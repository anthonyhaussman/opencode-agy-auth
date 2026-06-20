import type { Config } from './plugin/types';
import { AGY_PROVIDER_ID } from './constants';
import { agyFetch } from './fetch';
import { createOAuthAuthorizeMethod } from './plugin/oauth-authorize';
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from './plugin/auth';
import { resolveCachedAuth, initDiskSignatureCache } from './plugin/cache';
import { ensureProjectContext, retrieveUserQuota } from './plugin/project';
import { createAgyQuotaTool, AGY_QUOTA_TOOL_NAME } from './plugin/quota';
import { maybeShowAgyCapacityToast, maybeShowAgyTestToast } from './plugin/notify';
import { simulateClientBackgroundTraffic } from './plugin/traffic';
import { buildAgyCliUserAgent } from './sdk/user-agent';
import {
  resolveConfiguredProjectId,
  resolveConfiguredProjectIdFromClient,
  resolveConfiguredProjectIdFromConfig
} from './plugin/provider';
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareAgyRequest,
  type ThinkingConfigDefaults,
  transformAgyResponse
} from './sdk/request';
import { createChatLogger } from './sdk/chat-logger';
import { fetchWithRetry } from './sdk/retry';
import { refreshAccessToken } from './plugin/token';
import type {
  GetAuth,
  OAuthAuthDetails,
  PluginClient,
  PluginContext,
  PluginResult,
  Provider,
  ProviderModel,
  ProviderV2
} from './plugin/types';

const AGY_QUOTA_COMMAND = 'agyquota';
const AGY_QUOTA_COMMAND_TEMPLATE = `Retrieve Agy Code Assist quota usage for the current authenticated account.

Immediately call \`${AGY_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;
let latestAgyAuthResolver: GetAuth | undefined;
let latestAgyConfiguredProjectId: string | undefined;
let latestAgyUserAgentModel: string | undefined;

interface SimpleStaticModel {
  name: string;
  description: string;
  maxTokens: number;
  maxOutputTokens: number;
  toolCall: boolean;
  reasoning: boolean;
  attachment: boolean;
  cost?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
  };
}

const STATIC_MODELS_SIMPLE: Record<string, SimpleStaticModel> = {
  'gemini-3.5-flash': {
    name: 'Gemini 3.5 Flash',
    description: 'Gemini 3.5 Flash base model. Select tier at runtime.',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'gemini-3.1-pro': {
    name: 'Gemini 3.1 Pro',
    description: 'Gemini 3.1 Pro base model. Select tier at runtime.',
    maxTokens: 1048576,
    maxOutputTokens: 65535,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6 (Thinking)',
    description: 'Claude Sonnet 4.6 deep reasoning model, perfectly balancing thinking process, processing speed, and output quality.',
    maxTokens: 250000,
    maxOutputTokens: 64000,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'claude-opus-4-6-thinking': {
    name: 'Claude Opus 4.6 (Thinking)',
    description: 'Claude Opus 4.6 deep reasoning model, built-in chain of thought, highly suitable for top-tier algorithm and logic puzzles.',
    maxTokens: 250000,
    maxOutputTokens: 64000,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'gpt-oss-120b-medium': {
    name: 'GPT-OSS 120B (Medium)',
    description: 'GPT open-source 120B parameter medium tier model, excellent performance in local deployment or specific open-source benchmarks.',
    maxTokens: 131072,
    maxOutputTokens: 32768,
    toolCall: true,
    reasoning: true,
    attachment: false
  }
};

const TIER_MAPPING: Record<string, { low: string; medium: string; high: string } & Record<string, string>> = {
  'gemini-3.5-flash': {
    low: 'gemini-3.5-flash-extra-low',
    medium: 'gemini-3.5-flash-low',
    high: 'gemini-3-flash-agent'
  },
  'gemini-3.1-pro': {
    low: 'gemini-3.1-pro-low',
    medium: 'gemini-3.1-pro-high',
    high: 'gemini-3.1-pro-high'
  }
};

const buildModelFromSimple = (modelId: string, simple: SimpleStaticModel): ProviderModel => {
  const isClaude = modelId.startsWith('claude-');
  const isGpt = modelId.startsWith('gpt-');

  let variants: any = undefined;
  if (TIER_MAPPING[modelId]) {
    variants = {
      'low': { id: 'low', name: 'low', displayName: 'low', title: 'low', label: 'low', options: { name: 'low' }, headers: { 'x-agy-tier': 'low' } },
      'medium': { id: 'medium', name: 'medium', displayName: 'medium', title: 'medium', label: 'medium', options: { name: 'medium' }, headers: { 'x-agy-tier': 'medium' } },
      'high': { id: 'high', name: 'high', displayName: 'high', title: 'high', label: 'high', options: { name: 'high' }, headers: { 'x-agy-tier': 'high' } }
    };
  }

  return {
    id: modelId,
    providerID: AGY_PROVIDER_ID,
    api: {
      id: AGY_PROVIDER_ID,
      url: 'https://cloudcode-pa.googleapis.com',
      npm: '@ai-sdk/google'
    },
    name: simple.name,
    family: modelId.includes('gemini') ? 'gemini' : (isClaude ? 'claude' : (isGpt ? 'gpt' : 'unknown')),
    status: 'active',
    release_date: '2026-05-26',
    capabilities: {
      temperature: true,
      reasoning: simple.reasoning,
      attachment: simple.attachment,
      toolcall: simple.toolCall,
      input: {
        text: true,
        image: simple.attachment,
        pdf: simple.attachment,
        audio: !isClaude && !isGpt,
        video: !isClaude && !isGpt
      },
      output: {
        text: true,
        image: false,
        pdf: false,
        audio: false,
        video: false
      },
      interleaved: false
    },
    cost: {
      input: simple.cost?.input ?? 0,
      output: simple.cost?.output ?? 0,
      cache: {
        read: simple.cost?.cache?.read ?? 0,
        write: simple.cost?.cache?.write ?? 0
      }
    },
    limit: {
      context: simple.maxTokens,
      output: simple.maxOutputTokens
    },
    options: {
      description: simple.description
    },
    headers: {},
    variants
  };
};

const STATIC_MODELS: Record<string, ProviderModel> = {};
for (const [modelId, simple] of Object.entries(STATIC_MODELS_SIMPLE)) {
  STATIC_MODELS[modelId] = buildModelFromSimple(modelId, simple);
}

function getSafeHeader(headers: unknown, key: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const targetKey = key.toLowerCase();

  if (typeof (headers as any).get === 'function') {
    try {
      return (headers as any).get(targetKey) || undefined;
    } catch {
      // Fallback in case get throws
    }
  }

  if (Array.isArray(headers)) {
    const found = headers.find((item) => {
      if (Array.isArray(item) && typeof item[0] === 'string') {
        return item[0].toLowerCase() === targetKey;
      }
      return false;
    });
    return found ? String(found[1]) : undefined;
  }

  if (typeof headers === 'object') {
    const foundKey = Object.keys(headers).find(k => k.toLowerCase() === targetKey);
    return foundKey ? ((headers as Record<string, unknown>)[foundKey] !== undefined ? String((headers as Record<string, unknown>)[foundKey]) : undefined) : undefined;
  }

  return undefined;
}

function setSafeHeaders(initHeaders: unknown, newHeaders: Record<string, string>): unknown {
  if (typeof globalThis.Headers !== 'undefined') {
    const headers = new globalThis.Headers((initHeaders as any) ?? {});
    for (const [k, v] of Object.entries(newHeaders)) {
      headers.set(k, v);
    }
    return headers;
  }

  if (Array.isArray(initHeaders)) {
    const nextHeaders = [...initHeaders];
    for (const [k, v] of Object.entries(newHeaders)) {
      const idx = nextHeaders.findIndex(item => Array.isArray(item) && typeof item[0] === 'string' && item[0].toLowerCase() === k.toLowerCase());
      if (idx !== -1) {
        nextHeaders[idx] = [k, v];
      } else {
        nextHeaders.push([k, v]);
      }
    }
    return nextHeaders;
  }

  const nextHeaders: Record<string, string> = {};
  if (initHeaders && typeof initHeaders === 'object') {
    for (const [k, v] of Object.entries(initHeaders)) {
      nextHeaders[k] = String(v);
    }
  }
  for (const [k, v] of Object.entries(newHeaders)) {
    const existingKey = Object.keys(nextHeaders).find(key => key.toLowerCase() === k.toLowerCase());
    if (existingKey) {
      nextHeaders[existingKey] = v;
    } else {
      nextHeaders[k] = v;
    }
  }
  return nextHeaders;
}

function resolveModelTier(baseModelId: string, init?: RequestInit): string {
  const parts = baseModelId.split('@');
  const base = parts[0] || '';
  const suffixTier = parts[1]?.toLowerCase();

  const mapping = TIER_MAPPING[base];
  if (!mapping) {
    return baseModelId;
  }

  const headerTier = getSafeHeader(init?.headers, 'x-agy-tier')?.toLowerCase() || null;
  const requestedTier = headerTier || suffixTier;

  // Resolve to specific tier or default to medium
  if (requestedTier && Object.prototype.hasOwnProperty.call(mapping, requestedTier)) {
    return mapping[requestedTier] || baseModelId;
  }

  return mapping['medium'];
}

/**
 * Registers the Agy OAuth provider for Opencode.
 */
export const AgyCLIOAuthPlugin = async ({ client }: PluginContext): Promise<PluginResult> => {
  let latestConfig: Config | undefined;

  const getModelsList = (provider: ProviderV2): Record<string, ProviderModel> => {
    provider.models = provider.models || {};
    for (const [modelId, modelDetails] of Object.entries(STATIC_MODELS)) {
      provider.models[modelId] = {
        ...modelDetails,
        ...(provider.models[modelId] || {})
      };
    }

    if (latestConfig && latestConfig.provider && latestConfig.provider[AGY_PROVIDER_ID]) {
      latestConfig.provider[AGY_PROVIDER_ID].models = STATIC_MODELS;
    }
    normalizeProviderModelCosts(provider);

    return STATIC_MODELS;
  };

  initDiskSignatureCache({
    enabled: true,
    memory_ttl_seconds: 3600,
    disk_ttl_seconds: 86400,
    write_interval_seconds: 30
  });

  const resolveLatestConfiguredProjectId = async (provider?: Provider): Promise<string | undefined> => {
    const configProjectId = (await resolveConfiguredProjectIdFromClient(client)) ?? latestAgyConfiguredProjectId;
    const resolvedProjectId = resolveConfiguredProjectId({
      provider,
      configProjectId
    });
    latestAgyConfiguredProjectId = resolvedProjectId;
    return resolvedProjectId;
  };

  return {
    config: async (config) => {
      latestConfig = config;
      latestAgyConfiguredProjectId = resolveConfiguredProjectIdFromConfig(config);
      config.command = config.command || {};
      config.command[AGY_QUOTA_COMMAND] = {
        description: 'Show Agy Code Assist quota usage',
        template: AGY_QUOTA_COMMAND_TEMPLATE
      };

      // Dynamically registers the google-agy provider config to make it work seamlessly without manual user mapping.
      config.provider = config.provider || {};
      config.provider[AGY_PROVIDER_ID] = {
        npm: '@ai-sdk/google',
        name: 'Antigravity CLI',
        options: {},
        models: {},
        ...config.provider[AGY_PROVIDER_ID]
      };

      // Provides a hardcoded static model list by default.
      config.provider[AGY_PROVIDER_ID].models = STATIC_MODELS;
    },
    tool: {
      [AGY_QUOTA_TOOL_NAME]: createAgyQuotaTool({
        client,
        getAuthResolver: () => latestAgyAuthResolver,
        getConfiguredProjectId: () => latestAgyConfiguredProjectId,
        getUserAgentModel: () => latestAgyUserAgentModel
      })
    },
    auth: {
      provider: AGY_PROVIDER_ID,
      loader: async (getAuth: GetAuth, provider: Provider): Promise<any> => {
        latestAgyAuthResolver = getAuth;
        const auth = await getAuth();
        if (!isOAuthAuth(auth)) {
          return null;
        }

        const configuredProjectId = await resolveLatestConfiguredProjectId(provider);
        normalizeProviderModelCosts(provider);
        const thinkingConfigDefaults = resolveThinkingConfigDefaults(provider);

        return {
          apiKey: '',
          async fetch(input: RequestInfo, init?: RequestInit) {
            const isGL = isGenerativeLanguageRequest(input);
            const isInternal = toUrlString(input).includes('cloudcode-pa.googleapis.com');

            if (!isGL && !isInternal) {
              return agyFetch(input, init);
            }

            const latestAuth = await getAuth();
            if (!isOAuthAuth(latestAuth)) {
              return agyFetch(input, init);
            }

            let authRecord = resolveCachedAuth(latestAuth);
            if (accessTokenExpired(authRecord)) {
              const refreshed = await refreshAccessToken(authRecord, client);
              if (!refreshed) {
                return agyFetch(input, init);
              }
              authRecord = refreshed;
            }

            if (!authRecord.access) {
              return agyFetch(input, init);
            }

            const configuredProjectId = await resolveLatestConfiguredProjectId(provider);

            if (isInternal) {
              const hasAuth = getSafeHeader(init?.headers, 'Authorization') !== undefined;
              if (hasAuth) {
                return agyFetch(input, init);
              }

              const userAgent = buildAgyCliUserAgent(latestAgyUserAgentModel);
              const headers = setSafeHeaders(init?.headers, {
                'Authorization': `Bearer ${authRecord.access}`,
                'User-Agent': userAgent
              });

              if (configuredProjectId) {
                simulateClientBackgroundTraffic(authRecord.access, configuredProjectId, latestAgyUserAgentModel);
              }

              return agyFetch(input, {
                ...init,
                headers: headers as any
              });
            }
            const requestTarget = parseGenerativeLanguageRequest(input);
            const requestUserAgentModel = requestTarget?.effectiveModel;
            if (requestUserAgentModel) {
              latestAgyUserAgentModel = requestUserAgentModel;
            }
            const projectContext = await ensureProjectContextOrThrow(
              authRecord,
              client,
              configuredProjectId,
              requestUserAgentModel
            );
            await maybeShowAgyTestToast(client, projectContext.effectiveProjectId);

            const originalRequestedModel = parseGenerativeLanguageRequest(input)?.effectiveModel;
            let modifiedInput = input;
            if (isGL && originalRequestedModel) {
               const originalBase = originalRequestedModel.replace('google-agy/', '');
               const resolvedBase = resolveModelTier(originalBase, init);
               if (originalBase !== resolvedBase) {
                 if (typeof modifiedInput === 'string') {
                    modifiedInput = modifiedInput.replace(`models/${originalBase}`, `models/${resolvedBase}`);
                 } else if (typeof Request !== 'undefined' && modifiedInput instanceof Request) {
                    const newUrl = modifiedInput.url.replace(`models/${originalBase}`, `models/${resolvedBase}`);
                    modifiedInput = new Request(newUrl, modifiedInput);
                 }
               }
            }

            const parts = parseRefreshParts(authRecord.refresh);
            const transformed = prepareAgyRequest(
              modifiedInput,
              init,
              authRecord.access,
              projectContext.effectiveProjectId,
              thinkingConfigDefaults
            );
            const chatLogger = createChatLogger();
            if (chatLogger) {
              chatLogger.logRequest(
                toUrlString(transformed.request),
                transformed.init.method || 'GET',
                transformed.init.headers,
                transformed.init.body
              );
            }

            const response = await fetchWithRetry(transformed.request, transformed.init);
            if (response.ok && authRecord.access && projectContext.effectiveProjectId) {
              simulateClientBackgroundTraffic(
                authRecord.access,
                projectContext.effectiveProjectId,
                requestUserAgentModel
              );
            }
            await maybeShowAgyCapacityToast(
              client,
              response,
              projectContext.effectiveProjectId,
              transformed.requestedModel
            );
            return transformAgyResponse(
              response,
              transformed.streaming,
              null,
              transformed.requestedModel,
              transformed.sessionId,
              chatLogger
            );
          }
        };
      },
      methods: [
        {
          label: 'Google OAuth (Antigravity CLI)',
          type: 'oauth',
          authorize: createOAuthAuthorizeMethod({
            client,
            getConfiguredProjectId: () => resolveLatestConfiguredProjectId(),
            getUserAgentModel: () => latestAgyUserAgentModel
          })
        },
        {
          label: 'Manually enter API Key',
          type: 'api'
        }
      ]
    },
    provider: {
      id: AGY_PROVIDER_ID,
      models: async (provider: any, ctx: any): Promise<any> => {
        let auth = ctx?.auth;
        if (!auth && latestAgyAuthResolver) {
          try {
            auth = await latestAgyAuthResolver();
          } catch (e) {
            const errStr = e instanceof Error ? e.stack || e.message : String(e);
            console.warn(`[Agy Auth] Failed to resolve auth from resolver in models hook: ${errStr}`);
          }
        }

        if (!auth || !isOAuthAuth(auth)) {
          return {
            'login-required': {
              name: 'No models available'
            }
          };
        }

        return getModelsList(provider);
      }
    } as any
  };
};

export const GoogleOAuthPlugin = AgyCLIOAuthPlugin;

function normalizeProviderModelCosts(provider: Provider | ProviderV2): void {
  if (!provider?.models || typeof provider.models !== 'object') {
    return;
  }
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!model || typeof model !== 'object') {
      continue;
    }
    const existingCost = model.cost;
    const isValidCost =
      existingCost &&
      typeof existingCost === 'object' &&
      typeof existingCost.input === 'number' &&
      typeof existingCost.output === 'number';
    const normalizedCost = {
      input: isValidCost ? existingCost.input : 0,
      output: isValidCost ? existingCost.output : 0,
      cache: {
        read:
          isValidCost &&
          typeof existingCost.cache === 'object' &&
          existingCost.cache !== null &&
          typeof (existingCost.cache as { read?: number }).read === 'number'
            ? (existingCost.cache as { read: number }).read
            : 0,
        write:
          isValidCost &&
          typeof existingCost.cache === 'object' &&
          existingCost.cache !== null &&
          typeof (existingCost.cache as { write?: number }).write === 'number'
            ? (existingCost.cache as { write: number }).write
            : 0
      }
    };
    model.cost = normalizedCost;
  }
}

function resolveThinkingConfigDefaults(provider: Provider): ThinkingConfigDefaults | undefined {
  const providerOptions =
    provider && typeof provider === 'object'
      ? ((provider as { options?: Record<string, unknown> }).options ?? undefined)
      : undefined;
  const providerThinkingConfig = providerOptions?.thinkingConfig;

  const modelThinkingConfigByModel: Record<string, unknown> = {};
  for (const [modelId, model] of Object.entries(provider.models ?? {})) {
    if (!model || typeof model !== 'object') {
      continue;
    }
    const modelOptions = (model as { options?: Record<string, unknown> }).options;
    if (modelOptions && typeof modelOptions === 'object' && 'thinkingConfig' in modelOptions) {
      modelThinkingConfigByModel[modelId] = modelOptions.thinkingConfig;
    }
  }

  if (providerThinkingConfig === undefined && Object.keys(modelThinkingConfigByModel).length === 0) {
    return undefined;
  }

  return {
    provider: providerThinkingConfig,
    models: modelThinkingConfigByModel
  };
}

async function ensureProjectContextOrThrow(
  authRecord: OAuthAuthDetails,
  client: PluginClient,
  configuredProjectId?: string,
  userAgentModel?: string
) {
  try {
    return await ensureProjectContext(authRecord, client, configuredProjectId, userAgentModel);
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`[Agy Auth] ensureProjectContextOrThrow error: ${error.message}`);
    }
    throw error;
  }
}

function toUrlString(value: RequestInfo): string {
  if (typeof value === 'string') {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

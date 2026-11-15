import { updateStaticModelsWithPricing } from './plugin/pricing';
import type { Config } from './plugin/types';
import { AGY_PROVIDER_ID } from './constants';
import { agyFetch } from './fetch';
import { createOAuthAuthorizeMethod } from './plugin/oauth-authorize';
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from './plugin/auth';
import { resolveCachedAuth, initDiskSignatureCache } from './plugin/cache';
import { initTurnStateTracker } from './sdk/request/turn-state-tracker';
import { initCooldownPersistence } from './sdk/retry';
import { ensureProjectContext, retrieveUserQuota } from './plugin/project';
import { createAgyQuotaTool, AGY_QUOTA_TOOL_NAME } from './plugin/quota';
import { createAgyQuotaSummaryTool, AGY_QUOTA_SUMMARY_TOOL_NAME } from './plugin/quota-summary';
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

import {
  inferModelMetadata,
  extractBaseModelId,
  buildTierMapping,
  resolveModelTier,
  fetchAvailableModelIds,
  type SimpleStaticModel
} from './plugin/tier';
import { getSafeHeader, setSafeHeaders, toUrlString } from './plugin/headers';
export {
  inferModelMetadata,
  extractBaseModelId,
  buildTierMapping,
  resolveModelTier,
  fetchAvailableModelIds,
  type SimpleStaticModel
};

const AGY_QUOTA_COMMAND = 'agyquota';
const AGY_QUOTA_COMMAND_TEMPLATE = `Retrieve Agy Code Assist quota usage for the current authenticated account.

Immediately call \`${AGY_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;

const AGY_QUOTA_SUMMARY_COMMAND = 'agyquotasummary';
const AGY_QUOTA_SUMMARY_COMMAND_TEMPLATE = `Retrieve Agy Code Assist quota summary (weekly and 5-hour limits by model group) for the current authenticated account.

Immediately call \`${AGY_QUOTA_SUMMARY_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;

let latestAgyAuthResolver: GetAuth | undefined;
let latestAgyConfiguredProjectId: string | undefined;
let latestAgyUserAgentModel: string | undefined;

/**
 * Build a ProviderModel from a base model ID and its tier variants.
 * All metadata inferred dynamically — zero hardcoding.
 * Matches the OpenCode SDK Model type exactly.
 */
const buildModelFromBase = (
  baseModelId: string,
  tierVariants: Record<string, string>
): ProviderModel => {
  const metadata = inferModelMetadata(baseModelId);
  const isClaude = baseModelId.startsWith('claude-');
  const isGpt = baseModelId.startsWith('gpt-');

  const variants: Record<string, any> = {};
  for (const [tier, tieredModelId] of Object.entries(tierVariants)) {
    const hasMinimal = tier === 'minimal';
    variants[tier] = {
      id: tier,
      name: tier,
      displayName: tier,
      title: tier,
      label: tier,
      options: { name: tier },
      headers: { 'x-agy-tier': tier },
      ...(hasMinimal ? { thinkingConfig: { thinkingBudget: 1000, includeThoughts: true } } : {})
    };
  }

  return {
    id: baseModelId,
    providerID: AGY_PROVIDER_ID,
    api: {
      id: AGY_PROVIDER_ID,
      url: 'https://cloudcode-pa.googleapis.com',
      npm: '@ai-sdk/google'
    },
    name: metadata.name,
    family: baseModelId.includes('gemini') ? 'gemini' : (isClaude ? 'claude' : (isGpt ? 'gpt' : 'unknown')),
    status: 'active' as const,
    release_date: '2026-05-26',
    capabilities: {
      temperature: true,
      reasoning: metadata.reasoning,
      attachment: metadata.attachment,
      toolcall: metadata.toolCall,
      input: {
        text: true,
        image: metadata.attachment,
        pdf: metadata.attachment,
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
      input: metadata.cost?.input ?? 0,
      output: metadata.cost?.output ?? 0,
      cache: {
        read: metadata.cost?.cache?.read ?? 0,
        write: metadata.cost?.cache?.write ?? 0
      }
    },
    limit: {
      context: metadata.maxTokens,
      output: metadata.maxOutputTokens
    },
    options: {
      description: metadata.description
    },
    headers: {},
    variants
  } satisfies ProviderModel;
};

/**
 * Build dynamic model catalog from AGY quota response.
 * Replaces the old STATIC_MODELS completely.
 */
async function buildDynamicModelCatalog(
  accessToken: string,
  projectId: string,
  userAgentModel: string | undefined
): Promise<{ models: Record<string, ProviderModel>; tierMapping: Record<string, Record<string, string>> }> {
  const availableModelIds = await fetchAvailableModelIds(retrieveUserQuota, accessToken, projectId, userAgentModel);

  if (availableModelIds.size === 0) {
    return { models: {}, tierMapping: {} };
  }

  // Group tiered model IDs by base model
  const tierMapping = buildTierMapping(Array.from(availableModelIds));

  // Build ProviderModel for each base model
  const models: Record<string, ProviderModel> = {};
  for (const [baseModelId, variants] of Object.entries(tierMapping)) {
    models[baseModelId] = buildModelFromBase(baseModelId, variants);
  }

  return { models, tierMapping };
}

/**
 * Registers the Agy OAuth provider for Opencode.
 * Fully dynamic — no hardcoded model lists.
 */
export const AgyCLIOAuthPlugin = async ({ client }: PluginContext): Promise<PluginResult> => {
  let latestConfig: Config | undefined;
  let dynamicTierMapping: Record<string, Record<string, string>> = {};

  try {
    initDiskSignatureCache({
      enabled: true,
      memory_ttl_seconds: 3600,
      disk_ttl_seconds: 86400,
      write_interval_seconds: 30
    });
  } catch (e) {
    console.warn(`[Agy Auth] initDiskSignatureCache failed, running without signature disk cache: ${e instanceof Error ? e.message : e}`);
  }

  try {
    initTurnStateTracker();
  } catch (e) {
    console.warn(`[Agy Auth] initTurnStateTracker failed, running without turn-state tracking: ${e instanceof Error ? e.message : e}`);
  }

  try {
    initCooldownPersistence();
  } catch (e) {
    console.warn(`[Agy Auth] initCooldownPersistence failed, running without cooldown disk persistence: ${e instanceof Error ? e.message : e}`);
  }

  const resolveLatestConfiguredProjectId = async (provider?: Provider): Promise<string | undefined> => {
    const configProjectId = (await resolveConfiguredProjectIdFromClient(client)) ?? latestAgyConfiguredProjectId;
    const resolvedProjectId = resolveConfiguredProjectId({
      provider,
      configProjectId
    });
    latestAgyConfiguredProjectId = resolvedProjectId;
    return resolvedProjectId;
  };

  // Build dynamic model list for provider hook (used when user opens model picker)
  const getDynamicModels = async (provider: ProviderV2): Promise<Record<string, ProviderModel>> => {
    const auth = await latestAgyAuthResolver?.();
    if (!auth || !isOAuthAuth(auth)) {
      return {};
    }

    const authRecord = resolveCachedAuth(auth);
    if (accessTokenExpired(authRecord) || !authRecord.access) {
      return {};
    }

    const configuredProjectId = await resolveLatestConfiguredProjectId(provider);
    if (!configuredProjectId) {
      return {};
    }

    const { models, tierMapping } = await buildDynamicModelCatalog(
      authRecord.access,
      configuredProjectId,
      latestAgyUserAgentModel
    );
    dynamicTierMapping = tierMapping;

    // Merge with user config
    const userModels = provider.models || {};
    const mergedModels: Record<string, ProviderModel> = {};

    for (const [modelId, modelDetails] of Object.entries(models)) {
      const existing = userModels[modelId] as ProviderModel | undefined;
      mergedModels[modelId] = {
        ...modelDetails,
        ...(existing || {}),
        capabilities: {
          ...(modelDetails.capabilities || {}),
          ...(existing?.capabilities || {}),
          input: {
            ...(modelDetails.capabilities?.input || {}),
            ...(existing?.capabilities?.input || {})
          },
          output: {
            ...(modelDetails.capabilities?.output || {}),
            ...(existing?.capabilities?.output || {})
          }
        }
      } satisfies ProviderModel;
    }

    // Also include any user-defined models not in dynamic list
    for (const [modelId, modelDetails] of Object.entries(userModels)) {
      if (!mergedModels[modelId]) {
        mergedModels[modelId] = modelDetails as ProviderModel;
      }
    }

    if (latestConfig && latestConfig.provider && latestConfig.provider[AGY_PROVIDER_ID]) {
      latestConfig.provider[AGY_PROVIDER_ID].models = mergedModels;
    }

    // Apply pricing from models.dev
    updateStaticModelsWithPricing(mergedModels);
    normalizeProviderModelCosts({ models: mergedModels } as ProviderV2);

    return mergedModels;
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
      config.command[AGY_QUOTA_SUMMARY_COMMAND] = {
        description: 'Show Agy Code Assist quota summary with weekly and 5-hour limits',
        template: AGY_QUOTA_SUMMARY_COMMAND_TEMPLATE
      };

      config.provider = config.provider || {};
      config.provider[AGY_PROVIDER_ID] = {
        npm: '@ai-sdk/google',
        name: 'Antigravity CLI',
        options: {},
        models: {},
        ...config.provider[AGY_PROVIDER_ID]
      };

      // Initial empty models — will be populated dynamically via provider.models hook
      config.provider[AGY_PROVIDER_ID].models = {};
    },
    tool: {
      [AGY_QUOTA_TOOL_NAME]: createAgyQuotaTool({
        client,
        getAuthResolver: () => latestAgyAuthResolver,
        getConfiguredProjectId: () => latestAgyConfiguredProjectId,
        getUserAgentModel: () => latestAgyUserAgentModel
      }),
      [AGY_QUOTA_SUMMARY_TOOL_NAME]: createAgyQuotaSummaryTool({
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
              const resolvedBase = resolveModelTier(originalBase, init, dynamicTierMapping);
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

        const models = await getDynamicModels(provider);
        return models;
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
  for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
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
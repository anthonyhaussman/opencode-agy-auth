import {
  AGY_AUTH_URL,
  AGY_CLIENT_ID,
  AGY_CLIENT_SECRET,
  AGY_PROVIDER_ID,
  AGY_SCOPES,
  AGY_TOKEN_URL
} from '../constants';
import { STATIC_MODELS_SIMPLE, TIER_MAPPING } from '../plugin';
import { createAgyQuotaTool, AGY_QUOTA_TOOL_NAME } from './quota';
import { createAgyQuotaSummaryTool, AGY_QUOTA_SUMMARY_TOOL_NAME } from './quota-summary';
import {
  defineOpenCodeV2Plugin,
  type OpenCodeV2PluginContext,
  type OpenCodeV2PluginDefinition
} from './types';
import { buildAgyCliUserAgent } from '../sdk/user-agent';
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareAgyRequest,
  transformAgyResponse
} from '../sdk/request';
import { createChatLogger } from '../sdk/chat-logger';
import { fetchWithRetry } from '../sdk/retry';
import { classifyQuotaResponse, retryInternals } from '../sdk/retry/quota';
import { resolveRetryDelayMs } from '../sdk/retry/helpers';
import { resolveCachedAuth } from './cache';
import { accessTokenExpired, formatRefreshParts, isOAuthAuth, parseRefreshParts } from './auth';
import { refreshAccessToken } from './token';
import { ensureProjectContext } from './project';
import { agyFetch } from '../fetch';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export const AGY_V2_QUOTA_COMMAND = 'agy-quota';
export const AGY_V2_QUOTA_SUMMARY_COMMAND = 'agy-quota-summary';

export const AGY_V2_QUOTA_COMMAND_TEMPLATE = `Retrieve Agy Code Assist quota usage for the current authenticated account.

Immediately call \`${AGY_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;

export const AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE = `Retrieve Agy Code Assist quota summary (weekly and 5-hour limits by model group) for the current authenticated account.

Immediately call \`${AGY_QUOTA_SUMMARY_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;

export function getSafeHeader(headers: unknown, key: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const targetKey = key.toLowerCase();

  if (typeof (headers as any).get === 'function') {
    try {
      return (headers as any).get(targetKey) || undefined;
    } catch {
      // Fallback
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

export function setSafeHeaders(initHeaders: unknown, newHeaders: Record<string, string>): unknown {
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

export function toUrlString(value: RequestInfo): string {
  if (typeof value === 'string') {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

export function resolveModelTier(baseModelId: string, init?: RequestInit): string {
  const parts = baseModelId.split('@');
  const base = parts[0] || '';
  const suffixTier = parts[1]?.toLowerCase();

  const mapping = TIER_MAPPING[base];
  if (!mapping) {
    return baseModelId;
  }

  const headerTier = getSafeHeader(init?.headers, 'x-agy-tier')?.toLowerCase() || null;
  const requestedTier = headerTier || suffixTier;

  if (requestedTier && Object.prototype.hasOwnProperty.call(mapping, requestedTier)) {
    return mapping[requestedTier] || baseModelId;
  }

  return mapping['medium'] ?? mapping['high'];
}

export function loadStoredAuthFromJson(): any {
  const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  try {
    if (existsSync(authPath)) {
      const content = readFileSync(authPath, 'utf8');
      const data = JSON.parse(content);
      return data?.[AGY_PROVIDER_ID];
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

export function createV2FetchInterceptor(getAuthSnapshot?: () => Promise<any> | any) {
  return async function agyV2Fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const isGL = isGenerativeLanguageRequest(input);
    const isInternal = toUrlString(input).includes('cloudcode-pa.googleapis.com');

    if (!isGL && !isInternal) {
      return agyFetch(input, init);
    }

    let rawAuth = getAuthSnapshot ? await getAuthSnapshot() : undefined;
    if (!rawAuth) {
      rawAuth = loadStoredAuthFromJson();
    }

    if (!rawAuth || !isOAuthAuth(rawAuth)) {
      return agyFetch(input, init);
    }

    let authRecord = resolveCachedAuth(rawAuth);
    if (accessTokenExpired(authRecord)) {
      const refreshed = await refreshAccessToken(authRecord, { auth: { set: async () => {} } } as any);
      if (refreshed) {
        authRecord = refreshed;
      }
    }

    if (!authRecord.access) {
      return agyFetch(input, init);
    }

    if (isInternal) {
      const hasAuth = getSafeHeader(init?.headers, 'Authorization') !== undefined;
      if (hasAuth) {
        return agyFetch(input, init);
      }

      const userAgent = buildAgyCliUserAgent();
      const headers = setSafeHeaders(init?.headers, {
        Authorization: `Bearer ${authRecord.access}`,
        'User-Agent': userAgent
      });

      return agyFetch(input, {
        ...init,
        headers: headers as any
      });
    }

    const requestTarget = parseGenerativeLanguageRequest(input);
    const requestUserAgentModel = requestTarget?.effectiveModel;

    let projectContext: { effectiveProjectId: string; auth: any };
    try {
      projectContext = await ensureProjectContext(
        authRecord,
        { auth: { set: async () => {} } } as any,
        undefined,
        requestUserAgentModel
      );
    } catch {
      projectContext = {
        effectiveProjectId: parseRefreshParts(authRecord.refresh).projectId || 'antigravity',
        auth: authRecord
      };
    }

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

    const transformed = prepareAgyRequest(
      modifiedInput,
      init,
      authRecord.access,
      projectContext.effectiveProjectId,
      undefined
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
    return transformAgyResponse(
      response,
      transformed.streaming,
      null,
      transformed.requestedModel,
      transformed.sessionId,
      chatLogger
    );
  };
}

import { parseOAuthCallbackInput } from './oauth-authorize';

/**
 * Setup adapter for OpenCode v2 plugin architecture.
 */
export async function setupOpenCodeV2(ctx: OpenCodeV2PluginContext): Promise<void> {
  // 1. Register provider and models via catalog transform
  ctx.catalog.transform(async (editor: any) => {
    if (!editor) return;

    const resolveVariants = (modelId: string) => {
      const mapping = TIER_MAPPING[modelId];
      if (!mapping) return undefined;
      const variants: Array<{ id: string }> = [];
      if (mapping.minimal !== undefined) variants.push({ id: 'minimal' });
      if (mapping.low !== undefined) variants.push({ id: 'low' });
      if (mapping.medium !== undefined) variants.push({ id: 'medium' });
      if (mapping.high !== undefined) variants.push({ id: 'high' });
      return variants.length > 0 ? variants : undefined;
    };

    if (typeof editor?.provider?.update === 'function') {
      editor.provider.update(AGY_PROVIDER_ID, (p: any) => {
        p.name = 'Antigravity CLI';
        p.activation = 'enabled';
        p.package = 'aisdk:@ai-sdk/google';
        p.description = 'Google Gemini Antigravity Code Assist OAuth provider';
        p.settings = { ...(p.settings || {}), apiKey: 'dummy' };
        p.integrationID = AGY_PROVIDER_ID;
      });

      if (typeof editor?.model?.update === 'function') {
        for (const [modelId, simple] of Object.entries(STATIC_MODELS_SIMPLE)) {
          editor.model.update(AGY_PROVIDER_ID, modelId, (m: any) => {
            m.name = simple.name;
            m.capabilities = {
              tools: true,
              input: ['text', 'image'],
              output: ['text']
            };
            m.limit = {
              context: simple.maxTokens,
              output: simple.maxOutputTokens
            };
            m.family = 'gemini';
            if (simple.cost) {
              m.cost = simple.cost;
            }
            const variants = resolveVariants(modelId);
            if (variants) {
              m.variants = variants;
            }
          });
        }
      }
      return;
    }

    const catalog = editor;
    catalog.providers = catalog.providers || {};
    catalog.providers[AGY_PROVIDER_ID] = {
      id: AGY_PROVIDER_ID,
      name: 'Antigravity CLI',
      npm: 'aisdk:@ai-sdk/google',
      settings: { apiKey: 'dummy' },
      integrationID: AGY_PROVIDER_ID,
      models: { ...(catalog.providers[AGY_PROVIDER_ID]?.models || {}) },
      ...catalog.providers[AGY_PROVIDER_ID]
    };
    if (catalog.providers[AGY_PROVIDER_ID].settings) {
      catalog.providers[AGY_PROVIDER_ID].settings = {
        ...catalog.providers[AGY_PROVIDER_ID].settings,
        apiKey: 'dummy'
      };
    } else {
      catalog.providers[AGY_PROVIDER_ID].settings = { apiKey: 'dummy' };
    }
    catalog.providers[AGY_PROVIDER_ID].integrationID = AGY_PROVIDER_ID;

    const targetModels = catalog.providers[AGY_PROVIDER_ID].models;

    for (const [modelId, simple] of Object.entries(STATIC_MODELS_SIMPLE)) {
      const isClaude = modelId.startsWith('claude-');
      const isGpt = modelId.startsWith('gpt-');
      const variants = resolveVariants(modelId);

      targetModels[modelId] = {
        id: modelId,
        providerID: AGY_PROVIDER_ID,
        name: simple.name,
        description: simple.description,
        family: modelId.includes('gemini') ? 'gemini' : (isClaude ? 'claude' : (isGpt ? 'gpt' : 'unknown')),
        reasoning: simple.reasoning,
        attachment: simple.attachment,
        tool_call: simple.toolCall,
        limit: {
          context: simple.maxTokens,
          output: simple.maxOutputTokens
        },
        cost: simple.cost || { input: 0, output: 0 },
        ...(variants ? { variants } : {}),
        ...(targetModels[modelId] || {})
      };
    }
  });

  // 2. Register agy_quota and agy_quota_summary tools via tool transform
  ctx.tool.transform(async (editor: any) => {
    if (!editor) return;

    // Use dummy client / resolvers for static tool registration
    const quotaTool = createAgyQuotaTool({
      client: undefined as any,
      getAuthResolver: () => undefined,
      getConfiguredProjectId: () => undefined,
      getUserAgentModel: () => undefined
    });

    const quotaSummaryTool = createAgyQuotaSummaryTool({
      client: undefined as any,
      getAuthResolver: () => undefined,
      getConfiguredProjectId: () => undefined,
      getUserAgentModel: () => undefined
    });

    if (typeof editor.add === 'function') {
      editor.add({
        name: AGY_QUOTA_TOOL_NAME,
        description: quotaTool.description,
        input: {},
        execute: async (args: any, context: any) => (quotaTool as any).execute(args, context)
      });
      editor.add({
        name: AGY_QUOTA_SUMMARY_TOOL_NAME,
        description: quotaSummaryTool.description,
        input: {},
        execute: async (args: any, context: any) => (quotaSummaryTool as any).execute(args, context)
      });
    } else if (typeof editor.set === 'function') {
      editor.set(AGY_QUOTA_TOOL_NAME, quotaTool);
      editor.set(AGY_QUOTA_SUMMARY_TOOL_NAME, quotaSummaryTool);
    } else if (editor.tools && typeof editor.tools === 'object') {
      editor.tools[AGY_QUOTA_TOOL_NAME] = quotaTool;
      editor.tools[AGY_QUOTA_SUMMARY_TOOL_NAME] = quotaSummaryTool;
    } else if (typeof editor === 'object') {
      editor[AGY_QUOTA_TOOL_NAME] = quotaTool;
      editor[AGY_QUOTA_SUMMARY_TOOL_NAME] = quotaSummaryTool;
    }
  });

  // 3. Register agy-quota and agy-quota-summary commands via command transform
  ctx.command.transform(async (editor: any) => {
    if (!editor) return;

    const commands = {
      [AGY_V2_QUOTA_COMMAND]: {
        description: 'Show Agy Code Assist quota usage',
        template: AGY_V2_QUOTA_COMMAND_TEMPLATE
      },
      [AGY_V2_QUOTA_SUMMARY_COMMAND]: {
        description: 'Show Agy Code Assist quota summary with weekly and 5-hour limits',
        template: AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE
      }
    };

    if (typeof editor.add === 'function') {
      editor.add({
        name: AGY_V2_QUOTA_COMMAND,
        description: 'Display current Antigravity quota usage',
        template: AGY_V2_QUOTA_COMMAND_TEMPLATE
      });
      editor.add({
        name: AGY_V2_QUOTA_SUMMARY_COMMAND,
        description: 'Display Antigravity quota summary grouped by model family',
        template: AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE
      });
    } else if (typeof editor.set === 'function') {
      editor.set(AGY_V2_QUOTA_COMMAND, commands[AGY_V2_QUOTA_COMMAND]);
      editor.set(AGY_V2_QUOTA_SUMMARY_COMMAND, commands[AGY_V2_QUOTA_SUMMARY_COMMAND]);
    } else if (editor.commands && typeof editor.commands === 'object') {
      editor.commands[AGY_V2_QUOTA_COMMAND] = commands[AGY_V2_QUOTA_COMMAND];
      editor.commands[AGY_V2_QUOTA_SUMMARY_COMMAND] = commands[AGY_V2_QUOTA_SUMMARY_COMMAND];
    } else if (typeof editor === 'object') {
      editor[AGY_V2_QUOTA_COMMAND] = commands[AGY_V2_QUOTA_COMMAND];
      editor[AGY_V2_QUOTA_SUMMARY_COMMAND] = commands[AGY_V2_QUOTA_SUMMARY_COMMAND];
    }
  });

  // 4. Register integration for AGY_PROVIDER_ID via integration transform
  ctx.integration?.transform?.((editor: any) => {
    if (!editor) return;

    editor.update?.(AGY_PROVIDER_ID, (integration: any) => {
      integration.name = 'Antigravity CLI (plugin)';
    });

    editor.method?.update?.({
      integrationID: AGY_PROVIDER_ID,
      method: {
        id: 'oauth',
        type: 'oauth',
        label: 'Antigravity CLI (OAuth)'
      },
      authorize: async () => {
        const authUrl = new URL(AGY_AUTH_URL);
        authUrl.searchParams.set('client_id', AGY_CLIENT_ID);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', 'http://localhost');
        authUrl.searchParams.set('scope', AGY_SCOPES.join(' '));
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');

        return {
          mode: 'code',
          url: authUrl.toString(),
          instructions:
            'Please complete Google account authorization in your browser. After authorization, copy the full redirect URL or code and paste it below:',
          callback: async (code: string) => {
            const trimmed = code.trim();
            const parsed = parseOAuthCallbackInput(trimmed);
            const authCode = parsed.code || trimmed;

            if (!authCode) {
              return { type: 'failed', error: 'Missing authorization code in callback input' };
            }

            const tokenResponse = await agyFetch(AGY_TOKEN_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: new URLSearchParams({
                client_id: AGY_CLIENT_ID,
                client_secret: AGY_CLIENT_SECRET,
                code: authCode,
                grant_type: 'authorization_code',
                redirect_uri: 'http://localhost'
              })
            });

            if (!tokenResponse.ok) {
              const errorText = await tokenResponse.text();
              return { type: 'failed', error: errorText };
            }

            const tokenPayload = (await tokenResponse.json()) as {
              access_token: string;
              expires_in: number;
              refresh_token?: string;
            };

            if (!tokenPayload.refresh_token) {
              return { type: 'failed', error: 'Missing refresh token in response' };
            }

            const initialRefresh = formatRefreshParts({
              refreshToken: tokenPayload.refresh_token
            });

            let authRecord = {
              type: 'oauth' as const,
              refresh: initialRefresh,
              access: tokenPayload.access_token,
              expires: Date.now() + tokenPayload.expires_in * 1000
            };

            try {
              const projectContext = await ensureProjectContext(
                authRecord,
                { auth: { set: async () => {} } } as any
              );
              authRecord = {
                ...authRecord,
                refresh: projectContext.auth.refresh
              };
            } catch {
              // Ignore project resolution error during authorize
            }

            return {
              type: 'success',
              refresh: authRecord.refresh,
              access: authRecord.access,
              expires: authRecord.expires
            };
          }
        };
      }
    });
  });

  // 5. Register aisdk hook if supported
  ctx.aisdk?.hook('sdk', async (event: any) => {
    if (!event) return;
    const isMatchingProvider =
      event.providerID === AGY_PROVIDER_ID ||
      event.model?.providerID === AGY_PROVIDER_ID;

    if (!isMatchingProvider) return;

    event.options = event.options || {};
    event.options.apiKey = 'dummy';
    event.options.fetch = createV2FetchInterceptor();
  });

  // 5. Register session hooks
  ctx.session.hook(
    'http.request',
    async (event: any) => {
      if (!event) return;

      const rawUrl = typeof event.url === 'string' ? event.url : (event.request?.url || '');
      const isGL = isGenerativeLanguageRequest(rawUrl);
      const isInternal = rawUrl.includes('cloudcode-pa.googleapis.com');

      if (!isGL && !isInternal) {
        return;
      }

      event.headers = event.headers || {};
      let modelName: string | undefined;

      if (isGL) {
        const parsed = parseGenerativeLanguageRequest(rawUrl);
        modelName = parsed?.effectiveModel;

        // Strip x-goog-api-key and api-key from headers
        if (typeof event.headers.delete === 'function') {
          event.headers.delete('x-goog-api-key');
          event.headers.delete('api-key');
        } else {
          for (const key of Object.keys(event.headers)) {
            const lower = key.toLowerCase();
            if (lower === 'x-goog-api-key' || lower === 'api-key') {
              delete event.headers[key];
            }
          }
        }

        // Strip query parameter key/x-goog-api-key/api-key if URL has them
        try {
          const parsedUrl = new URL(rawUrl);
          let urlChanged = false;
          for (const param of ['key', 'x-goog-api-key', 'api-key']) {
            if (parsedUrl.searchParams.has(param)) {
              parsedUrl.searchParams.delete(param);
              urlChanged = true;
            }
          }
          if (urlChanged) {
            const cleanedUrl = parsedUrl.toString();
            if (typeof event.url === 'string') {
              event.url = cleanedUrl;
            }
            if (event.request && typeof event.request === 'object') {
              if (typeof event.request.url === 'string') {
                event.request.url = cleanedUrl;
              }
            }
          }
        } catch {
          // Ignore invalid URL parse
        }

        // Inject Authorization: Bearer <token>
        const hasAuth = typeof event.headers.get === 'function'
          ? !!event.headers.get('Authorization')
          : Object.keys(event.headers).some((k) => k.toLowerCase() === 'authorization');

        if (!hasAuth) {
          let token: string | undefined;
          if (typeof event.auth?.access === 'string' && event.auth.access) {
            token = event.auth.access;
          } else if (typeof event.auth?.token === 'string' && event.auth.token) {
            token = event.auth.token;
          }

          if (typeof event.headers.set === 'function') {
            event.headers.set('Authorization', `Bearer ${token || 'dummy'}`);
          } else {
            event.headers['Authorization'] = `Bearer ${token || 'dummy'}`;
          }
        }
      }

      const userAgent = buildAgyCliUserAgent(modelName);
      if (typeof event.headers.set === 'function') {
        if (!event.headers.get('User-Agent')) {
          event.headers.set('User-Agent', userAgent);
        }
      } else {
        if (!event.headers['User-Agent'] && !event.headers['user-agent']) {
          event.headers['User-Agent'] = userAgent;
        }
      }
    },
    { providerID: AGY_PROVIDER_ID }
  );

  ctx.session.hook(
    'http.response',
    async (event: any) => {
      if (!event) return;
      // Log or trace response status if needed
      if (event.response?.status === 429) {
        return;
      }
    },
    { providerID: AGY_PROVIDER_ID }
  );

  ctx.session.hook(
    'retry',
    async (event: any) => {
      if (!event) return;
      const response = event.response;
      if (response instanceof Response) {
        if (response.status === 429 || response.status === 503) {
          const quota = await classifyQuotaResponse(response);
          if (quota?.retryDelayMs) {
            event.retryDelayMs = quota.retryDelayMs;
          } else {
            event.retryDelayMs = await resolveRetryDelayMs(response, event.attempt || 1);
          }
        }
      } else if (event.details && Array.isArray(event.details)) {
        const retryInfo = event.details.find(
          (d: any) => d && d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
        );
        if (retryInfo?.retryDelay) {
          const delayMs = retryInternals.parseRetryDelayValue(retryInfo.retryDelay);
          if (delayMs !== null) {
            event.retryDelayMs = delayMs;
          }
        }
      }
    },
    { providerID: AGY_PROVIDER_ID }
  );
}

/**
 * OpenCode v2 Plugin Definition
 */
export const v2PluginDefinition: OpenCodeV2PluginDefinition = defineOpenCodeV2Plugin({
  id: AGY_PROVIDER_ID,
  setup: setupOpenCodeV2
});

export const createV2PluginDefinition = (): OpenCodeV2PluginDefinition => v2PluginDefinition;

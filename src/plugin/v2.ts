import { AGY_PROVIDER_ID } from '../constants';
import { STATIC_MODELS_SIMPLE, TIER_MAPPING } from '../plugin';
import { createAgyQuotaTool, AGY_QUOTA_TOOL_NAME } from './quota';
import { createAgyQuotaSummaryTool, AGY_QUOTA_SUMMARY_TOOL_NAME } from './quota-summary';
import {
  defineOpenCodeV2Plugin,
  type OpenCodeV2PluginContext,
  type OpenCodeV2PluginDefinition
} from './types';
import { buildAgyCliUserAgent } from '../sdk/user-agent';
import { isGenerativeLanguageRequest, parseGenerativeLanguageRequest } from '../sdk/request';
import { classifyQuotaResponse, retryInternals } from '../sdk/retry/quota';
import { resolveRetryDelayMs } from '../sdk/retry/helpers';

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
        return {
          mode: 'auto',
          url: 'https://accounts.google.com/o/oauth2/auth',
          instructions: 'Login with Google Cloud / Antigravity CLI credentials'
        };
      }
    });
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

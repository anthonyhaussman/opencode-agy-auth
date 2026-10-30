import { AGY_PROVIDER_ID } from '../constants';
import { STATIC_MODELS_SIMPLE, TIER_MAPPING } from './tier';
import { createAgyQuotaTool, AGY_QUOTA_TOOL_NAME, AGY_V2_QUOTA_COMMAND, AGY_V2_QUOTA_COMMAND_TEMPLATE } from './quota';
import {
  createAgyQuotaSummaryTool,
  AGY_QUOTA_SUMMARY_TOOL_NAME,
  AGY_V2_QUOTA_SUMMARY_COMMAND,
  AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE,
} from './quota-summary';
import {
  defineOpenCodeV2Plugin,
  type OpenCodeV2PluginContext,
  type OpenCodeV2PluginDefinition,
} from './types';
import { authorizeAgy, exchangeAgyWithVerifier } from '../sdk/oauth';
import { parseOAuthCallbackInput } from './oauth-authorize';
import { formatRefreshParts } from './auth';
import { ensureProjectContext } from './project';
import {
  loadStoredAuthFromJson,
  saveStoredAuthToJson,
  setStoredAuthOverrideForTesting,
} from './v2-storage';
import { createV2FetchInterceptor } from './v2-fetch';
import { registerV2SessionHooks } from './v2-session';
import { initDiskSignatureCache, getDiskSignatureCache, resetDiskSignatureCacheForTesting } from './cache';
import { initTurnStateTracker } from '../sdk/request';
import { initCooldownPersistence } from '../sdk/retry';
import { loadAccountModels } from './dynamic-models';

// Re-export common symbols for backward compatibility
export { getSafeHeader, setSafeHeaders, toUrlString } from './headers';
export { resolveModelTier } from './tier';
export { getDiskSignatureCache, resetDiskSignatureCacheForTesting } from './cache';
export {
  loadStoredAuthFromJson,
  saveStoredAuthToJson,
  setStoredAuthOverrideForTesting,
} from './v2-storage';
export { createV2FetchInterceptor } from './v2-fetch';
export {
  AGY_V2_QUOTA_COMMAND,
  AGY_V2_QUOTA_SUMMARY_COMMAND,
  AGY_V2_QUOTA_COMMAND_TEMPLATE,
  AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE,
};

/**
 * Setup adapter for OpenCode v2 plugin architecture.
 */
export async function setupOpenCodeV2(ctx: OpenCodeV2PluginContext): Promise<void | (() => void)> {
  // 0. Initialize persistent caches and tracking
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

  // 1. Register provider and models
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

  const updateProviderRecord = (p: any) => {
    p.name = 'Antigravity CLI';
    p.activation = 'enabled';
    p.package = 'aisdk:@ai-sdk/google';
    p.description = 'Google Gemini Antigravity Code Assist OAuth provider';
    p.settings = { ...(p.settings || {}), apiKey: 'dummy' };
    p.integrationID = AGY_PROVIDER_ID;
  };

  const buildModelRecord = (modelId: string, simple: any, existingModel?: any) => {
    const isClaude = modelId.startsWith('claude-');
    const isGpt = modelId.startsWith('gpt-');
    const variants = resolveVariants(modelId);
    return {
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
        output: simple.maxOutputTokens,
      },
      cost: simple.cost || { input: 0, output: 0 },
      ...(variants ? { variants } : {}),
      ...(existingModel || {}),
    };
  };

  const updateModelRecord = (m: any, modelId: string, simple: any) => {
    m.name = simple.name;
    m.capabilities = {
      tools: simple.toolCall,
      input: simple.attachment ? ['text', 'image'] : ['text'],
      output: ['text'],
    };
    m.limit = {
      context: simple.maxTokens,
      output: simple.maxOutputTokens,
    };
    m.family = modelId.startsWith('claude-') ? 'claude' : modelId.startsWith('gpt-') ? 'gpt' : 'gemini';
    if (simple.cost) {
      m.cost = simple.cost;
    }
    const variants = resolveVariants(modelId);
    if (variants) {
      m.variants = variants;
    }
  };

  // OpenCode v2.0.8+ splits catalog into top-level provider and model services
  if (ctx.provider?.transform) {
    ctx.provider.transform(async (editor: any) => {
      if (!editor) return;
      if (typeof editor.update === 'function') {
        editor.update(AGY_PROVIDER_ID, updateProviderRecord);
      } else if (typeof editor.set === 'function') {
        const p: any = { id: AGY_PROVIDER_ID };
        updateProviderRecord(p);
        editor.set(AGY_PROVIDER_ID, p);
      } else if (typeof editor === 'object') {
        const p: any = editor[AGY_PROVIDER_ID] || { id: AGY_PROVIDER_ID };
        updateProviderRecord(p);
        editor[AGY_PROVIDER_ID] = p;
      }
    });
  }

  let accountModels: typeof STATIC_MODELS_SIMPLE | undefined;
  const modelService = ctx.model as any;
  const canDiscover = typeof modelService?.reload === 'function' && typeof (ctx.integration as any)?.connection?.active === 'function';
  if (canDiscover) {
    try {
      accountModels = await loadAccountModels(ctx);
    } catch {
      console.warn('[Agy Auth] Model discovery unavailable; using the built-in catalog.');
    }
  }
  if (ctx.model?.transform) {
    ctx.model.transform(async (editor: any) => {
      if (!editor) return;
      if (typeof editor.update === 'function') {
        for (const [modelId, simple] of Object.entries(accountModels || STATIC_MODELS_SIMPLE)) {
          editor.update(AGY_PROVIDER_ID, modelId, (m: any) => updateModelRecord(m, modelId, simple));
        }
      } else if (typeof editor.set === 'function') {
        for (const [modelId, simple] of Object.entries(STATIC_MODELS_SIMPLE)) {
          const m = buildModelRecord(modelId, simple);
          editor.set(`${AGY_PROVIDER_ID}:${modelId}`, m);
        }
      } else if (typeof editor === 'object') {
        for (const [modelId, simple] of Object.entries(STATIC_MODELS_SIMPLE)) {
          const key = `${AGY_PROVIDER_ID}:${modelId}`;
          editor[key] = buildModelRecord(modelId, simple, editor[key]);
        }
      }
    });
  }

  // OpenCode v2 <= 2.0.7 legacy catalog transform fallback
  if (ctx.catalog?.transform) {
    ctx.catalog.transform(async (editor: any) => {
      if (!editor) return;

      if (typeof editor?.provider?.update === 'function') {
        editor.provider.update(AGY_PROVIDER_ID, updateProviderRecord);

        if (typeof editor?.model?.update === 'function') {
          for (const [modelId, simple] of Object.entries(STATIC_MODELS_SIMPLE)) {
            editor.model.update(AGY_PROVIDER_ID, modelId, (m: any) => updateModelRecord(m, modelId, simple));
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
        ...catalog.providers[AGY_PROVIDER_ID],
      };
      if (catalog.providers[AGY_PROVIDER_ID].settings) {
        catalog.providers[AGY_PROVIDER_ID].settings = {
          ...catalog.providers[AGY_PROVIDER_ID].settings,
          apiKey: 'dummy',
        };
      } else {
        catalog.providers[AGY_PROVIDER_ID].settings = { apiKey: 'dummy' };
      }
      catalog.providers[AGY_PROVIDER_ID].integrationID = AGY_PROVIDER_ID;

      const targetModels = catalog.providers[AGY_PROVIDER_ID].models;

      for (const [modelId, simple] of Object.entries(STATIC_MODELS_SIMPLE)) {
        targetModels[modelId] = buildModelRecord(modelId, simple, targetModels[modelId]);
      }
    });
  }

  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  if (canDiscover) {
    discoveryTimer = setInterval(async () => {
      try {
        accountModels = await loadAccountModels(ctx);
        await modelService.reload();
      } catch {
        console.warn('[Agy Auth] Model discovery refresh failed; keeping the last catalog.');
      }
    }, 5 * 60 * 1000);
    discoveryTimer.unref?.();
  }

  // 2. Register agy_quota and agy_quota_summary tools via tool transform
  ctx.tool.transform(async (editor: any) => {
    if (!editor) return;

    const v2Client = {
      auth: {
        set: async ({ body }: any) => {
          if (body) {
            saveStoredAuthToJson(body);
          }
        },
      },
    } as any;

    const resolveV2Auth = (): (() => Promise<any>) | undefined => {
      const connApi = (ctx.integration as any)?.connection;
      const stored = loadStoredAuthFromJson();
      if (!stored && typeof connApi?.active !== 'function') {
        return undefined;
      }
      return async () => {
        if (typeof connApi?.active === 'function' && typeof connApi?.resolve === 'function') {
          try {
            const active = await connApi.active(AGY_PROVIDER_ID);
            if (active) {
              const resolved = await connApi.resolve(active);
              if (resolved?.type === 'credential' && resolved.credential?.type === 'oauth') {
                return {
                  type: 'oauth',
                  access: resolved.credential.access,
                  refresh: resolved.credential.refresh,
                  expires: resolved.credential.expires,
                };
              }
            }
          } catch {
            // Fall back to stored auth JSON
          }
        }
        return loadStoredAuthFromJson();
      };
    };

    const quotaTool = createAgyQuotaTool({
      client: v2Client,
      getAuthResolver: resolveV2Auth,
      getConfiguredProjectId: () => undefined,
      getUserAgentModel: () => undefined,
    });

    const quotaSummaryTool = createAgyQuotaSummaryTool({
      client: v2Client,
      getAuthResolver: resolveV2Auth,
      getConfiguredProjectId: () => undefined,
      getUserAgentModel: () => undefined,
    });

    const emptyObjectSchema = {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    };

    if (typeof editor.add === 'function') {
      editor.add({
        name: AGY_QUOTA_TOOL_NAME,
        description: quotaTool.description,
        input: emptyObjectSchema,
        execute: async (args: any, context: any) => {
          const result = await (quotaTool as any).execute(args, context);
          return typeof result === 'string' ? { content: result } : result;
        },
      });
      editor.add({
        name: AGY_QUOTA_SUMMARY_TOOL_NAME,
        description: quotaSummaryTool.description,
        input: emptyObjectSchema,
        execute: async (args: any, context: any) => {
          const result = await (quotaSummaryTool as any).execute(args, context);
          return typeof result === 'string' ? { content: result } : result;
        },
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
        template: AGY_V2_QUOTA_COMMAND_TEMPLATE,
      },
      [AGY_V2_QUOTA_SUMMARY_COMMAND]: {
        description: 'Show Agy Code Assist quota summary with weekly and 5-hour limits',
        template: AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE,
      },
    };

    if (typeof editor.add === 'function') {
      editor.add({
        name: AGY_V2_QUOTA_COMMAND,
        description: 'Display current Antigravity quota usage',
        template: AGY_V2_QUOTA_COMMAND_TEMPLATE,
        execute: async ({ sessionID, prompt, delivery }: any = {}) => {
          await ctx.session?.prompt?.({
            ...prompt,
            sessionID,
            text: AGY_V2_QUOTA_COMMAND_TEMPLATE,
            delivery,
          });
        },
      });
      editor.add({
        name: AGY_V2_QUOTA_SUMMARY_COMMAND,
        description: 'Display Antigravity quota summary grouped by model family',
        template: AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE,
        execute: async ({ sessionID, prompt, delivery }: any = {}) => {
          await ctx.session?.prompt?.({
            ...prompt,
            sessionID,
            text: AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE,
            delivery,
          });
        },
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
        label: 'Antigravity CLI (OAuth)',
      },
      authorize: async () => {
        const authorization = await authorizeAgy();

        return {
          mode: 'code',
          url: authorization.url,
          instructions:
            'Please complete Google account authorization in your browser. After authorization, copy the full redirect URL or code and paste it below:',
          callback: async (code: string) => {
            const trimmed = code.trim();
            const parsed = parseOAuthCallbackInput(trimmed);
            const authCode = parsed.code || trimmed;

            if (!authCode) {
              return { type: 'failed', error: 'Missing authorization code in callback input' };
            }

            if (parsed.state && parsed.state !== authorization.state) {
              return { type: 'failed', error: 'State mismatch in callback input (possible CSRF attempt)' };
            }

            const exchangeResult = await exchangeAgyWithVerifier(authCode, authorization.verifier);
            if (exchangeResult.type !== 'success') {
              return exchangeResult;
            }

            const initialRefresh = formatRefreshParts({
              refreshToken: exchangeResult.refresh,
            });

            let authRecord = {
              type: 'oauth' as const,
              refresh: initialRefresh,
              access: exchangeResult.access,
              expires: exchangeResult.expires,
            };

            try {
              const projectContext = await ensureProjectContext(
                authRecord,
                { auth: { set: async () => {} } } as any
              );
              authRecord = {
                ...authRecord,
                refresh: projectContext.auth.refresh,
              };
            } catch {
              // Ignore project resolution error during authorize
            }

            try {
              saveStoredAuthToJson(authRecord);
            } catch {
              return {
                type: 'failed',
                error: 'Google authentication succeeded but AGY credentials could not be stored. Check filesystem access and retry.',
              };
            }

            return {
              type: 'oauth',
              methodID: 'oauth',
              refresh: authRecord.refresh,
              access: authRecord.access,
              expires: authRecord.expires,
            };
          },
        };
      },
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

  // 6. Register session hooks (http.request, http.response, retry)
  registerV2SessionHooks(ctx);
  return () => { if (discoveryTimer) clearInterval(discoveryTimer); };
}

export const v2PluginDefinition: OpenCodeV2PluginDefinition = defineOpenCodeV2Plugin({
  id: AGY_PROVIDER_ID,
  setup: setupOpenCodeV2,
});

export const createV2PluginDefinition = (): OpenCodeV2PluginDefinition => v2PluginDefinition;

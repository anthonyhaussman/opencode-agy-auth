import { AGY_PROVIDER_ID } from '../constants';
import { STATIC_MODELS_SIMPLE, TIER_MAPPING, type SimpleStaticModel, type TierMap } from './tier';
import { loadAccountModels, type AccountModelInventory } from './dynamic-models';
import { applyPricingToSimpleModels } from './pricing';
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
import { createV2FetchInterceptor, type V2RuntimeCatalog } from './v2-fetch';
import { registerV2SessionHooks } from './v2-session';
import { initDiskSignatureCache, getDiskSignatureCache, resetDiskSignatureCacheForTesting } from './cache';
import { initTurnStateTracker } from '../sdk/request';
import { initCooldownPersistence } from '../sdk/retry';

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
export async function setupOpenCodeV2(
  ctx: OpenCodeV2PluginContext
): Promise<(() => void) | void> {
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

  let inventory: AccountModelInventory | undefined;
  let activeConnectionId: string | undefined;
  let inflightRefresh: Promise<AccountModelInventory | undefined> | null = null;
  let disposed = false;

  const staticModels: Record<string, SimpleStaticModel> = structuredClone(STATIC_MODELS_SIMPLE);
  void applyPricingToSimpleModels(staticModels);

  const providerService = ctx.provider;
  const modelService = ctx.model;
  const connectionService = (ctx.integration as any)?.connection;
  const canDiscover = typeof connectionService?.active === 'function';
  const hasReload =
    typeof providerService?.reload === 'function' || typeof modelService?.reload === 'function';

  const warn = (msg: string) => {
    if (typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn(msg);
    } else {
      console.warn(msg);
    }
  };

  const getActiveInventory = (): AccountModelInventory | undefined => {
    if (!inventory) return undefined;
    if (activeConnectionId === undefined || inventory.connection.id !== activeConnectionId) {
      return undefined;
    }
    return inventory;
  };

  const reloadCatalog = async (): Promise<void> => {
    if (disposed) return;
    try {
      if (typeof providerService?.reload === 'function') {
        await providerService.reload();
      } else if (typeof modelService?.reload === 'function') {
        await modelService.reload();
      }
    } catch (err) {
      warn(`[Agy Auth] Catalog reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const readActiveCredentialConnection = async (): Promise<
    { type: 'credential'; id: string } | undefined
  > => {
    if (typeof connectionService?.active !== 'function') {
      return undefined;
    }
    try {
      const raw = await connectionService.active(AGY_PROVIDER_ID);
      if (
        raw &&
        typeof raw === 'object' &&
        (raw as any).type === 'credential' &&
        typeof (raw as any).id === 'string' &&
        (raw as any).id.length > 0
      ) {
        return { type: 'credential', id: (raw as any).id };
      }
    } catch {
      // Ignore connection lookup failure
    }
    return undefined;
  };

  const refreshModels = (): Promise<AccountModelInventory | undefined> => {
    if (disposed || !canDiscover) {
      return Promise.resolve(undefined);
    }
    if (inflightRefresh) {
      return inflightRefresh;
    }

    const run = (async (): Promise<AccountModelInventory | undefined> => {
      const active = await readActiveCredentialConnection();
      if (disposed) return undefined;

      if (!active) {
        const hadInventory = Boolean(inventory);
        inventory = undefined;
        activeConnectionId = undefined;
        if (hadInventory) {
          await reloadCatalog();
        }
        return undefined;
      }

      if (activeConnectionId !== active.id) {
        activeConnectionId = active.id;
      }

      try {
        let loaded = await loadAccountModels(ctx);
        if (disposed) return undefined;

        let currentActive = await readActiveCredentialConnection();
        if (disposed) return undefined;

        if (!currentActive) {
          const hadInventory = Boolean(inventory);
          inventory = undefined;
          activeConnectionId = undefined;
          if (hadInventory) {
            await reloadCatalog();
          }
          return undefined;
        }

        if (loaded && currentActive.id !== loaded.connection.id) {
          activeConnectionId = currentActive.id;
          loaded = await loadAccountModels(ctx);
          if (disposed) return undefined;
          currentActive = await readActiveCredentialConnection();
          if (disposed) return undefined;
          if (!currentActive) {
            const hadInventory = Boolean(inventory);
            inventory = undefined;
            activeConnectionId = undefined;
            if (hadInventory) {
              await reloadCatalog();
            }
            return undefined;
          }
        }

        if (loaded && currentActive.id === loaded.connection.id) {
          inventory = loaded;
          activeConnectionId = currentActive.id;
          await reloadCatalog();
          return inventory;
        }

        return getActiveInventory();
      } catch (err) {
        warn(
          `[Agy Auth] Account model discovery failed: ${err instanceof Error ? err.message : String(err)}`
        );
        if (!inventory || inventory.connection.id !== active.id) {
          const hadInventory = Boolean(inventory);
          inventory = undefined;
          if (hadInventory) {
            await reloadCatalog();
          }
        }
        return getActiveInventory();
      }
    })();

    const tracked = run.finally(() => {
      if (inflightRefresh === tracked) {
        inflightRefresh = null;
      }
    });

    inflightRefresh = tracked;
    return tracked;
  };

  const resolveRuntimeCatalog = async (variant?: string): Promise<V2RuntimeCatalog | undefined> => {
    if (canDiscover) {
      const active = await readActiveCredentialConnection();
      if (!active) {
        if (inventory !== undefined) {
          inventory = undefined;
          activeConnectionId = undefined;
          void reloadCatalog();
        }
        return variant ? { variant } : undefined;
      }
      if (!inventory || inventory.connection.id !== active.id) {
        await refreshModels();
      }
    }

    const activeInv = getActiveInventory();
    if (!activeInv) {
      return variant ? { variant } : undefined;
    }

    return {
      enums: activeInv.enums,
      tierMapping: activeInv.tierMapping,
      ...(variant ? { variant } : {}),
    };
  };

  // 1. Register provider and models
  const resolveVariants = (
    modelId: string,
    tierMapSource: Readonly<Record<string, TierMap>> = TIER_MAPPING
  ) => {
    const mapping = tierMapSource[modelId];
    if (!mapping) return undefined;
    const variants: Array<{ id: string; headers: { 'x-agy-tier': string } }> = [];
    if (mapping.minimal !== undefined) {
      variants.push({ id: 'minimal', headers: { 'x-agy-tier': 'minimal' } });
    }
    if (mapping.low !== undefined) {
      variants.push({ id: 'low', headers: { 'x-agy-tier': 'low' } });
    }
    if (mapping.medium !== undefined) {
      variants.push({ id: 'medium', headers: { 'x-agy-tier': 'medium' } });
    }
    if (mapping.high !== undefined) {
      variants.push({ id: 'high', headers: { 'x-agy-tier': 'high' } });
    }
    return variants.length > 0 ? variants : undefined;
  };

  const resolveModelFamily = (modelId: string): string => {
    if (modelId.includes('gemini')) return 'gemini';
    if (modelId.startsWith('claude-') || modelId.startsWith('claude')) return 'claude';
    if (modelId.startsWith('gpt-') || modelId.startsWith('gpt')) return 'gpt';
    return 'unknown';
  };

  const updateProviderRecord = (p: any) => {
    p.name = 'Antigravity CLI';
    p.activation = 'enabled';
    p.package = 'aisdk:@ai-sdk/google';
    p.description = 'Google Gemini Antigravity Code Assist OAuth provider';
    p.settings = { ...(p.settings || {}), apiKey: 'dummy' };
    p.integrationID = AGY_PROVIDER_ID;
  };

  const buildModelRecord = (
    modelId: string,
    simple: SimpleStaticModel,
    existingModel?: any,
    tierMapSource: Readonly<Record<string, TierMap>> = TIER_MAPPING
  ) => {
    const variants = resolveVariants(modelId, tierMapSource);
    const record: any = {
      id: modelId,
      providerID: AGY_PROVIDER_ID,
      name: simple.name,
      description: simple.description,
      family: resolveModelFamily(modelId),
      reasoning: simple.reasoning,
      attachment: simple.attachment,
      tool_call: simple.toolCall,
      capabilities: {
        tools: Boolean(simple.toolCall),
        reasoning: Boolean(simple.reasoning),
        input: simple.attachment ? ['text', 'image'] : ['text'],
        output: ['text'],
      },
      limit: {
        context: simple.maxTokens,
        output: simple.maxOutputTokens,
      },
      cost: simple.cost || { input: 0, output: 0 },
      ...(variants ? { variants } : {}),
      ...(existingModel || {}),
    };
    if (simple.cost) {
      record.cost = simple.cost;
    }
    if (variants) {
      record.variants = variants;
    }
    return record;
  };

  const updateModelRecord = (
    m: any,
    modelId: string,
    simple: SimpleStaticModel,
    tierMapSource: Readonly<Record<string, TierMap>> = TIER_MAPPING
  ) => {
    m.name = simple.name;
    m.description = simple.description;
    m.reasoning = simple.reasoning;
    m.attachment = simple.attachment;
    m.tool_call = simple.toolCall;
    m.capabilities = {
      tools: Boolean(simple.toolCall),
      reasoning: Boolean(simple.reasoning),
      input: simple.attachment ? ['text', 'image'] : ['text'],
      output: ['text'],
    };
    m.limit = {
      context: simple.maxTokens,
      output: simple.maxOutputTokens,
    };
    m.family = resolveModelFamily(modelId);
    if (simple.cost) {
      m.cost = simple.cost;
    }
    const variants = resolveVariants(modelId, tierMapSource);
    if (variants) {
      m.variants = variants;
    } else {
      delete m.variants;
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

  if (ctx.model?.transform) {
    ctx.model.transform(async (editor: any) => {
      if (!editor) return;
      const activeInv = getActiveInventory();
      const modelsToRegister = activeInv?.models ?? staticModels;
      const tierMapSource = activeInv?.tierMapping ?? TIER_MAPPING;

      if (typeof editor.update === 'function') {
        for (const [modelId, simple] of Object.entries(modelsToRegister)) {
          editor.update(AGY_PROVIDER_ID, modelId, (m: any) =>
            updateModelRecord(m, modelId, simple, tierMapSource)
          );
        }
      } else if (typeof editor.set === 'function') {
        for (const [modelId, simple] of Object.entries(modelsToRegister)) {
          const m = buildModelRecord(modelId, simple, undefined, tierMapSource);
          editor.set(`${AGY_PROVIDER_ID}:${modelId}`, m);
        }
      } else if (typeof editor === 'object') {
        for (const [modelId, simple] of Object.entries(modelsToRegister)) {
          const key = `${AGY_PROVIDER_ID}:${modelId}`;
          editor[key] = buildModelRecord(modelId, simple, editor[key], tierMapSource);
        }
      }
    });
  }

  // OpenCode v2 <= 2.0.7 legacy catalog transform fallback
  if (ctx.catalog?.transform) {
    ctx.catalog.transform(async (editor: any) => {
      if (!editor) return;
      const activeInv = getActiveInventory();
      const modelsToRegister = activeInv?.models ?? staticModels;
      const tierMapSource = activeInv?.tierMapping ?? TIER_MAPPING;

      if (typeof editor?.provider?.update === 'function') {
        editor.provider.update(AGY_PROVIDER_ID, updateProviderRecord);

        if (typeof editor?.model?.update === 'function') {
          for (const [modelId, simple] of Object.entries(modelsToRegister)) {
            editor.model.update(AGY_PROVIDER_ID, modelId, (m: any) =>
              updateModelRecord(m, modelId, simple, tierMapSource)
            );
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

      for (const [modelId, simple] of Object.entries(modelsToRegister)) {
        targetModels[modelId] = buildModelRecord(
          modelId,
          simple,
          targetModels[modelId],
          tierMapSource
        );
      }
    });
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

            const refreshTimer = setTimeout(() => {
              void refreshModels();
            }, 50);
            (refreshTimer as any)?.unref?.();

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
  const resolveActiveOAuthFromConnection = async () => {
    if (
      typeof connectionService?.active !== 'function' ||
      typeof connectionService?.resolve !== 'function'
    ) {
      return undefined;
    }
    try {
      const active = await connectionService.active(AGY_PROVIDER_ID);
      if (!active) return undefined;
      const resolved = await connectionService.resolve(active);
      const cred =
        resolved?.type === 'credential' && resolved.credential
          ? resolved.credential
          : resolved?.type === 'oauth'
            ? resolved
            : undefined;
      if (
        cred?.type === 'oauth' &&
        typeof cred.access === 'string' &&
        typeof cred.refresh === 'string'
      ) {
        return {
          type: 'oauth' as const,
          access: cred.access,
          refresh: cred.refresh,
          expires: typeof cred.expires === 'number' ? cred.expires : 0,
        };
      }
    } catch {
      // Fall back to stored auth JSON
    }
    return undefined;
  };

  ctx.aisdk?.hook('sdk', async (event: any) => {
    if (!event) return;
    const isMatchingProvider =
      event.providerID === AGY_PROVIDER_ID ||
      event.model?.providerID === AGY_PROVIDER_ID;

    if (!isMatchingProvider) return;

    const rawModelVariant = event.model?.variant;
    const modelVariant =
      typeof rawModelVariant === 'string' && rawModelVariant.length > 0
        ? rawModelVariant
        : typeof event.variant === 'string' && event.variant.length > 0
          ? event.variant
          : undefined;

    event.options = event.options || {};
    event.options.apiKey = 'dummy';
    event.options.fetch = createV2FetchInterceptor(
      resolveActiveOAuthFromConnection,
      () => resolveRuntimeCatalog(modelVariant)
    );
  });

  // 6. Register session hooks (http.request, http.response, retry)
  registerV2SessionHooks(ctx, () => resolveRuntimeCatalog());

  // 7. Reactive discovery lifecycle (startup, events, 5-minute interval, disposer)
  if (canDiscover && hasReload) {
    const unsubscribe = ctx.event?.subscribe?.((evt: any) => {
      const type = String(evt?.type ?? evt?.name ?? '');
      if (/integration|connection|auth|provider|config/i.test(type)) {
        void refreshModels();
      }
    });

    void refreshModels();

    const timer = setInterval(() => {
      void refreshModels();
    }, 5 * 60 * 1000);
    (timer as any)?.unref?.();

    return () => {
      disposed = true;
      clearInterval(timer);
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }
}

export const v2PluginDefinition: OpenCodeV2PluginDefinition = defineOpenCodeV2Plugin({
  id: AGY_PROVIDER_ID,
  setup: setupOpenCodeV2,
});

export const createV2PluginDefinition = (): OpenCodeV2PluginDefinition => v2PluginDefinition;

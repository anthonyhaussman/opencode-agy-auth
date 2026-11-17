import { updateStaticModelsWithPricing } from './plugin/pricing';
import type { Config } from './plugin/types';
import { AGY_PROVIDER_ID } from './constants';
import { agyFetch } from './fetch';
import { createOAuthAuthorizeMethod } from './plugin/oauth-authorize';
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from './plugin/auth';
import { resolveCachedAuth, initDiskSignatureCache } from './plugin/cache';
import { initTurnStateTracker } from './sdk/request/turn-state-tracker';
import { initCooldownPersistence } from './sdk/retry';
import { ensureProjectContext, retrieveUserQuota, resolveProjectContextFromAccessToken } from './plugin/project';
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
  rewriteRequestedModelInInput,
  type ThinkingConfigDefaults,
  transformAgyResponse
} from './sdk/request';
import { createChatLogger } from './sdk/chat-logger';
import { fetchWithRetry } from './sdk/retry';
import { refreshAccessToken } from './plugin/token';
import { loadStoredAuthFromJson, loadAccountStore, loadAccountAuth, splitAccountModel, accountModelKey } from './plugin/v2-storage';
import { getModelEnums } from './plugin/model-enums';
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

// Account health: a 429 means that specific account is out of quota, not that
// the provider is broken. Track it so the next request can fail over instead of
// re-spending the same exhausted bucket.
const exhaustedAccounts = new Map<string, number>();
const EXHAUSTION_TTL_MS = 30 * 60 * 1000;

const isAccountExhausted = (name: string | undefined): boolean => {
  if (!name) return false;
  const until = exhaustedAccounts.get(name);
  if (!until) return false;
  if (Date.now() > until) {
    exhaustedAccounts.delete(name);
    return false;
  }
  return true;
};

const markAccountExhausted = (name: string | undefined): void => {
  if (!name) return;
  exhaustedAccounts.set(name, Date.now() + EXHAUSTION_TTL_MS);
};

/** Pick the account to authenticate with: requested → first healthy → requested. */
const pickUsableAccount = (requested: string | undefined): string | undefined => {
  const store = loadAccountStore();
  const usable = Object.keys(store.accounts).filter((name) => {
    const record = store.accounts[name];
    return Boolean(record?.refresh) && !record?.needsCredentials;
  });
  if (usable.length === 0) {
    return undefined;
  }
  if (requested && usable.includes(requested) && !isAccountExhausted(requested)) {
    return requested;
  }
  const fallback = usable.find((name) => !isAccountExhausted(name));
  return fallback ?? requested ?? usable[0];
};

/**
 * Build a ProviderModel from a base model ID and its tier variants.
 * All metadata inferred dynamically — zero hardcoding.
 * Matches the OpenCode SDK Model type exactly.
 */
const buildModelFromBase = (
  baseModelId: string,
  tierVariants: Record<string, string>,
  account?: string
): ProviderModel => {
  const metadata = inferModelMetadata(baseModelId);
  const isClaude = baseModelId.startsWith('claude-');
  const isGpt = baseModelId.startsWith('gpt-');
  const namespacedId = account ? accountModelKey(account, baseModelId) : baseModelId;

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
    id: namespacedId,
    providerID: AGY_PROVIDER_ID,
    api: {
      id: AGY_PROVIDER_ID,
      url: 'https://cloudcode-pa.googleapis.com',
      npm: '@ai-sdk/google'
    },
    name: account ? `${metadata.name} [${account}]` : metadata.name,
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

  // Client stub for startup-time paths: the `config` hook runs DURING config
  // resolution, so touching the real client (config.get/auth.set) can deadlock.
  // Token refresh works without persistence here; the loader persists on use.
  const NOOP_CLIENT = { auth: { set: async () => {} } } as unknown as PluginClient;

  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

  // Resolve a usable OAuth record: explicit ctx auth → resolver → stored JSON,
  // refreshing an expired access token when needed.
  const resolveListingAuth = async (
    ctxAuth: unknown,
    useClient: boolean
  ): Promise<OAuthAuthDetails | null> => {
    let auth: any = ctxAuth;
    if (!auth && useClient && latestAgyAuthResolver) {
      try {
        auth = await latestAgyAuthResolver();
      } catch {
        auth = undefined;
      }
    }
    if (!auth || !isOAuthAuth(auth)) {
      auth = loadStoredAuthFromJson();
    }
    if (!auth || !isOAuthAuth(auth)) {
      return null;
    }
    let record = resolveCachedAuth(auth);
    if (accessTokenExpired(record) || !record.access) {
      const refreshed = await refreshAccessToken(record, useClient ? client : NOOP_CLIENT);
      if (!refreshed) {
        return null;
      }
      record = refreshed;
    }
    return record;
  };

  // Resolve project id WITHOUT touching client when useClient=false
  // (config-hook time). Order: provider options → env → refresh-token parts.
  const resolveListingProjectId = async (
    provider: ProviderV2,
    authRecord: OAuthAuthDetails,
    useClient: boolean,
    preferAccountProject = false
  ): Promise<string | undefined> => {
    if (useClient && !preferAccountProject) {
      const viaClient = await resolveLatestConfiguredProjectId(provider);
      if (viaClient) return viaClient;
    }
    if (!preferAccountProject) {
      const viaSync = resolveConfiguredProjectId({ provider: provider as unknown as Provider });
      if (viaSync) return viaSync;
    }
    // Prefer the managed project the backend reports for THIS account over the
    // project id embedded in the refresh token: the embedded one can belong to
    // another/stale project and yields "Resource has been exhausted" (429) even
    // when the account's real quota is untouched.
    try {
      const discovered = await withTimeout(
        resolveProjectContextFromAccessToken(authRecord, authRecord.access, undefined, undefined, latestAgyUserAgentModel).catch(() => null),
        15000
      );
      const effective = discovered?.effectiveProjectId?.trim();
      if (effective) {
        return effective;
      }
    } catch {
      // fall through to the embedded project id
    }
    const parts = parseRefreshParts(authRecord.refresh);
    if (parts.projectId) return parts.projectId;
    return undefined;
  };

  // Build dynamic model list for provider hook (used when user opens model picker)
  // Returns null when no usable auth/project is available (caller shows login-required).
  // useClient=false for startup-time (config hook) callers: never touches `client`.
  // MULTI-ACCOUNT: each account declared in auth.json["google-agy"].accounts is
  // exposed as its own model namespace `<account>/<model>`. Picking that model in
  // OpenCode selects the account; legacy single-account installs keep bare ids.
  const getDynamicModels = async (
    provider: ProviderV2,
    ctxAuth?: unknown,
    opts?: { useClient?: boolean }
  ): Promise<Record<string, ProviderModel> | null> => {
    const useClient = opts?.useClient ?? true;
    const store = loadAccountStore();
    const accountNames = Object.keys(store.accounts);
    const mergedModels: Record<string, ProviderModel> = {};

    const addAccountCatalog = async (account: string, record: OAuthAuthDetails): Promise<void> => {
      const projectId = await resolveListingProjectId(provider, record, useClient, true);
      if (!projectId) {
        return;
      }
      const { tierMapping } = await buildDynamicModelCatalog(
        record.access,
        projectId,
        latestAgyUserAgentModel
      );
      for (const [base, variants] of Object.entries(tierMapping)) {
        dynamicTierMapping[base] = { ...(dynamicTierMapping[base] || {}), ...variants };
        const model = buildModelFromBase(base, variants, account);
        mergedModels[model.id] = model;
      }
    };

    if (accountNames.length > 0) {
      const activeName = store.activeAccount ?? accountNames[0];
      for (const name of accountNames) {
        const stored = store.accounts[name];
        // Stub entries (created by seedAccountFromActive) carry no credentials.
        if (!stored?.refresh || stored?.needsCredentials) {
          continue;
        }
        const seed = ctxAuth && name === activeName ? ctxAuth : stored;
        const record = await resolveListingAuth(seed, useClient);
        if (!record) {
          continue;
        }
        await addAccountCatalog(name, record);
      }
    } else {
      // Legacy single-account path: bare model ids, no namespace.
      const record = await resolveListingAuth(ctxAuth, useClient);
      if (!record) {
        return null;
      }
      const projectId = await resolveListingProjectId(provider, record, useClient);
      if (!projectId) {
        return null;
      }
      const { tierMapping } = await buildDynamicModelCatalog(
        record.access,
        projectId,
        latestAgyUserAgentModel
      );
      dynamicTierMapping = tierMapping;
      for (const [base, variants] of Object.entries(tierMapping)) {
        const model = buildModelFromBase(base, variants);
        mergedModels[model.id] = model;
      }
    }

    if (Object.keys(mergedModels).length === 0) {
      return null;
    }

    // Merge with user config overrides
    const userModels = provider.models || {};
    for (const [modelId, modelDetails] of Object.entries(mergedModels)) {
      const existing = userModels[modelId] as ProviderModel | undefined;
      if (!existing) {
        continue;
      }
      mergedModels[modelId] = {
        ...modelDetails,
        ...existing,
        capabilities: {
          ...(modelDetails.capabilities || {}),
          ...(existing.capabilities || {}),
          input: {
            ...(modelDetails.capabilities?.input || {}),
            ...(existing.capabilities?.input || {})
          },
          output: {
            ...(modelDetails.capabilities?.output || {}),
            ...(existing.capabilities?.output || {})
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

      // Populate dynamic models at config time so `opencode models` lists the live
      // AGY inventory (same source as `agy models`). useClient=false: the config
      // hook runs DURING config resolution, so it must never touch `client`
      // (config.get/auth.set would deadlock). The provider.models hook covers
      // later TUI-time refreshes. Hard 25s cap so a stalled network can never
      // hang server startup.
      try {
        const load = getDynamicModels(config.provider[AGY_PROVIDER_ID] as ProviderV2, undefined, {
          useClient: false,
        }).catch(() => null);
        const dynamic = await withTimeout(load, 25000);
        if (dynamic && Object.keys(dynamic).length > 0) {
          config.provider[AGY_PROVIDER_ID].models = dynamic;
        } else {
          config.provider[AGY_PROVIDER_ID].models = {};
        }
      } catch (e) {
        console.warn(`[Agy Auth] dynamic model load at config time failed: ${e instanceof Error ? e.message : e}`);
        config.provider[AGY_PROVIDER_ID].models = {};
      }
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
          // Placeholder: the @ai-sdk/google client refuses an empty key before
          // ever reaching our fetch interceptor. Requests are rewritten to the
          // AGY Code Assist endpoint and carry a Bearer token, so this value is
          // never used as a credential (the x-goog-api-key header is stripped).
          apiKey: 'antigravity-bridge',
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

            // Account routing: `<account>/<model>` selects that account's
            // credentials from auth.json; bare `<model>` falls back to the
            // authenticated (active) account for backwards compatibility.
            const requestedModelRaw = parseGenerativeLanguageRequest(input)?.effectiveModel;
            const decodedRequestedModel = (() => {
              if (!requestedModelRaw) return '';
              try {
                return decodeURIComponent(requestedModelRaw);
              } catch {
                return requestedModelRaw;
              }
            })();
            const routed = splitAccountModel(decodedRequestedModel);
            const routedAccount = routed.account;
            const bareRequestedModel = routed.model || decodedRequestedModel;

            const accountSource = routedAccount
              ? loadAccountAuth(routedAccount)
              : loadStoredAuthFromJson();
            // Failover: if the requested account is out of quota, authenticate
            // with the next healthy one instead of burning the same 429 again.
            const failoverAccount = pickUsableAccount(routedAccount);
            const routedAuthSource =
              failoverAccount && failoverAccount !== routedAccount
                ? loadAccountAuth(failoverAccount)
                : accountSource;

            let authRecord = resolveCachedAuth(
              routedAuthSource && isOAuthAuth(routedAuthSource) ? routedAuthSource : latestAuth
            );
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

            const configuredProjectId = routedAccount
              ? (parseRefreshParts(authRecord.refresh).projectId ?? undefined)
              : await resolveLatestConfiguredProjectId(provider);

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
            const requestUserAgentModel = bareRequestedModel || requestTarget?.effectiveModel;
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

            let modifiedInput = input;
            if (isGL && requestedModelRaw) {
              const resolvedBase = resolveModelTier(
                bareRequestedModel ?? requestedModelRaw,
                init,
                dynamicTierMapping
              );
              // The account prefix must ALWAYS be stripped before hitting the
              // AGY backend, even when tier resolution is a no-op. Handles both
              // `/models/<model>:` and the slash-namespaced `/<model>:` shapes.
              if (resolvedBase !== bareRequestedModel || routedAccount) {
                modifiedInput = rewriteRequestedModelInInput(
                  modifiedInput,
                  requestedModelRaw,
                  resolvedBase
                );
              }
            }

            const parts = parseRefreshParts(authRecord.refresh);
            // Model → backend enum map from the account's own catalogue: it is
            // what routes the call to the Antigravity quota bucket.
            const modelEnums =
              (await withTimeout(
                getModelEnums(
                  authRecord.access,
                  projectContext.effectiveProjectId,
                  requestUserAgentModel
                ).catch(() => undefined),
                8000
              )) ?? undefined;
            const transformed = prepareAgyRequest(
              modifiedInput,
              init,
              authRecord.access,
              projectContext.effectiveProjectId,
              thinkingConfigDefaults,
              modelEnums
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
            if (response.status === 429) {
              markAccountExhausted(failoverAccount ?? routedAccount);
            }
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
        const models = await withTimeout(
          getDynamicModels(provider, ctx?.auth, { useClient: true }).catch(() => null),
          25000
        );
        if (!models) {
          return {
            'login-required': {
              name: 'No models available'
            }
          };
        }
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
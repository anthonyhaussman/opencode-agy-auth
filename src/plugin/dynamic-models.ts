import { AGY_PROVIDER_ID } from '../constants';
import {
  fetchAvailableModels,
  type AvailableModelDetails,
  type FetchAvailableModelsResponse,
} from '../sdk/fetch_models';
import { loadManagedProject } from '../sdk/fetch_project';
import {
  accessTokenExpired,
  formatRefreshParts,
  isOAuthAuth,
  parseRefreshParts,
} from './auth';
import { resolveCachedAuth, storeCachedAuth } from './cache';
import { applyPricingToSimpleModels } from './pricing';
import { ensureProjectContext } from './project/context';
import { normalizeProjectId } from './project/utils';
import {
  STATIC_MODELS_SIMPLE,
  TIER_MAPPING,
  type SimpleStaticModel,
  type TierMap,
  type TierName,
} from './tier';
import { refreshAccessToken } from './token';
import type { OAuthAuthDetails, OpenCodeV2PluginContext, PluginClient } from './types';
import { saveStoredAuthToJson } from './v2-storage';

const DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const TIER_SUFFIX_RE = /^(.+)-(minimal|low|medium|high)$/i;
const DISPLAY_TIER_SUFFIX_RE =
  /(?:\s*\((?:minimal|low|medium|high)\)|\s+-\s*(?:minimal|low|medium|high))$/i;
const CANONICAL_TIER_ORDER: readonly TierName[] = ['minimal', 'low', 'medium', 'high'];

export interface NormalizedModelCatalog {
  models: Record<string, SimpleStaticModel>;
  tierMapping: Record<string, TierMap>;
  enums: Record<string, string>;
}

export interface AccountModelInventory extends NormalizedModelCatalog {
  connection: { type: 'credential'; id: string };
}

export interface V2IntegrationConnectionApi {
  active?: (providerId: string) => Promise<unknown> | unknown;
  resolve?: (connection: { type: 'credential'; id: string }) => Promise<unknown> | unknown;
}

export type AccountModelsContext = Omit<Partial<OpenCodeV2PluginContext>, 'integration'> & {
  integration?:
    | (OpenCodeV2PluginContext['integration'] & {
        connection?: V2IntegrationConnectionApi;
      })
    | {
        connection?: V2IntegrationConnectionApi;
      };
};

interface ParsedTierSuffix {
  base: string;
  tier: TierName;
}

interface SelectableModelEntry {
  rawId: string;
  details: AvailableModelDetails;
  parsedTier?: ParsedTierSuffix;
}

interface TargetModelGroup {
  targetId: string;
  collapsed: boolean;
  entries: Array<{
    rawId: string;
    details: AvailableModelDetails;
    tier?: TierName;
  }>;
}

function parseTierSuffix(rawId: string): ParsedTierSuffix | undefined {
  const match = TIER_SUFFIX_RE.exec(rawId);
  if (!match || !match[1] || !match[2]) {
    return undefined;
  }
  return {
    base: match[1],
    tier: match[2].toLowerCase() as TierName,
  };
}

function extractOAuthCredential(resolved: unknown): OAuthAuthDetails | undefined {
  if (!resolved || typeof resolved !== 'object') {
    return undefined;
  }

  const record = resolved as Record<string, unknown>;
  const candidate =
    record.credential && typeof record.credential === 'object'
      ? record.type !== undefined && record.type !== 'credential'
        ? undefined
        : (record.credential as Record<string, unknown>)
      : record;

  if (!candidate || candidate.type !== 'oauth') {
    return undefined;
  }

  const authCandidate = {
    type: 'oauth' as const,
    refresh: typeof candidate.refresh === 'string' ? candidate.refresh : '',
    access: typeof candidate.access === 'string' ? candidate.access : '',
    expires: typeof candidate.expires === 'number' ? candidate.expires : 0,
  };

  return isOAuthAuth(authCandidate) ? authCandidate : undefined;
}

/**
 * Normalizes an Antigravity fetchAvailableModels payload into OpenCode base models,
 * dynamic tier mappings, and full server model enum lookup entries.
 */
export function normalizeDiscoveredModels(
  response: FetchAvailableModelsResponse
): NormalizedModelCatalog {
  if (!response || !response.models || typeof response.models !== 'object') {
    throw new Error('Invalid fetchAvailableModels response: missing models catalog');
  }

  if (!Array.isArray(response.agentModelSorts) || response.agentModelSorts.length === 0) {
    throw new Error('Invalid fetchAvailableModels response: missing agentModelSorts');
  }

  const enums: Record<string, string> = {};
  for (const [rawId, details] of Object.entries(response.models)) {
    if (details && typeof details.model === 'string') {
      const trimmedEnum = details.model.trim();
      if (trimmedEnum.length > 0) {
        enums[rawId] = trimmedEnum;
      }
    }
  }

  const selectableEntries: SelectableModelEntry[] = [];
  const seenRawIds = new Set<string>();

  for (const sort of response.agentModelSorts) {
    for (const group of sort?.groups ?? []) {
      for (const rawId of group?.modelIds ?? []) {
        if (typeof rawId !== 'string' || !rawId || seenRawIds.has(rawId)) {
          continue;
        }
        seenRawIds.add(rawId);

        if (rawId.toLowerCase().endsWith('-disabled')) {
          continue;
        }

        const details = response.models[rawId];
        if (!details || typeof details.displayName !== 'string' || !details.displayName.trim()) {
          continue;
        }

        selectableEntries.push({
          rawId,
          details,
          parsedTier: parseTierSuffix(rawId),
        });
      }
    }
  }

  if (selectableEntries.length === 0) {
    throw new Error('Invalid fetchAvailableModels response: zero selectable models found');
  }

  const tiersByBase = new Map<string, Set<TierName>>();
  for (const entry of selectableEntries) {
    if (!entry.parsedTier) {
      continue;
    }
    let tierSet = tiersByBase.get(entry.parsedTier.base);
    if (!tierSet) {
      tierSet = new Set<TierName>();
      tiersByBase.set(entry.parsedTier.base, tierSet);
    }
    tierSet.add(entry.parsedTier.tier);
  }

  const groups = new Map<string, TargetModelGroup>();
  for (const entry of selectableEntries) {
    const tierCount = entry.parsedTier ? (tiersByBase.get(entry.parsedTier.base)?.size ?? 0) : 0;
    const collapsed = Boolean(
      entry.parsedTier && (tierCount >= 2 || Boolean(TIER_MAPPING[entry.parsedTier.base]))
    );
    const targetId = collapsed && entry.parsedTier ? entry.parsedTier.base : entry.rawId;

    let group = groups.get(targetId);
    if (!group) {
      group = {
        targetId,
        collapsed,
        entries: [],
      };
      groups.set(targetId, group);
    } else if (collapsed) {
      group.collapsed = true;
    }

    group.entries.push({
      rawId: entry.rawId,
      details: entry.details,
      tier: collapsed ? entry.parsedTier?.tier : undefined,
    });
  }

  const models: Record<string, SimpleStaticModel> = {};
  const tierMapping: Record<string, TierMap> = {};

  for (const group of groups.values()) {
    const { targetId, collapsed, entries } = group;
    const knownStatic = STATIC_MODELS_SIMPLE[targetId];
    const firstDisplayName = entries[0]!.details.displayName.trim();
    const strippedName = firstDisplayName.replace(DISPLAY_TIER_SUFFIX_RE, '').trim();
    const name = knownStatic?.name ?? (collapsed ? strippedName || firstDisplayName : firstDisplayName);
    const description =
      knownStatic?.description ??
      (collapsed ? `${name} base model. Select tier at runtime.` : `${name} model.`);

    const maxTokensValues = entries
      .map((e) => e.details.maxTokens)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
    const maxTokens =
      maxTokensValues.length > 0
        ? Math.max(...maxTokensValues)
        : knownStatic?.maxTokens || DEFAULT_MAX_TOKENS;

    const maxOutputValues = entries
      .map((e) => e.details.maxOutputTokens)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
    const maxOutputTokens =
      maxOutputValues.length > 0
        ? Math.max(...maxOutputValues)
        : knownStatic?.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS;

    const reasoning = entries.some((e) => Boolean(e.details.supportsThinking));
    const attachment = entries.some((e) => Boolean(e.details.supportsImages));
    const staticCost = knownStatic?.cost;

    models[targetId] = {
      name,
      description,
      maxTokens,
      maxOutputTokens,
      toolCall: true,
      reasoning,
      attachment,
      ...(staticCost
        ? {
            cost: {
              input: staticCost.input,
              output: staticCost.output,
              ...(staticCost.cache ? { cache: { ...staticCost.cache } } : {}),
            },
          }
        : {}),
    };

    if (collapsed) {
      const rawMap: Partial<Record<TierName, string>> = {};
      for (const entry of entries) {
        if (entry.tier && !rawMap[entry.tier]) {
          rawMap[entry.tier] = entry.rawId;
        }
      }
      const orderedMap: TierMap = {};
      for (const tierName of CANONICAL_TIER_ORDER) {
        if (rawMap[tierName]) {
          orderedMap[tierName] = rawMap[tierName];
        }
      }
      if (Object.keys(orderedMap).length > 0) {
        tierMapping[targetId] = orderedMap;
      }
    }
  }

  return {
    models,
    tierMapping,
    enums,
  };
}

/**
 * Loads and normalizes account-specific models from the Antigravity Code Assist server
 * for the currently active OpenCode v2 OAuth credential connection.
 */
export async function loadAccountModels(
  ctx: AccountModelsContext
): Promise<AccountModelInventory | undefined> {
  const connApi = (ctx?.integration as { connection?: V2IntegrationConnectionApi } | undefined)
    ?.connection;
  if (typeof connApi?.active !== 'function' || typeof connApi?.resolve !== 'function') {
    return undefined;
  }

  const activeRaw = await connApi.active(AGY_PROVIDER_ID);
  if (!activeRaw || typeof activeRaw !== 'object') {
    return undefined;
  }

  const activeRecord = activeRaw as { type?: unknown; id?: unknown };
  if (
    activeRecord.type !== 'credential' ||
    typeof activeRecord.id !== 'string' ||
    !activeRecord.id
  ) {
    return undefined;
  }

  const connection = { type: 'credential' as const, id: activeRecord.id };
  const resolved = await connApi.resolve(activeRaw as { type: 'credential'; id: string });
  const initialAuth = extractOAuthCredential(resolved);
  if (!initialAuth) {
    return undefined;
  }

  let current = resolveCachedAuth(initialAuth);
  let lastPersistedAuth: OAuthAuthDetails = current;

  const client = {
    auth: {
      set: async () => {},
    },
  } as unknown as PluginClient;

  const persistIfChanged = async (candidate: OAuthAuthDetails): Promise<void> => {
    if (candidate === lastPersistedAuth) {
      return;
    }
    lastPersistedAuth = candidate;
    try {
      await saveStoredAuthToJson(candidate);
    } catch {
      // Best-effort persistence; do not fail discovery when disk write fails.
    }
  };

  if (accessTokenExpired(current)) {
    const refreshed = await refreshAccessToken(current, client);
    if (!refreshed?.access) {
      throw new Error('Failed to refresh expired Antigravity OAuth access token');
    }
    current = refreshed;
    await persistIfChanged(current);
  }

  let project = parseRefreshParts(current.refresh).managedProjectId;
  if (!project) {
    const ctxResult = await ensureProjectContext(current, client);
    current = ctxResult.auth;
    const updatedParts = parseRefreshParts(current.refresh);

    if (updatedParts.managedProjectId) {
      project = updatedParts.managedProjectId;
    } else {
      const payload = await loadManagedProject(
        current.access,
        updatedParts.projectId || ctxResult.effectiveProjectId || undefined
      );
      const loadedManagedId = normalizeProjectId(payload?.cloudaicompanionProject);
      if (loadedManagedId) {
        project = loadedManagedId;
        if (updatedParts.refreshToken) {
          current = {
            ...current,
            refresh: formatRefreshParts({
              refreshToken: updatedParts.refreshToken,
              projectId: updatedParts.projectId,
              managedProjectId: loadedManagedId,
            }),
          };
          storeCachedAuth(current);
        }
      } else {
        project = ctxResult.effectiveProjectId;
      }
    }

    await persistIfChanged(current);
  }

  if (!project) {
    throw new Error('Failed to resolve Antigravity managed project ID for account model discovery');
  }

  const response = await fetchAvailableModels(
    current.access,
    project,
    undefined,
    AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  );
  const normalized = normalizeDiscoveredModels(response);
  await applyPricingToSimpleModels(normalized.models);

  return {
    connection,
    models: normalized.models,
    tierMapping: normalized.tierMapping,
    enums: normalized.enums,
  };
}

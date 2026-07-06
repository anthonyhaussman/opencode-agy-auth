import { AGY_PROVIDER_ID } from '../../constants';
import { formatRefreshParts, parseRefreshParts } from '../auth';
import type { OAuthAuthDetails, PluginClient, ProjectContextResult } from '../types';
import { loadManagedProject, onboardManagedProject } from '../../sdk/fetch_project';
import { FREE_TIER_ID, LEGACY_TIER_ID, ProjectIdRequiredError, ProjectAccessDeniedError, type LoadCodeAssistPayload } from './types';
import {
  buildIneligibleTierMessage,
  getCacheKey,
  normalizeProjectId,
  pickOnboardTier,
  throwIfValidationRequired
} from './utils';

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

/**
 * Clears cached project context results and pending Promises.
 */
export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }

  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);

  const prefix = `${refresh}|cfg:`;
  for (const key of projectContextPendingCache.keys()) {
    if (key.startsWith(prefix)) {
      projectContextPendingCache.delete(key);
    }
  }
  for (const key of projectContextResultCache.keys()) {
    if (key.startsWith(prefix)) {
      projectContextResultCache.delete(key);
    }
  }
}

/**
 * Resolves the project context corresponding to the access token, optionally persisting updated auth details.
 */
export async function resolveProjectContextFromAccessToken(
  auth: OAuthAuthDetails,
  accessToken: string,
  configuredProjectId?: string,
  persistAuth?: (auth: OAuthAuthDetails) => Promise<void>,
  userAgentModel?: string
): Promise<ProjectContextResult> {
  const parts = parseRefreshParts(auth.refresh);
  const configuredProject = configuredProjectId?.trim();
  const projectId = configuredProject || parts.projectId;

  if (!configuredProject && (projectId || parts.managedProjectId)) {
    return {
      auth,
      effectiveProjectId: projectId || parts.managedProjectId || ''
    };
  }

  let loadPayload: LoadCodeAssistPayload | null = null;
  try {
    loadPayload = await loadManagedProject(accessToken, projectId, userAgentModel);
  } catch (error) {
    if (error instanceof ProjectAccessDeniedError) {
      throw error;
    }
    console.warn(`[Agy Auth] loadManagedProject returned an error for project: ${projectId || 'none'}, ${error}`);
  }

  if (!loadPayload) {
    console.warn(`[Agy Auth] loadManagedProject returned null for project: ${projectId || 'none'} (possible 429 rate limit / quota exhaustion / transient backend error - not necessarily a missing project config)`);
    if (projectId) {
      throw new Error(
        `Failed to load project context for '${projectId}'. This may be due to a rate limit, quota exhaustion, or transient backend error. Please try again later.`
      );
    }
    throw new ProjectIdRequiredError();
  }

  const managedProjectId = normalizeProjectId(loadPayload.cloudaicompanionProject);
  if (managedProjectId) {
    const updatedAuth = withProjectAuth(auth, parts.refreshToken, projectId, managedProjectId);
    if (persistAuth) {
      await persistAuth(updatedAuth);
    }
    return { auth: updatedAuth, effectiveProjectId: managedProjectId };
  }

  const currentTierId = loadPayload.currentTier?.id;
  if (!currentTierId) {
    throwIfValidationRequired(loadPayload.ineligibleTiers);
  }

  if (currentTierId) {
    if (projectId) {
      return { auth, effectiveProjectId: projectId };
    }
    const ineligibleMessage = buildIneligibleTierMessage(loadPayload.ineligibleTiers);
    if (ineligibleMessage) {
      throw new Error(ineligibleMessage);
    }
    throw new ProjectIdRequiredError();
  }

  const tier = pickOnboardTier(loadPayload.allowedTiers);
  const tierId = tier.id ?? LEGACY_TIER_ID;
  if (tierId !== FREE_TIER_ID && !projectId) {
    throw new ProjectIdRequiredError();
  }

  const onboardedProjectId = await onboardManagedProject(
    accessToken,
    tierId,
    projectId,
    userAgentModel
  );
  if (onboardedProjectId) {
    const updatedAuth = withProjectAuth(auth, parts.refreshToken, projectId, onboardedProjectId);
    if (persistAuth) {
      await persistAuth(updatedAuth);
    }
    return { auth: updatedAuth, effectiveProjectId: onboardedProjectId };
  }

  if (projectId) {
    return { auth, effectiveProjectId: projectId };
  }
  console.warn(`[Agy Auth] onboardManagedProject failed to resolve a project ID for tier: ${tierId}, configured project: ${projectId || 'none'}`);
  throw new ProjectIdRequiredError();
}

/**
 * Resolves the effective project ID for the current auth state and caches the result by refresh token.
 */
export async function ensureProjectContext(
  auth: OAuthAuthDetails,
  client: PluginClient,
  configuredProjectId?: string,
  userAgentModel?: string
): Promise<ProjectContextResult> {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: '' };
  }

  const cacheKey = buildProjectCacheKey(auth, configuredProjectId);
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = projectContextPendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const resolveContext = async (): Promise<ProjectContextResult> =>
    resolveProjectContextFromAccessToken(
      auth,
      accessToken,
      configuredProjectId,
      async (updatedAuth) => {
        await client.auth.set({
          path: { id: AGY_PROVIDER_ID },
          body: updatedAuth
        });
      },
      userAgentModel
    );

  if (!cacheKey) {
    return resolveContext();
  }

  const promise = resolveContext()
    .then((result) => {
      const nextKey = getCacheKey(result.auth) ?? cacheKey;
      projectContextPendingCache.delete(cacheKey);
      projectContextResultCache.set(nextKey, result);
      if (nextKey !== cacheKey) {
        projectContextResultCache.delete(cacheKey);
      }
      return result;
    })
    .catch((error) => {
      projectContextPendingCache.delete(cacheKey);
      throw error;
    });

  projectContextPendingCache.set(cacheKey, promise);
  return promise;
}

function withProjectAuth(
  auth: OAuthAuthDetails,
  refreshToken: string,
  projectId: string | undefined,
  managedProjectId: string
): OAuthAuthDetails {
  return {
    ...auth,
    refresh: formatRefreshParts({
      refreshToken,
      projectId,
      managedProjectId
    })
  };
}

function buildProjectCacheKey(auth: OAuthAuthDetails, configuredProjectId?: string): string | undefined {
  const base = getCacheKey(auth);
  if (!base) {
    return undefined;
  }
  const project = configuredProjectId?.trim() ?? '';
  return project ? `${base}|cfg:${project}` : base;
}

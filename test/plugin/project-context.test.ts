import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  invalidateProjectContextCache,
  resolveProjectContextFromAccessToken,
  ensureProjectContext,
} from '../../src/plugin/project/context.js';
import * as fetchProjectSdk from '../../src/sdk/fetch_project.js';
import { ProjectIdRequiredError, ProjectAccessDeniedError } from '../../src/plugin/project/types.js';

describe('project context', () => {
  beforeEach(() => {
    invalidateProjectContextCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    invalidateProjectContextCache();
    vi.restoreAllMocks();
  });

  it('handles empty access token in ensureProjectContext', async () => {
    const auth = {
      type: 'oauth' as const,
      access: '',
      refresh: 'refresh-tok',
      expires: 0,
    };
    const res = await ensureProjectContext(auth, { auth: { set: vi.fn() } } as any);
    expect(res.effectiveProjectId).toBe('');
  });

  it('handles fast path when refresh token contains project ID', async () => {
    const auth = {
      type: 'oauth' as const,
      access: 'valid-acc',
      refresh: 'refresh-tok|proj-123|managed-456',
      expires: Date.now() + 100000,
    };
    const res = await resolveProjectContextFromAccessToken(auth, 'valid-acc');
    expect(res.effectiveProjectId).toBe('proj-123');
  });

  it('throws ProjectAccessDeniedError when loadManagedProject encounters 403', async () => {
    vi.spyOn(fetchProjectSdk, 'loadManagedProject').mockRejectedValue(
      new ProjectAccessDeniedError('Project access denied')
    );
    const auth = {
      type: 'oauth' as const,
      access: 'valid-acc',
      refresh: 'refresh-tok',
      expires: Date.now() + 100000,
    };
    await expect(
      resolveProjectContextFromAccessToken(auth, 'valid-acc', 'configured-p')
    ).rejects.toThrow(ProjectAccessDeniedError);
  });

  it('handles null payload from loadManagedProject', async () => {
    vi.spyOn(fetchProjectSdk, 'loadManagedProject').mockResolvedValue(null);
    const auth = {
      type: 'oauth' as const,
      access: 'valid-acc',
      refresh: 'refresh-tok',
      expires: Date.now() + 100000,
    };
    await expect(
      resolveProjectContextFromAccessToken(auth, 'valid-acc', 'configured-p')
    ).rejects.toThrow(/Failed to load project context/);

    await expect(
      resolveProjectContextFromAccessToken(auth, 'valid-acc', undefined)
    ).rejects.toThrow(ProjectIdRequiredError);
  });

  it('handles currentTier present without cloudaicompanionProject', async () => {
    vi.spyOn(fetchProjectSdk, 'loadManagedProject').mockResolvedValue({
      cloudaicompanionProject: undefined,
      currentTier: { id: 'TIER_PAID' },
    });

    const auth = {
      type: 'oauth' as const,
      access: 'valid-acc',
      refresh: 'refresh-tok',
      expires: Date.now() + 100000,
    };

    const res = await resolveProjectContextFromAccessToken(auth, 'valid-acc', 'configured-p');
    expect(res.effectiveProjectId).toBe('configured-p');

    // Without configured project and ineligible tier message
    vi.spyOn(fetchProjectSdk, 'loadManagedProject').mockResolvedValue({
      cloudaicompanionProject: undefined,
      currentTier: { id: 'TIER_PAID' },
      ineligibleTiers: [{ tier: { id: 'TIER_PAID' }, reasonMessage: 'Upgrade required' }],
    });

    await expect(
      resolveProjectContextFromAccessToken(auth, 'valid-acc', undefined)
    ).rejects.toThrow('Upgrade required');
  });

  it('resolves project context with configured project ID and onboarded user', async () => {
    vi.spyOn(fetchProjectSdk, 'loadManagedProject').mockResolvedValue({
      cloudaicompanionProject: { id: 'managed-proj-1' },
      currentTier: { id: 'TIER_PAID' },
    });

    const auth = {
      type: 'oauth' as const,
      access: 'access-tok',
      refresh: 'refresh-tok',
      expires: Date.now() + 100000,
    };

    const persistAuth = vi.fn().mockResolvedValue(undefined);

    const result = await resolveProjectContextFromAccessToken(
      auth,
      'access-tok',
      'my-configured-proj',
      persistAuth,
      'gemini-2.5-pro'
    );

    expect(result.effectiveProjectId).toBe('managed-proj-1');
    expect(result.auth.refresh).toContain('managed-proj-1');
    expect(persistAuth).toHaveBeenCalled();
  });

  it('onboards new managed project if loadManagedProject cloudaicompanionProject is empty', async () => {
    vi.spyOn(fetchProjectSdk, 'loadManagedProject').mockResolvedValue({
      cloudaicompanionProject: undefined,
      allowedTiers: [{ id: 'free-tier' }],
    });
    vi.spyOn(fetchProjectSdk, 'onboardManagedProject').mockResolvedValue('onboarded-managed-proj');

    const auth = {
      type: 'oauth' as const,
      access: 'access-tok',
      refresh: 'refresh-tok',
      expires: Date.now() + 100000,
    };

    const result = await resolveProjectContextFromAccessToken(
      auth,
      'access-tok',
      undefined,
      undefined
    );

    expect(result.effectiveProjectId).toBe('onboarded-managed-proj');
  });

  it('handles onboarding failure with and without configured project', async () => {
    vi.spyOn(fetchProjectSdk, 'loadManagedProject').mockResolvedValue({
      cloudaicompanionProject: undefined,
      allowedTiers: [{ id: 'free-tier' }],
    });
    vi.spyOn(fetchProjectSdk, 'onboardManagedProject').mockResolvedValue(null);

    const auth = {
      type: 'oauth' as const,
      access: 'access-tok',
      refresh: 'refresh-tok',
      expires: Date.now() + 100000,
    };

    const resWithConfigured = await resolveProjectContextFromAccessToken(
      auth,
      'access-tok',
      'my-configured-proj'
    );
    expect(resWithConfigured.effectiveProjectId).toBe('my-configured-proj');

    await expect(
      resolveProjectContextFromAccessToken(auth, 'access-tok', undefined)
    ).rejects.toThrow(ProjectIdRequiredError);
  });

  it('uses cached context on subsequent ensureProjectContext calls', async () => {
    const loadSpy = vi.spyOn(fetchProjectSdk, 'loadManagedProject');

    const auth = {
      type: 'oauth' as const,
      access: 'access-tok',
      refresh: 'refresh-tok|cached-proj|managed-proj-cached',
      expires: Date.now() + 100000,
    };

    const clientMock = {
      auth: { set: vi.fn() },
    };

    const result1 = await ensureProjectContext(auth, clientMock as any, undefined);
    expect(result1.effectiveProjectId).toBe('cached-proj');
    expect(loadSpy).not.toHaveBeenCalled(); // Fast path: extracted from refresh token

    // Cache invalidation
    invalidateProjectContextCache('refresh-tok|cached-proj|managed-proj-cached');
    invalidateProjectContextCache();
  });
});

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_PROVIDER_ID } from '../../src/constants';
import * as fetchModelsSdk from '../../src/sdk/fetch_models';
import * as fetchProjectSdk from '../../src/sdk/fetch_project';
import * as pricingModule from '../../src/plugin/pricing';
import * as tokenModule from '../../src/plugin/token';
import * as projectContextModule from '../../src/plugin/project/context';
import * as v2StorageModule from '../../src/plugin/v2-storage';
import { clearCachedAuth } from '../../src/plugin/cache';
import type { OpenCodeV2PluginContext } from '../../src/plugin/types';
import { loadAccountModels } from '../../src/plugin/dynamic-models';

const sampleModelsResponse: fetchModelsSdk.FetchAvailableModelsResponse = {
  agentModelSorts: [
    {
      displayName: 'Recommended',
      groups: [
        {
          modelIds: [
            'gemini-4-argon-low',
            'gemini-4-argon-medium',
            'gemini-4-argon-high',
            'gpt-oss-120b-medium',
          ],
        },
      ],
    },
  ],
  models: {
    'gemini-4-argon-low': {
      displayName: 'Gemini 4 Argon (Low)',
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      supportsThinking: true,
      supportsImages: true,
      model: 'MODEL_PLACEHOLDER_M419',
    },
    'gemini-4-argon-medium': {
      displayName: 'Gemini 4 Argon (Medium)',
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      supportsThinking: true,
      supportsImages: true,
      model: 'MODEL_PLACEHOLDER_M418',
    },
    'gemini-4-argon-high': {
      displayName: 'Gemini 4 Argon (High)',
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      supportsThinking: true,
      supportsImages: true,
      model: 'MODEL_PLACEHOLDER_M417',
    },
    'gpt-oss-120b-medium': {
      displayName: 'GPT-OSS 120B (Medium)',
      maxTokens: 131072,
      maxOutputTokens: 32768,
      supportsThinking: true,
      supportsImages: false,
      model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    },
    chat_20706: {
      displayName: '',
      model: 'MODEL_CHAT_20706',
    },
  },
};

describe('loadAccountModels', () => {
  beforeEach(() => {
    clearCachedAuth();
    projectContextModule.invalidateProjectContextCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearCachedAuth();
    projectContextModule.invalidateProjectContextCache();
    vi.restoreAllMocks();
  });

  it('returns undefined when integration connection API is missing or returns non-oauth credentials', async () => {
    const baseV2Ctx: OpenCodeV2PluginContext = {
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      location: {},
    };
    expect(await loadAccountModels(baseV2Ctx)).toBeUndefined();

    expect(
      await loadAccountModels({
        integration: {},
      })
    ).toBeUndefined();

    expect(
      await loadAccountModels({
        integration: {
          connection: {
            active: vi.fn().mockResolvedValue(undefined),
            resolve: vi.fn(),
          },
        },
      })
    ).toBeUndefined();

    expect(
      await loadAccountModels({
        integration: {
          connection: {
            active: vi.fn().mockResolvedValue({ type: 'env', id: 'env-1' }),
            resolve: vi.fn(),
          },
        },
      })
    ).toBeUndefined();

    expect(
      await loadAccountModels({
        integration: {
          connection: {
            active: vi.fn().mockResolvedValue({ type: 'credential', id: '' }),
            resolve: vi.fn(),
          },
        },
      })
    ).toBeUndefined();

    expect(
      await loadAccountModels({
        integration: {
          connection: {
            active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-undef' }),
            resolve: vi.fn().mockResolvedValue(undefined),
          },
        },
      })
    ).toBeUndefined();

    expect(
      await loadAccountModels({
        integration: {
          connection: {
            active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-api' }),
            resolve: vi.fn().mockResolvedValue({
              type: 'credential',
              credential: { type: 'api', key: 'sk-test' },
            }),
          },
        },
      })
    ).toBeUndefined();

    expect(
      await loadAccountModels({
        integration: {
          connection: {
            active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-env-wrap' }),
            resolve: vi.fn().mockResolvedValue({
              type: 'env',
              credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 9999999999999 },
            }),
          },
        },
      })
    ).toBeUndefined();
  });

  it('refreshes expired OAuth access token, persists best-effort, and throws when refresh fails', async () => {
    const expiredAuth = {
      type: 'oauth' as const,
      access: 'expired-tok',
      refresh: 'rt-1|user-proj|managed-proj-1',
      expires: Date.now() - 10_000,
    };
    const refreshedAuth = {
      type: 'oauth' as const,
      access: 'fresh-access-tok',
      refresh: 'rt-1|user-proj|managed-proj-1',
      expires: Date.now() + 3_600_000,
    };

    const refreshSpy = vi
      .spyOn(tokenModule, 'refreshAccessToken')
      .mockResolvedValueOnce(refreshedAuth);
    const saveSpy = vi
      .spyOn(v2StorageModule, 'saveStoredAuthToJson')
      .mockImplementationOnce(() => {
        throw new Error('Read-only filesystem');
      });
    const fetchModelsSpy = vi
      .spyOn(fetchModelsSdk, 'fetchAvailableModels')
      .mockResolvedValueOnce(sampleModelsResponse);
    vi.spyOn(pricingModule, 'applyPricingToSimpleModels').mockImplementationOnce(async (m) => m);

    const activeFn = vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-1' });
    const resolveFn = vi.fn().mockResolvedValue({
      type: 'credential',
      credential: expiredAuth,
    });

    const result = await loadAccountModels({
      integration: {
        connection: {
          active: activeFn,
          resolve: resolveFn,
        },
      },
    });

    expect(activeFn).toHaveBeenCalledWith(AGY_PROVIDER_ID);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith(refreshedAuth);
    expect(fetchModelsSpy).toHaveBeenCalledWith(
      'fresh-access-tok',
      'managed-proj-1',
      undefined,
      expect.any(AbortSignal)
    );
    expect(result?.connection).toEqual({ type: 'credential', id: 'cred-1' });

    clearCachedAuth();
    refreshSpy.mockResolvedValueOnce(undefined);
    await expect(
      loadAccountModels({
        integration: {
          connection: {
            active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-2' }),
            resolve: vi.fn().mockResolvedValue({
              type: 'credential',
              credential: {
                type: 'oauth',
                access: '',
                refresh: 'rt-bad',
                expires: 0,
              },
            }),
          },
        },
      })
    ).rejects.toThrow(/refresh|access token/i);
  });

  it('uses managedProjectId directly from refresh parts when present without project lookups', async () => {
    const ensureSpy = vi.spyOn(projectContextModule, 'ensureProjectContext');
    const loadManagedSpy = vi.spyOn(fetchProjectSdk, 'loadManagedProject');
    const saveSpy = vi.spyOn(v2StorageModule, 'saveStoredAuthToJson');
    const fetchModelsSpy = vi
      .spyOn(fetchModelsSdk, 'fetchAvailableModels')
      .mockResolvedValueOnce(sampleModelsResponse);
    const pricingSpy = vi
      .spyOn(pricingModule, 'applyPricingToSimpleModels')
      .mockImplementationOnce(async (models) => {
        if (models['gemini-4-argon']) {
          models['gemini-4-argon'].cost = {
            input: 1.25,
            output: 5.0,
            cache: { read: 0.3, write: 1.25 },
          };
        }
        return models;
      });

    const result = await loadAccountModels({
      integration: {
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-direct' }),
          resolve: vi.fn().mockResolvedValue({
            type: 'oauth',
            access: 'valid-access',
            refresh: 'rt-direct|my-user-proj|citric-engine-kl9s4',
            expires: Date.now() + 3_600_000,
          }),
        },
      },
    });

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(loadManagedSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(fetchModelsSpy).toHaveBeenCalledTimes(1);
    const signalArg = fetchModelsSpy.mock.calls[0]?.[3];
    expect(signalArg).toBeInstanceOf(AbortSignal);
    expect(fetchModelsSpy).toHaveBeenCalledWith(
      'valid-access',
      'citric-engine-kl9s4',
      undefined,
      expect.any(AbortSignal)
    );
    expect(pricingSpy).toHaveBeenCalledTimes(1);

    expect(result).toEqual({
      connection: { type: 'credential', id: 'cred-direct' },
      models: expect.objectContaining({
        'gemini-4-argon': expect.objectContaining({
          name: 'Gemini 4 Argon',
          cost: {
            input: 1.25,
            output: 5.0,
            cache: { read: 0.3, write: 1.25 },
          },
        }),
        'gpt-oss-120b-medium': expect.objectContaining({
          name: 'GPT-OSS 120B (Medium)',
        }),
      }),
      tierMapping: {
        'gemini-4-argon': {
          low: 'gemini-4-argon-low',
          medium: 'gemini-4-argon-medium',
          high: 'gemini-4-argon-high',
        },
      },
      enums: {
        'gemini-4-argon-low': 'MODEL_PLACEHOLDER_M419',
        'gemini-4-argon-medium': 'MODEL_PLACEHOLDER_M418',
        'gemini-4-argon-high': 'MODEL_PLACEHOLDER_M417',
        'gpt-oss-120b-medium': 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
        chat_20706: 'MODEL_CHAT_20706',
      },
    });
  });

  it('resolves managedProjectId via ensureProjectContext when refresh lacks project segments', async () => {
    const initialAuth = {
      type: 'oauth' as const,
      access: 'valid-access',
      refresh: 'rt-onboard',
      expires: Date.now() + 3_600_000,
    };

    const ensureSpy = vi.spyOn(projectContextModule, 'ensureProjectContext');
    const loadManagedSpy = vi
      .spyOn(fetchProjectSdk, 'loadManagedProject')
      .mockResolvedValueOnce({
        cloudaicompanionProject: { id: 'onboarded-managed-proj' },
      });
    const saveSpy = vi.spyOn(v2StorageModule, 'saveStoredAuthToJson').mockImplementation(() => {});
    const fetchModelsSpy = vi
      .spyOn(fetchModelsSdk, 'fetchAvailableModels')
      .mockResolvedValueOnce(sampleModelsResponse);
    vi.spyOn(pricingModule, 'applyPricingToSimpleModels').mockImplementationOnce(async (m) => m);

    const result = await loadAccountModels({
      integration: {
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-onboard' }),
          resolve: vi.fn().mockResolvedValue({
            type: 'credential',
            credential: initialAuth,
          }),
        },
      },
    });

    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(loadManagedSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        refresh: 'rt-onboard||onboarded-managed-proj',
      })
    );
    expect(fetchModelsSpy).toHaveBeenCalledWith(
      'valid-access',
      'onboarded-managed-proj',
      undefined,
      expect.any(AbortSignal)
    );
    expect(result?.connection.id).toBe('cred-onboard');

    clearCachedAuth();
    projectContextModule.invalidateProjectContextCache();
    ensureSpy.mockResolvedValueOnce({
      auth: initialAuth,
      effectiveProjectId: '',
    });
    loadManagedSpy.mockResolvedValueOnce(null);

    await expect(
      loadAccountModels({
        integration: {
          connection: {
            active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-empty-proj' }),
            resolve: vi.fn().mockResolvedValue({
              type: 'credential',
              credential: initialAuth,
            }),
          },
        },
      })
    ).rejects.toThrow(/project ID/i);
  });

  it('resolves managedProjectId via loadManagedProject when refresh only has user-facing projectId, with fallback to effectiveProjectId', async () => {
    const userProjectAuth = {
      type: 'oauth' as const,
      access: 'valid-access',
      refresh: 'rt-user|my-user-proj|',
      expires: Date.now() + 3_600_000,
    };

    const loadManagedSpy = vi
      .spyOn(fetchProjectSdk, 'loadManagedProject')
      .mockResolvedValueOnce({
        cloudaicompanionProject: { id: 'citric-engine-resolved' },
      });
    const saveSpy = vi.spyOn(v2StorageModule, 'saveStoredAuthToJson').mockImplementation(() => {});
    const fetchModelsSpy = vi
      .spyOn(fetchModelsSdk, 'fetchAvailableModels')
      .mockResolvedValue(sampleModelsResponse);
    vi.spyOn(pricingModule, 'applyPricingToSimpleModels').mockImplementation(async (m) => m);

    await loadAccountModels({
      integration: {
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-user-proj' }),
          resolve: vi.fn().mockResolvedValue({
            type: 'credential',
            credential: userProjectAuth,
          }),
        },
      },
    });

    expect(loadManagedSpy).toHaveBeenCalledWith('valid-access', 'my-user-proj');
    expect(fetchModelsSpy).toHaveBeenCalledWith(
      'valid-access',
      'citric-engine-resolved',
      undefined,
      expect.any(AbortSignal)
    );
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        refresh: 'rt-user|my-user-proj|citric-engine-resolved',
      })
    );

    // String cloudaicompanionProject payload
    clearCachedAuth();
    projectContextModule.invalidateProjectContextCache();
    loadManagedSpy.mockResolvedValueOnce({
      cloudaicompanionProject: 'citric-string-proj',
    });

    await loadAccountModels({
      integration: {
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-str-proj' }),
          resolve: vi.fn().mockResolvedValue({
            type: 'credential',
            credential: {
              type: 'oauth',
              access: 'valid-access-2',
              refresh: 'rt-user-2|my-user-proj-2|',
              expires: Date.now() + 3_600_000,
            },
          }),
        },
      },
    });

    expect(fetchModelsSpy).toHaveBeenLastCalledWith(
      'valid-access-2',
      'citric-string-proj',
      undefined,
      expect.any(AbortSignal)
    );

    // Fallback to effectiveProjectId when loadManagedProject returns null
    clearCachedAuth();
    projectContextModule.invalidateProjectContextCache();
    loadManagedSpy.mockResolvedValueOnce(null);

    await loadAccountModels({
      integration: {
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'cred-fallback' }),
          resolve: vi.fn().mockResolvedValue({
            type: 'credential',
            credential: {
              type: 'oauth',
              access: 'valid-access-3',
              refresh: 'rt-user-3|my-user-proj-3|',
              expires: Date.now() + 3_600_000,
            },
          }),
        },
      },
    });

    expect(fetchModelsSpy).toHaveBeenLastCalledWith(
      'valid-access-3',
      'my-user-proj-3',
      undefined,
      expect.any(AbortSignal)
    );
  });
});

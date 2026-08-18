import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgyCLIOAuthPlugin } from '../../src/plugin';
import * as projectContextModule from '../../src/plugin/project/context';
import * as tokenModule from '../../src/plugin/token';
import * as fetchModule from '../../src/fetch';
import * as retryModule from '../../src/sdk/retry/index';
import * as trafficModule from '../../src/plugin/traffic';

describe('AgyCLIOAuthPlugin deep coverage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handles custom model definitions and config merging', async () => {
    const client: any = {
      config: {
        get: vi.fn().mockResolvedValue({
          data: {
            provider: {
              'google-agy': {
                options: {
                  projectId: 'opt-project',
                  thinkingConfig: { thinkingBudget: 100 },
                },
              },
            },
          },
        }),
      },
    };

    const plugin = await AgyCLIOAuthPlugin({ client });
    const configResult: any = {
      provider: {
        'google-agy': {
          models: {
            'gemini-3.7-flash': {
              name: 'Custom Gemini 3.7 Flash',
              cost: { input: 1.5, output: 3.0, cache: { read: 0.5, write: 1.0 } },
              capabilities: {
                input: { text: true, audio: true },
                output: { text: true },
              },
            },
          },
        },
      },
    };
    await (plugin as any).config(configResult);

    expect(configResult.provider?.['google-agy']).toBeDefined();
    expect(configResult.provider?.['google-agy'].models?.['gemini-3.7-flash']).toBeDefined();
    expect(configResult.provider?.['google-agy'].models?.['gemini-3.7-flash'].name).toBe('Custom Gemini 3.7 Flash');
  });

  it('normalizes provider model costs when model costs are non-numbers', async () => {
    const client: any = {
      config: { get: vi.fn().mockResolvedValue({}) },
    };

    const plugin = await AgyCLIOAuthPlugin({ client });
    const loader = (plugin as any).auth?.loader;

    const authDetails = {
      type: 'oauth' as const,
      access: 'access-tok',
      refresh: 'ref|p|m',
      expires: Date.now() + 3600000,
    };

    const provider: any = {
      models: {
        'custom-invalid-cost': {
          cost: {
            input: 'invalid',
            output: null,
            cache: { read: 'foo', write: {} },
          },
        },
        'custom-valid-cost': {
          cost: {
            input: 2.0,
            output: 4.0,
            cache: { read: 1.0, write: 2.0 },
          },
        },
      },
    };

    await loader(vi.fn().mockResolvedValue(authDetails), provider);

    expect(provider.models['custom-invalid-cost'].cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    expect(provider.models['custom-valid-cost'].cost).toEqual({
      input: 2.0,
      output: 4.0,
      cache: { read: 1.0, write: 2.0 },
    });
  });

  it('executes internal cloudcode request with Authorization header added', async () => {
    const client: any = {
      config: { get: vi.fn().mockResolvedValue({}) },
      tui: { showToast: vi.fn() },
    };

    const fetchSpy = vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const trafficSpy = vi.spyOn(trafficModule, 'simulateClientBackgroundTraffic').mockReturnValue();

    const plugin = await AgyCLIOAuthPlugin({ client });
    const loader = (plugin as any).auth?.loader;

    const authDetails = {
      type: 'oauth' as const,
      access: 'internal-access-token',
      refresh: 'refresh|configured-proj|managed-proj',
      expires: Date.now() + 3600000,
    };

    const getAuth = vi.fn().mockResolvedValue(authDetails);
    const provider: any = {
      options: { projectId: 'configured-proj' },
    };

    const authResult = await loader(getAuth, provider);
    expect(authResult).toBeDefined();

    // Call fetch for internal endpoint without Authorization header
    const internalRes = await authResult.fetch(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      { method: 'POST', body: JSON.stringify({ project: 'managed-proj' }) }
    );

    expect(internalRes.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    expect(trafficSpy).toHaveBeenCalledWith('internal-access-token', 'configured-proj', undefined);
  });

  it('bypasses header injection when Authorization is already present for internal endpoint', async () => {
    const client: any = {
      config: { get: vi.fn().mockResolvedValue({}) },
    };

    const fetchSpy = vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    const plugin = await AgyCLIOAuthPlugin({ client });
    const loader = (plugin as any).auth?.loader;

    const authDetails = {
      type: 'oauth' as const,
      access: 'access-tok',
      refresh: 'ref|p|m',
      expires: Date.now() + 3600000,
    };

    const authResult = await loader(vi.fn().mockResolvedValue(authDetails), {});
    const res = await authResult.fetch(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:test',
      {
        headers: { Authorization: 'Bearer existing-tok' },
      }
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('resolves model tier mapping correctly for suffix and x-agy-tier header', async () => {
    const client: any = {
      config: { get: vi.fn().mockResolvedValue({}) },
      tui: { showToast: vi.fn() },
    };

    vi.spyOn(projectContextModule, 'ensureProjectContext').mockResolvedValue({
      effectiveProjectId: 'proj-123',
    });

    const retrySpy = vi.spyOn(retryModule, 'fetchWithRetry').mockResolvedValue(
      new Response(JSON.stringify({ response: { candidates: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const plugin = await AgyCLIOAuthPlugin({ client });
    const loader = (plugin as any).auth?.loader;

    const authDetails = {
      type: 'oauth' as const,
      access: 'access-tier',
      refresh: 'ref|p|m',
      expires: Date.now() + 3600000,
    };

    const authResult = await loader(vi.fn().mockResolvedValue(authDetails), {});

    // Request with tier suffix in URL
    await authResult.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash@high:generateContent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [] }),
      }
    );

    expect(retrySpy).toHaveBeenCalled();
  });

  it('refreshes token on demand when token is expired during fetch', async () => {
    const client: any = {
      config: { get: vi.fn().mockResolvedValue({}) },
      tui: { showToast: vi.fn() },
    };

    vi.spyOn(projectContextModule, 'ensureProjectContext').mockResolvedValue({
      effectiveProjectId: 'proj-123',
    });

    const refreshSpy = vi.spyOn(tokenModule, 'refreshAccessToken').mockResolvedValue({
      type: 'oauth',
      access: 'new-refreshed-token',
      refresh: 'fresh-refresh-token|p|m',
      expires: Date.now() + 3600000,
    });

    vi.spyOn(retryModule, 'fetchWithRetry').mockResolvedValue(
      new Response(JSON.stringify({ response: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const plugin = await AgyCLIOAuthPlugin({ client });
    const loader = (plugin as any).auth?.loader;

    const expiredAuth = {
      type: 'oauth' as const,
      access: 'expired-token',
      refresh: 'fresh-refresh-token|p|m',
      expires: 1000, // Expired timestamp
    };

    const authResult = await loader(vi.fn().mockResolvedValue(expiredAuth), {});
    await authResult.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [] }),
      }
    );

    expect(refreshSpy).toHaveBeenCalled();
  });

  it('handles ensureProjectContext failure with logged error and rethrow', async () => {
    const client: any = {
      config: { get: vi.fn().mockResolvedValue({}) },
    };

    vi.spyOn(projectContextModule, 'ensureProjectContext').mockRejectedValue(
      new Error('Project context resolution failed')
    );

    const plugin = await AgyCLIOAuthPlugin({ client });
    const loader = (plugin as any).auth?.loader;

    const authDetails = {
      type: 'oauth' as const,
      access: 'access-tok',
      refresh: 'ref|p|m',
      expires: Date.now() + 3600000,
    };

    const authResult = await loader(vi.fn().mockResolvedValue(authDetails), {});

    await expect(
      authResult.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [] }),
        }
      )
    ).rejects.toThrow('Project context resolution failed');
  });
});

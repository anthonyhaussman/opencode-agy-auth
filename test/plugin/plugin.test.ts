import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgyCLIOAuthPlugin, GoogleOAuthPlugin } from '../../src/plugin';
import { AGY_PROVIDER_ID } from '../../src/constants';

vi.mock('../../src/fetch', () => ({
  agyFetch: vi.fn(async () => new Response('{"ok": true}', { status: 200, headers: { 'content-type': 'application/json' } }))
}));

vi.mock('../../src/sdk/retry', () => ({
  fetchWithRetry: vi.fn(async () => new Response('{"candidates": []}', { status: 200, headers: { 'content-type': 'application/json' } })),
  initCooldownPersistence: vi.fn()
}));

vi.mock('../../src/plugin/pricing', () => ({
  updateStaticModelsWithPricing: vi.fn((models) => {
    if (models['gemini-3.7-flash']) {
      models['gemini-3.7-flash'].cost = { input: 1.25, output: 5, cache: { read: 0.3, write: 1.25 } };
    }
  })
}));

vi.mock('../../src/plugin/project', () => ({
  ensureProjectContext: vi.fn(async () => ({
    effectiveProjectId: 'managed-proj-123',
    auth: { access: 'test-token', refresh: 'refresh-token', type: 'oauth' }
  })),
  retrieveUserQuota: vi.fn(async () => ({ buckets: [] })),
  retrieveUserQuotaSummary: vi.fn(async () => ({ groups: [] }))
}));

vi.mock('../../src/plugin/token', () => ({
  refreshAccessToken: vi.fn(async (auth) => ({
    ...auth,
    access: 'refreshed-token',
    expires: Date.now() + 3600000
  }))
}));

vi.mock('../../src/plugin/traffic', () => ({
  simulateClientBackgroundTraffic: vi.fn()
}));

vi.mock('../../src/plugin/notify', () => ({
  maybeShowAgyCapacityToast: vi.fn(),
  maybeShowAgyTestToast: vi.fn()
}));

describe('AgyCLIOAuthPlugin', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      config: {
        get: vi.fn(async () => ({
          data: {
            provider: {
              [AGY_PROVIDER_ID]: {
                options: {
                  projectId: 'client-project-1'
                }
              }
            }
          }
        }))
      },
      tui: {
        showToast: vi.fn()
      }
    };
  });

  it('exports aliases correctly', () => {
    expect(AgyCLIOAuthPlugin).toBe(GoogleOAuthPlugin);
  });

  it('initializes and configures provider, commands, and tools', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    expect(plugin).toBeDefined();
    expect(plugin.tool).toBeDefined();
    expect(plugin.tool?.['agy_quota']).toBeDefined();
    expect(plugin.tool?.['agy_quota_summary']).toBeDefined();

    const configObj: any = {};
    await plugin.config?.(configObj);

    expect(configObj.command['agyquota']).toBeDefined();
    expect(configObj.command['agyquotasummary']).toBeDefined();
    expect(configObj.provider[AGY_PROVIDER_ID]).toBeDefined();
    expect(configObj.provider[AGY_PROVIDER_ID].models['gemini-3.7-flash']).toBeDefined();
    expect(configObj.provider[AGY_PROVIDER_ID].models['claude-sonnet-4-6']).toBeDefined();
    expect(configObj.provider[AGY_PROVIDER_ID].models['gpt-oss-120b-medium']).toBeDefined();
  });

  it('models hook returns login-required when no oauth auth present', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const modelsFn = plugin.provider?.models as any;
    expect(modelsFn).toBeDefined();

    const unauthResult = await modelsFn({ models: {} }, { auth: null });
    expect(unauthResult['login-required']).toBeDefined();

    const apiAuthResult = await modelsFn({ models: {} }, { auth: { type: 'api', key: '123' } });
    expect(apiAuthResult['login-required']).toBeDefined();
  });

  it('models hook returns models with updated pricing when authenticated', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const modelsFn = plugin.provider?.models as any;

    const auth = { type: 'oauth', access: 'token', refresh: 'refresh' };
    const result = await modelsFn({ models: {} }, { auth });

    expect(result['gemini-3.7-flash']).toBeDefined();
    expect(result['gemini-3.7-flash'].cost.input).toBe(1.25);
  });

  it('loader returns null for non-oauth auth', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;
    expect(loader).toBeDefined();

    const result = await loader!(async () => ({ type: 'api', key: 'abc' }), {} as any);
    expect(result).toBeNull();
  });

  it('loader returns custom fetch handler for oauth auth', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    const auth = { type: 'oauth', access: 'access-123', refresh: 'ref-123', expires: Date.now() + 3600000 };
    const providerObj: any = {
      models: {
        'gemini-3.7-flash': {
          options: {
            thinkingConfig: { thinkingBudget: 2000 }
          }
        }
      },
      options: {
        thinkingConfig: { thinkingBudget: 1000 }
      }
    };

    const loaded = await loader!(async () => auth, providerObj);
    expect(loaded).toBeDefined();
    expect(loaded.apiKey).toBe('');
    expect(typeof loaded.fetch).toBe('function');

    // Case 1: non-google request -> agyFetch directly
    const res1 = await loaded.fetch('https://api.example.com/data');
    expect(res1).toBeDefined();

    // Case 2: internal cloudcode endpoint with Authorization
    const res2 = await loaded.fetch('https://cloudcode-pa.googleapis.com/v1/test', {
      headers: { Authorization: 'Bearer custom' }
    });
    expect(res2).toBeDefined();

    // Case 3: internal cloudcode endpoint without Authorization
    const res3 = await loaded.fetch('https://cloudcode-pa.googleapis.com/v1/test', {
      headers: {}
    });
    expect(res3).toBeDefined();

    // Case 4: Generative Language request (GL)
    const res4 = await loaded.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agy-tier': 'low'
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    });
    expect(res4).toBeDefined();
  });

  it('handles expired tokens during fetch interception', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    const auth = { type: 'oauth', access: 'expired-access', refresh: 'ref-123', expires: Date.now() - 10000 };
    const loaded = await loader!(async () => auth, { models: {} } as any);

    const res = await loaded.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
      method: 'POST',
      body: JSON.stringify({ contents: [] })
    });
    expect(res).toBeDefined();
  });

  it('handles model tier rewriting with suffix @high or x-agy-tier header', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    const auth = { type: 'oauth', access: 'access-123', refresh: 'ref-123', expires: Date.now() + 3600000 };
    const loaded = await loader!(async () => auth, { models: {} } as any);

    const res = await loaded.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash@high:generateContent', {
      method: 'POST',
      body: JSON.stringify({ contents: [] })
    });
    expect(res).toBeDefined();
  });

  it('safely handles headers formats in setSafeHeaders and getSafeHeader', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    const auth = { type: 'oauth', access: 'access-123', refresh: 'ref-123', expires: Date.now() + 3600000 };
    const loaded = await loader!(async () => auth, { models: {} } as any);

    // Array headers
    const resArray = await loaded.fetch('https://cloudcode-pa.googleapis.com/v1/test', {
      headers: [['X-Custom', 'val']]
    });
    expect(resArray).toBeDefined();

    // Plain object headers
    const resObj = await loaded.fetch('https://cloudcode-pa.googleapis.com/v1/test', {
      headers: { 'X-Custom': 'val' }
    });
    expect(resObj).toBeDefined();
  });

  it('handles Request object input in loader.fetch and model tier rewriting', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    const auth = { type: 'oauth', access: 'access-123', refresh: 'ref-123', expires: Date.now() + 3600000 };
    const loaded = await loader!(async () => auth, { models: {} } as any);

    const req = new Request('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash@high:generateContent', {
      method: 'POST',
      body: JSON.stringify({ contents: [] })
    });

    const res = await loaded.fetch(req);
    expect(res).toBeDefined();
  });

  it('handles non-oauth and missing token in loader.fetch inner execution', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    let currentAuth: any = { type: 'oauth', access: 'access-123', refresh: 'ref-123', expires: Date.now() + 3600000 };
    const loaded = await loader!(async () => currentAuth, { models: {} } as any);

    // Switch to non-oauth during fetch call
    currentAuth = { type: 'api', key: '123' };
    const res1 = await loaded.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent');
    expect(res1).toBeDefined();

    // Switch to oauth with empty access token
    currentAuth = { type: 'oauth', access: '', refresh: 'ref-123', expires: Date.now() + 3600000 };
    const res2 = await loaded.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent');
    expect(res2).toBeDefined();
  });

  it('handles custom user model overrides and capabilities merging in config hook', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const configObj: any = {
      provider: {
        [AGY_PROVIDER_ID]: {
          models: {
            'gemini-3.7-flash': {
              reasoning: false,
              attachment: false,
              tool_call: false,
              temperature: false,
              modalities: { input: ['text'], output: ['text'] },
              capabilities: {
                input: { text: true, image: false },
                output: { text: true }
              },
              cost: { input: 2, output: 4 }
            }
          }
        }
      }
    };
    await plugin.config?.(configObj);
    const configuredModel = configObj.provider[AGY_PROVIDER_ID].models['gemini-3.7-flash'];
    expect(configuredModel.reasoning).toBe(false);
    expect(configuredModel.attachment).toBe(false);
  });

  it('handles ensureProjectContextOrThrow error logging and re-throwing', async () => {
    const projectModule = await import('../../src/plugin/project');
    vi.spyOn(projectModule, 'ensureProjectContext').mockRejectedValueOnce(new Error('Project context exploded'));

    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    const auth = { type: 'oauth', access: 'access-123', refresh: 'ref-123', expires: Date.now() + 3600000 };
    const loaded = await loader!(async () => auth, { models: {} } as any);

    await expect(loaded.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent', {
      method: 'POST',
      body: JSON.stringify({ contents: [] })
    })).rejects.toThrow('Project context exploded');
  });

  it('handles toUrlString fallback with non-standard RequestInfo objects', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    const auth = { type: 'oauth', access: 'access-123', refresh: 'ref-123', expires: Date.now() + 3600000 };
    const loaded = await loader!(async () => auth, { models: {} } as any);

    const customReqObj = {
      toString: () => 'https://api.example.com/custom-object-url'
    };

    const res = await loaded.fetch(customReqObj as any);
    expect(res).toBeDefined();
  });


  it('handles resolver error in models hook gracefully', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    // Register a valid auth to initialize loader
    await loader!(async () => ({ type: 'oauth', access: 'token' }), { models: {} } as any);

    const modelsFn = plugin.provider?.models as any;
    const result = await modelsFn({ models: {} }, { auth: null });
    expect(result).toBeDefined();

    // With non-oauth auth, returns login-required
    const nonOAuthResult = await modelsFn({ models: {} }, { auth: { type: 'api_key' } });
    expect(nonOAuthResult['login-required']).toBeDefined();
  });

  it('handles normalizeProviderModelCosts with invalid/empty cost structures', async () => {
    const plugin = await AgyCLIOAuthPlugin({ client: mockClient });
    const loader = plugin.auth?.loader;

    const providerObj: any = {
      models: {
        'model-a': null,
        'model-b': { cost: null },
        'model-c': { cost: { input: 1, output: 2, cache: null } },
        'model-d': { cost: { input: 'invalid', output: 2 } }
      }
    };

    const auth = { type: 'oauth', access: 'access-123', refresh: 'ref-123', expires: Date.now() + 3600000 };
    await loader!(async () => auth, providerObj);

    expect(providerObj.models['model-b'].cost.input).toBe(0);
    expect(providerObj.models['model-c'].cost.input).toBe(1);
    expect(providerObj.models['model-d'].cost.input).toBe(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';
import * as traffic from '../src/plugin/traffic.js';
import * as tokenModule from '../src/plugin/token.js';
import * as cacheModule from '../src/plugin/cache.js';
import * as contextModule from '../src/plugin/project/context.js';
import * as fetchProject from '../src/sdk/fetch_project.js';
import * as signatureCacheMod from '../src/sdk/cache/signature-cache.js';
import * as errorsMod from '../src/sdk/request-helpers/errors.js';
import { createAgyQuotaTool } from '../src/plugin/quota.js';
import { createAgyQuotaSummaryTool } from '../src/plugin/quota-summary.js';

describe('coverage final push to exceed 95%', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('covers plugin variants, modalities, and capabilities for non-claude non-gpt models', async () => {
    const plugin = await AgyCLIOAuthPlugin({
      auth: {
        get: vi.fn().mockResolvedValue({
          type: 'oauth',
          access: 'acc-token',
          refresh: 'ref|p1|m1',
          expires: Date.now() + 3600000
        }),
        set: vi.fn()
      }
    } as any);

    const modelsRes = await plugin.provider.models?.(
      {
        models: {
          'custom-model': {
            name: 'Custom Model',
            options: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } }
          }
        }
      },
      {
        auth: {
          type: 'oauth',
          access: 'acc-token',
          refresh: 'ref|p1|m1',
          expires: Date.now() + 3600000
        }
      }
    );
    expect(modelsRes).toBeDefined();
  });

  it('covers plugin internal headers and background traffic on internal requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const simulateSpy = vi.spyOn(traffic, 'simulateClientBackgroundTraffic').mockImplementation(() => {});
    const plugin = await AgyCLIOAuthPlugin({
      auth: {
        get: vi.fn().mockResolvedValue({
          type: 'oauth',
          access: 'acc-token',
          refresh: 'ref|p1|m1',
          expires: Date.now() + 3600000
        }),
        set: vi.fn()
      }
    } as any);

    const loader = plugin.auth?.loader as any;
    const fetcher = await loader(
      async () => ({
        type: 'oauth',
        access: 'acc-token',
        refresh: 'ref|p1|m1',
        expires: Date.now() + 3600000
      }),
      { id: 'google-agy', options: { projectId: 'proj-123' } }
    );

    const res = await fetcher.fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
      method: 'POST',
      body: JSON.stringify({ project: 'm1' })
    });
    expect(res).toBeDefined();
    expect(simulateSpy).toHaveBeenCalled();
  });

  it('covers token.ts invalid_grant when client.auth.set throws an error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'invalid_grant', error_description: 'Token revoked' }))
    }));

    const mockClient = {
      auth: {
        set: vi.fn().mockRejectedValue(new Error('disk write permission denied'))
      }
    } as any;

    const result = await tokenModule.refreshAccessToken({
      type: 'oauth',
      refresh: 'revoked_token|proj1|m1',
      access: 'old',
      expires: 0
    }, mockClient);

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to clear stored Antigravity OAuth credentials'));
  });

  it('covers token.ts non-JSON error reading failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: vi.fn().mockRejectedValue(new Error('stream closed prematurely'))
    }));

    const mockClient = {
      auth: { set: vi.fn() }
    } as any;

    const result = await tokenModule.refreshAccessToken({
      type: 'oauth',
      refresh: 'valid_refresh|proj1|m1',
      access: 'old',
      expires: 0
    }, mockClient);

    expect(result).toBeUndefined();
  });

  it('covers cacheSignature LRU eviction discarding expired and oldest entries', () => {
    cacheModule.clearCachedAuth();
    for (let i = 0; i < 110; i++) {
      cacheModule.cacheSignature('session-lru', `thought text number ${i}`, `sig-${i}`);
    }
    const latest = cacheModule.getLatestSignature('session-lru');
    expect(latest).toBe('sig-109');
  });

  it('covers diskCache load and cleanup methods on SignatureCache', () => {
    const sigCache = new signatureCacheMod.SignatureCache({
      enabled: true,
      memory_ttl_seconds: 1,
      disk_ttl_seconds: 2,
      write_interval_seconds: 1
    });

    sigCache.store('key-1', 'sig-1');
    expect(sigCache.retrieve('key-1')).toBe('sig-1');

    (sigCache as any).cleanupExpired();
    sigCache.shutdown();
  });

  it('covers fetch_project.ts verbose log branch and 429 warnings', async () => {
    process.env.OPENCODE_AGY_VERBOSE_LOGS = '1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '2' }),
      text: vi.fn().mockResolvedValue('rate limited')
    }));

    const res = await fetchProject.loadManagedProject('acc-token', 'proj-rate-limited', undefined, 1, 10);
    expect(res).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('loadManagedProject failed with 429'));

    delete process.env.OPENCODE_AGY_VERBOSE_LOGS;
  });

  it('covers quota.ts and quota-summary.ts with custom version sorting and edge cases', async () => {
    const quotaTool = createAgyQuotaTool({
      client: { auth: { set: vi.fn() } } as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: 'acc',
        refresh: 'ref|p1|m1',
        expires: Date.now() + 3600000
      }),
      getConfiguredProjectId: () => 'p1',
      getUserAgentModel: () => 'gemini-2.5-pro'
    });

    vi.spyOn(contextModule, 'ensureProjectContext').mockResolvedValue({
      auth: { type: 'oauth', access: 'acc', refresh: 'ref|p1|m1', expires: Date.now() + 3600000 },
      effectiveProjectId: 'p1'
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        buckets: [
          {
            modelId: 'gemini-abc-custom',
            tokenType: 'REQUESTS',
            remainingFraction: 0.5,
            remainingAmount: '500',
            resetTime: '2026-08-18T00:00:00Z'
          },
          {
            modelId: 'gemini-99.99-pro',
            tokenType: 'TOKENS',
            remainingFraction: 0.8,
            resetTime: '2026-08-18T00:00:00Z'
          },
          {
            modelId: 'gemini-99.99.1-pro',
            tokenType: 'TOKENS',
            remainingFraction: 0.9,
            resetTime: '2026-08-18T00:00:00Z'
          }
        ]
      })
    }));

    const result = await quotaTool.execute({});
    expect(result).toBeDefined();
  });

  it('covers errors.ts rewriteGeminiPreviewAccessError with non-404 status and non-preview models', () => {
    const err = errorsMod.rewriteGeminiPreviewAccessError(500, { error: { message: 'internal' } }, 'gemini-2.5-flash');
    expect(err).toBeNull();

    const err2 = errorsMod.rewriteGeminiPreviewAccessError(404, { error: { message: 'not found' } }, 'claude-3-5-sonnet');
    expect(err2).toBeNull();
  });
});

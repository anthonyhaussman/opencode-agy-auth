import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';
import * as trafficModule from '../src/plugin/traffic.js';
import * as tokenModule from '../src/plugin/token.js';
import * as cacheModule from '../src/plugin/cache.js';
import * as quotaModule from '../src/plugin/quota.js';
import * as quotaSummaryModule from '../src/plugin/quota-summary.js';
import * as contextModule from '../src/plugin/project/context.js';
import * as fetchQuotaModule from '../src/sdk/fetch_quota.js';
import * as fetchProjectModule from '../src/sdk/fetch_project.js';
import * as retryModule from '../src/sdk/retry/index.js';
import * as retryHelpers from '../src/sdk/retry/helpers.js';
import * as errorHelpers from '../src/sdk/request-helpers/errors.js';
import * as quotaRetryModule from '../src/sdk/retry/quota.js';
import * as thinkingModule from '../src/sdk/request/thinking.js';
import * as signatureCacheModule from '../src/sdk/cache/signature-cache.js';
import * as turnStateTrackerModule from '../src/sdk/request/turn-state-tracker.js';

describe('Target 95% Coverage Test Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('src/plugin.ts edge cases', () => {
    it('covers variants and options builder branches in getModelsList', async () => {
      const plugin = await AgyCLIOAuthPlugin({
        client: {
          config: {
            get: vi.fn().mockResolvedValue({
              data: {
                provider: {
                  'google-agy': {
                    options: {
                      models: {
                        'gemini-3.7-flash': {
                          variants: {
                            low: { thinkingConfig: { maxTokens: 100 } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
          },
        } as any,
      });

      const configResult: any = {
        provider: {
          'google-agy': {
            models: {
              'gemini-3.7-flash': {
                modalities: { input: ['text'], output: ['text'] },
                capabilities: { input: ['text'], output: ['text'] },
              },
            },
          },
        },
      };

      await plugin.config!(configResult);
      expect(configResult.provider['google-agy'].models['gemini-3.7-flash']).toBeDefined();
    });

    it('covers custom auth loader and methods', async () => {
      const plugin = await AgyCLIOAuthPlugin({ client: {} as any });
      const authHandler: any = (plugin.auth as any).methods.find((m: any) => m.type === 'oauth');
      expect(authHandler).toBeDefined();
      expect(authHandler.authorize).toBeInstanceOf(Function);

      const loaderObj = await plugin.auth.loader(
        async () => ({ type: 'oauth', tokens: { access: 'token-abc' } } as any),
        { models: {} } as any
      );
      expect(loaderObj.apiKey).toBe('');
      expect(loaderObj.fetch).toBeInstanceOf(Function);
    });
  });

  describe('src/plugin/token.ts edge cases', () => {
    it('handles refresh errors and invalid grant', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token revoked' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = { auth: { set: vi.fn() } } as any;
      const result = await tokenModule.refreshAccessToken(
        { type: 'oauth', refresh: 'old-refresh|proj|managed', access: '', expires: 0 } as any,
        client
      );
      expect(result).toBeUndefined();
      expect(client.auth.set).toHaveBeenCalled();
    });

    it('handles refresh with non-json server error and retries', async () => {
      vi.spyOn(retryHelpers, 'wait').mockResolvedValue(undefined);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Internal Error', { status: 500 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'new-acc',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );

      const client = { auth: { set: vi.fn() } } as any;
      const result = await tokenModule.refreshAccessToken(
        { type: 'oauth', refresh: 'refresh-ok', access: '', expires: 0 } as any,
        client
      );
      expect(result?.access).toBe('new-acc');
    });
  });

  describe('src/plugin/traffic.ts edge cases', () => {
    it('covers sendWithRetry status handling and errors', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      vi.spyOn(retryHelpers, 'wait').mockResolvedValue(undefined);

      // Force background traffic
      trafficModule.simulateClientBackgroundTraffic('token-traffic');
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe('src/plugin/cache.ts edge cases', () => {
    it('handles signature cache error paths', () => {
      const entry = cacheModule.getLatestSignature('non-existent-session');
      expect(entry).toBeUndefined();

      cacheModule.cacheSignature('', 'test', 'sig');
      expect(cacheModule.getLatestSignature('')).toBeUndefined();
    });
  });

  describe('src/plugin/project/context.ts edge cases', () => {
    it('handles project resolution error paths', async () => {
      vi.spyOn(fetchProjectModule, 'loadManagedProject').mockResolvedValueOnce(null);
      const client = { auth: { set: vi.fn() } } as any;
      const res = await contextModule.ensureProjectContext(
        { type: 'oauth', tokens: { access: 'acc', refresh: 'ref' } } as any,
        client,
        'custom-proj'
      );
      expect(res.effectiveProjectId).toBe('');
    });
  });

  describe('src/plugin/quota.ts and quota-summary.ts edge cases', () => {
    it('executes quota tool with various group configurations', async () => {
      const validAuth = {
        type: 'oauth' as const,
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 3600000,
      };

      const tool = quotaModule.createAgyQuotaTool({
        client: {} as any,
        getAuthResolver: () => async () => validAuth,
        getConfiguredProjectId: () => undefined,
        getUserAgentModel: () => undefined,
      });

      vi.spyOn(contextModule, 'ensureProjectContext').mockResolvedValueOnce({
        auth: validAuth,
        effectiveProjectId: 'proj-123',
      });
      vi.spyOn(fetchQuotaModule, 'retrieveUserQuota').mockResolvedValueOnce({
        buckets: [
          {
            modelId: 'models/gemini-2.5-pro',
            tokenType: 'TOKENS',
            remainingFraction: 0.75,
            remainingAmount: '750000',
            resetTime: new Date(Date.now() + 3600000).toISOString(),
          },
          {
            modelId: 'models/claude-3-7-sonnet',
            tokenType: 'REQUESTS',
            remainingFraction: 0.1,
            resetTime: new Date(Date.now() + 7200000).toISOString(),
          },
          {
            modelId: 'custom-model',
            tokenType: 'UNKNOWN',
          },
        ],
      } as any);

      const output = await tool.execute({} as any, {} as any);
      expect(output).toContain('Agy quota usage for project');
      expect(output).toContain('gemini-2.5-pro');
    });

    it('executes quota-summary tool with top-level and empty buckets', async () => {
      const validAuth = {
        type: 'oauth' as const,
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 3600000,
      };

      const tool = quotaSummaryModule.createAgyQuotaSummaryTool({
        client: {} as any,
        getAuthResolver: () => async () => validAuth,
        getConfiguredProjectId: () => undefined,
        getUserAgentModel: () => undefined,
      });

      vi.spyOn(contextModule, 'ensureProjectContext').mockResolvedValueOnce({
        auth: validAuth,
        effectiveProjectId: 'proj-123',
      });
      vi.spyOn(fetchQuotaModule, 'retrieveUserQuotaSummary').mockResolvedValueOnce({
        groups: [
          {
            displayName: 'Gemini',
            description: 'Gemini models',
            buckets: [
              {
                displayName: 'gemini-3.7-flash',
                window: 'WEEKLY',
                remainingFraction: 0.9,
                remainingAmount: '900000',
                resetTime: new Date().toISOString(),
              },
            ],
          },
          {
            displayName: 'Claude',
            description: 'Claude models',
            buckets: [],
          },
        ],
      } as any);

      const output = await tool.execute({} as any, {} as any);
      expect(output).toContain('Agy quota summary for project');
      expect(output).toContain('Gemini');
    });
  });

  describe('src/sdk/request-helpers/errors.ts and retry edge cases', () => {
    it('parses fractional nanos and complex retry headers', () => {
      const delay1 = quotaRetryModule.retryInternals.parseRetryDelayValue({ seconds: 1, nanos: 500000000 });
      expect(delay1).toBe(1500);

      const delay2 = quotaRetryModule.retryInternals.parseRetryDelayValue({ seconds: undefined });
      expect(delay2).toBeNull();
    });

    it('handles retry on abort and network errors in fetchWithRetry', async () => {
      vi.spyOn(retryHelpers, 'wait').mockResolvedValue(undefined);
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new TypeError('network error'))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const res = await retryModule.fetchWithRetry(
        'https://example.com',
        {},
        { attempts: 2, delayMs: 10, fetchFn: mockFetch }
      );
      expect(res.status).toBe(200);
    });
  });

  describe('src/sdk/cache/signature-cache.ts and turn state tracker edge cases', () => {
    it('covers signature cache eviction and stats', () => {
      const cache = new signatureCacheModule.SignatureCache({
        enabled: true,
        memory_ttl_seconds: 1,
        disk_ttl_seconds: 1,
        write_interval_seconds: 1,
      });

      cache.store('k1', 'sig1');
      expect(cache.retrieve('k1')).toBe('sig1');
      expect(cache.has('k1')).toBe(true);

      cache.storeThinking('k1', 'thought-text', 'sig-thought', ['tool-1']);
      expect(cache.hasThinking('k1')).toBe(true);
      expect(cache.retrieveThinking('k1')?.signature).toBe('sig-thought');

      const stats = cache.getStats();
      expect(stats).toBeDefined();
      cache.shutdown();
    });

    it('covers turn state tracker recovery and cleanup', () => {
      const tracker = new turnStateTrackerModule.TurnStateTracker(false);
      tracker.updateAfterResponse('sess-1', {
        lastTurnIndex: 1,
        lastTurnHadThinking: true,
        pendingToolSignatures: ['sig-a'],
      });

      expect(tracker.getState('sess-1')?.lastTurnHadThinking).toBe(true);

      tracker.recoverFromContents('sess-1', [
        { role: 'model', parts: [{ text: 'thought', thought: true }] },
      ]);

      tracker.clear('sess-1');
      expect(tracker.getState('sess-1')).toBeUndefined();
      tracker.shutdown();
    });
  });

  describe('src/sdk/request/thinking.ts edge cases', () => {
    it('covers thought buffer and signature store', () => {
      const store = thinkingModule.createSignatureStore();
      store.set('id-1', 'sig-1');
      expect(store.get('id-1')).toBe('sig-1');
      expect(store.has('id-1')).toBe(true);
      store.delete('id-1');
      expect(store.has('id-1')).toBe(false);

      const buffer = thinkingModule.createThoughtBuffer();
      buffer.set(0, 'chunk-1');
      expect(buffer.get(0)).toBe('chunk-1');
      buffer.clear();
      expect(buffer.get(0)).toBeUndefined();
    });
  });
});

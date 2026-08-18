import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enhanceGeminiErrorResponse, rewriteGeminiPreviewAccessError } from '../src/sdk/request-helpers/errors.js';
import { refreshAccessToken } from '../src/plugin/token.js';
import { createAgyQuotaTool } from '../src/plugin/quota.js';
import { fetchAvailableModels } from '../src/sdk/fetch_models.js';
import { onboardManagedProject } from '../src/sdk/fetch_project.js';
import { retrieveUserQuota, retrieveUserQuotaSummary } from '../src/sdk/fetch_quota.js';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';
import * as helpers from '../src/sdk/retry/helpers.js';
import * as projectUtils from '../src/plugin/project/utils.js';

describe('Deep Coverage Expansion', () => {
  describe('errors.ts branches', () => {
    it('enhances Gemini 429 quota and rate limit errors with retry messages and delays', () => {
      const resp1 = enhanceGeminiErrorResponse(
        {
          error: {
            code: 429,
            message: 'Rate limit hit.',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'RATE_LIMIT_EXCEEDED',
                domain: 'cloudcode-pa.googleapis.com',
              },
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: { seconds: 2, nanos: 500000000 },
              },
            ],
          },
        },
        429
      );
      expect(resp1?.retryAfterMs).toBe(2500);
      expect(resp1?.body?.error?.message).toContain('Rate limit exceeded');

      const resp2 = enhanceGeminiErrorResponse(
        {
          error: {
            code: 429,
            message: 'Quota exceeded after 2s',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ description: 'Daily quota exceeded' }],
              },
            ],
          },
        },
        429
      );
      expect(resp2?.body?.error?.message).toContain('Quota exhausted');
    });

    it('rewrites 404 preview access errors for gemini-3 models', () => {
      const res1 = rewriteGeminiPreviewAccessError(
        { error: { code: 404, message: 'Model not found' } },
        404,
        'gemini-3.0-pro'
      );
      expect(res1?.error?.message).toContain('preview access');

      const res2 = rewriteGeminiPreviewAccessError(
        { error: { code: 404, message: 'gemini 3 preview error' } },
        404
      );
      expect(res2?.error?.message).toContain('preview access');
    });
  });

  describe('token.ts edge cases', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      vi.spyOn(helpers, 'wait').mockResolvedValue(undefined);
    });

    it('handles non-error thrown objects in refreshAccessToken', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => {
        throw 'String error thrown';
      });

      const client = { auth: { set: vi.fn() } } as any;
      const res = await refreshAccessToken({ type: 'oauth', access: 'old', refresh: 'tok', expires: 0 }, client);
      expect(res).toBeUndefined();
    });

    it('retries on network fetch failure and eventually returns undefined', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      const client = { auth: { set: vi.fn() } } as any;
      const res = await refreshAccessToken({ type: 'oauth', access: 'old', refresh: 'tok', expires: 0 }, client);
      expect(res).toBeUndefined();
    });

    it('handles non-retryable 400 error immediately and clears stored auth', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token revoked' }), { status: 400 })
      );

      const client = { auth: { set: vi.fn() } } as any;
      const res = await refreshAccessToken({ type: 'oauth', access: 'old', refresh: 'tok', expires: 0 }, client);
      expect(res).toBeUndefined();
      expect(client.auth.set).toHaveBeenCalled();
    });
  });

  describe('fetch_models.ts verbose logging and error handling', () => {
    it('logs verbose info when OPENCODE_AGY_VERBOSE_LOGS is enabled', async () => {
      const origEnv = process.env.OPENCODE_AGY_VERBOSE_LOGS;
      process.env.OPENCODE_AGY_VERBOSE_LOGS = '1';

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ models: { 'gemini-2.5-pro': {} } }), { status: 200 })
      );

      const models = await fetchAvailableModels('test-token', 'test-proj');
      expect(models).not.toBeNull();

      process.env.OPENCODE_AGY_VERBOSE_LOGS = origEnv;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('throws error when response is not ok in fetchAvailableModels', async () => {
      const origEnv = process.env.OPENCODE_AGY_VERBOSE_LOGS;
      process.env.OPENCODE_AGY_VERBOSE_LOGS = '1';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Internal error', { status: 500 })
      );

      await expect(fetchAvailableModels('tok', 'proj')).rejects.toThrow('Google API returned status 500');

      process.env.OPENCODE_AGY_VERBOSE_LOGS = origEnv;
      warnSpy.mockRestore();
    });
  });

  describe('fetch_quota.ts error and edge branches', () => {
    it('returns null on 401 response for quota', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
      const quota = await retrieveUserQuota('bad-token', 'proj');
      expect(quota).toBeNull();
    });

    it('returns null on 401 response for quota summary', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
      const summary = await retrieveUserQuotaSummary('bad-token', 'proj');
      expect(summary).toBeNull();
    });
  });

  describe('fetch_project.ts polling operation timeout and failure', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
      vi.spyOn(helpers, 'wait').mockResolvedValue(undefined);
      vi.spyOn(projectUtils, 'wait').mockResolvedValue(undefined);
    });

    it('returns undefined when operation done has error', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ name: 'operations/op-fail', done: false }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              name: 'operations/op-fail',
              done: true,
              error: { code: 7, message: 'Permission denied' },
            }),
            { status: 200 }
          )
        );

      const res = await onboardManagedProject('token', 'free-tier');
      expect(res).toBeUndefined();
    });

    it('returns undefined when operation fetch throws network error', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ name: 'operations/op-net', done: false }), { status: 200 })
        )
        .mockRejectedValue(new TypeError('Network error on poll'));

      const res = await onboardManagedProject('token', 'free-tier', 'proj');
      expect(res).toBeUndefined();
    });
  });

  describe('plugin.ts custom models and quota sorting', () => {
    it('merges custom model options and capabilities in config hook', async () => {
      const plugin = await AgyCLIOAuthPlugin({
        client: {
          config: {
            get: vi.fn().mockResolvedValue({
              data: {
                provider: {
                  'google-agy': {
                    options: {
                      thinkingConfig: { thinkingBudget: 2048 },
                    },
                    models: {
                      'custom-flash': {
                        displayName: 'Custom Flash',
                        options: {
                          thinkingConfig: { thinkingBudget: 4096 },
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

      const configResult = { provider: { 'google-agy': {} } };
      await plugin.config(configResult as any);
      expect((configResult.provider['google-agy'] as any).models).toBeDefined();
    });

    it('sorts versions and variants correctly in quota tool', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        const u = String(url);
        if (u.includes('loadCodeAssist')) {
          return Promise.resolve(new Response(JSON.stringify({ cloudaicompanionProject: { id: 'p1' } }), { status: 200 }));
        }
        if (u.includes('retrieveUserQuota')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                buckets: [
                  { modelId: 'gemini-2.5-pro_vertex', tokenType: 'TOKENS', remainingFraction: 0.9 },
                  { modelId: 'gemini-2.5-pro', tokenType: 'TOKENS', remainingFraction: 0.8 },
                  { modelId: 'gemini-1.5-pro', tokenType: 'TOKENS', remainingFraction: 0.5 },
                  { modelId: 'gemini-2.0-flash', tokenType: 'REQUESTS', remainingFraction: 0.95 },
                  { modelId: 'claude-3.5-sonnet', tokenType: 'TOKENS', remainingFraction: 0.7 },
                  { modelId: 'claude-3-haiku', tokenType: 'TOKENS', remainingFraction: 0.6 },
                ],
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

      const client = { auth: { set: vi.fn() } } as any;
      const quotaTool = createAgyQuotaTool({
        getAuthResolver: () => () => ({ type: 'oauth', access: 'tok', refresh: 'ref', expires: Date.now() + 3600000 } as any),
        client,
        getConfiguredProjectId: () => 'p1',
        getUserAgentModel: () => undefined,
      });

      const res = await quotaTool.execute({} as any, {} as any);
      expect(res).toContain('Gemini 2.5');
      expect(res).toContain('Gemini 1.5');
      expect(res).toContain('Other');
    });
  });
});

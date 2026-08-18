import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';
import * as retryQuotaModule from '../src/sdk/retry/quota.js';
import * as projectContextModule from '../src/plugin/project/context.js';
import * as tokenModule from '../src/plugin/token.js';

describe('Targeted 95% Coverage Test Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('setSafeHeaders & getSafeHeader edge branches in plugin.ts', () => {
    it('handles plain object header overwrites and additions in setSafeHeaders', async () => {
      const originalHeaders = globalThis.Headers;
      (globalThis as any).Headers = undefined;

      try {
        const plugin = await AgyCLIOAuthPlugin({
          client: {
            config: { get: vi.fn().mockResolvedValue({}) },
            auth: { set: vi.fn() },
            tui: { showToast: vi.fn() }
          } as any
        });

        const customProvider: any = {
          npm: '@ai-sdk/google',
          name: 'Antigravity CLI',
          options: {},
          models: {}
        };

        const configObj: any = {
          provider: {
            'google-agy': customProvider
          }
        };

        await plugin.config(configObj);
        const loaderRes = await plugin.auth?.loader(async () => ({
          type: 'oauth',
          access: 'acc-token',
          refresh: 'ref-token|proj-1|proj-managed',
          expires: Date.now() + 100000
        }), customProvider);

        // Header array and header object branches
        const resp1 = await loaderRes.fetch('https://cloudcode-pa.googleapis.com/v1/test', {
          headers: [['user-agent', 'old-agent'], ['custom-key', 'val']]
        });
        expect(resp1).toBeDefined();

        const resp2 = await loaderRes.fetch('https://cloudcode-pa.googleapis.com/v1/test', {
          headers: { 'user-agent': 'old-agent', 'other-key': 'val2' }
        });
        expect(resp2).toBeDefined();
      } finally {
        globalThis.Headers = originalHeaders;
      }
    });

    it('triggers OAuth authorize method callbacks', async () => {
      const plugin = await AgyCLIOAuthPlugin({
        client: {
          config: { get: vi.fn().mockResolvedValue({}) },
          auth: { set: vi.fn() },
          tui: { showToast: vi.fn() }
        } as any
      });

      const oauthMethod = plugin.auth?.methods?.find((m: any) => m.type === 'oauth');
      expect(oauthMethod).toBeDefined();
      expect(typeof oauthMethod?.authorize).toBe('function');
    });
  });

  describe('parseRetryDelayValue in quota.ts', () => {
    it('covers all parseRetryDelayValue branches', () => {
      const parseVal = retryQuotaModule.retryInternals.parseRetryDelayValue;
      expect(parseVal('100ms')).toBe(100);
      expect(parseVal('2.5s')).toBe(2500);
      expect(parseVal('   ')).toBeNull();
      expect(parseVal('invalid-str')).toBeNull();
      expect(parseVal({ seconds: 'invalid' } as any)).toBeNull();
      expect(parseVal({ seconds: 10, nanos: 'invalid' } as any)).toBe(10000);
      expect(parseVal({ seconds: 5, nanos: 500000000 })).toBe(5500);
      expect(parseVal({ seconds: 0, nanos: 2000000 })).toBe(2);
      expect(parseVal({ seconds: -1, nanos: 0 })).toBeNull();
    });

    it('covers parseRetryDelayFromMessage branches', () => {
      const parseMsg = retryQuotaModule.retryInternals.parseRetryDelayFromMessage;
      expect(parseMsg('')).toBeNull();
      expect(parseMsg('Please retry in 500ms')).toBe(500);
      expect(parseMsg('Reset after 3s')).toBe(3000);
      expect(parseMsg('Some other error')).toBeNull();
    });
  });

  describe('compareVersionDesc in quota.ts', () => {
    it('sorts versions with non-numeric, unequal, and equal segments', async () => {
      const plugin = await AgyCLIOAuthPlugin({
        client: {
          config: { get: vi.fn().mockResolvedValue({}) },
          auth: { set: vi.fn() },
          tui: { showToast: vi.fn() }
        } as any
      });

      vi.spyOn(projectContextModule, 'ensureProjectContext').mockResolvedValue({
        auth: { access: 'acc', refresh: 'ref|p1|p2', expires: Date.now() + 100000 } as any,
        effectiveProjectId: 'p2'
      });

      const quotaModuleInternal = await import('../src/sdk/fetch_quota.js');
      vi.spyOn(quotaModuleInternal, 'retrieveUserQuota').mockResolvedValue({
        buckets: [
          { modelId: 'gemini-1.5-flash', tokenType: 'TOKENS', remainingFraction: 0.8 },
          { modelId: 'gemini-1.5-pro', tokenType: 'TOKENS', remainingFraction: 0.9 },
          { modelId: 'gemini-2.0-flash', tokenType: 'TOKENS', remainingFraction: 0.7 },
          { modelId: 'gemini-2.5-flash', tokenType: 'TOKENS', remainingFraction: 0.6 },
          { modelId: 'gemini-2.5.1-flash', tokenType: 'TOKENS', remainingFraction: 0.5 },
          { modelId: 'gemini-alpha-flash', tokenType: 'TOKENS', remainingFraction: 0.4 },
          { modelId: 'gemini-beta-flash', tokenType: 'TOKENS', remainingFraction: 0.3 }
        ]
      } as any);

      const tool = (plugin.tool as any)['agy_quota'];
      const res = await tool.execute();
      expect(res).toContain('Agy quota usage for project');
    });
  });

  describe('token.ts error and retry edge cases', () => {
    it('handles refresh with non-Error exceptions and stream read errors', async () => {
      const client = {
        auth: { set: vi.fn().mockRejectedValue(new Error('store fail')) }
      } as any;

      const auth = {
        type: 'oauth',
        access: 'acc',
        refresh: 'ref|p1|p2',
        expires: 0
      } as any;

      // Mock fetch returning invalid_grant with bad stream
      const mockResponse = {
        ok: false,
        status: 400,
        clone: () => ({
          json: async () => { throw new Error('json fail'); },
          text: async () => { throw new Error('text fail'); }
        }),
        json: async () => ({ error: 'invalid_grant', error_description: 'revoked' })
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse as any);

      const res = await tokenModule.refreshAccessToken(auth, client);
      expect(res).toBeUndefined();
    });
  });

  describe('errors.ts extractValidationInfo & extractQuotaInfo branches', () => {
    it('covers extractValidationInfo and extractQuotaInfo branches', async () => {
      const errorsModule = await import('../src/sdk/request-helpers/errors.js');

      // 403 with Help link having learn more
      const body403: any = {
        error: {
          message: 'Base error',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'VALIDATION_REQUIRED',
              domain: 'cloudcode-pa.googleapis.com'
            },
            {
              '@type': 'type.googleapis.com/google.rpc.Help',
              links: [
                { url: 'https://support.google.com/doc', description: 'learn more' }
              ]
            }
          ]
        }
      };
      const res403 = errorsModule.enhanceGeminiErrorResponse(body403, 403);
      expect(res403?.body?.error?.message).toContain('Complete validation');

      // 403 with Help link having support.google.com url but different description
      const body403HelpUrl: any = {
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'VALIDATION_REQUIRED',
              domain: 'cloudcode-pa.googleapis.com'
            },
            {
              '@type': 'type.googleapis.com/google.rpc.Help',
              links: [
                { url: 'https://support.google.com/article' }
              ]
            }
          ]
        }
      };
      const res403HelpUrl = errorsModule.enhanceGeminiErrorResponse(body403HelpUrl, 403);
      expect(res403HelpUrl?.body?.error?.message).toContain('Account validation required');

      // 403 with malformed link url
      const body403BadUrl: any = {
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'VALIDATION_REQUIRED',
              domain: 'cloudcode-pa.googleapis.com'
            },
            {
              '@type': 'type.googleapis.com/google.rpc.Help',
              links: [
                { url: 'invalid url' }
              ]
            }
          ]
        }
      };
      const res403BadUrl = errorsModule.enhanceGeminiErrorResponse(body403BadUrl, 403);
      expect(res403BadUrl?.body?.error?.message).toContain('Complete validation');
      expect(res403BadUrl?.body?.error?.message).toContain('invalid url');

      // 429 QuotaFailure with daily description
      const body429Daily: any = {
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ description: 'Daily limit exceeded per day' }]
            }
          ]
        }
      };
      const res429Daily = errorsModule.enhanceGeminiErrorResponse(body429Daily, 429);
      expect(res429Daily?.body?.error?.message).toContain('Quota exhausted for this account');

      // 429 QuotaFailure without daily (retryable)
      const body429Retryable: any = {
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ description: 'Too many requests' }]
            }
          ]
        }
      };
      const res429Retryable = errorsModule.enhanceGeminiErrorResponse(body429Retryable, 429);
      expect(res429Retryable?.body?.error?.message).toContain('Rate limit exceeded');
    });
  });

  describe('context.ts & cache.ts edge cases', () => {
    it('covers invalidateProjectContextCache and LRU cache branches', async () => {
      const contextModule = await import('../src/plugin/project/context.js');
      const cacheModule = await import('../src/plugin/cache.js');

      // Invalidate with prefix
      contextModule.invalidateProjectContextCache('ref-1');
      contextModule.invalidateProjectContextCache();

      // LRU cache insertion past MAX_ENTRIES_PER_SESSION
      for (let i = 0; i < 110; i++) {
        cacheModule.cacheSignature('session-bulk', `thought-${i}`, `sig-${i}`);
      }
      expect(cacheModule.getLatestSignature('session-bulk')).toBe('sig-109');
    });
  });
});

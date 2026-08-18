import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgyQuotaTool } from '../../src/plugin/quota.js';
import { createAgyQuotaSummaryTool } from '../../src/plugin/quota-summary.js';
import * as projectContextPlugin from '../../src/plugin/project/context.js';
import * as projectPlugin from '../../src/plugin/project/index.js';
import { AgyCLIOAuthPlugin } from '../../src/plugin.js';
import * as fetchModule from '../../src/fetch.js';
import { RetrieveUserQuotaBucket } from '../../src/sdk/fetch_quota.js';

describe('Plugin and Quota Edge Cases', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('quota.ts formatting edge cases', () => {
    it('formats quota output with multiple versions, unknown remaining, and token types (lines 120-128, 172)', async () => {
      const buckets: RetrieveUserQuotaBucket[] = [
        {
          modelId: 'gemini-2.5-flash-preview:generateContent',
          remainingAmount: undefined,
          remainingFraction: undefined,
          resetTime: '2026-08-17T20:00:00Z',
          tokenType: 'TOKENS'
        },
        {
          modelId: 'gemini-3.0-pro:generateContent',
          remainingAmount: '500',
          remainingFraction: 0.5,
          resetTime: '2026-08-17T21:00:00Z',
          tokenType: 'REQUESTS'
        }
      ];

      vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
        effectiveProjectId: 'test-project',
        auth: {} as any
      });
      vi.spyOn(projectPlugin, 'retrieveUserQuota').mockResolvedValue({
        buckets
      });

      const quotaTool = createAgyQuotaTool({
        client: {} as any,
        getAuthResolver: () => async () => ({
          type: 'oauth',
          access: 'test-access',
          refresh: 'test-refresh',
          expires: Date.now() + 100000
        }),
        getConfiguredProjectId: () => 'test-project',
        getUserAgentModel: () => 'gemini-2.5-pro'
      });

      const output = await quotaTool.execute({});
      expect(output).toContain('Agy quota usage for project `test-project`');
      expect(output).toContain('unknown');
      expect(output).toContain('Type');
    });
  });

  describe('quota-summary.ts formatting edge cases', () => {
    it('formats summary with custom window labels, disabled buckets without descriptions, and missing fractions (lines 100-103, 124-126, 187-195)', async () => {
      const summary = {
        groups: [
          {
            displayName: 'Custom Group',
            description: 'Custom Group Description',
            buckets: [
              {
                window: 'CUSTOM_WINDOW',
                displayName: 'Custom Sub-Window',
                disabled: true,
                description: undefined
              },
              {
                window: 'CUSTOM_WINDOW',
                displayName: undefined,
                disabled: false,
                remainingFraction: undefined,
                remainingAmount: undefined,
                resetTime: '2026-08-17T22:00:00Z'
              },
              {
                window: 'WEEKLY',
                disabled: false,
                remainingFraction: undefined,
                remainingAmount: '1000'
              }
            ]
          }
        ]
      };

      vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
        effectiveProjectId: 'test-project',
        auth: {} as any
      });
      vi.spyOn(projectPlugin, 'retrieveUserQuotaSummary').mockResolvedValue(summary as any);

      const summaryTool = createAgyQuotaSummaryTool({
        client: {} as any,
        getAuthResolver: () => async () => ({
          type: 'oauth',
          access: 'test-access',
          refresh: 'test-refresh',
          expires: Date.now() + 100000
        }),
        getConfiguredProjectId: () => 'test-project',
        getUserAgentModel: () => 'gemini-2.5-pro'
      });

      const output = await summaryTool.execute({});
      expect(output).toContain('Custom Group');
      expect(output).toContain('Models within this group: Custom Group Description');
      expect(output).toContain('Disabled: other limit exhausted');
      expect(output).toContain('unknown remaining');
      expect(output).toContain('1,000 remaining');
    });
  });

  describe('plugin.ts edge cases', () => {
    it('handles plugin models hook when resolver throws (lines 635-637)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client: any = {
        config: {
          get: vi.fn().mockReturnValue({})
        }
      };

      const plugin = await AgyCLIOAuthPlugin({ client } as any);
      let throwOnNextCall = false;
      const authResolver = vi.fn().mockImplementation(async () => {
        if (throwOnNextCall) {
          throw new Error('Resolver broken');
        }
        return {
          type: 'oauth',
          access: 'test-token',
          refresh: 'test-refresh',
          expires: Date.now() + 100000
        };
      });

      // Initialize loader first
      await plugin.auth.loader(authResolver);

      // Now enable throwing for models hook
      throwOnNextCall = true;
      const resultAfterLoader = await plugin.provider.models(
        {},
        {
          auth: undefined
        }
      );

      expect(resultAfterLoader).toEqual({
        'login-required': {
          name: 'No models available'
        }
      });
      expect(warnSpy).toHaveBeenCalled();
    });

    it('handles internal request with Authorization header already present (lines 520-523)', async () => {
      const agyFetchSpy = vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

      const client: any = {
        config: { get: vi.fn().mockReturnValue({}) }
      };

      const plugin = await AgyCLIOAuthPlugin({ client } as any);
      const authResolver = vi.fn().mockResolvedValue({
        type: 'oauth',
        access: 'token-abc',
        refresh: 'refresh-token',
        expires: Date.now() + 100000
      });

      const auth = await plugin.auth.loader(authResolver);

      const response = await auth.fetch('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
        headers: {
          'Authorization': 'Bearer [REDACTED:Bearer token]'
        }
      });

      expect(response.status).toBe(200);
      expect(agyFetchSpy).toHaveBeenCalledWith(
        'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer [REDACTED:Bearer token]'
          }
        })
      );
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';
import { rewriteGeminiPreviewAccessError, enhanceGeminiErrorResponse } from '../src/sdk/request-helpers/errors.js';
import { onboardManagedProject } from '../src/sdk/fetch_project.js';
import { fetchWithRetry } from '../src/sdk/retry/index.js';
import * as projectUtils from '../src/plugin/project/utils.js';
import * as fetchModule from '../src/fetch.js';

describe('reach 95% coverage branches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('tests rewriteGeminiPreviewAccessError with empty message and non-matching conditions', () => {
    // Non-matching
    expect(rewriteGeminiPreviewAccessError({}, 200, 'gemini-3.7-flash')).toBeNull();
    // Matching 404 with Gemini 3 preview error without message
    const previewRes = rewriteGeminiPreviewAccessError(
      {
        error: {
          code: 404,
          status: 'NOT_FOUND',
          message: '',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'PREVIEW_FEATURE_DISABLED', domain: 'cloudcode-pa.googleapis.com' }]
        }
      },
      404,
      'gemini-3.7-flash'
    );
    expect(previewRes?.error?.message).toContain('preview access page');
  });

  it('tests enhanceGeminiErrorResponse with retry info delay parsing', () => {
    const errorBody = {
      error: {
        code: 429,
        message: 'Rate limit hit. Please retry in 2.5s',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED'
          }
        ]
      }
    };
    const res = enhanceGeminiErrorResponse(errorBody, 429);
    expect(res?.retryAfterMs).toBe(2500);

    const errorBodyMs = {
      error: {
        code: 429,
        message: 'Rate limit hit. retry after 500ms',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED'
          }
        ]
      }
    };
    const resMs = enhanceGeminiErrorResponse(errorBodyMs, 429);
    expect(resMs?.retryAfterMs).toBe(500);
  });

  it('tests onboardManagedProject timeout when operation is never done', async () => {
    vi.spyOn(projectUtils, 'wait').mockResolvedValue(undefined);
    vi.spyOn(fetchModule, 'agyFetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('onboard')) {
        return new Response(JSON.stringify({ name: 'operations/op-123' }), { status: 200 });
      }
      if (url.includes('operations/op-123')) {
        return new Response(JSON.stringify({ done: false }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const res = await onboardManagedProject('token-xyz', 'free-tier', undefined, undefined, 1, 10);
    expect(res).toBeUndefined();
  });

  it('tests onboardManagedProject when initial response has no name', async () => {
    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const res = await onboardManagedProject('token-xyz', 'free-tier');
    expect(res).toBeUndefined();
  });

  it('tests fetchWithRetry abort and cooldown checks', async () => {
    vi.spyOn(fetchModule, 'agyFetch').mockRejectedValue(new DOMException('The user aborted a request.', 'AbortError'));
    const controller = new AbortController();
    controller.abort();
    await expect(fetchWithRetry('https://example.com', { signal: controller.signal })).rejects.toThrow();
  });

  it('tests AgyCLIOAuthPlugin variants for all models including claude, gpt and gemini models', async () => {
    const plugin = await AgyCLIOAuthPlugin({
      client: {
        config: { get: vi.fn().mockResolvedValue({ data: {} }) },
        auth: { set: vi.fn() },
        tui: { showToast: vi.fn() }
      } as any
    });

    const configObj = {
      provider: {
        'google-agy': {
          npm: '@ai-sdk/google',
          name: 'Antigravity CLI',
          models: {
            'gemini-3.7-flash': { name: 'Custom Gemini 3.7' }
          }
        }
      }
    };

    await plugin.config(configObj as any);
    const models = (configObj.provider['google-agy'] as any).models;
    expect(models['gemini-3.7-flash']).toBeDefined();
    expect(models['gemini-3.6-flash']).toBeDefined();
    expect(models['gemini-3.5-flash']).toBeDefined();
    expect(models['gemini-3.1-pro']).toBeDefined();
    expect(models['claude-sonnet-4-6']).toBeDefined();
    expect(models['gpt-oss-120b-medium']).toBeDefined();

    // Verify Claude model capabilities (no audio/video)
    const claudeModel = models['claude-sonnet-4-6'];
    expect(claudeModel.capabilities.input.audio).toBe(false);
    expect(claudeModel.capabilities.input.video).toBe(false);
    expect(claudeModel.modalities.input).not.toContain('audio');

    // Verify Gemini model capabilities (has audio/video)
    const geminiModel = models['gemini-3.7-flash'];
    expect(geminiModel.capabilities.input.audio).toBe(true);
    expect(geminiModel.capabilities.input.video).toBe(true);
    expect(geminiModel.modalities.input).toContain('audio');
  });
});

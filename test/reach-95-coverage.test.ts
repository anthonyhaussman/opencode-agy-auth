import { describe, it, expect, vi, beforeEach } from 'vitest';
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

});

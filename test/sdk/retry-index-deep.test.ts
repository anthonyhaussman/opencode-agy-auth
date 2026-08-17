import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as errorsModule from '../../src/sdk/request-helpers/errors';
import * as retryModule from '../../src/sdk/retry/index';
import * as quotaModule from '../../src/sdk/retry/quota';
import * as fetchModule from '../../src/fetch';
import * as helpersModule from '../../src/sdk/retry/helpers';

describe('retry index and error delay deep coverage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseRetryDelayValue edge cases via quota and errors', () => {
    it('parses seconds/nanos object correctly', () => {
      expect(quotaModule.retryInternals.parseRetryDelayValue({ seconds: 2, nanos: 500000000 })).toBe(2500);
      expect(quotaModule.retryInternals.parseRetryDelayValue({ seconds: NaN, nanos: 0 })).toBeNull();
      expect(quotaModule.retryInternals.parseRetryDelayValue({ seconds: 0, nanos: 0 })).toBeNull();
      expect(quotaModule.retryInternals.parseRetryDelayValue({ seconds: 1, nanos: NaN })).toBeNull();
    });

    it('parses string seconds and ms formats', () => {
      expect(quotaModule.retryInternals.parseRetryDelayValue('1500ms')).toBe(1500);
      expect(quotaModule.retryInternals.parseRetryDelayValue('2.5s')).toBe(2500);
      expect(quotaModule.retryInternals.parseRetryDelayValue('  ')).toBeNull();
      expect(quotaModule.retryInternals.parseRetryDelayValue('invalid-string')).toBeNull();
      expect(quotaModule.retryInternals.parseRetryDelayValue('0ms')).toBeNull();
    });

    it('parses retry delay from message', () => {
      expect(quotaModule.retryInternals.parseRetryDelayFromMessage('Please retry in 500ms')).toBe(500);
      expect(quotaModule.retryInternals.parseRetryDelayFromMessage('after 3s')).toBe(3000);
      expect(quotaModule.retryInternals.parseRetryDelayFromMessage('No delay specified')).toBeNull();
    });

    it('parses retry delay directly from error response body', async () => {
      const respWithRetryInfo = new Response(JSON.stringify({
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '4s',
            },
          ],
        },
      }), { status: 429 });
      expect(await quotaModule.parseRetryDelayFromBody(respWithRetryInfo)).toBe(4000);

      const respWithMessage = new Response(JSON.stringify({
        error: {
          message: 'Rate limit hit. Please retry in 2000ms',
        },
      }), { status: 429 });
      expect(await quotaModule.parseRetryDelayFromBody(respWithMessage)).toBe(2000);

      const respEmpty = new Response('not-json', { status: 429 });
      expect(await quotaModule.parseRetryDelayFromBody(respEmpty)).toBeNull();
    });
  });

  describe('fetchWithRetry URL parsing and body handling', () => {
    it('handles URL object and string input with project and model in body', async () => {
      vi.spyOn(helpersModule, 'wait').mockResolvedValue();
      const fetchSpy = vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

      const urlObj = new URL('https://daily-cloudcode-pa.googleapis.com/v1internal:test');
      const res = await retryModule.fetchWithRetry(urlObj, {
        method: 'POST',
        body: JSON.stringify({ project: 'my-proj', model: 'gemini-2.5-pro' }),
      });

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('handles Request object with empty or unparseable body', async () => {
      vi.spyOn(helpersModule, 'wait').mockResolvedValue();
      const fetchSpy = vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const req = new Request('https://daily-cloudcode-pa.googleapis.com/v1internal:test2', {
        method: 'GET',
      });

      const res = await retryModule.fetchWithRetry(req, {
        body: 'invalid-json-body-{{{',
      });

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('waits for retry cooldown on 429 MODEL_CAPACITY_EXHAUSTED and cools down subsequent request', async () => {
      vi.spyOn(helpersModule, 'wait').mockResolvedValue();
      const fetchSpy = vi.spyOn(fetchModule, 'agyFetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({
          error: {
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                domain: 'cloudcode-pa.googleapis.com',
                reason: 'MODEL_CAPACITY_EXHAUSTED',
              },
            ],
          },
        }), { status: 429 }))
        .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));

      // First request (without retryDelayMs in RetryInfo) is terminal for MODEL_CAPACITY_EXHAUSTED and sets cooldown
      const res1 = await retryModule.fetchWithRetry('https://daily-cloudcode-pa.googleapis.com/v1internal:test-cd', {
        method: 'POST',
        body: JSON.stringify({ project: 'cd-proj', model: 'gemini-2.5-pro' }),
      });
      expect(res1.status).toBe(429);

      // Second request waits for cooldown and then executes
      const res2 = await retryModule.fetchWithRetry('https://daily-cloudcode-pa.googleapis.com/v1internal:test-cd', {
        method: 'POST',
        body: JSON.stringify({ project: 'cd-proj', model: 'gemini-2.5-pro' }),
      });
      expect(res2.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('bypasses cooldown wait if signal is aborted', async () => {
      vi.spyOn(helpersModule, 'wait').mockResolvedValue();
      vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const controller = new AbortController();
      controller.abort();

      const res = await retryModule.fetchWithRetry('https://test.aborted/url', {
        method: 'GET',
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
    });

    it('handles shutdownRetryCooldowns gracefully', () => {
      expect(() => retryModule.shutdownRetryCooldowns()).not.toThrow();
    });
  });
});

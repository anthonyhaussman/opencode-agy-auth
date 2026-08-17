import { describe, it, expect, vi } from 'vitest';
import { transformAgyResponse } from '../../src/sdk/request/response';
import { createChatLogger } from '../../src/sdk/chat-logger';

describe('transformAgyResponse deep coverage', () => {
  it('handles non-JSON and non-eventstream response with chatLogger', async () => {
    const chatLogger = createChatLogger();
    const headers = new Headers({ 'content-type': 'text/html' });
    const originalRes = new Response('<html>Error</html>', { status: 502, statusText: 'Bad Gateway', headers });

    const logHeadersSpy = chatLogger ? vi.spyOn(chatLogger, 'logResponseHeaders') : null;
    const logBodySpy = chatLogger ? vi.spyOn(chatLogger, 'logResponseBody') : null;

    const res = await transformAgyResponse(originalRes, false, null, 'gemini-2.5-pro', 'sess-1', chatLogger);
    expect(res.status).toBe(502);

    if (logHeadersSpy) {
      expect(logHeadersSpy).toHaveBeenCalledWith(502, 'Bad Gateway', headers);
    }
    if (logBodySpy) {
      expect(logBodySpy).toHaveBeenCalledWith('[Non-JSON response (body omitted)]');
    }
  });

  it('attaches all prompt, candidates, cached, and total usage headers', async () => {
    const body = {
      response: {
        candidates: [{ content: { parts: [{ text: 'response text' }] } }],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 34,
          cachedContentTokenCount: 56,
          totalTokenCount: 102,
        },
      },
    };

    const originalRes = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const res = await transformAgyResponse(originalRes, false, null, 'gemini-2.5-pro', 'sess-2');
    expect(res.headers.get('x-gemini-prompt-token-count')).toBe('12');
    expect(res.headers.get('x-gemini-candidates-token-count')).toBe('34');
    expect(res.headers.get('x-gemini-cached-content-token-count')).toBe('56');
    expect(res.headers.get('x-gemini-total-token-count')).toBe('102');
  });

  it('handles unwrapping response envelope if present', async () => {
    const body = {
      response: {
        candidates: [{ content: { parts: [{ text: 'inside response wrapper' }] } }],
      },
    };

    const originalRes = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const res = await transformAgyResponse(originalRes, false, null, 'gemini-2.5-pro', 'sess-3');
    const json = await res.json();
    expect(json.candidates).toBeDefined();
    expect(json.response).toBeUndefined();
  });

  it('handles streaming event-stream without response body gracefully', async () => {
    const originalRes = new Response(null, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const res = await transformAgyResponse(originalRes, true, null, 'gemini-2.5-pro', 'sess-4');
    expect(res.status).toBe(200);
  });

  it('catches and recovers from parsing error gracefully returning original response', async () => {
    const faultyRes = {
      headers: {
        get: () => 'application/json',
      },
      text: () => {
        throw new Error('Fatal stream read error');
      },
      status: 500,
      statusText: 'Internal Error',
    } as unknown as Response;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await transformAgyResponse(faultyRes, false, null, 'gemini-2.5-pro', 'sess-5');
    expect(res).toBe(faultyRes);
    expect(warnSpy).toHaveBeenCalled();
  });
});

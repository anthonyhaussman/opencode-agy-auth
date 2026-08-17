import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStreamingTransformer, deduplicateThinkingText, createThoughtBuffer } from '../../src/sdk/request/thinking.js';
import { transformAgyResponse } from '../../src/sdk/request/response.js';
import { onboardManagedProject } from '../../src/sdk/fetch_project.js';
import * as fetchModule from '../../src/fetch.js';
import { initTurnStateTracker } from '../../src/sdk/request/turn-state-tracker.js';

describe('SDK Edge Cases Coverage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('thinking.ts edge cases', () => {
    it('handles non-prefix sentBuffer in deduplicateThinkingText (line 456)', () => {
      const sentBuffer = createThoughtBuffer();
      const hashes = new Set<string>();
      sentBuffer.set(0, 'completely-different-prefix');

      const resp = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: 'new text',
                  thought: true
                }
              ]
            }
          }
        ]
      };

      const result = deduplicateThinkingText(resp as any, sentBuffer, hashes) as any;
      expect(result.candidates[0].content.parts[0].text).toBe('new text');
      expect(sentBuffer.get(0)).toBe('new text');
    });

    it('handles buffer flush remaining content with usageMetadata, thinking, and toolCalls (lines 715-733)', async () => {
      const store = {
        get: vi.fn(),
        set: vi.fn(),
        has: vi.fn(),
        delete: vi.fn()
      };
      const callbacks = {
        onCacheSignature: vi.fn(),
        onTurnStateUpdate: vi.fn(),
        transformThinkingParts: vi.fn(x => x)
      };

      const transformer = createStreamingTransformer(store, callbacks, {
        signatureSessionKey: 'test-session',
        cacheSignatures: true
      });

      // Send event without trailing \n\n so it stays in buffer until flush()
      const rawChunk = 'data: {"usageMetadata":{"totalTokenCount":10},"candidates":[{"content":{"parts":[{"functionCall":{"name":"myTool"}}]}}]}';

      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(rawChunk));
          controller.close();
        }
      });

      const transformedStream = readable.pipeThrough(transformer);
      const reader = transformedStream.getReader();
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }

      expect(output).toContain('myTool');
      expect(callbacks.onTurnStateUpdate).toHaveBeenCalled();
    });
  });

  describe('response.ts streaming transform with chatLogger and turnStateTracker', () => {
    it('executes streaming transformer callbacks on turn state update and cache signature (lines 138-149)', async () => {
      initTurnStateTracker();
      const chatLoggerMock: any = {
        logResponseHeaders: vi.fn(),
        logResponseBody: vi.fn(),
        createLoggingTransformStream: vi.fn(() => new TransformStream())
      };

      const payload = `data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking step","thoughtSignature":"sig-123"},{"functionCall":{"name":"tool1","args":{}}}]}}]}\n\n`;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        }
      });

      const response = new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream' }
      });

      const result = await transformAgyResponse(response, true, null, 'gemini-2.5-flash', 'session-xyz', chatLoggerMock);
      const text = await result.text();
      expect(text).toContain('Thinking step');
      expect(chatLoggerMock.createLoggingTransformStream).toHaveBeenCalled();
    });

    it('transforms non-streaming payload with chatLogger (lines 100-115)', async () => {
      const chatLoggerMock: any = {
        logResponseHeaders: vi.fn(),
        logResponseBody: vi.fn(),
        close: vi.fn()
      };

      const resp = new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: 'Hello' }] } }]
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

      const transformed = await transformAgyResponse(resp, false, null, 'gemini-2.5-flash', 'session-xyz', chatLoggerMock);
      expect(transformed.status).toBe(200);
      expect(chatLoggerMock.logResponseBody).toHaveBeenCalled();
    });
  });

  describe('fetch_project.ts edge cases', () => {
    it('handles onboardManagedProject failure with error details (lines 146-151)', async () => {
      vi.spyOn(fetchModule, 'agyFetch').mockRejectedValue(new Error('Network crash'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await onboardManagedProject('token-123', 'free-tier');
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('returns provided projectId when payload is done without managed cloudaicompanionProject id (line 143)', async () => {
      vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(
        new Response(JSON.stringify({ done: true, response: {} }), { status: 200 })
      );
      const result = await onboardManagedProject('token-123', 'free-tier', 'fallback-proj');
      expect(result).toBe('fallback-proj');
    });
  });
});

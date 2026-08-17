import { describe, it, expect, vi } from 'vitest';
import {
  createSignatureStore,
  createThoughtBuffer,
  analyzeConversationState,
  closeToolLoopForThinking,
  needsThinkingRecovery,
  looksLikeCompactedThinkingTurn,
  hasPossibleCompactedThinking,
  deduplicateThinkingText,
  cacheThinkingSignaturesFromResponse,
  transformSseEvent,
  createStreamingTransformer,
} from '../../src/sdk/request/thinking.js';

describe('thinking module', () => {
  describe('createSignatureStore and createThoughtBuffer', () => {
    it('stores, retrieves, and checks signatures', () => {
      const store = createSignatureStore();
      expect(store.has('sess1')).toBe(false);
      store.set('sess1', { text: 'thought1', signature: 'sig1' });
      expect(store.has('sess1')).toBe(true);
      expect(store.get('sess1')).toEqual({ text: 'thought1', signature: 'sig1' });
      expect(store.get('sess2')).toBeUndefined();

      store.delete('sess1');
      expect(store.has('sess1')).toBe(false);
      expect(store.get('sess1')).toBeUndefined();
    });

    it('records and checks thought buffer indexed by number', () => {
      const buffer = createThoughtBuffer();
      expect(buffer.get(0)).toBeUndefined();
      buffer.set(0, 'thought text 0');
      buffer.set(1, 'thought text 1');
      expect(buffer.get(0)).toBe('thought text 0');
      expect(buffer.get(1)).toBe('thought text 1');

      buffer.clear();
      expect(buffer.get(0)).toBeUndefined();
      expect(buffer.get(1)).toBeUndefined();
    });
  });

  describe('conversation analysis and compaction helpers', () => {
    it('analyzes conversation state for empty and user message', () => {
      expect(analyzeConversationState([])).toEqual({
        inToolLoop: false,
        turnStartIdx: -1,
        turnHasThinking: false,
        lastModelIdx: -1,
        lastModelHasThinking: false,
        lastModelHasToolCalls: false,
      });

      const userMsg = [{ role: 'user', parts: [{ text: 'hello' }] }];
      const state1 = analyzeConversationState(userMsg);
      expect(state1.inToolLoop).toBe(false);
      expect(state1.turnStartIdx).toBe(-1);

      const assistantMsg = [
        ...userMsg,
        {
          role: 'model',
          parts: [
            { text: 'thinking...', thought: true },
            { functionCall: { name: 'bash', args: {} } },
          ],
        },
      ];
      const state2 = analyzeConversationState(assistantMsg);
      expect(state2.turnStartIdx).toBe(1);
      expect(state2.turnHasThinking).toBe(true);
      expect(state2.lastModelHasThinking).toBe(true);
      expect(state2.lastModelHasToolCalls).toBe(true);
      expect(state2.inToolLoop).toBe(false);

      const toolResultMsg = [
        ...assistantMsg,
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'bash', response: { output: 'ok' } } }],
        },
      ];
      const state3 = analyzeConversationState(toolResultMsg);
      expect(state3.inToolLoop).toBe(true);
      expect(state3.turnHasThinking).toBe(true);
    });

    it('supports Claude style messages with content arrays', () => {
      const claudeMsg = [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'tool_use', name: 'calc' },
          ],
        },
      ];
      const state = analyzeConversationState(claudeMsg);
      expect(state.turnStartIdx).toBe(1);
      expect(state.turnHasThinking).toBe(true);
      expect(state.lastModelHasThinking).toBe(true);
      expect(state.lastModelHasToolCalls).toBe(true);
    });

    it('determines needsThinkingRecovery and handles closeToolLoopForThinking', () => {
      const stateInLoopNoThinking = {
        inToolLoop: true,
        turnStartIdx: 0,
        turnHasThinking: false,
        lastModelIdx: 0,
        lastModelHasThinking: false,
        lastModelHasToolCalls: true,
      };
      expect(needsThinkingRecovery(stateInLoopNoThinking)).toBe(true);

      const stateInLoopWithThinking = {
        ...stateInLoopNoThinking,
        turnHasThinking: true,
      };
      expect(needsThinkingRecovery(stateInLoopWithThinking)).toBe(false);

      // Single tool result
      const singleContents = [
        { role: 'model', parts: [{ functionCall: { name: 'bash' } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'bash', response: {} } }] },
      ];
      const closedSingle = closeToolLoopForThinking(singleContents);
      expect(closedSingle.length).toBe(4);
      expect(closedSingle[2].parts[0].text).toBe('[Tool exec completed.]');
      expect(closedSingle[3].parts[0].text).toBe('[Continue]');

      // Multiple tool results
      const multiContents = [
        { role: 'model', parts: [{ functionCall: { name: 'bash' } }] },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'bash', response: {} } },
            { functionResponse: { name: 'read', response: {} } },
          ],
        },
      ];
      const closedMulti = closeToolLoopForThinking(multiContents);
      expect(closedMulti[2].parts[0].text).toBe('[2 tool executions completed.]');

      // Zero tool results
      const emptyContents = [{ role: 'user', parts: [{ text: 'hello' }] }];
      const closedEmpty = closeToolLoopForThinking(emptyContents);
      expect(closedEmpty[1].parts[0].text).toBe('[Processing prev ctx.]');
    });

    it('detects compacted thinking turn and possible compacted thinking', () => {
      expect(looksLikeCompactedThinkingTurn(null)).toBe(false);
      expect(looksLikeCompactedThinkingTurn({ role: 'model', parts: [] })).toBe(false);
      expect(looksLikeCompactedThinkingTurn({ role: 'model', parts: [{ text: 'no tools' }] })).toBe(false);

      const compacted = {
        role: 'model',
        parts: [{ functionCall: { name: 'bash', args: {} } }],
      };
      expect(looksLikeCompactedThinkingTurn(compacted)).toBe(true);

      const hasThinking = {
        role: 'model',
        parts: [
          { text: 'thinking...', thought: true },
          { functionCall: { name: 'bash', args: {} } },
        ],
      };
      expect(looksLikeCompactedThinkingTurn(hasThinking)).toBe(false);

      const hasTextBefore = {
        role: 'model',
        parts: [
          { text: 'I will now run this tool:' },
          { functionCall: { name: 'bash', args: {} } },
        ],
      };
      expect(looksLikeCompactedThinkingTurn(hasTextBefore)).toBe(false);

      expect(hasPossibleCompactedThinking([compacted], 0)).toBe(true);
      expect(hasPossibleCompactedThinking([hasThinking], 0)).toBe(false);
      expect(hasPossibleCompactedThinking([], 0)).toBe(false);
      expect(hasPossibleCompactedThinking([compacted], -1)).toBe(false);
    });
  });

  describe('deduplicateThinkingText and cacheThinkingSignaturesFromResponse', () => {
    it('deduplicates Gemini thinking parts incrementally', () => {
      const buffer = createThoughtBuffer();
      const displayedHashes = new Set<string>();

      const chunk1 = {
        candidates: [
          {
            content: {
              parts: [{ text: 'I am ', thought: true }],
            },
          },
        ],
      };
      const dedup1 = deduplicateThinkingText(chunk1, buffer, displayedHashes) as any;
      expect(dedup1.candidates[0].content.parts[0].text).toBe('I am ');

      const chunk2 = {
        candidates: [
          {
            content: {
              parts: [{ text: 'I am thinking deeply', thought: true }],
            },
          },
        ],
      };
      const dedup2 = deduplicateThinkingText(chunk2, buffer, displayedHashes) as any;
      expect(dedup2.candidates[0].content.parts[0].text).toBe('thinking deeply');

      // Duplicate whole text when already rendered hash
      const bufferNew = createThoughtBuffer();
      const duplicateChunk = {
        candidates: [
          {
            content: {
              parts: [{ text: 'I am thinking deeply', thought: true }],
            },
          },
        ],
      };
      const dedup3 = deduplicateThinkingText(duplicateChunk, bufferNew, displayedHashes) as any;
      expect(dedup3.candidates[0].content.parts.length).toBe(0);
    });

    it('deduplicates Claude thinking blocks', () => {
      const buffer = createThoughtBuffer();
      const chunk1 = {
        content: [
          { type: 'thinking', thinking: 'Claude thought ' },
        ],
      };
      const res1 = deduplicateThinkingText(chunk1, buffer) as any;
      expect(res1.content[0].thinking).toBe('Claude thought ');

      const chunk2 = {
        content: [
          { type: 'thinking', thinking: 'Claude thought step 2' },
        ],
      };
      const res2 = deduplicateThinkingText(chunk2, buffer) as any;
      expect(res2.content[0].thinking).toBe('step 2');
    });

    it('caches signatures for Gemini and Claude responses', () => {
      const store = createSignatureStore();
      const buffer = createThoughtBuffer();
      const onCache = vi.fn();

      const geminiResp = {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Gemini thought', thought: true, thoughtSignature: 'gem-sig' },
              ],
            },
          },
        ],
      };

      cacheThinkingSignaturesFromResponse(geminiResp, 'session-gemini', store, buffer, onCache);
      expect(store.get('session-gemini')).toEqual({
        text: 'Gemini thought',
        signature: 'gem-sig',
      });
      expect(onCache).toHaveBeenCalledWith('session-gemini', 'Gemini thought', 'gem-sig');

      const claudeResp = {
        content: [
          { type: 'thinking', thinking: 'Claude full thought', signature: 'claude-sig' },
        ],
      };
      const claudeBuffer = createThoughtBuffer();
      cacheThinkingSignaturesFromResponse(claudeResp, 'session-claude', store, claudeBuffer, onCache);
      expect(store.get('session-claude')).toEqual({
        text: 'Claude full thought',
        signature: 'claude-sig',
      });
    });
  });

  describe('transformSseEvent and createStreamingTransformer', () => {
    it('transforms SSE event and injects debug text', () => {
      const store = createSignatureStore();
      const thoughtBuffer = createThoughtBuffer();
      const sentBuffer = createThoughtBuffer();
      const callbacks = {
        onInjectDebug: (resp: any, debug: string) => {
          resp.debug = debug;
          return resp;
        },
        transformThinkingParts: (resp: any) => resp,
      };
      const debugState = { injected: false };

      const eventPayload = JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: 'hello' }],
              },
            },
          ],
        },
      });

      const sseEvent = `data: ${eventPayload}\n\n`;
      const transformed = transformSseEvent(
        sseEvent,
        store,
        thoughtBuffer,
        sentBuffer,
        callbacks,
        { debugText: 'DEBUG-INFO' },
        debugState
      );

      expect(debugState.injected).toBe(true);
      expect(transformed).toContain('DEBUG-INFO');
    });

    it('returns raw text if not data event', () => {
      const store = createSignatureStore();
      const thoughtBuffer = createThoughtBuffer();
      const sentBuffer = createThoughtBuffer();
      const res = transformSseEvent(
        ': ping\n\n',
        store,
        thoughtBuffer,
        sentBuffer,
        {},
        {},
        { injected: false }
      );
      expect(res).toBe(': ping\n\n');
    });

    it('streams through createStreamingTransformer and appends synthetic usage if missing', async () => {
      const store = createSignatureStore();
      const onTurnUpdate = vi.fn();
      const transformer = createStreamingTransformer(
        store,
        { onTurnStateUpdate: onTurnUpdate },
        { signatureSessionKey: 'sess-123' }
      );

      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();

      const chunk = new TextEncoder().encode(
        `data: ${JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: 'hi', thought: true }] } }],
          },
        })}\n\n`
      );

      // Start reading concurrently with writing
      const readPromise = (async () => {
        let fullText = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          fullText += new TextDecoder().decode(value);
        }
        return fullText;
      })();

      await writer.write(chunk);
      await writer.close();

      const fullText = await readPromise;

      expect(fullText).toContain('"totalTokenCount":0');
      expect(onTurnUpdate).toHaveBeenCalledWith('sess-123', {
        turnHasThinking: true,
        lastModelHasToolCalls: false,
      });
    });
  });
});

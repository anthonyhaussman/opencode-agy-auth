import { createHash } from "node:crypto";

/**
 * NOTE: Special Design - Streaming deduplication and signature state self-healing
 * Agy/Gemini official API has the following non-standard behaviors and strict constraints that must be specially handled here:
 * 1. [Streaming Deduplication]: In the data packets returned by the official API during streaming, thought chain (Thinking) content is output cumulatively.
 *    We must perform hash comparison and truncation on each returned delta to prevent the IDE from receiving duplicate text.
 * 2. [Signature State Self-healing]: In multi-turn dialogues, if the thoughtSignature is lost due to tool calls or client state breakage,
 *    the official API throws a signature mismatch error. An auto-detection mechanism (e.g., needsThinkingRecovery) is designed here to, upon signature breakage,
 *    automatically backfill/align fallback thought chain fragments and signatures in context messages, allowing the dialogue chain to self-heal and continue.
 */

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Cached signed thought chain data structure
 */
export interface SignedThinking {
  /** Full thought chain text content */
  text: string;
  /** Corresponding server signature */
  signature: string;
}

/**
 * External contract interface for signature storage manager
 */
export interface SignatureStore {
  get(sessionKey: string): SignedThinking | undefined;
  set(sessionKey: string, value: SignedThinking): void;
  has(sessionKey: string): boolean;
  delete(sessionKey: string): void;
}

/**
 * Custom callback functions for the streaming phase
 */
export interface StreamingCallbacks {
  /** Triggered when the latest thought chain and signature are cached */
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void;
  /** Triggered when debugging instructions (e.g., quota overrun warnings) need injection into the stream */
  onInjectDebug?: (response: unknown, debugText: string) => unknown;
  /** Method to transform custom thought chain parts */
  transformThinkingParts?: (parts: unknown) => unknown;
}

/**
 * Configuration parameters for the streaming phase
 */
export interface StreamingOptions {
  /** Unique identifier for the signature session, used for cross-turn signature recovery */
  signatureSessionKey?: string;
  /** Debugging text to inject into the stream (optional) */
  debugText?: string;
  /** Whether to cache the latest generated signature in this stream */
  cacheSignatures?: boolean;
  /** Set of already rendered thought chain hashes, used to avoid duplicate output in tool call loops */
  displayedThinkingHashes?: Set<string>;
}

/**
 * Text buffer for caching thought chains of a specific index or type (handles streaming chunk cumulative output)
 */
export interface ThoughtBuffer {
  get(index: number): string | undefined;
  set(index: number, text: string): void;
  clear(): void;
}

/**
 * Agent and tool interaction state record during multi-turn dialogue runtime
 */
export interface ConversationState {
  /** Whether inside an incomplete tool call loop (i.e., last turn ended with functionResponse, continuing this turn) */
  inToolLoop: boolean;
  /** Array index of the first model reply message in the current dialogue turn */
  turnStartIdx: number;
  /** Whether the start of the current dialogue turn contains a thought chain (thought) */
  turnHasThinking: boolean;
  /** Array index of the last model reply message */
  lastModelIdx: number;
  /** Whether the last model message contains a thought chain */
  lastModelHasThinking: boolean;
  /** Whether the last model message contains a tool call (tool_use) */
  lastModelHasToolCalls: boolean;
}

// ============================================================================
// Stores & Buffers Factories
// ============================================================================

/**
 * Creates a memory Map-based signature storage manager
 */
export function createSignatureStore(): SignatureStore {
  const store = new Map<string, SignedThinking>();

  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: SignedThinking) => {
      store.set(key, value);
    },
    has: (key: string) => store.has(key),
    delete: (key: string) => {
      store.delete(key);
    },
  };
}

/**
 * Creates a thought chain text accumulation buffer for temporarily storing streaming chunks
 */
export function createThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();

  return {
    get: (index: number) => buffer.get(index),
    set: (index: number, text: string) => {
      buffer.set(index, text);
    },
    clear: () => buffer.clear(),
  };
}

/**
 * Default global memory signature storage
 */
export const defaultSignatureStore = createSignatureStore();

// ============================================================================
// Hashing Helper
// ============================================================================

/**
 * Generates a fast string hash (DJB2 algorithm) to deduplicate already output thought chain blocks
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// ============================================================================
// Thinking State Detection & Historical Self-healing Helpers
// ============================================================================

/**
 * Checks if a message part belongs to the thought chain type
 * Compatible with Gemini (thought field) and Claude (type: "thinking", etc.)
 */
function isThinkingPart(part: any): boolean {
  if (!part || typeof part !== "object") return false;
  return (
    part.thought === true ||
    part.type === "thinking" ||
    part.type === "redacted_thinking"
  );
}

/**
 * Checks if a message part is a tool execution result response
 */
function isFunctionResponsePart(part: any): boolean {
  return part && typeof part === "object" && "functionResponse" in part;
}

/**
 * Checks if a message part is a model-initiated tool call request
 */
function isFunctionCallPart(part: any): boolean {
  return part && typeof part === "object" && "functionCall" in part;
}

/**
 * Checks if a message is exclusively a tool execution return body (role = user but entirely functionResponse)
 */
function isToolResultMessage(msg: any): boolean {
  if (!msg || msg.role !== "user") return false;
  const parts = msg.parts || [];
  return parts.some(isFunctionResponsePart);
}

/**
 * Checks if a message contains any thought chain segment (including Gemini array format or Claude content format)
 */
function messageHasThinking(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;

  if (Array.isArray(msg.parts)) {
    return msg.parts.some(isThinkingPart);
  }

  if (Array.isArray(msg.content)) {
    return msg.content.some(
      (block: any) =>
        block?.type === "thinking" || block?.type === "redacted_thinking",
    );
  }

  return false;
}

/**
 * Checks if a message contains a tool call (supports Gemini and Claude tool_use)
 */
function messageHasToolCalls(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;

  if (Array.isArray(msg.parts)) {
    return msg.parts.some(isFunctionCallPart);
  }

  if (Array.isArray(msg.content)) {
    return msg.content.some((block: any) => block?.type === "tool_use");
  }

  return false;
}

/**
 * Analyzes multi-turn historical dialogue arrays to extract context metrics like agent interaction loop state, model message positions, whether the turn has thoughts, etc.
 */
export function analyzeConversationState(contents: any[]): ConversationState {
  const state: ConversationState = {
    inToolLoop: false,
    turnStartIdx: -1,
    turnHasThinking: false,
    lastModelIdx: -1,
    lastModelHasThinking: false,
    lastModelHasToolCalls: false,
  };

  if (!Array.isArray(contents) || contents.length === 0) {
    return state;
  }

  // Find the position of the last real human user question
  let lastRealUserIdx = -1;
  for (let i = 0; i < contents.length; i++) {
    const msg = contents[i];
    if (msg?.role === "user" && !isToolResultMessage(msg)) {
      lastRealUserIdx = i;
    }
  }

  // Scan all model messages to extract features of the most recent reply round
  for (let i = 0; i < contents.length; i++) {
    const msg = contents[i];
    const role = msg?.role;

    if (role === "model" || role === "assistant") {
      const hasThinking = messageHasThinking(msg);
      const hasToolCalls = messageHasToolCalls(msg);

      // If this is the first model message after the most recent user question, treat as the start of the current turn
      if (i > lastRealUserIdx && state.turnStartIdx === -1) {
        state.turnStartIdx = i;
        state.turnHasThinking = hasThinking;
      }

      state.lastModelIdx = i;
      state.lastModelHasToolCalls = hasToolCalls;
      state.lastModelHasThinking = hasThinking;
    }
  }

  // Determine if in the tail of an incomplete tool loop (i.e., user just returned tool call results, waiting for model's next step)
  if (contents.length > 0) {
    const lastMsg = contents[contents.length - 1];
    if (lastMsg?.role === "user" && isToolResultMessage(lastMsg)) {
      state.inToolLoop = true;
    }
  }

  return state;
}

/**
 * Calculate the number of uncompleted tool responses at the tail
 */
function countTrailingToolResults(contents: any[]): number {
  let count = 0;

  for (let i = contents.length - 1; i >= 0; i--) {
    const msg = contents[i];

    if (msg?.role === "user") {
      const parts = msg.parts || [];
      const functionResponses = parts.filter(isFunctionResponsePart);

      if (functionResponses.length > 0) {
        count += functionResponses.length;
      } else {
        break;
      }
    } else if (msg?.role === "model" || msg?.role === "assistant") {
      break;
    }
  }

  return count;
}

/**
 * Closes the tool execution loop and injects transition content to smoothly recover the dialogue without providing the old thought chain
 */
export function closeToolLoopForThinking(contents: any[]): any[] {
  const strippedContents = contents;
  const toolResultCount = countTrailingToolResults(strippedContents);
  let syntheticModelContent: string;

  if (toolResultCount === 0) {
    syntheticModelContent = "[Processing prev ctx.]";
  } else if (toolResultCount === 1) {
    syntheticModelContent = "[Tool exec completed.]";
  } else {
    syntheticModelContent = `[${toolResultCount} tool executions completed.]`;
  }

  const syntheticModel = {
    role: "model",
    parts: [{ text: syntheticModelContent }],
  };

  const syntheticUser = {
    role: "user",
    parts: [{ text: "[Continue]" }],
  };

  return [...strippedContents, syntheticModel, syntheticUser];
}

/**
 * Checks if the current state meets conditions to trigger historical self-healing
 */
export function needsThinkingRecovery(state: ConversationState): boolean {
  return state.inToolLoop && !state.turnHasThinking;
}

/**
 * Determines if the current model reply message had its thought chain pruned (has only tool calls but lost its preceding thought chain description)
 */
export function looksLikeCompactedThinkingTurn(msg: any): boolean {
  if (!msg || typeof msg !== "object") return false;

  const parts = msg.parts || [];
  if (parts.length === 0) return false;

  const hasFunctionCall = parts.some(
    (p: any) => p && typeof p === "object" && p.functionCall,
  );

  if (!hasFunctionCall) return false;

  const hasThinking = parts.some(
    (p: any) =>
      p &&
      typeof p === "object" &&
      (p.thought === true || p.type === "thinking" || p.type === "redacted_thinking"),
  );

  if (hasThinking) return false;

  const hasTextBeforeFunctionCall = parts.some((p: any, idx: number) => {
    if (!p || typeof p !== "object") return false;
    const firstFuncIdx = parts.findIndex(
      (fp: any) => fp && typeof fp === "object" && fp.functionCall,
    );
    if (idx >= firstFuncIdx) return false;
    return (
      "text" in p &&
      typeof p.text === "string" &&
      p.text.trim().length > 0 &&
      !p.thought
    );
  });

  return !hasTextBeforeFunctionCall;
}

/**
 * Deeply determines if the start of this Turn contains historical rounds whose thought chains might have been pruned/compressed by the system
 */
export function hasPossibleCompactedThinking(
  contents: any[],
  turnStartIdx: number,
): boolean {
  if (!Array.isArray(contents) || turnStartIdx < 0) return false;

  for (let i = turnStartIdx; i < contents.length; i++) {
    const msg = contents[i];
    if (msg?.role === "model" && looksLikeCompactedThinkingTurn(msg)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// SSE Deduplication Filter Processors (Streaming Transformers & Deduplicators)
// ============================================================================

/**
 * For streaming SSE data packets, calculates and locally strips duplicated thought chain text
 * Simultaneously supports Gemini's exclusive candidates.content structure and Claude's exclusive content[type=thinking] structure
 */
export function deduplicateThinkingText(
  response: unknown,
  sentBuffer: ThoughtBuffer,
  displayedThinkingHashes?: Set<string>,
): unknown {
  if (!response || typeof response !== "object") return response;

  const resp = response as Record<string, unknown>;

  // Branch 1: Handle Gemini structure type (candidates)
  if (Array.isArray(resp.candidates)) {
    const newCandidates = resp.candidates.map((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return candidate;

      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return candidate;

      const newParts = content.parts.map((part: unknown) => {
        const p = part as Record<string, unknown>;

        if (p.thought === true || p.type === "thinking") {
          const fullText = (p.text || p.thinking || "") as string;

          // If this thought chain was already rendered, block it directly from the stream to prevent long overlapping rendering in tool call branches
          if (displayedThinkingHashes) {
            const hash = hashString(fullText);
            if (displayedThinkingHashes.has(hash)) {
              sentBuffer.set(index, fullText);
              return null;
            }
            displayedThinkingHashes.add(hash);
          }

          // Calculate incremental output (Delta)
          const sentText = sentBuffer.get(index) ?? "";

          if (fullText.startsWith(sentText)) {
            const delta = fullText.slice(sentText.length);
            sentBuffer.set(index, fullText);

            if (delta) {
              return { ...p, text: delta, thinking: delta };
            }
            return null;
          }

          sentBuffer.set(index, fullText);
          return part;
        }
        return part;
      });

      const filteredParts = newParts.filter((p) => p !== null);

      return {
        ...cand,
        content: { ...content, parts: filteredParts },
      };
    });

    return { ...resp, candidates: newCandidates };
  }

  // Branch 2: Handle Claude structure type (content blocks) because Agy backend forwarding includes Claude
  if (Array.isArray(resp.content)) {
    let thinkingIndex = 0;
    const newContent = resp.content.map((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === "thinking") {
        const fullText = (b.thinking || b.text || "") as string;

        if (displayedThinkingHashes) {
          const hash = hashString(fullText);
          if (displayedThinkingHashes.has(hash)) {
            sentBuffer.set(thinkingIndex, fullText);
            thinkingIndex++;
            return null;
          }
          displayedThinkingHashes.add(hash);
        }

        const sentText = sentBuffer.get(thinkingIndex) ?? "";

        if (fullText.startsWith(sentText)) {
          const delta = fullText.slice(sentText.length);
          sentBuffer.set(thinkingIndex, fullText);
          thinkingIndex++;

          if (delta) {
            return { ...b, thinking: delta, text: delta };
          }
          return null;
        }

        sentBuffer.set(thinkingIndex, fullText);
        thinkingIndex++;
        return block;
      }
      return block;
    });

    const filteredContent = newContent.filter((b) => b !== null);
    if (filteredContent.length === 0) {
      return { ...resp, content: [] };
    }
    return { ...resp, content: filteredContent };
  }

  return response;
}

/**
 * Caches thought chain content and its validation signature from the returned message body for signature alignment in the next interaction round
 * Also supports Gemini signature mechanism (candidates[].thoughtSignature) and Claude signature mechanism (content[].signature)
 */
export function cacheThinkingSignaturesFromResponse(
  response: unknown,
  signatureSessionKey: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void,
): void {
  if (!response || typeof response !== "object") return;

  const resp = response as Record<string, unknown>;

  // Branch 1: Collect and cache Gemini type signatures
  if (Array.isArray(resp.candidates)) {
    resp.candidates.forEach((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return;
      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return;

      content.parts.forEach((part: unknown) => {
        const p = part as Record<string, unknown>;
        if (p.thought === true || p.type === "thinking") {
          const text = (p.text || p.thinking || "") as string;
          if (text) {
            const current = thoughtBuffer.get(index) ?? "";
            thoughtBuffer.set(index, current + text);
          }
        }

        if (p.thoughtSignature) {
          const fullText = thoughtBuffer.get(index) ?? "";
          if (fullText) {
            const signature = p.thoughtSignature as string;
            onCacheSignature?.(signatureSessionKey, fullText, signature);
            signatureStore.set(signatureSessionKey, { text: fullText, signature });
          }
        }
      });
    });
  }

  // Branch 2: Collect and cache Claude type signatures
  if (Array.isArray(resp.content)) {
    const CLAUDE_BUFFER_KEY = 0;
    resp.content.forEach((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === "thinking") {
        const text = (b.thinking || b.text || "") as string;
        if (text) {
          const current = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? "";
          thoughtBuffer.set(CLAUDE_BUFFER_KEY, current + text);
        }
      }
      if (b?.signature) {
        const fullText = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? "";
        if (fullText) {
          const signature = b.signature as string;
          onCacheSignature?.(signatureSessionKey, fullText, signature);
          signatureStore.set(signatureSessionKey, { text: fullText, signature });
        }
      }
    });
  }
}

/**
 * Transforms a single complete SSE event, triggering thought chain caching and incremental deduplication here
 */
export function transformSseEvent(
  eventText: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  sentThinkingBuffer: ThoughtBuffer,
  callbacks: StreamingCallbacks,
  options: StreamingOptions,
  debugState: { injected: boolean },
): string {
  // Extract all data from data: lines
  const dataLines: string[] = [];
  const lines = eventText.split(/\r?\n/);
  let isDataEvent = false;

  for (const line of lines) {
    if (line.startsWith("data:")) {
      isDataEvent = true;
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!isDataEvent) {
    return eventText;
  }

  const jsonString = dataLines.join("\n").trim();
  if (!jsonString) {
    return eventText;
  }

  try {
    const parsed = JSON.parse(jsonString) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object" && parsed.response !== undefined) {
      // Extract and write to cache
      if (options.cacheSignatures && options.signatureSessionKey) {
        cacheThinkingSignaturesFromResponse(
          parsed.response,
          options.signatureSessionKey,
          signatureStore,
          thoughtBuffer,
          callbacks.onCacheSignature,
        );
      }

      // Calculate deduplication
      let response: unknown = deduplicateThinkingText(
        parsed.response,
        sentThinkingBuffer,
        options.displayedThinkingHashes
      );

      // Debug text injection
      if (options.debugText && callbacks.onInjectDebug && !debugState.injected) {
        response = callbacks.onInjectDebug(response, options.debugText);
        debugState.injected = true;
      }

      const transformed = callbacks.transformThinkingParts
        ? callbacks.transformThinkingParts(response)
        : response;
      return `data: ${JSON.stringify(transformed)}`;
    }
  } catch (_) {}
  return eventText;
}

/**
 * Creates a TransformStream processor to split, deduplicate, and recombine the output stream
 */
export function createStreamingTransformer(
  signatureStore: SignatureStore,
  callbacks: StreamingCallbacks,
  options: StreamingOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const thoughtBuffer = createThoughtBuffer();
  const sentThinkingBuffer = createThoughtBuffer();
  const debugState = { injected: false };
  let hasSeenUsageMetadata = false;

  const displayedThinkingHashes = options.displayedThinkingHashes ?? new Set<string>();
  const mergedOptions = { ...options, displayedThinkingHashes };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";

      for (const event of events) {
        if (!event.trim()) continue; // Skip empty events if any
        if (event.includes("usageMetadata")) {
          hasSeenUsageMetadata = true;
        }

        const transformedEvent = transformSseEvent(
          event,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          mergedOptions,
          debugState,
        );
        controller.enqueue(encoder.encode(transformedEvent + "\n\n"));
      }
    },
    flush(controller) {
      buffer += decoder.decode();

      if (buffer.trim()) {
        if (buffer.includes("usageMetadata")) {
          hasSeenUsageMetadata = true;
        }
        const transformedEvent = transformSseEvent(
          buffer,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          mergedOptions,
          debugState,
        );
        controller.enqueue(encoder.encode(transformedEvent + "\n\n"));
      }

      // Fallback strategy: If no token usage metadata was generated at the end, forcibly inject a 0-count fallback to ensure VS Code statistics compatibility
      if (!hasSeenUsageMetadata) {
        const syntheticUsage = {
          candidates: [
            {
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0,
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(syntheticUsage)}\n\n`));
      }
    },
  });
}

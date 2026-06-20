/**
 * NOTE: Format/protocol conversion logic is typically in the app layer (Plugin), but is implemented here inside the SDK as a special case.
 * Reason:
 * Format conversion (OpenAI format to Gemini/Agy native and vice versa) is tightly coupled with Agy's unique streaming SSE data parsing,
 * thought chain deduplication, and signature self-healing (Thinking Recovery / Signature Cache) in multi-turn dialogues.
 * Encapsulating this conversion in the SDK completely shields the OpenCode plugin app layer from non-standard API interaction complexities,
 * allowing the plugin to simply call and forward standard OpenAI formatted requests and response streams.
 */

interface GeminiFunctionCallPart {
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
    [key: string]: unknown;
  };
  thoughtSignature?: string;
  [key: string]: unknown;
}

interface OpenAIToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenAIMessage {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  [key: string]: unknown;
}

/**
 * Converts OpenAI's `tool_calls` into Gemini's `functionCall` sections.
 */
export function transformOpenAIToolCalls(requestPayload: Record<string, unknown>): void {
  const messages = requestPayload.messages;
  if (!messages || !Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const msgObj = message as OpenAIMessage;
    const toolCalls = msgObj.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      continue;
    }

    const parts: GeminiFunctionCallPart[] = [];
    if (typeof msgObj.content === "string" && msgObj.content.length > 0) {
      parts.push({ text: msgObj.content });
    }

    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }

      const fn = toolCall.function;
      if (!fn || typeof fn !== "object") {
        continue;
      }

      const name = fn.name;
      const args = parseJsonObject(fn.arguments);

      const functionCallPart: NonNullable<GeminiFunctionCallPart['functionCall']> = {
        name: name ?? "",
        args,
      };

      if (typeof toolCall.id === 'string' && toolCall.id.length > 0) {
        functionCallPart.id = toolCall.id;
      }

      parts.push({
        functionCall: functionCallPart,
        thoughtSignature: "skip_thought_signature_validator",
      });
    }

    msgObj.parts = parts;
    delete msgObj.tool_calls;
    delete msgObj.content;
  }
}

/**
 * Adds synthesized thoughtSignature to function calls in the flattened and wrapped payload.
 */
export function addThoughtSignaturesToFunctionCalls(requestPayload: Record<string, unknown>): void {
  const processContents = (contents: unknown): void => {
    if (!contents || !Array.isArray(contents)) {
      return;
    }

    for (const content of contents) {
      if (!content || typeof content !== "object") {
        continue;
      }

      const parts = (content as Record<string, unknown>).parts;
      if (!parts || !Array.isArray(parts)) {
        continue;
      }

      for (const part of parts) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const partObj = part as Record<string, unknown>;
        if (partObj.functionCall && !partObj.thoughtSignature) {
          partObj.thoughtSignature = "skip_thought_signature_validator";
        }
      }
    }
  };

  processContents(requestPayload.contents);
  if (requestPayload.request && typeof requestPayload.request === "object") {
    processContents((requestPayload.request as Record<string, unknown>).contents);
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

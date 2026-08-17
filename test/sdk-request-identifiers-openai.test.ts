import { describe, expect, it } from "vitest";
import {
  normalizeRequestPayloadIdentifiers,
  normalizeWrappedIdentifiers,
} from "../src/sdk/request/identifiers";
import {
  isRecord,
  pickString,
  readString,
  toRequestUrlString,
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  injectResponseIdFromTrace,
} from "../src/sdk/request/shared";
import {
  transformOpenAIToolCalls,
  addThoughtSignaturesToFunctionCalls,
} from "../src/sdk/request/openai";

describe("src/sdk/request/shared", () => {
  it("validates record types and string helpers", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(true); // typeof [] is object
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);

    expect(readString("")).toBeUndefined();
    expect(readString("   ")).toBeUndefined();
    expect(readString("hello")).toBe("hello");

    expect(pickString(undefined, null, "", "   ", "hello", "world")).toBe("hello");
    expect(pickString(undefined, null)).toBeUndefined();
  });

  it("handles request URL formatting and Generative Language request parsing", () => {
    expect(toRequestUrlString("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent")).toContain("generativelanguage");
    expect(toRequestUrlString(new URL("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent"))).toContain("generativelanguage");
    expect(toRequestUrlString(new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent"))).toContain("generativelanguage");

    expect(isGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent")).toBe(true);
    expect(isGenerativeLanguageRequest("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")).toBe(false);

    const parsed = parseGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-high:streamGenerateContent");
    expect(parsed?.requestedModel).toBe("gemini-3.1-pro-high");
    expect(parsed?.effectiveModel).toBe("gemini-pro-agent");
    expect(parsed?.action).toBe("streamGenerateContent");

    expect(parseGenerativeLanguageRequest("https://example.com/other")).toBeUndefined();
  });

  it("injects responseId from traceId if missing", () => {
    const withTrace = {
      traceId: "trace-123",
      response: {
        candidates: [],
      },
    };
    const res = injectResponseIdFromTrace(withTrace);
    expect(res.response.responseId).toBe("trace-123");

    const withoutTrace = {
      response: {
        candidates: [],
      },
    };
    expect(injectResponseIdFromTrace(withoutTrace)).toEqual(withoutTrace);

    const existing = {
      traceId: "trace-123",
      response: {
        responseId: "existing-id",
      },
    };
    expect(injectResponseIdFromTrace(existing).response.responseId).toBe("existing-id");
  });
});

describe("src/sdk/request/identifiers", () => {
  it("normalizes request payload identifiers and strips aliases", () => {
    const payload: Record<string, unknown> = {
      user_prompt_id: "test-prompt-1",
      sessionId: "test-session-1",
    };

    const res = normalizeRequestPayloadIdentifiers(payload);
    expect(res.userPromptId).toBe("test-prompt-1");
    expect(res.sessionId).toBe("test-session-1");
    expect(res.requestId).toContain("agent/test-session-1/");
    expect(payload.session_id).toBe("test-session-1");
    expect(payload.sessionId).toBeUndefined();
    expect(payload.user_prompt_id).toBeUndefined();
  });

  it("handles agent/ prefixed requestId in wrapped identifiers", () => {
    const wrapped: Record<string, unknown> = {
      user_prompt_id: "agent/prefixed/id/123",
      request: {
        sessionId: "session-xyz",
      },
    };

    const res = normalizeWrappedIdentifiers(wrapped);
    expect(res.userPromptId).toBe("agent/prefixed/id/123");
    expect(res.requestId).toBe("agent/prefixed/id/123");
    expect(wrapped.requestId).toBe("agent/prefixed/id/123");
  });
});

describe("src/sdk/request/openai", () => {
  it("transforms openai tool_calls to gemini functionCall parts", () => {
    const payload: Record<string, unknown> = {
      messages: [
        {
          role: "assistant",
          content: "calling tool",
          tool_calls: [
            {
              id: "call_123",
              function: {
                name: "agy_quota",
                arguments: JSON.stringify({ dummy: true }),
              },
            },
          ],
        },
      ],
    };

    transformOpenAIToolCalls(payload);
    const msgs = payload.messages as any[];
    expect(msgs[0].content).toBeUndefined();
    expect(msgs[0].tool_calls).toBeUndefined();
    expect(msgs[0].parts).toHaveLength(2);
    expect(msgs[0].parts[0].text).toBe("calling tool");
    expect(msgs[0].parts[1].functionCall.name).toBe("agy_quota");
    expect(msgs[0].parts[1].functionCall.id).toBe("call_123");
    expect(msgs[0].parts[1].thoughtSignature).toBe("skip_thought_signature_validator");
  });

  it("adds thoughtSignature to function calls in wrapped request structures", () => {
    const payload: Record<string, unknown> = {
      contents: [
        {
          parts: [{ functionCall: { name: "testFn" } }],
        },
      ],
      request: {
        contents: [
          {
            parts: [{ functionCall: { name: "testFn2" } }],
          },
        ],
      },
    };

    addThoughtSignaturesToFunctionCalls(payload);
    expect((payload.contents as any[])[0].parts[0].thoughtSignature).toBe("skip_thought_signature_validator");
    expect(((payload.request as any).contents as any[])[0].parts[0].thoughtSignature).toBe(
      "skip_thought_signature_validator",
    );
  });
});

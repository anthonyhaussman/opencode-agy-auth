import { describe, expect, it } from "vitest";
import { getModelEnum, prepareAgyRequest, sanitizeClaudeThinkingParts } from "../../../src/sdk/request/prepare";
import { cacheSignature } from "../../../src/plugin/cache";

describe("prepareAgyRequest Claude model detection and label setting", () => {
  const token = "mock-token";
  const project = "mock-project";

  it("sets used_claude to 'true' for Claude models and 'false' for non-Claude models in unwrapped requests", () => {
    const claudeUrl = "https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-5-5:generateContent";
    const claudeResult = prepareAgyRequest(
      claudeUrl,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      token,
      project,
    );
    const claudePayload = JSON.parse(claudeResult.init.body as string);
    expect(claudePayload.request.labels.used_claude).toBe("true");

    const claudeOpusUrl = "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-5-5:generateContent";
    const claudeOpusResult = prepareAgyRequest(
      claudeOpusUrl,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      token,
      project,
    );
    const claudeOpusPayload = JSON.parse(claudeOpusResult.init.body as string);
    expect(claudeOpusPayload.request.labels.used_claude).toBe("true");

    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent";
    const geminiResult = prepareAgyRequest(
      geminiUrl,
      { method: "POST", body: JSON.stringify({ contents: [] }) },
      token,
      project,
    );
    const geminiPayload = JSON.parse(geminiResult.init.body as string);
    expect(geminiPayload.request.labels.used_claude).toBe("false");
  });

  it("sets used_claude to 'true' for Claude models and 'false' for non-Claude models in wrapped requests", () => {
    const claudeUrl = "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent";
    const claudeWrappedBody = JSON.stringify({
      project: "my-proj",
      request: { contents: [] },
    });
    const claudeResult = prepareAgyRequest(
      claudeUrl,
      { method: "POST", body: claudeWrappedBody },
      token,
      project,
    );
    const claudePayload = JSON.parse(claudeResult.init.body as string);
    expect(claudePayload.request.labels.used_claude).toBe("true");

    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent";
    const geminiWrappedBody = JSON.stringify({
      project: "my-proj",
      request: { contents: [] },
    });
    const geminiResult = prepareAgyRequest(
      geminiUrl,
      { method: "POST", body: geminiWrappedBody },
      token,
      project,
    );
    const geminiPayload = JSON.parse(geminiResult.init.body as string);
    expect(geminiPayload.request.labels.used_claude).toBe("false");
  });

  it("sanitizes thinking blocks without valid signatures for Claude models in multi-turn history", () => {
    const claudeUrl = "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent";
    const contents = [
      { role: "user", parts: [{ text: "Hello" }] },
      {
        role: "model",
        parts: [
          { thought: true, text: "Thinking without signature..." },
          { thought: true, text: "Thinking with skip validator", thoughtSignature: "skip_thought_signature_validator" },
          { type: "thinking", thinking: "Thinking with empty sig", signature: "" },
          { thought: true, text: "Thinking with valid sig", thoughtSignature: "valid-sig-123" },
          { functionCall: { id: "test_call", name: "test_tool", args: {} } },
        ],
      },
      { role: "user", parts: [{ functionResponse: { id: "test_call", name: "test_tool", response: { result: "ok" } } }] },
    ];

    const result = prepareAgyRequest(
      claudeUrl,
      { method: "POST", body: JSON.stringify({ contents }) },
      token,
      project,
    );

    const payload = JSON.parse(result.init.body as string);
    const modelTurn = payload.request.contents[1];
    expect(modelTurn.role).toBe("model");
    // Only the valid signature thinking part and the functionCall part should remain
    expect(modelTurn.parts).toEqual([
      { thought: true, text: "Thinking with valid sig", thoughtSignature: "valid-sig-123" },
      { functionCall: { id: "test_call", name: "test_tool", args: {} } },
    ]);
  });

  it("drops thinking blocks from completed turns when followed by a new user prompt", () => {
    const claudeUrl = "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent";
    const contents = [
      { role: "user", parts: [{ text: "Hello" }] },
      {
        role: "model",
        parts: [
          { thought: true, text: "Historical thinking with sig", thoughtSignature: "valid-sig-123" },
          { text: "Actual response" },
        ],
      },
      { role: "user", parts: [{ text: "New question from user" }] },
    ];

    const result = prepareAgyRequest(
      claudeUrl,
      { method: "POST", body: JSON.stringify({ contents }) },
      token,
      project,
    );

    const payload = JSON.parse(result.init.body as string);
    const modelTurn = payload.request.contents[1];
    expect(modelTurn.parts).toEqual([{ text: "Actual response" }]);
  });

  it("leaves thinking blocks untouched for non-Claude (Gemini) models", () => {
    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent";
    const contents = [
      { role: "user", parts: [{ text: "Hello" }] },
      {
        role: "model",
        parts: [
          { thought: true, text: "Gemini thinking without signature" },
          { text: "Gemini response" },
        ],
      },
      { role: "user", parts: [{ text: "Follow up" }] },
    ];

    const result = prepareAgyRequest(
      geminiUrl,
      { method: "POST", body: JSON.stringify({ contents }) },
      token,
      project,
    );

    const payload = JSON.parse(result.init.body as string);
    const modelTurn = payload.request.contents[1];
    expect(modelTurn.parts).toEqual([
      { thought: true, text: "Gemini thinking without signature" },
      { text: "Gemini response" },
    ]);
  });

  it("provides fallback text part if sanitization removes all parts in a Claude model turn", () => {
    const claudeUrl = "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent";
    const contents = [
      { role: "user", parts: [{ text: "Hello" }] },
      {
        role: "model",
        parts: [
          { thought: true, text: "Thinking without signature" },
        ],
      },
      { role: "user", parts: [{ text: "Follow up" }] },
    ];

    const result = prepareAgyRequest(
      claudeUrl,
      { method: "POST", body: JSON.stringify({ contents }) },
      token,
      project,
    );

    const payload = JSON.parse(result.init.body as string);
    const modelTurn = payload.request.contents[1];
    expect(modelTurn.parts).toEqual([{ text: "" }]);
  });

  it("sanitizeClaudeThinkingParts handles role assistant, missing parts, and non-array contents safely", () => {
    // Non-array contents
    expect(() => sanitizeClaudeThinkingParts(null as any, "claude-sonnet")).not.toThrow();

    // assistant role and healing to fallback
    const assistantContents = [
      {
        role: "assistant",
        parts: [
          { thought: true, text: "invalid thinking" },
        ],
      },
      {
        role: "assistant",
        parts: "not-an-array" as any,
      },
      null as any,
    ];
    sanitizeClaudeThinkingParts(assistantContents, "claude-3-7-sonnet");
    expect(assistantContents[0].parts).toEqual([{ text: "" }]);
  });

  it("sanitizeClaudeThinkingParts recognizes OpenCode v2 reasoning blocks with state.thoughtSignature", () => {
    const contents = [
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "v2 reasoning step", state: { thoughtSignature: "v2-sig-456" } },
          { text: "assistant response" },
        ],
      },
    ];
    sanitizeClaudeThinkingParts(contents, "claude-3-7-sonnet");
    expect(contents[0].parts).toHaveLength(2);
    expect((contents[0].parts[0] as any).thoughtSignature).toBe("v2-sig-456");
    expect((contents[0].parts[0] as any).signature).toBe("v2-sig-456");
  });

  it("sanitizeClaudeThinkingParts filters out unsigned OpenCode v2 reasoning blocks", () => {
    const contents = [
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "unsigned reasoning step" },
          { text: "assistant response" },
        ],
      },
    ];
    sanitizeClaudeThinkingParts(contents, "claude-3-7-sonnet");
    expect(contents[0].parts).toEqual([{ text: "assistant response" }]);
  });

  it("sanitizeClaudeThinkingParts recovers missing signature from signature cache using sessionId", () => {
    cacheSignature("session-recovery-test", "cached reasoning text", "recovered-sig-999");

    const contents = [
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "cached reasoning text" },
          { text: "assistant response" },
        ],
      },
    ];
    sanitizeClaudeThinkingParts(contents, "claude-3-7-sonnet", "session-recovery-test");
    expect(contents[0].parts).toHaveLength(2);
    expect((contents[0].parts[0] as any).signature).toBe("recovered-sig-999");
  });

  describe("getModelEnum and legacy model fallback resolution", () => {
    it("resolves legacy model aliases and fallbacks to MODEL_PLACEHOLDER_M16", () => {
      expect(getModelEnum("gemini-3.1-pro-high")).toBe("MODEL_PLACEHOLDER_M16");
      expect(getModelEnum("gemini-pro-agent")).toBe("MODEL_PLACEHOLDER_M16");
      expect(getModelEnum("completely-unknown-model")).toBe("MODEL_PLACEHOLDER_M16");
    });

    it("resolves known models from models.json correctly", () => {
      expect(getModelEnum("gemini-3.8-flash-low")).toBe("MODEL_PLACEHOLDER_M320");
      expect(getModelEnum("gemini-4-argon-low")).toBe("MODEL_PLACEHOLDER_M419");
      expect(getModelEnum("gemini-4-argon-medium")).toBe("MODEL_PLACEHOLDER_M418");
      expect(getModelEnum("gemini-4-argon-high")).toBe("MODEL_PLACEHOLDER_M417");
    });

    it("sets model_enum to MODEL_PLACEHOLDER_M16 in prepareAgyRequest for gemini-3.1-pro-high", () => {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-high:generateContent";
      const result = prepareAgyRequest(
        url,
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        "mock-token",
        "mock-project",
      );
      const payload = JSON.parse(result.init.body as string);
      expect(payload.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M16");
    });
  });
});

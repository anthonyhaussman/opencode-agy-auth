import { describe, expect, it } from "vitest";
import { prepareAgyRequest, sanitizeClaudeThinkingParts } from "../../../src/sdk/request/prepare";

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
          { text: "Actual response" },
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
    expect(modelTurn.role).toBe("model");
    // Only the valid signature thinking part and the text part should remain
    expect(modelTurn.parts).toEqual([
      { thought: true, text: "Thinking with valid sig", thoughtSignature: "valid-sig-123" },
      { text: "Actual response" },
    ]);
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
});

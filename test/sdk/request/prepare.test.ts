import { describe, expect, it } from "vitest";
import { prepareAgyRequest } from "../../../src/sdk/request/prepare";

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
});

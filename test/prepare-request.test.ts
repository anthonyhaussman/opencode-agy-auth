import { describe, expect, it } from "vitest";
import { prepareAgyRequest } from "../src/sdk/request/prepare";
import { AGY_CODE_ASSIST_ENDPOINT } from "../src/constants";
import { initTurnStateTracker } from "../src/sdk/request/turn-state-tracker";
import { cacheSignature } from "../src/plugin/cache";

describe("prepareAgyRequest Comprehensive Suite", () => {
  const token = "mock-access-token";
  const project = "mock-project-id";

  it("passes through non-generativelanguage requests untouched", () => {
    const input = "https://api.github.com/repos";
    const result = prepareAgyRequest(input, undefined, token, project);
    expect(result.request).toBe(input);
    expect(result.streaming).toBe(false);
  });

  it("passes through invalid generativelanguage format requests", () => {
    const input = "https://generativelanguage.googleapis.com/invalid/format";
    const result = prepareAgyRequest(input, undefined, token, project);
    expect(result.request).toBe(input);
    expect(result.streaming).toBe(false);
  });

  it("transforms unwrapped standard request payload with agent requestType", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      system_instruction: { parts: [{ text: "Be helpful" }] },
      cached_content: "cached-resource-123",
      extra_body: { cached_content: "cached-resource-123" },
      model: "gemini-2.5-pro",
    });

    const result = prepareAgyRequest(
      input,
      { method: "POST", body, headers: { "x-api-key": "old", "x-goog-api-key": "old" } },
      token,
      project,
    );

    expect(result.request).toBe(`${AGY_CODE_ASSIST_ENDPOINT}/v1internal:generateContent`);
    expect(result.streaming).toBe(false);
    expect(result.requestedModel).toBe("gemini-2.5-pro");

    const headers = result.init.headers as Headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBeNull();

    const parsed = JSON.parse(result.init.body as string);
    expect(parsed.project).toBe(project);
    expect(parsed.requestType).toBe("agent");
    expect(parsed.model).toBe("gemini-2.5-pro");
    expect(parsed.request.systemInstruction).toEqual({ parts: [{ text: "Be helpful" }] });
    expect(parsed.request.system_instruction).toBeUndefined();
    expect(parsed.request.cachedContent).toBe("cached-resource-123");
    expect(parsed.request.cached_content).toBeUndefined();
    expect(parsed.request.extra_body).toBeUndefined();
    expect(parsed.request.model).toBeUndefined();
    expect(parsed.request.labels.model_enum).toBeDefined();
  });

  it("classifies image_gen, checkpoint, chat, and web_search requestTypes", () => {
    const tests = [
      {
        url: "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002-image:generateContent",
        expectedType: "image_gen",
      },
      {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent",
        expectedType: "checkpoint",
      },
      {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
        expectedType: "chat",
      },
      {
        url: "https://generativelanguage.googleapis.com/v1beta/models/custom-model-lite:generateContent",
        expectedType: "web_search",
      },
    ];

    for (const t of tests) {
      const result = prepareAgyRequest(t.url, { method: "POST", body: JSON.stringify({ contents: [] }) }, token, project);
      const parsed = JSON.parse(result.init.body as string);
      expect(parsed.requestType).toBe(t.expectedType);
    }
  });

  it("handles imageConfig inside generationConfig as image_gen", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
    const body = JSON.stringify({
      contents: [],
      generationConfig: { imageConfig: { aspectRatio: "1:1" } },
    });
    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    expect(parsed.requestType).toBe("image_gen");
  });

  it("transforms wrapped request bodies correctly", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";
    const body = JSON.stringify({
      project: "custom-project",
      request: {
        contents: [
          {
            role: "user",
            parts: [{ text: "generate" }],
          },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "do_something:v1",
                parameters: {
                  anyOf: [{ type: "string" }],
                  unknown_prop: "remove-me",
                },
              },
            ],
          },
        ],
        tool_config: {
          function_calling_config: {
            allowed_function_names: ["do_something:v1"],
          },
        },
      },
    });

    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    expect(parsed.requestType).toBe("image_gen");
    expect(parsed.userAgent).toBe("antigravity");
    expect(parsed.request.tools[0].functionDeclarations[0].name).toBe("do_something_v1");
    expect(parsed.request.tools[0].functionDeclarations[0].parameters.type).toBe("STRING");
    expect(parsed.request.tools[0].functionDeclarations[0].parameters.unknown_prop).toBeUndefined();
    expect(parsed.request.tool_config.function_calling_config.allowed_function_names[0]).toBe("do_something_v1");
  });

  it("normalizes tool schema types, anyOf/oneOf, casing, and nested properties", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
    const body = JSON.stringify({
      contents: [],
      tools: [
        {
          functionDeclarations: [
            {
              name: "complexTool",
              parameters: {
                type: "object",
                properties: {
                  tags: {
                    oneOf: [{ type: "array", items: { type: "string" } }],
                  },
                  fallbackItem: {
                    anyOf: [{}],
                  },
                  count: {
                    type: "integer",
                  },
                  extraUnused: { type: "string" },
                },
              },
            },
            {
              name: "noParamsTool",
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          allowedFunctionNames: ["complexTool"],
        },
      },
    });

    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    const fn1 = parsed.request.tools[0].functionDeclarations[0];
    expect(fn1.parameters.type).toBe("OBJECT");
    expect(fn1.parameters.properties.tags.type).toBe("ARRAY");
    expect(fn1.parameters.properties.tags.items.type).toBe("STRING");
    expect(fn1.parameters.properties.fallbackItem.type).toBe("STRING");
    expect(fn1.parameters.properties.count.type).toBe("INTEGER");
    expect(fn1.parameters.properties.extraUnused.type).toBe("STRING");

    const fn2 = parsed.request.tools[0].functionDeclarations[1];
    expect(fn2.parameters).toEqual({ type: "OBJECT", properties: {} });
    expect(parsed.request.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["complexTool"]);
  });

  it("normalizes consecutive contents sequences by role and filters nulls", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
    const body = JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: "part 1" }, null] },
        { role: "user", parts: [{ text: "part 2" }] },
        { role: "model", parts: [{ text: "response" }] },
        { role: "invalid-empty", parts: [] },
      ],
    });

    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    expect(parsed.request.contents).toHaveLength(2);
    expect(parsed.request.contents[0].role).toBe("user");
    expect(parsed.request.contents[0].parts).toEqual([{ text: "part 1" }, { text: "part 2" }]);
    expect(parsed.request.contents[1].role).toBe("model");
  });

  it("injects missing tool call IDs and links corresponding tool responses", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
    const body = JSON.stringify({
      contents: [
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "lookupUser",
                args: { id: "123" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "lookupUser",
                response: { name: "Alice" },
              },
            },
          ],
        },
      ],
    });

    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    const call = parsed.request.contents[0].parts[0].functionCall;
    const resp = parsed.request.contents[1].parts[0].functionResponse;
    expect(call.id).toBeDefined();
    expect(resp.id).toBe(call.id);
  });

  it("fixes orphaned function responses into synthetic text parts", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
    const body = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "orphan-id-999",
                name: "missingTool",
                response: { error: "unpaired" },
              },
            },
          ],
        },
      ],
    });

    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    const part = parsed.request.contents[0].parts[0];
    expect(part.functionResponse).toBeUndefined();
    expect(part.text).toContain("[Orphaned Tool Response for missingTool]:");
    expect(part.text).toContain("unpaired");
  });

  it("applies latest cached thought signature to the last function call", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
    const sessionId = "session-sig-test-123";
    const sig = "sig_latest_hash_value";
    cacheSignature(sessionId, "thought-text", sig);

    const body = JSON.stringify({
      sessionId: sessionId,
      contents: [
        {
          role: "model",
          parts: [
            {
              thoughtSignature: "skip_thought_signature_validator",
              functionCall: {
                id: "call-1",
                name: "toolA",
              },
            },
            {
              functionCall: {
                id: "call-2",
                name: "toolB",
              },
            },
          ],
        },
      ],
    });

    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    const parts = parsed.request.contents[0].parts;
    expect(parts[1].thoughtSignature).toBe(sig);
    expect(parts[1].functionCall.thoughtSignature).toBeUndefined();
    expect(parts[0].thoughtSignature).toBe("skip_thought_signature_validator");
    expect(parts[0].functionCall.thoughtSignature).toBeUndefined();
  });

  it("migrates thoughtSignature if mistakenly placed in functionCall", () => {
    const sessionId = "session-migrate-test";
    const sig = "migrated-sig-123";
    cacheSignature(sessionId, "thought-text", sig);

    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
    const body = JSON.stringify({
      sessionId: sessionId,
      contents: [
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call-1",
                name: "toolA",
                thoughtSignature: "skip_thought_signature_validator",
              },
            },
          ],
        },
      ],
    });

    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    const parts = parsed.request.contents[0].parts;
    expect(parts[0].thoughtSignature).toBe(sig);
    expect(parts[0].functionCall.thoughtSignature).toBeUndefined();
  });

  it("recovers thinking when state tracker indicates in tool loop without thinking", () => {
    const tracker = initTurnStateTracker(false);
    const sessionId = "session-recovery-test";
    tracker.updateAfterResponse(sessionId, { inToolLoop: true, turnHasThinking: false, lastCallIds: ["c1"] });

    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
    const body = JSON.stringify({
      clientSessionId: sessionId,
      contents: [
        {
          role: "user",
          parts: [{ text: "initial query" }],
        },
        {
          role: "model",
          parts: [{ functionCall: { id: "c1", name: "tool1" } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { id: "c1", name: "tool1", response: { ok: true } } }],
        },
      ],
    });

    const result = prepareAgyRequest(input, { method: "POST", body }, token, project);
    const parsed = JSON.parse(result.init.body as string);
    expect(parsed.request.contents.length).toBeGreaterThan(3);
    tracker.shutdown();
  });

  it("handles thinking configuration defaults and budget overrides", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-low:generateContent";
    const body = JSON.stringify({
      contents: [],
      thinkingConfig: {
        thinkingBudget: 2000,
      },
    });

    const result = prepareAgyRequest(
      input,
      { method: "POST", body },
      token,
      project,
      {
        provider: { thinkingBudget: 500 },
        models: { "gemini-2.5-flash-low": { thinkingBudget: 1500 } },
      },
    );

    const parsed = JSON.parse(result.init.body as string);
    expect(parsed.request.generationConfig.thinkingConfig.thinkingBudget).toBe(2000);
    expect(parsed.request.thinkingConfig).toBeUndefined();
  });

  it("catches malformed JSON gracefully and warns", () => {
    const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
    const result = prepareAgyRequest(input, { method: "POST", body: "invalid-json{" }, token, project);
    expect(result.init.body).toBe("invalid-json{");
    expect(result.sessionId).toBeUndefined();
  });
});

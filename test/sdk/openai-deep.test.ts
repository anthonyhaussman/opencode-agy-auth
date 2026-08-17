import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  transformOpenAIToolCalls,
  addThoughtSignaturesToFunctionCalls,
} from "../../src/sdk/request/openai";

describe("openai transformer deep coverage", () => {
  it("transformOpenAIToolCalls handles empty or invalid messages array", () => {
    const payload1 = {};
    transformOpenAIToolCalls(payload1 as any);
    expect(payload1).toEqual({});

    const payload2 = { messages: "not-an-array" };
    transformOpenAIToolCalls(payload2 as any);
    expect(payload2).toEqual({ messages: "not-an-array" });

    const payload3 = { messages: [null, undefined, 123, "string", {}] };
    transformOpenAIToolCalls(payload3 as any);
    expect(payload3.messages).toHaveLength(5);
  });

  it("transformOpenAIToolCalls handles messages without tool_calls or invalid tool_calls", () => {
    const payload = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", tool_calls: "invalid" },
        { role: "assistant", tool_calls: [] },
        { role: "assistant", tool_calls: [null, undefined, 123] },
        { role: "assistant", tool_calls: [{}] }, // no function object
      ],
    };
    transformOpenAIToolCalls(payload as any);
    expect(payload.messages[0]).toEqual({ role: "user", content: "hello" });
  });

  it("transformOpenAIToolCalls transforms valid tool calls with toolMapper and string/non-string args", () => {
    const toolMapper = {
      toGemini: (name: string) => `mapped_${name}`,
      toClient: (name: string) => name.replace(/^mapped_/, ""),
    };

    const payload = {
      messages: [
        {
          role: "assistant",
          content: "calling tool",
          tool_calls: [
            {
              id: "call-1",
              function: {
                name: "do_action",
                arguments: '{"param": "val"}',
              },
            },
            {
              // missing id
              function: {
                // missing name
                arguments: "invalid-json-string",
              },
            },
            {
              function: {
                name: "do_action_non_json",
                arguments: null as any,
              },
            },
          ],
        },
      ],
    };

    transformOpenAIToolCalls(payload as any, toolMapper as any);
    const msg = payload.messages[0] as any;
    expect(msg.tool_calls).toBeUndefined();
    expect(msg.content).toBeUndefined();
    expect(msg.parts).toHaveLength(4); // 1 text + 3 tool calls
    expect(msg.parts[0]).toEqual({ text: "calling tool" });
    expect(msg.parts[1].functionCall).toEqual({
      id: "call-1",
      name: "mapped_do_action",
      args: { param: "val" },
    });
    expect(msg.parts[2].functionCall.args).toEqual({});
    expect(msg.parts[3].functionCall.args).toEqual({});
  });

  it("addThoughtSignaturesToFunctionCalls handles various invalid contents structures", () => {
    const payload1 = {};
    addThoughtSignaturesToFunctionCalls(payload1);
    expect(payload1).toEqual({});

    const payload2 = { contents: "not-an-array" };
    addThoughtSignaturesToFunctionCalls(payload2 as any);
    expect(payload2).toEqual({ contents: "not-an-array" });

    const payload3 = {
      contents: [
        null,
        undefined,
        123,
        { parts: "invalid" },
        { parts: [null, undefined, "not-an-object", { text: "hi" }] },
      ],
      request: {
        contents: [
          {
            parts: [
              {
                functionCall: { name: "test_fn" },
                // missing thoughtSignature
              },
              {
                functionCall: { name: "has_sig" },
                thoughtSignature: "existing_sig",
              },
            ],
          },
        ],
      },
    };

    addThoughtSignaturesToFunctionCalls(payload3 as any);
    const reqParts = (payload3.request.contents[0] as any).parts;
    expect(reqParts[0].thoughtSignature).toBe("skip_thought_signature_validator");
    expect(reqParts[1].thoughtSignature).toBe("existing_sig");
  });
});

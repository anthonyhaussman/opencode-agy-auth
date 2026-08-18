import { describe, expect, it } from "vitest";
import {
  ToolMapper,
  clearToolMapper,
  getToolMapper,
  restoreToolNamesInResponse,
  sanitizeToolName,
} from "../src/sdk/request/tool-mapper";

describe("src/sdk/request/tool-mapper", () => {
  it("sanitizes tool names according to Gemini API restrictions", () => {
    expect(sanitizeToolName("")).toBe("unnamed_tool");
    expect(sanitizeToolName(null as any)).toBe("unnamed_tool");
    expect(sanitizeToolName("my-tool")).toBe("my_tool");
    expect(sanitizeToolName("123tool")).toBe("_123tool");
    expect(sanitizeToolName("atlassian:get_issue")).toBe("atlassian_get_issue");
    expect(sanitizeToolName("namespace.sub::action")).toBe("namespace_sub__action");
  });

  it("handles registration and collision resolution", () => {
    const mapper = new ToolMapper();
    const s1 = mapper.register("my-tool");
    expect(s1).toBe("my_tool");
    expect(mapper.toGemini("my-tool")).toBe("my_tool");
    expect(mapper.fromGemini("my_tool")).toBe("my-tool");

    // Collision case
    const s2 = mapper.register("my_tool");
    expect(s2).toBe("my_tool_1");
    expect(mapper.toGemini("my_tool")).toBe("my_tool_1");
    expect(mapper.fromGemini("my_tool_1")).toBe("my_tool");

    expect(mapper.toGemini(null as any)).toBeNull();
    expect(mapper.fromGemini(null as any)).toBeNull();
    expect(mapper.fromGemini("unknown_tool")).toBe("unknown_tool");
  });

  it("registers tools from functionDeclarations, openAITools, and contents", () => {
    const mapper = new ToolMapper();
    mapper.registerFromFunctionDeclarations([
      {
        functionDeclarations: [{ name: "tool-a" }, { name: "tool-b" }, null],
      },
      null,
    ]);
    expect(mapper.fromGemini("tool_a")).toBe("tool-a");
    expect(mapper.fromGemini("tool_b")).toBe("tool-b");

    mapper.registerFromOpenAITools([
      {
        function: { name: "openai-tool" },
      },
      null,
    ]);
    expect(mapper.fromGemini("openai_tool")).toBe("openai-tool");

    mapper.registerFromContents([
      {
        parts: [
          { functionCall: { name: "called-tool" } },
          { functionResponse: { name: "responded-tool" } },
          null,
        ],
      },
      null,
    ]);
    expect(mapper.fromGemini("called_tool")).toBe("called-tool");
    expect(mapper.fromGemini("responded_tool")).toBe("responded-tool");
  });

  it("manages session mappers and restores tool names in response bodies", () => {
    const mapper1 = getToolMapper("session-abc");
    const mapper2 = getToolMapper("session-abc");
    expect(mapper1).toBe(mapper2);

    const mapper3 = getToolMapper();
    expect(mapper3).not.toBe(mapper1);

    clearToolMapper("session-abc");
    const mapper4 = getToolMapper("session-abc");
    expect(mapper4).not.toBe(mapper1);

    const testMapper = new ToolMapper();
    testMapper.register("custom-tool-call");

    const responseBody = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "custom_tool_call",
                    args: {},
                  },
                },
              ],
            },
          },
        ],
      },
    };

    restoreToolNamesInResponse(responseBody, testMapper);
    expect(
      (responseBody.response.candidates[0].content.parts[0] as any).functionCall.name,
    ).toBe("custom-tool-call");

    // Null/undefined guard test
    restoreToolNamesInResponse(null, testMapper);
  });
});

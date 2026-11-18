import { describe, expect, it } from "vitest";
import { ALLOWED_BUILTINS } from "../../src/acp/constants";
import {
  StreamMapper,
  classifyToolCall,
  mapStopReason,
  mapUsage,
  stripToolSummary,
} from "../../src/acp/stream-map";
import type { AcpSessionUpdate } from "../../src/acp/process";

const msg = (text: string): AcpSessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const thought = (text: string): AcpSessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const bridgeCall = (id = "t1"): AcpSessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  name: "call_mcp_tool",
  rawInput: {
    ServerName: "opencode-bridge_bridge",
    ToolName: "read",
    Arguments: { path: "a", toolSummary: "x" },
    toolSummary: "x",
  },
});

describe("text and reasoning blocks", () => {
  it("groups consecutive chunks and closes on flush", () => {
    const m = new StreamMapper();
    const a = m.map(msg("he")).parts;
    const b = m.map(msg("llo")).parts;
    const end = m.flush();
    expect(a.map((p) => p.type)).toEqual(["text-start", "text-delta"]);
    expect(b.map((p) => p.type)).toEqual(["text-delta"]);
    expect(end.map((p) => p.type)).toEqual(["text-end"]);
    const id = (a[0] as any).id;
    expect((a[1] as any).id).toBe(id);
    expect((b[0] as any).id).toBe(id);
    expect((end[0] as any).id).toBe(id);
    expect(m.flush()).toEqual([]);
  });

  it("switches between text and reasoning with unique ids", () => {
    const m = new StreamMapper();
    const p1 = m.map(msg("a")).parts;
    const p2 = m.map(thought("b")).parts;
    const p3 = m.map(msg("c")).parts;
    expect(p2.map((p) => p.type)).toEqual(["text-end", "reasoning-start", "reasoning-delta"]);
    expect(p3.map((p) => p.type)).toEqual(["reasoning-end", "text-start", "text-delta"]);
    const ids = [(p1[0] as any).id, (p2[1] as any).id, (p3[1] as any).id];
    expect(new Set(ids).size).toBe(3);
    expect(m.flush().map((p) => p.type)).toEqual(["text-end"]);
  });

  it("ignores empty or non-text chunks", () => {
    const m = new StreamMapper();
    expect(m.map({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }).parts).toEqual([]);
    expect(m.map(msg("")).parts).toEqual([]);
    expect(m.flush()).toEqual([]);
  });
});

describe("bridge calls", () => {
  it("detects a bridge call and closes open text", () => {
    const m = new StreamMapper();
    m.map(msg("x"));
    const ev = m.map(bridgeCall());
    expect(ev.parts.map((p) => p.type)).toEqual(["text-end", "tool-call"]);
    const tc = ev.parts[1] as any;
    expect(tc.toolCallId).toBe("t1");
    expect(tc.toolName).toBe("read");
    expect(tc.input).toBe(JSON.stringify({ path: "a" }));
    expect(tc.providerExecuted).toBeUndefined();
    expect(ev.bridgeCall).toEqual({ callId: "t1", toolName: "read", input: { path: "a" } });
    expect(ev.violation).toBeUndefined();
  });

  it("ignores updates for bridge calls", () => {
    const m = new StreamMapper();
    m.map(bridgeCall());
    const ev = m.map({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: "ok",
    });
    expect(ev.parts).toEqual([]);
  });

  it("does not duplicate a re-sent tool_call", () => {
    const m = new StreamMapper();
    m.map(bridgeCall());
    const ev = m.map(bridgeCall());
    expect(ev.parts).toEqual([]);
    expect(ev.bridgeCall).toBeUndefined();
  });

  it("defaults input to {} when Arguments absent", () => {
    const c = classifyToolCall({
      toolCallId: "t",
      name: "call_mcp_tool",
      rawInput: { ServerName: "opencode-bridge_bridge", ToolName: "x" },
    });
    expect(c).toEqual({ kind: "bridge", call: { callId: "t", toolName: "x", input: {} } });
  });
});

describe("builtins", () => {
  it.each([...ALLOWED_BUILTINS])("maps %s as provider-executed with a result", (name) => {
    const m = new StreamMapper();
    const ev = m.map({ sessionUpdate: "tool_call", toolCallId: "b1", name, rawInput: { p: 1 } });
    expect(ev.parts).toEqual([
      { type: "tool-call", toolCallId: "b1", toolName: name, input: '{"p":1}', providerExecuted: true },
    ]);
    const res = m.map({
      sessionUpdate: "tool_call_update",
      toolCallId: "b1",
      status: "completed",
      rawOutput: "raw",
      content: [{ type: "content", content: { type: "text", text: "body" } }],
    });
    expect(res.parts).toEqual([
      { type: "tool-result", toolCallId: "b1", toolName: name, result: "body" },
    ]);
    // result emitted once
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed" }).parts).toEqual([]);
  });

  it("falls back to rawOutput string, then JSON, then empty", () => {
    const run = (extra: Record<string, unknown>) => {
      const m = new StreamMapper();
      m.map({ sessionUpdate: "tool_call", toolCallId: "b", name: "read_file" });
      return (m.map({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed", ...extra } as any)
        .parts[0] as any).result;
    };
    expect(run({ rawOutput: "s" })).toBe("s");
    expect(run({ rawOutput: { jsonrpc: "2.0" } })).toBe('{"jsonrpc":"2.0"}');
    expect(run({})).toBe("");
  });

  it("marks failed results as errors", () => {
    const m = new StreamMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "b", name: "read_file" });
    const ev = m.map({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed", rawOutput: "boom" });
    expect((ev.parts[0] as any).isError).toBe(true);
    expect((ev.parts[0] as any).result).toBe("boom");
  });

  it("emits nothing for in-progress or unknown-id updates", () => {
    const m = new StreamMapper();
    m.map({ sessionUpdate: "tool_call", toolCallId: "b", name: "read_file" });
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "in_progress" }).parts).toEqual([]);
    expect(m.map({ sessionUpdate: "tool_call_update", toolCallId: "zz", status: "completed" }).parts).toEqual([]);
  });

  it("does not duplicate a re-sent builtin tool_call", () => {
    const m = new StreamMapper();
    const tc: AcpSessionUpdate = { sessionUpdate: "tool_call", toolCallId: "b", name: "read_file" };
    m.map(tc);
    expect(m.map(tc).parts).toEqual([]);
  });
});

describe("foreign MCP servers", () => {
  const foreign: AcpSessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: "f1",
    name: "call_mcp_tool",
    rawInput: { ServerName: "lean-ctx_server", ToolName: "ctx_read", Arguments: { a: 1 } },
  };
  it("is provider-executed with a prefixed name", () => {
    const m = new StreamMapper();
    const ev = m.map(foreign);
    expect(ev.bridgeCall).toBeUndefined();
    expect(ev.violation).toBeUndefined();
    expect(ev.parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "f1",
        toolName: "lean-ctx_server/ctx_read",
        input: '{"a":1}',
        providerExecuted: true,
      },
    ]);
    const res = m.map({ sessionUpdate: "tool_call_update", toolCallId: "f1", status: "failed", rawOutput: "no" });
    expect(res.parts).toEqual([
      {
        type: "tool-result",
        toolCallId: "f1",
        toolName: "lean-ctx_server/ctx_read",
        result: "no",
        isError: true,
      },
    ]);
  });
});

describe("violations", () => {
  it.each(["run_command", "write_file", undefined])("rejects %s", (name) => {
    const m = new StreamMapper();
    m.map(msg("x"));
    const ev = m.map({ sessionUpdate: "tool_call", toolCallId: "v", name });
    expect(ev.violation).toEqual({ toolName: name ?? "" });
    expect(ev.parts.some((p) => p.type === "tool-call")).toBe(false);
  });

  it("treats call_mcp_tool without a server as violation", () => {
    expect(classifyToolCall({ toolCallId: "x", name: "call_mcp_tool", rawInput: "bad" })).toEqual({
      kind: "violation",
      toolName: "call_mcp_tool",
    });
  });
});

describe("ignored updates", () => {
  it("returns no parts", () => {
    const m = new StreamMapper();
    const updates = [
      { sessionUpdate: "usage_update", used: 1, size: 2 },
      { sessionUpdate: "session_info_update", title: "t" },
      { sessionUpdate: "available_commands_update" },
      { sessionUpdate: "current_mode_update", currentModeId: "x" },
      { sessionUpdate: "plan" },
      { sessionUpdate: "something_new" },
    ] as unknown as AcpSessionUpdate[];
    for (const u of updates) expect(m.map(u)).toEqual({ parts: [] });
  });
});

describe("stripToolSummary", () => {
  it("removes toolSummary from objects only", () => {
    expect(stripToolSummary({ a: 1, toolSummary: "x" })).toEqual({ a: 1 });
    expect(stripToolSummary({ a: 1 })).toEqual({ a: 1 });
    expect(stripToolSummary("s")).toBe("s");
    expect(stripToolSummary([1])).toEqual([1]);
  });
});

describe("mapStopReason", () => {
  it.each([
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["max_turn_requests", "length"],
    ["refusal", "content-filter"],
    ["cancelled", "other"],
  ] as const)("%s -> %s", (r, u) => {
    expect(mapStopReason(r)).toEqual({ unified: u, raw: r });
  });
  it("maps unknown reasons to other", () => {
    expect(mapStopReason("weird" as any).unified).toBe("other");
  });
});

describe("mapUsage", () => {
  it("returns undefined fields for no usage", () => {
    const u = mapUsage(undefined);
    expect(u.inputTokens).toEqual({ total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined });
    expect(u.outputTokens).toEqual({ total: undefined, text: undefined, reasoning: undefined });
  });
  it("maps agy usage", () => {
    const u = mapUsage({
      inputTokens: 9493,
      outputTokens: 1162,
      thoughtTokens: 837,
      cachedReadTokens: 100,
      totalTokens: 10655,
    });
    expect(u.inputTokens.total).toBe(9493);
    expect(u.inputTokens.cacheRead).toBe(100);
    expect(u.inputTokens.noCache).toBe(9393);
    expect(u.inputTokens.cacheWrite).toBeUndefined();
    expect(u.outputTokens).toEqual({ total: 1162, reasoning: 837, text: 325 });
  });
  it("leaves text undefined without thought tokens", () => {
    expect(mapUsage({ outputTokens: 5 }).outputTokens).toEqual({ total: 5, text: undefined, reasoning: undefined });
  });
});

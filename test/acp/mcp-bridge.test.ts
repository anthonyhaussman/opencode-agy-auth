import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CANCELLED_TEXT, MCP_SOFT_TIMEOUT_MS, STILL_RUNNING_TEXT } from "../../src/acp/constants";
import { McpBridge, PendingTools, type BridgeToolDef } from "../../src/acp/mcp-bridge";

const TOOLS: BridgeToolDef[] = [
  {
    name: "read",
    description: "read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  { name: "ping", inputSchema: { type: "object" } },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => Promise<void>> = [];

async function setup(softTimeoutMs: number | null = null) {
  const pending = new PendingTools({ softTimeoutMs });
  const logs: string[] = [];
  const bridge = await McpBridge.start({ tools: TOOLS, pending, log: (m) => logs.push(m) });
  cleanup.push(() => bridge.close());
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
    }),
  );
  cleanup.push(() => client.close());
  return { pending, bridge, client, logs };
}

function text(result: any): string {
  return result.content[0].text;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  cleanup = [];
});

describe("McpBridge", () => {
  it("lists_tools", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: TOOLS, pending });
    cleanup.push(() => bridge.close());
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }),
    );
    cleanup.push(() => client.close());
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["read", "ping"]);
    expect(listed.tools[0]!.inputSchema).toMatchObject({ required: ["path"] });
    expect(listed.tools[0]!.description).toBe("read a file");
    expect(await bridge.waitForClient(10)).toBe(true);
  });

  it("wait_for_client_times_out", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: TOOLS, pending });
    cleanup.push(() => bridge.close());
    expect(await bridge.waitForClient(20)).toBe(false);
  });

  it("wait_for_client resolves when client arrives later", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: TOOLS, pending });
    cleanup.push(() => bridge.close());
    const waiting = bridge.waitForClient(5000);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }),
    );
    cleanup.push(() => client.close());
    await client.listTools();
    expect(await waiting).toBe(true);
  });

  it("call_waits_for_resolve", async () => {
    const { pending, client } = await setup();
    pending.expect({ callId: "t1", toolName: "read", input: { path: "a" } });
    let done = false;
    const p = client.callTool({ name: "read", arguments: { path: "a" } }).then((r) => {
      done = true;
      return r;
    });
    await sleep(50);
    expect(done).toBe(false);
    expect(pending.size).toBe(1);
    expect(pending.resolve("t1", { text: "ok", isError: false })).toBe(true);
    const r = await p;
    expect(text(r)).toBe("ok");
    expect(r.isError).toBeFalsy();
  });

  it("resolve_before_claim", async () => {
    const { pending, client } = await setup();
    pending.expect({ callId: "t1", toolName: "read", input: { path: "a" } });
    expect(pending.resolve("t1", { text: "early", isError: false })).toBe(true);
    const r = await client.callTool({ name: "read", arguments: { path: "a" } });
    expect(text(r)).toBe("early");
    expect(pending.size).toBe(0);
  });

  it("error_outcome", async () => {
    const { pending, client } = await setup();
    pending.expect({ callId: "t1", toolName: "read", input: { path: "a" } });
    pending.resolve("t1", { text: "boom", isError: true });
    const r = await client.callTool({ name: "read", arguments: { path: "a" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("boom");
  });

  it("unexpected_claim_is_error", async () => {
    const { client } = await setup();
    const r = await client.callTool({ name: "read", arguments: { path: "a" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("No pending OpenCode tool call");
  });

  it("invalid_input_is_error", async () => {
    const { client } = await setup();
    const bad = await client.callTool({ name: "read", arguments: { path: 5 } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("read");
    const unknown = await client.callTool({ name: "nope", arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("nope");
  });

  it("validation_failure_routes_opencode_result_as_late", async () => {
    const { pending, client } = await setup();
    pending.expect({ callId: "t1", toolName: "read", input: { path: 5 } });
    const bad = await client.callTool({ name: "read", arguments: { path: 5 } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("Invalid input");
    // OpenCode still ran the tool call it was shown: its result is delivered late.
    expect(pending.resolve("t1", { text: "opencode result", isError: false })).toBe(true);
    expect(pending.takeLateResults()).toEqual([{ callId: "t1", outcome: { text: "opencode result", isError: false } }]);
    expect(pending.size).toBe(0);

    pending.expect({ callId: "t2", toolName: "read", input: { path: "b" } });
    pending.resolve("t2", { text: "fresh", isError: false });
    const ok = await client.callTool({ name: "read", arguments: { path: "b" } });
    expect(text(ok)).toBe("fresh");
  });

  it("validation_failure_does_not_leave_stale_entry_for_fallback", async () => {
    const { pending, client } = await setup();
    pending.expect({ callId: "t1", toolName: "read", input: { path: 5 } });
    await client.callTool({ name: "read", arguments: { path: 5 } });
    // No entry for the next call: it must not get t1 through the claim fallback.
    const next = await client.callTool({ name: "read", arguments: { path: "c" } });
    expect(next.isError).toBe(true);
    expect(text(next)).toContain("No pending OpenCode tool call");
  });

  it("validation_failure_after_early_result_queues_it_late", async () => {
    const onClaim = vi.fn();
    const pending = new PendingTools({ softTimeoutMs: null, onClaim });
    pending.expect({ callId: "t1", toolName: "read", input: { path: 5 } });
    pending.resolve("t1", { text: "early", isError: false });
    pending.abandon("read", { path: 5 });
    expect(onClaim).toHaveBeenCalledWith("t1");
    expect(pending.takeLateResults()).toEqual([{ callId: "t1", outcome: { text: "early", isError: false } }]);
    expect(pending.size).toBe(0);
    pending.abandon("read", { path: 5 });
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it("tool_summary_passes_validation_with_strict_schema", async () => {
    const { pending, client } = await setup();
    pending.expect({ callId: "t1", toolName: "read", input: { path: "a" } });
    pending.resolve("t1", { text: "ok", isError: false });
    const r = await client.callTool({ name: "read", arguments: { path: "a", toolSummary: "x" } });
    expect(text(r)).toBe("ok");
  });

  it("tool call with no arguments is validated as empty object", async () => {
    const { pending, client } = await setup();
    pending.expect({ callId: "t1", toolName: "ping", input: {} });
    pending.resolve("t1", { text: "pong", isError: false });
    const r = await client.callTool({ name: "ping" });
    expect(text(r)).toBe("pong");
  });

  it("soft_timeout_returns_still_running", async () => {
    const { pending, client } = await setup(20);
    pending.expect({ callId: "t1", toolName: "read", input: { path: "a" } });
    const r = await client.callTool({ name: "read", arguments: { path: "a" } });
    expect(text(r)).toBe(STILL_RUNNING_TEXT);
    expect(r.isError).toBeFalsy();
    expect(pending.resolve("t1", { text: "late", isError: false })).toBe(true);
    expect(pending.takeLateResults()).toEqual([{ callId: "t1", outcome: { text: "late", isError: false } }]);
    expect(pending.takeLateResults()).toEqual([]);
  });

  it("rejectAll", async () => {
    const { pending, client } = await setup();
    pending.expect({ callId: "t1", toolName: "read", input: { path: "a" } });
    const p = client.callTool({ name: "read", arguments: { path: "a" } });
    await sleep(50);
    pending.rejectAll(CANCELLED_TEXT);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(CANCELLED_TEXT);
  });

  it("rejects_missing_token", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: TOOLS, pending });
    cleanup.push(() => bridge.close());
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const none = await fetch(bridge.url, { method: "POST", headers, body });
    expect(none.status).toBe(401);
    const wrong = await fetch(bridge.url, {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer wrong" },
      body,
    });
    expect(wrong.status).toBe(401);
    const sameLen = await fetch(bridge.url, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${"0".repeat(bridge.token.length)}` },
      body,
    });
    expect(sameLen.status).toBe(401);
    expect(bridge.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await bridge.waitForClient(10)).toBe(false);
  });

  it("close releases the port and is idempotent", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: TOOLS, pending });
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await bridge.close();
    await bridge.close();
    await expect(fetch(bridge.url, { method: "POST" })).rejects.toThrow();
  });
});

describe("McpBridge resilience", () => {
  async function connect(bridge: McpBridge) {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }),
    );
    cleanup.push(() => client.close());
    return client;
  }

  it("tolerates_2020_12_schema", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const tools: BridgeToolDef[] = [
      {
        name: "strict",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
        },
      },
    ];
    const bridge = await McpBridge.start({ tools, pending });
    cleanup.push(() => bridge.close());
    const client = await connect(bridge);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["strict"]);
    const bad = await client.callTool({ name: "strict", arguments: { n: "x" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("strict");
  });

  it("uncompilable_schema_accepts_any", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const logs: string[] = [];
    const tools: BridgeToolDef[] = [
      { name: "weird", inputSchema: { type: "object", properties: { a: { type: "nonsense" } } } },
    ];
    const bridge = await McpBridge.start({ tools, pending, log: (m) => logs.push(m) });
    cleanup.push(() => bridge.close());
    expect(logs.some((l) => l.includes("weird"))).toBe(true);
    const client = await connect(bridge);
    pending.expect({ callId: "w1", toolName: "weird", input: { a: 5 } });
    pending.resolve("w1", { text: "fine", isError: false });
    const r = await client.callTool({ name: "weird", arguments: { a: 5 } });
    expect(text(r)).toBe("fine");
  });

  it("reinitialize_after_client_restart", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: TOOLS, pending });
    cleanup.push(() => bridge.close());
    const a = new Client({ name: "a", version: "1" });
    await a.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }),
    );
    await a.listTools();
    pending.expect({ callId: "t1", toolName: "read", input: { path: "a" } });
    const b = await connect(bridge);
    expect((await b.listTools()).tools.map((t) => t.name)).toEqual(["read", "ping"]);
    pending.resolve("t1", { text: "after-swap", isError: false });
    const r = await b.callTool({ name: "read", arguments: { path: "a" } });
    expect(text(r)).toBe("after-swap");
  });

  it("malformed JSON body gets 400", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: TOOLS, pending });
    cleanup.push(() => bridge.close());
    const res = await fetch(bridge.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });
});

describe("PendingTools", () => {
  it("claim_matches_by_name_in_order", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    pending.expect({ callId: "a", toolName: "read", input: { path: "1" } });
    pending.expect({ callId: "b", toolName: "read", input: { path: "2" } });
    const c2 = pending.claim("read", { path: "2" });
    const c1 = pending.claim("read", { path: "1" });
    pending.resolve("b", { text: "B", isError: false });
    pending.resolve("a", { text: "A", isError: false });
    expect((await c2).text).toBe("B");
    expect((await c1).text).toBe("A");

    pending.expect({ callId: "c", toolName: "read", input: { path: "x" } });
    pending.expect({ callId: "d", toolName: "read", input: { path: "y" } });
    const first = pending.claim("read", { path: "other" });
    const second = pending.claim("read", { path: "other2" });
    pending.resolve("c", { text: "C", isError: false });
    pending.resolve("d", { text: "D", isError: false });
    expect((await first).text).toBe("C");
    expect((await second).text).toBe("D");
  });

  it("claim_strips_tool_summary", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    pending.expect({ callId: "a", toolName: "read", input: { x: 1, path: "1" } });
    pending.expect({ callId: "b", toolName: "read", input: { path: "2" } });
    const c = pending.claim("read", { path: "2", toolSummary: "s" });
    pending.resolve("b", { text: "B", isError: false });
    expect((await c).text).toBe("B");
    const k = pending.claim("read", { path: "1", x: 1 });
    pending.resolve("a", { text: "A", isError: false });
    expect((await k).text).toBe("A");
  });

  it("canonical input equality ignores key order and handles nesting", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    pending.expect({ callId: "a", toolName: "t", input: { a: 1, b: [{ y: 1, x: 2 }] } });
    pending.expect({ callId: "b", toolName: "t", input: { a: 2 } });
    const c = pending.claim("t", { b: [{ x: 2, y: 1 }], a: 1 });
    pending.resolve("a", { text: "A", isError: false });
    expect((await c).text).toBe("A");
    const n = pending.claim("t", null);
    pending.resolve("b", { text: "B", isError: false });
    expect((await n).text).toBe("B");
  });

  it("resolve of unknown callId returns false", () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    expect(pending.resolve("zz", { text: "x", isError: false })).toBe(false);
  });

  it("default_soft_timeout", async () => {
    vi.useFakeTimers();
    const pending = new PendingTools({ softTimeoutMs: MCP_SOFT_TIMEOUT_MS });
    expect(MCP_SOFT_TIMEOUT_MS).toBe(170000);
    pending.expect({ callId: "a", toolName: "read", input: {} });
    let out: unknown = null;
    void pending.claim("read", {}).then((o) => (out = o));
    await vi.advanceTimersByTimeAsync(169999);
    expect(out).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual({ text: STILL_RUNNING_TEXT, isError: false });
  });

  it("resolve before soft timeout cancels the timer", async () => {
    vi.useFakeTimers();
    const pending = new PendingTools({ softTimeoutMs: 100 });
    pending.expect({ callId: "a", toolName: "read", input: {} });
    const p = pending.claim("read", {});
    pending.resolve("a", { text: "ok", isError: false });
    expect((await p).text).toBe("ok");
    await vi.advanceTimersByTimeAsync(200);
    expect(pending.takeLateResults()).toEqual([]);
  });

  it("rejectAll clears early resolves and unclaimed expectations", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    pending.expect({ callId: "a", toolName: "read", input: {} });
    pending.expect({ callId: "b", toolName: "read", input: {} });
    pending.resolve("b", { text: "early", isError: false });
    pending.rejectAll(CANCELLED_TEXT);
    expect(pending.size).toBe(0);
    const r = await pending.claim("read", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No pending OpenCode tool call");
  });

  it("rejectAll also settles timed-out claims silently", async () => {
    const pending = new PendingTools({ softTimeoutMs: 5 });
    pending.expect({ callId: "a", toolName: "read", input: {} });
    await pending.claim("read", {});
    pending.rejectAll(CANCELLED_TEXT);
    expect(pending.resolve("a", { text: "x", isError: false })).toBe(false);
  });
});

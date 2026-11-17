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

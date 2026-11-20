import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { McpBridge, PendingTools } from "../../src/acp/mcp-bridge";

const proxy = path.resolve(__dirname, "../../agy-plugin/bridge-proxy.mjs");
let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  cleanup = [];
});

function env(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  delete base.AGY_ACP_BRIDGE_URL;
  delete base.AGY_ACP_BRIDGE_TOKEN;
  return { ...base, ...extra };
}

describe("bridge-proxy", () => {
  it("proxy_round_trip", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({
      tools: [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
      pending,
    });
    cleanup.push(() => bridge.close());
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [proxy],
      env: env({ AGY_ACP_BRIDGE_URL: bridge.url, AGY_ACP_BRIDGE_TOKEN: bridge.token }),
      stderr: "pipe",
    });
    const client = new Client({ name: "t", version: "1" });
    await client.connect(transport);
    cleanup.push(() => client.close());
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(["read"]);
    pending.expect({ callId: "t1", toolName: "read", input: { path: "a" } });
    const call = client.callTool({ name: "read", arguments: { path: "a" } });
    setTimeout(() => pending.resolve("t1", { text: "ok", isError: false }), 30);
    const r: any = await call;
    expect(r.content[0].text).toBe("ok");
  });

  it("proxy stdout contains only JSON-RPC lines", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: [{ name: "ping", inputSchema: { type: "object" } }], pending });
    cleanup.push(() => bridge.close());
    const child = spawn(process.execPath, [proxy], {
      env: env({ AGY_ACP_BRIDGE_URL: bridge.url, AGY_ACP_BRIDGE_TOKEN: bridge.token }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanup.push(async () => void child.kill());
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    });
    await new Promise((r) => setTimeout(r, 300));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await new Promise((r) => setTimeout(r, 300));
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
    send("not an object json");
    child.stdin.write("garbage{\n\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(child.exitCode).toBeNull();
  });

  it("proxy answers a pre-initialize server/discover with the request id", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: [{ name: "ping", inputSchema: { type: "object" } }], pending });
    cleanup.push(() => bridge.close());
    const child = spawn(process.execPath, [proxy], {
      env: env({ AGY_ACP_BRIDGE_URL: bridge.url, AGY_ACP_BRIDGE_TOKEN: bridge.token }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanup.push(async () => void child.kill());
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 300));
    const reply = JSON.parse(out.split("\n").filter(Boolean)[0]);
    expect(reply.id).toBe(1);
    expect(reply.error).toBeDefined();
    expect(child.exitCode).toBeNull();
  });

  it("proxy_fails_without_bridge", async () => {
    const pending = new PendingTools({ softTimeoutMs: null });
    const bridge = await McpBridge.start({ tools: [], pending });
    const { url, token } = bridge;
    await bridge.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [proxy],
      env: env({ AGY_ACP_BRIDGE_URL: url, AGY_ACP_BRIDGE_TOKEN: token }),
      stderr: "pipe",
    });
    const client = new Client({ name: "t", version: "1" });
    await expect(client.connect(transport)).rejects.toThrow(/OpenCode bridge unreachable/);
    await client.close().catch(() => {});
  });

  it("proxy fails with missing env", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [proxy], env: env({}), stderr: "pipe" });
    const client = new Client({ name: "t", version: "1" });
    await expect(client.connect(transport)).rejects.toThrow(/OpenCode bridge unreachable/);
    await client.close().catch(() => {});
  });

  it("proxy exits 1 on connection failure", async () => {
    const child = spawn(process.execPath, [proxy], {
      env: env({ AGY_ACP_BRIDGE_URL: "http://127.0.0.1:1/mcp", AGY_ACP_BRIDGE_TOKEN: "t" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) + "\n");
    const code: number = await new Promise((r) => child.on("exit", (c) => r(c ?? -1)));
    expect(code).toBe(1);
    const reply = JSON.parse(out.trim());
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32000 } });
    expect(reply.error.message).toContain("OpenCode bridge unreachable");
    expect(err).toContain("OpenCode bridge unreachable");
  });

  it("proxy exits 1 on connection failure for a notification without writing a reply", async () => {
    const child = spawn(process.execPath, [proxy], {
      env: env({ AGY_ACP_BRIDGE_URL: "http://127.0.0.1:1/mcp", AGY_ACP_BRIDGE_TOKEN: "t" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const code: number = await new Promise((r) => child.on("exit", (c) => r(c ?? -1)));
    expect(code).toBe(1);
    expect(out).toBe("");
  });

  it("proxy_has_no_package_imports", () => {
    const src = readFileSync(proxy, "utf8");
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.startsWith("node:")).toBe(true);
    expect(src).not.toMatch(/require\(/);
  });
});

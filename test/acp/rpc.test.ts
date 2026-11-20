import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonRpcConnection, JsonRpcError } from "../../src/acp/rpc";

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = new JsonRpcConnection(input, output);
  const written: any[] = [];
  let buf = "";
  output.on("data", (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      written.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`);
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return { input, output, conn, written, send, tick };
}

describe("JsonRpcConnection", () => {
  it("traces outgoing and incoming lines when a trace callback is given", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: [string, string][] = [];
    const conn = new JsonRpcConnection(input, output, (dir, line) => seen.push([dir, line]));
    const p = conn.request("m", { a: 1 });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: 2 })}\n`);
    await expect(p).resolves.toBe(2);
    expect(seen).toEqual([
      ["out", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m", params: { a: 1 } })],
      ["in", JSON.stringify({ jsonrpc: "2.0", id: 1, result: 2 })],
    ]);
  });

  it("resolves request with result", async () => {
    const { conn, written, send, tick } = setup();
    const p = conn.request<{ ok: boolean }>("m", { a: 1 });
    await tick();
    expect(written[0]).toMatchObject({ jsonrpc: "2.0", method: "m", params: { a: 1 } });
    send({ jsonrpc: "2.0", id: written[0].id, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects with JsonRpcError on error", async () => {
    const { conn, written, send, tick } = setup();
    const p = conn.request("m", {});
    await tick();
    send({ jsonrpc: "2.0", id: written[0].id, error: { code: -5, message: "bad", data: 1 } });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect(err.code).toBe(-5);
    expect(err.message).toBe("bad");
    expect(err.data).toBe(1);
  });

  it("times out and ignores late reply", async () => {
    const { conn, written, send, tick } = setup();
    const p = conn.request("m", {}, { timeoutMs: 10 });
    await expect(p).rejects.toThrow(/timed out/);
    send({ jsonrpc: "2.0", id: written[0].id, result: 1 });
    await tick();
    expect(written).toHaveLength(1);
  });

  it("rejects on abort and ignores late reply", async () => {
    const { conn, written, send, tick } = setup();
    const ac = new AbortController();
    const p = conn.request("m", {}, { signal: ac.signal });
    await tick();
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
    send({ jsonrpc: "2.0", id: written[0].id, result: 1 });
    await tick();
    const pre = new AbortController();
    pre.abort();
    await expect(conn.request("m", {}, { signal: pre.signal })).rejects.toThrow(/abort/i);
    expect(written).toHaveLength(1);
  });

  it("parses partial lines and multiple messages per chunk", async () => {
    const { conn, input, tick } = setup();
    const got: unknown[] = [];
    conn.onNotification("n", (p) => got.push(p));
    const a = JSON.stringify({ jsonrpc: "2.0", method: "n", params: 1 });
    const b = JSON.stringify({ jsonrpc: "2.0", method: "n", params: 2 });
    input.write(a.slice(0, 10));
    await tick();
    input.write(`${a.slice(10)}\n${b}\n`);
    await tick();
    expect(got).toEqual([1, 2]);
  });

  it("skips non-JSON lines", async () => {
    const { conn, input, tick } = setup();
    const got: unknown[] = [];
    conn.onNotification("n", (p) => got.push(p));
    input.write("not json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "n", params: 3 })}\n`);
    await tick();
    expect(got).toEqual([3]);
  });

  it("unsubscribes notification handlers and ignores unhandled notifications", async () => {
    const { conn, input, tick } = setup();
    const got: unknown[] = [];
    const off = conn.onNotification("n", (p) => got.push(p));
    off();
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "n", params: 1 })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "zzz" })}\n`);
    await tick();
    expect(got).toEqual([]);
  });

  it("answers inbound requests via handler, unknown method -32601, throwing handler -32603", async () => {
    const { conn, written, send, tick } = setup();
    conn.onRequest("ping", async (p: any) => ({ pong: p.x }));
    conn.onRequest("boom", () => {
      throw new Error("kaput");
    });
    send({ jsonrpc: "2.0", id: 7, method: "ping", params: { x: 1 } });
    send({ jsonrpc: "2.0", id: 8, method: "nope" });
    send({ jsonrpc: "2.0", id: 9, method: "boom" });
    await tick();
    expect(written.find((m) => m.id === 7)).toMatchObject({ result: { pong: 1 } });
    expect(written.find((m) => m.id === 8).error.code).toBe(-32601);
    expect(written.find((m) => m.id === 9).error).toMatchObject({ code: -32603, message: "kaput" });
  });

  it("close(err) rejects in-flight requests; later requests reject; notify is no-op", async () => {
    const { conn, written, tick } = setup();
    const p = conn.request("m", {});
    await tick();
    conn.close(new Error("x"));
    await expect(p).rejects.toThrow("x");
    await expect(conn.closed).resolves.toBeInstanceOf(Error);
    await expect(conn.request("m", {})).rejects.toThrow();
    const n = written.length;
    conn.notify("n", {});
    await tick();
    expect(written).toHaveLength(n);
  });

  it("input end resolves closed and rejects pending", async () => {
    const { conn, input, tick } = setup();
    const p = conn.request("m", {});
    await tick();
    input.end();
    await expect(conn.closed).resolves.toBeUndefined();
    await expect(p).rejects.toThrow();
  });

  it("notify writes a notification", async () => {
    const { conn, written, tick } = setup();
    conn.notify("n", { a: 1 });
    await tick();
    expect(written[0]).toEqual({ jsonrpc: "2.0", method: "n", params: { a: 1 } });
  });
});

describe("fake-acp-agent fixture", () => {
  it("replies to initialize and logs messages", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fake-acp-"));
    const scenario = path.join(dir, "s.json");
    const log = path.join(dir, "log.ndjson");
    writeFileSync(scenario, JSON.stringify([{ expect: "initialize", reply: { protocolVersion: 1 } }]));
    const child = spawn(process.execPath, [path.resolve("test/fixtures/fake-acp-agent.mjs")], {
      env: { ...process.env, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: log },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const conn = new JsonRpcConnection(child.stdout, child.stdin);
    const res = await conn.request("initialize", { protocolVersion: 1 }, { timeoutMs: 5000 });
    expect(res).toEqual({ protocolVersion: 1 });
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.kind === "start" && l.env.GEMINI_API_KEY === "unset")).toBe(true);
    expect(lines.some((l) => l.kind === "recv" && l.message.method === "initialize")).toBe(true);
  });
});

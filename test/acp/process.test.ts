import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgyAcpProcess,
  AgyProcessPool,
  applyAgyAuthEnv,
  buildAgyEnv,
  type AgyProcessOptions,
  type PoolEntry,
} from "../../src/acp/process";

const fixture = path.resolve(__dirname, "../fixtures/fake-acp-agent.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INIT = { expect: "initialize", reply: { protocolVersion: 1, agentCapabilities: { loadSession: true } } };
const AUTH = { expect: "authenticate", reply: {} };

let procs: AgyAcpProcess[] = [];

function setup(steps: unknown[], extra: Partial<AgyProcessOptions> = {}, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agy-proc-"));
  const scenario = path.join(dir, "scenario.json");
  const log = path.join(dir, "log.ndjson");
  writeFileSync(scenario, JSON.stringify(steps));
  const opts: AgyProcessOptions = {
    binaryPath: process.execPath,
    args: [fixture, "acp", "--agent", "opencode"],
    cwd: dir,
    env: {
      ...process.env,
      FAKE_ACP_SCENARIO: scenario,
      FAKE_ACP_LOG: log,
      FAKE_ACP_SKIP_BRIDGE: "1",
      AGY_ACP_BRIDGE_URL: "http://127.0.0.1:1/mcp",
      AGY_ACP_BRIDGE_TOKEN: "tok",
      ...env,
    },
    ...extra,
  };
  const entries = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const recv = (method: string) => entries().filter((e) => e.kind === "recv" && e.message.method === method);
  const start = async () => {
    const p = await AgyAcpProcess.start(opts);
    procs.push(p);
    return p;
  };
  return { opts, entries, recv, start };
}

afterEach(async () => {
  await Promise.all(procs.map((p) => p.dispose()));
  procs = [];
});

describe("buildAgyEnv", () => {
  const o = { bridgeUrl: "http://x", bridgeToken: "t" };
  it("sets bridge vars without mutating base", () => {
    const base = { A: "1", GOOGLE_API_KEY: "g" };
    const env = buildAgyEnv(base, { ...o, authMethod: "oauth-personal" });
    expect(env.AGY_ACP_BRIDGE_URL).toBe("http://x");
    expect(env.AGY_ACP_BRIDGE_TOKEN).toBe("t");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.AGY_ADC_AUTH).toBeUndefined();
    expect(env.A).toBe("1");
    expect(base).toEqual({ A: "1", GOOGLE_API_KEY: "g" });
  });
  it("api key replaces GOOGLE_API_KEY", () => {
    const env = buildAgyEnv({ GOOGLE_API_KEY: "g" }, { ...o, authMethod: "gemini-api-key", apiKey: "k" });
    expect(env.GEMINI_API_KEY).toBe("k");
    expect("GOOGLE_API_KEY" in env).toBe(false);
  });
  it("agent-platform sets ADC", () => {
    expect(buildAgyEnv({}, { ...o, authMethod: "agent-platform" }).AGY_ADC_AUTH).toBe("true");
  });
});

describe("applyAgyAuthEnv", () => {
  it("leaves oauth-personal env untouched and does not mutate base", () => {
    const base = { A: "1", GOOGLE_API_KEY: "g" };
    const env = applyAgyAuthEnv(base, { authMethod: "oauth-personal" });
    expect(env).toEqual({ A: "1", GOOGLE_API_KEY: "g" });
    expect(env).not.toBe(base);
    expect("AGY_ACP_BRIDGE_URL" in env).toBe(false);
  });
  it("api key replaces GOOGLE_API_KEY", () => {
    const env = applyAgyAuthEnv({ GOOGLE_API_KEY: "g" }, { authMethod: "gemini-api-key", apiKey: "k" });
    expect(env.GEMINI_API_KEY).toBe("k");
    expect("GOOGLE_API_KEY" in env).toBe(false);
  });
  it("agent-platform sets ADC", () => {
    expect(applyAgyAuthEnv({}, { authMethod: "agent-platform" }).AGY_ADC_AUTH).toBe("true");
  });
});

describe("AgyAcpProcess", () => {
  it("spawns_with_agent_args", async () => {
    const t = setup([INIT]);
    await t.start();
    const start = t.entries().find((e) => e.kind === "start");
    expect(start.argv).toEqual(["acp", "--agent", "opencode"]);
    expect(start.env.AGY_ACP_BRIDGE_URL).toBe("http://127.0.0.1:1/mcp");
    expect(start.env.AGY_ACP_BRIDGE_TOKEN).toBe("set");
  });

  it("start_initializes", async () => {
    const t = setup([INIT]);
    const p = await t.start();
    const init = t.recv("initialize")[0].message.params;
    expect(init.protocolVersion).toBe(1);
    expect(init.clientCapabilities).toBeDefined();
    expect(init.clientCapabilities.fs).toBeUndefined();
    expect(init.clientCapabilities.terminal).toBeUndefined();
    expect(p.initializeResult.agentCapabilities?.loadSession).toBe(true);
    expect(t.recv("authenticate")).toHaveLength(0);
  });

  it("writes a redacted debug log of spawn, rpc traffic and exit when AGY_ACP_DEBUG=1", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "agy-dbg-")), "debug.log");
    const t = setup([INIT], {}, {
      AGY_ACP_DEBUG: "1",
      AGY_ACP_DEBUG_FILE: file,
      AGY_ACP_BRIDGE_TOKEN: "sekret-tok-123",
    });
    const p = await t.start();
    await p.dispose();
    await p.exited;
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/ spawn pid=\d+ /);
    expect(text).toMatch(/ rpc> .*"method":"initialize"/);
    expect(text).toMatch(/ rpc< .*"protocolVersion":1/);
    expect(text).toMatch(/ exit code=/);
    expect(text).not.toContain("sekret-tok-123");
  });

  it("writes no debug log without AGY_ACP_DEBUG", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "agy-dbg-")), "debug.log");
    const t = setup([INIT], {}, { AGY_ACP_DEBUG: undefined, AGY_ACP_DEBUG_FILE: file });
    const p = await t.start();
    await p.dispose();
    expect(existsSync(file)).toBe(false);
  });

  it("start_authenticates", async () => {
    const t = setup([INIT, AUTH], { authMethod: "gemini-api-key" });
    await t.start();
    expect(t.recv("authenticate")[0].message.params).toEqual({ methodId: "gemini-api-key" });
  });

  it("uses default spawn args when none given", async () => {
    await expect(
      AgyAcpProcess.start({ binaryPath: "/nonexistent/agy-bin", cwd: os.tmpdir(), env: process.env }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("new_session_no_mcp_servers", async () => {
    const t = setup([
      INIT,
      {
        expect: "session/new",
        reply: {
          sessionId: "s1",
          models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "M1" }, { modelId: "m2" }] },
          modes: { currentModeId: "default" },
        },
      },
    ]);
    const p = await t.start();
    const res = await p.newSession({ cwd: "/w", systemPromptAppend: "be nice" });
    const sent = t.recv("session/new")[0].message.params;
    expect(sent.mcpServers).toEqual([]);
    expect(sent.cwd).toBe("/w");
    expect(sent._meta.antigravity.systemPrompt.append).toBe("be nice");
    expect(res).toEqual({
      sessionId: "s1",
      models: [{ modelId: "m1", name: "M1" }, { modelId: "m2" }],
      currentModelId: "m1",
    });
  });

  it("omits _meta without system prompt", async () => {
    const t = setup([INIT, { expect: "session/new", reply: { sessionId: "s1" } }]);
    const p = await t.start();
    const res = await p.newSession({ cwd: "/w" });
    expect(t.recv("session/new")[0].message.params._meta).toBeUndefined();
    expect(res.models).toEqual([]);
  });

  it("new_session_selects_model_tier_mode", async () => {
    const t = setup([
      INIT,
      {
        expect: "session/new",
        reply: { sessionId: "s1", models: { currentModelId: "m1", availableModels: [] }, modes: { currentModeId: "auto" } },
      },
      { expect: "session/set_model", reply: {} },
      { expect: "session/set_config_option", reply: {} },
      { expect: "session/set_config_option", reply: {} },
    ]);
    const p = await t.start();
    await p.newSession({ cwd: "/w", modelId: "claude-sonnet-4-6", tier: "low" });
    const methods = t
      .entries()
      .filter((e) => e.kind === "recv" && e.message.method?.startsWith("session/") && e.message.method !== "session/new")
      .map((e) => [e.message.method, e.message.params]);
    expect(methods).toEqual([
      ["session/set_model", { sessionId: "s1", modelId: "claude-sonnet-4-6" }],
      ["session/set_config_option", { sessionId: "s1", configId: "thought_level", value: "low" }],
      ["session/set_config_option", { sessionId: "s1", configId: "mode", value: "default" }],
    ]);
  });

  it("reads mode from configOptions and skips selections when unnecessary", async () => {
    const t = setup([
      INIT,
      {
        expect: "session/new",
        reply: {
          sessionId: "s1",
          models: { currentModelId: "m1", availableModels: [] },
          configOptions: [{ id: "mode", currentValue: "default" }],
        },
      },
      {
        expect: "session/new",
        reply: { sessionId: "s2", configOptions: [{ id: "mode", currentValue: "auto" }] },
      },
      { expect: "session/set_config_option", reply: {} },
      { expect: "session/new", reply: { sessionId: "s3", configOptions: [{ id: "other" }] } },
    ]);
    const p = await t.start();
    await p.newSession({ cwd: "/w", modelId: "m1" });
    expect(t.recv("session/set_model")).toHaveLength(0);
    expect(t.recv("session/set_config_option")).toHaveLength(0);
    await p.newSession({ cwd: "/w" });
    expect(t.recv("session/set_config_option")).toHaveLength(1);
    await p.newSession({ cwd: "/w" });
    expect(t.recv("session/set_config_option")).toHaveLength(1);
  });

  it("startup_timeout", async () => {
    const t = setup([{ expect: "initialize" }], { startupTimeoutMs: 50 });
    await expect(AgyAcpProcess.start(t.opts)).rejects.toThrow(/did not start within/);
  });

  it("idle_kill and touch postpones it", async () => {
    const t = setup([INIT], { idleTimeoutMs: 300 });
    const p = await t.start();
    await sleep(200);
    p.touch();
    const early = await Promise.race([p.exited.then(() => "exited"), sleep(200).then(() => "alive")]);
    expect(early).toBe("alive");
    const exit = await p.exited;
    expect(typeof exit.stderrTail).toBe("string");
  });

  it("idle timer does not fire during prompt", async () => {
    const t = setup(
      [INIT, { expect: "session/prompt", delayMs: 400, reply: { stopReason: "end_turn", usage: { inputTokens: 3 } } }],
      { idleTimeoutMs: 100 },
    );
    const p = await t.start();
    const res = await p.prompt("s1", [{ type: "text", text: "hi" }]);
    expect(res).toEqual({ stopReason: "end_turn", usage: { inputTokens: 3 } });
    expect(t.recv("session/prompt")[0].message.params).toEqual({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hi" }],
    });
  });

  it("exit_rejects_inflight", async () => {
    const t = setup([INIT, { expect: "session/prompt", stderr: "boom", exit: 3 }]);
    const p = await t.start();
    await expect(p.prompt("s1", [])).rejects.toThrow(/boom/);
    const exit = await p.exited;
    expect(exit.code).toBe(3);
    expect(exit.stderrTail).toContain("boom");
  });

  it("routes updates by session and unsubscribes", async () => {
    const update = (sid: string, text: string) => ({
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    });
    const t = setup([
      INIT,
      {
        expect: "session/prompt",
        notify: [update("a", "1"), update("b", "x"), update("a", "2")],
        reply: { stopReason: "end_turn" },
      },
      { expect: "session/prompt", notify: [update("a", "3")], reply: { stopReason: "end_turn" } },
    ]);
    const p = await t.start();
    const got: unknown[] = [];
    const off = p.onUpdate("a", (u) => got.push((u as any).content.text));
    p.onUpdate("a", () => {
      throw new Error("faulty");
    });
    await p.prompt("a", []);
    expect(got).toEqual(["1", "2"]);
    off();
    await p.prompt("a", []);
    expect(got).toEqual(["1", "2"]);
  });

  it("cancel notifies and closeSession requests", async () => {
    const t = setup([
      INIT,
      { expect: "session/close", reply: {} },
      { expect: "session/close", error: { code: -1, message: "gone" } },
    ]);
    const p = await t.start();
    p.cancel("s1");
    await p.closeSession("s1");
    await p.closeSession("s1");
    await sleep(20);
    expect(t.recv("session/cancel")[0].message.params).toEqual({ sessionId: "s1" });
    expect(t.recv("session/close")).toHaveLength(2);
  });

  const permStep = [
    INIT,
    { expect: "session/prompt", toolCall: { name: "run_command", toolCallId: "t1" }, reply: { stopReason: "end_turn" } },
  ];
  const permReply = (t: ReturnType<typeof setup>) =>
    t.entries().find((e) => e.kind === "recv" && e.message.id === "agent-1" && e.message.method === undefined).message
      .result;

  it("permission_dispatch to handler", async () => {
    const t = setup(permStep);
    const p = await t.start();
    let seen: any;
    p.onPermissionRequest(async (r) => {
      seen = r;
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
    await p.prompt("s1", []);
    expect(seen.sessionId).toBe("s1");
    expect(seen.toolCall.toolCallId).toBe("t1");
    expect(permReply(t)).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("permission without handler rejects once", async () => {
    const t = setup(permStep);
    const p = await t.start();
    await p.prompt("s1", []);
    expect(permReply(t)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
  });

  it("permission without reject option cancels", async () => {
    const t = setup([
      INIT,
      { expect: "session/prompt", reply: { stopReason: "end_turn" } },
    ]);
    const p = await t.start();
    // Drive the registered request handler path directly through a second fake option set.
    const conn = (p as any).conn;
    const handler = (conn as any).requestHandlers.get("session/request_permission");
    expect(await handler({ sessionId: "s", toolCall: { toolCallId: "x" }, options: [] })).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  it("dispose is idempotent and resolves after exit", async () => {
    const t = setup([INIT]);
    const p = await t.start();
    await Promise.all([p.dispose(), p.dispose()]);
    await p.dispose();
    await expect(p.exited).resolves.toBeDefined();
  });

  it("dispose SIGKILLs a child that ignores SIGTERM", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agy-stubborn-"));
    const script = path.join(dir, "stubborn.mjs");
    writeFileSync(
      script,
      `process.on("SIGTERM", () => {});
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (l) => { const m = JSON.parse(l); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n"); });
setInterval(() => {}, 1000);`,
    );
    const p = await AgyAcpProcess.start({
      binaryPath: process.execPath,
      args: [script],
      cwd: dir,
      env: process.env,
    });
    procs.push(p);
    await p.dispose();
    const exit = await p.exited;
    expect(exit.signal).toBe("SIGKILL");
  }, 10_000);
});

describe("AgyProcessPool", () => {
  function entry(name: string) {
    const e = { name, disposed: 0, dispose: async () => void e.disposed++ };
    return e;
  }

  it("reuses entries for same key and fingerprint", async () => {
    const pool = new AgyProcessPool<ReturnType<typeof entry>>();
    let calls = 0;
    const create = async () => (calls++, entry("a"));
    const [a, b] = await Promise.all([pool.acquire("k", "f", create), pool.acquire("k", "f", create)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(pool.get("k")).toBe(a);
    expect(await pool.acquire("k", "f", create)).toBe(a);
    expect(calls).toBe(1);
  });

  it("replaces on fingerprint change", async () => {
    const pool = new AgyProcessPool<ReturnType<typeof entry>>();
    const a = await pool.acquire("k", "f1", async () => entry("a"));
    const b = await pool.acquire("k", "f2", async () => entry("b"));
    expect(a.disposed).toBe(1);
    expect(b).not.toBe(a);
    expect(pool.get("k")).toBe(b);
  });

  it("separates keys and disposes all", async () => {
    const pool = new AgyProcessPool<ReturnType<typeof entry>>();
    const a = await pool.acquire("k1", "f", async () => entry("a"));
    const b = await pool.acquire("k2", "f", async () => entry("b"));
    expect(a).not.toBe(b);
    await pool.disposeAll();
    expect([a.disposed, b.disposed]).toEqual([1, 1]);
    expect(pool.get("k1")).toBeUndefined();
  });

  it("clears the key when create rejects and allows retry", async () => {
    const pool = new AgyProcessPool<PoolEntry>();
    await expect(pool.acquire("k", "f", async () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    expect(pool.get("k")).toBeUndefined();
    const e = { dispose: async () => {} };
    expect(await pool.acquire("k", "f", async () => e)).toBe(e);
  });

  it("release disposes one entry and tolerates missing or failed ones", async () => {
    const pool = new AgyProcessPool<ReturnType<typeof entry>>();
    const a = await pool.acquire("k", "f", async () => entry("a"));
    await pool.release("k");
    await pool.release("missing");
    expect(a.disposed).toBe(1);
    const failing = pool.acquire("x", "f", async () => Promise.reject(new Error("e")));
    await pool.release("x");
    await expect(failing).rejects.toThrow("e");
    // fingerprint change over a failed previous create still creates
    const bad = pool.acquire("y", "f1", async () => Promise.reject(new Error("e")));
    const next = pool.acquire("y", "f2", async () => entry("n"));
    await expect(bad).rejects.toThrow("e");
    expect((await next).name).toBe("n");
  });
});

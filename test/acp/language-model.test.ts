import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANCELLED_TEXT, STILL_RUNNING_TEXT } from "../../src/acp/constants";
import { BRIDGE_NOT_CONNECTED_TEXT, TOS_DISABLED_TEXT } from "../../src/acp/errors";
import { AgyAcpLanguageModel, type AgyAcpDeps, type LiveSession } from "../../src/acp/language-model";
import { AgyProcessPool } from "../../src/acp/process";
import { lockSession } from "../../src/acp/session-lock";
import { SessionStore } from "../../src/acp/session-sync";

const fixture = path.resolve(__dirname, "../fixtures/fake-acp-agent.mjs");

const INIT = { expect: "initialize", reply: { protocolVersion: 1 } };
const AUTH = { expect: "authenticate", reply: {} };
const MODELS = [{ modelId: "m1", name: "M1" }, { modelId: "claude-sonnet-4-6" }];
const NEW = { expect: "session/new", reply: { sessionId: "s1", models: { availableModels: MODELS, currentModelId: "m1" } } };
const CLOSE = { expect: "session/close", reply: {} };
const END = { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 4, thoughtTokens: 1 } };

function chunk(text: string, kind = "agent_message_chunk", sessionId = "s1") {
  return { method: "session/update", params: { sessionId, update: { sessionUpdate: kind, content: { type: "text", text } } } };
}

const READ_TOOL: LanguageModelV3FunctionTool = {
  type: "function",
  name: "read",
  description: "Read a file\nmore detail",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const user = (text: string): LanguageModelV3Message => ({ role: "user", content: [{ type: "text", text }] });
const system = (content: string): LanguageModelV3Message => ({ role: "system", content });
const assistantCall = (id: string, input: unknown, toolName = "read"): LanguageModelV3Message => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input }],
});
const toolResult = (id: string, value: string, toolName = "read"): LanguageModelV3Message => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }],
});

interface Harness {
  dir: string;
  deps: AgyAcpDeps;
  model: AgyAcpLanguageModel;
  entries: () => any[];
  recv: (method: string) => any[];
  replies: () => any[];
  bridge: (method: string) => any[];
  starts: () => any[];
}

let pools: AgyProcessPool<LiveSession>[] = [];
let extraCleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(pools.map((p) => p.disposeAll()));
  await Promise.all(extraCleanup.map((f) => f()));
  pools = [];
  extraCleanup = [];
});

function harness(
  steps: unknown[],
  o: {
    env?: NodeJS.ProcessEnv;
    deps?: Partial<AgyAcpDeps>;
    modelId?: string;
    pool?: AgyProcessPool<LiveSession>;
    store?: SessionStore;
  } = {},
): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agy-lm-"));
  const scenario = path.join(dir, "scenario.json");
  const log = path.join(dir, "log.ndjson");
  writeFileSync(scenario, JSON.stringify(steps));
  const launcher = path.join(dir, "agy");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const pool = o.pool ?? new AgyProcessPool<LiveSession>();
  pools.push(pool);
  const deps: AgyAcpDeps = {
    pool,
    store: o.store ?? new SessionStore(path.join(dir, "sessions.json")),
    agyPath: launcher,
    cwd: dir,
    env: { PATH: process.env.PATH, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: log, ...o.env },
    auth: async () => ({ method: "oauth-personal", identity: "none" }),
    ensurePlugin: vi.fn(async () => {}),
    log: vi.fn(),
    ...o.deps,
  };
  const entries = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  return {
    dir,
    deps,
    model: new AgyAcpLanguageModel(o.modelId ?? "m1", deps),
    entries,
    recv: (method) => entries().filter((e) => e.kind === "recv" && e.message.method === method),
    replies: () => entries().filter((e) => e.kind === "recv" && e.message.method === undefined),
    bridge: (method) => entries().filter((e) => e.kind === "bridge" && e.method === method),
    starts: () => entries().filter((e) => e.kind === "start"),
  };
}

function opts(prompt: LanguageModelV3Message[], extra: Partial<LanguageModelV3CallOptions> = {}, session = "ses-1") {
  return {
    prompt,
    headers: session === "" ? {} : { "X-OpenCode-Session-Id": session },
    ...extra,
  } as LanguageModelV3CallOptions;
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

async function run(h: Harness, o: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamPart[]> {
  return collect((await h.model.doStream(o)).stream);
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const finishOf = (parts: LanguageModelV3StreamPart[]) => parts.find((p) => p.type === "finish") as any;
const errorsOf = (parts: LanguageModelV3StreamPart[]) => parts.filter((p) => p.type === "error") as any[];
const promptTexts = (h: Harness) =>
  h.recv("session/prompt").map((e) => e.message.params.prompt.map((b: any) => b.text ?? `[${b.type}]`));
const bridgeTexts = (h: Harness) =>
  h.bridge("tools/call").map((e) => e.response?.result?.content?.[0]?.text as string | undefined);
const permissionReplies = (h: Harness) =>
  h.replies().filter((e) => e.message.result?.outcome).map((e) => e.message.result.outcome);

describe("AgyAcpLanguageModel", () => {
  it("streams_text_and_finishes", async () => {
    let logExistedAtInstall = true;
    const h = harness(
      [
        INIT,
        AUTH,
        NEW,
        { expect: "session/prompt", notify: [chunk("thinking", "agent_thought_chunk"), chunk("Hel"), chunk("lo")], reply: END },
      ],
      { env: {} },
    );
    h.deps.ensurePlugin = vi.fn(async () => {
      logExistedAtInstall = h.starts().length > 0;
    });
    expect(h.model.specificationVersion).toBe("v3");
    expect(h.model.provider).toBe("google-agy-acp");
    expect(h.model.modelId).toBe("m1");
    expect(h.model.supportedUrls).toEqual({});

    const parts = await run(h, opts([system("You are OpenCode."), system("Be terse."), user("hi")], { tools: [READ_TOOL] }));
    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(parts.filter((p) => p.type === "text-delta").map((p: any) => p.delta)).toEqual(["Hel", "lo"]);
    expect(parts.some((p) => p.type === "reasoning-delta")).toBe(true);
    expect(parts.filter((p) => p.type === "text-start")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
    const finish = finishOf(parts);
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
    expect(finish.usage.inputTokens.total).toBe(10);
    expect(finish.usage.outputTokens.reasoning).toBe(1);
    expect(parts[parts.length - 1]!.type).toBe("finish");

    expect(h.deps.ensurePlugin).toHaveBeenCalledTimes(1);
    expect(logExistedAtInstall).toBe(false);
    const start = h.starts()[0];
    expect(start.argv).toEqual(["acp", "--agent", "opencode"]);
    expect(start.env.AGY_ACP_BRIDGE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(start.env.AGY_ACP_BRIDGE_TOKEN).toBe("set");
    const newParams = h.recv("session/new")[0].message.params;
    expect(newParams.mcpServers).toEqual([]);
    const append: string = newParams._meta.antigravity.systemPrompt.append;
    expect(append.startsWith("You are OpenCode.\n\nBe terse.")).toBe(true);
    expect(append).toContain("- read: Read a file");
    expect(h.recv("authenticate")[0].message.params).toEqual({ methodId: "oauth-personal" });
    expect(promptTexts(h)).toEqual([["hi"]]);

    const record = await h.deps.store.get("ses-1");
    expect(record).toMatchObject({ agySessionId: "s1", interrupted: false });
    expect(record!.messageHashes).toHaveLength(1);
  });

  it("bridge_tool_round_trip", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      {
        expect: "session/prompt",
        callMcp: { tool: "read", args: { path: "a" }, toolCallId: "t1" },
        notifyAfter: [chunk("done")],
        reply: END,
      },
    ]);
    const history = [user("read a")];
    const first = await run(h, opts(history, { tools: [READ_TOOL] }));
    const call = first.find((p) => p.type === "tool-call") as any;
    expect(call).toEqual({ type: "tool-call", toolCallId: "t1", toolName: "read", input: '{"path":"a"}' });
    expect(call.providerExecuted).toBeUndefined();
    const f1 = finishOf(first);
    expect(f1.finishReason.unified).toBe("tool-calls");
    expect(f1.usage.inputTokens.total).toBeUndefined();
    expect(f1.usage.outputTokens.total).toBeUndefined();
    expect(permissionReplies(h)).toEqual([{ outcome: "selected", optionId: "allow" }]);

    const second = await run(
      h,
      opts([...history, assistantCall("t1", { path: "a" }), toolResult("t1", "file A")], { tools: [READ_TOOL] }),
    );
    expect(bridgeTexts(h)).toEqual(["file A"]);
    expect(second.filter((p) => p.type === "text-delta").map((p: any) => p.delta)).toEqual(["done"]);
    expect(finishOf(second).finishReason.unified).toBe("stop");
    expect(h.recv("session/prompt")).toHaveLength(1);
    expect((await h.deps.store.get("ses-1"))!.messageHashes).toHaveLength(3);
  });

  it("emits concurrent bridge calls in one step and resolves them in issue order", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      {
        expect: "session/prompt",
        callMcps: [
          { tool: "read", args: { path: "a" }, toolCallId: "t1" },
          { tool: "read", args: { path: "b" }, toolCallId: "t2" },
        ],
        reply: END,
      },
    ]);
    const first = await run(h, opts([user("read both")], { tools: [READ_TOOL] }));
    expect(first.filter((p) => p.type === "tool-call").map((p: any) => p.toolCallId)).toEqual(["t1", "t2"]);
    expect(finishOf(first).finishReason.unified).toBe("tool-calls");

    const live = h.deps.pool.get("ses-1")!;
    const resolve = vi.spyOn(live.pending, "resolve");
    const second = await run(
      h,
      opts(
        [
          user("read both"),
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "t1", toolName: "read", input: { path: "a" } },
              { type: "tool-call", toolCallId: "t2", toolName: "read", input: { path: "b" } },
            ],
          },
          {
            role: "tool",
            content: [
              { type: "tool-result", toolCallId: "t2", toolName: "read", output: { type: "text", value: "B" } },
              { type: "tool-result", toolCallId: "t1", toolName: "read", output: { type: "text", value: "A" } },
            ],
          },
        ],
        { tools: [READ_TOOL] },
      ),
    );
    expect(resolve.mock.calls.map((c) => c[0])).toEqual(["t1", "t2"]);
    expect(finishOf(second).finishReason.unified).toBe("stop");
    expect(bridgeTexts(h).sort()).toEqual(["A", "B"]);
  });

  it("late_result_prepended", async () => {
    const h = harness(
      [
        INIT,
        AUTH,
        NEW,
        { expect: "session/prompt", callMcp: { tool: "read", args: { path: "a" }, toolCallId: "t1" }, reply: END },
        { expect: "session/prompt", notify: [chunk("thanks")], reply: END },
      ],
      { deps: { softTimeoutMs: 20 } },
    );
    const history = [user("read a")];
    const first = await run(h, opts(history, { tools: [READ_TOOL] }));
    expect(finishOf(first).finishReason.unified).toBe("tool-calls");
    await waitFor(() => bridgeTexts(h)[0] === STILL_RUNNING_TEXT);

    const second = await run(
      h,
      opts([...history, assistantCall("t1", { path: "a" }), toolResult("t1", "late A")], { tools: [READ_TOOL] }),
    );
    expect(finishOf(second).finishReason.unified).toBe("stop");
    const prompts = promptTexts(h);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]![0]).toBe('<tool-result id="t1">\nlate A\n</tool-result>');
    expect((await h.deps.store.get("ses-1"))!.interrupted).toBe(false);
  });

  it("bridge_not_connected_is_error", async () => {
    const h = harness([INIT, AUTH, NEW], { env: { FAKE_ACP_SKIP_BRIDGE: "1" }, deps: { bridgeConnectTimeoutMs: 50 } });
    const parts = await run(h, opts([user("hi")], { tools: [READ_TOOL] }));
    const errors = errorsOf(parts);
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe(BRIDGE_NOT_CONNECTED_TEXT);
    expect(h.recv("session/prompt")).toHaveLength(0);
    expect(h.deps.pool.get("ses-1")).toBeUndefined();
    await waitFor(() => h.entries().length > 0);
  });

  it("plugin_install_failure_is_error", async () => {
    const h = harness([INIT, AUTH, NEW], {
      deps: { ensurePlugin: vi.fn(async () => Promise.reject(new Error("install failed"))) },
    });
    const parts = await run(h, opts([user("hi")]));
    const errors = errorsOf(parts);
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain("install failed");
    expect(errors[0].error.code).toBe("plugin_install");
    expect(h.starts()).toHaveLength(0);
  });

  it("abort_while_tool_pending", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      {
        expect: "session/prompt",
        callMcp: { tool: "read", args: { path: "a" }, toolCallId: "t1" },
        reply: { stopReason: "cancelled" },
      },
      { expect: "session/prompt", reply: END },
    ]);
    const ac = new AbortController();
    const history = [user("read a")];
    const first = await run(h, opts(history, { tools: [READ_TOOL], abortSignal: ac.signal }));
    expect(finishOf(first).finishReason.unified).toBe("tool-calls");
    const live = h.deps.pool.get("ses-1")!;
    await waitFor(() => live.claimed.has("t1"));

    ac.abort();
    await waitFor(() => h.recv("session/cancel").length === 1);
    await waitFor(() => bridgeTexts(h)[0] === CANCELLED_TEXT);
    const record = await waitForRecord(h, (r) => r?.interrupted === true);
    expect(record.interrupted).toBe(true);

    const second = await run(
      h,
      opts([...history, assistantCall("t1", { path: "a" }), toolResult("t1", "A"), user("again")], { tools: [READ_TOOL] }),
    );
    expect(finishOf(second).finishReason.unified).toBe("stop");
    const prompts = promptTexts(h);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]![0]).toContain("<conversation-checkpoint>");
    expect(prompts[1]![0]).toContain("again");
    expect((await h.deps.store.get("ses-1"))!.interrupted).toBe(false);
  });

  it("aborts mid-stream with an error part", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      { expect: "session/prompt", notify: [chunk("partial")], delayMs: 0, reply: undefined },
      { expect: "session/cancel", reply: undefined },
    ]);
    const ac = new AbortController();
    const { stream } = await h.model.doStream(opts([user("go")], { abortSignal: ac.signal }));
    const reader = stream.getReader();
    const parts: LanguageModelV3StreamPart[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      if (value.type === "text-delta") ac.abort(new Error("stop now"));
    }
    expect(errorsOf(parts)).toHaveLength(1);
    expect(errorsOf(parts)[0].error.message).toBe("stop now");
    await waitFor(() => h.recv("session/cancel").length === 1);
    expect((await h.deps.store.get("ses-1"))!.interrupted).toBe(true);
  });

  it("errors immediately when the signal is already aborted", async () => {
    const h = harness([INIT, AUTH, NEW]);
    const ac = new AbortController();
    ac.abort();
    const parts = await run(h, opts([user("go")], { abortSignal: ac.signal }));
    expect(errorsOf(parts)).toHaveLength(1);
    expect(h.recv("session/prompt")).toHaveLength(0);
  });

  it("cancels_turn_on_unlisted_builtin and permission_rejects_builtin", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      { expect: "session/prompt", toolCall: { name: "run_command", toolCallId: "r1", rawInput: { cmd: "ls" } }, reply: END },
    ]);
    const parts = await run(h, opts([user("ls")], { tools: [READ_TOOL] }));
    const errors = errorsOf(parts);
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain("run_command");
    expect(parts.some((p) => p.type === "tool-call")).toBe(false);
    await waitFor(() => h.recv("session/cancel").length === 1);
    await waitFor(() => permissionReplies(h).length === 1);
    expect(permissionReplies(h)).toEqual([{ outcome: "selected", optionId: "deny" }]);
    expect(h.deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("run_command"));
    expect((await h.deps.store.get("ses-1"))!.interrupted).toBe(true);
  });

  it("permission_rejects_foreign_server", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      {
        expect: "session/prompt",
        callMcp: { tool: "search", serverName: "lean-ctx_server", args: { q: "x" }, toolCallId: "f1" },
        notifyAfter: [chunk("could not")],
        reply: END,
      },
    ]);
    const parts = await run(h, opts([user("search")], { tools: [READ_TOOL] }));
    expect(permissionReplies(h)).toEqual([{ outcome: "selected", optionId: "deny" }]);
    const calls = parts.filter((p) => p.type === "tool-call") as any[];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolName: "lean-ctx_server/search", providerExecuted: true });
    const result = parts.find((p) => p.type === "tool-result") as any;
    expect(result).toMatchObject({ toolCallId: "f1", isError: true });
    expect(finishOf(parts).finishReason.unified).toBe("stop");
    expect(h.deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("call_mcp_tool"));
  });

  it("shows allowed built-ins as provider-executed calls", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      {
        expect: "session/prompt",
        toolCall: { name: "read_file", toolCallId: "b1", rawInput: { path: "/x" }, output: "contents" },
        reply: END,
      },
    ]);
    const parts = await run(h, opts([user("read")]));
    expect(parts.find((p) => p.type === "tool-call")).toMatchObject({ toolName: "read_file", providerExecuted: true });
    expect(parts.find((p) => p.type === "tool-result")).toMatchObject({ toolCallId: "b1", result: "contents" });
    expect(finishOf(parts).finishReason.unified).toBe("stop");
  });

  it("crash_mid_turn_then_recovers", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", notify: [chunk("par")], stderr: "segfault", exit: 1 }]);
    const parts = await run(h, opts([user("go")]));
    const errors = errorsOf(parts);
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toContain("segfault");
    expect(errors[0].error.code).toBe("crash");
    expect(h.deps.pool.get("ses-1")).toBeUndefined();
    expect((await h.deps.store.get("ses-1"))!.interrupted).toBe(true);

    writeFileSync(
      path.join(h.dir, "scenario.json"),
      JSON.stringify([INIT, AUTH, NEW, { expect: "session/prompt", notify: [chunk("ok")], reply: END }]),
    );
    const second = await run(h, opts([user("go"), { role: "assistant", content: [{ type: "text", text: "par" }] }, user("retry")]));
    expect(finishOf(second).finishReason.unified).toBe("stop");
    const starts = h.starts();
    expect(starts).toHaveLength(2);
    expect(starts[0].env.AGY_ACP_BRIDGE_URL).not.toBe(starts[1].env.AGY_ACP_BRIDGE_URL);
    const prompts = promptTexts(h);
    expect(prompts[1]![0]).toContain("<conversation-checkpoint>");
    expect(prompts[1]![1]).toBe("retry");
  });

  it("concurrent_sessions_isolated", async () => {
    const pool = new AgyProcessPool<LiveSession>();
    const store = new SessionStore(path.join(mkdtempSync(path.join(os.tmpdir(), "agy-lm-store-")), "s.json"));
    const steps = (text: string) => [
      INIT,
      AUTH,
      NEW,
      {
        expect: "session/prompt",
        callMcp: { tool: "read", args: { path: "a" }, toolCallId: "t1" },
        notifyAfter: [chunk(text)],
        reply: END,
      },
    ];
    const a = harness(steps("from A"), { pool, store });
    const b = harness(steps("from B"), { pool, store });
    const [pa, pb] = await Promise.all([
      run(a, opts([user("A asks")], { tools: [READ_TOOL] }, "ses-A")),
      run(b, opts([user("B asks")], { tools: [READ_TOOL] }, "ses-B")),
    ]);
    expect(finishOf(pa).finishReason.unified).toBe("tool-calls");
    expect(finishOf(pb).finishReason.unified).toBe("tool-calls");
    expect(a.starts()[0].env.AGY_ACP_BRIDGE_URL).not.toBe(b.starts()[0].env.AGY_ACP_BRIDGE_URL);
    expect(promptTexts(a)).toEqual([["A asks"]]);
    expect(promptTexts(b)).toEqual([["B asks"]]);

    const resolvedA = await run(
      a,
      opts([user("A asks"), assistantCall("t1", { path: "a" }), toolResult("t1", "result A")], { tools: [READ_TOOL] }, "ses-A"),
    );
    expect(resolvedA.filter((p) => p.type === "text-delta").map((p: any) => p.delta)).toEqual(["from A"]);
    expect(bridgeTexts(a)).toEqual(["result A"]);
    expect(bridgeTexts(b)).toEqual([]);
    expect(pool.get("ses-B")!.pending.size).toBe(1);

    const resolvedB = await run(
      b,
      opts([user("B asks"), assistantCall("t1", { path: "a" }), toolResult("t1", "result B")], { tools: [READ_TOOL] }, "ses-B"),
    );
    expect(resolvedB.filter((p) => p.type === "text-delta").map((p: any) => p.delta)).toEqual(["from B"]);
    expect(bridgeTexts(b)).toEqual(["result B"]);
  });

  it("api_key_env", async () => {
    const h = harness([INIT, { expect: "authenticate", reply: {} }, NEW, { expect: "session/prompt", reply: END }], {
      env: { GOOGLE_API_KEY: "g" },
      deps: { auth: async () => ({ method: "gemini-api-key", apiKey: "k", identity: "key:c1" }) },
    });
    await run(h, opts([user("hi")]));
    const env = h.starts()[0].env;
    expect(env.GEMINI_API_KEY).toBe("set");
    expect(env.GOOGLE_API_KEY).toBe("unset");
    expect(h.recv("authenticate")[0].message.params).toEqual({ methodId: "gemini-api-key" });
  });

  it("model_and_tier", async () => {
    const onModels = vi.fn();
    const h = harness(
      [
        INIT,
        AUTH,
        NEW,
        { expect: "session/set_model", reply: {} },
        { expect: "session/set_config_option", reply: {} },
        { expect: "session/prompt", reply: END },
      ],
      { modelId: "claude-sonnet-4-6", deps: { onModels } },
    );
    await run(h, opts([user("hi")], { providerOptions: { "google-agy-acp": { tier: "low" } } }));
    expect(h.recv("session/set_model")[0].message.params).toEqual({ sessionId: "s1", modelId: "claude-sonnet-4-6" });
    expect(h.recv("session/set_config_option")[0].message.params).toEqual({
      sessionId: "s1",
      configId: "thought_level",
      value: "low",
    });
    expect(onModels).toHaveBeenCalledWith(MODELS);
  });

  it("ignores an invalid tier", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }]);
    await run(h, opts([user("hi")], { providerOptions: { "google-agy-acp": { tier: "ultra" } } }));
    expect(h.recv("session/set_config_option")).toHaveLength(0);
  });

  it("no_session_header_uses_throwaway", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", notify: [chunk("Title")], reply: END }, CLOSE], {
      deps: { bridgeConnectTimeoutMs: 1 },
    });
    const parts = await run(h, opts([system("Generate a title"), user("hello")], { tools: [READ_TOOL] }, ""));
    expect(errorsOf(parts)).toHaveLength(0);
    expect(finishOf(parts).finishReason.unified).toBe("stop");
    expect(h.bridge("tools/list")[0].response.result.tools).toEqual([]);
    expect(h.recv("session/new")).toHaveLength(1);
    expect(h.recv("session/close")).toHaveLength(1);
    expect(existsSync(path.join(h.dir, "sessions.json"))).toBe(false);
    expect(h.recv("session/new")[0].message.params._meta.antigravity.systemPrompt.append).toBe("Generate a title");
  });

  it("throwaway reports errors and still disposes", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      { expect: "session/prompt", error: { code: -32603, message: "boom" } },
      CLOSE,
    ]);
    const parts = await run(h, opts([user("hello")], {}, ""));
    expect(errorsOf(parts)[0].error.message).toBe("boom");
    await waitFor(() => h.recv("session/close").length === 1);
  });

  it("tos_error_message", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      {
        expect: "session/prompt",
        error: { code: -32603, message: "Gemini is disabled in this account for violation of Terms of Service." },
      },
    ]);
    const parts = await run(h, opts([user("hi")]));
    const errors = errorsOf(parts);
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe(TOS_DISABLED_TEXT);
    expect(errors[0].error.code).toBe("tos_disabled");
    expect((await h.deps.store.get("ses-1"))!.interrupted).toBe(true);
    expect(h.deps.pool.get("ses-1")).toBeDefined();
  });

  it("doGenerate collects the stream", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      {
        expect: "session/prompt",
        notify: [chunk("hmm", "agent_thought_chunk"), chunk("a"), chunk("b")],
        callMcp: { tool: "read", args: { path: "a" }, toolCallId: "t1" },
        reply: END,
      },
    ]);
    const res = await h.model.doGenerate(opts([user("hi")], { tools: [READ_TOOL], temperature: 0.2 }));
    expect(res.content).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "ab" },
      { type: "tool-call", toolCallId: "t1", toolName: "read", input: '{"path":"a"}' },
    ]);
    expect(res.finishReason.unified).toBe("tool-calls");
    expect(res.warnings).toEqual([{ type: "unsupported", feature: "temperature" }]);
  });

  it("doGenerate throws the stream error", async () => {
    const h = harness([INIT, AUTH, NEW], {
      deps: { ensurePlugin: vi.fn(async () => Promise.reject(new Error("install failed"))) },
    });
    await expect(h.model.doGenerate(opts([user("hi")]))).rejects.toThrow("install failed");
  });

  it("warns about unsupported settings and provider tools", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }]);
    const parts = await run(
      h,
      opts([user("hi")], {
        temperature: 0.5,
        topP: 0.9,
        topK: 3,
        presencePenalty: 1,
        frequencyPenalty: 1,
        seed: 1,
        stopSequences: ["x"],
        maxOutputTokens: 10,
        responseFormat: { type: "json" },
        tools: [{ type: "provider", id: "google.search", name: "search", args: {} } as any],
      }),
    );
    const start = parts[0] as any;
    expect(start.warnings.map((w: any) => w.feature)).toEqual([
      "maxOutputTokens",
      "temperature",
      "stopSequences",
      "topP",
      "topK",
      "presencePenalty",
      "frequencyPenalty",
      "seed",
      "responseFormat",
      "provider-defined tool search",
    ]);
    expect(start.warnings.every((w: any) => w.type === "unsupported")).toBe(true);
    const promptParams = h.recv("session/prompt")[0].message.params;
    expect(JSON.stringify(promptParams)).not.toContain("temperature");
  });

  it("finishes without prompting when there is nothing to send", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }]);
    const history = [user("hi")];
    await run(h, opts(history));
    const parts = await run(h, opts([...history, { role: "assistant", content: [{ type: "text", text: "hello" }] }]));
    const finish = finishOf(parts);
    expect(finish.finishReason.unified).toBe("stop");
    expect(finish.usage.inputTokens.total).toBe(0);
    expect(h.recv("session/prompt")).toHaveLength(1);
  });

  it("does not send an empty checkpoint after an interruption", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }]);
    const history = [user("hi")];
    await run(h, opts(history));
    const record = (await h.deps.store.get("ses-1"))!;
    await h.deps.store.set("ses-1", { ...record, interrupted: true });
    const parts = await run(h, opts(history));
    expect(finishOf(parts).finishReason.unified).toBe("stop");
    expect(h.recv("session/prompt")).toHaveLength(1);
  });

  it("replaces the live session when the fingerprint changes", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }]);
    await run(h, opts([system("v1"), user("hi")]));
    writeFileSync(
      path.join(h.dir, "scenario.json"),
      JSON.stringify([INIT, AUTH, { ...NEW, reply: { ...NEW.reply, sessionId: "s2" } }, { expect: "session/prompt", reply: END }]),
    );
    await run(h, opts([system("v2"), user("hi"), { role: "assistant", content: [{ type: "text", text: "yo" }] }, user("more")]));
    expect(h.starts()).toHaveLength(2);
    const prompts = promptTexts(h);
    expect(prompts[1]![0]).toContain("<conversation-checkpoint>");
    expect(prompts[1]![1]).toBe("more");
    expect((await h.deps.store.get("ses-1"))!.agySessionId).toBe("s2");
  });

  it("opens a new agy session in the same process when history is edited", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      { expect: "session/prompt", reply: END },
      CLOSE,
      { expect: "session/new", reply: { ...NEW.reply, sessionId: "s2" } },
      { expect: "session/prompt", reply: END },
    ]);
    await run(h, opts([user("first")]));
    await run(h, opts([user("edited"), { role: "assistant", content: [{ type: "text", text: "x" }] }, user("next")]));
    expect(h.starts()).toHaveLength(1);
    expect(h.recv("session/close")[0].message.params).toEqual({ sessionId: "s1" });
    expect(h.recv("session/prompt")[1].message.params.sessionId).toBe("s2");
    expect((await h.deps.store.get("ses-1"))!.agySessionId).toBe("s2");
  });

  it("respawns when the process died while idle", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }]);
    const history = [user("hi")];
    await run(h, opts(history));
    const live = h.deps.pool.get("ses-1")!;
    writeFileSync(path.join(h.dir, "scenario.json"), JSON.stringify([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }]));
    await live.proc.dispose();
    await run(h, opts([...history, { role: "assistant", content: [{ type: "text", text: "a" }] }, user("again")]));
    expect(h.starts()).toHaveLength(2);
    expect(promptTexts(h)[1]![0]).toContain("<conversation-checkpoint>");
  });

  it("idle_kill_closes_bridge_and_frees_slot", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }], {
      // Long enough that the session is still pooled after run() under coverage load.
      deps: { idleTimeoutMs: 1000, bridgeConnectTimeoutMs: 2000 },
    });
    await run(h, opts([user("hi")], { tools: [READ_TOOL] }));
    const live = h.deps.pool.get("ses-1")!;
    const close = vi.spyOn(live.bridge, "close");
    live.pending.expect({ callId: "x", toolName: "read", input: { path: "a" } });
    const claimed = live.pending.claim("read", { path: "a" });
    await live.proc.exited;
    expect(await claimed).toEqual({ text: CANCELLED_TEXT, isError: true });
    await waitFor(() => close.mock.calls.length > 0);
    await close.mock.results[0]!.value;
    await expect(fetch(live.bridge.url, { method: "POST" })).rejects.toThrow();
    expect(live.dead).toBe(true);
    await waitFor(() => h.deps.pool.get("ses-1") === undefined);
    const late = vi.fn();
    live.onDead(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("starts a new prompt when a user message arrives while a tool is pending", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      { expect: "session/prompt", callMcp: { tool: "read", args: { path: "a" }, toolCallId: "t1" }, reply: { stopReason: "cancelled" } },
      { expect: "session/prompt", reply: END },
    ]);
    const history = [user("read a")];
    await run(h, opts(history, { tools: [READ_TOOL] }));
    await waitFor(() => h.deps.pool.get("ses-1")!.claimed.has("t1"));
    const parts = await run(h, opts([...history, assistantCall("t1", { path: "a" }), user("never mind")], { tools: [READ_TOOL] }));
    expect(finishOf(parts).finishReason.unified).toBe("stop");
    expect(h.recv("session/cancel")).toHaveLength(1);
    expect(bridgeTexts(h)).toEqual([CANCELLED_TEXT]);
    expect(promptTexts(h)[1]).toEqual(["never mind"]);
  });
});

describe("AgyAcpLanguageModel turn lifecycle", () => {
  const HANGING_TOOL = {
    expect: "session/prompt",
    callMcp: { tool: "read", args: { path: "a" }, toolCallId: "t1" },
  };
  const textOf = (parts: LanguageModelV3StreamPart[]) =>
    parts.filter((p) => p.type === "text-delta").map((p: any) => p.delta);

  it("cancel_ignored_by_agy_respawns_after_grace", async () => {
    const h = harness([INIT, AUTH, NEW, HANGING_TOOL], { deps: { cancelSettleTimeoutMs: 100 } });
    const history = [user("read a")];
    await run(h, opts(history, { tools: [READ_TOOL] }));
    const first = h.deps.pool.get("ses-1")!;
    await waitFor(() => first.claimed.has("t1"));
    writeFileSync(
      path.join(h.dir, "scenario.json"),
      JSON.stringify([INIT, AUTH, NEW, { expect: "session/prompt", notify: [chunk("fresh")], reply: END }]),
    );

    const parts = await run(h, opts([...history, assistantCall("t1", { path: "a" }), user("never mind")], { tools: [READ_TOOL] }));
    expect(errorsOf(parts)).toEqual([]);
    expect(textOf(parts)).toEqual(["fresh"]);
    expect(finishOf(parts).finishReason.unified).toBe("stop");
    expect(h.recv("session/cancel")).toHaveLength(1);
    expect(first.dead).toBe(true);
    expect(h.starts()).toHaveLength(2);
    const replay = promptTexts(h)[1]!;
    expect(replay[0]).toContain("<conversation-checkpoint>");
    expect(replay[1]).toBe("never mind");
    expect(h.deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("did not settle"));
  });

  it("abort_while_waiting_on_cancelled_turn", async () => {
    const h = harness([INIT, AUTH, NEW, HANGING_TOOL], { deps: { cancelSettleTimeoutMs: 60_000 } });
    const history = [user("read a")];
    await run(h, opts(history, { tools: [READ_TOOL] }));
    const live = h.deps.pool.get("ses-1")!;
    await waitFor(() => live.claimed.has("t1"));

    const ac = new AbortController();
    const pending = run(
      h,
      opts([...history, assistantCall("t1", { path: "a" }), user("stop")], { tools: [READ_TOOL], abortSignal: ac.signal }),
    );
    await waitFor(() => h.recv("session/cancel").length === 1);
    ac.abort(new Error("user pressed esc"));
    const parts = await pending;
    expect(errorsOf(parts).map((e) => e.error.message)).toEqual(["user pressed esc"]);
    expect(parts.some((p) => p.type === "finish")).toBe(false);
    expect(h.deps.pool.get("ses-1")).toBe(live);
    expect(live.dead).toBe(false);
    expect(h.starts()).toHaveLength(1);
    expect(h.recv("session/prompt")).toHaveLength(1);
  });

  it("overlapping_streams_same_session_serialize", async () => {
    const h = harness([
      INIT,
      AUTH,
      NEW,
      { expect: "session/prompt", delayMs: 100, notify: [chunk("one")], reply: END },
      { expect: "session/prompt", notify: [chunk("two")], reply: END },
    ]);
    const firstHistory = [user("a")];
    const secondHistory = [...firstHistory, { role: "assistant", content: [{ type: "text", text: "one" }] } as const, user("b")];
    const aborted = new AbortController();
    const [a, b, c] = await Promise.all([
      run(h, opts(firstHistory)),
      run(h, opts(secondHistory)),
      (async () => {
        const p = run(h, opts(secondHistory, { abortSignal: aborted.signal }));
        aborted.abort(new Error("waiter aborted"));
        return p;
      })(),
    ]);
    expect(textOf(a)).toEqual(["one"]);
    expect(finishOf(a).finishReason.unified).toBe("stop");
    expect(textOf(b)).toEqual(["two"]);
    expect(finishOf(b).finishReason.unified).toBe("stop");
    expect(errorsOf(c).map((e) => e.error.message)).toEqual(["waiter aborted"]);
    expect(promptTexts(h)).toEqual([["a"], ["b"]]);
    expect(h.starts()).toHaveLength(1);
  });

  it("a cancelled stream releases the session for the next call", async () => {
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", notify: [chunk("partial")] }], {
      deps: { cancelSettleTimeoutMs: 100 },
    });
    const { stream } = await h.model.doStream(opts([user("a")]));
    const reader = stream.getReader();
    for (;;) {
      const { value } = await reader.read();
      if (value?.type === "text-delta") break;
    }
    writeFileSync(
      path.join(h.dir, "scenario.json"),
      JSON.stringify([INIT, AUTH, NEW, { expect: "session/prompt", notify: [chunk("again")], reply: END }]),
    );
    await reader.cancel();
    const parts = await run(h, opts([user("a")]));
    expect(textOf(parts)).toEqual(["again"]);
    expect(h.starts()).toHaveLength(2);
  });

  it("cancel_without_abort_keeps_lock_until_settled", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const ensurePlugin = vi.fn(() => gate);
    const h = harness([INIT, AUTH, NEW, { expect: "session/prompt", reply: END }], { deps: { ensurePlugin } });
    const { stream } = await h.model.doStream(opts([user("a")]));
    await waitFor(() => ensurePlugin.mock.calls.length > 0);
    await stream.cancel();
    // The cancelled step is still inside runLocked: the session must stay locked.
    const probe = lockSession(h.deps.pool, "ses-1", undefined);
    const state = await Promise.race([
      probe.then(() => "acquired"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 80)),
    ]);
    expect(state).toBe("waiting");
    open();
    const release = await probe;
    expect(release).toBeTypeOf("function");
    release!();
  });

  it("different_sessions_stay_concurrent", async () => {
    const pool = new AgyProcessPool<LiveSession>();
    const store = new SessionStore(path.join(mkdtempSync(path.join(os.tmpdir(), "agy-lm-store-")), "s.json"));
    const a = harness([INIT, AUTH, NEW, { expect: "session/prompt", notify: [chunk("A streaming")] }], { pool, store });
    const b = harness([INIT, AUTH, NEW, { expect: "session/prompt", notify: [chunk("B done")], reply: END }], { pool, store });
    const ac = new AbortController();
    const { stream } = await a.model.doStream(opts([user("A")], { abortSignal: ac.signal }, "ses-A"));
    const reader = stream.getReader();
    for (;;) {
      const { value } = await reader.read();
      if (value?.type === "text-delta") break;
    }
    // A's step is still open (agy never replies); B on another session must not wait for it.
    const parts = await run(b, opts([user("B")], {}, "ses-B"));
    expect(textOf(parts)).toEqual(["B done"]);
    expect(finishOf(parts).finishReason.unified).toBe("stop");
    ac.abort(new Error("done"));
    const rest: LanguageModelV3StreamPart[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value);
    }
    expect(errorsOf(rest).map((e) => e.error.message)).toEqual(["done"]);
  });
});

async function waitForRecord(h: Harness, pred: (r: any) => boolean) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = await h.deps.store.get("ses-1");
    if (pred(r)) return r!;
    if (Date.now() > deadline) throw new Error("record wait timed out");
    await new Promise((res) => setTimeout(res, 10));
  }
}

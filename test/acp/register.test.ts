import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgyProbe, ExecFn } from "../../src/acp/binary";
import { AGY_ACP_FALLBACK_MODELS, AGY_ACP_PROVIDER_ID, MIN_AGY_VERSION } from "../../src/acp/constants";
import { AgyAcpLanguageModel } from "../../src/acp/language-model";
import { registerAgyAcpProvider, type AgyAcpRegistration } from "../../src/acp/register";
import { placeholderPackage } from "../../src/acp/register-catalog";
import { createGoogleAgyAcp } from "../../src/acp/sdk-placeholder";
import { AgyProcessPool } from "../../src/acp/process";
import { SessionStore } from "../../src/acp/session-sync";
import { resetAgyTosWarningForTesting } from "../../src/plugin/tos-warning";

const here = path.dirname(new URL(import.meta.url).pathname);
const fakeAgent = path.resolve(here, "../fixtures/fake-acp-agent.mjs");
const fakeCli = path.resolve(here, "../fixtures/fake-agy-cli.mjs");

const INIT = { expect: "initialize", reply: { protocolVersion: 1 } };
const NEW = {
  expect: "session/new",
  reply: { sessionId: "s1", models: { availableModels: [{ modelId: "gemini-3.8-flash-high" }], currentModelId: "gemini-3.8-flash-high" } },
};
const END = { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };

interface Recorder {
  providers: Map<string, any>;
  models: Map<string, any>;
  integrations: Map<string, any>;
  methods: any[];
  sdkHooks: Array<{ name: string; handler: (ev: any) => any }>;
  sessionHooks: Array<{ name: string; handler: (ev: any) => any; opts?: { providerID?: string } }>;
  statusCalls: any[];
  toasts: any[];
  apply(): Promise<void>;
  sdk(ev: any): Promise<any>;
  hook(name: string): (ev: any) => any;
}

let dir: string;
let regs: AgyAcpRegistration[] = [];
let active: any;
let credential: any;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "agy-reg-"));
  active = undefined;
  credential = undefined;
  resetAgyTosWarningForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(regs.map((r) => r.dispose()));
  regs = [];
  vi.restoreAllMocks();
});

function fakeCtx(o: { workspaceID?: string; noConnection?: boolean } = {}) {
  const transforms: { provider: any[]; model: any[]; integration: any[] } = { provider: [], model: [], integration: [] };
  const rec: Recorder = {
    providers: new Map(),
    models: new Map(),
    integrations: new Map(),
    methods: [],
    sdkHooks: [],
    sessionHooks: [],
    statusCalls: [],
    toasts: [],
    async apply() {
      for (const fn of transforms.provider) {
        await fn({
          update: (id: string, f: (p: any) => void) => {
            const p = rec.providers.get(id) ?? { id };
            f(p);
            rec.providers.set(id, p);
          },
        });
      }
      for (const fn of transforms.model) {
        await fn({
          update: (pid: string, mid: string, f: (m: any) => void) => {
            const key = `${pid}/${mid}`;
            const m = rec.models.get(key) ?? { id: mid, providerID: pid };
            f(m);
            rec.models.set(key, m);
          },
        });
      }
      for (const fn of transforms.integration) {
        await fn({
          update: (id: string, f: (i: any) => void) => {
            const i = rec.integrations.get(id) ?? { id };
            f(i);
            rec.integrations.set(id, i);
          },
          method: { update: (m: any) => rec.methods.push(m) },
        });
      }
    },
    async sdk(ev: any) {
      for (const h of rec.sdkHooks) if (h.name === "sdk") await h.handler(ev);
      return ev;
    },
    hook(name: string) {
      return rec.sessionHooks.find((h) => h.name === name)!.handler;
    },
  };
  const ctx: any = {
    provider: { transform: (fn: any) => transforms.provider.push(fn) },
    model: { transform: (fn: any) => transforms.model.push(fn) },
    tool: { transform: vi.fn() },
    command: { transform: vi.fn() },
    session: { hook: (name: string, handler: any, opts?: any) => rec.sessionHooks.push({ name, handler, opts }) },
    aisdk: { hook: (name: string, handler: any) => rec.sdkHooks.push({ name, handler }) },
    integration: {
      transform: (fn: any) => transforms.integration.push(fn),
      ...(o.noConnection
        ? {}
        : {
            connection: {
              active: async () => active,
              resolve: async () => credential,
              status: async (s: any) => {
                rec.statusCalls.push(s);
              },
            },
          }),
    },
    client: { tui: { showToast: async (t: any) => rec.toasts.push(t) } },
    location: { directory: dir, ...(o.workspaceID ? { workspaceID: o.workspaceID } : {}) },
  };
  return { ctx, rec };
}

function launcher(steps: unknown[]) {
  const scenario = path.join(dir, "scenario.json");
  writeFileSync(scenario, JSON.stringify(steps));
  const file = path.join(dir, "agy");
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${fakeAgent}" "$@"\n`);
  chmodSync(file, 0o755);
  const log = path.join(dir, "log.ndjson");
  return {
    path: file,
    env: { PATH: process.env.PATH, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: log },
    entries: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
  };
}

const ready = (p = "/usr/bin/agy"): AgyProbe => ({ status: "ready", path: p, version: MIN_AGY_VERSION });

async function register(ctx: any, overrides: Record<string, unknown> = {}) {
  const reg = await registerAgyAcpProvider(ctx, {
    probe: async () => ready(),
    installer: async () => {},
    modelsCachePath: path.join(dir, "models.json"),
    store: new SessionStore(path.join(dir, "sessions.json")),
    pool: new AgyProcessPool(),
    log: vi.fn(),
    ...overrides,
  } as any);
  regs.push(reg);
  await reg.ready;
  return reg;
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

const turn = (session = "ses-1") =>
  ({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    headers: { "x-opencode-session-id": session },
  }) as unknown as LanguageModelV3CallOptions;

async function languageModel(rec: Recorder, id = "gemini-3.8-flash-high"): Promise<AgyAcpLanguageModel> {
  const ev = await rec.sdk({ model: { id, providerID: AGY_ACP_PROVIDER_ID }, package: "x", options: {} });
  return ev.sdk.languageModel(id);
}

describe("registerAgyAcpProvider: catalog", () => {
  it("adds the provider with fallback models when no cache exists", async () => {
    const { ctx, rec } = fakeCtx();
    await register(ctx);
    await rec.apply();
    const p = rec.providers.get(AGY_ACP_PROVIDER_ID);
    expect(p).toMatchObject({ id: AGY_ACP_PROVIDER_ID, activation: "auto", integrationID: AGY_ACP_PROVIDER_ID });
    expect(p.package).toMatch(/^aisdk:file:\/\/.*\/sdk-placeholder\.(js|ts)$/);
    expect(existsSync(fileURLToPath(p.package.slice("aisdk:".length)))).toBe(true);
    const ids = [...rec.models.values()].map((m) => m.id);
    expect(ids).toEqual([...AGY_ACP_FALLBACK_MODELS]);
    for (const m of rec.models.values()) {
      expect(m.providerID).toBe(AGY_ACP_PROVIDER_ID);
      expect(m.variants.map((v: any) => v.id)).toEqual(["low", "medium", "high"]);
      for (const v of m.variants) expect(v.settings[AGY_ACP_PROVIDER_ID].tier).toBe(v.id);
      expect(m.cost.length).toBeGreaterThan(0);
      for (const c of m.cost) expect([c.input, c.output]).toEqual([0, 0]);
    }
  });

  it("uses cached model ids when models.json exists", async () => {
    writeFileSync(path.join(dir, "models.json"), JSON.stringify({ models: [{ modelId: "c1", name: "Cached One" }, { modelId: "c2" }] }));
    const { ctx, rec } = fakeCtx();
    await register(ctx);
    await rec.apply();
    expect([...rec.models.values()].map((m) => [m.id, m.name])).toEqual([
      ["c1", "Cached One"],
      ["c2", "c2"],
    ]);
  });

  it("falls back when the models cache is corrupt or empty", async () => {
    writeFileSync(path.join(dir, "models.json"), "{not json");
    const { ctx, rec } = fakeCtx();
    await register(ctx);
    await rec.apply();
    expect(rec.models.size).toBe(AGY_ACP_FALLBACK_MODELS.length);
  });

  it("supports the legacy catalog draft", async () => {
    const { ctx } = fakeCtx();
    delete ctx.provider;
    delete ctx.model;
    let fn: any;
    ctx.catalog = { transform: (f: any) => (fn = f) };
    await register(ctx);
    const providers = new Map<string, any>();
    const models = new Map<string, any>();
    await fn({
      provider: { update: (id: string, f: any) => f(providers.get(id) ?? providers.set(id, { id }).get(id)) },
      model: { update: (pid: string, mid: string, f: any) => f(models.get(mid) ?? models.set(mid, { id: mid, providerID: pid }).get(mid)) },
    });
    expect(providers.get(AGY_ACP_PROVIDER_ID).activation).toBe("auto");
    expect(models.size).toBe(AGY_ACP_FALLBACK_MODELS.length);
  });

  it("onModels writes the models cache", async () => {
    const { ctx } = fakeCtx();
    const reg = await register(ctx);
    reg.deps.onModels!([{ modelId: "m1" }]);
    const cached = JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8"));
    expect(cached.models.map((m: any) => m.modelId)).toContain("m1");
  });

  it("logs when the models cache cannot be written", async () => {
    const { ctx } = fakeCtx();
    const log = vi.fn();
    const reg = await register(ctx, { modelsCachePath: path.join(dir, "models.json", "nested", "x.json"), log });
    writeFileSync(path.join(dir, "models.json"), "file blocks dir");
    reg.deps.onModels!([{ modelId: "m1" }]);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("models cache"));
  });
});

describe("placeholder package", () => {
  it("prefers a sibling sdk-placeholder.js (the bundled layout)", () => {
    const dist = mkdtempSync(path.join(os.tmpdir(), "agy-dist-"));
    writeFileSync(path.join(dist, "sdk-placeholder.js"), "export default () => ({});\n");
    const base = new URL(`file://${dist}/index.js`).href;
    expect(placeholderPackage(base)).toBe(`aisdk:file://${dist}/sdk-placeholder.js`);
  });

  it("the placeholder factory throws a clear error", () => {
    expect(() => createGoogleAgyAcp().languageModel("x")).toThrow(/opencode-agy-auth plugin/);
  });
});

describe("registerAgyAcpProvider: aisdk and session hooks", () => {
  it("leaves other providers' sdk untouched", async () => {
    const { ctx, rec } = fakeCtx();
    await register(ctx);
    const sdk = { marker: true };
    const ev = await rec.sdk({ model: { id: "x", providerID: "openai" }, package: "x", options: {}, sdk });
    expect(ev.sdk).toBe(sdk);
    await rec.sdk(undefined);
  });

  it("sets an AgyAcpLanguageModel for this provider", async () => {
    const { ctx, rec } = fakeCtx();
    await register(ctx);
    const model = await languageModel(rec);
    expect(model).toBeInstanceOf(AgyAcpLanguageModel);
    expect(model.modelId).toBe("gemini-3.8-flash-high");
  });

  it("stamps session and kind headers on model.request for this provider only", async () => {
    const { ctx, rec } = fakeCtx();
    await register(ctx);
    const entry = rec.sessionHooks.find((h) => h.name === "model.request")!;
    expect(entry.opts).toEqual({ providerID: AGY_ACP_PROVIDER_ID });
    const ev: any = { sessionID: "ses-9", kind: "primary", baseURL: "", headers: {}, model: { providerID: AGY_ACP_PROVIDER_ID } };
    await entry.handler(ev);
    expect(ev.headers).toEqual({ "x-opencode-session-id": "ses-9", "x-opencode-request-kind": "primary" });
    const other: any = { sessionID: "ses-9", kind: "primary", baseURL: "", headers: {}, providerID: "openai" };
    await entry.handler(other);
    expect(other.headers).toEqual({});
    await entry.handler(undefined);
  });

  it("disables OpenCode retries for this provider", async () => {
    const { ctx, rec } = fakeCtx();
    await register(ctx);
    const entry = rec.sessionHooks.find((h) => h.name === "retry")!;
    expect(entry.opts).toEqual({ providerID: AGY_ACP_PROVIDER_ID });
    const ev: any = { attempt: 1, providerID: AGY_ACP_PROVIDER_ID };
    await entry.handler(ev);
    expect(ev.retryable).toBe(false);
    const other: any = { attempt: 1, model: { providerID: "openai" } };
    await entry.handler(other);
    expect(other.retryable).toBeUndefined();
    await entry.handler(undefined);
  });
});

describe("registerAgyAcpProvider: integration and auth", () => {
  it("adds the four auth methods", async () => {
    const { ctx, rec } = fakeCtx();
    await register(ctx);
    await rec.apply();
    expect(rec.integrations.get(AGY_ACP_PROVIDER_ID).name).toMatch(/Antigravity/);
    const methods = rec.methods.map((m) => m.method);
    expect(rec.methods.every((m) => m.integrationID === AGY_ACP_PROVIDER_ID)).toBe(true);
    const byId = (id: string) => methods.find((m) => m.id === id);
    expect(byId("oauth-personal")).toMatchObject({ type: "external" });
    expect(byId("oauth-business")).toMatchObject({ type: "external" });
    expect(byId("agent-platform")).toMatchObject({ type: "external" });
    expect(JSON.stringify(byId("oauth-personal").form)).toMatch(/agy/);
    expect(JSON.stringify(byId("agent-platform").form)).toMatch(/gcloud auth application-default login/);
    expect(methods.find((m) => m.type === "key")).toMatchObject({ type: "key", label: expect.stringMatching(/Gemini API key/) });
    expect(methods).toHaveLength(4);
  });

  it("maps stored credentials to the agy auth method and api key", async () => {
    const { ctx } = fakeCtx();
    const reg = await register(ctx);
    expect(await reg.deps.authMethod()).toBe("oauth-personal");
    expect(await reg.deps.apiKey()).toBeUndefined();

    active = { type: "credential", id: "c1", label: "k", method: "key" };
    credential = { type: "key", key: "AIza-test" };
    expect(await reg.deps.authMethod()).toBe("gemini-api-key");
    expect(await reg.deps.apiKey()).toBe("AIza-test");

    active = { type: "credential", id: "c2", label: "v", method: "external" };
    credential = { type: "external", methodID: "agent-platform" };
    expect(await reg.deps.authMethod()).toBe("agent-platform");
    expect(await reg.deps.apiKey()).toBeUndefined();

    credential = { type: "external", methodID: "bogus" };
    expect(await reg.deps.authMethod()).toBe("oauth-personal");
    credential = { type: "oauth", access: "a" };
    expect(await reg.deps.authMethod()).toBe("oauth-personal");
  });

  it("treats a failing connection lookup as no credential", async () => {
    const { ctx } = fakeCtx();
    ctx.integration.connection.active = async () => {
      throw new Error("boom");
    };
    const reg = await register(ctx);
    expect(await reg.deps.authMethod()).toBe("oauth-personal");
  });

  it("works without a connection API", async () => {
    const { ctx } = fakeCtx({ noConnection: true });
    const reg = await register(ctx, { probe: async () => ({ status: "missing" }) });
    expect(await reg.deps.authMethod()).toBe("oauth-personal");
    expect(reg.status().status).toBe("missing");
  });

  it("passes the stored API key to the agy child as GEMINI_API_KEY", async () => {
    const agy = launcher([INIT, { expect: "authenticate", reply: {} }, NEW, { expect: "session/prompt", reply: END }]);
    active = { type: "credential", id: "c1", label: "k", method: "key" };
    credential = { type: "key", key: "AIza-test" };
    const { ctx, rec } = fakeCtx();
    await register(ctx, { probe: async () => ready(agy.path), env: agy.env });
    const parts = await collect((await (await languageModel(rec)).doStream(turn())).stream);
    expect(parts.some((p) => p.type === "error")).toBe(false);
    const start = agy.entries().find((e) => e.kind === "start");
    expect(start.env.GEMINI_API_KEY).toBe("set");
  });

  it("does not set GEMINI_API_KEY when no key is stored", async () => {
    const agy = launcher([INIT, { expect: "authenticate", reply: {} }, NEW, { expect: "session/prompt", reply: END }]);
    const { ctx, rec } = fakeCtx();
    await register(ctx, { probe: async () => ready(agy.path), env: agy.env });
    await collect((await (await languageModel(rec)).doStream(turn())).stream);
    const start = agy.entries().find((e) => e.kind === "start");
    expect(start.env.GEMINI_API_KEY).toBe("unset");
  });
});

describe("registerAgyAcpProvider: status", () => {
  it("missing probe -> missing with an install hint", async () => {
    const { ctx, rec } = fakeCtx();
    const reg = await register(ctx, { probe: async () => ({ status: "missing" }) });
    expect(reg.status()).toMatchObject({ status: "missing", message: expect.stringMatching(/Install the Antigravity CLI/) });
    const parts = await collect((await (await languageModel(rec)).doStream(turn())).stream);
    const error = parts.find((p) => p.type === "error") as any;
    expect(error.error.code).toBe("missing");
  });

  it("too_old probe -> failed naming the minimum version", async () => {
    const { ctx } = fakeCtx();
    const reg = await register(ctx, { probe: async () => ({ status: "too_old", path: "/x/agy", version: "1.5.8" }) });
    expect(reg.status()).toMatchObject({ status: "failed", message: expect.stringContaining("1.5.10") });
  });

  it("failed probe -> failed with the probe error", async () => {
    const { ctx } = fakeCtx();
    const reg = await register(ctx, { probe: async () => ({ status: "failed", path: "/x/agy", error: "bad output" }) });
    expect(reg.status()).toMatchObject({ status: "failed", message: expect.stringContaining("bad output") });
  });

  it("a throwing probe -> failed", async () => {
    const { ctx } = fakeCtx();
    const reg = await register(ctx, {
      probe: async () => {
        throw new Error("exec exploded");
      },
    });
    expect(reg.status()).toMatchObject({ status: "failed", message: expect.stringContaining("exec exploded") });
  });

  it("ready probe -> ready", async () => {
    const { ctx } = fakeCtx();
    const reg = await register(ctx);
    expect(reg.status()).toEqual({ status: "ready", version: MIN_AGY_VERSION });
  });

  it("authenticate failure during a turn -> needs_auth, then a good turn -> ready", async () => {
    const agy = launcher([
      INIT,
      { expect: "authenticate", error: { code: -32000, message: "Authentication required" } },
    ]);
    active = { type: "credential", id: "c2", label: "g", method: "external" };
    credential = { type: "external", methodID: "oauth-personal" };
    const { ctx, rec } = fakeCtx();
    const reg = await register(ctx, { probe: async () => ready(agy.path), env: agy.env });
    const parts = await collect((await (await languageModel(rec)).doStream(turn())).stream);
    expect((parts.find((p) => p.type === "error") as any).error.code).toBe("auth_required");
    expect(reg.status()).toMatchObject({ status: "needs_auth", message: expect.stringMatching(/Sign in/) });
    await vi.waitFor(() => expect(rec.statusCalls).toHaveLength(1));
    expect(rec.statusCalls.at(-1)).toMatchObject({
      integrationID: AGY_ACP_PROVIDER_ID,
      connection: active,
      status: { status: "needs_auth" },
    });

    writeFileSync(
      path.join(dir, "scenario.json"),
      JSON.stringify([INIT, { expect: "authenticate", reply: {} }, NEW, { expect: "session/prompt", reply: END }]),
    );
    await collect((await (await languageModel(rec)).doStream(turn("ses-2"))).stream);
    expect(reg.status().status).toBe("ready");
    await vi.waitFor(() => expect(rec.statusCalls).toHaveLength(2));
    expect(rec.statusCalls.at(-1)).toMatchObject({ connection: active, status: undefined });
  });

  it("re-probes when the active credential changes", async () => {
    const { ctx } = fakeCtx();
    const probe = vi.fn(async () => ready());
    const reg = await register(ctx, { probe });
    expect(probe).toHaveBeenCalledTimes(1);
    await reg.deps.authMethod();
    expect(probe).toHaveBeenCalledTimes(1);
    active = { type: "credential", id: "c1", label: "k", method: "key" };
    credential = { type: "key", key: "k" };
    await reg.deps.authMethod();
    expect(probe).toHaveBeenCalledTimes(2);
    await reg.deps.authMethod();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("emits the provider ToS warning once per process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await register(fakeCtx().ctx);
    await register(fakeCtx().ctx);
    const acp = warn.mock.calls.filter((c) => String(c[0]).includes("google-agy-acp"));
    expect(acp).toHaveLength(1);
    expect(String(acp[0][0])).toMatch(/API key/);
  });
});

describe("registerAgyAcpProvider: lazy plugin install", () => {
  it("plugin_install_is_lazy", async () => {
    const agy = launcher([INIT, { expect: "authenticate", reply: {} }, NEW, { expect: "session/prompt", reply: END }]);
    const installer = vi.fn(async () => {});
    const { ctx, rec } = fakeCtx();
    await register(ctx, { probe: async () => ready(agy.path), env: agy.env, installer });
    expect(installer).not.toHaveBeenCalled();
    const model = await languageModel(rec);
    await collect((await model.doStream(turn())).stream);
    expect(installer).toHaveBeenCalledTimes(1);
    await collect((await model.doStream(turn("ses-x"))).stream);
    expect(installer).toHaveBeenCalledTimes(1);
  });

  it("retries the installer after a failure", async () => {
    const installer = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("install broke"))
      .mockResolvedValue(undefined);
    const { ctx } = fakeCtx();
    const reg = await register(ctx, { installer });
    await expect(reg.deps.ensurePlugin()).rejects.toThrow("install broke");
    await reg.deps.ensurePlugin();
    await reg.deps.ensurePlugin();
    expect(installer).toHaveBeenCalledTimes(2);
  });

  it("the real installer notifies once with one info log and one toast", async () => {
    const statePath = path.join(dir, "agy-state.json");
    const exec: ExecFn = (_file, args) =>
      new Promise((resolve, reject) => {
        execFile(process.execPath, [fakeCli, ...args], { env: { ...process.env, FAKE_AGY_STATE: statePath } }, (error, stdout, stderr) =>
          error ? reject(error) : resolve({ stdout: String(stdout), stderr: String(stderr) }),
        );
      });
    const log = vi.fn();
    const { ctx, rec } = fakeCtx();
    const reg = await register(ctx, { installer: undefined, installerOptions: { exec, dataDir: dir }, log });
    expect(existsSync(statePath)).toBe(false);
    await reg.deps.ensurePlugin();
    await reg.deps.ensurePlugin();
    const infos = log.mock.calls.filter((c) => c[0] === "info");
    expect(infos).toHaveLength(1);
    expect(infos[0][1]).toContain("agy plugin uninstall opencode-bridge");
    const infoToasts = () => rec.toasts.filter((t) => t.body.variant === "info");
    await vi.waitFor(() => expect(infoToasts()).toHaveLength(1));
    expect(infoToasts()[0].body).toMatchObject({ variant: "info", message: expect.stringContaining("agy plugin uninstall opencode-bridge") });
  });

  it("refuses to install when the probe is not ready", async () => {
    const installer = vi.fn(async () => {});
    const { ctx } = fakeCtx();
    const reg = await register(ctx, { probe: async () => ({ status: "missing" }), installer });
    await expect(reg.deps.ensurePlugin()).rejects.toMatchObject({ code: "missing" });
    expect(installer).not.toHaveBeenCalled();
    expect(reg.deps.agyPath).toBe("agy");
  });
});

describe("registerAgyAcpProvider: lifecycle", () => {
  it("registers nothing for a remote workspace", async () => {
    const installer = vi.fn(async () => {});
    const probe = vi.fn(async () => ready());
    const { ctx, rec } = fakeCtx({ workspaceID: "wrk_1" });
    const reg = await registerAgyAcpProvider(ctx, { installer, probe });
    await reg.ready;
    await rec.apply();
    expect(rec.providers.size).toBe(0);
    expect(rec.sdkHooks).toHaveLength(0);
    expect(rec.sessionHooks).toHaveLength(0);
    expect(installer).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    await reg.dispose();
  });

  it("dispose() disposes every pooled process", async () => {
    const pool = new AgyProcessPool<any>();
    const disposeAll = vi.spyOn(pool, "disposeAll");
    const { ctx } = fakeCtx();
    const reg = await register(ctx, { pool });
    await reg.dispose();
    expect(disposeAll).toHaveBeenCalledTimes(1);
  });

  it("uses default deps when no overrides are given", async () => {
    const { ctx } = fakeCtx();
    const reg = await registerAgyAcpProvider(ctx, { probe: async () => ({ status: "missing" }), modelsCachePath: path.join(dir, "m.json") });
    regs.push(reg);
    await reg.ready;
    expect(reg.deps.cwd).toBe(dir);
    expect(reg.deps.store).toBeInstanceOf(SessionStore);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    reg.deps.log("info", "hello");
    expect(info).toHaveBeenCalledWith("[Agy ACP] hello");
  });
});

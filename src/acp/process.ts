import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  AGY_ADC_ENV,
  AGY_API_KEY_ENV,
  AGY_API_KEY_OVERRIDE_ENV,
  AGY_SPAWN_ARGS,
  BRIDGE_TOKEN_ENV,
  BRIDGE_URL_ENV,
  IDLE_TIMEOUT_MS,
  MODE_CONFIG_ID,
  STARTUP_TIMEOUT_MS,
  THOUGHT_LEVEL_CONFIG_ID,
  type AgyTier,
} from "./constants";
import { createAgyDebugLog } from "./debug";
import { JsonRpcConnection } from "./rpc";

export type AgyAuthMethod = "oauth-personal" | "oauth-business" | "gemini-api-key" | "agent-platform";

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface AcpToolCall {
  toolCallId: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: Array<{ type: "content"; content: { type: "text"; text: string } }>;
}

export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: { type: string; text?: string } }
  | { sessionUpdate: "agent_thought_chunk"; content: { type: string; text?: string } }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCall)
  | { sessionUpdate: "usage_update"; used: number; size: number }
  | { sessionUpdate: "session_info_update"; title?: string }
  | { sessionUpdate: "available_commands_update"; availableCommands?: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId?: string }
  | { sessionUpdate: "plan"; entries?: unknown[] };

export interface AcpModelInfo {
  modelId: string;
  name?: string;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: { loadSession?: boolean; [key: string]: unknown };
  authMethods?: Array<{ id: string; name?: string }>;
  [key: string]: unknown;
}

export interface AgyProcessOptions {
  binaryPath: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  authMethod?: AgyAuthMethod;
}

export interface NewSessionParams {
  cwd: string;
  systemPromptAppend?: string;
  modelId?: string;
  tier?: AgyTier;
}

export interface NewSessionResult {
  sessionId: string;
  models: AcpModelInfo[];
  currentModelId?: string;
}

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface PromptResult {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  usage?: AcpUsage;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

export type AcpPermissionResponse = {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
};

export interface AgyExit {
  code: number | null;
  signal: string | null;
  stderrTail: string;
}

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 2000;

/** Returns a copy of `base` carrying the credential agy should use for `authMethod`. */
export function applyAgyAuthEnv(
  base: NodeJS.ProcessEnv,
  o: { authMethod: AgyAuthMethod; apiKey?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (o.authMethod === "gemini-api-key") {
    env[AGY_API_KEY_ENV] = o.apiKey;
    delete env[AGY_API_KEY_OVERRIDE_ENV];
  } else if (o.authMethod === "agent-platform") {
    env[AGY_ADC_ENV] = "true";
  }
  return env;
}

export function buildAgyEnv(
  base: NodeJS.ProcessEnv,
  o: { bridgeUrl: string; bridgeToken: string; authMethod: AgyAuthMethod; apiKey?: string },
): NodeJS.ProcessEnv {
  const env = applyAgyAuthEnv(base, o);
  env[BRIDGE_URL_ENV] = o.bridgeUrl;
  env[BRIDGE_TOKEN_ENV] = o.bridgeToken;
  return env;
}

export class AgyAcpProcess {
  initializeResult: AcpInitializeResult = {};
  readonly exited: Promise<AgyExit>;

  private readonly updateHandlers = new Map<string, Set<(u: AcpSessionUpdate) => void>>();
  private permissionHandler?: (r: AcpPermissionRequest) => AcpPermissionResponse | Promise<AcpPermissionResponse>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private inflightPrompts = 0;
  private hasExited = false;
  private disposePromise?: Promise<void>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly conn: JsonRpcConnection,
    private readonly idleTimeoutMs: number,
    exited: Promise<AgyExit>,
  ) {
    this.exited = exited;
    void exited.then(() => {
      this.hasExited = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
    });

    conn.onNotification("session/update", (params) => {
      this.touch();
      const handlers = this.updateHandlers.get(params?.sessionId);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          handler(params.update);
        } catch {
          // A faulty handler must not break routing.
        }
      }
    });
    conn.onRequest("session/request_permission", async (params) => {
      this.touch();
      const request = params as AcpPermissionRequest;
      if (this.permissionHandler) return this.permissionHandler(request);
      const reject = request.options?.find((o) => o.kind === "reject_once");
      if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
      return { outcome: { outcome: "cancelled" } };
    });
    this.touch();
  }

  static async start(opts: AgyProcessOptions): Promise<AgyAcpProcess> {
    const child = spawn(opts.binaryPath, [...(opts.args ?? AGY_SPAWN_ARGS)], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Opt-in diagnostics (AGY_ACP_DEBUG=1). Never logs the environment; known secrets are redacted.
    const debug = createAgyDebugLog(opts.env, [opts.env[BRIDGE_TOKEN_ENV], opts.env[AGY_API_KEY_ENV]]);
    debug?.(
      "spawn",
      `pid=${child.pid ?? "none"} binary=${opts.binaryPath} args=${JSON.stringify(opts.args ?? AGY_SPAWN_ARGS)} cwd=${opts.cwd}`,
    );

    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      debug?.("stderr", chunk.trimEnd());
    });

    const input = new PassThrough();
    child.stdout?.pipe(input, { end: false });
    const conn = new JsonRpcConnection(
      input,
      child.stdin!,
      debug ? (direction, line) => debug(direction === "out" ? "rpc>" : "rpc<", line) : undefined,
    );

    let spawnError: Error | undefined;
    const exited = new Promise<AgyExit>((resolve) => {
      child.once("error", (err) => {
        debug?.("error", err.message);
        spawnError = err;
        conn.close(err);
        resolve({ code: null, signal: null, stderrTail });
      });
      child.once("close", (code, signal) => {
        debug?.("exit", `code=${code ?? "null"} signal=${signal ?? "none"}`);
        const detail = stderrTail.trim();
        conn.close(
          new Error(
            `agy acp exited (code ${code ?? "null"}, signal ${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
          ),
        );
        resolve({ code, signal, stderrTail });
      });
    });

    const proc = new AgyAcpProcess(child, conn, opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS, exited);

    const startupMs = opts.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      startupTimer = setTimeout(
        () => reject(new Error(`agy acp did not start within ${startupMs}ms`)),
        startupMs,
      );
    });
    try {
      const handshake = (async () => {
        proc.initializeResult = await conn.request<AcpInitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "opencode-agy-acp", version: "0" },
        });
        if (opts.authMethod) await conn.request("authenticate", { methodId: opts.authMethod });
      })();
      handshake.catch(() => {});
      await Promise.race([handshake, timeout]);
    } catch (err) {
      await proc.dispose();
      throw spawnError ?? err;
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
    }
    return proc;
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hasExited || this.disposePromise) return;
    this.idleTimer = setTimeout(() => {
      if (this.inflightPrompts > 0) {
        this.touch();
        return;
      }
      void this.dispose();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    this.touch();
    try {
      return await this.conn.request<T>(method, params);
    } finally {
      this.touch();
    }
  }

  async newSession(p: NewSessionParams): Promise<NewSessionResult> {
    const params: Record<string, unknown> = { cwd: p.cwd, mcpServers: [] };
    if (p.systemPromptAppend) {
      params._meta = { antigravity: { systemPrompt: { append: p.systemPromptAppend } } };
    }
    const res = await this.rpc<any>("session/new", params);
    const sessionId: string = res.sessionId;
    const models: AcpModelInfo[] = res.models?.availableModels ?? [];
    const currentModelId: string | undefined = res.models?.currentModelId;

    if (p.modelId && p.modelId !== currentModelId) {
      await this.rpc("session/set_model", { sessionId, modelId: p.modelId });
    }
    if (p.tier) {
      await this.rpc("session/set_config_option", {
        sessionId,
        configId: THOUGHT_LEVEL_CONFIG_ID,
        value: p.tier,
      });
    }
    const configMode = Array.isArray(res.configOptions)
      ? res.configOptions.find((o: any) => o?.id === MODE_CONFIG_ID)?.currentValue
      : undefined;
    const currentMode: string | undefined = res.modes?.currentModeId ?? configMode;
    if (currentMode !== undefined && currentMode !== "default") {
      await this.rpc("session/set_config_option", {
        sessionId,
        configId: MODE_CONFIG_ID,
        value: "default",
      });
    }
    return { sessionId, models, currentModelId };
  }

  async prompt(sessionId: string, blocks: AcpContentBlock[]): Promise<PromptResult> {
    this.inflightPrompts++;
    try {
      const res = await this.rpc<any>("session/prompt", { sessionId, prompt: blocks });
      return { stopReason: res.stopReason, usage: res.usage };
    } finally {
      this.inflightPrompts--;
    }
  }

  cancel(sessionId: string): void {
    this.touch();
    this.conn.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    this.updateHandlers.delete(sessionId);
    try {
      await this.rpc("session/close", { sessionId });
    } catch {
      // Best effort: the session may already be gone.
    }
  }

  onUpdate(sessionId: string, handler: (u: AcpSessionUpdate) => void): () => void {
    let set = this.updateHandlers.get(sessionId);
    if (!set) {
      set = new Set();
      this.updateHandlers.set(sessionId, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  onPermissionRequest(
    handler: (r: AcpPermissionRequest) => AcpPermissionResponse | Promise<AcpPermissionResponse>,
  ): void {
    this.permissionHandler = handler;
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.conn.close();
    if (!this.hasExited) {
      this.child.kill("SIGTERM");
      const killer = setTimeout(() => {
        if (!this.hasExited) this.child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      await this.exited;
      clearTimeout(killer);
    }
  }
}

export interface PoolEntry {
  dispose(): Promise<void>;
  /** Optional: called once the entry can no longer serve requests; the pool then drops it. */
  onDead?(listener: () => void): void;
}

interface Slot<T> {
  fingerprint: string;
  promise: Promise<T>;
  value?: T;
}

export class AgyProcessPool<T extends PoolEntry> {
  private readonly slots = new Map<string, Slot<T>>();

  acquire(key: string, fingerprint: string, create: () => Promise<T>): Promise<T> {
    const existing = this.slots.get(key);
    if (existing && existing.fingerprint === fingerprint) return existing.promise;

    const slot = { fingerprint } as Slot<T>;
    slot.promise = (async () => {
      if (existing) await existing.promise.then((v) => v.dispose(), () => {});
      const value = await create();
      slot.value = value;
      value.onDead?.(() => {
        if (this.slots.get(key) === slot) this.slots.delete(key);
      });
      return value;
    })();
    this.slots.set(key, slot);
    slot.promise.catch(() => {
      if (this.slots.get(key) === slot) this.slots.delete(key);
    });
    return slot.promise;
  }

  get(key: string): T | undefined {
    return this.slots.get(key)?.value;
  }

  async release(key: string): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    await slot.promise.then((v) => v.dispose(), () => {});
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((key) => this.release(key)));
  }
}

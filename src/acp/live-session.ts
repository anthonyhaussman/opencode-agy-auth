import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { BRIDGE_CONNECT_TIMEOUT_MS, CANCELLED_TEXT, MCP_SOFT_TIMEOUT_MS } from "./constants";
import { AgyAcpError, BRIDGE_NOT_CONNECTED_TEXT } from "./errors";
import { McpBridge, PendingTools, type BridgeToolDef } from "./mcp-bridge";
import { decidePermission } from "./permission";
import {
  AgyAcpProcess,
  buildAgyEnv,
  type AcpContentBlock,
  type AcpModelInfo,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpToolCall,
  type AgyAuthMethod,
  type AgyProcessPool,
  type NewSessionParams,
  type PoolEntry,
  type PromptResult,
} from "./process";
import type { SessionRecord, SessionStore } from "./session-sync";
import { StreamMapper } from "./stream-map";

export interface AgyAcpDeps {
  pool: AgyProcessPool<LiveSession>;
  store: SessionStore;
  agyPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  authMethod: () => Promise<AgyAuthMethod>;
  apiKey: () => Promise<string | undefined>;
  ensurePlugin: () => Promise<void>;
  onModels?: (models: AcpModelInfo[]) => void;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  bridgeConnectTimeoutMs?: number;
  softTimeoutMs?: number;
}

export type TurnEvent =
  | { kind: "part"; part: LanguageModelV3StreamPart; bridgeCallId?: string }
  | { kind: "violation"; toolName: string };

/** Small edge-triggered wake-up primitive. */
class Signal {
  private waiters: Array<() => void> = [];
  wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  fire(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

/** One agy `session/prompt`; it can outlive a single doStream (open across tool calls). */
export class LiveTurn {
  readonly queue: TurnEvent[] = [];
  readonly mapper = new StreamMapper();
  readonly parked = new Set<string>();
  readonly signal = new Signal();
  settled?: { result?: PromptResult; error?: unknown };
  aborted?: unknown;
  done: Promise<void> = Promise.resolve();
  detachAbort?: () => void;
  interruptWrite?: Promise<void>;

  setAbortSignal(signal: AbortSignal | undefined, onAbort: (reason: unknown) => void): void {
    this.detachAbort?.();
    this.detachAbort = undefined;
    if (!signal) return;
    const listener = () => onAbort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    this.detachAbort = () => signal.removeEventListener("abort", listener);
  }
}

export interface LiveSessionConfig {
  key: string | undefined;
  fingerprint: string;
  tools: BridgeToolDef[];
  session: NewSessionParams;
  authMethod: AgyAuthMethod;
}

function definedOnly<T extends object>(o: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (v !== undefined) (out as any)[k] = v;
  return out;
}

/** agy process + MCP bridge + agy session for one OpenCode session. */
export class LiveSession implements PoolEntry {
  agySessionId?: string;
  turn?: LiveTurn;
  dead = false;
  record?: SessionRecord;
  readonly claimed = new Set<string>();
  readonly callOrder: string[] = [];
  private readonly toolCalls = new Map<string, AcpToolCall>();

  private constructor(
    readonly proc: AgyAcpProcess,
    readonly bridge: McpBridge,
    readonly pending: PendingTools,
    readonly config: LiveSessionConfig,
    private readonly log: AgyAcpDeps["log"],
  ) {
    void proc.exited.then(() => {
      this.dead = true;
    });
    proc.onPermissionRequest((req) => this.onPermission(req));
  }

  static async create(deps: AgyAcpDeps, config: LiveSessionConfig): Promise<LiveSession> {
    try {
      await deps.ensurePlugin();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgyAcpError("plugin_install", `agy plugin install failed: ${detail}`);
    }
    let live: LiveSession | undefined;
    const pending = new PendingTools({
      softTimeoutMs: deps.softTimeoutMs ?? MCP_SOFT_TIMEOUT_MS,
      onClaim: (id) => live?.markClaimed(id),
    });
    const bridge = await McpBridge.start({ tools: config.tools, pending, log: (m) => deps.log("warn", m) });
    let proc: AgyAcpProcess | undefined;
    try {
      const apiKey = await deps.apiKey();
      proc = await AgyAcpProcess.start({
        binaryPath: deps.agyPath,
        cwd: deps.cwd,
        env: buildAgyEnv(deps.env, {
          bridgeUrl: bridge.url,
          bridgeToken: bridge.token,
          authMethod: config.authMethod,
          apiKey,
        }),
        authMethod: config.authMethod,
      });
      live = new LiveSession(proc, bridge, pending, config, deps.log);
      const models = await live.openSession();
      deps.onModels?.(models);
      if (config.tools.length > 0) {
        const connected = await bridge.waitForClient(deps.bridgeConnectTimeoutMs ?? BRIDGE_CONNECT_TIMEOUT_MS);
        if (!connected) throw new AgyAcpError("bridge_unreachable", BRIDGE_NOT_CONNECTED_TEXT);
      }
      return live;
    } catch (error) {
      await proc?.dispose();
      await bridge.close();
      throw error;
    }
  }

  /** Opens a new agy session (closing the current one, if any). */
  async openSession(): Promise<AcpModelInfo[]> {
    if (this.agySessionId) await this.proc.closeSession(this.agySessionId);
    const res = await this.proc.newSession(this.config.session);
    this.agySessionId = res.sessionId;
    this.record = undefined;
    return res.models;
  }

  private onPermission(req: AcpPermissionRequest): AcpPermissionResponse {
    const id = req.toolCall?.toolCallId;
    const toolCall = { ...this.toolCalls.get(id), ...definedOnly(req.toolCall) } as AcpToolCall;
    const { response, allowed } = decidePermission({ ...req, toolCall });
    if (allowed) {
      this.turn?.parked.add(id);
      this.turn?.signal.fire();
    } else {
      this.log("warn", `agy-acp: rejected agy tool ${toolCall.name ?? "(unknown)"} (call ${id})`);
    }
    return response;
  }

  private markClaimed(id: string): void {
    this.claimed.add(id);
    this.turn?.parked.add(id);
    this.turn?.signal.fire();
  }

  startTurn(blocks: AcpContentBlock[]): LiveTurn {
    const sessionId = this.agySessionId!;
    const turn = new LiveTurn();
    this.turn = turn;
    const unsubscribe = this.proc.onUpdate(sessionId, (u) => {
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const merged = { ...this.toolCalls.get(u.toolCallId), ...definedOnly(u as AcpToolCall) } as AcpToolCall;
        this.toolCalls.set(u.toolCallId, merged);
      }
      const ev = turn.mapper.map(u);
      if (ev.bridgeCall) {
        this.pending.expect(ev.bridgeCall);
        this.callOrder.push(ev.bridgeCall.callId);
      }
      for (const part of ev.parts) {
        const isBridge = part.type === "tool-call" && part.toolCallId === ev.bridgeCall?.callId;
        turn.queue.push(isBridge ? { kind: "part", part, bridgeCallId: part.toolCallId } : { kind: "part", part });
      }
      if (ev.violation) {
        turn.queue.push({ kind: "violation", toolName: ev.violation.toolName });
        this.proc.cancel(sessionId);
      }
      turn.signal.fire();
    });
    turn.done = this.proc.prompt(sessionId, blocks).then(
      (result) => {
        turn.settled = { result };
      },
      (error) => {
        turn.settled = { error };
      },
    );
    void turn.done.finally(() => {
      unsubscribe();
      turn.signal.fire();
    });
    return turn;
  }

  /** Cancels the open turn (if any) and fails every pending bridge call. */
  cancelTurn(): void {
    const turn = this.turn;
    if (turn && !turn.settled && this.agySessionId) this.proc.cancel(this.agySessionId);
    this.pending.rejectAll(CANCELLED_TEXT);
  }

  async dispose(): Promise<void> {
    this.turn?.detachAbort?.();
    this.pending.rejectAll(CANCELLED_TEXT);
    await this.proc.dispose();
    await this.bridge.close();
  }
}

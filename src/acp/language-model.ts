import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import { AGY_ACP_PROVIDER_ID, CANCEL_SETTLE_TIMEOUT_MS, SESSION_HEADER, type AgyTier } from "./constants";
import { AgyAcpError, toAgyError } from "./errors";
import { LiveSession, type AgyAcpDeps, type LiveTurn } from "./live-session";
import type { BridgeToolDef, ToolOutcome } from "./mcp-bridge";
import type { AcpContentBlock, PromptResult } from "./process";
import { lockSession, waitBounded } from "./session-lock";
import { decideSync, fingerprintOf, hashMessage, renderToolIndex, type SyncDecision } from "./session-sync";
import { mapStopReason, mapUsage } from "./stream-map";

export type { AgyAcpDeps } from "./live-session";
export { LiveSession, LiveTurn } from "./live-session";

type Part = LanguageModelV3StreamPart;
type StepOutcome =
  | { kind: "tool-calls" }
  | { kind: "settled" }
  | { kind: "violation"; toolName: string }
  | { kind: "aborted" }
  | { kind: "detached" };

const TIERS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
const UNSUPPORTED_SETTINGS = [
  "maxOutputTokens",
  "temperature",
  "stopSequences",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
] as const;
const EMPTY_CHECKPOINT = /^<conversation-checkpoint>\s*<\/conversation-checkpoint>$/;
const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const STOP: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };

/** Guards the stream controller against writes after close or consumer cancel. */
class Out {
  closed = false;
  /** Wakes a waiting consumer loop when the reader cancels the stream. */
  onCancel?: () => void;
  constructor(private readonly controller: ReadableStreamDefaultController<Part>) {}
  emit(...parts: Part[]): void {
    if (this.closed) return;
    for (const part of parts) this.controller.enqueue(part);
  }
  error(error: unknown): void {
    this.emit({ type: "error", error });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}

interface CallContext {
  key: string | undefined;
  system: string;
  tools: BridgeToolDef[];
  tier: AgyTier | undefined;
}

function headerValue(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name && v) return v;
  return undefined;
}

function prepareCall(o: LanguageModelV3CallOptions): { warnings: SharedV3Warning[]; ctx: CallContext } {
  const warnings: SharedV3Warning[] = [];
  for (const setting of UNSUPPORTED_SETTINGS) {
    if (o[setting] !== undefined) warnings.push({ type: "unsupported", feature: setting });
  }
  if (o.responseFormat?.type === "json") warnings.push({ type: "unsupported", feature: "responseFormat" });
  const tools: BridgeToolDef[] = [];
  for (const tool of o.tools ?? []) {
    if (tool.type === "function") {
      tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as BridgeToolDef["inputSchema"] });
    } else {
      warnings.push({ type: "unsupported", feature: `provider-defined tool ${tool.name}` });
    }
  }
  const system = o.prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content as string)
    .join("\n\n");
  const rawTier = (o.providerOptions?.[AGY_ACP_PROVIDER_ID] as { tier?: unknown } | undefined)?.tier;
  const tier = typeof rawTier === "string" && TIERS.has(rawTier) ? (rawTier as AgyTier) : undefined;
  return { warnings, ctx: { key: headerValue(o.headers, SESSION_HEADER), system, tools, tier } };
}

function cleanBlocks(blocks: AcpContentBlock[]): AcpContentBlock[] {
  return blocks.filter((b) => b.type !== "text" || (b.text.trim() !== "" && !EMPTY_CHECKPOINT.test(b.text)));
}

function lateBlocks(late: Array<{ callId: string; outcome: ToolOutcome }>): AcpContentBlock[] {
  return late.map(({ callId, outcome }) => ({
    type: "text",
    text: `<tool-result id="${callId}"${outcome.isError ? ' error="true"' : ""}>\n${outcome.text}\n</tool-result>`,
  }));
}

export class AgyAcpLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = AGY_ACP_PROVIDER_ID;
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly deps: AgyAcpDeps,
  ) {}

  async doStream(o: LanguageModelV3CallOptions): Promise<{ stream: ReadableStream<Part> }> {
    const { warnings, ctx } = prepareCall(o);
    let out!: Out;
    const stream = new ReadableStream<Part>({
      start: (controller) => {
        out = new Out(controller);
        void this.run(o, warnings, ctx, out);
      },
      cancel: () => {
        out.closed = true;
        // The lock stays held until runSession settles (its finally releases it).
        out.onCancel?.();
      },
    });
    return { stream };
  }

  async doGenerate(o: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(o);
    const content: LanguageModelV3Content[] = [];
    const open = new Map<string, { text: string }>();
    let warnings: SharedV3Warning[] = [];
    let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };
    let usage = mapUsage();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      switch (value.type) {
        case "stream-start":
          warnings = value.warnings;
          break;
        case "text-start":
        case "reasoning-start": {
          const entry = { type: value.type === "text-start" ? "text" : "reasoning", text: "" } as {
            type: "text" | "reasoning";
            text: string;
          };
          content.push(entry);
          open.set(value.id, entry);
          break;
        }
        case "text-delta":
        case "reasoning-delta":
          open.get(value.id)!.text += value.delta;
          break;
        case "tool-call":
        case "tool-result":
          content.push(value);
          break;
        case "error":
          throw value.error;
        case "finish":
          finishReason = value.finishReason;
          usage = value.usage;
          break;
        default:
          break;
      }
    }
    return { content, finishReason, usage, warnings };
  }

  private sessionParams(ctx: CallContext, tools: BridgeToolDef[]) {
    const append = [ctx.system, renderToolIndex(tools)].filter(Boolean).join("\n\n");
    return {
      cwd: this.deps.cwd,
      ...(append ? { systemPromptAppend: append } : {}),
      modelId: this.modelId,
      ...(ctx.tier ? { tier: ctx.tier } : {}),
    };
  }

  private async run(o: LanguageModelV3CallOptions, warnings: SharedV3Warning[], ctx: CallContext, out: Out) {
    out.emit({ type: "stream-start", warnings });
    try {
      if (o.abortSignal?.aborted) {
        out.error(o.abortSignal.reason);
      } else if (ctx.key === undefined) {
        await this.runThrowaway(o, ctx, out);
      } else {
        await this.runSession(o, ctx, ctx.key, out);
      }
    } catch (error) {
      out.error(toAgyError(error));
    }
    out.close();
  }

  private async runSession(o: LanguageModelV3CallOptions, ctx: CallContext, key: string, out: Out) {
    const release = await lockSession(this.deps.pool, key, o.abortSignal);
    if (!release) {
      out.error(o.abortSignal!.reason);
      return;
    }
    try {
      await this.runLocked(o, ctx, key, out);
    } finally {
      release();
    }
  }

  private async runLocked(o: LanguageModelV3CallOptions, ctx: CallContext, key: string, out: Out) {
    const { deps } = this;
    const auth = await deps.auth();
    const fingerprint = fingerprintOf(ctx.system, ctx.tools, auth, this.modelId, ctx.tier);
    for (;;) {
      if (deps.pool.get(key)?.dead) await deps.pool.release(key);
      let created = false;
      const acquired = await waitBounded(
        deps.pool.acquire(key, fingerprint, () => {
          created = true;
          return LiveSession.create(deps, {
            key,
            fingerprint,
            tools: ctx.tools,
            session: this.sessionParams(ctx, ctx.tools),
            auth,
          });
        }),
        o.abortSignal,
      );
      if (acquired.kind !== "done") {
        out.error(o.abortSignal!.reason);
        return;
      }
      const live = acquired.value;
      const record = await deps.store.get(key);
      // A new process holds no history: replay everything (unless the config changed, which decideSync reports).
      const decision = decideSync(created && record?.fingerprint === fingerprint ? undefined : record, o.prompt, fingerprint);

      const previous = live.turn;
      if (previous && (decision.kind !== "continue" || decision.blocks.length > 0)) {
        previous.detachAbort?.();
        live.cancelTurn();
        const settled = await waitBounded(previous.done, o.abortSignal, deps.cancelSettleTimeoutMs ?? CANCEL_SETTLE_TIMEOUT_MS);
        if (settled.kind === "aborted") {
          out.error(o.abortSignal!.reason);
          return;
        }
        if (settled.kind === "timeout") {
          // agy ignored session/cancel: drop the process; the next acquire respawns and replays history.
          deps.log("warn", "agy-acp: cancelled agy turn did not settle in time; restarting agy");
          if (deps.pool.get(key) === live) await deps.pool.release(key);
          else await live.dispose();
          continue;
        }
        await previous.interruptWrite;
        live.turn = undefined;
      }
      if (!created && (decision.kind === "fresh" || decision.kind === "changed")) await live.openSession();
      if (decision.kind === "continue") this.resolveToolResults(live, decision);
      await this.step(o, live, decision.blocks, out);
      return;
    }
  }

  private async runThrowaway(o: LanguageModelV3CallOptions, ctx: CallContext, out: Out) {
    const auth = await this.deps.auth();
    const live = await LiveSession.create(this.deps, {
      key: undefined,
      fingerprint: "",
      tools: [],
      session: this.sessionParams(ctx, []),
      auth,
    });
    try {
      await this.step(o, live, decideSync(undefined, o.prompt, "").blocks, out);
    } finally {
      live.turn?.detachAbort?.();
      await live.proc.closeSession(live.agySessionId!);
      await live.dispose();
    }
  }

  private resolveToolResults(live: LiveSession, decision: Extract<SyncDecision, { kind: "continue" }>) {
    const rank = (id: string) => {
      const i = live.callOrder.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const ordered = [...decision.toolResults].sort((a, b) => rank(a.toolCallId) - rank(b.toolCallId));
    for (const { toolCallId, outcome } of ordered) {
      if (!live.pending.resolve(toolCallId, outcome)) {
        this.deps.log("warn", `agy-acp: no pending agy call for tool result ${toolCallId}`);
      }
      const i = live.callOrder.indexOf(toolCallId);
      if (i >= 0) live.callOrder.splice(i, 1);
    }
  }

  /** Drains the open turn (if any), then sends the next prompt when there is something to send. */
  private async step(o: LanguageModelV3CallOptions, live: LiveSession, decisionBlocks: AcpContentBlock[], out: Out) {
    let last: PromptResult | undefined;
    if (live.turn) {
      const settled = await this.drive(o, live, live.turn, out);
      if (!settled) return;
      last = settled;
    }
    const blocks = cleanBlocks([...lateBlocks(live.pending.takeLateResults()), ...decisionBlocks]);
    if (blocks.length === 0) {
      await this.writeRecord(live, o);
      out.emit({
        type: "finish",
        finishReason: last ? mapStopReason(last.stopReason) : STOP,
        usage: last ? mapUsage(last.usage) : ZERO_USAGE,
      });
      return;
    }
    const result = await this.drive(o, live, live.startTurn(blocks), out);
    if (!result) return;
    await this.writeRecord(live, o);
    out.emit({ type: "finish", finishReason: mapStopReason(result.stopReason), usage: mapUsage(result.usage) });
  }

  /**
   * Streams one turn until it settles or yields to OpenCode. Returns the prompt
   * result when the turn settled normally; otherwise the step was already ended.
   */
  private async drive(
    o: LanguageModelV3CallOptions,
    live: LiveSession,
    turn: LiveTurn,
    out: Out,
  ): Promise<PromptResult | undefined> {
    turn.setAbortSignal(o.abortSignal, (reason) => this.onAbort(live, turn, reason));
    out.onCancel = () => turn.signal.fire();
    const outcome = await this.consume(turn, out);
    out.onCancel = undefined;
    // The reader went away: leave the turn (and its queued parts) for the next call.
    if (outcome.kind === "detached") return undefined;
    if (outcome.kind === "tool-calls") {
      await this.writeRecord(live, o);
      out.emit({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: mapUsage() });
      return undefined;
    }
    turn.detachAbort?.();
    if (outcome.kind === "aborted") {
      await turn.interruptWrite;
      out.error(turn.aborted);
      return undefined;
    }
    if (outcome.kind === "violation") {
      live.pending.rejectAll(`agy tool ${outcome.toolName} is not allowed`);
      await this.markInterrupted(live);
      out.error(
        new AgyAcpError(
          "other",
          `agy tried to use the built-in tool "${outcome.toolName}", which the google-agy-acp provider does not allow. The turn was cancelled.`,
        ),
      );
      return undefined;
    }
    live.turn = undefined;
    if (turn.settled!.error !== undefined) {
      const error = toAgyError(turn.settled!.error);
      await this.markInterrupted(live);
      if (error.code === "crash" || live.dead) {
        live.pending.rejectAll(error.message);
        const key = live.config.key;
        if (key !== undefined && this.deps.pool.get(key) === live) await this.deps.pool.release(key);
      }
      out.error(error);
      return undefined;
    }
    return turn.settled!.result!;
  }

  private async consume(turn: LiveTurn, out: Out): Promise<StepOutcome> {
    const emitted: string[] = [];
    for (;;) {
      if (out.closed) return { kind: "detached" };
      while (turn.queue.length > 0) {
        const ev = turn.queue.shift()!;
        if (ev.kind === "violation") return { kind: "violation", toolName: ev.toolName };
        out.emit(ev.part);
        if (ev.bridgeCallId) emitted.push(ev.bridgeCallId);
      }
      if (turn.aborted !== undefined) return { kind: "aborted" };
      if (emitted.length > 0 && (turn.settled || emitted.every((id) => turn.parked.has(id)))) {
        out.emit(...turn.mapper.flush());
        return { kind: "tool-calls" };
      }
      if (turn.settled) {
        out.emit(...turn.mapper.flush());
        return { kind: "settled" };
      }
      await turn.signal.wait();
    }
  }

  private onAbort(live: LiveSession, turn: LiveTurn, reason: unknown): void {
    if (turn.settled || turn.aborted !== undefined) return;
    turn.aborted = reason ?? new Error("Aborted");
    live.cancelTurn();
    turn.interruptWrite = this.markInterrupted(live);
    turn.signal.fire();
  }

  private async writeRecord(live: LiveSession, o: LanguageModelV3CallOptions): Promise<void> {
    const key = live.config.key;
    if (key === undefined) return;
    live.record = {
      agySessionId: live.agySessionId!,
      fingerprint: live.config.fingerprint,
      messageHashes: o.prompt.filter((m) => m.role !== "system").map(hashMessage),
      interrupted: false,
      updatedAt: Date.now(),
    };
    await this.save(key, live.record);
  }

  private async markInterrupted(live: LiveSession): Promise<void> {
    const key = live.config.key;
    if (key === undefined) return;
    live.record = {
      ...(live.record ?? { fingerprint: live.config.fingerprint, messageHashes: [] }),
      agySessionId: live.agySessionId!,
      interrupted: true,
      updatedAt: Date.now(),
    };
    await this.save(key, live.record);
  }

  private async save(key: string, record: NonNullable<LiveSession["record"]>): Promise<void> {
    try {
      await this.deps.store.set(key, record);
    } catch (error) {
      this.deps.log("warn", `agy-acp: could not save session state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Ajv, type ValidateFunction } from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { STILL_RUNNING_TEXT } from "./constants";

export type JSONSchema7 = Record<string, unknown>;

export interface BridgeToolDef {
  name: string;
  description?: string;
  inputSchema: JSONSchema7;
}

export interface BridgeCall {
  /** ACP toolCallId. */
  callId: string;
  toolName: string;
  input: unknown;
}

export type ToolOutcome = { text: string; isError: boolean };

const TOOL_SUMMARY_KEY = "toolSummary";

function stripToolSummary(input: unknown): unknown {
  if (input && typeof input === "object" && !Array.isArray(input) && TOOL_SUMMARY_KEY in input) {
    const { [TOOL_SUMMARY_KEY]: _omit, ...rest } = input as Record<string, unknown>;
    return rest;
  }
  return input;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface Entry {
  callId: string;
  toolName: string;
  canon: string;
  claimed: boolean;
  timedOut: boolean;
  early?: ToolOutcome;
  settle?: (outcome: ToolOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class PendingTools {
  private readonly entries = new Map<string, Entry>();
  private late: Array<{ callId: string; outcome: ToolOutcome }> = [];

  constructor(
    private readonly opts: {
      softTimeoutMs: number | null;
      /** Called when the MCP client claims an expected call (agy's tools/call arrived). */
      onClaim?: (callId: string) => void;
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  expect(call: BridgeCall): void {
    this.entries.set(call.callId, {
      callId: call.callId,
      toolName: call.toolName,
      canon: canonical(stripToolSummary(call.input)),
      claimed: false,
      timedOut: false,
    });
  }

  /** First unclaimed entry for `toolName` with equal input, else the first unclaimed one for `toolName`. */
  private find(toolName: string, input: unknown): Entry | undefined {
    const canon = canonical(stripToolSummary(input));
    let fallback: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.claimed || entry.toolName !== toolName) continue;
      if (entry.canon === canon) return entry;
      fallback ??= entry;
    }
    return fallback;
  }

  claim(toolName: string, input: unknown): Promise<ToolOutcome> {
    const entry = this.find(toolName, input);
    if (!entry) {
      return Promise.resolve({ text: `No pending OpenCode tool call for ${toolName}`, isError: true });
    }
    entry.claimed = true;
    this.opts.onClaim?.(entry.callId);
    if (entry.early) {
      this.entries.delete(entry.callId);
      return Promise.resolve(entry.early);
    }
    return new Promise<ToolOutcome>((resolve) => {
      entry.settle = resolve;
      const ms = this.opts.softTimeoutMs;
      if (ms !== null) {
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          entry.timedOut = true;
          entry.settle = undefined;
          resolve({ text: STILL_RUNNING_TEXT, isError: false });
        }, ms);
      }
    });
  }

  /**
   * agy's call was refused before reaching OpenCode (invalid input), but OpenCode
   * already saw the tool call and may still run it. Claims the matching entry as
   * soft-timed-out, so OpenCode's result is delivered later as a late result and
   * the entry can never be handed to another call.
   */
  abandon(toolName: string, input: unknown): void {
    const entry = this.find(toolName, input);
    if (!entry) return;
    entry.claimed = true;
    this.opts.onClaim?.(entry.callId);
    if (entry.early) {
      this.entries.delete(entry.callId);
      this.late.push({ callId: entry.callId, outcome: entry.early });
      return;
    }
    entry.timedOut = true;
  }

  resolve(callId: string, outcome: ToolOutcome): boolean {
    const entry = this.entries.get(callId);
    if (!entry) return false;
    if (entry.timedOut) {
      this.entries.delete(callId);
      this.late.push({ callId, outcome });
      return true;
    }
    if (entry.settle) {
      if (entry.timer) clearTimeout(entry.timer);
      this.entries.delete(callId);
      entry.settle(outcome);
      return true;
    }
    entry.early = outcome;
    return true;
  }

  rejectAll(text: string): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.settle?.({ text, isError: true });
    }
  }

  takeLateResults(): Array<{ callId: string; outcome: ToolOutcome }> {
    const out = this.late;
    this.late = [];
    return out;
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export class McpBridge {
  private clientSeen = false;
  private waiters: Array<() => void> = [];
  private closed = false;
  private current: { mcp: Server; transport: StreamableHTTPServerTransport };
  private http!: HttpServer;
  url = "";

  private constructor(
    readonly token: string,
    private readonly makePair: (onList: () => void) => { mcp: Server; transport: StreamableHTTPServerTransport },
    private readonly log: ((msg: string) => void) | undefined,
  ) {
    this.current = makePair(() => this.markClient());
  }

  static async start(opts: {
    tools: BridgeToolDef[];
    pending: PendingTools;
    log?: (msg: string) => void;
  }): Promise<McpBridge> {
    const { tools, pending, log } = opts;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validators = new Map<string, ValidateFunction>();
    for (const tool of tools) {
      try {
        const { $schema: _ignored, ...schema } = tool.inputSchema;
        validators.set(tool.name, ajv.compile(schema));
      } catch (error) {
        log?.(
          `schema for tool ${tool.name} could not be compiled, accepting any input: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const makePair = (onList: () => void) => {
      const mcp = new Server({ name: "opencode-bridge", version: "1.0.0" }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        enableJsonResponse: true,
      });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => {
        onList();
        return {
          tools: tools.map((t) => ({
            name: t.name,
            ...(t.description === undefined ? {} : { description: t.description }),
            inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
          })),
        };
      });
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        if (!tools.some((t) => t.name === name)) return errorResult(`Unknown OpenCode tool: ${name}`);
        const input = stripToolSummary(request.params.arguments ?? {});
        const validate = validators.get(name);
        if (validate && !validate(input)) {
          const detail = ajv.errorsText(validate.errors);
          log?.(`invalid input for ${name}: ${detail}`);
          pending.abandon(name, input);
          return errorResult(`Invalid input for OpenCode tool ${name}: ${detail}`);
        }
        const outcome = await pending.claim(name, input);
        return {
          content: [{ type: "text" as const, text: outcome.text }],
          ...(outcome.isError ? { isError: true } : {}),
        };
      });
      return { mcp, transport };
    };

    const token = randomBytes(32).toString("hex");
    const bridge = new McpBridge(token, makePair, log);
    await bridge.current.mcp.connect(bridge.current.transport);
    bridge.http = createServer((req, res) => {
      void bridge.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      bridge.http.once("error", reject);
      bridge.http.listen(0, "127.0.0.1", () => resolve());
    });
    bridge.url = `http://127.0.0.1:${(bridge.http.address() as AddressInfo).port}/mcp`;
    return bridge;
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokenMatches(req.headers.authorization, this.token)) {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("Unauthorized");
      return;
    }
    try {
      let parsed: unknown;
      if (req.method === "POST") {
        try {
          parsed = JSON.parse(await this.readBody(req));
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid JSON");
          return;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        if (messages.some((m) => isInitializeRequest(m)) && this.current.transport.sessionId !== undefined) {
          const old = this.current;
          this.current = this.makePair(() => this.markClient());
          await this.current.mcp.connect(this.current.transport);
          this.log?.("MCP client re-initialized; replaced transport");
          void old.mcp.close().catch(() => {});
        }
      }
      await this.current.transport.handleRequest(req, res, parsed);
    } catch (error) {
      this.log?.(`bridge request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private markClient(): void {
    this.clientSeen = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  waitForClient(timeoutMs: number): Promise<boolean> {
    if (this.clientSeen) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(wake);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.current.mcp.close().catch(() => {});
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }
}

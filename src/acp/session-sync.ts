import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { agyAcpDataDir } from "./constants";
import type { BridgeToolDef, ToolOutcome } from "./mcp-bridge";
import type { AcpContentBlock } from "./process";

export interface SessionRecord {
  agySessionId: string;
  fingerprint: string;
  messageHashes: string[];
  interrupted: boolean;
  updatedAt: number;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class SessionStore {
  readonly filePath: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string = path.join(agyAcpDataDir(), "sessions.json")) {
    this.filePath = filePath;
  }

  private async load(): Promise<Record<string, SessionRecord>> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, SessionRecord>;
      }
    } catch {
      // missing or corrupt: treated as empty
    }
    return {};
  }

  private async save(data: Record<string, SessionRecord>): Promise<void> {
    const cutoff = Date.now() - MAX_AGE_MS;
    const kept: Record<string, SessionRecord> = {};
    for (const [id, r] of Object.entries(data)) {
      if (typeof r?.updatedAt === "number" && r.updatedAt >= cutoff) kept[id] = r;
    }
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.sessions-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(kept), { mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    await fs.chmod(this.filePath, 0o600);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    await this.chain;
    const data = await this.load();
    return Object.hasOwn(data, id) ? data[id] : undefined;
  }

  set(id: string, r: SessionRecord): Promise<void> {
    return this.serialize(async () => {
      const data = await this.load();
      data[id] = r;
      await this.save(data);
    });
  }

  delete(id: string): Promise<void> {
    return this.serialize(async () => {
      const data = await this.load();
      delete data[id];
      await this.save(data);
    });
  }
}

function toCanonical(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (v instanceof URL) return v.toString();
  if (Array.isArray(v)) return v.map(toCanonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      if (key === "providerOptions") continue;
      const val = (v as Record<string, unknown>)[key];
      if (val === undefined) continue;
      out[key] = toCanonical(val);
    }
    return out;
  }
  return v;
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(toCanonical(v));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hashMessage(m: LanguageModelV3Message): string {
  return sha256(canonicalJson({ role: m.role, content: m.content }));
}

export function fingerprintOf(
  system: string,
  tools: BridgeToolDef[],
  auth: { method: string; identity: string },
  modelId: string,
  tier: string | undefined,
): string {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(
    canonicalJson({
      system,
      tools: sorted,
      authMethod: auth.method,
      authIdentity: auth.identity,
      modelId,
      tier: tier ?? null,
    }),
  );
}

export function renderToolIndex(tools: BridgeToolDef[]): string {
  if (tools.length === 0) return "";
  const lines = tools.map((t) => {
    const first = (t.description ?? "").split("\n")[0]?.trim() ?? "";
    return first ? `- ${t.name}: ${first}` : `- ${t.name}`;
  });
  return [
    "OpenCode tools are available through the call_mcp_tool built-in with ServerName opencode-bridge_bridge. Available tools:",
    ...lines,
  ].join("\n");
}

type Part = { type: string; [k: string]: any };

function fileNote(p: Part): string {
  return `[file omitted: ${p.filename ?? p.mediaType}]`;
}

function userBlocks(m: LanguageModelV3Message): AcpContentBlock[] {
  if (m.role !== "user") return [];
  const out: AcpContentBlock[] = [];
  for (const p of m.content as Part[]) {
    if (p.type === "text") {
      out.push({ type: "text", text: p.text });
    } else if (p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/")) {
      if (p.data instanceof URL) {
        out.push({ type: "text", text: `[image url: ${p.data.toString()}]` });
      } else {
        const data = p.data instanceof Uint8Array ? Buffer.from(p.data).toString("base64") : String(p.data);
        out.push({ type: "image", data, mimeType: p.mediaType });
      }
    } else if (p.type === "file") {
      out.push({ type: "text", text: fileNote(p) });
    }
  }
  return out;
}

function toOutcome(output: any): ToolOutcome {
  switch (output.type) {
    case "text":
      return { text: output.value, isError: false };
    case "json":
      return { text: JSON.stringify(output.value), isError: false };
    case "error-text":
      return { text: output.value, isError: true };
    case "error-json":
      return { text: JSON.stringify(output.value), isError: true };
    case "execution-denied":
      return { text: output.reason ?? "Execution denied", isError: true };
    default:
      return {
        text: (output.value as Part[])
          .map((i) => (i.type === "text" ? i.text : `[${i.type}]`))
          .join("\n"),
        isError: false,
      };
  }
}

export function renderCheckpoint(messages: LanguageModelV3Message[]): string {
  const entries: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const body = (m.content as Part[])
        .map((p) => (p.type === "text" ? p.text : p.type === "file" ? fileNote(p) : `[${p.type}]`))
        .join("\n");
      entries.push(`[user]\n${body}`);
    } else if (m.role === "assistant") {
      const lines: string[] = [];
      for (const p of m.content as Part[]) {
        if (p.type === "text" || p.type === "reasoning") lines.push(p.text);
        else if (p.type === "tool-call") {
          lines.push(`[tool-call:${p.toolName} id=${p.toolCallId}] ${canonicalJson(p.input)}`);
        }
      }
      entries.push(`[assistant]\n${lines.join("\n")}`);
    } else if (m.role === "tool") {
      for (const p of m.content as Part[]) {
        if (p.type !== "tool-result") continue;
        entries.push(`[tool:${p.toolName} id=${p.toolCallId}]\n${toOutcome(p.output).text}`);
      }
    }
  }
  return `<conversation-checkpoint>\n${entries.join("\n\n")}\n</conversation-checkpoint>`;
}

export type SyncDecision =
  | { kind: "fresh" | "catch-up" | "changed"; blocks: AcpContentBlock[] }
  | {
      kind: "continue";
      blocks: AcpContentBlock[];
      toolResults: Array<{ toolCallId: string; outcome: ToolOutcome }>;
    };

/** Checkpoint of everything but a trailing user message, which is appended as normal blocks. */
function historyBlocks(msgs: LanguageModelV3Message[]): AcpContentBlock[] {
  const last = msgs[msgs.length - 1];
  if (msgs.length === 1 && last?.role === "user") return userBlocks(last);
  if (last?.role === "user") {
    return [{ type: "text", text: renderCheckpoint(msgs.slice(0, -1)) }, ...userBlocks(last)];
  }
  return [{ type: "text", text: renderCheckpoint(msgs) }];
}

function toolResultsOf(msgs: LanguageModelV3Message[]) {
  const results: Array<{ toolCallId: string; outcome: ToolOutcome }> = [];
  for (const m of msgs) {
    if (m.role !== "tool") continue;
    for (const p of m.content as Part[]) {
      if (p.type === "tool-result") {
        results.push({ toolCallId: p.toolCallId, outcome: toOutcome(p.output) });
      }
    }
  }
  return results;
}

export function decideSync(
  record: SessionRecord | undefined,
  prompt: LanguageModelV3Prompt,
  fingerprint: string,
): SyncDecision {
  const msgs = prompt.filter((m) => m.role !== "system");
  if (!record) return { kind: "fresh", blocks: historyBlocks(msgs) };

  const hashes = record.messageHashes;
  const isPrefix =
    hashes.length <= msgs.length && hashes.every((h, i) => hashMessage(msgs[i]!) === h);
  if (record.fingerprint !== fingerprint || !isPrefix) {
    return { kind: "changed", blocks: historyBlocks(msgs) };
  }

  const afterPrefix = msgs.slice(hashes.length);
  if (record.interrupted) {
    return { kind: "catch-up", blocks: [{ type: "text", text: renderCheckpoint(afterPrefix) }] };
  }

  let start = 0;
  while (start < afterPrefix.length && afterPrefix[start]!.role === "assistant") start++;
  const tail = afterPrefix.slice(start);

  if (tail.length === 0) return { kind: "continue", blocks: [], toolResults: [] };
  if (tail.length === 1 && tail[0]!.role === "user") {
    return { kind: "continue", blocks: userBlocks(tail[0]!), toolResults: [] };
  }
  if (tail.every((m) => m.role === "tool")) {
    return { kind: "continue", blocks: [], toolResults: toolResultsOf(tail) };
  }
  return { kind: "catch-up", blocks: historyBlocks(tail) };
}

import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { ALLOWED_BUILTINS, BRIDGE_SERVER_NAME, BRIDGE_TOOL_NAME } from "./constants";
import type { BridgeCall } from "./mcp-bridge";
import type { AcpSessionUpdate, AcpToolCall, AcpUsage, PromptResult } from "./process";

export type ToolCallClass =
  | { kind: "bridge"; call: BridgeCall }
  | { kind: "builtin"; toolName: string }
  | { kind: "foreign-mcp"; serverName: string; toolName: string }
  | { kind: "violation"; toolName: string };

export type MappedEvent = {
  parts: LanguageModelV3StreamPart[];
  bridgeCall?: BridgeCall;
  violation?: { toolName: string };
};

const TOOL_SUMMARY_KEY = "toolSummary";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function stripToolSummary(input: unknown): unknown {
  if (isRecord(input) && TOOL_SUMMARY_KEY in input) {
    const { [TOOL_SUMMARY_KEY]: _omit, ...rest } = input;
    return rest;
  }
  return input;
}

export function classifyToolCall(tc: AcpToolCall): ToolCallClass {
  const name = tc.name;
  if (name === BRIDGE_TOOL_NAME) {
    const raw = isRecord(tc.rawInput) ? tc.rawInput : {};
    const serverName = raw.ServerName;
    const toolName = raw.ToolName;
    if (typeof serverName !== "string" || typeof toolName !== "string") {
      return { kind: "violation", toolName: name };
    }
    if (serverName === BRIDGE_SERVER_NAME) {
      const args = raw.Arguments === undefined ? {} : stripToolSummary(raw.Arguments);
      return { kind: "bridge", call: { callId: tc.toolCallId, toolName, input: args } };
    }
    return { kind: "foreign-mcp", serverName, toolName };
  }
  if (name !== undefined && ALLOWED_BUILTINS.has(name)) return { kind: "builtin", toolName: name };
  return { kind: "violation", toolName: name ?? "" };
}

function inputJson(tc: AcpToolCall, cls: ToolCallClass): string {
  if (cls.kind === "foreign-mcp" && isRecord(tc.rawInput) && tc.rawInput.Arguments !== undefined) {
    return JSON.stringify(tc.rawInput.Arguments);
  }
  return JSON.stringify(tc.rawInput ?? {});
}

function resultText(tc: AcpToolCall): string {
  const text = tc.content?.[0]?.content?.text;
  if (typeof text === "string") return text;
  if (typeof tc.rawOutput === "string") return tc.rawOutput;
  if (tc.rawOutput !== undefined && tc.rawOutput !== null) return JSON.stringify(tc.rawOutput);
  return "";
}

export class StreamMapper {
  private open?: { kind: "text" | "reasoning"; id: string };
  private counter = 0;
  private readonly seen = new Set<string>();
  private readonly providerCalls = new Map<string, string>();

  map(update: AcpSessionUpdate): MappedEvent {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return { parts: this.chunk("text", update.content) };
      case "agent_thought_chunk":
        return { parts: this.chunk("reasoning", update.content) };
      case "tool_call":
        return this.toolCall(update);
      case "tool_call_update":
        return { parts: this.toolUpdate(update) };
      default:
        return { parts: [] };
    }
  }

  flush(): LanguageModelV3StreamPart[] {
    return this.close();
  }

  private close(): LanguageModelV3StreamPart[] {
    const open = this.open;
    if (!open) return [];
    this.open = undefined;
    return [{ type: `${open.kind}-end`, id: open.id }];
  }

  private chunk(kind: "text" | "reasoning", content: { type: string; text?: string }): LanguageModelV3StreamPart[] {
    if (content?.type !== "text" || !content.text) return [];
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.open?.kind !== kind) {
      parts.push(...this.close());
      const id = `${kind}-${this.counter++}`;
      this.open = { kind, id };
      parts.push({ type: `${kind}-start`, id });
    }
    parts.push({ type: `${kind}-delta`, id: this.open!.id, delta: content.text });
    return parts;
  }

  private toolCall(tc: AcpToolCall): MappedEvent {
    if (this.seen.has(tc.toolCallId)) return { parts: [] };
    this.seen.add(tc.toolCallId);
    const cls = classifyToolCall(tc);
    const parts = this.close();
    switch (cls.kind) {
      case "violation":
        return { parts, violation: { toolName: cls.toolName } };
      case "bridge":
        parts.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName: cls.call.toolName,
          input: JSON.stringify(cls.call.input),
        });
        return { parts, bridgeCall: cls.call };
      default: {
        const toolName = cls.kind === "builtin" ? cls.toolName : `${cls.serverName}/${cls.toolName}`;
        this.providerCalls.set(tc.toolCallId, toolName);
        parts.push({
          type: "tool-call",
          toolCallId: tc.toolCallId,
          toolName,
          input: inputJson(tc, cls),
          providerExecuted: true,
        });
        return { parts };
      }
    }
  }

  private toolUpdate(tc: AcpToolCall): LanguageModelV3StreamPart[] {
    const toolName = this.providerCalls.get(tc.toolCallId);
    if (toolName === undefined) return [];
    if (tc.status !== "completed" && tc.status !== "failed") return [];
    this.providerCalls.delete(tc.toolCallId);
    const parts = this.close();
    parts.push({
      type: "tool-result",
      toolCallId: tc.toolCallId,
      toolName,
      result: resultText(tc),
      ...(tc.status === "failed" ? { isError: true } : {}),
    });
    return parts;
  }
}

export function mapStopReason(r: PromptResult["stopReason"]): LanguageModelV3FinishReason {
  switch (r) {
    case "end_turn":
      return { unified: "stop", raw: r };
    case "max_tokens":
    case "max_turn_requests":
      return { unified: "length", raw: r };
    case "refusal":
      return { unified: "content-filter", raw: r };
    default:
      return { unified: "other", raw: r };
  }
}

export function mapUsage(u?: AcpUsage): LanguageModelV3Usage {
  const input = u?.inputTokens;
  const cacheRead = u?.cachedReadTokens;
  const cacheWrite = u?.cachedWriteTokens;
  const out = u?.outputTokens;
  const thought = u?.thoughtTokens;
  return {
    inputTokens: {
      total: input,
      noCache: input === undefined ? undefined : input - (cacheRead ?? 0) - (cacheWrite ?? 0),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: out,
      text: out !== undefined && thought !== undefined ? out - thought : undefined,
      reasoning: thought,
    },
  };
}

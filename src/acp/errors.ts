import { MIN_AGY_VERSION } from "./constants";
import { JsonRpcError } from "./rpc";

export type AgyErrorCode =
  | "tos_disabled"
  | "auth_required"
  | "missing"
  | "too_old"
  | "plugin_install"
  | "bridge_unreachable"
  | "crash"
  | "other";

export const BRIDGE_NOT_CONNECTED_TEXT =
  'agy did not connect to the OpenCode tool bridge. Check that "agy plugin list" shows opencode-bridge, then retry.';

export const TOS_DISABLED_TEXT =
  "Google disabled Antigravity access for this account for a Terms of Service violation. Submit an appeal to Google, or switch the google-agy-acp provider to the Gemini API key or Vertex (Agent Platform) method.";

const TOS_MARKER = "disabled in this account for violation of Terms of Service";
const ACP_AUTH_REQUIRED_CODE = -32000;

/** Error with a known classification, raised by the provider itself. */
export class AgyAcpError extends Error {
  constructor(
    readonly code: AgyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgyAcpError";
  }
}

function errorText(e: unknown): string {
  if (e instanceof JsonRpcError && e.data !== undefined) {
    const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
    return `${e.message} ${data}`;
  }
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

function probeStatus(e: unknown): { status: string; version?: string } | undefined {
  if (e && typeof e === "object" && !(e instanceof Error) && typeof (e as any).status === "string") {
    return e as { status: string; version?: string };
  }
  return undefined;
}

const MISSING_TEXT = `agy CLI not found. Install the Antigravity CLI (agy ${MIN_AGY_VERSION} or newer) or set OPENCODE_AGY_PATH to its path.`;

export function classifyAgyError(e: unknown): { code: AgyErrorCode; message: string } {
  if (e instanceof AgyAcpError) return { code: e.code, message: e.message };

  const probe = probeStatus(e);
  if (probe?.status === "missing") return { code: "missing", message: MISSING_TEXT };
  if (probe?.status === "too_old") {
    return {
      code: "too_old",
      message: `agy ${probe.version ?? "(unknown version)"} is too old; google-agy-acp needs agy ${MIN_AGY_VERSION} or newer. Update the Antigravity CLI.`,
    };
  }

  const text = errorText(e);
  if (text.includes(TOS_MARKER)) return { code: "tos_disabled", message: TOS_DISABLED_TEXT };
  if (
    (e instanceof JsonRpcError && e.code === ACP_AUTH_REQUIRED_CODE) ||
    /authentication required|unauthenticated|not authenticated|not logged in|login required/i.test(text)
  ) {
    return {
      code: "auth_required",
      message: `agy authentication required (${text}). Sign in by running "agy", or switch the google-agy-acp provider to the Gemini API key or Vertex (Agent Platform) method.`,
    };
  }
  if (/\bENOENT\b/.test(text)) return { code: "missing", message: MISSING_TEXT };
  if (/agy plugin install|install the agy plugin/i.test(text)) return { code: "plugin_install", message: text };
  if (/did not connect to the OpenCode tool bridge|bridge.*(timed? ?out|unreachable|not connect)/i.test(text)) {
    return { code: "bridge_unreachable", message: BRIDGE_NOT_CONNECTED_TEXT };
  }
  if (/agy acp exited/i.test(text)) return { code: "crash", message: `agy crashed: ${text}` };
  return { code: "other", message: text };
}

/** Converts any failure into the Error value carried by an AI SDK `error` stream part. */
export function toAgyError(e: unknown): AgyAcpError {
  const { code, message } = classifyAgyError(e);
  return e instanceof AgyAcpError ? e : new AgyAcpError(code, message);
}

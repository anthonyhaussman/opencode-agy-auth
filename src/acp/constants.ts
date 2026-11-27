import os from "node:os";
import path from "node:path";

export const AGY_ACP_PROVIDER_ID = "google-agy-acp";
export const MIN_AGY_VERSION = "1.5.10";

export const STARTUP_TIMEOUT_MS = 30_000;
export const IDLE_TIMEOUT_MS = 300_000;
/** How long plugin setup waits for the first `agy models` before returning. */
export const MODELS_STARTUP_WAIT_MS = 10_000;
export const BRIDGE_CONNECT_TIMEOUT_MS = 10_000;
/** How long a cancelled agy turn may take to settle before its process is disposed. */
export const CANCEL_SETTLE_TIMEOUT_MS = 10_000;
export const MCP_HARD_TIMEOUT_MS = 180_000;
export const MCP_SOFT_TIMEOUT_MS = 170_000;

export const AGY_PLUGIN_NAME = "opencode-bridge";
export const AGY_AGENT_NAME = "opencode";
export const BRIDGE_SERVER_KEY = "bridge";
export const BRIDGE_SERVER_NAME = "opencode-bridge_bridge";
export const BRIDGE_TOOL_NAME = "call_mcp_tool";

export const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  "read_file",
  "list_resources",
  "read_resource",
  "manage_task",
]);

export const AGY_SPAWN_ARGS: readonly string[] = ["acp", "--agent", "opencode"];

export const BRIDGE_URL_ENV = "AGY_ACP_BRIDGE_URL";
export const BRIDGE_TOKEN_ENV = "AGY_ACP_BRIDGE_TOKEN";
export const AGY_API_KEY_ENV = "GEMINI_API_KEY";
export const AGY_API_KEY_OVERRIDE_ENV = "GOOGLE_API_KEY";
export const AGY_ADC_ENV = "AGY_ADC_AUTH";

export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
export const MODE_CONFIG_ID = "mode";
export type AgyTier = "low" | "medium" | "high";

export const STILL_RUNNING_TEXT =
  "Still running in OpenCode (waiting on execution or user permission); the result will be sent with the next message.";
export const CANCELLED_TEXT = "Cancelled by user";

export const SESSION_HEADER = "x-opencode-session-id";
export const KIND_HEADER = "x-opencode-request-kind";

export function agyAcpDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), ".local/share");
  return path.join(base, "opencode", "agy-acp");
}

export function agyMcpSchemaDir(home: string = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "mcp", BRIDGE_SERVER_NAME);
}

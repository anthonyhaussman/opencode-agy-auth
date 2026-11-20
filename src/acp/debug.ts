import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { agyAcpDataDir } from "./constants";

export type AgyDebugLog = (event: string, detail?: string) => void;

/** Env switch for the opt-in agy ACP debug log. */
export const AGY_ACP_DEBUG_ENV = "AGY_ACP_DEBUG";
/** Optional override for the debug log path. */
export const AGY_ACP_DEBUG_FILE_ENV = "AGY_ACP_DEBUG_FILE";

/**
 * Returns a logger that appends timestamped lines to a private file when
 * AGY_ACP_DEBUG=1, or undefined when debugging is off. The logger redacts the
 * given secrets and never throws.
 */
export function createAgyDebugLog(
  env: NodeJS.ProcessEnv = process.env,
  secrets: (string | undefined)[] = [],
): AgyDebugLog | undefined {
  if (env[AGY_ACP_DEBUG_ENV] !== "1") return undefined;
  const file = env[AGY_ACP_DEBUG_FILE_ENV] || path.join(agyAcpDataDir(env), "debug.log");
  const hidden = secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  return (event, detail) => {
    try {
      let line = detail === undefined ? event : `${event} ${detail}`;
      for (const secret of hidden) line = line.split(secret).join("[redacted]");
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Debug logging must never break the provider.
    }
  };
}

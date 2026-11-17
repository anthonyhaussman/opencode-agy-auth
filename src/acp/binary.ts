import { execFile } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { MIN_AGY_VERSION } from "./constants";

export type ExecFn = (
  file: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export type AgyProbe =
  | { status: "missing" }
  | { status: "too_old"; path: string; version: string }
  | { status: "ready"; path: string; version: string }
  | { status: "failed"; path: string; error: string };

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * OPENCODE_AGY_PATH wins when set and executable; otherwise `agy` is looked up
 * on PATH. A non-executable override falls back to the PATH lookup.
 */
export async function resolveAgyPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const override = env.OPENCODE_AGY_PATH;
  if (override && (await isExecutable(override))) return override;
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, "agy");
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: opts?.env, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export async function probeAgy(
  env: NodeJS.ProcessEnv = process.env,
  exec: ExecFn = defaultExec,
): Promise<AgyProbe> {
  const agyPath = await resolveAgyPath(env);
  if (!agyPath) return { status: "missing" };
  try {
    const { stdout } = await exec(agyPath, ["--version"], { env });
    const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
    if (!version) {
      return {
        status: "failed",
        path: agyPath,
        error: `Could not parse agy version from output: ${stdout.trim()}`,
      };
    }
    return compareVersions(version, MIN_AGY_VERSION) < 0
      ? { status: "too_old", path: agyPath, version }
      : { status: "ready", path: agyPath, version };
  } catch (error) {
    return {
      status: "failed",
      path: agyPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

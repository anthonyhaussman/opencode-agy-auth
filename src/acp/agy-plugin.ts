import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExec, type ExecFn } from "./binary";
import { AGY_PLUGIN_NAME, agyAcpDataDir } from "./constants";

/** Bump whenever any file under agy-plugin/ changes (must equal plugin.json version). */
export const AGY_PLUGIN_VERSION = "1.0.1";

export const AGY_PLUGIN_NOTICE =
  'google-agy-acp installed the agy plugin "opencode-bridge" into agy\'s global plugins (~/.gemini/config/plugins/) so agy can call OpenCode tools. Remove it with: agy plugin uninstall opencode-bridge';

export interface AgyPluginStamp {
  version: string;
  nodePath: string;
  dir: string;
  installedAt: number;
  /** Extra env for the bridge process (BUN_BE_BUN under compiled OpenCode). */
  launchEnv?: Record<string, string>;
}

/**
 * Compiled OpenCode is a bun binary: running it with a script path starts
 * OpenCode itself unless BUN_BE_BUN=1 makes it behave as plain bun.
 */
export function bridgeLaunchEnv(
  versions: { bun?: string } = process.versions as { bun?: string },
): Record<string, string> | undefined {
  return versions.bun ? { BUN_BE_BUN: "1" } : undefined;
}

function sameEnv(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export type AgyPluginStatus = "installed" | "updated" | "current";

export function agyPluginTemplateDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "agy-plugin");
    if (existsSync(path.join(candidate, "plugin.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("agy-plugin template directory not found");
}

export async function materializeAgyPlugin(o: {
  templateDir: string;
  dataDir: string;
  nodePath: string;
  version: string;
  launchEnv?: Record<string, string>;
}): Promise<string> {
  const dir = path.join(o.dataDir, "agy-plugin", o.version);
  await mkdir(dir, { recursive: true });
  await cp(o.templateDir, dir, { recursive: true, force: true });
  const config = {
    mcpServers: {
      bridge: {
        command: o.nodePath,
        args: [path.join(dir, "bridge-proxy.mjs")],
        ...(o.launchEnv ? { env: o.launchEnv } : {}),
      },
    },
  };
  await writeFile(path.join(dir, "mcp_config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

async function readStamp(file: string): Promise<AgyPluginStamp | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as AgyPluginStamp;
    return typeof parsed?.version === "string" && typeof parsed.nodePath === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

export async function ensureAgyPlugin(o: {
  agyPath: string;
  templateDir?: string;
  dataDir?: string;
  nodePath?: string;
  launchEnv?: Record<string, string>;
  exec?: ExecFn;
}): Promise<{ status: AgyPluginStatus; dir: string; version: string }> {
  const dataDir = o.dataDir ?? agyAcpDataDir();
  const nodePath = o.nodePath ?? process.execPath;
  const launchEnv = o.launchEnv ?? bridgeLaunchEnv();
  const exec = o.exec ?? defaultExec;
  const version = AGY_PLUGIN_VERSION;
  const stampFile = path.join(dataDir, "agy-plugin", "installed.json");
  const stamp = await readStamp(stampFile);

  let listed = false;
  try {
    const { stdout } = await exec(o.agyPath, ["plugin", "list"]);
    listed = stdout.includes(AGY_PLUGIN_NAME);
  } catch {
    listed = false;
  }

  const materialized = typeof stamp?.dir === "string" && existsSync(path.join(stamp.dir, "bridge-proxy.mjs"));
  if (stamp && stamp.version === version && stamp.nodePath === nodePath && sameEnv(stamp.launchEnv, launchEnv) && listed && materialized) {
    return { status: "current", dir: stamp.dir, version };
  }

  const dir = await materializeAgyPlugin({
    templateDir: o.templateDir ?? agyPluginTemplateDir(),
    dataDir,
    nodePath,
    version,
    ...(launchEnv ? { launchEnv } : {}),
  });

  if (stamp || listed) {
    try {
      await exec(o.agyPath, ["plugin", "uninstall", AGY_PLUGIN_NAME]);
    } catch {
      // Ignored: install below surfaces any real problem.
    }
  }

  try {
    await exec(o.agyPath, ["plugin", "install", dir]);
  } catch (error) {
    throw new Error(
      `Failed to install the agy plugin: ${errorText(error)}. Install it manually with: agy plugin install ${dir}`,
    );
  }

  const next: AgyPluginStamp = {
    version,
    nodePath,
    dir,
    installedAt: Date.now(),
    ...(launchEnv ? { launchEnv } : {}),
  };
  await mkdir(path.dirname(stampFile), { recursive: true });
  await writeFile(stampFile, JSON.stringify(next), { mode: 0o600 });
  await chmod(stampFile, 0o600);
  const stale = stamp !== null && (stamp.version !== version || stamp.nodePath !== nodePath || !sameEnv(stamp.launchEnv, launchEnv));
  return { status: stale || listed ? "updated" : "installed", dir, version };
}

export function createAgyPluginInstaller(
  o: Parameters<typeof ensureAgyPlugin>[0] & { notify: (msg: string) => void },
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      pending = ensureAgyPlugin(o).then(
        (result) => {
          if (result.status !== "current") o.notify(AGY_PLUGIN_NOTICE);
        },
        (error) => {
          pending = undefined;
          throw error;
        },
      );
    }
    return pending;
  };
}

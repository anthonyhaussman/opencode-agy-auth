import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecFn } from "../../src/acp/binary";
import {
  AGY_PLUGIN_NOTICE,
  AGY_PLUGIN_VERSION,
  agyPluginTemplateDir,
  bridgeLaunchEnv,
  createAgyPluginInstaller,
  ensureAgyPlugin,
  materializeAgyPlugin,
  type AgyPluginStamp,
} from "../../src/acp/agy-plugin";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, "..", "fixtures", "fake-agy-cli.mjs");
const root = path.join(here, "..", "..");

let tmp: string;
let statePath: string;
let logPath: string;
let dataDir: string;

const exec: ExecFn = (_file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fakeCli, ...args],
      {
        env: { ...process.env, FAKE_AGY_STATE: statePath, FAKE_AGY_LOG: logPath },
      },
      (error, stdout, stderr) => {
        if (error) {
          const e = new Error(error.message) as Error & { stderr: string };
          e.stderr = String(stderr);
          reject(e);
        } else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function log(): string[] {
  try {
    return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
function setState(plugins: string[]): void {
  fs.writeFileSync(statePath, JSON.stringify({ plugins }));
}
function stampPath(): string {
  return path.join(dataDir, "agy-plugin", "installed.json");
}
function writeStamp(partial: Partial<AgyPluginStamp>): void {
  fs.mkdirSync(path.dirname(stampPath()), { recursive: true });
  fs.writeFileSync(
    stampPath(),
    JSON.stringify({
      version: AGY_PLUGIN_VERSION,
      nodePath: process.execPath,
      dir: "/x",
      installedAt: 1,
      ...partial,
    }),
  );
}
const base = () => ({
  agyPath: "agy",
  dataDir,
  nodePath: process.execPath,
  exec,
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-"));
  statePath = path.join(tmp, "state.json");
  logPath = path.join(tmp, "log.txt");
  dataDir = path.join(tmp, "data");
  delete process.env.FAKE_AGY_INSTALL_FAIL;
});
afterEach(() => {
  delete process.env.FAKE_AGY_INSTALL_FAIL;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("template", () => {
  it("template_matches_contract", () => {
    const dir = agyPluginTemplateDir();
    const plugin = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
    expect(plugin.name).toBe("opencode-bridge");
    expect(plugin.version).toBe(AGY_PLUGIN_VERSION);

    const md = fs.readFileSync(path.join(dir, "agents", "opencode.md"), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
    expect(match).not.toBeNull();
    const front: Record<string, unknown> = {};
    for (const line of match![1].split("\n")) {
      const [k, ...rest] = line.split(":");
      const v = rest.join(":").trim();
      if (v === "true") front[k] = true;
      else if (v === "false") front[k] = false;
      else if (v.startsWith("[")) front[k] = v.slice(1, -1).split(",").map((s) => s.trim());
      else front[k] = v;
    }
    expect(front).toMatchObject({
      name: "opencode",
      mainAgent: true,
      subagent: false,
      enable_mcp_tools: true,
      tools: ["read_file"],
    });
    expect(match![2]).toContain("call_mcp_tool");
    expect(match![2]).toContain("opencode-bridge_bridge");

    const mcp = JSON.parse(fs.readFileSync(path.join(dir, "mcp_config.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["bridge"]);
  });

  it("package_files_include_template", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.files).toContain("agy-plugin/");
  });
});

describe("materializeAgyPlugin", () => {
  it("materialize_writes_absolute_paths", async () => {
    const dir = await materializeAgyPlugin({
      templateDir: agyPluginTemplateDir(),
      dataDir,
      nodePath: "/usr/bin/node",
      version: "9.9.9",
    });
    expect(dir).toBe(path.join(dataDir, "agy-plugin", "9.9.9"));
    const raw = fs.readFileSync(path.join(dir, "mcp_config.json"), "utf8");
    const cfg = JSON.parse(raw);
    expect(cfg.mcpServers.bridge.command).toBe("/usr/bin/node");
    const proxy = cfg.mcpServers.bridge.args[0] as string;
    expect(path.isAbsolute(proxy)).toBe(true);
    expect(proxy.endsWith("bridge-proxy.mjs")).toBe(true);
    expect(fs.existsSync(proxy)).toBe(true);
    expect(raw).not.toContain("__NODE_PATH__");
    expect(raw).not.toContain("__PROXY_PATH__");
    // idempotent
    await expect(
      materializeAgyPlugin({
        templateDir: agyPluginTemplateDir(),
        dataDir,
        nodePath: "/usr/bin/node",
        version: "9.9.9",
      }),
    ).resolves.toBe(dir);
  });

  it("materialize_writes_launch_env_only_when_given", async () => {
    const withEnv = await materializeAgyPlugin({
      templateDir: agyPluginTemplateDir(),
      dataDir,
      nodePath: "/opt/opencode",
      launchEnv: { BUN_BE_BUN: "1" },
      version: "9.9.9",
    });
    let cfg = JSON.parse(fs.readFileSync(path.join(withEnv, "mcp_config.json"), "utf8"));
    expect(cfg.mcpServers.bridge.command).toBe("/opt/opencode");
    expect(cfg.mcpServers.bridge.env).toEqual({ BUN_BE_BUN: "1" });

    await materializeAgyPlugin({ templateDir: agyPluginTemplateDir(), dataDir, nodePath: "/usr/bin/node", version: "9.9.9" });
    cfg = JSON.parse(fs.readFileSync(path.join(withEnv, "mcp_config.json"), "utf8"));
    expect(cfg.mcpServers.bridge).not.toHaveProperty("env");
  });
});

describe("bridgeLaunchEnv", () => {
  it("runs a bun-compiled host as bun", () => {
    expect(bridgeLaunchEnv({ node: "24.0.0", bun: "1.3.0" })).toEqual({ BUN_BE_BUN: "1" });
  });

  it("needs no env under node", () => {
    expect(bridgeLaunchEnv({ node: "24.0.0" })).toBeUndefined();
  });
});

describe("ensureAgyPlugin", () => {
  it("installs_once_with_notice", async () => {
    const notes: string[] = [];
    const ensure = createAgyPluginInstaller({ ...base(), notify: (m) => notes.push(m) });
    await ensure();
    expect(log().some((l) => l.startsWith("plugin install "))).toBe(true);
    expect(fs.statSync(stampPath()).mode & 0o777).toBe(0o600);
    const r2 = await ensureAgyPlugin(base());
    expect(r2.status).toBe("current");
    await ensure();
    expect(log().filter((l) => l.startsWith("plugin install "))).toHaveLength(1);
    expect(notes).toEqual([AGY_PLUGIN_NOTICE]);
  });

  it("returns_installed_status", async () => {
    const r = await ensureAgyPlugin(base());
    expect(r.status).toBe("installed");
    expect(r.version).toBe(AGY_PLUGIN_VERSION);
    expect(r.dir).toBe(path.join(dataDir, "agy-plugin", AGY_PLUGIN_VERSION));
  });

  it("reinstalls_on_stamp_change", async () => {
    for (const partial of [{ version: "0.0.1" }, { nodePath: "/other/node" }]) {
      fs.rmSync(logPath, { force: true });
      setState(["opencode-bridge"]);
      writeStamp(partial);
      const notes: string[] = [];
      const ensure = createAgyPluginInstaller({ ...base(), notify: (m) => notes.push(m) });
      await ensure();
      const l = log();
      expect(l).toContain("plugin uninstall opencode-bridge");
      expect(l.findIndex((x) => x.startsWith("plugin install "))).toBeGreaterThan(
        l.indexOf("plugin uninstall opencode-bridge"),
      );
      expect(notes).toHaveLength(1);
      const r = await ensureAgyPlugin(base());
      expect(r.status).toBe("current");
    }
    setState(["opencode-bridge"]);
    writeStamp({ version: "0.0.1" });
    expect((await ensureAgyPlugin(base())).status).toBe("updated");
  });

  it("reinstalls_when_launch_env_changes", async () => {
    setState(["opencode-bridge"]);
    writeStamp({});
    const bun = { ...base(), launchEnv: { BUN_BE_BUN: "1" } };
    expect((await ensureAgyPlugin(bun)).status).toBe("updated");
    expect(log()).toContain("plugin uninstall opencode-bridge");
    expect((await ensureAgyPlugin(bun)).status).toBe("current");
    expect((await ensureAgyPlugin(base())).status).toBe("updated");
    expect((await ensureAgyPlugin(base())).status).toBe("current");
  });

  it("reinstalls_when_missing_from_list", async () => {
    await ensureAgyPlugin(base());
    setState([]);
    fs.rmSync(logPath, { force: true });
    const r = await ensureAgyPlugin(base());
    expect(r.status).toBe("installed");
    expect(log().some((l) => l.startsWith("plugin install "))).toBe(true);
  });

  it("missing_materialized_dir_reinstalls", async () => {
    const first = await ensureAgyPlugin(base());
    expect((await ensureAgyPlugin(base())).status).toBe("current");
    fs.rmSync(first.dir, { recursive: true, force: true });
    fs.rmSync(logPath, { force: true });
    const r = await ensureAgyPlugin(base());
    expect(r.status).toBe("updated");
    expect(fs.existsSync(path.join(r.dir, "bridge-proxy.mjs"))).toBe(true);
    expect(log().some((l) => l.startsWith("plugin install "))).toBe(true);
  });

  it("never_touches_other_plugins", async () => {
    setState(["lean-ctx"]);
    await ensureAgyPlugin(base());
    writeStamp({ version: "0.0.1" });
    await ensureAgyPlugin(base());
    expect(log().some((l) => l.includes("lean-ctx"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).plugins).toContain("lean-ctx");
  });

  it("install_failure_surfaces", async () => {
    process.env.FAKE_AGY_INSTALL_FAIL = "1";
    const ensure = createAgyPluginInstaller({ ...base(), notify: () => {} });
    await expect(ensure()).rejects.toThrow(/install failed[\s\S]*agy plugin install/);
    expect(fs.existsSync(stampPath())).toBe(false);
    delete process.env.FAKE_AGY_INSTALL_FAIL;
    await expect(ensure()).resolves.toBeUndefined();
    expect(fs.existsSync(stampPath())).toBe(true);
  });

  it("concurrent_calls_share_install", async () => {
    const ensure = createAgyPluginInstaller({ ...base(), notify: () => {} });
    await Promise.all([ensure(), ensure()]);
    expect(log().filter((l) => l.startsWith("plugin install "))).toHaveLength(1);
  });

  it("tolerates_failing_uninstall_and_corrupt_stamp", async () => {
    fs.mkdirSync(path.dirname(stampPath()), { recursive: true });
    fs.writeFileSync(stampPath(), "{not json");
    const failing: ExecFn = (file, args, opts) =>
      args[1] === "uninstall" ? Promise.reject(new Error("nope")) : exec(file, args, opts);
    setState(["opencode-bridge"]);
    const r = await ensureAgyPlugin({ ...base(), exec: failing });
    expect(r.status).toBe("updated");
  });

  it("treats_list_failure_as_empty", async () => {
    const noList: ExecFn = (file, args, opts) =>
      args[1] === "list" ? Promise.reject(new Error("boom")) : exec(file, args, opts);
    const r = await ensureAgyPlugin({ ...base(), exec: noList });
    expect(r.status).toBe("installed");
  });

  it("install_failure_without_stderr_uses_message", async () => {
    const bad: ExecFn = (file, args, opts) =>
      args[1] === "install" ? Promise.reject(new Error("spawn ENOENT")) : exec(file, args, opts);
    await expect(ensureAgyPlugin({ ...base(), exec: bad })).rejects.toThrow(/spawn ENOENT/);
  });
});

#!/usr/bin/env node
// Fake `agy plugin list|install <dir>|uninstall <name>` backed by a JSON state file.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const statePath = process.env.FAKE_AGY_STATE;
const logPath = process.env.FAKE_AGY_LOG;
if (logPath) fs.appendFileSync(logPath, `${argv.join(" ")}\n`);

function load() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")).plugins ?? [];
  } catch {
    return [];
  }
}
function save(plugins) {
  fs.writeFileSync(statePath, JSON.stringify({ plugins }));
}

const [group, cmd, arg] = argv;
if (group !== "plugin") {
  process.stderr.write("unknown command\n");
  process.exit(2);
}
if (cmd === "list") {
  process.stdout.write(load().map((p) => `${p}\n`).join(""));
} else if (cmd === "install") {
  if (process.env.FAKE_AGY_INSTALL_FAIL === "1") {
    process.stderr.write("install failed\n");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(arg, "plugin.json"), "utf8"));
  const plugins = load().filter((p) => p !== manifest.name);
  plugins.push(manifest.name);
  save(plugins);
} else if (cmd === "uninstall") {
  save(load().filter((p) => p !== arg));
} else {
  process.stderr.write("unknown plugin command\n");
  process.exit(2);
}

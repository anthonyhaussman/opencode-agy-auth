import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");

describe("README", () => {
  it("readme_discloses_risks", () => {
    for (const needle of [
      "agy plugin uninstall opencode-bridge",
      "~/.gemini/config/plugins",
      "read_file",
      "outside the workspace",
      "~/.gemini/antigravity-cli/mcp/opencode-bridge_bridge",
      "GEMINI_API_KEY",
      "1.5.10",
    ]) {
      expect(readme, needle).toContain(needle);
    }
    expect(readme).not.toContain(String.fromCharCode(0x2014));
  });

  it("documents requirements, disclaimer and runtime notes", () => {
    for (const needle of [
      "OpenCode >= 2.4.0",
      "tools.opencode.session_move",
      "OPENCODE_AGY_PATH",
      "google-agy-acp",
      "makes no claim",
      "170 s",
      "5 minutes",
    ]) {
      expect(readme, needle).toContain(needle);
    }
  });

  it("no longer documents the v1 runtime", () => {
    expect(readme).not.toMatch(/OpenCode v1|server\(options\)/);
  });
});

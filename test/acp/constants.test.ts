import { describe, expect, it } from "vitest";
import {
  AGY_AGENT_NAME,
  AGY_PLUGIN_NAME,
  AGY_SPAWN_ARGS,
  ALLOWED_BUILTINS,
  BRIDGE_SERVER_KEY,
  BRIDGE_SERVER_NAME,
  MCP_HARD_TIMEOUT_MS,
  MCP_SOFT_TIMEOUT_MS,
  agyAcpDataDir,
  agyMcpSchemaDir,
} from "../../src/acp/constants";
import os from "node:os";

describe("acp constants", () => {
  it("builds the bridge server name", () => {
    expect(BRIDGE_SERVER_NAME).toBe(`${AGY_PLUGIN_NAME}_${BRIDGE_SERVER_KEY}`);
  });

  it("uses the expected spawn args", () => {
    expect([...AGY_SPAWN_ARGS]).toEqual(["acp", "--agent", AGY_AGENT_NAME]);
  });

  it("soft timeout is below hard timeout", () => {
    expect(MCP_SOFT_TIMEOUT_MS).toBeLessThan(MCP_HARD_TIMEOUT_MS);
  });

  it("allows exactly four builtins", () => {
    expect(ALLOWED_BUILTINS.size).toBe(4);
    expect(ALLOWED_BUILTINS.has("call_mcp_tool")).toBe(false);
  });

  it("resolves data dir from XDG_DATA_HOME", () => {
    expect(agyAcpDataDir({ XDG_DATA_HOME: "/x" })).toBe("/x/opencode/agy-acp");
  });

  it("falls back to HOME then os.homedir for data dir", () => {
    expect(agyAcpDataDir({ HOME: "/h" })).toBe("/h/.local/share/opencode/agy-acp");
    expect(agyAcpDataDir({})).toBe(`${os.homedir()}/.local/share/opencode/agy-acp`);
  });

  it("resolves the mcp schema dir", () => {
    expect(agyMcpSchemaDir("/h")).toMatch(/\/\.gemini\/antigravity-cli\/mcp\/opencode-bridge_bridge$/);
    expect(agyMcpSchemaDir()).toContain(os.homedir());
  });
});

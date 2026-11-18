import { describe, expect, it } from "vitest";
import { decidePermission } from "../../src/acp/permission";
import type { AcpPermissionOption, AcpPermissionRequest } from "../../src/acp/process";

const BOTH: AcpPermissionOption[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

function req(toolCall: AcpPermissionRequest["toolCall"], options = BOTH): AcpPermissionRequest {
  return { sessionId: "s1", toolCall, options };
}

const bridgeCall = {
  toolCallId: "t1",
  name: "call_mcp_tool",
  rawInput: { ServerName: "opencode-bridge_bridge", ToolName: "read", Arguments: { path: "a" } },
};

describe("decidePermission", () => {
  it("allows a bridge call with allow_once", () => {
    expect(decidePermission(req(bridgeCall))).toEqual({
      response: { outcome: { outcome: "selected", optionId: "allow" } },
      allowed: true,
    });
  });

  it("rejects read_file", () => {
    const r = decidePermission(req({ toolCallId: "t2", name: "read_file", rawInput: { path: "/x" } }));
    expect(r).toEqual({ response: { outcome: { outcome: "selected", optionId: "deny" } }, allowed: false });
  });

  it("rejects a foreign MCP server", () => {
    const r = decidePermission(
      req({ ...bridgeCall, rawInput: { ServerName: "lean-ctx_server", ToolName: "x", Arguments: {} } }),
    );
    expect(r.response).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(r.allowed).toBe(false);
  });

  it("cancels when no reject option exists", () => {
    const r = decidePermission(req({ toolCallId: "t3", name: "run_command" }, [BOTH[0]!]));
    expect(r.response).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("selects allow_always when it is the only allow option", () => {
    const r = decidePermission(req(bridgeCall, [{ optionId: "always", kind: "allow_always" }]));
    expect(r.response).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
  });

  it("falls back to reject_always", () => {
    const r = decidePermission(req({ toolCallId: "t4", name: "write_file" }, [{ optionId: "never", kind: "reject_always" }]));
    expect(r.response).toEqual({ outcome: { outcome: "selected", optionId: "never" } });
  });

  it("treats a missing tool call and options as a violation", () => {
    const r = decidePermission({ sessionId: "s1" } as unknown as AcpPermissionRequest);
    expect(r).toEqual({ response: { outcome: { outcome: "cancelled" } }, allowed: false });
  });
});

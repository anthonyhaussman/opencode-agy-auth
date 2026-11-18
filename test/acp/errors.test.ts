import { describe, expect, it } from "vitest";
import {
  AgyAcpError,
  BRIDGE_NOT_CONNECTED_TEXT,
  classifyAgyError,
  TOS_DISABLED_TEXT,
  toAgyError,
} from "../../src/acp/errors";
import { JsonRpcError } from "../../src/acp/rpc";

describe("classifyAgyError", () => {
  it("maps the ToS text to the exact copy", () => {
    const e = new JsonRpcError(-32603, "Gemini access is disabled in this account for violation of Terms of Service.");
    expect(classifyAgyError(e)).toEqual({ code: "tos_disabled", message: TOS_DISABLED_TEXT });
    expect(TOS_DISABLED_TEXT).toBe(
      "Google disabled Antigravity access for this account for a Terms of Service violation. Submit an appeal to Google, or switch the google-agy-acp provider to the Gemini API key or Vertex (Agent Platform) method.",
    );
  });

  it("finds ToS text in JSON-RPC error data", () => {
    const e = new JsonRpcError(-32603, "internal", { detail: "disabled in this account for violation of Terms of Service" });
    expect(classifyAgyError(e).code).toBe("tos_disabled");
    const s = new JsonRpcError(-32603, "internal", "disabled in this account for violation of Terms of Service");
    expect(classifyAgyError(s).code).toBe("tos_disabled");
  });

  it("detects auth required by text and by -32000", () => {
    expect(classifyAgyError(new Error("Authentication required")).code).toBe("auth_required");
    const e = classifyAgyError(new JsonRpcError(-32000, "nope"));
    expect(e.code).toBe("auth_required");
    expect(e.message).toContain("agy");
  });

  it("classifies missing and too_old probes", () => {
    expect(classifyAgyError({ status: "missing" }).code).toBe("missing");
    const old = classifyAgyError({ status: "too_old", path: "/x", version: "1.0.0" });
    expect(old.code).toBe("too_old");
    expect(old.message).toContain("1.0.0");
    expect(old.message).toContain("1.5.10");
    expect(classifyAgyError({ status: "too_old" }).message).toContain("unknown version");
    expect(classifyAgyError(new Error("spawn /x/agy ENOENT")).code).toBe("missing");
  });

  it("classifies plugin install failures", () => {
    const e = new Error("Failed to install the agy plugin: boom. Install it manually with: agy plugin install /d");
    expect(classifyAgyError(e)).toEqual({ code: "plugin_install", message: e.message });
  });

  it("classifies bridge timeouts", () => {
    expect(classifyAgyError(new Error("bridge connect timed out"))).toEqual({
      code: "bridge_unreachable",
      message: BRIDGE_NOT_CONNECTED_TEXT,
    });
  });

  it("classifies process exits as crash", () => {
    const e = classifyAgyError(new Error("agy acp exited (code 1, signal none): segfault"));
    expect(e.code).toBe("crash");
    expect(e.message).toContain("segfault");
  });

  it("keeps the original message for anything else", () => {
    expect(classifyAgyError(new Error("weird"))).toEqual({ code: "other", message: "weird" });
    expect(classifyAgyError("plain")).toEqual({ code: "other", message: "plain" });
    expect(classifyAgyError({ a: 1 })).toEqual({ code: "other", message: '{"a":1}' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(classifyAgyError(cyclic).code).toBe("other");
    expect(classifyAgyError(undefined)).toEqual({ code: "other", message: "undefined" });
  });

  it("passes AgyAcpError through", () => {
    const e = new AgyAcpError("bridge_unreachable", BRIDGE_NOT_CONNECTED_TEXT);
    expect(classifyAgyError(e)).toEqual({ code: "bridge_unreachable", message: BRIDGE_NOT_CONNECTED_TEXT });
    expect(toAgyError(e)).toBe(e);
    const wrapped = toAgyError(new Error("x"));
    expect(wrapped).toBeInstanceOf(AgyAcpError);
    expect(wrapped.code).toBe("other");
  });
});

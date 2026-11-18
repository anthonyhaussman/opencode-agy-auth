import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LanguageModelV3Message, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  SessionStore,
  decideSync,
  fingerprintOf,
  hashMessage,
  renderCheckpoint,
  renderToolIndex,
  type SessionRecord,
} from "../../src/acp/session-sync";

const sys: LanguageModelV3Message = { role: "system", content: "SYSTEM" };
const user = (t: string): LanguageModelV3Message => ({
  role: "user",
  content: [{ type: "text", text: t }],
});
const asst = (t: string): LanguageModelV3Message => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
});
const toolMsg = (id: string, name: string, output: any): LanguageModelV3Message => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName: name, output }],
});

function rec(msgs: LanguageModelV3Message[], over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    agySessionId: "s1",
    fingerprint: "fp",
    messageHashes: msgs.map(hashMessage),
    interrupted: false,
    updatedAt: Date.now(),
    ...over,
  };
}

describe("hashMessage / fingerprintOf", () => {
  it("ignores providerOptions and key order", () => {
    const a = hashMessage({ role: "user", content: [{ type: "text", text: "x" }] });
    const b = hashMessage({
      role: "user",
      content: [{ text: "x", type: "text", providerOptions: { a: { b: 1 } } }],
      providerOptions: { z: {} },
    } as any);
    expect(a).toBe(b);
    expect(hashMessage(user("y"))).not.toBe(a);
  });

  it("hashes binary data as base64", () => {
    const m1 = hashMessage({
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }],
    });
    const m2 = hashMessage({
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: "AQID" }],
    });
    expect(m1).toBe(m2);
  });

  it("fingerprint depends on each input and sorts tools", () => {
    const t1 = { name: "a", inputSchema: {} };
    const t2 = { name: "b", inputSchema: {} };
    const A = { method: "api", identity: "x" };
    const base = fingerprintOf("s", [t1, t2], A, "m", undefined);
    expect(fingerprintOf("s", [t2, t1], A, "m", undefined)).toBe(base);
    expect(fingerprintOf("s2", [t1, t2], A, "m", undefined)).not.toBe(base);
    expect(fingerprintOf("s", [t1], A, "m", undefined)).not.toBe(base);
    expect(fingerprintOf("s", [t1, t2], { method: "oauth", identity: "x" }, "m", undefined)).not.toBe(base);
    expect(fingerprintOf("s", [t1, t2], A, "m2", undefined)).not.toBe(base);
    expect(fingerprintOf("s", [t1, t2], A, "m", "high")).not.toBe(base);
    expect(fingerprintOf("s", [t1, t2], { method: "api", identity: "y" }, "m", undefined)).not.toBe(base);
  });
});

describe("renderCheckpoint / renderToolIndex", () => {
  it("wraps and labels messages", () => {
    const out = renderCheckpoint([
      user("hello"),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "hi" },
          { type: "tool-call", toolCallId: "c1", toolName: "grep", input: { q: 1 } },
        ],
      },
      toolMsg("c1", "grep", { type: "text", value: "found" }),
    ]);
    expect(out.startsWith("<conversation-checkpoint>")).toBe(true);
    expect(out.endsWith("</conversation-checkpoint>")).toBe(true);
    expect(out).toContain("[user]");
    expect(out).toContain("[assistant]");
    expect(out).toContain('[tool-call:grep id=c1] {"q":1}');
    expect(out).toContain("[tool:grep id=c1]");
    expect(out).toContain("found");
  });

  it("renders user files and system messages", () => {
    const out = renderCheckpoint([
      {
        role: "user",
        content: [{ type: "file", mediaType: "application/pdf", data: "AA", filename: "a.pdf" }],
      },
    ]);
    expect(out).toContain("[file omitted: a.pdf]");
  });

  it("tool index lists tools and bridge name", () => {
    const out = renderToolIndex([
      { name: "alpha", description: "First line\nsecond", inputSchema: {} },
      { name: "beta", inputSchema: {} },
    ]);
    expect(out).toContain("call_mcp_tool");
    expect(out).toContain("opencode-bridge_bridge");
    expect(out).toContain("- alpha: First line");
    expect(out).not.toContain("second");
    expect(out.match(/beta/g)).toHaveLength(1);
    expect(renderToolIndex([])).toBe("");
  });
});

describe("decideSync", () => {
  it("fresh with single user message", () => {
    const d = decideSync(undefined, [sys, user("hi")], "fp");
    expect(d).toEqual({ kind: "fresh", blocks: [{ type: "text", text: "hi" }] });
  });

  it("fresh with history: checkpoint then last user", () => {
    const d = decideSync(undefined, [sys, user("a"), asst("b"), user("c")], "fp");
    expect(d.kind).toBe("fresh");
    expect(d.blocks).toHaveLength(2);
    const first = d.blocks[0] as any;
    expect(first.text).toContain("<conversation-checkpoint>");
    expect(first.text).toContain("b");
    expect(first.text).not.toContain("SYSTEM");
    expect(d.blocks[1]).toEqual({ type: "text", text: "c" });
  });

  it("fresh when history does not end with user", () => {
    const d = decideSync(undefined, [sys, user("a"), asst("b")], "fp");
    expect(d.kind).toBe("fresh");
    expect(d.blocks).toHaveLength(1);
  });

  it("continue with new user message after assistant output", () => {
    const hist = [user("a")];
    const d = decideSync(rec(hist), [sys, ...hist, asst("out"), user("next")], "fp");
    expect(d).toEqual({ kind: "continue", blocks: [{ type: "text", text: "next" }], toolResults: [] });
  });

  it("continue with tool results in prompt order", () => {
    const hist = [user("a")];
    const prompt: LanguageModelV3Prompt = [
      sys,
      ...hist,
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "x", input: {} },
          { type: "tool-call", toolCallId: "c2", toolName: "y", input: {} },
        ],
      },
      toolMsg("c1", "x", { type: "text", value: "r1" }),
      toolMsg("c2", "y", { type: "error-text", value: "bad" }),
    ];
    const d = decideSync(rec(hist), prompt, "fp");
    expect(d).toEqual({
      kind: "continue",
      blocks: [],
      toolResults: [
        { toolCallId: "c1", outcome: { text: "r1", isError: false } },
        { toolCallId: "c2", outcome: { text: "bad", isError: true } },
      ],
    });
  });

  it("continue with empty tail", () => {
    const hist = [user("a")];
    const d = decideSync(rec(hist), [sys, ...hist, asst("x")], "fp");
    expect(d).toEqual({ kind: "continue", blocks: [], toolResults: [] });
  });

  it("converts every tool output shape", () => {
    const hist = [user("a")];
    const outs: any[] = [
      { type: "json", value: { a: 1 } },
      { type: "error-json", value: [1] },
      { type: "execution-denied" },
      { type: "execution-denied", reason: "no" },
      {
        type: "content",
        value: [
          { type: "text", text: "t" },
          { type: "file-url", url: "u" },
        ],
      },
    ];
    const d = decideSync(rec(hist), [...hist, toolMsg("c", "n", outs[0]), ...outs.slice(1).map((o) => toolMsg("c", "n", o))], "fp") as any;
    expect(d.toolResults.map((r: any) => r.outcome)).toEqual([
      { text: '{"a":1}', isError: false },
      { text: "[1]", isError: true },
      { text: "Execution denied", isError: true },
      { text: "no", isError: true },
      { text: "t\n[file-url]", isError: false },
    ]);
  });

  it("interrupted yields catch-up with checkpoint after prefix", () => {
    const hist = [user("a")];
    const d = decideSync(rec(hist, { interrupted: true }), [sys, ...hist, asst("partial"), user("n")], "fp");
    expect(d.kind).toBe("catch-up");
    expect(d.blocks).toHaveLength(1);
    expect((d.blocks[0] as any).text).toContain("partial");
    expect((d.blocks[0] as any).text).toContain("[user]");
  });

  it("several user messages yield catch-up with last user as block", () => {
    const hist = [user("a")];
    const d = decideSync(rec(hist), [...hist, user("b"), user("c")], "fp");
    expect(d.kind).toBe("catch-up");
    expect(d.blocks).toHaveLength(2);
    expect((d.blocks[0] as any).text).toContain("b");
    expect((d.blocks[0] as any).text).not.toContain("\nc");
    expect(d.blocks[1]).toEqual({ type: "text", text: "c" });
  });

  it("user plus tool mix yields catch-up", () => {
    const hist = [user("a")];
    const d = decideSync(rec(hist), [...hist, toolMsg("c", "n", { type: "text", value: "r" }), user("q")], "fp");
    expect(d.kind).toBe("catch-up");
  });

  it("catch-up ending in non-user keeps single checkpoint block", () => {
    const hist = [user("a")];
    const d = decideSync(rec(hist, { interrupted: true }), [...hist, asst("x")], "fp");
    expect(d.kind).toBe("catch-up");
    expect(d.blocks).toHaveLength(1);
  });

  it("edit_earlier_message_is_changed", () => {
    const hist = [user("a"), asst("b"), user("c")];
    const edited = [user("a"), asst("EDIT"), user("c"), user("d")];
    expect(decideSync(rec(hist), edited, "fp").kind).toBe("changed");
  });

  it("compaction_is_changed", () => {
    const hist = [user("a"), asst("b"), user("c")];
    expect(decideSync(rec(hist), [user("a")], "fp").kind).toBe("changed");
  });

  it("fingerprint mismatch is changed", () => {
    const hist = [user("a")];
    expect(decideSync(rec(hist), [...hist, user("b")], "other").kind).toBe("changed");
  });

  it("changed rebuilds from full history", () => {
    const d = decideSync(rec([user("z")]), [user("a"), asst("b"), user("c")], "fp");
    expect(d.kind).toBe("changed");
    expect(d.blocks).toHaveLength(2);
  });

  it("converts images and urls in user content", () => {
    const d = decideSync(undefined, [
      {
        role: "user",
        content: [
          { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
          { type: "file", mediaType: "image/jpeg", data: "QUJD" },
          { type: "file", mediaType: "image/gif", data: new URL("https://x.test/a.gif") },
          { type: "file", mediaType: "application/pdf", data: "AA" },
        ],
      },
    ], "fp");
    expect(d.blocks).toEqual([
      { type: "image", data: "AQID", mimeType: "image/png" },
      { type: "image", data: "QUJD", mimeType: "image/jpeg" },
      { type: "text", text: "[image url: https://x.test/a.gif]" },
      { type: "text", text: "[file omitted: application/pdf]" },
    ]);
  });
});

describe("SessionStore", () => {
  async function tmp() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sess-"));
    return path.join(dir, "nested", "sessions.json");
  }

  it("round-trips with mode 0600 and deletes", async () => {
    const p = await tmp();
    const s = new SessionStore(p);
    expect(await s.get("a")).toBeUndefined();
    const r = rec([user("a")]);
    await Promise.all([s.set("a", r), s.set("b", r)]);
    expect(await s.get("a")).toEqual(r);
    expect(await s.get("b")).toEqual(r);
    expect((await fs.stat(p)).mode & 0o777).toBe(0o600);
    await s.delete("a");
    expect(await s.get("a")).toBeUndefined();
    expect(await new SessionStore(p).get("b")).toEqual(r);
  });

  it("treats corrupt file as empty and prunes old entries", async () => {
    const p = await tmp();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "{not json");
    const s = new SessionStore(p);
    expect(await s.get("x")).toBeUndefined();
    const old = rec([], { updatedAt: Date.now() - 31 * 24 * 3600 * 1000 });
    await fs.writeFile(p, JSON.stringify({ old }));
    await s.set("fresh", rec([]));
    expect(await s.get("old")).toBeUndefined();
    expect(await s.get("fresh")).toBeDefined();
    await fs.writeFile(p, "[1]");
    expect(await s.get("fresh")).toBeUndefined();
  });

  it("uses default path", () => {
    expect(new SessionStore().filePath.endsWith("sessions.json")).toBe(true);
  });
});

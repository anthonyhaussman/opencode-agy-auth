import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { afterAll, describe, expect, it } from "vitest";
import { AGY_ACP_PROVIDER_ID } from "../../src/acp/constants";
import { registerAgyAcpProvider, type AgyAcpRegistration } from "../../src/acp/register";
import { AgyProcessPool } from "../../src/acp/process";
import { SessionStore } from "../../src/acp/session-sync";

/**
 * Live smoke test against the real agy binary. Opt in with AGY_ACP_LIVE=1.
 * Uses GEMINI_API_KEY when set, otherwise the existing agy Google login
 * (the plugin never reads agy's tokens). Installs the opencode-bridge agy
 * plugin globally, like a first real turn does.
 */
const LIVE = process.env.AGY_ACP_LIVE === "1";
const MODEL = process.env.AGY_ACP_LIVE_MODEL ?? "gemini-3.8-flash-medium";

const echoTool = {
  type: "function" as const,
  name: "echo",
  description: "Echo the given text back to the caller.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

const textOf = (parts: LanguageModelV3StreamPart[]) =>
  parts.map((p: any) => (p.type === "text-delta" ? (p.delta ?? p.text ?? "") : "")).join("");

const finishOf = (parts: LanguageModelV3StreamPart[]) => parts.find((p) => p.type === "finish") as any;

describe.skipIf(!LIVE)("live agy acp", () => {
  const work = LIVE ? mkdtempSync(path.join(os.tmpdir(), "agy-live-")) : "";
  const apiKey = process.env.GEMINI_API_KEY;
  const regs: AgyAcpRegistration[] = [];
  // Set once the echo round trip proves the bridge is connected; the write_file case depends on it.
  let bridgeVerified = false;

  afterAll(async () => {
    await Promise.all(regs.map((r) => r.dispose()));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  async function modelFor(tier?: string) {
    let sdkHandler: ((ev: any) => unknown) | undefined;
    const ctx: any = {
      provider: { transform: () => undefined },
      model: { transform: () => undefined },
      tool: { transform: () => undefined },
      command: { transform: () => undefined },
      session: { hook: () => undefined },
      aisdk: { hook: (_n: string, h: (ev: any) => unknown) => ((sdkHandler = h), { dispose() {} }) },
      integration: {
        transform: () => undefined,
        connection: {
          active: async () => (apiKey ? { type: "key", id: "live" } : undefined),
          resolve: async () => (apiKey ? { type: "key", key: apiKey } : undefined),
          status: async () => undefined,
        },
      },
      location: { directory: work },
    };
    const reg = await registerAgyAcpProvider(ctx, {
      pool: new AgyProcessPool(),
      store: new SessionStore(path.join(work, `sessions-${regs.length}.json`)),
      cwd: work,
    });
    regs.push(reg);
    await reg.ready;
    const ev: any = { model: { id: MODEL, providerID: AGY_ACP_PROVIDER_ID }, options: {} };
    await sdkHandler!(ev);
    const model = ev.sdk.languageModel(MODEL);
    const call = (session: string, prompt: LanguageModelV3CallOptions["prompt"], tools?: any[]) =>
      model
        .doStream({
          prompt,
          tools,
          headers: { "x-opencode-session-id": session },
          ...(tier ? { providerOptions: { [AGY_ACP_PROVIDER_ID]: { tier } } } : {}),
        } as LanguageModelV3CallOptions)
        .then((r: any) => collect(r.stream));
    return call;
  }

  const user = (text: string): LanguageModelV3CallOptions["prompt"][number] => ({
    role: "user",
    content: [{ type: "text", text }],
  });

  it("answers a plain prompt", { timeout: 180_000 }, async () => {
    const call = await modelFor();
    const parts = await call("live-1", [user("Reply with the word pong")]);
    expect(textOf(parts).toLowerCase()).toContain("pong");
    expect(finishOf(parts).finishReason.unified).toBe("stop");
  });

  it("round-trips an OpenCode tool through the bridge", { timeout: 240_000 }, async () => {
    const call = await modelFor();
    const prompt = [user("Call the echo tool with text 'zebra-4412' and then tell me what it returned.")];
    const first = await call("live-2", prompt, [echoTool]);
    const toolCall = first.find((p: any) => p.type === "tool-call" && !p.providerExecuted) as any;
    expect(toolCall?.toolName).toBe("echo");
    expect(finishOf(first).finishReason.unified).toBe("tool-calls");
    const input = typeof toolCall.input === "string" ? JSON.parse(toolCall.input) : toolCall.input;
    const second = await call(
      "live-2",
      [
        ...prompt,
        { role: "assistant", content: [{ type: "tool-call", toolCallId: toolCall.toolCallId, toolName: "echo", input }] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: toolCall.toolCallId,
              toolName: "echo",
              output: { type: "text", value: `ECHO:${input.text}` },
            },
          ],
        },
      ],
      [echoTool],
    );
    expect(textOf(second)).toContain(input.text);
    bridgeVerified = true;
  });

  it("never lets write_file succeed", { timeout: 240_000 }, async () => {
    // Guard against a vacuous pass: only meaningful when the bridge route works.
    expect(bridgeVerified, "echo round trip must pass first").toBe(true);
    const call = await modelFor();
    const parts = await call("live-3", [
      user(`Use your write_file tool to create the file ${path.join(work, "should-not-exist.txt")} containing hello.`),
    ]);
    const succeeded = parts.filter(
      (p: any) => p.type === "tool-result" && p.toolName === "write_file" && !p.isError,
    );
    expect(succeeded).toEqual([]);
    expect(existsSync(path.join(work, "should-not-exist.txt"))).toBe(false);
  });

  it("starts with a tier variant", { timeout: 180_000 }, async () => {
    const call = await modelFor("low");
    const parts = await call("live-4", [user("Reply with the word pong")]);
    expect(finishOf(parts)).toBeDefined();
  });
});

#!/usr/bin/env node
// Fake ACP agent used by tests. Reads a scenario (JSON list of steps) from
// FAKE_ACP_SCENARIO, speaks NDJSON JSON-RPC over stdio, and logs what it saw
// to FAKE_ACP_LOG (NDJSON). See task brief for the step schema.
import { appendFileSync, readFileSync } from "node:fs";
import readline from "node:readline";

const BRIDGE_SERVER_NAME = "opencode-bridge_bridge";
const ALLOWED_BUILTINS = new Set(["read_file", "list_resources", "read_resource", "manage_task"]);
const ENV_KEYS = ["AGY_ACP_BRIDGE_URL", "AGY_ACP_BRIDGE_TOKEN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH"];

const scenario = process.env.FAKE_ACP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_ACP_SCENARIO, "utf8")) : [];
const logPath = process.env.FAKE_ACP_LOG;

function log(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = {};
for (const key of ENV_KEYS) {
  const value = process.env[key];
  env[key] = key === "AGY_ACP_BRIDGE_URL" ? (value ?? "unset") : value ? "set" : "unset";
}
log({ kind: "start", argv: process.argv.slice(2), env });

// ---- agent -> client requests -------------------------------------------

let agentRequestId = 0;
const agentPending = new Map();

function agentRequest(method, params) {
  const id = `agent-${++agentRequestId}`;
  return new Promise((resolve, reject) => {
    agentPending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// ---- bridge (MCP over HTTP) ---------------------------------------------

let bridgeSession;
let mcpId = 0;

async function bridgePost(body) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${process.env.AGY_ACP_BRIDGE_TOKEN ?? ""}`,
  };
  if (bridgeSession) headers["mcp-session-id"] = bridgeSession;
  const response = await fetch(process.env.AGY_ACP_BRIDGE_URL, { method: "POST", headers, body: JSON.stringify(body) });
  bridgeSession = response.headers.get("mcp-session-id") ?? bridgeSession;
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    if (data) parsed = JSON.parse(data.slice(5));
  }
  log({ kind: "bridge", method: body.method, status: response.status, response: parsed });
  return parsed;
}

async function bridgeCall(method, params) {
  return bridgePost({ jsonrpc: "2.0", id: ++mcpId, method, params });
}

async function bridgeStartup() {
  if (!process.env.AGY_ACP_BRIDGE_URL || process.env.FAKE_ACP_SKIP_BRIDGE) return;
  try {
    await bridgeCall("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake-agy", version: "0" },
    });
    await bridgePost({ jsonrpc: "2.0", method: "notifications/initialized" });
    await bridgeCall("tools/list", {});
  } catch (err) {
    log({ kind: "bridge-error", message: String(err) });
  }
}

// ---- scenario steps -----------------------------------------------------

function sessionUpdate(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

async function permission(sessionId, toolCallId) {
  const res = await agentRequest("session/request_permission", {
    sessionId,
    toolCall: { toolCallId },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  return res?.outcome?.outcome === "selected" ? res.outcome.optionId : "cancelled";
}

// Returns true when the turn was ended early (permission cancelled).
// All tool_call updates are sent first, then permissions one by one, then the
// allowed MCP calls run concurrently (a single call is the degenerate case).
async function runCallMcps(sessionId, calls) {
  const prepared = calls.map((callMcp, i) => ({
    callMcp,
    toolCallId: callMcp.toolCallId ?? `call-${Date.now()}-${i}`,
    args: callMcp.args ?? {},
  }));
  for (const { callMcp, toolCallId, args } of prepared) {
    sessionUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      name: "call_mcp_tool",
      title: `MCP Tool ${callMcp.tool}`,
      kind: "execute",
      rawInput: {
        ServerName: callMcp.serverName ?? BRIDGE_SERVER_NAME,
        ToolName: callMcp.tool,
        Arguments: { ...args, toolSummary: "x" },
        toolSummary: "x",
      },
    });
  }
  const choices = [];
  for (const { toolCallId } of prepared) {
    const choice = await permission(sessionId, toolCallId);
    if (choice === "cancelled") return true;
    choices.push(choice);
  }
  await Promise.all(
    prepared.map(async ({ callMcp, toolCallId, args }, i) => {
      if (choices[i] === "allow") {
        const rawOutput = await bridgeCall("tools/call", { name: callMcp.tool, arguments: args });
        sessionUpdate(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput });
      } else {
        sessionUpdate(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      }
    }),
  );
  return false;
}

async function runToolCall(sessionId, toolCall) {
  const toolCallId = toolCall.toolCallId ?? `tool-${Date.now()}`;
  sessionUpdate(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    name: toolCall.name,
    title: toolCall.name,
    kind: "other",
    rawInput: toolCall.rawInput ?? {},
  });
  if (!ALLOWED_BUILTINS.has(toolCall.name)) {
    const choice = await permission(sessionId, toolCallId);
    if (choice === "cancelled") return true;
  }
  sessionUpdate(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: toolCall.status ?? "completed",
    rawOutput: toolCall.output,
  });
  return false;
}

async function runStep(step, message) {
  const sessionId = message.params?.sessionId;
  if (step.delayMs) await sleep(step.delayMs);
  if (step.stderr) process.stderr.write(step.stderr);
  for (const n of step.notify ?? []) send({ jsonrpc: "2.0", method: n.method, params: n.params });
  let cancelled = false;
  if (step.callMcp) cancelled = await runCallMcps(sessionId, [step.callMcp]);
  if (!cancelled && step.callMcps) cancelled = await runCallMcps(sessionId, step.callMcps);
  if (!cancelled && step.toolCall) cancelled = await runToolCall(sessionId, step.toolCall);
  if (!cancelled) for (const n of step.notifyAfter ?? []) send({ jsonrpc: "2.0", method: n.method, params: n.params });
  if (message.id !== undefined) {
    if (cancelled) send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    else if (step.error) send({ jsonrpc: "2.0", id: message.id, error: step.error });
    else if (step.reply !== undefined) send({ jsonrpc: "2.0", id: message.id, result: step.reply });
  }
  if (step.exit !== undefined) {
    process.stdout.write("", () => process.exit(step.exit));
    await sleep(1000);
  }
}

// ---- main loop ----------------------------------------------------------

const queue = [];
let wake;

function nextMatching(method) {
  return new Promise((resolve) => {
    const check = () => {
      const index = queue.findIndex((m) => m.method === method);
      if (index >= 0) return resolve(queue.splice(index, 1)[0]);
      wake = check;
    };
    check();
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log({ kind: "recv-invalid", line });
    return;
  }
  log({ kind: "recv", message });
  if (message.method === undefined && message.id !== undefined) {
    const entry = agentPending.get(message.id);
    if (entry) {
      agentPending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
    return;
  }
  queue.push(message);
  wake?.();
});
rl.on("close", () => process.exit(0));

await bridgeStartup();
for (const step of scenario) {
  const message = await nextMatching(step.expect);
  await runStep(step, message);
}

#!/usr/bin/env node
// Stdio -> HTTP MCP proxy launched by agy. Only node: imports are allowed here.
import readline from "node:readline";

const url = process.env.AGY_ACP_BRIDGE_URL;
const token = process.env.AGY_ACP_BRIDGE_TOKEN;
let sessionId;
let failing = false;

function write(message) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve());
  });
}

async function fail(message, reason) {
  if (failing) return;
  failing = true;
  const text = `OpenCode bridge unreachable: ${reason}`;
  process.stderr.write(`bridge-proxy: ${text}\n`);
  if (message && message.id !== undefined && message.id !== null) {
    await write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
  }
  process.exit(1);
}

function parseBody(contentType, text) {
  if (!text.trim()) return [];
  const out = [];
  if (contentType.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) out.push(JSON.parse(data));
    }
    return out;
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function forward(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("bridge-proxy: ignoring non-JSON input line\n");
    return;
  }
  if (!url || !token) {
    await fail(message, "AGY_ACP_BRIDGE_URL or AGY_ACP_BRIDGE_TOKEN is not set");
    return;
  }
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(message) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    for (const reply of parseBody(res.headers.get("content-type") ?? "", text)) {
      // Transport-level errors (e.g. a pre-initialize server/discover) carry id null; agy
      // drops replies it cannot correlate, so echo the request id.
      if (reply && reply.error && reply.id == null && message.id !== undefined && message.id !== null) {
        reply.id = message.id;
      }
      await write(reply);
    }
    if (!res.ok && !text.trim() && message.id !== undefined) {
      await write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: `OpenCode bridge returned HTTP ${res.status}` },
      });
    }
  } catch (error) {
    await fail(message, error instanceof Error ? error.message : String(error));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  void forward(line);
});

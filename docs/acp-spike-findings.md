# agy ACP gating spike findings

Date: 2026-11-17. Binary under test: `agy` **1.5.10** (the installed version;
the plan assumed 1.5.9). Transport: `agy acp` over stdio (JSON-RPC 2.0 NDJSON).
Auth: the existing interactive `agy` login (no `authenticate` call was needed,
`session/new` worked directly). No credentials were read, printed or copied.
Scratch: `/tmp/agy-acp-spike/` (not committed). Every agy run used the throwaway
cwd `/tmp/agy-acp-spike/ws`.

Evidence legend: **live** = observed against a running agy, **static** =
binary strings, `--help`, shipped docs, or opencode binary strings.

## Gate verdict: FAIL

- Q1 fails: no supported strategy disables agy's mutating built-ins while
  keeping client MCP tools reachable (details below).
- Q2 passes (HTTP `mcpServers` tools reach the model and execute).

Per the plan, stop and escalate to the user; fallback A1 changes Tasks 5-9.

## Q1. Disabling built-ins (FAIL)

Tool list of a default session (live, model asked to list its tools):
`read_file, run_command, manage_task, send_message, schedule, invoke_subagent,
define_subagent, manage_subagents, write_file, edit_file, search_web,
run_workflow, swarm, ask_question, list_resources, read_resource` plus the
client MCP tools. (`generate_image` and browser tools appear in some agent
configurations; `/browser` is a slash command.)

Strategies tried, in the plan's order:

| Strategy | Result | Evidence |
|---|---|---|
| `session/new` `disableBuiltInTools: true` (also `disable_built_in_tools`, an array form, and `_meta.antigravity.disableBuiltInTools`) | Accepted silently, **no effect**: the same 18 tools are still listed. The field exists in the binary (`NewSessionParams.DisableBuiltInTools`) but does not remove tools. | live |
| `--settings '{"disabledTools":[...]}'` | Rejected: `--settings: unknown setting "disabledTools"`. Also `agy acp` itself does not accept `--settings`; it is a top-level flag (`agy --settings ... acp`). | live |
| `--settings '{"permissions":{"deny":[...]}}'` | Valid JSON object accepted. Rule kinds documented in shipped skills: `command()`, `read_file()`, `write_file()`, `mcp()`, `read_url()`, `execute_url()`. These are call-time rules, do not hide tools, and have **no rule for** `schedule`, `send_message`, `run_workflow`, `invoke_subagent`, `swarm`, `search_web`. Behavior not exercised end to end. | static |
| Mode `plan` via `session/set_config_option {configId:"mode", value:"plan"}` | Accepted, **tool list unchanged**. | live |
| `--agent <custom>` (markdown agent in `ws/.agents/agents/bridge.md`, `mainAgent: true`, `tools: [read_file]`) | Hides the built-ins well (only `read_file`, `manage_task`, `list_resources`, `read_resource` remain), **but the ACP `mcpServers` tools are not exposed** to that agent. Same with `enable_mcp_tools: true`, with `tools` omitted (you then get `send_message, read_file, search_web, schedule, generate_image`), and listing `mcp_spikebridge_echo` in `tools` fails with `tool "mcp_spikebridge_echo" not found in registry`. The MCP server was connected (requests seen) but its tools were not offered. | live |
| Reject via `session/request_permission` | Not a defense. In default mode `write_file` inside the workspace **executed with no permission request** (`b.txt` was created). `run_command` and MCP tools do ask. | live |

Remaining mutating built-ins that cannot be turned off while MCP tools stay
exposed: `write_file`, `edit_file` (workspace writes need no prompt),
`run_command` (prompt-gated only), `search_web` (network), `schedule`,
`send_message`, `invoke_subagent`, `define_subagent`, `manage_subagents`,
`run_workflow`, `swarm`, `manage_task`.

Read-only built-ins observed: `read_file` (workspace read, `kind: read`),
`list_resources`, `read_resource` (MCP resource reads). `find_by_name`,
`grep_search`, `list_dir` were not present in 1.5.10's tool list; file search is
done through `read_file`/`run_command`.

Untested ideas that might still satisfy the gate (cost: more spike time and
user-config side effects): (a) a workspace or global plugin
(`.agents/plugins.json`, `plugins/<name>/{agents,mcp_config.json}`) that ships a
restricted custom agent together with its own MCP server config, since custom
agents ignore ACP-supplied MCP servers but may see plugin/global MCP servers;
(b) `agy --settings` `permissions.deny` for `write_file`/`command`/`read_url`
plus a client that denies everything else, which still leaves `schedule`,
`send_message`, subagents and `run_workflow` callable.

## Q2. MCP `mcpServers` exposure (PASS) and wait limit

- HTTP entry `{type:"http", name:"spikebridge", url, headers:[]}` in
  `session/new` works (Streamable HTTP; agy also probes
  `/.well-known/oauth-protected-resource`). Tools are listed to the model as
  `mcp_spikebridge_echo` and `mcp_spikebridge_slow_echo`. A call executed and
  returned `ECHO:hi`. stdio was not needed. (live)
- Tool names are `mcp_<serverName>_<toolName>`.
- agy injects an extra `toolSummary` string into every tool call's args
  (`args`/`rawInput` carry `toolSummary`); the bridge must tolerate or strip it.
- MCP tool calls trigger `session/request_permission` in default mode (options
  `allow` kind `allow_once`, `deny` kind `reject_once`). Replying
  `{outcome:{outcome:"cancelled"}}` ends the whole turn immediately
  (`stopReason: end_turn`). Reply with `{outcome:{outcome:"selected",optionId}}`.
- **Wait limit on a blocked MCP call: 180 s (3 min), fixed.** `slow_echo`
  (blocks 15 min) failed after exactly 180.0 s with: `Encountered error in tool
  execution: MCP tool call to server "spikebridge" timed out after 3m0s:
  context deadline exceeded`. Turn then continued normally. (live)
- Early in the session the server was briefly down, and with it MCP tools
  silently vanished from the tool list instead of erroring; an unreachable
  bridge must be treated as a hard failure by the plugin.

## Q3. `_meta.antigravity.systemPrompt.append`

Takes effect (live): with `session/new` `_meta.antigravity.systemPrompt.append`
set to a codeword sentence, the model answered with the codeword. Only
`append` exists; binary string: `Ignoring invalid systemPrompt in
_meta.antigravity: missing 'append' key`. No replace option found (static).
`initialize` advertises `_meta.antigravity.{tier:true, systemPrompt:{append:true}}`.

## Q4. Models and tiers

From `session/new` (live):

- `models.availableModels` / `currentModelId`: `gemini-3.8-flash-high`,
  `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, `claude-sonnet-4-6`
  ("Claude Sonnet 4.6 (Thinking)"), `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium`. Default `gemini-3.8-flash-high`.
- `configOptions`: `model` (select: `gemini-3.8-flash`, `claude-sonnet-4-6`,
  `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`), `thought_level`
  (`low|medium|high`, current `high`), `mode` (`default|accept-edits|auto|plan`).
  Note the `model` config option groups the Gemini tiers under
  `gemini-3.8-flash` plus `thought_level`, while `availableModels` lists the
  three tiers separately.
- `modes`: `default, accept-edits, auto, plan`.
- `_meta.antigravity.tier`: `{name:"Antigravity Starter Quota", id:"g1-plus-tier",
  upgradeUri}`.
- `agy models` (CLI) prints the same six ids.
- `initialize.authMethods`: `oauth-personal`, `oauth-business`,
  `gemini-api-key`, `agent-platform` (Vertex/ADC).

## Q5. Usage data

- `session/prompt` result: `{stopReason:"end_turn", usage:{inputTokens,
  outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens,
  totalTokens}}` (live, e.g. input 9493, output 1162, thought 837, total 10655).
- Notification `usage_update`: `{used, size}` (context used / window size
  1048576), sent at turn start (`used:0`) and end.
- `session_info_update` carries a generated `title`.
- agent -> client updates observed: `agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update` (status `pending|in_progress|completed|failed`),
  `available_commands_update`, `usage_update`, `session_info_update`.

## Q6. API key env var (static evidence)

From `strings` on the binary and its changelog: `GEMINI_API_KEY` (settings key
`modelProvider: "gemini"`, optional `GOOGLE_GEMINI_BASE_URL`); `GOOGLE_API_KEY`
is also read and wins when both are set (`Warning: Both GOOGLE_API_KEY and
GEMINI_API_KEY are set. Using GOOGLE_API_KEY.`). ADC mode uses `AGY_ADC_AUTH`.
Not exercised live (no key available).

## Q7. `tool_call` title for MCP tools

`tool_call.name` = `mcp_<server>_<tool>`; `title` = `"Run mcp_<server>_<tool>"`
(live); `kind: "other"`; `rawInput` = args (plus `toolSummary`). For built-ins
the title is human text (e.g. `echo hi`, `File a.txt`) with `kind`
`read|edit|execute`. Match bridge tools on `name` starting with
`mcp_<server>_`, not on `title`.

## Q8. OpenCode 2.3.0 `model.request` hook (static evidence)

String extraction from the installed opencode 2.3.0 binary shows
`yield* e.session.hook("model.request", (ev) => ..., {providerID})` and the
trigger site `L.trigger("session","model.request",{...T, baseURL, headers:{...j.headers}})`.
Handlers in built-in plugins read `ev.sessionID`, `ev.kind` (`"primary"` etc.),
`ev.baseURL` and mutate `ev.headers[...]` / `ev.baseURL`. So the hook exists with
mutable `headers`, `baseURL` and a `sessionID`: **true**. Note the repo's
`@opencode-ai/plugin` 1.19.5 typings do not declare this hook name (only
`http.request`/`http.response`/`retry` are used in `src/plugin/v2-session.ts`),
so it must be typed locally. Not exercised with a probe plugin.

## Values for Task 2 (`src/acp/constants.ts`)

- `READ_ONLY_BUILTINS`: `read_file`, `list_resources`, `read_resource` (only
  those are read-only; the gate failed, so this set is informational).
- `BRIDGE_TOOL_PREFIX`: `mcp_<serverName>_` (e.g. `mcp_spikebridge_`).
- `MCP_SOFT_TIMEOUT_MS`: `180000` (fixed, 3m0s).
- `AGY_API_KEY_ENV`: `GEMINI_API_KEY` (`GOOGLE_API_KEY` takes precedence).
- `DISABLE_BUILTINS_STRATEGY`: **none works**. Closest partial: custom
  `--agent` with restricted `tools`, which loses ACP MCP tools.
- `SESSION_HOOK_MODEL_REQUEST`: `true` (static evidence).

## Follow-up spike: restricted agent shipped in an agy plugin

Date: 2026-11-17, agy 1.5.10. Scratch in `/tmp/agy-acp-spike/`, cwd
`/tmp/agy-acp-spike/ws`.

### Verdict: PASS for the Q1 gate, with a different bridge shape

Mutating built-ins are absent and uncallable, and a bridge MCP tool is callable
with a per-process URL and token. Two things change versus the original plan:
the bridge must be a **plugin-declared stdio MCP server** (not ACP
`session/new` `mcpServers`), and bridge tools are invoked through agy's generic
`call_mcp_tool`, not as `mcp_<server>_<tool>`.

### What was touched

- Workspace-local plugin attempt: `ws/.agents/plugins.json` with
  `{"entries":[{"path":"plugins"}]}` plus `ws/plugins/bridgeplug/`. agy
  discovered the agent and connected to the plugin MCP server, but no MCP tools
  were offered. Removed.
- Global install (needed for the working result): `agy plugin install
  /tmp/agy-acp-spike/plug/bridgeplug` created
  `~/.gemini/config/plugins/bridgeplug/` (agy also records it in its own
  config). Removed afterwards with `agy plugin uninstall bridgeplug`;
  `agy plugin list` shows only the pre-existing `lean-ctx`. I did not edit
  `~/.gemini/config/config.json` or `settings.json` by hand, and read no
  credentials.
- agy generated schema files under `~/.gemini/antigravity-cli/mcp/` (agy's own
  cache).

### Working strategy (exact files)

`plugin.json`:

```json
{"name":"bridgeplug","version":"1.0.0","description":"..."}
```

`agents/pbagent.md`:

```markdown
---
name: pbagent
description: Restricted agent using only bridge MCP tools.
mainAgent: true
subagent: false
enable_mcp_tools: true
tools: [read_file]
---
<system prompt>
```

`mcp_config.json` (static, stdio):

```json
{"mcpServers":{"pbridge":{"command":"node","args":["/abs/path/to/bridge-proxy.mjs"]}}}
```

Run: `agy acp --agent pbagent` (the plugin must be installed; `agy plugin
install <dir>` is a global install, there is no per-invocation plugin dir).

Tool list the model sees: `read_file`, `call_mcp_tool`, `list_resources`,
`read_resource`, `manage_task`. Asked to call `write_file`, `run_command`,
`search_web`, `schedule`, `send_message`, `invoke_subagent`, `run_workflow`,
`swarm`, the model reported each "does not exist" (live).

### MCP tool call shape

- MCP tools are not listed individually; the model reads the schema from
  `~/.gemini/antigravity-cli/mcp/<plugin>_<server>/<tool>.json` with
  `read_file`, then calls `call_mcp_tool`.
- `tool_call`: `name: "call_mcp_tool"`, `title: "MCP Tool <tool>"`,
  `kind: "execute"`, `args: {ServerName:"<plugin>_<server>", ToolName:"echo",
  Arguments:{...}}`. Server name is `<plugin name>_<server key>`
  (`bridgeplug_pbridge`). Final update has `rawOutput` (string) and
  `content[0].content.text`. Permission request is sent (`allow`/`deny`
  optionIds) before execution; bridge calls must be allowed, everything else
  denied.

### Naming variants for `tools` (all fail)

`tools:` only accepts built-in registry names. Each of these fails agent
construction with `tool "<x>" not found in registry`: `mcp_pbridge_echo`,
`mcp_pbridge_*`, `pbridge`, `mcp(pbridge/echo)`, `mcp(pbridge/*)`,
`pbridge_echo`, `echo`, `mcp__pbridge__echo`, `pbridge/echo`, `mcp`. MCP
tools are exposed to a custom agent only through `enable_mcp_tools: true`
(which yields `call_mcp_tool`, `list_resources`, `read_resource`).

### ACP `session/new` mcpServers with the restricted agent (fails)

With `--agent pbagent`, the ACP-supplied server is connected but its tools are
not usable: `call_mcp_tool` on `spikebridge` returns `tool echo is not enabled
for server spikebridge`. So ACP-supplied `mcpServers` cannot be used with the
restricted agent. Also, plugin MCP servers appear to the default agent only via
`call_mcp_tool`; the default agent's built-ins stay exposed.

### Per-session URL and token

- `${VAR}` interpolation in plugin `mcp_config.json` (url, headers) is not
  usable: undeclared variables are passed literally; declaring them in
  `variables` makes the plugin disabled until they are filled in interactively
  (`agy plugin enable` refuses: "open /plugin in the interactive CLI").
- **Works:** a plugin stdio MCP server inherits the environment of the
  `agy acp` process (verified: `BRIDGE_PORT`, `BRIDGE_TOKEN`,
  `BRIDGE_SESSION` set on the spawn were visible in the stdio server, cwd =
  plugin dir). Design: ship a static stdio proxy that forwards MCP requests
  to the OpenCode-side HTTP bridge using `BRIDGE_URL`/`BRIDGE_TOKEN` read from
  its env. Values are per agy process; use one `agy acp` process per session
  (or `--process-per-session`) to make them per session, or carry the
  session id in a tool argument.
- Wait limit for blocked MCP calls was measured earlier (180 s) on the ACP
  route; not re-measured through the plugin stdio route.

### Concerns

1. `read_file` is not workspace-confined: it read `/tmp/agy-acp-spike/outside.txt`
   outside the cwd with no permission request (paths must be absolute). Read-only
   but can read any user-readable file. Possible mitigation not tested:
   `--settings` `permissions.deny` `read_file(<path>)`.
2. Requires a global `agy plugin install` into `~/.gemini/config/plugins/`
   (no per-invocation plugin dir; workspace-local plugin MCP tools did not
   surface). The plugin must install/update itself and the stdio proxy path must
   be absolute and stable.
3. Tool schemas are discovered through agy's cache dir via `read_file`, adding
   one extra tool call per tool per session.
4. `manage_task` remains (no way to start tasks without `run_command`).

### Updated values

- `DISABLE_BUILTINS_STRATEGY`: install a plugin with restricted markdown agent
  (`mainAgent: true`, `enable_mcp_tools: true`, `tools: [read_file]`) and a
  static stdio MCP server entry; start `agy acp --agent <agent>` with the dynamic
  values in the process env; do not pass ACP `mcpServers`.
- `READ_ONLY_BUILTINS`: `read_file`, `list_resources`, `read_resource`
  (plus harmless `manage_task`); `call_mcp_tool` is the bridge channel.
- `BRIDGE_TOOL_PREFIX`: not a name prefix any more; match `name ===
  "call_mcp_tool"` and `args.ServerName === "<plugin>_<server>"`, tool in
  `args.ToolName`, input in `args.Arguments`.

## Auth and plugin MCP loading (fix round, 2026-11-18)

Question: does `authenticate {methodId:"oauth-personal"}` (sent by the provider
when no OpenCode connection exists) stop agy from loading the opencode-bridge
plugin MCP server? Raw JSON-RPC check against `agy acp --agent opencode` 1.5.10
with `AGY_ACP_BRIDGE_URL` pointing at a throwaway listener (live):

| Variant | session/new | Plugin MCP proxy launched and hit the listener |
|---|---|---|
| `initialize`, no `authenticate` | ok | yes (`server/discover` then `initialize`) |
| `initialize`, `authenticate oauth-personal`, then `session/new` | ok | yes (same) |

Both variants load the plugin MCP server, so `authenticate` is not the cause and
the provider keeps sending it. The agy log line "Not reloading plugin MCP
servers: cannot get the signed-in user" appears in both variants and is
unrelated.

Real cause of `bridge_unreachable`: for plugin (stdio) MCP servers agy first
sends a `server/discover` request. The real bridge (MCP SDK streamable HTTP
transport, not yet initialized) answers HTTP 400 with a JSON-RPC error whose
`id` is `null`. The proxy relayed that reply unchanged; agy cannot correlate an
id-null reply and never sends `initialize` or `tools/list`, so the bridge never
sees a client and the model only found `read_file` for schemas. The earlier
listener check only worked because its empty 500 made the proxy synthesize an
error carrying the request id. Fix: `bridge-proxy.mjs` now copies the request id
into id-null error replies (agy plugin version 1.0.1). After the fix the live
echo round trip passes.

## Re-check on agy 1.5.18

Date: 2026-11-27. OpenCode 2.4.2. Audited through ACP only (no direct Code Assist calls).

- `initialize`: `agentInfo.version` `1.5.18`; `_meta.antigravity` still advertises `tier: true` and `systemPrompt.append: true`; capabilities unchanged (`loadSession`, `sessionCapabilities` resume/close/load/list/additionalDirectories).
- Restricted agent: `agy acp --agent opencode` without bridge env lists only `read_file, manage_task`; with the bridge connected it adds `call_mcp_tool`. `AGY_ACP_LIVE=1 npx vitest run test/acp/live.test.ts`: 4/4 passed (including "never lets write_file succeed").
- Permission shape unchanged: `call_mcp_tool` with `ServerName: opencode-bridge_bridge`, options `allow` (`allow_once`) and `deny` (`reject_once`).
- MCP wait limit: a bridge `tools/call` that never answers fails 180.0 s after allow with `MCP tool call to server "opencode-bridge_bridge" timed out after 3m0s: context deadline exceeded`. Still 180 s.
- `call_mcp_tool` is only exposed once the bridge MCP server has connected; a `session/prompt` sent right after `session/new` can miss it.
- `session/new` `mcpServers` (stdio) was not exposed to the default agent in this run; the provider does not use that path (`mcpServers: []`).
- antigravity-cli#1684: `systemPrompt.append` containing `tools.opencode.session_move` still ends with `RESOURCE_EXHAUSTED (code 429)` after about 141 s; `tools.opencode.sessionMove` answers in 5 s.
- `MIN_AGY_VERSION` stays `1.5.10`.

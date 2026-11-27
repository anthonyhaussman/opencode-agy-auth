# AGENTS.md

OpenCode v2 plugin (OpenCode >= 2.4.0, v2 only) for the Google Gemini Antigravity CLI (`agy`). It registers two providers:

- `google-agy-acp`: drives the local `agy acp --agent opencode` binary (agy >= 1.5.10) over ACP. OpenCode tools are bridged to agy over MCP through an agy plugin named `opencode-bridge`.
- `google-agy` (deprecated, display name suffixed "(deprecated)"): the original direct Code Assist provider. It intercepts `@ai-sdk/google` requests and rewrites them to the Antigravity Code Assist endpoint with OAuth bearer auth, project context resolution, and server-supplied model enum mapping. It also ships the `agy_quota` and `agy_quota_summary` tools and quota commands.

## Architecture

The package exports a single v2 plugin from `index.ts` (`Plugin.define` / `setup(ctx)`). There is no `server()` v1 export.

### google-agy (deprecated) layout

`src/plugin/v2.ts` orchestrates (contracts in `src/plugin/types.ts`) and delegates to modules under `src/plugin/`:

- `oauth-authorize.ts`: `google-agy` OAuth integration method with PKCE flow.
- `v2-fetch.ts`: `createV2FetchInterceptor` hooks AI SDK client init (`ctx.aisdk.hook("sdk", ...)`) to inject a dummy `apiKey` and handle Code Assist transformations.
- `v2-session.ts`: session hooks `http.request`, `http.response` and `retry` for request rewriting, streaming transformation and backoff.
- `v2-storage.ts`: credential reads and writes in `~/.local/share/opencode/auth.json` alongside the v2 auth store.
- `headers.ts`, `tier.ts` (`STATIC_MODELS_SIMPLE`, `TIER_MAPPING`, `resolveModelTier`), `quota.ts` and `quota-summary.ts` (tools and `agy-quota` / `agy-quota-summary` commands), `tos-warning.ts` (one-time Terms of Service warnings, including the `google-agy-acp` variant).
- Shared engine in `src/sdk/`: request preparation (`src/sdk/request/`), quota fetching, retry and error parsing (`src/sdk/retry/`), models catalog via `models.json`; project context in `src/plugin/project/context.ts`.

### google-agy-acp layout

`src/acp/register.ts` (`registerAgyAcpProvider`) wires catalog, auth integration, the `aisdk` hook that supplies `AgyAcpLanguageModel`, and the `model.request` / `retry` session hooks (`retryable = false`: agy retries internally). Modules in `src/acp/`:

- `constants.ts`: ids, env keys, timeouts, allowed built-ins, `MIN_AGY_VERSION`.
- `binary.ts`: resolves `OPENCODE_AGY_PATH` or `agy` on `PATH` and probes the version.
- `rpc.ts`, `process.ts`: NDJSON JSON-RPC connection and per-session `agy acp` process pool (startup 30 s, idle kill 5 min). Plain `spawn`, no shell; `session/new` always sends `mcpServers: []`.
- `mcp-bridge.ts` (plus `agy-plugin/bridge-proxy.mjs`, the stdio proxy agy launches): local MCP bridge (127.0.0.1, random port, 32-byte hex bearer token passed to the child only as `AGY_ACP_BRIDGE_URL` / `AGY_ACP_BRIDGE_TOKEN`). agy hard-times MCP calls out at 180 s; the bridge soft-replies at 170 s.
- `agy-plugin.ts`: installs the shipped `agy-plugin/` as the global agy plugin `opencode-bridge` via `agy plugin install` only (never edits `~/.gemini/config/*` by hand); one-time notice on install or update.
- `permission.ts`: `allow_once` for bridge `call_mcp_tool` only, `reject_once` for everything else. Allowed provider-executed built-ins: `read_file`, `list_resources`, `read_resource`, `manage_task`; any other tool name cancels the turn.
- `stream-map.ts`, `language-model.ts`, `live-session.ts`, `session-lock.ts`, `session-sync.ts`, `errors.ts`: ACP update to AI SDK stream mapping, the language model, history sync with agy sessions, error classification.
- `register-auth.ts`, `register-catalog.ts`, `sdk-placeholder.ts`: auth methods (Gemini API key and Vertex recommended; Google login is external and the plugin never reads agy tokens or the OS keyring), model catalog with cache.
- Spike evidence behind these choices: `docs/acp-spike-findings.md`.

## agy CLI bump workflow

When a new `agy` CLI release lands (check `https://github.com/google-antigravity/antigravity-cli/releases`), execute every step in sequence without skipping.

**CRITICAL MANDATE**: Always audit backend and protocol additions. Upstream release notes primarily highlight user-facing UI changes, but minor/patch releases frequently introduce unannounced backend protocol updates, internal RPC routes, header adjustments, or payload schema changes. Never assume a bump is client-only without performing the full binary and server inspection.

1. **Install or upgrade CLI locally**: Ensure `agy --version` matches the target release.
2. **Audit changelog & release notes**: Read `https://github.com/google-antigravity/antigravity-cli/releases/tag/<VERSION>` (note: tag is `<version>` without "v" prefix, e.g. `0.1.2`). Identify upstream bug fixes, protocol changes, new request parameters, error handling adjustments, or server-side capabilities.
3. **Inspect local agy binary**: Run `strings $(readlink -f $(which agy)) | grep -E 'v1internal|daily-cloudcode|CodeAssist'` to discover internal RPC routes, header adjustments, or payload changes. Diffing binary strings against the previous version reveals unannounced backend protocol changes. For `google-agy-acp`, also diff ACP surface changes (`session/new` `_meta` keys, permission request shapes, the `opencode` agent tool list, error and 429 reporting), for example from an `AGY_ACP_DEBUG=1` log of one prompt.
4. **Inspect server response payloads & error structures**: Check live HTTP error payloads and retry headers (`retry-after-ms`, `error.details[]` structures like `type.googleapis.com/google.rpc.RetryInfo` or `QuotaFailure`). Test live quota calls with the `agy_quota` and `agy_quota_summary` tools to confirm server schema compatibility (these tools cover the deprecated `google-agy` provider only). For `google-agy-acp`, run one prompt with `AGY_ACP_DEBUG=1` and read the debug log: the `authenticate` response carries the quota tier, and 429 or retry messages arrive as `agent_message_chunk` updates.
5. **Reconcile against surface review checklist**: Systematically cross-reference the [Surface review checklist](#surface-review-checklist) to verify whether any plugin component requires updates for new capabilities, endpoints, or error codes.
6. **Report analysis findings**: Explicitly report findings to the user. State clearly whether actionable features or protocol adjustments exist to implement, or confirm with evidence that all upstream changes are client-only (e.g. CLI UI, terminal rendering, keyring handling).
7. **Implement relevant plugin adjustments**: If actionable backend fixes or protocol changes were discovered in steps 2-6, implement and test them before bumping constants.
8. **Update version constants**: Update `src/sdk/agy-cli-version.ts` (`AGY_CLI_VERSION`) and `scripts/fetch-models.mjs` (`AGY_API_VERSION`) to the new version. This sets the `User-Agent` header on every Code Assist API request.
9. **Update release config**: Update `.release-please-config.json` (`"release-as"` field) to the new version. Do **not** touch `.release-please-manifest.json`; release-please manages it automatically on PR merge.
10. **Update NPM dependencies**: Proactively invoke the `dependency-upgrade` skill to audit and upgrade dependencies. Run `npm outdated` to identify all pending patch, minor, and major updates. Upgrade outdated dependencies (evaluate breaking changes for majors like Vitest, `@opencode-ai/*`, `@ai-sdk/*`, `@types/node`). Run `npm test` immediately after upgrading dependencies to verify backward compatibility and test stability before proceeding. (`@ai-sdk/google` is only a literal string reference in `src/plugin/v2.ts`, so version bumps are zero-risk). `@ai-sdk/provider` is a runtime dependency of the ACP language model and is pinned to an exact version: pin it to the version `@ai-sdk/google` resolves (`npm ls @ai-sdk/provider` must show one deduped copy). Keep `package.json` ranges at the installed version (for example `^1.19.6`, not `^1.19.5`, when 1.19.6 is installed).
11. **Refresh model catalog & register models**: Run `npm run models:refresh` and verify diff (see [Refreshing models.json](#refreshing-modelsjson)). If new models appear (e.g. in `.models` or `agentModelSorts`), register them in `STATIC_MODELS_SIMPLE` and `TIER_MAPPING` in `src/plugin/tier.ts` (see [Registering models in src/plugin/tier.ts](#registering-models-in-srcplugintierts)). The `google-agy-acp` provider needs no registration: it discovers models from `agy models` at runtime. Also prune models from `STATIC_MODELS_SIMPLE` and `TIER_MAPPING` that are no longer usable or returned by the upstream `agy models` CLI command.
12. **Re-run the ACP gating checks**: re-run the restricted-agent tool list check (the `opencode` agent must still expose only the allowed built-ins plus the bridge tool) and the 180 s MCP timeout check (a blocked bridge call must still fail after 3 minutes), update `MIN_AGY_VERSION` in `src/acp/constants.ts` if the minimum moves, and record results in `docs/acp-spike-findings.md`. Run `AGY_ACP_LIVE=1 npx vitest run test/acp/live.test.ts` against the new binary.
13. **Re-check the system prompt 429 ([antigravity-cli#1684](https://github.com/google-antigravity/antigravity-cli/issues/1684))**: `tools.opencode.session_move` in `session/new` `_meta.antigravity.systemPrompt.append` returns `RESOURCE_EXHAUSTED (code 429)` (OpenCode 2.2.3-2.3.2 send it; 2.4.0 renamed it). Run a minimal ACP repro with that append (`bad`) and with `tools.opencode.sessionMove` (`good`), timeout at least 240 s (the 429 arrives after about 160 s on agy 1.5.13 and later). Report the result in step 6. If `bad` now succeeds, ask the user before commenting on the issue, then relax the README note.
14. **Run full verification suite**: Execute `npm install && npm run test:coverage && npm run typecheck && npm run build && npm run smoke:node-import`. All tests and quality gates must pass cleanly.

Prior bump commits follow a consistent pattern. Run `git log --oneline | grep "bump agy cli"` for examples.

## Refreshing models.json

`models.json` is the Antigravity Code Assist internal model catalog returned by the `fetchAvailableModels` server API. It is **not** the same as the public-facing `agy models` command output, which is a filtered subset. The plugin's `src/sdk/request/prepare.ts` reads `models.json` at runtime to resolve model enum placeholders via `getModelEnum`.

To refresh:

```bash
npm run models:refresh
```

Or equivalently:

```bash
./scripts/fetch-models.mjs --verbose
```

The script:

1. Reads `~/.local/share/opencode/auth.json` and extracts the `google-agy.refresh` field, whose format is `refreshToken|projectId|managedProjectId`.
2. Refreshes the OAuth access token via `POST https://oauth2.googleapis.com/token` using `AGY_CLIENT_ID` and `AGY_CLIENT_SECRET` (same values as `src/constants.ts`).
3. Calls `POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` with body `{"project": managedProjectId}`.
4. Writes the response (pretty-printed, 2-space indent) to `models.json` at the repo root.

Flags:

- `--endpoint <url>`: override the Code Assist endpoint (default `https://daily-cloudcode-pa.googleapis.com`).
- `--output <path>`: write to a different file (default `models.json` at repo root).
- `--verbose`: emit progress to stderr.

The script uses Node's built-in `fetch` (HTTP/2 capable). This is required because curl's HTTP/1.0 fallback fails due to network-level stream resets when sending the `Authorization` header against Google APIs from certain network environments; Node's HTTP/2 stream multiplexing handles it correctly.

### Verifying a refresh

After running `models:refresh`, diff old vs new `models.json` to identify:

- Model additions or removals in `.models` keys.
- Changes to `.defaultAgentModelId` (the agy CLI's default model).
- Changes to `.tieredModelIds.flash` (the tiered-flash parent model id, rotates across releases).
- New `.deprecatedModelIds` entries (model enum migrations).
- Changes to `.agentModelSorts[0].groups[0].modelIds` (the user-visible recommended list).

`models.json` is a pure upstream reflection of the `fetchAvailableModels` server response without synthetic fields. Legacy model enum mappings (such as `gemini-3.1-pro-high` and `gemini-pro-agent` resolving to `MODEL_PLACEHOLDER_M16`) are decoupled and maintained directly in code within `src/sdk/request/prepare.ts` (`LEGACY_MODEL_ENUM_FALLBACKS`) and `src/sdk/request/shared.ts` (`REQUEST_MODEL_FALLBACKS`), so `models.json` does not require manual patching on refresh.

## Registering models in src/plugin/tier.ts

When new user-facing models are added to `models.json` (for example, new series entries like `gemini-3.8-flash` or major releases appearing in `agentModelSorts[0].groups[0].modelIds`), register them in `src/plugin/tier.ts` so OpenCode exposes them:

1. **Add to `STATIC_MODELS_SIMPLE`**:
   - Define model key (e.g. `gemini-3.8-flash`) with `name`, `limit: { context: 1048576, output: 65536 }`, and default fallback `cost`.
2. **Add to `TIER_MAPPING`**:
   - Map tier aliases (`low`, `medium`, `high`) to the underlying model ID string (e.g. `low: "gemini-3.8-flash-low"`, `medium: "gemini-3.8-flash-medium"`, `high: "gemini-3.8-flash-high"`).
3. **Add unit test assertions**:
   - Update the v2 plugin tests under `test/plugin/` to assert that the newly registered model ID exists in provider models.

Note: internal preview strings or non-user-facing endpoints (like `chat_*` or internal tab models) should only remain in `models.json` for server enum mapping and do not need registration in `STATIC_MODELS_SIMPLE`.

## Surface review checklist

When reconciling agy CLI release notes against this plugin's code surface, check:

- `index.ts` - v2 entrypoint (`Plugin.define`) and named exports
- `src/plugin/types.ts` - OpenCode v2 plugin type contracts and helper definitions
- `src/plugin/v2.ts` - OpenCode v2 orchestrator (catalog, integration, aisdk, tools, commands, session hooks)
- `src/plugin/v2-fetch.ts` - OpenCode v2 AI SDK client fetch interceptor
- `src/plugin/v2-session.ts` - OpenCode v2 session hooks (`http.request`, `http.response`, `retry`)
- `src/plugin/v2-storage.ts` - OpenCode v2 credentials storage sync with `~/.local/share/opencode/auth.json`
- `src/plugin/headers.ts` - HTTP header and URL helpers
- `src/plugin/tier.ts` - shared model definitions (`STATIC_MODELS_SIMPLE`, `TIER_MAPPING`) and tier resolution
- `src/plugin/oauth-authorize.ts` - OpenCode v2 PKCE OAuth authorization flow and callback handler
- `src/acp/*` - google-agy-acp provider: process pool, JSON-RPC, MCP bridge, permission policy, stream mapping, language model, registration, `constants.ts` (`MIN_AGY_VERSION`, bridge names, allowed built-ins)
- `agy-plugin/*` - shipped `opencode-bridge` agy plugin (agent `opencode`, MCP server key `bridge`) installed by `src/acp/agy-plugin.ts`
- `docs/acp-spike-findings.md` - verified agy ACP behaviour (tool list, 180 s MCP limit, permission shapes)
- `src/sdk/agy-cli-version.ts` - version constant
- `scripts/fetch-models.mjs` - `AGY_API_VERSION` constant
- `src/constants.ts` - client ID/secret, endpoints, OAuth scopes
- `src/sdk/user-agent.ts` - User-Agent builder using `AGY_CLI_VERSION`
- `src/sdk/request/prepare.ts` - request body transformation, `getModelEnum` reads from `models.json`
- `src/sdk/request/shared.ts` - model fallback rewrites (e.g., `gemini-3.1-pro-high` to `gemini-pro-agent`)
- `src/sdk/fetch_models.ts` - `fetchAvailableModels` endpoint interface (do not confuse with the `agy models` CLI command output)
- `src/sdk/fetch_quota.ts` - quota fetch helpers
- `src/sdk/retry/quota.ts` - quota classification (parses server-supplied `RetryInfo`)
- `src/sdk/retry/helpers.ts` - retry delay resolution (prioritizes `retry-after-ms`, then `retry-after`, then `parseRetryDelayFromBody`)
- `src/plugin/pricing.ts` - dynamic model cost resolution via models.dev
- `src/plugin/project/context.ts` - project context resolution (loadCodeAssist / onboardUser)
- `src/plugin/quota.ts` and `src/plugin/quota-summary.ts` - the agy_quota and agy_quota_summary tools
- `models.json` - internal server model catalog (different from `agy models` public-facing output)

## Important distinctions

- `agy models` (or `agy --output-format stream-json models`) returns the public-facing filtered model IDs (e.g., `gemini-3.5-flash-low`). This is the list users see in the CLI's model picker.
- The `fetchAvailableModels` API returns the full internal catalog including preview/internal models (e.g., `chat_20706`, `tab_flash_lite_preview`, `gemini-3.6-flash-tiered` with no `displayName`). This is what the plugin's `prepare.ts` reads at runtime.
- The `google-agy` provider uses only `models.json` at runtime. The `google-agy-acp` provider ignores `models.json` and lists exactly what `agy --output-format stream-json models` returns (no cache, no fallback list).
- `@ai-sdk/google` is never imported; it is only used as a literal npm-name string at `src/plugin/v2.ts`. Version bumps to this package are zero-risk regardless of API changes in the upstream package.
- The plugin's OAuth token storage lives at `~/.local/share/opencode/auth.json` under the `google-agy` key. The agy CLI itself uses the OS keyring directly; the opencode plugin maintains its own auth storage for portability.
- **Client Credentials**: `AGY_CLIENT_SECRET` in `src/constants.ts` and `scripts/fetch-models.mjs` is Google's public OAuth client secret for the Antigravity desktop/CLI OAuth client (RFC 8252 public client). It is embedded directly in the upstream binary distribution and is not a confidential server secret. Do not rotate or redact it without updating the paired public `AGY_CLIENT_ID`.
- **Thinking / CoT Support**: Tiered Gemini models (`gemini-3.7/3.8-flash-high/medium`) currently have thinking suppressed by the upstream Code Assist server over SSE (it performs internal reasoning but does not stream raw `thought: true` parts back to the client, unlike Claude thinking models). When Google enables streaming thoughts for Flash tiers in future Code Assist protocol updates, add client response stream parsing and configuration support for them.

## Gotchas

- `.release-please-manifest.json` is auto-managed by release-please; do not manually edit it.
- Release track: `.release-please-config.json` `packages."."` sets `"prerelease"` (`true`: `X.Y.Z-alpha.N` tags on the npm `alpha` dist-tag; `false`: stable `X.Y.Z`) and `"release-as"` (next version). To switch tracks, change only these keys.
- Debug `google-agy-acp` with `AGY_ACP_DEBUG=1` (optional `AGY_ACP_DEBUG_FILE`, default `<XDG_DATA_HOME or ~/.local/share>/opencode/agy-acp/debug.log`, mode 0600): logs spawn, ACP JSON-RPC traffic, stderr and exit per agy child; the bridge token and Gemini API key are redacted, prompts are not.
- When the agy CLI is not logged in (`agy --version` works but `agy` interactive fails with "could not open TTY"), the `agy models` command still works and returns a cached or session-less model list.
- curl may show `HTTP/1.0 400 Bad Request` from a network security appliance intercepting `Authorization`-header requests against Google APIs. Use Node `fetch` instead (HTTP/2 stream multiplexing works correctly through such appliances). This is why `scripts/fetch-models.mjs` uses Node's built-in `fetch` rather than shelling out to `curl`.
- The `managedProjectId` (third pipe-separated field of the refresh token, e.g., `citric-engine-kl9s4`) is the value passed as the `project` body parameter to `fetchAvailableModels`, not the user-facing project ID. The user-facing project ID (second field, e.g., `tone-workspace-cli`) is not directly accepted by the API.
- A fresh `fetchAvailableModels` response will overwrite the entire `models.json` file. Diff old vs new before committing to catch any unintended server-side removals. Legacy model fallbacks (`gemini-3.1-pro-high` and `gemini-pro-agent`) are handled in code via `src/sdk/request/prepare.ts` and `src/sdk/request/shared.ts`.

## Build verification

```bash
npm install          # updates package-lock.json
npm test             # run unit test suite
npm run test:coverage # run tests with v8 code coverage enforcement
npm run typecheck    # tsc type check
npm run build        # tsup bundle + tsc declaration emit
npm run smoke:node-import  # verify dist/index.js loads without error
pipx run plugin-scanner scan .  # verify security and quality compliance (score >= 80)
```

To smoke test in OpenCode v2 locally, install or point the plugin to the build output using the v2 binary (`opencodev2` at `~/.local/bin/opencodev2`).

## Testing & Code Coverage

The repository uses [Vitest](https://vitest.dev/) with `@vitest/coverage-v8` for unit testing and code coverage enforcement.

### Test Commands

- `npm test`: Runs test suite once (`vitest run`).
- `npm run test:watch`: Runs tests in interactive watch mode (`vitest`).
- `npm run test:coverage`: Runs full suite and enforces code coverage thresholds (`vitest run --coverage`).

### Coverage Standards

- Minimum thresholds configured in `vitest.config.ts`:
  - **Lines**: >= 95%
  - **Functions**: >= 95%
  - **Statements**: >= 94%
  - **Branches**: >= 85%
- CI executes `npm run test:coverage` on every push and pull request. All new features and refactors must include unit tests maintaining >= 95% overall line and function coverage.

### Test Suite Organization

All tests are located in `test/` and organized by module:

- `test/sdk-*` & `test/sdk/`: Tests for request transformations, thinking configs, thought signatures, SSE streaming, retry backoff, quota error parsing, user-agent formatting, and OAuth helpers.
- `test/acp/`: ACP provider tests using the fake agent in `test/fixtures/`; `test/acp/live.test.ts` is gated by `AGY_ACP_LIVE=1` (uses `GEMINI_API_KEY` if set, otherwise your agy login; installs `opencode-bridge` globally).
- `test/plugin-*` & `test/plugin/`: Tests for plugin lifecycle, authentication loading/refreshing, project context resolution, pricing updates, toast notifications, background traffic simulation, and the `agy_quota` / `agy_quota_summary` tools.

Validate `models.json` is well-formed JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('models.json', 'utf8')); console.log('ok')"
```

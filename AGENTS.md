# AGENTS.md

OpenCode plugin that adds the Google Gemini Antigravity CLI (`agy`) OAuth provider. This plugin intercepts `fetch()` calls from `@ai-sdk/google` and rewrites them to the Antigravity Code Assist endpoint with OAuth bearer auth, project context resolution, and server-supplied model enum mapping. The plugin ships its own `agy_quota` and `agy_quota_summary` tools.

## agy CLI bump workflow

When a new `agy` CLI release lands (check `https://github.com/google-antigravity/antigravity-cli/releases`), execute every step in sequence without skipping.

**CRITICAL MANDATE**: Always audit backend and protocol additions. Upstream release notes primarily highlight user-facing UI changes, but minor/patch releases frequently introduce unannounced backend protocol updates, internal RPC routes, header adjustments, or payload schema changes. Never assume a bump is client-only without performing the full binary and server inspection.

1. **Install or upgrade CLI locally**: Ensure `agy --version` matches the target release.
2. **Audit changelog & release notes**: Read `https://github.com/google-antigravity/antigravity-cli/releases/tag/<VERSION>` (note: tag is `<version>` without "v" prefix, e.g. `0.1.2`). Identify upstream bug fixes, protocol changes, new request parameters, error handling adjustments, or server-side capabilities.
3. **Inspect local agy binary**: Run `strings $(readlink -f $(which agy)) | grep -E 'v1internal|daily-cloudcode|CodeAssist'` to discover internal RPC routes, header adjustments, or payload changes. Diffing binary strings against the previous version reveals unannounced backend protocol changes.
4. **Inspect server response payloads & error structures**: Check live HTTP error payloads and retry headers (`retry-after-ms`, `error.details[]` structures like `type.googleapis.com/google.rpc.RetryInfo` or `QuotaFailure`). Test live quota calls with the `agy_quota` and `agy_quota_summary` tools to confirm server schema compatibility.
5. **Reconcile against surface review checklist**: Systematically cross-reference the [Surface review checklist](#surface-review-checklist) to verify whether any plugin component requires updates for new capabilities, endpoints, or error codes.
6. **Report analysis findings**: Explicitly report findings to the user. State clearly whether actionable features or protocol adjustments exist to implement, or confirm with evidence that all upstream changes are client-only (e.g. CLI UI, terminal rendering, keyring handling).
7. **Implement relevant plugin adjustments**: If actionable backend fixes or protocol changes were discovered in steps 2-6, implement and test them before bumping constants.
8. **Update version constants**: Update `src/sdk/agy-cli-version.ts` (`AGY_CLI_VERSION`) and `scripts/fetch-models.mjs` (`AGY_API_VERSION`) to the new version. This sets the `User-Agent` header on every Code Assist API request.
9. **Update release config**: Update `.release-please-config.json` (`"release-as"` field) to the new version. Do **not** touch `.release-please-manifest.json`; release-please manages it automatically on PR merge.
10. **Check dependencies**: Run `npm outdated` and bump dependencies to latest semver-compatible. (`@ai-sdk/google` is only a literal string reference in `src/plugin.ts`, so version bumps are zero-risk).
11. **Refresh model catalog**: Run `npm run models:refresh` and verify diff (see [Refreshing models.json](#refreshing-modelsjson)).
12. **Run full verification suite**: Execute `npm install && npm run test:coverage && npm run typecheck && npm run build && npm run smoke:node-import`. All tests and quality gates must pass cleanly.

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

Always verify that `.deprecatedModelIds` for `gemini-3.1-pro-high` (mapping to `gemini-pro-agent` with enum `MODEL_PLACEHOLDER_M16`) is preserved. The plugin's `src/sdk/request/shared.ts:10` hardcodes a fallback rewrite of `gemini-3.1-pro-high` to `gemini-pro-agent`, which depends on this deprecation entry being present in `models.json` so `prepare.ts` `getModelEnum` resolves the correct enum.

## Surface review checklist

When reconciling agy CLI release notes against this plugin's code surface, check:

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
- `src/plugin.ts` - `STATIC_MODELS_SIMPLE`, `TIER_MAPPING`, fetch interceptor, provider registration
- `src/plugin/pricing.ts` - dynamic model cost resolution via models.dev
- `src/plugin/project/context.ts` - project context resolution (loadCodeAssist / onboardUser)
- `src/plugin/quota.ts` and `src/plugin/quota-summary.ts` - the agy_quota and agy_quota_summary tools
- `models.json` - internal server model catalog (different from `agy models` public-facing output)

## Important distinctions

- `agy models` (or `agy --output-format stream-json models`) returns the public-facing filtered model IDs (e.g., `gemini-3.5-flash-low`). This is the list users see in the CLI's model picker.
- The `fetchAvailableModels` API returns the full internal catalog including preview/internal models (e.g., `chat_20706`, `tab_flash_lite_preview`, `gemini-3.6-flash-tiered` with no `displayName`). This is what the plugin's `prepare.ts` reads at runtime.
- Only `models.json` is used by the plugin at runtime; the `agy models` output is informational and not consumed by the plugin code.
- `@ai-sdk/google` is never imported; it is only used as a literal npm-name string at `src/plugin.ts:179` and `src/plugin.ts:438`. Version bumps to this package are zero-risk regardless of API changes in the upstream package.
- The plugin's OAuth token storage lives at `~/.local/share/opencode/auth.json` under the `google-agy` key. The agy CLI itself uses the OS keyring directly; the opencode plugin maintains its own auth storage for portability.

## Gotchas

- `.release-please-manifest.json` is auto-managed by release-please; do not manually edit it.
- When the agy CLI is not logged in (`agy --version` works but `agy` interactive fails with "could not open TTY"), the `agy models` command still works and returns a cached or session-less model list.
- curl may show `HTTP/1.0 400 Bad Request` from a network security appliance intercepting `Authorization`-header requests against Google APIs. Use Node `fetch` instead (HTTP/2 stream multiplexing works correctly through such appliances). This is why `scripts/fetch-models.mjs` uses Node's built-in `fetch` rather than shelling out to `curl`.
- The `managedProjectId` (third pipe-separated field of the refresh token, e.g., `citric-engine-kl9s4`) is the value passed as the `project` body parameter to `fetchAvailableModels`, not the user-facing project ID. The user-facing project ID (second field, e.g., `tone-workspace-cli`) is not directly accepted by the API.
- A fresh `fetchAvailableModels` response will overwrite the entire `models.json` file. Diff old vs new before committing to catch any unintended server-side removals. Pay particular attention to the `deprecatedModelIds` entry for `gemini-3.1-pro-high` which the plugin's `shared.ts:10` fallback depends on.

## Build verification

```bash
npm install          # updates package-lock.json
npm test             # run unit test suite
npm run test:coverage # run tests with v8 code coverage enforcement
npm run typecheck    # tsc type check
npm run build        # tsup bundle + tsc declaration emit
npm run smoke:node-import  # verify dist/index.js loads without error
```

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
- `test/plugin-*` & `test/plugin/`: Tests for plugin lifecycle, authentication loading/refreshing, project context resolution, pricing updates, toast notifications, background traffic simulation, and the `agy_quota` / `agy_quota_summary` tools.

Validate `models.json` is well-formed JSON:

```bash
node -e "JSON.parse(require('fs').readFileSync('models.json', 'utf8')); console.log('ok')"
```

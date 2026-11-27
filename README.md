# OpenCode Antigravity CLI Plugin

[![npm version](https://img.shields.io/npm/v/@anthonyhaussman/opencode-agy-auth)](https://www.npmjs.com/package/@anthonyhaussman/opencode-agy-auth)
[![npm downloads](https://img.shields.io/npm/dw/@anthonyhaussman/opencode-agy-auth)](https://www.npmjs.com/package/@anthonyhaussman/opencode-agy-auth)
[![CI](https://github.com/anthonyhaussman/opencode-agy-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/anthonyhaussman/opencode-agy-auth/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/anthonyhaussman/opencode-agy-auth)](https://github.com/anthonyhaussman/opencode-agy-auth/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/anthonyhaussman/opencode-agy-auth?style=social)](https://github.com/anthonyhaussman/opencode-agy-auth)

> [!WARNING]
> **Using this plugin can get your Google account disabled.**
>
> Google's current Antigravity terms prohibit using third-party software, tools, or services (explicitly including OpenCode) to access an Antigravity/Gemini CLI login. Accounts detected doing so are blocked with:
>
> `This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.`
>
> A disabled account can only be restored through [Google's appeal form](https://docs.google.com/forms/d/e/1FAIpQLScOJWibQ_-hYuVv63kJTgEqlgAaOwRLGFTbXm-QY1gz8U0CGA/viewform). The plugin prints this warning on every startup.
>
> Supported alternatives that do not rely on an Antigravity login:
>
> - The `google-agy-acp` provider of this plugin with the **Gemini API key** or **Vertex** method (see below).
> - OpenCode's native `google` provider with a Gemini API key (`GOOGLE_GENERATIVE_AI_API_KEY`, from Google AI Studio).
> - OpenCode's native `google-vertex` provider with your own Google Cloud project.
>
> Use this plugin at your own risk. The maintainer takes no responsibility for any action Google takes against your account.

An [OpenCode](https://opencode.ai/) plugin for the Antigravity CLI (`agy`). It ships two providers:

- **`google-agy-acp`** (recommended): drives your local `agy` binary over the Agent Client Protocol (`agy acp`).
- **`google-agy`** (deprecated): the original direct Code Assist API provider with OAuth. It is kept for existing users and will not receive new features.

## Requirements

- OpenCode >= 2.4.0, required by `google-agy-acp` (this package supports the v2 plugin API only; older OpenCode versions cannot load the provider). OpenCode 2.2.3 to 2.3.2 can load the provider, but their system prompt names the Code Mode tool `tools.opencode.session_move`, and agy answers every prompt that contains this string with `RESOURCE_EXHAUSTED (code 429)` ([antigravity-cli#1684](https://github.com/google-antigravity/antigravity-cli/issues/1684)). OpenCode 2.4.0 renamed the tool to `tools.opencode.session.move`.
- agy >= 1.5.10 for `google-agy-acp`. The binary is `agy` on your `PATH`, or the path in `OPENCODE_AGY_PATH`.

## google-agy-acp provider

The provider starts `agy acp --agent opencode` (one process per OpenCode session, no shell) and exposes agy's models in OpenCode. OpenCode keeps ownership of tools: they are presented to agy through a local MCP bridge (127.0.0.1, random port, per-process bearer token) served by an agy plugin named `opencode-bridge`, so file edits and commands still run inside OpenCode with OpenCode's permission prompts. Low, medium and high variants map to agy's `thought_level`. The model list comes from `agy models` shortly after startup and refreshes when agy reports a different list at session start. If `agy models` fails later, the provider keeps the last list that worked for the current account; if agy is missing, too old, or has never answered for that account, the provider lists no models.

### Authentication

Pick a method when connecting the `google-agy-acp` provider:

- **Gemini API key** (recommended): stored by OpenCode, passed to agy as `GEMINI_API_KEY` in the child environment.
- **Vertex AI / Agent Platform** (recommended): uses your Application Default Credentials. Nothing is stored by OpenCode.
- **Google login (personal or Gemini Enterprise / Workspace)**: you sign in with `agy` itself; the plugin never reads, refreshes or forwards agy's OAuth tokens and never reads the OS keyring.

### Disclaimer

Google's policy names OpenCode as a third-party tool. Using the Google-login method through this plugin may still get your account disabled. This project makes no claim of Terms of Service compliance for any method. The API key and Vertex methods are the recommended ones.

### What this provider changes on your machine

- **Global agy plugin.** On first use the provider runs `agy plugin install` and adds the `opencode-bridge` plugin to agy's global plugins in `~/.gemini/config/plugins/`. A one-time notice is shown. Remove it at any time with `agy plugin uninstall opencode-bridge`. The plugin never edits `~/.gemini/config/*` by hand.
- **`read_file` is not sandboxed.** agy's own `read_file` can read any file your user can read, including files outside the workspace, without a permission prompt. It is read-only and appears in OpenCode as a provider-executed call. Other agy built-ins (`write_file`, `run_command` and so on) are rejected.
- **Shared schema cache.** agy caches tool schemas in `~/.gemini/antigravity-cli/mcp/opencode-bridge_bridge/`, shared by all sessions. Concurrent sessions with different tool sets can see each other's schemas; calls to a tool the session does not have are rejected by the bridge.
- **Other MCP servers are blocked.** MCP servers from other agy plugins are blocked by permission rejection.
- **Long tool runs.** agy times MCP calls out at 180 s. OpenCode tools that run longer than 170 s return "still running" to agy, and the result is delivered with the next message.
- **Process lifetime.** agy child processes are not killed when the plugin unloads (the v2 setup hook has no disposer), but they exit after 5 minutes idle or when OpenCode exits.

### Environment variables

- `OPENCODE_AGY_PATH`: path to the agy binary (default: `agy` on `PATH`).
- `AGY_ACP_DEBUG=1`: write a debug log of each agy child process (spawn, ACP JSON-RPC traffic, stderr, exit). The bridge token and the Gemini API key are redacted; prompts and tool output are logged as-is. Off by default.
- `AGY_ACP_DEBUG_FILE`: debug log path (default: `$XDG_DATA_HOME/opencode/agy-acp/debug.log`, or `~/.local/share/opencode/agy-acp/debug.log`). Created with mode 0600.

## Legacy `google-agy` provider (deprecated)

### Features

- **OAuth 2.0 Integration**: Uses Antigravity's OAuth flows for authentication.
- **Dynamic Model Retrieval**: Fetches available models based on user tier and current allocations.
- **Quota Tracking**: Injects the `agy_quota` tool into OpenCode to check usage limits directly.
- **Background Session Requests**: Sends the session-level requests the Antigravity backend expects alongside model calls.

### Installation

Install the plugin from npm (or directly using local file configurations if developing):

```bash
npm install @anthonyhaussman/opencode-agy-auth
```

### Configuration

Update your OpenCode configuration file (typically `opencode.json` at the root of your project or globally at `~/.config/opencode/opencode.json`) to register the plugin and specify your Google Cloud Project ID.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@anthonyhaussman/opencode-agy-auth"],
  "provider": {
    "google-agy": {
      "options": {
        "projectId": "your-google-cloud-project-id"
      }
    }
  }
}
```

By default, the plugin registers a specialized provider ID to interface with `agy`.
You can switch your active OpenCode provider to `agy` or let the plugin inject authentication into your existing sessions.

#### Environment Variables

If you are running OpenCode in environments with specific requirements for Antigravity, you can use the following environment variables:

- `OPENCODE_AGY_PROJECT_ID`: Specify your Google Cloud Project ID manually.
- `OPENCODE_AGY_AUTH_PROXY`: Define a proxy if accessing authentication endpoints behind a corporate firewall.
- `OPENCODE_AGY_ENDPOINT`: Override the default internal `daily-cloudcode-pa.googleapis.com` API endpoint.
- `OPENCODE_AGY_VERBOSE_LOGS`: Set to `"1"` to enable verbose diagnostic logs for API calls and responses.

### Usage

Once installed and configured, OpenCode will automatically authenticate against Antigravity CLI when interacting with eligible models. If no active session exists, you will be prompted to complete an OAuth login.

Additionally, you can check your quota using slash commands directly in your OpenCode prompt:

- `/agyquota` - Per-model detail view. Shows remaining tokens, progress bars, and reset timers for every model variant. Use when you need the full breakdown of individual buckets.
- `/agyquotasummary` - High-level grouped view. Shows weekly and 5-hour limits aggregated by model family. Use when you want a quick overview of your allowance across all models.

You can also ask naturally:
> "What is my current agy quota?"
> "Show me my quota summary"

### Companion Plugin: `opencode-quota`

This repository is compatible with [`opencode-quota`](https://github.com/slkiser/opencode-quota), an OpenCode plugin for displaying quota information directly in your status bar or interface.

Follow the [Google AGY Quick Setup Guide](https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#google-agy-quick-setup) to set them up together.

To use both plugins side by side, register them in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@anthonyhaussman/opencode-agy-auth",
    "opencode-quota"
  ],
  "provider": {
    "google-agy": {
      "options": {
        "projectId": "your-google-cloud-project-id"
      }
    }
  }
}
```

When used together, `opencode-quota` seamlessly visualizes rate limits and quotas for models authenticated through `google-agy`.

### Disk Persistence

The plugin persists turn-state and retry-cooldown data to disk so that it survives OpenCode restarts. Files are stored under `~/.config/opencode/` (or `%APPDATA%\opencode\` on Windows):

- `antigravity-turn-states.json` - tracks thinking/reasoning state across request turns, with a 24-hour TTL and 5-second throttled writes using atomic tmp+rename.
- Retry cooldowns are persisted via `CooldownStore` with the same atomic-write pattern.

Both stores initialize lazily at runtime - no filesystem reads occur at import time.

#### `diskEnabled` Parameter

`TurnStateTracker` accepts a `diskEnabled` constructor parameter (defaults to `true`):

```ts
import { TurnStateTracker } from "@anthonyhaussman/opencode-agy-auth/sdk/request/turn-state-tracker";

// Disk persistence enabled (default)
const tracker = new TurnStateTracker(true);

// Memory-only mode - no filesystem reads or writes
const tracker = new TurnStateTracker(false);
```

When `diskEnabled` is `false`, the tracker operates entirely in memory. All state is lost when the process exits. This is useful in restricted environments (containers, read-only filesystems) where disk access is unavailable or undesirable.

If disk initialization fails at runtime (permission error, corrupt file, etc.), the plugin automatically falls back to memory-only mode and logs a warning. No configuration is needed for normal use - disk persistence works out of the box.

## Local Testing

To test and develop the plugin locally with OpenCode before publishing:

1. **Build the plugin locally**:
   Clone the repository, install dependencies, and build the source code:
   ```bash
   npm install
   npm run build
   ```

2. **Configure OpenCode to use the local build**:
   In the target project where you want to test the plugin, open your `opencode.json` (or `~/.config/opencode/opencode.json` for global testing) and add the absolute local path to the plugin:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["/absolute/path/to/opencode-agy-auth"]
   }
   ```
   *Note: OpenCode also supports dropping plugin files directly into the `.opencode/plugins/` folder in your project.*

3. **Verify the plugin**:
   Launch OpenCode in your target project. OpenCode will automatically resolve and load your local plugin directory. You can test your changes by running `npm run build` in the plugin directory and restarting your OpenCode session.

## Pre-release Channel

To test bleeding-edge features or upcoming changes before official releases, configure the `@alpha` distribution tag:

```bash
npm install @anthonyhaussman/opencode-agy-auth@alpha
```

Or configure it directly in your `opencode.json`:

```json
{
  "plugin": ["@anthonyhaussman/opencode-agy-auth@alpha"]
}
```

> [!WARNING]
> **Instability Warning**: The `@alpha` release contains experimental features and active development builds. It may be unstable or cause disruptions in session authentication and model requests. Use only for testing and development. For day-to-day work, use the stable release.

## Star History & Support

If this plugin saved you time or made using Antigravity models in OpenCode smoother, consider giving the repository a star on [GitHub](https://github.com/anthonyhaussman/opencode-agy-auth) - it helps others discover the project.

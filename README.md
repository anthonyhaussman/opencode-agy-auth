# OpenCode Antigravity CLI Auth Plugin

An [OpenCode](https://opencode.ai/) authentication plugin that enables seamless interaction with the Antigravity CLI (`agy`) by hooking into its authentication, quota retrieval, and dynamic model fetching layers.

## Features

- **OAuth 2.0 Integration**: Uses Antigravity's OAuth flows for authentication.
- **Dynamic Model Retrieval**: Fetches available models based on user tier and current allocations.
- **Quota Tracking**: Injects the `agy_quota` tool into OpenCode to check usage limits directly.
- **Traffic Simulation**: Maintains background heartbeat with `agy` servers.

## Installation

Install the plugin from npm (or directly using local file configurations if developing):

```bash
npm install @anthonyhaussman/opencode-agy-auth
```

## Configuration

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

### Environment Variables

If you are running OpenCode in environments with specific requirements for Antigravity, you can use the following environment variables:

- `OPENCODE_AGY_PROJECT_ID`: Specify your Google Cloud Project ID manually.
- `OPENCODE_AGY_AUTH_PROXY`: Define a proxy if accessing authentication endpoints behind a corporate firewall.
- `OPENCODE_AGY_ENDPOINT`: Override the default internal `daily-cloudcode-pa.googleapis.com` API endpoint.
- `OPENCODE_AGY_VERBOSE_LOGS`: Set to `"1"` to enable verbose diagnostic logs for API calls and responses.

## Usage

Once installed and configured, OpenCode will automatically authenticate against Antigravity CLI when interacting with eligible models. If no active session exists, you will be prompted to complete an OAuth login.

Additionally, you can quickly check your quota using the `/agyquota` slash command directly in your OpenCode prompt, or simply by asking:
> "What is my current agy quota?"

This calls the injected `agy_quota` tool to give you a real-time table of your current usage, tokens remaining, and reset times.

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

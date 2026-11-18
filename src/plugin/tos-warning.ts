import type { PluginClient } from "./types";

export const AGY_TOS_APPEAL_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLScOJWibQ_-hYuVv63kJTgEqlgAaOwRLGFTbXm-QY1gz8U0CGA/viewform";

export const AGY_TOS_WARNING_TITLE = "Antigravity Terms of Service Risk";

export const AGY_TOS_WARNING =
  "Google's current Antigravity terms prohibit using third-party tools (including OpenCode) to access an " +
  "Antigravity/Gemini CLI login. Using this plugin can get your Google account disabled " +
  "(\"This service has been disabled in this account for violation of Terms of Service\"). " +
  "Use at your own risk. Supported alternatives: the native `google` provider with " +
  "GOOGLE_GENERATIVE_AI_API_KEY, `google-vertex`, or the `google-agy-acp` provider " +
  "(drives the local agy CLI; use its Gemini API key or Vertex method).";

export const AGY_ACP_TOS_WARNING =
  "Google's Antigravity policy names OpenCode as a third-party tool. The google-agy-acp provider drives your local " +
  "agy CLI, but its Google-login methods may still get your Google account disabled. The Gemini API key and " +
  "Vertex (Agent Platform) methods are the recommended way to use google-agy-acp.";

let tosWarningEmitted = false;
let acpTosWarningEmitted = false;

function emitWarning(client: PluginClient | undefined, message: string): void {
  console.warn(`[Agy Auth] WARNING: ${message} Appeal form: ${AGY_TOS_APPEAL_URL}`);

  const showToast = client?.tui?.showToast;
  if (!showToast) {
    return;
  }

  try {
    void Promise.resolve(
      showToast.call(client.tui, {
        body: {
          title: AGY_TOS_WARNING_TITLE,
          message,
          variant: "error",
          duration: 15000,
        },
      }),
    ).catch(() => undefined);
  } catch {
    // Toast delivery is best-effort; the console warning already ran.
  }
}

/**
 * Emits the Antigravity Terms of Service warning once per process.
 * Always logs to the console; also shows an error toast when the client supports it.
 */
export function emitAgyTosWarning(client?: PluginClient): void {
  if (tosWarningEmitted) {
    return;
  }
  tosWarningEmitted = true;
  emitWarning(client, AGY_TOS_WARNING);
}

/** Emits the google-agy-acp variant of the Terms of Service warning once per process. */
export function emitAgyAcpTosWarning(client?: PluginClient): void {
  if (acpTosWarningEmitted) {
    return;
  }
  acpTosWarningEmitted = true;
  emitWarning(client, AGY_ACP_TOS_WARNING);
}

/**
 * Resets the once-per-process guards. Test-only.
 */
export function resetAgyTosWarningForTesting(): void {
  tosWarningEmitted = false;
  acpTosWarningEmitted = false;
}

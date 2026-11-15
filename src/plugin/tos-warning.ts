import type { PluginClient } from "./types";

export const AGY_TOS_APPEAL_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLScOJWibQ_-hYuVv63kJTgEqlgAaOwRLGFTbXm-QY1gz8U0CGA/viewform";

export const AGY_TOS_WARNING_TITLE = "Antigravity Terms of Service Risk";

export const AGY_TOS_WARNING =
  "Google's current Antigravity terms prohibit using third-party tools (including OpenCode) to access an " +
  "Antigravity/Gemini CLI login. Using this plugin can get your Google account disabled " +
  "(\"This service has been disabled in this account for violation of Terms of Service\"). " +
  "Use at your own risk. Supported alternatives: the native `google` provider with " +
  "GOOGLE_GENERATIVE_AI_API_KEY, or `google-vertex`.";

let tosWarningEmitted = false;

/**
 * Emits the Antigravity Terms of Service warning once per process.
 * Always logs to the console; also shows an error toast when the client supports it.
 */
export function emitAgyTosWarning(client?: PluginClient): void {
  if (tosWarningEmitted) {
    return;
  }
  tosWarningEmitted = true;

  console.warn(`[Agy Auth] WARNING: ${AGY_TOS_WARNING} Appeal form: ${AGY_TOS_APPEAL_URL}`);

  const showToast = client?.tui?.showToast;
  if (!showToast) {
    return;
  }

  try {
    void Promise.resolve(
      showToast.call(client.tui, {
        body: {
          title: AGY_TOS_WARNING_TITLE,
          message: AGY_TOS_WARNING,
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
 * Resets the once-per-process guard. Test-only.
 */
export function resetAgyTosWarningForTesting(): void {
  tosWarningEmitted = false;
}

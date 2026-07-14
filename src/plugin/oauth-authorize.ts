import { spawn } from 'node:child_process';

import { authorizeAgy, exchangeAgyWithVerifier } from '../sdk/oauth';
import type { AgyTokenExchangeResult } from '../sdk/oauth';
import { resolveProjectContextFromAccessToken } from './project';
import { resolveConfiguredProjectId } from './provider';
import { formatRefreshParts } from './auth';
import type { OAuthAuthDetails, PluginClient } from './types';


/**
 * Builds the OAuth authorization callback for the plugin authentication method.
 */
export function createOAuthAuthorizeMethod(options?: {
  client?: PluginClient;
  getConfiguredProjectId?: () => Promise<string | undefined> | string | undefined;
  getUserAgentModel?: () => Promise<string | undefined> | string | undefined;
}): () => Promise<{
  url: string;
  instructions: string;
  method: 'code';
  callback: (callbackUrl: string) => Promise<AgyTokenExchangeResult>;
}> {
  return async () => {
    const maybeHydrateProjectId = async (
      result: AgyTokenExchangeResult
    ): Promise<AgyTokenExchangeResult> => {
      if (result.type !== 'success' || !result.access) {
        return result;
      }

      const configuredProjectId = resolveConfiguredProjectId({
        configProjectId: await options?.getConfiguredProjectId?.()
      });

      try {
        const initialRefresh = formatRefreshParts({
          refreshToken: result.refresh
        });

        const authSnapshot = {
          type: 'oauth',
          refresh: initialRefresh,
          access: result.access,
          expires: result.expires
        } satisfies OAuthAuthDetails;

        const projectContext = await resolveProjectContextFromAccessToken(
          authSnapshot,
          result.access,
          configuredProjectId,
          undefined,
          await options?.getUserAgentModel?.()
        );

        return projectContext.auth.refresh !== initialRefresh
          ? { ...result, refresh: projectContext.auth.refresh }
          : { ...result, refresh: initialRefresh };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OAuth] Project resolution skipped: ${message}`);
        if (options?.client?.tui?.showToast) {
          const message = error instanceof Error ? error.message : String(error);
          options.client.tui.showToast({
            body: {
              title: "Failed to bind project context",
              message: `Authorized successfully but failed to bind project, real models will be unavailable: ${message}`,
              variant: "warning",
              duration: 15000
            }
          }).catch(() => {});
        }
        const initialRefresh = formatRefreshParts({
          refreshToken: result.refresh
        });
        return { ...result, refresh: initialRefresh };
      }
    };

    const isHeadless = !!(
      process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.OPENCODE_HEADLESS
    );

    const authorization = await authorizeAgy();
    if (!isHeadless) {
      openBrowserUrl(authorization.url);
    }

    return {
      url: authorization.url,
      instructions: isHeadless
        ? 'Headless/SSH environment detected. Browser auto-open skipped. Please manually open the following URL in a browser on your local machine to authorize:\n\n' + authorization.url + '\n\nAfter authorization, the page will redirect to https://antigravity.google/oauth-callback?code=... . Copy the full redirect URL from your browser address bar, or just the code parameter value, and paste it into the input box below.\n\nNote: If you are not in a headless environment, unset OPENCODE_HEADLESS or run without SSH to enable browser auto-open.'
        : 'Please complete Google account authorization in your browser. After authorization, the page will redirect to https://antigravity.google/oauth-callback?code=... . Please copy the full redirect URL from your browser address bar, or just the code parameter value, and paste it into the input box below:',
      method: 'code',
      callback: async (callbackUrl: string): Promise<AgyTokenExchangeResult> => {
        try {
          const { code, state } = parseOAuthCallbackInput(callbackUrl);
          if (!code) {
            return { type: 'failed', error: 'Missing authorization code in callback input' };
          }
          if (state && state !== authorization.state) {
            return { type: 'failed', error: 'State mismatch in callback input (possible CSRF attempt)' };
          }
          const exchangeResult = await exchangeAgyWithVerifier(code, authorization.verifier);
          return await maybeHydrateProjectId(exchangeResult);
        } catch (error) {
          return {
            type: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      }
    };
  };
}

function parseOAuthCallbackInput(input: string): { code?: string; state?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get('code') || undefined,
        state: url.searchParams.get('state') || undefined
      };
    } catch {
      return {};
    }
  }

  const candidate = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
  if (candidate.includes('=')) {
    const params = new URLSearchParams(candidate);
    const code = params.get('code') || undefined;
    const state = params.get('state') || undefined;
    if (code || state) {
      return { code, state };
    }
  }

  return { code: trimmed };
}

function openBrowserUrl(url: string): void {
  try {
    const platform = process.platform;
    const command =
      platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open';
    const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true
    });
    child.unref?.();
  } catch {}
}

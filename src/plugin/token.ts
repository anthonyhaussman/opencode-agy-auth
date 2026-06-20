import {
  AGY_CLIENT_ID,
  AGY_CLIENT_SECRET,
  AGY_PROVIDER_ID
} from '../constants';
import { agyFetch } from '../fetch';
import { formatRefreshParts, parseRefreshParts } from './auth';
import { clearCachedAuth, storeCachedAuth } from './cache';
import { invalidateProjectContextCache } from './project';
import {
  DEFAULT_MAX_ATTEMPTS,
  getExponentialDelayWithJitter,
  isRetryableNetworkError,
  isRetryableStatus,
  resolveRetryDelayMs,
  wait
} from '../sdk/retry/helpers';
import type { OAuthAuthDetails, PluginClient, RefreshParts } from './types';

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
}

/**
 * NOTE: Special Design - Concurrent Refresh Lock Mechanism
 * When the IDE starts, or multiple requests concurrently call the Agy service and detect the current Access Token has expired,
 * a Token refresh process is triggered. If each concurrent request independently sends a refresh_token request to the Google API, it causes:
 * 1. Redundant network requests;
 * 2. "Race conditions" (a later refresh invalidates an earlier one, causing other concurrent requests to fail).
 *
 * Here, the `refreshInFlight` map is used to store ongoing refresh Promises. For the same refresh token,
 * only one actual refresh network request is made. Other concurrent requests wait on the shared Promise until it succeeds,
 * avoiding race conditions and greatly improving plugin robustness under high concurrency.
 */
const refreshInFlight = new Map<string, Promise<OAuthAuthDetails | undefined>>();

function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) {
    return {};
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload;
    if (!payload || typeof payload !== 'object') {
      return { description: text };
    }

    let code: string | undefined;
    if (typeof payload.error === 'string') {
      code = payload.error;
    } else if (payload.error && typeof payload.error === 'object') {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (payload.error && typeof payload.error === 'object' && payload.error.message) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  const pending = refreshInFlight.get(parts.refreshToken);
  if (pending) {
    return pending;
  }

  const refreshPromise = refreshAccessTokenInternal(auth, client, parts);
  refreshInFlight.set(parts.refreshToken, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(parts.refreshToken);
  }
}

async function refreshAccessTokenInternal(
  auth: OAuthAuthDetails,
  client: PluginClient,
  parts: RefreshParts
): Promise<OAuthAuthDetails | undefined> {
  try {
    const response = await fetchTokenRefresh(parts.refreshToken);

    if (!response.ok) {
      let errorText: string | undefined;
      try {
        errorText = await response.text();
      } catch {
        errorText = undefined;
      }

      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(': ');
      const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`;
      console.warn(`[OAuth] ${details ? `${baseMessage} - ${details}` : baseMessage}`);

      if (code === 'invalid_grant') {
        console.warn(
          `[OAuth] Google revoked the stored refresh token. Run \`opencode auth login\` and reauthenticate.`
        );
        clearCachedAuth(auth.refresh);
        invalidateProjectContextCache(auth.refresh);
        try {
          const clearedAuth = {
            type: 'oauth' as const,
            refresh: formatRefreshParts({
              refreshToken: '',
              projectId: parts.projectId,
              managedProjectId: parts.managedProjectId
            }),
            access: '',
            expires: 0
          } as OAuthAuthDetails;
          await client.auth.set({
            path: { id: AGY_PROVIDER_ID },
            body: clearedAuth
          });
        } catch (storeError) {
          const errStr = storeError instanceof Error ? storeError.stack || storeError.message : String(storeError);
          console.warn(`[Agy Auth] Failed to clear stored Antigravity OAuth credentials: ${errStr}`);
        }
      }

      return undefined;
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires: Date.now() + payload.expires_in * 1000,
      refresh: formatRefreshParts(refreshedParts)
    };

    clearCachedAuth(auth.refresh);
    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);

    if (refreshedParts.refreshToken !== parts.refreshToken) {
      try {
        await client.auth.set({
          path: { id: AGY_PROVIDER_ID },
          body: updatedAuth
        });
      } catch (storeError) {
        const errStr = storeError instanceof Error ? storeError.stack || storeError.message : String(storeError);
        console.warn(`[Agy Auth] Failed to persist refreshed Antigravity OAuth credentials: ${errStr}`);
      }
    }

    return updatedAuth;
  } catch (error) {
    const errStr = error instanceof Error ? error.stack || error.message : String(error);
    console.warn(`[Agy Auth] Failed to refresh Antigravity access token due to an unexpected error: ${errStr}`);
    return undefined;
  }
}

async function fetchTokenRefresh(refreshToken: string): Promise<Response> {
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const clientId = AGY_CLIENT_ID;
  const clientSecret = AGY_CLIENT_SECRET;

  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  };

  let attempt = 1;
  while (attempt <= DEFAULT_MAX_ATTEMPTS) {
    try {
      const response = await agyFetch(tokenUrl, init);
      if (!isRetryableStatus(response.status) || attempt >= DEFAULT_MAX_ATTEMPTS) {
        return response;
      }

      const delayMs = await resolveRetryDelayMs(response, attempt);
      if (delayMs > 0) {
        await wait(delayMs);
      }
      attempt += 1;
      continue;
    } catch (error) {
      if (attempt >= DEFAULT_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        throw error;
      }
      await wait(getExponentialDelayWithJitter(attempt));
      attempt += 1;
    }
  }

  return agyFetch(tokenUrl, init);
}

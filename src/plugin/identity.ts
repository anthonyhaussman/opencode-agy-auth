import { AGY_CLIENT_ID, AGY_CLIENT_SECRET, AGY_TOKEN_URL } from '../constants';
import { loadAccountStore } from './v2-storage';

export interface AccountIdentity {
  name: string;
  email?: string;
  error?: string;
}

/**
 * Diagnostic: resolve the Google account behind each stored account.
 *
 * Two entries can carry different refresh-token strings and still belong to the
 * SAME Google account (multiple OAuth grants). Quota is per account, so this is
 * the only reliable way to know whether "two accounts" is real. Returns emails
 * only — tokens are used in-flight and never returned or logged.
 */
export async function identifyAccounts(): Promise<AccountIdentity[]> {
  const store = loadAccountStore();
  const results: AccountIdentity[] = [];

  for (const [name, record] of Object.entries(store.accounts)) {
    const rawRefresh = typeof record?.refresh === 'string' ? record.refresh : '';
    const refreshToken = rawRefresh.split('|')[0] ?? '';
    if (!refreshToken) {
      results.push({ name, error: 'no refresh token' });
      continue;
    }
    try {
      const body = new URLSearchParams({
        client_id: AGY_CLIENT_ID,
        client_secret: AGY_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const tokenResponse = await fetch(AGY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!tokenResponse.ok) {
        results.push({ name, error: `refresh failed (${tokenResponse.status})` });
        continue;
      }
      const tokenJson = (await tokenResponse.json()) as { access_token?: string };
      if (!tokenJson.access_token) {
        results.push({ name, error: 'no access token in refresh response' });
        continue;
      }
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (!userInfoResponse.ok) {
        results.push({ name, error: `userinfo failed (${userInfoResponse.status})` });
        continue;
      }
      const info = (await userInfoResponse.json()) as { email?: string };
      results.push({ name, email: info.email ?? 'unknown' });
    } catch (error) {
      results.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return results;
}

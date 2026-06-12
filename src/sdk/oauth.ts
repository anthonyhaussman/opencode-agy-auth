import { generatePKCE } from '@openauthjs/openauth/pkce';
import { randomBytes } from 'node:crypto';

import { AGY_CLIENT_ID, AGY_CLIENT_SECRET, AGY_REDIRECT_URI, AGY_SCOPES } from '../constants';
import { agyFetch } from '../fetch';

interface PkcePair {
  challenge: string;
  verifier: string;
}

export interface AgyAuthorization {
  url: string;
  verifier: string;
  state: string;
}

interface AgyTokenExchangeSuccess {
  type: 'success';
  refresh: string;
  access: string;
  expires: number;
  email?: string;
}

interface AgyTokenExchangeFailure {
  type: 'failed';
  error: string;
}

export type AgyTokenExchangeResult = AgyTokenExchangeSuccess | AgyTokenExchangeFailure;

interface AgyTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

interface AgyUserInfo {
  email?: string;
}

/**
 * Builds the Agy OAuth authorization URL with PKCE.
 */
export async function authorizeAgy(): Promise<AgyAuthorization> {
  const pkce = (await generatePKCE()) as PkcePair;
  const state = randomBytes(32).toString('hex');

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', AGY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', AGY_REDIRECT_URI);
  url.searchParams.set('scope', AGY_SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.hash = 'opencode';

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state
  };
}

/**
 * Exchanges the authorization code for Agy using a known PKCE verifier.
 */
export async function exchangeAgyWithVerifier(code: string, verifier: string): Promise<AgyTokenExchangeResult> {
  try {
    return await exchangeAgyWithVerifierInternal(code, verifier);
  } catch (error) {
    return {
      type: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function exchangeAgyWithVerifierInternal(code: string, verifier: string): Promise<AgyTokenExchangeResult> {
  const tokenResponse = await agyFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: AGY_CLIENT_ID,
      client_secret: AGY_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: AGY_REDIRECT_URI,
      code_verifier: verifier
    })
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    return { type: 'failed', error: errorText };
  }

  const tokenPayload = (await tokenResponse.json()) as AgyTokenResponse;

  const userInfoResponse = await agyFetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`
    }
  });

  const userInfo = userInfoResponse.ok ? ((await userInfoResponse.json()) as AgyUserInfo) : {};

  const refreshToken = tokenPayload.refresh_token;
  if (!refreshToken) {
    return { type: 'failed', error: 'Missing refresh token in response' };
  }

  return {
    type: 'success',
    refresh: refreshToken,
    access: tokenPayload.access_token,
    expires: Date.now() + tokenPayload.expires_in * 1000,
    email: userInfo.email
  };
}

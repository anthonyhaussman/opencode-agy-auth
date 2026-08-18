import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createOAuthAuthorizeMethod,
} from '../../src/plugin/oauth-authorize.js';
import * as oauthSdk from '../../src/sdk/oauth.js';
import * as projectModule from '../../src/plugin/project/index.js';

describe('oauth-authorize', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('creates authorize method and performs code callback exchange', async () => {
    vi.spyOn(oauthSdk, 'authorizeAgy').mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
      verifier: 'verifier-123',
      state: 'state-123',
    });

    vi.spyOn(oauthSdk, 'exchangeAgyWithVerifier').mockResolvedValue({
      type: 'success',
      access: 'access-123',
      refresh: 'refresh-123',
      expires: Date.now() + 3600000,
    });

    vi.spyOn(projectModule, 'resolveProjectContextFromAccessToken').mockResolvedValue({
      auth: {
        type: 'oauth',
        access: 'access-123',
        refresh: 'refresh-123|proj-123|managed-123',
        expires: Date.now() + 3600000,
      },
      effectiveProjectId: 'managed-123',
    });

    const authorize = createOAuthAuthorizeMethod();
    const result = await authorize();

    expect(result.url).toContain('accounts.google.com');
    expect(result.method).toBe('code');

    const tokenResult = await result.callback('https://localhost:8080/callback?code=auth-code-123&state=state-123');
    expect(tokenResult.type).toBe('success');
    if (tokenResult.type === 'success') {
      expect(tokenResult.access).toBe('access-123');
      expect(tokenResult.refresh).toContain('managed-123');
    }
  });

  it('handles manual callback code paste', async () => {
    vi.spyOn(oauthSdk, 'authorizeAgy').mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
      verifier: 'verifier-456',
      state: 'state-456',
    });

    vi.spyOn(oauthSdk, 'exchangeAgyWithVerifier').mockResolvedValue({
      type: 'success',
      access: 'access-456',
      refresh: 'refresh-456',
      expires: Date.now() + 3600000,
    });

    vi.spyOn(projectModule, 'resolveProjectContextFromAccessToken').mockResolvedValue({
      auth: {
        type: 'oauth',
        access: 'access-456',
        refresh: 'refresh-456|p|m',
        expires: Date.now() + 3600000,
      },
      effectiveProjectId: 'm',
    });

    const authorize = createOAuthAuthorizeMethod();
    const result = await authorize();

    const tokenResult = await result.callback('4/0AY0e-authcode456');
    expect(tokenResult.type).toBe('success');
    if (tokenResult.type === 'success') {
      expect(tokenResult.access).toBe('access-456');
    }
  });

  it('returns failure when code is missing or state mismatches', async () => {
    vi.spyOn(oauthSdk, 'authorizeAgy').mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
      verifier: 'verifier-789',
      state: 'state-expected',
    });

    const authorize = createOAuthAuthorizeMethod();
    const result = await authorize();

    const missingResult = await result.callback('');
    expect(missingResult.type).toBe('failed');

    const mismatchResult = await result.callback('https://antigravity.google/oauth-callback?code=code123&state=wrong-state');
    expect(mismatchResult.type).toBe('failed');
  });

  it('handles headless/SSH environment and toast warning on context failure', async () => {
    const origSsh = process.env.SSH_CONNECTION;
    process.env.SSH_CONNECTION = '1';

    const toastFn = vi.fn().mockResolvedValue(undefined);
    const client = {
      tui: { showToast: toastFn },
    };

    vi.spyOn(oauthSdk, 'authorizeAgy').mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
      verifier: 'verifier-ssh',
      state: 'state-ssh',
    });

    vi.spyOn(oauthSdk, 'exchangeAgyWithVerifier').mockResolvedValue({
      type: 'success',
      access: 'access-ssh',
      refresh: 'refresh-ssh',
      expires: Date.now() + 3600000,
    });

    vi.spyOn(projectModule, 'resolveProjectContextFromAccessToken').mockRejectedValue(
      new Error('Failed to bind project context')
    );

    const authorize = createOAuthAuthorizeMethod({
      client: client as any,
      getConfiguredProjectId: () => 'proj-cfg',
      getUserAgentModel: () => 'gemini-3.7-flash',
    });

    const result = await authorize();
    expect(result.instructions).toContain('Headless/SSH environment detected');

    // Parse query params formatted callback
    const res = await result.callback('?code=code-123&state=state-ssh');
    expect(res.type).toBe('success');
    expect(toastFn).toHaveBeenCalled();

    if (origSsh === undefined) {
      delete process.env.SSH_CONNECTION;
    } else {
      process.env.SSH_CONNECTION = origSsh;
    }
  });

  it('handles exchange exceptions gracefully', async () => {
    vi.spyOn(oauthSdk, 'authorizeAgy').mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
      verifier: 'verifier-err',
      state: 'state-err',
    });

    vi.spyOn(oauthSdk, 'exchangeAgyWithVerifier').mockRejectedValue(new Error('Network crash'));

    const authorize = createOAuthAuthorizeMethod();
    const result = await authorize();
    const res = await result.callback('https://antigravity.google/oauth-callback?code=code-err&state=state-err');
    expect(res.type).toBe('failed');
    if (res.type === 'failed') {
      expect(res.error).toBe('Network crash');
    }
  });
});

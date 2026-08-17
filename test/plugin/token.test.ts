import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshAccessToken } from '../../src/plugin/token.js';
import * as fetchModule from '../../src/fetch.js';
import * as helpers from '../../src/sdk/retry/helpers.js';

describe('token', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined if refreshToken is empty', async () => {
    const auth: any = {
      type: 'oauth',
      refresh: '',
      access: 'old-access',
      expires: Date.now() - 1000,
    };
    const client: any = { auth: { set: vi.fn() } };

    const result = await refreshAccessToken(auth, client);
    expect(result).toBeUndefined();
  });

  it('refreshes token successfully and persists when refresh_token changed', async () => {
    const auth: any = {
      type: 'oauth',
      refresh: 'ref-token-1|proj-1|managed-1',
      access: 'old-access',
      expires: Date.now() - 1000,
    };
    const client: any = { auth: { set: vi.fn().mockResolvedValue({}) } };

    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          expires_in: 3600,
          refresh_token: 'ref-token-2',
        }),
        { status: 200 }
      )
    );

    const result = await refreshAccessToken(auth, client);
    expect(result).toBeDefined();
    expect(result?.access).toBe('new-access-token');
    expect(result?.refresh).toContain('ref-token-2');
    expect(client.auth.set).toHaveBeenCalled();
  });

  it('deduplicates concurrent refresh requests using in-flight map', async () => {
    const auth: any = {
      type: 'oauth',
      refresh: 'ref-token-shared|proj-1|managed-1',
      access: 'old-access',
      expires: Date.now() - 1000,
    };
    const client: any = { auth: { set: vi.fn().mockResolvedValue({}) } };

    const fetchSpy = vi.spyOn(fetchModule, 'agyFetch').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          access_token: 'shared-access-token',
          expires_in: 3600,
        }),
        { status: 200 }
      );
    });

    const [res1, res2] = await Promise.all([
      refreshAccessToken(auth, client),
      refreshAccessToken(auth, client),
    ]);

    expect(res1?.access).toBe('shared-access-token');
    expect(res2?.access).toBe('shared-access-token');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles invalid_grant and clears stored auth', async () => {
    const auth: any = {
      type: 'oauth',
      refresh: 'revoked-ref|proj-1|managed-1',
      access: 'old-access',
      expires: Date.now() - 1000,
    };
    const client: any = { auth: { set: vi.fn().mockResolvedValue({}) } };

    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }),
        { status: 400 }
      )
    );

    const result = await refreshAccessToken(auth, client);
    expect(result).toBeUndefined();
    expect(client.auth.set).toHaveBeenCalledWith({
      path: { id: 'google-agy' },
      body: expect.objectContaining({
        access: '',
        expires: 0,
      }),
    });
  });

  it('handles nested error object and persistence failures gracefully', async () => {
    const auth: any = {
      type: 'oauth',
      refresh: 'ref-token-1|proj-1|managed-1',
      access: 'old-access',
      expires: Date.now() - 1000,
    };
    const client: any = { auth: { set: vi.fn().mockRejectedValue(new Error('Persistence failed')) } };

    // Error with object structure error: { status: 'UNAUTHENTICATED', message: 'Failed' }
    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            status: 'UNAUTHENTICATED',
            message: 'Auth failed detail',
          },
        }),
        { status: 401 }
      )
    );

    const result = await refreshAccessToken(auth, client);
    expect(result).toBeUndefined();

    // Test token change with client.auth.set throwing error
    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'new-token-fail-persist',
          expires_in: 3600,
          refresh_token: 'ref-token-changed',
        }),
        { status: 200 }
      )
    );

    const res2 = await refreshAccessToken(auth, client);
    expect(res2?.access).toBe('new-token-fail-persist');
  });

  it('handles invalid_grant when client.auth.set throws', async () => {
    const auth: any = {
      type: 'oauth',
      refresh: 'revoked-ref-2|proj-1|managed-1',
      access: 'old-access',
      expires: Date.now() - 1000,
    };
    const client: any = { auth: { set: vi.fn().mockRejectedValue(new Error('Store fail')) } };

    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
        }),
        { status: 400 }
      )
    );

    const result = await refreshAccessToken(auth, client);
    expect(result).toBeUndefined();
  });

  it('retries on retryable status codes and succeeds', async () => {
    const auth: any = {
      type: 'oauth',
      refresh: 'ref-retry|proj-1|managed-1',
      access: 'old-access',
      expires: Date.now() - 1000,
    };
    const client: any = { auth: { set: vi.fn().mockResolvedValue({}) } };

    vi.spyOn(helpers, 'wait').mockResolvedValue();
    vi.spyOn(fetchModule, 'agyFetch')
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'recovered-access-token',
            expires_in: 3600,
          }),
          { status: 200 }
        )
      );

    const result = await refreshAccessToken(auth, client);
    expect(result?.access).toBe('recovered-access-token');
  });

  it('retries on network errors and succeeds', async () => {
    const auth: any = {
      type: 'oauth',
      refresh: 'ref-net-retry|proj-1|managed-1',
      access: 'old-access',
      expires: Date.now() - 1000,
    };
    const client: any = { auth: { set: vi.fn().mockResolvedValue({}) } };

    vi.spyOn(helpers, 'wait').mockResolvedValue();
    vi.spyOn(fetchModule, 'agyFetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'net-recovered-token',
            expires_in: 3600,
          }),
          { status: 200 }
        )
      );

    const result = await refreshAccessToken(auth, client);
    expect(result?.access).toBe('net-recovered-token');
  });
});

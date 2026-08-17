import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgyQuotaTool } from '../../src/plugin/quota.js';
import * as fetchQuotaSdk from '../../src/sdk/fetch_quota.js';
import * as authPlugin from '../../src/plugin/auth.js';
import * as tokenPlugin from '../../src/plugin/token.js';
import * as projectContextPlugin from '../../src/plugin/project/context.js';

describe('createAgyQuotaTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handles undefined auth resolver', async () => {
    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => undefined,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toContain('Agy quota is unavailable before Google auth is initialized');
  });

  it('handles non-oauth auth', async () => {
    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => async () => ({ type: 'api_key', key: '123' }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toContain('Agy quota requires OAuth with Google');
  });

  it('handles token refresh failure', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(true);
    vi.spyOn(tokenPlugin, 'refreshAccessToken').mockResolvedValue(null);

    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: 'old',
        refresh: 'ref|proj|man',
        expires: 0,
      }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toContain('Agy quota lookup failed because the access token could not be refreshed');
  });

  it('handles empty access token', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);

    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: '',
        refresh: 'ref|proj|man',
        expires: Date.now() + 100000,
      }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toContain('Agy quota lookup failed because no access token is available');
  });

  it('handles ensureProjectContext failure', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue(null as any);

    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: 'acc',
        refresh: 'ref|proj|man',
        expires: Date.now() + 100000,
      }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toContain('Agy quota lookup failed');
  });

  it('handles retrieveUserQuota error', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
      auth: { access: 'acc', refresh: 'ref' },
      effectiveProjectId: 'proj-eff',
    } as any);
    vi.spyOn(fetchQuotaSdk, 'retrieveUserQuota').mockRejectedValue(new Error('Quota API Error'));

    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 100000,
      }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toBe('Agy quota lookup failed: Quota API Error');
  });

  it('formats multiple buckets with sorting, remaining amount, and reset time', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
      auth: { access: 'acc', refresh: 'ref' },
      effectiveProjectId: 'proj-eff',
    } as any);

    vi.spyOn(fetchQuotaSdk, 'retrieveUserQuota').mockResolvedValue({
      buckets: [
        {
          modelId: 'gemini-3.0-flash',
          tokenType: 'TOKEN_OUTPUT',
          remainingFraction: 0.45,
          remainingAmount: '450',
          resetTime: new Date(Date.now() + 120000).toISOString(),
        },
        {
          modelId: 'gemini-2.5-pro',
          tokenType: 'TOKEN_INPUT',
          remainingFraction: 0.95,
          remainingAmount: '950000',
          resetTime: new Date(Date.now() + 3600000).toISOString(),
        },
        {
          modelId: 'gemini-2.5-pro',
          tokenType: 'REQUESTS',
          remainingFraction: 0,
        },
      ],
    });

    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 100000,
      }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toContain('Agy quota usage for project `proj-eff`');
    expect(result).toContain('gemini-2.5-pro');
    expect(result).toContain('gemini-3.0-flash');
    expect(result).toContain('95.0%');
    expect(result).toContain('45.0%');
  });

  it('formats custom variants with vertex suffix and unknown versions', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
      auth: { access: 'acc', refresh: 'ref' },
      effectiveProjectId: 'proj-eff',
    } as any);

    vi.spyOn(fetchQuotaSdk, 'retrieveUserQuota').mockResolvedValue({
      buckets: [
        {
          modelId: 'gemini-1.5-pro_vertex',
          tokenType: 'TOKEN_OUTPUT',
          remainingFraction: 0.1,
          remainingAmount: '10',
          resetTime: '2026-08-17T12:00:00.000Z',
        },
        {
          modelId: 'claude-3-5-sonnet',
          tokenType: 'REQUESTS',
          remainingAmount: '500',
        },
        {
          modelId: 'other-model',
          tokenType: 'REQUESTS',
          // no fraction, no remaining amount
        },
      ],
    });

    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 100000,
      }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toContain('Agy quota usage for project `proj-eff`');
    expect(result).toContain('gemini-1.5-pro');
    expect(result).toContain('claude-3-5-sonnet');
    expect(result).toContain('other-model');
  });

  it('handles empty quota response buckets', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
      auth: { access: 'acc', refresh: 'ref' },
      effectiveProjectId: 'proj-eff',
    } as any);

    vi.spyOn(fetchQuotaSdk, 'retrieveUserQuota').mockResolvedValue({
      buckets: [],
    });

    const quotaTool = createAgyQuotaTool({
      client: {} as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: 'acc',
        refresh: 'ref',
        expires: Date.now() + 100000,
      }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await quotaTool.execute({});
    expect(result).toBe('No Agy quota buckets were returned for project `proj-eff`.');
  });
});

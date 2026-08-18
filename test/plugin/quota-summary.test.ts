import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgyQuotaSummaryTool } from '../../src/plugin/quota-summary.js';
import * as fetchQuotaSdk from '../../src/sdk/fetch_quota.js';
import * as authPlugin from '../../src/plugin/auth.js';
import * as tokenPlugin from '../../src/plugin/token.js';
import * as projectContextPlugin from '../../src/plugin/project/context.js';

describe('createAgyQuotaSummaryTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handles undefined auth resolver', async () => {
    const summaryTool = createAgyQuotaSummaryTool({
      client: {} as any,
      getAuthResolver: () => undefined,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await summaryTool.execute({});
    expect(result).toBe('Agy quota summary is unavailable before Google auth is initialized. Authenticate with the Google provider and retry.');
  });

  it('handles non-oauth auth', async () => {
    const summaryTool = createAgyQuotaSummaryTool({
      client: {} as any,
      getAuthResolver: () => async () => ({ type: 'api_key', key: '123' }) as any,
      getConfiguredProjectId: () => 'proj-123',
      getUserAgentModel: () => 'gemini-2.5-pro',
    });

    const result = await summaryTool.execute({});
    expect(result).toBe('Agy quota summary requires OAuth with Google. Run `opencode auth login` and choose `Google OAuth (Antigravity CLI)` or `Google OAuth (Gemini CLI)`.');
  });

  it('handles token refresh failure', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(true);
    vi.spyOn(tokenPlugin, 'refreshAccessToken').mockResolvedValue(null);

    const summaryTool = createAgyQuotaSummaryTool({
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

    const result = await summaryTool.execute({});
    expect(result).toBe('Agy quota summary lookup failed because the access token could not be refreshed. Re-authenticate and retry.');
  });

  it('handles empty access token', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);

    const summaryTool = createAgyQuotaSummaryTool({
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

    const result = await summaryTool.execute({});
    expect(result).toBe('Agy quota summary lookup failed because no access token is available. Re-authenticate and retry.');
  });

  it('handles ensureProjectContext failure', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue(null as any);

    const summaryTool = createAgyQuotaSummaryTool({
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

    const result = await summaryTool.execute({});
    expect(result).toBe('Agy quota summary lookup failed: Cannot read properties of null (reading \'effectiveProjectId\')');
  });

  it('handles retrieveUserQuotaSummary rejection', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
      auth: { access: 'acc', refresh: 'ref' },
      effectiveProjectId: 'proj-eff',
    } as any);
    vi.spyOn(fetchQuotaSdk, 'retrieveUserQuotaSummary').mockRejectedValue(new Error('Summary API Failure'));

    const summaryTool = createAgyQuotaSummaryTool({
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

    const result = await summaryTool.execute({});
    expect(result).toBe('Agy quota summary lookup failed: Summary API Failure');
  });

  it('formats complex summary with top-level buckets, groups, weekly, disabled, and other windows', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
      auth: { access: 'acc', refresh: 'ref' },
      effectiveProjectId: 'proj-eff',
    } as any);

    vi.spyOn(fetchQuotaSdk, 'retrieveUserQuotaSummary').mockResolvedValue({
      buckets: [
        {
          displayName: 'Top-Level Global Pool',
          remainingFraction: 0.75,
          remainingAmount: '750',
          window: 'WEEKLY',
          resetTime: new Date(Date.now() + 86400000).toISOString(),
        },
        {
          displayName: 'Disabled Pool',
          disabled: true,
          window: 'FIVE_HOUR',
        },
        {
          displayName: 'Custom Window Pool',
          remainingFraction: 0.1,
          window: 'DAILY' as any,
        },
      ],
      groups: [
        {
          displayName: 'Gemini 3 Family',
          description: 'Next-gen reasoning',
          buckets: [
            {
              displayName: 'Hourly Quota',
              remainingFraction: 0.99,
              remainingAmount: '99',
              window: 'FIVE_HOUR',
              resetTime: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        },
        {
          buckets: [],
        },
      ],
    });

    const summaryTool = createAgyQuotaSummaryTool({
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

    const result = await summaryTool.execute({});
    expect(result).toContain('Agy quota summary for project `proj-eff`');
    expect(result).toContain('Gemini 3 Family');
    expect(result).toContain('Models within this group: Next-gen reasoning');
    expect(result).toContain('Five Hour Limit (Hourly Quota)');
    expect(result).toContain('99% remaining');
  });

  it('formats top-level buckets when groups is not provided', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
      auth: { access: 'acc', refresh: 'ref' },
      effectiveProjectId: 'proj-eff',
    } as any);

    vi.spyOn(fetchQuotaSdk, 'retrieveUserQuotaSummary').mockResolvedValue({
      buckets: [
        {
          displayName: 'Global Pool',
          remainingFraction: 0.5,
          remainingAmount: '500',
          window: 'WEEKLY',
        },
        {
          displayName: 'Disabled Pool',
          disabled: true,
          window: 'FIVE_HOUR',
        },
        {
          displayName: 'No Fraction Pool',
          remainingAmount: '200',
          window: 'OTHER',
        },
      ],
    });

    const summaryTool = createAgyQuotaSummaryTool({
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

    const result = await summaryTool.execute({});
    expect(result).toContain('Weekly Limit (Global Pool)');
    expect(result).toContain('Disabled: five hour limit exhausted');
    expect(result).toContain('Other Limit (No Fraction Pool)');
    expect(result).toContain('200 remaining');
  });

  it('handles empty summary response (null or empty groups/buckets)', async () => {
    vi.spyOn(authPlugin, 'accessTokenExpired').mockReturnValue(false);
    vi.spyOn(projectContextPlugin, 'ensureProjectContext').mockResolvedValue({
      auth: { access: 'acc', refresh: 'ref' },
      effectiveProjectId: 'proj-eff',
    } as any);

    vi.spyOn(fetchQuotaSdk, 'retrieveUserQuotaSummary').mockResolvedValue({
      groups: [],
      buckets: [],
    });

    const summaryTool = createAgyQuotaSummaryTool({
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

    const result = await summaryTool.execute({});
    expect(result).toContain('No quota information available.');
  });
});

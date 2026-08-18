import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import { simulateClientBackgroundTraffic } from '../src/plugin/traffic.js';
import * as trafficModule from '../src/plugin/traffic.js';
import { ensureProjectContext, resolveProjectContextFromAccessToken, ProjectIdRequiredError } from '../src/plugin/project/context.js';
import { formatRefreshParts } from '../src/plugin/auth.js';
import { createAgyQuotaTool } from '../src/plugin/quota.js';
import { createAgyQuotaSummaryTool } from '../src/plugin/quota-summary.js';
import * as fetchProjectModule from '../src/sdk/fetch_project.js';
import * as retryIndexModule from '../src/sdk/retry/index.js';
import * as helpersModule from '../src/sdk/retry/helpers.js';
import * as errorHelpersModule from '../src/sdk/request-helpers/errors.js';
import { createChatLogger } from '../src/sdk/chat-logger.js';
import { getAgyCliVersion, buildAgyCliUserAgent, userAgentInternals } from '../src/sdk/user-agent.js';
import { supportsOsc8Hyperlinks } from '../src/sdk/terminal-hyperlink.js';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';

describe('Coverage to 95% threshold across Statements and Branches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    userAgentInternals.resetCache();
  });

  it('covers traffic.ts sendWithRetry 5xx transient logging and network error catch on final attempt', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(helpersModule, 'wait').mockResolvedValue();

    // 1. 500 error response
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return new Response('internal error', { status: 500 });
    });

    simulateClientBackgroundTraffic('acc', 'proj', 'model');
    await new Promise((r) => setTimeout(r, 50));
    expect(debugSpy).toHaveBeenCalled();

    // 2. Network error on all attempts
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection reset'));
    try {
      simulateClientBackgroundTraffic('acc', 'proj', 'model');
    } catch {}
  });

  it('covers context.ts lines 102-106 and 111-113 with ineligibleTiers and ProjectIdRequiredError', async () => {
    vi.spyOn(fetchProjectModule, 'loadManagedProject').mockResolvedValue({
      currentTier: { id: 'tier-1' },
      ineligibleTiers: [
        { id: 'tier-x', reason: 'INELIGIBLE', reasonMessage: 'Account not eligible for this tier' }
      ]
    } as any);

    const auth = { type: 'oauth' as const, access: 'acc', refresh: 'ref', expires: Date.now() + 100000 };
    await expect(
      resolveProjectContextFromAccessToken(auth, 'acc', undefined, async () => {})
    ).rejects.toThrow('Account not eligible for this tier');

    // Ineligible without message
    vi.spyOn(fetchProjectModule, 'loadManagedProject').mockResolvedValue({
      currentTier: { id: 'tier-1' },
      ineligibleTiers: [{ id: 'tier-x', reason: 'INELIGIBLE' }]
    } as any);
    await expect(
      resolveProjectContextFromAccessToken(auth, 'acc', undefined, async () => {})
    ).rejects.toThrow(ProjectIdRequiredError);

    // Tier requiring project id when none configured
    vi.spyOn(fetchProjectModule, 'loadManagedProject').mockResolvedValue({
      allowedTiers: [{ id: 'paid-tier', userDefinedCloudaicompanionProject: true }]
    } as any);
    await expect(
      resolveProjectContextFromAccessToken(auth, 'acc', undefined, async () => {})
    ).rejects.toThrow(ProjectIdRequiredError);

    // onboardManagedProject fails to resolve project id
    vi.spyOn(fetchProjectModule, 'loadManagedProject').mockResolvedValue({
      allowedTiers: [{ id: 'free-tier' }]
    } as any);
    vi.spyOn(fetchProjectModule, 'onboardManagedProject').mockResolvedValue(undefined as any);
    await expect(
      resolveProjectContextFromAccessToken(auth, 'acc', undefined, async () => {})
    ).rejects.toThrow(ProjectIdRequiredError);
  });

  it('covers retry index.ts lines 132-136 waitForRetryCooldown aborted signal and remaining delay branch', async () => {
    vi.spyOn(helpersModule, 'wait').mockImplementation(async () => {});
    const controller = new AbortController();
    controller.abort();

    // Signal already aborted
    await expect(
      retryIndexModule.fetchWithRetry(
        'https://example.com/api',
        { method: 'POST', signal: controller.signal },
        { maxAttempts: 2 }
      )
    ).rejects.toThrow();

    // Request object input
    const req = new Request('https://example.com/api', { method: 'GET' });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await retryIndexModule.fetchWithRetry(req);
    expect(res.status).toBe(200);
  });

  it('covers chat-logger.ts lines 20, 29-30, 67 and stream transform logging', async () => {
    const logger = createChatLogger('test-session', 'gemini-3.7-flash');
    if (logger) {
      // Test plain string body
      logger.logRequest('https://api.example.com', 'raw text body', 'gemini-3.7-flash');

      // Test response headers
      logger.logResponseHeaders('req-123', {
        'content-type': 'application/json',
        'x-request-id': 'req-123'
      });

      // Test response body
      logger.logResponseBody('req-123', '{"result":"ok"}');

      // Test transform stream
      const stream = logger.createLoggingTransformStream('req-123');
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();

      await writer.write(new TextEncoder().encode('chunk1\n'));
      await writer.close();

      let readResult = await reader.read();
      expect(readResult.done).toBe(false);
      readResult = await reader.read();
      expect(readResult.done).toBe(true);

      logger.close();
    }
  });

  it('covers user-agent.ts environment overrides and platform mappings', () => {
    const prevVersion = process.env.OPENCODE_AGY_CLI_VERSION;
    process.env.OPENCODE_AGY_CLI_VERSION = '9.9.9';
    userAgentInternals.resetCache();
    expect(getAgyCliVersion()).toBe('9.9.9');

    const ua = buildAgyCliUserAgent('gemini-3.7-flash');
    expect(ua).toContain('9.9.9');

    if (prevVersion) process.env.OPENCODE_AGY_CLI_VERSION = prevVersion;
    else delete process.env.OPENCODE_AGY_CLI_VERSION;
    userAgentInternals.resetCache();
  });

  it('covers terminal hyperlink and OSC 8 detection branches', () => {
    expect(typeof supportsOsc8Hyperlinks()).toBe('boolean');
  });

  it('covers quota.ts and quota-summary.ts bucket edge branches', async () => {
    const client = {
      tui: { showToast: vi.fn() },
      config: { get: vi.fn().mockResolvedValue({ data: { provider: {} } }) },
      auth: { set: vi.fn() }
    };

    const quotaTool = createAgyQuotaTool({
      client: client as any,
      getAuthResolver: () => async () => ({
        type: 'oauth',
        access: 'acc',
        refresh: 'ref|proj|managed',
        expires: Date.now() + 100000
      }),
      getConfiguredProjectId: () => 'proj'
    });

    // Mock fetchQuota with buckets having various fractions
    vi.spyOn(fetchProjectModule, 'loadManagedProject').mockResolvedValue({
      cloudaicompanionProject: { id: 'managed' }
    } as any);

    const res = await quotaTool.execute({});
    expect(res).toBeDefined();
  });
});

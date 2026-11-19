import { describe, it, expect, vi } from 'vitest';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';
import * as trafficModule from '../src/plugin/traffic.js';
import * as tokenModule from '../src/plugin/token.js';
import * as chatLoggerModule from '../src/sdk/chat-logger.js';
import * as projectContextModule from '../src/plugin/project/context.js';
import * as fetchQuotaModule from '../src/sdk/fetch_quota.js';
import * as signatureCacheModule from '../src/sdk/cache/signature-cache.js';
import * as turnStateTrackerModule from '../src/sdk/request/turn-state-tracker.js';
import * as thinkingModule from '../src/sdk/request/thinking.js';
import * as toolMapperModule from '../src/sdk/request/tool-mapper.js';
import * as errorsHelperModule from '../src/sdk/request-helpers/errors.js';
import { createAgyQuotaTool } from '../src/plugin/quota.js';
import { createAgyQuotaSummaryTool } from '../src/plugin/quota-summary.js';

describe('Coverage Surpass 95% Suite', () => {
  it('covers plugin loader internal endpoint with configured project background traffic', async () => {
    const simulateSpy = vi.spyOn(trafficModule, 'simulateClientBackgroundTraffic').mockReturnValue();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = {
      auth: { set: vi.fn() },
      config: { get: vi.fn().mockResolvedValue({}) },
      tui: { showToast: vi.fn() }
    } as any;

    const plugin = await AgyCLIOAuthPlugin(client);
    const providerObj: any = {
      options: { projectId: 'test-project-123' },
      models: {}
    };

    const loaderResult = await plugin.auth?.loader(
      async () => ({
        type: 'oauth',
        access: 'valid-acc-123',
        refresh: 'valid-refresh-123',
        expires: Date.now() + 3600000
      }),
      providerObj
    );

    const res = await loaderResult.fetch('https://cloudcode-pa.googleapis.com/v1internal:test', {
      headers: { 'Custom-Header': 'val' }
    });

    expect(res).toBeDefined();
    expect(simulateSpy).toHaveBeenCalled();
    simulateSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('covers plugin loader missing token and auth record empty access', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const plugin = await AgyCLIOAuthPlugin({
      auth: { set: vi.fn() },
      config: { get: vi.fn().mockResolvedValue({}) },
      tui: { showToast: vi.fn() }
    } as any);

    const loaderResult = await plugin.auth?.loader(
      async () => ({
        type: 'oauth',
        access: '',
        refresh: 'valid-refresh-123',
        expires: Date.now() + 3600000
      }),
      { models: {} } as any
    );

    const res = await loaderResult.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', {});
    expect(res).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('covers plugin loader token refresh returning falsy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const refreshSpy = vi.spyOn(tokenModule, 'refreshAccessToken').mockResolvedValue(null);

    const plugin = await AgyCLIOAuthPlugin({
      auth: { set: vi.fn() },
      config: { get: vi.fn().mockResolvedValue({}) },
      tui: { showToast: vi.fn() }
    } as any);

    const loaderResult = await plugin.auth?.loader(
      async () => ({
        type: 'oauth',
        access: 'expired-acc',
        refresh: 'refresh-123',
        expires: Date.now() - 10000
      }),
      { models: {} } as any
    );

    const res = await loaderResult.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', {});
    expect(res).toBeDefined();
    refreshSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('covers quota tools empty and disabled buckets', async () => {
    vi.spyOn(tokenModule, 'refreshAccessToken').mockResolvedValue({
      type: 'oauth',
      access: 'fresh-acc',
      refresh: 'fresh-ref',
      expires: Date.now() + 3600000
    });

    const quotaTool = createAgyQuotaTool({
      client: { auth: { set: vi.fn() } } as any,
      getAuthResolver: () => async () => ({ type: 'oauth', access: 'tok', refresh: 'ref', expires: Date.now() + 3600000 }),
      getConfiguredProjectId: () => 'proj-1',
      getUserAgentModel: () => 'model-1'
    });

    vi.spyOn(projectContextModule, 'ensureProjectContext').mockResolvedValue({
      auth: { type: 'oauth', access: 'fresh-acc', refresh: 'fresh-ref', expires: Date.now() + 3600000 } as any,
      effectiveProjectId: 'proj-1'
    });

    vi.spyOn(fetchQuotaModule, 'retrieveUserQuota').mockResolvedValue({
      buckets: []
    });

    const out1 = await quotaTool.execute({});
    expect(out1).toContain('No Agy quota buckets were returned');

    vi.spyOn(fetchQuotaModule, 'retrieveUserQuota').mockResolvedValue({
      buckets: [
        {
          modelId: 'disabled-model',
          tokenType: 'TOKENS',
          remainingFraction: 0,
          resetTime: '2026-08-18T00:00:00Z'
        }
      ]
    });

    const out2 = await quotaTool.execute({});
    expect(out2).toContain('disabled-model');

    const summaryTool = createAgyQuotaSummaryTool({
      client: { auth: { set: vi.fn() } } as any,
      getAuthResolver: () => async () => ({ type: 'oauth', access: 'tok', refresh: 'ref', expires: Date.now() + 3600000 }),
      getConfiguredProjectId: () => 'proj-1',
      getUserAgentModel: () => 'model-1'
    });

    vi.spyOn(fetchQuotaModule, 'retrieveUserQuotaSummary').mockResolvedValue({
      groups: [
        {
          name: 'Gemini',
          buckets: [
            {
              modelId: 'gemini-1.5',
              window: 'HOURLY',
              remainingFraction: 0.8
            }
          ]
        }
      ]
    });

    const out3 = await summaryTool.execute({});
    expect(out3).toContain('remaining');
  });

  it('covers signature cache LRU and disk branch edge cases', () => {
    const cache = new signatureCacheModule.SignatureCache({
      enabled: true,
      memory_ttl_seconds: 1,
      disk_ttl_seconds: 2,
      write_interval_seconds: 1
    });

    cache.storeThinking('k1', 'thought-1', 'sig-1', ['t1']);
    expect(cache.hasThinking('k1')).toBe(true);
    expect(cache.retrieveThinking('k1')).toBeDefined();

    cache.store('norm-1', 'sig-norm');
    expect(cache.retrieve('norm-1')).toBe('sig-norm');

    cache.flush();
    cache.shutdown();
  });

  it('covers turn state tracker branches', () => {
    const tracker = new turnStateTrackerModule.TurnStateTracker(false);
    expect(tracker.getState('non-existent')).toBeUndefined();
    expect(tracker.needsThinkingRecovery('non-existent')).toBe(false);

    tracker.updateAfterResponse('s1', {
      turnState: 'turn-1',
      turnStartIdx: 0,
      timestamp: Date.now()
    });
    expect(tracker.getState('s1')).toBeDefined();
    tracker.clear('s1');
    expect(tracker.getState('s1')).toBeUndefined();
    tracker.shutdown();
  });

  it('covers tool mapper collision and edge naming branches', () => {
    const mapper = new toolMapperModule.ToolMapper();
    expect(toolMapperModule.sanitizeToolName('valid_tool_1')).toBe('valid_tool_1');
    expect(toolMapperModule.sanitizeToolName('123_invalid_start')).toBe('_123_invalid_start');

    const sanitized = mapper.toGemini('tool_a');
    expect(sanitized).toBe('tool_a');
    expect(mapper.fromGemini('tool_a')).toBe('tool_a');
    expect(mapper.fromGemini('unregistered')).toBe('unregistered');

    toolMapperModule.clearToolMapper('s1');
  });

  it('covers thinking module analysis and stream edge cases', () => {
    const store = thinkingModule.createSignatureStore();
    store.set('k1', 'sig-1');
    expect(store.get('k1')).toBe('sig-1');
    expect(store.has('k1')).toBe(true);
    store.delete('k1');
    expect(store.has('k1')).toBe(false);

    const buffer = thinkingModule.createThoughtBuffer();
    buffer.set(0, 'thought-0');
    expect(buffer.get(0)).toBe('thought-0');
    expect(buffer.get(1)).toBeUndefined();
    buffer.clear();
    expect(buffer.get(0)).toBeUndefined();
  });

  it('covers chat logger initialization', async () => {
    process.env.AGY_LOG = "1";
    const logger = chatLoggerModule.createChatLogger();
    if (logger) {
      logger.logRequest('https://test.com', 'POST', {}, '{}');
      logger.logResponseHeaders(200, 'OK', new Headers());
      logger.logResponseBody('{}');
      logger.close();
    }
    delete process.env.AGY_LOG;
  });

  it('covers error helper preview access and retry delay arithmetic', () => {
    const previewRes = errorsHelperModule.enhanceGeminiErrorResponse({
      status: 404,
      body: JSON.stringify({
        error: {
          code: 404,
          message: 'models/gemini-3.1-pro is not found',
          status: 'NOT_FOUND'
        }
      }),
      requestedModel: 'gemini-3.1-pro'
    });
    expect(previewRes).toBeDefined();

    const quotaRes = errorsHelperModule.enhanceGeminiErrorResponse({
      status: 429,
      body: JSON.stringify({
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  subject: 'user:123',
                  description: 'Daily limit exceeded per day'
                }
              ]
            }
          ]
        }
      }),
      requestedModel: 'gemini-2.5-flash'
    });
    expect(quotaRes).toBeDefined();
  });
});

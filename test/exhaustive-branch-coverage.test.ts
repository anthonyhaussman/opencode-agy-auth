import { describe, expect, it, vi } from 'vitest';
import { normalizeThinkingConfig } from '../src/sdk/request-helpers/thinking.js';
import { parseGeminiApiBody, extractUsageMetadata } from '../src/sdk/request-helpers/parsing.js';
import { enhanceGeminiErrorResponse } from '../src/sdk/request-helpers/errors.js';
import { supportsOsc8Hyperlinks, formatHyperlink, stripOsc8 } from '../src/sdk/terminal-hyperlink.js';
import { getAgyCliVersion, buildAgyCliUserAgent } from '../src/sdk/user-agent.js';
import { toRequestUrlString, isGenerativeLanguageRequest, parseGenerativeLanguageRequest, isRecord, readString, pickString, injectResponseIdFromTrace } from '../src/sdk/request/shared.js';
import { normalizeThinking } from '../src/sdk/request/prepare.js';
import { CooldownStore, loadCooldowns, saveCooldowns } from '../src/sdk/retry/cooldown-store.js';
import { normalizeProjectId } from '../src/plugin/project/utils.js';
import { ProjectIdRequiredError, ProjectAccessDeniedError, AccountValidationRequiredError } from '../src/plugin/project/types.js';
import { maybeShowAgyCapacityToast, maybeShowAgyTestToast } from '../src/plugin/notify.js';
import { resolveConfiguredProjectId } from '../src/plugin/provider.js';
import { isOAuthAuth } from '../src/plugin/auth.js';
import { transformSseEvent } from '../src/sdk/request/thinking.js';
import { ToolMapper, sanitizeToolName } from '../src/sdk/request/tool-mapper.js';

describe('Exhaustive Branch Coverage Suite', () => {
  it('covers terminal hyperlink and user agent branch variations', () => {
    const originalEnv = { ...process.env };
    const originalStdout = process.stdout.isTTY;

    try {
      (process.stdout as any).isTTY = true;
      process.env.TERM_PROGRAM = 'iterm.app';
      expect(supportsOsc8Hyperlinks()).toBe(true);

      process.env.OPENCODE_HEADLESS = '1';
      expect(supportsOsc8Hyperlinks()).toBe(false);
      delete process.env.OPENCODE_HEADLESS;

      delete process.env.TERM_PROGRAM;
      process.env.KITTY_WINDOW_ID = '123';
      expect(supportsOsc8Hyperlinks()).toBe(true);
      delete process.env.KITTY_WINDOW_ID;

      process.env.VTE_VERSION = '5001';
      expect(supportsOsc8Hyperlinks()).toBe(true);
      delete process.env.VTE_VERSION;

      process.env.COLORTERM = '24bit';
      process.env.TERM = 'xterm-256color';
      expect(supportsOsc8Hyperlinks()).toBe(true);

      (process.stdout as any).isTTY = false;
      expect(supportsOsc8Hyperlinks()).toBe(false);

      expect(stripOsc8('\x1b]8;;https://example.com\x07Link\x1b]8;;\x07')).toBe('Link');
    } finally {
      process.env = originalEnv;
      (process.stdout as any).isTTY = originalStdout;
    }

    try {
      process.env.OPENCODE_AGY_CLI_VERSION = '9.9.9';
      expect(getAgyCliVersion()).toBe('9.9.9');
      delete process.env.OPENCODE_AGY_CLI_VERSION;
      expect(getAgyCliVersion()).toBeTruthy();
    } finally {
      process.env = originalEnv;
    }

    const ua = buildAgyCliUserAgent('gemini-2.5-pro');
    expect(ua).toContain('antigravity/cli/');
  });

  it('covers parsing helpers branches', () => {
    const valid = parseGeminiApiBody('{"candidates": []}');
    expect(valid).toEqual({ candidates: [] });
    expect(parseGeminiApiBody('not-json')).toBeNull();
    expect(parseGeminiApiBody('123')).toBeNull();

    expect(extractUsageMetadata({} as any)).toBeNull();
    expect(extractUsageMetadata({ response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } } } as any)).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: undefined,
      cachedContentTokenCount: undefined
    });
  });

  it('covers thinking config normalization branches', () => {
    expect(normalizeThinkingConfig(undefined)).toBeUndefined();
    expect(normalizeThinkingConfig(null as any)).toBeUndefined();
    expect(normalizeThinkingConfig({ thinkingLevel: 'HIGH' })).toEqual({ thinkingBudget: 2048, includeThoughts: true });
    expect(normalizeThinkingConfig({ thinkingLevel: 'MEDIUM' })).toEqual({ thinkingBudget: 1024, includeThoughts: true });
    expect(normalizeThinkingConfig({ thinkingLevel: 'LOW' })).toEqual({ thinkingBudget: 512, includeThoughts: true });
    expect(normalizeThinkingConfig({ thinkingLevel: 'MINIMAL' })).toEqual({ thinkingBudget: 0, includeThoughts: false });
    expect(normalizeThinkingConfig({ thinkingBudget: 4096 })).toEqual({ thinkingBudget: 4096, includeThoughts: true });
    expect(normalizeThinkingConfig({ thinkingBudget: -1 })).toEqual({ thinkingBudget: -1, includeThoughts: false });
    expect(normalizeThinkingConfig({ thinking_budget: 1000 } as any)).toEqual({ thinkingBudget: 1000, includeThoughts: true });

    expect(normalizeThinkingConfig(true as any)).toBeUndefined();
    expect(normalizeThinkingConfig(false as any)).toBeUndefined();
    expect(normalizeThinkingConfig({ budgetTokens: 100 } as any)).toBeUndefined();
  });

  it('covers request error parsing branches', () => {
    const errorEnhancement = enhanceGeminiErrorResponse({
      error: {
        code: 429,
        message: 'Rate limit exceeded Please retry in 500ms',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            domain: 'cloudcode-pa.googleapis.com',
            reason: 'RATE_LIMIT_EXCEEDED'
          }
        ]
      }
    }, 429);

    expect(errorEnhancement?.retryAfterMs).toBe(500);
  });

  it('covers shared request helpers and model classification', () => {
    expect(toRequestUrlString('https://example.com')).toBe('https://example.com');
    expect(toRequestUrlString(new URL('https://example.com/api'))).toBe('https://example.com/api');
    expect(toRequestUrlString({ url: 'https://example.com/req' } as any)).toBe('https://example.com/req');

    expect(isGenerativeLanguageRequest('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent')).toBe(true);
    expect(isGenerativeLanguageRequest('https://example.com/models/x')).toBe(false);

    const parsed = parseGenerativeLanguageRequest('https://daily-cloudcode-pa.googleapis.com/v1internal/models/gemini-3.1-pro-high:generateContent');
    expect(parsed?.requestedModel).toBe('gemini-3.1-pro-high');
    expect(parsed?.effectiveModel).toBe('gemini-pro-agent');

    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(readString('  hello  ')).toBe('hello');
    expect(readString('   ')).toBeUndefined();
    expect(pickString('', undefined, 'chosen', 'other')).toBe('chosen');

    const traceBody = injectResponseIdFromTrace({ traceId: 'trace-123', response: {} });
    expect((traceBody.response as any).responseId).toBe('trace-123');
  });

  it('covers CooldownStore branches', () => {
    const store = new CooldownStore();
    const map = new Map<string, number>();
    store.bind(map);
    store.markDirty();
    expect(store.flush()).toBe(true);
    store.shutdown();
  });

  it('covers ToolMapper branches', () => {
    expect(sanitizeToolName('valid_name-1')).toBe('valid_name_1');
    expect(sanitizeToolName('bad.tool.name$!')).toMatch(/^[a-zA-Z0-9_]+$/);

    const mapper = new ToolMapper();
    const geminiName = mapper.register('my.custom:tool');
    expect(mapper.toGemini('my.custom:tool')).toBe(geminiName);
    expect(mapper.fromGemini(geminiName)).toBe('my.custom:tool');
    expect(mapper.fromGemini('unregistered')).toBe('unregistered');
  });

  it('covers transformSseEvent branches', () => {
    const event = transformSseEvent('event: message\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}}\n\n');
    expect(event).toContain('hello');

    const doneEvent = transformSseEvent('data: [DONE]\n\n');
    expect(doneEvent).toContain('[DONE]');

    const emptyEvent = transformSseEvent('');
    expect(emptyEvent).toBe('');
  });

  it('covers Project error types and normalizeProjectId', () => {
    const err = new ProjectIdRequiredError();
    expect(err.message).toContain('Google Gemini/Agy requires a Google Cloud project');
    expect(err.name).toBe('Error');

    const denied = new ProjectAccessDeniedError('p1', 'Backend denied');
    expect(denied.message).toContain('Backend denied');

    const validation = new AccountValidationRequiredError('Validation required', 'https://validate.me');
    expect(validation.message).toContain('Validation required');

    expect(normalizeProjectId(null)).toBeUndefined();
    expect(normalizeProjectId(undefined)).toBeUndefined();
    expect(normalizeProjectId('p-123')).toBe('p-123');
    expect(normalizeProjectId({ id: 'p-obj' })).toBe('p-obj');
    expect(normalizeProjectId({ name: 'wrong' } as any)).toBeUndefined();
  });

  it('covers notify toasts branches', () => {
    const mockClient = { tui: { showToast: vi.fn() } };
    maybeShowAgyCapacityToast(mockClient as any, { status: 429 } as any, 'proj-1', 'gemini-2.5-pro');
    maybeShowAgyTestToast(mockClient as any, { OPENCODE_AGY_TEST_TOAST: '1' } as any);
    maybeShowAgyTestToast(mockClient as any, {} as any);
  });

  it('covers provider config resolution branches', () => {
    expect(resolveConfiguredProjectId({ env: { OPENCODE_AGY_PROJECT_ID: 'env-p' } } as any)).toBe('env-p');
    expect(resolveConfiguredProjectId({ env: {}, provider: { options: { projectId: 'prov-p' } } } as any)).toBe('prov-p');
    expect(resolveConfiguredProjectId({ env: {}, configProjectId: 'cfg-p' } as any)).toBe('cfg-p');
    expect(resolveConfiguredProjectId({ env: {}, config: { provider: { 'google-agy': { options: { projectId: 'sub-p' } } } } } as any)).toBe('sub-p');
    expect(resolveConfiguredProjectId({ env: { GOOGLE_CLOUD_PROJECT: 'gcp-p' } } as any)).toBe('gcp-p');
    expect(resolveConfiguredProjectId({ env: {} } as any)).toBeUndefined();
  });

  it('covers isOAuthAuth branches', () => {
    expect(isOAuthAuth({ type: 'api-key' } as any)).toBe(false);
    expect(isOAuthAuth({ type: 'oauth', access: 'tok', refresh: 'ref', expires: 123 } as any)).toBe(true);
  });
});

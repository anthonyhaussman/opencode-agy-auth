import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';
import * as fetchModule from '../src/fetch.js';
import * as fetchProjectModule from '../src/sdk/fetch_project.js';
import * as fetchQuotaModule from '../src/sdk/fetch_quota.js';
import * as errorsHelper from '../src/sdk/request-helpers/errors.js';

describe('Coverage Booster - 95%+ Target', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('tests plugin.ts variants, modalities, and capabilities for gpt, claude, and gemini models', async () => {
    const client = {
      config: { get: vi.fn().mockResolvedValue({ data: {} }) },
      auth: { set: vi.fn() },
      tui: { showToast: vi.fn() }
    };
    const plugin = await AgyCLIOAuthPlugin(client as any);

    const configInput = {
      provider: {
        'google-agy': {
          models: {
            'custom-model-extra': {
              name: 'Custom Extra',
              description: 'Desc',
              toolCall: false,
              reasoning: false,
              attachment: false,
              cost: { input: 1, output: 2, cache: { read: 0.5, write: 1.5 } }
            }
          }
        }
      }
    };
    await plugin.config(configInput as any);

    const models = (configInput.provider as any)['google-agy'].models;
    expect(models['gpt-oss-120b-medium']).toBeDefined();
    expect(models['gpt-oss-120b-medium'].modalities.input).toEqual(['text']);
    expect(models['gpt-oss-120b-medium'].capabilities.input.audio).toBe(false);

    expect(models['claude-sonnet-4-6']).toBeDefined();
    expect(models['claude-sonnet-4-6'].capabilities.input.image).toBe(true);
    expect(models['claude-sonnet-4-6'].capabilities.input.audio).toBe(false);

    expect(models['gemini-3.6-flash']).toBeDefined();
    expect(models['gemini-3.6-flash'].variants.minimal).toBeDefined();
    expect(models['gemini-3.6-flash'].variants.minimal.thinkingConfig.thinkingBudget).toBe(1000);
    expect(models['gemini-3.6-flash'].variants.medium).toBeDefined();

    expect(models['gemini-3.1-pro']).toBeDefined();
    expect(models['gemini-3.1-pro'].variants.medium).toBeUndefined();
  });

  it('tests plugin.ts auth methods and loader authorization header branching', async () => {
    const client = {
      config: { get: vi.fn().mockResolvedValue({ data: {} }) },
      auth: { set: vi.fn() },
      tui: { showToast: vi.fn() }
    };
    const plugin = await AgyCLIOAuthPlugin(client as any);
    const authRecord = {
      type: 'oauth' as const,
      refresh: 'ref|proj|man',
      access: 'valid-access-123',
      expires: Date.now() + 3600000
    };

    const loaderObj = await (plugin.auth as any).loader(async () => authRecord, { id: 'google-agy' });

    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const respWithAuth = await loaderObj.fetch('https://cloudcode-pa.googleapis.com/v1internal:test', {
      headers: { Authorization: 'Bearer [REDACTED:Bearer token]' }
    });
    expect(respWithAuth.status).toBe(200);

    const respWithoutAuth = await loaderObj.fetch('https://cloudcode-pa.googleapis.com/v1internal:test', {
      headers: { 'Content-Type': 'application/json' }
    });
    expect(respWithoutAuth.status).toBe(200);
  });

  it('tests sdk error helpers and retry parsing edge cases', () => {
    const previewError = errorsHelper.rewriteGeminiPreviewAccessError(
      { error: { message: 'Not found' } },
      404,
      'gemini-3-flash'
    );
    expect(previewError).not.toBeNull();
    expect(previewError?.error?.message).toContain('Request preview access');

    const non404Error = errorsHelper.rewriteGeminiPreviewAccessError(
      { error: { message: 'Server error' } },
      500,
      'gemini-3-flash'
    );
    expect(non404Error).toBeNull();

    const nonGemini3Error = errorsHelper.rewriteGeminiPreviewAccessError(
      { error: { message: 'Not found' } },
      404,
      'gemini-1.5-flash'
    );
    expect(nonGemini3Error).toBeNull();
  });

  it('tests fetch_quota.ts failure fallback branches', async () => {
    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(new Response('Internal Error', { status: 500 }));
    const quota = await fetchQuotaModule.retrieveUserQuota('acc-token', 'proj-123', 'gemini-3.7-flash');
    expect(quota).toBeNull();

    const summary = await fetchQuotaModule.retrieveUserQuotaSummary('acc-token', 'proj-123', 'gemini-3.7-flash');
    expect(summary).toBeNull();
  });

  it('tests fetch_project.ts loadManagedProject and readResponseTextIfNeeded error handling', async () => {
    vi.spyOn(fetchModule, 'agyFetch').mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const proj = await fetchProjectModule.loadManagedProject('acc-token', 'gemini-3.7-flash');
    expect(proj).toBeNull();
  });
});

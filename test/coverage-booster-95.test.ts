import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fetchModule from '../src/fetch.js';
import * as fetchProjectModule from '../src/sdk/fetch_project.js';
import * as fetchQuotaModule from '../src/sdk/fetch_quota.js';
import * as errorsHelper from '../src/sdk/request-helpers/errors.js';

describe('Coverage Booster - 95%+ Target', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

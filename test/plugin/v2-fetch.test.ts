import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createV2FetchInterceptor,
  type V2RuntimeCatalog,
} from '../../src/plugin/v2-fetch';
import { setStoredAuthOverrideForTesting } from '../../src/plugin/v2-storage';
import { getModelEnum } from '../../src/sdk/request/prepare';

const VALID_OAUTH = {
  type: 'oauth' as const,
  access: 'test-access-token',
  refresh: 'test-refresh|proj-123|managed-proj-123',
  expires: Date.now() + 3_600_000,
};

function createJsonOkResponse() {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('createV2FetchInterceptor runtime catalog and variant resolution', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setStoredAuthOverrideForTesting(undefined);
  });

  it('resolves dynamic tierMapping and enums when x-agy-tier header is provided', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => createJsonOkResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const catalog: V2RuntimeCatalog = {
      tierMapping: {
        'gemini-5-pro': {
          low: 'gemini-5-pro-low',
          high: 'gemini-5-pro-high',
        },
      },
      enums: {
        'gemini-5-pro-low': 'MODEL_PLACEHOLDER_M776',
        'gemini-5-pro-high': 'MODEL_PLACEHOLDER_M777',
      },
    };

    const interceptor = createV2FetchInterceptor(
      () => VALID_OAUTH,
      async () => catalog,
    );

    await interceptor(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-agy-tier': 'high',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        }),
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toContain('/v1internal:generateContent');

    const sentBody = JSON.parse(String(calledInit.body));
    expect(sentBody.model).toBe('gemini-5-pro-high');
    expect(sentBody.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M777');
    expect((calledInit.headers as Headers).get('User-Agent')).toContain('antigravity/cli/');
  });

  it('uses catalog.variant when x-agy-tier header and @ suffix are absent (string URL and Request)', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => createJsonOkResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const catalog: V2RuntimeCatalog = {
      tierMapping: {
        'gemini-5-pro': {
          low: 'gemini-5-pro-low',
          medium: 'gemini-5-pro-medium',
          high: 'gemini-5-pro-high',
        },
      },
      enums: {
        'gemini-5-pro-medium': 'MODEL_PLACEHOLDER_M775',
        'gemini-5-pro-high': 'MODEL_PLACEHOLDER_M777',
      },
      variant: 'high',
    };

    const interceptor = createV2FetchInterceptor(
      () => VALID_OAUTH,
      () => catalog,
    );

    await interceptor(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'string input' }] }],
        }),
      },
    );

    const reqInput = new Request(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'request input' }] }],
        }),
      },
    );
    await interceptor(reqInput);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [, calledInit] of fetchSpy.mock.calls) {
      const sentBody = JSON.parse(String(calledInit.body));
      expect(sentBody.model).toBe('gemini-5-pro-high');
      expect(sentBody.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M777');
    }
  });

  it('enforces tier precedence: x-agy-tier header > @tier suffix > catalog.variant > default tier', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => createJsonOkResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const baseCatalog: V2RuntimeCatalog = {
      tierMapping: {
        'gemini-5-pro': {
          low: 'gemini-5-pro-low',
          medium: 'gemini-5-pro-medium',
          high: 'gemini-5-pro-high',
        },
        'gemini-5-ultra': {
          low: 'gemini-5-ultra-low',
          high: 'gemini-5-ultra-high',
        },
      },
      enums: {
        'gemini-5-pro-low': 'ENUM_LOW',
        'gemini-5-pro-medium': 'ENUM_MED',
        'gemini-5-pro-high': 'ENUM_HIGH',
        'gemini-5-ultra-high': 'ENUM_ULTRA_HIGH',
      },
      variant: 'high',
    };

    const interceptorWithVariant = createV2FetchInterceptor(
      () => VALID_OAUTH,
      () => baseCatalog,
    );

    // 1. Explicit x-agy-tier header in init beats catalog.variant ('high') and @medium suffix
    await interceptorWithVariant(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro@medium:generateContent',
      {
        method: 'POST',
        headers: { 'x-agy-tier': 'low' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '1' }] }] }),
      },
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1].body)).model).toBe('gemini-5-pro-low');
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1].body)).request.labels.model_enum).toBe('ENUM_LOW');

    // 2. Explicit x-agy-tier header on Request object beats catalog.variant ('high') when init is omitted
    const reqWithHeader = new Request(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent',
      {
        method: 'POST',
        headers: { 'x-agy-tier': 'low' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '2' }] }] }),
      },
    );
    await interceptorWithVariant(reqWithHeader);
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1].body)).model).toBe('gemini-5-pro-low');

    // 3. @tier suffix beats catalog.variant ('high') when no x-agy-tier header is present
    await interceptorWithVariant(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro@low:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '3' }] }] }),
      },
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[2][1].body)).model).toBe('gemini-5-pro-low');

    // 4. Default tier fallback (medium ?? high) when no header, no suffix, and no catalog.variant
    const interceptorNoVariant = createV2FetchInterceptor(
      () => VALID_OAUTH,
      () => ({
        tierMapping: baseCatalog.tierMapping,
        enums: baseCatalog.enums,
      }),
    );

    await interceptorNoVariant(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '4' }] }] }),
      },
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[3][1].body)).model).toBe('gemini-5-pro-medium');
    expect(JSON.parse(String(fetchSpy.mock.calls[3][1].body)).request.labels.model_enum).toBe('ENUM_MED');

    await interceptorNoVariant(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-ultra:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '5' }] }] }),
      },
    );
    expect(JSON.parse(String(fetchSpy.mock.calls[4][1].body)).model).toBe('gemini-5-ultra-high');
    expect(JSON.parse(String(fetchSpy.mock.calls[4][1].body)).request.labels.model_enum).toBe('ENUM_ULTRA_HIGH');
  });

  it('falls back to loadStoredAuthFromJson when getAuthSnapshot returns undefined', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => createJsonOkResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    setStoredAuthOverrideForTesting(VALID_OAUTH);

    const interceptor = createV2FetchInterceptor(
      async () => undefined,
      async () => ({
        tierMapping: { 'gemini-5-pro': { high: 'gemini-5-pro-high' } },
        enums: { 'gemini-5-pro-high': 'MODEL_PLACEHOLDER_M777' },
        variant: 'high',
      }),
    );

    await interceptor(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'fallback auth' }] }] }),
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toContain('cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect((calledInit.headers as Headers).get('Authorization')).toBe(`Bearer ${VALID_OAUTH.access}`);
    const sentBody = JSON.parse(String(calledInit.body));
    expect(sentBody.model).toBe('gemini-5-pro-high');
    expect(sentBody.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M777');
  });

  it('falls back to static TIER_MAPPING and models.json getModelEnum when getRuntimeCatalog throws or returns undefined', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => createJsonOkResponse());
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const throwingCatalogFn = vi.fn(async () => {
      throw new Error('discovery failure');
    });
    const throwingInterceptor = createV2FetchInterceptor(
      () => VALID_OAUTH,
      throwingCatalogFn,
    );

    await throwingInterceptor(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      {
        method: 'POST',
        headers: { 'x-agy-tier': 'high' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'throwing catalog' }] }] }),
      },
    );

    const undefinedCatalogFn = vi.fn(() => undefined);
    const undefinedInterceptor = createV2FetchInterceptor(
      () => VALID_OAUTH,
      undefinedCatalogFn,
    );

    await undefinedInterceptor(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'undefined catalog' }] }] }),
      },
    );

    expect(throwingCatalogFn).toHaveBeenCalledTimes(1);
    expect(undefinedCatalogFn).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(firstBody.model).toBe('gemini-3.8-flash-high');
    expect(firstBody.request.labels.model_enum).toBe(getModelEnum('gemini-3.8-flash-high'));

    const secondBody = JSON.parse(String(fetchSpy.mock.calls[1][1].body));
    expect(secondBody.model).toBe('gemini-3.8-flash-medium');
    expect(secondBody.request.labels.model_enum).toBe(getModelEnum('gemini-3.8-flash-medium'));
  });

  it('refreshes expired access token and falls back project context while applying runtime catalog', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: RequestInfo) => {
      const str = String(url);
      if (str.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'refreshed-access-token', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (str.includes('loadCodeAssist')) {
        return new Response('Forbidden', { status: 403 });
      }
      return createJsonOkResponse();
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const expiredAuth = {
      type: 'oauth' as const,
      access: 'expired-access-token',
      refresh: 'refresh-without-managed',
      expires: Date.now() - 10_000,
    };

    const interceptor = createV2FetchInterceptor(
      () => expiredAuth,
      () => ({
        tierMapping: { 'gemini-5-pro': { high: 'gemini-5-pro-high' } },
        enums: { 'gemini-5-pro-high': 'MODEL_PLACEHOLDER_M777' },
        variant: 'high',
      }),
    );

    const response = await interceptor(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'refresh test' }] }] }),
      },
    );

    expect(response.status).toBe(200);
    const generateCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('v1internal:generateContent'));
    expect(generateCall).toBeDefined();
    const [, init] = generateCall!;
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer refreshed-access-token');
    const body = JSON.parse(String(init.body));
    expect(body.project).toBe('antigravity');
    expect(body.model).toBe('gemini-5-pro-high');
    expect(body.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M777');
  });
});

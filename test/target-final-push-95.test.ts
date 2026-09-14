import { describe, it, expect, vi } from 'vitest';
import { AgyCLIOAuthPlugin } from '../src/plugin.js';
import { setOpenBrowserLauncherForTesting } from '../src/plugin/oauth-authorize.js';
import { createThoughtBuffer, deduplicateThinkingText } from '../src/sdk/request/thinking.js';
import { onboardManagedProject } from '../src/sdk/fetch_project.js';
import * as chatLoggerModule from '../src/sdk/chat-logger.js';
import * as retryModule from '../src/sdk/retry/index.js';

describe('Final Coverage Push', () => {
  it('covers all plugin modalities and capabilities combinations', async () => {
    const plugin = await AgyCLIOAuthPlugin({
      client: {
        tui: { showToast: vi.fn() },
        config: { get: vi.fn().mockResolvedValue({ data: { provider: {} } }) },
        auth: { set: vi.fn() }
      }
    } as any);

    const config: any = { provider: {} };
    await plugin.config(config);
    const models = config.provider['google-agy'].models;

    // Check claude vs gpt vs gemini modalities
    expect(models['claude-sonnet-4-6'].capabilities.input.audio).toBe(false);
    expect(models['gpt-oss-120b-medium'].capabilities.input.video).toBe(false);
    expect(models['gemini-3.7-flash'].capabilities.input.audio).toBe(true);
    expect(models['gemini-3.7-flash'].capabilities.input.video).toBe(true);
  });

  it('covers internal request with configured project id background traffic trigger', async () => {
    const plugin = await AgyCLIOAuthPlugin({
      client: {
        tui: { showToast: vi.fn() },
        config: { get: vi.fn().mockResolvedValue({ data: { provider: { 'google-agy': { options: { projectId: 'my-bg-proj' } } } } }) },
        auth: { set: vi.fn() }
      }
    } as any);

    const auth = { type: 'oauth', access: 'valid-acc', refresh: 'ref-t', expires: Date.now() + 100000 };
    const loaderResult = await plugin.auth.loader(async () => auth, { id: 'google-agy', options: { projectId: 'my-bg-proj' } } as any);

    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = mockFetch;

    const res = await loaderResult.fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
      method: 'POST',
      body: JSON.stringify({})
    });
    expect(res.status).toBe(200);
  });

  it('covers loader fetch with chatLogger enabled', async () => {
    const mockLogger = {
      logRequest: vi.fn(),
      logResponseHeaders: vi.fn(),
      logResponseBody: vi.fn(),
      createLoggingTransformStream: vi.fn(() => new TransformStream()),
      close: vi.fn()
    };
    vi.spyOn(chatLoggerModule, 'createChatLogger').mockReturnValue(mockLogger as any);

    const plugin = await AgyCLIOAuthPlugin({
      client: {
        tui: { showToast: vi.fn() },
        config: { get: vi.fn().mockResolvedValue({ data: { provider: { 'google-agy': { options: { projectId: 'p-1' } } } } }) },
        auth: { set: vi.fn() }
      }
    } as any);

    const auth = { type: 'oauth', access: 'valid-acc', refresh: 'ref-t|proj|managed-proj', expires: Date.now() + 100000 };
    const loaderResult = await plugin.auth.loader(async () => auth, { id: 'google-agy', options: { projectId: 'p-1' } } as any);

    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }), { status: 200 }));
    globalThis.fetch = mockFetch;

    const res = await loaderResult.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent', {
      method: 'POST',
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] })
    });
    expect(res.status).toBe(200);
    expect(mockLogger.logRequest).toHaveBeenCalled();
  });

  it('covers deduplicateThinkingText empty content filter', () => {
    const resp = {
      content: [
        { type: 'thinking', thinking: 'initial' }
      ]
    };
    const sent = createThoughtBuffer();
    sent.set(0, 'initial');
    const hashes = new Set<string>();

    // Repeating exact text when filtered returns empty content array
    const deduped: any = deduplicateThinkingText(resp, sent, hashes);
    expect(deduped.content).toHaveLength(0);
  });

  it('covers thinking recovery and thought buffer methods', () => {
    const buffer = createThoughtBuffer();
    buffer.set(0, 'thought-part-1');
    expect(buffer.get(0)).toBe('thought-part-1');
    expect(buffer.get(1)).toBeUndefined();
    buffer.clear();
    expect(buffer.get(0)).toBeUndefined();
  });

  it('covers onboardManagedProject with undefined and non-empty project ids', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: { id: 'auto-proj' } } }), { status: 200 }));
    globalThis.fetch = mockFetch;

    const res = await onboardManagedProject('token', 'free-tier');
    expect(res).toBe('auto-proj');
  });

  it('covers createOAuthAuthorizeMethod options callbacks', async () => {
    const plugin = await AgyCLIOAuthPlugin({
      client: {
        tui: { showToast: vi.fn() },
        config: { get: vi.fn().mockResolvedValue({ data: { provider: {} } }) },
        auth: { set: vi.fn() }
      }
    } as any);

    const authMethod = (plugin.auth as any).methods.find((m: any) => m.type === 'oauth');
    const authResult = await authMethod.authorize();
    expect(authResult.url).toBeDefined();
    expect(typeof authResult.callback).toBe('function');

    // Exercise non-headless browser open branch
    const launcherMock = vi.fn();
    setOpenBrowserLauncherForTesting(launcherMock);
    const origEnv = process.env;
    process.env = { ...origEnv };
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_TTY;
    delete process.env.OPENCODE_HEADLESS;
    try {
      const nonHeadlessMethod = (plugin.auth as any).methods.find((m: any) => m.type === 'oauth');
      const res = await nonHeadlessMethod.authorize();
      expect(res.url).toBeDefined();
      expect(launcherMock).toHaveBeenCalled();
    } finally {
      process.env = origEnv;
      setOpenBrowserLauncherForTesting(null);
    }
  });

  it('covers plugin provider models hook error and null auth', async () => {
    const plugin = await AgyCLIOAuthPlugin({
      client: {
        tui: { showToast: vi.fn() },
        config: { get: vi.fn().mockResolvedValue({ data: { provider: {} } }) },
        auth: { set: vi.fn() }
      }
    } as any);

    let shouldThrow = false;
    // Call loader to register resolver
    await plugin.auth.loader(async () => {
      if (shouldThrow) {
        throw new Error('Resolver explosion');
      }
      return { type: 'oauth', access: 'token', refresh: 'ref', expires: Date.now() + 100000 };
    }, { models: {} } as any);

    // Call provider.models with failing resolver
    shouldThrow = true;
    const modelsResult = await (plugin as any).provider.models({ models: {} }, {});
    expect(modelsResult['login-required']).toBeDefined();
  });
});

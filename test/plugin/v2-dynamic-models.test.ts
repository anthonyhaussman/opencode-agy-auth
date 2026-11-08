import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGY_PROVIDER_ID } from '../../src/constants';
import * as dynamicModelsModule from '../../src/plugin/dynamic-models';
import type { AccountModelInventory } from '../../src/plugin/dynamic-models';
import * as pricingModule from '../../src/plugin/pricing';
import { STATIC_MODELS_SIMPLE } from '../../src/plugin/tier';
import type { OpenCodeV2PluginContext } from '../../src/plugin/types';
import { setupOpenCodeV2, setStoredAuthOverrideForTesting } from '../../src/plugin/v2';
import * as oauthSdk from '../../src/sdk/oauth';

function makeInventory(connectionId: string): AccountModelInventory {
  return {
    connection: { type: 'credential', id: connectionId },
    models: {
      'gemini-4-argon': {
        name: 'Gemini 4 Argon',
        description: 'Gemini 4 Argon base model. Select tier at runtime.',
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        toolCall: true,
        reasoning: true,
        attachment: true,
        cost: { input: 1.25, output: 5.0, cache: { read: 0.3, write: 1.25 } },
      },
      'gemini-5-pro': {
        name: 'Gemini 5 Pro',
        description: 'Gemini 5 Pro base model. Select tier at runtime.',
        maxTokens: 2097152,
        maxOutputTokens: 131072,
        toolCall: true,
        reasoning: true,
        attachment: true,
        cost: { input: 2.5, output: 10.0 },
      },
      'gpt-oss-120b-medium': {
        name: 'GPT-OSS 120B (Medium)',
        description: 'GPT open-source 120B parameter medium tier model.',
        maxTokens: 131072,
        maxOutputTokens: 32768,
        toolCall: true,
        reasoning: true,
        attachment: false,
        cost: { input: 0.5, output: 1.5 },
      },
    },
    tierMapping: {
      'gemini-4-argon': {
        low: 'gemini-4-argon-low',
        medium: 'gemini-4-argon-medium',
        high: 'gemini-4-argon-high',
      },
      'gemini-5-pro': {
        minimal: 'gemini-5-pro-minimal',
        low: 'gemini-5-pro-low',
        medium: 'gemini-5-pro-medium',
        high: 'gemini-5-pro-high',
      },
    },
    enums: {
      'gemini-4-argon-low': 'MODEL_PLACEHOLDER_M419',
      'gemini-4-argon-medium': 'MODEL_PLACEHOLDER_M418',
      'gemini-4-argon-high': 'MODEL_PLACEHOLDER_M417',
      'gemini-5-pro-minimal': 'MODEL_GEMINI_5_PRO_MINIMAL',
      'gemini-5-pro-low': 'MODEL_GEMINI_5_PRO_LOW',
      'gemini-5-pro-medium': 'MODEL_GEMINI_5_PRO_MEDIUM',
      'gemini-5-pro-high': 'MODEL_GEMINI_5_PRO_HIGH',
      'gpt-oss-120b-medium': 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
    },
  };
}

describe('OpenCode v2 Dynamic Account Model Discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(pricingModule, 'applyPricingToSimpleModels').mockImplementation(async (m) => m);
  });

  afterEach(() => {
    setStoredAuthOverrideForTesting(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers all 5 static fallback models with variant headers, accurate family, capabilities, reasoning, and cost before discovery and when discovery fails', async () => {
    let providerTransform: ((editor: any) => Promise<void> | void) | undefined;
    let modelTransform: ((editor: any) => Promise<void> | void) | undefined;
    let catalogTransform: ((editor: any) => Promise<void> | void) | undefined;

    let resolveDiscovery: ((val: AccountModelInventory | undefined) => void) | undefined;
    vi.spyOn(dynamicModelsModule, 'loadAccountModels').mockImplementationOnce(
      () =>
        new Promise<AccountModelInventory | undefined>((resolve) => {
          resolveDiscovery = resolve;
        })
    );

    const providerReload = vi.fn().mockResolvedValue(undefined);
    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn((fn) => {
          providerTransform = fn;
        }),
        reload: providerReload,
      },
      model: {
        transform: vi.fn((fn) => {
          modelTransform = fn;
        }),
      },
      catalog: {
        transform: vi.fn((fn) => {
          catalogTransform = fn;
        }),
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'conn-1' }),
          resolve: vi.fn(),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);

    try {
      const expectedVariants = [
        { id: 'low', headers: { 'x-agy-tier': 'low' } },
        { id: 'medium', headers: { 'x-agy-tier': 'medium' } },
        { id: 'high', headers: { 'x-agy-tier': 'high' } },
      ];

      // 1. model.transform with editor.update
      const updatedModels: Record<string, any> = {};
      await modelTransform!({
        update: (providerId: string, modelId: string, fn: (m: any) => void) => {
          expect(providerId).toBe(AGY_PROVIDER_ID);
          const m: any = {};
          fn(m);
          updatedModels[modelId] = m;
        },
      });

      expect(Object.keys(updatedModels)).toEqual(Object.keys(STATIC_MODELS_SIMPLE));
      expect(updatedModels['gemini-3.8-flash'].family).toBe('gemini');
      expect(updatedModels['gemini-3.8-flash'].variants).toEqual(expectedVariants);
      expect(updatedModels['gemini-3.8-flash'].reasoning).toBe(true);
      expect(updatedModels['gemini-3.8-flash'].capabilities).toMatchObject({
        tools: true,
        input: ['text', 'image'],
        output: ['text'],
      });

      expect(updatedModels['gemini-4-argon'].family).toBe('gemini');
      expect(updatedModels['gemini-4-argon'].variants).toEqual(expectedVariants);

      expect(updatedModels['claude-opus-5-5'].family).toBe('claude');
      expect(updatedModels['claude-opus-5-5'].variants).toEqual(expectedVariants);
      expect(updatedModels['claude-opus-5-5'].capabilities.input).toEqual(['text', 'image']);

      expect(updatedModels['claude-sonnet-5-5'].family).toBe('claude');
      expect(updatedModels['claude-sonnet-5-5'].variants).toEqual(expectedVariants);

      expect(updatedModels['gpt-oss-120b-medium'].family).toBe('gpt');
      expect(updatedModels['gpt-oss-120b-medium'].variants).toBeUndefined();
      expect(updatedModels['gpt-oss-120b-medium'].reasoning).toBe(true);
      expect(updatedModels['gpt-oss-120b-medium'].capabilities).toMatchObject({
        tools: true,
        input: ['text'],
        output: ['text'],
      });

      // 2. model.transform with editor.set
      const setModels = new Map<string, any>();
      await modelTransform!({
        set: (key: string, val: any) => setModels.set(key, val),
      });
      expect(setModels.get(`${AGY_PROVIDER_ID}:claude-opus-5-5`)?.family).toBe('claude');
      expect(setModels.get(`${AGY_PROVIDER_ID}:claude-opus-5-5`)?.variants).toEqual(
        expectedVariants
      );
      expect(setModels.get(`${AGY_PROVIDER_ID}:gpt-oss-120b-medium`)?.family).toBe('gpt');
      expect(
        setModels.get(`${AGY_PROVIDER_ID}:gpt-oss-120b-medium`)?.capabilities.input
      ).toEqual(['text']);
      expect(setModels.get(`${AGY_PROVIDER_ID}:gpt-oss-120b-medium`)?.cost).toEqual({
        input: 0,
        output: 0,
      });

      // 3. provider.transform does not set sourceConnection
      const providerObj: any = {};
      await providerTransform!({
        update: (_id: string, fn: (p: any) => void) => fn(providerObj),
      });
      expect(providerObj.sourceConnection).toBeUndefined();

      // 4. catalog.transform with plain catalog object
      const plainCatalog: any = {};
      await catalogTransform!(plainCatalog);
      expect(
        plainCatalog.providers[AGY_PROVIDER_ID].models['gemini-4-argon'].variants
      ).toEqual(expectedVariants);
      expect(
        plainCatalog.providers[AGY_PROVIDER_ID].models['gpt-oss-120b-medium'].variants
      ).toBeUndefined();

      resolveDiscovery!(undefined);
    } finally {
      dispose?.();
    }
  });

  it('registers discovered models and dynamic variants across all model.transform and catalog.transform shapes and triggers reload', async () => {
    let modelTransform: ((editor: any) => Promise<void> | void) | undefined;
    let catalogTransform: ((editor: any) => Promise<void> | void) | undefined;

    const inventory = makeInventory('conn-1');
    vi.spyOn(dynamicModelsModule, 'loadAccountModels').mockResolvedValue(inventory);

    const providerReload = vi.fn().mockResolvedValue(undefined);
    const modelReload = vi.fn().mockResolvedValue(undefined);

    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn(),
        reload: providerReload,
      },
      model: {
        transform: vi.fn((fn) => {
          modelTransform = fn;
        }),
        reload: modelReload,
      },
      catalog: {
        transform: vi.fn((fn) => {
          catalogTransform = fn;
        }),
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'conn-1' }),
          resolve: vi.fn(),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);
    try {
      await vi.waitFor(() => {
        expect(providerReload).toHaveBeenCalledTimes(1);
      });

      const expected5ProVariants = [
        { id: 'minimal', headers: { 'x-agy-tier': 'minimal' } },
        { id: 'low', headers: { 'x-agy-tier': 'low' } },
        { id: 'medium', headers: { 'x-agy-tier': 'medium' } },
        { id: 'high', headers: { 'x-agy-tier': 'high' } },
      ];

      // 1. editor.update
      const updated: Record<string, any> = {};
      await modelTransform!({
        update: (_pid: string, mid: string, fn: (m: any) => void) => {
          const m: any = {};
          fn(m);
          updated[mid] = m;
        },
      });
      expect(Object.keys(updated)).toEqual([
        'gemini-4-argon',
        'gemini-5-pro',
        'gpt-oss-120b-medium',
      ]);
      expect(updated['gemini-5-pro'].variants).toEqual(expected5ProVariants);
      expect(updated['gemini-5-pro'].cost).toEqual({ input: 2.5, output: 10.0 });
      expect(updated['gpt-oss-120b-medium'].variants).toBeUndefined();
      expect(updated['gpt-oss-120b-medium'].capabilities.input).toEqual(['text']);

      // 2. editor.set
      const setMap = new Map<string, any>();
      await modelTransform!({
        set: (k: string, v: any) => setMap.set(k, v),
      });
      expect(Array.from(setMap.keys())).toEqual([
        `${AGY_PROVIDER_ID}:gemini-4-argon`,
        `${AGY_PROVIDER_ID}:gemini-5-pro`,
        `${AGY_PROVIDER_ID}:gpt-oss-120b-medium`,
      ]);
      expect(setMap.get(`${AGY_PROVIDER_ID}:gemini-5-pro`)?.variants).toEqual(
        expected5ProVariants
      );

      // 3. plain object editor
      const plainObj: Record<string, any> = {};
      await modelTransform!(plainObj);
      expect(Object.keys(plainObj)).toEqual([
        `${AGY_PROVIDER_ID}:gemini-4-argon`,
        `${AGY_PROVIDER_ID}:gemini-5-pro`,
        `${AGY_PROVIDER_ID}:gpt-oss-120b-medium`,
      ]);
      expect(plainObj[`${AGY_PROVIDER_ID}:gemini-5-pro`].variants).toEqual(expected5ProVariants);

      // 4. catalog.transform with editor.model.update
      const catModelUpdates: Record<string, any> = {};
      await catalogTransform!({
        provider: { update: vi.fn() },
        model: {
          update: (_pid: string, mid: string, fn: (m: any) => void) => {
            const m: any = {};
            fn(m);
            catModelUpdates[mid] = m;
          },
        },
      });
      expect(Object.keys(catModelUpdates)).toEqual([
        'gemini-4-argon',
        'gemini-5-pro',
        'gpt-oss-120b-medium',
      ]);
      expect(catModelUpdates['gemini-5-pro'].variants).toEqual(expected5ProVariants);

      // 5. catalog.transform with catalog.providers
      const legacyCatalog: any = {};
      await catalogTransform!(legacyCatalog);
      expect(Object.keys(legacyCatalog.providers[AGY_PROVIDER_ID].models)).toEqual([
        'gemini-4-argon',
        'gemini-5-pro',
        'gpt-oss-120b-medium',
      ]);
      expect(
        legacyCatalog.providers[AGY_PROVIDER_ID].models['gemini-5-pro'].variants
      ).toEqual(expected5ProVariants);
    } finally {
      dispose?.();
    }

    // Fallback to model.reload() when provider.reload is absent
    const modelOnlyReload = vi.fn().mockResolvedValue(undefined);
    const dispose2 = await setupOpenCodeV2({
      model: {
        transform: vi.fn(),
        reload: modelOnlyReload,
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'conn-1' }),
          resolve: vi.fn(),
        },
      },
      location: {},
    });
    try {
      await vi.waitFor(() => {
        expect(modelOnlyReload).toHaveBeenCalledTimes(1);
      });
    } finally {
      dispose2?.();
    }
  });

  it('deduplicates concurrent refreshModels triggers into a single loadAccountModels call', async () => {
    let resolveLoad: ((val: AccountModelInventory | undefined) => void) | undefined;
    const loadSpy = vi.spyOn(dynamicModelsModule, 'loadAccountModels').mockImplementation(
      () =>
        new Promise<AccountModelInventory | undefined>((resolve) => {
          resolveLoad = resolve;
        })
    );

    let eventSubscriber: ((evt: any) => void) | undefined;
    let sdkHook: ((evt: any) => Promise<void> | void) | undefined;
    const providerReload = vi.fn().mockResolvedValue(undefined);

    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn(),
        reload: providerReload,
      },
      model: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      aisdk: {
        hook: vi.fn((name, fn) => {
          if (name === 'sdk') sdkHook = fn;
        }),
      },
      event: {
        subscribe: vi.fn((fn) => {
          eventSubscriber = fn;
          return () => {};
        }),
      },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'conn-1' }),
          resolve: vi.fn().mockResolvedValue({
            type: 'credential',
            credential: {
              type: 'oauth',
              access: 'tok-1',
              refresh: 'ref-1|proj-1|mproj-1',
              expires: Date.now() + 3600000,
            },
          }),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);
    const origFetch = globalThis.fetch;
    try {
      await vi.waitFor(() => {
        expect(loadSpy).toHaveBeenCalledTimes(1);
      });

      // Trigger concurrent event + runtime request while startup loadAccountModels is still pending
      eventSubscriber?.({ type: 'integration.connection.updated' });
      eventSubscriber?.({ type: 'auth.changed' });

      const sdkEvent: any = {
        providerID: AGY_PROVIDER_ID,
        model: { providerID: AGY_PROVIDER_ID, variant: 'high' },
      };
      await sdkHook!(sdkEvent);

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const fetchPromise = sdkEvent.options.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'hello' }] }] }),
        }
      );

      await new Promise((r) => setTimeout(r, 20));
      expect(loadSpy).toHaveBeenCalledTimes(1);

      resolveLoad!(makeInventory('conn-1'));
      const res = await fetchPromise;
      expect(res.status).toBe(200);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(providerReload).toHaveBeenCalledTimes(1);

      // Verify runtime request used discovered gemini-5-pro-high and enum MODEL_GEMINI_5_PRO_HIGH
      const calledBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(calledBody.model).toBe('gemini-5-pro-high');
      expect(calledBody.request.labels.model_enum).toBe('MODEL_GEMINI_5_PRO_HIGH');
    } finally {
      globalThis.fetch = origFetch;
      dispose?.();
    }
  });

  it('handles account switch (conn-a -> conn-b) without leaking conn-a models, without setting sourceConnection, and without throwing in resolveRuntimeCatalog', async () => {
    let activeConn: { type: 'credential'; id: string } | undefined = {
      type: 'credential',
      id: 'conn-a',
    };
    const invA = makeInventory('conn-a');
    const invB: AccountModelInventory = {
      connection: { type: 'credential', id: 'conn-b' },
      models: {
        'claude-sonnet-5-5': {
          name: 'Claude Sonnet 5.5',
          description: 'Claude Sonnet 5.5 model.',
          maxTokens: 1000000,
          maxOutputTokens: 128000,
          toolCall: true,
          reasoning: true,
          attachment: true,
        },
      },
      tierMapping: {
        'claude-sonnet-5-5': {
          low: 'claude-sonnet-5-5-low',
          high: 'claude-sonnet-5-5-high',
        },
      },
      enums: {
        'claude-sonnet-5-5-low': 'MODEL_CLAUDE_SONNET_LOW_B',
        'claude-sonnet-5-5-high': 'MODEL_CLAUDE_SONNET_HIGH_B',
      },
    };

    let resolveConnBLoad: ((val: AccountModelInventory | undefined) => void) | undefined;
    const loadSpy = vi
      .spyOn(dynamicModelsModule, 'loadAccountModels')
      .mockResolvedValueOnce(invA)
      .mockImplementationOnce(
        () =>
          new Promise<AccountModelInventory | undefined>((resolve) => {
            resolveConnBLoad = resolve;
          })
      );

    let modelTransform: ((editor: any) => Promise<void> | void) | undefined;
    let providerTransform: ((editor: any) => Promise<void> | void) | undefined;
    const sessionHooks: Record<string, (event: any) => Promise<void> | void> = {};
    const providerReload = vi.fn().mockResolvedValue(undefined);

    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn((fn) => {
          providerTransform = fn;
        }),
        reload: providerReload,
      },
      model: {
        transform: vi.fn((fn) => {
          modelTransform = fn;
        }),
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: {
        hook: vi.fn((name, fn) => {
          sessionHooks[name] = fn;
        }),
      },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn(async () => activeConn),
          resolve: vi.fn(),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);
    try {
      await vi.waitFor(() => {
        expect(providerReload).toHaveBeenCalledTimes(1);
      });

      // Verify conn-a models are active
      const mapA = new Map<string, any>();
      await modelTransform!({ set: (k: string, v: any) => mapA.set(k, v) });
      expect(mapA.has(`${AGY_PROVIDER_ID}:gemini-5-pro`)).toBe(true);

      // Provider transform never binds sourceConnection
      const pRecord: any = {};
      await providerTransform!({ update: (_id: string, fn: (p: any) => void) => fn(pRecord) });
      expect(pRecord.sourceConnection).toBeUndefined();

      // Switch active account to conn-b and trigger runtime request before conn-b discovery finishes
      activeConn = { type: 'credential', id: 'conn-b' };

      const reqEvent: any = {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-5-5:generateContent',
        headers: { 'x-agy-tier': 'high' },
        auth: {
          type: 'oauth',
          access: 'tok-b',
          refresh: 'ref-b|proj-b|mproj-b',
          expires: Date.now() + 3600000,
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
      };

      const reqPromise = sessionHooks['http.request']!(reqEvent);
      await vi.waitFor(() => {
        expect(loadSpy).toHaveBeenCalledTimes(2);
      });

      // While conn-b refresh is in-flight, model.transform must NOT leak conn-a's gemini-5-pro
      const mapDuringRefresh = new Map<string, any>();
      await modelTransform!({ set: (k: string, v: any) => mapDuringRefresh.set(k, v) });
      expect(mapDuringRefresh.has(`${AGY_PROVIDER_ID}:gemini-5-pro`)).toBe(false);
      expect(mapDuringRefresh.has(`${AGY_PROVIDER_ID}:gemini-3.8-flash`)).toBe(true);

      // Complete conn-b discovery
      resolveConnBLoad!(invB);
      await reqPromise;

      const parsedBody = JSON.parse(reqEvent.body);
      expect(parsedBody.model).toBe('claude-sonnet-5-5-high');
      expect(parsedBody.request.labels.model_enum).toBe('MODEL_CLAUDE_SONNET_HIGH_B');

      const mapB = new Map<string, any>();
      await modelTransform!({ set: (k: string, v: any) => mapB.set(k, v) });
      expect(Array.from(mapB.keys())).toEqual([`${AGY_PROVIDER_ID}:claude-sonnet-5-5`]);
    } finally {
      dispose?.();
    }
  });

  it('handles logout (active becomes undefined) by clearing inventory, restoring static models, and falling back to stored auth.json without throwing', async () => {
    let activeConn: { type: 'credential'; id: string } | undefined = {
      type: 'credential',
      id: 'conn-a',
    };
    const invA = makeInventory('conn-a');
    vi.spyOn(dynamicModelsModule, 'loadAccountModels').mockImplementation(async () =>
      activeConn ? invA : undefined
    );

    let modelTransform: ((editor: any) => Promise<void> | void) | undefined;
    let eventSubscriber: ((evt: any) => void) | undefined;
    let sdkHook: ((evt: any) => Promise<void> | void) | undefined;
    const providerReload = vi.fn().mockResolvedValue(undefined);

    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn(),
        reload: providerReload,
      },
      model: {
        transform: vi.fn((fn) => {
          modelTransform = fn;
        }),
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      aisdk: {
        hook: vi.fn((name, fn) => {
          if (name === 'sdk') sdkHook = fn;
        }),
      },
      event: {
        subscribe: vi.fn((fn) => {
          eventSubscriber = fn;
          return () => {};
        }),
      },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn(async () => activeConn),
          resolve: vi.fn(async () => undefined),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);
    const origFetch = globalThis.fetch;
    try {
      await vi.waitFor(() => {
        expect(providerReload).toHaveBeenCalledTimes(1);
      });

      // Log out
      activeConn = undefined;
      eventSubscriber?.({ type: 'connection.removed' });

      await vi.waitFor(() => {
        expect(providerReload).toHaveBeenCalledTimes(2);
      });

      const mapAfterLogout = new Map<string, any>();
      await modelTransform!({ set: (k: string, v: any) => mapAfterLogout.set(k, v) });
      expect(Array.from(mapAfterLogout.keys())).toEqual(
        Object.keys(STATIC_MODELS_SIMPLE).map((id) => `${AGY_PROVIDER_ID}:${id}`)
      );

      // Verify aisdk.hook('sdk') getAuthSnapshot does NOT throw when logged out and falls back to auth.json
      setStoredAuthOverrideForTesting({
        type: 'oauth',
        access: 'stored-json-access',
        refresh: 'stored-ref|proj-fallback|mproj-fallback',
        expires: Date.now() + 3600000,
      });

      const sdkEvent: any = {
        providerID: AGY_PROVIDER_ID,
        variant: 'low',
      };
      await sdkHook!(sdkEvent);

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await sdkEvent.options.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'fallback test' }] }] }),
        }
      );
      expect(res.status).toBe(200);
      const sentHeaders = (globalThis.fetch as any).mock.calls[0][1].headers as Headers;
      expect(sentHeaders.get('Authorization')).toBe('Bearer stored-json-access');
    } finally {
      globalThis.fetch = origFetch;
      dispose?.();
    }
  });

  it('preserves existing inventory on transient refresh error for same connection, and falls back to static models when refresh fails after switching connection', async () => {
    let activeConn: { type: 'credential'; id: string } | undefined = {
      type: 'credential',
      id: 'conn-a',
    };
    const invA = makeInventory('conn-a');
    const loadSpy = vi
      .spyOn(dynamicModelsModule, 'loadAccountModels')
      .mockResolvedValueOnce(invA)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('Network error on conn-b'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let modelTransform: ((editor: any) => Promise<void> | void) | undefined;
    let eventSubscriber: ((evt: any) => void) | undefined;
    const providerReload = vi.fn().mockResolvedValue(undefined);

    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn(),
        reload: providerReload,
      },
      model: {
        transform: vi.fn((fn) => {
          modelTransform = fn;
        }),
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      event: {
        subscribe: vi.fn((fn) => {
          eventSubscriber = fn;
          return () => {};
        }),
      },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn(async () => activeConn),
          resolve: vi.fn(),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);
    try {
      await vi.waitFor(() => {
        expect(providerReload).toHaveBeenCalledTimes(1);
      });

      // Trigger transient error on conn-a
      eventSubscriber?.({ type: 'config.updated' });
      await vi.waitFor(() => {
        expect(loadSpy).toHaveBeenCalledTimes(2);
      });
      expect(warnSpy).toHaveBeenCalled();

      // conn-a inventory is preserved
      const mapAfterTransient = new Map<string, any>();
      await modelTransform!({ set: (k: string, v: any) => mapAfterTransient.set(k, v) });
      expect(mapAfterTransient.has(`${AGY_PROVIDER_ID}:gemini-5-pro`)).toBe(true);

      // Now switch to conn-b and fail refresh -> must NOT serve conn-a's models
      activeConn = { type: 'credential', id: 'conn-b' };
      eventSubscriber?.({ type: 'connection.updated' });
      await vi.waitFor(() => {
        expect(loadSpy).toHaveBeenCalledTimes(3);
      });

      const mapOnConnBFail = new Map<string, any>();
      await modelTransform!({ set: (k: string, v: any) => mapOnConnBFail.set(k, v) });
      expect(mapOnConnBFail.has(`${AGY_PROVIDER_ID}:gemini-5-pro`)).toBe(false);
      expect(mapOnConnBFail.has(`${AGY_PROVIDER_ID}:gemini-3.8-flash`)).toBe(true);
    } finally {
      dispose?.();
    }
  });

  it('triggers refreshModels on OAuth callback, matching events, and 5-minute interval, and cleans up on dispose', async () => {
    vi.useFakeTimers();

    const inv = makeInventory('conn-oauth');
    const loadSpy = vi.spyOn(dynamicModelsModule, 'loadAccountModels').mockResolvedValue(inv);

    let integrationTransform: ((editor: any) => void) | undefined;
    let eventSubscriber: ((evt: any) => void) | undefined;
    const unsubscribeSpy = vi.fn();
    const providerReload = vi.fn().mockResolvedValue(undefined);

    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn(),
        reload: providerReload,
      },
      model: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      event: {
        subscribe: vi.fn((fn) => {
          eventSubscriber = fn;
          return unsubscribeSpy;
        }),
      },
      integration: {
        transform: vi.fn((fn) => {
          integrationTransform = fn;
        }),
        connection: {
          active: vi.fn().mockResolvedValue({ type: 'credential', id: 'conn-oauth' }),
          resolve: vi.fn(),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);
    await vi.advanceTimersByTimeAsync(10);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // Non-matching event should be ignored
    eventSubscriber?.({ type: 'session.message' });
    await vi.advanceTimersByTimeAsync(10);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // Matching event triggers refresh
    eventSubscriber?.({ name: 'provider.reloaded' });
    await vi.advanceTimersByTimeAsync(10);
    expect(loadSpy).toHaveBeenCalledTimes(2);

    // OAuth callback success triggers refresh
    let authorizeFn: (() => Promise<any>) | undefined;
    integrationTransform!({
      update: vi.fn(),
      method: {
        update: vi.fn((cfg) => {
          authorizeFn = cfg.authorize;
        }),
      },
    });

    vi.spyOn(oauthSdk, 'authorizeAgy').mockResolvedValue({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      verifier: 'v-1',
      state: 's-1',
    });
    vi.spyOn(oauthSdk, 'exchangeAgyWithVerifier').mockResolvedValue({
      type: 'success',
      access: 'acc-1',
      refresh: 'ref-1|p-1|mp-1',
      expires: Date.now() + 3600000,
    });

    const authFlow = await authorizeFn!();
    const cbRes = await authFlow.callback('https://antigravity.google/oauth-callback?code=c1&state=s-1');
    expect(cbRes.type).toBe('oauth');
    await vi.advanceTimersByTimeAsync(100);
    expect(loadSpy).toHaveBeenCalledTimes(3);

    // 5-minute periodic timer triggers refresh
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(loadSpy).toHaveBeenCalledTimes(4);

    // Disposer stops interval and unsubscribes event listener
    expect(typeof dispose).toBe('function');
    dispose!();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    eventSubscriber?.({ type: 'auth.updated' });
    await vi.advanceTimersByTimeAsync(100);
    expect(loadSpy).toHaveBeenCalledTimes(4);
  });

  it('handles mid-flight account switch and mid-flight logout during refreshModels', async () => {
    let activeConn: { type: 'credential'; id: string } | undefined = {
      type: 'credential',
      id: 'conn-1',
    };

    const inv1 = makeInventory('conn-1');
    const inv2 = makeInventory('conn-2');

    let callCount = 0;
    const loadSpy = vi.spyOn(dynamicModelsModule, 'loadAccountModels').mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        // Switch active account to conn-2 while conn-1 discovery was in-flight
        activeConn = { type: 'credential', id: 'conn-2' };
        return inv1;
      }
      if (callCount === 2) {
        return inv2;
      }
      // 3rd call: logout mid-flight
      activeConn = undefined;
      return inv2;
    });

    let eventSubscriber: ((evt: any) => void) | undefined;
    let modelTransform: ((editor: any) => Promise<void> | void) | undefined;
    const providerReload = vi.fn().mockResolvedValue(undefined);

    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn(),
        reload: providerReload,
      },
      model: {
        transform: vi.fn((fn) => {
          modelTransform = fn;
        }),
      },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      event: {
        subscribe: vi.fn((fn) => {
          eventSubscriber = fn;
          return () => {};
        }),
      },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn(async () => activeConn),
          resolve: vi.fn(),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);
    try {
      // Initial startup should perform follow-up call for conn-2 and commit inv2
      await vi.waitFor(() => {
        expect(loadSpy).toHaveBeenCalledTimes(2);
        expect(providerReload).toHaveBeenCalledTimes(1);
      });

      const mapConn2 = new Map<string, any>();
      await modelTransform!({ set: (k: string, v: any) => mapConn2.set(k, v) });
      expect(mapConn2.has(`${AGY_PROVIDER_ID}:gemini-5-pro`)).toBe(true);

      // Trigger another refresh where user logs out mid-flight
      eventSubscriber?.({ type: 'auth.logout' });
      await vi.waitFor(() => {
        expect(loadSpy).toHaveBeenCalledTimes(3);
        expect(providerReload).toHaveBeenCalledTimes(2);
      });

      const mapAfterMidFlightLogout = new Map<string, any>();
      await modelTransform!({ set: (k: string, v: any) => mapAfterMidFlightLogout.set(k, v) });
      expect(mapAfterMidFlightLogout.has(`${AGY_PROVIDER_ID}:gemini-5-pro`)).toBe(false);
      expect(mapAfterMidFlightLogout.has(`${AGY_PROVIDER_ID}:gemini-3.8-flash`)).toBe(true);
    } finally {
      dispose?.();
    }
  });

  it('exercises logger.warn on reload failure, runtime catalog logout cleanup, and connection resolve shapes in aisdk hook', async () => {
    let activeConn: { type: 'credential'; id: string } | undefined = {
      type: 'credential',
      id: 'conn-1',
    };
    const inv1 = makeInventory('conn-1');
    vi.spyOn(dynamicModelsModule, 'loadAccountModels').mockResolvedValueOnce(inv1);

    const loggerWarn = vi.fn();
    let sdkHook: ((evt: any) => Promise<void> | void) | undefined;
    const providerReload = vi
      .fn()
      .mockRejectedValueOnce(new Error('reload boom'))
      .mockResolvedValue(undefined);

    const ctx: OpenCodeV2PluginContext = {
      provider: {
        transform: vi.fn(),
        reload: providerReload,
      },
      model: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      logger: { warn: loggerWarn },
      aisdk: {
        hook: vi.fn((name, fn) => {
          if (name === 'sdk') sdkHook = fn;
        }),
      },
      integration: {
        transform: vi.fn(),
        connection: {
          active: vi.fn(async () => activeConn),
          resolve: vi.fn(async () => ({
            type: 'oauth',
            access: 'direct-oauth-access',
            refresh: 'ref|proj|mproj',
            expires: Date.now() + 3600000,
          })),
        },
      },
      location: {},
    };

    const dispose = await setupOpenCodeV2(ctx);
    const origFetch = globalThis.fetch;
    try {
      await vi.waitFor(() => {
        expect(providerReload).toHaveBeenCalledTimes(1);
      });
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('reload boom'));

      const sdkEvent: any = {
        providerID: AGY_PROVIDER_ID,
        model: { providerID: AGY_PROVIDER_ID, variant: 'low' },
      };
      await sdkHook!(sdkEvent);

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // Call fetch while logged in with direct oauth resolve shape
      const res1 = await sdkEvent.options.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
        }
      );
      expect(res1.status).toBe(200);

      // Now log out without firing event and call fetch -> resolveRuntimeCatalog clears inventory and triggers reload
      activeConn = undefined;
      setStoredAuthOverrideForTesting({
        type: 'oauth',
        access: 'stored-access-after-logout',
        refresh: 'ref|proj|mproj',
        expires: Date.now() + 3600000,
      });

      const res2 = await sdkEvent.options.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
        }
      );
      expect(res2.status).toBe(200);
      await vi.waitFor(() => {
        expect(providerReload).toHaveBeenCalledTimes(2);
      });
    } finally {
      globalThis.fetch = origFetch;
      dispose?.();
    }
  });
});

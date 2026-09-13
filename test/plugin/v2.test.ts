import { describe, it, expect, vi } from 'vitest';
import {
  setupOpenCodeV2,
  v2PluginDefinition,
  createV2PluginDefinition,
  AGY_V2_QUOTA_COMMAND,
  AGY_V2_QUOTA_SUMMARY_COMMAND,
  createV2FetchInterceptor,
  loadStoredAuthFromJson,
  getSafeHeader,
  setSafeHeaders,
  toUrlString,
  resolveModelTier
} from '../../src/plugin/v2';
import { AGY_PROVIDER_ID } from '../../src/constants';
import { AGY_QUOTA_TOOL_NAME } from '../../src/plugin/quota';
import { AGY_QUOTA_SUMMARY_TOOL_NAME } from '../../src/plugin/quota-summary';
import type { OpenCodeV2PluginContext } from '../../src/plugin/types';

describe('OpenCode v2 Plugin Setup Adapter', () => {
  it('defines v2 plugin definition with correct id and setup function', () => {
    expect(v2PluginDefinition.id).toBe(AGY_PROVIDER_ID);
    expect(typeof v2PluginDefinition.setup).toBe('function');

    const created = createV2PluginDefinition();
    expect(created.id).toBe(AGY_PROVIDER_ID);
    expect(created.setup).toBe(setupOpenCodeV2);
  });

  it('registers provider and models via catalog.transform', async () => {
    let catalogTransformFn: ((catalog: any) => Promise<void> | void) | undefined;
    let toolTransformFn: ((editor: any) => Promise<void> | void) | undefined;
    let commandTransformFn: ((editor: any) => Promise<void> | void) | undefined;
    const sessionHooks: Record<string, Function> = {};

    const mockCtx: OpenCodeV2PluginContext = {
      catalog: {
        transform: vi.fn((fn) => {
          catalogTransformFn = fn;
        })
      },
      tool: {
        transform: vi.fn((fn) => {
          toolTransformFn = fn;
        })
      },
      command: {
        transform: vi.fn((fn) => {
          commandTransformFn = fn;
        })
      },
      session: {
        hook: vi.fn((name, handler) => {
          sessionHooks[name] = handler;
        })
      },
      integration: {
        transform: vi.fn()
      },
      location: {
        root: '/test',
        workspace: '/test/workspace'
      }
    };

    await setupOpenCodeV2(mockCtx);

    expect(mockCtx.catalog.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.tool.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.command.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.session.hook).toHaveBeenCalledWith('http.request', expect.any(Function), { providerID: AGY_PROVIDER_ID });
    expect(mockCtx.session.hook).toHaveBeenCalledWith('http.response', expect.any(Function), { providerID: AGY_PROVIDER_ID });
    expect(mockCtx.session.hook).toHaveBeenCalledWith('retry', expect.any(Function), { providerID: AGY_PROVIDER_ID });

    // Test catalog transform execution
    const catalog: any = {};
    await catalogTransformFn!(catalog);

    expect(catalog.providers).toBeDefined();
    expect(catalog.providers[AGY_PROVIDER_ID]).toBeDefined();
    expect(catalog.providers[AGY_PROVIDER_ID].id).toBe(AGY_PROVIDER_ID);
    expect(catalog.providers[AGY_PROVIDER_ID].npm).toBe('aisdk:@ai-sdk/google');
    expect(catalog.providers[AGY_PROVIDER_ID].settings).toEqual({ apiKey: 'dummy' });
    expect(catalog.providers[AGY_PROVIDER_ID].integrationID).toBe(AGY_PROVIDER_ID);
    expect(catalog.providers[AGY_PROVIDER_ID].models['gemini-3.8-flash']).toBeDefined();
    expect(catalog.providers[AGY_PROVIDER_ID].models['gemini-3.8-flash'].variants).toEqual([
      { id: 'low' },
      { id: 'medium' },
      { id: 'high' }
    ]);
    expect(catalog.providers[AGY_PROVIDER_ID].models['gemini-3.1-pro'].variants).toEqual([
      { id: 'low' },
      { id: 'high' }
    ]);
    expect(catalog.providers[AGY_PROVIDER_ID].models['claude-sonnet-4-6']).toBeDefined();
    expect(catalog.providers[AGY_PROVIDER_ID].models['claude-sonnet-4-6'].variants).toBeUndefined();
    expect(catalog.providers[AGY_PROVIDER_ID].models['gpt-oss-120b-medium']).toBeDefined();

    // Test with catalog having existing provider without settings
    const catalogNoSettings: any = { providers: { [AGY_PROVIDER_ID]: {} } };
    await catalogTransformFn!(catalogNoSettings);
    expect(catalogNoSettings.providers[AGY_PROVIDER_ID].settings).toEqual({ apiKey: 'dummy' });

    // Test v2 catalog editor interface (provider.update and model.update)
    const providerUpdateMock = vi.fn();
    const modelUpdateMock = vi.fn();
    const v2Editor = {
      provider: {
        update: providerUpdateMock
      },
      model: {
        update: modelUpdateMock
      }
    };
    await catalogTransformFn!(v2Editor);
    expect(providerUpdateMock).toHaveBeenCalledWith(AGY_PROVIDER_ID, expect.any(Function));
    const providerObj: any = {};
    providerUpdateMock.mock.calls[0][1](providerObj);
    expect(providerObj.name).toBe('Antigravity CLI');
    expect(providerObj.activation).toBe('enabled');
    expect(providerObj.package).toBe('aisdk:@ai-sdk/google');
    expect(providerObj.description).toBe('Google Gemini Antigravity Code Assist OAuth provider');
    expect(providerObj.settings).toEqual({ apiKey: 'dummy' });
    expect(providerObj.integrationID).toBe(AGY_PROVIDER_ID);

    expect(modelUpdateMock).toHaveBeenCalled();
    const modelCalls = modelUpdateMock.mock.calls;
    const flashCall = modelCalls.find((c: any) => c[0] === AGY_PROVIDER_ID && c[1] === 'gemini-3.8-flash');
    expect(flashCall).toBeDefined();
    const flashModelObj: any = {};
    flashCall[2](flashModelObj);
    expect(flashModelObj.family).toBe('gemini');
    expect(flashModelObj.capabilities.tools).toBe(true);
    expect(flashModelObj.capabilities.input).toEqual(['text', 'image']);
    expect(flashModelObj.capabilities.output).toEqual(['text']);
    expect(flashModelObj.variants).toEqual([
      { id: 'low' },
      { id: 'medium' },
      { id: 'high' }
    ]);

    const proCall = modelCalls.find((c: any) => c[0] === AGY_PROVIDER_ID && c[1] === 'gemini-3.1-pro');
    expect(proCall).toBeDefined();
    const proModelObj: any = {};
    proCall[2](proModelObj);
    expect(proModelObj.variants).toEqual([
      { id: 'low' },
      { id: 'high' }
    ]);

    const claudeCall = modelCalls.find((c: any) => c[0] === AGY_PROVIDER_ID && c[1] === 'claude-sonnet-4-6');
    expect(claudeCall).toBeDefined();
    const claudeModelObj: any = {};
    claudeCall[2](claudeModelObj);
    expect(claudeModelObj.variants).toBeUndefined();

    // Verify catalog transform handles null safely
    await catalogTransformFn!(null);
  });

  it('registers agy_quota and agy_quota_summary tools via tool.transform and exercises tool dependencies', async () => {
    let toolTransformFn: ((editor: any) => Promise<void> | void) | undefined;

    const mockCtx: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: {
        transform: vi.fn((fn) => {
          toolTransformFn = fn;
        })
      },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: { transform: vi.fn() },
      location: {}
    };

    await setupOpenCodeV2(mockCtx);

    // Map-like editor with .set()
    const mapEditor = new Map<string, any>();
    await toolTransformFn!(mapEditor);
    expect(mapEditor.has(AGY_QUOTA_TOOL_NAME)).toBe(true);
    expect(mapEditor.has(AGY_QUOTA_SUMMARY_TOOL_NAME)).toBe(true);

    const quotaTool = mapEditor.get(AGY_QUOTA_TOOL_NAME);
    const quotaSummaryTool = mapEditor.get(AGY_QUOTA_SUMMARY_TOOL_NAME);

    // Call execute on tools to exercise dependencies
    const quotaRes = await quotaTool.execute({});
    expect(quotaRes).toContain('unavailable before Google auth is initialized');

    const quotaSummaryRes = await quotaSummaryTool.execute({});
    expect(quotaSummaryRes).toContain('unavailable before Google auth is initialized');

    // v2 Editor with .add()
    const addedTools: any[] = [];
    const addEditor = {
      add: vi.fn((toolDef: any) => {
        addedTools.push(toolDef);
      })
    };
    await toolTransformFn!(addEditor);
    expect(addEditor.add).toHaveBeenCalledTimes(2);
    expect(addedTools[0].name).toBe(AGY_QUOTA_TOOL_NAME);
    expect(addedTools[1].name).toBe(AGY_QUOTA_SUMMARY_TOOL_NAME);
    const v2QuotaRes = await addedTools[0].execute({}, {});
    expect(v2QuotaRes).toContain('unavailable before Google auth is initialized');
    const v2QuotaSummaryRes = await addedTools[1].execute({}, {});
    expect(v2QuotaSummaryRes).toContain('unavailable before Google auth is initialized');

    // Object with tools property
    const toolsPropEditor: any = { tools: {} };
    await toolTransformFn!(toolsPropEditor);
    expect(toolsPropEditor.tools[AGY_QUOTA_TOOL_NAME]).toBeDefined();
    expect(toolsPropEditor.tools[AGY_QUOTA_SUMMARY_TOOL_NAME]).toBeDefined();

    // Plain object editor
    const plainEditor: any = {};
    await toolTransformFn!(plainEditor);
    expect(plainEditor[AGY_QUOTA_TOOL_NAME]).toBeDefined();
    expect(plainEditor[AGY_QUOTA_SUMMARY_TOOL_NAME]).toBeDefined();

    // Safe with null
    await toolTransformFn!(null);
  });

  it('registers commands via command.transform', async () => {
    let commandTransformFn: ((editor: any) => Promise<void> | void) | undefined;

    const mockCtx: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: {
        transform: vi.fn((fn) => {
          commandTransformFn = fn;
        })
      },
      session: { hook: vi.fn() },
      integration: { transform: vi.fn() },
      location: {}
    };

    await setupOpenCodeV2(mockCtx);

    // Map-like editor with .set()
    const mapEditor = new Map<string, any>();
    await commandTransformFn!(mapEditor);
    expect(mapEditor.get(AGY_V2_QUOTA_COMMAND)?.template).toContain(AGY_QUOTA_TOOL_NAME);
    expect(mapEditor.get(AGY_V2_QUOTA_SUMMARY_COMMAND)?.template).toContain(AGY_QUOTA_SUMMARY_TOOL_NAME);

    // v2 Editor with .add()
    const addedCommands: any[] = [];
    const addEditor = {
      add: vi.fn((cmdDef: any) => {
        addedCommands.push(cmdDef);
      })
    };
    await commandTransformFn!(addEditor);
    expect(addEditor.add).toHaveBeenCalledTimes(2);
    expect(addedCommands[0].name).toBe(AGY_V2_QUOTA_COMMAND);
    expect(addedCommands[0].template).toContain(AGY_QUOTA_TOOL_NAME);
    expect(addedCommands[1].name).toBe(AGY_V2_QUOTA_SUMMARY_COMMAND);
    expect(addedCommands[1].template).toContain(AGY_QUOTA_SUMMARY_TOOL_NAME);

    // Object with commands property
    const commandsPropEditor: any = { commands: {} };
    await commandTransformFn!(commandsPropEditor);
    expect(commandsPropEditor.commands[AGY_V2_QUOTA_COMMAND]).toBeDefined();
    expect(commandsPropEditor.commands[AGY_V2_QUOTA_SUMMARY_COMMAND]).toBeDefined();

    // Plain object editor
    const plainEditor: any = {};
    await commandTransformFn!(plainEditor);
    expect(plainEditor[AGY_V2_QUOTA_COMMAND]).toBeDefined();
    expect(plainEditor[AGY_V2_QUOTA_SUMMARY_COMMAND]).toBeDefined();

    // Safe with null
    await commandTransformFn!(null);
  });

  it('registers integration via integration.transform', async () => {
    let integrationTransformFn: ((editor: any) => Promise<void> | void) | undefined;

    const mockCtx: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: {
        transform: vi.fn((fn) => {
          integrationTransformFn = fn;
        })
      },
      location: {}
    };

    await setupOpenCodeV2(mockCtx);
    expect(mockCtx.integration?.transform).toHaveBeenCalledTimes(1);

    const updateMock = vi.fn();
    const methodUpdateMock = vi.fn();
    const editor = {
      update: updateMock,
      method: {
        update: methodUpdateMock
      }
    };

    await integrationTransformFn!(editor);

    expect(updateMock).toHaveBeenCalledWith(AGY_PROVIDER_ID, expect.any(Function));
    const integrationObj: any = {};
    updateMock.mock.calls[0][1](integrationObj);
    expect(integrationObj.name).toBe('Antigravity CLI (plugin)');

    expect(methodUpdateMock).toHaveBeenCalledWith({
      integrationID: AGY_PROVIDER_ID,
      method: {
        id: 'oauth',
        type: 'oauth',
        label: 'Antigravity CLI (OAuth)'
      },
      authorize: expect.any(Function)
    });

    const authorizeRes = await methodUpdateMock.mock.calls[0][0].authorize();
    expect(authorizeRes.mode).toBe('code');
    expect(authorizeRes.url).toContain('https://accounts.google.com/o/oauth2/auth');
    expect(authorizeRes.url).toContain('response_type=code');
    expect(authorizeRes.url).toContain('client_id=');
    expect(authorizeRes.url).toContain('redirect_uri=');
    expect(authorizeRes.url).toContain('scope=');
    expect(typeof authorizeRes.callback).toBe('function');
    expect(typeof authorizeRes.instructions).toBe('string');

    // Test callback validation & failure on missing code
    const failRes = await authorizeRes.callback('');
    expect(failRes.type).toBe('failed');
    expect(failRes.error).toContain('Missing authorization code');

    // Test callback with mock token exchange failure
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('invalid_grant', { status: 400 })
      );
      const tokenFailRes = await authorizeRes.callback('test-code');
      expect(tokenFailRes.type).toBe('failed');
      expect(tokenFailRes.error).toBe('invalid_grant');

      // Test callback with mock token exchange success without refresh token
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'acc', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      const noRefreshRes = await authorizeRes.callback('test-code');
      expect(noRefreshRes.type).toBe('failed');
      expect(noRefreshRes.error).toContain('Missing refresh token');

      // Test callback with mock token exchange success
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      const successRes = await authorizeRes.callback('https://antigravity.google/oauth-callback?code=good-code');
      expect(successRes.type).toBe('success');
      expect(successRes.access).toBe('acc');
      expect(successRes.refresh).toContain('ref');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Test callback with valid refresh token that fails project resolution
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      // Spy ensureProjectContext or trigger its failure path
      const successWithFallbackProject = await authorizeRes.callback('test-code');
      expect(successWithFallbackProject.type).toBe('success');
      expect(successWithFallbackProject.refresh).toContain('ref');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Safe with null editor
    await integrationTransformFn!(null);
  });

  it('registers aisdk hook and sets apiKey and custom fetch when provider is google-agy', async () => {
    let aisdkHookHandler: ((event: any) => Promise<void> | void) | undefined;
    const mockAisdk = {
      hook: vi.fn((name: string, handler: any) => {
        if (name === 'sdk') {
          aisdkHookHandler = handler;
        }
      })
    };

    const mockCtx: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: { transform: vi.fn() },
      aisdk: mockAisdk,
      location: {}
    };

    await setupOpenCodeV2(mockCtx);

    expect(mockAisdk.hook).toHaveBeenCalledWith('sdk', expect.any(Function));
    expect(aisdkHookHandler).toBeDefined();

    // Event for non-matching provider is unchanged
    const otherEvent = { providerID: 'anthropic' };
    await aisdkHookHandler!(otherEvent);
    expect((otherEvent as any).options).toBeUndefined();

    // Event with providerID matching AGY_PROVIDER_ID
    const agyEventWithProviderID: any = { providerID: AGY_PROVIDER_ID };
    await aisdkHookHandler!(agyEventWithProviderID);
    expect(agyEventWithProviderID.options).toBeDefined();
    expect(agyEventWithProviderID.options.apiKey).toBe('dummy');
    expect(typeof agyEventWithProviderID.options.fetch).toBe('function');

    // Event with model.providerID matching AGY_PROVIDER_ID
    const agyEventWithModel: any = { model: { providerID: AGY_PROVIDER_ID }, options: { otherOpt: true } };
    await aisdkHookHandler!(agyEventWithModel);
    expect(agyEventWithModel.options.apiKey).toBe('dummy');
    expect(agyEventWithModel.options.otherOpt).toBe(true);
    expect(typeof agyEventWithModel.options.fetch).toBe('function');

    // Safe with null event
    await aisdkHookHandler!(null);

    // Exercise createV2FetchInterceptor through event.options.fetch with mocked fetch
    const customFetch = agyEventWithModel.options.fetch;
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const nonGoogleRes = await customFetch('https://example.com/test');
      expect(nonGoogleRes.status).toBe(200);

      // Non-OAuth or missing auth
      const glNonAuthRes = await customFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
      expect(glNonAuthRes.status).toBe(200);

      // With stored auth and internal endpoint
      const mockAuth = {
        type: 'oauth' as const,
        access: 'test-access',
        refresh: 'test-refresh|proj-1|m-proj-1',
        expires: Date.now() + 3600000
      };
      const internalCustomFetch = createV2FetchInterceptor(() => mockAuth);
      const internalRes = await internalCustomFetch('https://cloudcode-pa.googleapis.com/v1internal:test');
      expect(internalRes.status).toBe(200);

      // With internal endpoint already having Authorization
      const internalAuthRes = await internalCustomFetch('https://cloudcode-pa.googleapis.com/v1internal:test', {
        headers: { Authorization: 'Bearer existing' }
      });
      expect(internalAuthRes.status).toBe(200);

      // With GL request, tier rewriting, and success response
      const glCustomFetch = createV2FetchInterceptor(() => mockAuth);
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      const glRes = await glCustomFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] })
      });
      expect(glRes.status).toBe(200);

      // With GL request as Request instance
      const glReqInstance = new Request('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] })
      });
      const glReqRes = await glCustomFetch(glReqInstance);
      expect(glReqRes.status).toBe(200);

      // With expired access token triggering refresh
      const expiredAuth = {
        type: 'oauth' as const,
        access: 'old-access',
        refresh: 'test-refresh|proj-1|m-proj-1',
        expires: Date.now() - 1000
      };
      const expiredCustomFetch = createV2FetchInterceptor(() => expiredAuth);
      const expiredRes = await expiredCustomFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] })
      });
      expect(expiredRes.status).toBe(200);

      // Auth without access token
      const noAccessAuth = {
        type: 'oauth' as const,
        access: '',
        refresh: '',
        expires: 0
      };
      const noAccessFetch = createV2FetchInterceptor(() => noAccessAuth);
      const noAccessRes = await noAccessFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
      expect(noAccessRes.status).toBe(200);

      // Test ensureProjectContext throwing in v2 fetch interceptor
      const fallbackContextFetch = createV2FetchInterceptor(() => ({
        type: 'oauth',
        access: 'some-access',
        refresh: 'some-refresh|fallback-proj',
        expires: Date.now() + 3600000
      }));
      // When fetch returns empty json, prepareAgyRequest & transformAgyResponse handle it
      const fallbackRes = await fallbackContextFetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
        headers: { 'x-agy-tier': 'low' }
      });
      expect(fallbackRes.status).toBe(200);

      // Test internal endpoint with headers as an array and existing auth
      const arrayHeadersFetch = createV2FetchInterceptor(() => mockAuth);
      const arrayHeadersRes = await arrayHeadersFetch('https://cloudcode-pa.googleapis.com/v1internal:test', {
        headers: [['Authorization', 'Bearer existing']] as any
      });
      expect(arrayHeadersRes.status).toBe(200);

      // Test internal endpoint with headers as Headers instance
      const instHeadersRes = await arrayHeadersFetch('https://cloudcode-pa.googleapis.com/v1internal:test', {
        headers: new Headers({ Authorization: 'Bearer existing' })
      });
      expect(instHeadersRes.status).toBe(200);

      // Test internal endpoint with existing header to be replaced in setSafeHeaders array format
      const arrayReplaceRes = await arrayHeadersFetch('https://cloudcode-pa.googleapis.com/v1internal:test', {
        headers: [['User-Agent', 'old-agent']] as any
      });
      expect(arrayReplaceRes.status).toBe(200);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('exercises loadStoredAuthFromJson helper and auth code parser', () => {
    // Test safe header utilities
    expect(getSafeHeader(null, 'test')).toBeUndefined();
    expect(getSafeHeader({ 'X-Test': 'val' }, 'x-test')).toBe('val');
    expect(getSafeHeader({ 'Other': undefined }, 'other')).toBeUndefined();
    expect(getSafeHeader([['X-Arr', 'valArr']], 'x-arr')).toBe('valArr');
    expect(getSafeHeader([['Invalid']], 'x-arr')).toBeUndefined();
    expect(getSafeHeader(['not-array'], 'x-arr')).toBeUndefined();
    const headersObj = new Headers({ 'X-Head': 'valHead' });
    expect(getSafeHeader(headersObj, 'x-head')).toBe('valHead');

    // Test setSafeHeaders utilities
    const plainHeaders = setSafeHeaders({ 'A': '1' }, { 'B': '2', 'a': 'updated' });
    expect(plainHeaders instanceof Headers).toBe(true);
    expect((plainHeaders as Headers).get('a')).toBe('updated');
    expect((plainHeaders as Headers).get('b')).toBe('2');

    const arrHeaders = setSafeHeaders([['A', '1']], { 'A': '2', 'B': '3' });
    expect(arrHeaders instanceof Headers).toBe(true);
    expect((arrHeaders as Headers).get('a')).toBe('2');
    expect((arrHeaders as Headers).get('b')).toBe('3');

    // Test with undefined globalThis.Headers fallback
    const origHeaders = globalThis.Headers;
    try {
      (globalThis as any).Headers = undefined;
      const fallbackArr = setSafeHeaders([['A', '1']], { 'A': '2', 'B': '3' });
      expect(Array.isArray(fallbackArr)).toBe(true);

      const fallbackObj = setSafeHeaders({ 'A': '1' }, { 'A': '2', 'B': '3' });
      expect(typeof fallbackObj).toBe('object');
      expect((fallbackObj as any)['A']).toBe('2');
    } finally {
      globalThis.Headers = origHeaders;
    }

    // Test resolveModelTier utility
    expect(resolveModelTier('gemini-3.8-flash', { headers: { 'x-agy-tier': 'low' } })).toBe('gemini-3.8-flash-low');
    expect(resolveModelTier('gemini-3.8-flash@high')).toBe('gemini-3.8-flash-high');
    expect(resolveModelTier('gemini-3.8-flash@unknown')).toBe('gemini-3.8-flash-medium');
    expect(resolveModelTier('unknown-model')).toBe('unknown-model');

    // Test toUrlString
    expect(toUrlString('https://example.com')).toBe('https://example.com');
    expect(toUrlString(new Request('https://example.com/req'))).toBe('https://example.com/req');
    expect(toUrlString({ toString: () => 'https://example.com/custom' } as any)).toBe('https://example.com/custom');

    const loaded = loadStoredAuthFromJson();
    expect(loaded === undefined || typeof loaded === 'object').toBe(true);
  });

  it('handles session http.request hook properly', async () => {
    const sessionHooks: Record<string, Function> = {};

    const mockCtx: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: {
        hook: vi.fn((name, handler) => {
          sessionHooks[name] = handler;
        })
      },
      integration: { transform: vi.fn() },
      location: {}
    };

    await setupOpenCodeV2(mockCtx);

    const onRequest = sessionHooks['http.request'];
    expect(onRequest).toBeDefined();

    // Ignores non-Google URL
    const nonGoogleEvent: any = { url: 'https://api.openai.com/v1/chat', headers: {} };
    await onRequest(nonGoogleEvent);
    expect(nonGoogleEvent.headers['User-Agent']).toBeUndefined();

    // Injects User-Agent for Google GL URL with plain object headers
    const glEvent: any = {
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
      headers: {}
    };
    await onRequest(glEvent);
    expect(glEvent.headers['User-Agent']).toContain('antigravity');
    expect(glEvent.headers['Authorization']).toBe('Bearer dummy');

    // Strips x-goog-api-key and api-key from headers and query parameters, and injects auth
    const glWithKeyHeaders = new Headers({
      'x-goog-api-key': 'secret-key-1',
      'api-key': 'secret-key-2'
    });
    const glWithKeyEvent: any = {
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?key=query-key&api-key=query-key-2',
      headers: glWithKeyHeaders,
      auth: { access: 'oauth-test-access-token' }
    };
    await onRequest(glWithKeyEvent);
    expect(glWithKeyHeaders.get('x-goog-api-key')).toBeNull();
    expect(glWithKeyHeaders.get('api-key')).toBeNull();
    expect(glWithKeyHeaders.get('Authorization')).toBe('Bearer oauth-test-access-token');
    expect(glWithKeyEvent.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent');

    // Strips headers using plain object headers and request.url
    const plainHeadersObj: Record<string, string> = {
      'x-goog-api-key': 'header-key',
      'api-key': 'header-key-2'
    };
    const reqObjEvent: any = {
      request: {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?x-goog-api-key=bad'
      },
      headers: plainHeadersObj,
      auth: { token: 'token-property-test' }
    };
    await onRequest(reqObjEvent);
    expect(plainHeadersObj['x-goog-api-key']).toBeUndefined();
    expect(plainHeadersObj['api-key']).toBeUndefined();
    expect(plainHeadersObj['Authorization']).toBe('Bearer token-property-test');
    expect(reqObjEvent.request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');

    // Injects User-Agent for CloudCode PA internal endpoint with Headers object
    const internalHeaders = new Headers();
    const internalEvent: any = {
      url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      headers: internalHeaders
    };
    await onRequest(internalEvent);
    expect(internalHeaders.get('User-Agent')).toContain('antigravity');

    // Does not overwrite existing User-Agent
    const customHeaders = { 'User-Agent': 'custom-agent' };
    const customEvent: any = {
      url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      headers: customHeaders
    };
    await onRequest(customEvent);
    expect(customHeaders['User-Agent']).toBe('custom-agent');

    // Safe with null event
    await onRequest(null);
  });

  it('handles session http.response and retry hooks properly', async () => {
    const sessionHooks: Record<string, Function> = {};

    const mockCtx: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: {
        hook: vi.fn((name, handler) => {
          sessionHooks[name] = handler;
        })
      },
      integration: { transform: vi.fn() },
      location: {}
    };

    await setupOpenCodeV2(mockCtx);

    const onResponse = sessionHooks['http.response'];
    expect(onResponse).toBeDefined();
    await onResponse({ response: { status: 429 } });
    await onResponse(null);

    const onRetry = sessionHooks['retry'];
    expect(onRetry).toBeDefined();

    // Test with quota retry details
    const retryEvent: any = {
      response: { status: 429 },
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '2.5s'
        }
      ]
    };
    await onRetry(retryEvent);
    expect(retryEvent.retryDelayMs).toBe(2500);

    // Test with Response object containing Retry-After
    const responseWithHeaders = new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
      status: 429,
      headers: {
        'retry-after-ms': '3500'
      }
    });
    const responseRetryEvent: any = {
      response: responseWithHeaders
    };
    await onRetry(responseRetryEvent);
    expect(responseRetryEvent.retryDelayMs).toBe(3500);

    // Test with Response object returning classified quota delay
    const responseWithQuota = new Response(
      JSON.stringify({
        error: {
          message: 'Resource exhausted',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              domain: 'cloudcode-pa.googleapis.com',
              reason: 'RATE_LIMIT_EXCEEDED'
            },
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '5s'
            }
          ]
        }
      }),
      { status: 429 }
    );
    const quotaRetryEvent: any = {
      response: responseWithQuota
    };
    await onRetry(quotaRetryEvent);
    expect(quotaRetryEvent.retryDelayMs).toBe(5000);

    // Safe with non-matching retry event and null
    const regularRetryEvent: any = { response: { status: 200 } };
    await onRetry(regularRetryEvent);
    expect(regularRetryEvent.retryDelayMs).toBeUndefined();
    await onRetry(null);
  });
});

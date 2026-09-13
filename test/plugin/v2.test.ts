import { describe, it, expect, vi } from 'vitest';
import {
  setupOpenCodeV2,
  v2PluginDefinition,
  createV2PluginDefinition,
  AGY_V2_QUOTA_COMMAND,
  AGY_V2_QUOTA_SUMMARY_COMMAND
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
    expect(authorizeRes).toEqual({
      mode: 'auto',
      url: 'https://accounts.google.com/o/oauth2/auth',
      instructions: 'Login with Google Cloud / Antigravity CLI credentials'
    });

    // Safe with null editor
    await integrationTransformFn!(null);
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

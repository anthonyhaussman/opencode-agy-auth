import { describe, it, expect, vi } from 'vitest';
import { setupOpenCodeV2 } from '../../src/plugin/v2';
import { AGY_PROVIDER_ID } from '../../src/constants';
import { AGY_QUOTA_TOOL_NAME } from '../../src/plugin/quota';
import { AGY_QUOTA_SUMMARY_TOOL_NAME } from '../../src/plugin/quota-summary';
import type { OpenCodeV2PluginContext } from '../../src/plugin/types';

describe('OpenCode v2 Integration and Edge Cases', () => {
  const createMockContext = () => {
    let catalogTransformFn: ((catalog: any) => Promise<void> | void) | undefined;
    let toolTransformFn: ((editor: any) => Promise<void> | void) | undefined;
    let commandTransformFn: ((editor: any) => Promise<void> | void) | undefined;
    const sessionHooks: Record<string, (event: any) => Promise<void> | void> = {};

    const ctx: OpenCodeV2PluginContext = {
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
        root: '/workspace',
        workspace: '/workspace/project'
      }
    };

    return {
      ctx,
      getCatalogTransform: () => catalogTransformFn,
      getToolTransform: () => toolTransformFn,
      getCommandTransform: () => commandTransformFn,
      getSessionHook: (name: string) => sessionHooks[name]
    };
  };

  describe('catalog.transform edge cases', () => {
    it('handles pre-existing provider and model configurations without overwriting', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const transform = harness.getCatalogTransform()!;

      const existingCatalog: any = {
        providers: {
          [AGY_PROVIDER_ID]: {
            id: AGY_PROVIDER_ID,
            name: 'Custom Antigravity Provider',
            customField: true,
            models: {
              'gemini-3.8-flash': {
                id: 'gemini-3.8-flash',
                name: 'Custom Flash Name',
                customModelField: 'keep-me'
              }
            }
          }
        }
      };

      await transform(existingCatalog);

      const provider = existingCatalog.providers[AGY_PROVIDER_ID];
      expect(provider.name).toBe('Custom Antigravity Provider');
      expect(provider.customField).toBe(true);

      const flashModel = provider.models['gemini-3.8-flash'];
      expect(flashModel.name).toBe('Custom Flash Name');
      expect(flashModel.customModelField).toBe('keep-me');
      expect(flashModel.family).toBe('gemini');
      expect(flashModel.providerID).toBe(AGY_PROVIDER_ID);
    });

    it('populates family correctly across gemini, claude, gpt, and unknown models', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const transform = harness.getCatalogTransform()!;

      const catalog: any = {};
      await transform(catalog);

      const models = catalog.providers[AGY_PROVIDER_ID].models;
      expect(models['gemini-3.8-flash'].family).toBe('gemini');
      expect(models['claude-sonnet-4-6'].family).toBe('claude');
      expect(models['gpt-oss-120b-medium'].family).toBe('gpt');
    });
  });

  describe('tool.transform registration edge cases', () => {
    it('invokes tools with getAuthResolver and getConfiguredProjectId returning undefined', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const transform = harness.getToolTransform()!;

      const target: any = {};
      await transform(target);

      const quotaTool = target[AGY_QUOTA_TOOL_NAME];
      const summaryTool = target[AGY_QUOTA_SUMMARY_TOOL_NAME];

      expect(quotaTool).toBeDefined();
      expect(summaryTool).toBeDefined();

      const quotaOutput = await quotaTool.execute({});
      expect(quotaOutput).toContain('unavailable before Google auth is initialized');

      const summaryOutput = await summaryTool.execute({});
      expect(summaryOutput).toContain('unavailable before Google auth is initialized');
    });
  });

  describe('command.transform registration edge cases', () => {
    it('registers quota commands across all supported editor container shapes', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const transform = harness.getCommandTransform()!;

      // Map editor
      const mapEditor = new Map<string, any>();
      await transform(mapEditor);
      expect(mapEditor.has('agy-quota')).toBe(true);
      expect(mapEditor.has('agy-quota-summary')).toBe(true);

      // Container with .commands object
      const propEditor: any = { commands: {} };
      await transform(propEditor);
      expect(propEditor.commands['agy-quota']).toBeDefined();
      expect(propEditor.commands['agy-quota-summary']).toBeDefined();

      // Flat dictionary
      const flatEditor: any = {};
      await transform(flatEditor);
      expect(flatEditor['agy-quota']).toBeDefined();
      expect(flatEditor['agy-quota-summary']).toBeDefined();
    });
  });

  describe('session http.request hook edge cases', () => {
    it('handles event.request.url when top-level url is absent', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRequest = harness.getSessionHook('http.request');

      const event: any = {
        request: {
          url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'
        },
        headers: {}
      };

      await onRequest(event);
      expect(event.headers['User-Agent']).toContain('antigravity');
    });

    it('ignores completely irrelevant URLs and requests', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRequest = harness.getSessionHook('http.request');

      const events = [
        { url: 'https://api.github.com/repos' },
        { url: 'https://google.com' },
        { request: { url: 'https://anthropic.com' } },
        { request: {} },
        {}
      ];

      for (const evt of events) {
        await onRequest(evt);
        expect((evt as any).headers).toBeUndefined();
      }
    });

    it('preserves existing lowercase user-agent header in plain object', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRequest = harness.getSessionHook('http.request');

      const event: any = {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
        headers: {
          'user-agent': 'existing-lowercase-agent'
        }
      };

      await onRequest(event);
      expect(event.headers['user-agent']).toBe('existing-lowercase-agent');
      expect(event.headers['User-Agent']).toBeUndefined();
    });

    it('sets User-Agent on generative language request when missing', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRequest = harness.getSessionHook('http.request');

      const event: any = {
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
        headers: {}
      };

      await onRequest(event);
      expect(event.headers['User-Agent']).toContain('antigravity/cli/');
    });
  });

  describe('session http.response hook edge cases', () => {
    it('handles various response status codes without errors', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onResponse = harness.getSessionHook('http.response');

      await onResponse(null);
      await onResponse({});
      await onResponse({ response: { status: 200 } });
      await onResponse({ response: { status: 429 } });
      await onResponse({ response: { status: 500 } });
    });
  });

  describe('session retry hook edge cases', () => {
    it('handles 503 Service Unavailable with exponential/resolved backoff', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRetry = harness.getSessionHook('retry');

      const response503 = new Response('Service Unavailable', {
        status: 503,
        headers: {
          'retry-after': '10'
        }
      });

      const event: any = {
        response: response503,
        attempt: 2
      };

      await onRetry(event);
      expect(event.retryDelayMs).toBe(10000);
    });

    it('handles 429 without RetryInfo by falling back to resolveRetryDelayMs', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRetry = harness.getSessionHook('retry');

      const response429 = new Response(JSON.stringify({ error: { message: 'Too Many Requests' } }), {
        status: 429,
        headers: {
          'retry-after-ms': '4200'
        }
      });

      const event: any = {
        response: response429
      };

      await onRetry(event);
      expect(event.retryDelayMs).toBe(4200);
    });

    it('ignores responses with non-retryable status codes (e.g., 400, 401, 404)', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRetry = harness.getSessionHook('retry');

      const nonRetryable = new Response('Bad Request', { status: 400 });
      const event: any = { response: nonRetryable };

      await onRetry(event);
      expect(event.retryDelayMs).toBeUndefined();
    });

    it('parses retryDelay from details array when response is not a Response instance', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRetry = harness.getSessionHook('retry');

      // Valid RetryInfo details
      const validEvent: any = {
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '3.2s'
          }
        ]
      };
      await onRetry(validEvent);
      expect(validEvent.retryDelayMs).toBe(3200);

      // Malformed or unknown details items
      const invalidDetailsEvent: any = {
        details: [
          null,
          { '@type': 'other.type' },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: 'invalid-seconds' }
        ]
      };
      await onRetry(invalidDetailsEvent);
      expect(invalidDetailsEvent.retryDelayMs).toBeUndefined();
    });

    it('handles empty, null, or undefined event gracefully', async () => {
      const harness = createMockContext();
      await setupOpenCodeV2(harness.ctx);
      const onRetry = harness.getSessionHook('retry');

      await onRetry(null);
      await onRetry(undefined);
      const emptyEvent: any = {};
      await onRetry(emptyEvent);
      expect(emptyEvent.retryDelayMs).toBeUndefined();
    });
  });
});

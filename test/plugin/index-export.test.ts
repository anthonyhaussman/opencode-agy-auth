import { describe, it, expect, vi } from 'vitest';
import pluginDefault, {
  AgyCLIOAuthPlugin,
  GoogleOAuthPlugin,
  setupOpenCodeV2,
  v2PluginDefinition,
} from '../../index';
import { AGY_PROVIDER_ID } from '../../src/constants';
import { AGY_QUOTA_TOOL_NAME } from '../../src/plugin/quota';
import { AGY_QUOTA_SUMMARY_TOOL_NAME } from '../../src/plugin/quota-summary';
import type { OpenCodeV2PluginContext } from '../../src/plugin/types';

describe('index entrypoint dual v1/v2 export', () => {
  it('exports dual plugin object as default export', () => {
    expect(pluginDefault).toBeDefined();
    expect(pluginDefault.id).toBe(AGY_PROVIDER_ID);
    expect(typeof pluginDefault.setup).toBe('function');
    expect(typeof pluginDefault.server).toBe('function');
  });

  it('exposes identical setup and v2PluginDefinition references', () => {
    expect(pluginDefault.setup).toBe(setupOpenCodeV2);
    expect(pluginDefault.id).toBe(v2PluginDefinition.id);
  });

  it('invokes v1 plugin function via .server and returns v1 plugin shape', async () => {
    const mockClient = {
      app: {
        log: vi.fn(),
      },
    };

    const v1Result = await pluginDefault.server({ client: mockClient });
    expect(v1Result).toBeDefined();
    expect(typeof v1Result.config).toBe('function');
    expect(typeof v1Result.tool).toBe('object');
    expect(v1Result.tool[AGY_QUOTA_TOOL_NAME]).toBeDefined();
    expect(v1Result.tool[AGY_QUOTA_SUMMARY_TOOL_NAME]).toBeDefined();
    expect(typeof v1Result.auth).toBe('object');
    expect(v1Result.auth.provider).toBe(AGY_PROVIDER_ID);
    expect(typeof v1Result.auth.loader).toBe('function');
    expect(typeof v1Result.provider).toBe('object');
    expect(typeof v1Result.provider.models).toBe('function');
  });

  it('invokes v2 setup function via .setup', async () => {
    const mockCtx: OpenCodeV2PluginContext = {
      catalog: {
        transform: vi.fn(),
      },
      tool: {
        transform: vi.fn(),
      },
      command: {
        transform: vi.fn(),
      },
      session: {
        hook: vi.fn(),
      },
      integration: {
        transform: vi.fn(),
      },
      location: {
        root: '/test',
        workspace: '/test/workspace',
      },
    };

    await pluginDefault.setup(mockCtx);

    expect(mockCtx.catalog.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.tool.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.command.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.session.hook).toHaveBeenCalled();
  });

  it('preserves named exports AgyCLIOAuthPlugin and GoogleOAuthPlugin', () => {
    expect(AgyCLIOAuthPlugin).toBeDefined();
    expect(GoogleOAuthPlugin).toBeDefined();
    expect(GoogleOAuthPlugin).toBe(AgyCLIOAuthPlugin);
    expect(pluginDefault.server).toBe(AgyCLIOAuthPlugin);
  });
});

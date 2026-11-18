import { describe, it, expect, vi } from 'vitest';
import pluginDefault, { setupOpenCodeV2, v2PluginDefinition } from '../../index';
import { AGY_PROVIDER_ID } from '../../src/constants';
import type { OpenCodeV2PluginContext } from '../../src/plugin/types';

// These tests cover google-agy alone; google-agy-acp registration is tested in test/acp/register.test.ts.
vi.mock('../../src/acp/register', () => ({
  registerAgyAcpProvider: vi.fn(async () => ({ dispose: async () => {} })),
}));

describe('index entrypoint v2 export', () => {
  it('exports a v2-only plugin definition', async () => {
    const mod = await import('../../index');
    expect(typeof mod.default.setup).toBe('function');
    expect(typeof mod.default.id).toBe('string');
    expect('server' in mod.default).toBe(false);
    expect('AgyCLIOAuthPlugin' in mod).toBe(false);
  });

  it('exports plugin definition with provider id as default export', () => {
    expect(pluginDefault.id).toBe(AGY_PROVIDER_ID);
    expect(typeof pluginDefault.setup).toBe('function');
  });

  it('exposes identical setup and v2PluginDefinition references', () => {
    expect(pluginDefault.setup).toBe(setupOpenCodeV2);
    expect(pluginDefault.id).toBe(v2PluginDefinition.id);
  });

  it('invokes v2 setup function via .setup', async () => {
    const mockCtx: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: { transform: vi.fn() },
      location: { root: '/test', workspace: '/test/workspace' },
    };

    await pluginDefault.setup(mockCtx);

    expect(mockCtx.catalog.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.tool.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.command.transform).toHaveBeenCalledTimes(1);
    expect(mockCtx.session.hook).toHaveBeenCalled();
  });
});

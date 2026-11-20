import { describe, it, expect, vi } from 'vitest';
import pluginDefault, { setup } from '../../index';

describe('index entrypoint — V2-only, one account per provider', () => {
  it('exports a V2 plugin object with a stable id and setup function', () => {
    expect(pluginDefault).toBeDefined();
    expect(pluginDefault.id).toBe('kpihx.agy');
    expect(typeof pluginDefault.setup).toBe('function');
    expect(pluginDefault.setup).toBe(setup);
  });

  it('has no V1 dual surface (no .server, no multi-account exports)', () => {
    expect((pluginDefault as any).server).toBeUndefined();
  });

  it('registers provider + integration + model + aisdk for each configured id', async () => {
    const transforms: Record<string, any> = {};
    const providerTransform = vi.fn((fn: any) => { transforms.provider = fn; });
    const integrationTransform = vi.fn((fn: any) => { transforms.integration = fn; });
    const modelTransform = vi.fn((fn: any) => { transforms.model = fn; });
    const hook = vi.fn();
    const mockCtx: any = {
      options: { ids: ['agy', 'agy-labs'] },
      provider: { transform: providerTransform },
      integration: { transform: integrationTransform },
      model: { transform: modelTransform },
      aisdk: { hook },
      event: { subscribe: async function* () {} },
      location: { root: '/test' },
    };

    const cleanup = await pluginDefault.setup(mockCtx);
    expect(typeof cleanup).toBe('function');
    cleanup();

    expect(providerTransform).toHaveBeenCalledTimes(2);
    expect(integrationTransform).toHaveBeenCalledTimes(2);
    // The catalog is loaded before the transforms, then published through the
    // same ctx.model.transform + editor.update path the kernel mirror uses.
    expect(modelTransform).toHaveBeenCalledTimes(2);
    // No dead aisdk hook: request shaping lives in session http.request/http.response.
    expect(hook).not.toHaveBeenCalled();
  });

  it('defaults to ["agy", "agy-labs"] when options.ids is absent', async () => {
    const providerTransform = vi.fn();
    await pluginDefault.setup({
      options: {},
      provider: { transform: providerTransform },
      integration: { transform: vi.fn() },
      model: { transform: vi.fn() },
      aisdk: { hook: vi.fn() },
      event: { subscribe: async function* () {} },
    } as any);
    expect(providerTransform).toHaveBeenCalledTimes(2);
  });

  it('exposes an OAuth method registration for each integration id', async () => {
    let integrationFn: any;
    await pluginDefault.setup({
      options: { ids: ['agy'] },
      provider: { transform: vi.fn() },
      integration: { transform: (fn: any) => { integrationFn = fn; } },
      model: { transform: vi.fn() },
      aisdk: { hook: vi.fn() },
      event: { subscribe: async function* () {} },
    } as any);

    const update = vi.fn();
    const editor: any = { update, method: { update: vi.fn() } };
    integrationFn(editor);
    expect(editor.method.update).toHaveBeenCalledTimes(1);
    const reg = editor.method.update.mock.calls[0][0];
    expect(reg.integrationID).toBe('agy');
    expect(reg.method.type).toBe('oauth');
    expect(typeof reg.authorize).toBe('function');
    expect(typeof reg.refresh).toBe('function');
  });
});

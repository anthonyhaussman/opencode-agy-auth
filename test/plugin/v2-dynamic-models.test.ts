import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/dynamic-models', () => ({ loadAccountModels: vi.fn() }));

import { loadAccountModels } from '../../src/plugin/dynamic-models';
import { setupOpenCodeV2 } from '../../src/plugin/v2';

const model = (name: string) => ({ name, description: name, maxTokens: 1000, maxOutputTokens: 100, toolCall: true, reasoning: false, attachment: false });
const connection = { type: 'credential', id: 'account-a' };
const inventory = (id: string, name: string) => ({ connection, models: { [id]: model(name) }, enums: {} });

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('OpenCode v2 model discovery', () => {
  it('does not block plugin setup while discovery is pending', async () => {
    vi.mocked(loadAccountModels).mockReturnValue(new Promise(() => {}));
    const ctx: any = {
      provider: { transform: vi.fn(), reload: vi.fn() },
      model: { transform: vi.fn(), reload: vi.fn() },
      integration: { transform: vi.fn(), connection: { active: vi.fn() } },
      tool: { transform: vi.fn() }, command: { transform: vi.fn() },
      session: { hook: vi.fn() }, location: {},
    };
    const result = await Promise.race([
      setupOpenCodeV2(ctx).then(cleanup => ({ completed: true, cleanup })),
      new Promise<{ completed: false }>(resolve => setTimeout(() => resolve({ completed: false }), 100)),
    ]);
    expect(result.completed).toBe(true);
    if ('cleanup' in result && typeof result.cleanup === 'function') result.cleanup();
  });

  it('registers account models, preserves configured models, refreshes and stops on cleanup', async () => {
    vi.useFakeTimers();
    vi.mocked(loadAccountModels)
      .mockResolvedValueOnce(inventory('first', 'First'))
      .mockResolvedValueOnce(inventory('second', 'Second'));
    let transform: (editor: any) => Promise<void> | void = () => {};
    const reload = vi.fn();
    const ctx: any = {
      provider: { transform: vi.fn(), reload },
      model: { transform: (fn: typeof transform) => { transform = fn; }, reload },
      integration: { transform: vi.fn(), connection: { active: vi.fn().mockResolvedValue(connection) } },
      tool: { transform: vi.fn() }, command: { transform: vi.fn() },
      session: { hook: vi.fn() }, location: {},
    };
    const cleanup = await setupOpenCodeV2(ctx);
    await vi.advanceTimersByTimeAsync(0);
    const updates: string[] = [];
    const remove = vi.fn();
    await transform({ update: (_provider: string, id: string) => updates.push(id), remove });
    expect(updates).toEqual(['first']);
    expect(remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300000);
    expect(reload).toHaveBeenCalledTimes(2);
    updates.length = 0;
    await transform({ update: (_provider: string, id: string) => updates.push(id), remove });
    expect(updates).toEqual(['second']);
    if (typeof cleanup === 'function') cleanup();
    await vi.advanceTimersByTimeAsync(300000);
    expect(loadAccountModels).toHaveBeenCalledTimes(2);
  });

  it('retains the last successful inventory when a refresh fails', async () => {
    vi.useFakeTimers();
    vi.mocked(loadAccountModels).mockResolvedValueOnce(inventory('first', 'First')).mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let transform: (editor: any) => Promise<void> | void = () => {};
    const reload = vi.fn();
    const ctx: any = {
      provider: { transform: vi.fn(), reload },
      model: { transform: (fn: typeof transform) => { transform = fn; }, reload },
      integration: { transform: vi.fn(), connection: { active: vi.fn().mockResolvedValue(connection) } },
      tool: { transform: vi.fn() }, command: { transform: vi.fn() },
      session: { hook: vi.fn() }, location: {},
    };
    const cleanup = await setupOpenCodeV2(ctx);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300000);
    const updates: string[] = [];
    await transform({ update: (_provider: string, id: string) => updates.push(id) });
    expect(updates).toEqual(['first']);
    expect(reload).toHaveBeenCalledOnce();
    if (typeof cleanup === 'function') cleanup();
    vi.restoreAllMocks();
  });

  it('does not publish a discovery result after the active account changes', async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof inventory>) => void;
    vi.mocked(loadAccountModels).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const active = vi.fn().mockResolvedValue({ type: 'credential', id: 'account-b' });
    const reload = vi.fn();
    const ctx: any = {
      provider: { transform: vi.fn(), reload },
      model: { transform: vi.fn(), reload: vi.fn() },
      integration: { transform: vi.fn(), connection: { active } },
      tool: { transform: vi.fn() }, command: { transform: vi.fn() },
      session: { hook: vi.fn() }, location: {},
    };
    const cleanup = await setupOpenCodeV2(ctx);
    finish(inventory('first', 'First'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    if (typeof cleanup === 'function') cleanup();
  });

  it('binds the discovered provider source to the account connection', async () => {
    vi.useFakeTimers();
    vi.mocked(loadAccountModels).mockResolvedValueOnce(inventory('first', 'First'));
    let providerTransform: (editor: any) => Promise<void> | void = () => {};
    const ctx: any = {
      provider: { transform: (fn: typeof providerTransform) => { providerTransform = fn; }, reload: vi.fn() },
      model: { transform: vi.fn(), reload: vi.fn() },
      integration: { transform: vi.fn(), connection: { active: vi.fn().mockResolvedValue(connection) } },
      tool: { transform: vi.fn() }, command: { transform: vi.fn() },
      session: { hook: vi.fn() }, location: {},
    };
    const cleanup = await setupOpenCodeV2(ctx);
    await vi.advanceTimersByTimeAsync(0);
    const add = vi.fn();
    await providerTransform({ update: vi.fn(), get: () => ({ provider: { id: 'google-agy' }, models: new Map() }), add });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ sourceConnection: connection }));
    if (typeof cleanup === 'function') cleanup();
  });
});

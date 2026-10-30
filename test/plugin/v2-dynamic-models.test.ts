import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/dynamic-models', () => ({ loadAccountModels: vi.fn() }));

import { loadAccountModels } from '../../src/plugin/dynamic-models';
import { setupOpenCodeV2 } from '../../src/plugin/v2';

const model = (name: string) => ({ name, description: name, maxTokens: 1000, maxOutputTokens: 100, toolCall: true, reasoning: false, attachment: false });

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('OpenCode v2 model discovery', () => {
  it('registers account models, preserves configured models, refreshes and stops on cleanup', async () => {
    vi.useFakeTimers();
    vi.mocked(loadAccountModels)
      .mockResolvedValueOnce({ first: model('First') })
      .mockResolvedValueOnce({ second: model('Second') });
    let transform: (editor: any) => Promise<void> | void = () => {};
    const reload = vi.fn();
    const ctx: any = {
      provider: { transform: vi.fn() },
      model: { transform: (fn: typeof transform) => { transform = fn; }, reload },
      integration: { transform: vi.fn(), connection: { active: vi.fn() } },
      tool: { transform: vi.fn() }, command: { transform: vi.fn() },
      session: { hook: vi.fn() }, location: {},
    };
    const cleanup = await setupOpenCodeV2(ctx);
    const updates: string[] = [];
    const remove = vi.fn();
    await transform({ update: (_provider: string, id: string) => updates.push(id), remove });
    expect(updates).toEqual(['first']);
    expect(remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300000);
    expect(reload).toHaveBeenCalledOnce();
    updates.length = 0;
    await transform({ update: (_provider: string, id: string) => updates.push(id), remove });
    expect(updates).toEqual(['second']);
    if (typeof cleanup === 'function') cleanup();
    await vi.advanceTimersByTimeAsync(300000);
    expect(loadAccountModels).toHaveBeenCalledTimes(2);
  });

  it('retains the last successful inventory when a refresh fails', async () => {
    vi.useFakeTimers();
    vi.mocked(loadAccountModels).mockResolvedValueOnce({ first: model('First') }).mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let transform: (editor: any) => Promise<void> | void = () => {};
    const reload = vi.fn();
    const ctx: any = {
      provider: { transform: vi.fn() },
      model: { transform: (fn: typeof transform) => { transform = fn; }, reload },
      integration: { transform: vi.fn(), connection: { active: vi.fn() } },
      tool: { transform: vi.fn() }, command: { transform: vi.fn() },
      session: { hook: vi.fn() }, location: {},
    };
    const cleanup = await setupOpenCodeV2(ctx);
    await vi.advanceTimersByTimeAsync(300000);
    const updates: string[] = [];
    await transform({ update: (_provider: string, id: string) => updates.push(id) });
    expect(updates).toEqual(['first']);
    expect(reload).not.toHaveBeenCalled();
    if (typeof cleanup === 'function') cleanup();
    vi.restoreAllMocks();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sdk/fetch_models', () => ({ fetchAvailableModels: vi.fn() }));
vi.mock('../../src/plugin/v2-storage', () => ({ loadStoredAuthFromJson: vi.fn(), saveStoredAuthToJson: vi.fn() }));
vi.mock('../../src/plugin/project', () => ({ ensureProjectContext: vi.fn() }));
vi.mock('../../src/plugin/token', () => ({ refreshAccessToken: vi.fn() }));

import { fetchAvailableModels } from '../../src/sdk/fetch_models';
import { loadStoredAuthFromJson } from '../../src/plugin/v2-storage';
import { ensureProjectContext } from '../../src/plugin/project';
import { refreshAccessToken } from '../../src/plugin/token';
import { loadAccountModels } from '../../src/plugin/dynamic-models';

const inventory = {
  models: { chat: { displayName: 'Chat', model: 'MODEL_CHAT' } },
  agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['chat'] }] }],
};
const auth = { type: 'oauth' as const, access: 'fake-access', refresh: 'fake-refresh|user-project|managed-project', expires: Date.now() + 3600000 };
const context = (credential: typeof auth) => ({ integration: { connection: {
  active: vi.fn().mockResolvedValue({ type: 'credential', id: 'connection' }),
  resolve: vi.fn().mockResolvedValue({ type: 'credential', credential }),
} } });

beforeEach(() => vi.resetAllMocks());

describe('loadAccountModels', () => {
  it('uses the active connection and managed project to fetch its inventory', async () => {
    vi.mocked(fetchAvailableModels).mockResolvedValue(inventory);
    const ctx = context(auth);
    const result = await loadAccountModels(ctx);
    expect(Object.keys(result.models)).toEqual(['chat']);
    expect(result.enums).toEqual({ chat: 'MODEL_CHAT' });
    expect(fetchAvailableModels).toHaveBeenCalledWith('fake-access', 'managed-project', undefined, expect.any(AbortSignal));
    expect(loadStoredAuthFromJson).not.toHaveBeenCalled();
  });

  it('resolves the project for the active connection when necessary', async () => {
    vi.mocked(ensureProjectContext).mockResolvedValue({ auth, effectiveProjectId: 'resolved-project' });
    vi.mocked(fetchAvailableModels).mockResolvedValue(inventory);
    await loadAccountModels(context({ ...auth, refresh: 'fake-refresh' }));
    expect(fetchAvailableModels).toHaveBeenCalledWith('fake-access', 'resolved-project', undefined, expect.any(AbortSignal));
  });

  it('rejects missing OAuth credentials', async () => {
    vi.mocked(loadStoredAuthFromJson).mockReturnValue(undefined);
    await expect(loadAccountModels({})).rejects.toThrow('OAuth');
  });

  it('refreshes an expired access token', async () => {
    vi.mocked(refreshAccessToken).mockResolvedValue(auth);
    vi.mocked(fetchAvailableModels).mockResolvedValue(inventory);
    await loadAccountModels(context({ ...auth, refresh: 'expired-refresh|user-project|managed-project', expires: 1 }));
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchAvailableModels).toHaveBeenCalledWith('fake-access', 'managed-project', undefined, expect.any(AbortSignal));
  });

  it('does not use an expired token when refresh fails', async () => {
    vi.mocked(refreshAccessToken).mockResolvedValue(undefined);
    await expect(loadAccountModels(context({ ...auth, refresh: 'failed-refresh|user-project|managed-project', expires: 1 }))).rejects.toThrow('access token');
    expect(fetchAvailableModels).not.toHaveBeenCalled();
  });
});

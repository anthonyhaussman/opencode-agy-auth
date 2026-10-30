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
  models: { chat: { displayName: 'Chat' } },
  agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['chat'] }] }],
};
const auth = { type: 'oauth' as const, access: 'fake-access', refresh: 'fake-refresh|user-project|managed-project', expires: Date.now() + 3600000 };

beforeEach(() => vi.resetAllMocks());

describe('loadAccountModels', () => {
  it('uses the active connection and managed project to fetch its inventory', async () => {
    vi.mocked(fetchAvailableModels).mockResolvedValue(inventory);
    const ctx = { integration: { connection: { active: vi.fn().mockResolvedValue({ id: 'connection' }), resolve: vi.fn().mockResolvedValue({ type: 'credential', credential: auth }) } } };
    expect(Object.keys(await loadAccountModels(ctx))).toEqual(['chat']);
    expect(fetchAvailableModels).toHaveBeenCalledWith('fake-access', 'managed-project');
    expect(loadStoredAuthFromJson).not.toHaveBeenCalled();
  });

  it('falls back to stored auth and resolves the project when necessary', async () => {
    vi.mocked(loadStoredAuthFromJson).mockReturnValue({ ...auth, refresh: 'fake-refresh' });
    vi.mocked(ensureProjectContext).mockResolvedValue({ auth, effectiveProjectId: 'resolved-project' });
    vi.mocked(fetchAvailableModels).mockResolvedValue(inventory);
    await loadAccountModels({});
    expect(fetchAvailableModels).toHaveBeenCalledWith('fake-access', 'resolved-project');
  });

  it('rejects missing OAuth credentials', async () => {
    vi.mocked(loadStoredAuthFromJson).mockReturnValue(undefined);
    await expect(loadAccountModels({})).rejects.toThrow('OAuth');
  });

  it('refreshes an expired access token', async () => {
    vi.mocked(loadStoredAuthFromJson).mockReturnValue({ ...auth, refresh: 'expired-refresh|user-project|managed-project', expires: 1 });
    vi.mocked(refreshAccessToken).mockResolvedValue(auth);
    vi.mocked(fetchAvailableModels).mockResolvedValue(inventory);
    await loadAccountModels({});
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchAvailableModels).toHaveBeenCalledWith('fake-access', 'managed-project');
  });
});

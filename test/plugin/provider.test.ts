import { describe, it, expect, vi } from 'vitest';
import {
  resolveConfiguredProjectId,
  resolveConfiguredProjectIdFromConfig,
  resolveConfiguredProjectIdFromClient,
} from '../../src/plugin/provider.js';

describe('provider helpers', () => {
  it('resolves configured project ID from provider options, config, or provider', () => {
    expect(
      resolveConfiguredProjectId({
        provider: { id: 'google-agy', options: { projectId: 'p-prov' } } as any,
      })
    ).toBe('p-prov');

    expect(
      resolveConfiguredProjectId({
        configProjectId: 'p-cfg-id',
      })
    ).toBe('p-cfg-id');

    expect(
      resolveConfiguredProjectId({
        config: {
          provider: {
            'google-agy': {
              options: { projectId: 'p-conf' },
            },
          },
        } as any,
      })
    ).toBe('p-conf');

    expect(
      resolveConfiguredProjectId({
        env: { OPENCODE_AGY_PROJECT_ID: 'p-env' } as any,
      })
    ).toBe('p-env');

    expect(resolveConfiguredProjectId({ env: {} })).toBeUndefined();
  });

  it('resolves configured project ID from client', async () => {
    const clientMock = {
      config: {
        get: vi.fn().mockResolvedValue({
          data: {
            provider: {
              'google-agy': {
                options: { projectId: 'p-client' },
              },
            },
          },
        }),
      },
    };

    const id = await resolveConfiguredProjectIdFromClient(clientMock as any);
    expect(id).toBe('p-client');
  });
});

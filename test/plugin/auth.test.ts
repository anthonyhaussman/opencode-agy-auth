import { describe, it, expect } from 'vitest';
import {
  isOAuthAuth,
  parseRefreshParts,
  formatRefreshParts,
  accessTokenExpired,
} from '../../src/plugin/auth.js';

describe('plugin auth helpers', () => {
  it('identifies oauth auth objects', () => {
    expect(isOAuthAuth({ type: 'oauth', access: 'a', refresh: 'r', expires: 123 })).toBe(true);
    expect(isOAuthAuth({ type: 'basic', key: 'k' } as any)).toBe(false);
  });

  it('parses refresh parts', () => {
    expect(parseRefreshParts('')).toEqual({
      refreshToken: '',
      projectId: undefined,
      managedProjectId: undefined,
    });

    expect(parseRefreshParts('token1')).toEqual({
      refreshToken: 'token1',
      projectId: undefined,
      managedProjectId: undefined,
    });

    expect(parseRefreshParts('token1|proj1')).toEqual({
      refreshToken: 'token1',
      projectId: 'proj1',
      managedProjectId: undefined,
    });

    expect(parseRefreshParts('token1|proj1|managed1')).toEqual({
      refreshToken: 'token1',
      projectId: 'proj1',
      managedProjectId: 'managed1',
    });
  });

  it('formats refresh parts', () => {
    expect(
      formatRefreshParts({
        refreshToken: '',
        projectId: undefined,
        managedProjectId: undefined,
      })
    ).toBe('');

    expect(
      formatRefreshParts({
        refreshToken: 'token1',
        projectId: undefined,
        managedProjectId: undefined,
      })
    ).toBe('token1');

    expect(
      formatRefreshParts({
        refreshToken: 'token1',
        projectId: 'proj1',
        managedProjectId: undefined,
      })
    ).toBe('token1|proj1|');

    expect(
      formatRefreshParts({
        refreshToken: 'token1',
        projectId: 'proj1',
        managedProjectId: 'managed1',
      })
    ).toBe('token1|proj1|managed1');

    expect(
      formatRefreshParts({
        refreshToken: 'token1',
        projectId: undefined,
        managedProjectId: 'managed1',
      })
    ).toBe('token1||managed1');
  });

  it('checks if access token is expired with 60s buffer', () => {
    const now = Date.now();
    expect(
      accessTokenExpired({
        type: 'oauth',
        access: '',
        refresh: 'r',
        expires: now + 100000,
      })
    ).toBe(true);

    expect(
      accessTokenExpired({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: undefined as any,
      })
    ).toBe(true);

    expect(
      accessTokenExpired({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: now - 1000,
      })
    ).toBe(true);

    expect(
      accessTokenExpired({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: now + 30 * 1000, // within 60s window
      })
    ).toBe(true);

    expect(
      accessTokenExpired({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: now + 120 * 1000, // safe
      })
    ).toBe(false);
  });
});

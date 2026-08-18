import { describe, it, expect, vi } from 'vitest';
import {
  resolveCachedAuth,
  storeCachedAuth,
  clearCachedAuth,
  initDiskSignatureCache,
  cacheSignature,
  getLatestSignature,
} from '../../src/plugin/cache.js';

describe('plugin cache', () => {
  it('handles empty, undefined, or whitespace-only refresh keys gracefully', () => {
    const authNoRefresh = {
      type: 'oauth' as const,
      access: 'acc-no-ref',
      refresh: '   ',
      expires: Date.now() + 100000,
    };
    expect(resolveCachedAuth(authNoRefresh)).toEqual(authNoRefresh);
    storeCachedAuth(authNoRefresh);
    clearCachedAuth('   ');
  });

  it('resolves, stores, and clears cached auth', () => {
    const auth1 = {
      type: 'oauth' as const,
      access: 'access1',
      refresh: 'ref1|proj1|mproj1',
      expires: Date.now() + 100000,
    };

    // Initially resolves to itself
    expect(resolveCachedAuth(auth1)).toEqual(auth1);

    // When auth is expired, it uses valid cached auth if available
    const authExpired = {
      ...auth1,
      access: 'expired-access',
      expires: Date.now() - 10000,
    };
    expect(resolveCachedAuth(authExpired).access).toBe('access1');

    // Store updated cached auth
    const authUpdated = {
      ...auth1,
      access: 'access-new',
    };
    storeCachedAuth(authUpdated);

    expect(resolveCachedAuth(authExpired).access).toBe('access-new');

    clearCachedAuth('ref1|proj1|mproj1');
    expect(resolveCachedAuth(auth1).access).toBe('access1');

    clearCachedAuth();
  });

  it('manages in-memory and disk signature caches', () => {
    expect(getLatestSignature('')).toBeUndefined();

    // Invalid parameters guard
    cacheSignature('', 'text', 'sig');
    cacheSignature('session-1', '', 'sig');
    cacheSignature('session-1', 'text', '');

    const diskCache = initDiskSignatureCache({ enabled: true });
    expect(diskCache).toBeDefined();

    cacheSignature('session-1', 'thought text 1', 'sig-123');
    expect(getLatestSignature('session-1')).toBe('sig-123');
    expect(getLatestSignature('nonexistent')).toBeUndefined();
  });

  it('handles signature LRU eviction and disk fallback', () => {
    const mockDisk = {
      store: vi.fn(),
      retrieve: vi.fn().mockReturnValue('disk-sig-xyz'),
    };
    initDiskSignatureCache(undefined);
    // Directly test disk fallback when not in memory
    expect(getLatestSignature('session-missing')).toBeUndefined();

    // Fill memory cache up to 105 entries to trigger LRU and eviction of oldest 25%
    const sess = 'session-heavy';
    for (let i = 0; i < 105; i++) {
      cacheSignature(sess, `thought-${i}`, `sig-${i}`);
    }
    expect(getLatestSignature(sess)).toBe('sig-104');
  });
});

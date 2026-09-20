import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

import * as fs from 'fs';
import { loadStoredAuthFromJson, saveStoredAuthToJson, setStoredAuthOverrideForTesting } from '../../src/plugin/v2-storage';
import { AGY_PROVIDER_ID } from '../../src/constants';

describe('plugin/v2-storage', () => {
  beforeEach(() => {
    setStoredAuthOverrideForTesting(undefined);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setStoredAuthOverrideForTesting(undefined);
    vi.restoreAllMocks();
  });

  it('respects testing override', () => {
    try {
      const mockAuth = { access: 'test-token', refresh: 'test-refresh', expires: 12345 };
      setStoredAuthOverrideForTesting(mockAuth);
      expect(loadStoredAuthFromJson()).toEqual(mockAuth);
    } finally {
      setStoredAuthOverrideForTesting(undefined);
    }
  });

  it('safely skips saveStoredAuthToJson during testing/vitest', () => {
    expect(() => {
      saveStoredAuthToJson({ access: 'dummy', refresh: 'dummy', expires: 0 });
    }).not.toThrow();
  });

  it('loads stored auth from json file when override is undefined', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        [AGY_PROVIDER_ID]: { access: 'stored-access', refresh: 'stored-refresh', expires: 9999 }
      })
    );

    const auth = loadStoredAuthFromJson();
    expect(auth).toEqual({ access: 'stored-access', refresh: 'stored-refresh', expires: 9999 });
  });

  it('handles loadStoredAuthFromJson when file does not exist or read throws', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadStoredAuthFromJson()).toBeUndefined();

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('read error');
    });
    expect(loadStoredAuthFromJson()).toBeUndefined();
  });

  it('saves stored auth when environment allows it', () => {
    const origEnv = process.env.NODE_ENV;
    const origVitest = process.env.VITEST;
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;

      vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ other: { foo: 'bar' } }));

      saveStoredAuthToJson({ access: 'new-access', refresh: 'new-refresh', expires: 12345 });

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenContent = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenContent[AGY_PROVIDER_ID]).toEqual({
        type: 'oauth',
        refresh: 'new-refresh',
        access: 'new-access',
        expires: 12345
      });
      expect(writtenContent.other).toEqual({ foo: 'bar' });
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.VITEST = origVitest;
    }
  });

  it('handles saveStoredAuthToJson when directory does not exist and existing json is invalid', () => {
    const origEnv = process.env.NODE_ENV;
    const origVitest = process.env.VITEST;
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;

      vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined as any);
      vi.mocked(fs.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid-json{{{');

      saveStoredAuthToJson({ access: 'new-access', refresh: 'new-refresh', expires: 12345 });

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.VITEST = origVitest;
    }
  });
});

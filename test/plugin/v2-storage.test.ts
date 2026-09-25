import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    closeSync: vi.fn(actual.closeSync),
    openSync: vi.fn(actual.openSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
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
      vi.mocked(fs.openSync).mockReturnValue(42);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined as any);
      vi.mocked(fs.closeSync).mockReturnValue(undefined as any);
      vi.mocked(fs.renameSync).mockReturnValue(undefined as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ other: { foo: 'bar' } }));

      saveStoredAuthToJson({ access: 'new-access', refresh: 'new-refresh', expires: 12345 });

      expect(fs.openSync).toHaveBeenCalledWith(expect.any(String), 'wx', 0o600);
      expect(fs.writeFileSync).toHaveBeenCalledOnce();
      expect(fs.renameSync).toHaveBeenCalledOnce();
      const writtenContent = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(writtenContent[AGY_PROVIDER_ID]).toEqual({
        type: 'oauth',
        refresh: 'new-refresh',
        access: 'new-access',
        expires: 12345
      });
      expect(writtenContent.other).toEqual({ foo: 'bar' });
      expect(vi.mocked(fs.writeFileSync).mock.calls[0][2]).toMatchObject({ encoding: 'utf8' });
      expect(vi.mocked(fs.renameSync).mock.calls[0][1]).toMatch(/auth\.json$/);
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.VITEST = origVitest;
    }
  });

  it('creates its parent directory and fails without replacing corrupt auth json', () => {
    const origEnv = process.env.NODE_ENV;
    const origVitest = process.env.VITEST;
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;

      vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
      vi.mocked(fs.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValue('invalid-json{{{');

      expect(() => saveStoredAuthToJson({ access: 'new-access', refresh: 'new-refresh', expires: 12345 })).toThrow();

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.VITEST = origVitest;
    }
  });

  it('cleans up the temporary file and propagates an atomic replacement failure', () => {
    const origEnv = process.env.NODE_ENV;
    const origVitest = process.env.VITEST;
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(42);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined as any);
      vi.mocked(fs.closeSync).mockReturnValue(undefined as any);
      vi.mocked(fs.renameSync).mockImplementation(() => {
        throw new Error('rename failed');
      });
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined as any);

      expect(() => saveStoredAuthToJson({ access: 'new-access', refresh: 'new-refresh', expires: 12345 }))
        .toThrow('rename failed');
      expect(fs.unlinkSync).toHaveBeenCalledOnce();
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.VITEST = origVitest;
    }
  });

  it('does not remove a temporary file when exclusive creation fails', () => {
    const origEnv = process.env.NODE_ENV;
    const origVitest = process.env.VITEST;
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockImplementation(() => {
        throw new Error('EEXIST');
      });

      expect(() => saveStoredAuthToJson({ access: 'new-access', refresh: 'new-refresh', expires: 12345 }))
        .toThrow('EEXIST');
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.VITEST = origVitest;
    }
  });

  it('cleans up an owned temporary file when writing it fails', () => {
    const origEnv = process.env.NODE_ENV;
    const origVitest = process.env.VITEST;
    try {
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.openSync).mockReturnValue(42);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('ENOSPC');
      });
      vi.mocked(fs.closeSync).mockReturnValue(undefined as any);
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined as any);

      expect(() => saveStoredAuthToJson({ access: 'new-access', refresh: 'new-refresh', expires: 12345 }))
        .toThrow('ENOSPC');
      expect(fs.closeSync).toHaveBeenCalledWith(42);
      expect(fs.unlinkSync).toHaveBeenCalledOnce();
    } finally {
      process.env.NODE_ENV = origEnv;
      process.env.VITEST = origVitest;
    }
  });
});

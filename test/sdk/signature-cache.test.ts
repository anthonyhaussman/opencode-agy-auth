import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SignatureCache,
  createSignatureCache,
} from '../../src/sdk/cache/signature-cache.js';

describe('SignatureCache', () => {
  const tmpDir = path.join(os.tmpdir(), `sig-cache-test-${Date.now()}`);

  beforeEach(() => {
    vi.stubEnv('XDG_CONFIG_HOME', tmpDir);
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates signature cache with defaults and disabled state', () => {
    const disabledCache = createSignatureCache({
      enabled: false,
      memory_ttl_seconds: 60,
      disk_ttl_seconds: 3600,
      write_interval_seconds: 5,
    });
    expect(disabledCache).toBeNull();

    const enabledCache = createSignatureCache({
      enabled: true,
      memory_ttl_seconds: 60,
      disk_ttl_seconds: 3600,
      write_interval_seconds: 5,
    });
    expect(enabledCache).toBeInstanceOf(SignatureCache);
    enabledCache?.shutdown();
  });

  it('stores, retrieves, and checks signatures', () => {
    const cache = new SignatureCache({
      enabled: true,
      memory_ttl_seconds: 10,
      disk_ttl_seconds: 3600,
      write_interval_seconds: 5,
    });

    const key = SignatureCache.makeKey('sess-1', 'gemini-3.7-flash');
    expect(cache.retrieve(key)).toBeNull();
    expect(cache.has(key)).toBe(false);

    cache.store(key, 'sig-abc-123');
    expect(cache.has(key)).toBe(true);
    expect(cache.retrieve(key)).toBe('sig-abc-123');

    const stats = cache.getStats();
    expect(stats.memoryHits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.memoryEntries).toBe(1);
    expect(stats.dirty).toBe(true);

    cache.shutdown();
  });

  it('stores and retrieves full thinking chains', () => {
    const cache = new SignatureCache({
      enabled: true,
      memory_ttl_seconds: 10,
      disk_ttl_seconds: 3600,
      write_interval_seconds: 5,
    });

    const key = SignatureCache.makeKey('sess-2', 'gemini-3.7-flash');
    cache.storeThinking(key, 'detailed thinking thought chain', 'sig-thought-456', ['tool_call_1']);

    expect(cache.hasThinking(key)).toBe(true);
    const thinking = cache.retrieveThinking(key);
    expect(thinking).toEqual({
      text: 'detailed thinking thought chain',
      signature: 'sig-thought-456',
      toolIds: ['tool_call_1'],
    });

    cache.shutdown();
  });

  it('handles TTL expiration', async () => {
    const cache = new SignatureCache({
      enabled: true,
      memory_ttl_seconds: 0.05, // 50ms
      disk_ttl_seconds: 0.1,
      write_interval_seconds: 1,
    });

    const key = SignatureCache.makeKey('sess-3', 'gemini-3.7-flash');
    cache.storeThinking(key, 'thought', 'sig-xyz');

    expect(cache.has(key)).toBe(true);
    expect(cache.hasThinking(key)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(cache.has(key)).toBe(false);
    expect(cache.hasThinking(key)).toBe(false);
    expect(cache.retrieve(key)).toBeNull();
    expect(cache.retrieveThinking(key)).toBeNull();

    cache.shutdown();
  });

  it('flushes to disk, creates .gitignore, and reloads data', async () => {
    const cache1 = new SignatureCache({
      enabled: true,
      memory_ttl_seconds: 60,
      disk_ttl_seconds: 3600,
      write_interval_seconds: 60,
    });

    const key = SignatureCache.makeKey('sess-disk', 'model-1');
    cache1.storeThinking(key, 'disk thought', 'sig-disk-1', ['t1']);
    await cache1.flush();
    cache1.shutdown();

    const gitignorePath = path.join(tmpDir, 'opencode', '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignoreContent).toContain('antigravity-signature-cache.json');

    const cache2 = new SignatureCache({
      enabled: true,
      memory_ttl_seconds: 60,
      disk_ttl_seconds: 3600,
      write_interval_seconds: 60,
    });

    expect(cache2.hasThinking(key)).toBe(true);
    expect(cache2.retrieveThinking(key)).toEqual({
      text: 'disk thought',
      signature: 'sig-disk-1',
      toolIds: ['t1'],
    });

    cache2.shutdown();
  });

  it('does nothing when disabled', async () => {
    const disabledCache = new SignatureCache({
      enabled: false,
      memory_ttl_seconds: 60,
      disk_ttl_seconds: 3600,
      write_interval_seconds: 5,
    });

    const key = 'test-key';
    disabledCache.store(key, 'sig');
    disabledCache.storeThinking(key, 'thought', 'sig');

    expect(disabledCache.has(key)).toBe(false);
    expect(disabledCache.retrieve(key)).toBeNull();
    expect(disabledCache.hasThinking(key)).toBe(false);
    expect(disabledCache.retrieveThinking(key)).toBeNull();
    expect(await disabledCache.flush()).toBe(true);
    disabledCache.shutdown();
  });
});

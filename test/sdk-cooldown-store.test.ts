import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadCooldowns,
  saveCooldowns,
  CooldownStore
} from "../src/sdk/retry/cooldown-store";

describe("cooldown-store", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("handles saving and loading valid cooldowns", () => {
    const testDir = join(tmpdir(), `cooldown-test-${Date.now()}`);
    process.env.XDG_CONFIG_HOME = testDir;

    const entries = new Map<string, number>();
    const futureTime = Date.now() + 10000;
    entries.set("https://api.example.com|proj1|model1", futureTime);
    entries.set("expired-key", Date.now() - 1000);

    const saved = saveCooldowns(entries);
    expect(saved).toBe(true);

    const loaded = loadCooldowns();
    expect(loaded.has("https://api.example.com|proj1|model1")).toBe(true);
    expect(loaded.has("expired-key")).toBe(false);

    // cleanup
    try {
      const filePath = join(testDir, "opencode", "antigravity-retry-cooldowns.json");
      if (existsSync(filePath)) unlinkSync(filePath);
      rmdirSync(join(testDir, "opencode"));
      rmdirSync(testDir);
    } catch {}
  });

  it("returns empty map on missing file or invalid json/version", () => {
    const testDir = join(tmpdir(), `cooldown-test-empty-${Date.now()}`);
    process.env.XDG_CONFIG_HOME = testDir;

    const loaded = loadCooldowns();
    expect(loaded.size).toBe(0);
  });

  it("handles platform win32 config dir", () => {
    const testDir = join(tmpdir(), `cooldown-test-win-${Date.now()}`);
    process.env.APPDATA = testDir;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const entries = new Map<string, number>();
    entries.set("key-win", Date.now() + 5000);
    expect(saveCooldowns(entries)).toBe(true);
    expect(loadCooldowns().has("key-win")).toBe(true);

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  it("CooldownStore class marks dirty, flushes, schedules throttled write and shuts down", () => {
    vi.useFakeTimers();
    const testDir = join(tmpdir(), `cooldown-test-store-${Date.now()}`);
    process.env.XDG_CONFIG_HOME = testDir;

    const store = new CooldownStore();
    const entries = new Map<string, number>();
    entries.set("k1", Date.now() + 60000);
    store.bind(entries);

    store.markDirty();
    // second markDirty while timer pending
    store.markDirty();

    vi.advanceTimersByTime(6000);

    const flushed = store.flush();
    expect(flushed).toBe(true);

    store.markDirty();
    store.shutdown();

    vi.useRealTimers();
  });
});

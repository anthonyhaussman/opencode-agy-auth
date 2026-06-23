import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";

interface CooldownData {
  version: "1.0";
  entries: Record<string, number>;
  updatedAt: number;
}

const WRITE_THROTTLE_MS = 5000;

function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

function getCooldownFilePath(): string {
  return join(getConfigDir(), "antigravity-retry-cooldowns.json");
}

export function loadCooldowns(): Map<string, number> {
  const result = new Map<string, number>();
  try {
    const filePath = getCooldownFilePath();
    if (!existsSync(filePath)) {
      return result;
    }

    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as CooldownData;
    if (data.version !== "1.0") {
      return result;
    }

    const now = Date.now();
    for (const [key, expiresAt] of Object.entries(data.entries)) {
      if (typeof expiresAt === "number" && expiresAt > now) {
        result.set(key, expiresAt);
      }
    }
  } catch {
    // Fault tolerance: start fresh on disk load failure
  }
  return result;
}

export function saveCooldowns(entries: Map<string, number>): boolean {
  try {
    const filePath = getCooldownFilePath();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const now = Date.now();
    const serializable: Record<string, number> = {};
    for (const [key, expiresAt] of entries.entries()) {
      if (expiresAt > now) {
        serializable[key] = expiresAt;
      }
    }

    const data: CooldownData = {
      version: "1.0",
      entries: serializable,
      updatedAt: now,
    };

    const tmpPath = join(tmpdir(), `antigravity-cooldowns-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(data), "utf-8");

    try {
      renameSync(tmpPath, filePath);
    } catch {
      writeFileSync(filePath, readFileSync(tmpPath));
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore temp file deletion failure
      }
    }

    return true;
  } catch {
    return false;
  }
}

export class CooldownStore {
  private dirty = false;
  private lastWriteTime = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private entries: Map<string, number> = new Map();

  bind(entries: Map<string, number>): void {
    this.entries = entries;
  }

  markDirty(): void {
    this.dirty = true;
    this.scheduleThrottledWrite();
  }

  flush(): boolean {
    this.dirty = false;
    this.clearWriteTimer();
    this.lastWriteTime = Date.now();
    return saveCooldowns(this.entries);
  }

  shutdown(): void {
    this.clearWriteTimer();
    if (this.dirty) {
      saveCooldowns(this.entries);
      this.dirty = false;
    }
  }

  private scheduleThrottledWrite(): void {
    if (this.writeTimer) {
      return;
    }

    const elapsed = Date.now() - this.lastWriteTime;
    const remaining = Math.max(0, WRITE_THROTTLE_MS - elapsed);

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.lastWriteTime = Date.now();
      if (this.dirty) {
        this.dirty = false;
        saveCooldowns(this.entries);
      }
    }, remaining);

    if (this.writeTimer && typeof this.writeTimer === "object" && "unref" in this.writeTimer) {
      this.writeTimer.unref();
    }
  }

  private clearWriteTimer(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";

// =============================================================================
/**
 * NOTE: Special Design - Cross-turn signature disk-level persistent cache
 * Google Agy / Gemini 2.5/3 thinking models introduce strict "Thought Signature Validation" restrictions:
 * In multi-turn dialogues (especially with Tool calls), the next request must carry a context signature (thoughtSignature) exactly matching the previous API response.
 * To avoid conversation crashes caused by the following:
 * 1. IDE-side session lifecycle rebuilds, causing loss of in-memory signature states.
 * 2. Concurrent packets from multi-turn Tool interactions disrupting the memory cache of signatures.
 * We implement a disk cache layer here with a background thread that periodically flushes to disk. Using a combination of session ID (sessionId) and historical thought chain hash digest as the Key,
 * it persists the signatures and thought chains. Even if the IDE restarts or turns split, it can pull back the latest matching signature to fulfill official validation constraints.
 */
// Types & Interfaces
// =============================================================================

/**
 * Signature cache configuration options
 */
export interface SignatureCacheConfig {
  /** Whether to enable caching */
  enabled: boolean;
  /** In-memory cache time-to-live (seconds) */
  memory_ttl_seconds: number;
  /** Disk cache time-to-live (seconds) */
  disk_ttl_seconds: number;
  /** Auto-save interval to disk (seconds) */
  write_interval_seconds: number;
}

/**
 * Single cached data entry
 */
interface CacheEntry {
  /** Cached value (e.g., signature) */
  value: string;
  /** Timestamp (milliseconds) */
  timestamp: number;
  /** Full thought chain text content (optional, for self-healing recovery after compression) */
  thinkingText?: string;
  /** Preview of thought chain text (for debug logs only) */
  textPreview?: string;
  /** List of tool call IDs associated with this thought chain block */
  toolIds?: string[];
}

/**
 * Complete cache structure saved to disk
 */
interface CacheData {
  /** Version number */
  version: "1.0";
  /** Memory TTL config */
  memory_ttl_seconds: number;
  /** Disk TTL config */
  disk_ttl_seconds: number;
  /** Cache entry mapping table */
  entries: Record<string, CacheEntry>;
  /** Statistics */
  statistics: {
    /** Memory hit count */
    memory_hits: number;
    /** Disk hit count */
    disk_hits: number;
    /** Miss count */
    misses: number;
    /** Disk write count */
    writes: number;
    /** Last disk write timestamp */
    last_write: number;
  };
}

/**
 * Cache runtime state and statistics
 */
interface CacheStats {
  /** Memory hit count */
  memoryHits: number;
  /** Disk hit count */
  diskHits: number;
  /** Miss count */
  misses: number;
  /** Disk write count */
  writes: number;
  /** Total number of entries currently in memory */
  memoryEntries: number;
  /** Whether the cache is dirty (has unsaved data) */
  dirty: boolean;
  /** Whether disk storage is enabled */
  diskEnabled: boolean;
}

/**
 * Retrieve full thought chain cache data structure
 */
export interface ThinkingCacheData {
  /** Thought chain text */
  text: string;
  /** Signature */
  signature: string;
  /** Associated tool ID list */
  toolIds?: string[];
}

// =============================================================================
// Path & Storage Utilities
// =============================================================================

/**
 * Get plugin config save directory
 */
function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Get absolute path for saving cache file
 */
function getCacheFilePath(): string {
  return join(getConfigDir(), "antigravity-signature-cache.json");
}

/**
 * Synchronously ensure the config file is added to .gitignore to avoid leaking signatures and cache
 */
function ensureGitignoreSync(configDir: string): void {
  const gitignorePath = join(configDir, ".gitignore");
  const entries = [".gitignore", "antigravity-signature-cache.json"];
  try {
    let content = "";
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
    }
    const existingLines = content.split("\n").map((line) => line.trim());
    const missing = entries.filter((e) => !existingLines.includes(e));
    if (missing.length === 0) return;
    if (content === "") {
      writeFileSync(gitignorePath, missing.join("\n") + "\n", "utf-8");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, suffix + missing.join("\n") + "\n", "utf-8");
    }
  } catch {
    // Ignore exception: anti-leakage is a non-blocking secondary feature
  }
}

// =============================================================================
// Signature Cache Manager
// =============================================================================

export class SignatureCache {
  // Memory cache map
  private cache: Map<string, CacheEntry> = new Map();

  // Configuration options
  private memoryTtlMs: number;
  private diskTtlMs: number;
  private writeIntervalMs: number;
  private cacheFilePath: string;
  private enabled: boolean;

  // State variables
  private dirty: boolean = false;
  private writeTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Statistical metrics
  private stats = {
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    writes: 0,
  };

  constructor(config: SignatureCacheConfig) {
    this.enabled = config.enabled;
    this.memoryTtlMs = config.memory_ttl_seconds * 1000;
    this.diskTtlMs = config.disk_ttl_seconds * 1000;
    this.writeIntervalMs = config.write_interval_seconds * 1000;
    this.cacheFilePath = getCacheFilePath();

    if (this.enabled) {
      this.loadFromDisk();
      this.startBackgroundTasks();
    }
  }

  // ===========================================================================
  // Public Signature API
  // ===========================================================================

  /**
   * Generates a unique cache key based on session ID and model ID
   */
  static makeKey(sessionId: string, modelId: string): string {
    return `${sessionId}:${modelId}`;
  }

  /**
   * Stores a signature in cache (marks as dirty, awaits background disk write)
   */
  store(key: string, signature: string): void {
    if (!this.enabled) return;

    this.cache.set(key, {
      value: signature,
      timestamp: Date.now(),
    });
    this.dirty = true;
  }

  /**
   * Retrieves a signature from cache and updates hit stats
   * Returns null if expired or missing
   */
  retrieve(key: string): string | null {
    if (!this.enabled) return null;

    const entry = this.cache.get(key);
    if (entry) {
      const age = Date.now() - entry.timestamp;
      if (age <= this.memoryTtlMs) {
        this.stats.memoryHits++;
        return entry.value;
      }
      // Expired in memory, delete
      this.cache.delete(key);
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Checks if a key is valid and unexpired in cache (without affecting stats)
   */
  has(key: string): boolean {
    if (!this.enabled) return false;

    const entry = this.cache.get(key);
    if (!entry) return false;

    const age = Date.now() - entry.timestamp;
    return age <= this.memoryTtlMs;
  }

  // ===========================================================================
  // Full Thinking Cache API
  // ===========================================================================

  /**
   * Caches the full thought chain text content and signature
   * Allows self-healing and recovery of historical thought blocks even if the context is subsequently compressed.
   */
  storeThinking(
    key: string,
    thinkingText: string,
    signature: string,
    toolIds?: string[],
  ): void {
    if (!this.enabled || !thinkingText || !signature) return;

    this.cache.set(key, {
      value: signature,
      timestamp: Date.now(),
      thinkingText,
      textPreview: thinkingText.slice(0, 100),
      toolIds,
    });
    this.dirty = true;
  }

  /**
   * Extracts full thought chain info from cache
   */
  retrieveThinking(key: string): ThinkingCacheData | null {
    if (!this.enabled) return null;

    const entry = this.cache.get(key);
    if (!entry || !entry.thinkingText) return null;

    const age = Date.now() - entry.timestamp;
    if (age > this.memoryTtlMs) {
      this.cache.delete(key);
      return null;
    }

    this.stats.memoryHits++;
    return {
      text: entry.thinkingText,
      signature: entry.value,
      toolIds: entry.toolIds,
    };
  }

  /**
   * Checks if full thought chain content exists for a key
   */
  hasThinking(key: string): boolean {
    if (!this.enabled) return false;

    const entry = this.cache.get(key);
    if (!entry || !entry.thinkingText) return false;

    const age = Date.now() - entry.timestamp;
    return age <= this.memoryTtlMs;
  }

  /**
   * Gets current cache stats and memory footprint
   */
  getStats(): CacheStats {
    return {
      ...this.stats,
      memoryEntries: this.cache.size,
      dirty: this.dirty,
      diskEnabled: this.enabled,
    };
  }

  /**
   * Manually triggers immediate save to disk
   */
  async flush(): Promise<boolean> {
    if (!this.enabled) return true;
    return this.saveToDisk();
  }

  /**
   * Graceful shutdown: stops all timers and flushes unsaved data to disk
   */
  shutdown(): void {
    if (this.writeTimer) {
      clearInterval(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.dirty && this.enabled) {
      this.saveToDisk();
    }
  }

  // ===========================================================================
  // Disk Operations
  // ===========================================================================

  /**
   * Loads signature cache from disk and validates TTL state
   */
  private loadFromDisk(): void {
    try {
      if (!existsSync(this.cacheFilePath)) {
        return;
      }

      const content = readFileSync(this.cacheFilePath, "utf-8");
      const data = JSON.parse(content) as CacheData;

      if (data.version !== "1.0") {
        // On version mismatch, silently ignore and start a fresh cache
        return;
      }

      const now = Date.now();
      for (const [key, entry] of Object.entries(data.entries)) {
        const age = now - entry.timestamp;
        if (age <= this.diskTtlMs) {
          this.cache.set(key, {
            value: entry.value,
            timestamp: entry.timestamp,
            thinkingText: entry.thinkingText,
            textPreview: entry.textPreview,
            toolIds: entry.toolIds,
          });
        }
      }
    } catch {
      // Fault tolerance: silently start fresh memory cache on disk load failure
    }
  }

  /**
   * Synchronously saves memory cache to disk (using atomic write: temp file then rename)
   * Merges with existing unexpired entries on disk during write
   */
  private saveToDisk(): boolean {
    try {
      const dir = dirname(this.cacheFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      ensureGitignoreSync(dir);

      const now = Date.now();

      // Step 1: Read existing disk entries
      let existingEntries: Record<string, CacheEntry> = {};
      if (existsSync(this.cacheFilePath)) {
        try {
          const content = readFileSync(this.cacheFilePath, "utf-8");
          const data = JSON.parse(content) as CacheData;
          existingEntries = data.entries || {};
        } catch {
          // Fault tolerance: overwrite if malformed or corrupted
        }
      }

      // Step 2: Filter expired disk entries
      const validDiskEntries: Record<string, CacheEntry> = {};
      for (const [key, entry] of Object.entries(existingEntries)) {
        const age = now - entry.timestamp;
        if (age <= this.diskTtlMs) {
          validDiskEntries[key] = entry;
        }
      }

      // Step 3: Overwrite or merge memory cache into valid disk entries (memory data is newest, highest priority)
      const mergedEntries: Record<string, CacheEntry> = { ...validDiskEntries };
      for (const [key, entry] of this.cache.entries()) {
        mergedEntries[key] = {
          value: entry.value,
          timestamp: entry.timestamp,
          thinkingText: entry.thinkingText,
          textPreview: entry.textPreview,
          toolIds: entry.toolIds,
        };
      }

      // Step 4: Build persistent structure
      const cacheData: CacheData = {
        version: "1.0",
        memory_ttl_seconds: this.memoryTtlMs / 1000,
        disk_ttl_seconds: this.diskTtlMs / 1000,
        entries: mergedEntries,
        statistics: {
          memory_hits: this.stats.memoryHits,
          disk_hits: this.stats.diskHits,
          misses: this.stats.misses,
          writes: this.stats.writes + 1,
          last_write: now,
        },
      };

      // Step 5: Atomic write (write to temp file, rename to finalize, preventing data corruption)
      const tmpPath = join(tmpdir(), `antigravity-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      writeFileSync(tmpPath, JSON.stringify(cacheData, null, 2), "utf-8");

      try {
        renameSync(tmpPath, this.cacheFilePath);
      } catch {
        // Cross-volume rename on Windows might fail, fallback to copy + delete
        writeFileSync(this.cacheFilePath, readFileSync(tmpPath));
        try {
          unlinkSync(tmpPath);
        } catch {
          // Ignore temp file deletion failure
        }
      }

      this.stats.writes++;
      this.dirty = false;
      return true;
    } catch {
      // Disk writing is non-core, fail silently
      return false;
    }
  }

  // ===========================================================================
  // Background Tasks
  // ===========================================================================

  /**
   * Starts timers for auto-saving and auto-cleaning expired memory entries
   */
  private startBackgroundTasks(): void {
    // Periodic disk write (if modified)
    this.writeTimer = setInterval(() => {
      if (this.dirty) {
        this.saveToDisk();
      }
    }, this.writeIntervalMs);

    // Perform memory garbage collection every 30 mins to free unused space
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 30 * 60 * 1000);
  }

  /**
   * Removes memory cache entries exceeding their TTL
   */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp;
      if (age > this.memoryTtlMs) {
        this.cache.delete(key);
      }
    }
  }
}

// =============================================================================
// Factory function
// =============================================================================

/**
 * Instantiates signature cache object based on config. Returns null if disabled.
 */
export function createSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null {
  if (!config || !config.enabled) {
    return null;
  }
  return new SignatureCache(config);
}

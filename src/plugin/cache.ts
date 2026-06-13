import { createHash } from "node:crypto";
import { accessTokenExpired } from "./auth";
import type { OAuthAuthDetails } from "./types";
import { SignatureCache, createSignatureCache, type SignatureCacheConfig } from "../sdk/cache/signature-cache";

// In-memory cache of authorized account details.
const authCache = new Map<string, OAuthAuthDetails>();

/**
 * Normalizes and trims whitespace from the refresh token string.
 */
function normalizeRefreshKey(refresh?: string): string | undefined {
  const key = refresh?.trim();
  return key ? key : undefined;
}

/**
 * Extracts valid OAuthAuthDetails from cache. Reuses an available and unexpired Token if present, otherwise prioritizes the latest provided value.
 */
export function resolveCachedAuth(auth: OAuthAuthDetails): OAuthAuthDetails {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return auth;
  }

  const cached = authCache.get(key);
  if (!cached) {
    authCache.set(key, auth);
    return auth;
  }

  if (!accessTokenExpired(auth)) {
    authCache.set(key, auth);
    return auth;
  }

  if (!accessTokenExpired(cached)) {
    return cached;
  }

  authCache.set(key, auth);
  return auth;
}

/**
 * Explicitly updates or saves authorized token details to the cache.
 */
export function storeCachedAuth(auth: OAuthAuthDetails): void {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return;
  }
  authCache.set(key, auth);
}

/**
 * Clears cached login authorization details. If no refresh token is provided, clears the global cache.
 */
export function clearCachedAuth(refresh?: string): void {
  if (!refresh) {
    authCache.clear();
    return;
  }
  const key = normalizeRefreshKey(refresh);
  if (key) {
    authCache.delete(key);
  }
}

// ============================================================================
// Thinking signature cache layer (supports self-healing alignment of Gemini and Claude signature states in multi-turn dialogues).
// ============================================================================

interface SignatureEntry {
  signature: string;
  timestamp: number;
}

// In-memory cache layer: sessionId -> Map<textHash, SignatureEntry>
const signatureCache = new Map<string, Map<string, SignatureEntry>>();

// Cache validity period set to 1 hour.
const SIGNATURE_CACHE_TTL_MS = 60 * 60 * 1000;

// Maximum cache size per session to prevent memory leaks when left open for a long time.
const MAX_ENTRIES_PER_SESSION = 100;

// Use the first 16 hex characters of the sha256 result as the textHash key width.
const SIGNATURE_TEXT_HASH_HEX_LEN = 16;

// Disk-level persistent cache instance.
let diskCache: SignatureCache | null = null;

/**
 * Initializes the disk-level signature storage manager.
 */
export function initDiskSignatureCache(config: SignatureCacheConfig | undefined): SignatureCache | null {
  diskCache = createSignatureCache(config);
  return diskCache;
}

/**
 * Calculates a stable sha256 hash of the thought chain content, taking the first 16 characters as the unique key.
 */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, SIGNATURE_TEXT_HASH_HEX_LEN);
}

/**
 * Builds the composite primary key sessionId:textHash on disk storage.
 */
function makeDiskKey(sessionId: string, textHash: string): string {
  return `${sessionId}:${textHash}`;
}

// Latest signature mapping: sessionId -> most recent signature string.
const latestSignatureMap = new Map<string, string>();

/**
 * Caches a thought chain fragment and its corresponding service signature, synchronously saving it to disk.
 */
export function cacheSignature(sessionId: string, text: string, signature: string): void {
  if (!sessionId || !text || !signature) return;

  const textHash = hashText(text);

  let sessionMemCache = signatureCache.get(sessionId);
  if (!sessionMemCache) {
    sessionMemCache = new Map();
    signatureCache.set(sessionId, sessionMemCache);
  }

  // When capacity limit is exceeded, trigger LRU cleanup of expired entries.
  if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
    const now = Date.now();
    for (const [key, entry] of sessionMemCache.entries()) {
      if (now - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
        sessionMemCache.delete(key);
      }
    }
    // If still over the limit, discard the oldest 25% of entries by timestamp.
    if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
      const entries = Array.from(sessionMemCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, Math.floor(MAX_ENTRIES_PER_SESSION / 4));
      for (const [key] of toRemove) {
        sessionMemCache.delete(key);
      }
    }
  }

  sessionMemCache.set(textHash, { signature, timestamp: Date.now() });
  latestSignatureMap.set(sessionId, signature);

  // If disk persistence is enabled, write to disk synchronously.
  if (diskCache) {
    const diskKey = makeDiskKey(sessionId, textHash);
    diskCache.store(diskKey, signature);
    // Also store the latest signature value directly using sessionId as the key, for global signature recovery without textHash.
    diskCache.store(sessionId, signature);
  }
}

/**
 * Recovers and retrieves the most recently cached signature for a session (supports signature recovery).
 */
export function getLatestSignature(sessionId: string): string | undefined {
  if (!sessionId) return undefined;

  // Prioritize retrieval from in-memory cache.
  const memValue = latestSignatureMap.get(sessionId);
  if (memValue) return memValue;

  // In-memory miss, fallback to disk query.
  if (diskCache) {
    const diskValue = diskCache.retrieve(sessionId);
    if (diskValue) {
      // Automatically promote to in-memory Map after read, accelerating subsequent queries.
      latestSignatureMap.set(sessionId, diskValue);
      return diskValue;
    }
  }

  return undefined;
}

export type { SignatureCache } from "../sdk/cache/signature-cache";
export type { SignatureCacheConfig } from "../sdk/cache/signature-cache";

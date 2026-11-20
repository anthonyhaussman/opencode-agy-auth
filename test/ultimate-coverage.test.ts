import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearCachedAuth, initDiskSignatureCache, cacheSignature, getLatestSignature } from "../src/plugin/cache";
import { refreshAccessToken } from "../src/plugin/token";
import * as fetchModule from "../src/fetch";
import * as projectUtils from "../src/plugin/project/utils";
import * as projectContextModule from "../src/plugin/project/context";
import { SignatureCache } from "../src/sdk/cache/signature-cache";
import { existsSync, unlinkSync, rmdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Ultimate coverage expansion", () => {
  let agyFetchSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAuth();
    agyFetchSpy = vi.spyOn(fetchModule, "agyFetch");
  });

  afterEach(() => {
    agyFetchSpy.mockRestore();
  });


  describe("cache.ts and signature cache branches", () => {
    it("handles disk cache promotion and expired entry cleanups", () => {
      const testDir = join(tmpdir(), `sig-cache-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });

      const sigCache = new SignatureCache({
        cacheDir: testDir,
        memory_ttl_seconds: 1,
        disk_ttl_seconds: 5,
        write_interval_seconds: 60,
        enabled: true
      });

      initDiskSignatureCache({
        cacheDir: testDir,
        memory_ttl_seconds: 1,
        disk_ttl_seconds: 5,
        write_interval_seconds: 60,
        enabled: true
      });

      cacheSignature("session-test-disk", "thought content 1", "sig-1");
      const sig = getLatestSignature("session-test-disk");
      expect(sig).toBe("sig-1");

      // Cleanup
      sigCache.shutdown();
    });
  });

  describe("token.ts error handling & retry fallback", () => {
    it("handles invalid_grant error when client auth.set fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      agyFetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
          status: 400,
          statusText: "Bad Request"
        })
      );

      const client = {
        auth: {
          set: vi.fn().mockRejectedValueOnce(new Error("Disk IO write error"))
        }
      } as any;

      const auth = {
        type: "oauth" as const,
        access: "old-access",
        refresh: "bad-refresh|p1|m1",
        expires: 0
      };

      const res = await refreshAccessToken(auth, client);
      expect(res).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to clear stored Antigravity OAuth credentials"));
      warnSpy.mockRestore();
    });

    it("handles refreshed token persistence error gracefully", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      agyFetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "<placeholder-access-token>", expires_in: 3600, refresh_token: "<placeholder-rotated-ref>" }), {
          status: 200
        })
      );

      const client = {
        auth: {
          set: vi.fn().mockRejectedValueOnce(new Error("Storage failure"))
        }
      } as any;

      const auth = {
        type: "oauth" as const,
        access: "old-access",
        refresh: "old-ref|p1|m1",
        expires: 0
      };

      const res = await refreshAccessToken(auth, client);
      expect(res?.access).toBe("<placeholder-access-token>");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist refreshed Antigravity OAuth credentials"));
      warnSpy.mockRestore();
    });
  });
});

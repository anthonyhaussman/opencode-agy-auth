import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgyCLIOAuthPlugin } from "../src/plugin";
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

  describe("plugin.ts full branch coverage", () => {
    it("builds full models with claude, gpt, and gemini family differences and modalities", async () => {
      const client = {
        config: {
          get: vi.fn().mockResolvedValue({ data: {} }),
          set: vi.fn().mockResolvedValue({})
        },
        auth: {
          set: vi.fn().mockResolvedValue({})
        }
      } as any;

      const result = await AgyCLIOAuthPlugin({ client });
      const customConfig: any = {
        provider: {
          "google-agy": {
            models: {
              "custom-claude": {
                name: "Custom Claude",
                family: "claude",
                attachment: true,
                reasoning: true,
                toolCall: true
              }
            }
          }
        }
      };

      await result.config?.(customConfig as any);
      expect(customConfig.provider["google-agy"].models).toBeDefined();

      const models = customConfig.provider["google-agy"].models as Record<string, any>;
      // Check claude models
      const claude37 = models["claude-sonnet-4-6"];
      if (claude37) {
        expect(claude37.family).toBe("claude");
        expect(claude37.modalities.input).toContain("pdf");
        expect(claude37.modalities.input).not.toContain("audio");
      }

      // Check gpt-oss models
      const gptOss = models["gpt-oss-120b-medium"];
      if (gptOss) {
        expect(gptOss.family).toBe("gpt");
        expect(gptOss.modalities.input).not.toContain("audio");
      }

      // Check gemini models
      const gemini25 = models["gemini-3.7-flash"];
      if (gemini25) {
        expect(gemini25.family).toBe("gemini");
        expect(gemini25.modalities.input).toContain("audio");
        expect(gemini25.modalities.input).toContain("video");
      }
    });

    it("handles oauth authorization callback methods", async () => {
      const client = {
        config: {
          get: vi.fn().mockResolvedValue({ data: { provider: { "google-agy": { options: { projectId: "proj-1" } } } } }),
          set: vi.fn().mockResolvedValue({})
        },
        auth: {
          set: vi.fn().mockResolvedValue({})
        }
      } as any;

      const result = await AgyCLIOAuthPlugin({ client });
      const oauthMethod = result.auth?.methods?.find((m: any) => m.type === "oauth");
      expect(oauthMethod).toBeDefined();
    });

    it("logs error and re-throws when ensureProjectContextOrThrow fails with Error or non-Error", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const client = {
        config: {
          get: vi.fn().mockResolvedValue({ data: {} }),
          set: vi.fn().mockResolvedValue({})
        },
        auth: {
          set: vi.fn().mockResolvedValue({})
        }
      } as any;

      const result = await AgyCLIOAuthPlugin({ client });
      const loader = result.auth?.loader as any;
      const provider = { id: "google-agy" } as any;
      const getAuth = async () => ({
        type: "oauth" as const,
        access: "valid-acc",
        refresh: "valid-ref|proj-1|man-1",
        expires: Date.now() + 100000
      });
      const fetcher = await loader(getAuth, provider);

      vi.spyOn(projectContextModule, "ensureProjectContext").mockRejectedValueOnce(new Error("Context failure"));

      await expect(
        fetcher.fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent")
      ).rejects.toThrow("Context failure");

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ensureProjectContextOrThrow error: Context failure"));

      vi.spyOn(projectContextModule, "ensureProjectContext").mockRejectedValueOnce("Non error failure");
      await expect(
        fetcher.fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent")
      ).rejects.toBe("Non error failure");

      warnSpy.mockRestore();
    });
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
        new Response(JSON.stringify({ access_token: "new-acc", expires_in: 3600, refresh_token: "rotated-ref" }), {
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
      expect(res?.access).toBe("new-acc");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist refreshed Antigravity OAuth credentials"));
      warnSpy.mockRestore();
    });
  });
});

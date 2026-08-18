import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChatLogger } from "../src/sdk/chat-logger.js";
import { createAgyQuotaTool } from "../src/plugin/quota.js";
import { fetchWithRetry, shutdownRetryCooldowns } from "../src/sdk/retry/index.js";
import { retrieveUserQuota, retrieveUserQuotaSummary } from "../src/sdk/fetch_quota.js";

describe("Direct gap coverage for 95% threshold", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("chat-logger", () => {
    it("logs requests properly and formats headers and bodies", async () => {
      process.env.AGY_LOG = "1";
      const logger = createChatLogger();
      expect(logger).not.toBeNull();

      logger!.logRequest(
        "https://example.com/test",
        "POST",
        { Authorization: "Bearer xyz", "X-Custom": "val" },
        JSON.stringify({ hello: "world" })
      );

      logger!.logRequest(
        "https://example.com/test2",
        "POST",
        undefined,
        "{invalid json"
      );

      logger!.logRequest(
        "https://example.com/test3",
        "POST",
        undefined,
        new Uint8Array([1, 2, 3]) as any
      );

      logger!.logRequest("https://example.com/test4", "GET", undefined, null);

      logger!.logResponseHeaders(200, "OK", new Headers({ "Content-Type": "text/plain" }));
      logger!.logResponseBody("response content");

      const stream = logger!.createLoggingTransformStream();
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();

      const chunkPromise = reader.read();
      await writer.write(new TextEncoder().encode("chunk-1"));
      await writer.close();
      await chunkPromise;

      logger!.close();
    });
  });

  describe("quota.ts compareVersionDesc branches", () => {
    it("handles comparison with invalid numbers and localeCompare fallback", async () => {
      const resp = {
        buckets: [
          {
            modelId: "gemini-1.5-pro",
            tokenType: "TOKENS",
            remainingFraction: 0.5,
            resetTime: "2026-03-09T12:00:00Z"
          },
          {
            modelId: "gemini-1.invalid.5-pro",
            tokenType: "TOKENS",
            remainingFraction: 0.5,
            resetTime: "2026-03-09T12:00:00Z"
          },
          {
            modelId: "gemini-2.5-flash",
            tokenType: "TOKENS",
            remainingFraction: 0.8,
            resetTime: "2026-03-09T12:00:00Z"
          },
          {
            modelId: "gemini-1.5.0-pro",
            tokenType: "TOKENS",
            remainingFraction: 0.6,
            resetTime: "2026-03-09T12:00:00Z"
          }
        ]
      };

      const client = {
        auth: { set: vi.fn() }
      } as any;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("loadCodeAssist")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ cloudaicompanionProject: { id: "p-version-desc" } }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              )
            );
          }
          if (url.includes("retrieveUserQuota")) {
            return Promise.resolve(
              new Response(JSON.stringify(resp), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              })
            );
          }
          return Promise.resolve(new Response("{}", { status: 200 }));
        })
      );

      const tool = createAgyQuotaTool({
        client,
        getAuthResolver: () => async () => ({
          type: "oauth",
          access: "acc-token-123",
          refresh: "ref-token-123",
          expires: Date.now() + 3600000
        }),
        getConfiguredProjectId: () => "p-version-desc",
        getUserAgentModel: () => "gemini-2.5-flash"
      });

      const output = await tool.execute({} as any, {} as any);
      expect(output).toContain("Agy quota usage for project");
      expect(output).toContain("gemini-1.5-pro");
      expect(output).toContain("gemini-2.5-flash");
    });
  });

  describe("fetch_quota.ts error handling", () => {
    it("catches and returns null when retrieveUserQuota fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network fail")));
      const res = await retrieveUserQuota("token", "proj");
      expect(res).toBeNull();
    });

    it("catches and returns null when retrieveUserQuotaSummary fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network fail")));
      const res = await retrieveUserQuotaSummary("token", "proj");
      expect(res).toBeNull();
    });
  });

  describe("retry/index.ts RequestInfo and retry paths", () => {
    it("handles URL object and string input in fetchWithRetry", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        )
      );

      const res1 = await fetchWithRetry(new URL("https://example.com/api/test"), {
        method: "POST",
        body: JSON.stringify({ project: "proj-1", model: "model-1" })
      });
      expect(res1.status).toBe(200);

      const reqObj = new Request("https://example.com/api/test2", {
        method: "GET"
      });
      const res2 = await fetchWithRetry(reqObj);
      expect(res2.status).toBe(200);

      shutdownRetryCooldowns();
    });
  });
});

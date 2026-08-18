import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { createChatLogger } from "../src/sdk/chat-logger";
import { fetchAvailableModels } from "../src/sdk/fetch_models";
import { loadManagedProject, onboardManagedProject } from "../src/sdk/fetch_project";
import { retrieveUserQuota, retrieveUserQuotaSummary } from "../src/sdk/fetch_quota";
import { authorizeAgy, exchangeAgyWithVerifier } from "../src/sdk/oauth";
import * as fetchModule from "../src/fetch";
import { ProjectAccessDeniedError, ProjectIdRequiredError } from "../src/plugin/project/types";

describe("sdk/chat-logger and fetch_* modules and oauth", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("chat-logger", () => {
    it("returns null if AGY_LOG is not 1", () => {
      process.env.AGY_LOG = "0";
      expect(createChatLogger()).toBeNull();
    });

    it("creates logger, logs requests, responses, streams, and closes properly", async () => {
      process.env.AGY_LOG = "1";
      const logger = createChatLogger();
      expect(logger).not.toBeNull();

      if (logger) {
        // Request with authorization header to verify redaction
        logger.logRequest(
          "https://api.example.com/test",
          "POST",
          { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
          JSON.stringify({ test: "data" })
        );

        // Request with non-string and null bodies
        logger.logRequest("https://api.example.com/get", "GET", undefined, null);
        logger.logRequest("https://api.example.com/raw", "POST", undefined, new Uint8Array([1, 2, 3]));

        // Response headers & body
        logger.logResponseHeaders(200, "OK", new Headers({ "x-test": "val" }));
        logger.logResponseBody(JSON.stringify({ result: "ok" }));

        // TransformStream
        const transform = logger.createLoggingTransformStream();
        const readable = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("stream-chunk-1"));
            controller.close();
          }
        });
        const piped = readable.pipeThrough(transform);
        const reader = piped.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }

        logger.close();
      }
    });
  });

  describe("fetch_models", () => {
    it("fetches available models successfully", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            models: { "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash" } },
            defaultAgentModelId: "gemini-3.7-flash"
          }),
          { status: 200 }
        )
      );

      const res = await fetchAvailableModels("fake-token", "fake-project");
      expect(res.defaultAgentModelId).toBe("gemini-3.7-flash");
      expect(res.models?.["gemini-3.7-flash"]?.displayName).toBe("Gemini 3.7 Flash");
    });

    it("throws detailed error if response is not ok", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
        new Response("Access Denied Details", { status: 403, statusText: "Forbidden" })
      );

      await expect(fetchAvailableModels("fake-token", "fake-project")).rejects.toThrow(
        "Google API returned status 403 Forbidden: Access Denied Details"
      );
    });
  });

  describe("fetch_project", () => {
    it("loads managed project successfully", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            cloudaicompanionProject: "managed-proj-123"
          }),
          { status: 200 }
        )
      );

      const res = await loadManagedProject("fake-token", "user-proj");
      expect(res?.cloudaicompanionProject).toBe("managed-proj-123");
    });

    it("throws ProjectAccessDeniedError on 403 / 404 response", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
        new Response("VPC-SC blocked request", { status: 403, statusText: "Forbidden" })
      );

      await expect(loadManagedProject("fake-token", "blocked-proj")).rejects.toThrow(
        ProjectAccessDeniedError
      );
    });

    it("returns null on 500 error", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockRejectedValue(new Error("500 Server Error"));

      const res = await loadManagedProject("fake-token", "proj");
      expect(res).toBeNull();
    });

    it("onboards managed project with immediate completion", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            done: true,
            response: {
              cloudaicompanionProject: { id: "onboarded-id" }
            }
          }),
          { status: 200 }
        )
      );

      const id = await onboardManagedProject("fake-token", "free-tier", "proj-1");
      expect(id).toBe("onboarded-id");
    });

    it("onboards managed project with polling operation", async () => {
      let callCount = 0;
      vi.spyOn(fetchModule, "agyFetch").mockImplementation(async (url) => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              done: false,
              name: "operations/123"
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            done: true,
            response: {
              cloudaicompanionProject: { id: "polled-id" }
            }
          }),
          { status: 200 }
        );
      });

      const id = await onboardManagedProject("fake-token", "free-tier", "proj-1", undefined, 2, 1);
      expect(id).toBe("polled-id");
    });

    it("throws ProjectIdRequiredError if not free tier and no project id", async () => {
      await expect(onboardManagedProject("fake-token", "paid-tier", undefined)).rejects.toThrow(
        ProjectIdRequiredError
      );
    });
  });

  describe("fetch_quota", () => {
    it("retrieves user quota successfully", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
        new Response(JSON.stringify({ buckets: [{ modelId: "m1" }] }), { status: 200 })
      );

      const res = await retrieveUserQuota("token", "proj");
      expect(res).toEqual({ buckets: [{ modelId: "m1" }] });
    });

    it("returns null on failed quota fetch", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(new Response("error", { status: 500 }));
      expect(await retrieveUserQuota("token", "proj")).toBeNull();
    });

    it("retrieves user quota summary successfully", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
        new Response(JSON.stringify({ userQuotaSummary: { groups: [] } }), { status: 200 })
      );

      const res = await retrieveUserQuotaSummary("token", "proj");
      expect(res).toEqual({ userQuotaSummary: { groups: [] } });
    });

    it("returns null on failed quota summary fetch", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(new Response("error", { status: 500 }));
      expect(await retrieveUserQuotaSummary("token", "proj")).toBeNull();
    });
  });

  describe("oauth", () => {
    it("generates authorize URL with PKCE and state", async () => {
      const auth = await authorizeAgy();
      expect(auth.url).toContain("accounts.google.com");
      expect(auth.url).toContain("code_challenge=");
      expect(auth.verifier).toBeDefined();
      expect(auth.state).toBeDefined();
    });

    it("exchanges code for tokens successfully", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockImplementation(async (url) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "access-123",
              expires_in: 3600,
              refresh_token: "refresh-123"
            }),
            { status: 200 }
          );
        }
        if (String(url).includes("googleapis.com/oauth2/v1/userinfo")) {
          return new Response(
            JSON.stringify({
              email: "test@example.com"
            }),
            { status: 200 }
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const res = await exchangeAgyWithVerifier("test-code", "test-verifier");
      expect(res.type).toBe("success");
      if (res.type === "success") {
        expect(res.access).toBe("access-123");
        expect(res.refresh).toBe("refresh-123");
        expect(res.email).toBe("test@example.com");
      }
    });

    it("returns failure when token exchange fails", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
        new Response("invalid_grant", { status: 400 })
      );

      const res = await exchangeAgyWithVerifier("bad-code", "bad-verifier");
      expect(res.type).toBe("failed");
      if (res.type === "failed") {
        expect(res.error).toBe("invalid_grant");
      }
    });

    it("returns failure when refresh token is missing", async () => {
      vi.spyOn(fetchModule, "agyFetch").mockImplementation(async (url) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              access_token: "access-123",
              expires_in: 3600
            }),
            { status: 200 }
          );
        }
        if (String(url).includes("googleapis.com/oauth2/v1/userinfo")) {
          return new Response(JSON.stringify({ email: "test@example.com" }), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const res = await exchangeAgyWithVerifier("code", "verifier");
      expect(res.type).toBe("failed");
      if (res.type === "failed") {
        expect(res.error).toContain("Missing refresh token");
      }
    });
  });
});

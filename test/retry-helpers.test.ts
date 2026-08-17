import { describe, expect, it } from "vitest";
import {
  canRetryRequest,
  isRetryableStatus,
  isRetryableNetworkError,
  resolveRetryDelayMs,
} from "../src/sdk/retry/helpers";

describe("retry helpers", () => {
  describe("canRetryRequest", () => {
    it("allows retrying when no init or no body", () => {
      expect(canRetryRequest(undefined)).toBe(true);
      expect(canRetryRequest({})).toBe(true);
    });

    it("allows retrying string and URLSearchParams bodies", () => {
      expect(canRetryRequest({ body: "test payload" })).toBe(true);
      expect(canRetryRequest({ body: new URLSearchParams({ q: "test" }) })).toBe(true);
    });

    it("allows retrying ArrayBuffer bodies", () => {
      const buffer = new ArrayBuffer(8);
      expect(canRetryRequest({ body: buffer })).toBe(true);
      expect(canRetryRequest({ body: new Uint8Array(buffer) })).toBe(true);
    });
  });

  describe("isRetryableStatus", () => {
    it("returns true for 429", () => {
      expect(isRetryableStatus(429)).toBe(true);
    });

    it("returns true for 5xx server errors", () => {
      expect(isRetryableStatus(500)).toBe(true);
      expect(isRetryableStatus(502)).toBe(true);
      expect(isRetryableStatus(503)).toBe(true);
      expect(isRetryableStatus(504)).toBe(true);
      expect(isRetryableStatus(599)).toBe(true);
    });

    it("returns false for 2xx and 4xx other than 429", () => {
      expect(isRetryableStatus(200)).toBe(false);
      expect(isRetryableStatus(400)).toBe(false);
      expect(isRetryableStatus(401)).toBe(false);
      expect(isRetryableStatus(404)).toBe(false);
    });
  });

  describe("isRetryableNetworkError", () => {
    it("recognizes ECONNRESET and ETIMEDOUT", () => {
      const err = new Error("connection reset");
      (err as any).code = "ECONNRESET";
      expect(isRetryableNetworkError(err)).toBe(true);
    });

    it("recognizes nested cause code", () => {
      const rootErr = new Error("fetch failed");
      const cause = new Error("timeout");
      (cause as any).code = "ETIMEDOUT";
      (rootErr as any).cause = cause;
      expect(isRetryableNetworkError(rootErr)).toBe(true);
    });

    it("recognizes generic 'fetch failed' error messages", () => {
      expect(isRetryableNetworkError(new Error("TypeError: fetch failed"))).toBe(true);
    });

    it("returns false for non-network errors", () => {
      expect(isRetryableNetworkError(new Error("SyntaxError: Unexpected token"))).toBe(false);
    });
  });

  describe("resolveRetryDelayMs", () => {
    it("prioritizes retry-after-ms header", async () => {
      const response = new Response("{}", {
        headers: {
          "retry-after-ms": "1500",
          "retry-after": "5",
        },
      });
      const delay = await resolveRetryDelayMs(response, 1);
      expect(delay).toBe(1500);
    });

    it("parses retry-after in seconds", async () => {
      const response = new Response("{}", {
        headers: {
          "retry-after": "3",
        },
      });
      const delay = await resolveRetryDelayMs(response, 1);
      expect(delay).toBe(3000);
    });

    it("respects quotaDelayMs parameter when headers are absent", async () => {
      const response = new Response("{}", {});
      const delay = await resolveRetryDelayMs(response, 1, 4500);
      expect(delay).toBe(4500);
    });
  });
});

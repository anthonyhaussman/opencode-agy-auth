import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchWithRetry,
  initCooldownPersistence,
  shutdownRetryCooldowns
} from "../src/sdk/retry/index";
import * as helpers from "../src/sdk/retry/helpers";
import * as fetchModule from "../src/fetch";

describe("sdk/retry/index", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(helpers, "wait").mockResolvedValue();
  });

  afterEach(() => {
    shutdownRetryCooldowns();
  });

  it("calls agyFetch directly when request cannot be retried (e.g. streaming or GET with body)", async () => {
    const fetchSpy = vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await fetchWithRetry("https://api.example.com", { method: "POST" });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable network errors and succeeds", async () => {
    let callCount = 0;
    vi.spyOn(fetchModule, "agyFetch").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new TypeError("fetch failed");
      }
      return new Response("ok", { status: 200 });
    });

    const res = await fetchWithRetry("https://api.example.com", {
      method: "POST",
      body: JSON.stringify({ project: "p1", model: "m1" })
    });
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it("throws immediately on unretryable network error", async () => {
    vi.spyOn(fetchModule, "agyFetch").mockRejectedValue(new Error("Fatal custom error"));

    await expect(
      fetchWithRetry("https://api.example.com", {
        method: "POST",
        body: JSON.stringify({ project: "p1", model: "m1" })
      })
    ).rejects.toThrow("Fatal custom error");
  });

  it("handles 429 quota exhaustion (terminal)", async () => {
    vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                domain: "cloudcode-pa.googleapis.com",
                reason: "QUOTA_EXHAUSTED"
              }
            ]
          }
        }),
        { status: 429 }
      )
    );

    const res = await fetchWithRetry("https://api.example.com", {
      method: "POST",
      body: JSON.stringify({ project: "p1", model: "m1" })
    });
    expect(res.status).toBe(429);
  });

  it("handles 429 retryable rate limit with Retry-After header and cooldown", async () => {
    let callCount = 0;
    vi.spyOn(fetchModule, "agyFetch").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  domain: "cloudcode-pa.googleapis.com",
                  reason: "RATE_LIMIT_EXCEEDED"
                }
              ]
            }
          }),
          {
            status: 429,
            headers: { "retry-after-ms": "10" }
          }
        );
      }
      return new Response("success", { status: 200 });
    });

    const res = await fetchWithRetry("https://api.example.com/endpoint", {
      method: "POST",
      body: JSON.stringify({ project: "p1", model: "m1" })
    });
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it("handles Request and URL objects as input", async () => {
    vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(new Response("ok", { status: 200 }));

    const resUrl = await fetchWithRetry(new URL("https://api.example.com/v1"), {
      method: "POST",
      body: JSON.stringify({ project: "p1" })
    });
    expect(resUrl.status).toBe(200);

    const reqObj = new Request("https://api.example.com/v2", {
      method: "POST",
      body: JSON.stringify({ project: "p1" })
    });
    const resReq = await fetchWithRetry(reqObj, undefined);
    expect(resReq.status).toBe(200);
  });

  it("respects already aborted signal in retry loop", async () => {
    const controller = new AbortController();
    controller.abort();

    vi.spyOn(fetchModule, "agyFetch").mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(
      fetchWithRetry("https://api.example.com", {
        method: "POST",
        body: JSON.stringify({ project: "p1" }),
        signal: controller.signal
      })
    ).rejects.toThrow();
  });
});

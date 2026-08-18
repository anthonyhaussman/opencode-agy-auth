import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canRetryRequest,
  isRetryableStatus,
  isRetryableNetworkError,
  resolveRetryDelayMs,
  getExponentialDelayWithJitter,
  wait,
} from "../../src/sdk/retry/helpers";
import * as quotaModule from "../../src/sdk/retry/quota";

describe("retry helpers additional coverage", () => {
  it("canRetryRequest handles various body types", () => {
    expect(canRetryRequest(undefined)).toBe(true);
    expect(canRetryRequest({})).toBe(true);
    expect(canRetryRequest({ body: "test" })).toBe(true);
    expect(canRetryRequest({ body: new URLSearchParams("a=1") })).toBe(true);
    expect(canRetryRequest({ body: new ArrayBuffer(8) })).toBe(true);
    expect(canRetryRequest({ body: new Uint8Array([1, 2, 3]) })).toBe(true);
    expect(canRetryRequest({ body: new Blob(["data"]) })).toBe(true);
    expect(canRetryRequest({ body: {} as any })).toBe(false);
  });

  it("isRetryableStatus identifies retryable statuses", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(600)).toBe(false);
  });

  it("isRetryableNetworkError traverses nested causes", () => {
    const errorWithDirectCode = { code: "ECONNRESET" };
    expect(isRetryableNetworkError(errorWithDirectCode)).toBe(true);

    const errorWithNestedCause = {
      cause: {
        cause: {
          code: "ETIMEDOUT",
        },
      },
    };
    expect(isRetryableNetworkError(errorWithNestedCause)).toBe(true);

    const errorWithNonRetryableCode = { code: "SOME_OTHER_CODE" };
    expect(isRetryableNetworkError(errorWithNonRetryableCode)).toBe(false);

    expect(isRetryableNetworkError(new Error("request fetch failed unexpectedly"))).toBe(true);
    expect(isRetryableNetworkError(new Error("regular application error"))).toBe(false);
    expect(isRetryableNetworkError(null)).toBe(false);
    expect(isRetryableNetworkError(undefined)).toBe(false);
    expect(isRetryableNetworkError(123)).toBe(false);
  });

  it("resolveRetryDelayMs parses retry-after headers in seconds or HTTP date", async () => {
    const respWithMs = new Response("{}", {
      headers: { "retry-after-ms": "2500" },
    });
    expect(await resolveRetryDelayMs(respWithMs, 1)).toBe(2500);

    const respWithSec = new Response("{}", {
      headers: { "Retry-After": "4" },
    });
    expect(await resolveRetryDelayMs(respWithSec, 1)).toBe(4000);

    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const respWithDate = new Response("{}", {
      headers: { "Retry-After": futureDate },
    });
    const delay = await resolveRetryDelayMs(respWithDate, 1);
    expect(delay).toBeGreaterThanOrEqual(1000);

    const respInvalidDate = new Response("{}", {
      headers: { "Retry-After": "invalid-date-string" },
    });
    const fallbackDelay = await resolveRetryDelayMs(respInvalidDate, 1);
    expect(fallbackDelay).toBeGreaterThan(0);
  });

  it("resolveRetryDelayMs parses quotaDelayMs or body delay", async () => {
    const resp = new Response("{}", { headers: {} });
    expect(await resolveRetryDelayMs(resp, 1, 3500)).toBe(3500);

    vi.spyOn(quotaModule, "parseRetryDelayFromBody").mockResolvedValueOnce(6000);
    expect(await resolveRetryDelayMs(resp, 1)).toBe(6000);
  });

  it("getExponentialDelayWithJitter produces positive clamped delay", () => {
    const d1 = getExponentialDelayWithJitter(1);
    expect(d1).toBeGreaterThanOrEqual(0);
    expect(d1).toBeLessThanOrEqual(30000);

    const d10 = getExponentialDelayWithJitter(10);
    expect(d10).toBeLessThanOrEqual(30000);
  });

  it("wait delays resolution", async () => {
    const start = Date.now();
    await wait(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });
});

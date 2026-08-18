import { describe, it, expect, vi } from "vitest";
import {
  classifyQuotaResponse,
  parseRetryDelayFromBody,
  findResetTimeForModel,
  resolveQuotaResetDelay,
  MAX_QUOTA_RESET_WAIT_MS,
  retryInternals,
} from "../src/sdk/retry/quota";
import * as fetchQuotaModule from "../src/sdk/fetch_quota";
import type { RetrieveUserQuotaSummaryResponse } from "../src/plugin/project/types";

describe("sdk/retry/quota", () => {
  it("parses retry delay values correctly", () => {
    expect(retryInternals.parseRetryDelayValue("")).toBeNull();
    expect(retryInternals.parseRetryDelayValue("500ms")).toBe(500);
    expect(retryInternals.parseRetryDelayValue("2.5s")).toBe(2500);
    expect(retryInternals.parseRetryDelayValue("invalid")).toBeNull();
    expect(retryInternals.parseRetryDelayValue({ seconds: 3, nanos: 500000000 })).toBe(3500);
    expect(retryInternals.parseRetryDelayValue({ seconds: NaN })).toBeNull();
  });

  it("parses retry delay from message string", () => {
    expect(retryInternals.parseRetryDelayFromMessage("Please retry in 3.5s.")).toBe(3500);
    expect(retryInternals.parseRetryDelayFromMessage("Rate exceeded, after 400ms try again")).toBe(400);
    expect(retryInternals.parseRetryDelayFromMessage("No delay specified")).toBeNull();
  });

  it("returns null for non-JSON or invalid error response in classifyQuotaResponse and parseRetryDelayFromBody", async () => {
    const resNonJson = new Response("not-json", { status: 429 });
    expect(await classifyQuotaResponse(resNonJson)).toBeNull();
    expect(await parseRetryDelayFromBody(resNonJson)).toBeNull();

    const resEmpty = new Response("", { status: 429 });
    expect(await classifyQuotaResponse(resEmpty)).toBeNull();
    expect(await parseRetryDelayFromBody(resEmpty)).toBeNull();
  });

  it("parses retry delay from body with RetryInfo or message", async () => {
    const resWithInfo = new Response(
      JSON.stringify({
        error: {
          message: "Too Many Requests",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "4s"
            }
          ]
        }
      }),
      { status: 429 }
    );
    expect(await parseRetryDelayFromBody(resWithInfo)).toBe(4000);

    const resWithMessageOnly = new Response(
      JSON.stringify({
        error: {
          message: "Please retry in 1.2s"
        }
      }),
      { status: 429 }
    );
    expect(await parseRetryDelayFromBody(resWithMessageOnly)).toBe(1200);
  });

  it("classifies error with domain check, QUOTA_EXHAUSTED, RATE_LIMIT_EXCEEDED, MODEL_CAPACITY_EXHAUSTED", async () => {
    // Non-cloudcode domain
    const resForeignDomain = new Response(
      JSON.stringify({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              domain: "foreign.googleapis.com",
              reason: "QUOTA_EXHAUSTED"
            }
          ]
        }
      }),
      { status: 429 }
    );
    expect(await classifyQuotaResponse(resForeignDomain)).toBeNull();

    // QUOTA_EXHAUSTED (terminal)
    const resExhausted = new Response(
      JSON.stringify({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              domain: "daily-cloudcode-pa.googleapis.com",
              reason: "QUOTA_EXHAUSTED"
            }
          ]
        }
      }),
      { status: 429 }
    );
    const resExhaustedResult = await classifyQuotaResponse(resExhausted);
    expect(resExhaustedResult?.terminal).toBe(true);
    expect(resExhaustedResult?.reason).toBe("QUOTA_EXHAUSTED");

    // RATE_LIMIT_EXCEEDED (non-terminal)
    const resRateLimit = new Response(
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
      { status: 429 }
    );
    const resRateLimitResult = await classifyQuotaResponse(resRateLimit);
    expect(resRateLimitResult?.terminal).toBe(false);
    expect(resRateLimitResult?.retryDelayMs).toBe(10000);

    // MODEL_CAPACITY_EXHAUSTED with delay
    const resModelCap = new Response(
      JSON.stringify({
        error: {
          message: "Please retry in 5s",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              domain: "staging-cloudcode-pa.googleapis.com",
              reason: "MODEL_CAPACITY_EXHAUSTED"
            }
          ]
        }
      }),
      { status: 429 }
    );
    const resModelCapResult = await classifyQuotaResponse(resModelCap);
    expect(resModelCapResult?.terminal).toBe(false);
    expect(resModelCapResult?.retryDelayMs).toBe(5000);

    // MODEL_CAPACITY_EXHAUSTED without delay (terminal)
    const resModelCapNoDelay = new Response(
      JSON.stringify({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              domain: "cloudaicompanion.googleapis.com",
              reason: "MODEL_CAPACITY_EXHAUSTED"
            }
          ]
        }
      }),
      { status: 429 }
    );
    const resModelCapNoDelayResult = await classifyQuotaResponse(resModelCapNoDelay);
    expect(resModelCapNoDelayResult?.terminal).toBe(true);
  });

  it("classifies QuotaFailure violations (daily vs perminute)", async () => {
    // daily violation -> terminal
    const resDaily = new Response(
      JSON.stringify({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [
                { quotaId: "DailyQuotaPerUser", description: "PerDay limit reached" }
              ]
            }
          ]
        }
      }),
      { status: 429 }
    );
    expect((await classifyQuotaResponse(resDaily))?.terminal).toBe(true);

    // per minute violation -> non-terminal
    const resMinute = new Response(
      JSON.stringify({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [
                { quotaId: "RequestsPerMinute", description: "Per minute limit reached" }
              ]
            }
          ]
        }
      }),
      { status: 429 }
    );
    expect((await classifyQuotaResponse(resMinute))?.terminal).toBe(false);

    // other violation -> non-terminal
    const resOther = new Response(
      JSON.stringify({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [
                { quotaId: "OtherLimit", description: "Some other limit" }
              ]
            }
          ]
        }
      }),
      { status: 429 }
    );
    expect((await classifyQuotaResponse(resOther))?.terminal).toBe(false);
  });

  it("classifies metadata quota_limit containing perminute", async () => {
    const resMeta = new Response(
      JSON.stringify({
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              metadata: {
                quota_limit: "RequestsPerMinutePerProject"
              }
            }
          ]
        }
      }),
      { status: 429 }
    );
    const resMetaResult = await classifyQuotaResponse(resMeta);
    expect(resMetaResult?.terminal).toBe(false);
    expect(resMetaResult?.retryDelayMs).toBe(60000);
  });

  it("handles array envelope for error JSON", async () => {
    const resArrayEnvelope = new Response(
      JSON.stringify([
        {
          error: {
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "RATE_LIMIT_EXCEEDED"
              }
            ]
          }
        }
      ]),
      { status: 429 }
    );
    expect((await classifyQuotaResponse(resArrayEnvelope))?.reason).toBe("RATE_LIMIT_EXCEEDED");
  });

  describe("findResetTimeForModel", () => {
    it("returns null if summary is null or undefined", () => {
      expect(findResetTimeForModel(null)).toBeNull();
      expect(findResetTimeForModel(undefined)).toBeNull();
    });

    it("returns null if no buckets have future reset times", () => {
      const pastSummary: RetrieveUserQuotaSummaryResponse = {
        buckets: [
          { resetTime: new Date(Date.now() - 100000).toISOString(), window: "FIVE_HOUR" },
          { resetTime: "invalid-date", window: "FIVE_HOUR" },
          { window: "FIVE_HOUR" },
        ],
      };
      expect(findResetTimeForModel(pastSummary)).toBeNull();
    });

    it("prioritizes exhausted FIVE_HOUR bucket matching model", () => {
      const futureReset = new Date(Date.now() + 300000).toISOString();
      const futureOther = new Date(Date.now() + 600000).toISOString();
      const summary: RetrieveUserQuotaSummaryResponse = {
        groups: [
          {
            displayName: "Claude Opus 3.5",
            buckets: [
              { resetTime: futureOther, window: "FIVE_HOUR", remainingFraction: 1 },
            ],
          },
          {
            displayName: "Gemini 2.5 Pro",
            buckets: [
              { resetTime: futureReset, window: "FIVE_HOUR", remainingFraction: 0 },
            ],
          },
        ],
      };

      expect(findResetTimeForModel(summary, "gemini-2.5-pro")).toBe(futureReset);
    });

    it("falls back to exhausted bucket if not FIVE_HOUR", () => {
      const futureReset = new Date(Date.now() + 300000).toISOString();
      const summary: RetrieveUserQuotaSummaryResponse = {
        groups: [
          {
            displayName: "Gemini Flash",
            buckets: [
              { resetTime: futureReset, window: "WEEKLY", remainingFraction: 0, disabled: true },
            ],
          },
        ],
      };

      expect(findResetTimeForModel(summary, "gemini-flash")).toBe(futureReset);
    });

    it("falls back to non-exhausted FIVE_HOUR bucket", () => {
      const futureReset = new Date(Date.now() + 300000).toISOString();
      const summary: RetrieveUserQuotaSummaryResponse = {
        groups: [
          {
            displayName: "Default",
            buckets: [
              { resetTime: futureReset, window: "FIVE_HOUR", remainingFraction: 0.5 },
            ],
          },
        ],
      };

      expect(findResetTimeForModel(summary)).toBe(futureReset);
    });

    it("falls back to earliest valid bucket when no FIVE_HOUR or exhausted buckets exist", () => {
      const earlier = new Date(Date.now() + 100000).toISOString();
      const later = new Date(Date.now() + 500000).toISOString();
      const summary: RetrieveUserQuotaSummaryResponse = {
        buckets: [
          { resetTime: later, window: "DAILY", remainingFraction: 0.5 },
          { resetTime: earlier, window: "DAILY", remainingFraction: 0.5 },
        ],
      };

      expect(findResetTimeForModel(summary)).toBe(earlier);
    });
  });

  describe("resolveQuotaResetDelay", () => {
    it("returns waitMs and resetTime if within MAX_QUOTA_RESET_WAIT_MS", async () => {
      const futureDate = new Date(Date.now() + 60000); // 60s
      vi.spyOn(fetchQuotaModule, "retrieveUserQuotaSummary").mockResolvedValueOnce({
        buckets: [
          { resetTime: futureDate.toISOString(), window: "FIVE_HOUR", remainingFraction: 0 },
        ],
      });

      const result = await resolveQuotaResetDelay("token", "proj", "gemini-pro");
      expect(result).not.toBeNull();
      expect(result?.resetTime).toBe(futureDate.toISOString());
      expect(result?.waitMs).toBeGreaterThan(50000);
      expect(result?.waitMs).toBeLessThanOrEqual(62000);
    });

    it("returns null if summary fetch returns null or throws", async () => {
      vi.spyOn(fetchQuotaModule, "retrieveUserQuotaSummary").mockResolvedValueOnce(null);
      expect(await resolveQuotaResetDelay("token", "proj")).toBeNull();

      vi.spyOn(fetchQuotaModule, "retrieveUserQuotaSummary").mockRejectedValueOnce(new Error("network error"));
      expect(await resolveQuotaResetDelay("token", "proj")).toBeNull();
    });

    it("returns null if waitMs exceeds MAX_QUOTA_RESET_WAIT_MS", async () => {
      const farFuture = new Date(Date.now() + MAX_QUOTA_RESET_WAIT_MS + 100000);
      vi.spyOn(fetchQuotaModule, "retrieveUserQuotaSummary").mockResolvedValueOnce({
        buckets: [
          { resetTime: farFuture.toISOString(), window: "FIVE_HOUR", remainingFraction: 0 },
        ],
      });

      expect(await resolveQuotaResetDelay("token", "proj")).toBeNull();
    });

    it("returns null if resetTime is invalid or in the past", async () => {
      vi.spyOn(fetchQuotaModule, "retrieveUserQuotaSummary").mockResolvedValueOnce({
        buckets: [
          { resetTime: "invalid-date", window: "FIVE_HOUR" },
        ],
      });

      expect(await resolveQuotaResetDelay("token", "proj")).toBeNull();
    });
  });
});

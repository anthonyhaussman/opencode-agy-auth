import { describe, it, expect } from "vitest";
import { classifyQuotaResponse, parseRetryDelayFromBody, retryInternals } from "../src/sdk/retry/quota";

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
});

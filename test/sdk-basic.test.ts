import { describe, expect, it } from "vitest";
import { formatHyperlink, stripOsc8, supportsOsc8Hyperlinks } from "../src/sdk/terminal-hyperlink";
import { getAgyCliVersion, buildAgyCliUserAgent } from "../src/sdk/user-agent";
import { AGY_CLI_VERSION } from "../src/sdk/agy-cli-version";
import {
  AGY_PROVIDER_ID,
  AGY_CLIENT_ID,
  AGY_CLIENT_SECRET,
  AGY_SCOPES,
  AGY_REDIRECT_URI,
  AGY_CODE_ASSIST_ENDPOINT,
  AGY_GENERATIVE_LANGUAGE_ENDPOINT,
} from "../src/constants";
import { createAgyActivityRequestId } from "../src/sdk/activity-request-id";
import { normalizeThinkingConfig } from "../src/sdk/request-helpers/thinking";
import { extractUsageMetadata, parseGeminiApiBody } from "../src/sdk/request-helpers/parsing";
import { enhanceGeminiErrorResponse, rewriteGeminiPreviewAccessError } from "../src/sdk/request-helpers/errors";

describe("src/constants", () => {
  it("exports expected API endpoints and OAuth configs", () => {
    expect(AGY_PROVIDER_ID).toBe("google-agy");
    expect(AGY_CLIENT_ID).toBeDefined();
    expect(AGY_CLIENT_SECRET).toBeDefined();
    expect(AGY_SCOPES.length).toBeGreaterThan(0);
    expect(AGY_REDIRECT_URI).toBe("https://antigravity.google/oauth-callback");
    expect(AGY_CODE_ASSIST_ENDPOINT).toContain("googleapis.com");
    expect(AGY_GENERATIVE_LANGUAGE_ENDPOINT).toBe("https://generativelanguage.googleapis.com/v1beta");
  });
});

describe("src/sdk/terminal-hyperlink", () => {
  it("formats hyperlinks with OSC 8 or plain text fallback depending on terminal support", () => {
    const originalStdout = process.stdout;
    const oldEnv = { ...process.env };

    try {
      Object.defineProperty(process, "stdout", {
        value: { isTTY: true },
        configurable: true,
      });
      process.env.TERM_PROGRAM = "ghostty";
      delete process.env.OPENCODE_HEADLESS;

      expect(supportsOsc8Hyperlinks()).toBe(true);
      const link = formatHyperlink("https://example.com", "Example");
      expect(link).toContain("\x1b]8;;https://example.com\x07Example\x1b]8;;\x07");
      expect(stripOsc8(link)).toBe("Example");

      process.env.OPENCODE_HEADLESS = "1";
      expect(supportsOsc8Hyperlinks()).toBe(false);
      const fallback = formatHyperlink("https://example.com", "Example");
      expect(fallback).toBe("Example (https://example.com)");
      expect(formatHyperlink("https://example.com")).toBe("https://example.com");
      expect(formatHyperlink("https://example.com", "https://example.com")).toBe("https://example.com");
    } finally {
      Object.defineProperty(process, "stdout", {
        value: originalStdout,
        configurable: true,
      });
      process.env = oldEnv;
    }
  });

  it("checks terminal programs, kitty, vte, and colorterm", () => {
    const oldEnv = { ...process.env };
    const originalStdout = process.stdout;
    try {
      Object.defineProperty(process, "stdout", {
        value: { isTTY: true },
        configurable: true,
      });
      delete process.env.OPENCODE_HEADLESS;

      process.env.TERM_PROGRAM = "wezterm";
      expect(supportsOsc8Hyperlinks()).toBe(true);

      process.env.TERM_PROGRAM = "iterm.app";
      expect(supportsOsc8Hyperlinks()).toBe(true);

      delete process.env.TERM_PROGRAM;
      process.env.KITTY_WINDOW_ID = "1";
      expect(supportsOsc8Hyperlinks()).toBe(true);

      delete process.env.KITTY_WINDOW_ID;
      process.env.VTE_VERSION = "5200";
      expect(supportsOsc8Hyperlinks()).toBe(true);

      delete process.env.VTE_VERSION;
      process.env.COLORTERM = "truecolor";
      process.env.TERM = "xterm-256color";
      expect(supportsOsc8Hyperlinks()).toBe(true);

      process.env.TERM = "alacritty";
      expect(supportsOsc8Hyperlinks()).toBe(true);

      process.env.TERM = "termion";
      expect(supportsOsc8Hyperlinks()).toBe(true);

      process.env.TERM = "dumb";
      expect(supportsOsc8Hyperlinks()).toBe(false);
    } finally {
      Object.defineProperty(process, "stdout", {
        value: originalStdout,
        configurable: true,
      });
      process.env = oldEnv;
    }
  });
});

describe("src/sdk/activity-request-id", () => {
  it("generates short activity request id", () => {
    const id = createAgyActivityRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("src/sdk/request-helpers/thinking", () => {
  it("normalizes thinkingConfig correctly", () => {
    expect(normalizeThinkingConfig(undefined)).toBeUndefined();
    expect(normalizeThinkingConfig("invalid")).toBeUndefined();
    expect(normalizeThinkingConfig({})).toBeUndefined();

    expect(normalizeThinkingConfig({ thinkingBudget: 2048 })).toEqual({
      thinkingBudget: 2048,
      includeThoughts: true,
    });
    expect(normalizeThinkingConfig({ thinkingBudget: 0 })).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    });

    expect(normalizeThinkingConfig({ thinking_budget: 1024, include_thoughts: true })).toEqual({
      thinkingBudget: 1024,
      includeThoughts: true,
    });

    expect(normalizeThinkingConfig({ thinkingLevel: "HIGH" })).toEqual({
      thinkingBudget: 2048,
      includeThoughts: true,
    });
    expect(normalizeThinkingConfig({ thinkingLevel: "MEDIUM" })).toEqual({
      thinkingBudget: 1024,
      includeThoughts: true,
    });
    expect(normalizeThinkingConfig({ thinkingLevel: "LOW" })).toEqual({
      thinkingBudget: 512,
      includeThoughts: true,
    });
    expect(normalizeThinkingConfig({ thinkingLevel: "MINIMAL" })).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    });
    expect(normalizeThinkingConfig({ thinkingLevel: "UNKNOWN" })).toEqual({
      thinkingBudget: 1024,
      includeThoughts: true,
    });

    expect(normalizeThinkingConfig({ thinkingBudget: 2048, includeThoughts: false })).toEqual({
      thinkingBudget: 2048,
      includeThoughts: false,
    });
  });
});

describe("src/sdk/request-helpers/parsing", () => {
  it("parses valid and invalid JSON for gemini bodies", () => {
    expect(parseGeminiApiBody("invalid json")).toBeNull();
    expect(parseGeminiApiBody('{"candidates": []}')).toEqual({ candidates: [] });
    expect(parseGeminiApiBody('[{"candidates": []}, null]')).toEqual({ candidates: [] });
    expect(parseGeminiApiBody("[]")).toBeNull();
    expect(parseGeminiApiBody("123")).toBeNull();
  });

  it("extracts usage metadata correctly", () => {
    expect(extractUsageMetadata({} as any)).toBeNull();
    expect(
      extractUsageMetadata({
        response: {
          usageMetadata: {
            totalTokenCount: 100,
            promptTokenCount: 60,
            candidatesTokenCount: 40,
            cachedContentTokenCount: 0,
          },
        },
      }),
    ).toEqual({
      totalTokenCount: 100,
      promptTokenCount: 60,
      candidatesTokenCount: 40,
      cachedContentTokenCount: 0,
    });
  });
});

describe("src/sdk/request-helpers/errors", () => {
  it("rewrites preview access error for gemini 3 models on 404", () => {
    const non404 = rewriteGeminiPreviewAccessError({ error: { message: "Not found" } }, 500, "gemini-3.7-flash");
    expect(non404).toBeNull();

    const nonGemini3 = rewriteGeminiPreviewAccessError({ error: { message: "Not found" } }, 404, "gemini-2.5-flash");
    expect(nonGemini3).toBeNull();

    const rewritten = rewriteGeminiPreviewAccessError({ error: { message: "Model missing" } }, 404, "gemini-3.7-flash");
    expect(rewritten).not.toBeNull();
    expect(rewritten?.error?.message).toContain("preview access");

    const rewrittenFromMsg = rewriteGeminiPreviewAccessError({ error: { message: "gemini-3 model error" } }, 404);
    expect(rewrittenFromMsg).not.toBeNull();
  });

  it("enhances 403 validation errors and 429 quota errors", () => {
    expect(enhanceGeminiErrorResponse({}, 200)).toBeNull();

    // 403 with validation required
    const enhanced403 = enhanceGeminiErrorResponse(
      {
        error: {
          message: "Permission denied",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "VALIDATION_REQUIRED",
              domain: "daily-cloudcode-pa.googleapis.com",
              metadata: {
                validation_link: "https://cloud.google.com/validate",
              },
            },
            {
              "@type": "type.googleapis.com/google.rpc.Help",
              links: [{ url: "https://support.google.com/article", description: "learn more" }],
            },
          ],
        },
      },
      403,
    );
    expect(enhanced403?.body?.error?.message).toContain("validation page");

    // 429 rate limit exceeded
    const enhanced429 = enhanceGeminiErrorResponse(
      {
        error: {
          message: "Rate limit exceeded. Please retry in 2.5s",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "RATE_LIMIT_EXCEEDED",
            },
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "2.5s",
            },
          ],
        },
      },
      429,
    );
    expect(enhanced429?.retryAfterMs).toBe(2500);
    expect(enhanced429?.body?.error?.message).toContain("Rate limit exceeded");

    // 429 quota exhausted
    const enhancedQuotaExhausted = enhanceGeminiErrorResponse(
      {
        error: {
          message: "Quota reached",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "QUOTA_EXHAUSTED",
            },
          ],
        },
      },
      429,
    );
    expect(enhancedQuotaExhausted?.body?.error?.message).toContain("Quota exhausted for this account");

    // 429 violations daily check
    const enhancedDailyViolation = enhanceGeminiErrorResponse(
      {
        error: {
          message: "Quota reached",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ description: "Daily limit exceeded" }],
            },
          ],
        },
      },
      429,
    );
    expect(enhancedDailyViolation?.body?.error?.message).toContain("Quota exhausted for this account");
  });
});

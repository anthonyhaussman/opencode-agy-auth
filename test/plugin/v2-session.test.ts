import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createV2HttpRequestHook,
  createV2HttpResponseHook,
  createV2RetryHook,
  registerV2SessionHooks,
  type V2RuntimeCatalog,
} from "../../src/plugin/v2-session";
import { setStoredAuthOverrideForTesting } from "../../src/plugin/v2-storage";
import { getModelEnum } from "../../src/sdk/request/prepare";

describe("v2 session hooks", () => {
  it("registers http.request, http.response, and retry hooks on session", () => {
    const hooks: Record<string, Function> = {};
    const mockCtx = {
      session: {
        hook: vi.fn((event: string, handler: Function) => {
          hooks[event] = handler;
        }),
      },
    };

    registerV2SessionHooks(mockCtx);

    expect(mockCtx.session.hook).toHaveBeenCalledWith("http.request", expect.any(Function), expect.any(Object));
    expect(mockCtx.session.hook).toHaveBeenCalledWith("http.response", expect.any(Function), expect.any(Object));
    expect(mockCtx.session.hook).toHaveBeenCalledWith("retry", expect.any(Function), expect.any(Object));
    expect(typeof hooks["http.request"]).toBe("function");
    expect(typeof hooks["http.response"]).toBe("function");
    expect(typeof hooks["retry"]).toBe("function");
  });

  describe("http.request hook", () => {
    it("ignores non-google requests", async () => {
      const hook = createV2HttpRequestHook();
      const request = new Request("https://api.openai.com/v1/chat/completions", {
        headers: { "x-api-key": "secret" },
      });
      const output = { request };

      await hook({ request }, output);

      expect(output.request).toBe(request);
      expect(output.request.headers.get("x-api-key")).toBe("secret");
    });

    it("sanitizes google-agy requests and strips x-goog-api-key", async () => {
      const hook = createV2HttpRequestHook();
      const request = new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent", {
        method: "POST",
        headers: {
          "x-goog-api-key": "opencode-dummy-key",
          authorization: "Bearer dummy",
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] }),
      });
      const output = { request };

      await hook({ request }, output);

      expect(output.request.headers.get("x-goog-api-key")).toBeNull();
    });
  });

  describe("http.response hook", () => {
    it("returns output response directly for non-code-assist endpoints", async () => {
      const hook = createV2HttpResponseHook();
      const request = new Request("https://api.openai.com/v1/chat/completions");
      const response = new Response("ok", { status: 200 });
      const output = { response };

      await hook({ request, response }, output);

      expect(output.response).toBe(response);
    });

    it("captures sessionId in state during http.request and passes it to transformAgyResponse in http.response", async () => {
      const state: any = {};
      const reqHook = createV2HttpRequestHook(state);
      const resHook = createV2HttpResponseHook(state);

      const requestPayload = {
        sessionId: "v2-test-session-123",
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      };

      const eventReq: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        headers: new Headers({
          authorization: "Bearer dummy",
        }),
        body: JSON.stringify(requestPayload),
        auth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "refresh|project|managed",
          expires: Date.now() + 3600000,
        },
      };

      await reqHook(eventReq);
      expect(state.lastSessionId).toBe("v2-test-session-123");

      const eventRes: any = {
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateCode",
        response: new Response('data: {"candidates":[{"content":{"parts":[{"type":"reasoning","text":"thinking step","state":{"thoughtSignature":"sig-v2-abc"}}]}}]}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
      };

      await resHook(eventRes);
      expect(eventRes.response).toBeInstanceOf(Response);
    });

    it("captures sessionId in state even when authRecord is not present", async () => {
      const state: any = {};
      const reqHook = createV2HttpRequestHook(state);

      const requestPayload = {
        sessionId: "v2-unauth-session-456",
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      };

      const eventReq: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        headers: new Headers({
          authorization: "Bearer dummy",
        }),
        body: JSON.stringify(requestPayload),
      };

      const originalHome = process.env.HOME;
      try {
        process.env.HOME = `/tmp/test-nonexistent-home-${Date.now()}`;
        await reqHook(eventReq);
        expect(state.lastSessionId).toBe("v2-unauth-session-456");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("retry hook", () => {
    it("returns empty or void for non-rate-limit errors", async () => {
      const hook = createV2RetryHook();
      const event: any = {
        error: new Error("Network error"),
        attempt: 1,
        request: new Request("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent"),
      };
      const result = await hook(event, {});

      expect(result).toBeUndefined();
      expect(event.retryDelayMs).toBeUndefined();
    });

    it("sets exponential retryDelayMs for retryable socket disconnect errors", async () => {
      const hook = createV2RetryHook();
      const event: any = {
        error: new Error("http2: client connection lost"),
        attempt: 1,
        request: new Request("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent"),
      };

      await hook(event);

      expect(typeof event.retryDelayMs).toBe("number");
      expect(event.retryDelayMs).toBeGreaterThan(0);
    });

    it("sets retryDelayMs for 502 Bad Gateway responses", async () => {
      const hook = createV2RetryHook();
      const event: any = {
        response: new Response(JSON.stringify({ error: "Bad Gateway" }), { status: 502 }),
        attempt: 1,
        request: new Request("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent"),
      };

      await hook(event);

      expect(typeof event.retryDelayMs).toBe("number");
      expect(event.retryDelayMs).toBeGreaterThan(0);
    });

    it("sets retryDelayMs for other 5xx errors like 500 and 504", async () => {
      const hook = createV2RetryHook();
      for (const status of [500, 504]) {
        const event: any = {
          response: new Response("Gateway error", { status }),
          attempt: 2,
        };
        await hook(event);
        expect(typeof event.retryDelayMs).toBe("number");
        expect(event.retryDelayMs).toBeGreaterThan(0);
      }
    });

    it("does not set retryDelayMs for non-retryable 4xx client errors", async () => {
      const hook = createV2RetryHook();
      const event: any = {
        response: new Response("Bad Request", { status: 400 }),
        attempt: 1,
      };

      await hook(event);

      expect(event.retryDelayMs).toBeUndefined();
    });
  });

  describe("runtime catalog and variant resolution", () => {
    const validAuth = {
      type: "oauth" as const,
      access: "session-access-token",
      refresh: "session-refresh|proj-session|managed-session",
      expires: Date.now() + 3_600_000,
    };

    const dynamicCatalog: V2RuntimeCatalog = {
      tierMapping: {
        "gemini-5-pro": {
          low: "gemini-5-pro-low",
          medium: "gemini-5-pro-medium",
          high: "gemini-5-pro-high",
        },
        "gemini-5-ultra": {
          low: "gemini-5-ultra-low",
          high: "gemini-5-ultra-high",
        },
      },
      enums: {
        "gemini-5-pro-low": "MODEL_PLACEHOLDER_M776",
        "gemini-5-pro-medium": "MODEL_PLACEHOLDER_M775",
        "gemini-5-pro-high": "MODEL_PLACEHOLDER_M777",
        "gemini-5-ultra-high": "MODEL_PLACEHOLDER_M888",
      },
    };

    afterEach(() => {
      setStoredAuthOverrideForTesting(undefined);
    });

    it("resolves dynamic tierMapping and enums via event.model.variant when x-agy-tier header is absent", async () => {
      const hook = createV2HttpRequestHook({}, async () => dynamicCatalog);

      const event: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello dynamic" }] }],
        }),
        model: {
          providerID: "google-agy",
          id: "gemini-5-pro",
          variant: "high",
        },
        auth: validAuth,
      };

      await hook(event);

      expect(event.url).toContain("cloudcode-pa.googleapis.com/v1internal:generateContent");
      const transformedBody = JSON.parse(event.body);
      expect(transformedBody.model).toBe("gemini-5-pro-high");
      expect(transformedBody.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M777");
      expect(event.headers.get("User-Agent")).toContain("antigravity/cli/");
    });

    it("forwards getRuntimeCatalog from registerV2SessionHooks to http.request hook", async () => {
      const hooks: Record<string, Function> = {};
      const mockCtx = {
        session: {
          hook: vi.fn((event: string, handler: Function) => {
            hooks[event] = handler;
          }),
        },
      };

      registerV2SessionHooks(mockCtx, () => dynamicCatalog);

      const event: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent",
        headers: { "x-agy-tier": "high" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "via registerV2SessionHooks" }] }],
        }),
        auth: validAuth,
      };

      await hooks["http.request"](event);

      const transformedBody = JSON.parse(event.body);
      expect(transformedBody.model).toBe("gemini-5-pro-high");
      expect(transformedBody.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M777");
    });

    it("enforces tier precedence: x-agy-tier header > @tier suffix > event.model.variant > default tier", async () => {
      const hook = createV2HttpRequestHook({}, () => dynamicCatalog);

      // 1. Explicit x-agy-tier header on event.headers beats event.model.variant ('high') and @medium suffix
      const headerWinsEvent: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro@medium:generateContent",
        headers: new Headers({ "x-agy-tier": "low" }),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "1" }] }] }),
        model: { providerID: "google-agy", id: "gemini-5-pro", variant: "high" },
        auth: validAuth,
      };
      await hook(headerWinsEvent);
      expect(JSON.parse(headerWinsEvent.body).model).toBe("gemini-5-pro-low");
      expect(JSON.parse(headerWinsEvent.body).request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M776");

      // 2. Explicit x-agy-tier header on event.request.headers beats event.model.variant ('high')
      const reqWithHeader = new Request(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent",
        {
          method: "POST",
          headers: { "x-agy-tier": "low" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "2" }] }] }),
        },
      );
      const reqHeaderWinsEvent: any = {
        request: reqWithHeader,
        model: { providerID: "google-agy", id: "gemini-5-pro", variant: "high" },
        auth: validAuth,
      };
      await hook(reqHeaderWinsEvent);
      const reqTransformedBody = JSON.parse(await reqHeaderWinsEvent.request.text());
      expect(reqTransformedBody.model).toBe("gemini-5-pro-low");
      expect(reqTransformedBody.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M776");

      // 3. @tier suffix in URL beats event.model.variant ('high') when x-agy-tier header is absent
      const suffixWinsEvent: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro@low:generateContent",
        headers: new Headers(),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "3" }] }] }),
        model: { providerID: "google-agy", id: "gemini-5-pro", variant: "high" },
        auth: validAuth,
      };
      await hook(suffixWinsEvent);
      expect(JSON.parse(suffixWinsEvent.body).model).toBe("gemini-5-pro-low");
      expect(JSON.parse(suffixWinsEvent.body).request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M776");

      // 4. Default tier fallback (medium ?? high) when no header, no suffix, and empty/missing event.model.variant
      const defaultMediumEvent: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent",
        headers: new Headers(),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "4" }] }] }),
        model: { providerID: "google-agy", id: "gemini-5-pro", variant: "" },
        auth: validAuth,
      };
      await hook(defaultMediumEvent);
      expect(JSON.parse(defaultMediumEvent.body).model).toBe("gemini-5-pro-medium");
      expect(JSON.parse(defaultMediumEvent.body).request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M775");

      const defaultHighEvent: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-5-ultra:generateContent",
        headers: new Headers(),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "5" }] }] }),
        auth: validAuth,
      };
      await hook(defaultHighEvent);
      expect(JSON.parse(defaultHighEvent.body).model).toBe("gemini-5-ultra-high");
      expect(JSON.parse(defaultHighEvent.body).request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M888");
    });

    it("falls back to loadStoredAuthFromJson when event.auth is absent and still applies runtime catalog", async () => {
      setStoredAuthOverrideForTesting(validAuth);

      const hook = createV2HttpRequestHook({}, async () => dynamicCatalog);
      const event: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-5-pro:generateContent",
        headers: new Headers(),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "stored auth" }] }] }),
        model: { providerID: "google-agy", id: "gemini-5-pro", variant: "high" },
      };

      await hook(event);

      expect(event.headers.get("Authorization")).toBe(`Bearer ${validAuth.access}`);
      const transformedBody = JSON.parse(event.body);
      expect(transformedBody.model).toBe("gemini-5-pro-high");
      expect(transformedBody.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M777");
    });

    it("falls back to static TIER_MAPPING and models.json getModelEnum when getRuntimeCatalog throws or returns undefined", async () => {
      const throwingHook = createV2HttpRequestHook({}, async () => {
        throw new Error("catalog failure");
      });

      const throwEvent: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
        headers: new Headers({ "x-agy-tier": "high" }),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "throw fallback" }] }] }),
        auth: validAuth,
      };
      await throwingHook(throwEvent);
      const throwBody = JSON.parse(throwEvent.body);
      expect(throwBody.model).toBe("gemini-3.8-flash-high");
      expect(throwBody.request.labels.model_enum).toBe(getModelEnum("gemini-3.8-flash-high"));

      const undefinedHook = createV2HttpRequestHook({}, () => undefined);
      const undefinedEvent: any = {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
        headers: new Headers(),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "undefined fallback" }] }] }),
        model: { providerID: "google-agy", id: "gemini-3.8-flash", variant: "high" },
        auth: validAuth,
      };
      await undefinedHook(undefinedEvent);
      const undefinedBody = JSON.parse(undefinedEvent.body);
      expect(undefinedBody.model).toBe("gemini-3.8-flash-high");
      expect(undefinedBody.request.labels.model_enum).toBe(getModelEnum("gemini-3.8-flash-high"));
    });
  });
});

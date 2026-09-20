import { describe, expect, it, vi } from "vitest";
import {
  createV2HttpRequestHook,
  createV2HttpResponseHook,
  createV2RetryHook,
  registerV2SessionHooks,
} from "../../src/plugin/v2-session";

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
  });

  describe("retry hook", () => {
    it("returns empty or void for non-rate-limit errors", async () => {
      const hook = createV2RetryHook();
      const result = await hook(
        {
          error: new Error("Network error"),
          attempt: 1,
          request: new Request("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent"),
        },
        {}
      );

      expect(result).toBeUndefined();
    });
  });
});

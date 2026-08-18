import { describe, expect, it, vi } from "vitest";
import { transformAgyResponse } from "../src/sdk/request/response";

describe("src/sdk/request/response", () => {
  it("passes through non-JSON, non-SSE responses directly and interacts with chatLogger", async () => {
    const chatLoggerMock = {
      logResponseHeaders: vi.fn(),
      logResponseBody: vi.fn(),
      close: vi.fn(),
      createLoggingTransformStream: vi.fn(),
    };

    const plainResponse = new Response("plain text", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

    const res = await transformAgyResponse(plainResponse, false, undefined, undefined, undefined, chatLoggerMock as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("plain text");
    expect(chatLoggerMock.logResponseBody).toHaveBeenCalledWith("[Non-JSON response (body omitted)]");
    expect(chatLoggerMock.close).toHaveBeenCalled();
  });

  it("unwraps JSON response payload and attaches usage headers", async () => {
    const body = {
      response: {
        candidates: [{ content: { parts: [{ text: "Hello world" }] } }],
        usageMetadata: {
          totalTokenCount: 50,
          promptTokenCount: 30,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 5,
        },
      },
    };

    const jsonResponse = new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const res = await transformAgyResponse(jsonResponse, false);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gemini-cached-content-token-count")).toBe("5");
    expect(res.headers.get("x-gemini-total-token-count")).toBe("50");
    expect(res.headers.get("x-gemini-prompt-token-count")).toBe("30");
    expect(res.headers.get("x-gemini-candidates-token-count")).toBe("20");

    const parsedJson = await res.json();
    expect(parsedJson.candidates[0].content.parts[0].text).toBe("Hello world");
  });

  it("handles error responses, retryAfterMs headers, and preview access rewrites", async () => {
    const errorBody = {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Models in the gemini-2.5-preview family require preview access",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "3.5s",
          },
        ],
      },
    };

    const errorResponse = new Response(JSON.stringify(errorBody), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

    const res = await transformAgyResponse(errorResponse, false, undefined, "gemini-2.5-preview");
    expect(res.status).toBe(403);
    expect(res.headers.get("retry-after-ms")).toBe("3500");
    expect(res.headers.get("Retry-After")).toBe("4");
  });

  it("handles streaming SSE responses with and without chatLogger", async () => {
    const sseChunks = [
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "Stream chunk 1"}]}}]}}\n\n',
      'data: {"response": {"candidates": [{"content": {"parts": [{"text": "Stream chunk 2"}]}}]}}\n\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const sseResponse = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const res = await transformAgyResponse(sseResponse, true, undefined, undefined, "test-session");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    const { value } = await reader!.read();
    expect(new TextDecoder().decode(value)).toContain("Stream chunk 1");
  });
});

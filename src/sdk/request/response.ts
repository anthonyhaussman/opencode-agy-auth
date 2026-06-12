
import {
  enhanceGeminiErrorResponse,
  extractUsageMetadata,
  parseGeminiApiBody,
  rewriteGeminiPreviewAccessError,
  type GeminiApiBody,
} from "../request-helpers";
import { injectResponseIdFromTrace } from "./shared";
import { cacheSignature } from "../../plugin/cache";
import { createStreamingTransformer, defaultSignatureStore } from "./thinking";
import type { ChatLogger } from "../chat-logger";

/**
 * Normalizes Gemini/Agy responses, preserving request metadata and usage counters.
 */
export async function transformAgyResponse(
  response: Response,
  streaming: boolean,
  _ignoredDebugContext?: any,
  requestedModel?: string,
  sessionId?: string,
  chatLogger?: ChatLogger | null,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  if (!isJsonResponse && !isEventStreamResponse) {
    if (chatLogger) {
      chatLogger.logResponseHeaders(response.status, response.statusText, response.headers);
      chatLogger.logResponseBody("[Non-JSON response (body omitted)]");
      chatLogger.close();
    }
    return response;
  }

  try {
    const headers = new Headers(response.headers);
    if (chatLogger) {
      chatLogger.logResponseHeaders(response.status, response.statusText, headers);
    }

    if (streaming && response.ok && isEventStreamResponse && response.body) {
      return new Response(transformStreamingPayloadStream(response.body, sessionId, chatLogger), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const text = await response.text();
    if (chatLogger) {
      chatLogger.logResponseBody(text);
      chatLogger.close();
    }

    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const parsed: GeminiApiBody | null = !streaming || !isEventStreamResponse ? parseGeminiApiBody(text) : null;
    const enhanced = !response.ok && parsed ? enhanceGeminiErrorResponse(parsed, response.status) : null;
    if (enhanced?.retryAfterMs) {
      const retryAfterSec = Math.ceil(enhanced.retryAfterMs / 1000).toString();
      headers.set("Retry-After", retryAfterSec);
      headers.set("retry-after-ms", String(enhanced.retryAfterMs));
    }

    const previewPatched = parsed
      ? rewriteGeminiPreviewAccessError(enhanced?.body ?? parsed, response.status, requestedModel)
      : null;

    const effectiveBodyRaw = previewPatched ?? enhanced?.body ?? parsed ?? undefined;
    const effectiveBody =
      effectiveBodyRaw && typeof effectiveBodyRaw === "object"
        ? injectResponseIdFromTrace(effectiveBodyRaw as Record<string, unknown>)
        : effectiveBodyRaw;

    attachUsageHeaders(headers, effectiveBody);

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody && typeof effectiveBody === "object" && "response" in effectiveBody) {
      return new Response(JSON.stringify((effectiveBody as { response: unknown }).response), init);
    }
    if (previewPatched) {
      return new Response(JSON.stringify(previewPatched), init);
    }

    return new Response(text, init);
  } catch (error) {
    const errStr = error instanceof Error ? error.stack || error.message : String(error);
    console.warn(`[Agy Auth] Failed to transform Gemini/Agy response: ${errStr}`);
    return response;
  }
}

function attachUsageHeaders(headers: Headers, effectiveBody: unknown): void {
  if (!effectiveBody || typeof effectiveBody !== "object") {
    return;
  }
  const usage = extractUsageMetadata(effectiveBody as GeminiApiBody);
  if (usage?.cachedContentTokenCount === undefined) {
    return;
  }

  headers.set("x-gemini-cached-content-token-count", String(usage.cachedContentTokenCount));
  if (usage.totalTokenCount !== undefined) {
    headers.set("x-gemini-total-token-count", String(usage.totalTokenCount));
  }
  if (usage.promptTokenCount !== undefined) {
    headers.set("x-gemini-prompt-token-count", String(usage.promptTokenCount));
  }
  if (usage.candidatesTokenCount !== undefined) {
    headers.set("x-gemini-candidates-token-count", String(usage.candidatesTokenCount));
  }
}

function transformStreamingPayloadStream(
  stream: ReadableStream<Uint8Array>,
  sessionId?: string,
  chatLogger?: ChatLogger | null,
): ReadableStream<Uint8Array> {
  const callbacks = {
    onCacheSignature: (sessionKey: string, text: string, signature: string) => {
      cacheSignature(sessionKey, text, signature);
    },
    transformThinkingParts: (response: unknown) => {
      if (response && typeof response === "object") {
        return injectResponseIdFromTrace(response as Record<string, unknown>);
      }
      return response;
    },
  };

  const transformer = createStreamingTransformer(
    defaultSignatureStore,
    callbacks,
    {
      signatureSessionKey: sessionId,
      cacheSignatures: !!sessionId,
    },
  );

  if (chatLogger) {
    return stream
      .pipeThrough(chatLogger.createLoggingTransformStream())
      .pipeThrough(transformer);
  }

  return stream.pipeThrough(transformer);
}

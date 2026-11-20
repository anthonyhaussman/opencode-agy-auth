import { AGY_GENERATIVE_LANGUAGE_ENDPOINT } from "../../constants";

const REQUEST_MODEL_FALLBACKS: Record<string, string> = {};
const GENERATIVE_LANGUAGE_HOST = new URL(AGY_GENERATIVE_LANGUAGE_ENDPOINT).host;
const CODE_ASSIST_HOST_SUFFIX = "cloudcode-pa.googleapis.com";
const MODEL_ACTION_PATTERN = /\/models\/[^:]+:\w+/;

/**
 * Returns the URL string for supported RequestInfo inputs.
 */
export function toRequestUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

/**
 * Detects Gemini/Generative Language API requests via URL.
 */
export function isGenerativeLanguageRequest(input: RequestInfo): input is string {
  const url = toRequestUrlString(input);
  return (
    url.includes(GENERATIVE_LANGUAGE_HOST) ||
    (url.includes(CODE_ASSIST_HOST_SUFFIX) && MODEL_ACTION_PATTERN.test(url))
  );
}

export function parseGenerativeLanguageRequest(input: RequestInfo):
  | { requestedModel: string; effectiveModel: string; action: string }
  | undefined {
  const url = toRequestUrlString(input);
  // Standard Generative Language shape: /v1beta/models/<model>:<action>
  // Slash-namespaced shape: /v1beta/<account>/<model>:<action> — produced when a
  // provider model id itself contains a slash (multi-account namespaces), the
  // SDK then omits the "models/" segment entirely.
  const match =
    url.match(/\/models\/([^:]+):(\w+)/) ??
    (url.includes(GENERATIVE_LANGUAGE_HOST) ? url.match(/\/v1beta\/([^:]+):(\w+)/) : null);
  if (!match) {
    return undefined;
  }

  const [, requestedModel = "", action = ""] = match;
  return {
    requestedModel,
    effectiveModel: REQUEST_MODEL_FALLBACKS[requestedModel] ?? requestedModel,
    action,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/**
 * Replace the requested model token inside a request URL, supporting both the
 * `/models/<model>:` and the slash-namespaced `/<model>:` shapes. Returns the
 * original input untouched when the token is absent.
 */
export function rewriteRequestedModelInInput(
  input: RequestInfo,
  from: string,
  to: string,
): RequestInfo {
  if (!from) {
    return input;
  }
  const url = toRequestUrlString(input);
  let next = url;
  const withModels = `models/${from}`;
  if (next.includes(withModels)) {
    next = next.replace(withModels, `models/${to}`);
  } else if (next.includes(`/${from}:`)) {
    next = next.replace(`/${from}:`, `/${to}:`);
  }
  if (next === url) {
    return input;
  }
  if (typeof input === "string") {
    return next;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return new Request(next, input);
  }
  return next;
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const str = readString(value);
    if (str) {
      return str;
    }
  }
  return undefined;
}

/**
 * Preserves Cloud Code trace identity for downstream clients by mapping traceId to responseId.
 */
export function injectResponseIdFromTrace<T extends Record<string, unknown>>(body: T): T {
  const traceId = readString(body.traceId);
  if (!traceId) {
    return body;
  }

  const response = body.response;
  if (!isRecord(response)) {
    return body;
  }

  if (readString(response.responseId)) {
    return body;
  }

  return {
    ...body,
    response: {
      ...response,
      responseId: traceId,
    },
  };
}

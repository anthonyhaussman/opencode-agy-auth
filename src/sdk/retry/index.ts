import {
  canRetryRequest,
  DEFAULT_MAX_ATTEMPTS,
  getExponentialDelayWithJitter,
  isRetryableNetworkError,
  isRetryableStatus,
  resolveRetryDelayMs,
  wait,
} from "./helpers";
import { classifyQuotaResponse, retryInternals } from "./quota";
import { agyFetch } from "../../fetch";
import { CooldownStore, loadCooldowns } from "./cooldown-store";

const retryCooldownByKey = loadCooldowns();
const cooldownStore = new CooldownStore();
cooldownStore.bind(retryCooldownByKey);
const RETRY_IN_FLIGHT_LOG_INTERVAL_MS = 5000;
const MODEL_CAPACITY_COOLDOWN_MS = 8000;

/**
 * Sends a request with retry/exponential backoff semantics, consistent with Gemini/Agy CLI.
 */
export async function fetchWithRetry(
  input: RequestInfo,
  init: RequestInit | undefined,
): Promise<Response> {
  if (!canRetryRequest(init)) {
    return agyFetch(input, init);
  }

  const retryInit = cloneRetryableInit(init);
  const throttleKey = buildRetryThrottleKey(input, retryInit);
  await waitForRetryCooldown(throttleKey, retryInit.signal);
  let attempt = 1;
  const url = readRequestUrl(input);

  while (attempt <= DEFAULT_MAX_ATTEMPTS) {
    let response: Response;
    try {
      response = await agyFetch(input, retryInit);
    } catch (error) {
      if (attempt >= DEFAULT_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        throw error;
      }
      if (retryInit.signal?.aborted) {
        throw error;
      }

      const delayMs = getExponentialDelayWithJitter(attempt);
      await wait(delayMs);
      attempt += 1;
      continue;
    }

    if (!isRetryableStatus(response.status)) {
      return response;
    }

    const quotaContext = response.status === 429 ? await classifyQuotaResponse(response) : null;
    if (response.status === 429 && quotaContext?.terminal) {
      if (quotaContext.reason === "MODEL_CAPACITY_EXHAUSTED") {
        const cooldownMs = quotaContext.retryDelayMs ?? MODEL_CAPACITY_COOLDOWN_MS;
        setRetryCooldown(throttleKey, cooldownMs);
      }
      return response;
    }

    if (attempt >= DEFAULT_MAX_ATTEMPTS || retryInit.signal?.aborted) {
      return response;
    }

    const delayMs = await resolveRetryDelayMs(response, attempt, quotaContext?.retryDelayMs);
    if (delayMs > 0 && response.status === 429) {
      setRetryCooldown(throttleKey, delayMs);
    }
    if (delayMs > 0) {
      await wait(delayMs);
    }
    attempt += 1;
  }

  return agyFetch(input, retryInit);
}

function cloneRetryableInit(init: RequestInit | undefined): RequestInit {
  if (!init) {
    return {};
  }
  return {
    ...init,
    headers: new Headers(init.headers ?? {}),
  };
}

function buildRetryThrottleKey(input: RequestInfo, init: RequestInit): string {
  const url = readRequestUrl(input);
  const body = typeof init.body === "string" ? safeParseBody(init.body) : null;
  const project = readString(body?.project);
  const model = readString(body?.model);
  return `${url}|${project ?? ""}|${model ?? ""}`;
}

async function waitForRetryCooldown(key: string, signal?: AbortSignal | null): Promise<void> {
  const until = retryCooldownByKey.get(key);
  if (!until) {
    return;
  }

  const remaining = until - Date.now();
  if (remaining <= 0) {
    retryCooldownByKey.delete(key);
    return;
  }
  if (signal?.aborted) {
      return;
  }

  await wait(remaining);
  retryCooldownByKey.delete(key);
}

function setRetryCooldown(key: string, delayMs: number): void {
  const next = Date.now() + delayMs;
  const current = retryCooldownByKey.get(key) ?? 0;
  retryCooldownByKey.set(key, Math.max(current, next));
  cooldownStore.markDirty();
}

export function shutdownRetryCooldowns(): void {
  cooldownStore.shutdown();
}

function readRequestUrl(input: RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }

  const request = input as Request;
  if (request.url) {
    return request.url;
  }
  return input.toString();
}

function safeParseBody(body: string): Record<string, unknown> | null {
  if (!body) {
    return null;
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export { retryInternals };

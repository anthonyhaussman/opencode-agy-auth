import { randomUUID } from "node:crypto";

import { isRecord, pickString } from "./shared";

const PROCESS_SESSION_ID = randomUUID();
let PROCESS_REQUEST_INDEX = 0;

function formatAgyRequestId(userPromptId: string, sessionId: string): string {
  if (userPromptId.startsWith("agent/")) {
    return userPromptId;
  }

  return `agent/${sessionId}/${Date.now()}/${userPromptId}/${PROCESS_REQUEST_INDEX++}`;
}

function resolveUserPromptId(payload: Record<string, unknown>, request?: Record<string, unknown>): string {
  const extra = isRecord(payload.extra_body) ? payload.extra_body : undefined;

  return (
    pickString(
      payload.user_prompt_id,
      payload.userPromptId,
      payload.prompt_id,
      payload.promptId,
      payload.request_id,
      payload.requestId,
      request?.user_prompt_id,
      request?.userPromptId,
      request?.prompt_id,
      request?.promptId,
      request?.request_id,
      request?.requestId,
      extra?.user_prompt_id,
      extra?.userPromptId,
      extra?.prompt_id,
      extra?.promptId,
      extra?.request_id,
      extra?.requestId,
    ) ?? randomUUID()
  );
}

function resolveSessionId(payload: Record<string, unknown>, request?: Record<string, unknown>): string {
  const extra = isRecord(payload.extra_body) ? payload.extra_body : undefined;
  return (
    pickString(
      request?.session_id,
      request?.sessionId,
      payload.session_id,
      payload.sessionId,
      extra?.session_id,
      extra?.sessionId,
    ) ?? PROCESS_SESSION_ID
  );
}

function stripPromptIdentifierAliases(payload: Record<string, unknown>): void {
  delete payload.user_prompt_id;
  delete payload.userPromptId;
  delete payload.prompt_id;
  delete payload.promptId;
  delete payload.request_id;
  delete payload.requestId;
}

function stripSessionIdentifierAliases(payload: Record<string, unknown>): void {
  delete payload.sessionId;
}

/**
 * Applies canonical identifiers for wrapped Code Assist payloads.
 */
export function normalizeWrappedIdentifiers(
  wrapped: Record<string, unknown>,
): { userPromptId: string; sessionId: string; requestId: string } {
  const request = isRecord(wrapped.request) ? { ...wrapped.request } : {};
  const userPromptId = resolveUserPromptId(wrapped, request);
  const sessionId = resolveSessionId(wrapped, request);
  const requestId = formatAgyRequestId(userPromptId, sessionId);

  request.session_id = sessionId;
  stripSessionIdentifierAliases(request);
  wrapped.request = request;

  stripPromptIdentifierAliases(wrapped);
  wrapped.requestId = requestId;

  return { userPromptId, sessionId, requestId };
}

/**
 * Applies canonical identifiers for unwrapped request payloads prior to wrapping.
 */
export function normalizeRequestPayloadIdentifiers(
  payload: Record<string, unknown>,
): { userPromptId: string; sessionId: string; requestId: string } {
  const userPromptId = resolveUserPromptId(payload);
  const sessionId = resolveSessionId(payload);
  const requestId = formatAgyRequestId(userPromptId, sessionId);

  payload.session_id = sessionId;
  stripSessionIdentifierAliases(payload);
  stripPromptIdentifierAliases(payload);

  return { userPromptId, sessionId, requestId };
}

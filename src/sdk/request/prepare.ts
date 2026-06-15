import { randomUUID } from "node:crypto";

import { AGY_CODE_ASSIST_ENDPOINT } from "../../constants";
import { normalizeThinkingConfig } from "../request-helpers";
import { buildAgyCliUserAgent } from "../user-agent";
import { normalizeRequestPayloadIdentifiers, normalizeWrappedIdentifiers } from "./identifiers";
import { addThoughtSignaturesToFunctionCalls, transformOpenAIToolCalls } from "./openai";
import { isGenerativeLanguageRequest, parseGenerativeLanguageRequest } from "./shared";
import { getLatestSignature } from "../../plugin/cache";
import {
  analyzeConversationState,
  needsThinkingRecovery,
  closeToolLoopForThinking,
} from "./thinking";

const STREAM_ACTION = "streamGenerateContent";

export interface ThinkingConfigDefaults {
  provider?: unknown;
  models?: Record<string, unknown>;
}

/**
 * Rewrites OpenAI-style requests into the format for Gemini Code Assist requests.
 */
export function prepareAgyRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
  thinkingConfigDefaults?: ThinkingConfigDefaults,
): {
  request: RequestInfo;
  init: RequestInit;
  streaming: boolean;
  requestedModel?: string;
  sessionId?: string;
} {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  const requestTarget = parseGenerativeLanguageRequest(input);
  if (!requestTarget) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");

  const { requestedModel: rawModel, effectiveModel, action: rawAction } = requestTarget;
  const streaming = rawAction === STREAM_ACTION;
  
  const transformedUrl = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:${rawAction}${
    streaming ? "?alt=sse" : ""
  }`;

  let body = baseInit.body;
  let sessionId: string | undefined;

  if (typeof baseInit.body === "string" && baseInit.body) {
    const transformed = transformRequestBody(
      baseInit.body,
      projectId,
      effectiveModel,
      rawModel,
      thinkingConfigDefaults,
    );
    if (transformed.body) {
      body = transformed.body;
    }
    sessionId = transformed.sessionId;
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }

  const userAgent = buildAgyCliUserAgent(effectiveModel);
  headers.set("User-Agent", userAgent);

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel: rawModel,
    sessionId,
  };
}

function transformRequestBody(
  body: string,
  projectId: string,
  effectiveModel: string,
  requestedModel: string,
  thinkingConfigDefaults?: ThinkingConfigDefaults,
): { body?: string; userPromptId: string; sessionId?: string } {
  const fallbackId = randomUUID();
  try {
    const parsedBody = JSON.parse(body) as Record<string, unknown>;
    const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;

    if (isWrapped) {
      const wrappedBody = {
        ...parsedBody,
        model: effectiveModel,
      } as Record<string, unknown>;

      const wrappedModel = (wrappedBody.model as string) || "";
      if (wrappedModel.includes("-image") && !wrappedBody.requestType) {
        wrappedBody.requestType = "image_gen";
        wrappedBody.userAgent = wrappedBody.userAgent || "antigravity";
      }

      const { userPromptId, sessionId, requestId } = normalizeWrappedIdentifiers(wrappedBody);

      const requestPayloadInside = wrappedBody.request as Record<string, unknown> | undefined;
      if (requestPayloadInside) {
        normalizeThinking(
          requestPayloadInside,
          resolveDefaultThinkingConfig(thinkingConfigDefaults, requestedModel, effectiveModel),
          thinkingConfigDefaults?.provider,
        );
      }
      if (requestPayloadInside && !requestPayloadInside.labels) {
        requestPayloadInside.labels = {
          last_execution_id: randomUUID(),
          last_step_index: "0",
          model_enum: "MODEL_PLACEHOLDER_M16",
          trajectory_id: randomUUID(),
          used_claude: "false",
          used_claude_conservative: "false"
        };
      }

      if (requestPayloadInside && Array.isArray(requestPayloadInside.tools)) {
        normalizeToolSchemaTypes(requestPayloadInside.tools);
      }
      if (requestPayloadInside && Array.isArray(requestPayloadInside.contents)) {
        let contents = requestPayloadInside.contents;
        const state = analyzeConversationState(contents);
        if (needsThinkingRecovery(state)) {
          contents = closeToolLoopForThinking(contents);
        }
        
        contents = normalizeContentsSequence(contents);
        injectMissingToolCallIds(contents);

        const latestSig = getLatestSignature(sessionId);
        applyLatestSignature(contents, latestSig);
        requestPayloadInside.contents = contents;
      }

      return { body: JSON.stringify(wrappedBody), userPromptId, sessionId };
    }

    const requestPayload = { ...parsedBody };
    if (Array.isArray(requestPayload.tools)) {
      normalizeToolSchemaTypes(requestPayload.tools);
    }
    transformOpenAIToolCalls(requestPayload);
    addThoughtSignaturesToFunctionCalls(requestPayload);
    normalizeThinking(
      requestPayload,
      resolveDefaultThinkingConfig(thinkingConfigDefaults, requestedModel, effectiveModel),
      thinkingConfigDefaults?.provider,
    );
    normalizeSystemInstruction(requestPayload);
    normalizeCachedContent(requestPayload);

    const { userPromptId, sessionId, requestId } = normalizeRequestPayloadIdentifiers(requestPayload);

    let contents = requestPayload.contents as any[];
    if (Array.isArray(contents)) {
      const state = analyzeConversationState(contents);
      if (needsThinkingRecovery(state)) {
        contents = closeToolLoopForThinking(contents);
      }
      
      contents = normalizeContentsSequence(contents);
      injectMissingToolCallIds(contents);

      const latestSig = getLatestSignature(sessionId);
      applyLatestSignature(contents, latestSig);
      requestPayload.contents = contents;
    }

    if ("model" in requestPayload) {
      delete requestPayload.model;
    }

    if (!requestPayload.labels) {
      requestPayload.labels = {
        last_execution_id: randomUUID(),
        last_step_index: "0",
        model_enum: "MODEL_PLACEHOLDER_M16",
        trajectory_id: randomUUID(),
        used_claude: "false",
        used_claude_conservative: "false"
      };
    }

    const isImageGen =
      effectiveModel.includes("-image") ||
      requestedModel.includes("-image") ||
      (typeof requestPayload.generationConfig === "object" &&
        requestPayload.generationConfig !== null &&
        "imageConfig" in (requestPayload.generationConfig as Record<string, unknown>));

    const wrappedBody: Record<string, unknown> = {
      project: projectId,
      model: effectiveModel,
      requestId,
      request: requestPayload,
      userAgent: "antigravity"
    };

    if (isImageGen) {
      wrappedBody.requestType = "image_gen";
    } else if (effectiveModel.includes("gemini-3.1-flash-lite")) {
      wrappedBody.requestType = "checkpoint";
    } else if (effectiveModel.includes("gemini-2.5-flash-lite")) {
      wrappedBody.requestType = "chat";
    } else if (effectiveModel.includes("-lite")) {
      wrappedBody.requestType = "web_search";
    } else {
      wrappedBody.requestType = "agent";
    }

    return { body: JSON.stringify(wrappedBody), userPromptId, sessionId };
  } catch (error) {
    const errStr = error instanceof Error ? error.stack || error.message : String(error);
    console.warn(`[Agy Auth] Failed to transform Gemini request body: ${errStr}`);
    return { userPromptId: fallbackId };
  }
}

function resolveDefaultThinkingConfig(
  thinkingConfigDefaults: ThinkingConfigDefaults | undefined,
  requestedModel: string,
  effectiveModel: string,
): unknown {
  const configured = thinkingConfigDefaults?.models
    ? thinkingConfigDefaults.models[requestedModel] ?? thinkingConfigDefaults.models[effectiveModel]
    : undefined;
  if (configured !== undefined) {
    return configured;
  }

  return getImplicitThinkingConfigForModel(requestedModel) ?? getImplicitThinkingConfigForModel(effectiveModel);
}

function normalizeThinking(
  requestPayload: Record<string, unknown>,
  modelThinkingConfig: unknown,
  providerThinkingConfig: unknown,
): void {
  const rawGenerationConfig = isRecord(requestPayload.generationConfig)
    ? { ...requestPayload.generationConfig }
    : undefined;
  const mergedThinkingConfig = mergeThinkingConfigs(
    providerThinkingConfig,
    modelThinkingConfig,
    requestPayload.thinkingConfig,
    rawGenerationConfig?.thinkingConfig,
  );
  const normalizedThinkingConfig = normalizeThinkingConfig(mergedThinkingConfig);

  if (Object.prototype.hasOwnProperty.call(requestPayload, "thinkingConfig")) {
    delete requestPayload.thinkingConfig;
  }

  if (!normalizedThinkingConfig) {
    if (rawGenerationConfig) {
      requestPayload.generationConfig = rawGenerationConfig;
    }
    return;
  }

  requestPayload.generationConfig = {
    ...(rawGenerationConfig ?? {}),
    thinkingConfig: normalizedThinkingConfig,
  };
}

function getImplicitThinkingConfigForModel(modelId: string): unknown {
  const normalizedModelId = modelId.toLowerCase();
  if (!normalizedModelId.startsWith("gemini-") || normalizedModelId.includes("image")) {
    return undefined;
  }

  return {
    thinkingBudget: normalizedModelId.includes("extra-low") ? 1000 : 10001,
    includeThoughts: true,
  };
}

function mergeThinkingConfigs(...configs: unknown[]): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    const normalized = normalizeThinkingConfig(config);
    if (!normalized) {
      continue;
    }
    for (const [key, value] of Object.entries(normalized)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolSchemaTypes(tools: unknown): void {
  if (!Array.isArray(tools)) return;

  const validSchemaKeys = new Set([
    "type", "description", "properties", "items", 
    "required", "enum", "nullable", "format"
  ]);

  const sanitizeSchema = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(sanitizeSchema);
      return;
    }

    if (!obj.type && (Array.isArray(obj.anyOf) || Array.isArray(obj.oneOf))) {
      const arr = obj.anyOf || obj.oneOf;
      if (arr.length > 0 && arr[0] && typeof arr[0].type === "string") {
        obj.type = arr[0].type;
        if (arr[0].items) {
          obj.items = arr[0].items;
        }
      } else {
        obj.type = "STRING";
      }
    }

    if (typeof obj.type === "string") {
      const t = obj.type.toLowerCase();
      if (["string", "number", "integer", "boolean", "array", "object"].includes(t)) {
        obj.type = t.toUpperCase();
      }
    }

    if (obj.properties && typeof obj.properties === "object") {
      Object.values(obj.properties).forEach(sanitizeSchema);
    }
    if (obj.items && typeof obj.items === "object") {
      sanitizeSchema(obj.items);
    }

    for (const key of Object.keys(obj)) {
      if (!validSchemaKeys.has(key)) {
        delete obj[key];
      }
    }
  };

  for (const tool of tools) {
    if (tool && Array.isArray(tool.functionDeclarations)) {
      for (const fn of tool.functionDeclarations) {
        if (fn && typeof fn.name === "string") {
          fn.name = fn.name.replace(/[^a-zA-Z0-9_]/g, "_");
        }
        if (fn) {
          if (!fn.parameters) {
            fn.parameters = { type: "OBJECT", properties: {} };
          }
          sanitizeSchema(fn.parameters);
        }
      }
    }
  }
}

function normalizeSystemInstruction(requestPayload: Record<string, unknown>): void {
  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }
}

function normalizeCachedContent(requestPayload: Record<string, unknown>): void {
  const extraBody =
    requestPayload.extra_body && typeof requestPayload.extra_body === "object"
      ? (requestPayload.extra_body as Record<string, unknown>)
      : undefined;
  const cachedContentFromExtra = extraBody?.cached_content ?? extraBody?.cachedContent;
  const cachedContent =
    (requestPayload.cached_content as string | undefined) ??
    (requestPayload.cachedContent as string | undefined) ??
    (cachedContentFromExtra as string | undefined);

  if (cachedContent) {
    requestPayload.cachedContent = cachedContent;
  }

  delete requestPayload.cached_content;
  if (!extraBody) {
    return;
  }

  delete extraBody.cached_content;
  delete extraBody.cachedContent;
  if (Object.keys(extraBody).length === 0) {
    delete requestPayload.extra_body;
  }
}



function normalizeContentsSequence(contents: any[]): any[] {
  const merged: any[] = [];
  for (const msg of contents) {
    if (!msg || !msg.role || !Array.isArray(msg.parts)) {
      continue;
    }
    const validParts = msg.parts.filter((p: any) => p != null);
    if (validParts.length === 0) {
      continue;
    }

    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.parts.push(...validParts);
    } else {
      merged.push({ ...msg, parts: validParts });
    }
  }
  return merged;
}

function injectMissingToolCallIds(contents: any[]): void {
  // Map of function name to array of missing IDs we generated for it
  const missingIdsByName = new Map<string, string[]>();

  for (const content of contents) {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      continue;
    }

    for (const part of content.parts) {
      if (!part || typeof part !== "object") {
        continue;
      }

      if (part.functionCall && typeof part.functionCall.name === "string") {
        if (!part.functionCall.id) {
          const generatedId = randomUUID();
          part.functionCall.id = generatedId;
          
          let ids = missingIdsByName.get(part.functionCall.name);
          if (!ids) {
            ids = [];
            missingIdsByName.set(part.functionCall.name, ids);
          }
          ids.push(generatedId);
        }
      }

      if (part.functionResponse && typeof part.functionResponse.name === "string") {
        if (!part.functionResponse.id) {
          const ids = missingIdsByName.get(part.functionResponse.name);
          if (ids && ids.length > 0) {
            part.functionResponse.id = ids.shift();
          } else {
             part.functionResponse.id = randomUUID();
          }
        }
      }
    }
  }
}

function applyLatestSignature(contents: any[], latestSig: string | undefined): void {
  // Collect all function calls in chronological order
  const allFunctionCalls: any[] = [];
  for (const content of contents) {
    if (content && typeof content === "object" && Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (part && typeof part === "object" && part.functionCall) {
          allFunctionCalls.push(part);
        }
      }
    }
  }

  // Only apply the latest signature to the VERY LAST function call
  if (allFunctionCalls.length > 0 && latestSig) {
    const lastFunctionCall = allFunctionCalls[allFunctionCalls.length - 1];
    if (!lastFunctionCall.thoughtSignature || lastFunctionCall.thoughtSignature === "skip_thought_signature_validator") {
      lastFunctionCall.thoughtSignature = latestSig;
    }
  }
}




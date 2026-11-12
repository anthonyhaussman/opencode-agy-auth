import { buildAgyCliUserAgent } from '../sdk/user-agent';
import {
  prepareAgyRequest,
  transformAgyResponse,
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest
} from '../sdk/request';
import { createChatLogger } from '../sdk/chat-logger';
import { fetchWithRetry } from '../sdk/retry';
import { resolveCachedAuth } from './cache';
import {
  accessTokenExpired,
  parseRefreshParts,
  isOAuthAuth
} from './auth';
import { refreshAccessToken } from './token';
import { ensureProjectContext } from './project';
import { getSafeHeader, setSafeHeaders, toUrlString } from './headers';
import { resolveModelTier, type TierMap } from './tier';
import { loadStoredAuthFromJson } from './v2-storage';

export interface V2RuntimeCatalog {
  enums?: Readonly<Record<string, string>>;
  tierMapping?: Readonly<Record<string, TierMap>>;
  variant?: string;
}

export function createV2FetchInterceptor(
  getAuthSnapshot?: () => Promise<any> | any,
  getRuntimeCatalog?: () => Promise<V2RuntimeCatalog | undefined> | V2RuntimeCatalog | undefined
) {
  return async function agyV2Fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const isGL = isGenerativeLanguageRequest(input);
    const isInternal = toUrlString(input).includes('cloudcode-pa.googleapis.com');

    if (!isGL && !isInternal) {
      return (globalThis.fetch || fetch)(input, init);
    }

    let rawAuth = getAuthSnapshot ? await getAuthSnapshot() : undefined;
    if (!rawAuth) {
      rawAuth = loadStoredAuthFromJson();
    }

    if (!rawAuth || !isOAuthAuth(rawAuth)) {
      return (globalThis.fetch || fetch)(input, init);
    }

    let authRecord = resolveCachedAuth(rawAuth);
    if (accessTokenExpired(authRecord)) {
      const refreshed = await refreshAccessToken(authRecord, { auth: { set: async () => {} } } as any);
      if (refreshed) {
        authRecord = refreshed;
      }
    }

    if (!authRecord.access) {
      return (globalThis.fetch || fetch)(input, init);
    }

    if (isInternal) {
      const hasAuth = getSafeHeader(init?.headers, 'Authorization') !== undefined;
      if (hasAuth) {
        return (globalThis.fetch || fetch)(input, init);
      }

      const userAgent = buildAgyCliUserAgent();
      const headers = setSafeHeaders(init?.headers, {
        Authorization: `Bearer ${authRecord.access}`,
        'User-Agent': userAgent
      });

      return (globalThis.fetch || fetch)(input, {
        ...init,
        headers: headers as any
      });
    }

    const requestTarget = parseGenerativeLanguageRequest(input);
    const requestUserAgentModel = requestTarget?.effectiveModel;

    let projectContext: { effectiveProjectId: string; auth: any };
    try {
      projectContext = await ensureProjectContext(
        authRecord,
        { auth: { set: async () => {} } } as any,
        undefined,
        requestUserAgentModel
      );
    } catch {
      projectContext = {
        effectiveProjectId: parseRefreshParts(authRecord.refresh).projectId || 'antigravity',
        auth: authRecord
      };
    }

    let catalog: V2RuntimeCatalog | undefined;
    try {
      catalog = await getRuntimeCatalog?.();
    } catch {
      catalog = undefined;
    }

    const originalRequestedModel = parseGenerativeLanguageRequest(input)?.effectiveModel;
    let modifiedInput: RequestInfo = input;
    if (isGL && originalRequestedModel) {
      const originalBase = originalRequestedModel.replace('google-agy/', '');
      const existingHeaders =
        init?.headers ??
        (typeof Request !== 'undefined' && modifiedInput instanceof Request
          ? modifiedInput.headers
          : undefined);
      const hasExplicitTier = getSafeHeader(existingHeaders, 'x-agy-tier') !== undefined;
      const tierInit =
        !hasExplicitTier && !originalBase.includes('@') && catalog?.variant
          ? { headers: setSafeHeaders(existingHeaders, { 'x-agy-tier': catalog.variant }) as HeadersInit }
          : existingHeaders !== undefined
            ? { headers: existingHeaders }
            : init;
      const resolvedBase = resolveModelTier(originalBase, tierInit, catalog?.tierMapping);
      if (originalBase !== resolvedBase) {
        if (typeof modifiedInput === 'string') {
          modifiedInput = modifiedInput.replace(`models/${originalBase}`, `models/${resolvedBase}`);
        } else if (typeof Request !== 'undefined' && modifiedInput instanceof Request) {
          const newUrl = modifiedInput.url.replace(`models/${originalBase}`, `models/${resolvedBase}`);
          modifiedInput = new Request(newUrl, modifiedInput);
        }
      }
    }

    let effectiveInit = init;
    if (typeof Request !== 'undefined' && modifiedInput instanceof Request) {
      let reqBody = init?.body;
      if (reqBody === undefined && modifiedInput.body !== null) {
        try {
          reqBody = await modifiedInput.clone().text();
        } catch {
          // Ignore body read error
        }
      }
      effectiveInit = {
        ...init,
        method: init?.method ?? modifiedInput.method,
        headers: init?.headers ?? modifiedInput.headers,
        ...(reqBody !== undefined ? { body: reqBody } : {})
      };
    }

    const transformed = prepareAgyRequest(
      modifiedInput,
      effectiveInit,
      authRecord.access,
      projectContext.effectiveProjectId,
      undefined,
      catalog?.enums
    );

    const chatLogger = createChatLogger();
    if (chatLogger) {
      chatLogger.logRequest(
        toUrlString(transformed.request),
        transformed.init.method || 'GET',
        transformed.init.headers,
        transformed.init.body
      );
    }

    const response = await fetchWithRetry(transformed.request, transformed.init);
    return transformAgyResponse(
      response,
      transformed.streaming,
      null,
      transformed.requestedModel,
      transformed.sessionId,
      chatLogger
    );
  };
}

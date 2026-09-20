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
import { resolveModelTier } from './tier';
import { loadStoredAuthFromJson } from './v2-storage';

export function createV2FetchInterceptor(getAuthSnapshot?: () => Promise<any> | any) {
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

    const originalRequestedModel = parseGenerativeLanguageRequest(input)?.effectiveModel;
    let modifiedInput = input;
    if (isGL && originalRequestedModel) {
      const originalBase = originalRequestedModel.replace('google-agy/', '');
      const resolvedBase = resolveModelTier(originalBase, init);
      if (originalBase !== resolvedBase) {
        if (typeof modifiedInput === 'string') {
          modifiedInput = modifiedInput.replace(`models/${originalBase}`, `models/${resolvedBase}`);
        } else if (typeof Request !== 'undefined' && modifiedInput instanceof Request) {
          const newUrl = modifiedInput.url.replace(`models/${originalBase}`, `models/${resolvedBase}`);
          modifiedInput = new Request(newUrl, modifiedInput);
        }
      }
    }

    const transformed = prepareAgyRequest(
      modifiedInput,
      init,
      authRecord.access,
      projectContext.effectiveProjectId,
      undefined
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

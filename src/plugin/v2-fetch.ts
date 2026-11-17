import { buildAgyCliUserAgent } from '../sdk/user-agent';
import {
  prepareAgyRequest,
  transformAgyResponse,
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  rewriteRequestedModelInInput
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
import { loadStoredAuthFromJson, loadAccountAuth, splitAccountModel } from './v2-storage';

export function createV2FetchInterceptor(getAuthSnapshot?: () => Promise<any> | any) {
  return async function agyV2Fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const isGL = isGenerativeLanguageRequest(input);
    const isInternal = toUrlString(input).includes('cloudcode-pa.googleapis.com');

    if (!isGL && !isInternal) {
      return (globalThis.fetch || fetch)(input, init);
    }

    // Account routing: `<account>/<model>` picks that account's credentials.
    const requestedModelRaw = parseGenerativeLanguageRequest(input)?.effectiveModel;
    const decodedRequestedModel = (() => {
      if (!requestedModelRaw) return '';
      try {
        return decodeURIComponent(requestedModelRaw);
      } catch {
        return requestedModelRaw;
      }
    })();
    const routed = splitAccountModel(decodedRequestedModel);
    const bareRequestedModel = routed.model || decodedRequestedModel;

    let rawAuth = routed.account ? loadAccountAuth(routed.account) : undefined;
    if (!rawAuth && getAuthSnapshot) {
      rawAuth = await getAuthSnapshot();
    }
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
      const resolvedBase = resolveModelTier(bareRequestedModel ?? originalRequestedModel, init);
      // Always strip the account prefix, even when the tier is unchanged.
      if (resolvedBase !== bareRequestedModel || routed.account) {
        modifiedInput = rewriteRequestedModelInInput(
          modifiedInput,
          originalRequestedModel,
          resolvedBase
        );
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

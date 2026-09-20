import { AGY_PROVIDER_ID } from '../constants';
import { buildAgyCliUserAgent } from '../sdk/user-agent';
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareAgyRequest,
  transformAgyResponse
} from '../sdk/request';
import { classifyQuotaResponse, retryInternals } from '../sdk/retry/quota';
import { resolveRetryDelayMs } from '../sdk/retry/helpers';
import { resolveCachedAuth } from './cache';
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from './auth';
import { refreshAccessToken } from './token';
import { ensureProjectContext } from './project';
import { loadStoredAuthFromJson, saveStoredAuthToJson } from './v2-storage';
import { toUrlString } from './headers';
import { resolveModelTier } from './tier';

export interface V2SessionHooksState {
  lastInterceptedModel?: string;
}

export function createV2HttpRequestHook(state: V2SessionHooksState = {}) {
  return async (event: any) => {
    if (!event) return;

    const rawUrl = typeof event.url === 'string' ? event.url : (event.request?.url || '');
    const isGL = isGenerativeLanguageRequest(rawUrl);
    const isInternal = rawUrl.includes('cloudcode-pa.googleapis.com');

    if (!isGL && !isInternal) {
      return;
    }

    event.headers = event.headers || {};
    let modelName: string | undefined;

    // Load auth record
    let rawAuth = event.auth;
    if (rawAuth && !rawAuth.type) {
      const tokenVal = rawAuth.access || rawAuth.token;
      if (tokenVal || rawAuth.refresh) {
        rawAuth = { type: 'oauth', access: tokenVal, ...rawAuth };
      }
    }
    if (!rawAuth || !isOAuthAuth(rawAuth)) {
      rawAuth = loadStoredAuthFromJson();
    }

    let authRecord = rawAuth && isOAuthAuth(rawAuth) ? resolveCachedAuth(rawAuth) : undefined;
    if (authRecord && accessTokenExpired(authRecord)) {
      const refreshed = await refreshAccessToken(authRecord, { auth: { set: async () => {} } } as any);
      if (refreshed) {
        authRecord = refreshed;
        saveStoredAuthToJson(refreshed);
      }
    }

    if (isGL) {
      const parsed = parseGenerativeLanguageRequest(rawUrl);
      modelName = parsed?.effectiveModel;
      if (modelName) {
        state.lastInterceptedModel = modelName;
      }

      // Strip x-goog-api-key and api-key from headers
      if (typeof event.headers.delete === 'function') {
        event.headers.delete('x-goog-api-key');
        event.headers.delete('api-key');
      } else {
        for (const key of Object.keys(event.headers)) {
          const lower = key.toLowerCase();
          if (lower === 'x-goog-api-key' || lower === 'api-key') {
            delete event.headers[key];
          }
        }
      }

      if (event.request?.headers) {
        if (typeof event.request.headers.delete === 'function') {
          event.request.headers.delete('x-goog-api-key');
          event.request.headers.delete('api-key');
        } else {
          for (const key of Object.keys(event.request.headers)) {
            const lower = key.toLowerCase();
            if (lower === 'x-goog-api-key' || lower === 'api-key') {
              delete event.request.headers[key];
            }
          }
        }
      }

      // Strip query parameter key/x-goog-api-key/api-key if URL has them
      let cleanUrl = rawUrl;
      try {
        const parsedUrl = new URL(rawUrl);
        let urlChanged = false;
        for (const param of ['key', 'x-goog-api-key', 'api-key']) {
          if (parsedUrl.searchParams.has(param)) {
            parsedUrl.searchParams.delete(param);
            urlChanged = true;
          }
        }
        if (urlChanged) {
          cleanUrl = parsedUrl.toString();
        }
      } catch {
        // Ignore invalid URL parse
      }

      // If we have auth, perform full URL and body transformation via prepareAgyRequest
      if (authRecord && authRecord.access) {
        let projectContext: { effectiveProjectId: string; auth: any };
        try {
          projectContext = await ensureProjectContext(
            authRecord,
            { auth: { set: async () => {} } } as any,
            undefined,
            modelName
          );
        } catch {
          projectContext = {
            effectiveProjectId: parseRefreshParts(authRecord.refresh).projectId || 'antigravity',
            auth: authRecord
          };
        }

        const originalRequestedModel = modelName;
        let modifiedUrl = cleanUrl;
        if (originalRequestedModel) {
          const originalBase = originalRequestedModel.replace('google-agy/', '');
          const initHeaders = event.headers instanceof Headers ? event.headers : event.request?.headers;
          const resolvedBase = resolveModelTier(originalBase, { headers: initHeaders });
          if (originalBase !== resolvedBase) {
            modifiedUrl = modifiedUrl.replace(`models/${originalBase}`, `models/${resolvedBase}`);
          }
        }

        // Read body from event.body or event.request
        let bodyPayload: any = event.body;
        if (bodyPayload === undefined && event.request) {
          if (typeof event.request.clone === 'function') {
            try {
              bodyPayload = await event.request.clone().text();
            } catch {
              // Ignore clone read error
            }
          } else if (event.request.body !== undefined) {
            bodyPayload = event.request.body;
          }
        }

        // Check if caller supplied custom user-agent
        let preExistingUserAgent: string | undefined;
        if (typeof event.headers?.get === 'function') {
          preExistingUserAgent = event.headers.get('user-agent') || event.headers.get('User-Agent') || undefined;
        } else if (event.headers && typeof event.headers === 'object') {
          preExistingUserAgent = (event.headers['user-agent'] as string) || (event.headers['User-Agent'] as string) || undefined;
        }
        if (!preExistingUserAgent && typeof event.request?.headers?.get === 'function') {
          preExistingUserAgent = event.request.headers.get('user-agent') || event.request.headers.get('User-Agent') || undefined;
        } else if (!preExistingUserAgent && event.request?.headers && typeof event.request.headers === 'object') {
          preExistingUserAgent = (event.request.headers['user-agent'] as string) || (event.request.headers['User-Agent'] as string) || undefined;
        }

        const method = event.method || event.request?.method || 'POST';
        const requestHeaders = event.headers || event.request?.headers;
        const transformed = prepareAgyRequest(
          modifiedUrl,
          {
            method,
            headers: requestHeaders,
            body: bodyPayload
          },
          authRecord.access,
          projectContext.effectiveProjectId
        );

        // Update URL to Code Assist endpoint
        const targetUrl = toUrlString(transformed.request);
        if (typeof event.url === 'string') {
          event.url = targetUrl;
        }
        if (event.request && typeof event.request === 'object') {
          if (typeof Request !== 'undefined' && event.request instanceof Request) {
            event.request = new Request(targetUrl, {
              method: transformed.init.method,
              headers: transformed.init.headers,
              body: transformed.init.body
            });
          } else if (typeof event.request.url === 'string') {
            try {
              event.request.url = targetUrl;
            } catch {
              // Ignore setter error on read-only url property
            }
          }
        }

        // Update headers
        const headerEntries = transformed.init.headers instanceof Headers
          ? Array.from(transformed.init.headers.entries())
          : Object.entries(transformed.init.headers || {});

        for (const [k, v] of headerEntries) {
          const lowerK = k.toLowerCase();
          if (lowerK === 'user-agent') {
            if (preExistingUserAgent) {
              continue;
            }
            // If no pre-existing user-agent, set as 'User-Agent' on plain objects
            if (typeof event.headers?.set === 'function') {
              event.headers.set('User-Agent', v);
            } else if (event.headers) {
              event.headers['User-Agent'] = v;
            }
            if (event.request?.headers && typeof event.request.headers.set === 'function') {
              event.request.headers.set('User-Agent', v);
            } else if (event.request?.headers && typeof event.request.headers === 'object') {
              event.request.headers['User-Agent'] = v;
            }
            continue;
          }
          if (typeof event.headers?.set === 'function') {
            event.headers.set(k, v);
          } else if (event.headers) {
            event.headers[k] = v;
          }
          if (event.request?.headers && typeof event.request.headers.set === 'function') {
            event.request.headers.set(k, v);
          } else if (event.request?.headers && typeof event.request.headers === 'object') {
            event.request.headers[k] = v;
          }
        }

        // Update body
        if (transformed.init.body !== undefined) {
          event.body = transformed.init.body;
          if (event.request && typeof event.request === 'object' && !(event.request instanceof Request)) {
            event.request.body = transformed.init.body;
          }
        }
      } else {
        // Fallback if no auth: update cleaned URL
        if (typeof event.url === 'string') {
          event.url = cleanUrl;
        }
        if (event.request && typeof event.request === 'object') {
          if (typeof Request !== 'undefined' && event.request instanceof Request) {
            event.request = new Request(cleanUrl, event.request);
          } else if (typeof event.request.url === 'string') {
            try {
              event.request.url = cleanUrl;
            } catch {
              // Ignore setter error on read-only url property
            }
          }
        }
      }
    }

    if (authRecord && authRecord.access) {
      if (typeof event.headers?.set === 'function') {
        event.headers.set('Authorization', `Bearer ${authRecord.access}`);
      } else if (event.headers) {
        event.headers['Authorization'] = `Bearer ${authRecord.access}`;
      }
      if (event.request?.headers && typeof event.request.headers.set === 'function') {
        event.request.headers.set('Authorization', `Bearer ${authRecord.access}`);
      } else if (event.request?.headers && typeof event.request.headers === 'object') {
        event.request.headers['Authorization'] = `Bearer ${authRecord.access}`;
      }
    }

    const userAgent = buildAgyCliUserAgent(modelName);
    if (typeof event.headers?.set === 'function') {
      if (!event.headers.get('User-Agent') && !event.headers.get('user-agent')) {
        event.headers.set('User-Agent', userAgent);
      }
    } else if (event.headers) {
      if (!event.headers['User-Agent'] && !event.headers['user-agent']) {
        event.headers['User-Agent'] = userAgent;
      }
    }
    if (event.request?.headers && typeof event.request.headers.set === 'function') {
      if (!event.request.headers.get('User-Agent') && !event.request.headers.get('user-agent')) {
        event.request.headers.set('User-Agent', userAgent);
      }
    } else if (event.request?.headers && typeof event.request.headers === 'object') {
      if (!event.request.headers['User-Agent'] && !event.request.headers['user-agent']) {
        event.request.headers['User-Agent'] = userAgent;
      }
    }
  };
}

export function createV2HttpResponseHook(state: V2SessionHooksState = {}) {
  return async (event: any) => {
    if (!event || !event.response) return;

    const rawUrl = typeof event.url === 'string' ? event.url : (event.request?.url || '');
    const isInternal = rawUrl.includes('cloudcode-pa.googleapis.com');

    if (isInternal && event.response instanceof Response) {
      const isStreaming = rawUrl.includes(':streamGenerateCode') ||
        event.response.headers.get('content-type')?.includes('text/event-stream');

      const parsedModel = parseGenerativeLanguageRequest(rawUrl)?.effectiveModel || state.lastInterceptedModel;
      const transformed = await transformAgyResponse(
        event.response,
        !!isStreaming,
        null,
        parsedModel,
        undefined,
        undefined
      );
      event.response = transformed;
    }
  };
}

export function createV2RetryHook() {
  return async (event: any) => {
    if (!event) return;
    const response = event.response;
    if (response instanceof Response) {
      if (response.status === 429 || response.status === 503) {
        const quota = await classifyQuotaResponse(response);
        if (quota?.retryDelayMs) {
          event.retryDelayMs = quota.retryDelayMs;
        } else {
          event.retryDelayMs = await resolveRetryDelayMs(response, event.attempt || 1);
        }
      }
    } else if (event.details && Array.isArray(event.details)) {
      const retryInfo = event.details.find(
        (d: any) => d && d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
      );
      if (retryInfo?.retryDelay) {
        const delayMs = retryInternals.parseRetryDelayValue(retryInfo.retryDelay);
        if (delayMs !== null) {
          event.retryDelayMs = delayMs;
        }
      }
    }
  };
}

export function registerV2SessionHooks(ctx: any) {
  const state: V2SessionHooksState = {};
  ctx.session.hook('http.request', createV2HttpRequestHook(state), { providerID: AGY_PROVIDER_ID });
  ctx.session.hook('http.response', createV2HttpResponseHook(state), { providerID: AGY_PROVIDER_ID });
  ctx.session.hook('retry', createV2RetryHook(), { providerID: AGY_PROVIDER_ID });
}

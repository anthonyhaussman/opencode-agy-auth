/**
 * v2-clean.ts — V2-only, one account per provider, secrets owned by OpenCode.
 *
 * Design:
 *  - `options.ids` (default ["agy", "agy-labs"]) drives N independent provider
 *    IDs, all served by this single plugin instance.
 *  - Each ID gets its own integration with one Google OAuth method. The
 *    credential is stored by OpenCode in SQLite — never in a plugin file.
 *  - The catalog is loaded BEFORE the synchronous transforms, then replayed via
 *    reload() whenever a credential changes. (V2 transforms must be sync.)
 *  - No `account/model` namespacing, no multi-account store, no failover.
 *  - Request shaping reuses the proven helpers in src/sdk + src/plugin.
 */
import { spawn } from "node:child_process";

import { authorizeAgy, exchangeAgyWithVerifier } from "./sdk/oauth";
import { parseOAuthCallbackInput } from "./plugin/oauth-authorize";
import { formatRefreshParts, parseRefreshParts } from "./plugin/auth";
import { resolveProjectContextFromAccessToken } from "./plugin/project";
import { refreshAccessToken } from "./plugin/token";
import { retrieveUserQuota } from "./sdk/fetch_quota";
import {
  buildTierMapping,
  fetchAvailableModelIds,
  inferModelMetadata,
  resolveModelTier,
} from "./plugin/tier";
import { getModelEnums } from "./plugin/model-enums";
import { buildAgyCliUserAgent } from "./sdk/user-agent";
import { fetchWithRetry } from "./sdk/retry";
import { getSafeHeader, setSafeHeaders, toUrlString } from "./plugin/headers";
import { createChatLogger } from "./sdk/chat-logger";
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareAgyRequest,
  rewriteRequestedModelInInput,
  transformAgyResponse,
} from "./sdk/request";

const DEFAULT_IDS = ["agy", "agy-labs"];
const DUMMY_KEY = "opencode-managed";
const LOGIN_MODEL_ID = "__agy_login_required__";

type AnyCtx = any;
type OAuth = {
  type: "oauth";
  methodID: string;
  refresh: string;
  access: string;
  expires: number;
};

function openBrowser(url: string): void {
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref?.();
  } catch {
    // Best-effort only; the URL is always shown in the instructions.
  }
}

function toOAuth(refresh: string, access: string, expires: number): OAuth {
  return { type: "oauth", methodID: "oauth", refresh, access, expires };
}

function labelFor(id: string): string {
  if (id === "agy") return "AGY";
  const suffix = id.replace(/^agy[-_]?/, "");
  return suffix ? `AGY ${suffix}` : id;
}

export const setup = async (ctx: AnyCtx): Promise<() => void> => {
  const ids: string[] = Array.isArray(ctx.options?.ids) && ctx.options.ids.length
    ? ctx.options.ids
    : DEFAULT_IDS;

  // Cached snapshot per provider, consumed by the synchronous transforms.
  const catalogs = new Map<string, AnyCtx[]>();
  const tiersById = new Map<string, Record<string, Record<string, string>>>();

  const resolveCredential = async (id: string): Promise<OAuth | undefined> => {
    const connApi = ctx.integration?.connection;
    if (!connApi?.active || !connApi?.resolve) return undefined;
    try {
      const connection = await connApi.active(id);
      if (!connection) return undefined;
      const resolved = await connApi.resolve(connection);
      if (resolved?.type === "credential" && resolved.credential?.type === "oauth") {
        const c = resolved.credential;
        return toOAuth(c.refresh, c.access, c.expires);
      }
    } catch {
      // No usable connection yet.
    }
    return undefined;
  };

  // OpenCode V2 Model.Info schema requires time.released, endpoint, options
  // and cost as an ARRAY. Hand-built models missing these crash /api/model
  // at `time.released` (verified via exa/web docs 2026-11-19).
  const baseFields = (id: string, mid: string) => ({
    id: mid,
    providerID: id,
    endpoint: { type: "unknown" },
    options: { headers: {}, body: {} },
    time: { released: 0 },
    variants: [] as AnyCtx[],
    status: "active",
  });

  const loginModel = (id: string, label: string): AnyCtx => ({
    ...baseFields(id, LOGIN_MODEL_ID),
    name: `Sign in to ${label} (Google OAuth)`,
    description: "Run: opencode auth login " + id,
    family: "unknown",
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context: 0, output: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  });

  const buildModel = (id: string, base: string, tiers: Record<string, string>): AnyCtx => {
    const meta = inferModelMetadata(base);
    const family = base.includes("gemini") ? "gemini" : base.includes("claude") ? "claude" : base.includes("gpt") ? "gpt" : "unknown";
    const variants = Object.keys(tiers);
    const cost = meta.cost || { input: 0, output: 0 };
    return {
      ...baseFields(id, base),
      name: meta.name,
      description: meta.description,
      family,
      capabilities: {
        tools: Boolean(meta.toolCall),
        input: ["text", ...(meta.attachment ? ["image"] : [])],
        output: ["text"],
      },
      limit: { context: meta.maxTokens, output: meta.maxOutputTokens },
      cost: [{ input: cost.input ?? 0, output: cost.output ?? 0, cache: { read: 0, write: 0 } }],
      ...(variants.length ? { variants: variants.map((v) => ({ id: v, headers: {}, body: {} })) } : {}),
    };
  };

  const loadCatalog = async (id: string): Promise<void> => {
    const label = labelFor(id);
    const credential = await resolveCredential(id);
    if (!credential?.access) {
      catalogs.set(id, [loginModel(id, label)]);
      return;
    }
    const projectId = parseRefreshParts(credential.refresh).projectId;
    if (!projectId) {
      catalogs.set(id, [loginModel(id, label)]);
      return;
    }
    try {
      const available = await fetchAvailableModelIds(
        retrieveUserQuota,
        credential.access,
        projectId,
        undefined,
      );
      const tiers = buildTierMapping([...available]);
      if (Object.keys(tiers).length === 0) {
        catalogs.set(id, [loginModel(id, label)]);
        return;
      }
      tiersById.set(id, tiers);
      catalogs.set(id, Object.keys(tiers).map((base) => buildModel(id, base, tiers[base] ?? {})));
    } catch {
      catalogs.set(id, [loginModel(id, label)]);
    }
  };

  // Load external data BEFORE registering the synchronous transforms.
  await Promise.all(ids.map(loadCatalog));

  for (const id of ids) {
    const label = labelFor(id);

    // 1. Provider declaration bound to the integration of the same id.
    ctx.provider?.transform?.((editor: AnyCtx) => {
      if (!editor) return;
      if (typeof editor.get === "function" && editor.get(id)) {
        editor.update(id, (p: AnyCtx) => {
          p.name = label;
          p.integrationID = id;
          p.activation = "enabled";
          p.package = "@ai-sdk/google";
          p.settings = { ...(p.settings || {}), apiKey: DUMMY_KEY };
        });
      } else if (typeof editor.add === "function") {
        editor.add({
          info: {
            id,
            name: label,
            integrationID: id,
            activation: "enabled",
            package: "@ai-sdk/google",
            settings: { apiKey: DUMMY_KEY },
          },
          models: catalogs.get(id) || [],
        });
      }
      if (typeof editor.models?.set === "function") {
        editor.models.set(id, catalogs.get(id) || []);
      }
    });

    // 2. Integration with one OAuth method — OpenCode stores the credential.
    ctx.integration?.transform?.((editor: AnyCtx) => {
      if (!editor) return;
      editor.update?.(id, (i: AnyCtx) => { i.name = `${label} (Google OAuth)`; });
      editor.method?.update?.({
        integrationID: id,
        method: { id: "oauth", type: "oauth", label: `Google OAuth — ${label}` },
        authorize: async () => {
          const authorization = await authorizeAgy();
          openBrowser(authorization.url);
          return {
            mode: "code",
            url: authorization.url,
            instructions:
              "Complete Google authorization in your browser, then paste the full redirect URL (or just the code) below.",
            callback: async (code: string) => {
              const parsed = parseOAuthCallbackInput(code);
              if (!parsed.code) throw new Error("Missing authorization code in callback input");
              if (parsed.state && parsed.state !== authorization.state) {
                throw new Error("State mismatch in callback input (possible CSRF attempt)");
              }
              const result = await exchangeAgyWithVerifier(parsed.code, authorization.verifier);
              if (result.type !== "success") throw new Error(result.error);

              let refresh = formatRefreshParts({ refreshToken: result.refresh });
              try {
                const hydrated = await resolveProjectContextFromAccessToken(
                  toOAuth(refresh, result.access, result.expires),
                  result.access,
                  undefined,
                  undefined,
                  undefined,
                );
                refresh = hydrated.auth.refresh || refresh;
              } catch {
                // Project binding is best-effort at login; request time retries it.
              }
              return toOAuth(refresh, result.access, result.expires);
            },
          };
        },
        refresh: async (credential: AnyCtx) => {
          const next = await refreshAccessToken(
            toOAuth(credential.refresh, credential.access, credential.expires),
            { auth: { set: async () => {} } } as AnyCtx,
          );
          if (!next) throw new Error("AGY token refresh failed");
          return toOAuth(next.refresh, next.access, next.expires);
        },
      });
    });

    // 3. Request interception — resolve the credential per request and rewrite.
    ctx.aisdk?.hook?.("sdk", (event: AnyCtx) => {
      if (!event || event.model?.providerID !== id) return;
      event.options = event.options || {};
      event.options.apiKey = DUMMY_KEY;
      event.options.fetch = async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
        const isGL = isGenerativeLanguageRequest(input);
        const isInternal = toUrlString(input).includes("cloudcode-pa.googleapis.com");
        if (!isGL && !isInternal) return (globalThis.fetch || fetch)(input, init);

        const credential = await resolveCredential(id);
        if (!credential?.access) return (globalThis.fetch || fetch)(input, init);

        if (isInternal) {
          if (getSafeHeader(init?.headers, "Authorization") !== undefined) {
            return (globalThis.fetch || fetch)(input, init);
          }
          return (globalThis.fetch || fetch)(input, {
            ...init,
            headers: setSafeHeaders(init?.headers, {
              Authorization: `Bearer ${credential.access}`,
              "User-Agent": buildAgyCliUserAgent(),
            }) as HeadersInit,
          });
        }

        const projectId = parseRefreshParts(credential.refresh).projectId || "antigravity";

        // Translate a selected variant into the real backend tiered model id.
        let requestInput = input;
        const requested = parseGenerativeLanguageRequest(input)?.effectiveModel;
        if (requested) {
          const resolved = resolveModelTier(requested, init, tiersById.get(id));
          if (resolved !== requested) {
            requestInput = rewriteRequestedModelInInput(input, requested, resolved);
          }
        }

        const modelEnums = await getModelEnums(
          credential.access,
          projectId,
          undefined,
        ).catch(() => undefined);
        const transformed = prepareAgyRequest(
          requestInput,
          init,
          credential.access,
          projectId,
          undefined,
          modelEnums,
        );
        const chatLogger = createChatLogger();
        const response = await fetchWithRetry(transformed.request, transformed.init);
        return transformAgyResponse(
          response,
          transformed.streaming,
          null,
          transformed.requestedModel,
          transformed.sessionId,
          chatLogger,
        );
      };
    });
  }

  // Rebuild the cached catalog when a credential appears or changes, then replay
  // the synchronous transforms through reload().
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const _event of ctx.event.subscribe({
        types: ["credential.updated", "credential.switched"],
        signal: controller.signal,
      })) {
        await Promise.all(ids.map(loadCatalog));
        await ctx.provider?.reload?.();
        await ctx.model?.reload?.();
      }
    } catch {
      // Aborted on plugin unload.
    }
  })();

  return () => controller.abort();
};

export default {
  id: "kpihx.agy",
  setup,
};
/**
 * v2-clean.ts — V2-only, one account per provider, secrets owned by OpenCode.
 *
 * Design:
 *  - `options.ids` (default ["agy", "agy-x"]) drives N independent provider
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
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./plugin/auth";
import { resolveCachedAuth } from "./plugin/cache";
import { resolveProjectContextFromAccessToken } from "./plugin/project";
import { toUrlString } from "./plugin/headers";
import { refreshAccessToken } from "./plugin/token";
import { retrieveUserQuota } from "./sdk/fetch_quota";
import {
  buildTierMapping,
  extractBaseModelId,
  fetchAvailableModelIds,
  inferModelMetadata,
  resolveModelTier,
} from "./plugin/tier";
import { getModelEnums } from "./plugin/model-enums";
import { buildAgyCliUserAgent } from "./sdk/user-agent";
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareAgyRequest,
  rewriteRequestedModelInInput,
  transformAgyResponse,
} from "./sdk/request";

const DEFAULT_IDS = ["agy", "agy-x"];
const DUMMY_KEY = "opencode-managed";
const LOGIN_MODEL_ID = "__agy_login_required__";
// Antigravity returns a misleading 429 "Resource has been exhausted" for an
// oversized systemInstruction on an otherwise full-quota account. Verified
// threshold: <=12000 chars -> 200, >=16000 chars -> 429. Stay well under it.
const SYSTEM_INSTRUCTION_LIMIT = 10000;

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
  const connectionsById = new Map<string, AnyCtx>();

  const resolveCredential = async (id: string): Promise<OAuth | undefined> => {
    const connApi = ctx.integration?.connection;
    if (!connApi?.active || !connApi?.resolve) return undefined;
    try {
      const connection = await connApi.active(id);
      if (!connection) return undefined;
      connectionsById.set(id, connection);
      const resolved = await connApi.resolve(connection);
      // V2 returns CredentialOAuth directly ({type:"oauth", access, refresh,
      // expires}) — not a {type:"credential", credential:{...}} wrapper.
      const oauth =
        resolved?.type === "oauth" ? resolved : resolved?.credential?.type === "oauth" ? resolved.credential : undefined;
      if (oauth?.access) {
        // connection.resolve() returns the STORED credential verbatim. Because
        // this provider declares a dummy apiKey, OpenCode never drives its own
        // OAuth-refresh flow, so a stale access token stays stale (401 quota /
        // "API key not valid"). Refresh it here, reusing the shared in-memory
        // cache + in-flight dedup from the legacy path. Persistence back to the
        // OpenCode store is best-effort via a no-op client; the in-memory cache
        // keeps every subsequent call in this process on the fresh token.
        let auth = resolveCachedAuth(
          toOAuth(oauth.refresh, oauth.access, oauth.expires),
        );
        if (accessTokenExpired(auth)) {
          const refreshed = await refreshAccessToken(auth, {
            auth: { set: async () => {} },
          } as AnyCtx);
          if (refreshed?.access) {
            auth = resolveCachedAuth(toOAuth(refreshed.refresh, refreshed.access, refreshed.expires));
          }
        }
        return toOAuth(auth.refresh, auth.access, auth.expires);
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
    modelID: mid,
    providerID: id,
    endpoint: { type: "unknown" },
    options: { headers: {}, body: {} },
    time: { released: 0 },
    variants: [] as AnyCtx[],
    status: "active",
    enabled: true,
    package: "aisdk:@ai-sdk/google",
    settings: { provider: id },
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
    let projectId = parseRefreshParts(credential.refresh).projectId;
    if (!projectId) {
      // The refresh string does not always carry the project id. Resolve it
      // from the live token exactly like request time does.
      try {
        const discovered = await resolveProjectContextFromAccessToken(
          credential,
          credential.access,
          undefined,
          undefined,
          undefined,
        );
        projectId = discovered?.effectiveProjectId || parseRefreshParts(discovered?.auth?.refresh || "").projectId;
      } catch {
        // Fall through to login-required catalog.
      }
    }
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
          p.package = "aisdk:@ai-sdk/google";
          p.settings = { ...(p.settings || {}), apiKey: DUMMY_KEY };
        });
      } else if (typeof editor.add === "function") {
        editor.add({
          info: {
            id,
            name: label,
            integrationID: id,
            activation: "enabled",
            package: "aisdk:@ai-sdk/google",
            settings: { apiKey: DUMMY_KEY },
          },
          models: catalogs.get(id) || [],
          // V2 excludes account-specific providers from the catalog unless the
          // inventory is bound to the connection that produced it (sourceConnection).
          sourceConnection: connectionsById.get(id),
        });
      }
    });

    // The kernel's own provider mirror uses ctx.model.transform + editor.update.
    // editor.models.set on a config-declared provider is a no-op in this runtime
    // (source stays null, modelCount 0), so publish each model through the
    // proven path instead.
    ctx.model?.transform?.((editor: AnyCtx) => {
      if (!editor?.update) return;
      for (const model of catalogs.get(id) || []) {
        editor.update(id, model.id, (draft: AnyCtx) => {
          Object.assign(draft, model);
        });
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

    // 3. Request interception via the V2 http.request/http.response hooks.
    // aisdk.hook never fires for the native google provider; session hooks do.
    ctx.session?.hook?.("http.request", async (event: AnyCtx) => {
      if (!event?.request) return;
      const rawUrl: string = event.request.url || "";
      const isGL = isGenerativeLanguageRequest(rawUrl);
      const isInternal = rawUrl.includes("cloudcode-pa.googleapis.com");
      if (!isGL && !isInternal) return;

      const credential = await resolveCredential(id);
      if (!credential?.access) return;

      let projectId = parseRefreshParts(credential.refresh).projectId;
      if (!projectId) {
        try {
          const discovered = await resolveProjectContextFromAccessToken(
            credential,
            credential.access,
            undefined,
            undefined,
            undefined,
          );
          projectId = discovered?.effectiveProjectId;
        } catch {
          // Fall back below.
        }
      }
      projectId = projectId || "antigravity";

      let requestUrl = rawUrl;
      const requested = parseGenerativeLanguageRequest(rawUrl)?.effectiveModel;
      if (requested) {
        const resolved = resolveModelTier(requested, { headers: event.request.headers }, tiersById.get(id));
        if (resolved !== requested) {
          requestUrl = toUrlString(rewriteRequestedModelInInput(requestUrl, requested, resolved));
        }
      }

      const modelEnums = await getModelEnums(credential.access, projectId, requested).catch(() => undefined);
      const body = typeof event.request.clone === "function"
        ? await event.request.clone().text().catch(() => undefined)
        : undefined;
      const transformed = prepareAgyRequest(
        requestUrl,
        {
          method: event.request.method,
          headers: event.request.headers,
          body,
        },
        credential.access,
        projectId,
        undefined,
        modelEnums,
      );

      // The AI SDK opens the request with the catalog's display model id
      // (e.g. `gemini-3.8-flash`) and prepareAgyRequest derives a variant
      // (`gemini-3.8-flash-medium`) from modelEnums. The Antigravity backend
      // only accepts the canonical bucket id (`gemini-3.8-flash-tiered`);
      // anything else answers 404/429 "Resource has been exhausted" even with
      // full quota. Force the wrapped body's `model` to a real bucket id built
      // from the live quota, matching by base name, tiered variant preferred.
      let outBody = transformed.init.body;
      try {
        const wrapped = JSON.parse(String(outBody));
        // (1) Force the wrapped `model` to a canonical id that actually exists
        // in the live-quota bucket set. The catalog's display names (and the
        // variant derived by prepareAgyRequest from modelEnums, e.g.
        // `gemini-3.8-flash-medium`) are rejected by the backend with 404/429.
        const currentModel: string = String(wrapped?.model ?? requested ?? "");
        const base = extractBaseModelId(currentModel);
        const tierMap = tiersById.get(id)?.[base];
        const canonical = tierMap
          ? (tierMap["tiered"] ?? tierMap["medium"] ?? tierMap["high"] ?? Object.values(tierMap)[0])
          : undefined;
        if (canonical && canonical !== currentModel) {
          wrapped.model = canonical;
        }

        // (2) Antigravity rejects an oversized `systemInstruction` (>~12k
        // chars) with a misleading 429 "Resource has been exhausted" even on
        // a full-quota account. OpenCode injects the whole AGENTS.md kernel
        // there. Relocate the full text into a leading user content part and
        // keep a short systemInstruction — lossless, no kernel content lost.
        const req = wrapped?.request;
        const parts: AnyCtx[] = Array.isArray(req?.systemInstruction?.parts) ? req.systemInstruction.parts : [];
        const sysText = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
        if (sysText.length > SYSTEM_INSTRUCTION_LIMIT) {
          req.systemInstruction = { parts: [{ text: sysText.slice(0, SYSTEM_INSTRUCTION_LIMIT) }] };
          const contents: AnyCtx[] = Array.isArray(req.contents) ? req.contents : [];
          req.contents = [
            {
              role: "user",
              parts: [{ text: `The following is authoritative system context (AGENTS.md):\n\n${sysText}` }],
            },
            ...contents,
          ];
        }
        outBody = JSON.stringify(wrapped);
      } catch {
        // If the body is not parseable JSON, forward it untouched.
      }
      const headers = new Headers(transformed.init.headers);
      headers.delete("x-goog-api-key");
      headers.delete("x-api-key");
      headers.set("Authorization", `Bearer ${credential.access}`);
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", buildAgyCliUserAgent(requested));
      }
      event.request = new Request(toUrlString(transformed.request), {
        method: transformed.init.method || event.request.method,
        headers,
        body: outBody,
      });
    }, { providerID: id });

    ctx.session?.hook?.("http.response", async (event: AnyCtx) => {
      if (!event?.response || !(event.response instanceof Response)) return;
      const rawUrl: string = event.request?.url || "";
      if (!rawUrl.includes("cloudcode-pa.googleapis.com")) return;
      const isStreaming = rawUrl.includes(":streamGenerateContent") ||
        event.response.headers.get("content-type")?.includes("text/event-stream");
      const parsedModel = parseGenerativeLanguageRequest(rawUrl)?.effectiveModel;
      event.response = await transformAgyResponse(
        event.response,
        Boolean(isStreaming),
        null,
        parsedModel,
        undefined,
        undefined,
      );
    }, { providerID: id });
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
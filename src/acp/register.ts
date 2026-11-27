import type { OpenCodeV2PluginContext, PluginClient } from "../plugin/types";
import { emitAgyAcpTosWarning } from "../plugin/tos-warning";
import { createAgyPluginInstaller } from "./agy-plugin";
import { listAgyModels, probeAgy, type AgyProbe } from "./binary";
import { AGY_ACP_PROVIDER_ID, KIND_HEADER, MODELS_STARTUP_WAIT_MS, SESSION_HEADER } from "./constants";
import { AgyAcpError, type AgyErrorCode } from "./errors";
import { AgyAcpLanguageModel, type AgyAcpDeps, type LiveSession } from "./language-model";
import { AgyProcessPool, applyAgyAuthEnv, type AcpModelInfo } from "./process";
import { publishStatus, registerIntegration, resolveAuth, statusFromProbe, type AgyAcpStatus } from "./register-auth";
import { ModelRegistry, placeholderPackage, registerCatalog } from "./register-catalog";
import { SessionStore } from "./session-sync";

export type { AgyAcpStatus } from "./register-auth";

export type AgyAcpRegisterOverrides = Partial<AgyAcpDeps> & {
  probe?: typeof probeAgy;
  installer?: () => Promise<void>;
  /** Model discovery via `agy models` (tests). */
  listModels?: typeof listAgyModels;
  /** Upper bound for how long setup waits for the first model discovery (tests). */
  modelsStartupWaitMs?: number;
  /** Extra options for the default agy plugin installer (tests). */
  installerOptions?: Omit<Parameters<typeof createAgyPluginInstaller>[0], "agyPath" | "notify">;
  /** Toast channel; defaults to `ctx.client` when the host provides one. */
  client?: PluginClient;
};

export interface AgyAcpRegistration {
  dispose(): Promise<void>;
  /** Settles once the registration-time binary probe has finished. */
  ready: Promise<void>;
  /** Settles after the first `agy models` discovery attempt. */
  modelsReady: Promise<void>;
  status(): AgyAcpStatus;
  deps: AgyAcpDeps;
}

const PLUGIN_NOTICE_TITLE = "agy plugin installed";

function defaultLog(level: "info" | "warn" | "error", msg: string): void {
  console[level](`[Agy ACP] ${msg}`);
}

function showToast(client: PluginClient | undefined, message: string): void {
  const toast = client?.tui?.showToast;
  if (!toast) return;
  try {
    void Promise.resolve(
      toast.call(client.tui, { body: { title: PLUGIN_NOTICE_TITLE, message, variant: "info", duration: 15000 } }),
    ).catch(() => undefined);
  } catch {
    // Toast delivery is best-effort; the log line already ran.
  }
}

function belongsToProvider(ev: any): boolean {
  const providerID = ev?.providerID ?? ev?.model?.providerID;
  return providerID === undefined || providerID === AGY_ACP_PROVIDER_ID;
}

function probeError(probe: AgyProbe | undefined, status: AgyAcpStatus): AgyAcpError {
  const code: AgyErrorCode = probe?.status === "missing" ? "missing" : probe?.status === "too_old" ? "too_old" : "other";
  return new AgyAcpError(code, "message" in status ? status.message : "agy CLI is not ready");
}

/**
 * Registers the google-agy-acp provider with OpenCode v2: catalog entries,
 * auth integration, the AI SDK hook that supplies AgyAcpLanguageModel, and the
 * session hooks. The binary probe runs here and on credential switch only; the
 * agy plugin install runs lazily on the first turn.
 */
export async function registerAgyAcpProvider(
  ctx: OpenCodeV2PluginContext,
  overrides: AgyAcpRegisterOverrides = {},
): Promise<AgyAcpRegistration> {
  const {
    probe: probeFn = probeAgy,
    installer: installerOverride,
    listModels = listAgyModels,
    modelsStartupWaitMs = MODELS_STARTUP_WAIT_MS,
    installerOptions,
    client = (ctx as { client?: PluginClient }).client,
    ...depOverrides
  } = overrides;
  const log = depOverrides.log ?? defaultLog;
  const env = depOverrides.env ?? process.env;

  let status: AgyAcpStatus = { status: "checking" };
  let probe: AgyProbe | undefined;
  let lastIdentity: string | undefined;
  let installing: Promise<void> | undefined;
  const installers = new Map<string, () => Promise<void>>();

  const setStatus = (next: AgyAcpStatus) => {
    const previous = status;
    status = next;
    if (previous.status === "needs_auth" || next.status === "needs_auth") void publishStatus(ctx, next);
    if ("message" in next && previous.status !== next.status) log("warn", `agy-acp: ${next.message}`);
  };

  const runProbe = async () => {
    try {
      probe = await probeFn(env);
    } catch (error) {
      probe = { status: "failed", path: "agy", error: error instanceof Error ? error.message : String(error) };
    }
    setStatus(statusFromProbe(probe));
  };

  const notify = (message: string) => {
    log("info", message);
    showToast(client, message);
  };

  const installerFor = (agyPath: string) => {
    if (installerOverride) return installerOverride;
    let installer = installers.get(agyPath);
    if (!installer) {
      installer = createAgyPluginInstaller({ ...installerOptions, agyPath, notify });
      installers.set(agyPath, installer);
    }
    return installer;
  };

  let probing: Promise<void> = Promise.resolve();
  // Hosts expose reload either on `catalog` or on `provider` and `model`
  // (OpenCode 2.3.x); undefined means the host cannot reload at all.
  const reloadCatalog = catalogReloader(ctx);
  const registry = new ModelRegistry(() => reloadCatalog?.(), log);

  // Every model list (discovery or session/new) takes a generation; a list from
  // an older generation never overwrites a newer one.
  let generation = 0;
  // Last list that worked, per account, kept in memory only. A transient
  // `agy models` failure restores it instead of emptying the picker.
  const lastGood = new Map<string, AcpModelInfo[]>();
  // After dispose, late results (discovery or session/new) never touch the catalog.
  let disposed = false;
  const setModels = async (gen: number, models: AcpModelInfo[], identity?: string): Promise<void> => {
    if (disposed || gen !== generation) return;
    if (identity !== undefined) lastGood.set(identity, models);
    await registry.set(models);
  };

  // The catalog lists what agy reports; no file cache, no static fallback list.
  const discover = async (): Promise<void> => {
    const gen = ++generation;
    await probing;
    if (probe?.status !== "ready") {
      await setModels(gen, []);
      return;
    }
    const auth = await resolveAuth(ctx);
    const fallback = (): AcpModelInfo[] => lastGood.get(auth.identity) ?? [];
    try {
      const authEnv = applyAgyAuthEnv(env, { authMethod: auth.method, ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }) });
      const result = await listModels(probe.path, authEnv);
      if (!result.recognized) {
        log("warn", "agy-acp: unrecognized agy models output");
        await setModels(gen, fallback());
        return;
      }
      await setModels(gen, result.models, auth.identity);
    } catch (error) {
      log("warn", `agy-acp: agy models failed: ${error instanceof Error ? error.message : String(error)}`);
      await setModels(gen, fallback());
    }
  };

  const deps: AgyAcpDeps = {
    pool: depOverrides.pool ?? new AgyProcessPool<LiveSession>(),
    store: depOverrides.store ?? new SessionStore(),
    agyPath: "agy",
    cwd: depOverrides.cwd ?? ctx.location?.directory ?? ctx.location?.root ?? process.cwd(),
    env,
    log,
    auth: async () => {
      const auth = await resolveAuth(ctx);
      if (lastIdentity !== undefined && auth.identity !== lastIdentity) {
        lastIdentity = auth.identity;
        probing = runProbe();
        void discover();
      }
      lastIdentity = auth.identity;
      await probing;
      return { method: auth.method, identity: auth.identity, ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }) };
    },
    ensurePlugin: async () => {
      await probing;
      if (probe?.status !== "ready") throw probeError(probe, status);
      if (!installing) {
        installing = installerFor(probe.path)().catch((error) => {
          installing = undefined;
          throw error;
        });
      }
      return installing;
    },
    onModels: (models) => {
      void setModels(++generation, models, lastIdentity);
    },
    onAuthStatus: (failure) => {
      if (failure !== undefined) setStatus({ status: "needs_auth", message: failure });
      else if (status.status === "needs_auth" && probe) setStatus(statusFromProbe(probe));
    },
    ...depOverrides,
  };
  Object.defineProperty(deps, "agyPath", {
    enumerable: true,
    get: () => depOverrides.agyPath ?? (probe?.status === "ready" ? probe.path : "agy"),
  });

  const handle: AgyAcpRegistration = {
    deps,
    ready: Promise.resolve(),
    modelsReady: Promise.resolve(),
    status: () => status,
    dispose: async () => {
      disposed = true;
      await deps.pool.disposeAll();
    },
  };

  // agy runs on this machine; a remote workspace cannot use it.
  if (ctx.location?.workspaceID) return handle;

  emitAgyAcpTosWarning(client);
  if (!reloadCatalog) {
    log("warn", "agy-acp: host cannot reload the catalog; model list changes appear after restart");
  }
  probing = runProbe();
  handle.ready = probing;
  handle.modelsReady = discover();

  registerCatalog(ctx, placeholderPackage(), () => registry.list());
  registerIntegration(ctx);

  const sdkRegistration = await ctx.aisdk?.hook("sdk", (event: any) => {
    if (event?.model?.providerID !== AGY_ACP_PROVIDER_ID && event?.providerID !== AGY_ACP_PROVIDER_ID) return;
    event.sdk = { languageModel: (modelId: string) => new AgyAcpLanguageModel(modelId, deps) };
  });

  ctx.session.hook(
    "model.request",
    (ev) => {
      if (!ev || !belongsToProvider(ev)) return;
      ev.headers = ev.headers ?? {};
      ev.headers[SESSION_HEADER] = ev.sessionID;
      ev.headers[KIND_HEADER] = ev.kind;
    },
    { providerID: AGY_ACP_PROVIDER_ID },
  );

  // agy retries internally; OpenCode retrying a turn would replay it.
  ctx.session.hook(
    "retry",
    (ev: any) => {
      if (!ev || !belongsToProvider(ev)) return;
      ev.retryable = false;
    },
    { providerID: AGY_ACP_PROVIDER_ID },
  );

  handle.dispose = async () => {
    disposed = true;
    if (sdkRegistration && typeof sdkRegistration.dispose === "function") sdkRegistration.dispose();
    await deps.pool.disposeAll();
  };

  // Hosts resolve `opencode run -m` and default models right after setup, so give
  // the first `agy models` a bounded head start; a slow agy still fills the
  // catalog later through the reload.
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    handle.modelsReady.then(() => false),
    new Promise<boolean>((resolve) => {
      waitTimer = setTimeout(() => resolve(true), modelsStartupWaitMs);
    }),
  ]);
  clearTimeout(waitTimer);
  if (timedOut) log("warn", "agy-acp: agy models still running; models appear when it finishes");
  return handle;
}

function catalogReloader(ctx: OpenCodeV2PluginContext): (() => Promise<void>) | undefined {
  const { catalog, provider, model } = ctx;
  if (typeof catalog?.reload === "function") return async () => void (await catalog.reload!());
  if (typeof provider?.reload !== "function" && typeof model?.reload !== "function") return undefined;
  return async () => {
    await Promise.all([provider?.reload?.(), model?.reload?.()]);
  };
}

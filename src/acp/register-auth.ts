import { createHash } from "node:crypto";
import type { OpenCodeV2PluginContext } from "../plugin/types";
import type { AgyProbe } from "./binary";
import { AGY_ACP_PROVIDER_ID } from "./constants";
import { classifyAgyError } from "./errors";
import type { AgyAuthMethod } from "./process";
import { AGY_ACP_PROVIDER_NAME } from "./register-catalog";

export type AgyAcpStatus =
  | { status: "checking" }
  | { status: "missing"; message: string }
  | { status: "failed"; message: string }
  | { status: "needs_auth"; message: string }
  | { status: "ready"; version: string };

const EXTERNAL_IDS: ReadonlySet<string> = new Set(["oauth-personal", "oauth-business", "agent-platform"]);

function externalMethod(id: string, label: string, title: string, description: string) {
  return {
    integrationID: AGY_ACP_PROVIDER_ID,
    method: {
      id,
      type: "external" as const,
      label,
      form: [{ key: "confirmed", type: "boolean" as const, title, description, default: true }],
    },
  };
}

/**
 * Auth methods, mapped to agy's ACP `authMethods`. Google login methods are
 * external: the user signs in with agy itself and the plugin never touches
 * agy's OAuth tokens. The API key is stored by OpenCode (method type `key`).
 */
export const AGY_ACP_AUTH_METHODS = [
  externalMethod(
    "oauth-personal",
    "Google login (personal account, via agy)",
    "Sign in with agy",
    'Run "agy" in a terminal and sign in with your Google account, then confirm here. Google\'s policy may still disable accounts used through OpenCode; the Gemini API key or Vertex methods are recommended.',
  ),
  externalMethod(
    "oauth-business",
    "Google login (Gemini Enterprise / Workspace, via agy)",
    "Sign in with agy",
    'Run "agy" in a terminal and sign in with your Gemini Enterprise or Workspace account, then confirm here.',
  ),
  { integrationID: AGY_ACP_PROVIDER_ID, method: { type: "key" as const, label: "Gemini API key" } },
  externalMethod(
    "agent-platform",
    "Vertex AI / Agent Platform (Application Default Credentials)",
    "Use Application Default Credentials",
    'Run "gcloud auth application-default login" (or set GOOGLE_APPLICATION_CREDENTIALS) and configure the Google Cloud project for agy, then confirm here. Nothing is stored by OpenCode.',
  ),
];

export function registerIntegration(ctx: OpenCodeV2PluginContext): void {
  (ctx.integration as any)?.transform?.((editor: any) => {
    editor?.update?.(AGY_ACP_PROVIDER_ID, (integration: any) => {
      integration.name = AGY_ACP_PROVIDER_NAME;
    });
    for (const registration of AGY_ACP_AUTH_METHODS) editor?.method?.update?.(registration);
  });
}

export interface ResolvedAuth {
  /**
   * Non-secret identity of the active credential; changes on connection or key
   * switch. Holds a truncated SHA-256 of an API key, never the key itself.
   */
  identity: string;
  connection: unknown;
  method: AgyAuthMethod;
  apiKey?: string;
}

/** Reads the active OpenCode connection. No connection means agy's own Google login. */
export async function resolveAuth(ctx: OpenCodeV2PluginContext): Promise<ResolvedAuth> {
  const api = ctx.integration?.connection;
  let connection: any;
  let credential: any;
  try {
    connection = await api?.active?.(AGY_ACP_PROVIDER_ID);
    if (connection) credential = await api?.resolve?.(connection);
  } catch {
    connection = undefined;
    credential = undefined;
  }
  const identity = connection ? `${connection.type}:${connection.id ?? connection.name}` : "none";
  if (credential?.type === "key" && typeof credential.key === "string") {
    const keyId = createHash("sha256").update(credential.key).digest("hex").slice(0, 16);
    return { identity: `${identity}#key:${keyId}`, connection, method: "gemini-api-key", apiKey: credential.key };
  }
  if (credential?.type === "external" && EXTERNAL_IDS.has(credential.methodID)) {
    return { identity, connection, method: credential.methodID as AgyAuthMethod };
  }
  return { identity, connection, method: "oauth-personal" };
}

export function statusFromProbe(probe: AgyProbe): AgyAcpStatus {
  switch (probe.status) {
    case "ready":
      return { status: "ready", version: probe.version };
    case "missing":
      return { status: "missing", message: classifyAgyError(probe).message };
    case "too_old":
      return { status: "failed", message: classifyAgyError(probe).message };
    default:
      return { status: "failed", message: `agy CLI check failed (${probe.path}): ${probe.error}` };
  }
}

/** Mirrors a status into OpenCode's connection status (only `needs_auth` exists there). */
export async function publishStatus(ctx: OpenCodeV2PluginContext, status: AgyAcpStatus): Promise<void> {
  const api = ctx.integration?.connection;
  if (!api?.status || !api.active) return;
  try {
    const connection = await api.active(AGY_ACP_PROVIDER_ID);
    if (!connection) return;
    await api.status({
      integrationID: AGY_ACP_PROVIDER_ID,
      connection,
      status: status.status === "needs_auth" ? { status: "needs_auth", message: status.message } : undefined,
    });
  } catch {
    // Status display is best-effort.
  }
}

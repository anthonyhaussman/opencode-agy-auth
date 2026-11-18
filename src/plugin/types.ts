import type { OpencodeClient, Auth } from '@opencode-ai/sdk';
import type { Provider as ProviderV1 } from '@opencode-ai/sdk';
import type { Model as ModelV2 } from '@opencode-ai/sdk/v2';
import type { Config as PluginConfig } from '@opencode-ai/plugin';

export type OAuthAuthDetails = Extract<Auth, { type: 'oauth' }>;
export type AuthDetails = Auth;
export type GetAuth = () => Promise<AuthDetails>;

export type Provider = ProviderV1;
export type ProviderModel = ModelV2;

export type Config = PluginConfig;

export type PluginClient = OpencodeClient;

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
}

// Export V2 types explicitly for use in provider hooks
export type { Provider as ProviderV2, Model as ModelV2 } from '@opencode-ai/sdk/v2';

// OpenCode v2 Plugin Contracts (without taking @opencode/plugin runtime dependency)

export interface OpenCodeV2TransformRegistry<T = any> {
  transform: (fn: (target: T) => Promise<void> | void) => void;
}

/**
 * `session.hook("model.request")` event. OpenCode 2.3 triggers it before each
 * model call; the published typings do not declare it yet, so it is typed here.
 */
export interface ModelRequestEvent {
  sessionID: string;
  kind: string;
  baseURL: string;
  headers: Record<string, string>;
}

export interface OpenCodeV2SessionHook {
  (
    name: 'model.request',
    handler: (ev: ModelRequestEvent) => void | Promise<void>,
    options?: { providerID?: string },
  ): unknown;
  (name: string, handler: (...args: any[]) => any, options?: { providerID?: string }): unknown;
}

export interface OpenCodeV2SessionRegistry {
  hook: OpenCodeV2SessionHook;
  prompt?: (input: any) => Promise<any> | any;
}

export interface OpenCodeV2PluginLocation {
  root?: string;
  workspace?: string;
  directory?: string;
  /** Set when the session runs in a remote workspace. */
  workspaceID?: string;
}

/** OpenCode 2.3 connection status: only `needs_auth` exists; `undefined` clears it. */
export interface OpenCodeV2ConnectionStatus {
  status: 'needs_auth';
  message: string;
  url?: string;
}

export interface OpenCodeV2IntegrationConnection {
  active?: (integrationID: string) => Promise<any>;
  resolve?: (connection: any) => Promise<any>;
  status?: (input: {
    integrationID: string;
    connection: any;
    status?: OpenCodeV2ConnectionStatus;
  }) => Promise<void> | void;
}

export interface OpenCodeV2PluginContext {
  /** `reload()` re-runs every catalog transform (OpenCode v2 promise plugins). */
  catalog?: OpenCodeV2TransformRegistry & { reload?: () => Promise<void> | void };
  /** OpenCode 2.3.x exposes `reload()` here instead of on `catalog`. */
  provider?: OpenCodeV2TransformRegistry & { reload?: () => Promise<void> | void };
  model?: OpenCodeV2TransformRegistry & { reload?: () => Promise<void> | void };
  tool: OpenCodeV2TransformRegistry;
  command: OpenCodeV2TransformRegistry;
  session: OpenCodeV2SessionRegistry;
  aisdk?: {
    hook: (
      name: 'sdk' | 'language',
      handler: (event: any) => Promise<void> | void,
    ) => Promise<{ dispose(): void } | void> | void;
  };
  integration?: (OpenCodeV2TransformRegistry | {
    transform?: (transformer: (editor: any) => void) => void;
  }) & { connection?: OpenCodeV2IntegrationConnection };
  location: OpenCodeV2PluginLocation;
}

export interface OpenCodeV2PluginDefinition {
  id: string;
  setup: (ctx: OpenCodeV2PluginContext) => Promise<void> | void;
}

export function defineOpenCodeV2Plugin(
  def: OpenCodeV2PluginDefinition,
): OpenCodeV2PluginDefinition {
  return def;
}

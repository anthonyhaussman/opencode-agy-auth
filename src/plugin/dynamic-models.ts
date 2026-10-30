import { AGY_PROVIDER_ID } from '../constants';
import { fetchAvailableModels, type FetchAvailableModelsResponse } from '../sdk/fetch_models';
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from './auth';
import { resolveCachedAuth } from './cache';
import { ensureProjectContext } from './project';
import { refreshAccessToken } from './token';
import { saveStoredAuthToJson } from './v2-storage';
import type { SimpleStaticModel } from './tier';

export function selectAvailableModels(
  response: FetchAvailableModelsResponse,
): Record<string, SimpleStaticModel> {
  if (!response.models || !Array.isArray(response.agentModelSorts)) {
    throw new Error('Incomplete model inventory');
  }

  const selected: Record<string, SimpleStaticModel> = {};
  for (const group of response.agentModelSorts.flatMap(sort => sort.groups ?? [])) {
    for (const modelId of group.modelIds ?? []) {
      const model = response.models[modelId];
      if (!model?.displayName || modelId.endsWith('-disabled')) continue;
      selected[modelId] = {
        name: model.displayName,
        description: model.displayName,
        maxTokens: model.maxTokens || 200000,
        maxOutputTokens: model.maxOutputTokens || 32000,
        toolCall: true,
        reasoning: model.supportsThinking ?? false,
        attachment: model.supportsImages ?? false,
      };
    }
  }
  if (!Object.keys(selected).length) {
    throw new Error('Empty model inventory');
  }
  return selected;
}

export interface AccountInventory {
  connection: { type: string; id: string };
  models: Record<string, SimpleStaticModel>;
  enums: Record<string, string>;
}

export async function loadAccountModels(ctx: any): Promise<AccountInventory> {
  const connection = await ctx.integration?.connection?.active?.(AGY_PROVIDER_ID);
  if (connection?.type !== 'credential' || !connection.id) {
    throw new Error('Antigravity OAuth connection is unavailable');
  }
  const resolved = connection ? await ctx.integration.connection.resolve(connection) : undefined;
  const auth = resolved?.type === 'credential' ? resolved.credential : resolved;
  if (!isOAuthAuth(auth)) {
    throw new Error('Antigravity OAuth is not connected');
  }
  const client = { auth: { set: async ({ body }: any) => saveStoredAuthToJson(body) } } as any;
  let current = resolveCachedAuth(auth);
  if (accessTokenExpired(current)) {
    const refreshed = await refreshAccessToken(current, client);
    if (!refreshed?.access) {
      throw new Error('Antigravity access token refresh failed');
    }
    current = refreshed;
  }
  if (!current.access) {
    throw new Error('Antigravity access token unavailable');
  }
  const parts = parseRefreshParts(current.refresh);
  const project = parts.managedProjectId || (await ensureProjectContext(current, client)).effectiveProjectId;
  if (!project) {
    throw new Error('Antigravity project unavailable');
  }
  const response = await fetchAvailableModels(current.access, project, undefined, AbortSignal.timeout(15_000));
  const models = selectAvailableModels(response);
  const enums: Record<string, string> = {};
  for (const id of Object.keys(models)) {
    const modelEnum = response.models?.[id]?.model;
    if (typeof modelEnum === 'string' && modelEnum) enums[id] = modelEnum;
  }
  return { connection, models, enums };
}

import { AGY_PROVIDER_ID } from '../constants';
import { fetchAvailableModels, type FetchAvailableModelsResponse } from '../sdk/fetch_models';
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from './auth';
import { resolveCachedAuth } from './cache';
import { ensureProjectContext } from './project';
import { refreshAccessToken } from './token';
import { loadStoredAuthFromJson, saveStoredAuthToJson } from './v2-storage';
import type { SimpleStaticModel } from './tier';

export function selectAvailableModels(response: FetchAvailableModelsResponse): Record<string, SimpleStaticModel> {
  if (!response.models || !Array.isArray(response.agentModelSorts)) throw new Error('Incomplete model inventory');
  const selected: Record<string, SimpleStaticModel> = {};
  for (const group of response.agentModelSorts.flatMap(sort => sort.groups ?? [])) {
    for (const id of group.modelIds ?? []) {
      const model = response.models[id];
      if (!model?.displayName || id.endsWith('-disabled')) continue;
      selected[id] = {
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
  if (!Object.keys(selected).length) throw new Error('Empty model inventory');
  return selected;
}

export async function loadAccountModels(ctx: any): Promise<Record<string, SimpleStaticModel>> {
  const connection = await ctx.integration?.connection?.active?.(AGY_PROVIDER_ID);
  const resolved = connection ? await ctx.integration.connection.resolve(connection) : undefined;
  const auth = resolved?.type === 'credential' ? resolved.credential : loadStoredAuthFromJson();
  if (!isOAuthAuth(auth)) throw new Error('Antigravity OAuth is not connected');
  const client = { auth: { set: async ({ body }: any) => saveStoredAuthToJson(body) } } as any;
  let current = resolveCachedAuth(auth);
  if (accessTokenExpired(current)) current = await refreshAccessToken(current, client) || current;
  if (!current.access) throw new Error('Antigravity access token unavailable');
  const parts = parseRefreshParts(current.refresh);
  const project = parts.managedProjectId || (await ensureProjectContext(current, client)).effectiveProjectId;
  if (!project) throw new Error('Antigravity project unavailable');
  return selectAvailableModels(await fetchAvailableModels(current.access, project));
}

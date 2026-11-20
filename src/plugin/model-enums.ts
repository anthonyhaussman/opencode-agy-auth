import { fetchAvailableModels } from '../sdk/fetch_models';

/**
 * Runtime model → backend enum map.
 *
 * The Code Assist request carries `labels.model_enum`, which routes the call to
 * the right (Antigravity) quota bucket. Hardcoding those enums in a bundled
 * catalog is exactly what broke before (stale models, wrong bucket, silent
 * "Individual quota reached"). So they are fetched from the account's own
 * catalogue, per project, with a short TTL.
 */
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; enums: Record<string, string> }>();

export async function getModelEnums(
  accessToken: string,
  projectId: string,
  userAgentModel?: string
): Promise<Record<string, string> | undefined> {
  if (!accessToken || !projectId) {
    return undefined;
  }
  const key = projectId;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return cached.enums;
  }
  try {
    const response = await fetchAvailableModels(accessToken, projectId, userAgentModel);
    const enums: Record<string, string> = {};
    for (const [name, details] of Object.entries(response.models ?? {})) {
      const enumValue = details && typeof details.model === 'string' ? details.model : '';
      if (enumValue) {
        enums[name] = enumValue;
      }
    }
    if (Object.keys(enums).length > 0) {
      cache.set(key, { at: Date.now(), enums });
      return enums;
    }
  } catch {
    // Best effort: fall back to whatever was cached, else no enum at all.
  }
  return cached?.enums;
}

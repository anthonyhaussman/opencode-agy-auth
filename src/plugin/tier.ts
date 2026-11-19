import { getSafeHeader } from './headers';

export interface SimpleStaticModel {
  name: string;
  description: string;
  maxTokens: number;
  maxOutputTokens: number;
  toolCall: boolean;
  reasoning: boolean;
  attachment: boolean;
  cost?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
  };
}

/**
 * Dynamic model metadata derived from model ID patterns.
 * No hardcoded lists — everything inferred from AGY quota response.
 */
export function inferModelMetadata(modelId: string): SimpleStaticModel {
  const isClaude = modelId.startsWith('claude-');
  const isGpt = modelId.startsWith('gpt-');
  const isGemini = modelId.startsWith('gemini-');

  // Base defaults
  let name = modelId;
  let description = `${modelId} model. Select tier at runtime.`;
  let maxTokens = 1048576;
  let maxOutputTokens = 65536;
  let toolCall = true;
  let reasoning = true;
  let attachment = true;

  if (isClaude) {
    name = modelId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    description = `${name} deep reasoning model. Select tier at runtime.`;
    maxTokens = 1000000;
    maxOutputTokens = 128000;
    attachment = true;
  } else if (isGpt) {
    name = modelId.toUpperCase().replace(/-/g, ' ');
    description = `GPT open-source model. Select tier at runtime.`;
    maxTokens = 131072;
    maxOutputTokens = 32768;
    attachment = false;
  } else if (isGemini) {
    // Some newer variants have larger output
  if (maxOutputTokens < 262144 && /-4\b/.test(modelId) && modelId.split('-').length >= 3) {
    maxOutputTokens = 262144;
  }
    name = modelId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    description = `${name} base model. Select tier at runtime.`;
    attachment = true;
  }

  return {
    name,
    description,
    maxTokens,
    maxOutputTokens,
    toolCall,
    reasoning,
    attachment
  };
}

/**
 * Extract base model ID from a tiered model ID.
 */
export function extractBaseModelId(tieredModelId: string): string {
  const tierSuffixes = ['-minimal', '-low', '-medium', '-high', '-xhigh'];
  for (const suffix of tierSuffixes) {
    if (tieredModelId.endsWith(suffix)) {
      return tieredModelId.slice(0, -suffix.length);
    }
  }
  return tieredModelId;
}

/**
 * Build tier mapping dynamically from a list of tiered model IDs.
 * Returns mapping from base model ID to its available tiers.
 */
export function buildTierMapping(modelIds: string[]): Record<string, Record<string, string>> {
  const mapping: Record<string, Record<string, string>> = {};

  for (const modelId of modelIds) {
    const base = extractBaseModelId(modelId);
    const tier = modelId.slice(base.length + 1); // +1 for the dash

    if (!mapping[base]) {
      mapping[base] = {};
    }
    mapping[base][tier] = modelId;
  }

  return mapping;
}

/**
 * Resolves a model ID and optional request headers or suffix into the appropriate tier variant.
 * Uses dynamically built TIER_MAPPING.
 */
export function resolveModelTier(
  baseModelId: string,
  headersOrInit?: RequestInit | unknown,
  tierMapping?: Record<string, Record<string, string>>
): string {
  const parts = baseModelId.split('@');
  const base = parts[0] || '';
  const suffixTier = parts[1]?.toLowerCase();

  const mapping = tierMapping?.[base];
  if (!mapping) {
    return baseModelId;
  }

  const rawHeaders =
    headersOrInit && typeof headersOrInit === 'object' && 'headers' in headersOrInit
      ? (headersOrInit as RequestInit).headers
      : headersOrInit;

  const headerTier = getSafeHeader(rawHeaders, 'x-agy-tier')?.toLowerCase() || null;
  const requestedTier = headerTier || suffixTier;

  if (requestedTier && Object.prototype.hasOwnProperty.call(mapping, requestedTier)) {
    return mapping[requestedTier] || baseModelId;
  }

  // Default priority: medium > high > first available
  return mapping['medium'] ?? mapping['high'] ?? Object.values(mapping)[0] ?? baseModelId;
}

/**
 * Fetch available model IDs from AGY quota API.
 * Returns a Set of model IDs that the current account/project has access to.
 */
export async function fetchAvailableModelIds(
  retrieveUserQuota: (accessToken: string, projectId: string, userAgentModel?: string) => Promise<{ buckets?: Array<{ modelId?: string }> } | null>,
  accessToken: string,
  projectId: string,
  userAgentModel?: string
): Promise<Set<string>> {
  const quota = await retrieveUserQuota(accessToken, projectId, userAgentModel);
  if (!quota?.buckets?.length) return new Set();

  const modelIds = new Set<string>();
  for (const bucket of quota.buckets) {
    if (bucket.modelId) {
      modelIds.add(bucket.modelId);
    }
  }
  return modelIds;
}
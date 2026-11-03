import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import type { ProviderModel } from './types';
import type { SimpleStaticModel } from './tier';

// Using fetch API (available in Node.js 18+)
const PRICING_API_URL = 'https://models.dev/api.json';
const CACHE_FILE_NAME = 'agy-pricing-cache.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let memoryCache: ModelsDevResponse | null = null;

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  [key: string]: any;
}

interface ModelsDevModel {
  cost?: ModelsDevCost;
  [key: string]: any;
}

interface ModelsDevProvider {
  models: Record<string, ModelsDevModel>;
  [key: string]: any;
}

type ModelsDevResponse = Record<string, ModelsDevProvider>;

function getCachePath(): string {
  try {
    return join(tmpdir(), `${CACHE_FILE_NAME}-${userInfo().uid}`);
  } catch (err) {
    return join(tmpdir(), CACHE_FILE_NAME);
  }
}

function loadCachedPricing(): ModelsDevResponse | null {
  try {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) return null;

    const stats = statSync(cachePath);
    if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) {
      return null; // Cache expired
    }

    const data = readFileSync(cachePath, 'utf-8');
    return JSON.parse(data) as ModelsDevResponse;
  } catch (err) {
    return null;
  }
}

function savePricingCache(data: ModelsDevResponse): void {
  try {
    const cachePath = getCachePath();
    writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
  } catch (err) {
    // Ignore cache write errors
  }
}

async function fetchPricing(): Promise<ModelsDevResponse | null> {
  if (memoryCache) {
    return memoryCache;
  }

  const cached = loadCachedPricing();
  if (cached) {
    memoryCache = cached;
    return cached;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(PRICING_API_URL, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as ModelsDevResponse;
    if (data) {
      savePricingCache(data);
      memoryCache = data;
      return data;
    }
  } catch (err) {
    clearTimeout(timeoutId);
    // Silent fail, will fallback to 0 or existing costs
  }

  return null;
}

function determineProvider(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('gemini-') || lower.startsWith('gemma-')) return 'google';
  if (lower.startsWith('claude-')) return 'anthropic';
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3')) return 'openai';
  return null;
}

interface ExistingModelCost {
  input?: number;
  output?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

interface ResolvedModelCost {
  input: number;
  output: number;
  cache: {
    read: number;
    write: number;
  };
}

function findApiModelCost(
  providerModels: Record<string, ModelsDevModel>,
  modelId: string
): ModelsDevCost | undefined {
  const baseWithoutAt = modelId.split('@')[0] || modelId;
  const exact = providerModels[baseWithoutAt];
  if (exact?.cost) {
    return exact.cost;
  }

  let candidate = baseWithoutAt;
  while (candidate.includes('-')) {
    candidate = candidate.slice(0, candidate.lastIndexOf('-'));
    const fallback = providerModels[candidate];
    if (fallback?.cost) {
      return fallback.cost;
    }
  }

  return undefined;
}

function resolveModelCost(
  modelId: string,
  existingCost: ExistingModelCost | undefined,
  pricingData: ModelsDevResponse
): ResolvedModelCost | undefined {
  const provider = determineProvider(modelId);
  const providerModels = provider ? pricingData[provider]?.models : undefined;
  if (!providerModels) return undefined;

  const apiCost = findApiModelCost(providerModels, modelId);
  if (!apiCost) return undefined;

  return {
    input: apiCost.input ?? existingCost?.input ?? 0,
    output: apiCost.output ?? existingCost?.output ?? 0,
    cache: {
      read: apiCost.cache_read ?? existingCost?.cache?.read ?? 0,
      write: apiCost.cache_write ?? existingCost?.cache?.write ?? 0
    }
  };
}

/**
 * Mutates the STATIC_MODELS object by injecting dynamic costs from models.dev
 */
export function updateStaticModelsWithPricing(
  staticModels: Record<string, ProviderModel>
): void {
  fetchPricing().then((pricingData) => {
    if (!pricingData) return;

    for (const [modelId, modelObj] of Object.entries(staticModels)) {
      const resolvedCost = resolveModelCost(modelId, modelObj.cost, pricingData);
      if (resolvedCost) {
        modelObj.cost = resolvedCost;
      }
    }
  }).catch(() => {
    // Ignore errors to prevent unhandled rejections
  });
}

/**
 * Enriches SimpleStaticModel entries with dynamic costs from models.dev when available.
 */
export async function applyPricingToSimpleModels<T extends Record<string, SimpleStaticModel>>(
  models: T
): Promise<T> {
  try {
    const pricingData = await fetchPricing();
    if (!pricingData) return models;

    for (const [modelId, modelObj] of Object.entries(models)) {
      const resolvedCost = resolveModelCost(modelId, modelObj.cost, pricingData);
      if (resolvedCost) {
        modelObj.cost = resolvedCost;
      }
    }
  } catch {
    // Ignore pricing errors and preserve existing models
  }

  return models;
}

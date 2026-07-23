import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import type { ProviderModel } from './types';

// Using fetch API (available in Node.js 18+)
const PRICING_API_URL = 'https://models.dev/api.json';
const CACHE_FILE_NAME = 'agy-pricing-cache.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  return join(tmpdir(), CACHE_FILE_NAME);
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
  const cached = loadCachedPricing();
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(PRICING_API_URL);
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as ModelsDevResponse;
    if (data) {
      savePricingCache(data);
      return data;
    }
  } catch (err) {
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

/**
 * Mutates the STATIC_MODELS object by injecting dynamic costs from models.dev
 */
export async function updateStaticModelsWithPricing(
  staticModels: Record<string, ProviderModel>
): Promise<void> {
  const pricingData = await fetchPricing();
  if (!pricingData) return;

  for (const [modelId, modelObj] of Object.entries(staticModels)) {
    const provider = determineProvider(modelId);
    if (!provider || !pricingData[provider]?.models) continue;

    // Remove the "-thinking" suffix which is custom for opencode if the base model exists
    let lookupId = modelId;
    if (lookupId.endsWith('-thinking') && !pricingData[provider].models[lookupId]) {
      lookupId = lookupId.replace('-thinking', '');
    }

    const apiModel = pricingData[provider].models[lookupId];
    if (apiModel && apiModel.cost) {
      const apiCost = apiModel.cost;
      
      modelObj.cost = {
        input: apiCost.input ?? modelObj.cost?.input ?? 0,
        output: apiCost.output ?? modelObj.cost?.output ?? 0,
        cache: {
          read: apiCost.cache_read ?? modelObj.cost?.cache?.read ?? 0,
          write: apiCost.cache_write ?? modelObj.cost?.cache?.write ?? 0
        }
      };
    }
  }
}

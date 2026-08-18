import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateStaticModelsWithPricing } from '../../src/plugin/pricing.js';

describe('pricing', () => {
  const cacheFileName = `agy-pricing-cache.json-${os.userInfo().uid}`;
  const cacheFilePath = path.join(os.tmpdir(), cacheFileName);

  beforeEach(() => {
    vi.resetModules();
    if (fs.existsSync(cacheFilePath)) {
      fs.unlinkSync(cacheFilePath);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(cacheFilePath)) {
      fs.unlinkSync(cacheFilePath);
    }
  });

  it('loads pricing from cache when fresh', async () => {
    const cachedData = {
      google: {
        models: {
          'gemini-2.5-flash-cached-test': {
            cost: {
              input: 0.075,
              output: 0.3,
            },
          },
        },
      },
    };
    fs.writeFileSync(cacheFilePath, JSON.stringify(cachedData));

    const { updateStaticModelsWithPricing: updatePricing } = await import('../../src/plugin/pricing.js');

    const staticModels: any = {
      'gemini-2.5-flash-cached-test': {
        id: 'gemini-2.5-flash-cached-test',
      },
    };

    updatePricing(staticModels);
    await new Promise((r) => setTimeout(r, 50));

    expect(staticModels['gemini-2.5-flash-cached-test'].cost).toEqual({
      input: 0.075,
      output: 0.3,
      cache: {
        read: 0,
        write: 0,
      },
    });
  });

  it('updates static models with fetched pricing', async () => {
    const mockApiResponse = {
      google: {
        models: {
          'gemini-2.5-pro': {
            cost: {
              input: 1.25,
              output: 5.0,
              cache_read: 0.3125,
            },
          },
        },
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockApiResponse), { status: 200 })
    );

    const { updateStaticModelsWithPricing: updatePricing } = await import('../../src/plugin/pricing.js');

    const staticModels: any = {
      'gemini-2.5-pro': {
        id: 'gemini-2.5-pro',
        cost: undefined,
      },
    };

    updatePricing(staticModels);

    await new Promise((r) => setTimeout(r, 100));

    expect(staticModels['gemini-2.5-pro'].cost).toEqual({
      input: 1.25,
      output: 5.0,
      cache: {
        read: 0.3125,
        write: 0,
      },
    });
  });

  it('handles fetch failure gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const { updateStaticModelsWithPricing: updatePricing } = await import('../../src/plugin/pricing.js');

    const staticModels: any = {
      'gemini-unknown-fail': {
        id: 'gemini-unknown-fail',
      },
    };

    expect(() => updatePricing(staticModels)).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(staticModels['gemini-unknown-fail'].cost).toBeUndefined();
  });

  it('updates claude and gpt models and strips -thinking suffix', async () => {
    const mockApiResponse = {
      anthropic: {
        models: {
          'claude-3-5-sonnet': {
            cost: {
              input: 3.0,
              output: 15.0,
              cache_read: 0.3,
              cache_write: 3.75
            }
          }
        }
      },
      openai: {
        models: {
          'gpt-4o': {
            cost: {
              input: 2.5,
              output: 10.0
            }
          }
        }
      }
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockApiResponse), { status: 200 })
    );

    const { updateStaticModelsWithPricing: updatePricing } = await import('../../src/plugin/pricing.js');

    const staticModels: any = {
      'claude-3-5-sonnet-thinking': {
        id: 'claude-3-5-sonnet-thinking'
      },
      'gpt-4o': {
        id: 'gpt-4o'
      },
      'unsupported-model': {
        id: 'unsupported-model'
      }
    };

    updatePricing(staticModels);
    await new Promise((r) => setTimeout(r, 100));

    expect(staticModels['claude-3-5-sonnet-thinking'].cost?.input).toBe(3.0);
    expect(staticModels['gpt-4o'].cost?.input).toBe(2.5);
    expect(staticModels['unsupported-model'].cost).toBeUndefined();
  });

  it('handles expired cache and fetch 404', async () => {
    const cachedData = {
      google: {
        models: {
          'gemini-expired': { cost: { input: 1, output: 2 } }
        }
      }
    };
    fs.writeFileSync(cacheFilePath, JSON.stringify(cachedData));

    // Force expired mtime (25 hours ago)
    const oldTime = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(cacheFilePath, oldTime, oldTime);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not found', { status: 404 })
    );

    const { updateStaticModelsWithPricing: updatePricing } = await import('../../src/plugin/pricing.js');

    const staticModels: any = {
      'gemini-expired': { id: 'gemini-expired' }
    };

    updatePricing(staticModels);
    await new Promise((r) => setTimeout(r, 100));
    expect(staticModels['gemini-expired'].cost).toBeUndefined();
  });
});

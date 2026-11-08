import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { updateStaticModelsWithPricing } from '../../src/plugin/pricing.js';

describe('pricing', () => {
  const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pricing-test-'));
  const cacheFileName = `agy-pricing-cache.json-${os.userInfo().uid}`;
  const cacheFilePath = path.join(testTmpDir, cacheFileName);

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return {
        ...actual,
        tmpdir: () => testTmpDir,
      };
    });
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

  afterAll(() => {
    fs.rmSync(testTmpDir, { recursive: true, force: true });
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

    await updatePricing(staticModels);

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

    await updatePricing(staticModels);

    expect(staticModels['gemini-2.5-pro'].cost).toEqual({
      input: 1.25,
      output: 5.0,
      cache: {
        read: 0.3125,
        write: 0,
      },
    });
  });

  it('ignores non-pricing JSON in disk cache and fetched responses without poisoning cache', async () => {
    fs.writeFileSync(cacheFilePath, JSON.stringify({ buckets: [] }));

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

    await updatePricing(staticModels);

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

    await expect(updatePricing(staticModels)).resolves.toBeUndefined();
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

    await updatePricing(staticModels);

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

    await updatePricing(staticModels);
    expect(staticModels['gemini-expired'].cost).toBeUndefined();
  });

  it('enriches SimpleStaticModel entries via applyPricingToSimpleModels with exact and base prefix fallback', async () => {
    const mockApiResponse = {
      google: {
        models: {
          'gemini-2.5-pro': {
            cost: {
              input: 1.25,
              output: 5.0,
              cache_read: 0.3125,
              cache_write: 1.25,
            },
          },
          'gemini-3.8-flash': {
            cost: {
              input: 0.15,
              output: 0.6,
              cache_read: 0.0375,
            },
          },
        },
      },
      openai: {
        models: {
          'gpt-oss-120b': {
            cost: {
              input: 0.2,
              output: 0.8,
            },
          },
        },
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockApiResponse), { status: 200 })
    );

    const { applyPricingToSimpleModels } = await import('../../src/plugin/pricing.js');

    const models = {
      'gemini-2.5-pro': {
        name: 'Gemini 2.5 Pro',
        description: 'Exact match model',
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        toolCall: true,
        reasoning: true,
        attachment: true,
      },
      'gemini-3.8-flash-high': {
        name: 'Gemini 3.8 Flash High',
        description: 'Tiered suffix fallback model',
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        toolCall: true,
        reasoning: true,
        attachment: true,
      },
      'gpt-oss-120b-medium': {
        name: 'GPT-OSS 120B (Medium)',
        description: 'Base prefix fallback model',
        maxTokens: 131072,
        maxOutputTokens: 32768,
        toolCall: true,
        reasoning: true,
        attachment: false,
      },
      'claude-future-9': {
        name: 'Claude Future 9',
        description: 'Model missing in models.dev with existing cost',
        maxTokens: 1000000,
        maxOutputTokens: 128000,
        toolCall: true,
        reasoning: true,
        attachment: true,
        cost: {
          input: 4.0,
          output: 20.0,
          cache: { read: 0.4, write: 5.0 },
        },
      },
    };

    const result = await applyPricingToSimpleModels(models);

    expect(result).toBe(models);
    expect(result['gemini-2.5-pro'].cost).toEqual({
      input: 1.25,
      output: 5.0,
      cache: { read: 0.3125, write: 1.25 },
    });
    expect(result['gemini-3.8-flash-high'].cost).toEqual({
      input: 0.15,
      output: 0.6,
      cache: { read: 0.0375, write: 0 },
    });
    expect(result['gpt-oss-120b-medium'].cost).toEqual({
      input: 0.2,
      output: 0.8,
      cache: { read: 0, write: 0 },
    });
    expect(result['claude-future-9'].cost).toEqual({
      input: 4.0,
      output: 20.0,
      cache: { read: 0.4, write: 5.0 },
    });
  });

  it('preserves existing cost and never throws when fetchPricing returns null, rejects, or times out', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection refused'));

    const { applyPricingToSimpleModels } = await import('../../src/plugin/pricing.js');

    const models = {
      'gemini-4-argon': {
        name: 'Gemini 4 Argon',
        description: 'Fallback cost preserved',
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        toolCall: true,
        reasoning: true,
        attachment: true,
        cost: {
          input: 1.5,
          output: 6.0,
          cache: { read: 0.3, write: 1.5 },
        },
      },
    };

    const afterReject = await applyPricingToSimpleModels(models);
    expect(afterReject['gemini-4-argon'].cost).toEqual({
      input: 1.5,
      output: 6.0,
      cache: { read: 0.3, write: 1.5 },
    });

    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      );

      const pending = applyPricingToSimpleModels(models);
      await vi.advanceTimersByTimeAsync(2500);
      const afterTimeout = await pending;
      expect(afterTimeout['gemini-4-argon'].cost).toEqual({
        input: 1.5,
        output: 6.0,
        cache: { read: 0.3, write: 1.5 },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

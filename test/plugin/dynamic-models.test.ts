import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchAvailableModelsResponse } from '../../src/sdk/fetch_models';
import { STATIC_MODELS_SIMPLE } from '../../src/plugin/tier';
import { normalizeDiscoveredModels } from '../../src/plugin/dynamic-models';

const repoModelsJson = JSON.parse(
  readFileSync(join(process.cwd(), 'models.json'), 'utf8')
) as FetchAvailableModelsResponse;

describe('normalizeDiscoveredModels', () => {
  it('normalizes real models.json catalog, collapses multi-tier families, keeps gpt-oss-120b-medium standalone, and indexes all enums', () => {
    const input: FetchAvailableModelsResponse = {
      ...repoModelsJson,
      agentModelSorts: [
        {
          displayName: 'Recommended',
          groups: [
            {
              modelIds: [
                ...(repoModelsJson.agentModelSorts?.[0]?.groups?.[0]?.modelIds ?? []),
                'chat_20706',
                'gemini-4-argon-disabled',
                'non-existent-model-id',
              ],
            },
          ],
        },
      ],
      models: {
        ...repoModelsJson.models,
        'gemini-4-argon-disabled': {
          displayName: 'Gemini 4 Argon Disabled',
          maxTokens: 1048576,
          maxOutputTokens: 65536,
          model: 'MODEL_PLACEHOLDER_DISABLED',
        },
        'empty-enum-internal': {
          displayName: '',
          model: '   ',
        },
      },
    };

    const result = normalizeDiscoveredModels(input);

    expect(Object.keys(result.models)).toEqual([
      'gemini-4-argon',
      'gemini-3.8-flash',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-oss-120b-medium',
    ]);

    expect(result.models['gemini-4-argon']?.name).toBe('Gemini 4 Argon');
    expect(result.models['gemini-3.8-flash']?.name).toBe('Gemini 3.8 Flash');
    expect(result.models['claude-opus-5-5']?.name).toBe('Claude Opus 5.5');
    expect(result.models['claude-sonnet-5-5']?.name).toBe('Claude Sonnet 5.5');
    expect(result.models['gpt-oss-120b-medium']?.name).toBe('GPT-OSS 120B (Medium)');

    expect(result.models['gpt-oss-120b']).toBeUndefined();
    expect(result.models['chat_20706']).toBeUndefined();
    expect(result.models['gemini-4-argon-disabled']).toBeUndefined();

    expect(result.tierMapping['gemini-4-argon']).toEqual({
      low: 'gemini-4-argon-low',
      medium: 'gemini-4-argon-medium',
      high: 'gemini-4-argon-high',
    });
    expect(result.tierMapping['gemini-3.8-flash']).toEqual({
      low: 'gemini-3.8-flash-low',
      medium: 'gemini-3.8-flash-medium',
      high: 'gemini-3.8-flash-high',
    });
    expect(result.tierMapping['claude-opus-5-5']).toEqual({
      low: 'claude-opus-5-5-low',
      medium: 'claude-opus-5-5-medium',
      high: 'claude-opus-5-5-high',
    });
    expect(result.tierMapping['claude-sonnet-5-5']).toEqual({
      low: 'claude-sonnet-5-5-low',
      medium: 'claude-sonnet-5-5-medium',
      high: 'claude-sonnet-5-5-high',
    });
    expect(result.tierMapping['gpt-oss-120b']).toBeUndefined();
    expect(result.tierMapping['gpt-oss-120b-medium']).toBeUndefined();

    expect(result.enums['gemini-4-argon-high']).toBe('MODEL_PLACEHOLDER_M417');
    expect(result.enums['gemini-4-argon-medium']).toBe('MODEL_PLACEHOLDER_M418');
    expect(result.enums['gemini-4-argon-low']).toBe('MODEL_PLACEHOLDER_M419');
    expect(result.enums['chat_20706']).toBe('MODEL_CHAT_20706');
    expect(result.enums['gemini-4-argon-disabled']).toBe('MODEL_PLACEHOLDER_DISABLED');
    expect(result.enums['empty-enum-internal']).toBeUndefined();
  });

  it('collapses brand-new multi-tier families, strips trailing tier display suffixes, and keeps unknown single-tier models standalone', () => {
    const response: FetchAvailableModelsResponse = {
      agentModelSorts: [
        {
          displayName: 'Recommended',
          groups: [
            {
              modelIds: [
                'gemini-4.2-pro-high',
                'gemini-4.2-pro-minimal',
                'gemini-5-pro-low',
                'gemini-5-pro-high',
                'llama-4-maverick-medium',
                'gemini-6-omni',
              ],
            },
          ],
        },
        {
          displayName: 'Secondary duplicate sort',
          groups: [
            {
              modelIds: ['gemini-5-pro-low', 'gemini-5-pro-high'],
            },
          ],
        },
      ],
      models: {
        'gemini-4.2-pro-high': {
          displayName: 'Gemini 4.2 Pro (High)',
          maxTokens: 2097152,
          maxOutputTokens: 131072,
          supportsThinking: true,
          supportsImages: true,
          model: 'MODEL_GEMINI_4_2_PRO_HIGH',
        },
        'gemini-4.2-pro-minimal': {
          displayName: 'Gemini 4.2 Pro (minimal)',
          maxTokens: 1048576,
          maxOutputTokens: 65536,
          supportsThinking: false,
          supportsImages: false,
          model: 'MODEL_GEMINI_4_2_PRO_MINIMAL',
        },
        'gemini-5-pro-low': {
          displayName: 'Gemini 5 Pro - LOW',
          supportsThinking: true,
          model: 'MODEL_GEMINI_5_PRO_LOW',
        },
        'gemini-5-pro-high': {
          displayName: 'Gemini 5 Pro - High',
          supportsImages: true,
          model: 'MODEL_GEMINI_5_PRO_HIGH',
        },
        'llama-4-maverick-medium': {
          displayName: 'Llama 4 Maverick (Medium)',
          maxTokens: 128000,
          maxOutputTokens: 16384,
          supportsThinking: false,
          supportsImages: false,
          model: 'MODEL_LLAMA_4_MAVERICK_MEDIUM',
        },
        'gemini-6-omni': {
          displayName: 'Gemini 6 Omni',
          maxTokens: 500000,
          maxOutputTokens: 64000,
          supportsThinking: true,
          supportsImages: true,
          model: 'MODEL_GEMINI_6_OMNI',
        },
      },
    };

    const result = normalizeDiscoveredModels(response);

    expect(Object.keys(result.models)).toEqual([
      'gemini-4.2-pro',
      'gemini-5-pro',
      'llama-4-maverick-medium',
      'gemini-6-omni',
    ]);

    expect(result.models['gemini-4.2-pro']).toEqual({
      name: 'Gemini 4.2 Pro',
      description: 'Gemini 4.2 Pro base model. Select tier at runtime.',
      maxTokens: 2097152,
      maxOutputTokens: 131072,
      toolCall: true,
      reasoning: true,
      attachment: true,
    });

    expect(result.models['gemini-5-pro']).toEqual({
      name: 'Gemini 5 Pro',
      description: 'Gemini 5 Pro base model. Select tier at runtime.',
      maxTokens: 200000,
      maxOutputTokens: 32000,
      toolCall: true,
      reasoning: true,
      attachment: true,
    });

    expect(result.models['llama-4-maverick-medium']?.name).toBe('Llama 4 Maverick (Medium)');
    expect(result.models['gemini-6-omni']?.name).toBe('Gemini 6 Omni');

    expect(result.tierMapping).toEqual({
      'gemini-4.2-pro': {
        minimal: 'gemini-4.2-pro-minimal',
        high: 'gemini-4.2-pro-high',
      },
      'gemini-5-pro': {
        low: 'gemini-5-pro-low',
        high: 'gemini-5-pro-high',
      },
    });
  });

  it('collapses a single-tier known base model when TIER_MAPPING[base] exists and preserves static fallbacks and cost', () => {
    const originalCost = STATIC_MODELS_SIMPLE['gemini-4-argon']?.cost;
    STATIC_MODELS_SIMPLE['gemini-4-argon'] = {
      ...STATIC_MODELS_SIMPLE['gemini-4-argon']!,
      cost: {
        input: 1.25,
        output: 5.0,
        cache: { read: 0.3, write: 1.25 },
      },
    };

    try {
      const response: FetchAvailableModelsResponse = {
        agentModelSorts: [
          {
            displayName: 'Recommended',
            groups: [{ modelIds: ['gemini-4-argon-high'] }],
          },
        ],
        models: {
          'gemini-4-argon-high': {
            displayName: 'Gemini 4 Argon (High)',
            supportsThinking: false,
            supportsImages: false,
            model: 'MODEL_PLACEHOLDER_M417',
          },
        },
      };

      const result = normalizeDiscoveredModels(response);

      expect(Object.keys(result.models)).toEqual(['gemini-4-argon']);
      expect(result.tierMapping['gemini-4-argon']).toEqual({
        high: 'gemini-4-argon-high',
      });
      expect(result.models['gemini-4-argon']).toEqual({
        name: 'Gemini 4 Argon',
        description: 'Gemini 4 Argon base model. Select tier at runtime.',
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        toolCall: true,
        reasoning: false,
        attachment: false,
        cost: {
          input: 1.25,
          output: 5.0,
          cache: { read: 0.3, write: 1.25 },
        },
      });
      expect(result.models['gemini-4-argon']?.cost).not.toBe(
        STATIC_MODELS_SIMPLE['gemini-4-argon']?.cost
      );
    } finally {
      if (originalCost === undefined) {
        delete STATIC_MODELS_SIMPLE['gemini-4-argon']!.cost;
      } else {
        STATIC_MODELS_SIMPLE['gemini-4-argon']!.cost = originalCost;
      }
    }
  });

  it('throws descriptive Error when models or agentModelSorts is missing or yields zero selectable models', () => {
    expect(() => normalizeDiscoveredModels({} as FetchAvailableModelsResponse)).toThrow(
      /models/i
    );

    expect(() =>
      normalizeDiscoveredModels({
        models: {
          'gemini-4-argon-high': {
            displayName: 'Gemini 4 Argon (High)',
            model: 'MODEL_PLACEHOLDER_M417',
          },
        },
      })
    ).toThrow(/agentModelSorts/i);

    expect(() =>
      normalizeDiscoveredModels({
        models: {
          'gemini-4-argon-high': {
            displayName: 'Gemini 4 Argon (High)',
            model: 'MODEL_PLACEHOLDER_M417',
          },
        },
        agentModelSorts: [],
      })
    ).toThrow(/agentModelSorts/i);

    expect(() =>
      normalizeDiscoveredModels({
        models: {
          chat_20706: {
            displayName: '',
            model: 'MODEL_CHAT_20706',
          },
          'gemini-4-argon-disabled': {
            displayName: 'Gemini 4 Argon Disabled',
            model: 'MODEL_DISABLED',
          },
        },
        agentModelSorts: [
          {
            displayName: 'Recommended',
            groups: [
              {
                modelIds: ['chat_20706', 'gemini-4-argon-disabled', 'missing-model'],
              },
            ],
          },
        ],
      })
    ).toThrow(/selectable/i);
  });
});

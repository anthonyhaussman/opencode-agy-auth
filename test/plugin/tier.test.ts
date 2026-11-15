import { describe, expect, it } from 'vitest';
import {
  resolveModelTier,
  extractBaseModelId,
  buildTierMapping,
  inferModelMetadata
} from '../../src/plugin/tier';

describe('plugin/tier (dynamic)', () => {
  it('extractBaseModelId removes tier suffixes correctly', () => {
    expect(extractBaseModelId('gemini-3.8-flash-low')).toBe('gemini-3.8-flash');
    expect(extractBaseModelId('gemini-3.8-flash-medium')).toBe('gemini-3.8-flash');
    expect(extractBaseModelId('gemini-3.8-flash-high')).toBe('gemini-3.8-flash');
    expect(extractBaseModelId('gemini-4-hydrogen-xhigh')).toBe('gemini-4-hydrogen');
    expect(extractBaseModelId('claude-opus-5-5-low')).toBe('claude-opus-5-5');
    expect(extractBaseModelId('claude-sonnet-5-5-high')).toBe('claude-sonnet-5-5');
    expect(extractBaseModelId('gpt-oss-120b-medium')).toBe('gpt-oss-120b');
    expect(extractBaseModelId('unknown-model')).toBe('unknown-model');
  });

  it('buildTierMapping groups tiered models by base', () => {
    const modelIds = [
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-high',
      'gemini-4-argon-low',
      'gemini-4-argon-high',
      'claude-opus-5-5-low',
      'claude-opus-5-5-medium',
      'claude-opus-5-5-high',
    ];
    const mapping = buildTierMapping(modelIds);

    expect(mapping['gemini-3.8-flash']).toEqual({
      low: 'gemini-3.8-flash-low',
      medium: 'gemini-3.8-flash-medium',
      high: 'gemini-3.8-flash-high',
    });
    expect(mapping['gemini-4-argon']).toEqual({
      low: 'gemini-4-argon-low',
      high: 'gemini-4-argon-high',
    });
    expect(mapping['claude-opus-5-5']).toEqual({
      low: 'claude-opus-5-5-low',
      medium: 'claude-opus-5-5-medium',
      high: 'claude-opus-5-5-high',
    });
  });

  it('inferModelMetadata generates metadata for known model patterns', () => {
    const gemini = inferModelMetadata('gemini-3.8-flash');
    expect(gemini.name).toBe('Gemini 3.8 Flash');
    expect(gemini.attachment).toBe(true);
    expect(gemini.reasoning).toBe(true);
    expect(gemini.toolCall).toBe(true);

    const hydrogen = inferModelMetadata('gemini-4-hydrogen');
    expect(hydrogen.maxOutputTokens).toBe(262144);

    const claude = inferModelMetadata('claude-opus-5-5');
    expect(claude.name).toBe('Claude Opus 5 5');
    expect(claude.maxTokens).toBe(1000000);
    expect(claude.maxOutputTokens).toBe(128000);

    const gpt = inferModelMetadata('gpt-oss-120b-medium');
    expect(gpt.name).toBe('Gpt Oss 120b Medium');
    expect(gpt.attachment).toBe(false);
    expect(gpt.maxTokens).toBe(131072);
  });

  it('resolveModelTier returns base model when no mapping', () => {
    expect(resolveModelTier('unknown-model')).toBe('unknown-model');
  });

  it('resolveModelTier defaults to medium when no tier requested', () => {
    const mapping = {
      'gemini-3.8-flash': {
        low: 'gemini-3.8-flash-low',
        medium: 'gemini-3.8-flash-medium',
        high: 'gemini-3.8-flash-high',
      },
    };
    expect(resolveModelTier('gemini-3.8-flash', undefined, mapping)).toBe('gemini-3.8-flash-medium');
    expect(resolveModelTier('gemini-4-argon', undefined, mapping)).toBe('gemini-4-argon'); // not in mapping
  });

  it('resolves tier from model suffix (@low, @high)', () => {
    const mapping = {
      'gemini-3.8-flash': {
        low: 'gemini-3.8-flash-low',
        medium: 'gemini-3.8-flash-medium',
        high: 'gemini-3.8-flash-high',
      },
    };
    expect(resolveModelTier('gemini-3.8-flash@low', undefined, mapping)).toBe('gemini-3.8-flash-low');
    expect(resolveModelTier('gemini-3.8-flash@high', undefined, mapping)).toBe('gemini-3.8-flash-high');
    expect(resolveModelTier('gemini-3.8-flash@medium', undefined, mapping)).toBe('gemini-3.8-flash-medium');
  });

  it('resolves tier from RequestInit headers', () => {
    const mapping = {
      'gemini-3.8-flash': {
        low: 'gemini-3.8-flash-low',
        medium: 'gemini-3.8-flash-medium',
        high: 'gemini-3.8-flash-high',
      },
    };
    const init: RequestInit = { headers: { 'x-agy-tier': 'low' } };
    expect(resolveModelTier('gemini-3.8-flash', init, mapping)).toBe('gemini-3.8-flash-low');
  });

  it('resolves tier from direct Headers object', () => {
    const mapping = {
      'gemini-3.8-flash': {
        low: 'gemini-3.8-flash-low',
        medium: 'gemini-3.8-flash-medium',
        high: 'gemini-3.8-flash-high',
      },
    };
    const headers = new Headers({ 'x-agy-tier': 'high' });
    expect(resolveModelTier('gemini-3.8-flash', headers, mapping)).toBe('gemini-3.8-flash-high');
  });

  it('prefers header tier over suffix tier', () => {
    const mapping = {
      'gemini-3.8-flash': {
        low: 'gemini-3.8-flash-low',
        medium: 'gemini-3.8-flash-medium',
        high: 'gemini-3.8-flash-high',
      },
    };
    const init: RequestInit = { headers: { 'x-agy-tier': 'high' } };
    expect(resolveModelTier('gemini-3.8-flash@low', init, mapping)).toBe('gemini-3.8-flash-high');
  });

  it('defaults to medium if unknown tier requested', () => {
    const mapping = {
      'gemini-3.8-flash': {
        low: 'gemini-3.8-flash-low',
        medium: 'gemini-3.8-flash-medium',
        high: 'gemini-3.8-flash-high',
      },
    };
    expect(resolveModelTier('gemini-3.8-flash@ultra', undefined, mapping)).toBe('gemini-3.8-flash-medium');
  });

  it('falls back to first available tier if medium/high not present', () => {
    const mapping = {
      'test-model': {
        low: 'test-model-low',
        xhigh: 'test-model-xhigh',
      },
    };
    expect(resolveModelTier('test-model', undefined, mapping)).toBe('test-model-low');
  });
});
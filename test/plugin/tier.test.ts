import { describe, expect, it } from 'vitest';
import {
  resolveModelTier,
  STATIC_MODELS_SIMPLE,
  TIER_MAPPING,
  type TierMap,
  type TierName,
} from '../../src/plugin/tier';

describe('plugin/tier', () => {
  it('exports STATIC_MODELS_SIMPLE and TIER_MAPPING with all 5 default models', () => {
    expect(Object.keys(STATIC_MODELS_SIMPLE)).toEqual([
      'gemini-3.8-flash',
      'gemini-4-argon',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-oss-120b-medium',
    ]);
    expect(TIER_MAPPING['gemini-3.8-flash']).toBeDefined();
    expect(TIER_MAPPING['gemini-3.8-flash'].low).toBe('gemini-3.8-flash-low');
    expect(TIER_MAPPING['gemini-3.8-flash'].medium).toBe('gemini-3.8-flash-medium');
    expect(TIER_MAPPING['gemini-3.8-flash'].high).toBe('gemini-3.8-flash-high');
    expect(TIER_MAPPING['gemini-4-argon']).toBeDefined();
    expect(TIER_MAPPING['gemini-4-argon'].low).toBe('gemini-4-argon-low');
    expect(TIER_MAPPING['gemini-4-argon'].medium).toBe('gemini-4-argon-medium');
    expect(TIER_MAPPING['gemini-4-argon'].high).toBe('gemini-4-argon-high');
  });

  it('returns unmapped model unchanged', () => {
    expect(resolveModelTier('claude-3-5-sonnet')).toBe('claude-3-5-sonnet');
  });

  it('defaults to medium when no tier requested', () => {
    expect(resolveModelTier('gemini-3.8-flash')).toBe('gemini-3.8-flash-medium');
    expect(resolveModelTier('gemini-4-argon')).toBe('gemini-4-argon-medium');
  });

  it('resolves tier from model suffix (@low, @high)', () => {
    expect(resolveModelTier('gemini-3.8-flash@low')).toBe('gemini-3.8-flash-low');
    expect(resolveModelTier('gemini-3.8-flash@high')).toBe('gemini-3.8-flash-high');
    expect(resolveModelTier('gemini-3.8-flash@medium')).toBe('gemini-3.8-flash-medium');
  });

  it('resolves tier from RequestInit headers', () => {
    const init: RequestInit = {
      headers: { 'x-agy-tier': 'low' },
    };
    expect(resolveModelTier('gemini-3.8-flash', init)).toBe('gemini-3.8-flash-low');
  });

  it('resolves tier from direct Headers object', () => {
    const headers = new Headers({ 'x-agy-tier': 'high' });
    expect(resolveModelTier('gemini-3.8-flash', headers)).toBe('gemini-3.8-flash-high');
  });

  it('prefers header tier over suffix tier', () => {
    const init: RequestInit = {
      headers: { 'x-agy-tier': 'high' },
    };
    expect(resolveModelTier('gemini-3.8-flash@low', init)).toBe('gemini-3.8-flash-high');
  });

  it('defaults to medium if unknown tier requested', () => {
    expect(resolveModelTier('gemini-3.8-flash@ultra')).toBe('gemini-3.8-flash-medium');
  });

  it('uses customTierMapping for explicit header, suffix, and default tier priority', () => {
    const requestedTier: TierName = 'high';
    const customTierMapping: Record<string, TierMap> = {
      'gemini-5-ultra': {
        low: 'gemini-5-ultra-low',
        medium: 'gemini-5-ultra-medium',
        high: 'gemini-5-ultra-high',
      },
      'gemini-high-low': {
        low: 'gemini-high-low-low',
        high: 'gemini-high-low-high',
      },
      'gemini-low-minimal': {
        minimal: 'gemini-low-minimal-minimal',
        low: 'gemini-low-minimal-low',
      },
      'gemini-minimal-only': {
        minimal: 'gemini-minimal-only-minimal',
      },
      'gemini-empty-map': {},
    };

    expect(
      resolveModelTier('gemini-5-ultra', { headers: { 'x-agy-tier': requestedTier } }, customTierMapping)
    ).toBe('gemini-5-ultra-high');
    expect(resolveModelTier('gemini-5-ultra@low', undefined, customTierMapping)).toBe(
      'gemini-5-ultra-low'
    );
    expect(resolveModelTier('gemini-5-ultra', undefined, customTierMapping)).toBe(
      'gemini-5-ultra-medium'
    );
    expect(resolveModelTier('gemini-high-low', undefined, customTierMapping)).toBe(
      'gemini-high-low-high'
    );
    expect(resolveModelTier('gemini-low-minimal', undefined, customTierMapping)).toBe(
      'gemini-low-minimal-low'
    );
    expect(resolveModelTier('gemini-minimal-only', undefined, customTierMapping)).toBe(
      'gemini-minimal-only-minimal'
    );
    expect(resolveModelTier('gemini-empty-map', undefined, customTierMapping)).toBe(
      'gemini-empty-map'
    );
  });

  it('falls back to TIER_MAPPING unless customTierMapping overrides base', () => {
    const partialCustom: Record<string, TierMap> = {
      'gemini-5-ultra': {
        low: 'gemini-5-ultra-low',
        high: 'gemini-5-ultra-high',
      },
    };
    expect(resolveModelTier('gemini-3.8-flash', undefined, undefined)).toBe(
      'gemini-3.8-flash-medium'
    );
    expect(resolveModelTier('gemini-3.8-flash', undefined, partialCustom)).toBe(
      'gemini-3.8-flash-medium'
    );

    const overridingCustom: Record<string, TierMap> = {
      'gemini-3.8-flash': {
        low: 'gemini-3.8-flash-custom-low',
        high: 'gemini-3.8-flash-custom-high',
      },
    };
    expect(resolveModelTier('gemini-3.8-flash', undefined, overridingCustom)).toBe(
      'gemini-3.8-flash-custom-high'
    );
  });

  it('leaves standalone non-mapped IDs unchanged', () => {
    const customTierMapping: Record<string, TierMap> = {
      'gemini-5-ultra': {
        low: 'gemini-5-ultra-low',
        high: 'gemini-5-ultra-high',
      },
    };
    expect(resolveModelTier('gpt-oss-120b-medium')).toBe('gpt-oss-120b-medium');
    expect(resolveModelTier('gpt-oss-120b-medium', undefined, customTierMapping)).toBe(
      'gpt-oss-120b-medium'
    );
  });
});

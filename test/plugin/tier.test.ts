import { describe, expect, it } from 'vitest';
import { resolveModelTier, TIER_MAPPING } from '../../src/plugin/tier';

describe('plugin/tier', () => {
  it('exports TIER_MAPPING with known flash models', () => {
    expect(TIER_MAPPING['gemini-3.8-flash']).toBeDefined();
    expect(TIER_MAPPING['gemini-3.8-flash'].low).toBe('gemini-3.8-flash-low');
    expect(TIER_MAPPING['gemini-3.8-flash'].medium).toBe('gemini-3.8-flash-medium');
    expect(TIER_MAPPING['gemini-3.8-flash'].high).toBe('gemini-3.8-flash-high');
  });

  it('returns unmapped model unchanged', () => {
    expect(resolveModelTier('claude-3-5-sonnet')).toBe('claude-3-5-sonnet');
  });

  it('defaults to medium when no tier requested', () => {
    expect(resolveModelTier('gemini-3.8-flash')).toBe('gemini-3.8-flash-medium');
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
});

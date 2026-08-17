import { describe, it, expect } from 'vitest';
import {
  buildMetadata,
  normalizeProjectId,
  pickOnboardTier,
  buildIneligibleTierMessage,
  throwIfValidationRequired,
  isVpcScError,
  parseJsonSafe,
  wait,
  getCacheKey,
} from '../../src/plugin/project/utils.js';

describe('project utils', () => {
  it('builds metadata with or without duet project', () => {
    const meta1 = buildMetadata('my-proj', true);
    expect(meta1.ideType).toBe('ANTIGRAVITY');
    expect(meta1.duetProject).toBe('my-proj');

    const meta2 = buildMetadata(undefined, false);
    expect(meta2.duetProject).toBeUndefined();
  });

  it('normalizes project IDs from string or CloudAiCompanionProject object', () => {
    expect(normalizeProjectId(undefined)).toBeUndefined();
    expect(normalizeProjectId('  ')).toBeUndefined();
    expect(normalizeProjectId('my-project')).toBe('my-project');
    expect(normalizeProjectId({ id: 'companion-1' })).toBe('companion-1');
    expect(normalizeProjectId({ name: 'companion-name' } as any)).toBeUndefined();
    expect(normalizeProjectId({} as any)).toBeUndefined();
  });

  it('picks onboard tier with priority', () => {
    const defaultTier = { id: 'tier-default', isDefault: true, userDefinedCloudaicompanionProject: true };
    const paidTier = { id: 'tier-paid', isDefault: false, userDefinedCloudaicompanionProject: true };
    expect(pickOnboardTier([paidTier, defaultTier])).toEqual(defaultTier);
    expect(pickOnboardTier([paidTier])).toEqual(paidTier);
    expect(pickOnboardTier([])).toEqual({ id: 'legacy-tier', userDefinedCloudaicompanionProject: true });
    expect(pickOnboardTier(undefined)).toEqual({ id: 'legacy-tier', userDefinedCloudaicompanionProject: true });
  });

  it('builds ineligible tier messages and throws validation errors', () => {
    const msg = buildIneligibleTierMessage([
      { tier: 'TIER_PAID' as any, reasonMessage: 'Ineligible payment method' },
    ]);
    expect(msg).toContain('Ineligible payment method');

    expect(buildIneligibleTierMessage([])).toBeUndefined();

    expect(() =>
      throwIfValidationRequired([
        {
          tier: 'TIER_PAID' as any,
          reasonCode: 'VALIDATION_REQUIRED',
          validationUrl: 'https://verify.google.com',
          reasonMessage: 'Please verify',
        },
      ])
    ).toThrow('Please verify');

    expect(() => throwIfValidationRequired([])).not.toThrow();
  });

  it('detects VPC-SC errors', () => {
    expect(isVpcScError(null)).toBe(false);
    expect(isVpcScError({ error: { details: [{ reason: 'SECURITY_POLICY_VIOLATED' }] } })).toBe(
      true
    );
    expect(isVpcScError({ message: 'VPC Service Controls blocked request' })).toBe(false);
    expect(isVpcScError({ error: { message: 'Normal error' } })).toBe(false);
  });

  it('parses JSON safely and executes wait', async () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonSafe('invalid json')).toBeNull();

    const start = Date.now();
    await wait(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });

  it('extracts cache key from auth details', () => {
    expect(
      getCacheKey({
        type: 'oauth',
        access: 'a',
        refresh: 'my-refresh-token|p1|m1',
        expires: 100,
      })
    ).toBe('my-refresh-token');
  });
});

import { describe, expect, it } from 'vitest';
import { selectAvailableModels } from '../../src/plugin/dynamic-models';

describe('selectAvailableModels', () => {
  it('selects recommended chat models from the account inventory, including exhausted models', () => {
    const models = selectAvailableModels({
      models: {
        'claude-sonnet-4-6': { displayName: 'Sonnet', maxTokens: 250000, maxOutputTokens: 64000 },
        'gemini-3.8-flash-high': { displayName: 'Flash High', quotaInfo: { remainingFraction: 0 } },
        'gemini-4-argon-disabled': { displayName: 'Disabled' },
        chat_internal: { displayName: 'Internal' },
      },
      agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['claude-sonnet-4-6', 'gemini-3.8-flash-high', 'gemini-4-argon-disabled', 'missing'] }] }],
    });
    expect(Object.keys(models)).toEqual(['claude-sonnet-4-6', 'gemini-3.8-flash-high']);
    expect(models['claude-sonnet-4-6']).toMatchObject({ name: 'Sonnet', maxTokens: 250000, maxOutputTokens: 64000 });
  });

  it('does not mistake an incomplete response for an empty successful inventory', () => {
    expect(() => selectAvailableModels({ models: {} })).toThrow();
  });
});

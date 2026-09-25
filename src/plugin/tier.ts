import { getSafeHeader } from './headers';

export interface SimpleStaticModel {
  name: string;
  description: string;
  maxTokens: number;
  maxOutputTokens: number;
  toolCall: boolean;
  reasoning: boolean;
  attachment: boolean;
  cost?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
  };
}

export const STATIC_MODELS_SIMPLE: Record<string, SimpleStaticModel> = {
  'gemini-3.8-flash': {
    name: 'Gemini 3.8 Flash',
    description: 'Gemini 3.8 Flash base model. Select tier at runtime.',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'gemini-3.7-flash': {
    name: 'Gemini 3.7 Flash',
    description: 'Gemini 3.7 Flash base model. Select tier at runtime.',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'gemini-3.6-flash': {
    name: 'Gemini 3.6 Flash',
    description: 'Gemini 3.6 Flash base model. Select tier at runtime.',
    maxTokens: 1048576,
    maxOutputTokens: 65536,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'gemini-3.1-pro': {
    name: 'Gemini 3.1 Pro',
    description: 'Gemini 3.1 Pro base model. Select tier at runtime.',
    maxTokens: 1048576,
    maxOutputTokens: 65535,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6 (Thinking)',
    description: 'Claude Sonnet 4.6 deep reasoning model, perfectly balancing thinking process, processing speed, and output quality.',
    maxTokens: 250000,
    maxOutputTokens: 64000,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'claude-opus-4-6-thinking': {
    name: 'Claude Opus 4.6 (Thinking)',
    description: 'Claude Opus 4.6 deep reasoning model, built-in chain of thought, highly suitable for top-tier algorithm and logic puzzles.',
    maxTokens: 250000,
    maxOutputTokens: 64000,
    toolCall: true,
    reasoning: true,
    attachment: true
  },
  'gpt-oss-120b-medium': {
    name: 'GPT-OSS 120B (Medium)',
    description: 'GPT open-source 120B parameter medium tier model, excellent performance in local deployment or specific open-source benchmarks.',
    maxTokens: 131072,
    maxOutputTokens: 32768,
    toolCall: true,
    reasoning: true,
    attachment: false
  }
};

export const TIER_MAPPING: Record<string, { low: string; high: string; medium?: string; minimal?: string } & Record<string, string | undefined>> = {
  'gemini-3.8-flash': {
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high'
  },
  'gemini-3.7-flash': {
    low: 'gemini-3.7-flash-low',
    medium: 'gemini-3.7-flash-medium',
    high: 'gemini-3.7-flash-high'
  },
  'gemini-3.6-flash': {
    minimal: 'gemini-3.6-flash-low',
    low: 'gemini-3.6-flash-low',
    medium: 'gemini-3.6-flash-medium',
    high: 'gemini-3.6-flash-high'
  },
  'gemini-3.1-pro': {
    low: 'gemini-3.1-pro-low',
    high: 'gemini-3.1-pro-high'
  }
};

/**
 * Resolves a model ID and optional request headers or suffix into the appropriate tier variant.
 */
export function resolveModelTier(
  baseModelId: string,
  headersOrInit?: RequestInit | unknown
): string {
  const parts = baseModelId.split('@');
  const base = parts[0] || '';
  const suffixTier = parts[1]?.toLowerCase();

  const mapping = TIER_MAPPING[base];
  if (!mapping) {
    return baseModelId;
  }

  const rawHeaders =
    headersOrInit && typeof headersOrInit === 'object' && 'headers' in headersOrInit
      ? (headersOrInit as RequestInit).headers
      : headersOrInit;

  const headerTier = getSafeHeader(rawHeaders, 'x-agy-tier')?.toLowerCase() || null;
  const requestedTier = headerTier || suffixTier;

  if (requestedTier && Object.prototype.hasOwnProperty.call(mapping, requestedTier)) {
    return mapping[requestedTier] || baseModelId;
  }

  return mapping['medium'] ?? mapping['high'] ?? baseModelId;
}

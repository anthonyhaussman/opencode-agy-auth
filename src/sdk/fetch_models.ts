import { AGY_CODE_ASSIST_ENDPOINT } from '../constants';
import { agyFetch } from '../fetch';
import { createAgyActivityRequestId } from './activity-request-id';
import { buildAgyCliUserAgent } from './user-agent';

export interface AvailableModelDetails {
  displayName: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  minThinkingBudget?: number;
  recommended?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
  tokenizerType?: string;
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
  model?: string;
  apiProvider?: string;
  modelProvider?: string;
  supportsVideo?: boolean;
  supportedMimeTypes?: Record<string, boolean>;
  modelExperiments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FetchAvailableModelsResponse {
  models?: Record<string, AvailableModelDetails>;
  defaultAgentModelId?: string;
  agentModelSorts?: Array<{
    displayName: string;
    groups: Array<{
      modelIds: string[];
    }>;
  }>;
  commandModelIds?: string[];
  tabModelIds?: string[];
  imageGenerationModelIds?: string[];
  mqueryModelIds?: string[];
  webSearchModelIds?: string[];
  deprecatedModelIds?: Record<string, unknown>;
  commitMessageModelIds?: string[];
  audioTranscriptionModelIds?: string[];
  experimentIds?: number[];
  tieredModelIds?: Record<string, string[]>;
  [key: string]: unknown;
}

/**
 * Fetches the list of available models for the current account under the specified project from the Agy server.
 */
export async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
  userAgentModel?: string
): Promise<FetchAvailableModelsResponse> {
  const url = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:fetchAvailableModels`;
  if (process.env.OPENCODE_AGY_VERBOSE_LOGS === "1") {
    console.warn(`[Agy Auth] fetchAvailableModels calling URL: ${url} with project: ${projectId}`);
  }
  const userAgent = buildAgyCliUserAgent(userAgentModel);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': userAgent
  };

  const response = await agyFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ project: projectId })
  });

  if (!response.ok) {
    let details = '';
    try {
      details = await response.clone().text();
    } catch {}
    const errMsg = `Google API returned status ${response.status} ${response.statusText}${details ? `: ${details}` : ''}`;
    if (process.env.OPENCODE_AGY_VERBOSE_LOGS === "1") {
      console.warn(`[Agy Auth] fetchAvailableModels error: ${errMsg}`);
    }
    throw new Error(errMsg);
  }
  const result = (await response.json()) as FetchAvailableModelsResponse;
  if (process.env.OPENCODE_AGY_VERBOSE_LOGS === "1") {
    console.warn(`[Agy Auth] fetchAvailableModels success, returned keys: ${Object.keys(result.models || {}).join(', ')}`);
  }
  return result;
}

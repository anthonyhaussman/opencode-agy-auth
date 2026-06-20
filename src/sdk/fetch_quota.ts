import { AGY_CODE_ASSIST_ENDPOINT } from '../constants';
import { agyFetch } from '../fetch';
import { createAgyActivityRequestId } from './activity-request-id';
import { buildAgyCliUserAgent } from './user-agent';
import type { RetrieveUserQuotaResponse, RetrieveUserQuotaSummaryResponse } from '../plugin/project/types';

/**
 * Fetches the Code Assist quota bucket information, which contains the model IDs visible to the current account/project.
 */
export async function retrieveUserQuota(
  accessToken: string,
  projectId: string,
  userAgentModel?: string
): Promise<RetrieveUserQuotaResponse | null> {
  const url = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`;
  const headers = buildCodeAssistHeaders(accessToken, userAgentModel);

  try {
    const response = await agyFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project: projectId })
    });

    if (!response.ok) {
      return null;
    }
    return (await response.json()) as RetrieveUserQuotaResponse;
  } catch {
    return null;
  }
}

/**
 * Fetches the Code Assist quota summary, grouped by model family with window-based buckets.
 */
export async function retrieveUserQuotaSummary(
  accessToken: string,
  projectId: string,
  userAgentModel?: string
): Promise<RetrieveUserQuotaSummaryResponse | null> {
  const url = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuotaSummary`;
  const headers = buildCodeAssistHeaders(accessToken, userAgentModel);

  try {
    const response = await agyFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project: projectId })
    });

    if (!response.ok) {
      return null;
    }
    return (await response.json()) as RetrieveUserQuotaSummaryResponse;
  } catch {
    return null;
  }
}

function buildCodeAssistHeaders(
  accessToken: string,
  userAgentModel?: string
): Record<string, string> {
  const userAgent = buildAgyCliUserAgent(userAgentModel);
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': userAgent,
    'x-activity-request-id': createAgyActivityRequestId()
  };
}

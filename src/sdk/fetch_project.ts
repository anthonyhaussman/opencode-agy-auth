import { AGY_CODE_ASSIST_ENDPOINT } from '../constants';
import { agyFetch } from '../fetch';
import { fetchWithRetry } from './retry';
import { createAgyActivityRequestId } from './activity-request-id';
import { buildAgyCliUserAgent } from './user-agent';
import { formatHyperlink } from './terminal-hyperlink';
import {
  FREE_TIER_ID,
  type LoadCodeAssistPayload,
  type OnboardUserPayload,
  ProjectIdRequiredError,
  ProjectAccessDeniedError
} from '../plugin/project/types';
import { buildMetadata, isVpcScError, parseJsonSafe, wait } from '../plugin/project/utils';

/**
 * Loads hosted project information for a given access token and optional project.
 */
export async function loadManagedProject(
  accessToken: string,
  projectId?: string,
  userAgentModel?: string
): Promise<LoadCodeAssistPayload | null> {
  try {
    const metadata = buildMetadata(projectId);
    const requestBody: Record<string, unknown> = { metadata };
    if (projectId) {
      requestBody.cloudaicompanionProject = projectId;
    }

    const url = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
    if (process.env.OPENCODE_AGY_VERBOSE_LOGS === "1") {
      console.warn(`[Agy Auth] loadManagedProject calling URL: ${formatHyperlink(url)} with project: ${projectId || 'none'}`);
    }
    const headers = buildCodeAssistHeaders(accessToken, userAgentModel);

    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      if (response.status === 403 || response.status === 404) {
        console.warn(`[Agy Auth] loadManagedProject failed with ${response.status} (possible Cloud API mismatch/unauthorized). URL: ${formatHyperlink(url)}, Project: ${projectId}`);
        const responseText = await readResponseTextIfNeeded(response, true);
        if (responseText && isVpcScError(responseText)) {
           console.warn(`[Agy Auth] loadManagedProject: Detected VPC Service Controls block`);
        }
        throw new ProjectAccessDeniedError(projectId, responseText);
      } else {
        const cleanStatusText = response.statusText.replace(/[\r\n]+/g, ' ').trim();
        if (response.status === 429) {
          console.warn(`[Agy Auth] loadManagedProject failed with 429 ${cleanStatusText} (rate limited after retries; see Retry-After / quota exhaustion). URL: ${formatHyperlink(url)}, Project: ${projectId}`);
        } else {
          console.warn(`[Agy Auth] loadManagedProject failed with ${response.status} ${cleanStatusText}`);
        }
      }
      return null;
    }

    const responseJson = await response.json();
    return responseJson as LoadCodeAssistPayload;
  } catch (error) {
    if (error instanceof ProjectAccessDeniedError) {
      throw error;
    }
    const errStr = error instanceof Error ? error.stack || error.message : String(error);
    console.warn(`[Agy Auth] Failed to load code assist project: ${errStr}`);
    return null;
  }
}

/**
 * Enables a hosted project for the user, optionally retrying until complete.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  userAgentModel?: string,
  attempts = 10,
  delayMs = 5000
): Promise<string | undefined> {
  const isFreeTier = tierId === FREE_TIER_ID;
  const metadata = buildMetadata(projectId, !isFreeTier);
  const requestBody: Record<string, unknown> = { tierId, metadata };

  if (!isFreeTier) {
    if (!projectId) {
      throw new ProjectIdRequiredError();
    }
    requestBody.cloudaicompanionProject = projectId;
  }

  const baseUrl = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal`;
  const onboardUrl = `${baseUrl}:onboardUser`;
  if (process.env.OPENCODE_AGY_VERBOSE_LOGS === "1") {
    console.warn(`[Agy Auth] onboardManagedProject calling URL: ${formatHyperlink(onboardUrl)} with project: ${projectId || 'none'}`);
  }

  try {
    const response = await fetchWithDebug(
      onboardUrl,
      'POST',
      buildCodeAssistHeaders(accessToken, userAgentModel),
      requestBody,
      projectId
    );
    if (!response.ok) {
      const cleanStatusText = response.statusText.replace(/[\r\n]+/g, ' ').trim();
      console.warn(`[Agy Auth] onboardManagedProject response not ok: status ${response.status} ${cleanStatusText}`);
      return undefined;
    }

    let payload = (await response.json()) as OnboardUserPayload;
    if (!payload.done && payload.name) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await wait(delayMs);
        const operationUrl = `${baseUrl}/${payload.name}`;
        const opResponse = await fetchWithDebug(
          operationUrl,
          'GET',
          buildCodeAssistHeaders(accessToken, userAgentModel),
          undefined,
          projectId
        );
        if (!opResponse.ok) {
          return undefined;
        }
        payload = (await opResponse.json()) as OnboardUserPayload;
        if (payload.done) {
          break;
        }
      }
    }

    const managedProjectId = payload.response?.cloudaicompanionProject?.id;
    if (payload.done && managedProjectId) {
      return managedProjectId;
    }
    if (payload.done && projectId) {
      return projectId;
    }
  } catch (error) {
    const errStr = error instanceof Error ? error.stack || error.message : String(error);
    console.warn(`[Agy Auth] Failed to onboard Antigravity managed project: ${errStr}`);
    return undefined;
  }

  return undefined;
}

function buildCodeAssistHeaders(
  accessToken: string,
  userAgentModel?: string
): Record<string, string> {
  const userAgent = buildAgyCliUserAgent(userAgentModel);
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': userAgent
  };
}

async function fetchWithDebug(
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: Record<string, unknown> | undefined,
  projectId?: string
): Promise<Response> {
  const response = await agyFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return response;
}

async function readResponseTextIfNeeded(response: Response, needed: boolean): Promise<string | undefined> {
  if (!needed && response.ok) {
    return undefined;
  }
  try {
    return await response.clone().text();
  } catch {
    return undefined;
  }
}

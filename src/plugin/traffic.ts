import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { AGY_CODE_ASSIST_ENDPOINT } from '../constants';
import { agyFetch } from '../fetch';
import { isRetryableStatus, getExponentialDelayWithJitter, wait } from '../sdk/retry/helpers';
import { getAgyCliVersion, buildAgyCliUserAgent } from '../sdk/user-agent';

const MAX_SEND_ATTEMPTS = 2;

async function sendWithRetry(label: string, url: string, init: RequestInit): Promise<void> {
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    try {
      const response = await agyFetch(url, init);
      if (response.ok) return;
      if (!isRetryableStatus(response.status) || attempt === MAX_SEND_ATTEMPTS - 1) {
        if (response.status >= 500 && response.status < 600) {
          console.debug(`[Agy] ${label} failed: ${response.status} (transient, suppressed)`);
        } else {
          console.warn(`[Agy] ${label} failed: ${response.status}`);
        }
        return;
      }
    } catch (error) {
      if (attempt === MAX_SEND_ATTEMPTS - 1) {
        console.debug(`[Agy] ${label} failed with network error: ${error} (suppressed)`);
        return;
      }
    }
    await wait(getExponentialDelayWithJitter(attempt + 1));
  }
}

let lastTrafficTime = 0;
const TRAFFIC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Simulates the experimental fetch and metric telemetry traffic sent periodically by the official Agy client in the background to prevent API bans or anomaly detection.
 */
export function simulateClientBackgroundTraffic(accessToken: string, projectId: string, userAgentModel?: string): void {
  const now = Date.now();
  if (now - lastTrafficTime < TRAFFIC_INTERVAL_MS) {
    return;
  }
  lastTrafficTime = now;

  // Asynchronous silent send, never blocking the core generation flow of the editor.
  Promise.all([
    sendListExperiments(accessToken, userAgentModel),
    sendCodeAssistMetrics(accessToken, projectId, userAgentModel),
    sendTrajectoryAnalytics(accessToken, userAgentModel)
  ]).catch((err) => {
    console.warn(`[Agy] Failed to send background traffic: ${err}`);
  });
}

async function sendListExperiments(accessToken: string, userAgentModel?: string) {
  const url = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:listExperiments`;
  const userAgent = buildAgyCliUserAgent(userAgentModel);

  await sendWithRetry('listExperiments', url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      Authorization: `Bearer ${accessToken}`
    },
    body: '{}'
  });
}

async function sendCodeAssistMetrics(accessToken: string, projectId: string, userAgentModel?: string) {
  const url = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:recordCodeAssistMetrics`;
  const userAgent = buildAgyCliUserAgent(userAgentModel);

  const plat = os.platform();
  const arch = os.arch();

  const platMap: Record<string, string> = {
    darwin: 'DARWIN',
    linux: 'LINUX',
    win32: 'WINDOWS'
  };
  const archMap: Record<string, string> = {
    x64: 'AMD64',
    arm64: 'ARM64'
  };

  const p = platMap[plat] || 'UNSPECIFIED';
  const a = archMap[arch] || 'UNSPECIFIED';
  const platform = `${p}_${a}`;

  const traceId = randomUUID().replace(/-/g, '').slice(0, 16);
  const trajectoryId = randomUUID();
  const requestId = randomUUID();

  const body = {
    project: projectId,
    requestId,
    metadata: {
      ideType: 'ANTIGRAVITY',
      ideVersion: getAgyCliVersion(),
      platform
    },
    metrics: [
      {
        timestamp: new Date().toISOString(),
        conversationOffered: {
          status: 'ACTION_STATUS_NO_ERROR',
          traceId,
          streamingLatency: {
            firstMessageLatency: '0.5s',
            totalLatency: '1.0s'
          },
          isAgentic: true,
          initiationMethod: 'AGENT',
          trajectoryId,
          language: 'unspecified'
        }
      }
    ]
  };

  await sendWithRetry('recordCodeAssistMetrics', url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
}

async function sendTrajectoryAnalytics(accessToken: string, userAgentModel?: string) {
  const url = `${AGY_CODE_ASSIST_ENDPOINT}/v1internal:recordTrajectoryAnalytics`;
  const userAgent = buildAgyCliUserAgent(userAgentModel);

  const plat = os.platform();
  const arch = os.arch();

  const platMap: Record<string, string> = {
    darwin: 'DARWIN',
    linux: 'LINUX',
    win32: 'WINDOWS'
  };
  const archMap: Record<string, string> = {
    x64: 'AMD64',
    arm64: 'ARM64'
  };

  const p = platMap[plat] || 'UNSPECIFIED';
  const a = archMap[arch] || 'UNSPECIFIED';
  const platform = `${p}_${a}`;

  const body = buildTrajectoryAnalyticsBody(randomUUID(), platform);

  await sendWithRetry('recordTrajectoryAnalytics', url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
}

export function buildTrajectoryAnalyticsBody(cascadeId = randomUUID(), platform = 'DARWIN_AMD64') {
  return {
    trajectory: {
      cascadeId,
      executorMetadatas: [
        {
          cascadeConfig: {
            agentApiConfig: {
              enabled: false
            },
            checkpointConfig: {
              checkpointModel: 'MODEL_PLACEHOLDER_M50',
              strategy: 'CHECKPOINT_STRATEGY_SINGLE_PROMPT',
              maxTokenLimit: '128000',
              tokenThreshold: '50000',
              maxOverheadRatio: '0.15',
              movingWindowSize: '1',
              enabled: true,
              maxOutputTokens: '16384',
              useLastPlannerModel: false,
              isSync: false,
              maxUserRequests: 10,
              includeLastUserMessage: false,
              includeConversationLog: true,
              includeRunningTaskSnapshots: true,
              includeSubagentSnapshots: true,
              includeArtifactSnapshots: true,
              retryConfig: {
                maxRetries: 0,
                initialSleepDurationMs: 1000,
                exponentialMultiplier: 2,
                includeErrorFeedback: false
              }
            }
          }
        }
      ]
    },
    mendelExperimentIds: [],
    metadata: {
      ideType: 'ANTIGRAVITY',
      ideVersion: getAgyCliVersion(),
      platform
    },
    startStepIndex: '0'
  };
}

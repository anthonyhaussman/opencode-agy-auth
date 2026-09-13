import { AGY_PROVIDER_ID } from '../constants';
import { STATIC_MODELS_SIMPLE, TIER_MAPPING } from '../plugin';
import { createAgyQuotaTool, AGY_QUOTA_TOOL_NAME } from './quota';
import { createAgyQuotaSummaryTool, AGY_QUOTA_SUMMARY_TOOL_NAME } from './quota-summary';
import {
  defineOpenCodeV2Plugin,
  type OpenCodeV2PluginContext,
  type OpenCodeV2PluginDefinition
} from './types';
import { buildAgyCliUserAgent } from '../sdk/user-agent';
import { isGenerativeLanguageRequest, parseGenerativeLanguageRequest } from '../sdk/request';
import { classifyQuotaResponse, retryInternals } from '../sdk/retry/quota';
import { resolveRetryDelayMs } from '../sdk/retry/helpers';

export const AGY_V2_QUOTA_COMMAND = 'agy-quota';
export const AGY_V2_QUOTA_SUMMARY_COMMAND = 'agy-quota-summary';

export const AGY_V2_QUOTA_COMMAND_TEMPLATE = `Retrieve Agy Code Assist quota usage for the current authenticated account.

Immediately call \`${AGY_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;

export const AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE = `Retrieve Agy Code Assist quota summary (weekly and 5-hour limits by model group) for the current authenticated account.

Immediately call \`${AGY_QUOTA_SUMMARY_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;

/**
 * Setup adapter for OpenCode v2 plugin architecture.
 */
export async function setupOpenCodeV2(ctx: OpenCodeV2PluginContext): Promise<void> {
  // 1. Register provider and models via catalog transform
  ctx.catalog.transform(async (catalog: any) => {
    if (!catalog) return;

    catalog.providers = catalog.providers || {};
    catalog.providers[AGY_PROVIDER_ID] = {
      id: AGY_PROVIDER_ID,
      name: 'Antigravity CLI',
      npm: '@ai-sdk/google',
      models: { ...(catalog.providers[AGY_PROVIDER_ID]?.models || {}) },
      ...catalog.providers[AGY_PROVIDER_ID]
    };

    const targetModels = catalog.providers[AGY_PROVIDER_ID].models;

    for (const [modelId, simple] of Object.entries(STATIC_MODELS_SIMPLE)) {
      const isClaude = modelId.startsWith('claude-');
      const isGpt = modelId.startsWith('gpt-');

      targetModels[modelId] = {
        id: modelId,
        providerID: AGY_PROVIDER_ID,
        name: simple.name,
        description: simple.description,
        family: modelId.includes('gemini') ? 'gemini' : (isClaude ? 'claude' : (isGpt ? 'gpt' : 'unknown')),
        reasoning: simple.reasoning,
        attachment: simple.attachment,
        tool_call: simple.toolCall,
        limit: {
          context: simple.maxTokens,
          output: simple.maxOutputTokens
        },
        cost: simple.cost || { input: 0, output: 0 },
        ...(targetModels[modelId] || {})
      };
    }
  });

  // 2. Register agy_quota and agy_quota_summary tools via tool transform
  ctx.tool.transform(async (editor: any) => {
    if (!editor) return;

    // Use dummy client / resolvers for static tool registration
    const quotaTool = createAgyQuotaTool({
      client: undefined as any,
      getAuthResolver: () => undefined,
      getConfiguredProjectId: () => undefined,
      getUserAgentModel: () => undefined
    });

    const quotaSummaryTool = createAgyQuotaSummaryTool({
      client: undefined as any,
      getAuthResolver: () => undefined,
      getConfiguredProjectId: () => undefined,
      getUserAgentModel: () => undefined
    });

    if (typeof editor.set === 'function') {
      editor.set(AGY_QUOTA_TOOL_NAME, quotaTool);
      editor.set(AGY_QUOTA_SUMMARY_TOOL_NAME, quotaSummaryTool);
    } else if (editor.tools && typeof editor.tools === 'object') {
      editor.tools[AGY_QUOTA_TOOL_NAME] = quotaTool;
      editor.tools[AGY_QUOTA_SUMMARY_TOOL_NAME] = quotaSummaryTool;
    } else if (typeof editor === 'object') {
      editor[AGY_QUOTA_TOOL_NAME] = quotaTool;
      editor[AGY_QUOTA_SUMMARY_TOOL_NAME] = quotaSummaryTool;
    }
  });

  // 3. Register agy-quota and agy-quota-summary commands via command transform
  ctx.command.transform(async (editor: any) => {
    if (!editor) return;

    const commands = {
      [AGY_V2_QUOTA_COMMAND]: {
        description: 'Show Agy Code Assist quota usage',
        template: AGY_V2_QUOTA_COMMAND_TEMPLATE
      },
      [AGY_V2_QUOTA_SUMMARY_COMMAND]: {
        description: 'Show Agy Code Assist quota summary with weekly and 5-hour limits',
        template: AGY_V2_QUOTA_SUMMARY_COMMAND_TEMPLATE
      }
    };

    if (typeof editor.set === 'function') {
      editor.set(AGY_V2_QUOTA_COMMAND, commands[AGY_V2_QUOTA_COMMAND]);
      editor.set(AGY_V2_QUOTA_SUMMARY_COMMAND, commands[AGY_V2_QUOTA_SUMMARY_COMMAND]);
    } else if (editor.commands && typeof editor.commands === 'object') {
      editor.commands[AGY_V2_QUOTA_COMMAND] = commands[AGY_V2_QUOTA_COMMAND];
      editor.commands[AGY_V2_QUOTA_SUMMARY_COMMAND] = commands[AGY_V2_QUOTA_SUMMARY_COMMAND];
    } else if (typeof editor === 'object') {
      editor[AGY_V2_QUOTA_COMMAND] = commands[AGY_V2_QUOTA_COMMAND];
      editor[AGY_V2_QUOTA_SUMMARY_COMMAND] = commands[AGY_V2_QUOTA_SUMMARY_COMMAND];
    }
  });

  // 4. Register session hooks
  ctx.session.hook('http.request', async (event: any) => {
    if (!event) return;

    const url = typeof event.url === 'string' ? event.url : (event.request?.url || '');
    const isGL = isGenerativeLanguageRequest(url);
    const isInternal = url.includes('cloudcode-pa.googleapis.com');

    if (!isGL && !isInternal) {
      return;
    }

    event.headers = event.headers || {};
    let modelName: string | undefined;

    if (isGL) {
      const parsed = parseGenerativeLanguageRequest(url);
      modelName = parsed?.effectiveModel;
    }

    const userAgent = buildAgyCliUserAgent(modelName);
    if (typeof event.headers.set === 'function') {
      if (!event.headers.get('User-Agent')) {
        event.headers.set('User-Agent', userAgent);
      }
    } else {
      if (!event.headers['User-Agent'] && !event.headers['user-agent']) {
        event.headers['User-Agent'] = userAgent;
      }
    }
  });

  ctx.session.hook('http.response', async (event: any) => {
    if (!event) return;
    // Log or trace response status if needed
    if (event.response?.status === 429) {
      return;
    }
  });

  ctx.session.hook('retry', async (event: any) => {
    if (!event) return;
    const response = event.response;
    if (response instanceof Response) {
      if (response.status === 429 || response.status === 503) {
        const quota = await classifyQuotaResponse(response);
        if (quota?.retryDelayMs) {
          event.retryDelayMs = quota.retryDelayMs;
        } else {
          event.retryDelayMs = await resolveRetryDelayMs(response, event.attempt || 1);
        }
      }
    } else if (event.details && Array.isArray(event.details)) {
      const retryInfo = event.details.find(
        (d: any) => d && d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
      );
      if (retryInfo?.retryDelay) {
        const delayMs = retryInternals.parseRetryDelayValue(retryInfo.retryDelay);
        if (delayMs !== null) {
          event.retryDelayMs = delayMs;
        }
      }
    }
  });
}

/**
 * OpenCode v2 Plugin Definition
 */
export const v2PluginDefinition: OpenCodeV2PluginDefinition = defineOpenCodeV2Plugin({
  id: AGY_PROVIDER_ID,
  setup: setupOpenCodeV2
});

export const createV2PluginDefinition = (): OpenCodeV2PluginDefinition => v2PluginDefinition;

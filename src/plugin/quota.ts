import { tool } from "@opencode-ai/plugin";
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from "./auth";
import { resolveCachedAuth } from "./cache";
import { ensureProjectContext, retrieveUserQuota } from "./project";
import type { RetrieveUserQuotaBucket } from "./project/types";
import { refreshAccessToken } from "./token";
import type { GetAuth, PluginClient } from "./types";
import { buildProgressBar, clamp, formatRemainingAmount, formatRelativeResetTime, pad } from "./quota-utils";

export const AGY_QUOTA_TOOL_NAME = "agy_quota";

interface AgyQuotaToolDependencies {
  client: PluginClient;
  getAuthResolver: () => GetAuth | undefined;
  getConfiguredProjectId: () => string | undefined;
  getUserAgentModel: () => string | undefined;
}

export function createAgyQuotaTool({
  client,
  getAuthResolver,
  getConfiguredProjectId,
  getUserAgentModel,
}: AgyQuotaToolDependencies) {
  return tool({
    description:
      "Retrieve current Agy Code Assist quota usage for the authenticated user and project.",
    args: {},
    async execute() {
      const getAuth = getAuthResolver();
      if (!getAuth) {
        return "Agy quota is unavailable before Google auth is initialized. Authenticate with the Google provider and retry.";
      }

      const auth = await getAuth();
      if (!isOAuthAuth(auth)) {
        return "Agy quota requires OAuth with Google. Run `opencode auth login` and choose `Google OAuth (Antigravity CLI)` or `Google OAuth (Gemini CLI)`.";
      }

      let authRecord = resolveCachedAuth(auth);
      if (accessTokenExpired(authRecord)) {
        const refreshed = await refreshAccessToken(authRecord, client);
        if (!refreshed?.access) {
          return "Agy quota lookup failed because the access token could not be refreshed. Re-authenticate and retry.";
        }
        authRecord = refreshed;
      }

      if (!authRecord.access) {
        return "Agy quota lookup failed because no access token is available. Re-authenticate and retry.";
      }

      try {
        const projectContext = await ensureProjectContext(
          authRecord,
          client,
          getConfiguredProjectId(),
          getUserAgentModel(),
        );
        if (!projectContext.effectiveProjectId) {
          return "Agy quota lookup failed because no Google Cloud project could be resolved.";
        }

        const quota = await retrieveUserQuota(
          authRecord.access,
          projectContext.effectiveProjectId,
          getUserAgentModel(),
        );
        if (!quota?.buckets?.length) {
          return `No Agy quota buckets were returned for project \`${projectContext.effectiveProjectId}\`.`;
        }

        return formatAgyQuotaOutput(
          projectContext.effectiveProjectId,
          quota.buckets,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return `Agy quota lookup failed: ${message}`;
      }
    },
  });
}

function formatAgyQuotaOutput(
  projectId: string,
  buckets: RetrieveUserQuotaBucket[],
): string {
  const sortedBuckets = [...buckets].sort(compareQuotaBuckets);
  const groupedRows = groupQuotaRows(sortedBuckets);
  const versionGroups = groupByVersion(groupedRows);
  const variantWidth = Math.max(
    "Variant".length,
    ...versionGroups.flatMap((group) =>
      group.models.flatMap((model) => model.rows.map((row) => row.variant.length))
    ),
  );
  const tokenTypeValues = [...new Set(versionGroups.flatMap((group) =>
    group.models.flatMap((model) => model.rows.map((row) => row.tokenType))
  ))];
  const showTokenType = tokenTypeValues.length > 1 || tokenTypeValues[0] !== "REQUESTS";
  const lines = [
    `Agy quota usage for project \`${projectId}\``,
    "",
    showTokenType
      ? `  ↳ ${pad("Variant", variantWidth)}  Remaining                   Reset      Type`
      : `  ↳ ${pad("Variant", variantWidth)}  Remaining                   Reset`,
  ];

  for (let index = 0; index < versionGroups.length; index += 1) {
    const versionGroup = versionGroups[index];
    if (!versionGroup) {
      continue;
    }
    if (index > 0) {
      lines.push("");
    }
    lines.push(formatVersionGroupTitle(versionGroup));
    for (const model of versionGroup.models) {
      lines.push(model.baseModel);
      for (const row of model.rows) {
        lines.push(
          showTokenType
            ? `  ↳ ${pad(row.variant, variantWidth)}  ${pad(row.usageRemaining, 27)} ${pad(row.resetValue, 8)} ${row.tokenType}`
            : `  ↳ ${pad(row.variant, variantWidth)}  ${pad(row.usageRemaining, 27)} ${row.resetValue}`,
        );
      }
    }
  }

  return lines.join("\n");
}

function compareQuotaBuckets(
  left: RetrieveUserQuotaBucket,
  right: RetrieveUserQuotaBucket,
): number {
  const leftModel = left.modelId ?? "";
  const rightModel = right.modelId ?? "";
  if (leftModel !== rightModel) {
    return leftModel.localeCompare(rightModel);
  }

  const leftTokenType = left.tokenType ?? "";
  const rightTokenType = right.tokenType ?? "";
  if (leftTokenType !== rightTokenType) {
    return leftTokenType.localeCompare(rightTokenType);
  }

  return (left.resetTime ?? "").localeCompare(right.resetTime ?? "");
}

function formatUsageRemaining(bucket: RetrieveUserQuotaBucket): string {
  const remainingAmount = formatRemainingAmount(bucket.remainingAmount);
  const remainingFraction = bucket.remainingFraction;
  const hasFraction =
    typeof remainingFraction === "number" && Number.isFinite(remainingFraction);

  if (hasFraction) {
    const clamped = clamp(remainingFraction, 0, 1);
    const percent = (clamped * 100).toFixed(1);
    const bar = buildProgressBar(clamped);
    return remainingAmount
      ? `${bar} ${percent}% (${remainingAmount} left)`
      : `${bar} ${percent}%`;
  }

  if (remainingAmount) {
    return remainingAmount;
  }

  return "unknown";
}

function normalizeTokenType(bucket: RetrieveUserQuotaBucket): string {
  const value = bucket.tokenType?.trim();
  return value ? value.toUpperCase() : "REQUESTS";
}

interface GroupedQuotaRow {
  variant: string;
  usageRemaining: string;
  resetValue: string;
  tokenType: string;
}

interface GroupedQuotaModel {
  baseModel: string;
  version: string | undefined;
  rows: GroupedQuotaRow[];
}

function groupQuotaRows(sortedBuckets: RetrieveUserQuotaBucket[]): GroupedQuotaModel[] {
  const groups = new Map<string, GroupedQuotaModel>();

  for (const bucket of sortedBuckets) {
    const modelId = bucket.modelId?.trim() || "unknown-model";
    const { baseModel, variant } = splitModelVariant(modelId);
    const usageRemaining = formatUsageRemaining(bucket);
    const resetLabel = formatRelativeResetTime(bucket.resetTime);
    const resetValue = resetLabel?.replace("resets in ", "") ?? "-";
    const tokenType = normalizeTokenType(bucket);

    const existing = groups.get(baseModel);
    if (existing) {
      existing.rows.push({
        variant,
        usageRemaining,
        resetValue,
        tokenType,
      });
      continue;
    }

    groups.set(baseModel, {
      baseModel,
      version: extractModelVersion(baseModel),
      rows: [{
        variant,
        usageRemaining,
        resetValue,
        tokenType,
      }],
    });
  }

  return [...groups.values()];
}

interface VersionQuotaGroup {
  title: string;
  version: string | undefined;
  models: GroupedQuotaModel[];
}

function groupByVersion(models: GroupedQuotaModel[]): VersionQuotaGroup[] {
  const groups = new Map<string, VersionQuotaGroup>();

  for (const model of models) {
    const key = model.version ?? "__unknown__";
    const existing = groups.get(key);
    if (existing) {
      existing.models.push(model);
      continue;
    }

    groups.set(key, {
      title: model.version ? `Gemini ${model.version}` : "Other",
      version: model.version,
      models: [model],
    });
  }

  const ordered = [...groups.values()].sort((left, right) =>
    compareVersionDesc(left.version, right.version),
  );

  for (const group of ordered) {
    group.models.sort((left, right) => left.baseModel.localeCompare(right.baseModel));
  }

  return ordered;
}

function extractModelVersion(modelId: string): string | undefined {
  const match = modelId.match(/^gemini-([0-9]+(?:\.[0-9]+)*)-/i);
  return match?.[1];
}

function compareVersionDesc(left: string | undefined, right: string | undefined): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }

  const leftSegments = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightSegments = right.split(".").map((part) => Number.parseInt(part, 10));
  const max = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < max; index += 1) {
    const l = leftSegments[index] ?? 0;
    const r = rightSegments[index] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) {
      break;
    }
    if (l > r) {
      return -1;
    }
    if (l < r) {
      return 1;
    }
  }

  return right.localeCompare(left);
}

function formatVersionGroupTitle(group: VersionQuotaGroup): string {
  const modelCount = group.models.length;
  const bucketCount = group.models.reduce((count, model) => count + model.rows.length, 0);
  const modelLabel = modelCount === 1 ? "model" : "models";
  const bucketLabel = bucketCount === 1 ? "bucket" : "buckets";
  return `${group.title} (${modelCount} ${modelLabel}, ${bucketCount} ${bucketLabel})`;
}

function splitModelVariant(modelId: string): { baseModel: string; variant: string } {
  const vertexSuffix = "_vertex";
  if (modelId.endsWith(vertexSuffix)) {
    return {
      baseModel: modelId.slice(0, -vertexSuffix.length),
      variant: "vertex",
    };
  }
  return {
    baseModel: modelId,
    variant: "default",
  };
}

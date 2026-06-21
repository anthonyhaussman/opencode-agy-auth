import { tool } from "@opencode-ai/plugin";
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from "./auth";
import { resolveCachedAuth } from "./cache";
import { ensureProjectContext, retrieveUserQuotaSummary } from "./project";
import type { QuotaSummaryBucket, QuotaSummaryGroup } from "./project/types";
import { refreshAccessToken } from "./token";
import type { GetAuth, PluginClient } from "./types";
import { buildProgressBar, clamp, formatRemainingAmount, formatRelativeResetTime } from "./quota-utils";

export const AGY_QUOTA_SUMMARY_TOOL_NAME = "agy_quota_summary";

interface AgyQuotaSummaryToolDependencies {
  client: PluginClient;
  getAuthResolver: () => GetAuth | undefined;
  getConfiguredProjectId: () => string | undefined;
  getUserAgentModel: () => string | undefined;
}

export function createAgyQuotaSummaryTool({
  client,
  getAuthResolver,
  getConfiguredProjectId,
  getUserAgentModel,
}: AgyQuotaSummaryToolDependencies) {
  return tool({
    description:
      "Retrieve Agy Code Assist quota summary with weekly and 5-hour limits grouped by model family.",
    args: {},
    async execute() {
      const getAuth = getAuthResolver();
      if (!getAuth) {
        return "Agy quota summary is unavailable before Google auth is initialized. Authenticate with the Google provider and retry.";
      }

      const auth = await getAuth();
      if (!isOAuthAuth(auth)) {
        return "Agy quota summary requires OAuth with Google. Run `opencode auth login` and choose `Google OAuth (Antigravity CLI)` or `Google OAuth (Gemini CLI)`.";
      }

      let authRecord = resolveCachedAuth(auth);
      if (accessTokenExpired(authRecord)) {
        const refreshed = await refreshAccessToken(authRecord, client);
        if (!refreshed?.access) {
          return "Agy quota summary lookup failed because the access token could not be refreshed. Re-authenticate and retry.";
        }
        authRecord = refreshed;
      }

      if (!authRecord.access) {
        return "Agy quota summary lookup failed because no access token is available. Re-authenticate and retry.";
      }

      try {
        const projectContext = await ensureProjectContext(
          authRecord,
          client,
          getConfiguredProjectId(),
          getUserAgentModel(),
        );
        if (!projectContext.effectiveProjectId) {
          return "Agy quota summary lookup failed because no Google Cloud project could be resolved.";
        }

        const summary = await retrieveUserQuotaSummary(
          authRecord.access,
          projectContext.effectiveProjectId,
          getUserAgentModel(),
        );
        if (!summary) {
          return `No Agy quota summary available for project \`${projectContext.effectiveProjectId}\`.`;
        }

        return formatAgyQuotaSummaryOutput(
          projectContext.effectiveProjectId,
          summary,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return `Agy quota summary lookup failed: ${message}`;
      }
    },
  });
}

const BAR_WIDTH = 50;

function windowLabel(window: string | undefined): string {
  switch (window?.toUpperCase()) {
    case "WEEKLY":
      return "Weekly Limit";
    case "FIVE_HOUR":
      return "Five Hour Limit";
    default:
      return "Other Limit";
  }
}

function formatSummaryBucket(bucket: QuotaSummaryBucket, indent: string): string[] {
  if (bucket.disabled) {
    const defaultDesc = `${windowLabel(bucket.window).toLowerCase()} exhausted`;
    const desc = bucket.description?.trim() || defaultDesc;
    return [`${indent}Disabled: ${desc}`];
  }

  const lines: string[] = [];
  const fraction = bucket.remainingFraction;
  const hasFraction = typeof fraction === "number" && Number.isFinite(fraction);

  if (hasFraction) {
    const clamped = clamp(fraction, 0, 1);
    const percent = (clamped * 100).toFixed(2);
    const bar = buildProgressBar(clamped, BAR_WIDTH);
    lines.push(`${indent}[${bar}] ${percent}%`);

    const remaining = formatRemainingAmount(bucket.remainingAmount);
    if (remaining) {
      const pctWhole = (clamped * 100).toFixed(0);
      lines.push(`${indent}${pctWhole}% remaining \u00b7 ${remaining} left`);
    } else {
      const pctWhole = (clamped * 100).toFixed(0);
      lines.push(`${indent}${pctWhole}% remaining`);
    }
  } else {
    const remaining = formatRemainingAmount(bucket.remainingAmount);
    lines.push(remaining ? `${indent}${remaining} remaining` : `${indent}unknown remaining`);
  }

  const resetLabel = formatRelativeResetTime(bucket.resetTime);
  if (resetLabel) {
    const formattedReset = resetLabel.startsWith("resets in ")
      ? resetLabel.replace("resets in ", "Refreshes in ")
      : resetLabel.charAt(0).toUpperCase() + resetLabel.slice(1);
    lines.push(`${indent}${formattedReset}`);
  }

  return lines;
}

function groupBucketsByWindow(buckets: QuotaSummaryBucket[]): Map<string, QuotaSummaryBucket[]> {
  const groups = new Map<string, QuotaSummaryBucket[]>();
  const order = ["WEEKLY", "FIVE_HOUR"];

  for (const bucket of buckets) {
    const key = bucket.window?.toUpperCase() || "UNKNOWN";
    const existing = groups.get(key);
    if (existing) {
      existing.push(bucket);
    } else {
      groups.set(key, [bucket]);
    }
  }

  const sorted = new Map<string, QuotaSummaryBucket[]>();
  for (const key of order) {
    const group = groups.get(key);
    if (group) {
      sorted.set(key, group);
    }
  }
  for (const [key, group] of groups) {
    if (!sorted.has(key)) {
      sorted.set(key, group);
    }
  }

  return sorted;
}

function formatSummaryGroup(group: QuotaSummaryGroup): string[] {
  const lines: string[] = [];
  const name = group.displayName?.trim();
  if (name) {
    lines.push(name);
  }

  const desc = group.description?.trim();
  if (desc) {
    lines.push(`  Models within this group: ${desc}`);
  }

  const buckets = group.buckets;
  if (buckets?.length) {
    const windowGroups = groupBucketsByWindow(buckets);
    let firstWindow = true;
    for (const [, windowBuckets] of windowGroups) {
      if (!firstWindow) {
        lines.push("");
      }
      for (const bucket of windowBuckets) {
        const baseLabel = windowLabel(bucket.window);
        const label = bucket.displayName ? `${baseLabel} (${bucket.displayName})` : baseLabel;
        lines.push(`  ${label}`);
        lines.push(...formatSummaryBucket(bucket, "    "));
        firstWindow = false;
      }
    }
  }

  return lines;
}

function formatTopLevelBuckets(buckets: QuotaSummaryBucket[]): string[] {
  const lines: string[] = [];
  const windowGroups = groupBucketsByWindow(buckets);

  let firstWindow = true;
  for (const [, windowBuckets] of windowGroups) {
    if (!firstWindow) {
      lines.push("");
    }
    for (const bucket of windowBuckets) {
      const baseLabel = windowLabel(bucket.window);
      const label = bucket.displayName ? `${baseLabel} (${bucket.displayName})` : baseLabel;
      lines.push(label);
      lines.push(...formatSummaryBucket(bucket, "  "));
      firstWindow = false;
    }
  }

  return lines;
}

function formatAgyQuotaSummaryOutput(
  projectId: string,
  summary: { groups?: QuotaSummaryGroup[]; buckets?: QuotaSummaryBucket[]; description?: string },
): string {
  const lines = [
    `Agy quota summary for project \`${projectId}\``,
    "",
  ];

  const groups = summary.groups;
  if (groups?.length) {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (!group) {
        continue;
      }
      if (i > 0) {
        lines.push("");
      }
      lines.push(...formatSummaryGroup(group));
    }
  } else if (summary.buckets?.length) {
    lines.push(...formatTopLevelBuckets(summary.buckets));
  } else {
    lines.push("No quota information available.");
  }

  return lines.join("\n");
}

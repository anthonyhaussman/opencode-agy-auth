import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AGY_ACP_FALLBACK_MODELS, AGY_ACP_PROVIDER_ID, type AgyTier } from "./constants";
import type { AcpModelInfo } from "./process";

const TIERS: readonly AgyTier[] = ["low", "medium", "high"];

export const AGY_ACP_PROVIDER_NAME = "Antigravity CLI (ACP)";

/**
 * `aisdk:` package URL of the placeholder module. The bundle ships it as
 * `dist/sdk-placeholder.js` next to `dist/index.js`; from source (tests) the
 * sibling is `sdk-placeholder.ts`.
 */
export function placeholderPackage(base: string = import.meta.url): string {
  const js = new URL("./sdk-placeholder.js", base);
  const url = existsSync(fileURLToPath(js)) ? js : new URL("./sdk-placeholder.ts", base);
  return `aisdk:${url.href}`;
}

/** Model ids cached from a previous `session/new`, else the static fallback list. */
export function readCachedModels(file: string): AcpModelInfo[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown };
    const models = Array.isArray(parsed.models)
      ? parsed.models.filter((m): m is AcpModelInfo => typeof (m as AcpModelInfo)?.modelId === "string")
      : [];
    if (models.length > 0) return models;
  } catch {
    // No cache yet, or unreadable: use the fallback list.
  }
  return AGY_ACP_FALLBACK_MODELS.map((modelId) => ({ modelId }));
}

export function writeCachedModels(file: string, models: AcpModelInfo[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ models, updatedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 });
}

function family(id: string): string {
  if (id.startsWith("gemini")) return "gemini";
  if (id.startsWith("claude")) return "claude";
  if (id.startsWith("gpt")) return "gpt";
  return "unknown";
}

/** Mutates an OpenCode provider record into the google-agy-acp provider. */
export function applyProviderRecord(p: any, pkg: string): void {
  p.id = AGY_ACP_PROVIDER_ID;
  p.name = AGY_ACP_PROVIDER_NAME;
  p.package = pkg;
  p.activation = "auto";
  p.integrationID = AGY_ACP_PROVIDER_ID;
  p.description = "Google Antigravity models through the local agy CLI (Agent Client Protocol)";
}

/**
 * Mutates an OpenCode model record. Variant `settings` become AI SDK
 * `providerOptions`, so `providerOptions["google-agy-acp"].tier` reaches the
 * language model. Cost is zero: agy bills the Google account, not OpenCode.
 */
export function applyModelRecord(m: any, model: AcpModelInfo): void {
  m.id = model.modelId;
  m.modelID = model.modelId;
  m.providerID = AGY_ACP_PROVIDER_ID;
  m.name = model.name ?? model.modelId;
  m.family = family(model.modelId);
  m.capabilities = { tools: true, input: ["text", "image"], output: ["text"] };
  m.limit = { context: 1_048_576, output: 65_536 };
  m.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
  m.variants = TIERS.map((tier) => ({ id: tier, settings: { [AGY_ACP_PROVIDER_ID]: { tier } } }));
  m.status = "active";
  m.enabled = true;
}

/** Registers the provider and its models with whichever catalog API the host exposes. */
export function registerCatalog(ctx: any, pkg: string, models: () => AcpModelInfo[]): void {
  const provider = (editor: any) => editor?.update?.(AGY_ACP_PROVIDER_ID, (p: any) => applyProviderRecord(p, pkg));
  const model = (editor: any) => {
    for (const info of models()) editor?.update?.(AGY_ACP_PROVIDER_ID, info.modelId, (m: any) => applyModelRecord(m, info));
  };
  if (ctx.provider?.transform && ctx.model?.transform) {
    ctx.provider.transform(provider);
    ctx.model.transform(model);
    return;
  }
  ctx.catalog?.transform?.((draft: any) => {
    provider(draft?.provider);
    model(draft?.model);
  });
}

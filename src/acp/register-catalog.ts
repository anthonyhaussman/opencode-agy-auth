import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGY_ACP_PROVIDER_ID, type AgyTier } from "./constants";
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

// Order-insensitive: `agy models` and session/new may list the same models in a
// different order, which must not churn the catalog.
function sameModels(a: readonly AcpModelInfo[], b: readonly AcpModelInfo[]): boolean {
  if (a.length !== b.length) return false;
  const names = new Map(a.map((m) => [m.modelId, m.name]));
  return names.size === b.length && b.every((m) => names.has(m.modelId) && names.get(m.modelId) === m.name);
}

/**
 * In-memory list of the models agy reports. The catalog transform reads it on
 * every run; `set` asks the host to re-run the transform when the list changes.
 * Nothing is persisted: when agy cannot be asked, the provider has no models.
 */
export class ModelRegistry {
  private models: AcpModelInfo[] = [];

  constructor(
    private readonly reload: () => Promise<void> | void,
    private readonly log: (level: "warn", msg: string) => void,
  ) {}

  list(): AcpModelInfo[] {
    return this.models;
  }

  /** Replaces the list; reloads the catalog only when ids or names changed. Returns whether it changed. */
  async set(models: AcpModelInfo[]): Promise<boolean> {
    if (sameModels(this.models, models)) return false;
    this.models = models.map((m) => ({ ...m }));
    try {
      await this.reload();
    } catch (err) {
      this.log("warn", `agy-acp: catalog reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }
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

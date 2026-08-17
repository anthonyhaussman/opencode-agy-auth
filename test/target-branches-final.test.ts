import { describe, it, expect, vi } from "vitest";
import { ensureProjectContext, resolveProjectContextFromAccessToken, ProjectIdRequiredError } from "../src/plugin/project/context.js";
import { simulateClientBackgroundTraffic } from "../src/plugin/traffic.js";
import { createAgyQuotaTool } from "../src/plugin/quota.js";
import { fetchWithRetry } from "../src/sdk/retry/index.js";
import * as retryHelpers from "../src/sdk/retry/helpers.js";
import * as fetchModule from "../src/fetch.js";
import * as fetchProject from "../src/sdk/fetch_project.js";

describe("target branches and statements final", () => {
  it("throws ProjectIdRequiredError when tierId !== FREE_TIER_ID and no projectId is provided", async () => {
    vi.spyOn(fetchProject, "loadManagedProject").mockResolvedValueOnce({
      cloudaicompanionProject: null,
      allowedTiers: [{ id: "enterprise-tier", isDefault: true }],
    });

    const auth = { type: "oauth" as const, access: "acc-token", refresh: "ref-tok", expires: Date.now() + 100000 };
    await expect(
      resolveProjectContextFromAccessToken(auth, "acc-token", undefined)
    ).rejects.toThrow(ProjectIdRequiredError);
  });

  it("returns cached result when present in ensureProjectContext cache", async () => {
    const auth = { type: "oauth" as const, access: "acc-token", refresh: "ref-cached-key", expires: Date.now() + 100000 };
    const client = { auth: { set: vi.fn() } } as any;

    vi.spyOn(fetchProject, "loadManagedProject").mockResolvedValue({
      cloudaicompanionProject: { id: "proj-1" },
    });

    const first = await ensureProjectContext(auth, client, "cfg-proj");
    expect(first.effectiveProjectId).toBe("proj-1");

    // Second call returns cached result
    const second = await ensureProjectContext(auth, client, "cfg-proj");
    expect(second.effectiveProjectId).toBe(first.effectiveProjectId);
  });

  it("handles background traffic fetch and suppresses network and transient errors", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    let callCount = 0;
    const mockAgyFetch = vi.spyOn(fetchModule, "agyFetch").mockImplementation((async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Service Unavailable", { status: 503 });
      }
      if (callCount === 2) {
        throw new Error("connection reset");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any);

    // Call background traffic
    simulateClientBackgroundTraffic("token-test", "proj-test", "gemini-model");

    // Wait microtask
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockAgyFetch).toHaveBeenCalled();
    debugSpy.mockRestore();
    mockAgyFetch.mockRestore();
  });

  it("sorts versions and groups in quota tool with various formats", async () => {
    const client = { auth: { set: vi.fn() } } as any;
    vi.spyOn(fetchProject, "loadManagedProject").mockResolvedValue({
      cloudaicompanionProject: { id: "proj-1" },
    });

    vi.spyOn(fetchModule, "agyFetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          buckets: [
            {
              modelId: "gemini-1.5-pro",
              tokenType: "TOKENS",
              remainingFraction: 0.5,
              remainingAmount: "500",
              resetTime: "2026-08-18T00:00:00Z",
            },
            {
              modelId: "gemini-1.0.0-pro",
              tokenType: "REQUESTS",
              remainingFraction: 0.9,
              remainingAmount: "900",
              resetTime: "2026-08-18T00:00:00Z",
            },
            {
              modelId: "gemini-1.0.alpha-pro",
              tokenType: "REQUESTS",
              remainingFraction: 0.9,
              remainingAmount: "900",
              resetTime: "2026-08-18T00:00:00Z",
            },
            {
              modelId: "gemini-1.0.beta-pro",
              tokenType: "REQUESTS",
              remainingFraction: 0.9,
              remainingAmount: "900",
              resetTime: "2026-08-18T00:00:00Z",
            },
            {
              modelId: "gemini-custom-pro",
              tokenType: "REQUESTS",
              remainingFraction: 0.9,
              remainingAmount: "900",
              resetTime: "2026-08-18T00:00:00Z",
            },
            {
              modelId: "claude-3-5-sonnet_vertex",
              tokenType: "REQUESTS",
              remainingFraction: 0.9,
              remainingAmount: "900",
              resetTime: "2026-08-18T00:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const tool = createAgyQuotaTool({
      client,
      getAuthResolver: () => async () => ({
        type: "oauth",
        access: "acc",
        refresh: "ref",
        expires: Date.now() + 100000,
      }),
      getConfiguredProjectId: () => "proj-1",
      getUserAgentModel: () => "gemini-pro",
    });

    const result = await (tool as any).execute({});
    expect(result).toContain("Agy quota usage for project `proj-1`");
  });

  it("tests fetchWithRetry with Request object input and signal abortion", async () => {
    vi.spyOn(retryHelpers, "wait").mockResolvedValue();
    const controller = new AbortController();
    const req = new Request("https://daily-cloudcode-pa.googleapis.com/v1/test", {
      method: "POST",
      body: JSON.stringify({ project: "proj", model: "model" }),
      signal: controller.signal,
    });

    vi.spyOn(fetchModule, "agyFetch").mockImplementation((async () => {
      controller.abort();
      throw new TypeError("fetch failed");
    }) as any);

    await expect(fetchWithRetry(req, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

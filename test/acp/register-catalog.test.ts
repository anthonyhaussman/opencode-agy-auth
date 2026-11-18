import { describe, expect, it, vi } from "vitest";
import { AGY_ACP_PROVIDER_ID } from "../../src/acp/constants";
import { ModelRegistry, registerCatalog } from "../../src/acp/register-catalog";

const A = [{ modelId: "m1", name: "Model One" }, { modelId: "m2" }];

describe("ModelRegistry", () => {
  it("list() is empty initially", () => {
    expect(new ModelRegistry(vi.fn(), vi.fn()).list()).toEqual([]);
  });

  it("set with a new list updates list() and calls reload once", async () => {
    const reload = vi.fn();
    const reg = new ModelRegistry(reload, vi.fn());
    await expect(reg.set(A)).resolves.toBe(true);
    expect(reg.list()).toEqual(A);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("set with an identical list does not call reload", async () => {
    const reload = vi.fn();
    const reg = new ModelRegistry(reload, vi.fn());
    await reg.set(A);
    await expect(reg.set(A.map((m) => ({ ...m })))).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("set with the same models in another order does not call reload", async () => {
    const reload = vi.fn();
    const reg = new ModelRegistry(reload, vi.fn());
    await reg.set(A);
    await expect(reg.set([...A].reverse())).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reg.list()).toEqual(A);
  });

  it("set with the same ids in another order and a changed name calls reload", async () => {
    const reload = vi.fn();
    const reg = new ModelRegistry(reload, vi.fn());
    await reg.set(A);
    await expect(reg.set([{ modelId: "m2" }, { modelId: "m1", name: "Renamed" }])).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("set with the same ids but a changed name calls reload", async () => {
    const reload = vi.fn();
    const reg = new ModelRegistry(reload, vi.fn());
    await reg.set(A);
    await expect(reg.set([{ modelId: "m1", name: "Renamed" }, { modelId: "m2" }])).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reg.list()[0]?.name).toBe("Renamed");
  });

  it("set with an empty list after models clears them and reloads", async () => {
    const reload = vi.fn();
    const reg = new ModelRegistry(reload, vi.fn());
    await reg.set(A);
    await expect(reg.set([])).resolves.toBe(true);
    expect(reg.list()).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reload rejection is logged, not thrown", async () => {
    const log = vi.fn();
    const reg = new ModelRegistry(() => Promise.reject(new Error("boom")), log);
    await expect(reg.set(A)).resolves.toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe("warn");
    expect(log.mock.calls[0]?.[1]).toContain("catalog reload");
    expect(log.mock.calls[0]?.[1]).toContain("boom");
  });

  it("synchronous reload throw is logged, not thrown", async () => {
    const log = vi.fn();
    const reg = new ModelRegistry(() => {
      throw new Error("sync");
    }, log);
    await expect(reg.set(A)).resolves.toBe(true);
    expect(log.mock.calls[0]?.[1]).toContain("catalog reload");
  });

  it("does not hold onto the caller's array", async () => {
    const reg = new ModelRegistry(vi.fn(), vi.fn());
    const input = [...A];
    await reg.set(input);
    input.push({ modelId: "m3" });
    expect(reg.list()).toHaveLength(2);
  });
});

describe("registerCatalog", () => {
  it("registers exactly registry.list()", async () => {
    let transform: ((draft: any) => void) | undefined;
    const ctx = { catalog: { transform: (fn: (draft: any) => void) => void (transform = fn) } };
    const reg = new ModelRegistry(vi.fn(), vi.fn());
    registerCatalog(ctx, "aisdk:x", () => reg.list());

    const run = () => {
      const update = vi.fn();
      transform?.({ provider: { update: vi.fn() }, model: { update } });
      return update.mock.calls.map((c) => [c[0], c[1]]);
    };

    expect(run()).toEqual([]);
    await reg.set(A);
    expect(run()).toEqual([
      [AGY_ACP_PROVIDER_ID, "m1"],
      [AGY_ACP_PROVIDER_ID, "m2"],
    ]);
  });
});

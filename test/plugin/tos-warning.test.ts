import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGY_TOS_APPEAL_URL,
  AGY_TOS_WARNING,
  AGY_TOS_WARNING_TITLE,
  emitAgyTosWarning,
  resetAgyTosWarningForTesting,
} from "../../src/plugin/tos-warning";
import type { PluginClient } from "../../src/plugin/types";

describe("AGY_TOS_WARNING", () => {
  it("points to the google-agy-acp provider", () => {
    expect(AGY_TOS_WARNING).toContain("google-agy-acp");
  });
});

describe("emitAgyTosWarning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAgyTosWarningForTesting();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    resetAgyTosWarningForTesting();
  });

  it("logs the warning to the console without a client", () => {
    emitAgyTosWarning();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0]);
    expect(message).toContain("[Agy Auth] WARNING:");
    expect(message).toContain(AGY_TOS_WARNING);
    expect(message).toContain(AGY_TOS_APPEAL_URL);
  });

  it("emits only once per process", () => {
    const showToast = vi.fn().mockResolvedValue(undefined);
    const client = { tui: { showToast } } as unknown as PluginClient;
    emitAgyTosWarning(client);
    emitAgyTosWarning(client);
    emitAgyTosWarning();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("shows a red error toast when the client supports it", () => {
    const showToast = vi.fn().mockResolvedValue(undefined);
    emitAgyTosWarning({ tui: { showToast } } as unknown as PluginClient);
    expect(showToast).toHaveBeenCalledWith({
      body: expect.objectContaining({
        title: AGY_TOS_WARNING_TITLE,
        message: AGY_TOS_WARNING,
        variant: "error",
      }),
    });
  });

  it("skips the toast when the client has no tui", () => {
    expect(() => emitAgyTosWarning({} as unknown as PluginClient)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows synchronous toast failures", () => {
    const showToast = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() => emitAgyTosWarning({ tui: { showToast } } as unknown as PluginClient)).not.toThrow();
  });

  it("swallows asynchronous toast rejections", async () => {
    const showToast = vi.fn().mockRejectedValue(new Error("boom"));
    expect(() => emitAgyTosWarning({ tui: { showToast } } as unknown as PluginClient)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

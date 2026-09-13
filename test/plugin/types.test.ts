import { describe, expect, it, vi } from "vitest";
import {
  defineOpenCodeV2Plugin,
  type DualOpenCodePlugin,
  type OpenCodeV2PluginContext,
  type OpenCodeV2PluginDefinition,
} from "../../src/plugin/types";

describe("OpenCode v2 plugin types and helper", () => {
  it("returns plugin definition unmodified in defineOpenCodeV2Plugin", () => {
    const pluginDef: OpenCodeV2PluginDefinition = {
      id: "test-plugin",
      setup: vi.fn(),
    };

    const result = defineOpenCodeV2Plugin(pluginDef);
    expect(result).toBe(pluginDef);
    expect(result.id).toBe("test-plugin");
  });

  it("supports synchronous setup function", () => {
    const setupMock = vi.fn();
    const plugin = defineOpenCodeV2Plugin({
      id: "sync-plugin",
      setup: setupMock,
    });

    const dummyContext: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: { transform: vi.fn() },
      location: { root: "/root", workspace: "/workspace" },
    };

    plugin.setup(dummyContext);
    expect(setupMock).toHaveBeenCalledWith(dummyContext);
  });

  it("supports asynchronous setup function", async () => {
    const setupMock = vi.fn().mockResolvedValue(undefined);
    const plugin = defineOpenCodeV2Plugin({
      id: "async-plugin",
      setup: setupMock,
    });

    const dummyContext: OpenCodeV2PluginContext = {
      catalog: { transform: vi.fn() },
      tool: { transform: vi.fn() },
      command: { transform: vi.fn() },
      session: { hook: vi.fn() },
      integration: { transform: vi.fn() },
      location: {},
    };

    await plugin.setup(dummyContext);
    expect(setupMock).toHaveBeenCalledWith(dummyContext);
  });

  it("satisfies DualOpenCodePlugin interface contracts", async () => {
    const serverFn = vi.fn().mockResolvedValue({ status: "ok" });
    const dualPlugin: DualOpenCodePlugin = {
      id: "dual-plugin",
      setup: vi.fn(),
      server: serverFn,
    };

    expect(dualPlugin.id).toBe("dual-plugin");
    const serverRes = await dualPlugin.server({ port: 1234 });
    expect(serverRes).toEqual({ status: "ok" });
    expect(serverFn).toHaveBeenCalledWith({ port: 1234 });
  });
});

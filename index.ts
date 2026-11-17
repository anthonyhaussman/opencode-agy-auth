import { setupOpenCodeV2, v2PluginDefinition } from "./src/plugin/v2";
import type { OpenCodeV2PluginDefinition } from "./src/plugin/types";

export { setupOpenCodeV2, v2PluginDefinition };
export * from "./src/plugin/types";

const plugin: OpenCodeV2PluginDefinition = v2PluginDefinition;

export default plugin;

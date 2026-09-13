import { AgyCLIOAuthPlugin, GoogleOAuthPlugin } from "./src/plugin";
import { setupOpenCodeV2, v2PluginDefinition } from "./src/plugin/v2";
import type { DualOpenCodePlugin } from "./src/plugin/types";

export { AgyCLIOAuthPlugin, GoogleOAuthPlugin };
export { setupOpenCodeV2, v2PluginDefinition };
export * from "./src/plugin/types";

const dualPlugin: DualOpenCodePlugin = {
  ...v2PluginDefinition,
  server: AgyCLIOAuthPlugin,
};

export default dualPlugin;

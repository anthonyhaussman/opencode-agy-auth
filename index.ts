import { AgyCLIOAuthPlugin, GoogleOAuthPlugin } from "./src/plugin";
import { setupOpenCodeV2, v2PluginDefinition } from "./src/plugin/v2";
import type { DualOpenCodePlugin } from "./src/plugin/types";

export { AgyCLIOAuthPlugin, GoogleOAuthPlugin };
export { setupOpenCodeV2, v2PluginDefinition };
export * from "./src/plugin/types";
export { identifyAccounts, type AccountIdentity } from "./src/plugin/identity";
export {
  loadAccountStore,
  loadAccountAuth,
  saveAccountAuth,
  setActiveAccount,
  seedAccountFromActive,
  renameAccount,
  removeAccount,
  syncAccountStore,
  importAccountFromJson,
  importAccountFromProvider,
  describeAccounts,
  splitAccountModel,
  accountModelKey,
} from "./src/plugin/v2-storage";

const dualPlugin: DualOpenCodePlugin = {
  ...v2PluginDefinition,
  server: AgyCLIOAuthPlugin,
};

export default dualPlugin;

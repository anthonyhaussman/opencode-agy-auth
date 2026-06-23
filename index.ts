import { AgyCLIOAuthPlugin, GoogleOAuthPlugin } from "./src/plugin";
import { shutdownRetryCooldowns } from "./src/sdk/retry";
import { shutdownTurnStateTracker } from "./src/sdk/request/turn-state-tracker";

export { AgyCLIOAuthPlugin, GoogleOAuthPlugin };

export function shutdownAgyPlugin(): void {
  shutdownRetryCooldowns();
  shutdownTurnStateTracker();
}

export default AgyCLIOAuthPlugin;

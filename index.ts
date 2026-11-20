/**
 * opencode-agy-auth — V2-only entry point.
 *
 * One plugin, N provider IDs (options.ids, default ["agy"]).
 * Each ID has a single Google OAuth account whose credential is owned by
 * OpenCode (SQLite). No plugin-owned credential store, no account/model
 * namespacing, no multi-account failover.
 *
 * All request shaping is delegated to the proven helpers in src/sdk + src/plugin.
 */
import v2Clean from "./src/v2-clean";

export { setup } from "./src/v2-clean";
export default v2Clean;

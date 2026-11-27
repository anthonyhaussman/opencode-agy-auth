/**
 * AI SDK package placeholder for the google-agy-acp provider.
 *
 * The provider record points OpenCode at this module (`aisdk:file://...`) so
 * OpenCode never falls back to installing an npm package. The real language
 * model is supplied by the plugin's `aisdk.hook("sdk")` handler; this factory
 * only runs if that hook did not, and then fails with a clear message.
 */
const MESSAGE =
  "google-agy-acp models are provided by the opencode-agy-auth plugin. Make sure the plugin is enabled and runs on OpenCode v2.4.0 or newer.";

export function createGoogleAgyAcp(): { languageModel(modelId: string): never } {
  return {
    languageModel(): never {
      throw new Error(MESSAGE);
    },
  };
}

export default createGoogleAgyAcp;

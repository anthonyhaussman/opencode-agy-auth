import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "index.ts", "sdk-placeholder": "src/acp/sdk-placeholder.ts" },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "node20",
  noExternal: ["@opencode-ai/plugin", "@openauthjs/openauth"],
});

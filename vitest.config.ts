import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      OPENCODE_HEADLESS: "1",
    },
    include: ["test/**/*.test.ts"],
    // Legacy V1/V2 dual-architecture tests are archived under test/legacy/.
    // They assert removed behavior (static catalog, plugin-owned multi-account
    // store). Kept for audit, excluded from the active suite.
    exclude: ["test/legacy/**"],
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 94,
        branches: 85,
      },
    },
  },
});

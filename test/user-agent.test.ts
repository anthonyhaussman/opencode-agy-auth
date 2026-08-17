import { describe, expect, it, beforeEach, afterEach } from "vitest";
import os from "node:os";
import { buildAgyCliUserAgent, getAgyCliVersion, userAgentInternals } from "../src/sdk/user-agent";
import { AGY_CLI_VERSION } from "../src/sdk/agy-cli-version";

describe("user-agent", () => {
  const originalEnv = process.env.OPENCODE_AGY_CLI_VERSION;

  beforeEach(() => {
    userAgentInternals.resetCache();
    delete process.env.OPENCODE_AGY_CLI_VERSION;
  });

  afterEach(() => {
    userAgentInternals.resetCache();
    if (originalEnv !== undefined) {
      process.env.OPENCODE_AGY_CLI_VERSION = originalEnv;
    } else {
      delete process.env.OPENCODE_AGY_CLI_VERSION;
    }
  });

  it("returns default AGY_CLI_VERSION when env var is not set", () => {
    expect(getAgyCliVersion()).toBe(AGY_CLI_VERSION);
  });

  it("respects OPENCODE_AGY_CLI_VERSION env var override", () => {
    process.env.OPENCODE_AGY_CLI_VERSION = "0.99.0";
    expect(getAgyCliVersion()).toBe("0.99.0");
  });

  it("formats user-agent with platform and architecture", () => {
    const ua = buildAgyCliUserAgent();
    const rawPlatform = os.platform();
    const expectedPlatform = rawPlatform === "win32" ? "windows" : rawPlatform;
    const rawArch = os.arch();
    const expectedArch = rawArch === "x64" ? "amd64" : rawArch;

    expect(ua).toBe(`antigravity/cli/${AGY_CLI_VERSION} ${expectedPlatform}/${expectedArch}`);
  });
});

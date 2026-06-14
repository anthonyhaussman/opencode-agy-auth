import os from 'os';
import { AGY_CLI_VERSION } from './agy-cli-version';

const AGY_CLI_UA_NAME = 'GeminiCLI';
const AGY_CLI_DEFAULT_MODEL = 'gemini-code-assist';
const AGY_CLI_DEFAULT_SURFACE = 'terminal';

export function getAgyCliVersion(): string {
  const explicitVersion = process.env.OPENCODE_AGY_CLI_VERSION?.trim();
  if (explicitVersion) {
    return explicitVersion;
  }
  return AGY_CLI_VERSION;
}

export function buildAgyCliUserAgent(model?: string): string {
  const version = getAgyCliVersion();
  const rawPlatform = os.platform();
  const platform = rawPlatform === 'win32' ? 'windows' : rawPlatform;
  const rawArch = os.arch();
  const arch = rawArch === 'x64' ? 'amd64' : rawArch;
  return `antigravity/cli/${version} ${platform}/${arch}`;
}

function getAgyCliSurface(): string {
  return (
    process.env.AGY_CLI_SURFACE?.trim() ||
    process.env.SURFACE?.trim() ||
    AGY_CLI_DEFAULT_SURFACE
  );
}

export const userAgentInternals = {
  resetCache() {}
};

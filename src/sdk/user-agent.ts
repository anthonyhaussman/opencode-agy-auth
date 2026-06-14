import os from 'node:os';
import { AGY_CLI_VERSION } from './agy-cli-version';

const AGY_CLI_DEFAULT_SURFACE = 'terminal';

let cachedUserAgent: string | null = null;

export function getAgyCliVersion(): string {
  const explicitVersion = process.env.OPENCODE_AGY_CLI_VERSION?.trim();
  if (explicitVersion) {
    return explicitVersion;
  }
  return AGY_CLI_VERSION;
}

export function buildAgyCliUserAgent(model?: string): string {
  const version = getAgyCliVersion();
  if (cachedUserAgent && cachedUserAgent.startsWith('antigravity/cli/' + version + ' ')) {
    return cachedUserAgent;
  }
  const rawPlatform = os.platform();
  const platform = rawPlatform === 'win32' ? 'windows' : rawPlatform;
  const rawArch = os.arch();
  const arch = rawArch === 'x64' ? 'amd64' : rawArch;
  cachedUserAgent = 'antigravity/cli/' + version + ' ' + platform + '/' + arch;
  return cachedUserAgent;
}

function getAgyCliSurface(): string {
  return (
    process.env.AGY_CLI_SURFACE?.trim() ||
    process.env.SURFACE?.trim() ||
    AGY_CLI_DEFAULT_SURFACE
  );
}

export const userAgentInternals = {
  resetCache() {
    cachedUserAgent = null;
  }
};

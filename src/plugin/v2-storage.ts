import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { AGY_PROVIDER_ID } from '../constants';

let storedAuthOverrideForTesting: any = undefined;

export function setStoredAuthOverrideForTesting(override: any): void {
  storedAuthOverrideForTesting = override;
}

export function loadStoredAuthFromJson(): any {
  if (storedAuthOverrideForTesting !== undefined) {
    return storedAuthOverrideForTesting;
  }
  const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  try {
    if (existsSync(authPath)) {
      const content = readFileSync(authPath, 'utf8');
      const data = JSON.parse(content);
      return data?.[AGY_PROVIDER_ID];
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

export function saveStoredAuthToJson(authRecord: any): void {
  // Never overwrite the user's real auth.json during tests or when testing override is active
  if (process.env.NODE_ENV === 'test' || process.env.VITEST || storedAuthOverrideForTesting !== undefined) {
    return;
  }
  try {
    const dirPath = join(homedir(), '.local', 'share', 'opencode');
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    const authPath = join(dirPath, 'auth.json');
    let data: Record<string, any> = {};
    if (existsSync(authPath)) {
      try {
        data = JSON.parse(readFileSync(authPath, 'utf8')) || {};
      } catch {
        data = {};
      }
    }
    data[AGY_PROVIDER_ID] = {
      type: 'oauth',
      refresh: authRecord.refresh,
      access: authRecord.access,
      expires: authRecord.expires,
    };
    writeFileSync(authPath, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Ignore write errors
  }
}

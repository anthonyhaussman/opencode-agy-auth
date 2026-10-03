import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
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
  const dirPath = join(homedir(), '.local', 'share', 'opencode');
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  const authPath = join(dirPath, 'auth.json');
  const data: Record<string, any> = existsSync(authPath)
    ? JSON.parse(readFileSync(authPath, 'utf8'))
    : {};
  data[AGY_PROVIDER_ID] = {
    type: 'oauth',
    refresh: authRecord.refresh,
    access: authRecord.access,
    expires: authRecord.expires,
  };

  const tempPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
  let tempFileDescriptor: number | undefined;
  let ownsTempFile = false;
  try {
    tempFileDescriptor = openSync(tempPath, 'wx', 0o600);
    ownsTempFile = true;
    writeFileSync(tempFileDescriptor, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
    });
    closeSync(tempFileDescriptor);
    tempFileDescriptor = undefined;
    renameSync(tempPath, authPath);
  } catch (error) {
    if (tempFileDescriptor !== undefined) {
      try {
        closeSync(tempFileDescriptor);
      } catch {
        // Preserve the original persistence error.
      }
    }
    if (ownsTempFile) {
      try {
        unlinkSync(tempPath);
      } catch {
        // The temporary file has already been renamed or removed.
      }
    }
    throw error;
  }
}

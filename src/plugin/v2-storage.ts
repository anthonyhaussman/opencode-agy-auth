import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { AGY_PROVIDER_ID } from '../constants';

let storedAuthOverrideForTesting: any = undefined;

export function setStoredAuthOverrideForTesting(override: any): void {
  storedAuthOverrideForTesting = override;
}

export interface AccountStore {
  activeAccount?: string;
  accounts: Record<string, any>;
}

const FALLBACK_ACCOUNT = 'default';

/**
 * Source of truth for accounts, OWNED BY THE PLUGIN.
 *
 * `auth.json` cannot hold this: OpenCode itself writes the `google-agy` entry
 * as a flat OAuth record when it refreshes a token, which silently deletes any
 * nested `accounts` map (verified: kpihx/demar disappeared after one run).
 * So accounts live here, and `auth.json` is kept only as a flat mirror for
 * OpenCode's own auth detection.
 */
const ACCOUNTS_FILE = join(homedir(), '.local', 'share', 'opencode', 'agy-accounts.json');

function readAccountsFile(): any {
  try {
    if (existsSync(ACCOUNTS_FILE)) {
      return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
  } catch {
    // Corrupt file: fall back to auth.json migration below.
  }
  return undefined;
}

function writeAccountsFile(store: AccountStore): void {
  const dirPath = join(homedir(), '.local', 'share', 'opencode');
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  const tempPath = `${ACCOUNTS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ activeAccount: store.activeAccount, accounts: store.accounts }, null, 2), {
      encoding: 'utf8',
    });
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, ACCOUNTS_FILE);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original error.
      }
    }
    throw error;
  }
}

/**
 * One-time bootstrap when no accounts file exists yet.
 *
 * Rebuilds named accounts from what is available on disk: the flat/nested
 * `google-agy` entry becomes `kpihx`, and a distinct `google` OAuth record (a
 * leftover Antigravity login, different refresh token) becomes `demar`.
 * No secret is printed, and nothing is invented: only tokens already present.
 */
function bootstrapAccounts(entry: any): AccountStore {
  const store = normalizeAccountStore(entry);
  const names = Object.keys(store.accounts);
  if (names.length === 0) {
    return store;
  }

  const accounts: Record<string, any> = {};
  let activeAccount: string | undefined;

  if (names.length === 1) {
    const only = store.accounts[names[0] as string];
    accounts.kpihx = only;
    activeAccount = 'kpihx';
  } else {
    for (const name of names) {
      accounts[name] = store.accounts[name];
    }
    activeAccount = store.activeAccount;
  }

  const primaryName = activeAccount ?? (Object.keys(accounts)[0] as string);
  const primary = primaryName ? accounts[primaryName] : undefined;
  const secondary = readProviderEntry('google');
  if (
    secondary &&
    typeof secondary === 'object' &&
    typeof secondary.refresh === 'string' &&
    secondary.refresh &&
    secondary.refresh !== primary?.refresh &&
    !accounts.demar
  ) {
    accounts.demar = {
      type: 'oauth',
      access: secondary.access ?? '',
      refresh: secondary.refresh,
      expires: secondary.expires ?? 0,
      importedFromProvider: 'google',
    };
  }

  return {
    activeAccount: activeAccount ?? Object.keys(accounts)[0],
    accounts,
  };
}

/**
 * Normalise the `google-agy` entry of auth.json.
 *
 * Two shapes are accepted:
 *   legacy (single account):   { type, access, refresh, expires }
 *   multi-account:             { activeAccount, accounts: { <name>: { type, access, refresh, expires } } }
 *
 * The legacy shape is wrapped into a one-entry account map so every consumer can
 * work with accounts uniformly, without breaking existing installations.
 */
export function normalizeAccountStore(raw: any): AccountStore {
  if (!raw || typeof raw !== 'object') {
    return { accounts: {} };
  }
  if (raw.accounts && typeof raw.accounts === 'object') {
    const accounts: Record<string, any> = {};
    for (const [name, record] of Object.entries(raw.accounts)) {
      if (record && typeof record === 'object') {
        accounts[name] = record;
      }
    }
    let activeAccount =
      typeof raw.activeAccount === 'string' && raw.activeAccount in accounts
        ? raw.activeAccount
        : Object.keys(accounts)[0];
    // OpenCode itself reads this entry and needs the flat OAuth fields. Those
    // mirror the active account; backfill the active record if it is incomplete.
    if (activeAccount && accounts[activeAccount]) {
      const activeRecord = accounts[activeAccount];
      accounts[activeAccount] = {
        ...activeRecord,
        type: activeRecord.type ?? raw.type ?? 'oauth',
        access: activeRecord.access ?? raw.access,
        refresh: activeRecord.refresh ?? raw.refresh,
        expires: activeRecord.expires ?? raw.expires,
      };
    }
    return { activeAccount, accounts };
  }
  if (typeof raw.type === 'string' || typeof raw.access === 'string' || typeof raw.refresh === 'string') {
    return { activeAccount: FALLBACK_ACCOUNT, accounts: { [FALLBACK_ACCOUNT]: raw } };
  }
  return { accounts: {} };
}

/**
 * Serialise a store into the on-disk entry.
 *
 * The flat OAuth fields are REQUIRED because OpenCode reads this same entry for
 * its own provider auth detection; they mirror the active account. The
 * `accounts` map and `activeAccount` are our extension.
 */
function buildProviderEntry(store: AccountStore): any {
  const activeAccount = store.activeAccount || Object.keys(store.accounts)[0];
  const activeRecord = activeAccount ? store.accounts[activeAccount] : undefined;
  const entry: Record<string, any> = { activeAccount, accounts: store.accounts };
  if (activeRecord) {
    entry.type = activeRecord.type ?? 'oauth';
    entry.access = activeRecord.access;
    entry.refresh = activeRecord.refresh;
    entry.expires = activeRecord.expires;
  }
  return entry;
}

function readProviderEntry(providerId: string): any {
  if (storedAuthOverrideForTesting !== undefined && providerId === AGY_PROVIDER_ID) {
    return storedAuthOverrideForTesting;
  }
  const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  try {
    if (existsSync(authPath)) {
      const content = readFileSync(authPath, 'utf8');
      const data = JSON.parse(content);
      return data?.[providerId];
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

function readRawProviderEntry(): any {
  return readProviderEntry(AGY_PROVIDER_ID);
}

/**
 * Import an account from another provider entry in the same auth.json
 * (e.g. a leftover `google` OAuth record). The secret is moved by the plugin and
 * never returned or logged.
 */
export function importAccountFromProvider(name: string, providerId: string): boolean {
  const entry = readProviderEntry(providerId);
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const refresh = String(entry.refresh ?? '');
  if (!refresh) {
    return false;
  }
  saveAccountAuth(name, {
    type: 'oauth',
    access: String(entry.access ?? ''),
    refresh,
    expires: typeof entry.expires === 'number' ? entry.expires : 0,
    importedFromProvider: providerId,
  });
  return true;
}

/** Full account store (plugin-owned file first, auth.json migration second). */
export function loadAccountStore(): AccountStore {
  const file = readAccountsFile();
  if (file && file.accounts && typeof file.accounts === 'object' && Object.keys(file.accounts).length > 0) {
    const store = normalizeAccountStore(file);
    // OpenCode may have refreshed the active token and written it flat into
    // auth.json: absorb it so we do not keep a stale access token.
    const flat = readRawProviderEntry();
    const active = store.activeAccount;
    const record = active ? store.accounts[active] : undefined;
    if (flat && !flat.accounts && active && record && flat.refresh && flat.refresh === record.refresh) {
      if (flat.access && flat.access !== record.access) {
        store.accounts[active] = {
          ...record,
          access: flat.access,
          expires: typeof flat.expires === 'number' ? flat.expires : record.expires,
        };
      }
    }
    return store;
  }

  const migrated = bootstrapAccounts(readRawProviderEntry());
  if (Object.keys(migrated.accounts).length > 0 && !persistenceDisabled()) {
    writeAccountsFile(migrated);
  }
  return migrated;
}

/** Raw OAuth record for one account (defaults to the active account). */
export function loadAccountAuth(name?: string): any {
  const store = loadAccountStore();
  const key = name || store.activeAccount || Object.keys(store.accounts)[0];
  if (!key) {
    return undefined;
  }
  return store.accounts[key];
}

/**
 * Backwards-compatible accessor: returns the ACTIVE account's OAuth record.
 * Every legacy call site keeps working unchanged.
 */
export function loadStoredAuthFromJson(): any {
  if (storedAuthOverrideForTesting !== undefined) {
    const store = normalizeAccountStore(storedAuthOverrideForTesting);
    const key = store.activeAccount || Object.keys(store.accounts)[0];
    return key ? store.accounts[key] : undefined;
  }
  return loadAccountAuth();
}

/**
 * Split `<account>/<model>` (or the provider-qualified `google-agy/<account>/<model>`)
 * into its account name and bare model id. Model ids containing no slash are
 * returned untouched with no account, preserving single-account behaviour.
 */
export function splitAccountModel(modelId: string): { account?: string; model: string } {
  if (!modelId) {
    return { model: modelId };
  }
  let value = modelId;
  if (value.startsWith(`${AGY_PROVIDER_ID}/`)) {
    value = value.slice(AGY_PROVIDER_ID.length + 1);
  }
  const slash = value.indexOf('/');
  if (slash <= 0) {
    return { model: value };
  }
  return { account: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** Namespaced catalogue key for an account's model: `<account>/<model>`. */
export function accountModelKey(account: string, modelId: string): string {
  return `${account}/${modelId}`;
}

/**
 * Persist a store: the plugin-owned file is the truth, auth.json gets the flat
 * mirror OpenCode needs for its own auth detection.
 */
function persistStore(store: AccountStore): void {
  if (persistenceDisabled()) {
    return;
  }
  writeAccountsFile(store);
  writeRawProviderEntry(buildProviderEntry(store));
}

function writeRawProviderEntry(entry: any): void {
  const dirPath = join(homedir(), '.local', 'share', 'opencode');
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  const authPath = join(dirPath, 'auth.json');
  const data: Record<string, any> = existsSync(authPath)
    ? JSON.parse(readFileSync(authPath, 'utf8'))
    : {};
  data[AGY_PROVIDER_ID] = entry;

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

function persistenceDisabled(): boolean {
  return Boolean(process.env.NODE_ENV === 'test' || process.env.VITEST || storedAuthOverrideForTesting !== undefined);
}

/** Upsert one account, keeping every other account and the active pointer. */
export function saveAccountAuth(name: string, authRecord: any): void {
  if (persistenceDisabled()) {
    return;
  }
  const store = loadAccountStore();
  const accounts = { ...store.accounts, [name]: authRecord };
  const activeAccount = store.activeAccount || name;
  persistStore({ activeAccount, accounts });
}

/** Change the default account without touching its credentials. */
export function setActiveAccount(name: string): void {
  if (persistenceDisabled()) {
    return;
  }
  const store = loadAccountStore();
  if (!(name in store.accounts)) {
    throw new Error(`Unknown account "${name}" (known: ${Object.keys(store.accounts).join(', ') || 'none'})`);
  }
  persistStore({ activeAccount: name, accounts: store.accounts });
}

/**
 * Rename an account entry, preserving its credentials and the active pointer.
 * Returns false when the source does not exist or the target already does.
 */
export function renameAccount(from: string, to: string): boolean {
  const store = loadAccountStore();
  if (!store.accounts[from] || store.accounts[to] || !to || from === to) {
    return false;
  }
  const accounts: Record<string, any> = {};
  for (const [name, record] of Object.entries(store.accounts)) {
    accounts[name === from ? to : name] = record;
  }
  const activeAccount = store.activeAccount === from ? to : store.activeAccount;
  if (persistenceDisabled()) {
    return false;
  }
  persistStore({ activeAccount, accounts });
  return true;
}

/** Remove one account entry (never the last one). */
export function removeAccount(name: string): boolean {
  const store = loadAccountStore();
  if (!(name in store.accounts) || Object.keys(store.accounts).length <= 1) {
    return false;
  }
  const accounts: Record<string, any> = { ...store.accounts };
  delete accounts[name];
  const activeAccount = store.activeAccount === name ? Object.keys(accounts)[0] : store.activeAccount;
  persistStore({ activeAccount, accounts });
  return true;
}

/**
 * Rewrite the stored entry in canonical shape: flat OAuth mirror of the active
 * account (required by OpenCode's own auth detection) plus the accounts map.
 * Idempotent; used to migrate files that only carry the nested form.
 */
export function syncAccountStore(): boolean {
  if (persistenceDisabled()) {
    return false;
  }
  const store = loadAccountStore();
  if (Object.keys(store.accounts).length === 0) {
    return false;
  }
  persistStore(store);
  return true;
}

/**
 * Create a new account entry for `name`.
 *
 * NEVER copies credentials from another account: two names sharing one token is
 * indistinguishable from a real second account until the quota contradicts it
 * (that exact trap cost a debugging session — a `demar` entry cloned from
 * `kpihx` silently spent kpihx's exhausted quota under a different label).
 *
 * The entry is a STUB (`needsCredentials: true`): fill `refresh` (and
 * optionally `access`/`expires`) by editing the JSON directly. Idempotent.
 */
export function seedAccountFromActive(name: string): boolean {
  const store = loadAccountStore();
  const active = store.activeAccount || Object.keys(store.accounts)[0];
  if (!store.accounts[name]) {
    saveAccountAuth(name, {
      type: 'oauth',
      access: '',
      refresh: '',
      expires: 0,
      needsCredentials: true,
      seededFrom: active ?? null,
    });
  }
  return true;
}

/**
 * Import one account from an OAuth JSON file (Google "installed app" shape or a
 * flat `{access, refresh, expires}`). The secret is read and stored by the
 * PLUGIN; it is never returned, logged or echoed.
 * Returns false when the file carries no refresh token.
 */
export function importAccountFromJson(name: string, filePath: string): boolean {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
  const record = raw?.installed ?? raw?.oauth ?? raw ?? {};
  const refresh = String(record?.refresh_token ?? record?.refresh ?? '');
  if (!refresh) {
    return false;
  }
  const access = String(record?.access_token ?? record?.access ?? '');
  const expiry = record?.expiry_date ?? record?.expires ?? 0;
  const expires =
    typeof expiry === 'number' ? expiry : (Date.parse(String(expiry)) || 0);
  saveAccountAuth(name, {
    type: 'oauth',
    access,
    refresh,
    expires,
    importedFrom: filePath,
  });
  return true;
}

export interface AccountSummary {
  name: string;
  expired: boolean;
  needsCredentials: boolean;
  hasRefresh: boolean;
  duplicateOf?: string;
}

/**
 * Safe, secret-free description of every configured account: perfect for a
 * diagnostic command. `duplicateOf` exposes two names sharing one token — the
 * failure mode where a stale account silently spends another one's quota.
 */
export function describeAccounts(): AccountSummary[] {
  const store = loadAccountStore();
  const seen = new Map<string, string>();
  return Object.entries(store.accounts).map(([name, record]) => {
    const refresh = typeof record?.refresh === 'string' ? record.refresh : '';
    const duplicateOf = refresh ? seen.get(refresh) : undefined;
    if (refresh && !duplicateOf) {
      seen.set(refresh, name);
    }
    return {
      name,
      expired: typeof record?.expires === 'number' ? record.expires < Date.now() : true,
      needsCredentials: Boolean(record?.needsCredentials),
      hasRefresh: Boolean(refresh),
      ...(duplicateOf ? { duplicateOf } : {}),
    };
  });
}

export function saveStoredAuthToJson(authRecord: any): void {
  // Never overwrite the user's real auth.json during tests or when testing override is active
  if (persistenceDisabled()) {
    return;
  }
  const store = loadAccountStore();
  const name = store.activeAccount || FALLBACK_ACCOUNT;
  saveAccountAuth(name, {
    type: 'oauth',
    refresh: authRecord.refresh,
    access: authRecord.access,
    expires: authRecord.expires,
  });
}

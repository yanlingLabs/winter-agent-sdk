// WS-25 (MCP OAuth) §2: the STORE SEAM every sign-in door reads and writes through.
//
// Three methods over an uninterpreted string per account -- the records codec (records.ts) owns what the
// string means. A host passes its Keychain store (Winter's daemon: its own profile's service); tests pass
// the memory store below. Nothing in `mcp-auth` ever writes a record anywhere else: no file, no env var,
// no log line.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_KEYCHAIN_SERVICE, envName, WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { createKeychainRawStore } from "../provider/keychain-store.ts";
import { McpOAuthError } from "./errors.ts";
import { decodeMcpOAuthClientRecord, decodeMcpOAuthTokenRecord, encodeMcpOAuthClientRecord, encodeMcpOAuthTokenRecord, type McpOAuthClientRecord, type McpOAuthTokenRecord } from "./records.ts";

export interface McpOAuthStore {
  read(account: string): Promise<string | null>;
  write(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

/** A process-local store, for tests and for a host that keeps sign-ins only for its own lifetime. */
export function createMemoryMcpOAuthStore(initial: Record<string, string> = {}): McpOAuthStore & { readonly entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    async read(account) {
      return entries.get(account) ?? null;
    },
    async write(account, value) {
      entries.set(account, value);
    },
    async remove(account) {
      entries.delete(account);
    },
  };
}

/**
 * The macOS Keychain, one service. `service` is the host's own (its brand's `keychainService`, per
 * profile); absent, the SDK's `DEFAULT_KEYCHAIN_SERVICE`.
 */
export function createKeychainMcpOAuthStore(service?: string): McpOAuthStore {
  return service === undefined ? createKeychainRawStore() : createKeychainRawStore(service);
}

/** Reads and validates a token record; `null` when there is no item. A malformed item throws typed. */
export async function readTokenRecord(store: McpOAuthStore, account: string): Promise<McpOAuthTokenRecord | null> {
  const raw = await store.read(account);
  return raw === null ? null : decodeMcpOAuthTokenRecord(raw);
}

/** Reads and validates a client record; `null` when there is no item. */
export async function readClientRecord(store: McpOAuthStore, account: string): Promise<McpOAuthClientRecord | null> {
  const raw = await store.read(account);
  return raw === null ? null : decodeMcpOAuthClientRecord(raw);
}

export async function writeTokenRecord(store: McpOAuthStore, account: string, record: McpOAuthTokenRecord): Promise<void> {
  await store.write(account, encodeMcpOAuthTokenRecord(record));
}

export async function writeClientRecord(store: McpOAuthStore, account: string, record: McpOAuthClientRecord): Promise<void> {
  await store.write(account, encodeMcpOAuthClientRecord(record));
}

/**
 * Reads a token record, answering `null` for a MALFORMED one as well as an absent one -- for the paths
 * where a broken item must behave as "not signed in" (the session's read, a refresh) rather than fail
 * the connection with a codec error. A NEWER record version is still thrown: acting as "not signed in"
 * on it would send the user to sign in again and overwrite what the newer Winter wrote.
 */
export async function readTokenRecordLenient(store: McpOAuthStore, account: string): Promise<McpOAuthTokenRecord | null> {
  try {
    return await readTokenRecord(store, account);
  } catch (err) {
    if (err instanceof McpOAuthError && err.code === "malformed_record") return null;
    throw err;
  }
}

// --- The SESSION's store ---------------------------------------------------------------------------

/**
 * TEST-ONLY: a JSON file of `{ account: value }`, re-read on every read so a second process's write
 * (a fake host's refresh) is seen. Selected ONLY by `mcpOAuthTestStoreEnvName(brand)` from the original process env (see `resolveSessionMcpOAuthStore`), the same
 * named-test-seam posture as `WINTER_TEST_PROVIDER`: the compiled-binary gate (`verify:mcp-oauth`) must
 * hand a spawned `winter` the fixture's sign-ins without the Keychain, which would prompt for an item a
 * different binary wrote. It writes the fixture's throwaway tokens to a temp file -- which is exactly why
 * nothing but that variable selects it.
 */
export function createTestFileMcpOAuthStore(path: string): McpOAuthStore & { readonly testFile: string } {
  const load = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const save = (entries: Record<string, string>): void => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    testFile: path,
    async read(account) {
      return load()[account] ?? null;
    },
    async write(account, value) {
      save({ ...load(), [account]: value });
    },
    async remove(account) {
      const entries = load();
      delete entries[account];
      save(entries);
    },
  };
}

/**
 * The env name of the test seam above, BRAND-DERIVED (`<envPrefix>TEST_MCP_OAUTH_STORE_FILE`;
 * `WINTER_TEST_MCP_OAUTH_STORE_FILE` for Winter). Every settings tier's `env` block refuses it
 * (`settings/env-filter.ts`'s `ALL_TIER_REFUSED_ENV`): a trusted project that could set it would move the
 * session's sign-ins into a file it controls.
 */
export function mcpOAuthTestStoreEnvName(brand: Pick<BrandProfile, "envPrefix">): string {
  return envName(brand, "TEST_MCP_OAUTH_STORE_FILE");
}

/** Winter's spelling of the name, for the gates that set it. */
export const MCP_OAUTH_TEST_STORE_ENV = mcpOAuthTestStoreEnvName(WINTER_BRAND);

/**
 * The store a SESSION reads its sign-ins from: the session's own Keychain service (the brand's, as for
 * every other `{ kind: "keychain" }` credential), or the test seam's file.
 *
 * The seam is honoured only when ALL of these hold, so no configuration path can reach it:
 *   - `testStoreFile` came from the ORIGINAL process environment (the caller reads it before any
 *     settings tier's `env` is merged -- production-wiring captures it first, and the tiers refuse the
 *     name anyway);
 *   - the session names a Keychain service explicitly, and it is NOT the SDK's default production service
 *     (`DEFAULT_KEYCHAIN_SERVICE`, the dist profile's): a gate names its own throwaway
 *     service, a production session never can without also changing where its real credentials live.
 */
export function resolveSessionMcpOAuthStore(opts: { keychainService: string | undefined; testStoreFile: string | undefined }): McpOAuthStore {
  const { keychainService, testStoreFile } = opts;
  if (testStoreFile !== undefined && testStoreFile !== "" && keychainService !== undefined && keychainService !== DEFAULT_KEYCHAIN_SERVICE) {
    return createTestFileMcpOAuthStore(testStoreFile);
  }
  return createKeychainMcpOAuthStore(keychainService);
}

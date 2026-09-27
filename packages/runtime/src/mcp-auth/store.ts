// WS-25 (MCP OAuth) §2: the STORE SEAM every sign-in door reads and writes through.
//
// Three methods over an uninterpreted string per account -- the records codec (records.ts) owns what the
// string means. A host passes its Keychain store (Winter's daemon: its own profile's service); tests pass
// the memory store below. Nothing in `mcp-auth` ever writes a record anywhere else: no file, no env var,
// no log line.
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
 * The macOS Keychain, one service. `service` is the host's own (Winter: `com.winter.core` on the default
 * profile, `com.winter.core.dev` on dev); absent, the SDK's `DEFAULT_KEYCHAIN_SERVICE`.
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

// Phase 6 Task 3 (R6-10): the macOS Keychain credential store.
//
// THE ONLY FILE IN THIS REPOSITORY THAT MAY NAME `Bun.secrets`, and a repo-wide grep tripwire in
// `keychain-store.test.ts` pins that. The rule is not stylistic: a test that reaches the real
// Keychain writes to the developer's own login keychain, which no test may do (Global Constraints),
// and the only way to be sure none does is to make the API unreachable from anywhere a test could
// call it accidentally.
//
// The store resolves ONE credential per provider/account: `account = "<providerId>:<accountId>"`,
// JSON-encoded `CredentialMaterial`, service from the session's own `brand.keychainService`
// (P7a/D19/R-7a-8: the SINGLE source -- see `session-provider.ts`'s keychain block), falling back to
// `DEFAULT_KEYCHAIN_SERVICE` for a caller that supplies none.
// That retires the single fixed secret name a per-provider layer cannot live with -- two accounts on
// the same provider, or two providers at once, need two records.
//
// `set`/`delete` are Keychain-only BY TYPE (provider-runtime's `CredentialStore` narrows their
// argument to `Extract<CredentialRef, {kind:"keychain"}>`), which is what makes "the SDK never
// persists an inline value, never writes an env var, never writes a credentials file" unrepresentable
// rather than merely documented.
//
// TEST RUNS (the Keychain-dialog incident): `defaultSecretsBackend()` honours `WINTER_TEST_KEYCHAIN=memory`
// (`TEST_KEYCHAIN_ENV`) and hands back a per-process in-memory backend instead of the real one. Every
// `bun test` run sets it (`scripts/test-keychain-guard.ts`), which also replaces the real API with a
// tripwire in the test process and every `bun` child it spawns, so a path that reaches the real Keychain
// anyway fails the test that caused it instead of raising a macOS consent dialog.
import type { CredentialMaterial, CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { CredentialResolutionError, redactRef } from "@yanlinglabs/winter-provider-runtime";
// `DEFAULT_KEYCHAIN_SERVICE` is DECLARED in the sdk's `options.ts` and imported here rather than
// re-declared: this codebase polices one-declaration-per-value everywhere else, and a second copy of
// a service NAME is the kind of drift that silently splits a user's credentials across two keychain
// services. Re-exported so a caller reads it from the module it is working in.
import { DEFAULT_KEYCHAIN_SERVICE, TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY, type CredentialRef } from "@yanlinglabs/winter-agent-sdk";
export { DEFAULT_KEYCHAIN_SERVICE, TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY };

/**
 * The shape this store needs from a secrets backend.
 *
 * A NAMED INTERFACE rather than a direct dependency on the global, and the reason is testability
 * without exception: the real backend is injected by DEFAULT and overridable by a caller, so the
 * unit tests below drive a double and the real path has exactly one construction site. Mirrors
 * `Bun.secrets`' own three methods and nothing more.
 */
export interface SecretsBackend {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean | void>;
}

/**
 * The TEST-ONLY in-memory backend `TEST_KEYCHAIN_ENV=memory` selects: ONE map per process, shared by
 * every store this module builds, so a `set` through one store is read back by another exactly as the
 * Keychain would. It starts empty -- a keychain ref reads as ABSENT -- and dies with the process. Within
 * one test process a write is visible to a later test that reads the same service/account; before the
 * redirect such a write went to the developer's real Keychain, so that is not a new coupling.
 */
const memorySecrets = new Map<string, string>();
const memoryKey = (service: string, name: string): string => `${service}\u0000${name}`;
const MEMORY_SECRETS_BACKEND: SecretsBackend = {
  async get({ service, name }) {
    return memorySecrets.get(memoryKey(service, name)) ?? null;
  },
  async set({ service, name, value }) {
    memorySecrets.set(memoryKey(service, name), value);
  },
  async delete({ service, name }) {
    return memorySecrets.delete(memoryKey(service, name));
  },
};

/**
 * ONE stderr line, the first time a process's default backend is the in-memory one -- so a redirect left
 * on by accident outside a test run is visible rather than a mystery of vanished credentials. Never the
 * value, never an account.
 */
let memoryBackendAnnounced = false;
function announceMemoryBackend(): void {
  if (memoryBackendAnnounced) return;
  memoryBackendAnnounced = true;
  try {
    process.stderr.write(`winter: ${TEST_KEYCHAIN_ENV}=${TEST_KEYCHAIN_MEMORY} -- the Keychain is replaced by an in-memory store for this process (test runs only)\n`);
  } catch {
    /* no stderr (a detached context): the redirect itself is unaffected */
  }
}

/**
 * The real backend, resolved LAZILY.
 *
 * Lazily because this module is imported by the selection path, which every session touches --
 * including sessions with no keychain ref at all, and including the Node-portable-ish contexts where
 * `Bun.secrets` may simply not exist. Reading the global at call time means a session that never
 * resolves a keychain ref never touches it, and a runtime without it reports a TYPED failure at the
 * point of use rather than crashing at import.
 */
function defaultSecretsBackend(): SecretsBackend {
  // TEST-ONLY REDIRECT (`TEST_KEYCHAIN_ENV`, declared in the sdk's `options.ts`, which says why it exists
  // and why a compiled binary honours it too). Read at CALL time, like the global below, so the choice is
  // the process's at the moment of use. Exactly `memory` selects the in-memory backend. Unset or empty:
  // the real backend, byte-identical to before the redirect existed.
  //
  // Any other non-empty value is REFUSED, and with `io`, never `unsupported`: the production store stack
  // (`createProductionCredentialStore`'s composite) reads `unsupported` as "not my ref kind, ask the next
  // member", and its last member answers `null` for a keychain ref -- so an `unsupported` here would turn
  // a typo into a silent "no credential". `io` stops the composite and surfaces the variable's name.
  const redirect = process.env[TEST_KEYCHAIN_ENV];
  if (redirect !== undefined && redirect !== "") {
    if (redirect === TEST_KEYCHAIN_MEMORY) {
      announceMemoryBackend();
      return MEMORY_SECRETS_BACKEND;
    }
    throw new CredentialResolutionError("io", `${TEST_KEYCHAIN_ENV} is set to an unrecognized value; the only accepted value is "${TEST_KEYCHAIN_MEMORY}" (test runs only) -- unset it to use the Keychain`);
  }
  const secrets = (globalThis as { Bun?: { secrets?: SecretsBackend } }).Bun?.secrets;
  if (secrets === undefined) {
    throw new CredentialResolutionError("unsupported", "the Keychain credential store requires Bun.secrets, which is unavailable in this runtime");
  }
  return secrets;
}

export interface KeychainCredentialStoreOptions {
  /** Injected in tests. The real `Bun.secrets` path is NEVER exercised under test -- see this file's header. */
  secrets?: SecretsBackend;
}

/**
 * A `CredentialStore` backed by the macOS Keychain.
 *
 * `get` answers `null` for a ref this store does not own, rather than throwing: a composite store
 * (provider-runtime's `createCompositeCredentialStore`) tries each member in turn, and a member that
 * threw on someone else's ref kind would break the composition.
 */
export function createKeychainCredentialStore(service: string = DEFAULT_KEYCHAIN_SERVICE, opts: KeychainCredentialStoreOptions = {}): CredentialStore {
  const backend = (): SecretsBackend => opts.secrets ?? defaultSecretsBackend();
  return {
    async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
      if (ref.kind !== "keychain") return null;
      let raw: string | null;
      try {
        raw = await backend().get({ service: ref.service ?? service, name: ref.account });
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        // The REF is rendered redacted; the underlying error message is not reproduced at all. A
        // keychain error can quote the item it failed on, and this string reaches a log.
        throw new CredentialResolutionError("io", `keychain lookup failed for ${redactRef(ref)}`);
      }
      if (raw === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // The stored VALUE is never quoted in the message -- it is the secret.
        throw new CredentialResolutionError("malformed", `the keychain record for ${redactRef(ref)} is not valid JSON credential material`);
      }
      const material = coerceMaterial(parsed);
      if (material === undefined) throw new CredentialResolutionError("malformed", `the keychain record for ${redactRef(ref)} is not a recognized credential material shape`);
      return material;
    },

    async set(ref: Extract<CredentialRef, { kind: "keychain" }>, material: CredentialMaterial): Promise<void> {
      try {
        await backend().set({ service: ref.service ?? service, name: ref.account, value: JSON.stringify(material) });
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        throw new CredentialResolutionError("io", `keychain write failed for ${redactRef(ref)}`);
      }
    },

    async delete(ref: Extract<CredentialRef, { kind: "keychain" }>): Promise<void> {
      try {
        await backend().delete({ service: ref.service ?? service, name: ref.account });
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        throw new CredentialResolutionError("io", `keychain delete failed for ${redactRef(ref)}`);
      }
    },
  };
}

/** Reads ONE keychain item's stored string, uninterpreted. `null` when there is no such item. */
export type KeychainSecretReader = (ref: Extract<CredentialRef, { kind: "keychain" }>) => Promise<string | null>;

/**
 * The RAW half of this store, for a TOOL's secret rather than a provider's credential.
 *
 * WHY IT EXISTS, AND WHY HERE. `get` above insists the item is JSON `CredentialMaterial` and throws
 * `malformed` for anything else -- correct for a provider credential, which this SDK writes itself.
 * A tool's key is different: a host may store it as the BARE KEY STRING because another client of
 * the same keychain slot reads it that way, and that format is not this SDK's to change. So a reader
 * that returns the item uninterpreted has to exist, and it has to live in THIS file -- the only one
 * allowed to name the secrets backend (see the header, and the tripwire in the test beside it).
 *
 * It interprets NOTHING: `provider/tool-secret.ts` decides what the string means. It never logs and
 * never quotes the value; a backend failure is the same typed, ref-redacted `io` error `get` raises.
 * The ref's own `service` wins over the session's, exactly as in `get`.
 */
export function createKeychainSecretReader(service: string = DEFAULT_KEYCHAIN_SERVICE, opts: KeychainCredentialStoreOptions = {}): KeychainSecretReader {
  const backend = (): SecretsBackend => opts.secrets ?? defaultSecretsBackend();
  return async (ref) => {
    try {
      return await backend().get({ service: ref.service ?? service, name: ref.account });
    } catch (err) {
      if (err instanceof CredentialResolutionError) throw err;
      throw new CredentialResolutionError("io", `keychain lookup failed for ${redactRef(ref)}`);
    }
  };
}

/**
 * WS-25 (MCP OAuth): a RAW string store over ONE Keychain service -- `read`/`write`/`remove` of an
 * uninterpreted value under an account name. It is the default `McpOAuthStore` (`mcp-auth/store.ts`):
 * an MCP sign-in record is JSON this SDK writes and validates itself (`mcp-auth/records.ts`), not a
 * provider's `CredentialMaterial`, so neither `get` above (which insists on material) nor the reader
 * (read-only) fits. It lives HERE for the same reason the reader does: this is the one file allowed to
 * name the secrets backend.
 *
 * Every failure is the same typed, account-named `io` error the rest of this file raises; the value is
 * never quoted, and neither is the backend's own message (it can quote the item).
 *
 * SIZE (WS-25 spec §4.1, measured -- `mcp-auth/size-gate.test.ts`, opt-in): `Bun.secrets` round-trips a
 * 4 MiB value intact on macOS 26, so an item's size is not what splits a sign-in into two items (an
 * access + refresh token record is a few KiB at most). The 4096-byte limit Claude Code hit is the
 * `security -i` command line's, a tool Winter never drives.
 */
export interface KeychainRawStore {
  read(account: string): Promise<string | null>;
  write(account: string, value: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export function createKeychainRawStore(service: string = DEFAULT_KEYCHAIN_SERVICE, opts: KeychainCredentialStoreOptions = {}): KeychainRawStore {
  const backend = (): SecretsBackend => opts.secrets ?? defaultSecretsBackend();
  const failure = (what: string, account: string): CredentialResolutionError => new CredentialResolutionError("io", `keychain ${what} failed for account ${JSON.stringify(account)}`);
  return {
    async read(account) {
      try {
        return await backend().get({ service, name: account });
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        throw failure("lookup", account);
      }
    },
    async write(account, value) {
      try {
        await backend().set({ service, name: account, value });
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        throw failure("write", account);
      }
    },
    async remove(account) {
      try {
        await backend().delete({ service, name: account });
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        throw failure("delete", account);
      }
    },
  };
}

/** `account = "<providerId>:<accountId>"` (R6-10). One helper, so a caller never assembles the key by hand and drifts. */
export function keychainAccountName(providerId: string, accountId: string): string {
  return `${providerId}:${accountId}`;
}

/**
 * WS-25 §7: the SAME interpretation `get` applies to a Keychain item's string, for a value that arrived
 * another way (a host-brokered session receives the item's string from its host). Typed errors name the
 * ref, never the value.
 */
export function parseStoredCredentialMaterial(raw: string, ref: CredentialRef): CredentialMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialResolutionError("malformed", `the credential record for ${redactRef(ref)} is not valid JSON credential material`);
  }
  const material = coerceMaterial(parsed);
  if (material === undefined) throw new CredentialResolutionError("malformed", `the credential record for ${redactRef(ref)} is not a recognized credential material shape`);
  return material;
}

const MATERIAL_KINDS: ReadonlySet<string> = new Set(["api-key", "bearer", "oauth", "aws", "gcp-service-account", "gcp-access-token"]);

/**
 * Structural validation of a stored record.
 *
 * VALIDATED, never cast: a keychain record can be written by a previous version, by a host's own
 * tooling, or by hand, and a cast would let a malformed one surface as an incomprehensible failure
 * deep inside an adapter's auth header assembly. The check is on the DISCRIMINANT and the required
 * field of each arm -- never on the secret's own content.
 */
function coerceMaterial(value: unknown): CredentialMaterial | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== "string" || !MATERIAL_KINDS.has(v.kind)) return undefined;
  switch (v.kind) {
    case "api-key":
      return typeof v.key === "string" ? { kind: "api-key", key: v.key } : undefined;
    case "bearer":
      // P10a-4 (2026-09-13): `expiresAt` is OPTIONAL on `bearer` (added for the host-brokered
      // Anthropic Console material, refreshed on a timer ahead of it) -- read the same way `oauth`'s
      // own optional fields are below, or a real Keychain round-trip would silently drop it and the
      // renewal timer would never know when to fire again.
      return typeof v.token === "string" ? { kind: "bearer", token: v.token, ...(typeof v.expiresAt === "number" ? { expiresAt: v.expiresAt } : {}) } : undefined;
    case "oauth":
      return typeof v.accessToken === "string"
        ? {
            kind: "oauth",
            accessToken: v.accessToken,
            ...(typeof v.refreshToken === "string" ? { refreshToken: v.refreshToken } : {}),
            ...(typeof v.expiresAt === "number" ? { expiresAt: v.expiresAt } : {}),
            ...(typeof v.accountId === "string" ? { accountId: v.accountId } : {}),
            ...(typeof v.idToken === "string" ? { idToken: v.idToken } : {}),
          }
        : undefined;
    case "aws":
      return typeof v.accessKeyId === "string" && typeof v.secretAccessKey === "string"
        ? { kind: "aws", accessKeyId: v.accessKeyId, secretAccessKey: v.secretAccessKey, ...(typeof v.sessionToken === "string" ? { sessionToken: v.sessionToken } : {}) }
        : undefined;
    case "gcp-service-account":
      return typeof v.clientEmail === "string" && typeof v.privateKeyPem === "string" && typeof v.tokenUri === "string"
        ? { kind: "gcp-service-account", clientEmail: v.clientEmail, privateKeyPem: v.privateKeyPem, tokenUri: v.tokenUri }
        : undefined;
    case "gcp-access-token":
      return typeof v.token === "string" ? { kind: "gcp-access-token", token: v.token } : undefined;
    default:
      return undefined;
  }
}

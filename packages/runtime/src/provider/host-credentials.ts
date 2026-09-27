// WS-25 §7 (prompt-free credentials): a session whose HOST resolves its credentials.
//
// WHY. macOS asks for consent whenever a process reads a Keychain item ANOTHER binary created. A code
// session's `winter` child reading the daemon's items (its provider slot, an advisor pin, the Exa key,
// the Console bearer, an MCP sign-in) is exactly that, once per item per binary -- and on dev, once per
// rebuild. With `RuntimeConfig.hostCredentials` set, this session never touches the Keychain: every
// `{ kind: "keychain" }` read becomes a `credential_resolve` control request, answered by the host (the
// daemon, which created the items and reads them without a prompt) ONLY for refs this session's
// `Options` named.
//
// THE RULES THIS FILE KEEPS:
//   - NO KEYCHAIN, NO FALLBACK: a host that cannot answer is an error, never a quiet Keychain read (the
//     read that would prompt is the whole thing being removed).
//   - NO WRITES: `set`/`delete` refuse typed. Renewal is the HOST's (it holds every refresh token and
//     posts every grant, single-flight), so this session never persists anything -- the two-refresher
//     race and dev's partition-list poisoning end here too. `refresh(ref)` asks the host for material
//     NEWER than the generation last seen (`minGeneration`), which is what `refreshOauthMaterial` uses
//     instead of posting a grant (provider-runtime `CredentialStore.refresh`).
//   - NO REFRESH TOKEN held: the host strips them; an `oauth` material that arrives with one anyway is
//     stripped here too, so no code path in this process can post a grant with it.
//   - THE MATERIAL STAYS IN THE FRAME: it arrives in the control_response and is returned to the caller;
//     it is never logged, never put in an error (errors name the ref and a reason code), never cached
//     beyond the generation number.
import { CREDENTIAL_RESOLVE_SUBTYPE, type CredentialRef, type CredentialResolveAnswer, type CredentialResolveRequest } from "@yanlinglabs/winter-agent-sdk";
import { CredentialResolutionError, redactRef, type CredentialMaterial, type CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { parseStoredCredentialMaterial, type KeychainSecretReader } from "./keychain-store.ts";

type KeychainRef = Extract<CredentialRef, { kind: "keychain" }>;

/** The narrow bridge shape this needs (the runtime's `RpcBridge` satisfies it). */
export interface HostRequestSender {
  request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

/**
 * The session's line to its host, BOUND LATE: production wiring builds the credential stores before the
 * engine exists, and the engine's control bridge is created inside `runEngine`, which binds it here
 * first thing. A request made before the bind waits for it (bounded).
 */
export interface HostCredentialChannel extends HostRequestSender {
  bind(sender: HostRequestSender): void;
}

/** How long one `credential_resolve` may take (the host may be refreshing). */
export const HOST_CREDENTIAL_TIMEOUT_MS = 60_000;
/** How long a request waits for the engine to bind the channel before failing typed. */
export const HOST_CREDENTIAL_BIND_TIMEOUT_MS = 30_000;

export function createHostCredentialChannel(opts: { bindTimeoutMs?: number } = {}): HostCredentialChannel {
  let sender: HostRequestSender | undefined;
  const waiters: Array<(s: HostRequestSender) => void> = [];
  const bound = (): Promise<HostRequestSender> => {
    if (sender !== undefined) return Promise.resolve(sender);
    return new Promise<HostRequestSender>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CredentialResolutionError("io", "the host credential channel was never bound to the session's control bridge")), opts.bindTimeoutMs ?? HOST_CREDENTIAL_BIND_TIMEOUT_MS);
      timer.unref?.();
      waiters.push((s) => {
        clearTimeout(timer);
        resolve(s);
      });
    });
  };
  return {
    bind(next) {
      sender = next;
      for (const wake of waiters.splice(0)) wake(next);
    },
    async request<T>(subtype: string, payload: unknown, requestOpts?: { timeoutMs?: number }): Promise<T> {
      return (await bound()).request<T>(subtype, payload, requestOpts);
    },
  };
}

export interface HostResolved {
  material: string;
  generation: number;
  expiresAt?: number;
}

function isAnswer(value: unknown): value is CredentialResolveAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { ok?: unknown; material?: unknown; generation?: unknown; reason?: unknown };
  if (v.ok === true) return typeof v.material === "string" && typeof v.generation === "number";
  return v.ok === false && typeof v.reason === "string";
}

/**
 * ONE `credential_resolve` round trip. `null` for `not_found` (the session behaves as with an empty
 * Keychain); every other failure throws a typed, ref-named error -- never the material, never the host's
 * own error text.
 */
export async function resolveFromHost(sender: HostRequestSender, ref: KeychainRef, minGeneration?: number): Promise<HostResolved | null> {
  const request: CredentialResolveRequest = { ref: { kind: "keychain", account: ref.account, ...(ref.service !== undefined ? { service: ref.service } : {}) }, ...(minGeneration !== undefined ? { minGeneration } : {}) };
  let answer: unknown;
  try {
    answer = await sender.request(CREDENTIAL_RESOLVE_SUBTYPE, request, { timeoutMs: HOST_CREDENTIAL_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof CredentialResolutionError) throw err;
    throw new CredentialResolutionError("io", `the host did not resolve ${redactRef(ref)} (${err instanceof Error ? err.name : "error"})`);
  }
  if (!isAnswer(answer)) throw new CredentialResolutionError("io", `the host answered ${redactRef(ref)} with a malformed credential_resolve answer`);
  if (!answer.ok) {
    if (answer.reason === "not_found") return null;
    throw new CredentialResolutionError("io", `the host refused ${redactRef(ref)}: ${answer.reason}`);
  }
  return { material: answer.material, generation: answer.generation, ...(answer.expiresAt !== undefined ? { expiresAt: answer.expiresAt } : {}) };
}

function withoutRefreshToken(material: CredentialMaterial): CredentialMaterial {
  if (material.kind !== "oauth" || material.refreshToken === undefined) return material;
  const { refreshToken: _dropped, ...rest } = material;
  return rest;
}

/**
 * The Keychain MEMBER of a host-brokered session's credential store. Serves `keychain` refs only (every
 * other kind is `unsupported`, so the composite asks the env/file/inline members as before).
 */
export function createHostBrokeredCredentialStore(sender: HostRequestSender): CredentialStore & { refresh(ref: KeychainRef): Promise<CredentialMaterial> } {
  const generations = new Map<string, number>();
  const key = (ref: KeychainRef): string => `${ref.service ?? ""}\u0000${ref.account}`;
  const noWrites = (ref: KeychainRef): CredentialResolutionError => new CredentialResolutionError("unsupported", `a host-brokered session never persists credentials (${redactRef(ref)}); its host renews them`);
  return {
    async get(ref) {
      if (ref.kind !== "keychain") throw new CredentialResolutionError("unsupported", `the host-brokered credential store does not serve ${ref.kind} refs`);
      const resolved = await resolveFromHost(sender, ref);
      if (resolved === null) return null;
      generations.set(key(ref), resolved.generation);
      return withoutRefreshToken(parseStoredCredentialMaterial(resolved.material, ref));
    },
    async set(ref) {
      throw noWrites(ref);
    },
    async delete(ref) {
      throw noWrites(ref);
    },
    async refresh(ref) {
      const minGeneration = (generations.get(key(ref)) ?? 0) + 1;
      const resolved = await resolveFromHost(sender, ref, minGeneration);
      if (resolved === null) throw new CredentialResolutionError("io", `the host holds no credential for ${redactRef(ref)} any more; sign in again`);
      generations.set(key(ref), resolved.generation);
      return withoutRefreshToken(parseStoredCredentialMaterial(resolved.material, ref));
    },
  };
}

/** A host-brokered session's RAW tool-secret reader (the Exa key and friends): the item's string, uninterpreted. */
export function createHostBrokeredSecretReader(sender: HostRequestSender): KeychainSecretReader {
  return async (ref) => (await resolveFromHost(sender, ref))?.material ?? null;
}

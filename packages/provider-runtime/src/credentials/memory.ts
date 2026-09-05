// An in-memory credential store. FROZEN as of P6 T2's merge (R6-12, `credentials/**`).
//
// Handles `keychain` (in memory — the REAL Keychain-backed store is a runtime-side deliverable,
// `provider/keychain-store.ts`, and lives there precisely so nothing in this package can reach
// `Bun.secrets` and touch the user's login Keychain from a test run), `inline`, and `none`.

import type { CredentialMaterial, CredentialRef, CredentialStore } from "../types.ts";
import { isNoCredential, unsupported } from "./types.ts";

const NAME = "memory credential store";

/** The composite key one Keychain record occupies: service + account (R6-10: one record per provider/account, never a shared global slot). */
function recordKey(ref: Extract<CredentialRef, { kind: "keychain" }>): string {
  return `${ref.service ?? ""} ${ref.account}`;
}

export interface MemoryCredentialStore extends CredentialStore {
  /** Test/diagnostic seam: how many records are held. Never exposes material. */
  size(): number;
}

export function createMemoryCredentialStore(
  seed?: Iterable<readonly [Extract<CredentialRef, { kind: "keychain" }>, CredentialMaterial]>,
): MemoryCredentialStore {
  const records = new Map<string, CredentialMaterial>();
  for (const [ref, material] of seed ?? []) records.set(recordKey(ref), material);

  return {
    async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
      if (isNoCredential(ref)) return null;
      if (ref.kind === "keychain") return records.get(recordKey(ref)) ?? null;
      // An inline value is resolved but NEVER stored: R6-10 makes it a host responsibility, and a
      // store that quietly retained it would turn "the host holds this" into "the SDK holds this".
      if (ref.kind === "inline") return ref.value.length > 0 ? { kind: "api-key", key: ref.value } : null;
      throw unsupported(NAME, ref);
    },
    async set(ref, material): Promise<void> {
      records.set(recordKey(ref), material);
    },
    async delete(ref): Promise<void> {
      records.delete(recordKey(ref));
    },
    size(): number {
      return records.size;
    },
  };
}

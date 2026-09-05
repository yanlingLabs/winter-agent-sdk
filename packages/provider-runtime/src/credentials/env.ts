// An environment-variable credential store. FROZEN as of P6 T2's merge (R6-12, `credentials/**`).
//
// R6-10's hard rule, implemented rather than merely documented: **ambient env keys are NEVER
// scanned implicitly.** The environment is INJECTED (never read from `process.env` inside this
// module), and the only reachable variable is the one a `{ kind: "env", name }` ref NAMES. Nothing
// here enumerates, pattern-matches, or falls back to a conventional variable — an
// `ANTHROPIC_API_KEY` sitting in the environment does not become a credential by existing.
//
// Injection is also what keeps the tests honest: a store built over `{}` cannot see the process's
// real environment, which the test suite asserts directly.

import type { CredentialMaterial, CredentialRef, CredentialStore } from "../types.ts";
import { isNoCredential, readOnlyWriteRefusal, unsupported } from "./types.ts";

const NAME = "env credential store";

export interface EnvCredentialStoreOptions {
  /** The environment this store may read. A host passes `process.env` explicitly at the composition root if that is what it wants — never here. */
  env: Record<string, string | undefined>;
}

export function createEnvCredentialStore(opts: EnvCredentialStoreOptions): CredentialStore {
  return {
    async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
      if (isNoCredential(ref)) return null;
      if (ref.kind !== "env") throw unsupported(NAME, ref);
      const raw = opts.env[ref.name];
      // A whitespace-only value is MISSING, not a credential: an exported-but-empty variable is the
      // single most common way a key "is set" and is not there, and forwarding it produces an opaque
      // provider 401 instead of the actionable "no credential configured".
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value.length === 0) return null;
      return { kind: "api-key", key: value };
    },
    async set(): Promise<void> {
      throw readOnlyWriteRefusal(NAME);
    },
    async delete(): Promise<void> {
      throw readOnlyWriteRefusal(NAME);
    },
  };
}

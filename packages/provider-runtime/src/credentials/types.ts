// Shared credential-store machinery: the typed error, the redaction helpers every store and every
// adapter must render material through, and the composite that chains stores.
//
// FROZEN as of P6 T2's merge (R6-12, `credentials/**`).
//
// The contract every store in this directory obeys, stated once:
//
//   get(ref) resolves to MATERIAL when it has it, `null` when it HANDLES that ref kind and has
//   nothing, and REJECTS with a `CredentialResolutionError { code: "unsupported" }` when it does
//   not handle the kind at all.
//
// That three-way answer is the whole design. A store that returned `null` for "I don't do env vars"
// would make a chain unable to tell "no credential is configured" (a user-fixable, reportable state)
// from "nobody in this chain can even look" (a wiring bug) — and the composite below would then
// silently swallow the second as the first.

import type { CredentialMaterial, CredentialRef, CredentialStore } from "../types.ts";

export type CredentialResolutionCode = "unsupported" | "malformed" | "io";

/**
 * A typed credential failure. **Its message never contains credential material** — construct it from
 * a locator (`redactRef`) and a reason, never from a file's contents or a parsed value. The stores
 * in this directory are tested for exactly that (`credentials.test.ts` asserts a malformed-file
 * error's message does not contain the file's secret).
 */
export class CredentialResolutionError extends Error {
  readonly code: CredentialResolutionCode;
  constructor(code: CredentialResolutionCode, message: string) {
    super(message);
    this.name = "CredentialResolutionError";
    this.code = code;
  }
}

/**
 * Renders material for a log line or an error message: the KIND, and `***` where the material was.
 * The one sanctioned way to put a `CredentialMaterial` into a string anywhere in Winter.
 */
export function redactMaterial(material: CredentialMaterial): string {
  switch (material.kind) {
    case "oauth":
      // `accountId` is a non-secret locator and is genuinely useful in a log; the three tokens are not.
      return material.accountId === undefined ? "***(oauth)" : `***(oauth, account ${material.accountId})`;
    case "gcp-service-account":
      // The client email identifies WHICH service account without exposing the key that signs as it.
      return `***(gcp-service-account, ${material.clientEmail})`;
    default:
      return `***(${material.kind})`;
  }
}

/**
 * Renders a reference for a log line or an error message. A ref is a LOCATOR, so its addressing
 * fields (variable name, keychain account/service, file path) are kept — they are what makes a
 * "credential not found" message actionable. `inline` is the one arm that carries material, and its
 * value is replaced.
 */
export function redactRef(ref: CredentialRef): string {
  switch (ref.kind) {
    case "keychain":
      return `keychain:${ref.service ?? "<default service>"}/${ref.account}`;
    case "env":
      return `env:${ref.name}`;
    case "file":
      return `file:${ref.path} (${ref.format}${ref.profile === undefined ? "" : `, profile ${ref.profile}`})`;
    case "inline":
      return "inline:***";
    case "aws-default-chain":
      return "aws-default-chain";
    case "none":
      return "none";
  }
}

/** Every store answers `none` identically: null, meaning "send no credential". Shared so no store can drift on it. */
export function isNoCredential(ref: CredentialRef): boolean {
  return ref.kind === "none";
}

export function unsupported(storeName: string, ref: CredentialRef): CredentialResolutionError {
  return new CredentialResolutionError("unsupported", `${storeName}: cannot resolve a credential reference of kind "${ref.kind}" (${redactRef(ref)})`);
}

/** A store that cannot write: `set`/`delete` are Keychain-only, and only a Keychain-backed store implements them. */
export function readOnlyWriteRefusal(storeName: string): CredentialResolutionError {
  return new CredentialResolutionError("unsupported", `${storeName}: does not persist credentials — only a Keychain-backed store does (R6-10)`);
}

/**
 * Chains stores: the first one that HANDLES the ref kind answers, whether it found material or not.
 *
 * The subtlety worth stating (and tested): a handled-but-empty `null` STOPS the chain. Falling
 * through on null would mean a configured-but-empty env var silently resolved out of some later
 * store — a credential arriving from a source the host never named, which is exactly what R6-10's
 * "ambient keys are NEVER scanned implicitly" forbids.
 */
export function createCompositeCredentialStore(stores: readonly CredentialStore[]): CredentialStore {
  return {
    async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
      let lastUnsupported: CredentialResolutionError | undefined;
      for (const store of stores) {
        try {
          return await store.get(ref);
        } catch (err) {
          if (err instanceof CredentialResolutionError && err.code === "unsupported") {
            lastUnsupported = err;
            continue;
          }
          throw err;
        }
      }
      throw lastUnsupported ?? unsupported("composite credential store (no stores configured)", ref);
    },
    async set(ref, material): Promise<void> {
      let lastUnsupported: CredentialResolutionError | undefined;
      for (const store of stores) {
        try {
          await store.set(ref, material);
          return;
        } catch (err) {
          if (err instanceof CredentialResolutionError && err.code === "unsupported") {
            lastUnsupported = err;
            continue;
          }
          throw err;
        }
      }
      throw lastUnsupported ?? readOnlyWriteRefusal("composite credential store (no stores configured)");
    },
    async delete(ref): Promise<void> {
      let lastUnsupported: CredentialResolutionError | undefined;
      for (const store of stores) {
        try {
          await store.delete(ref);
          return;
        } catch (err) {
          if (err instanceof CredentialResolutionError && err.code === "unsupported") {
            lastUnsupported = err;
            continue;
          }
          throw err;
        }
      }
      throw lastUnsupported ?? readOnlyWriteRefusal("composite credential store (no stores configured)");
    },
  };
}

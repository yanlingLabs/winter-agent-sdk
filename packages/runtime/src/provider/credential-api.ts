// Phase 6 Task 8 (Lane D, R6-10): the credential HOST doors.
//
// Three functions, and they exist because a host application — Norma's settings pane, a CLI `login`
// command — needs to put a credential somewhere, take it away again, and ask whether it works, and
// none of those are things the agent loop does. T10 re-exports them through the sdk barrel; this is
// their implementation and their only home.
//
// WHAT THIS FILE ADDS OVER CALLING THE STORE DIRECTLY, since `CredentialStore.set` is right there:
//
//   1. THE ACCOUNT SPELLING. R6-10 fixes it at `"<providerId>:<accountId>"`, and a host that
//      assembles that string by hand will eventually assemble it differently from the store that
//      reads it — a credential written to a key nothing looks up, failing as "no credential
//      configured" with the record sitting right there. `keychainAccountName` is the one spelling;
//      this door is the one caller.
//   2. THE VALIDATION. A provider id containing `:` makes the composite key ambiguous, and an empty
//      secret produces an opaque provider 401 later instead of an actionable refusal now.
//   3. THE REDACTION. Every throw out of these doors is built from a LOCATOR and a reason, never
//      from the material and never from the underlying store's own message.
//
// ON NOT REPRODUCING THE UNDERLYING MESSAGE: `keychain-store.ts` established the rule for its own
// errors ("the underlying error message is not reproduced at all") because a keychain error can quote
// the item it failed on. The same reasoning applies harder here, because the `store` these doors
// receive may be a HOST's own implementation, whose message discipline this repository cannot audit.
// A `cause` is likewise not attached: a cause chain is part of the error a host prints. What survives
// is the redacted ref, the operation, and the typed code — which is what makes the failure
// actionable in the first place.
import type { CredentialMaterial, CredentialStatus, CredentialStore, ProviderContext, ProviderRegistry } from "@yanlinglabs/winter-provider-runtime";
import { CredentialResolutionError, WinterProviderResolutionError } from "@yanlinglabs/winter-provider-runtime";
import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import { keychainAccountName } from "./keychain-store.ts";
import { redactCredentialRef } from "./selection.ts";

/** The one keychain-ref shape these doors deal in. `set`/`delete` are Keychain-only by TYPE on `CredentialStore`, so this is not a narrowing choice — it is the only representable one. */
export type ProviderCredentialRef = Extract<CredentialRef, { kind: "keychain" }>;

export interface ProviderCredentialLocator {
  providerId: string;
  /** WHICH account on that provider. R6-10: one record per provider/account, never a shared global slot — two accounts on one provider, or two providers at once, need two records. */
  accountId: string;
  /** Overrides the store's configured service. Omitted means the store's own default (`config.keychainService ?? "com.winter.core"`). */
  service?: string;
}

export interface StoreProviderCredentialInput extends ProviderCredentialLocator {
  material: CredentialMaterial;
}

/**
 * The ref one provider/account occupies.
 *
 * EXPORTED because a host that stored a credential needs to name it again in
 * `config.provider.authRef`, and deriving that string a second time by hand is the drift this
 * function exists to prevent.
 */
export function providerCredentialRef(locator: ProviderCredentialLocator): ProviderCredentialRef {
  assertLocator(locator);
  return { kind: "keychain", account: keychainAccountName(locator.providerId, locator.accountId), ...(locator.service !== undefined ? { service: locator.service } : {}) };
}

/**
 * Writes one provider credential, and answers with the ref that now addresses it.
 *
 * Returning the ref rather than `void` is the point of the door: the host's very next act is to put
 * that ref in a session config, and handing it back is what stops it being retyped.
 */
export async function storeProviderCredential(store: CredentialStore, input: StoreProviderCredentialInput): Promise<ProviderCredentialRef> {
  const ref = providerCredentialRef(input);
  assertMaterial(input.material, ref);
  try {
    await store.set(ref, input.material);
  } catch (err) {
    throw redactedFailure("store", ref, err);
  }
  return ref;
}

/**
 * Removes one provider credential.
 *
 * IDEMPOTENT by delegation: the store's own `delete` decides what removing an absent record means,
 * and neither of the shipped stores treats it as an error. This door does not probe first — a `get`
 * before a `delete` would read the secret into memory for no reason other than to answer a question
 * the caller did not ask.
 */
export async function deleteProviderCredential(store: CredentialStore, locator: ProviderCredentialLocator): Promise<ProviderCredentialRef> {
  const ref = providerCredentialRef(locator);
  try {
    await store.delete(ref);
  } catch (err) {
    throw redactedFailure("delete", ref, err);
  }
  return ref;
}

/**
 * Asks the provider's own adapter whether a credential reference works.
 *
 * ROUTED THROUGH THE REGISTRY because the answer is the ADAPTER's: only it knows which endpoint
 * proves a key, what an expiry looks like for its auth kind, and which ref kinds it can check at all.
 * The registry is how a provider id becomes that adapter, and it has no adapter-by-provider door of
 * its own — so this resolves the provider's first catalog row and takes the adapter off it. A
 * provider with no rows is answered, not thrown: "this provider has nothing to check with" is a
 * legitimate state a host must be able to render.
 *
 * NEVER THROWS. A host door that reports status by return value for four outcomes and by exception
 * for the fifth is a door every caller wraps in a try. Every failure is a `{ ok: false }` row.
 */
export async function validateProviderCredential(registry: ProviderRegistry, ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
  const providerId = ctx.connection.providerId;
  if (ref.kind === "none") {
    // Answered HERE rather than delegated: `none` means "send no credential" by definition
    // (`isNoCredential`), so there is nothing for an adapter to check, and an adapter that failed to
    // special-case it would produce an unauthenticated live request just to be told so.
    return { ok: false, code: "missing", message: `no credential reference is configured for provider "${providerId}"` };
  }

  const rows = registry.listModelInfo(providerId);
  if (rows.length === 0) {
    return { ok: false, code: "unsupported", message: `provider "${providerId}" has no models in this build's catalog, so no adapter can be reached to check ${redactCredentialRef(ref)}` };
  }

  let lastError: WinterProviderResolutionError | undefined;
  for (const row of rows) {
    // `provider: { providerId }` is required, not cosmetic: an alias row's `value` is a bare alias,
    // which resolves only inside a named provider's namespace (registry.ts's own step 1).
    const resolved = registry.resolve({ model: row.value, provider: { providerId } });
    if (resolved instanceof WinterProviderResolutionError) {
      lastError = resolved;
      continue;
    }
    try {
      return await resolved.adapter.validateCredential(ref, ctx);
    } catch (err) {
      return statusFromThrow(err, ref, providerId);
    }
  }
  return {
    ok: false,
    code: "unsupported",
    message: `no model of provider "${providerId}" resolves in this build (${lastError?.code ?? "unknown"}), so no adapter can check ${redactCredentialRef(ref)}`,
  };
}

// -------------------------------------------------------------------------------------------------
// internals
// -------------------------------------------------------------------------------------------------
/**
 * Control characters, which must not reach a keychain account name or a log line built from one.
 *
 * Written as explicit escapes rather than as literal bytes: a source file carrying a raw NUL is a
 * binary file to every tool that reads it, and a hyphen inside a character class is the range
 * operator -- which would have rejected every hyphenated Winter provider id (`codex-oauth`,
 * `azure-openai`, `ollama-local`).
 */
const FORBIDDEN = /[\u0000-\u001f\u007f]/;

function assertLocator(locator: ProviderCredentialLocator): void {
  const { providerId, accountId, service } = locator;
  if (typeof providerId !== "string" || providerId.trim().length === 0) throw new CredentialResolutionError("malformed", "a provider credential needs a non-empty providerId");
  if (typeof accountId !== "string" || accountId.trim().length === 0) throw new CredentialResolutionError("malformed", `a provider credential for "${providerId}" needs a non-empty accountId`);
  // Only the PROVIDER id must be colon-free. The composite key is read left-to-right at its FIRST
  // colon, so an accountId containing one stays unambiguous — and account ids are frequently
  // e-mail-shaped or URL-shaped, so forbidding it there would refuse legitimate accounts.
  if (providerId.includes(":")) {
    throw new CredentialResolutionError("malformed", `providerId "${providerId}" contains ":", which is the separator in the "<providerId>:<accountId>" keychain account name (R6-10) and would make the record ambiguous`);
  }
  if (FORBIDDEN.test(providerId) || FORBIDDEN.test(accountId) || (service !== undefined && FORBIDDEN.test(service))) {
    throw new CredentialResolutionError("malformed", `a provider credential locator may not contain control characters (provider "${providerId}")`);
  }
  if (service !== undefined && service.trim().length === 0) throw new CredentialResolutionError("malformed", `an explicit keychain service for provider "${providerId}" may not be blank; omit it to use the store's default`);
}

/**
 * Rejects material whose own secret is empty.
 *
 * The failure this prevents is specific and common: an unset environment variable read into a
 * "login" flow stores `""`, every later request sends an empty header, and the provider answers 401.
 * The credential then LOOKS configured everywhere a host displays it. The env credential store makes
 * the same call for the same reason ("an exported-but-empty variable is the single most common way a
 * key 'is set' and is not there"); this is that rule at the write door.
 *
 * The message names the FIELD, never the value.
 */
function assertMaterial(material: CredentialMaterial, ref: ProviderCredentialRef): void {
  const empty = (value: string | undefined): boolean => value === undefined || value.trim().length === 0;
  const bad = (field: string): never => {
    throw new CredentialResolutionError("malformed", `the ${material.kind} credential for ${redactCredentialRef(ref)} has an empty "${field}"; an empty secret is stored happily and then fails as an opaque provider rejection on every request`);
  };
  switch (material.kind) {
    case "api-key":
      if (empty(material.key)) bad("key");
      return;
    case "bearer":
      if (empty(material.token)) bad("token");
      return;
    case "oauth":
      if (empty(material.accessToken)) bad("accessToken");
      return;
    case "aws":
      if (empty(material.accessKeyId)) bad("accessKeyId");
      if (empty(material.secretAccessKey)) bad("secretAccessKey");
      return;
    case "gcp-service-account":
      if (empty(material.clientEmail)) bad("clientEmail");
      if (empty(material.privateKeyPem)) bad("privateKeyPem");
      if (empty(material.tokenUri)) bad("tokenUri");
      return;
    case "gcp-access-token":
      if (empty(material.token)) bad("token");
      return;
  }
}

/**
 * A store failure, rendered from the locator alone.
 *
 * The underlying error contributes its CLASS and, for a typed credential error, its code — never its
 * message, and never as a `cause`. See this file's header for why.
 */
function redactedFailure(operation: "store" | "delete", ref: ProviderCredentialRef, err: unknown): CredentialResolutionError {
  const code = err instanceof CredentialResolutionError ? err.code : "io";
  const kind = err instanceof Error ? err.name : typeof err;
  return new CredentialResolutionError(code, `could not ${operation} the credential for ${redactCredentialRef(ref)}: the store failed with a ${kind} (its message is withheld because a store's error text may quote the record)`);
}

/**
 * An adapter that THREW rather than answering.
 *
 * A typed credential failure maps onto the vocabulary it already implies. Anything else is reported
 * as `unsupported` — which reads as "this check did not happen", the only honest thing to say. It is
 * deliberately NOT `invalid`: an adapter bug is not evidence that the user's key is bad, and telling
 * a user to re-enter a working credential is a worse outcome than telling them the check failed.
 */
function statusFromThrow(err: unknown, ref: CredentialRef, providerId: string): CredentialStatus {
  const locator = redactCredentialRef(ref);
  if (err instanceof CredentialResolutionError) {
    if (err.code === "malformed") return { ok: false, code: "invalid", message: `the credential at ${locator} is not valid material for provider "${providerId}"` };
    if (err.code === "io") return { ok: false, code: "network", message: `the credential at ${locator} could not be read while validating provider "${providerId}"` };
    return { ok: false, code: "unsupported", message: `provider "${providerId}"'s adapter cannot resolve a credential reference of kind "${ref.kind}"` };
  }
  const kind = err instanceof Error ? err.name : typeof err;
  return { ok: false, code: "unsupported", message: `provider "${providerId}"'s adapter failed with a ${kind} while validating ${locator}, so the credential is UNVERIFIED rather than known-bad (the underlying message is withheld)` };
}

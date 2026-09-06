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
import { CredentialResolutionError, WinterProviderResolutionError, startAnthropicConsoleLogin, startCodexLogin, startXaiLogin } from "@yanlinglabs/winter-provider-runtime";
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
 * its own — so this reaches one through a model resolution, in two steps.
 *
 * THE SECOND STEP IS NOT A NICETY. A provider's catalog ROWS are the natural route, but ten of the
 * twenty-one seed providers have none: every local one (lm-studio, vllm, llama-cpp, llamafile, the
 * mlx pair, oobabooga, triton, xinference, docker-model-runner, lemonade) ships as a provider whose
 * models exist only on the user's own machine. Stopping at "no rows" would make this door useless
 * for exactly the providers a host is most likely to be helping someone configure. So a provider with
 * no usable row falls through to `allowUnlisted` — registry.ts's own step 2, which answers with the
 * adapter and `descriptor: undefined` for any provider whose live catalog is not authoritative, and
 * with a typed refusal for one where it is (there, an absent id is a FACT and there is nothing
 * honest to probe with). `validateCredential` never sees a model id, so the probe string below is
 * inert — it is a key into the registry, not something that reaches a wire.
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
  if (!registry.list().providers.some((p) => p.id === providerId)) {
    // Checked BEFORE either resolution path, so an unknown provider gets its own message rather than
    // the resolution failure of a probe against a provider that does not exist.
    return { ok: false, code: "unsupported", message: `no provider "${providerId}" exists in this build's catalog, so no adapter can check ${redactCredentialRef(ref)}` };
  }

  let lastError: WinterProviderResolutionError | undefined;
  // (1) A real catalog row, which is also the only path that gives the adapter a descriptor.
  //     `provider: { providerId }` is required, not cosmetic: an alias row's `value` is a bare alias,
  //     which resolves only inside a named provider's namespace (registry.ts's own step 1).
  for (const row of registry.listModelInfo(providerId)) {
    const resolved = registry.resolve({ model: row.value, provider: { providerId } });
    if (resolved instanceof WinterProviderResolutionError) {
      lastError = resolved;
      continue;
    }
    return askAdapter(resolved.adapter, ref, ctx, providerId);
  }

  // (2) No usable row. See the header: this is the local-provider case, not an edge.
  const unlisted = registry.resolve({ model: CREDENTIAL_PROBE_MODEL, provider: { providerId, allowUnlisted: true } });
  if (!(unlisted instanceof WinterProviderResolutionError)) return askAdapter(unlisted.adapter, ref, ctx, providerId);

  return {
    ok: false,
    code: "unsupported",
    message: `no model of provider "${providerId}" resolves in this build (${lastError?.code ?? unlisted.code}), so no adapter can check ${redactCredentialRef(ref)}`,
  };
}

/**
 * The id the `allowUnlisted` fallback resolves with.
 *
 * INERT by construction: `ProviderAdapter.validateCredential(ref, ctx)` takes no model, so this
 * string never reaches a request. It is named rather than arbitrary so that if it ever DOES surface
 * — in a log, in an error — a reader can tell at a glance that nothing asked for a model called this.
 */
const CREDENTIAL_PROBE_MODEL = "winter-credential-probe";

async function askAdapter(adapter: { validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> }, ref: CredentialRef, ctx: ProviderContext, providerId: string): Promise<CredentialStatus> {
  try {
    return await adapter.validateCredential(ref, ctx);
  } catch (err) {
    return statusFromThrow(err, ref, providerId);
  }
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

// -------------------------------------------------------------------------------------------------
// WS-13b (P6.5): the OAuth login door
// -------------------------------------------------------------------------------------------------

/**
 * The providers whose credential is obtained by a LOGIN rather than by pasting a key.
 *
 * DECLARED IN FULL NOW, ahead of two of its four flows. A host offering sign-in should compile
 * against one door rather than discover a second one when the next flow lands, and a case that
 * throws a typed refusal is a much better thing to ship than a member missing from the union — which
 * fails at a caller's call site as an unassignable literal and tells them nothing about why.
 * `xai-oauth` and `qoder` are wired by their own lane; this file's switch is where they land.
 */
export type ProviderLoginId = "anthropic" | "codex-oauth" | "xai-oauth" | "qoder";

export interface StartProviderLoginOptions {
  /**
   * Opens the browser. HOST-supplied: the SDK never shells out to one, and a login is a host action.
   *
   * **A DEVICE-CODE FLOW NEVER CALLS THIS.** That is the whole point of RFC 8628 — the device has no
   * browser to open, so there is no URL to hand one. Its verification URL and its user code reach the
   * host through `onAuthStatus.output` instead, and a host that renders a device login by waiting for
   * `openUrl` will wait forever while the two strings the user actually needs go past on the other
   * channel. Required rather than optional only because the two flows that exist today are both
   * loopback ones; a device flow may be handed a function that is never invoked.
   */
  openUrl: (url: string) => Promise<void>;
  /** Overridden by a fixture; production uses each flow's own derived constants. */
  authorizeUrl?: string;
  tokenUrl?: string;
  /** Anthropic Console only: where the account id is read from. Ignored by flows that do not need one. */
  profileUrl?: string;
  /**
   * Device-code flows only (RFC 8628): where the device authorization request is posted.
   *
   * Present ahead of its flows for the same reason `ProviderLoginId` carries all four members — and
   * for one more that is not cosmetic. Without a fixture endpoint here, a test driving a device login
   * THROUGH THIS DOOR has nowhere to point it and would reach the vendor live, which the phase's
   * hermeticity rule forbids outright. An option that only appears alongside its implementation is an
   * option whose first test cannot be written.
   */
  deviceCodeUrl?: string;
  /** Device-code flows only: the poll interval FLOOR in ms. The vendor's own `interval` wins when larger. */
  pollIntervalMs?: number;
  callbackPort?: number;
  timeoutMs?: number;
  /** The Keychain service the record lands in — `config.keychainService` from the host. */
  service?: string;
  /** A login-flow PROGRESS channel (R6-F). Never carries credential material. */
  onAuthStatus?: (status: { isAuthenticating: boolean; output?: string[]; error?: string }) => void;
}

export interface ProviderLoginResult {
  /** The record the credential now occupies — the very thing a host puts in `config.provider.authRef`. */
  ref: ProviderCredentialRef;
  accountId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * Runs one provider's login and PERSISTS the result, answering with the ref that now addresses it.
 *
 * ONE DOOR, for the same reason `storeProviderCredential` is one: every flow writes a record whose
 * name is `"<providerId>:<accountId>"` (R6-10), and a host that reaches each flow's own function
 * directly is a host that will eventually spell that name differently from whatever reads it back.
 * Routing through here means the login and the lookup agree by construction.
 *
 * WHAT THIS DOES NOT DO: choose a provider, open a browser itself, or decide that a failed login
 * should be retried. Each is a host's decision, and the SDK taking any of them would be a library
 * driving a user interface.
 */
export async function startProviderLogin(providerId: ProviderLoginId, store: CredentialStore, options: StartProviderLoginOptions): Promise<ProviderLoginResult> {
  switch (providerId) {
    case "anthropic":
      return await startAnthropicConsoleLogin(store, options);
    case "codex-oauth":
      return await startCodexLogin(store, options);
    case "xai-oauth":
      // The RFC 8628 device grant, and the one arm here that never touches `options.openUrl` —
      // there is no browser leg to open. The verification URL and the user code reach the host on
      // `onAuthStatus.output` instead (see `openUrl`'s own note above).
      return await startXaiLogin(store, options);
    case "qoder":
      // TYPED, and raised BEFORE anything runs: a refusal that had already opened a browser or
      // half-completed a flow would be worse than one that never started. `unsupported` is the
      // honest code — the flow is not wired in this build, which is not the same as the user's
      // credential being bad.
      //
      // For `qoder` this is the END STATE, not a stub waiting on a lane. Lane O's capture
      // (`packages/conformance/compat/qoder/derived-shapes-p6b-qoder.md`) established against
      // Qoder's own complete documentation index that it publishes no third-party OAuth grant —
      // the only OAuth it documents is Qoder acting as a client toward MCP servers — and no
      // third-party inference endpoint either. Its documented programmatic route is a Personal
      // Access Token, and its documented agent route is its own Agent SDK / Cloud Agents, which is
      // the agent-transport class WS-13 §8.2 excludes. There is nothing here to sign in to.
      throw new CredentialResolutionError("unsupported", `the "${providerId}" login is not wired in this build, so there is nothing to sign in to; no browser was opened and no record was written`);
  }
}

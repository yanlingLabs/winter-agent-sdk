// A TOOL's secret -- an API key for something that is not a model provider (the web search
// backend's key is the first) -- resolved from an ARBITRARY `CredentialRef`.
//
// WHY THIS IS NOT `CredentialStore.get`. Three differences, each of which the store is right to
// refuse for a PROVIDER credential and wrong for a tool's:
//
//   1. NOT PROVIDER-KEYED. A provider credential lives at `<providerId>:default` and is found through
//      the catalog. A tool's key lives wherever the host says -- the ref IS the whole address.
//   2. A RAW STRING IS VALID. The keychain store insists on JSON `CredentialMaterial` and throws
//      `malformed` otherwise. A host may share the slot with another client that reads a bare key, so
//      the stored format is not this SDK's to dictate: JSON api-key material and a bare non-empty
//      string are BOTH the key.
//   3. IT NEVER THROWS. Its caller is a tool executor, and an executor that throws ends the whole
//      turn. Every outcome -- found, missing, unreadable -- is a value.
//
// THE VALUE IS NEVER LOGGED AND NEVER QUOTED. Every message below is built from the redacted ref
// (`redactCredentialRef`: a locator, with an inline value replaced) and a reason; an underlying
// store's own error text is withheld, because it may quote the record it failed on.
import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { CredentialResolutionError } from "@yanlinglabs/winter-provider-runtime";
import type { KeychainSecretReader } from "./keychain-store.ts";
import { redactCredentialRef } from "./selection.ts";

/**
 * `found`       the key, trimmed.
 * `missing`     the ref resolves to nothing (no such item, an empty value, `{ kind: "none" }`). The
 *               ordinary "no key configured" state -- never an error.
 * `unreadable`  something IS there (or the store failed) and it cannot be used as a key. `code` is
 *               the store's own vocabulary; `message` names the redacted ref and the reason.
 */
export type ToolSecretResult =
  | { status: "found"; key: string }
  | { status: "missing" }
  | { status: "unreadable"; code: "io" | "malformed" | "unsupported"; message: string };

/** What an executor is handed. A test fake is a one-line function returning one of the three arms. */
export type ToolSecretResolver = (ref: CredentialRef) => Promise<ToolSecretResult>;

export interface ToolSecretResolverDeps {
  /** Serves every NON-keychain ref (`env`, `inline`, `file`, `none`), and keychain refs too when no raw reader is supplied. */
  credentials: CredentialStore;
  /**
   * The keychain's RAW reader (`createKeychainSecretReader`). When present, a keychain ref is read
   * through it EXACTLY ONCE and interpreted here -- never through `credentials.get` first, which
   * would throw `malformed` on a bare key and would cost a second keychain access (each of which can
   * raise an OS consent prompt). ABSENT for a wiring built over an injected store: a test must never
   * reach the real keychain, so an injected store means "this is the only source".
   */
  readKeychainSecret?: KeychainSecretReader;
}

const MATERIAL_KIND_FIELD = "kind";

/** The material kinds this SDK itself writes. Anything else in a `kind` field is STORED CONTENT of unknown provenance. */
const KNOWN_MATERIAL_KINDS: ReadonlySet<string> = new Set(["api-key", "bearer", "oauth", "aws", "gcp-service-account", "gcp-access-token"]);

const HOW_TO_STORE = 'store the bare key, or {"kind":"api-key","key":...}';

function malformed(locator: string, what: string): ToolSecretResult {
  return { status: "unreadable", code: "malformed", message: `the item at ${locator} holds ${what}, not an API key; ${HOW_TO_STORE}` };
}

/** A BARE key, held to what a key can be: non-empty, and no whitespace (a header value cannot carry it, and it is far likelier a pasted sentence). */
function bareKey(value: string, locator: string): ToolSecretResult {
  const key = value.trim();
  if (key.length === 0) return { status: "missing" };
  if (/\s/.test(key)) return malformed(locator, "text containing whitespace");
  return { status: "found", key };
}

/**
 * What one stored string means. Exported for its own tests.
 *
 * NOTHING FROM THE STORED VALUE EVER APPEARS IN A MESSAGE -- these messages travel into a tool
 * RESULT, which a model reads. That includes the value of a `kind` field: it is quoted only when it
 * is one of the kinds this SDK writes, because anything else is content of unknown provenance and
 * may be the secret itself (an item holding `{"kind":"sk-live-..."}` must not be echoed).
 *
 *   JSON `{ "kind": "api-key", "key": "<non-empty>" }`  -> the key
 *   a JSON string                                       -> that string, held to the bare-key rule
 *   JSON `null`                                         -> missing (a serialised "no value")
 *   any other JSON object, array, `true`/`false`        -> unreadable: structured, and not an API key
 *   text that STARTS like JSON (`{` / `[`) but does not
 *   parse                                               -> unreadable. It was meant to be structured;
 *                                                          sending the whole blob as the key header
 *                                                          would put a broken record on the wire
 *   any other text                                      -> the trimmed text, if it has no whitespace
 *
 * A JSON NUMBER is deliberately a key: one made only of digits parses as a number, and it is still
 * the key.
 */
export function interpretToolSecret(raw: string, locator: string): ToolSecretResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { status: "missing" };
  const looksStructured = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return looksStructured ? malformed(locator, "JSON that does not parse") : bareKey(trimmed, locator);
  }
  if (parsed === null) return { status: "missing" };
  if (typeof parsed === "string") return bareKey(parsed, locator);
  if (typeof parsed === "number") return bareKey(trimmed, locator);
  if (typeof parsed === "boolean") return malformed(locator, "a JSON boolean");
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(parsed) && record[MATERIAL_KIND_FIELD] === "api-key" && typeof record["key"] === "string") return bareKey(record["key"], locator);
  const kind = !Array.isArray(parsed) ? record[MATERIAL_KIND_FIELD] : undefined;
  return malformed(locator, typeof kind === "string" && KNOWN_MATERIAL_KINDS.has(kind) ? `"${kind}" credential material` : "structured JSON");
}

function unreadableFrom(err: unknown, locator: string): ToolSecretResult {
  const code = err instanceof CredentialResolutionError && (err.code === "io" || err.code === "malformed" || err.code === "unsupported") ? err.code : "io";
  const kind = err instanceof Error ? err.name : "unknown error";
  // The underlying message is WITHHELD: a store's error text may quote the record it failed on.
  return { status: "unreadable", code, message: `could not read the tool secret at ${locator}: the store failed with a ${kind} (${code})` };
}

export function createToolSecretResolver(deps: ToolSecretResolverDeps): ToolSecretResolver {
  return async (ref) => {
    const locator = redactCredentialRef(ref);
    try {
      if (ref.kind === "none") return { status: "missing" };
      if (ref.kind === "keychain" && deps.readKeychainSecret !== undefined) {
        const raw = await deps.readKeychainSecret(ref);
        return raw === null ? { status: "missing" } : interpretToolSecret(raw, locator);
      }
      const material = await deps.credentials.get(ref);
      if (material === null) return { status: "missing" };
      if (material.kind !== "api-key") return { status: "unreadable", code: "malformed", message: `the item at ${locator} holds "${material.kind}" credential material, not an API key` };
      return bareKey(material.key, locator);
    } catch (err) {
      return unreadableFrom(err, locator);
    }
  };
}

// WS-13b: WINTER'S OWN IDENTITY ON EVERY WIRE.
//
// One function, one string, and the reason it is a module rather than a constant spread across five
// header builders is the rule it enforces: WS-13 §5 (reaffirmed by D21) says client-identity headers
// are NEVER imported and every Winter adapter authors its own. A per-family literal is five places a
// vendor's product name could later be pasted "just for compatibility"; one function is a place a
// reviewer can grep, and `identity.test.ts` is where the negative lives.
//
// It is deliberately NOT configurable. A host that could override it could make Winter present as an
// editor or a first-party CLI, which is the exact thing the admission rule exists to forbid. The one
// sanctioned override is a user's own `ConnectionProfile.headers` — that is the operator speaking
// about their own proxy, and it goes through `hostHeaders` like every other host header.
//
// SOURCE OF THE VERSION: this package's own `package.json` "version" field, which
// `scripts/sync-version.ts` restamps from the root VERSION file. A static JSON import (not a runtime
// fs read) because this module reaches the compiled `$bunfs` binary through production-wiring, and a
// relative fs read does not survive that — the catalog next door already ships as a static JSON
// import into the same binary, so this path is proven rather than assumed.

import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import pkg from "../package.json";

/**
 * `winter-agent-sdk/<version>` — the `User-Agent` every adapter family sends.
 *
 * Never an editor, a vendor CLI or a first-party product identity (WS-13 §5, D21). Where a vendor
 * names a second identity field (aihorde's `Client-Agent`, the codex backend's `originator`), that
 * field carries Winter's name too; it never carries somebody else's.
 */
export function winterUserAgent(): string {
  return `${DEFAULT_PRODUCT}/${pkg.version}`;
}

// --- the per-row second identity field (WS-13b §7/§8.4, fix-wave R-FW-2) ---------------------------
//
// THE OBLIGATION THAT FELL BETWEEN TWO LANES. Spec §2 asks for an adapter that sends
// `Client-Agent: winter-agent-sdk/<version>:<contact>`; §8.4 asks for `aihorde` and `uncloseai` to
// ship "with a truthful `Client-Agent`"; the audit calls it "the rule's honest-identity requirement
// made concrete". What shipped was a row whose citation NAMES the header and no code that sends it —
// the row author handed it to "the adapter owner", whose brief was the live gate.
//
// So it is DATA ON THE ROW and ONE seam applies it. The row that documents the vendor's field is the
// row that carries it, which is the only arrangement where adding a second such vendor cannot be
// forgotten by whoever adds the row.
//
// NOT PRIVILEGED, DELIBERATELY. `applyPrivilegedHeaders` returns `{}` on a non-generated endpoint,
// and a multi-provider row's reviewed endpoint is COPIED into `ConnectionProfile.baseUrl` by the
// runtime's `connectionFrom`, which evaluates as a USER endpoint (whole-branch review seam 1c).
// `aihorde` is on the 136-row chat adapter, so a privileged reading would deliver this header in an
// adapter fixture (`generatedBaseUrl`, generated) and never once in production. It discloses nothing
// about the operator — it is Winter's own name, the same class as the `User-Agent` it rides beside.

/** A row id -> the Winter-authored identity headers that row's vendor names. Built once per adapter registration. */
export type IdentityHeaderLookup = (providerId: string) => Record<string, string> | undefined;

/** The token a row's value carries in place of this build's version, so a release cannot leave a stale number on the wire. */
const VERSION_PLACEHOLDER = "<version>";
/**
 * P7a (D19): the token a row's value carries in place of the running brand's PRODUCT NAME.
 *
 * A row that hard-codes `winter-agent-sdk` is honest for Winter and a lie for a reuser — it would
 * put Winter's identity on a request the reuser's product made, in the one field whose entire
 * purpose is honest identity. `<product>` is what makes a catalog row truthful under every brand.
 */
const PRODUCT_PLACEHOLDER = "<product>";

/**
 * The DEFAULT product token when no brand has been threaded to this module.
 *
 * Lane A replaces this constant's use with `RuntimeConfig.brand.packageName` — that is the whole
 * remaining half of the identity sweep. Until then every substitution resolves to Winter's own
 * name, which is exactly today's behaviour, so the placeholder is inert rather than wrong.
 */
const DEFAULT_PRODUCT = "winter-agent-sdk";

/** What a row's identity-header value is rendered against: this build's version and this run's product. */
export interface IdentityRenderContext {
  version: string;
  product: string;
}

/**
 * Substitutes BOTH placeholders in one row's declared identity headers.
 *
 * The seam Lane A needs, extracted from `winterIdentityHeaders` so the brand can be threaded in one
 * place: everything about WHICH headers a row declares stays in the lookup, and everything about
 * WHAT the tokens resolve to arrives here as data. A caller with no brand still gets today's answer.
 */
export function renderIdentityHeaders(declared: Record<string, string>, ctx: IdentityRenderContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(declared)) {
    out[name] = value.split(PRODUCT_PLACEHOLDER).join(ctx.product).split(VERSION_PLACEHOLDER).join(ctx.version);
  }
  return out;
}

/** Indexes a catalog's `identityHeaders` by provider id. Rows without any are simply absent. */
export function identityHeaderLookup(catalog: WinterCatalog): IdentityHeaderLookup {
  const index = new Map<string, Record<string, string>>();
  for (const provider of catalog.providers) {
    if (provider.identityHeaders !== undefined && Object.keys(provider.identityHeaders).length > 0) index.set(provider.id, provider.identityHeaders);
  }
  return (providerId) => index.get(providerId);
}

/**
 * The identity headers for one row, with `<product>` and `<version>` substituted — or `{}`.
 *
 * `{}` for a row with none, for an adapter constructed without a lookup (every unit fixture), and
 * for an unknown id. An absent second identity field is the normal case: only a vendor that NAMES
 * one gets one.
 */
export function winterIdentityHeaders(lookup: IdentityHeaderLookup | undefined, providerId: string): Record<string, string> {
  const declared = lookup?.(providerId);
  if (declared === undefined) return {};
  return renderIdentityHeaders(declared, { version: pkg.version, product: DEFAULT_PRODUCT });
}

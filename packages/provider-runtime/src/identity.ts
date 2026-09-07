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
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import pkg from "../package.json";

// --- P7a (D19): the RUNNING product's identity ------------------------------------------------------
//
// `Options.brand` exists so a reuser ships a product of their own. The one thing that must follow it
// onto the wire is IDENTITY: a request the reuser's product made, carrying Winter's own token in its
// `User-Agent` and Winter's own value in the codex `originator`, is a false statement about who is calling —
// the exact failure this module's own header says the rule exists to prevent, only pointed the other
// way.
//
// A PROCESS-LEVEL VALUE WITH A SETTER, and that shape is forced rather than chosen. `winterUserAgent()`
// is called from ten call sites — OAuth device-code and refresh helpers, PKCE, Vertex, and five
// adapter header builders — most of which hold no session object at all, and the two `originator`
// sites read a frozen constant table. Threading a profile to each would put a brand parameter on
// every OAuth helper in the package for one string. So the runtime sets it ONCE per session, beside
// the standing-server rename it already does (`rebrandStandingServerTools`), and disposes it with
// the session.
//
// THE ONE-LIVE-BRAND ASSUMPTION, disclosed: two CONCURRENT sessions under DIFFERENT brands in one
// process would share this value. That is the same assumption `subagents/limits.ts` and
// `tools/background-tasks.ts` already record for their own process-level state; a genuinely
// multi-tenant host is a WS-15 concern. It is NOT configurable by the model or by a host header —
// only by the validated brand profile, whose `codexOriginator` is refused if it names a first party.

/** The two identity tokens a running product puts on the wire. */
export interface WinterIdentity {
  /** The product token in `User-Agent` and in a row's `<product>` placeholder — `brand.packageName`. */
  product: string;
  /** The codex backend's `originator` — `brand.codexOriginator`, validated never to be first-party. */
  codexOriginator: string;
}

const DEFAULT_IDENTITY: Readonly<WinterIdentity> = Object.freeze({ product: WINTER_BRAND.packageName, codexOriginator: WINTER_BRAND.codexOriginator });

let activeIdentity: Readonly<WinterIdentity> = DEFAULT_IDENTITY;

/** What this process is currently presenting as. Winter's own values until a branded session sets it. */
export function activeWinterIdentity(): Readonly<WinterIdentity> {
  return activeIdentity;
}

/**
 * Install a session's identity; the returned disposer restores what was there before.
 *
 * Restore-what-was-there rather than restore-to-default, so nested/overlapping sessions unwind in
 * the order they were installed. A disposer whose value has since been replaced is a no-op, the
 * same identity check `registerHostGeneratedTool` uses for the identical reason.
 */
export function setWinterIdentity(next: WinterIdentity): () => void {
  const previous = activeIdentity;
  const installed: Readonly<WinterIdentity> = Object.freeze({ ...next });
  activeIdentity = installed;
  let disposed = false;
  return () => {
    if (disposed || activeIdentity !== installed) return;
    disposed = true;
    activeIdentity = previous;
  };
}

/**
 * `<product>/<version>` — the `User-Agent` every adapter family sends.
 *
 * Never an editor, a vendor CLI or a first-party product identity (WS-13 §5, D21). Where a vendor
 * names a second identity field (aihorde's `Client-Agent`, the codex backend's `originator`), that
 * field carries the running product's name too; it never carries somebody else's.
 */
export function winterUserAgent(): string {
  return `${activeIdentity.product}/${pkg.version}`;
}

// --- the per-row second identity field (WS-13b §7/§8.4, fix-wave R-FW-2) ---------------------------
//
// THE OBLIGATION THAT FELL BETWEEN TWO LANES. Spec §2 asks for an adapter that sends
// `Client-Agent: <product>/<version>:<contact>`; §8.4 asks for `aihorde` and `uncloseai` to
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
 * A row that hard-codes a product token is honest for that product and a lie for a reuser — it would
 * put one product's identity on a request another one made, in the one field whose entire
 * purpose is honest identity. `<product>` is what makes a catalog row truthful under every brand.
 */
const PRODUCT_PLACEHOLDER = "<product>";

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
  return renderIdentityHeaders(declared, { version: pkg.version, product: activeIdentity.product });
}

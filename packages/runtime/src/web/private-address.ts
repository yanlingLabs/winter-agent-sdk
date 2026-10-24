// PRIVATE / LOOPBACK / LINK-LOCAL ADDRESS CLASSIFICATION for `WebFetch`'s `privateAddressPolicy`.
//
// A sandboxed shell has no network, so `WebFetch` is the ONLY door from a session to the services on
// the user's own machine and LAN (`WebPrivateAddressPolicy`'s own header, packages/sdk/src/protocol/
// config.ts). Whether that door opens depends on TWO independent facts about the target, both
// checked here: the LEXICAL shape of the hostname the caller wrote (an IP literal, `localhost`, a
// `.local` mDNS name), and the RESOLVED address it connects to at fetch time -- because a public-
// looking hostname that resolves to `127.0.0.1` (DNS rebinding) is the classic bypass a
// lexical-only check misses entirely.
//
// IP-RANGE CLASSIFICATION ITSELF IS NOT REBUILT HERE. `@yanlinglabs/winter-web` carries the
// classifier its own fetcher enforces on every hop (bytes, not spellings: every IPv4 notation, the
// IPv4-embedding IPv6 forms, cloud metadata, multicast, this machine's own interface addresses), so
// this module is a THIN layer over it: the verdict shape the permission layer and the cache-hit gate
// read, and the "lexical, else every resolved address" orchestration `WebFetch` itself needs.
//
// This module registers no tool and has no dependency on anything under `tools/`.
import { isIP } from "node:net";
import { classifyAddress, classifyHostnameLexically as classifyLexically, isReservedPrivateName } from "@yanlinglabs/winter-web";

export type AddressVerdict = "public" | "private";

/** One classified fact about a hop's target -- WHERE it came from is what a caller's message names. */
export interface PrivateAddressFinding {
  class: AddressVerdict;
  /** The shared classifier's own class name, or a reserved-name label -- safe to show the model. */
  reason?: string;
}

const PUBLIC: PrivateAddressFinding = { class: "public" };

/** Strips a `[...]` IPv6 literal's brackets; a non-bracketed host is returned unchanged. */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Classifies a literal IP address -- `undefined` when `address` is not one (`net.isIP` decides, as
 * before). The class and its reason are `@yanlinglabs/winter-web`'s.
 */
export function classifyIpLiteral(address: string): PrivateAddressFinding | undefined {
  if (isIP(address) === 0) return undefined;
  const verdict = classifyAddress(address);
  return verdict.public ? { class: "public", reason: "public" } : { class: "private", reason: verdict.reason };
}

/** Reserved names RFC 6761 (`localhost`) and mDNS (`.local`) carve out -- private by NAME, whatever they resolve to. A single trailing dot is ignored. */
export function classifyReservedName(hostname: string): PrivateAddressFinding | undefined {
  if (!isReservedPrivateName(hostname)) return undefined;
  let h = hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return { class: "private", reason: h === "localhost" || h.endsWith(".localhost") ? "the localhost TLD (RFC 6761)" : "the .local mDNS TLD" };
}

/**
 * The LEXICAL verdict for `hostname` as written in the URL: an IP literal classified by range, or a
 * reserved name. `undefined` means "not lexically decidable" -- an ordinary DNS name, which is only
 * classifiable by its RESOLVED address (see `classifyHostname` below).
 */
export function classifyHostnameLexically(hostname: string): PrivateAddressFinding | undefined {
  const bare = stripIpv6Brackets(hostname);
  const literal = classifyIpLiteral(bare) ?? classifyReservedName(hostname);
  if (literal !== undefined) return literal;
  // Any other address spelling (`0x7f.1`, `2130706433`) -- the URL parser normalises these, but the
  // verdict never depends on that.
  const verdict = classifyLexically(hostname);
  return verdict === undefined ? undefined : verdict.public ? { class: "public", reason: "public" } : { class: "private", reason: verdict.reason };
}

/** The verdict for one resolved connection address (whatever DNS returned for an ordinary name). */
export function classifyResolvedAddress(address: string): PrivateAddressFinding {
  return classifyIpLiteral(address) ?? PUBLIC;
}

/**
 * The full verdict for `hostname`: lexical first (an IP literal or reserved name never needs a
 * lookup), else every address `resolve` returns for it -- ANY private address among them makes the
 * whole hostname private, because a caller reaches whichever address the OS connects to, not
 * necessarily the first one.
 *
 * NOT the function that guards the actual connection any more (security review finding M6):
 * `_web-fetch-net.ts`'s own `resolveTarget` now does its own single resolution and PINS the fetch
 * to the exact address it classified (`Host` + `tls.serverName` carrying the logical name), closing
 * the rebinding TOCTOU this function's own resolve-then-classify shape cannot by itself (a second,
 * independent `fetch()`-internal resolution could still answer differently). This function remains
 * the upfront, pre-cache gate in `web-fetch.ts` -- a decision, not a connection -- where that gap
 * does not apply the same way (nothing here opens a socket).
 *
 * FAILS CLOSED on a resolution failure (security review finding M6): an EARLIER version of this
 * function answered `PUBLIC` when `resolve` threw or answered nothing, on the reasoning that "the
 * fetch step reports the real failure" -- but a caller that only asks THIS function before deciding
 * whether to proceed (as `web-fetch.ts`'s own upfront gate does, ahead of a cache-hit) would treat an
 * unresolvable name as safe to serve. There is no address to pin a decision to, so the honest answer
 * is `private` (refuse), never `public` (silently proceed).
 */
/**
 * Item 2: the ONE spelling of "resolution failed" -- shared so a caller that needs to tell "actually
 * private" apart from "unknown, because DNS didn't answer" (`web-fetch.ts`'s own cache-hit refusal,
 * which used to say "it is a private/loopback address" for BOTH) compares against this constant,
 * never a re-typed literal that could drift from the one below.
 */
export const UNRESOLVABLE_HOST_REASON = "could not resolve any address for this host";

export async function classifyHostname(hostname: string, resolve: (hostname: string) => Promise<readonly string[]>): Promise<PrivateAddressFinding> {
  const lexical = classifyHostnameLexically(hostname);
  if (lexical !== undefined) return lexical;
  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { class: "private", reason: UNRESOLVABLE_HOST_REASON };
  }
  if (addresses.length === 0) return { class: "private", reason: UNRESOLVABLE_HOST_REASON };
  for (const address of addresses) {
    const verdict = classifyResolvedAddress(address);
    if (verdict.class === "private") return verdict;
  }
  return PUBLIC;
}

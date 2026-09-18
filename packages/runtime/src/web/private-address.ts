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
// IP-RANGE CLASSIFICATION ITSELF IS NOT REBUILT HERE. `@yanlinglabs/winter-provider-runtime` already
// carries a tested classifier (`classifyAddress`, moved there from this SDK's own `monitor.ts` for
// exactly this "one classifier, one fixture set" reason, R6-11) -- this module is deliberately a
// THIN layer over it: `net.isIP` picks the family exactly the way that package's own
// `evaluateEndpoint` does (its file header names this convention directly), and the only work this
// module adds is what the shared classifier does not attempt: reserved HOSTNAMES (`localhost`,
// `.local`) that are private by name regardless of what they resolve to, and the "lexical, else every
// resolved address" orchestration `WebFetch` itself needs. A second hand-rolled IPv4/IPv6 parser
// here would be exactly the duplicate copy R6-11 exists to forbid.
//
// This module registers no tool and has no dependency on anything under `tools/`.
import { isIP } from "node:net";
import { classifyAddress, type AddressClass } from "@yanlinglabs/winter-provider-runtime";

export type AddressVerdict = "public" | "private";

/** One classified fact about a hop's target -- WHERE it came from is what a caller's message names. */
export interface PrivateAddressFinding {
  class: AddressVerdict;
  /** The shared classifier's own class name, or a reserved-name label -- safe to show the model. */
  reason?: string;
}

const PUBLIC: PrivateAddressFinding = { class: "public" };

/**
 * The classes this module treats as private, beyond `@yanlinglabs/winter-provider-runtime`'s own
 * `isLocalAddressClass` (loopback/private/link-local/unique-local): `cgnat` (100.64.0.0/10, RFC
 * 6598 -- a real bypass-relevant range that classifier's own `isLocalAddressClass` deliberately
 * excludes, because ITS consumer, the provider endpoint policy, is answering a different question)
 * and `unspecified` (0.0.0.0/8, "::") -- both named explicitly in this tool's own requirements.
 * `multicast` and `invalid` are left PUBLIC: neither is a real bypass target (an unreachable address
 * simply fails the fetch itself, which is the honest failure to report).
 */
const PRIVATE_CLASSES: ReadonlySet<AddressClass> = new Set(["loopback", "private", "link-local", "unique-local", "cgnat", "unspecified"]);

/** Strips a `[...]` IPv6 literal's brackets; a non-bracketed host is returned unchanged. */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Classifies a literal IP address -- family auto-detected via `net.isIP` (0 = not a literal IP at
 * all, in which case this returns `undefined` rather than guessing). Delegates the actual range
 * logic to the shared classifier, which already handles IPv4-mapped IPv6 in both its dotted-quad
 * (`::ffff:127.0.0.1`) and hex-group (`::ffff:7f00:1`) forms.
 */
export function classifyIpLiteral(address: string): PrivateAddressFinding | undefined {
  const family = isIP(address);
  if (family === 0) return undefined;
  const cls = classifyAddress(address, family);
  // `classifyAddress`'s own IPv4 arm fails closed to "invalid" for something `net.isIP` nonetheless
  // called a 4 (should not happen in practice; both use the same dotted-quad shape) -- treated as
  // "not classifiable," letting the fetch attempt itself report the real failure rather than this
  // module inventing a verdict for an address it cannot parse.
  if (cls === "invalid") return undefined;
  return { class: PRIVATE_CLASSES.has(cls) ? "private" : "public", reason: cls };
}

/** Reserved names RFC 6761 (`localhost`) and mDNS (`.local`) carve out -- private by NAME, whatever they resolve to. A single trailing dot (the DNS root, `localhost.`/`a.localhost.`/`foo.local.`) is stripped first so it cannot defeat the check. */
export function classifyReservedName(hostname: string): PrivateAddressFinding | undefined {
  let h = hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return { class: "private", reason: "the localhost TLD (RFC 6761)" };
  if (h === "local" || h.endsWith(".local")) return { class: "private", reason: "the .local mDNS TLD" };
  return undefined;
}

/**
 * The LEXICAL verdict for `hostname` as written in the URL: an IP literal classified by range, or a
 * reserved name. `undefined` means "not lexically decidable" -- an ordinary DNS name, which is only
 * classifiable by its RESOLVED address (see `classifyHostname` below).
 */
export function classifyHostnameLexically(hostname: string): PrivateAddressFinding | undefined {
  const bare = stripIpv6Brackets(hostname);
  return classifyIpLiteral(bare) ?? classifyReservedName(hostname);
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
export async function classifyHostname(hostname: string, resolve: (hostname: string) => Promise<readonly string[]>): Promise<PrivateAddressFinding> {
  const lexical = classifyHostnameLexically(hostname);
  if (lexical !== undefined) return lexical;
  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { class: "private", reason: "could not resolve any address for this host" };
  }
  if (addresses.length === 0) return { class: "private", reason: "could not resolve any address for this host" };
  for (const address of addresses) {
    const verdict = classifyResolvedAddress(address);
    if (verdict.class === "private") return verdict;
  }
  return PUBLIC;
}

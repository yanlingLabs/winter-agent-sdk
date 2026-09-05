// THE address classifier — one classifier, one fixture set (R6-11).
//
// This code was MOVED here from `packages/runtime/src/tools/impl/monitor.ts` (P3's Monitor ws
// endpoint validation, rulings P3-I and the N5 fix-wave additions), not copied: monitor.ts now
// imports and re-exports `isDisallowedAddress` from this module, so its own fixture set — the ~30
// address assertions in monitor.test.ts, including the two IPv4-mapped-IPv6 forms a resolver can
// hand back — keeps testing exactly this implementation. R6-11's "never a second copy" is a
// structural property here, not a promise.
//
// The move direction is the only one available: `packages/runtime` depends on
// `@yanlinglabs/winter-provider-runtime`, and R6-4 forbids the reverse import (cycle). So shared
// code has to live at the lower level.
//
// BEHAVIOUR IS PRESERVED EXACTLY, including one wart, deliberately: an unrecognised IPv6 string
// classifies as `public` rather than `invalid`, where an unparseable IPv4 fails closed as `invalid`.
// That asymmetry is P3's, and a move commit is the wrong place to silently tighten a security
// check. Neither live caller can reach it — monitor.ts classifies addresses that came back from
// `dns.lookup`, and `evaluateEndpoint` classifies only strings `net.isIP` already confirmed — so it
// is recorded rather than repaired here.

/**
 * What an IP address IS, rather than merely whether some particular caller should refuse it. The
 * two consumers want opposite answers from the same facts — Monitor refuses every non-public
 * address, while the provider endpoint policy ACCEPTS a loopback/private one when a host declares
 * the endpoint local — so the shared primitive has to be the classification, not the verdict.
 */
export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "unique-local"
  | "cgnat"
  | "multicast"
  | "unspecified"
  | "invalid";

/** Everything a provider endpoint may reach over plain `http` when it is declared (or generated as) local. */
const LOCAL_CLASSES: ReadonlySet<AddressClass> = new Set<AddressClass>(["loopback", "private", "link-local", "unique-local"]);

/** True for the classes an endpoint may serve over plain `http` — loopback, RFC 1918, link-local, unique-local (R6-11). */
export function isLocalAddressClass(cls: AddressClass): boolean {
  return LOCAL_CLASSES.has(cls);
}

function classifyIPv4(ip: string): AddressClass {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return "invalid"; // unparseable -- fail closed
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return "unspecified"; // 0.0.0.0/8
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local"; // covers cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return "cgnat"; // 100.64.0.0/10, RFC 6598
  if (a >= 224 && a <= 239) return "multicast"; // 224.0.0.0/4
  return "public";
}

// An IPv4-mapped IPv6 address's two trailing 16-bit groups ARE the IPv4 address, just split across
// group boundaries rather than byte boundaries: each group's high byte then low byte, concatenated,
// is the dotted-quad. E.g. "a9fe:a9fe" -> 0xa9fe=169.254 twice -> "169.254.169.254" (cloud metadata).
function ipv4FromHexGroups(g1: string, g2: string): string {
  const h1 = parseInt(g1, 16);
  const h2 = parseInt(g2, 16);
  return `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
}

function classifyIPv6(ip: string): AddressClass {
  const lower = ip.toLowerCase();
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mappedDotted) return classifyIPv4(mappedDotted[1]!);
  // IPv4-mapped, HEX-GROUP form (e.g. "::ffff:a9fe:a9fe" for 169.254.169.254) -- a resolver can hand
  // this shape back just as readily as the dotted-quad form above. Without this arm, the two
  // trailing hex groups fail the dotted-quad regex, and `lower.split(":")[0]` (used below for the
  // fe80::/fc00:: checks) is "" (the leading "::" splits to two empty leading segments) -- an empty
  // string fails the `.length > 0` guard, so `firstGroup` stays NaN and NEITHER link-local check
  // ever fires either. The address fell all the way through: silently PUBLIC. Converting both groups
  // to their four constituent bytes and re-running them through classifyIPv4 gives this one shared
  // source of truth with the dotted-quad arm above.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) return classifyIPv4(ipv4FromHexGroups(mappedHex[1]!, mappedHex[2]!));
  if (lower === "::1") return "loopback";
  if (lower === "::") return "unspecified";
  const firstGroupText = lower.split(":")[0] ?? "";
  const firstGroup = firstGroupText.length > 0 ? parseInt(firstGroupText, 16) : NaN;
  if (!Number.isNaN(firstGroup)) {
    if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return "link-local"; // fe80::/10
    if (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) return "unique-local"; // fc00::/7
  }
  return "public";
}

/** Classifies a literal IP address. `family` is 4 or 6, exactly as `dns.lookup`'s own results report it. */
export function classifyAddress(address: string, family: number): AddressClass {
  return family === 6 ? classifyIPv6(address) : classifyIPv4(address);
}

/**
 * Monitor's verdict, unchanged from P3: everything that is not a routable public address is refused,
 * unparseable IPv4 included (fail closed). Re-exported by `monitor.ts` so that file's own callers
 * and its existing fixture set are untouched by this module's existence.
 */
export function isDisallowedAddress(address: string, family: number): boolean {
  return classifyAddress(address, family) !== "public";
}

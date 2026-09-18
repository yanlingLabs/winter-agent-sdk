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
// This module registers no tool and has no dependency on anything under `tools/`.

export type AddressClass = "public" | "private";

/** One classified fact about a hop's target -- WHERE it came from is what a caller's message names. */
export interface PrivateAddressFinding {
  class: AddressClass;
  /** Human-readable reason, safe to show the model (`"loopback"`, `"private-use (RFC 1918)"`, ...). */
  reason?: string;
}

const PUBLIC: PrivateAddressFinding = { class: "public" };

function ipv4Octets(host: string): [number, number, number, number] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return undefined;
  const parts = m.slice(1, 5).map((s) => Number(s));
  if (parts.some((n) => n > 255)) return undefined;
  return parts as [number, number, number, number];
}

/** Classifies a bare IPv4 literal (dotted-decimal only -- `new URL().hostname` already canonicalizes hex/octal/decimal forms to this shape). */
export function classifyIpv4(host: string): PrivateAddressFinding | undefined {
  const octets = ipv4Octets(host);
  if (octets === undefined) return undefined;
  const [a, b] = octets;
  if (a === 127) return { class: "private", reason: "loopback (127.0.0.0/8)" };
  if (a === 10) return { class: "private", reason: "private-use (10.0.0.0/8)" };
  if (a === 172 && b >= 16 && b <= 31) return { class: "private", reason: "private-use (172.16.0.0/12)" };
  if (a === 192 && b === 168) return { class: "private", reason: "private-use (192.168.0.0/16)" };
  if (a === 169 && b === 254) return { class: "private", reason: "link-local (169.254.0.0/16)" };
  if (a === 100 && b >= 64 && b <= 127) return { class: "private", reason: "carrier-grade NAT (100.64.0.0/10)" };
  if (a === 0) return { class: "private", reason: "\"this network\" (0.0.0.0/8)" };
  return PUBLIC;
}

/** Expands an IPv6 literal (brackets already stripped) to 8 16-bit groups, or `undefined` if it does not parse. */
function expandIpv6(host: string): number[] | undefined {
  // An embedded IPv4 tail ("::ffff:127.0.0.1") is rewritten to its hex-group form first.
  const v4 = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  let s = host;
  if (v4 !== null) {
    const octets = ipv4Octets(v4[2]!);
    if (octets === undefined) return undefined;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${v4[1]}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const groups = parseGroups(halves[0]!);
    return groups !== undefined && groups.length === 8 ? groups : undefined;
  }
  const left = parseGroups(halves[0]!);
  const right = parseGroups(halves[1]!);
  if (left === undefined || right === undefined) return undefined;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return undefined;
  return [...left, ...new Array(fill).fill(0), ...right];
}

/** Classifies a bare IPv6 literal (no brackets). */
export function classifyIpv6(host: string): PrivateAddressFinding | undefined {
  if (!host.includes(":")) return undefined;
  const groups = expandIpv6(host);
  if (groups === undefined) return undefined;
  const isZero = (n: number) => n === 0;
  if (groups.every(isZero)) return { class: "private", reason: "unspecified (::)" };
  if (groups.slice(0, 7).every(isZero) && groups[7] === 1) return { class: "private", reason: "loopback (::1)" };
  // IPv4-mapped (::ffff:0:0/96): groups 0-4 zero, group 5 = 0xffff -- classify the embedded IPv4.
  if (groups.slice(0, 5).every(isZero) && groups[5] === 0xffff) {
    const g6 = groups[6]!;
    const g7 = groups[7]!;
    const ipv4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    const inner = classifyIpv4(ipv4);
    return inner?.class === "private" ? { class: "private", reason: `IPv4-mapped ${inner.reason}` } : PUBLIC;
  }
  if ((groups[0]! & 0xfe00) === 0xfc00) return { class: "private", reason: "unique local (fc00::/7)" };
  if ((groups[0]! & 0xffc0) === 0xfe80) return { class: "private", reason: "link-local (fe80::/10)" };
  return PUBLIC;
}

/** Reserved names RFC 6761 (`localhost`) and mDNS (`.local`) carve out -- private by NAME, whatever they resolve to. */
export function classifyReservedName(hostname: string): PrivateAddressFinding | undefined {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return { class: "private", reason: "the localhost TLD (RFC 6761)" };
  if (h === "local" || h.endsWith(".local")) return { class: "private", reason: "the .local mDNS TLD" };
  return undefined;
}

/** Strips a `[...]` IPv6 literal's brackets; a non-bracketed host is returned unchanged. */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * The LEXICAL verdict for `hostname` as written in the URL: an IP literal classified by range, or a
 * reserved name. `undefined` means "not lexically decidable" -- an ordinary DNS name, which is only
 * classifiable by its RESOLVED address (see `classifyResolved` below).
 */
export function classifyHostnameLexically(hostname: string): PrivateAddressFinding | undefined {
  const bare = stripIpv6Brackets(hostname);
  return classifyIpv4(bare) ?? classifyIpv6(bare) ?? classifyReservedName(hostname);
}

/** The verdict for one resolved connection address (whatever DNS returned for an ordinary name). */
export function classifyResolvedAddress(address: string): PrivateAddressFinding {
  return classifyIpv4(address) ?? classifyIpv6(address) ?? PUBLIC;
}

/**
 * The full verdict for `hostname`: lexical first (an IP literal or reserved name never needs a
 * lookup), else every address `resolve` returns for it -- ANY private address among them makes the
 * whole hostname private, because a caller reaches whichever address the OS connects to, not
 * necessarily the first one.
 *
 * DISCLOSED TOCTOU: this resolves once, before connecting; nothing here pins the connection to the
 * addresses it just classified (Bun's `fetch` re-resolves internally), so a rebinding attacker whose
 * DNS answer changes between this check and the actual TCP connect is not caught. Closing that gap
 * needs a custom `connect` hook this fetch surface does not have -- disclosed, not silently assumed
 * away.
 */
export async function classifyHostname(hostname: string, resolve: (hostname: string) => Promise<readonly string[]>): Promise<PrivateAddressFinding> {
  const lexical = classifyHostnameLexically(hostname);
  if (lexical !== undefined) return lexical;
  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    // An unresolvable name cannot be connected to at all; that failure surfaces at the fetch step,
    // not here -- this function only ever answers "public" or "private," never "unknown."
    return PUBLIC;
  }
  for (const address of addresses) {
    const verdict = classifyResolvedAddress(address);
    if (verdict.class === "private") return verdict;
  }
  return PUBLIC;
}

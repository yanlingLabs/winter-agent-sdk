// DOMAIN MATCHING for the web tools' one shared `blockedDomains` floor -- a module that REGISTERS
// NOTHING, so both `impl/web-fetch.ts` and `impl/web-search.ts` (and `_exa-client.ts`) may import it.
//
// ONE implementation, because the floor has one meaning: `WebFetch` refuses a listed host,
// `WebSearch` excludes it from every backend search AND drops any hit that slips through. Two
// matchers would be two chances for "blocked for fetching, still surfaced as a link".
//
// THE RULE: SUFFIX ON A LABEL BOUNDARY. `example.com` blocks `example.com` and `docs.example.com`,
// and does NOT block `notexample.com` or `example.com.evil.test`. Comparison is case-insensitive; a
// trailing dot (the DNS root) is ignored on both sides.
//
// NORMALISATION GOES THROUGH THE URL PARSER, ON BOTH SIDES. The fetcher will resolve its target with
// `new URL()`, so a matcher that reads hosts any other way can be walked around: `http:/host/p`,
// `http:host/p` and `https:\\host/p` all resolve to `host`, a unicode name is punycode on the wire,
// and `0x7f.1`, `2130706433` and `127.0.0.1` are one address. Parsing the input AND every list entry
// with the same parser makes each of those the same string before anything is compared.
//
// THREE KINDS OF ENTRY NEVER MATCH BY SUFFIX, only exactly:
//   - an IP literal. A suffix of an address is not a parent of it: `0.1` must not block `127.0.0.1`.
//     (IPv6 is kept in its bracketed form, so a bare `::1` entry and `[::1]` are the same entry.)
//   - a SINGLE-LABEL name (`com`, `localhost`). As a suffix `com` would block every `.com` from one
//     typo'd or truncated entry; exactly, `localhost` still blocks `localhost`. A host that really
//     wants a whole TLD gone lists it knowingly elsewhere -- this floor does not do it by accident.

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hostnameOf(candidate: string): string | undefined {
  try {
    const hostname = new URL(candidate).hostname;
    return hostname.length > 0 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || IPV4.test(host);
}

/**
 * One list entry, or one host/URL under test, as the canonical hostname the URL parser gives it --
 * or `undefined` for something that names no host.
 *
 * Tolerant of what people actually write in a block-list: a leading `*.` or `.`, a scheme, userinfo,
 * a port, a path, surrounding whitespace, a unicode name, a bare IPv6 address.
 * `https://Ads.Example.com/track` and `*.ads.example.com` both become `ads.example.com`.
 */
export function normalizeDomain(entry: string): string | undefined {
  const raw = entry.trim();
  if (raw.length === 0) return undefined;
  // (1) Something the URL parser reads as a URL WITH A HOST, in whatever spelling (`http:/h`,
  //     `https:\\h`). `host:8080` also looks like a scheme; it parses to an EMPTY host and falls through.
  let hostname = SCHEME_PREFIX.test(raw) ? hostnameOf(raw) : undefined;
  if (hostname === undefined) {
    // (2) A bare host (or `//host/path`, or `host:port/path`): strip the list-entry decorations, then
    //     let the parser canonicalise it. A bare IPv6 address needs its brackets to parse at all.
    const bare = raw.replace(/^\/\//, "").replace(/^(\*\.)+/, "").replace(/^\.+/, "");
    if (bare.length === 0) return undefined;
    hostname = hostnameOf(`http://${bare}`) ?? (bare.includes(":") && !bare.includes("[") ? hostnameOf(`http://[${bare}]`) : undefined);
  }
  if (hostname === undefined) return undefined;
  const value = hostname.replace(/^(\*\.)+/, "").replace(/\.+$/, "");
  return value.length > 0 ? value : undefined;
}

/** `host` is `domain`, or a subdomain of it when `domain` is a multi-label NAME. Both are normalised first. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = normalizeDomain(host);
  const d = normalizeDomain(domain);
  if (h === undefined || d === undefined) return false;
  if (h === d) return true;
  // Exact-only entries: see the header.
  if (isIpLiteral(h) || isIpLiteral(d) || !d.includes(".")) return false;
  return h.endsWith(`.${d}`);
}

/** The first entry of `domains` that covers `hostOrUrl`, or `undefined`. */
export function matchingDomain(hostOrUrl: string, domains: readonly string[]): string | undefined {
  return domains.find((domain) => hostMatchesDomain(hostOrUrl, domain));
}

export function isDomainBlocked(hostOrUrl: string, blockedDomains: readonly string[]): boolean {
  return matchingDomain(hostOrUrl, blockedDomains) !== undefined;
}

/** Normalised, de-duplicated union, in first-seen order. Entries that name no host are dropped. */
export function mergeDomainLists(...lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      const domain = normalizeDomain(entry);
      if (domain !== undefined) seen.add(domain);
    }
  }
  return [...seen];
}

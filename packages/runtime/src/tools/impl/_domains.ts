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

/**
 * One list entry as a bare, lower-cased hostname, or `undefined` for an entry that names no host.
 *
 * Tolerant of what people actually write in a block-list: a leading `*.` or `.`, a scheme, a path, a
 * port, surrounding whitespace. `https://Ads.Example.com/track` and `*.ads.example.com` both become
 * `ads.example.com`.
 */
export function normalizeDomain(entry: string): string | undefined {
  let value = entry.trim().toLowerCase();
  if (value.length === 0) return undefined;
  const scheme = value.indexOf("://");
  if (scheme !== -1) value = value.slice(scheme + 3);
  // Userinfo, then path/query/fragment, then port. (An IPv6 literal keeps its brackets and is left alone.)
  const at = value.lastIndexOf("@", value.search(/[/?#]|$/));
  if (at !== -1) value = value.slice(at + 1);
  value = value.replace(/[/?#].*$/, "");
  if (!value.startsWith("[")) value = value.replace(/:\d+$/, "");
  value = value.replace(/^(\*\.)+/, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return value.length > 0 ? value : undefined;
}

/** `host` is `domain` or a subdomain of it. Both are normalised first. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = normalizeDomain(host);
  const d = normalizeDomain(domain);
  if (h === undefined || d === undefined) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** The first entry of `domains` that covers `hostOrUrl`, or `undefined`. A URL that does not parse is matched as a bare host. */
export function matchingDomain(hostOrUrl: string, domains: readonly string[]): string | undefined {
  let host = hostOrUrl;
  try {
    if (hostOrUrl.includes("://")) host = new URL(hostOrUrl).hostname;
  } catch {
    /* not a URL: `normalizeDomain` strips what it can */
  }
  return domains.find((domain) => hostMatchesDomain(host, domain));
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

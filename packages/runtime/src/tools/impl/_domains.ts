// DOMAIN MATCHING for the web tools' one shared `blockedDomains` floor -- a module that REGISTERS
// NOTHING, so both `impl/web-fetch.ts` and `impl/web-search.ts` (and `_exa-client.ts`) may import it.
//
// The matcher itself lives in `@yanlinglabs/winter-web` (`domains.ts` there, with the rule written
// out): ONE implementation, because the floor has one meaning, and the fetcher and the search client
// in that package apply the same floor on every hop and every result.
export { backendExcludableDomains, hostMatchesDomain, isDomainBlocked, matchingDomain, mergeDomainLists, normalizeDomain } from "@yanlinglabs/winter-web";

// @yanlinglabs/winter-web -- web search (Exa) and SSRF-guarded web fetching. Public API: everything
// exported here is covered by semver (see README.md).

// Fetching
export {
  fetchWebResource,
  checkHostAllowed,
  defaultResolveHost,
  isSameHostRedirect,
  reasonPhrase,
  WEB_FETCH_ACCEPT,
  WEB_FETCH_CONNECT_BUDGET_MS,
  WEB_FETCH_DEFAULT_USER_AGENT,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_ENCODED_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_MAX_REDIRECTS_CEILING,
  WEB_FETCH_TIMEOUT_MS,
  type OverflowPolicy,
  type PrivateAddressPolicy,
  type RedirectPolicy,
  type WebFetchFailure,
  type WebFetchFailureCode,
  type WebFetchOptions,
  type WebFetchResult,
  type WebFetchTransport,
  type WebFetchTransportRequest,
  type WebFetchTransportResponse,
  type WebResource,
} from "./net.ts";
export { createNodeWebFetchTransport, type NodeWebFetchTransportOptions } from "./transport-node.ts";
export {
  fetchWebPage,
  classifyContentType,
  WEB_PAGE_LINK_TEXT_MAX_CHARACTERS,
  WEB_PAGE_MAX_LINKS,
  WEB_PAGE_TITLE_MAX_CHARACTERS,
  type FetchWebPageOptions,
  type WebPage,
  type WebPageKind,
  type WebPageLink,
  type WebPageResult,
} from "./page.ts";
export { MemoryWebFetchCache, WEB_FETCH_CACHE_MAX_BYTES, WEB_FETCH_CACHE_TTL_MS, type MemoryWebFetchCacheOptions, type WebFetchCache, type WebFetchCacheEntry } from "./cache.ts";
export {
  buildWebFetchDigestRequest,
  cappedForDigest,
  webFetchDigestPrompt,
  WEB_FETCH_DIGEST_CONTENT_CAP,
  WEB_FETCH_PERMISSIVE_GUIDELINES,
  WEB_FETCH_STRICT_GUIDELINES,
  type WebFetchDigestInput,
  type WebFetchDigestRequest,
} from "./digest.ts";
export { convertFetchedHtml, convertFetchedHtmlPage, decodeHtmlEntities, htmlToMarkdown, HtmlBudgetExceededError, WEB_FETCH_HTML_TRUNCATION_NOTICE, type HtmlAnchor, type HtmlPageConversion } from "./html.ts";

// The rules every hop is checked against
export {
  classifyAddress,
  classifyAddressBytes,
  classifyHostnameLexically,
  classifyIPv4Bytes,
  classifyIPv6Bytes,
  formatAddress,
  hostnameAsAddress,
  isReservedPrivateName,
  parseIPv4,
  parseIPv4Loose,
  parseIPv6,
  parseIpLiteral,
  type AddressRefusalReason,
  type AddressVerdict,
} from "./address.ts";
export { backendExcludableDomains, hostMatchesDomain, isDomainBlocked, matchingDomain, mergeDomainLists, normalizeDomain } from "./domains.ts";
export { fetchTimeUrlRefusal, MAX_URL_LENGTH, unfetchableUrlReason, upgradeToHttps, urlWithoutCredentials, type UnfetchableUrlReason } from "./url.ts";

// Search
export {
  anonymousBreakerOpen,
  classifyExaErrorText,
  createExaBackendState,
  createExaSearchClient,
  exaEndpointUrl,
  parseExaResults,
  sharedExaBackendState,
  EXA_ADVANCED_SEARCH_TOOL,
  EXA_ANONYMOUS_COOLDOWN_MS,
  EXA_ANONYMOUS_MIN_INTERVAL_MS,
  EXA_API_KEY_HEADER,
  EXA_AUTH_PATTERN,
  EXA_CALL_TIMEOUT_MS,
  EXA_CONNECT_TIMEOUT_MS,
  EXA_DEFAULT_NUM_RESULTS,
  EXA_ENABLED_TOOLS,
  EXA_HIGHLIGHTS_MAX_CHARACTERS,
  EXA_MAX_NUM_RESULTS,
  EXA_MAX_RESULT_CHARS,
  EXA_MCP_ENDPOINT,
  EXA_RATE_LIMIT_PATTERN,
  EXA_SEARCH_TOOL,
  EXA_TEXT_MAX_CHARACTERS,
  EXA_TITLE_MAX_CHARACTERS,
  EXA_UNREACHABLE_PATTERN,
  EXA_URL_MAX_CHARACTERS,
  type ExaBackendState,
  type ExaConnection,
  type ExaConnectRequest,
  type ExaErrorClass,
  type ExaKeyResolution,
  type ExaSearchClient,
  type ExaSearchClientOptions,
  type ExaSearchFailureCode,
  type ExaSearchParams,
  type ExaSearchResult,
  type ExaSearchResultItem,
  type ExaTier,
  type ExaToolCallResult,
  type ExaTransport,
} from "./exa.ts";
export type { ExaErrorKind } from "./exa-classify.ts";
export { classifyExaTransportError, createExaMcpHttpTransport, ExaTransportError, EXA_MCP_PROTOCOL_VERSION, type ExaFetch, type ExaMcpHttpTransportOptions, type ExaTransportErrorKind } from "./exa-mcp-http.ts";

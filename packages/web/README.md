# `@yanlinglabs/winter-web`

Web search and web fetching for agents, with the SSRF guard built in: Winter's own `WebSearch` and
`WebFetch` internals as a standalone library. It is what Winter's runtime itself uses, so there is one
copy of the code.

- **`fetchWebPage(url, options)`** fetches a page and hands back markdown (HTML), text, or a binary
  flag. With `privateAddressPolicy: "deny"` -- the default -- no request can reach loopback, the LAN,
  link-local, CGNAT, multicast, cloud metadata or this machine's own addresses, on any hop, whatever
  the URL looks like or the name resolves to.
- **`createExaSearchClient(options)`** searches through Exa's hosted MCP server: anonymous tier first,
  your API key as fallback, with a circuit breaker and a pacer.
- **`buildWebFetchDigestRequest({ text, prompt })`** builds the exact digest prompt Winter's WebFetch
  sends its model; you make the model call.

ESM only. Runs under **Node >= 20** and **Bun >= 1.3**. **No runtime dependencies** -- only `node:*`
built-ins (`http`, `https`, `dns`, `zlib`, `stream`, `os`).

## Install

### From public npm (anyone)

```sh
npm install @yanlinglabs/winter-web
```

Nothing else is needed: the `@yanlinglabs` scope is public on npm.

### From GitHub Packages (the `yanlingLabs` org)

GitHub Packages needs the scope pointed at it and an authenticated read, even for a public package.
In your project's `.npmrc`:

```
@yanlinglabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

…with `GITHUB_TOKEN` in the environment — a personal access token carrying `read:packages`, never a
literal in the file. Then `npm install @yanlinglabs/winter-web` as usual.

**The published package contains COMPILED OUTPUT ONLY.** The tarball ships `dist/` — the bundled
JavaScript and the `.d.ts` declarations — plus `README.md` and `LICENSE`. The TypeScript sources live
at <https://github.com/yanlingLabs/winter-agent-sdk> (`packages/web`).

## Fetching a page

```ts
import { fetchWebPage, MemoryWebFetchCache } from "@yanlinglabs/winter-web";

const cache = new MemoryWebFetchCache(); // optional; one per tenant
const page = await fetchWebPage(urlFromAUser, { signal, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, cache });
if (!page.ok) {
  // page.code: "private_address" | "invalid_url" | "blocked_domain" | "timeout" | ... ; page.message is safe to show
} else {
  page.kind; // "html" | "text" | "binary"
  page.text; // HTML converted to markdown; "" for binary
  page.truncated; // the body hit maxBytes (or the HTML hit the converter's 1,048,576-character cap)
}
```

Nothing here throws for an expected failure: every refusal and every network outcome is a typed
`{ ok: false, code, message, ... }`. Only a programming error (a bug) can throw.

### Options (`fetchWebPage` and `fetchWebResource`)

| Option | Default | |
| --- | --- | --- |
| `privateAddressPolicy` | `"deny"` | `"deny"` unless EXACTLY `"allow"` is passed: any other value, `undefined` included, is deny. |
| `signal` | none | Aborts the whole fetch (`code: "aborted"`). |
| `timeoutMs` | 60 000 | Per hop: DNS, connect, headers and body together (`code: "timeout"`). |
| `maxBytes` | 10 MiB | Cap on the decoded body. |
| `maxEncodedBytes` | 2 MiB | Cap on the compressed bytes of a `Content-Encoding` body (gzip, deflate, br). |
| `onOverflow` | `"truncate"` | `"truncate"` keeps the first `maxBytes` (`truncated: true`); `"fail"` returns `too_large`. |
| `followRedirects` | `"any"` | `"any"`, `"same-host"` (same scheme, port and host, a `www.` prefix ignored), or `(from: URL, to: URL) => boolean`. Every followed hop is re-validated in full. A redirect not followed is `redirect_not_followed` with the target (userinfo removed) in `location`. |
| `maxRedirects` | 10 | Then `too_many_redirects`. |
| `blockedDomains` | `[]` | Hosts never fetched on any hop (suffix match on a label boundary: `example.com` blocks `docs.example.com`, not `notexample.com`). |
| `userAgent` | `winter-web (+https://github.com/yanlingLabs/winter-agent-sdk)` | |
| `cache` (`fetchWebPage` only) | none | Any `WebFetchCache` (`get`/`set`, sync or async). `MemoryWebFetchCache` is a TTL (15 min) + byte-weighted LRU (50 MiB). |
| `resolveHost`, `transport`, `connectBudgetMs` | system resolver, `node:http(s)`, 10 s | Advanced; tests use them. A custom `transport` is only ever handed validated addresses. |

`fetchWebResource(url, options)` is the same fetch returning the raw decoded `body: Uint8Array`
instead of page text. `checkHostAllowed(host, options)` applies the hop rules to a host without
fetching it.

### Failure codes

`invalid_url` (with `reason`: `unparseable`, `too-long`, `embedded-credentials`,
`single-label-hostname`, `unsupported-scheme`), `blocked_domain`, `private_address` (with `reason`),
`unresolvable`, `redirect_not_followed`, `too_many_redirects`, `http_error` (with `status`, the fixed
reason phrase as `statusText`, and a numeric `retryAfter` when sent), `too_large` (`limit`:
`decoded` | `encoded`), `unsupported_encoding`, `timeout`, `aborted`, `network_error` (with `detail`:
an error CODE such as `ECONNREFUSED` or `ERR_TLS_CERT_ALTNAME_INVALID`, never an error message).

No message or field ever carries URL userinfo, a proxy URL or credential, or server-controlled status
text.

## The SSRF guard

Under `"deny"`, for EVERY hop -- the first request and each redirect -- before a byte is sent:

1. **The URL.** `http` is upgraded to `https` (every hop). Refused: anything but http(s), URLs over
   2000 characters, URLs with userinfo, hostnames with fewer than two labels (so `localhost` and every
   IPv6 literal are unfetchable at all).
2. **`blockedDomains`.**
3. **The host, lexically.** An IPv4 literal in ANY notation (`2130706433`, `0177.0.0.1`, `0x7f.1`,
   `127.1`, a trailing dot) is parsed to its bytes and judged like `127.0.0.1`; a numeric-looking host
   that is not a valid literal is refused; `localhost`, `*.localhost`, `local`, `*.local` are refused
   by name, without a lookup; a zone id is refused.
4. **The resolution -- once.** Every address the name resolves to is classified. ANY non-public answer
   refuses the hop: a mixed answer (a public A record and a private AAAA, or two A records) is refused
   as a whole. No answer, or a resolver error, is `unresolvable`.
5. **The connection is pinned.** The socket is opened to the validated address itself, never to the
   name, so nothing resolves the name a second time: a DNS-rebinding answer after the check has nothing
   to act on. The name travels only as the `Host` header and the TLS server name -- certificates are
   validated against the HOSTNAME, as usual (`rejectUnauthorized` is never turned off). Each resolved
   address is tried in order with a 10 s connect budget; one is abandoned only before any response.

**What counts as non-public.** IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local,
169.254.169.254 metadata), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15,
198.51.100/24, 203.0.113/24, 224/4 (multicast), 240/4 and the broadcast address. IPv6: everything
outside 2000::/3, plus fc00::/7 (unique-local, fd00:ec2::254 metadata), fe80::/10, fec0::/10,
ff00::/8, 100::/64, 2001:db8::/32, 3fff::/20, the ORCHID blocks and 64:ff9b:1::/48. IPv4 EMBEDDED in
IPv6 is judged by the IPv4 address it carries: IPv4-mapped (`::ffff:127.0.0.1`, `::ffff:7f00:1`),
IPv4-compatible, IPv4-translated, NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) and Teredo (both the
server and the client address). And any address on one of this machine's own network interfaces.

**How the pinning is enforced, per runtime.** The default transport is `node:http`/`node:https`, the
same code under both runtimes:

- **Node.** The request's `host` is the validated IP literal, so Node's `net` performs no resolution;
  the `lookup` option is pinned to that address as well; and the socket's `remoteAddress` is checked
  against it when the TCP connection comes up -- before the TLS handshake and before any request
  byte -- destroying the request on a mismatch. `agent: false`: no socket is pooled or reused across
  hops. Node's `http`/`https` never consult `HTTP(S)_PROXY` for such a request (also with
  `NODE_USE_ENV_PROXY=1`, tested).
- **Bun.** The same request: an IP-literal `host` (Bun's client does not resolve a literal) and the
  pinned `lookup`. Bun's client exposes no `remoteAddress`, so the post-connect comparison is not
  available there; the first two hold. **Bun's `node:http` honours `HTTPS_PROXY`/`HTTP_PROXY`.** The
  proxy is then handed the pinned literal (`CONNECT 93.184.216.34:443`), never the hostname, so it has
  no name to re-resolve and can reach only the address that was validated, with TLS end to end to the
  origin. Proxy credentials stay inside the runtime: this package never reads the proxy URL, and every
  failure reports an error code, never a message. A proxy that allowlists by hostname may refuse an
  IP-literal `CONNECT`; that surfaces as `http_error` or `network_error`.

Under `"allow"`, private addresses are fetched like any other (still only over https, still pinned).

A cache hit is re-checked before it is served: the blocked domains and, under `"deny"`, the input host
and the cached final host (lexically and by resolution).

## The digest request

```ts
import { buildWebFetchDigestRequest } from "@yanlinglabs/winter-web";

const { system, messages } = buildWebFetchDigestRequest({ text: page.text, prompt: "What does this page say about pricing?" });
// system is undefined (the digest pass has no system prompt); messages is one user message.
```

The page text is capped at 100,000 characters (`[Content truncated due to length...]` appended).
`guidelines: "permissive"` selects the documentation-host guidelines instead of the default strict
ones (quote limits, no lyrics). `url` is accepted but not part of the prompt -- Winter's prompt does not
include it.

## Searching (Exa)

```ts
import { createExaSearchClient, createExaBackendState } from "@yanlinglabs/winter-web";

const search = createExaSearchClient({
  resolveKey: async () => process.env.EXA_API_KEY, // asked only when the free tier is exhausted
});
const result = await search.search({ query: "bun 1.4 release notes", numResults: 5, includeDomains: ["bun.com"] }, { signal });
if (result.ok) {
  for (const r of result.results) r.url, r.title, r.publishedDate, r.text, r.highlights;
} else {
  result.code; // "quota_exhausted" | "rate_limited" | "key_rejected" | "key_unreadable" | "unavailable" | "backend_error" | "timeout" | "aborted" | "blocked_domains"
}
await search.close();
```

- **Anonymous first.** The free tier is tried first; `resolveKey` is called only after it answers
  rate-limited (or refuses anonymous access), and a found key is kept for the client's lifetime. It may
  return a string, `undefined`/`null` (no key), or `{ status: "found", key } | { status: "missing" } |
  { status: "unreadable", message }`; a throwing resolver reads as `key_unreadable`.
- **The key travels only in the `x-api-key` header** -- never in the URL, never in a result or a
  message (backend text that echoes it is scrubbed) -- and the keyed connection never follows a
  redirect.
- **The circuit breaker.** After a rate-limited answer the anonymous tier is skipped for 10 minutes,
  then re-probed; with no key and the breaker open the answer is `quota_exhausted` (with
  `retryAfterMs`) without touching the network. **The pacer** spaces anonymous call starts 500 ms
  apart. Both live in an `ExaBackendState` (no credential in it): every client shares
  `sharedExaBackendState` unless you pass `state: createExaBackendState()` to scope it.
- `text` is the best excerpt (the highlights joined, else the summary, else the page text), at most
  1,200 characters; `numResults` is clamped to 1..20 (default 8). `blockedDomains` on the client is
  excluded from every search and filtered out of every result.
- The default transport is a minimal MCP Streamable HTTP client on the platform `fetch` (JSON and SSE
  responses, size-capped). A host with its own MCP client passes `transport` (`ExaTransport`).

## Supported public API and versioning

**What is supported.** Every name exported from `@yanlinglabs/winter-web`, with the types it declares.
The core is `fetchWebPage`, `fetchWebResource`, the `WebFetchFailure` codes, `WebFetchCache` /
`MemoryWebFetchCache`, `buildWebFetchDigestRequest`, `createExaSearchClient` with its result and
failure codes, and `createExaBackendState` / `sharedExaBackendState`. The rule helpers
(`classifyAddress`, `classifyHostnameLexically`, `isDomainBlocked`, `upgradeToHttps`, ...), the
transports (`createNodeWebFetchTransport`, `createExaMcpHttpTransport`) and their interfaces are
exported for hosts that need them, under the same rules. Anything reached by a deep path (`dist/...`)
is not supported.

**How versions move.** This package is released in lockstep with the rest of the repository, from one
`VERSION`, and every release has a `CHANGELOG.md` entry. While versions are `0.0.x`:

- a release may ADD exports, options, result fields, failure codes and refusal reasons at any time --
  a host that handles an unknown `code` as a generic failure is never broken by one;
- the guard may become STRICTER in any release (a newly refused range, notation or redirect shape)
  -- that is a security fix, not a break;
- a change that can break a host using the supported surface -- a removed or renamed export, a changed
  signature, a narrowed union, a changed default -- ships only under a **"Breaking for winter-web
  hosts"** heading in that release's CHANGELOG entry, naming what to do instead;
- a supported export is deprecated for at least one release before it is removed, unless the removal
  closes a security problem.

Pin an exact version and read the CHANGELOG entry before moving it.

## License

MIT. See [LICENSE](./LICENSE).

// CLAUDE'S "PREAPPROVED HOSTS" LIST FOR `WebFetch` -- extracted, never retyped, from the pinned
// claude 2.1.250 binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.250`'s `claude` executable).
//
// EXTRACTION METHOD (reproducible): `LC_ALL=C grep -a -b -o 'developer\.mozilla\.org' <binary>`
// found two byte offsets (71095476 and 159474768); a handful of other known members
// (`react.dev`, `nextjs.org`, `bun.sh`, `modelcontextprotocol.io`, `git-scm.com`) were grepped the
// same way and clustered tightly around the SECOND offset (159474621..159476142), confirming it as
// the real literal (the first offset was an unrelated string table). `dd if=<binary> bs=1
// skip=159473800 count=3200` over that window, decoded as latin1 (the binary is UTF-8-safe ASCII in
// this region), landed exactly on the source line:
//
//   var c7t=new Set([...92 string literals...]),{HOSTNAME_ONLY:u7t,PATH_PREFIXES:d7t}=(()=>{...})();
//   function wX(e,t){ if(u7t.has(e))return!0; let r=d7t.get(e); if(r){
//     if(/%(25)*(2f|5c|2e)/i.test(t))return!1;
//     for(let o of r)if(t===o||t.startsWith(o+"/"))return!0 } return!1 }
//
// `wX(hostname, pathname)` is the checkPermissions-side matcher; this module is its faithful copy.
// MEASURED, matching the extraction doc's own count exactly: 92 literals, 91 DISTINCT
// (`learn.microsoft.com` is listed twice in the source array), 9 path-scoped.
//
// This module registers no tool and imports nothing from `tools/`, so a permissions lane (auto-allow
// after deny+ask, WS-06/A4) and this tool's own executor both import it with no impl-isolation risk.

/**
 * The 92 literals exactly as they appear in `c7t`'s source order (duplicate `learn.microsoft.com`
 * included) -- kept verbatim so a future re-extraction diffs cleanly against this array.
 */
export const PREAPPROVED_HOST_ENTRIES: readonly string[] = [
  "platform.claude.com",
  "code.claude.com",
  "claude.com/docs",
  "modelcontextprotocol.io",
  "github.com/anthropics",
  "agentskills.io",
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev/doc",
  "go.dev/ref",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",
  "laravel.com",
  "symfony.com",
  "wordpress.org/documentation",
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",
  "asp.net",
  "dotnet.microsoft.com",
  "blazor.net",
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",
  "keras.io",
  "spark.apache.org",
  "huggingface.co/docs",
  "www.kaggle.com/docs",
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",
  "docs.getdbt.com",
  "docs.aws.amazon.com",
  "cloud.google.com",
  "learn.microsoft.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "vercel.com/docs",
  "docs.stripe.com",
  "docs.netlify.com",
  "devcenter.heroku.com",
  "dev.wix.com/docs",
  "cypress.io",
  "selenium.dev",
  "docs.unity.com",
  "docs.unrealengine.com",
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
];

/** `c7t`'s own `HOSTNAME_ONLY` half: entries with no `/`, as an exact-match set. */
const HOSTNAME_ONLY = new Set<string>();
/** `c7t`'s own `PATH_PREFIXES` half: hostname -> every path prefix registered for it. */
const PATH_PREFIXES = new Map<string, string[]>();
for (const entry of PREAPPROVED_HOST_ENTRIES) {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    HOSTNAME_ONLY.add(entry);
  } else {
    const host = entry.slice(0, slash);
    const prefix = entry.slice(slash); // keeps the leading "/"
    const existing = PATH_PREFIXES.get(host);
    if (existing) existing.push(prefix);
    else PATH_PREFIXES.set(host, [prefix]);
  }
}

/** claude's own encoded-slash/backslash/dot guard on the PATH half, verbatim (`/%(25)*(2f|5c|2e)/i`). */
const ENCODED_TRAVERSAL = /%(25)*(2f|5c|2e)/i;

/**
 * `wX(hostname, pathname)`, verbatim: an EXACT hostname match (no subdomains) against the
 * hostname-only half, OR a hostname with a registered path prefix whose pathname is that prefix or a
 * `/`-bounded child of it -- rejected outright when the raw pathname contains an encoded slash,
 * backslash or dot (`%2f`, `%5c`, `%2e`, doubly-encoded or not), which is exactly the traversal class
 * that would otherwise let `/docs%2f..%2fadmin` read as a legitimate child of `/docs`.
 */
export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true;
  const prefixes = PATH_PREFIXES.get(hostname);
  if (prefixes === undefined) return false;
  if (ENCODED_TRAVERSAL.test(pathname)) return false;
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** `isPreapprovedHost`, taking the URL directly. A URL that fails to parse is never preapproved. */
export function isPreapprovedUrl(url: URL): boolean {
  return isPreapprovedHost(url.hostname, url.pathname);
}

/**
 * The registered entry that matched `url`, if any -- distinguishes a bare hostname match from a
 * path-scoped one, and names the scope's prefix, so the redirect walk can ask "does the hop's own
 * path still fall under the SAME scope" rather than only "is this host preapproved at all."
 */
export interface PreapprovedMatch {
  host: string;
  /** `undefined` for a hostname-only entry; the exact `/`-prefixed scope for a path-scoped one. */
  pathPrefix?: string;
}

export function preapprovedScopeOf(url: URL): PreapprovedMatch | undefined {
  const { hostname, pathname } = url;
  if (HOSTNAME_ONLY.has(hostname)) return { host: hostname };
  const prefixes = PATH_PREFIXES.get(hostname);
  if (prefixes === undefined) return undefined;
  if (ENCODED_TRAVERSAL.test(pathname)) return undefined;
  const prefix = prefixes.find((p) => pathname === p || pathname.startsWith(`${p}/`));
  return prefix === undefined ? undefined : { host: hostname, pathPrefix: prefix };
}

/** Whether `url` still falls under the SAME preapproved scope `from` matched -- used by the redirect walk's "not leaving a preapproved path scope" gate. */
export function staysWithinScope(from: PreapprovedMatch, url: URL): boolean {
  if (url.hostname !== from.host) return false;
  if (from.pathPrefix === undefined) return true; // a hostname-only scope covers the whole host
  const { pathname } = url;
  if (ENCODED_TRAVERSAL.test(pathname)) return false;
  return pathname === from.pathPrefix || pathname.startsWith(`${from.pathPrefix}/`);
}

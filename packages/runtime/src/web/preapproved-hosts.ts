// THE "PREAPPROVED HOSTS" LIST FOR `WebFetch` -- the documentation hosts claude treats as
// preapproved: a fetch of one needs no permission prompt, and its content may be passed through as
// markdown instead of going through the digest model.
//
// An entry is either a bare hostname (exact match, no subdomains) or a hostname plus a path prefix
// (the prefix itself or any `/`-bounded child of it, with percent-encoded slashes, backslashes and
// dots refused). 92 entries, 91 distinct (`learn.microsoft.com` is listed twice), 9 path-scoped.
//
// This module registers no tool and imports nothing from `tools/`, so a permissions lane (auto-allow
// after deny+ask, WS-06/A4) and this tool's own executor both import it with no impl-isolation risk.

/** The 92 entries, duplicate `learn.microsoft.com` included. */
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

/** Whether `hostname` + `pathname` (raw strings) fall under a preapproved entry. */
export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true;
  const prefixes = PATH_PREFIXES.get(hostname);
  if (prefixes === undefined) return false;
  if (isTraversalEncoded(pathname)) return false;
  return prefixes.some((prefix) => underPrefix(pathname, prefix));
}

// Hosts listed with no path: every path on them is preapproved.
const HOSTNAME_ONLY = new Set<string>();
// Hosts listed with one or more path prefixes, each prefix keeping its leading `/`, in listing order.
const PATH_PREFIXES = new Map<string, string[]>();
for (const entry of PREAPPROVED_HOST_ENTRIES) {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    HOSTNAME_ONLY.add(entry);
    continue;
  }
  const host = entry.slice(0, slash);
  const prefix = entry.slice(slash);
  const list = PATH_PREFIXES.get(host);
  if (list === undefined) PATH_PREFIXES.set(host, [prefix]);
  else if (!list.includes(prefix)) list.push(prefix);
}

// A percent-encoded slash, backslash or dot, possibly with its `%` itself re-encoded any number of
// times (`%2f`, `%252F`, `%25252e`, ...). A path-scoped match refuses these, since a server may decode
// them into a path that escapes the scope.
const ENCODED_TRAVERSAL = /%(?:25)*(?:2f|5c|2e)/i;

function isTraversalEncoded(pathname: string): boolean {
  return ENCODED_TRAVERSAL.test(pathname);
}

// The prefix itself, or anything below it on a `/` boundary.
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

// `host`, `host` with one leading `www.` removed, and that with `www.` put back -- duplicates dropped.
function wwwVariants(host: string): string[] {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  return [...new Set([host, bare, `www.${bare}`])];
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

/**
 * The preapproved scope `url` falls under, matching its host, that host without a leading `www.`,
 * and that stripped form with `www.` re-added (security review round 2: an exact-host-only match let
 * a redirect chain `claude.com/docs/a` -> `www.claude.com/docs/a` -> `www.claude.com/other` lose its
 * scope at the second hop, so the third, off-scope hop was auto-followed).
 */
export function preapprovedScopeOf(url: URL): PreapprovedMatch | undefined {
  const pathname = url.pathname;
  for (const candidate of wwwVariants(url.hostname)) {
    if (HOSTNAME_ONLY.has(candidate)) return { host: candidate };
    const prefixes = PATH_PREFIXES.get(candidate);
    if (prefixes === undefined) continue;
    if (isTraversalEncoded(pathname)) return undefined;
    const prefix = prefixes.find((p) => underPrefix(pathname, p));
    if (prefix !== undefined) return { host: candidate, pathPrefix: prefix };
  }
  return undefined;
}

/**
 * Whether `url` still falls under the SAME preapproved scope `from` matched -- used by the redirect
 * walk's "not leaving a preapproved path scope" gate. The host may be the scope's own host, that host
 * without a leading `www.`, or that with `www.` re-added (claude follows a same-site www-variant
 * redirect -- security review corrections §4.8).
 */
export function staysWithinScope(from: PreapprovedMatch, url: URL): boolean {
  if (!wwwVariants(from.host).includes(url.hostname)) return false;
  if (from.pathPrefix === undefined) return true;
  if (isTraversalEncoded(url.pathname)) return false;
  return underPrefix(url.pathname, from.pathPrefix);
}

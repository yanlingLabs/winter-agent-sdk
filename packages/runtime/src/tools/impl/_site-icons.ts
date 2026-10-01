// SITE ICONS -- the icon each web tool already KNOWS for the sites its result names, handed to the
// HOST and never to the model. A module that REGISTERS NOTHING (the `_domains.ts` convention).
//
// `WebFetch` learns its page's icon from the HTML it already downloads (`pageIconUrl`: the page's own
// `<link rel="icon" | "shortcut icon" | "apple-touch-icon">`, resolved against the page url, else the
// page origin's `/favicon.ico`); `WebSearch` passes through each Exa hit's `favicon` when the backend
// sends one. Either returns them as `ToolResultPayload.siteIcons`, which the engine writes ONLY onto
// the host-facing frame's `tool_result` block, as `winter_site_icons: [{url, icon_url}]` -- never into
// the model-facing content, the history, the transcript or a provider request (engine.ts, the
// tool-round frame write). A host that ignores the field loses nothing; one that draws site tiles
// (Winter's dispatch pill) draws them from the exact url instead of guessing.
//
// Bounds match what Winter's protocol accepts on its own `tool_result.siteIcons`: at most
// `SITE_ICONS_MAX` entries, each url https, printable ASCII (as `URL#href` serialises it) and at most
// `SITE_ICON_URL_MAX_LENGTH` characters.
import { decodeHtmlEntities } from "./_web-fetch-html.ts";
import type { ToolResultSiteIcon } from "../registry.ts";

export const SITE_ICONS_MAX = 10;
export const SITE_ICON_URL_MAX_LENGTH = 2048;
/** Only the document's head-ish prefix is scanned for `<link>` tags: icons are declared in `<head>`. */
const ICON_SCAN_CHARS = 256 * 1024;

/** A url a host may be handed: https, parseable, no credentials, re-serialised, within the cap. */
export function siteIconHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > SITE_ICON_URL_MAX_LENGTH) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || !isPublicName(parsed.hostname)) return undefined;
  const href = parsed.href;
  return href.length <= SITE_ICON_URL_MAX_LENGTH && /^https:\/\/[!-~]+$/.test(href) ? href : undefined;
}

/** Name suffixes that conventionally stay on the user's own network (mDNS, home routers, corporate
 *  split-horizon DNS). Kept in step with Winter's dispatch pill (`plumePrivateNameSuffixes`). */
const PRIVATE_NAME_SUFFIX = /\.(?:localhost|local|internal|lan|home|home\.arpa|corp|intranet|private)$/;

/**
 * A dotted DNS name a host could fetch an icon from: never an IP literal (v4, or a bracketed v6),
 * never `localhost` or a name under `PRIVATE_NAME_SUFFIX`, never a single label. A lexical
 * check only -- the host that fetches the icon applies its own policy (Winter's pill re-checks every
 * url, redirects included).
 */
function isPublicName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253 || host.startsWith("[") || !host.includes(".")) return false;
  if (host === "localhost" || PRIVATE_NAME_SUFFIX.test(host)) return false;
  const labels = host.split(".");
  return /[a-z]/.test(labels[labels.length - 1]!) && labels.every((l) => l.length > 0 && l.length <= 63);
}

/** A clean list: both urls of each entry checked, one entry per page url (first wins), capped. */
export function collectSiteIcons(entries: Iterable<{ url: unknown; iconUrl: unknown }>): ToolResultSiteIcon[] | undefined {
  const out: ToolResultSiteIcon[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (out.length >= SITE_ICONS_MAX) break;
    const url = siteIconHttpsUrl(e.url);
    const iconUrl = siteIconHttpsUrl(e.iconUrl);
    if (url === undefined || iconUrl === undefined || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, iconUrl });
  }
  return out.length > 0 ? out : undefined;
}

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * The icon `html` declares for the page at `pageUrl`, resolved against it: `apple-touch-icon` (large
 * and opaque) over `icon` / `shortcut icon`, never a `mask-icon` (a monochrome stencil), an SVG (most
 * hosts' image decoders cannot draw one) or a `data:` url. With none declared, the page origin's own
 * `/favicon.ico`. Undefined when the page itself is not https (nothing is handed out for it).
 */
export function pageIconUrl(html: string, pageUrl: string): string | undefined {
  const page = siteIconHttpsUrl(pageUrl);
  if (page === undefined) return undefined;
  const head = html.length > ICON_SCAN_CHARS ? html.slice(0, ICON_SCAN_CHARS) : html;
  let best: { rank: number; href: string } | undefined;
  for (const tag of head.matchAll(LINK_TAG)) {
    const attrs: Record<string, string> = {};
    for (const m of tag[0].matchAll(ATTRIBUTE)) attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    const rel = (attrs["rel"] ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    const href = decodeHtmlEntities(attrs["href"] ?? "").trim();
    const lowered = href.toLowerCase();
    if (href.length === 0 || rel.includes("mask-icon") || lowered.startsWith("data:") || /\.svg(?:[?#]|$)/.test(lowered)) continue;
    const rank = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed") ? 3 : rel.includes("icon") ? 2 : 0;
    if (rank === 0) continue;
    if (best === undefined || rank > best.rank) {
      const resolved = resolveIcon(href, page);
      if (resolved !== undefined) best = { rank, href: resolved };
    }
  }
  return best?.href ?? siteIconHttpsUrl(new URL("/favicon.ico", page).href);
}

function resolveIcon(href: string, page: string): string | undefined {
  try {
    return siteIconHttpsUrl(new URL(href, page).href);
  } catch {
    return undefined;
  }
}

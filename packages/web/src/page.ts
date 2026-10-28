// `fetchWebPage` -- a fetch, read as a page: HTML converted to markdown, text decoded, binary flagged.
import { convertFetchedHtmlPage, WEB_FETCH_HTML_TRUNCATION_NOTICE, type HtmlAnchor } from "./html.ts";
import { MAX_URL_LENGTH } from "./url.ts";
import { checkHostAllowed, fetchWebResource, type WebFetchFailure, type WebFetchOptions } from "./net.ts";
import type { WebFetchCache, WebFetchCacheEntry } from "./cache.ts";

export type WebPageKind = "html" | "text" | "binary";

/** One link of an HTML page: its absolute URL and its text. */
export interface WebPageLink {
  text: string;
  url: string;
}

/** The most links a page reports. */
export const WEB_PAGE_MAX_LINKS = 500;
/** A link's text is cut to this many characters. */
export const WEB_PAGE_LINK_TEXT_MAX_CHARACTERS = 200;
/** A page title is cut to this many characters. */
export const WEB_PAGE_TITLE_MAX_CHARACTERS = 300;

export interface WebPage {
  ok: true;
  /** The URL actually fetched (after the https upgrade and any redirects). */
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  kind: WebPageKind;
  /** HTML as markdown; text as text; `""` for a binary body. */
  text: string;
  /** HTML only: the first `<title>` with text, else the first `<h1>` with text, whitespace collapsed, at most `WEB_PAGE_TITLE_MAX_CHARACTERS`. */
  title?: string;
  /**
   * HTML only (always present for HTML, possibly empty): the page's links in the order their
   * `[text](href)` appears in `text` -- so the nth entry is the nth distinct link a reader of `text`
   * meets. Each URL is absolute (resolved against `finalUrl`), http(s) only, at most `MAX_URL_LENGTH`
   * characters; a URL is listed once, at its first appearance, with that appearance's text (trimmed,
   * at most `WEB_PAGE_LINK_TEXT_MAX_CHARACTERS`; an icon-only link falls back to its `title`, then its
   * `aria-label`). At most `WEB_PAGE_MAX_LINKS`. A relative `href`
   * stays relative in `text`; `<base href>` is not applied.
   */
  links?: WebPageLink[];
  /** A binary body's bytes, only with `binary: "bytes"` (capped by `maxBytes`; `truncated` says when cut). */
  bytes?: Uint8Array;
  /** True when the body was cut at `maxBytes`, or the HTML at the converter's 1,048,576-character input cap. */
  truncated: boolean;
  /** The body's size in bytes after decoding (and any truncation); on a cache hit, the cached text's UTF-8 length. */
  byteLength: number;
  /** True when the page came from `cache`. */
  fromCache: boolean;
}

export type WebPageResult = WebPage | WebFetchFailure;

export interface FetchWebPageOptions extends WebFetchOptions {
  cache?: WebFetchCache;
  /** What a binary body gives back: `"flag"` (the default) is `kind: "binary"` with `text: ""`; `"bytes"` also returns the body as `bytes`. Binary bodies are never cached either way. */
  binary?: "flag" | "bytes";
}

/** How a `Content-Type` is read: HTML, text-like (text/*, JSON, XML, JavaScript, CSV, or none at all), or binary. */
export function classifyContentType(contentType: string): WebPageKind {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html")) return "html";
  if (ct === "" || ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("javascript") || ct.includes("csv")) return "text";
  return "binary";
}

function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** A page's anchors as `WebPage.links`: resolved against `base`, http(s) only, deduplicated by URL at first appearance, capped. */
function linksFrom(anchors: readonly HtmlAnchor[], base: string): WebPageLink[] {
  const links: WebPageLink[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    if (links.length >= WEB_PAGE_MAX_LINKS) break;
    let url: string;
    try {
      const parsed = new URL(anchor.href, base);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      url = parsed.href;
    } catch {
      continue;
    }
    if (url.length > MAX_URL_LENGTH || seen.has(url)) continue;
    seen.add(url);
    links.push({ text: cutText(anchor.text.trim(), WEB_PAGE_LINK_TEXT_MAX_CHARACTERS).trim(), url });
  }
  return links;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

async function cacheGet(cache: WebFetchCache, key: string): Promise<WebFetchCacheEntry | undefined> {
  try {
    return (await cache.get(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function cacheSet(cache: WebFetchCache, key: string, entry: WebFetchCacheEntry): Promise<void> {
  try {
    await cache.set(key, entry);
  } catch {
    /* a failing cache is a cache that did not store */
  }
}

/**
 * Fetches `url` and reads it as a page. Every expected failure is a typed `WebFetchFailure` (see
 * `fetchWebResource`); this function does not throw for them.
 */
export async function fetchWebPage(url: string | URL, options: FetchWebPageOptions = {}): Promise<WebPageResult> {
  const key = url instanceof URL ? url.toString() : url;
  const { cache, binary, ...fetchOptions } = options;
  if (cache !== undefined) {
    const hit = await cacheGet(cache, key);
    if (hit !== undefined) {
      const inputHost = hostOf(key);
      const finalHost = hostOf(hit.finalUrl);
      for (const host of new Set([inputHost, finalHost])) {
        if (host === undefined) continue;
        const refusal = await checkHostAllowed(host, fetchOptions);
        if (refusal !== undefined) return refusal;
      }
      const textBytes = utf8Length(hit.text);
      return {
        ok: true,
        finalUrl: hit.finalUrl,
        status: hit.status,
        statusText: hit.statusText,
        contentType: hit.contentType,
        kind: hit.kind,
        text: hit.text,
        ...(hit.title !== undefined ? { title: hit.title } : {}),
        ...(hit.links !== undefined ? { links: hit.links } : {}),
        truncated: hit.truncated,
        byteLength: textBytes,
        fromCache: true,
      };
    }
  }

  const fetched = await fetchWebResource(url, fetchOptions);
  if (!fetched.ok) return fetched;
  const kind = classifyContentType(fetched.contentType);
  let text = "";
  let title: string | undefined;
  let links: WebPageLink[] | undefined;
  let truncated = fetched.truncated;
  if (kind === "html") {
    const converted = await convertFetchedHtmlPage(new TextDecoder("utf-8", { fatal: false }).decode(fetched.body));
    text = converted.text;
    if (converted.title !== undefined) title = cutText(converted.title, WEB_PAGE_TITLE_MAX_CHARACTERS).trim();
    links = linksFrom(converted.anchors, fetched.finalUrl);
    if (text.endsWith(WEB_FETCH_HTML_TRUNCATION_NOTICE)) truncated = true;
  } else if (kind === "text") {
    text = new TextDecoder("utf-8", { fatal: false }).decode(fetched.body);
  }
  const page: WebPage = {
    ok: true,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    statusText: fetched.statusText,
    contentType: fetched.contentType,
    kind,
    text,
    ...(title !== undefined ? { title } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(kind === "binary" && binary === "bytes" ? { bytes: fetched.body } : {}),
    truncated,
    byteLength: fetched.body.byteLength,
    fromCache: false,
  };
  if (cache !== undefined && kind !== "binary") {
    const bytes = utf8Length(text) + (title !== undefined ? utf8Length(title) : 0) + (links ?? []).reduce((sum, link) => sum + utf8Length(link.url) + utf8Length(link.text), 0);
    await cacheSet(cache, key, { finalUrl: page.finalUrl, status: page.status, statusText: page.statusText, contentType: page.contentType, kind, text, ...(title !== undefined ? { title } : {}), ...(links !== undefined ? { links } : {}), truncated, bytes });
  }
  return page;
}

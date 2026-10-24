// `fetchWebPage` -- a fetch, read as a page: HTML converted to markdown, text decoded, binary flagged.
import { convertFetchedHtml, WEB_FETCH_HTML_TRUNCATION_NOTICE } from "./html.ts";
import { checkHostAllowed, fetchWebResource, type WebFetchFailure, type WebFetchOptions } from "./net.ts";
import type { WebFetchCache, WebFetchCacheEntry } from "./cache.ts";

export type WebPageKind = "html" | "text" | "binary";

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
  const { cache, ...fetchOptions } = options;
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
      return { ok: true, finalUrl: hit.finalUrl, status: hit.status, statusText: hit.statusText, contentType: hit.contentType, kind: hit.kind, text: hit.text, truncated: hit.truncated, byteLength: hit.bytes, fromCache: true };
    }
  }

  const fetched = await fetchWebResource(url, fetchOptions);
  if (!fetched.ok) return fetched;
  const kind = classifyContentType(fetched.contentType);
  let text = "";
  let truncated = fetched.truncated;
  if (kind === "html") {
    text = await convertFetchedHtml(new TextDecoder("utf-8", { fatal: false }).decode(fetched.body));
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
    truncated,
    byteLength: fetched.body.byteLength,
    fromCache: false,
  };
  if (cache !== undefined && kind !== "binary") {
    await cacheSet(cache, key, { finalUrl: page.finalUrl, status: page.status, statusText: page.statusText, contentType: page.contentType, kind, text, truncated, bytes: new TextEncoder().encode(text).byteLength });
  }
  return page;
}

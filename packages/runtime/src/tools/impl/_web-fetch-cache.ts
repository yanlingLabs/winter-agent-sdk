// `WebFetch`'s "self-cleaning cache" (the tool description's own phrase), in a module that
// REGISTERS NOTHING (see `_domains.ts`'s header for why that convention exists).
//
// 15-minute TTL, 50 MiB weighted by the CONVERTED CONTENT's own byte length, LRU, keyed on the
// ORIGINAL input URL string (before the http->https upgrade and before any redirect walk) --
// matching claude's own WebFetch cache. Redirects and non-2xx responses are never cached; only the
// caller (`impl/web-fetch.ts`) knows that distinction, so this module simply never sees them (it has
// no "outcome" concept at all -- only "here is a successful fetch's converted content, remember it").
//
// SCOPED PER SESSION, deliberately (claude's own cache is process-lifetime, one process per session).
// `ctx.sessionId` is the key, NOT `agentId ?? sessionId`: a spawned subagent shares its ROOT
// session's cache exactly as it shares the root's model and credentials (`session-runtime.ts`'s own
// `inheritedWebSessionFacts` precedent) -- a child re-fetching a URL its parent already fetched this
// turn should hit the same cache, not start a cold one.
//
// TEARDOWN IS TWO THINGS (whole-branch review MINOR 4 corrected the header's earlier claim that there
// was no teardown hook at all):
//   - SELF-CLEANING, which this module earns literally: every `get`/`set` for a session first sweeps
//     THAT session's own expired entries, and an emptied session map is deleted outright rather than
//     left as a zero-entry husk.
//   - `forgetSession`, called from the ROOT run's own teardown in `engine.ts` (beside the search
//     client's close). Without it a session that ended holding 50 MiB of live, unexpired entries kept
//     every byte until the TTL happened to be swept by some LATER session -- harmless in the
//     one-process-per-session binary, a real leak on the in-process `query()` path, which is also the
//     one path where session ids are reused within a process. A resumed session therefore starts with
//     a COLD cache, which is what a resumed session gets in claude too (a new process).

import { MemoryWebFetchCache, WEB_FETCH_CACHE_MAX_BYTES, WEB_FETCH_CACHE_TTL_MS } from "@yanlinglabs/winter-web";

export interface WebFetchCacheEntry {
  /** The converted content's own UTF-8 byte length -- the cache's weight unit. */
  bytes: number;
  /** Always a 2xx status: redirects and errors are never cached (the caller enforces this by never calling `set` for them). */
  code: number;
  codeText: string;
  /** The CONVERTED content (markdown, or raw text/passthrough) -- never the inner model's answer, which is why a cache hit still re-runs the digest pass. */
  content: string;
  contentType: string;
  /** The URL actually fetched (after the https upgrade and any auto-followed same-host redirect) -- may differ from the cache key. */
  finalUrl: string;
  /** The page's icon url (`_site-icons.ts`'s `pageIconUrl`), kept so a cache HIT still reports it to the host. */
  iconUrl?: string;
}

export { WEB_FETCH_CACHE_MAX_BYTES, WEB_FETCH_CACHE_TTL_MS } from "@yanlinglabs/winter-web";

export type ClockFn = () => number;

/** One session's store: the TTL + byte-weighted LRU from `@yanlinglabs/winter-web`. */
type SessionCache = MemoryWebFetchCache<WebFetchCacheEntry>;

export class WebFetchCache {
  private readonly sessions = new Map<string, SessionCache>();
  private readonly now: ClockFn;
  private readonly ttlMs: number;
  private readonly maxBytes: number;

  constructor(opts: { now?: ClockFn; ttlMs?: number; maxBytes?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? WEB_FETCH_CACHE_TTL_MS;
    this.maxBytes = opts.maxBytes ?? WEB_FETCH_CACHE_MAX_BYTES;
  }

  get(sessionId: string, url: string): WebFetchCacheEntry | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    const hit = session.get(url);
    if (session.size === 0) this.sessions.delete(sessionId);
    return hit;
  }

  set(sessionId: string, url: string, entry: WebFetchCacheEntry): void {
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      session = new MemoryWebFetchCache<WebFetchCacheEntry>({ ttlMs: this.ttlMs, maxBytes: this.maxBytes, now: this.now });
      this.sessions.set(sessionId, session);
    }
    session.set(url, entry);
    if (session.size === 0) this.sessions.delete(sessionId);
  }

  /**
   * Drops everything cached for `sessionId` (whole-branch review MINOR 4). Called from the ROOT run's
   * teardown; idempotent, and unknown session ids are a no-op.
   */
  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Test/diagnostic only: how many sessions currently hold at least one live entry. */
  sessionCountForTest(): number {
    return this.sessions.size;
  }
}

/** The module-load default: one process-wide cache instance, sessions partitioned by key as documented above. */
export const webFetchCache = new WebFetchCache();

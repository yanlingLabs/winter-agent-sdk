// THE FETCH CACHE -- an interface, and one in-memory implementation of it.
//
// `fetchWebPage` consults a cache only when it is given one. The key is the caller's INPUT URL
// string, exactly as passed (before the https upgrade and any redirect). Only successful fetches of
// text and HTML are stored; redirects, errors and binary bodies never are. A cache hit is re-checked
// against the hop rules before it is served (blocked domains, and -- under "deny" -- the private
// address policy on both the input host and the cached final host), so a policy that tightened
// after an entry was stored still applies to it.
//
// A cache is the caller's to scope: entries are keyed by URL alone, so a host serving several
// tenants (users, sessions) keeps one cache per tenant.

/** One stored page. `bytes` is the entry's weight for a size-bounded cache (the text's UTF-8 length). */
export interface WebFetchCacheEntry {
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  kind: "html" | "text";
  text: string;
  truncated: boolean;
  bytes: number;
}

/** Any store. Both methods may be synchronous or return a promise; a throwing or rejecting cache is treated as a miss. */
export interface WebFetchCache<E = WebFetchCacheEntry> {
  get(key: string): E | undefined | Promise<E | undefined>;
  set(key: string, entry: E): void | Promise<void>;
}

export const WEB_FETCH_CACHE_TTL_MS = 15 * 60_000;
export const WEB_FETCH_CACHE_MAX_BYTES = 50 * 1024 * 1024;

export interface MemoryWebFetchCacheOptions {
  ttlMs?: number;
  /** Total weight (the entries' `bytes`) kept before the least recently used entries are evicted. */
  maxBytes?: number;
  now?: () => number;
}

interface Stored<E> {
  entry: E;
  storedAtMs: number;
}

/**
 * A TTL + LRU store weighted by each entry's `bytes`. Self-cleaning: every `get`/`set` first sweeps
 * the expired entries. An entry heavier than the whole budget is never stored.
 */
export class MemoryWebFetchCache<E extends { bytes: number } = WebFetchCacheEntry> implements WebFetchCache<E> {
  private readonly entries = new Map<string, Stored<E>>();
  private weight = 0;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: MemoryWebFetchCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? WEB_FETCH_CACHE_TTL_MS;
    this.maxBytes = options.maxBytes ?? WEB_FETCH_CACHE_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  private sweepExpired(now: number): void {
    for (const [key, stored] of this.entries) {
      if (now - stored.storedAtMs >= this.ttlMs) {
        this.weight -= stored.entry.bytes;
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): E | undefined {
    this.sweepExpired(this.now());
    const stored = this.entries.get(key);
    if (stored === undefined) return undefined;
    // Re-inserted: a Map iterates in insertion order, so the most recently used key is always last.
    this.entries.delete(key);
    this.entries.set(key, stored);
    return stored.entry;
  }

  set(key: string, entry: E): void {
    const now = this.now();
    this.sweepExpired(now);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.weight -= existing.entry.bytes;
      this.entries.delete(key);
    }
    if (entry.bytes > this.maxBytes) return;
    while (this.weight + entry.bytes > this.maxBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value as string;
      const oldest = this.entries.get(oldestKey)!;
      this.weight -= oldest.entry.bytes;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, { entry, storedAtMs: now });
    this.weight += entry.bytes;
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (existing === undefined) return;
    this.weight -= existing.entry.bytes;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.weight = 0;
  }
}

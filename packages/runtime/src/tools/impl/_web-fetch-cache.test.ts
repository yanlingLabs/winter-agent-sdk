import { describe, expect, test } from "bun:test";
import { WebFetchCache, type WebFetchCacheEntry } from "./_web-fetch-cache.ts";

function entry(content: string, overrides: Partial<WebFetchCacheEntry> = {}): WebFetchCacheEntry {
  return { bytes: Buffer.byteLength(content, "utf8"), code: 200, codeText: "OK", content, contentType: "text/markdown", finalUrl: "https://example.com/", ...overrides };
}

describe("WebFetchCache -- basic get/set", () => {
  test("a miss returns undefined; a hit returns the stored entry", () => {
    const cache = new WebFetchCache();
    expect(cache.get("s1", "https://example.com/")).toBeUndefined();
    cache.set("s1", "https://example.com/", entry("hello"));
    expect(cache.get("s1", "https://example.com/")?.content).toBe("hello");
  });

  test("keyed on the ORIGINAL url string, not the (possibly upgraded/redirected) finalUrl", () => {
    const cache = new WebFetchCache();
    cache.set("s1", "http://example.com/page", entry("x", { finalUrl: "https://example.com/page" }));
    expect(cache.get("s1", "http://example.com/page")?.content).toBe("x");
    expect(cache.get("s1", "https://example.com/page")).toBeUndefined();
  });

  test("sessions are isolated -- one session's entry is invisible to another", () => {
    const cache = new WebFetchCache();
    cache.set("s1", "https://example.com/", entry("for s1"));
    expect(cache.get("s2", "https://example.com/")).toBeUndefined();
  });
});

describe("WebFetchCache -- TTL", () => {
  test("an entry expires after the TTL and a swept miss is a real miss", () => {
    let now = 1_000_000;
    const cache = new WebFetchCache({ now: () => now, ttlMs: 1000 });
    cache.set("s1", "https://example.com/", entry("x"));
    now += 999;
    expect(cache.get("s1", "https://example.com/")?.content).toBe("x");
    now += 2;
    expect(cache.get("s1", "https://example.com/")).toBeUndefined();
  });

  test("an emptied session map is dropped, not left as a husk", () => {
    let now = 0;
    const cache = new WebFetchCache({ now: () => now, ttlMs: 100 });
    cache.set("s1", "https://example.com/", entry("x"));
    expect(cache.sessionCountForTest()).toBe(1);
    now += 200;
    cache.get("s1", "https://example.com/"); // triggers the sweep
    expect(cache.sessionCountForTest()).toBe(0);
  });
});

describe("WebFetchCache -- size / LRU eviction", () => {
  test("adding past the byte budget evicts the LEAST recently used entry first", () => {
    const cache = new WebFetchCache({ maxBytes: 10 });
    cache.set("s1", "u1", entry("aaaaa")); // 5 bytes
    cache.set("s1", "u2", entry("bbbbb")); // 5 bytes, total 10 (at budget)
    cache.set("s1", "u3", entry("ccccc")); // 5 bytes -> evicts u1 (oldest / least recently touched)
    expect(cache.get("s1", "u1")).toBeUndefined();
    expect(cache.get("s1", "u2")?.content).toBe("bbbbb");
    expect(cache.get("s1", "u3")?.content).toBe("ccccc");
  });

  test("a GET touches recency -- a re-read entry survives an eviction that would otherwise take it", () => {
    const cache = new WebFetchCache({ maxBytes: 10 });
    cache.set("s1", "u1", entry("aaaaa"));
    cache.set("s1", "u2", entry("bbbbb"));
    cache.get("s1", "u1"); // u1 is now MORE recently used than u2
    cache.set("s1", "u3", entry("ccccc")); // evicts u2, not u1
    expect(cache.get("s1", "u1")?.content).toBe("aaaaa");
    expect(cache.get("s1", "u2")).toBeUndefined();
  });

  test("a single entry heavier than the whole budget is never cached", () => {
    const cache = new WebFetchCache({ maxBytes: 10 });
    cache.set("s1", "huge", entry("x".repeat(20)));
    expect(cache.get("s1", "huge")).toBeUndefined();
  });

  test("per-session budgets are independent", () => {
    const cache = new WebFetchCache({ maxBytes: 10 });
    cache.set("s1", "u1", entry("aaaaa"));
    cache.set("s2", "u1", entry("bbbbb"));
    cache.set("s2", "u2", entry("ccccc"));
    // s1's own budget is untouched by s2's writes.
    expect(cache.get("s1", "u1")?.content).toBe("aaaaa");
  });
});

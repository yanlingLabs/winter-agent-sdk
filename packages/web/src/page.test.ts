// fetchWebPage (kinds, markdown, the cache and its re-check), the digest request, the HTML converter's
// tokenizer edges, and the node transport's address comparison.
import { harness, isBun, type BunTestModule } from "./harness.test-support.ts";
import assert from "node:assert/strict";
import { fetchWebPage, type FetchWebPageOptions } from "./page.ts";
import { MemoryWebFetchCache, type WebFetchCacheEntry } from "./cache.ts";
import { buildWebFetchDigestRequest, WEB_FETCH_DIGEST_CONTENT_CAP, WEB_FETCH_STRICT_GUIDELINES } from "./digest.ts";
import { convertFetchedHtml, htmlToMarkdown, WEB_FETCH_HTML_TRUNCATION_NOTICE } from "./html.ts";
import http from "node:http";
import net from "node:net";
import { createNodeWebFetchTransport, sameAddress } from "./transport-node.ts";
import { mappedTransport, PUBLIC_A, startHttpsServer, testPki, type TestServer } from "./servers.test-support.ts";

// @ts-ignore -- `bun:test` has no types under the Node-only configs (the fence, this package's own tsconfig); it is imported only under Bun.
const { after, before, describe, test } = await harness(isBun ? ((await import("bun:test")) as unknown as BunTestModule) : undefined);

const skip = testPki() === undefined ? "openssl is not available" : false;

// The loopback server for the whole file (unref'd: it never holds the process open).
const server: TestServer = skip !== false ? (undefined as unknown as TestServer) : await startHttpsServer((req, res) => {
    if (req.url === "/page") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<title>T</title><h1>Head</h1><p>Some <b>bold</b> &amp; <a href='/x'>link</a></p><svg><path d='M0'/></svg><p>after</p>");
      return;
    }
    if (req.url === "/json") {
      res.setHeader("content-type", "application/json");
      res.end('{"a":1}');
      return;
    }
    if (req.url === "/bin") {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    res.end("plain");
  });

describe("fetchWebPage, the cache, the digest and the converter", () => {

  const opts = (over: Partial<FetchWebPageOptions> = {}): FetchWebPageOptions => ({
    transport: mappedTransport(server.port).transport,
    resolveHost: async (host) => (host === "public.test" ? [PUBLIC_A] : host === "rebind.test" ? ["127.0.0.1"] : []),
    ...over,
  });

  describe("fetchWebPage", { skip }, () => {
    test("HTML becomes markdown (an inline SVG icon no longer derails the conversion)", async () => {
      const page = await fetchWebPage(`https://public.test:${server.port}/page`, opts());
      assert.equal(page.ok, true);
      if (page.ok) {
        assert.equal(page.kind, "html");
        assert.equal(page.text, "T\n\nHead\n====\n\nSome **bold** & [link](/x)\n\nafter");
        assert.equal(page.truncated, false);
        assert.equal(page.fromCache, false);
      }
    });

    test("text-like and binary bodies", async () => {
      const json = await fetchWebPage(`https://public.test:${server.port}/json`, opts());
      assert.ok(json.ok && json.kind === "text" && json.text === '{"a":1}');
      const bin = await fetchWebPage(`https://public.test:${server.port}/bin`, opts());
      assert.ok(bin.ok && bin.kind === "binary" && bin.text === "" && bin.byteLength === 4);
    });

    test("a cache hit is served without a fetch, and re-checked against the policy before it is", async () => {
      const cache = new MemoryWebFetchCache();
      const first = await fetchWebPage(`https://public.test:${server.port}/page`, opts({ cache }));
      assert.ok(first.ok && !first.fromCache);
      const hits = server.hits.length;
      const second = await fetchWebPage(`https://public.test:${server.port}/page`, opts({ cache }));
      assert.ok(second.ok && second.fromCache);
      assert.equal(server.hits.length, hits);
      // The same URL, now resolving privately: the cached copy is refused under deny...
      const rebound = await fetchWebPage(`https://public.test:${server.port}/page`, opts({ cache, resolveHost: async () => ["127.0.0.1"] }));
      assert.equal(!rebound.ok && rebound.code, "private_address");
      // ...and when the domain is blocked.
      const blocked = await fetchWebPage(`https://public.test:${server.port}/page`, opts({ cache, blockedDomains: ["public.test"] }));
      assert.equal(!blocked.ok && blocked.code, "blocked_domain");
    });

    test("a cached entry whose FINAL host is private is refused under deny", async () => {
      const cache = new MemoryWebFetchCache();
      const entry: WebFetchCacheEntry = { finalUrl: "https://rebind.test/x", status: 200, statusText: "OK", contentType: "text/plain", kind: "text", text: "cached", truncated: false, bytes: 6 };
      cache.set("https://public.test/start", entry);
      const result = await fetchWebPage("https://public.test/start", opts({ cache }));
      assert.equal(!result.ok && result.code, "private_address");
      const allowed = await fetchWebPage("https://public.test/start", opts({ cache, privateAddressPolicy: "allow" }));
      assert.ok(allowed.ok && allowed.text === "cached");
    });

    test("a cache that throws is a miss, never an error", async () => {
      const cache = { get: () => Promise.reject(new Error("down")), set: () => { throw new Error("down"); } };
      const page = await fetchWebPage(`https://public.test:${server.port}/json`, opts({ cache }));
      assert.ok(page.ok && !page.fromCache);
    });
  });

  describe("MemoryWebFetchCache", () => {
    test("TTL and byte-weighted LRU eviction", () => {
      let now = 0;
      const cache = new MemoryWebFetchCache<{ bytes: number; v: string }>({ ttlMs: 100, maxBytes: 10, now: () => now });
      cache.set("a", { bytes: 4, v: "a" });
      cache.set("b", { bytes: 4, v: "b" });
      assert.equal(cache.get("a")?.v, "a"); // a is now most recent
      cache.set("c", { bytes: 4, v: "c" }); // evicts b
      assert.equal(cache.get("b"), undefined);
      assert.equal(cache.get("a")?.v, "a");
      cache.set("huge", { bytes: 11, v: "x" });
      assert.equal(cache.get("huge"), undefined);
      now = 100;
      assert.equal(cache.get("a"), undefined);
      assert.equal(cache.size, 0);
    });
  });

  describe("buildWebFetchDigestRequest", () => {
    test("the exact digest prompt: one user message, no system prompt", () => {
      const request = buildWebFetchDigestRequest({ text: "PAGE", prompt: "What is it?" });
      assert.equal(request.system, undefined);
      assert.deepEqual(request.messages, [{ role: "user", content: `\nWeb page content:\n---\nPAGE\n---\n\nWhat is it?\n\n${WEB_FETCH_STRICT_GUIDELINES}\n` }]);
    });

    test("the page is capped at 100,000 characters with the notice", () => {
      const content = buildWebFetchDigestRequest({ text: "x".repeat(WEB_FETCH_DIGEST_CONTENT_CAP + 5), prompt: "p", guidelines: "permissive" }).messages[0].content;
      assert.ok(content.includes("x".repeat(WEB_FETCH_DIGEST_CONTENT_CAP) + WEB_FETCH_HTML_TRUNCATION_NOTICE));
      assert.ok(!content.includes("x".repeat(WEB_FETCH_DIGEST_CONTENT_CAP + 1)));
    });
  });

  describe("the HTML converter's tokenizer", () => {
    test("raw text elements hold markup as text; comments, doctypes and PIs vanish", async () => {
      assert.equal(await htmlToMarkdown("<!doctype html><!-- <p>no</p> --><script>if (a</div>) {}</script><p>yes<?pi?></p>"), "yes");
      assert.equal(await htmlToMarkdown("<title>a <b>b</b></title>"), "a <b>b</b>");
    });

    test("an end tag closes everything opened inside it; a stray one is ignored", async () => {
      assert.equal(await htmlToMarkdown("<div><span>hello</div>after</b>"), "hello\n\nafter");
    });

    test("a self-closing element inside svg/math closes itself", async () => {
      assert.equal(await htmlToMarkdown("<p>a</p><svg><g><path d='1'/><circle/></g></svg><p>b</p>"), "a\n\nb");
    });

    test("stray end tags and unclosed start tags cost linear time (1 MB of <i> then </b> used to block ~17 s)", async () => {
      const page = "<i>".repeat(175_000) + "</b>".repeat(130_000);
      const started = Date.now();
      await convertFetchedHtml(page);
      const ms = Date.now() - started;
      assert.ok(ms < 2_000, `took ${ms} ms`);
      const nested = "<div><b>".repeat(60_000) + "</i>".repeat(100_000) + "</b></div>".repeat(60_000);
      const again = Date.now();
      await convertFetchedHtml(nested);
      assert.ok(Date.now() - again < 2_000, "a deep stack closed by matching end tags is linear too");
    });

    test("content over the 1,048,576-character cap is cut and the notice appended", async () => {
      const out = await convertFetchedHtml(`<p>${"y".repeat(1_100_000)}</p>`);
      assert.ok(out.endsWith(WEB_FETCH_HTML_TRUNCATION_NOTICE));
    });
  });

  describe("the node transport's connected-address check", () => {
    test("a socket's remote address must be the pinned one (an IPv4-mapped remote counts as its IPv4 address)", () => {
      assert.equal(sameAddress("127.0.0.1", "127.0.0.1"), true);
      assert.equal(sameAddress("::ffff:127.0.0.1", "127.0.0.1"), true);
      assert.equal(sameAddress("2606:4700:4700:0:0:0:0:1111", "2606:4700:4700::1111"), true);
      assert.equal(sameAddress("127.0.0.2", "127.0.0.1"), false);
      assert.equal(sameAddress("10.0.0.1", "93.184.216.34"), false);
      assert.equal(sameAddress("not-an-address", "127.0.0.1"), false);
    });
  });

  // Bun's http client exposes no `remoteAddress` (see transport-node.ts), so the check is inert there.
  describe("the node transport refuses a socket connected to another address", { skip: isBun ? "Bun's client reports no remoteAddress" : false }, () => {
    test("a socket that connected to an address other than the pinned one is refused before any request byte is sent", async () => {
      // A raw loopback server that counts the bytes it receives. The client socket is made to REPORT a
      // different remote address than the one pinned (the property is patched for sockets to this port only).
      let received = 0;
      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("data", (chunk) => void (received += chunk.length));
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as net.AddressInfo).port;
      // The socket's reported remote address is overridden per socket: http.request is wrapped so an own
      // `remoteAddress` getter lands on the request's socket before the transport's own 'socket' listener
      // runs (the prototype getter is non-configurable under Node, and Bun's socket class is not net.Socket).
      const realRequest = http.request;
      const report = (override: string): void => {
        http.request = ((...args: unknown[]) => {
          const req = (realRequest as (...a: unknown[]) => http.ClientRequest)(...args);
          req.on("socket", (socket: net.Socket) => {
            let proto: object | null = Object.getPrototypeOf(socket);
            let getter: (() => unknown) | undefined;
            while (proto !== null && getter === undefined) {
              getter = Object.getOwnPropertyDescriptor(proto, "remoteAddress")?.get;
              proto = Object.getPrototypeOf(proto);
            }
            assert.ok(getter !== undefined, "remoteAddress is a getter");
            Object.defineProperty(socket, "remoteAddress", { configurable: true, // Bun's client never reports a remote address of its own (the check there is inert), so it is
            // reported at once; Node reports only once connected, and the check waits for 'connect'.
            get: () => (!isBun && getter!.call(socket) === undefined ? undefined : override) });
          });
          return req;
        }) as typeof http.request;
      };
      const request = () => ({
        url: new URL(`http://127.0.0.1:${port}/x`),
        address: "127.0.0.1",
        family: 4 as const,
        serverName: "127.0.0.1",
        headers: { Host: `127.0.0.1:${port}` },
        signal: AbortSignal.timeout(5_000),
      });
      try {
        report("10.9.8.7");
        await assert.rejects(createNodeWebFetchTransport()(request()), (err: unknown) => (err as { code?: string }).code === "ERR_CONNECTED_ADDRESS_MISMATCH");
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(received, 0, "no request byte reached the server");

        // The same socket reporting the pinned address is let through (the server never answers, so abort).
        report("127.0.0.1");
        const controller = new AbortController();
        const pending = createNodeWebFetchTransport()({ ...request(), signal: controller.signal });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(received > 0, "a matching address sends the request");
        controller.abort();
        await assert.rejects(pending);
      } finally {
        http.request = realRequest;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

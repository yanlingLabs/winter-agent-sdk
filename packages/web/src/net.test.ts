// The fetch: SSRF refusals on every hop, against real loopback HTTPS servers and a fake resolver, plus
// the body caps, timeouts and aborts. node:test + node:assert, so it runs under `node --test` and
// `bun test` alike. No live network: every hostname is resolved by a fake, and every "public"
// address is mapped onto a loopback server by the test transport.
import { BUN_TEST, harness, isBun, type BunTestModule } from "./harness.test-support.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { fetchWebResource, type WebFetchOptions, type WebFetchTransportRequest, type WebFetchResult } from "./net.ts";
import { mappedTransport, PUBLIC_A, PUBLIC_B, startHttpsServer, testPki, type TestServer } from "./servers.test-support.ts";

const { after, before, describe, test } = await harness(isBun ? ((await import(BUN_TEST)) as BunTestModule) : undefined);

const pki = testPki();
const skip = pki === undefined ? "openssl is not available" : false;

const resolves: string[] = [];

/** A resolver that maps names to fixed answers and records every lookup. */
function resolver(table: Record<string, readonly string[] | ((n: number) => readonly string[])>) {
  const counts = new Map<string, number>();
  return async (hostname: string): Promise<readonly string[]> => {
    resolves.push(hostname);
    const n = (counts.get(hostname) ?? 0) + 1;
    counts.set(hostname, n);
    const answer = table[hostname];
    if (answer === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return typeof answer === "function" ? answer(n) : answer;
  };
}

function opts(over: Partial<WebFetchOptions> = {}, seen: WebFetchTransportRequest[] = []): WebFetchOptions {
  return { transport: mappedTransport(server.port, seen).transport, resolveHost: resolver({ "public.test": [PUBLIC_A] }), timeoutMs: 5_000, ...over };
}

function expectFailure(result: WebFetchResult, code: string): asserts result is Extract<WebFetchResult, { ok: false }> {
  assert.equal(result.ok, false, `expected a ${code} failure, got success`);
  if (!result.ok) assert.equal(result.code, code, `expected ${code}, got ${result.code} (${result.message})`);
}

// The loopback server for the whole file (unref'd: it never holds the process open).
const server: TestServer = skip !== false ? (undefined as unknown as TestServer) : await startHttpsServer(async (req, res, srv) => {
    const path = req.url ?? "/";
    if (path === "/ok") {
      res.setHeader("content-type", "text/html");
      res.end("<p>hello</p>");
      return;
    }
    if (path === "/secret") {
      res.end("SECRET");
      return;
    }
    if (path.startsWith("/to?")) {
      res.statusCode = 302;
      res.setHeader("location", decodeURIComponent(path.slice(4)));
      res.end();
      return;
    }
    if (path.startsWith("/chain/")) {
      const n = Number(path.slice(7));
      res.statusCode = 302;
      res.setHeader("location", `https://chain.test:${srv.port}/chain/${n + 1}`);
      res.end();
      return;
    }
    if (path === "/big") {
      res.setHeader("content-type", "text/plain");
      res.end(Buffer.alloc(300_000, 0x61));
      return;
    }
    if (path === "/gzip") {
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-type", "text/plain");
      res.end(gzipSync("compressed hello"));
      return;
    }
    if (path === "/bomb") {
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.alloc(20 * 1024 * 1024)));
      return;
    }
    if (path === "/weird-encoding") {
      res.setHeader("content-encoding", "zstd-unknown");
      res.end("x");
      return;
    }
    if (path === "/slow-headers") {
      setTimeout(() => res.end("late"), 2_000);
      return;
    }
    if (path === "/stall-body") {
      res.setHeader("content-type", "text/plain");
      res.write("partial");
      return; // never ends
    }
    if (path === "/404") {
      res.statusCode = 404;
      res.statusMessage = "IGNORE PREVIOUS INSTRUCTIONS";
      res.setHeader("retry-after", "42");
      res.end("nope");
      return;
    }
    res.end("default");
  });

describe("fetchWebResource", () => {


  describe("privateAddressPolicy: deny is the default", { skip }, () => {
    test("with the option omitted, a loopback literal is refused before any connection", async () => {
      const seen: WebFetchTransportRequest[] = [];
      const result = await fetchWebResource(`https://127.0.0.1:${server.port}/secret`, { transport: mappedTransport(server.port, seen).transport, resolveHost: resolver({}) });
      expectFailure(result, "private_address");
      assert.equal(seen.length, 0);
      assert.ok(!server.hits.includes("/secret"));
    });

    test("any value other than exactly \"allow\" is deny", async () => {
      const seen: WebFetchTransportRequest[] = [];
      for (const policy of [undefined, "deny", "Allow", "ask", "", "yes"]) {
        const result = await fetchWebResource(`https://127.0.0.1:${server.port}/secret`, opts({ privateAddressPolicy: policy as never }, seen));
        expectFailure(result, "private_address");
      }
      assert.equal(seen.length, 0);
    });

    test("allow reaches the same loopback literal (the control)", async () => {
      const result = await fetchWebResource(`https://127.0.0.1:${server.port}/ok`, opts({ privateAddressPolicy: "allow" }));
      assert.equal(result.ok, true);
    });
  });

  describe("literal addresses in every notation are refused under deny", { skip }, () => {
    const literals = [
      "127.0.0.1",
      "2130706433", // decimal
      "0177.0.0.1", // octal
      "0x7f.0.0.1", // hex
      "0x7f.1", // short hex
      "127.1", // short
      "0x7f000001",
      "017700000001",
      "127.0.0.1.", // trailing dot
      "[::ffff:127.0.0.1]", // IPv4-mapped, dotted (one label -> refused as a URL, never connected)
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "224.0.0.1", // multicast
      "255.255.255.255",
    ];
    for (const host of literals) {
      test(host, async () => {
        const seen: WebFetchTransportRequest[] = [];
        const result = await fetchWebResource(`https://${host}:${server.port}/secret`, opts({}, seen));
        assert.equal(result.ok, false);
        if (!result.ok) assert.ok(result.code === "private_address" || result.code === "invalid_url", `${host}: ${result.code}`);
        assert.equal(seen.length, 0, `${host} reached the transport`);
      });
    }

    test("IPv6 literals are one label, so they are refused as URLs before the address check even runs", async () => {
      for (const host of ["[::1]", "[::ffff:7f00:1]", "[fd00:ec2::254]", "[fe80::1]", "[64:ff9b::a9fe:a9fe]", "[2002:7f00:1::]"]) {
        const result = await fetchWebResource(`https://${host}/`, opts());
        expectFailure(result, "invalid_url");
      }
    });

    test("a zone id is never a fetchable host", async () => {
      const result = await fetchWebResource("https://[fe80::1%25en0]/", opts());
      expectFailure(result, "invalid_url");
    });

    test("reserved names are refused without a lookup", async () => {
      resolves.length = 0;
      for (const host of ["api.localhost", "printer.local", "localhost.", "LOCALHOST.localhost"]) {
        const result = await fetchWebResource(`https://${host}/`, opts({ resolveHost: resolver({ [host]: [PUBLIC_A] }) }));
        expectFailure(result, "private_address");
      }
      assert.deepEqual(resolves, []);
    });
  });

  describe("resolution: every answer is checked, and the connection is pinned to it", { skip }, () => {
    test("a public-looking name that resolves to loopback is refused (and never dialled)", async () => {
      const seen: WebFetchTransportRequest[] = [];
      const result = await fetchWebResource(`https://rebind.test:${server.port}/secret`, opts({ resolveHost: resolver({ "rebind.test": ["127.0.0.1"] }) }, seen));
      expectFailure(result, "private_address");
      assert.equal(seen.length, 0);
    });

    for (const [label, answer] of [
      ["a mixed A answer (public + private)", [PUBLIC_A, "10.0.0.5"]],
      ["a mixed A/AAAA answer (public A, loopback AAAA)", [PUBLIC_A, "::1"]],
      ["an IPv4-mapped AAAA answer", ["::ffff:127.0.0.1"]],
      ["a NAT64 answer embedding the metadata address", ["64:ff9b::a9fe:a9fe"]],
      ["a 6to4 answer embedding loopback", ["2002:7f00:1::1"]],
      ["the IPv6 metadata address", ["fd00:ec2::254"]],
      ["an unparseable answer", ["not-an-address"]],
    ] as const) {
      test(`${label} refuses the whole host`, async () => {
        const seen: WebFetchTransportRequest[] = [];
        const result = await fetchWebResource(`https://mixed.test:${server.port}/secret`, opts({ resolveHost: resolver({ "mixed.test": answer }) }, seen));
        expectFailure(result, "private_address");
        assert.equal(seen.length, 0);
      });
    }

    test("DNS rebinding: the name is resolved ONCE per hop and the connection goes to that answer, so a later private answer is never used", async () => {
      const seen: WebFetchTransportRequest[] = [];
      resolves.length = 0;
      const result = await fetchWebResource(`https://rebind.test:${server.port}/ok`, opts({ resolveHost: resolver({ "rebind.test": (n) => (n === 1 ? [PUBLIC_A] : ["127.0.0.1"]) }) }, seen));
      assert.equal(result.ok, true);
      assert.deepEqual(resolves, ["rebind.test"]);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.address, PUBLIC_A);
      assert.equal(seen[0]!.url.hostname, PUBLIC_A);
      assert.equal(seen[0]!.serverName, "rebind.test");
      assert.equal(seen[0]!.headers["Host"], `rebind.test:${server.port}`);
      assert.equal(server.hosts.at(-1), `rebind.test:${server.port}`);
    });

    test("a resolver that fails, or answers nothing, refuses (unresolvable) -- never falls open", async () => {
      expectFailure(await fetchWebResource("https://nowhere.test/", opts({ resolveHost: resolver({}) })), "unresolvable");
      expectFailure(await fetchWebResource("https://empty.test/", opts({ resolveHost: resolver({ "empty.test": [] }) })), "unresolvable");
    });

    test("IPv6 public answers connect with a bracketed URL and the address unbracketed", async () => {
      const seen: WebFetchTransportRequest[] = [];
      const result = await fetchWebResource(`https://public.test:${server.port}/ok`, opts({ resolveHost: resolver({ "public.test": [PUBLIC_B] }) }, seen));
      assert.equal(result.ok, true);
      assert.equal(seen[0]!.address, PUBLIC_B);
      assert.equal(seen[0]!.family, 6);
      assert.equal(seen[0]!.url.hostname, `[${PUBLIC_B}]`);
    });
  });

  describe("redirects: every hop is re-validated", { skip }, () => {
    const to = (target: string): string => `https://redirect.test:${server.port}/to?${encodeURIComponent(target)}`;
    const redirectOpts = (over: Partial<WebFetchOptions> = {}, seen: WebFetchTransportRequest[] = []) =>
      opts({ resolveHost: resolver({ "redirect.test": [PUBLIC_A], "chain.test": [PUBLIC_A], "rebind.test": ["127.0.0.1"], "other.test": [PUBLIC_A] }), ...over }, seen);

    for (const target of [
      "https://127.0.0.1:PORT/secret",
      "http://127.0.0.1:PORT/secret",
      "https://10.1.2.3:PORT/secret",
      "https://2130706433:PORT/secret",
      "https://169.254.169.254/latest/meta-data/",
      "https://rebind.test:PORT/secret",
    ]) {
      test(`a redirect to ${target} is refused at the second hop`, async () => {
        const seen: WebFetchTransportRequest[] = [];
        const result = await fetchWebResource(to(target.replace("PORT", String(server.port))), redirectOpts({}, seen));
        expectFailure(result, "private_address");
        assert.equal(seen.length, 1, "only the first hop reached the transport");
        assert.ok(!server.hits.includes("/secret"));
      });
    }

    test("a redirect to [::1] or an IPv4-mapped IPv6 literal is refused (never dialled)", async () => {
      for (const target of [`https://[::1]:${server.port}/secret`, `https://[::ffff:127.0.0.1]:${server.port}/secret`]) {
        const seen: WebFetchTransportRequest[] = [];
        const result = await fetchWebResource(to(target), redirectOpts({}, seen));
        assert.equal(result.ok, false);
        assert.equal(seen.length, 1);
      }
    });

    test("a public redirect is followed, upgraded to https", async () => {
      const result = await fetchWebResource(to(`http://other.test:${server.port}/ok`), redirectOpts());
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.finalUrl, `https://other.test:${server.port}/ok`);
    });

    test("a redirect chain longer than maxRedirects is refused, after exactly maxRedirects follows", async () => {
      const seen: WebFetchTransportRequest[] = [];
      const result = await fetchWebResource(`https://chain.test:${server.port}/chain/0`, redirectOpts({ maxRedirects: 3 }, seen));
      expectFailure(result, "too_many_redirects");
      assert.equal(seen.length, 4);
    });

    test("the default cap is 10 redirects", async () => {
      const seen: WebFetchTransportRequest[] = [];
      const result = await fetchWebResource(`https://chain.test:${server.port}/chain/0`, redirectOpts({}, seen));
      expectFailure(result, "too_many_redirects");
      assert.equal(seen.length, 11);
    });

    test("a maxRedirects that is not a non-negative integer falls back to the default cap of 10 (NaN and Infinity never disable it)", async () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 2.5]) {
        const seen: WebFetchTransportRequest[] = [];
        const result = await fetchWebResource(`https://chain.test:${server.port}/chain/0`, redirectOpts({ maxRedirects: bad }, seen));
        expectFailure(result, "too_many_redirects");
        assert.equal(seen.length, 11, `maxRedirects ${bad}`);
      }
    });

    test("maxRedirects: 0 follows nothing", async () => {
      const seen: WebFetchTransportRequest[] = [];
      const result = await fetchWebResource(`https://chain.test:${server.port}/chain/0`, redirectOpts({ maxRedirects: 0 }, seen));
      expectFailure(result, "too_many_redirects");
      assert.equal(seen.length, 1);
    });

    test("followRedirects: same-host returns a cross-host redirect instead of following it, with the target's userinfo removed", async () => {
      const seen: WebFetchTransportRequest[] = [];
      const result = await fetchWebResource(to("https://user:hunter2@other.test/x"), redirectOpts({ followRedirects: "same-host" }, seen));
      expectFailure(result, "redirect_not_followed");
      if (!result.ok && result.code === "redirect_not_followed") {
        assert.equal(result.location, "https://other.test/x");
        assert.ok(!result.message.includes("hunter2"));
      }
      assert.equal(seen.length, 1);
    });

    test("a non-http(s) Location is never followed and its target never relayed", async () => {
      const result = await fetchWebResource(to("javascript:alert(1)"), redirectOpts());
      expectFailure(result, "redirect_not_followed");
      if (!result.ok && result.code === "redirect_not_followed") assert.equal(result.location, undefined);
    });

    test("a redirect to a blocked domain is refused", async () => {
      const result = await fetchWebResource(to(`https://other.test:${server.port}/ok`), redirectOpts({ blockedDomains: ["other.test"] }));
      expectFailure(result, "blocked_domain");
    });
  });

  describe("URL refusals and safe messages", { skip }, () => {
    test("embedded credentials are refused, and no message or field carries them", async () => {
      const result = await fetchWebResource("https://user:hunter2@public.test/", opts());
      expectFailure(result, "invalid_url");
      assert.ok(!JSON.stringify(result).includes("hunter2"));
    });

    test("an unparseable URL is refused without echoing it", async () => {
      const result = await fetchWebResource("https://user:hunter2@[bad/", opts());
      expectFailure(result, "invalid_url");
      assert.ok(!JSON.stringify(result).includes("hunter2"));
    });

    test("a non-http(s) scheme is refused", async () => {
      expectFailure(await fetchWebResource("ftp://public.test/x", opts()), "invalid_url");
      expectFailure(await fetchWebResource("file:///etc/passwd", opts()), "invalid_url");
    });

    test("a status line's reason phrase never reaches the result (the fixed table does)", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/404`, opts());
      expectFailure(result, "http_error");
      assert.ok(!JSON.stringify(result).includes("IGNORE"));
      if (!result.ok && result.code === "http_error") {
        assert.equal(result.statusText, "Not Found");
        assert.equal(result.retryAfter, "42");
      }
    });

    test("a certificate that does not name the host fails the TLS handshake (validation is by hostname, not by the pinned address)", async () => {
      const result = await fetchWebResource(`https://wrong-name.example:${server.port}/ok`, opts({ resolveHost: resolver({ "wrong-name.example": [PUBLIC_A] }) }));
      expectFailure(result, "network_error");
    });
  });

  describe("body caps, decoding, timeouts and aborts", { skip }, () => {
    test("maxBytes truncates by default", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/big`, opts({ maxBytes: 1000 }));
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.body.byteLength, 1000);
        assert.equal(result.truncated, true);
      }
    });

    test("onOverflow: fail refuses an oversized body", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/big`, opts({ maxBytes: 1000, onOverflow: "fail" }));
      expectFailure(result, "too_large");
      if (!result.ok && result.code === "too_large") assert.equal(result.limit, "decoded");
    });

    test("a body under the cap is whole and not marked truncated", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/big`, opts());
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.body.byteLength, 300_000);
        assert.equal(result.truncated, false);
      }
    });

    test("gzip is decoded", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/gzip`, opts());
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(new TextDecoder().decode(result.body), "compressed hello");
    });

    test("a compression bomb is capped by DECODED bytes", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/bomb`, opts({ maxBytes: 64 * 1024, onOverflow: "fail" }));
      expectFailure(result, "too_large");
      const truncated = await fetchWebResource(`https://public.test:${server.port}/bomb`, opts({ maxBytes: 64 * 1024 }));
      assert.equal(truncated.ok, true);
      if (truncated.ok) assert.equal(truncated.body.byteLength, 64 * 1024);
    });

    test("the compressed input has its own cap", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/bomb`, opts({ maxEncodedBytes: 1024, onOverflow: "fail" }));
      expectFailure(result, "too_large");
      if (!result.ok && result.code === "too_large") assert.equal(result.limit, "encoded");
    });

    test("an unknown Content-Encoding is refused", async () => {
      expectFailure(await fetchWebResource(`https://public.test:${server.port}/weird-encoding`, opts()), "unsupported_encoding");
    });

    test("slow headers past timeoutMs are a timeout", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/slow-headers`, opts({ timeoutMs: 300 }));
      expectFailure(result, "timeout");
    });

    test("a body that stalls past timeoutMs is a timeout, not a truncated success", async () => {
      const result = await fetchWebResource(`https://public.test:${server.port}/stall-body`, opts({ timeoutMs: 400 }));
      expectFailure(result, "timeout");
    });

    test("an abort mid-body is aborted", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const result = await fetchWebResource(`https://public.test:${server.port}/stall-body`, opts({ signal: controller.signal }));
      expectFailure(result, "aborted");
    });

    test("an already-aborted signal is aborted before anything is resolved", async () => {
      resolves.length = 0;
      const result = await fetchWebResource(`https://public.test:${server.port}/ok`, opts({ signal: AbortSignal.abort() }));
      expectFailure(result, "aborted");
      assert.deepEqual(resolves, []);
    });

    test("a resolver that never answers is bounded by timeoutMs", async () => {
      const result = await fetchWebResource("https://hang.test/", opts({ timeoutMs: 200, resolveHost: () => new Promise(() => {}) }));
      expectFailure(result, "timeout");
    });

    test("a connect failure on the first address falls through to the next one; a response is never retried elsewhere", async () => {
      const seen: WebFetchTransportRequest[] = [];
      const mapped = mappedTransport(server.port);
      const transport = (req: WebFetchTransportRequest) => {
        seen.push(req);
        if (req.address === PUBLIC_B) return Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
        return mapped.transport(req);
      };
      const result = await fetchWebResource(`https://public.test:${server.port}/ok`, opts({ transport, resolveHost: resolver({ "public.test": [PUBLIC_B, PUBLIC_A] }) }));
      assert.equal(result.ok, true);
      assert.deepEqual(seen.map((r) => r.address), [PUBLIC_B, PUBLIC_A]);
      seen.length = 0;
      const notFound = await fetchWebResource(`https://public.test:${server.port}/404`, opts({ transport, resolveHost: resolver({ "public.test": [PUBLIC_A, PUBLIC_B] }) }));
      expectFailure(notFound, "http_error");
      assert.deepEqual(seen.map((r) => r.address), [PUBLIC_A]);
    });

    test("every address failing to connect is a network_error carrying only an error code", async () => {
      const transport = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443 via http://proxyuser:proxysecret@proxy"), { code: "ECONNREFUSED" }));
      const result = await fetchWebResource("https://public.test/ok", opts({ transport }));
      expectFailure(result, "network_error");
      if (!result.ok && result.code === "network_error") assert.equal(result.detail, "ECONNREFUSED");
      assert.ok(!JSON.stringify(result).includes("proxysecret"));
    });
  });

  describe("proxies", { skip }, () => {
    test("an HTTPS_PROXY in the environment is either ignored (Node) or handed the pinned address, never the hostname (Bun)", () => {
      // In a child process: the proxy must be set before the runtime's first request.
      const child = spawnSync(process.execPath, [fileURLToPath(new URL("./proxy-child.test-support.ts", import.meta.url))], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env["PATH"] ?? "" } });
      const line = (child.stdout ?? "").trim().split("\n").pop() ?? "";
      const report = JSON.parse(line) as { ok: boolean; code?: string; lines: string[]; expected: string; leaked: boolean };
      assert.equal(report.ok, true, report.code ?? "");
      assert.equal(report.leaked, false);
      for (const seen of report.lines) assert.equal(seen, report.expected, "the proxy was handed something other than the pinned address");
      if (!isBun) assert.deepEqual(report.lines, [], "Node's http client must not use an environment proxy");
    });
  });
});

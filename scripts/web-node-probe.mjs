// THE winter-web PROBE -- plain ESM JavaScript, run against an INSTALLED (or built) copy of
// `@yanlinglabs/winter-web` under Node and under Bun:
//
//   node scripts/web-node-probe.mjs [target]     (default: @yanlinglabs/winter-web)
//   bun  scripts/web-node-probe.mjs [target]
//
// The target is one of three LITERAL choices -- `@yanlinglabs/winter-web` (the installed package),
// `packages/web/dist/index.js` (this checkout's build) or `packages/web/src/index.ts` (its source,
// Bun or a type-stripping Node) -- each its own `import("<literal>")`, never a computed specifier.
//
// No live network: every name is resolved by a fake, every server is on 127.0.0.1, and the TLS
// certificate is made by `openssl` here and thrown away (the TLS legs are skipped, and said so, when
// `openssl` is absent). Prints `WEB PROBE PASS` and exits 0 only when every check held.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2] ?? "@yanlinglabs/winter-web";
const web =
  target === "@yanlinglabs/winter-web" ? await import("@yanlinglabs/winter-web")
  : target === "packages/web/dist/index.js" ? await import("../packages/web/dist/index.js")
  : target === "packages/web/src/index.ts" ? await import("../packages/web/src/index.ts")
  : (console.error(`unknown probe target "${target}"`), process.exit(2));
const runtime = typeof process.versions.bun === "string" ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const failures = [];
const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

// 1. The public surface.
for (const name of ["fetchWebPage", "fetchWebResource", "buildWebFetchDigestRequest", "createExaSearchClient", "createExaBackendState", "sharedExaBackendState", "MemoryWebFetchCache", "createNodeWebFetchTransport", "classifyAddress", "htmlToMarkdown"]) {
  check(`export ${name}`, web[name] !== undefined);
}

// 2. Refusals before any network: literals in several notations, a rebinding name, a mixed answer.
let lookups = 0;
const resolveHost = async (host) => {
  lookups += 1;
  if (host === "rebind.test") return ["127.0.0.1"];
  if (host === "mixed.test") return ["93.184.216.34", "::ffff:10.0.0.1"];
  throw Object.assign(new Error("no"), { code: "ENOTFOUND" });
};
const neverDial = () => Promise.reject(new Error("the transport must not be reached"));
for (const url of ["https://127.0.0.1/", "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://169.254.169.254/latest/meta-data/", "https://[::ffff:127.0.0.1]/", "https://api.localhost/", "https://rebind.test/", "https://mixed.test/"]) {
  const result = await web.fetchWebPage(url, { resolveHost, transport: neverDial });
  check(`deny ${url}`, result.ok === false && (result.code === "private_address" || result.code === "invalid_url"), result.ok ? "fetched" : result.code);
}
check("one lookup per name, none for literals and reserved names", lookups === 2, String(lookups));

// 3. The digest request and the converter.
const digest = web.buildWebFetchDigestRequest({ text: "PAGE", prompt: "Q" });
check("digest", digest.system === undefined && digest.messages.length === 1 && digest.messages[0].content.startsWith("\nWeb page content:\n---\nPAGE\n---\n\nQ\n\n"));
check("markdown", (await web.htmlToMarkdown("<h2>T</h2><p>a <b>b</b></p><svg><path/></svg>")) === "T\n-\n\na **b**");

// 4. End to end over TLS, pinned to 127.0.0.1, through an environment proxy where the runtime uses one.
let tls = "skipped (no openssl)";
const dir = mkdtempSync(join(tmpdir(), "winter-web-probe-"));
try {
  const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  let pki;
  try {
    run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=probe CA"]);
    run(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=probe.test"]);
    writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:probe.test\n");
    run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "1", "-extfile", "ext.cnf"]);
    pki = { ca: readFileSync(join(dir, "ca.crt"), "utf8"), key: readFileSync(join(dir, "leaf.key"), "utf8"), cert: readFileSync(join(dir, "leaf.crt"), "utf8") };
  } catch {
    pki = undefined;
  }
  if (pki !== undefined) {
    const hits = [];
    const server = https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
      hits.push(req.headers.host);
      res.setHeader("content-type", "text/html");
      res.end("<p>probe <i>ok</i></p>");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const transport = web.createNodeWebFetchTransport({ ca: pki.ca });
    const local = async () => ["127.0.0.1"];
    const denied = await web.fetchWebPage(`https://probe.test:${port}/`, { resolveHost: local, transport });
    check("deny: a name resolving to 127.0.0.1", !denied.ok && denied.code === "private_address" && hits.length === 0);
    const allowed = await web.fetchWebPage(`https://probe.test:${port}/`, { resolveHost: local, transport, privateAddressPolicy: "allow" });
    check("allow: fetched over TLS, validated by name", allowed.ok && allowed.text === "probe _ok_" && hits[0] === `probe.test:${port}`, allowed.ok ? allowed.text : allowed.code);

    const proxyLines = [];
    const proxy = http.createServer((_q, s) => {
      proxyLines.push("plain request");
      s.statusCode = 502;
      s.end();
    });
    proxy.on("connect", (req, socket, head) => {
      proxyLines.push(`CONNECT ${req.url}`);
      const [host, p] = String(req.url).split(":");
      if (host !== "127.0.0.1") return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      const up = net.connect(Number(p), host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on("error", () => socket.destroy());
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyUrl = `http://probeuser:probesecret@127.0.0.1:${proxy.address().port}`;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.https_proxy = proxyUrl;
    const viaEnv = await web.fetchWebPage(`https://probe.test:${port}/`, { resolveHost: local, transport, privateAddressPolicy: "allow" });
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    check("with HTTPS_PROXY set: still fetched", viaEnv.ok, viaEnv.ok ? "" : viaEnv.code);
    check("with HTTPS_PROXY set: no credential in the result", !JSON.stringify(viaEnv).includes("probesecret"));
    for (const line of proxyLines) check("the proxy is handed only the pinned address", line === `CONNECT 127.0.0.1:${port}`, line);
    if (typeof process.versions.bun !== "string") check("Node's http client ignores HTTPS_PROXY", proxyLines.length === 0, proxyLines.join(", "));
    tls = `pinned TLS ok; HTTPS_PROXY ${proxyLines.length === 0 ? "not used by this runtime" : `used, saw ${proxyLines.join(", ")}`}`;
    await new Promise((r) => proxy.close(r));
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 5. Exa over the built-in MCP transport: anonymous 429 -> the key, in the header only.
const KEY = "probe-exa-key-0000";
const seen = [];
const exa = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url, body, headers: req.headers });
    if (req.headers["x-api-key"] === undefined) {
      res.statusCode = 429;
      return void res.end('{"error":"Rate limit exceeded"}');
    }
    const msg = JSON.parse(body);
    if (msg.method === "notifications/initialized") {
      res.statusCode = 202;
      return void res.end();
    }
    res.setHeader("content-type", "application/json");
    if (msg.method === "initialize") return void res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://r.example/", title: "R", highlights: ["h"] }] }) }] } }));
  });
});
await new Promise((r) => exa.listen(0, "127.0.0.1", r));
const client = web.createExaSearchClient({ endpoint: `http://127.0.0.1:${exa.address().port}/mcp`, state: web.createExaBackendState(), resolveKey: () => KEY, sleep: async () => {} });
const found = await client.search({ query: "probe" });
await client.close();
check("exa: key fallback", found.ok && found.tier === "key" && found.results[0]?.url === "https://r.example/", found.ok ? found.tier : found.code);
check("exa: the key only in x-api-key", seen.every((s) => !s.url.includes(KEY) && !s.body.includes(KEY) && Object.entries(s.headers).every(([k, v]) => k === "x-api-key" || !String(v).includes(KEY))) && !JSON.stringify(found).includes(KEY));
await new Promise((r) => exa.close(r));

if (failures.length > 0) {
  console.error(`WEB PROBE FAIL (${runtime}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`WEB PROBE PASS (${runtime}; ${tls})`);

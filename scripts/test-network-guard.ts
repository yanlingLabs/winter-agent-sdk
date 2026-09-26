// WS-23: THE TEST SUITE'S NETWORK GUARD -- a `bun test` preload (every package's `bunfig.toml`, and the
// root's for `scripts/`).
//
// WHY. Twice now a hermetic test reached a PAID vendor API: the Anthropic hardening lane, then the
// reasoning-state lane's golden harness. Both built a session with an inline credential ("fixture") and
// no `provider.connection`, so the provider resolved its REAL catalog endpoint and the request went to
// `api.anthropic.com` -- refused with a 401 that time, but a test must never be one config key away from
// spending money or sending a transcript to a vendor. Loopback fakes are the only network a test uses.
//
// WHAT IT DOES. Every outbound path a test can reach is wrapped -- `fetch`, `WebSocket`, `Bun.connect`,
// `node:net` / `node:tls` connects and `node:http` / `node:https` requests -- and a destination that is not
// loopback (127.0.0.0/8, ::1, `localhost`, or a reserved never-resolving name: `.localhost`, `.invalid`,
// `.test`) is REFUSED before a byte leaves: the call throws, and because an adapter may catch and
// normalize that throw (a typed provider error a test could even have expected), the violation is also
// recorded and FAILS the test in a global `afterEach`. A unix-socket path is local by definition.
//
// OPT-IN, NAMED: `WINTER_TEST_ALLOW_REAL_NETWORK=1` switches the guard off for a run. Only a live probe
// sets it (the probe scripts run under `bun run`, not `bun test`, so they never load this file at all; the
// flag exists for a live gate a human deliberately runs through `bun test`). Never set it in CI.
import { afterEach } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";

export const ALLOW_REAL_NETWORK_ENV = "WINTER_TEST_ALLOW_REAL_NETWORK";

const violations: string[] = [];

/** Loopback, or a name reserved never to resolve (RFC 2606 / RFC 6761). */
export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0) return true; // no host: a relative URL or a unix socket
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "::ffff:127.0.0.1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h.endsWith(".localhost") || h.endsWith(".invalid") || h.endsWith(".test") || h === "invalid" || h === "test";
}

function refuse(via: string, where: string): never {
  const line = `${via} -> ${where}`;
  violations.push(line);
  throw new Error(`winter test network guard: refused a non-loopback connection (${line}). Tests talk to loopback fakes only -- a session with no \`provider.connection\` resolves the vendor's REAL endpoint. Set ${ALLOW_REAL_NETWORK_ENV}=1 only for a deliberate live gate.`);
}

function hostOfUrl(input: unknown): { host: string; label: string } | undefined {
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (typeof input === "object" && input !== null && typeof (input as { url?: unknown }).url === "string") raw = (input as { url: string }).url;
  else return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "file:") return undefined;
    return { host: url.hostname, label: `${url.protocol}//${url.host}` };
  } catch {
    return undefined; // a relative or malformed URL never reaches a remote host
  }
}

/** The host a `net.connect` / `tls.connect` / `Bun.connect` / `http.request` argument list names, or `undefined` for a unix socket. */
function hostOfArgs(args: unknown[]): string | undefined {
  const [first, second] = args;
  if (typeof first === "string" || first instanceof URL) {
    const fromUrl = hostOfUrl(first);
    if (fromUrl !== undefined) return fromUrl.host;
    return typeof second === "string" ? second : undefined; // net.connect(path) or connect(port, host)
  }
  if (typeof first === "number") return typeof second === "string" ? second : "localhost";
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: unknown; hostname?: unknown; path?: unknown; socketPath?: unknown; unix?: unknown };
    if (typeof o.unix === "string" || typeof o.socketPath === "string" || (typeof o.path === "string" && o.host === undefined && o.hostname === undefined)) return undefined;
    const host = typeof o.hostname === "string" ? o.hostname : typeof o.host === "string" ? o.host : "localhost";
    return host.replace(/:\d+$/, "");
  }
  return undefined;
}

function guardArgs<T extends (...args: never[]) => unknown>(via: string, original: T): T {
  return function (this: unknown, ...args: unknown[]) {
    const host = hostOfArgs(args);
    if (host !== undefined && !isLocalHost(host)) refuse(via, host);
    return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as T;
}

if (process.env[ALLOW_REAL_NETWORK_ENV] !== "1") {
  const realFetch = globalThis.fetch;
  const guardedFetch = function (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const target = hostOfUrl(input);
    if (target !== undefined && !isLocalHost(target.host)) {
      try {
        refuse("fetch", target.label);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return realFetch(input, init);
  } as typeof fetch;
  Object.assign(guardedFetch, realFetch);
  globalThis.fetch = guardedFetch;

  const RealWebSocket = globalThis.WebSocket;
  if (RealWebSocket !== undefined) {
    globalThis.WebSocket = new Proxy(RealWebSocket, {
      construct(target, args: unknown[]) {
        const dest = hostOfUrl(args[0]);
        if (dest !== undefined && !isLocalHost(dest.host)) refuse("WebSocket", dest.label);
        return Reflect.construct(target, args);
      },
    });
  }

  const bun = Bun as unknown as { connect: (...args: unknown[]) => unknown };
  try {
    bun.connect = guardArgs("Bun.connect", bun.connect.bind(Bun));
  } catch {
    /* not writable on this Bun: fetch and node:net still cover every client path the suites use */
  }
  net.connect = guardArgs("net.connect", net.connect);
  net.createConnection = guardArgs("net.createConnection", net.createConnection);
  tls.connect = guardArgs("tls.connect", tls.connect);
  http.request = guardArgs("http.request", http.request);
  http.get = guardArgs("http.get", http.get);
  https.request = guardArgs("https.request", https.request);
  https.get = guardArgs("https.get", https.get);

  // The guard's throw may be caught and normalized by the code under test; the recorded violation is what
  // fails the test regardless.
  afterEach(() => {
    if (violations.length === 0) return;
    const seen = violations.splice(0);
    throw new Error(`winter test network guard: this test attempted ${seen.length} non-loopback connection(s): ${seen.join("; ")}`);
  });
}

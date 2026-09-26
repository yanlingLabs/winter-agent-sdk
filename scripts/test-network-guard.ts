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
//
// CHILDREN TOO (review r1, M-3). A test that spawns a `bun` child (transport-equivalence spawns the real
// runtime) used to run that child unguarded. Two layers now: every child a test spawns through `Bun.spawn`
// or `node:child_process` that runs `bun` on code gets `--preload` of this guard (a child records a
// violation in the file named by `WINTER_TEST_NETWORK_GUARD_LOG`, and the parent's `afterEach` fails the
// test that spawned it); and EVERY child -- a compiled binary, `curl`, a grandchild -- inherits the proxy
// environment of the recording proxy below, unless it was handed an environment that drops it.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";

export const ALLOW_REAL_NETWORK_ENV = "WINTER_TEST_ALLOW_REAL_NETWORK";

const violations: string[] = [];
const LOG_ENV = "WINTER_TEST_NETWORK_GUARD_LOG";
const PARENT_ENV = "WINTER_TEST_NETWORK_GUARD_PARENT";
/** Set by the child shim BEFORE it loads this file, so a child spawned with an empty environment still knows. */
const CHILD_LOG_GLOBAL = "__winterTestNetworkGuardChildLog";
const childLog = (globalThis as Record<string, unknown>)[CHILD_LOG_GLOBAL] as string | undefined;
/** Is this the `bun test` process itself (not a child it spawned)? */
const isTestRunner = childLog === undefined && (process.env[PARENT_ENV] === undefined || process.env[PARENT_ENV] === String(process.pid));

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
  if (isTestRunner) violations.push(line);
  else {
    const log = childLog ?? process.env[LOG_ENV];
    if (log !== undefined) {
      try {
        appendFileSync(log, `child ${process.pid}: ${line}\n`);
      } catch {
        /* the throw below still refuses the connection */
      }
    }
  }
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

  const bun = Bun as unknown as { connect: (...args: unknown[]) => unknown; fetch: typeof fetch };
  try {
    bun.connect = guardArgs("Bun.connect", bun.connect.bind(Bun));
  } catch {
    /* not writable on this Bun: fetch and node:net still cover every client path the suites use */
  }
  // Review r1, M-3: `Bun.fetch` is a function of its own, not `globalThis.fetch`, and it is NOT wrappable
  // (the `Bun` global is read-only and the property unconfigurable, measured on 1.3.14). It is covered by
  // the recording proxy below instead, which also covers every child process that inherits the environment.
  // Review r1, M-3: `new net.Socket().connect(...)` reaches no module-level export -- the prototype does.
  const socketConnect = net.Socket.prototype.connect as unknown as (...args: never[]) => unknown;
  (net.Socket.prototype as unknown as { connect: unknown }).connect = guardArgs("net.Socket.connect", socketConnect);
  net.connect = guardArgs("net.connect", net.connect);
  net.createConnection = guardArgs("net.createConnection", net.createConnection);
  tls.connect = guardArgs("tls.connect", tls.connect);
  http.request = guardArgs("http.request", http.request);
  http.get = guardArgs("http.get", http.get);
  https.request = guardArgs("https.request", https.request);
  https.get = guardArgs("https.get", https.get);

  if (isTestRunner) {
    // Children: every `bun` this test process spawns loads the guard too, and reports here. `BUN_OPTIONS`
    // takes no quoting, and this checkout's path has spaces, so the preload is a one-line shim in a temp
    // directory (which has none) importing this file by its real path.
    const dir = mkdtempSync(join(tmpdir(), "winter-net-guard-"));
    const log = join(dir, "violations.log");
    writeFileSync(log, "");
    const shim = join(dir, "guard-shim.ts");
    writeFileSync(shim, `(globalThis as Record<string, unknown>)[${JSON.stringify(CHILD_LOG_GLOBAL)}] = ${JSON.stringify(log)};\nawait import(${JSON.stringify(import.meta.path)});\n`);
    process.env[LOG_ENV] = log;
    process.env[PARENT_ENV] = String(process.pid);

    // THE BACKSTOP: a recording HTTP proxy on loopback, named by the proxy environment every HTTP client
    // honours -- `Bun.fetch` (unwrappable above), a child `bun`, a compiled `winter`, `curl`. Loopback is
    // exempt (`NO_PROXY`); anything else reaches this proxy instead of the internet, is refused with a 403,
    // and (unless it names a reserved never-resolving host) fails the test.
    const proxy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        // A CONNECT names `host:port` (no scheme); a plain proxied request names the absolute URL.
        const raw = request.url.includes("://") ? request.url : `http://${request.url}`;
        let target: string;
        try {
          target = new URL(raw).hostname;
        } catch {
          target = raw;
        }
        if (!isLocalHost(target)) violations.push(`proxy (${request.method}) -> ${target}`);
        return new Response("winter test network guard: refused", { status: 403 });
      },
    });
    proxy.unref();
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) process.env[name] = proxyUrl;
    // Review r2: the reserved names (`.invalid`, `.test`, RFC 2606/6761) bypass the proxy too, so a test
    // that points at one still fails at DNS as it always did, not with the proxy's 403.
    for (const name of ["NO_PROXY", "no_proxy"]) process.env[name] = "localhost,127.0.0.1,::1,.localhost,.invalid,.test,invalid,test";
    // A spawn with NO `env` of its own inherits Bun's STARTUP environment, not today's `process.env`
    // (measured: `Bun.spawn` and `node:child_process` both), so the variables above would never reach it.
    // Such a spawn is handed `process.env` explicitly; a spawn that brings its own `env` keeps it as is.
    const withEnv = <O extends { env?: unknown } | undefined>(opts: O): O => (opts !== undefined && opts.env !== undefined ? opts : ({ ...(opts ?? {}), env: { ...process.env } } as O));
    // A child `bun` RUNNING CODE (a file, `-e`, `run <file>`) gets the guard itself too: `--preload` right
    // after the executable. A `bun` subcommand (`build`, `install`, `test`, ...) is left alone -- it runs no
    // test code, and `--preload` in front of it would turn it into a script lookup. (`BUN_OPTIONS` would
    // reach grandchildren too, but it applies to subcommands as well, and breaks `bun build`.)
    const SUBCOMMANDS = new Set(["build", "install", "i", "add", "a", "remove", "rm", "update", "outdated", "pm", "x", "create", "c", "init", "upgrade", "link", "unlink", "patch", "patch-commit", "publish", "test", "audit", "info", "why", "repl", "exec"]);
    const withPreload = (argv: unknown[]): unknown[] => {
      const [cmd, first] = argv;
      if (typeof cmd !== "string" || !/(^|\/)bun(-debug)?$/.test(cmd) || (typeof first === "string" && SUBCOMMANDS.has(first))) return argv;
      // `bun run <file>` takes its flags after `run`; `bun --preload x run f` is a usage error.
      if (first === "run") return [cmd, "run", "--preload", shim, ...argv.slice(2)];
      return [cmd, "--preload", shim, ...argv.slice(1)];
    };
    const bunSpawn = bun as unknown as { spawn: (...args: unknown[]) => unknown; spawnSync: (...args: unknown[]) => unknown };
    for (const name of ["spawn", "spawnSync"] as const) {
      const original = bunSpawn[name].bind(Bun);
      try {
        bunSpawn[name] = (first: unknown, second?: unknown) => {
          if (Array.isArray(first)) return original(withPreload(first), withEnv(second as { env?: unknown } | undefined));
          const opts = first as { cmd?: unknown[]; env?: unknown };
          return original(withEnv({ ...opts, ...(Array.isArray(opts.cmd) ? { cmd: withPreload(opts.cmd) } : {}) }));
        };
      } catch {
        /* not writable on this Bun */
      }
    }
    const cp = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
      const original = cp[name]!;
      cp[name] = (command: unknown, ...rest: unknown[]) => {
        // (command, args?, options?, callback?) -- the options object is the first plain object after the command.
        const hasArgs = Array.isArray(rest[0]);
        const argv = withPreload([command, ...(hasArgs ? (rest[0] as unknown[]) : [])]);
        const tail = hasArgs ? rest.slice(1) : rest;
        const at = tail.findIndex((a) => typeof a === "object" && a !== null && !Array.isArray(a));
        const options = at === -1 ? withEnv(undefined) : withEnv(tail[at] as { env?: unknown });
        const others = tail.filter((_, i) => i !== at);
        return original(argv[0], argv.slice(1), options, ...others);
      };
    }
    // The guard's throw may be caught and normalized by the code under test; the recorded violation is
    // what fails the test regardless. `bun:test` is imported here only: a child is not a test runner.
    const { afterEach } = await import("bun:test");
    afterEach(() => {
      let fromChildren = "";
      try {
        fromChildren = readFileSync(log, "utf8");
        if (fromChildren.length > 0) writeFileSync(log, "");
      } catch {
        /* no log: nothing reported */
      }
      const seen = [...violations.splice(0), ...fromChildren.split("\n").filter((l) => l.length > 0)];
      if (seen.length === 0) return;
      throw new Error(`winter test network guard: this test attempted ${seen.length} non-loopback connection(s): ${seen.join("; ")}`);
    });
  }
}

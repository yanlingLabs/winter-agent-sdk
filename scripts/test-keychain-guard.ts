// THE TEST SUITE'S KEYCHAIN GUARD -- a `bun test` preload, listed FIRST in every package's `bunfig.toml`
// (and the root's), ahead of `test-network-guard.ts`.
//
// WHY. A run of the whole suite raised a macOS consent dialog: "bun wants to use your confidential
// information stored in <Winter's default Keychain service>" (the sdk's `DEFAULT_KEYCHAIN_SERVICE`).
// That is the user's REAL Winter credential store. The path:
// transport-equivalence spawns real `bun src/main.ts` children (and the compiled `winter`), the P6
// provider scenarios name real catalog models, and a child handed no store of its own builds the default
// Keychain store -- on that default service when nothing names another -- and probes `<vendor>:default`
// for credential presence. The items were created by the real Winter binary, so `bun` reading them asks
// for consent; the dialog also HUNG the child, and later real-child tests timed out behind it.
//
// WHAT IT DOES, three layers:
//  1. THE REDIRECT. `WINTER_TEST_KEYCHAIN=memory` (the sdk's `TEST_KEYCHAIN_ENV`, spelled again below: a
//     preload must not import a package) is set on this process. `provider/keychain-store.ts`'s
//     `defaultSecretsBackend()` -- the one site in the repository that may reach the Keychain, pinned by
//     the repo-wide grep tripwire in `keychain-store.test.ts` -- then answers a per-process in-memory
//     backend: every keychain ref reads as absent, every write stays in the process.
//  2. PROPAGATION. Every child a test spawns through `Bun.spawn`/`Bun.spawnSync` or the `node:child_process`
//     module object gets the variable in its environment: an explicit `env` has it added, and a spawn with
//     none is handed `process.env` (a no-env spawn inherits Bun's STARTUP environment, measured by the
//     network guard, so a variable set here would otherwise not reach it). A `bun` child running code also
//     gets `--preload` of this guard, so layers 1 and 3 hold there even if its environment was built from
//     scratch. `query()` itself carries the variable into an explicit `Options.env` (sdk `query.ts`) --
//     that is what covers a host's own spawn hook, a compiled child, and an embedded Worker, whose
//     `process.env` is the session's env -- none of which this preload can reach.
//  3. THE TRIPWIRE. `Bun.secrets` is REPLACED (the property is writable, though not configurable -- measured
//     on Bun 1.3.14) by an object whose every method records a violation and throws. So anything that
//     reaches the real API anyway -- a path that bypasses the redirect, a new call site, a redirect bug --
//     never talks to the Keychain from a test: the test that caused it FAILS in a global `afterEach`
//     (children report through a log file, like the network guard's). A compiled child cannot preload
//     this file; it is protected by layer 1 alone, which is the same code.
//
// THE ONE HOLE: an opt-in gate that measures the real Keychain on a THROWAWAY service
// (`mcp-auth/size-gate.test.ts`, `WINTER_TEST_KEYCHAIN_SIZE_GATE=1`) is forwarded to the real API, and only
// for a service under `THROWAWAY_SERVICE_PREFIX` -- a neutral namespace no product stores items under,
// never the default service (or its dev variant) that holds a user's items.
// The gate unsets the redirect for the length of its own body.
//
// This file names `Bun.secrets` in code, so it is the SECOND file the repo-wide tripwire allows; it only
// ever forwards through the one hole above.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import { promisify } from "node:util";

/** The sdk's `TEST_KEYCHAIN_ENV` / `TEST_KEYCHAIN_MEMORY` (parity pinned in `keychain-store.test.ts`). */
export const TEST_KEYCHAIN_ENV = "WINTER_TEST_KEYCHAIN";
export const TEST_KEYCHAIN_MEMORY = "memory";
/** The opt-in of the real-Keychain measurement gates, and the only services they may touch. */
export const REAL_KEYCHAIN_GATE_ENV = "WINTER_TEST_KEYCHAIN_SIZE_GATE";
export const THROWAWAY_SERVICE_PREFIX = "keychain-test-throwaway.";
/** A marker on the replacement object, so a test can prove the tripwire is what `Bun.secrets` is. */
export const KEYCHAIN_TRIPWIRE_MARKER = Symbol.for("winter.test.keychainTripwire");

const LOG_ENV = "WINTER_TEST_KEYCHAIN_GUARD_LOG";
const PARENT_ENV = "WINTER_TEST_KEYCHAIN_GUARD_PARENT";
/** Set by the child shim BEFORE it loads this file, so a child spawned with an empty environment still knows. */
const CHILD_LOG_GLOBAL = "__winterTestKeychainGuardChildLog";
const childLog = (globalThis as Record<string, unknown>)[CHILD_LOG_GLOBAL] as string | undefined;
const isTestRunner = childLog === undefined && (process.env[PARENT_ENV] === undefined || process.env[PARENT_ENV] === String(process.pid));

const violations: string[] = [];

// Layer 1: every default secrets backend in this process (and, through layer 2, in its children) is the
// in-memory one. The TEST PROCESS forces it, whatever the developer's shell holds. A CHILD keeps a value
// its spawner stated on purpose (the spawn wrappers below add the variable wherever an env does not name
// it, so only a test that writes it explicitly can): that is how the child-tripwire control switches the
// redirect off, and the tripwire below still refuses whatever then reaches the real API.
if (isTestRunner || process.env[TEST_KEYCHAIN_ENV] === undefined) process.env[TEST_KEYCHAIN_ENV] = TEST_KEYCHAIN_MEMORY;

interface SecretsApi {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean | void>;
}

function record(line: string): void {
  if (isTestRunner) {
    violations.push(line);
    return;
  }
  const log = childLog ?? process.env[LOG_ENV];
  if (log === undefined) return;
  try {
    appendFileSync(log, `child ${process.pid}: ${line}\n`);
  } catch {
    /* the throw at the call site still refuses the access */
  }
}

/** Consumes the violations this process recorded so far (the tripwire's own self-test uses it). */
export function takeKeychainGuardViolations(): string[] {
  return violations.splice(0);
}

// Layer 3: the tripwire.
const bun = Bun as unknown as { secrets?: SecretsApi; spawn: (...args: unknown[]) => unknown; spawnSync: (...args: unknown[]) => unknown };
const realSecrets = Bun.secrets as SecretsApi | undefined;
if (realSecrets !== undefined && (realSecrets as unknown as Record<symbol, unknown>)[KEYCHAIN_TRIPWIRE_MARKER] !== true) {
  const guarded = (method: "get" | "set" | "delete") =>
    function (options: { service?: unknown; name?: unknown }) {
      const service = typeof options?.service === "string" ? options.service : "";
      if (process.env[REAL_KEYCHAIN_GATE_ENV] === "1" && service.startsWith(THROWAWAY_SERVICE_PREFIX)) {
        return (realSecrets[method] as (o: unknown) => Promise<unknown>).call(realSecrets, options);
      }
      // The account NAME is not echoed: it can identify a user's item. The service is what matters here.
      const line = `Bun.secrets.${method} on service ${JSON.stringify(service)}`;
      record(line);
      return Promise.reject(new Error(`winter test keychain guard: refused a REAL Keychain access (${line}). Tests never reach the Keychain -- a default secrets backend under test is the in-memory one (${TEST_KEYCHAIN_ENV}=${TEST_KEYCHAIN_MEMORY}); inject a store, or use a throwaway ${THROWAWAY_SERVICE_PREFIX}* service behind ${REAL_KEYCHAIN_GATE_ENV}=1.`));
    };
  const tripwire = { get: guarded("get"), set: guarded("set"), delete: guarded("delete"), [KEYCHAIN_TRIPWIRE_MARKER]: true };
  try {
    bun.secrets = tripwire as unknown as SecretsApi;
  } catch {
    /* not writable on this Bun: layer 1 still redirects every default backend */
  }
}

/** True when the real API in this process is the tripwire above (a self-test checks this before provoking it). */
export function keychainTripwireInstalled(): boolean {
  return (Bun.secrets as unknown as Record<symbol, unknown> | undefined)?.[KEYCHAIN_TRIPWIRE_MARKER] === true;
}

let childShim: string | undefined;
/**
 * The `--preload` path that installs this guard in a `bun` child (test process only), for a test that
 * wants its child to carry the tripwire explicitly rather than through the spawn wrappers below.
 * (Measured on Bun 1.3.14: the wrappers DO reach a named `node:child_process` import such as
 * `transport.ts`'s `defaultSpawn` in a module loaded after this preload.)
 */
export function keychainGuardChildPreload(): string | undefined {
  return childShim;
}

// Layer 2: propagation, in the test process only (a child's own children inherit its environment,
// which layer 1 has already set).
if (isTestRunner) {
  const dir = mkdtempSync(join(tmpdir(), "winter-keychain-guard-"));
  const log = join(dir, "violations.log");
  writeFileSync(log, "");
  // `BUN_OPTIONS` takes no quoting and this checkout's path may have spaces, so the preload is a one-line
  // shim in a temp directory importing this file by its real path (the network guard's own device).
  const shim = join(dir, "keychain-guard-shim.ts");
  childShim = shim;
  writeFileSync(shim, `(globalThis as Record<string, unknown>)[${JSON.stringify(CHILD_LOG_GLOBAL)}] = ${JSON.stringify(log)};\nawait import(${JSON.stringify(import.meta.path)});\n`);
  process.env[LOG_ENV] = log;
  process.env[PARENT_ENV] = String(process.pid);

  /**
   * An explicit env gets the redirect added; a missing one becomes today's `process.env` (which carries
   * it). An env that already NAMES the variable keeps its value: only a test can write that, on purpose
   * (the child-tripwire control does), and the child's tripwire still refuses whatever reaches the real API.
   */
  const withRedirect = <O extends { env?: unknown } | undefined>(opts: O): O => {
    if (opts !== undefined && opts !== null && typeof opts.env === "object" && opts.env !== null) {
      const env = opts.env as Record<string, unknown>;
      return { ...opts, env: { [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY, ...env, [LOG_ENV]: log } } as O;
    }
    return { ...(opts ?? {}), env: { ...process.env } } as O;
  };
  // Same rule as the network guard's: a `bun` RUNNING CODE gets `--preload`; a `bun` subcommand does not.
  const SUBCOMMANDS = new Set(["build", "install", "i", "add", "a", "remove", "rm", "update", "outdated", "pm", "x", "create", "c", "init", "upgrade", "link", "unlink", "patch", "patch-commit", "publish", "test", "audit", "info", "why", "repl", "exec"]);
  const withPreload = (argv: unknown[]): unknown[] => {
    const [cmd, first] = argv;
    if (typeof cmd !== "string" || !/(^|\/)bun(-debug)?$/.test(cmd) || (typeof first === "string" && SUBCOMMANDS.has(first))) return argv;
    if (first === "run") return [cmd, "run", "--preload", shim, ...argv.slice(2)];
    return [cmd, "--preload", shim, ...argv.slice(1)];
  };

  for (const name of ["spawn", "spawnSync"] as const) {
    const original = bun[name].bind(Bun);
    try {
      bun[name] = (first: unknown, second?: unknown) => {
        if (Array.isArray(first)) return original(withPreload(first), withRedirect(second as { env?: unknown } | undefined));
        const opts = first as { cmd?: unknown[]; env?: unknown };
        return original(withRedirect({ ...opts, ...(Array.isArray(opts.cmd) ? { cmd: withPreload(opts.cmd) } : {}) }));
      };
    } catch {
      /* not writable on this Bun */
    }
  }
  const cp = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  // The shell doors, `(command, options?, callback?)`: environment only (a shell string is never rewritten).
  for (const name of ["exec", "execSync"]) {
    const original = cp[name]!;
    const wrapped = (command: unknown, ...rest: unknown[]) => {
      const at = rest.findIndex((a) => typeof a === "object" && a !== null && !Array.isArray(a));
      if (at !== -1) return original(command, ...rest.map((a, i) => (i === at ? withRedirect(a as { env?: unknown }) : a)));
      if (rest.length > 0 && (rest[0] === null || rest[0] === undefined)) return original(command, withRedirect(undefined), ...rest.slice(1));
      return original(command, withRedirect(undefined), ...rest);
    };
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
    if (custom !== undefined) Object.defineProperty(wrapped, promisify.custom, { value: custom, configurable: true });
    cp[name] = wrapped;
  }
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = cp[name]!;
    cp[name] = (command: unknown, ...rest: unknown[]) => {
      const hasArgs = Array.isArray(rest[0]);
      const argv = withPreload([command, ...(hasArgs ? (rest[0] as unknown[]) : [])]);
      const tail = hasArgs ? rest.slice(1) : rest;
      const at = tail.findIndex((a) => typeof a === "object" && a !== null && !Array.isArray(a));
      const options = at === -1 ? withRedirect(undefined) : withRedirect(tail[at] as { env?: unknown });
      const others = tail.filter((_, i) => i !== at);
      return original(argv[0], argv.slice(1), options, ...others);
    };
  }

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
    throw new Error(`winter test keychain guard: this test reached the REAL Keychain API ${seen.length} time(s): ${seen.join("; ")}`);
  });
}

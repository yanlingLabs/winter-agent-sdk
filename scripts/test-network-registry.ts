// WS-23 (release CI fix): THE ONE HOLE IN THE TEST NETWORK GUARD -- the public npm registry, for the
// release gates that exist to talk to it, and for nothing else.
//
// WHY. `scripts/test-network-guard.ts` refuses every non-loopback connection a test makes, in process
// and in every child (through its recording proxy). A handful of tests are network legs BY DESIGN, gated
// on `CI` / `WINTER_TEST_PACK_SMOKE=1` and marked BLOCKING in `release.yml`/`ci.yml`: the pack -> install
// -> import smoke (`smoke-installed.test.ts`, whose `npm install` primes npm's cache with the third-party
// runtime dependencies from the registry) and the official fixture's exact CI step
// (`compile-fixtures.test.ts`, which fetches the pinned upstream tarball and lets npm install its
// dependencies). The v0.0.25 release run failed on exactly those, on a runner whose npm cache was cold
// (they had only ever passed where a warm cache meant npm never went online).
//
// WHY NOT AN ALLOWLIST INSIDE THE RECORDING PROXY. The proxy is a `Bun.serve` in the test process, and
// the smoke spawns npm with `Bun.spawnSync`, which BLOCKS that process's event loop: the proxy cannot
// answer anything while npm waits on it (that is the 120 s hang and the `exit null` in the log, and the
// CONNECT it recorded once the loop came back is what failed the NEXT tests). `Bun.serve` cannot tunnel
// a CONNECT either. So the hole is cut where the traffic starts instead: for the length of ONE opted-in
// call, `registry.npmjs.org` joins `NO_PROXY` (children connect to it directly; every other host still
// goes to the proxy and still fails the test), and the guard's in-process `fetch` lets an HTTPS request to
// that one host through (`npmRegistryAccessOpen`, read by the guard).
//
// NO CREDENTIAL RIDES THE HOLE. Inside the scope npm is handed an EMPTY user and global config and the
// registry is pinned to the public one, and every token-shaped variable is removed (`NODE_AUTH_TOKEN` --
// `release.yml`'s publish job exports it, `NPM_TOKEN`, any `npm_config_*` auth/token/password key), so
// neither a runner's publish credential nor a developer's own `~/.npmrc` login can reach the registry
// through a test. The guard also refuses an allowlisted fetch that carries an `Authorization` or `Cookie`
// header. Everything is restored when the call settles, thrown or not.
//
// SIDE-EFFECT FREE ON PURPOSE: importing `test-network-guard.ts` INSTALLS the guard, so the opt-in and the
// allowlist live here, where both a test and the guard can import them.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The one host the opt-in opens: the public npm registry (packuments AND tarballs are served from it). */
export const NPM_REGISTRY_HOST = "registry.npmjs.org";
const NPM_REGISTRY_URL = `https://${NPM_REGISTRY_HOST}/`;

const OPEN = Symbol.for("@yanlinglabs/winter-test-network-guard:npm-registry-open");

function openScopes(): number {
  return ((globalThis as Record<symbol, unknown>)[OPEN] as number | undefined) ?? 0;
}

/** Is a `withNpmRegistryAccess` call in flight in this process? Read by the guard's `fetch` wrapper. */
export function npmRegistryAccessOpen(): boolean {
  return openScopes() > 0;
}

/** A variable that can carry a registry credential: the tokens CI and npm read, and any npm auth config key. */
function isCredentialVariable(name: string): boolean {
  const n = name.toLowerCase();
  if (n === "node_auth_token" || n === "npm_token") return true;
  return n.startsWith("npm_config_") && /auth|token|password|passwd|_secret/.test(n);
}

/**
 * Runs `fn` with `registry.npmjs.org` reachable -- from `fetch` in this process and from every child it
 * spawns -- and with no registry credential anywhere in the environment. For the network legs only.
 */
export async function withNpmRegistryAccess<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  const set = (name: string, value: string | undefined): void => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const configDir = mkdtempSync(join(tmpdir(), "winter-npm-registry-config-"));
  // Two files: npm refuses one file loaded as both "user" and "global" ("double-loading config").
  const emptyUserConfig = join(configDir, "user-npmrc");
  const emptyGlobalConfig = join(configDir, "global-npmrc");
  writeFileSync(emptyUserConfig, "");
  writeFileSync(emptyGlobalConfig, "");
  const g = globalThis as Record<symbol, unknown>;
  g[OPEN] = openScopes() + 1;
  try {
    for (const name of Object.keys(process.env)) if (isCredentialVariable(name)) set(name, undefined);
    // npm reads `npm_config_*` case-insensitively, and `setup-node` exports `NPM_CONFIG_USERCONFIG`
    // upper-case: exactly one spelling of each key may survive, or which one wins is npm's choice.
    for (const name of Object.keys(process.env)) {
      if (/^npm_config_(userconfig|globalconfig|registry)$/i.test(name)) set(name, undefined);
    }
    set("npm_config_userconfig", emptyUserConfig);
    set("npm_config_globalconfig", emptyGlobalConfig);
    set("npm_config_registry", NPM_REGISTRY_URL);
    for (const name of ["NO_PROXY", "no_proxy"]) {
      const current = process.env[name];
      set(name, current === undefined || current === "" ? NPM_REGISTRY_HOST : `${current},${NPM_REGISTRY_HOST}`);
    }
    return await fn();
  } finally {
    g[OPEN] = openScopes() - 1;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
}

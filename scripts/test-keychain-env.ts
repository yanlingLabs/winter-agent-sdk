// The test Keychain redirect, for code that runs OUTSIDE `bun test` -- the compiled-binary gates
// (`scripts/verify-*.ts`) and `scripts/differential.ts`, which run under `bun run` and so never load the
// test preload (`./test-keychain-guard.ts`).
//
// WHY. Those scripts start real sessions -- in process, or as the compiled `winter` -- on REAL catalog
// models. A session handed no store of its own builds the default Keychain store and probes
// `<vendor>:default` for credential presence; on a machine with Winter installed that is the user's real
// credential store, and macOS raises a consent dialog (which also hangs the child). The redirect makes
// every default secrets backend an in-memory one (`provider/keychain-store.ts`).
//
// HOW TO USE IT. Call `isolateKeychain()` at the top of the script (every in-process session), and build
// each spawned child's environment with `keychainIsolatedEnv(...)`: a spawn with no `env` inherits Bun's
// STARTUP environment, which a later assignment to `process.env` never reaches.
//
// Deliberately NOT used by `verify-provider-live.ts`: that is the operator's live gate, which reads real
// credentials from a Keychain service the operator names (`requireLiveKeychainService`) on purpose, and
// which `bun test` can never drive (its test refuses every Keychain selector).
//
// Importing it does nothing (the test preload imports the constants, and must not have the variable forced
// on a child whose spawner stated it on purpose).

/** The sdk's `TEST_KEYCHAIN_ENV` / `TEST_KEYCHAIN_MEMORY` (parity pinned in `keychain-store.test.ts`). */
export const TEST_KEYCHAIN_ENV = "WINTER_TEST_KEYCHAIN";
export const TEST_KEYCHAIN_MEMORY = "memory";

/** Sets the redirect on THIS process (every in-process session). Idempotent. */
export function isolateKeychain(): void {
  process.env[TEST_KEYCHAIN_ENV] = TEST_KEYCHAIN_MEMORY;
}

/** A child environment carrying the redirect -- `process.env` when none is given. The redirect is applied LAST. */
export function keychainIsolatedEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  out[TEST_KEYCHAIN_ENV] = TEST_KEYCHAIN_MEMORY;
  return out;
}

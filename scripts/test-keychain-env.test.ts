// The scripts that run OUTSIDE `bun test` -- the compiled-binary gates and the differential -- never reach
// the real Keychain: each sets the redirect on itself and hands it to every child it spawns with an
// environment of its own (`./test-keychain-env.ts`). A grep, because these scripts build real binaries and
// are not something a unit test can run.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY, keychainIsolatedEnv } from "./test-keychain-env.ts";

/** Scripts exempt from the redirect, each with the reason. Nothing else may be. */
const EXEMPT: Record<string, string> = {
  "verify-provider-live.ts": "the operator's LIVE gate: it reads real credentials from a Keychain service the operator names, on purpose, and its test refuses every Keychain selector",
  "verify-mcp-oauth-login-entry.ts": "a compiled ENTRY, not a script: it writes to the test FILE store named by --store, and verify-mcp-oauth.ts spawns it with the redirect",
};

const GUARDED = [...readdirSync(import.meta.dir).filter((f) => /^verify-.*\.ts$/.test(f) && !f.endsWith(".test.ts")), "differential.ts"].sort();

describe("scripts outside `bun test` keep off the real Keychain", () => {
  test("the sweep sees the gates (not vacuous)", () => {
    for (const f of ["verify-protocol-compiled.ts", "verify-mcp-compiled.ts", "verify-mcp-oauth.ts", "verify-workflow.ts", "differential.ts"]) expect(GUARDED).toContain(f);
  });

  for (const file of GUARDED) {
    if (EXEMPT[file] !== undefined) continue;
    test(`${file} sets the redirect on itself, and never hands a child a literal env without it`, () => {
      const code = readFileSync(join(import.meta.dir, file), "utf8");
      expect(code).toMatch(/^import \{[^}]*\bisolateKeychain\b[^}]*\} from "\.\/test-keychain-env\.ts";$/m);
      expect(code).toMatch(/^isolateKeychain\(\);$/m);
      // Every child environment written as an object literal goes through `keychainIsolatedEnv(...)`.
      const bare = code.split("\n").map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => /\benv:\s*\{/.test(line) && !line.trimStart().startsWith("//"));
      expect(bare.map(({ n, line }) => `${file}:${n}: ${line.trim()}`)).toEqual([]);
    });
  }

  test("every exemption names a file that exists", () => {
    for (const file of Object.keys(EXEMPT)) expect(GUARDED).toContain(file);
  });

  test("keychainIsolatedEnv: the redirect is applied LAST and nothing else changes", () => {
    expect(keychainIsolatedEnv({ PATH: "/bin", [TEST_KEYCHAIN_ENV]: "", DROPPED: undefined })).toEqual({ PATH: "/bin", [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY });
  });
});

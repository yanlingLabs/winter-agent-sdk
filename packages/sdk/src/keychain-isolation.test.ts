// The Keychain-dialog incident, end to end: a REAL runtime child (`bun src/main.ts`, the dev-child leg
// transport-equivalence uses) on a REAL catalog model with a KEYCHAIN authRef and no keychain service of
// its own -- exactly the shape that made macOS ask whether `bun` may read `com.winter.core` -- must never
// reach the real Keychain under test.
//
// Two layers are proven in the child (see `scripts/test-keychain-guard.ts`):
//  - the REDIRECT: `WINTER_TEST_KEYCHAIN=memory` reaches the child through `query()` even though the host
//    hands it an explicit, minimal `env`, so the credential reads as ABSENT, never the `io` failure the
//    tripwire would produce;
//  - the TRIPWIRE, live in the child: a CONTROL child with the redirect switched off reaches the real API
//    and is refused and REPORTED -- on a `keychain-test-throwaway.*` service that holds no item, so even a broken
//    guard could not raise a dialog there.
import { describe, test, expect, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SdkMessage as SDKMessage } from "./query.ts";
import { defaultSpawn, type SpawnClaudeCodeProcess } from "./transport.ts";
import { TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY, type Options } from "./options.ts";
import { SCENARIO_MODELS, startScenarioFake, type ScenarioFake } from "@yanlinglabs/winter-agent-runtime";
import { keychainGuardChildPreload } from "../../../scripts/test-keychain-guard.ts";

const mainPath = fileURLToPath(new URL("../../runtime/src/main.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "winter-keychain-isolation-"));
const cwd = mkdtempSync(join(tmpdir(), "winter-keychain-isolation-cwd-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** The file every guarded child reports a real-Keychain access to (set by the test preload). */
function guardLog(): string {
  const log = process.env.WINTER_TEST_KEYCHAIN_GUARD_LOG;
  if (log === undefined) throw new Error("the test keychain guard preload is not active in this process");
  return log;
}

/** A child hook: the real dev-child leg, WITH the keychain guard preloaded, on exactly the env `query()` resolved. */
function guardedChild(seen: { env?: Record<string, string> }): SpawnClaudeCodeProcess {
  const preload = keychainGuardChildPreload();
  if (preload === undefined) throw new Error("the test keychain guard preload is not active in this process");
  return (opts) => {
    seen.env = opts.env;
    return defaultSpawn({ ...opts, command: process.execPath, args: ["--preload", preload, mainPath, ...opts.args] });
  };
}

async function runTurn(fake: ScenarioFake, env: Record<string, string>, extra: Partial<Options>, seen: { env?: Record<string, string> }): Promise<{ messages: SDKMessage[]; thrown: unknown }> {
  const messages: SDKMessage[] = [];
  let thrown: unknown;
  try {
    for await (const message of query({
      prompt: "hello",
      options: {
        cwd,
        env,
        model: SCENARIO_MODELS.anthropic,
        // A KEYCHAIN ref on the vendor's default account, no keychain service: the child's default store
        // would be `com.winter.core` -- the user's real one -- were it not redirected.
        provider: { providerId: "anthropic", authRef: { kind: "keychain", account: "anthropic:default" }, connection: { baseUrl: fake.url, local: true } },
        spawnClaudeCodeProcess: guardedChild(seen),
        ...extra,
      },
    })) {
      messages.push(message);
    }
  } catch (err) {
    thrown = err;
  }
  return { messages, thrown };
}

function isCredentialHeader(name: string): boolean {
  return ["x-api-key", "authorization", "x-goog-api-key", "api-key"].includes(name.toLowerCase());
}

function minimalEnv(): Record<string, string> {
  // Explicit and minimal ON PURPOSE: no WINTER_TEST_KEYCHAIN here -- `query()` must add it.
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? home, WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" };
}

describe("a real runtime child never reaches the real Keychain under test", () => {
  test("keychain authRef on a real catalog model, explicit minimal env: the child reads the credential as ABSENT from memory, and reaches the real API zero times", async () => {
    const fake = await startScenarioFake();
    try {
      writeFileSync(guardLog(), "");
      const seen: { env?: Record<string, string> } = {};
      const { messages, thrown } = await runTurn(fake, minimalEnv(), {}, seen);
      // The redirect crossed the explicit env.
      expect(seen.env?.[TEST_KEYCHAIN_ENV]).toBe(TEST_KEYCHAIN_MEMORY);
      // The child answered (no dialog-shaped hang). The credential read as ABSENT: a `local` connection
      // may run without one, so the turn reached the loopback fake -- carrying NO credential header, which
      // is what an absent keychain item looks like (a real one would have been sent). Never the `io`
      // failure a tripwire refusal would surface as.
      expect(messages.some((m) => m.type === "system")).toBe(true);
      const text = `${JSON.stringify(messages)} ${thrown instanceof Error ? thrown.message : String(thrown)}`;
      expect(text).not.toContain("keychain lookup failed");
      expect(text).not.toContain("winter test keychain guard");
      expect(fake.requests.length).toBeGreaterThan(0);
      for (const request of fake.requests) expect(Object.keys(request.headers).filter(isCredentialHeader)).toEqual([]);
      // ...and the child's tripwire recorded nothing.
      expect(readFileSync(guardLog(), "utf8")).toBe("");
    } finally {
      await fake.close();
    }
  }, 60_000);

  test("CONTROL: with the redirect switched off, the same child reaches the real API -- and the tripwire refuses and reports it (so the test above is not vacuous)", async () => {
    const fake = await startScenarioFake();
    const service = `keychain-test-throwaway.keychain-isolation-control.${process.pid}`;
    try {
      writeFileSync(guardLog(), "");
      const seen: { env?: Record<string, string> } = {};
      // An env that NAMES the variable (empty = off) is left as written by `query()`. A throwaway service,
      // so a guard that failed to load in the child could at worst miss a nonexistent item -- no CONSENT
      // dialog. (It could still raise macOS's UNLOCK prompt if the login keychain happened to be locked:
      // a lookup of any item asks for the keychain to be unlocked first. The tripwire, proven live by this
      // very test, is what keeps the lookup from ever reaching the Keychain.)
      const { messages, thrown } = await runTurn(fake, { ...minimalEnv(), [TEST_KEYCHAIN_ENV]: "" }, { keychainService: service }, seen);
      expect(seen.env?.[TEST_KEYCHAIN_ENV]).toBe("");
      const reported = readFileSync(guardLog(), "utf8");
      expect(reported).toContain(`Bun.secrets.get on service ${JSON.stringify(service)}`);
      expect(reported).not.toContain("com.winter.core");
      const text = `${JSON.stringify(messages)} ${thrown instanceof Error ? thrown.message : String(thrown)}`;
      expect(text).toContain("keychain lookup failed");
      for (const request of fake.requests) expect(Object.keys(request.headers).filter(isCredentialHeader)).toEqual([]);
    } finally {
      // Consumed here, so the preload's afterEach does not fail THIS test for the access it provoked.
      writeFileSync(guardLog(), "");
      await fake.close();
    }
  }, 60_000);
});

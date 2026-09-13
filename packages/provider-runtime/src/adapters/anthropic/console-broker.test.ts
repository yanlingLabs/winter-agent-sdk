// D20, host-brokered (P10a-1 amendment): `console-broker.ts` proved against REAL executables -- small
// shell-script stubs under `mkdtemp`, standing in for `ant` exactly as the controller's live
// measurement observed the real 1.32.0 binary behaving (see the module's own banner). Real scripts
// run by the REAL `Bun.spawn`, not a mocked spawn function (except the one test that deliberately
// wraps it to RECORD argv, item 4 below): the point is proving this file's pipe wiring and env
// building against an actual child process, the same way `runGit`-style helpers elsewhere in this
// repo are proved.
//
// LANE S ROUND 2: every stub here is named/shaped `ant`, never `claude` -- the premise that
// `claude auth login --console` writes the profile this file reads was FALSIFIED by a live
// measurement (see the module banner), and this file no longer spawns `claude` for anything.
//
// HERMETIC BY CONSTRUCTION: every config dir is a fresh `mkdtemp`, never `~/.claude*` or
// `~/.config/anthropic` (Global Constraints). No real `ant` or `claude` binary is ever invoked.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import {
  DEFAULT_LOGIN_TIMEOUT,
  SubmitCodeRefused,
  anthropicConsoleProfileExists,
  logoutAnthropicConsole,
  refreshAnthropicBearer,
  startAnthropicConsoleBrokerLogin,
  type AnthropicConsoleBrokerOptions,
} from "./console-broker.ts";
import { ANTHROPIC_CONSOLE_ACCOUNT_ID, ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT, anthropicCredentialRef } from "./console-oauth.ts";

const EXPECTED_CODE = "test-code-9f2a-do-not-reuse";
const STUB_BEARER_TOKEN = "fake-token";
const FIXTURE_EXPIRES_AT = 1_999_999_999_999;

/** Writes an executable POSIX shell script and returns its path. */
function writeStub(dir: string, name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * An `ant auth login --profile <p> --timeout <t>` stub: prints the URL `ant` opens itself and a
 * paste-the-code prompt, reads one line off stdin, and either writes the credentials profile file
 * and exits 0 (the pasted line matches `EXPECTED_CODE`) or exits 2 with a stderr line (it does not)
 * -- exactly the shape the controller's live measurement recorded. `$2` is the subcommand (`login`),
 * matching `ant`'s own argv shape (`ant auth login ...`).
 */
function writeAntLoginStub(dir: string, opts: { writeProfile?: boolean } = {}): string {
  const writeProfile = opts.writeProfile ?? true;
  return writeStub(
    dir,
    "ant",
    [
      `case "$2" in`,
      `login)`,
      `  echo "Open this URL to continue: https://platform.claude.com/oauth/authorize?client_id=abc123&code=${EXPECTED_CODE}&state=xyz1"`,
      `  echo "or paste the code here if the browser did not open > "`,
      `  read -r pasted`,
      `  if [ "$pasted" = "${EXPECTED_CODE}" ]; then`,
      writeProfile
        ? `    mkdir -p "$ANTHROPIC_CONFIG_DIR/credentials"\n    printf '{"version":"1.0","type":"oauth_token","access_token":"stub-access","refresh_token":"stub-refresh","expires_at":${FIXTURE_EXPIRES_AT}}' > "$ANTHROPIC_CONFIG_DIR/credentials/winter.json"`
        : `    : # deliberately writes NO profile file, to prove exit 0 alone is not trusted`,
      `    exit 0`,
      `  else`,
      `    echo "console login refused: invalid code" >&2`,
      `    exit 2`,
      `  fi`,
      `  ;;`,
      `print-credentials)`,
      `  echo "${STUB_BEARER_TOKEN}"`,
      `  ;;`,
      `*)`,
      `  echo "unexpected subcommand: $2" >&2`,
      `  exit 1`,
      `  ;;`,
      `esac`,
    ].join("\n"),
  );
}

/** An `ant auth logout --profile <p>` stub: exits 0 unconditionally. */
function writeAntLogoutStub(dir: string): string {
  return writeStub(dir, "ant-logout", `exit 0`);
}

/** An `ant auth print-credentials` stub: prints a bare token and exits 0. */
function writeAntStub(dir: string): string {
  return writeStub(dir, "ant", `echo "${STUB_BEARER_TOKEN}"`);
}

/** A FAILING `ant` stub: exits 2 with a stderr line, never a bare token on stdout. */
function writeFailingAntStub(dir: string): string {
  return writeStub(dir, "ant-fail", `echo "ant: profile not found" >&2\nexit 2`);
}

/** Fix round 1, item 1: dumps every `NAME=VALUE` the child actually received, one per line, and exits 0. */
function writeEnvDumpStub(dir: string): string {
  return writeStub(dir, "env-dump", `env`);
}

/** A login stub that NEVER prompts and exits immediately -- proves a slow/hanging code submission never blocks the outcome, and that `submitCode` refuses once the process is gone. */
function writeInstantExitStub(dir: string, exitCode = 2): string {
  return writeStub(dir, "ant-instant-exit", `echo "refused before any prompt" >&2\nexit ${exitCode}`);
}

/** Reads one line and then stays alive for a moment -- a window to prove a SECOND `submitCode` is refused while the process is still running (as opposed to already exited). */
function writeSlowLoginStub(dir: string): string {
  return writeStub(dir, "ant-slow", `read -r pasted\nsleep 1\nexit 0`);
}

/**
 * A multi-subcommand `ant` stub that handles `login`, `logout` and `print-credentials` from ONE
 * script, keyed on `$2` -- used by the argv-recording test (item 4) so all three flows can point at
 * the SAME executable path and still be told apart by their own behaviour.
 */
function writeMultiCommandAntStub(dir: string): string {
  return writeStub(
    dir,
    "ant-multi",
    [
      `case "$2" in`,
      `login)`,
      `  read -r pasted`,
      `  mkdir -p "$ANTHROPIC_CONFIG_DIR/credentials"`,
      `  printf '{"expires_at":${FIXTURE_EXPIRES_AT}}' > "$ANTHROPIC_CONFIG_DIR/credentials/winter.json"`,
      `  exit 0`,
      `  ;;`,
      `logout)`,
      `  exit 0`,
      `  ;;`,
      `print-credentials)`,
      `  echo "${STUB_BEARER_TOKEN}"`,
      `  ;;`,
      `esac`,
    ].join("\n"),
  );
}

describe("console-broker.ts (host-brokered D20, P10a-1 amendment; Lane S round 2: ant-only)", () => {
  let dirs: string[] = [];

  function mkConfigDirs(): { anthropicConfigDir: string; binDir: string } {
    const anthropicConfigDir = mkdtempSync(join(tmpdir(), "winter-console-broker-anthropic-"));
    const binDir = mkdtempSync(join(tmpdir(), "winter-console-broker-bin-"));
    dirs.push(anthropicConfigDir, binDir);
    return { anthropicConfigDir, binDir };
  }

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  test("REDACTION: every line reaching `onLine` has its URL's query string stripped -- the one-time code never appears in any line", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntLoginStub(binDir);
    const store = createMemoryCredentialStore();
    const lines: string[] = [];
    const options: AnthropicConsoleBrokerOptions = { antExecutable, anthropicConfigDir, onLine: (line) => lines.push(line) };

    const handle = startAnthropicConsoleBrokerLogin(store, options);
    await handle.submitCode(EXPECTED_CODE);
    const outcome = await handle.done;

    expect(outcome).toEqual({ ok: true, profile: "winter" });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(EXPECTED_CODE);
    // The redaction leaves the URL recognisable, just with its query gone -- proving the line was
    // actually seen and trimmed, not merely absent because nothing matched a URL at all.
    expect(lines.some((l) => l.includes("https://platform.claude.com/oauth/authorize?…"))).toBe(true);
  });

  test("SUBMITCODE + DONE (success): the right code completes the login, writes the profile, and mints the bearer material", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntLoginStub(binDir);
    const store = createMemoryCredentialStore();
    const options: AnthropicConsoleBrokerOptions = { antExecutable, anthropicConfigDir, service: "com.winter.core.dev" };

    const handle = startAnthropicConsoleBrokerLogin(store, options);
    await handle.submitCode(EXPECTED_CODE);
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: true, profile: "winter" });

    // The bearer write (via the in-memory store), under the fixed `anthropic:console` record
    // (Lane S round 3) -- NEVER `anthropic:default`, the api-key slot.
    const ref = anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID, "com.winter.core.dev");
    const material = await store.get(ref);
    expect(material).toEqual({ kind: "bearer", token: STUB_BEARER_TOKEN, expiresAt: FIXTURE_EXPIRES_AT });
  });

  test("SUBMITCODE + DONE (failure): the WRONG code is refused, and the reason names neither the code nor a URL", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntLoginStub(binDir);
    const store = createMemoryCredentialStore();
    const options: AnthropicConsoleBrokerOptions = { antExecutable, anthropicConfigDir };

    const handle = startAnthropicConsoleBrokerLogin(store, options);
    await handle.submitCode("not-the-expected-code");
    const outcome = await handle.done;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.reason : "").toContain("invalid code");
    expect(outcome.ok === false ? outcome.reason : "").not.toContain(EXPECTED_CODE);
    expect(outcome.ok === false ? outcome.reason : "").not.toContain("http");
    // No profile written on a refused code, and nothing left in the store.
    expect(anthropicConsoleProfileExists(anthropicConfigDir, "winter")).toBe(false);
    expect(store.size()).toBe(0);
  });

  test("Lane S round 2: exit 0 WITHOUT a written profile is a typed failure -- the exit code alone is not trusted", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntLoginStub(binDir, { writeProfile: false });
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { antExecutable, anthropicConfigDir });
    await handle.submitCode(EXPECTED_CODE);
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: false, reason: '"ant auth login" exited 0 but wrote no profile for "winter" -- there is nothing to authenticate with' });
    expect(store.size()).toBe(0);
  });

  test("NO antExecutable (item 2): login refuses BEFORE spawning anything, mirroring refreshAnthropicBearer's wording", async () => {
    const { anthropicConfigDir } = mkConfigDirs();
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { anthropicConfigDir });
    const outcome = await handle.done;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.reason : "").toContain('"ant"');
    const rejection = await handle.submitCode("anything").catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(SubmitCodeRefused);
  });

  test("loginTimeout validation: an invalid duration is a typed pre-spawn failure, never a spawn with a malformed flag", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntLoginStub(binDir);
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { antExecutable, anthropicConfigDir, loginTimeout: "not-a-duration" });
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: false, reason: 'loginTimeout "not-a-duration" is not a valid duration -- expected digits followed by a single s/m/h unit, e.g. "10m"' });
  });

  test("loginTimeout: the default is passed on argv when omitted, and an explicit valid one overrides it", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const recordedArgvs: string[][] = [];
    const recordingSpawn = ((cmd: readonly string[], opts: unknown) => {
      recordedArgvs.push([...cmd]);
      return Bun.spawn(cmd as string[], opts as Parameters<typeof Bun.spawn>[1]);
    }) as unknown as typeof Bun.spawn;
    const antExecutable = writeAntLoginStub(binDir);

    const store1 = createMemoryCredentialStore();
    const handle1 = startAnthropicConsoleBrokerLogin(store1, { antExecutable, anthropicConfigDir, spawn: recordingSpawn });
    await handle1.submitCode(EXPECTED_CODE);
    await handle1.done;

    const anthropicConfigDir2 = mkdtempSync(join(tmpdir(), "winter-console-broker-anthropic-"));
    dirs.push(anthropicConfigDir2);
    const store2 = createMemoryCredentialStore();
    const handle2 = startAnthropicConsoleBrokerLogin(store2, { antExecutable, anthropicConfigDir: anthropicConfigDir2, loginTimeout: "45s", spawn: recordingSpawn });
    await handle2.submitCode(EXPECTED_CODE);
    await handle2.done;

    // Each login also triggers an internal `refreshAnthropicBearer` (`print-credentials`) spawn --
    // filtered out here since this assertion is about the LOGIN argv specifically.
    const loginArgvs = recordedArgvs.filter((argv) => argv[2] === "login");
    expect(loginArgvs[0]).toEqual([antExecutable, "auth", "login", "--profile", "winter", "--timeout", DEFAULT_LOGIN_TIMEOUT]);
    expect(loginArgvs[1]).toEqual([antExecutable, "auth", "login", "--profile", "winter", "--timeout", "45s"]);
  });

  test("a login binary that could not be started at all (ENOENT) settles the handle immediately, and `submitCode` REFUSES typed (fix round 1, item 3)", async () => {
    const { anthropicConfigDir } = mkConfigDirs();
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { antExecutable: join(anthropicConfigDir, "does-not-exist"), anthropicConfigDir });
    const rejection = await handle.submitCode("anything").catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(SubmitCodeRefused);
    expect((rejection as SubmitCodeRefused).reason).toBe("not-running");
    const outcome = await handle.done;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.reason : "").toContain("could not be started");
  });

  test("refreshAnthropicBearer: expiresAt is read from the fixture profile file, not guessed", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ access_token: "irrelevant", expires_at: FIXTURE_EXPIRES_AT, refresh_token: "irrelevant" }));
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir });
    expect(result).toEqual({ ok: true, expiresAt: FIXTURE_EXPIRES_AT });
    const material = await store.get(anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID));
    expect(material).toEqual({ kind: "bearer", token: STUB_BEARER_TOKEN, expiresAt: FIXTURE_EXPIRES_AT });
  });

  test("refreshAnthropicBearer: no profile file on disk falls back to a conservative now+1h estimate, never 'unknown as already expired'", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    const store = createMemoryCredentialStore();
    const now = 1_700_000_000_000;
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir, now: () => now });
    expect(result).toEqual({ ok: true, expiresAt: now + 3_600_000 });
  });

  test("refreshAnthropicBearer: the ant binary's own failure is a named, typed refusal — never the bare exit code alone, and any existing material is left untouched", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const failingAnt = writeFailingAntStub(binDir);
    const store = createMemoryCredentialStore();
    const ref = anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID);
    await store.set(ref, { kind: "bearer", token: "already-there", expiresAt: 123 });
    const result = await refreshAnthropicBearer(store, { antExecutable: failingAnt, anthropicConfigDir });
    expect(result).toEqual({ ok: false, reason: "ant: profile not found" });
    expect(await store.get(ref)).toEqual({ kind: "bearer", token: "already-there", expiresAt: 123 });
  });

  test("refreshAnthropicBearer: with NO `antExecutable` resolved, the refusal names the missing broker BY NAME", async () => {
    const { anthropicConfigDir } = mkConfigDirs();
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { anthropicConfigDir });
    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : "").toContain('"ant"');
  });

  test("anthropicConsoleProfileExists: true only once the profile file is actually there", () => {
    const { anthropicConfigDir } = mkConfigDirs();
    expect(anthropicConsoleProfileExists(anthropicConfigDir, "winter")).toBe(false);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), "{}");
    expect(anthropicConsoleProfileExists(anthropicConfigDir, "winter")).toBe(true);
    // A DIFFERENT profile name is a DIFFERENT file -- no accidental match on "any profile exists".
    expect(anthropicConsoleProfileExists(anthropicConfigDir, "other")).toBe(false);
  });

  test("logoutAnthropicConsole: spawns `ant auth logout --profile <p>` and deletes the bearer material regardless of what it prints", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntLogoutStub(binDir);
    const store = createMemoryCredentialStore();
    const ref = anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID);
    await store.set(ref, { kind: "bearer", token: "to-be-deleted", expiresAt: 999 });
    await logoutAnthropicConsole(store, { antExecutable, anthropicConfigDir });
    expect(await store.get(ref)).toBeNull();
  });

  test("logoutAnthropicConsole: still deletes the material even when the binary cannot be started at all", async () => {
    const { anthropicConfigDir } = mkConfigDirs();
    const store = createMemoryCredentialStore();
    const ref = anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID);
    await store.set(ref, { kind: "bearer", token: "to-be-deleted", expiresAt: 999 });
    await logoutAnthropicConsole(store, { antExecutable: join(anthropicConfigDir, "does-not-exist"), anthropicConfigDir });
    expect(await store.get(ref)).toBeNull();
  });

  test("logoutAnthropicConsole: NO antExecutable skips the spawn, names the reason on `onLine`, and STILL deletes the material (item 2)", async () => {
    const { anthropicConfigDir } = mkConfigDirs();
    const store = createMemoryCredentialStore();
    const ref = anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID);
    await store.set(ref, { kind: "bearer", token: "to-be-deleted", expiresAt: 999 });
    const lines: string[] = [];
    await logoutAnthropicConsole(store, { anthropicConfigDir, onLine: (l) => lines.push(l) });
    expect(await store.get(ref)).toBeNull();
    expect(lines.some((l) => l.includes('"ant"'))).toBe(true);
  });

  test("EVERY spawn from login+submitCode, logout, and refresh starts with the ant executable -- claude is NEVER spawned (Lane S round 2, item 4)", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeMultiCommandAntStub(binDir);
    const claudeExecutable = join(binDir, "claude-must-never-run");
    const recordedArgvs: string[][] = [];
    const recordingSpawn = ((cmd: readonly string[], opts: unknown) => {
      recordedArgvs.push([...cmd]);
      return Bun.spawn(cmd as string[], opts as Parameters<typeof Bun.spawn>[1]);
    }) as unknown as typeof Bun.spawn;
    const store = createMemoryCredentialStore();
    const options: AnthropicConsoleBrokerOptions = { antExecutable, claudeExecutable, anthropicConfigDir, spawn: recordingSpawn };

    // login + submitCode (submitCode itself spawns nothing; it writes to the already-spawned process).
    const handle = startAnthropicConsoleBrokerLogin(store, options);
    await handle.submitCode(EXPECTED_CODE);
    const loginOutcome = await handle.done;
    expect(loginOutcome).toEqual({ ok: true, profile: "winter" });

    // logout
    await logoutAnthropicConsole(store, options);

    // refresh (standalone call, on top of the one login already triggered internally)
    const refreshResult = await refreshAnthropicBearer(store, options);
    expect(refreshResult.ok).toBe(true);

    // login triggers ONE login spawn + ONE internal refresh spawn; logout is a third; the standalone
    // refresh above is a fourth -- four spawns total, every one of them `ant`.
    expect(recordedArgvs.length).toBe(4);
    for (const argv of recordedArgvs) {
      expect(argv[0]).toBe(antExecutable);
      expect(argv).not.toContain(claudeExecutable);
    }
  });

  test("ENV SCRUB (fix round 1, item 1, CRITICAL; narrowed in Lane S round 2): forbidden ambient vars never reach the child; the allowlist + ANTHROPIC_CONFIG_DIR do; ANTHROPIC_PROFILE is carried by the --profile FLAG, never the environment", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const envDumpStub = writeEnvDumpStub(binDir);
    const store = createMemoryCredentialStore();
    const forbidden: Record<string, string> = {
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak-9f2a",
      ANTHROPIC_AUTH_TOKEN: "should-not-leak-either-9f2a",
      ANTHROPIC_BASE_URL: "https://evil.example.invalid",
      CLAUDE_CODE_SOME_FLAG: "should-not-leak-9f2a",
      CLAUDE_CONFIG_DIR: "/should/not/leak/9f2a",
      OPENAI_API_KEY: "should-not-leak-9f2a",
      SOME_SERVICE_TOKEN: "should-not-leak-9f2a",
      WINTER_RANDOM_AMBIENT_VAR: "should-not-leak-9f2a",
    };
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(forbidden)) saved[key] = process.env[key];
    Object.assign(process.env, forbidden);
    try {
      const result = await refreshAnthropicBearer(store, { antExecutable: envDumpStub, anthropicConfigDir });
      expect(result.ok).toBe(true);
      // `refreshAnthropicBearer` writes the child's stdout (here, the whole env dump) as the bearer
      // token -- the store IS the observation point for what the child actually received.
      const material = await store.get(anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID));
      const dump = material?.kind === "bearer" ? material.token : "";
      expect(dump.length).toBeGreaterThan(0);
      for (const key of Object.keys(forbidden)) expect(dump).not.toContain(`${key}=`);
      // ANTHROPIC_PROFILE is NEVER set in the environment (Lane S round 2) -- the `--profile` flag
      // carries it, and setting it in both places would be a second, potentially-disagreeing source
      // of truth.
      expect(dump).not.toContain("ANTHROPIC_PROFILE=");
      // Positive control: the mechanism is an ALLOWLIST, not a blanket wipe -- PATH and this file's
      // ONE broker var DO reach the child.
      expect(dump).toContain(`ANTHROPIC_CONFIG_DIR=${anthropicConfigDir}`);
      expect(dump).toContain("PATH=");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("submitCode REFUSES a second call while the process is still alive (fix round 1, item 3)", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeSlowLoginStub(binDir);
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { antExecutable, anthropicConfigDir });
    await handle.submitCode("first-and-only-valid-call");
    const rejection = await handle.submitCode("second-call-must-refuse").catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(SubmitCodeRefused);
    expect((rejection as SubmitCodeRefused).reason).toBe("already-submitted");
  });

  test("submitCode REFUSES a call after the process has already exited (fix round 1, item 3)", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeInstantExitStub(binDir);
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { antExecutable, anthropicConfigDir });
    await handle.done; // the process is guaranteed gone by the time this resolves.
    const rejection = await handle.submitCode("too-late").catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(SubmitCodeRefused);
    expect((rejection as SubmitCodeRefused).reason).toBe("not-running");
  });

  test("refreshAnthropicBearer: a profile file OVER the 64 KiB cap is truncated, not read whole -- expiresAt falls back rather than reading the fixture's own value past the cut (fix round 1, item 4)", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    // `padding` alone is 100 KB, well past the 64 KiB cap, and it is serialised BEFORE `expires_at`
    // (JSON.stringify preserves insertion order) -- so a truncated read cuts off mid-string and never
    // reaches the real value, which is exactly the case this test exists to prove.
    const padding = "x".repeat(100_000);
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ padding, expires_at: FIXTURE_EXPIRES_AT }));
    const store = createMemoryCredentialStore();
    const now = 1_700_000_000_000;
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir, now: () => now });
    expect(result).toEqual({ ok: true, expiresAt: now + 3_600_000 });
  });

  test("refreshAnthropicBearer: a profile file that is not valid JSON at all is tolerated -- falls back to the conservative estimate (fix round 1, item 4)", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), "not json at all {{{");
    const store = createMemoryCredentialStore();
    const now = 1_700_000_000_000;
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir, now: () => now });
    expect(result).toEqual({ ok: true, expiresAt: now + 3_600_000 });
  });

  test("M3-units: a numeric `expires_at` under 1e12 is treated as epoch SECONDS and normalised to milliseconds", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    const secondsValue = 4_000_000_000; // well under 1e12 -- a real-looking epoch-seconds timestamp, ~2096
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: secondsValue }));
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir });
    expect(result).toEqual({ ok: true, expiresAt: secondsValue * 1000 });
  });

  test("M3-units: a numeric `expires_at` at or above 1e12 is trusted as milliseconds already, unchanged", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: FIXTURE_EXPIRES_AT }));
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir });
    expect(result).toEqual({ ok: true, expiresAt: FIXTURE_EXPIRES_AT });
  });

  test("M3-units: an ISO-8601 string `expires_at` is parsed with `Date.parse`", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    const iso = "2099-01-01T00:00:00.000Z";
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: iso }));
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir });
    expect(result).toEqual({ ok: true, expiresAt: Date.parse(iso) });
  });

  test("M3-units: an `expires_at` that is neither a number nor a parseable string is tolerated -- falls back to the conservative estimate", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: "not-a-date" }));
    const store = createMemoryCredentialStore();
    const now = 1_700_000_000_000;
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir, now: () => now });
    expect(result).toEqual({ ok: true, expiresAt: now + 3_600_000 });
  });

  test("M3-units: refreshAnthropicBearer never returns an expiresAt in the past -- a profile value at/before now is clamped to now+60s and named (not detailed) on `onLine`", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    const now = 1_700_000_000_000;
    // Epoch SECONDS for a moment well before `now` -- normalises to a firmly-past millisecond value,
    // not merely a rounding edge case.
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: 1_000 }));
    const store = createMemoryCredentialStore();
    const lines: string[] = [];
    const result = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir, now: () => now, onLine: (line) => lines.push(line) });
    expect(result).toEqual({ ok: true, expiresAt: now + 60_000 });
    const material = await store.get(anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID));
    expect(material).toEqual({ kind: "bearer", token: STUB_BEARER_TOKEN, expiresAt: now + 60_000 });
    // Named by the function's own name only -- never the profile's raw value.
    expect(lines.some((line) => line.includes("refreshAnthropicBearer"))).toBe(true);
    expect(lines.join("\n")).not.toContain("1000");
  });

  test("BELT-AND-BRACES REDACTION (fix round 1, item 6): a `code=` occurrence OUTSIDE a recognised URL is still redacted, and everything after it on that line is dropped", async () => {
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeStub(
      binDir,
      "ant-plain-code",
      [`echo "plain text mentioning code=${EXPECTED_CODE} and then MORE TEXT that must also be dropped"`, `read -r pasted`, `exit 0`].join("\n"),
    );
    const store = createMemoryCredentialStore();
    const lines: string[] = [];
    const handle = startAnthropicConsoleBrokerLogin(store, { antExecutable, anthropicConfigDir, onLine: (l) => lines.push(l) });
    await handle.submitCode("whatever-code-value");
    await handle.done;
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(EXPECTED_CODE);
    expect(lines.some((l) => l.includes("code=…"))).toBe(true);
    expect(lines.some((l) => l.includes("MORE TEXT"))).toBe(false);
  });

  test("DATA-LOSS REGRESSION (Opus review, Lane S round 3): a full login -> refresh -> logout cycle never touches api-key material stored at anthropic:default", async () => {
    // The exact defect: refreshAnthropicBearer/logoutAnthropicConsole used to write/delete
    // `anthropic:default` -- the SAME account `winter login --anthropic-key` stores the user's pasted
    // API key at. Pre-seeded here and asserted BYTE-IDENTICAL after every step of the cycle.
    const { anthropicConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeMultiCommandAntStub(binDir);
    const store = createMemoryCredentialStore();
    const apiKeyRef = anthropicCredentialRef("default");
    const apiKeyMaterial = { kind: "api-key" as const, key: "sk-ant-api03-user-pasted-key-do-not-touch" };
    await store.set(apiKeyRef, apiKeyMaterial);

    // Login (its OWN internal refresh, on success, is step one of the cycle).
    const handle = startAnthropicConsoleBrokerLogin(store, { antExecutable, anthropicConfigDir });
    await handle.submitCode("anything");
    const loginOutcome = await handle.done;
    expect(loginOutcome).toEqual({ ok: true, profile: "winter" });
    expect(await store.get(apiKeyRef)).toEqual(apiKeyMaterial);

    // A standalone refresh (the host's own timer, per P10a-4).
    const refreshResult = await refreshAnthropicBearer(store, { antExecutable, anthropicConfigDir });
    expect(refreshResult.ok).toBe(true);
    expect(await store.get(apiKeyRef)).toEqual(apiKeyMaterial);

    // Logout.
    await logoutAnthropicConsole(store, { antExecutable, anthropicConfigDir });
    expect(await store.get(apiKeyRef)).toEqual(apiKeyMaterial);

    // The console bearer itself really was written and really was deleted -- at ITS OWN account, so
    // this is a positive proof the cycle did its job, not merely a no-op that touched nothing.
    expect(await store.get(anthropicCredentialRef(ANTHROPIC_CONSOLE_ACCOUNT_ID))).toBeNull();
    expect(ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT).toBe("anthropic:console");
  });
});

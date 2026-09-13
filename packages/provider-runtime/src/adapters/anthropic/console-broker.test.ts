// D20, host-brokered (P10a-1 amendment): `console-broker.ts` proved against REAL executables -- small
// shell-script stubs under `mkdtemp`, standing in for `claude`/`ant` exactly as the coordinator's M2
// measurement observed the real 2.1.250 binary behaving (see the module's own banner). Real scripts
// run by the REAL `Bun.spawn`, not a mocked spawn function: the point is proving this file's pipe
// wiring and env building against an actual child process, the same way `runGit`-style helpers
// elsewhere in this repo are proved.
//
// HERMETIC BY CONSTRUCTION: every config dir is a fresh `mkdtemp`, never `~/.claude*` or
// `~/.config/anthropic` (Global Constraints). No real `claude`/`ant` binary is ever invoked.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import {
  SubmitCodeRefused,
  anthropicConsoleProfileExists,
  logoutAnthropicConsole,
  refreshAnthropicBearer,
  startAnthropicConsoleBrokerLogin,
  type AnthropicConsoleBrokerOptions,
} from "./console-broker.ts";
import { anthropicCredentialRef } from "./console-oauth.ts";

const EXPECTED_CODE = "test-code-9f2a-do-not-reuse";
const STUB_ACCESS_TOKEN = "stub-official-access-do-not-reuse";
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
 * A `claude auth login --console` stub: prints the two lines the real binary prints (the authorize
 * URL, carrying a one-time `code=` query, and the paste prompt), reads one line off stdin, and either
 * writes the profile file and exits 0 (the pasted line matches `EXPECTED_CODE`) or exits 2 with a
 * stderr line (it does not) -- exactly the shape the coordinator's M2 measurement recorded.
 */
function writeLoginStub(dir: string): string {
  return writeStub(
    dir,
    "claude",
    [
      `echo "Open this URL to continue: https://platform.claude.com/oauth/authorize?client_id=abc123&code=${EXPECTED_CODE}&state=xyz1"`,
      `echo "Paste code here if prompted > "`,
      `read -r pasted`,
      `if [ "$pasted" = "${EXPECTED_CODE}" ]; then`,
      `  mkdir -p "$ANTHROPIC_CONFIG_DIR/credentials"`,
      `  printf '{"access_token":"${STUB_ACCESS_TOKEN}","expires_at":${FIXTURE_EXPIRES_AT},"refresh_token":"stub-refresh"}' > "$ANTHROPIC_CONFIG_DIR/credentials/$ANTHROPIC_PROFILE.json"`,
      `  exit 0`,
      `else`,
      `  echo "console login refused: invalid code" >&2`,
      `  exit 2`,
      `fi`,
    ].join("\n"),
  );
}

/** A logout stub: exits 0 unconditionally, no side effect -- `logoutAnthropicConsole` deletes the material regardless of what this prints. */
function writeLogoutCapableStub(dir: string): string {
  return writeStub(dir, "claude-logout", `exit 0`);
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

/** Fix round 1, item 2: a login stub that NEVER prompts and exits immediately -- proves a slow/hanging `readConsoleCode` never blocks the outcome. */
function writeInstantExitStub(dir: string, exitCode = 2): string {
  return writeStub(dir, "claude-instant-exit", `echo "refused before any prompt" >&2\nexit ${exitCode}`);
}

/** Fix round 1, item 3: reads one line and then stays alive for a moment -- a window to prove a SECOND `submitCode` is refused while the process is still running (as opposed to already exited). */
function writeSlowLoginStub(dir: string): string {
  return writeStub(dir, "claude-slow", `read -r pasted\nsleep 1\nexit 0`);
}

describe("console-broker.ts (host-brokered D20, P10a-1 amendment)", () => {
  let dirs: string[] = [];

  function mkConfigDirs(): { anthropicConfigDir: string; claudeConfigDir: string; binDir: string } {
    const anthropicConfigDir = mkdtempSync(join(tmpdir(), "winter-console-broker-anthropic-"));
    const claudeConfigDir = mkdtempSync(join(tmpdir(), "winter-console-broker-claude-"));
    const binDir = mkdtempSync(join(tmpdir(), "winter-console-broker-bin-"));
    dirs.push(anthropicConfigDir, claudeConfigDir, binDir);
    return { anthropicConfigDir, claudeConfigDir, binDir };
  }

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  test("REDACTION: every line reaching `onLine` has its URL's query string stripped -- the one-time code never appears in any line", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const claudeExecutable = writeLoginStub(binDir);
    const antExecutable = writeAntStub(binDir);
    const store = createMemoryCredentialStore();
    const lines: string[] = [];
    const options: AnthropicConsoleBrokerOptions = { claudeExecutable, antExecutable, anthropicConfigDir, claudeConfigDir, onLine: (line) => lines.push(line) };

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
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const claudeExecutable = writeLoginStub(binDir);
    const antExecutable = writeAntStub(binDir);
    const store = createMemoryCredentialStore();
    const options: AnthropicConsoleBrokerOptions = { claudeExecutable, antExecutable, anthropicConfigDir, claudeConfigDir, service: "com.winter.core.dev" };

    const handle = startAnthropicConsoleBrokerLogin(store, options);
    await handle.submitCode(EXPECTED_CODE);
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: true, profile: "winter" });

    // The bearer write (via the in-memory store), under the fixed `anthropic:default` record.
    const ref = anthropicCredentialRef("default", "com.winter.core.dev");
    const material = await store.get(ref);
    expect(material).toEqual({ kind: "bearer", token: STUB_BEARER_TOKEN, expiresAt: FIXTURE_EXPIRES_AT });
    // The stub's OWN access token (a stand-in for the official leg's profile secret) never leaks
    // into the native provider's bearer material -- `ant`'s bare-token stdout is the only source.
    expect(JSON.stringify(material)).not.toContain(STUB_ACCESS_TOKEN);
  });

  test("SUBMITCODE + DONE (failure): the WRONG code is refused, and the reason names neither the code nor a URL", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const claudeExecutable = writeLoginStub(binDir);
    const store = createMemoryCredentialStore();
    const options: AnthropicConsoleBrokerOptions = { claudeExecutable, anthropicConfigDir, claudeConfigDir };

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

  test("a login binary that could not be started at all (ENOENT) settles the handle immediately, and `submitCode` REFUSES typed (fix round 1, item 3)", async () => {
    const { anthropicConfigDir, claudeConfigDir } = mkConfigDirs();
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { claudeExecutable: join(anthropicConfigDir, "does-not-exist"), anthropicConfigDir, claudeConfigDir });
    const rejection = await handle.submitCode("anything").catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(SubmitCodeRefused);
    expect((rejection as SubmitCodeRefused).reason).toBe("not-running");
    const outcome = await handle.done;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false ? outcome.reason : "").toContain("could not be started");
  });

  test("refreshAnthropicBearer: expiresAt is read from the fixture profile file, not guessed", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ access_token: "irrelevant", expires_at: FIXTURE_EXPIRES_AT, refresh_token: "irrelevant" }));
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir });
    expect(result).toEqual({ ok: true, expiresAt: FIXTURE_EXPIRES_AT });
    const material = await store.get(anthropicCredentialRef("default"));
    expect(material).toEqual({ kind: "bearer", token: STUB_BEARER_TOKEN, expiresAt: FIXTURE_EXPIRES_AT });
  });

  test("refreshAnthropicBearer: no profile file on disk falls back to a conservative now+1h estimate, never 'unknown as already expired'", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    const store = createMemoryCredentialStore();
    const now = 1_700_000_000_000;
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir, now: () => now });
    expect(result).toEqual({ ok: true, expiresAt: now + 3_600_000 });
  });

  test("refreshAnthropicBearer: the ant binary's own failure is a named, typed refusal — never the bare exit code alone, and any existing material is left untouched", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const failingAnt = writeFailingAntStub(binDir);
    const store = createMemoryCredentialStore();
    const ref = anthropicCredentialRef("default");
    await store.set(ref, { kind: "bearer", token: "already-there", expiresAt: 123 });
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable: failingAnt, anthropicConfigDir, claudeConfigDir });
    expect(result).toEqual({ ok: false, reason: "ant: profile not found" });
    expect(await store.get(ref)).toEqual({ kind: "bearer", token: "already-there", expiresAt: 123 });
  });

  test("refreshAnthropicBearer: with NO `antExecutable` resolved, the refusal names the missing broker BY NAME", async () => {
    const { anthropicConfigDir, claudeConfigDir } = mkConfigDirs();
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", anthropicConfigDir, claudeConfigDir });
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

  test("logoutAnthropicConsole: deletes the bearer material regardless of what the logout binary prints", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const claudeExecutable = writeLogoutCapableStub(binDir);
    const store = createMemoryCredentialStore();
    const ref = anthropicCredentialRef("default");
    await store.set(ref, { kind: "bearer", token: "to-be-deleted", expiresAt: 999 });
    await logoutAnthropicConsole(store, { claudeExecutable, anthropicConfigDir, claudeConfigDir });
    expect(await store.get(ref)).toBeNull();
  });

  test("logoutAnthropicConsole: still deletes the material even when the binary cannot be started at all", async () => {
    const { anthropicConfigDir, claudeConfigDir } = mkConfigDirs();
    const store = createMemoryCredentialStore();
    const ref = anthropicCredentialRef("default");
    await store.set(ref, { kind: "bearer", token: "to-be-deleted", expiresAt: 999 });
    await logoutAnthropicConsole(store, { claudeExecutable: join(anthropicConfigDir, "does-not-exist"), anthropicConfigDir, claudeConfigDir });
    expect(await store.get(ref)).toBeNull();
  });

  test("ENV SCRUB (fix round 1, item 1, CRITICAL): forbidden ambient vars never reach the child; the allowlist + the three broker vars do", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const envDumpStub = writeEnvDumpStub(binDir);
    const store = createMemoryCredentialStore();
    const forbidden: Record<string, string> = {
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak-9f2a",
      ANTHROPIC_AUTH_TOKEN: "should-not-leak-either-9f2a",
      ANTHROPIC_BASE_URL: "https://evil.example.invalid",
      CLAUDE_CODE_SOME_FLAG: "should-not-leak-9f2a",
      OPENAI_API_KEY: "should-not-leak-9f2a",
      SOME_SERVICE_TOKEN: "should-not-leak-9f2a",
      WINTER_RANDOM_AMBIENT_VAR: "should-not-leak-9f2a",
    };
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(forbidden)) saved[key] = process.env[key];
    Object.assign(process.env, forbidden);
    try {
      const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable: envDumpStub, anthropicConfigDir, claudeConfigDir });
      expect(result.ok).toBe(true);
      // `refreshAnthropicBearer` writes the child's stdout (here, the whole env dump) as the bearer
      // token -- the store IS the observation point for what the child actually received.
      const material = await store.get(anthropicCredentialRef("default"));
      const dump = material?.kind === "bearer" ? material.token : "";
      expect(dump.length).toBeGreaterThan(0);
      for (const key of Object.keys(forbidden)) expect(dump).not.toContain(`${key}=`);
      // Positive control: the mechanism is an ALLOWLIST, not a blanket wipe -- PATH and the three
      // broker vars this login needs DO reach the child.
      expect(dump).toContain("ANTHROPIC_PROFILE=winter");
      expect(dump).toContain(`ANTHROPIC_CONFIG_DIR=${anthropicConfigDir}`);
      expect(dump).toContain(`CLAUDE_CONFIG_DIR=${claudeConfigDir}`);
      expect(dump).toContain("PATH=");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("submitCode REFUSES a second call while the process is still alive (fix round 1, item 3)", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const claudeExecutable = writeSlowLoginStub(binDir);
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { claudeExecutable, anthropicConfigDir, claudeConfigDir });
    await handle.submitCode("first-and-only-valid-call");
    const rejection = await handle.submitCode("second-call-must-refuse").catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(SubmitCodeRefused);
    expect((rejection as SubmitCodeRefused).reason).toBe("already-submitted");
  });

  test("submitCode REFUSES a call after the process has already exited (fix round 1, item 3)", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const claudeExecutable = writeInstantExitStub(binDir);
    const store = createMemoryCredentialStore();
    const handle = startAnthropicConsoleBrokerLogin(store, { claudeExecutable, anthropicConfigDir, claudeConfigDir });
    await handle.done; // the process is guaranteed gone by the time this resolves.
    const rejection = await handle.submitCode("too-late").catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(SubmitCodeRefused);
    expect((rejection as SubmitCodeRefused).reason).toBe("not-running");
  });

  test("refreshAnthropicBearer: a profile file OVER the 64 KiB cap is truncated, not read whole -- expiresAt falls back rather than reading the fixture's own value past the cut (fix round 1, item 4)", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    // `padding` alone is 100 KB, well past the 64 KiB cap, and it is serialised BEFORE `expires_at`
    // (JSON.stringify preserves insertion order) -- so a truncated read cuts off mid-string and never
    // reaches the real value, which is exactly the case this test exists to prove.
    const padding = "x".repeat(100_000);
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ padding, expires_at: FIXTURE_EXPIRES_AT }));
    const store = createMemoryCredentialStore();
    const now = 1_700_000_000_000;
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir, now: () => now });
    expect(result).toEqual({ ok: true, expiresAt: now + 3_600_000 });
  });

  test("refreshAnthropicBearer: a profile file that is not valid JSON at all is tolerated -- falls back to the conservative estimate (fix round 1, item 4)", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), "not json at all {{{");
    const store = createMemoryCredentialStore();
    const now = 1_700_000_000_000;
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir, now: () => now });
    expect(result).toEqual({ ok: true, expiresAt: now + 3_600_000 });
  });

  test("M3-units: a numeric `expires_at` under 1e12 is treated as epoch SECONDS and normalised to milliseconds", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    const secondsValue = 4_000_000_000; // well under 1e12 -- a real-looking epoch-seconds timestamp, ~2096
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: secondsValue }));
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir });
    expect(result).toEqual({ ok: true, expiresAt: secondsValue * 1000 });
  });

  test("M3-units: a numeric `expires_at` at or above 1e12 is trusted as milliseconds already, unchanged", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: FIXTURE_EXPIRES_AT }));
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir });
    expect(result).toEqual({ ok: true, expiresAt: FIXTURE_EXPIRES_AT });
  });

  test("M3-units: an ISO-8601 string `expires_at` is parsed with `Date.parse`", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    const iso = "2099-01-01T00:00:00.000Z";
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: iso }));
    const store = createMemoryCredentialStore();
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir });
    expect(result).toEqual({ ok: true, expiresAt: Date.parse(iso) });
  });

  test("M3-units: an `expires_at` that is neither a number nor a parseable string is tolerated -- falls back to the conservative estimate", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: "not-a-date" }));
    const store = createMemoryCredentialStore();
    const now = 1_700_000_000_000;
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir, now: () => now });
    expect(result).toEqual({ ok: true, expiresAt: now + 3_600_000 });
  });

  test("M3-units: refreshAnthropicBearer never returns an expiresAt in the past -- a profile value at/before now is clamped to now+60s and named (not detailed) on `onLine`", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const antExecutable = writeAntStub(binDir);
    mkdirSync(join(anthropicConfigDir, "credentials"), { recursive: true });
    const now = 1_700_000_000_000;
    // Epoch SECONDS for a moment well before `now` -- normalises to a firmly-past millisecond value,
    // not merely a rounding edge case.
    writeFileSync(join(anthropicConfigDir, "credentials", "winter.json"), JSON.stringify({ expires_at: 1_000 }));
    const store = createMemoryCredentialStore();
    const lines: string[] = [];
    const result = await refreshAnthropicBearer(store, { claudeExecutable: "/bin/true", antExecutable, anthropicConfigDir, claudeConfigDir, now: () => now, onLine: (line) => lines.push(line) });
    expect(result).toEqual({ ok: true, expiresAt: now + 60_000 });
    const material = await store.get(anthropicCredentialRef("default"));
    expect(material).toEqual({ kind: "bearer", token: STUB_BEARER_TOKEN, expiresAt: now + 60_000 });
    // Named by the function's own name only -- never the profile's raw value.
    expect(lines.some((line) => line.includes("refreshAnthropicBearer"))).toBe(true);
    expect(lines.join("\n")).not.toContain("1000");
  });

  test("BELT-AND-BRACES REDACTION (fix round 1, item 6): a `code=` occurrence OUTSIDE a recognised URL is still redacted, and everything after it on that line is dropped", async () => {
    const { anthropicConfigDir, claudeConfigDir, binDir } = mkConfigDirs();
    const claudeExecutable = writeStub(
      binDir,
      "claude-plain-code",
      [`echo "plain text mentioning code=${EXPECTED_CODE} and then MORE TEXT that must also be dropped"`, `read -r pasted`, `exit 0`].join("\n"),
    );
    const store = createMemoryCredentialStore();
    const lines: string[] = [];
    const handle = startAnthropicConsoleBrokerLogin(store, { claudeExecutable, anthropicConfigDir, claudeConfigDir, onLine: (l) => lines.push(l) });
    await handle.submitCode("whatever-code-value");
    await handle.done;
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(EXPECTED_CODE);
    expect(lines.some((l) => l.includes("code=…"))).toBe(true);
    expect(lines.some((l) => l.includes("MORE TEXT"))).toBe(false);
  });
});

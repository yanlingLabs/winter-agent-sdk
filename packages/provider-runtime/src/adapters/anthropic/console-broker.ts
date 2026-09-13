// D20, host-brokered (P10a-1 amendment, 2026-09-13): Anthropic Console OAuth through Anthropic's OWN
// broker binary -- `ant auth login`/`auth logout` (the Anthropic Platform CLI) -- never a
// re-implementation of the OAuth protocol itself. `console-oauth.ts`'s banner is the account of the
// FIRST thing this replaced (a re-implemented PKCE client); this file's own history is the SECOND
// correction, below.
//
// LANE S ROUND 2 (2026-09-13): the premise this file shipped on in v0.0.6/v0.0.7 -- that
// `claude auth login --console` writes the Anthropic profile the rest of this file reads -- was
// FALSIFIED by a live measurement. What the controller actually observed, on `claude` 2.1.250 and
// `ant` 1.32.0, for this org:
//
//   `claude auth login --console` writes NO Anthropic profile. It mints a Console API key ("/login
//   managed key"), stored in the LOGIN KEYCHAIN keyed to a hash of `CLAUDE_CONFIG_DIR`, plus
//   `<CLAUDE_CONFIG_DIR>/.claude.json` -- neither of which this file, or `anthropicConsoleProfileExists`,
//   has ever read. That held even with `ANTHROPIC_PROFILE`/`ANTHROPIC_CONFIG_DIR` set during the
//   login. Spawning `claude` for login therefore never produced the file this module went on to check
//   for, and left a stray Console-keyed login sitting in the OFFICIAL leg's own config dir besides.
//
//   The `claude` binary DOES authenticate from a profile `ant` writes: with `ANTHROPIC_CONFIG_DIR` set
//   and a fresh `CLAUDE_CONFIG_DIR`, a profile `ant auth login --profile winter` plants gives
//   `claude auth status` -> `{ loggedIn: true, authMethod: "oauth_token" }`. So `ant` is the ONE door
//   onto BOTH legs, and this file now spawns ONLY `ant` -- never `claude`, for login, logout, or
//   anything else.
//
//   Profile layout (read from the `claude` binary and matching what `ant` writes):
//   `configs/<profile>.json` = `{ version: "1.0", organization_id, workspace_id, authentication:
//   { type: "user_oauth", client_id } }`; `credentials/<profile>.json` = `{ version: "1.0", type:
//   "oauth_token", access_token, refresh_token, expires_at }`. The writer stamps `expires_at` as
//   `Math.floor(ms / 1000)` -- SECONDS -- which `normalizeExpiresAt` below already tolerates alongside
//   milliseconds (M3-units, carried over from v0.0.7 unchanged by this round).
//
//   `ant`'s login flag is `ant auth login --profile <p> [--timeout <duration>]` (default 5m; this file
//   always states one explicitly, default `"10m"`). Without `--no-browser` -- which this file never
//   passes, matching how a host would actually drive it -- `ant` opens the browser ITSELF and ALSO
//   prints the URL and a paste-the-code prompt, then reads a pasted code off stdin (proven with a
//   piped stdin). Logout is `ant auth logout --profile <p>` -- `--all` (every profile at once) is
//   never used here.
//
// EVERY OTHER BEHAVIOUR THIS FILE HAD IS UNCHANGED: line-by-line progress with URL query strings (and
// any bare `code=`) redacted before `onLine` ever sees a line, `submitCode` writing the pasted code
// plus a newline to stdin exactly once, the `SubmitCodeRefused` refusal states, and
// `refreshAnthropicBearer`'s own contract. What moved is WHICH BINARY is spawned and WITH WHAT
// ARGUMENTS -- and, since `ant`'s CLI carries the profile as a flag rather than reading it from the
// environment, `ANTHROPIC_PROFILE` is no longer part of this file's child environment at all.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { requireBunRuntime } from "../../bun-required.ts";
import type { CredentialMaterial, CredentialStore } from "../../types.ts";
import { anthropicCredentialRef } from "./console-oauth.ts";

/** `ant`'s `--profile` value (P10a-2) -- one profile for the login and every subsequent `ant` call. */
export const DEFAULT_ANTHROPIC_CONSOLE_PROFILE = "winter";

/** `ant auth login`'s `--timeout` default (Lane S round 2) -- generous over `ant`'s own 5m default, since a human has to notice a browser tab, sign in, and paste a code back. */
export const DEFAULT_LOGIN_TIMEOUT = "10m";

/** A Go duration of the shape `ant`'s own `--timeout` flag accepts for this purpose: digits followed by a single s/m/h unit. */
const LOGIN_TIMEOUT_PATTERN = /^\d+[smh]$/;

/** Config every door in this file shares -- one process env, one profile, one binary. */
export interface AnthropicConsoleBrokerOptions {
  /**
   * UNUSED (Lane S round 2, measured 2026-09-13): `claude auth login --console` does not write the
   * Anthropic profile this file reads, so this file no longer spawns `claude` for anything. Retained
   * as an OPTIONAL field purely for SOURCE COMPATIBILITY with existing call sites that still pass
   * it -- a host may drop it once its own callers are updated.
   */
  claudeExecutable?: string;
  /**
   * The resolved `ant` executable. Absent means "not installed/resolved" -- every door in this file
   * that would otherwise spawn it (login, logout, `refreshAnthropicBearer`) answers a named, typed
   * failure BEFORE spawning anything, rather than throwing or leaving a login half-finished.
   */
  antExecutable?: string;
  /** `<home>/runtimes/anthropic-config` (P10a-2), passed as `ANTHROPIC_CONFIG_DIR`. Created by the HOST before this file is ever called; this file only reads and writes inside it, never creates it. */
  anthropicConfigDir: string;
  /**
   * UNUSED (Lane S round 2): this file never spawns `claude`, so nothing here reads the official
   * leg's own config dir. Retained OPTIONAL for source compatibility, exactly like `claudeExecutable`
   * above.
   */
  claudeConfigDir?: string;
  /** `ant auth login/logout --profile`. Defaults to `DEFAULT_ANTHROPIC_CONSOLE_PROFILE`. */
  profile?: string;
  /** `ant auth login --timeout`. A Go duration (`^\d+[smh]$`); defaults to `DEFAULT_LOGIN_TIMEOUT`. An invalid value is a typed login failure, never a spawn with a malformed flag. */
  loginTimeout?: string;
  /** The Keychain service the bearer material lands in -- `config.keychainService` from the host. */
  service?: string;
  /**
   * Every stdout/stderr line, in the order this file observed them, REDACTED of any URL's query
   * string (and any bare `code=`) before this file ever calls it (R6-F: a progress channel, never
   * material).
   */
  onLine?: (line: string) => void;
  /** Injectable for a fixture: a stub executable under mkdtemp, never the real `ant`. */
  spawn?: typeof Bun.spawn;
  now?: () => number;
}

export interface AnthropicConsoleLoginHandle {
  /**
   * Writes `code + "\n"` to the child's stdin and closes it -- exactly what a human types at `ant`'s
   * paste-the-code prompt. Resolves once the write completes, NOT once the login finishes; await
   * `done` for that. Calling this before the child is ready for input, or more than once, is a caller
   * error this file does not guard against beyond the two REFUSAL states below -- the same trust
   * boundary `openUrl` callers already hold for every other login in this package.
   */
  submitCode(code: string): Promise<void>;
  /**
   * Resolves once this login is genuinely usable or genuinely not. A non-zero `ant` exit is
   * `{ ok: false, reason }`, the reason being the last non-empty stderr line this file observed
   * (already redacted) -- never the bare exit code alone, and never a URL or a code. A ZERO exit is
   * STILL a failure if `anthropicConsoleProfileExists` reports no profile written (Lane S round 2:
   * the exit code alone is not evidence of a written profile), and is only `{ ok: true, profile }`
   * once `refreshAnthropicBearer` has ALSO succeeded on top of that: a login that could not mint a
   * usable bearer is not one Winter can act on.
   */
  done: Promise<{ ok: true; profile: string } | { ok: false; reason: string }>;
}

/**
 * Fix round 1, item 3 (MINOR): a TYPED refusal from `submitCode`, rather than a silent no-op or an
 * untyped throw -- a caller that raced its own timeout against a slow paste, or that mis-drives this
 * handle from two places, gets something it can `instanceof`-check rather than a message to parse.
 */
export type SubmitCodeRefusalReason = "already-submitted" | "not-running";
export class SubmitCodeRefused extends Error {
  readonly name = "SubmitCodeRefused";
  readonly reason: SubmitCodeRefusalReason;
  constructor(reason: SubmitCodeRefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * An EXPLICIT ALLOWLIST, never `...process.env` (fix round 1, item 1; narrowed further in Lane S
 * round 2 now that only `ant` is ever spawned). Only what a shell needs to RUN a binary at all
 * survives, plus this file's one variable, `ANTHROPIC_CONFIG_DIR`. Everything else -- an
 * `ANTHROPIC_API_KEY`, an `ANTHROPIC_AUTH_TOKEN`, any `CLAUDE_*` variable, an unrelated
 * `*_API_KEY`/`*_TOKEN` the host process happens to hold -- is dropped. `ANTHROPIC_PROFILE` is
 * DELIBERATELY not here either (Lane S round 2): `ant`'s `--profile` flag carries it on the argv this
 * file already builds, so setting it in the environment too would be a second, redundant source of
 * truth that could disagree with the flag. `LC_*` is a wildcard-by-PREFIX (locale has an open-ended
 * variable set: `LC_ALL`, `LC_CTYPE`, `LC_COLLATE`, ...), not a loophole -- none of them shapes what
 * the binary authenticates as.
 */
const INHERITED_ENV_NAMES = ["HOME", "PATH", "TMPDIR", "LANG"] as const;

function brokerEnv(anthropicConfigDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("LC_") && value !== undefined) env[name] = value;
  }
  env["ANTHROPIC_CONFIG_DIR"] = anthropicConfigDir;
  return env;
}

/**
 * Strips the query string off every `http(s)` URL a line contains, replacing it with a literal `…`,
 * THEN (fix round 1, item 6, belt-and-braces) drops everything from any remaining `code=` to the end
 * of the line, case-insensitively -- not only inside a recognised URL. The first pass is the derived,
 * measured shape of what the binary actually prints; the second is cheap insurance against a future
 * build printing the code in a shape the URL pattern does not recognise (no scheme, a different
 * query-string encoding, plain prose). Applied to EVERY line this file hands a host, not only ones
 * that look like a prompt -- a one-time code is exactly the kind of value that looks unremarkable
 * until it is the one line someone pastes into a support channel.
 */
function redactUrlQuery(line: string): string {
  const urlRedacted = line.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1?…");
  return urlRedacted.replace(/code=.*/i, "code=…");
}

/**
 * Splits a growing text buffer on newlines, calling `onLine` with each COMPLETE line (redacted) as
 * soon as it arrives, and returns whatever partial line is left unread when the stream ends.
 */
function pump(chunk: string, buffer: string, onLine: (line: string) => void, record?: string[]): string {
  let working = buffer + chunk;
  let newlineAt: number;
  while ((newlineAt = working.indexOf("\n")) !== -1) {
    const raw = working.slice(0, newlineAt);
    working = working.slice(newlineAt + 1);
    const redacted = redactUrlQuery(raw);
    if (record !== undefined && redacted.trim().length > 0) record.push(redacted);
    onLine(redacted);
  }
  return working;
}

async function drainStream(stream: ReadableStream<Uint8Array> | undefined | null, onLine: (line: string) => void, record?: string[]): Promise<void> {
  if (stream === null || stream === undefined) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = pump(decoder.decode(value, { stream: true }), buffer, onLine, record);
  }
  if (buffer.length > 0) {
    const redacted = redactUrlQuery(buffer);
    if (record !== undefined && redacted.trim().length > 0) record.push(redacted);
    onLine(redacted);
  }
}

/** Builds the already-settled failure handle every pre-spawn refusal returns (missing `antExecutable`, a malformed `loginTimeout`, or an ENOENT from the spawn itself). */
function settledLoginFailure(reason: string): AnthropicConsoleLoginHandle {
  return {
    submitCode: async () => {
      throw new SubmitCodeRefused("not-running", "the console login process never started, so there is nothing to write the code to");
    },
    done: Promise.resolve({ ok: false, reason }),
  };
}

/**
 * Starts `ant auth login --profile <p> --timeout <t>` and returns a handle a host drives
 * interactively: it prints the URL `ant` opens itself and its paste-the-code prompt through `onLine`,
 * and the host calls `submitCode` once the operator has one. See the file banner for what was
 * MEASURED about this shape rather than assumed.
 *
 * SYNCHRONOUS RETURN, matching `runGit`'s own precedent for a spawn that can fail before any process
 * exists: `Bun.spawn` throws SYNCHRONOUSLY on an unresolvable executable (ENOENT), and a function that
 * only surfaced that inside an async `done` would leave a caller unable to tell "the binary doesn't
 * exist" from "the login is running" until the first `await`. Every pre-spawn refusal in this
 * function -- no `antExecutable`, a malformed `loginTimeout`, or a genuine ENOENT -- is reflected the
 * same way: `done` is already resolved `{ ok: false, reason }`, and `submitCode` REFUSES (fix round 1,
 * item 3) with `SubmitCodeRefused("not-running", …)` -- there is no process to write to, which is the
 * SAME condition a call after a real process exits refuses under.
 */
export function startAnthropicConsoleBrokerLogin(store: CredentialStore, options: AnthropicConsoleBrokerOptions): AnthropicConsoleLoginHandle {
  requireBunRuntime(
    "startAnthropicConsoleBrokerLogin",
    "Bun.spawn",
    "The Console login has to spawn the `ant` binary and pipe its stdin/stdout/stderr, which needs Bun's subprocess API. Run the login under Bun (or complete it in a Bun process and pass the resulting credential ref to your Node session).",
  );
  const profile = options.profile ?? DEFAULT_ANTHROPIC_CONSOLE_PROFILE;
  const onLine = options.onLine ?? (() => {});
  const spawnFn = options.spawn ?? Bun.spawn;

  // Item 2: no `antExecutable` refuses BEFORE spawning anything, mirroring `refreshAnthropicBearer`'s
  // existing wording -- the console login cannot run at all without this broker.
  if (options.antExecutable === undefined) {
    return settledLoginFailure(
      'the "ant" broker is not installed/resolved (settings.runtimes.antExecutable, or `brew install anthropics/tap/ant`) -- the console login cannot run without it',
    );
  }
  const loginTimeout = options.loginTimeout ?? DEFAULT_LOGIN_TIMEOUT;
  if (!LOGIN_TIMEOUT_PATTERN.test(loginTimeout)) {
    return settledLoginFailure(`loginTimeout "${loginTimeout}" is not a valid duration -- expected digits followed by a single s/m/h unit, e.g. "${DEFAULT_LOGIN_TIMEOUT}"`);
  }

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = spawnFn([options.antExecutable, "auth", "login", "--profile", profile, "--timeout", loginTimeout], {
      env: brokerEnv(options.anthropicConfigDir),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return settledLoginFailure(`"ant auth login" could not be started: ${err instanceof Error ? err.message : String(err)}`);
  }

  const stderrLines: string[] = [];
  const stdoutPump = drainStream(child.stdout as ReadableStream<Uint8Array> | undefined, onLine);
  const stderrPump = drainStream(child.stderr as ReadableStream<Uint8Array> | undefined, onLine, stderrLines);

  // Fix round 1, item 3: the two states `submitCode` refuses on. `exited` is set from `child.exited`
  // directly (not derived from `done`, which also awaits the stdout/stderr drains, the profile-file
  // check and the bearer refresh) -- a caller must be refused the instant the PROCESS is gone, not
  // once every follow-on step this file does afterward has also finished.
  let submitted = false;
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });

  const done = (async (): Promise<{ ok: true; profile: string } | { ok: false; reason: string }> => {
    const [exitCode] = await Promise.all([child.exited, stdoutPump, stderrPump]);
    if (exitCode !== 0) {
      const reason = stderrLines.at(-1) ?? `"ant auth login" exited with code ${exitCode}`;
      return { ok: false, reason };
    }
    // Lane S round 2: exit 0 is NOT evidence of a written profile on its own (that was the exact
    // premise the live measurement falsified for `claude`) -- checked explicitly rather than trusted.
    if (!anthropicConsoleProfileExists(options.anthropicConfigDir, profile)) {
      return { ok: false, reason: `"ant auth login" exited 0 but wrote no profile for "${profile}" -- there is nothing to authenticate with` };
    }
    const refreshed = await refreshAnthropicBearer(store, options);
    if (!refreshed.ok) return { ok: false, reason: refreshed.reason };
    return { ok: true, profile };
  })();

  return {
    async submitCode(code: string): Promise<void> {
      if (exited) throw new SubmitCodeRefused("not-running", "the console login process has already exited; there is nothing left to write the code to");
      if (submitted) throw new SubmitCodeRefused("already-submitted", "submitCode was already called once for this login; a second call cannot un-write what was already sent");
      submitted = true;
      const stdin = child.stdin;
      if (stdin === undefined || stdin === null || typeof stdin === "number") return;
      stdin.write(`${code}\n`);
      await stdin.end();
    },
    done,
  };
}

/**
 * Runs `ant auth print-credentials --profile <profile> --access-token` and writes the bearer material
 * `anthropic:default` (P10a-4) -- called automatically by `startAnthropicConsoleBrokerLogin` on a
 * successful login, and separately by a host's own refresh timer (60 s before `expiresAt`, per
 * P10a-4) since renewal never re-runs the interactive login.
 *
 * A FAILURE LEAVES ANY EXISTING MATERIAL UNTOUCHED: this function never calls `store.set` on any path
 * that did not itself produce a fresh token, so a transient failure of the broker cannot erase a
 * still-good credential.
 */
export async function refreshAnthropicBearer(store: CredentialStore, options: AnthropicConsoleBrokerOptions): Promise<{ ok: true; expiresAt: number } | { ok: false; reason: string }> {
  requireBunRuntime("refreshAnthropicBearer", "Bun.spawn", "Minting the native provider's bearer token spawns the `ant` binary, which needs Bun's subprocess API. Run it under Bun.");
  if (options.antExecutable === undefined) {
    return { ok: false, reason: 'the "ant" broker is not installed/resolved (settings.runtimes.antExecutable, or `brew install anthropics/tap/ant`) -- the console login itself succeeded, but nothing can mint the native provider\'s bearer token without it' };
  }
  const profile = options.profile ?? DEFAULT_ANTHROPIC_CONSOLE_PROFILE;
  const spawnFn = options.spawn ?? Bun.spawn;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = spawnFn([options.antExecutable, "auth", "print-credentials", "--profile", profile, "--access-token"], {
      env: brokerEnv(options.anthropicConfigDir),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { ok: false, reason: `"ant auth print-credentials" could not be started: ${err instanceof Error ? err.message : String(err)}` };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array> | undefined).text(),
    new Response(child.stderr as ReadableStream<Uint8Array> | undefined).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const lastLine = stderr
      .trim()
      .split("\n")
      .map((line) => redactUrlQuery(line))
      .filter((line) => line.length > 0)
      .at(-1);
    return { ok: false, reason: lastLine ?? `"ant auth print-credentials" exited with code ${exitCode}` };
  }
  const token = stdout.trim();
  if (token.length === 0) return { ok: false, reason: '"ant auth print-credentials" printed no token' };
  const now = options.now ?? Date.now;
  const nowValue = now();
  let expiresAt = (await readProfileExpiresAt(options.anthropicConfigDir, profile)) ?? nowValue + 3_600_000;
  // M3-units (P10a, whole-branch review): a normalised-but-still-wrong or clock-skewed profile value
  // can come back at or before `now`. This function's contract to its caller is "a usable bearer, not
  // an already-expired one" -- an `expiresAt` in the past would tell a refresh timer the credential is
  // fine right up until the moment it fails upstream. Clamped to a short, clearly-a-clamp window
  // rather than the normal 1h fallback, so a caller inspecting the value can tell this path fired.
  // Named ONLY by this function's own name in the note (never the profile's raw value, which is not
  // secret but is still host-file content this file has no other reason to echo).
  if (expiresAt <= nowValue) {
    options.onLine?.("refreshAnthropicBearer: profile expiresAt was not in the future; clamped to now+60s");
    expiresAt = nowValue + 60_000;
  }
  const material: Extract<CredentialMaterial, { kind: "bearer" }> = { kind: "bearer", token, expiresAt };
  const ref = anthropicCredentialRef("default", options.service);
  try {
    await store.set(ref, material);
  } catch {
    // Never reproduce the underlying store's own message (the repo-wide rule): it may quote the
    // token it failed to persist, and this function's OWN redaction discipline is worth nothing if
    // the store it calls has none of its own.
    return { ok: false, reason: "the bearer credential could not be written" };
  }
  return { ok: true, expiresAt };
}

/** Fix round 1, item 4 (MINOR): the read cap. A profile file is a small JSON object; anything past this is not one this function was written to trust. */
const MAX_PROFILE_FILE_BYTES = 64 * 1024;

/**
 * Reads `expires_at` out of `<anthropicConfigDir>/credentials/<profile>.json` -- ONLY that one field
 * is ever read, and it is never logged or echoed. `undefined` for anything unreadable, oversized, or
 * malformed: a file this function cannot parse is not evidence of an EXPIRED token, so
 * `refreshAnthropicBearer` falls back to a conservative estimate rather than treating "unknown" as
 * "already expired".
 *
 * READ AT MOST `MAX_PROFILE_FILE_BYTES` (fix round 1, item 4): this file is HOST-WRITTEN, not
 * attacker-controlled in the usual sense, but "controlled by a process this one merely spawned"
 * still earns a bound -- a truncated read fails `JSON.parse` exactly like a malformed one and this
 * function already tolerates that, so the cap costs nothing on the happy path and stops an
 * unexpectedly huge file from being read into memory whole.
 *
 * UNIT NORMALISED (M3-units, whole-branch review of P10a; confirmed by Lane S round 2's measurement --
 * the writer stamps `Math.floor(ms / 1000)`, i.e. SECONDS): a numeric value under 1e12 is treated as
 * seconds (`*1000`); at or above 1e12 as milliseconds already; a string is parsed as ISO-8601;
 * anything else is `undefined` (the conservative fallback in `refreshAnthropicBearer`).
 */
async function readProfileExpiresAt(anthropicConfigDir: string, profile: string): Promise<number | undefined> {
  try {
    const raw = await Bun.file(join(anthropicConfigDir, "credentials", `${profile}.json`))
      .slice(0, MAX_PROFILE_FILE_BYTES)
      .text();
    const parsed = JSON.parse(raw) as { expires_at?: unknown };
    return normalizeExpiresAt(parsed.expires_at);
  } catch {
    return undefined;
  }
}

/**
 * M3-units: normalises an unverified `expires_at` value into epoch milliseconds.
 *
 *   - a FINITE NUMBER under 1e12 is treated as epoch SECONDS (any millisecond timestamp for a date
 *     after 2001-09-09 is >= 1e12, so this threshold never misclassifies a real ms value as seconds);
 *     >= 1e12 is trusted as milliseconds already.
 *   - a STRING is parsed as ISO-8601 via `Date.parse`; an unparseable string is `undefined`.
 *   - anything else (missing, `null`, a non-finite number, an object) is `undefined`.
 *
 * `undefined` is deliberately NOT "expired" -- `refreshAnthropicBearer` treats it as "unknown" and
 * falls back to its own conservative now+1h estimate, per this file's existing rule.
 */
function normalizeExpiresAt(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Does `<anthropicConfigDir>/credentials/<profile>.json` exist? A plain file-exists check -- this file never opens or parses it here. */
export function anthropicConsoleProfileExists(anthropicConfigDir: string, profile: string = DEFAULT_ANTHROPIC_CONSOLE_PROFILE): boolean {
  return existsSync(join(anthropicConfigDir, "credentials", `${profile}.json`));
}

/**
 * Runs `ant auth logout --profile <p>` (Lane S round 2: never `--all`, and never `claude auth
 * logout`, which does not touch what this file's login writes) and then deletes the bearer material
 * regardless of whether the binary succeeded -- a host that cannot reach the binary should still be
 * able to forget the bearer material it already holds; leaving it in the Keychain because a
 * subprocess failed would be the worse of the two failures.
 *
 * NO `antExecutable` (item 2): refuses to spawn anything and reports why on the progress channel
 * (`onLine`) before still deleting the stored material -- this function returns `Promise<void>`, so
 * that channel is the only way to surface the reason, and "the stray binary is unreachable" is never
 * a reason to leave a bearer record a host explicitly asked to forget.
 */
export async function logoutAnthropicConsole(store: CredentialStore, options: AnthropicConsoleBrokerOptions): Promise<void> {
  requireBunRuntime("logoutAnthropicConsole", "Bun.spawn", "Signing out spawns the `ant` binary, which needs Bun's subprocess API. Run it under Bun.");
  const profile = options.profile ?? DEFAULT_ANTHROPIC_CONSOLE_PROFILE;
  if (options.antExecutable === undefined) {
    options.onLine?.(
      'the "ant" broker is not installed/resolved (settings.runtimes.antExecutable, or `brew install anthropics/tap/ant`) -- skipping "ant auth logout"; the stored bearer material is still removed',
    );
  } else {
    const spawnFn = options.spawn ?? Bun.spawn;
    try {
      const child = spawnFn([options.antExecutable, "auth", "logout", "--profile", profile], { env: brokerEnv(options.anthropicConfigDir), stdout: "pipe", stderr: "pipe" });
      await child.exited;
    } catch {
      // Best-effort, per the doc comment above.
    }
  }
  await store.delete(anthropicCredentialRef("default", options.service));
}

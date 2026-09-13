// D20, host-brokered (P10a-1 amendment, 2026-09-13): Anthropic Console OAuth through Anthropic's OWN
// broker binaries -- `claude auth login --console` (the official Claude Agent SDK's CLI, already
// embedded for the official leg, P9c-1) and `ant auth print-credentials` (the Anthropic Platform CLI)
// -- never a re-implementation of the OAuth protocol itself. `console-oauth.ts`'s banner is the
// account of what THAT looked like and why it was retired; this file is the thing that replaced it,
// per the user's 2026-09-13 scope amendment putting the broker in the SDK runtime (beside
// `codex-oauth.ts`/`xai-oauth.ts`) rather than solely in Winter's daemon.
//
// MEASURED ON THE REAL BINARY (2.1.250), not assumed -- every behavioural claim below is what the
// controller's M2 measurement observed, not a guess about how such a CLI "should" behave:
//
//   `claude auth login --console` PRINTS the authorize URL and a `Paste code here if prompted > `
//   prompt, then BLOCKS on stdin. The URL carries a ONE-TIME `code=` query parameter -- Anthropic's
//   own redirect target, not a URL this file constructs -- so every line handed to a host is stripped
//   of any URL's query string before it ever reaches `onLine`: an operator who pastes a progress line
//   to ask for help must never also paste a live one-time code. `redactUrlQuery` is the one function
//   that does this, and it runs on every line, not just ones that look like prompts.
//
//   The code arrives on a PASTED LINE, not a loopback callback -- unlike D20's retired PKCE client,
//   this binary exposes no redirect URI a Winter process could intercept, because Winter is not party
//   to the OAuth exchange at all. Anthropic's own official binary is, and only that binary ever holds
//   a token during this step: `submitCode` writes the operator's paste to the child's stdin and closes
//   it, exactly as a human would at that same prompt.
//
//   `ANTHROPIC_PROFILE`/`ANTHROPIC_CONFIG_DIR` route the write to Winter's own profile+dir (P10a-2);
//   `CLAUDE_CONFIG_DIR` is P9c-1's own variable for the official leg's config, carried on every spawn
//   alongside it because a build of `claude` may consult either.
//
//   `ant auth print-credentials --profile <p> --access-token` reads the profile THIS login just wrote
//   and prints a bare token to stdout, nothing else. The token is never logged and never appears in
//   an error message anywhere in this file -- the one place it is ever held is the one
//   `store.set(...)` call that writes it as `CredentialMaterial`.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireBunRuntime } from "../../bun-required.ts";
import type { CredentialMaterial, CredentialStore } from "../../types.ts";
import { anthropicCredentialRef } from "./console-oauth.ts";

/** `ANTHROPIC_PROFILE`'s default (P10a-2) -- one profile for the login, the official leg, and every `ant` call. */
export const DEFAULT_ANTHROPIC_CONSOLE_PROFILE = "winter";

/** Config every door in this file shares -- one process env, one profile, one pair of binaries. */
export interface AnthropicConsoleBrokerOptions {
  /** The resolved `claude` executable -- the SAME binary the official leg spawns (P9c-1). */
  claudeExecutable: string;
  /**
   * The resolved `ant` executable. Absent means "not installed/resolved" -- `refreshAnthropicBearer`
   * answers a named, typed failure rather than throwing or leaving a login half-finished.
   */
  antExecutable?: string;
  /** `<home>/runtimes/anthropic-config` (P10a-2). Created by the HOST before this file is ever called; this file only reads and writes inside it, never creates it. */
  anthropicConfigDir: string;
  /** P9c-1's own config dir for the official leg's OWN credentials, carried on every spawn alongside `anthropicConfigDir` because a build of `claude` may read either variable. */
  claudeConfigDir: string;
  /** `ANTHROPIC_PROFILE`. Defaults to `DEFAULT_ANTHROPIC_CONSOLE_PROFILE`. */
  profile?: string;
  /** The Keychain service the bearer material lands in -- `config.keychainService` from the host. */
  service?: string;
  /**
   * Every stdout/stderr line, in the order this file observed them, REDACTED of any URL's query
   * string before this file ever calls it (R6-F: a progress channel, never material).
   */
  onLine?: (line: string) => void;
  /** Injectable for a fixture: a stub executable under mkdtemp, never the real `claude`/`ant`. */
  spawn?: typeof Bun.spawn;
  now?: () => number;
}

export interface AnthropicConsoleLoginHandle {
  /**
   * Writes `code + "\n"` to the child's stdin and closes it -- exactly what a human types at the
   * `Paste code here if prompted > ` prompt. Resolves once the write completes, NOT once the login
   * finishes; await `done` for that. Calling this before the child is ready for input, or more than
   * once, is a caller error this file does not guard against -- the same trust boundary `openUrl`
   * callers already hold for every other login in this package.
   */
  submitCode(code: string): Promise<void>;
  /**
   * Resolves on process exit. A non-zero exit is `{ ok: false, reason }`, the reason being the last
   * non-empty stderr line this file observed (already redacted) -- never the bare exit code alone,
   * and never a URL. A ZERO exit is only `{ ok: true, profile }` once `refreshAnthropicBearer` has
   * ALSO succeeded: an exit-0 login that could not mint a usable bearer is not a login Winter can act
   * on, so this file does not report success until both steps have.
   */
  done: Promise<{ ok: true; profile: string } | { ok: false; reason: string }>;
}

function brokerEnv(options: Pick<AnthropicConsoleBrokerOptions, "anthropicConfigDir" | "claudeConfigDir">, profile: string): Record<string, string> {
  return {
    ...process.env,
    ANTHROPIC_PROFILE: profile,
    ANTHROPIC_CONFIG_DIR: options.anthropicConfigDir,
    CLAUDE_CONFIG_DIR: options.claudeConfigDir,
  } as Record<string, string>;
}

/**
 * Strips the query string off every `http(s)` URL a line contains, replacing it with a literal `…`.
 * Applied to EVERY line this file hands a host, not only ones that look like a prompt -- a one-time
 * `code=` parameter is exactly the kind of value that looks unremarkable until it is the one line
 * someone pastes into a support channel.
 */
function redactUrlQuery(line: string): string {
  return line.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1?…");
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

/**
 * Starts `claude auth login --console` and returns a handle a host drives interactively: it prints
 * the authorize URL and a prompt through `onLine`, and the host calls `submitCode` once the operator
 * has one. See the file banner for what was MEASURED about this shape rather than assumed.
 *
 * SYNCHRONOUS RETURN, matching `runGit`'s own precedent for a spawn that can fail before any process
 * exists: `Bun.spawn` throws SYNCHRONOUSLY on an unresolvable executable (ENOENT), and a function that
 * only surfaced that inside an async `done` would leave a caller unable to tell "the binary doesn't
 * exist" from "the login is running" until the first `await`. Here it is instead reflected into an
 * ALREADY-SETTLED handle: `done` is already resolved `{ ok: false, reason }`, and `submitCode` is a
 * no-op precisely because there is no process to write to.
 */
export function startAnthropicConsoleBrokerLogin(store: CredentialStore, options: AnthropicConsoleBrokerOptions): AnthropicConsoleLoginHandle {
  requireBunRuntime(
    "startAnthropicConsoleBrokerLogin",
    "Bun.spawn",
    "The Console login has to spawn the `claude` binary and pipe its stdin/stdout/stderr, which needs Bun's subprocess API. Run the login under Bun (or complete it in a Bun process and pass the resulting credential ref to your Node session).",
  );
  const profile = options.profile ?? DEFAULT_ANTHROPIC_CONSOLE_PROFILE;
  const onLine = options.onLine ?? (() => {});
  const spawnFn = options.spawn ?? Bun.spawn;

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = spawnFn([options.claudeExecutable, "auth", "login", "--console"], {
      env: brokerEnv(options, profile),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const reason = `"claude auth login --console" could not be started: ${err instanceof Error ? err.message : String(err)}`;
    return { submitCode: async () => {}, done: Promise.resolve({ ok: false, reason }) };
  }

  const stderrLines: string[] = [];
  const stdoutPump = drainStream(child.stdout as ReadableStream<Uint8Array> | undefined, onLine);
  const stderrPump = drainStream(child.stderr as ReadableStream<Uint8Array> | undefined, onLine, stderrLines);

  const done = (async (): Promise<{ ok: true; profile: string } | { ok: false; reason: string }> => {
    const [exitCode] = await Promise.all([child.exited, stdoutPump, stderrPump]);
    if (exitCode !== 0) {
      const reason = stderrLines.at(-1) ?? `"claude auth login --console" exited with code ${exitCode}`;
      return { ok: false, reason };
    }
    const refreshed = await refreshAnthropicBearer(store, options);
    if (!refreshed.ok) return { ok: false, reason: refreshed.reason };
    return { ok: true, profile };
  })();

  return {
    async submitCode(code: string): Promise<void> {
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
      env: brokerEnv(options, profile),
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
  const expiresAt = (await readProfileExpiresAt(options.anthropicConfigDir, profile)) ?? now() + 3_600_000;
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

/**
 * Reads `expires_at` out of `<anthropicConfigDir>/credentials/<profile>.json` -- ONLY that one field
 * is ever read, and it is never logged or echoed. `undefined` for anything unreadable or malformed:
 * a file this function cannot parse is not evidence of an EXPIRED token, so `refreshAnthropicBearer`
 * falls back to a conservative estimate rather than treating "unknown" as "already expired".
 *
 * UNVERIFIED UNIT (flagged for the controller's M3): assumed epoch MILLISECONDS, matching every other
 * `expiresAt` this package carries (`CredentialMaterial`'s `oauth` variant, `OAuthTokens`). If the
 * profile file's own `expires_at` turns out to be epoch SECONDS instead, this reads as ~1970 and the
 * broker refresh timer fires immediately rather than never -- wrong in the SAFE direction (refreshes
 * too often, never too rarely), but still worth measuring rather than shipping as an assumption.
 */
async function readProfileExpiresAt(anthropicConfigDir: string, profile: string): Promise<number | undefined> {
  try {
    const raw = await readFile(join(anthropicConfigDir, "credentials", `${profile}.json`), "utf8");
    const parsed = JSON.parse(raw) as { expires_at?: unknown };
    return typeof parsed.expires_at === "number" ? parsed.expires_at : undefined;
  } catch {
    return undefined;
  }
}

/** Does `<anthropicConfigDir>/credentials/<profile>.json` exist? A plain file-exists check -- this file never opens or parses it here. */
export function anthropicConsoleProfileExists(anthropicConfigDir: string, profile: string = DEFAULT_ANTHROPIC_CONSOLE_PROFILE): boolean {
  return existsSync(join(anthropicConfigDir, "credentials", `${profile}.json`));
}

/**
 * Runs `claude auth logout` (best-effort) and then deletes the bearer material regardless of whether
 * the binary succeeded -- a host that cannot reach the binary should still be able to forget the
 * bearer material it already holds; leaving it in the Keychain because a subprocess failed would be
 * the worse of the two failures.
 */
export async function logoutAnthropicConsole(store: CredentialStore, options: AnthropicConsoleBrokerOptions): Promise<void> {
  requireBunRuntime("logoutAnthropicConsole", "Bun.spawn", "Signing out spawns the `claude` binary, which needs Bun's subprocess API. Run it under Bun.");
  const profile = options.profile ?? DEFAULT_ANTHROPIC_CONSOLE_PROFILE;
  const spawnFn = options.spawn ?? Bun.spawn;
  try {
    const child = spawnFn([options.claudeExecutable, "auth", "logout"], { env: brokerEnv(options, profile), stdout: "pipe", stderr: "pipe" });
    await child.exited;
  } catch {
    // Best-effort, per the doc comment above.
  }
  await store.delete(anthropicCredentialRef("default", options.service));
}

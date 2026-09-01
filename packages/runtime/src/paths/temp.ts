import { lstatSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { isUnset } from "./home.ts";

export class WinterPathsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WinterPathsError";
  }
}

const SAFE_KEY_SEGMENT = /^[A-Za-z0-9-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_KEY_SEGMENT.test(value)) {
    throw new WinterPathsError(
      `invalid ${label} ${JSON.stringify(value)}: expected non-empty [A-Za-z0-9-]+ (no path separators or traversal)`,
    );
  }
}

// process.getuid is POSIX-only; this package is Bun-only and macOS-first (Ruling P1-C), so a
// non-null assertion is appropriate here — there is no supported target where it is absent.
function realUid(): number {
  return process.getuid!();
}

// Exported so the foreign-owner refusal branch is reachable without root (task-6-brief: "assert
// the CHECK exists by unit-testing the validator's branch, not by faking uid") — callers construct
// a stat-shaped object directly. Accepts a minimal duck-typed shape rather than a full fs.Stats so
// a test never needs a real Stats instance to exercise this.
export function assertOwnedDir(
  stat: Pick<Stats, "uid"> & { isDirectory(): boolean; isSymbolicLink(): boolean },
  pathForError: string,
): void {
  if (stat.isSymbolicLink()) throw new WinterPathsError(`refusing a symlink at a level Winter must own: ${pathForError}`);
  if (!stat.isDirectory()) throw new WinterPathsError(`expected a directory, found something else at: ${pathForError}`);
  if (stat.uid !== realUid()) throw new WinterPathsError(`refusing a directory owned by a different uid: ${pathForError}`);
}

// Create-if-missing, then always lstat-validate (own uid, real directory, never a symlink — even a
// dangling one, which is why creation failure is routed through the SAME validation rather than
// trusted at face value) and self-heal the mode to exactly 0700. Every level this resolver walks
// goes through here (WS-05 §9 MUST: "0700 directories... throughout").
function ensureValidatedDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(path); // lstat, never stat — a symlink (dangling or not) must be caught, not followed
  assertOwnedDir(stat, path);
  chmodSync(path, 0o700); // idempotent self-heal — this whole chain is Winter-owned
}

// WINTER_TMPDIR || "/tmp" (blank = unset, same rule as WINTER_HOME — see home.ts's isUnset).
// Exported so the DEFAULT can be asserted as a pure string decision in tests, never by actually
// creating directories under the real, shared /tmp/winter-<uid> chain.
export function resolveTempBase(env?: Record<string, string | undefined>): string {
  const override = (env ?? process.env).WINTER_TMPDIR;
  return isUnset(override) ? "/tmp" : (override as string);
}

export interface SessionTempDirOptions {
  tempProjectKey: string;
  backendUuid: string;
  env?: Record<string, string | undefined>;
}

export interface SessionTempDirPaths {
  root: string;
  scratchpad: string;
  tasks: string;
}

// D18: ${realpath(WINTER_TMPDIR|/tmp)}/winter-<uid>/winter-<uid>/<tempProjectKey>/<backendUuid>/
// — the OUTER "winter-<uid>" is the shared per-user root (the value handed to a spawned
// official-branch child as CLAUDE_CODE_TMPDIR, whose own hard-coded sibling becomes claude-<uid>
// alongside it); the INNER "winter-<uid>" is Winter's own engine directory, following the
// identical <engine>-<uid>/<key>/<uuid> shape as that sibling. Only the base is realpath'd (macOS
// /tmp -> /private/tmp) — done ONCE, up front, before composing the rest of the chain; every level
// beneath it is created/validated by ensureValidatedDir above, never realpath'd again. scratchpad/
// is created eagerly here; tasks/ stays lazy (see ensureTasksDir). `uid` is always the real
// process uid (process.getuid()) — never injectable, never a fixed literal: a fixed suffix would
// let one user's 0700 root lock out every other user on a shared machine.
export function sessionTempDir(opts: SessionTempDirOptions): SessionTempDirPaths {
  assertSafeSegment(opts.tempProjectKey, "tempProjectKey");
  assertSafeSegment(opts.backendUuid, "backendUuid");

  const base = realpathSync(resolveTempBase(opts.env));
  const uid = realUid();
  const sharedRoot = join(base, `winter-${uid}`);
  const engineDir = join(sharedRoot, `winter-${uid}`);
  const projectDir = join(engineDir, opts.tempProjectKey);
  const sessionDir = join(projectDir, opts.backendUuid);
  const scratchpad = join(sessionDir, "scratchpad");
  const tasks = join(sessionDir, "tasks");

  for (const level of [sharedRoot, engineDir, projectDir, sessionDir, scratchpad]) {
    ensureValidatedDir(level);
  }

  return { root: sessionDir, scratchpad, tasks };
}

// Lazy tasks/ creation (WS-05 §9/§10: "tasks/ is a sibling of scratchpad/, created lazily at first
// task"). First call creates + validates it; later calls are a validated no-op that returns the
// same path.
export function ensureTasksDir(paths: Pick<SessionTempDirPaths, "tasks">): string {
  ensureValidatedDir(paths.tasks);
  return paths.tasks;
}

import { lstatSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
// home.ts moved to the sdk package (Task 10, WS-05 §6) — isUnset is the one piece of it this
// runtime-private module still needs; reused from there rather than re-implemented, preserving
// the "one shared blank-env-value rule" this file's own resolveTempBase comment documents.
import { isUnset, WINTER_BRAND, envName, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

// P7a (D19): the two brand fields this module needs, as a `Pick` rather than the whole profile --
// the same shape (and the same reason) as the sdk's `HomeBrand`: a caller holding a partially
// threaded config, or a test, can call these without constructing a full profile. `brand` defaults
// to `WINTER_BRAND` at every entry point below, so a caller that has not threaded one yet keeps
// exactly today's behaviour.
export type TempBrand = Pick<BrandProfile, "envPrefix" | "tempRootName">;

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
    // T6 fix-wave (doc note): a non-EEXIST failure here (EACCES, a missing/non-directory parent,
    // resource exhaustion, ...) is deliberately re-thrown UNWRAPPED — the raw Node error, not a
    // WinterPathsError. This mirrors session-store.ts's identical ensureSecureDir catch (same
    // shape, same choice): only the conditions this module actually VALIDATES (symlink, wrong
    // owner, wrong type — see assertOwnedDir below) get this module's own typed error; a plain
    // filesystem failure it never attempted to interpret is more honestly surfaced as-is than
    // repackaged into a WinterPathsError that would imply this code understood what went wrong.
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
  }
  const stat = lstatSync(path); // lstat, never stat — a symlink (dangling or not) must be caught, not followed
  assertOwnedDir(stat, path);
  chmodSync(path, 0o700); // idempotent self-heal — this whole chain is Winter-owned
}

// `<PREFIX>TMPDIR` || "/tmp" (blank = unset, same rule as `<PREFIX>HOME` — see home.ts's isUnset).
// Exported so the DEFAULT can be asserted as a pure string decision in tests, never by actually
// creating directories under the real, shared /tmp/<tempRootName>-<uid> chain.
//
// P7a (D19): THE ENV NAME IS DERIVED, NEVER SPELLED, and it is read INSIDE this function — the
// brand arrives with `--config-json`, so a module-load read would bake in Winter's own prefix for a
// reuser and could never be corrected (brand-gate rules 9 and 10 pin both halves of that).
export function resolveTempBase(env?: Record<string, string | undefined>, brand?: Pick<BrandProfile, "envPrefix">): string {
  const override = (env ?? process.env)[envName(brand ?? WINTER_BRAND, "TMPDIR")];
  return isUnset(override) ? "/tmp" : (override as string);
}

export interface SessionTempDirOptions {
  tempProjectKey: string;
  backendUuid: string;
  env?: Record<string, string | undefined>;
  /** P7a (D19): the session's resolved brand. Omitted = `WINTER_BRAND`, i.e. today's names. */
  brand?: TempBrand;
}

export interface SessionTempDirPaths {
  root: string;
  scratchpad: string;
  tasks: string;
}

// D18: ${realpath(<PREFIX>TMPDIR|/tmp)}/<root>-<uid>/<root>-<uid>/<tempProjectKey>/<backendUuid>/,
// where <root> is `brand.tempRootName`
// — the OUTER "<root>-<uid>" is the shared per-user root (the value handed to a spawned
// official-branch child as CLAUDE_CODE_TMPDIR, whose own hard-coded sibling becomes claude-<uid>
// alongside it); the INNER "<root>-<uid>" is Winter's own engine directory, following the
// identical <engine>-<uid>/<key>/<uuid> shape as that sibling. Only the base is realpath'd (macOS
// /tmp -> /private/tmp) — done ONCE, up front, before composing the rest of the chain; every level
// beneath it is created/validated by ensureValidatedDir above, never realpath'd again. scratchpad/
// is created eagerly here; tasks/ stays lazy (see ensureTasksDir). `uid` is always the real
// process uid (process.getuid()) — never injectable, never a fixed literal: a fixed suffix would
// let one user's 0700 root lock out every other user on a shared machine.
export function sessionTempDir(opts: SessionTempDirOptions): SessionTempDirPaths {
  assertSafeSegment(opts.tempProjectKey, "tempProjectKey");
  assertSafeSegment(opts.backendUuid, "backendUuid");

  const brand = opts.brand ?? WINTER_BRAND;
  const base = realpathSync(resolveTempBase(opts.env, brand));
  const uid = realUid();
  const sharedRoot = join(base, `${brand.tempRootName}-${uid}`);
  const engineDir = join(sharedRoot, `${brand.tempRootName}-${uid}`);
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

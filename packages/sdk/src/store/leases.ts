// WS-05 §13: one exclusive writer lease per (projectKey, sessionId) — NOT per subpath, so a
// subagent transcript append competes for the SAME lease as its parent session's main transcript.
// P1 stores `{pid, startTimeMs}` in a `<sessionId>.lock` JSON sidecar and detects staleness by
// pid-liveness alone (process.kill(pid, 0) semantics); P8 does full identity revalidation using
// startTimeMs (recorded now, unused for detection until then — a reused pid after a reboot is an
// accepted P1 gap the brief explicitly defers). Same-PROCESS re-entry (the same OS pid re-acquiring
// its own live lease — e.g. two `WinterCompatibilitySessionStore` instances in one process) always
// succeeds; a DIFFERENT, still-live pid throws WinterStoreLeaseError.
import { openSync, readFileSync, writeSync, fsyncSync, closeSync, renameSync, linkSync, unlinkSync } from "node:fs";

export class WinterStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WinterStoreError";
  }
}

export class WinterStoreLeaseError extends WinterStoreError {
  constructor(
    message: string,
    public readonly heldByPid: number,
  ) {
    super(message);
    this.name = "WinterStoreLeaseError";
  }
}

export interface LeaseInfo {
  pid: number;
  startTimeMs: number;
}

// process.kill(pid, 0) sends no signal — it only probes whether the target pid could be signaled.
// ESRCH -> gone (stale); EPERM -> exists but owned by another user (still alive: Winter treats
// "can't prove it's dead" as alive, the safer direction — it would rather refuse a lease than
// silently steal one from a live foreign process); anything else rethrows.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

// Fully writes `buf` to `fd`, looping on the rare partial-write return from a single writeSync
// call (Node/Bun's documented contract: the return value is bytes actually written, which for a
// regular file is normally the whole buffer in one call, but is not GUARANTEED to be — looping
// here is the correct, defensive way to issue "one complete logical write", not the "chunking"
// P1-C's ruling warns against, which is about never splitting one caller-supplied batch across
// multiple INDEPENDENT write calls with other work interleaved between them).
export function writeAllSync(fd: number, buf: Buffer): void {
  let written = 0;
  while (written < buf.length) {
    written += writeSync(fd, buf, written, buf.length - written);
  }
}

// Exported (fix-wave, Ruling P1-S) so a caller that must never MUTATE a lease — session-store.ts's
// load(), deciding whether a torn tail's repair should defer to a live foreign writer — can peek at
// who holds it without going through acquireLease's own create-or-steal side effects. Semantics
// unchanged from its original private form: absent, unparseable, or shape-invalid all read as null.
export function readLeaseInfo(lockPath: string): LeaseInfo | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.startTimeMs === "number") {
      return { pid: parsed.pid, startTimeMs: parsed.startTimeMs };
    }
  } catch {
    // unparseable — fall through and treat exactly like a stale/absent lease below
  }
  return null;
}

// Fix-wave (T7 review F1, MODERATE-LOW): the ORIGINAL version of this function opened `lockPath`
// itself with O_CREAT|O_EXCL (atomic creation) and only THEN wrote its content — leaving a real,
// if sub-microsecond, window where the path exists as an EMPTY file. A second acquirer racing in
// during exactly that window would see EEXIST from its own createExclusive attempt, read back the
// (still-empty, unparseable) lockPath, conclude "corrupt ⇒ stale," and STEAL it via
// writeLeaseInfoReplacing's rename — which replaces the DIRECTORY ENTRY at lockPath but does
// nothing to the first opener's already-open file descriptor, still pointing at the now-orphaned
// original inode. The first opener's in-flight write/fsync above then lands invisibly, off the
// path, while genuinely believing (createExclusive never threw) that it holds the lease the second
// process just replaced — two live holders, silently.
//
// Fix (write-then-expose): fully write and fsync the lease's content to a fresh, uniquely-named
// temp file FIRST — before `lockPath` is ever touched — then atomically EXPOSE it via linkSync,
// which (like the O_CREAT|O_EXCL it replaces) fails with EEXIST if anything already sits at
// `lockPath`, but never allows a reader to observe a partially-written state at that path: it is
// either absent, or already carries its final bytes, with no state in between. A concurrent
// corrupt-steal is therefore never possible during a fresh acquire — a competitor's steal and this
// call's expose now race on the SAME atomic linkSync-vs-linkSync (or rename-vs-linkSync) primitive
// every other path in this file already uses, not on a read of transient empty content.
function createExclusive(lockPath: string, info: LeaseInfo): void {
  const data = Buffer.from(JSON.stringify(info), "utf8");
  const tmpPath = `${lockPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmpPath, "wx", 0o600); // fresh unique name — never collides with a concurrent acquirer
  try {
    writeAllSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmpPath, lockPath); // atomic expose; throws EEXIST (propagated to acquireLease's own catch) if beaten
  } finally {
    // The temp name is disposable the instant link either succeeds (lockPath now has its own name
    // for the same inode; the temp name is redundant) or fails (nothing was ever exposed under it).
    // ENOENT-tolerant only — anything else here would mask the real linkSync outcome above.
    try {
      unlinkSync(tmpPath);
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    }
  }
}

function writeLeaseInfoReplacing(lockPath: string, info: LeaseInfo): void {
  // write-temp + rename: an atomic replace. rename() swaps the directory entry regardless of what
  // (if anything, symlink included) currently sits at `lockPath` — it never follows/writes through
  // an existing symlink there, unlike a plain re-open in "w"/"a" mode would.
  const data = Buffer.from(JSON.stringify(info), "utf8");
  const tmpPath = `${lockPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeAllSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, lockPath);
}

// Acquires (or re-verifies) the exclusive writer lease at `lockPath` for the CURRENT process.
// Returns the LeaseInfo now on disk (freshly written, or the pre-existing one on re-entry).
// Throws WinterStoreLeaseError when a DIFFERENT, still-live pid holds it.
export function acquireLease(lockPath: string): LeaseInfo {
  const fresh: LeaseInfo = { pid: process.pid, startTimeMs: Date.now() };

  // Common/fast path: nobody holds a lease yet. O_EXCL makes creation atomic against a second
  // process racing to create the SAME brand-new session's lease at the same instant.
  try {
    createExclusive(lockPath, fresh);
    return fresh;
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
  }

  const existing = readLeaseInfo(lockPath);
  if (existing !== null && existing.pid === process.pid) {
    return existing; // same-process re-entry — the original startTimeMs is left untouched
  }
  if (existing !== null && isPidAlive(existing.pid)) {
    throw new WinterStoreLeaseError(
      `session lease is held by another live process (pid ${existing.pid}); refusing a concurrent writer`,
      existing.pid,
    );
  }
  // Stale (holder's pid is gone) or an unreadable/corrupt lock file either way: steal it. This
  // replacement is best-effort, not itself race-free against a second concurrent stealer reaching
  // the same conclusion at the same instant — P1 accepts that gap (see module doc: P8 does full
  // identity revalidation).
  writeLeaseInfoReplacing(lockPath, fresh);
  return fresh;
}

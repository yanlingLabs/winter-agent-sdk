// WS-05 §13: one exclusive writer lease per (projectKey, sessionId) — NOT per subpath, so a
// subagent transcript append competes for the SAME lease as its parent session's main transcript.
// P1 stores `{pid, startTimeMs}` in a `<sessionId>.lock` JSON sidecar and detects staleness by
// pid-liveness alone (process.kill(pid, 0) semantics); P8 does full identity revalidation using
// startTimeMs (recorded now, unused for detection until then — a reused pid after a reboot is an
// accepted P1 gap the brief explicitly defers). Same-PROCESS re-entry (the same OS pid re-acquiring
// its own live lease — e.g. two `WinterCompatibilitySessionStore` instances in one process) always
// succeeds; a DIFFERENT, still-live pid throws WinterStoreLeaseError.
import { openSync, readFileSync, writeSync, fsyncSync, closeSync, renameSync } from "node:fs";

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

function readLeaseInfo(lockPath: string): LeaseInfo | null {
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

function createExclusive(lockPath: string, info: LeaseInfo): void {
  const fd = openSync(lockPath, "wx", 0o600); // O_CREAT|O_EXCL|O_WRONLY: fails if ANYTHING already
  try {
    // exists at this path (symlink included) — atomic w.r.t. a second concurrent fresh acquirer.
    writeAllSync(fd, Buffer.from(JSON.stringify(info), "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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

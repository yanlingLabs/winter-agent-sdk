// Phase 5 Task 7 (Lane K, R5-11 as amended): the RESTORE half -- `rewind(userMessageUuid, {dryRun?})`.
//
// The unit is an ENVELOPE. Everything recorded from the target envelope's first mutation onward is
// in scope, and each in-scope path is restored to the OLDEST snapshot at or after the target: a path
// first touched in a LATER envelope was, by construction, unchanged between the target and that
// envelope, so that envelope's own pre-image is its state at the target too.
//
// Applied in REVERSE record order -- newest first -- so the last write to any path is its oldest
// in-scope snapshot. Delta records carry no bytes and are skipped: they exist to say "this path was
// touched again inside an envelope that already has a snapshot", which changes nothing about where
// the restore lands.
//
// EVERY FAILURE IS AN ANSWER, NEVER A THROW: `{ canRewind: false, error }`. The pinned method
// returns a typed result, so a rejected promise would leave a host unable to tell "there is nothing
// to rewind to" from a transport fault.
import type { RewindFilesResult } from "@yanlinglabs/winter-agent-sdk";
import { lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { blobName, parentRealPathOf, readCheckpointIndex, sessionBackupsDir, type CheckpointRecord } from "./file-history.ts";

/**
 * Line counts, Winter-defined and DISCLOSED: the pin declares `insertions`/`deletions` as numbers and
 * defines no algorithm for them. This is a MULTISET (bag) difference -- for each distinct line, the
 * surplus in one side over the other -- which is O(n+m), deterministic, and exact for the pure
 * insert/delete edits a rewind actually undoes. A minimal-edit-script (LCS) count would be O(n*m)
 * over arbitrary files, and a rewind must not become the slowest thing in a session.
 *
 * `insertions` = lines the rewind ADDS (present in the restored content, missing from the current);
 * `deletions` = lines it REMOVES. Reported from the FILE's point of view, matching the direction a
 * host renders as "+/-".
 */
export function countLineDelta(current: string[], restored: string[]): { insertions: number; deletions: number } {
  const bag = new Map<string, number>();
  for (const line of current) bag.set(line, (bag.get(line) ?? 0) + 1);
  for (const line of restored) bag.set(line, (bag.get(line) ?? 0) - 1);
  let insertions = 0;
  let deletions = 0;
  for (const surplus of bag.values()) {
    if (surplus > 0) deletions += surplus;
    else if (surplus < 0) insertions += -surplus;
  }
  return { insertions, deletions };
}

/** A trailing newline terminates the last line rather than starting an empty one. */
export function splitLines(content: Buffer | undefined): string[] {
  if (content === undefined) return [];
  const text = content.toString("utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readCurrent(path: string): Buffer | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

/**
 * PATH-IDENTITY refusals: the recorded path no longer names the file the checkpoint was about, so a
 * restore would write into -- or DELETE -- somebody else's tree.
 *
 * Three independent guards, all cheap, none removable:
 *
 *  1. the nearest ancestor that existed at checkpoint time must still resolve to the same real
 *     directory (`anchorPath`/`anchorRealPath`);
 *  2. no component between that ancestor and the target may have become a symlink since;
 *  3. the legacy immediate-parent check, kept because removing a guard is never the safe direction
 *     and because it still protects records written by an earlier build.
 *
 * Guards 1 and 2 exist because guard 3 alone was INERT ON EXACTLY THE RECORDS THE DELETE ARM ACTS
 * ON: `parentRealPath` is absent precisely when the parent did not exist at checkpoint time, which
 * is the `absent: true` case, which is the case `rmSync` services. Replacing the not-yet-created
 * directory with a symlink then let a rewind delete a never-checkpointed file, silently.
 *
 * These are evaluated on a `dryRun` TOO -- see `rewindToCheckpoint` for why that is not the
 * "previews do not reflect refusals" clause.
 */
function pathIdentityRefusal(record: CheckpointRecord): string | undefined {
  if (record.anchorPath !== undefined && record.anchorRealPath !== undefined) {
    let nowReal: string | undefined;
    try {
      nowReal = realpathSync(record.anchorPath);
    } catch {
      nowReal = undefined;
    }
    if (nowReal !== record.anchorRealPath) return "its nearest checkpointed ancestor directory no longer resolves where it did";
    const linked = firstLinkedComponent(record.anchorPath, record.path);
    if (linked !== undefined) return `the path component ${linked} is now a symbolic link`;
  }
  if (record.parentRealPath !== undefined && parentRealPathOf(record.path) !== record.parentRealPath) {
    return "its parent directory no longer resolves where it did at checkpoint time";
  }
  return undefined;
}

/**
 * The first directory between `anchorPath` (exclusive) and `target` (exclusive) that is now a
 * symlink, or is present but not a directory. The LEAF is deliberately not examined here -- its own
 * state is `leafStateRefusal`'s business and carries a more specific message. A component that does
 * not exist is fine: nothing can be followed through it, and the write/delete arms handle absence.
 */
function firstLinkedComponent(anchorPath: string, target: string): string | undefined {
  const rest = relative(anchorPath, target).split(sep).filter((s) => s.length > 0);
  // `anchorPath` is an ancestor of `target` by construction; anything else is a record this build
  // did not write, and refusing to reason about it is the safe answer.
  if (rest.some((s) => s === "..")) return "..";
  let walked = anchorPath;
  for (const segment of rest.slice(0, -1)) {
    walked = join(walked, segment);
    try {
      const stat = lstatSync(walked);
      if (stat.isSymbolicLink()) return segment;
      if (!stat.isDirectory()) return segment;
    } catch {
      /* not there yet -- nothing to follow */
    }
  }
  return undefined;
}

/**
 * LEAF-STATE refusals, item (e)'s own list: the tracked path still names the intended file, but that
 * file is now a symlink, a hard link or a non-regular file, or its backup cannot be safely read.
 *
 * Evaluated on REAL rewinds only. This is the class item (e)'s "a preview's counts do not reflect
 * refusals" describes -- the plan targets the right path and the USER's tree moved under it.
 */
function leafStateRefusal(record: CheckpointRecord, backupPath: string | undefined): string | undefined {
  try {
    const stat = lstatSync(record.path);
    // lstat, never stat: `stat` would follow the very link this check exists to catch.
    if (stat.isSymbolicLink()) return "it is now a symbolic link";
    if (!stat.isFile()) return "it is no longer a regular file";
    if (stat.nlink > 1) return "it now has more than one hard link";
  } catch {
    /* the path is simply gone -- restoring it back into existence is the whole point, not a refusal */
  }
  if (backupPath !== undefined) {
    try {
      if (!statSync(backupPath).isFile()) return "its backup is not a regular file";
    } catch {
      return "its backup could not be read";
    }
  }
  return undefined;
}

export interface RewindOptions {
  home: string;
  sessionUuid: string;
  userMessageUuid: string;
  dryRun: boolean;
}

export function rewindToCheckpoint(opts: RewindOptions): RewindFilesResult {
  const records = readCheckpointIndex(opts.home, opts.sessionUuid);
  const from = records.findIndex((r) => r.userMessageUuid === opts.userMessageUuid);
  if (from === -1) {
    return { canRewind: false, error: `no checkpoint recorded for user message ${opts.userMessageUuid} in this session` };
  }
  const inScope = records.slice(from);
  const dir = sessionBackupsDir(opts.home, opts.sessionUuid);

  // Reverse order: the LAST write to a path is therefore its OLDEST in-scope snapshot, which is its
  // state at the target envelope. Deltas hold no bytes and are skipped.
  const plan = new Map<string, CheckpointRecord>();
  for (let i = inScope.length - 1; i >= 0; i--) {
    const record = inScope[i]!;
    if (record.kind !== "snapshot") continue;
    plan.set(record.path, record);
  }

  const filesChanged: string[] = [];
  let insertions = 0;
  let deletions = 0;
  let skippedLinks = 0;

  for (const record of plan.values()) {
    const backupPath = record.absent === true ? undefined : join(dir, blobName(record.pathHash, record.version));

    // TWO CLASSES OF REFUSAL, and only one of them is what item (e)'s dryRun clause is about.
    //
    // PATH-IDENTITY refusals are evaluated on BOTH paths. Item (e) says a preview's counts "do not
    // reflect refusals" -- that clause is about the USER's tree moving under a plan that still
    // targets the intended file, which is the leaf-state class below. A path-identity refusal means
    // the plan does not target the intended file at all, so listing it would put a WRONG PATH in
    // `filesChanged` and promise a host a deletion that will never happen. A preview must not
    // advertise a destructive change to a file the rewind was never about.
    //
    // LEAF-STATE refusals stay real-rewind-only, exactly as item (e) describes.
    //
    // `skippedLinks` is populated on real rewinds either way, and stays ABSENT on a preview.
    const identityRefusal = pathIdentityRefusal(record);
    if (identityRefusal !== undefined) {
      if (!opts.dryRun) skippedLinks++;
      continue;
    }
    if (!opts.dryRun) {
      const refused = leafStateRefusal(record, backupPath);
      if (refused !== undefined) {
        skippedLinks++;
        continue;
      }
    }

    const current = readCurrent(record.path);
    const restored = backupPath === undefined ? undefined : readCurrent(backupPath);

    // A snapshot whose BLOB IS GONE has nothing to restore from, and a real rewind refuses it above.
    // A preview must not then report the file as about to be deleted -- that is a plan that can
    // never run, which is a different thing from the refusals item (e) says a preview may miss (the
    // USER's tree changing under an otherwise valid plan). Only reachable on a corrupted store.
    if (opts.dryRun && record.absent !== true && restored === undefined) continue;

    const unchanged = current === undefined ? restored === undefined : restored !== undefined && current.equals(restored);
    if (unchanged) continue;

    const delta = countLineDelta(splitLines(current), splitLines(restored));
    insertions += delta.insertions;
    deletions += delta.deletions;
    filesChanged.push(record.path);

    if (opts.dryRun) continue;
    if (restored === undefined) {
      // The file did not exist at checkpoint time: the rewind removes it again.
      rmSync(record.path, { force: true });
    } else {
      writeFileSync(record.path, restored);
    }
  }

  return {
    canRewind: true,
    filesChanged,
    insertions,
    deletions,
    // Populated on REAL rewinds only. Absent rather than a misleading zero on a preview.
    ...(opts.dryRun ? {} : { skippedLinks }),
  };
}

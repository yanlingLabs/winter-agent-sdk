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
import { lstatSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * Item (e)'s link-safety rule, verbatim in behaviour: a tracked path that now resolves to a symlink,
 * a hard link or a non-regular file, or whose parent directory no longer resolves where it did at
 * checkpoint time, or whose backup cannot be safely read, is REFUSED rather than restored.
 *
 * Returns the reason for the refusal, or undefined when the restore may proceed. Evaluated on REAL
 * rewinds only -- see `rewindToCheckpoint`.
 */
function refusalReason(record: CheckpointRecord, backupPath: string | undefined): string | undefined {
  // The parent is checked FIRST: if the directory moved, nothing about the leaf is meaningful.
  if (record.parentRealPath !== undefined && parentRealPathOf(record.path) !== record.parentRealPath) {
    return "its parent directory no longer resolves where it did at checkpoint time";
  }
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

    // `dryRun` PREVIEWS: it never touches the filesystem and never evaluates refusals, so -- per
    // item (e) -- its counts deliberately do not reflect them. A preview that silently subtracted
    // refused files would under-report the change a real rewind is about to make in every case
    // where the refusal has not happened yet.
    if (!opts.dryRun) {
      const refused = refusalReason(record, backupPath);
      if (refused !== undefined) {
        skippedLinks++;
        continue;
      }
    }

    const current = readCurrent(record.path);
    const restored = backupPath === undefined ? undefined : readCurrent(backupPath);
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

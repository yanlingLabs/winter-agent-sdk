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
import { join, relative, resolve, sep } from "node:path";
import { blobName, nearestExistingAncestor, parentRealPathOf, readCheckpointIndex, sessionBackupsDir, type CheckpointRecord } from "./file-history.ts";

/**
 * T8 rider 25 (SECURITY): is `absPath` inside one of the session's own writable roots?
 *
 * `index.jsonl` is an ordinary file naming absolute paths, and this function used to act on every
 * one it found. Two independent layers already keep a MODEL away from that file (engine.ts's managed
 * `~/.winter/backups` write denies, and sandbox/profile.ts's seatbelt write-deny for a shell-invoked
 * write) -- this is the third: even GIVEN a hostile index, a rewind may only write or delete inside
 * the roots the session itself could write, so a forged record naming `~/.ssh/authorized_keys` is
 * refused rather than serviced.
 *
 * Roots are `cwd` plus whatever `additionalDirectories` the session ran with -- the same notion
 * `permissions/evaluator.ts`'s `boundedRoots` uses. A root that does not resolve is compared as
 * written; a rewind must not become unusable because one configured directory has since been
 * deleted.
 */
function isInsideSessionRoots(absPath: string, roots: readonly string[]): boolean {
  // RESOLVED, NOT COMPARED AS STRINGS. A string prefix check is defeated by one symlink: a Bash round
  // inside the session's own cwd may legitimately `ln -s /etc cwd/link`, and a forged record naming
  // `cwd/link/passwd` then starts with the root prefix while resolving entirely outside it. The
  // path-identity guards below do not save it either -- they are SKIPPED whenever a record carries
  // neither `anchorPath` nor `parentRealPath`, which a hand-written record simply omits, and
  // `leafStateRefusal` only lstats the LEAF (a real regular file, reached through a linked ancestor).
  //
  // `nearestExistingAncestor` walks upward until something resolves, so this answers for a path
  // several not-yet-created directories deep as well as for one that exists -- and it is the SAME
  // primitive the anchor guard uses, so the two cannot disagree about what "resolves" means.
  const target = resolve(absPath);
  const anchor = nearestExistingAncestor(target);
  // The portion of the path BELOW the nearest existing ancestor cannot contain a link (nothing exists
  // there to be one), so appending it to the anchor's REAL path gives the path the write would
  // actually reach.
  const realTarget = anchor === undefined ? target : join(anchor.anchorRealPath, relative(anchor.anchorPath, target));
  for (const raw of roots) {
    const root = resolve(raw);
    // Compare against BOTH spellings of the root: as written, and canonicalised. Every macOS mkdtemp
    // path is a `/var` -> `/private/var` link, so a check that only used one form would refuse a
    // session's own legitimate files on a real machine.
    let realRoot: string | undefined;
    try {
      realRoot = realpathSync(root);
    } catch {
      /* the root is gone -- the written form below is the only answer available */
    }
    for (const candidate of new Set([root, ...(realRoot !== undefined ? [realRoot] : [])])) {
      if (realTarget === candidate) return true;
      if (realTarget.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep)) return true;
    }
  }
  return false;
}

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
export function describeRefusal(record: Pick<CheckpointRecord, "path" | "anchorPath" | "anchorRealPath" | "parentRealPath">): string | undefined {
  if (record.anchorPath !== undefined && record.anchorRealPath !== undefined) {
    let nowReal: string | undefined;
    try {
      nowReal = realpathSync(record.anchorPath);
    } catch {
      nowReal = undefined;
    }
    if (nowReal !== record.anchorRealPath) return "its nearest checkpointed ancestor directory no longer resolves where it did";
    const componentIssue = componentRefusal(record.anchorPath, record.path);
    if (componentIssue !== undefined) return componentIssue;
  }
  if (record.parentRealPath !== undefined && parentRealPathOf(record.path) !== record.parentRealPath) {
    return "its parent directory no longer resolves where it did at checkpoint time";
  }
  return undefined;
}

/** The internal name, kept so the call site below reads as the CLASS of refusal it is applying. */
const pathIdentityRefusal = describeRefusal;

/**
 * A refusal describing the first directory between `anchorPath` (exclusive) and `target` (exclusive)
 * that can no longer be walked as it was: it has become a symlink, or it exists and is not a
 * directory. The LEAF is deliberately not examined here -- its own state is `leafStateRefusal`'s
 * business and carries a more specific message. A component that does not exist is fine: nothing can
 * be followed through it, and the write/delete arms handle absence.
 *
 * RETURNS THE WHOLE PHRASE, not a component name (A-12b). It used to return a bare segment that the
 * caller pasted into "the path component X is now a symbolic link", which made this function's two
 * OTHER answers say something untrue: a component that is merely no longer a directory was reported
 * as a symlink, and the defensive climb-out arm returned the literal `".."` -- rendering "the path
 * component .. is now a symbolic link", naming a component that is not one and a cause that is not
 * the cause. A refusal message is what a host shows a user about a file it declined to restore; it
 * has to be true.
 */
function componentRefusal(anchorPath: string, target: string): string | undefined {
  const rest = relative(anchorPath, target).split(sep).filter((s) => s.length > 0);
  // `anchorPath` is an ancestor of `target` by construction; anything else is a record this build
  // did not write, and refusing to reason about it is the safe answer.
  if (rest.some((s) => s === "..")) return "its recorded path is not inside the ancestor directory it was checkpointed under";
  let walked = anchorPath;
  for (const segment of rest.slice(0, -1)) {
    walked = join(walked, segment);
    try {
      const stat = lstatSync(walked);
      if (stat.isSymbolicLink()) return `the path component "${segment}" is now a symbolic link`;
      if (!stat.isDirectory()) return `the path component "${segment}" is no longer a directory`;
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
  /**
   * T8 rider 25: the session's own writable roots (its `cwd` plus any `additionalDirectories`). A
   * record naming a path outside every one of them is REFUSED -- see `isInsideSessionRoots`.
   *
   * REQUIRED, not optional-defaulting-to-unfenced: an omitted fence is exactly the state this rider
   * closes, and a caller that genuinely wants no fence has to say so by passing `["/"]`.
   */
  roots: readonly string[];
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
    // T8 rider 25: the ROOT fence, checked first and on BOTH paths for the same reason the
    // path-identity class is -- a record outside the session's roots does not describe a file this
    // session ever touched, so listing it in a preview would promise a host a change to a stranger's
    // file. Counted in `skippedLinks` on a real rewind (the field the pin gives to "records this
    // rewind declined to service"); still absent on a preview, per item (e).
    if (!isInsideSessionRoots(record.path, opts.roots)) {
      if (!opts.dryRun) skippedLinks++;
      continue;
    }

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

// Phase 5 Task 7 (Lane K, R5-11 as amended): the BACKUP STORE behind `enableFileCheckpointing`.
//
// LAYOUT -- `<home>/backups/<session-uuid>/`:
//
//   <path-hash>@v<n>   the pre-image bytes of one snapshot, byte-exact (never text-normalised)
//   index.jsonl        the append-only record of every intercepted mutation, in order
//
// `backups/`, NOT `file-history/<uuid>/`. WS-11 §9's mechanism row and the task brief both say the
// latter; derived-shapes-p5's capture (2) observed the pinned runtime growing a `backups/` sibling
// of `projects/` instead, and the R5-11 amendment adopted it. The report wins over the brief.
//
// `<path-hash>` is the first 16 hex of the sha256 of the ABSOLUTE path -- DISCLOSED: R5-11 marks the
// real algorithm capture-pending and names exactly this as the fallback. Hashing the absolute path
// (not the spelling the tool call used) is what makes `a.ts` and `/work/a.ts` one backup rather than
// two half-histories of the same file.
//
// SNAPSHOT vs DELTA. A rewind restores each file to its state at the START of an envelope, so only
// the FIRST mutation of a path within an envelope has bytes worth keeping; every later one in the
// same envelope writes a record with no blob. Copying the file again mid-envelope would store bytes
// no rewind can ever restore to.
//
// index.jsonl IS A WINTER-PRIVATE SIDECAR, not transcript. T3 deliberately landed no
// `file-history-snapshot`/`file-history-delta` dialect entries (`store/**` is spine and frozen to
// lanes, and both the entry NAMES and their fields are Winter-defined), so this file keeps its own
// record next to the blobs it describes. That is consistent with WS-05 §5.2's own rule -- Winter
// metadata lives in sidecars `load()` never returns, never as a transcript line -- but it does mean
// a rewind's history is invisible to a transcript reader. Raised as a spine request in the task
// report.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** The directory name under `~/.winter`. One constant so a fixture and the sink cannot disagree. */
export const CHECKPOINT_BACKUPS_DIRNAME = "backups";

/** The private per-session record of intercepted mutations. */
export const CHECKPOINT_INDEX_FILENAME = "index.jsonl";

export type CheckpointRecordKind = "snapshot" | "delta";

export interface CheckpointRecord {
  kind: CheckpointRecordKind;
  /** The envelope this mutation belongs to -- the unit `rewind` restores to. */
  userMessageUuid: string;
  /** Absolute, resolved. */
  path: string;
  pathHash: string;
  /** Which mutating tool announced it. Recorded for auditability; the rewind does not branch on it. */
  tool: string;
  at: string;
  /**
   * The blob version for a snapshot (`<path-hash>@v<version>`); for a delta, the snapshot version it
   * follows. Counts SNAPSHOTS only, so the blob numbering is dense and `@v2` really is the second
   * backup of that file rather than the second time it was touched.
   */
  version: number;
  /** The file did not exist at checkpoint time -- there are no bytes, and a rewind DELETES it. */
  absent?: boolean;
  /**
   * `realpath(dirname(path))` at checkpoint time. Item (e)'s rule: a path whose parent no longer
   * resolves where it did is REFUSED rather than restored -- otherwise a rewind follows a directory
   * that has since become a link and writes the pre-image into somebody else's tree.
   */
  parentRealPath?: string;
}

export function checkpointPathHash(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
}

export function sessionBackupsDir(home: string, sessionUuid: string): string {
  return join(home, CHECKPOINT_BACKUPS_DIRNAME, sessionUuid);
}

export function blobName(pathHash: string, version: number): string {
  return `${pathHash}@v${version}`;
}

/** `realpath` of the parent, or undefined when it cannot be resolved (the directory is gone). */
export function parentRealPathOf(absolutePath: string): string | undefined {
  try {
    return realpathSync(dirname(absolutePath));
  } catch {
    return undefined;
  }
}

/**
 * Reads the session's records, oldest first. A missing directory or file is an EMPTY history, never
 * an error: `rewind` on a session that has mutated nothing must answer "nothing to rewind to", and
 * a `dryRun` must not bring the directory into existence just by asking.
 *
 * A malformed line is skipped rather than fatal -- a truncated final line (a process killed
 * mid-append) must not make every earlier checkpoint unreadable.
 */
export function readCheckpointIndex(home: string, sessionUuid: string): CheckpointRecord[] {
  const file = join(sessionBackupsDir(home, sessionUuid), CHECKPOINT_INDEX_FILENAME);
  if (!existsSync(file)) return [];
  const out: CheckpointRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as CheckpointRecord;
      if (typeof parsed.path === "string" && typeof parsed.userMessageUuid === "string") out.push(parsed);
    } catch {
      /* a torn line is skipped; every whole record before it still restores */
    }
  }
  return out;
}

export function appendCheckpointRecord(home: string, sessionUuid: string, record: CheckpointRecord): void {
  const dir = sessionBackupsDir(home, sessionUuid);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, CHECKPOINT_INDEX_FILENAME), `${JSON.stringify(record)}\n`);
}

/** The pre-image bytes, or undefined when the file does not exist / is not a regular file. */
export function readPreImage(absolutePath: string): Buffer | undefined {
  try {
    if (!statSync(absolutePath).isFile()) return undefined;
    return readFileSync(absolutePath);
  } catch {
    return undefined;
  }
}

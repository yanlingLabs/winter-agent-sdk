// Phase 5 Task 7 (Lane K, R5-11 as amended): the real `FileCheckpointSink`.
//
// The engine owns the interception POINT (after permission approval, after any transform, before
// execution, keyed on the canonical post-alias identity) and the `rewind_files` control request;
// this owns the store behind them. `checkpoint/seam.contract.test.ts` is the authority for the
// engine's half.
//
// SCOPE, narrow and pinned: Write/Edit/NotebookEdit only. A Bash-written file and a subagent's edits
// never reach `beforeMutation` at all, so a rewind leaves them exactly as they are. That is the
// mechanism class WS-11 §9 pins, not an oversight -- and the honest consequence, fixtured, is that a
// rewind restores PATHS rather than authorship: a Bash edit to a TRACKED file is undone as
// collateral, while a Bash-CREATED file is untouched.
import type { RewindFilesResult } from "@yanlinglabs/winter-agent-sdk";
import { resolveWinterHome } from "@yanlinglabs/winter-agent-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CheckpointMutation, FileCheckpointSink } from "./seam.ts";
import {
  appendCheckpointRecord,
  blobName,
  checkpointPathHash,
  nearestExistingAncestor,
  parentRealPathOf,
  readCheckpointIndex,
  readPreImage,
  sessionBackupsDir,
  type CheckpointRecord,
} from "./file-history.ts";
import { rewindToCheckpoint } from "./rewind.ts";

export { CHECKPOINT_BACKUPS_DIRNAME, CHECKPOINT_INDEX_FILENAME } from "./file-history.ts";

export interface FileCheckpointSinkOptions {
  /**
   * The session this sink rewinds. REQUIRED, because `rewind(userMessageUuid)` carries no session of
   * its own: checkpoints belong to a session (WS-11 §9's scope row), and a sink that guessed would
   * let one session undo another's work.
   */
  sessionUuid: string;
  /** The `~/.winter` root. Defaults to `WINTER_HOME || ~/.winter`; every test passes a mkdtemp root. */
  home?: string;
  /**
   * Resolves a RELATIVE candidate write path. `extractCandidateWritePaths` yields the path the tool
   * call carried, which is usually but not always absolute -- and the backup identity is the hash of
   * the ABSOLUTE path, so resolving late would file two spellings of one file as two histories.
   */
  cwd?: string;
  /**
   * T8 rider 25 (SECURITY): extra roots the session was configured to write outside `cwd`
   * (`RuntimeConfig.additionalDirectories`). `rewind` refuses a record naming a path outside `cwd`
   * and these, so a tampered `index.jsonl` cannot become an arbitrary write or delete -- but a file
   * the session GENUINELY edited in a granted directory must still restore, which is what this
   * field carries. Omitted => `cwd` is the whole fence.
   */
  additionalDirectories?: readonly string[];
  env?: Record<string, string | undefined>;
}

export function createFileCheckpointSink(opts: FileCheckpointSinkOptions): FileCheckpointSink {
  const home = opts.home ?? resolveWinterHome(opts.env);
  const cwd = opts.cwd ?? process.cwd();
  const ownSession = opts.sessionUuid;
  // T8 rider 25: the rewind fence. Computed once here, from the same construction options the
  // session's own writes were resolved against, so the two can never disagree.
  const roots: readonly string[] = [cwd, ...(opts.additionalDirectories ?? [])];

  // The snapshot version per (session, path), and which (envelope, path) pairs already hold one.
  // Both are seeded LAZILY from the on-disk index the first time a session is written to, so a sink
  // constructed over an existing session continues its numbering instead of overwriting `@v1`.
  const versions = new Map<string, number>();
  const snapshotted = new Set<string>();
  const seeded = new Set<string>();

  const seed = (sessionUuid: string): void => {
    if (seeded.has(sessionUuid)) return;
    seeded.add(sessionUuid);
    for (const record of readCheckpointIndex(home, sessionUuid)) {
      if (record.kind !== "snapshot") continue;
      const key = `${sessionUuid}\0${record.pathHash}`;
      versions.set(key, Math.max(versions.get(key) ?? 0, record.version));
      snapshotted.add(`${sessionUuid}\0${record.userMessageUuid}\0${record.pathHash}`);
    }
  };

  return {
    async beforeMutation(req: CheckpointMutation): Promise<void> {
      // Scoped by the SEAM's own `sessionUuid`, not the factory's: the engine stamps every mutation
      // with the session it belongs to, and honouring that is what makes a child engine's writes
      // land in the child's own subtree rather than silently in the parent's.
      const sessionUuid = req.sessionUuid;
      seed(sessionUuid);
      const absolute = resolve(cwd, req.path);
      const pathHash = checkpointPathHash(absolute);
      const checkpointKey = `${sessionUuid}\0${req.userMessageUuid}\0${pathHash}`;
      const versionKey = `${sessionUuid}\0${pathHash}`;
      const parentRealPath = parentRealPathOf(absolute);
      // Recorded for EVERY record, snapshot and delta alike, and -- unlike `parentRealPath` --
      // ALWAYS available, because it walks up until something exists. That is the whole fix: a
      // checkpoint taken before the tool `mkdir -p`s the directory used to carry no path-identity
      // anchor at all, and it is exactly that record whose rewind arm deletes.
      const anchor = nearestExistingAncestor(absolute);
      const anchorFields = anchor !== undefined ? { anchorPath: anchor.anchorPath, anchorRealPath: anchor.anchorRealPath } : {};

      // A LATER mutation of the same path inside the same envelope: record it and stop. A rewind
      // restores to the state at the START of the envelope, so re-copying the file now would store
      // bytes nothing can ever restore to -- this is the "delta-record" half of R5-11.
      if (snapshotted.has(checkpointKey)) {
        appendCheckpointRecord(home, sessionUuid, {
          kind: "delta",
          userMessageUuid: req.userMessageUuid,
          path: absolute,
          pathHash,
          tool: req.tool,
          at: new Date().toISOString(),
          version: versions.get(versionKey) ?? 0,
          ...(parentRealPath !== undefined ? { parentRealPath } : {}),
          ...anchorFields,
        });
        return;
      }

      const version = (versions.get(versionKey) ?? 0) + 1;
      const preImage = readPreImage(absolute);
      const record: CheckpointRecord = {
        kind: "snapshot",
        userMessageUuid: req.userMessageUuid,
        path: absolute,
        pathHash,
        tool: req.tool,
        at: new Date().toISOString(),
        version,
        ...(preImage === undefined ? { absent: true } : {}),
        ...(parentRealPath !== undefined ? { parentRealPath } : {}),
        ...anchorFields,
      };
      if (preImage !== undefined) {
        const dir = sessionBackupsDir(home, sessionUuid);
        mkdirSync(dir, { recursive: true });
        // The BLOB IS WRITTEN BEFORE THE RECORD that names it. A crash between the two leaves an
        // orphan blob no rewind reads; the other order would leave a record pointing at bytes that
        // do not exist, which `refusalReason` would then have to treat as a refused file -- an
        // unexplainable one, since nothing about the user's tree had changed.
        writeFileSync(join(dir, blobName(pathHash, version)), preImage);
      }
      appendCheckpointRecord(home, sessionUuid, record);
      versions.set(versionKey, version);
      snapshotted.add(checkpointKey);
    },

    async rewind(userMessageUuid: string, o?: { dryRun?: boolean }): Promise<RewindFilesResult> {
      return rewindToCheckpoint({ home, sessionUuid: ownSession, userMessageUuid, dryRun: o?.dryRun === true, roots });
    },
  };
}

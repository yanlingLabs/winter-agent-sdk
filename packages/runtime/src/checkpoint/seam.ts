// Phase 5 Task 3 (spine): the FILE-CHECKPOINTING seam -- R5-11. Lane K (task 7) implements the
// backup store and the restore; the ENGINE owns the interception point and the control request.
//
// SCOPE, narrow and deliberate: Write/Edit/NotebookEdit ONLY. A Bash-written file and a subagent's
// edits are untouched -- not an oversight but the pinned mechanism class (backup-before-modify on the
// three mutating tools), and pretending otherwise would produce a rewind that silently half-restores.
//
// DIVERGENCE FROM THE TASK-3 BRIEF, resolved in favour of the shape authority: the brief writes
// `rewind(userMessageUuid): Promise<{restored, skipped}>`, which predates the R5-11 amendment.
// derived-shapes-p5 item (e) pins `rewindFiles(userMessageId, { dryRun? }) -> RewindFilesResult`
// (six fields), and a `{restored, skipped}` seam could produce neither `insertions`/`deletions`/
// `skippedLinks` nor honour `dryRun` -- so the seam carries the pinned shape. `userMessageUuid` is
// kept as the PARAMETER name here (the pinned `@param` line itself describes the value as a UUID;
// only the public method's parameter is spelled `userMessageId`).
//
// `skippedLinks` is a link-safety counter with a real behavioural rule attached (item (e)): a tracked
// path that resolves to a symlink, a hard link or a non-regular file, or whose parent directory no
// longer resolves where it did at checkpoint time, or whose backup cannot be safely read, is REFUSED
// rather than restored. The counter is populated on REAL rewinds only -- never on a `dryRun`, whose
// preview counts therefore do not reflect refusals.
import type { RewindFilesResult } from "@yanlinglabs/winter-agent-sdk";

/** The three mutating tools checkpointing intercepts, as one exported set so the engine's check and a lane's own fixtures cannot drift. */
export const CHECKPOINTED_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;
export type CheckpointedTool = (typeof CHECKPOINTED_TOOLS)[number];

export function isCheckpointedTool(name: string): name is CheckpointedTool {
  return (CHECKPOINTED_TOOLS as readonly string[]).includes(name);
}

export interface CheckpointMutation {
  path: string;
  tool: CheckpointedTool;
  /** The engine-minted id of the user envelope this mutation belongs to -- the unit `rewind` restores to. */
  userMessageUuid: string;
  sessionUuid: string;
}

export interface FileCheckpointSink {
  /**
   * Called BEFORE the mutation runs, once per candidate write path. A sink that throws does NOT stop
   * the write: the engine treats a checkpoint failure the way it treats a store failure -- auxiliary,
   * reported, never turn-fatal. That is a deliberate choice in the safe direction for the USER'S WORK
   * (the edit they asked for still happens) and the unsafe one for undo, so a sink that cannot back
   * up must say so loudly rather than failing silently.
   */
  beforeMutation(req: CheckpointMutation): Promise<void>;
  /**
   * Restores every tracked file to its state at `userMessageUuid`. `dryRun` previews without
   * touching the filesystem -- and, per item (e), without populating `skippedLinks`.
   *
   * Returns `canRewind: false` with an `error` for an unknown/untracked id rather than throwing: the
   * control request that reaches this is a host action, and "there is nothing to rewind to" is an
   * answer, not a failure.
   */
  rewind(userMessageUuid: string, opts?: { dryRun?: boolean }): Promise<RewindFilesResult>;
}

/**
 * The spine's test double: an in-memory sink recording every intercepted mutation and answering
 * `rewind` from a canned table. It touches no filesystem at all -- Lane K's real sink is what proves
 * backup/restore.
 */
export function fakeFileCheckpointSink(opts?: {
  mutations?: CheckpointMutation[];
  results?: Record<string, RewindFilesResult>;
  rewindCalls?: Array<{ userMessageUuid: string; dryRun: boolean }>;
  failBeforeMutation?: string;
}): FileCheckpointSink {
  return {
    async beforeMutation(req: CheckpointMutation): Promise<void> {
      opts?.mutations?.push(req);
      if (opts?.failBeforeMutation !== undefined) throw new Error(opts.failBeforeMutation);
    },
    async rewind(userMessageUuid: string, o?: { dryRun?: boolean }): Promise<RewindFilesResult> {
      opts?.rewindCalls?.push({ userMessageUuid, dryRun: o?.dryRun === true });
      const canned = opts?.results?.[userMessageUuid];
      if (canned !== undefined) return canned;
      return { canRewind: false, error: `no checkpoint recorded for user message ${userMessageUuid}` };
    },
  };
}

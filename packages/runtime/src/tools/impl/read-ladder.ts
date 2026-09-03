// WS-06 §3.1 -- the shared read-before-edit ladder, implemented ONCE here and consumed by all three
// Lane B tools (edit.ts, write.ts, notebook-edit.ts). Every one of them asks the SAME question --
// "given what this session knows about this path, and what a probe read would do right now, may this
// operation proceed?" -- so the decision lives in exactly one place rather than three near-identical
// copies that would inevitably drift.
//
// THE THREE MUTUALLY EXCLUSIVE STATES a target path can be in, per `ctx.readState.lookup(path)`:
//   1. No record at all                              -- "unread"
//   2. A record whose mtimeMs === the CURRENT mtime   -- "cleanly read" (further split by `complete`)
//   3. A record whose mtimeMs !== the CURRENT mtime   -- "changed since read" (drifted)
// These states, plus the `readLadderProfile` family knob and the operation's own shape, are composed
// into exactly four rungs, checked in this fixed order:
//
//   RUNG 1 (both profiles, any operation): a COMPLETE read that is still FRESH (mtime unchanged)
//     always satisfies the ladder. This is the base case every other rung is an escape hatch FROM.
//
//   THE WRITE-OVERWRITE-ONLY OVERRIDE (advisor-adjudicated scope, see below): a notebook target, or
//     an existing-but-PARTIAL read record, collapses the ladder to rung 1 ONLY for an "overwrite"
//     operation -- no unread-file shortcut (rung 2), no drift rescue (rung 3). WS-06 §3.1's Write
//     paragraph is the ONLY place this sentence appears ("notebooks and partially-read files always
//     need a complete read"), immediately after "same ladder as Edit for existing files" -- i.e. it
//     is a carve-OUT from Edit's ladder, not a universal rule. Report §40.45 confirms the scope
//     independently: Write inherits only the *unread* condition from Edit ("may overwrite an unread
//     existing file only under the same ... conditions as Edit"), never the drift-rescue sentence,
//     which report §40.8 (Edit) states with no profile/family qualifier of its own. Concretely: this
//     override is NEVER consulted for `operation: "edit"` -- plain Edit and NotebookEdit both stay on
//     rungs 1/2/3 even against a notebook path or a partial prior read.
//     LOAD-BEARING REASON this override must exist at all (why "partially-read" isn't already
//     covered by rung 2 below): without it, an existing-but-partial record would be indistinguishable
//     from "no record" and would ride the exact same relaxed/silent-probe shortcut rung 2 grants an
//     unread file -- making the WS-06 sentence dead code. This override is what makes it real.
//
//   RUNG 3 (both profiles, "edit" operation only): a record EXISTS but has drifted (mtime changed).
//     Rescued when the CURRENT on-disk content's match is unambiguous (Edit's own `old_string`
//     search, computed by the caller against what is on disk RIGHT NOW, independent of what was read)
//     AND a fresh Read of this path would resolve silently. Never available to "overwrite" (Write has
//     no substring-match concept -- nothing to be "unambiguous" about) or to NotebookEdit (cell
//     identity is matched by id, not content) -- both simply omit `hasUnambiguousCurrentMatch`, which
//     structurally forces this rung closed for them without any special-casing.
//
//   RUNG 2 ("relaxed" profile only, any operation not already forced into the override above): never
//     read, or read only partially with no drift -- a "newer model family" may still proceed when
//     Read is available (Winter's `Read` is an unconditional, always-advertised implement-now
//     builtin -- WS-06 §3.1/§2 -- so this is a structural truth here, never a registry lookup; a
//     registry lookup would also be WRONG in-process during Phase 3, since Lane A's own Read
//     executor lands in a sibling worktree this lane never imports) and reading this exact path RIGHT
//     NOW would resolve SILENTLY.
//     RULING P3-B (binding): the ONLY value that satisfies this is `probeReadAccess(...) === "silent"`.
//     `"prompt"` (a real Read here would need interaction) and `"deny"` (a real Read here would be
//     rejected) both fail closed -- never treated as "safe to skip the read."
//
// `readLadderProfile` (strict | relaxed, default "strict") is the R3-4-style family knob: a
// declarative seam nothing populates yet (progress ledger: "readLadderProfile ... P6 carry" --
// provider/model-family catalog work). Every call site in this lane omits it, relying on the
// "strict" default, exactly like `AdvertisedSetInputs.familyMetadata` (registry.ts) reads absent as
// its own conservative default today. This module cannot itself grow a field on ToolDescriptor or
// ToolExecutionContext to carry the resolved value (both live in registry.ts, off-limits to every
// lane per R3-5) -- so the seam is this function's own optional parameter, exactly as buildable now
// as it will be once a real caller resolves something other than the default.
import type { SessionReadState } from "../read-state.ts";
import type { ReadAccessProbe } from "../../permissions/evaluator.ts";

export type ReadLadderProfile = "strict" | "relaxed";
export const DEFAULT_READ_LADDER_PROFILE: ReadLadderProfile = "strict";

// "edit" = a targeted, verifiable delta (Edit's old_string/new_string; NotebookEdit's per-cell
// replace/insert/delete) -- eligible for rungs 1/2/3. "overwrite" = Write's whole-file replace, which
// has no match concept of its own -- eligible for rungs 1/2 only, and subject to the override above.
export type ReadLadderOperation = "edit" | "overwrite";

export interface ReadLadderInput {
  // MUST already be the resolved, absolute path the caller actually opened/will open -- this module
  // performs no resolution of its own (read-state.ts's own header: keying is the executor's job).
  filePath: string;
  // The target's CURRENT on-disk mtime (milliseconds), as of THIS call -- the caller stats the file
  // itself; this module never touches the filesystem (kept synchronous and side-effect-free so it is
  // trivially unit-testable against a bare SessionReadState, with no fixture files at all).
  currentMtimeMs: number;
  operation: ReadLadderOperation;
  // Edit-only (see RUNG 3 above): does `old_string` currently match EXACTLY ONCE against the
  // target's CURRENT on-disk content? Omit for "overwrite" and for NotebookEdit's "edit" calls --
  // both have no match concept, and omitting (rather than passing `false`) is what keeps rung 3
  // closed for them without a second, redundant flag.
  hasUnambiguousCurrentMatch?: boolean;
  profile?: ReadLadderProfile;
}

export interface ReadLadderDeps {
  readState: SessionReadState;
  probeReadAccess: (filePath: string) => ReadAccessProbe;
}

export type ReadLadderDecision = { eligible: true } | { eligible: false; reason: string };

function isNotebookPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".ipynb");
}

export function evaluateReadLadder(input: ReadLadderInput, deps: ReadLadderDeps): ReadLadderDecision {
  const profile = input.profile ?? DEFAULT_READ_LADDER_PROFILE;
  const record = deps.readState.lookup(input.filePath);

  // Rung 1.
  if (record !== undefined && record.complete && record.mtimeMs === input.currentMtimeMs) {
    return { eligible: true };
  }

  // The Write-overwrite-only override -- see module header for why this is scoped to "overwrite".
  if (input.operation === "overwrite" && (isNotebookPath(input.filePath) || (record !== undefined && !record.complete))) {
    return {
      eligible: false,
      reason: `"${input.filePath}" needs a complete, up-to-date read before it can be overwritten -- notebooks and partially-read files always require a fresh, complete read first`,
    };
  }

  // Rung 3: a record exists but has drifted (mtime changed since it was taken).
  if (record !== undefined && record.mtimeMs !== input.currentMtimeMs) {
    if (input.operation === "edit" && input.hasUnambiguousCurrentMatch === true && deps.probeReadAccess(input.filePath) === "silent") {
      return { eligible: true };
    }
    return {
      eligible: false,
      reason: `"${input.filePath}" has changed on disk since it was last read in this session -- read it again before editing`,
    };
  }

  // Rung 2: never read, or read only partially with no drift.
  if (profile === "relaxed" && deps.probeReadAccess(input.filePath) === "silent") {
    return { eligible: true };
  }
  return {
    eligible: false,
    reason: `"${input.filePath}" has not been read in this session -- read it first`,
  };
}

// After a successful Edit/Write/NotebookEdit, the executor knows strictly MORE about the file's
// current content than it did a moment ago -- recording that here is what keeps a same-session
// SEQUENCE of edits on the same path off the drift rung. Without this, the tool's own write would
// immediately invalidate its own prior read via mtime drift, and the very next call on the same path
// would need a fresh Read (or a relaxed silent probe) just to continue a chain the caller never
// actually left.
//
// "full" (Write only) always records complete:true -- the new content is 100% author-known,
// regardless of how much of the PREVIOUS content was ever seen. "carryForward" (Edit/NotebookEdit --
// a targeted delta applied ON TOP OF whatever was already known) preserves the PRE-OPERATION
// completeness verbatim: a prior complete read plus one known, applied delta is still complete; a
// prior partial/absent read is still not. Honesty nuance flagged for T8: this treats "was complete,
// but the on-disk file had ALSO drifted from an external actor before this edit landed" the same as
// an ordinary complete carry-forward once the edit itself succeeds (rung 3 already required the
// drifted content's match to be unambiguous to get here at all, which is the load-bearing safety
// check -- this function only ever runs after that has already passed).
export type PostOperationReadKind = "full" | "carryForward";

export function recordPostOperationRead(deps: ReadLadderDeps, filePath: string, kind: PostOperationReadKind, mtimeMs: number): void {
  const complete = kind === "full" ? true : deps.readState.lookup(filePath)?.complete === true;
  deps.readState.recordRead(filePath, { complete, mtimeMs });
}

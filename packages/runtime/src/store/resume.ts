// Task 9 (WS-05 §7): continue / resume / fork / resume-at. Pure, store-level primitives — the
// orchestration that wires these into a running engine session (P1-N project-dir-name record/apply,
// message-rebuild, chain continuation) lives in dialect.ts's resolveEngineSession, which is what
// main.ts and testing.ts actually call (Task 8's two persistence call sites — this task extends
// those paths, it never adds a third).
//
// WS-05 §7's table, as restated for P1 scope (worktree-awareness for `resume` is explicitly
// deferred — see findResumeTarget's own comment):
//   continue: true      -> newest session in the CURRENT directory only, no cross-project fallback.
//   resume: <uuid>       -> current project first; then every OTHER project; >1 foreign match is a
//                           typed refusal, never an arbitrary pick.
//   forkSession: true    -> (combined with continue/resume) copies the resolved target into a fresh
//                           uuid FIRST; the original is left byte-identical; no undo/file-history is
//                           copied (neither exists yet at P1 — nothing to carry or omit). Task 10:
//                           the primitive that implements this bullet now lives in
//                           packages/sdk/src/store/fork-session.ts (forkSessionByKey) — see this
//                           file's own note further down, where it used to be defined.
//   resumeSessionAt      -> keep only atUuid's own ANCESTRY (root..atUuid, graph-defined — Ruling
//                           P1-R, fix-round 1); resumeDropsTurn confirms (and validates) discarding
//                           atUuid's DESCENDANTS specifically, never an unrelated sibling branch.
//
// Both the message-rebuild below and resumeSessionAt anchor on the parentUuid GRAPH, never on file
// (append) order — a session can branch (an earlier resumeSessionAt leaves its abandoned tail on
// disk, WS-05 §7: "the transcript is a graph, not a linear buffer"), so file order alone conflates
// unrelated branches. See the "ancestry-graph walks" section below (Rulings P1-Q + P1-R).
import type { ProviderMessage, ContentBlock } from "../engine.ts";
// session-store.ts moved to the sdk package (Task 10, WS-05 §6) — SessionKey is no longer needed
// here (it was only forkSession's own parameter/return-construction type; forkSession itself
// relocated to packages/sdk/src/store/fork-session.ts alongside the store, see this file's own
// header comment above and task-10-report.md).
import type { SessionStore, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { attachmentMessage } from "../context/attachments.ts";

// Whole-branch review Minor 1 (extends the T9-nit carry, WS-03 §11): official taxonomy-building
// still needs to check whether the real Anthropic SDK collapses "not_found"/"ambiguous" into one
// class where this codebase splits them (justified here via WS-03 §11's own error-detail
// obligation — a caller distinguishing "never existed" from "exists more than once, pick one"
// needs the split, whatever the official shape does). That obligation runs deeper than the two
// reasons themselves: WS-03 §11 requires resume-failure DETAIL to eventually reach a caller, and
// today it only does so as free-text stderr (main.ts's top-level catch: `winter: fatal: ${text}`)
// or a thrown JS error object a wrapper-side try/catch can inspect (query.ts, inMemoryProcess) —
// there is no STRUCTURED wire payload carrying `reason` across a real child process boundary today
// (a real spawned `winter` child's stderr is diagnostics-only, WS-04 §6 — query.ts's `stderr`
// callback sees text, never a typed object). A future WS-03 §11 taxonomy pass must either put this
// detail on the wire as a pre-init error payload, or guarantee it is always pre-validated
// wrapper-side before a real child is ever spawned (so the detail never needs to cross a process
// boundary at all). Note the SAME duality applies to SessionNotFoundError (sdk/src/errors.ts,
// Task 10's standalone session-management API) — it mirrors this class's not_found/ambiguous split
// for exactly the analogous reason, and inherits the identical open obligation.
export class ResumeTargetError extends Error {
  // "locked" — Ruling P1-S (whole-branch review Important 1): the resolved continue/resume/fork
  // target's writer lease is held by a DIFFERENT, still-live pid (dialect.ts's resolveEngineSession
  // claims the lease eagerly, before readBack/rebuild/init — see its own comment). Reuses this
  // class rather than a new one: same "resume resolution failed, typed, pre-init" shape as
  // not_found/ambiguous, just a third cause.
  readonly reason: "not_found" | "ambiguous" | "locked";
  constructor(reason: "not_found" | "ambiguous" | "locked", message: string) {
    super(message);
    this.name = "ResumeTargetError";
    this.reason = reason;
  }
}

export class ResumeTruncationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeTruncationError";
  }
}

// findContinueTarget's "newest by mtime" contract needs mtime, and findResumeTarget's cross-project
// search needs project enumeration — neither is available through load() (which also runs
// tail-repair, a MUTATING operation that must never fire against a foreign session file merely
// being PROBED during search; see projectHasSession below). Both walk store.listSessions(), a
// stat-level read with no such side effect.
async function projectHasSession(store: SessionStore, projectKey: string, sessionId: string): Promise<boolean> {
  if (!store.listSessions) return false;
  const sessions = await store.listSessions(projectKey);
  return sessions.some((s) => s.sessionId === sessionId);
}

// Fix-round 1 (MAJOR finding): WS-03 §10 pins SessionStore as EXACTLY its six documented members —
// project enumeration is a Winter-only capability that must never widen that exported type (see
// session-store.ts's own comment on WinterCompatibilitySessionStore.listProjectKeys). Accessed here
// via a LOCAL intersection type instead, so findResumeTarget's own public signature stays exactly
// the pinned `store: SessionStore` the brief specifies; a minimal/foreign SessionStore
// implementation without this capability still type-checks as a valid argument and degrades
// gracefully at runtime (the `if (!storeExt.listProjectKeys)` guard below).
type StoreWithProjectEnumeration = SessionStore & { listProjectKeys?(): Promise<string[]> };

/** `continue: true` — the newest session in exactly one directory (WS-05 §7: no cross-project fallback). */
export async function findContinueTarget(store: SessionStore, cwdKey: string): Promise<string | null> {
  if (!store.listSessions) return null;
  const sessions = await store.listSessions(cwdKey);
  if (sessions.length === 0) return null;
  // listSessions' own contract: "ORDER NOT GUARANTEED — sort yourself."
  let newest = sessions[0]!;
  for (const s of sessions) {
    if (s.mtime > newest.mtime) newest = s;
  }
  return newest.sessionId;
}

/**
 * `resume: <uuid>` — current project first (an unconditional win, never subject to the ambiguity
 * check below, even if the same id ALSO happens to exist elsewhere); then every other project,
 * resolving only on a unique foreign match.
 *
 * Deferred scope (documented, not silently dropped): WS-05 §7 also says to search "the current
 * project + its git worktrees" before falling through to every other project. P1 has no
 * worktree-aware transcriptProjectKey (compatibilityKeys' worktree-awareness is memoryProjectKey
 * only, WS-05 §3.2) and the outer task brief's own restatement of this rule omits worktrees
 * entirely — a worktree session resolves via the ordinary "every other project" fallback today
 * (correct, just not distinguished from any other foreign project), until a later task adds
 * worktree identity to the search's first phase.
 */
export async function findResumeTarget(store: SessionStore, opts: { sessionId: string; cwdKey: string }): Promise<{ projectKey: string }> {
  if (await projectHasSession(store, opts.cwdKey, opts.sessionId)) {
    return { projectKey: opts.cwdKey };
  }

  const storeExt = store as StoreWithProjectEnumeration;
  if (!storeExt.listProjectKeys) {
    throw new ResumeTargetError("not_found", `session not found: ${opts.sessionId} (store cannot enumerate other projects)`);
  }
  const allProjectKeys = await storeExt.listProjectKeys();
  const foreignMatches: string[] = [];
  for (const projectKey of allProjectKeys) {
    if (projectKey === opts.cwdKey) continue; // already checked above
    if (await projectHasSession(store, projectKey, opts.sessionId)) foreignMatches.push(projectKey);
  }

  if (foreignMatches.length === 0) {
    throw new ResumeTargetError("not_found", `session not found in any project: ${opts.sessionId}`);
  }
  if (foreignMatches.length > 1) {
    throw new ResumeTargetError(
      "ambiguous",
      `session ${opts.sessionId} found in ${foreignMatches.length} foreign projects (${foreignMatches.join(", ")}); refusing to pick arbitrarily`,
    );
  }
  return { projectKey: foreignMatches[0]! };
}

// Task 10 (WS-05 §6, Controller resolution): the `resume + forkSession: true` store-level
// primitive that used to live here relocated to packages/sdk/src/store/fork-session.ts, alongside
// the store it operates on (the store itself moved there in the same task) — ONE implementation,
// never fork-copied. dialect.ts's resolveEngineSession is this codebase's only production caller of
// the resumed target's fork step; it now imports the primitive directly from the sdk as
// `forkSessionByKey`, since this file no longer has any relationship to it. See
// task-10-report.md for the full relocation writeup, including why its not-found error is now
// SessionNotFoundError (sdk/src/errors.ts) rather than this file's own ResumeTargetError.

// The narrow slice of a loaded SessionStoreEntry that resume's own algorithms need: a real chain
// identity (uuid/parentUuid) plus enough of the message to rebuild provider context. Deliberately
// NOT SessionStoreEntry itself (whose `[key: string]: unknown` index signature makes object-spread
// construction against a target interface unreliable — see dialect.ts's BaseFields comment for the
// same TS quirk hit and worked around in Task 8) and deliberately narrower than DialectEntryBase
// (dialect.ts's OWN producer-side type): resume only ever READS entries, it never needs the
// producer's cwd/version/timestamp/isSidechain fields.
export interface DialectEntry {
  type: string;
  uuid: string;
  parentUuid: string | null;
  // W18-17 fix round 3 (P10b-6): `model` mirrors the real claude binary's own `message.model` --
  // present on EVERY entry the binary writes, absent on every entry Winter's own `assistantEntry`
  // writes (W18-11's own reason). `rebuildProviderMessages`'s assistant branch carries it forward,
  // structurally, onto the rebuilt message -- it is what `renderer.ts`'s `structuralModel` fallback
  // reads for an official-leg-written entry, which has no sidecar origin record at all to fall back
  // on otherwise. Before this field existed, the raw JSON still had `message.model` (untyped,
  // `SessionStoreEntry` is `[key: string]: unknown`) but THIS projection discarded it silently --
  // the renderer's own fallback was built and tested, but had nothing to read.
  message?: { role: string; content: unknown; model?: string };
  // Phase 5 Task 3 (R5-4): carried through so `rebuildProviderMessages` can honour a compaction
  // boundary. Typed `unknown` and narrowed at the one read site -- this projection deliberately
  // mirrors only what resume READS, and a structurally-typed metadata object here would make every
  // reader believe the field had already been validated.
  compact_metadata?: unknown;
  // Phase 10b Lane S, S3 (W18-13): Claude's own native compaction shape. `subtype`/`compactMetadata`
  // (camelCase) mirror the boundary; `logicalParentUuid` is the boundary's backward-looking link to
  // the pre-compaction leaf (never followed for history -- W18-13's own text); `isCompactSummary` is
  // the summary's own marker (its dialect `type` is the ordinary `"user"`, unlike the legacy
  // `"compact_summary"`, so the type string alone can't tell the two shapes apart).
  subtype?: string;
  compactMetadata?: unknown;
  logicalParentUuid?: string;
  isCompactSummary?: boolean;
  // W18-13 (c): claude writes a failed call as a synthetic `isApiErrorMessage: true` assistant entry
  // (probe P6) -- Winter's reader must skip it, never replay it to a provider as a real turn.
  isApiErrorMessage?: boolean;
  // SDK 0.0.16 (P16-5/P16-6): claude's persisted attachment payload (`type: "attachment"` entries).
  attachment?: { type: string; [key: string]: unknown };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Narrows a loaded SessionStoreEntry[] to the entries that actually carry a chain identity (WS-05
 * §5.2's chain guarantee applies to entries with a uuid; mirrors dialect.ts's own validateChain
 * narrowing) — an entry with no uuid at all is simply not part of the resumable chain. */
export function toDialectEntries(raw: SessionStoreEntry[]): DialectEntry[] {
  const result: DialectEntry[] = [];
  for (const e of raw) {
    if (typeof e.uuid !== "string") continue;
    const parentUuid = typeof e.parentUuid === "string" ? e.parentUuid : null;
    const rawMessage = (e as { message?: unknown }).message;
    const message =
      isRecord(rawMessage) && typeof rawMessage.role === "string"
        ? { role: rawMessage.role, content: rawMessage.content, ...(typeof rawMessage.model === "string" ? { model: rawMessage.model } : {}) }
        : undefined;
    const compactMetadata = (e as { compact_metadata?: unknown }).compact_metadata;
    const claudeCompactMetadata = (e as { compactMetadata?: unknown }).compactMetadata;
    const rawSubtype = (e as { subtype?: unknown }).subtype;
    const subtype = typeof rawSubtype === "string" ? rawSubtype : undefined;
    const rawLogicalParentUuid = (e as { logicalParentUuid?: unknown }).logicalParentUuid;
    const logicalParentUuid = typeof rawLogicalParentUuid === "string" ? rawLogicalParentUuid : undefined;
    const isCompactSummary = (e as { isCompactSummary?: unknown }).isCompactSummary === true;
    const isApiErrorMessage = (e as { isApiErrorMessage?: unknown }).isApiErrorMessage === true;
    const rawAttachment = (e as { attachment?: unknown }).attachment;
    const attachment = isRecord(rawAttachment) && typeof rawAttachment.type === "string" ? (rawAttachment as { type: string; [key: string]: unknown }) : undefined;
    result.push({
      type: e.type,
      uuid: e.uuid,
      parentUuid,
      ...(message !== undefined ? { message } : {}),
      ...(compactMetadata !== undefined ? { compact_metadata: compactMetadata } : {}),
      ...(claudeCompactMetadata !== undefined ? { compactMetadata: claudeCompactMetadata } : {}),
      ...(subtype !== undefined ? { subtype } : {}),
      ...(logicalParentUuid !== undefined ? { logicalParentUuid } : {}),
      ...(isCompactSummary ? { isCompactSummary: true as const } : {}),
      ...(isApiErrorMessage ? { isApiErrorMessage: true as const } : {}),
      ...(attachment !== undefined ? { attachment } : {}),
    });
  }
  return result;
}

// --- ancestry-graph walks (fix-round 1, Rulings P1-Q + P1-R) --------------------------------------
//
// A session's loaded entries are a GRAPH, not a linear buffer (WS-05 §7): the store is append-only,
// so an earlier resumeSessionAt leaves its abandoned tail on disk and grows a new branch alongside
// it — a later load() can return entries whose FILE ORDER (chronological append order) does not
// match any single branch's causal ancestry. `rebuildProviderMessages` and `truncateAt` both anchor
// on one specific node and walk `parentUuid` links — never array position — so an abandoned tail or
// an unrelated sibling branch is excluded BY CONSTRUCTION rather than by validating file positions
// after the fact (this task's fix-round-1 review caught the original position-based versions of
// both functions producing wrong results whenever a session had actually branched; the corpus this
// task's own initial test suite exercised was entirely linear, so it never observed the bug).

function buildUuidIndex(entries: DialectEntry[]): Map<string, DialectEntry> {
  return new Map(entries.map((e) => [e.uuid, e] as const));
}

// Walks parentUuid from `leafUuid` back to the root (parentUuid === null), INCLUSIVE of the leaf,
// returning root-first (chronological) order. Degenerates to file order whenever `entries` is a
// single, never-branched lineage.
function ancestryChain(byUuid: Map<string, DialectEntry>, leafUuid: string): DialectEntry[] {
  const chain: DialectEntry[] = [];
  const seen = new Set<string>();
  let cursor: DialectEntry | undefined = byUuid.get(leafUuid);
  while (cursor) {
    if (seen.has(cursor.uuid)) break; // cycle guard — defensive only, never true for a chain that passed validateChain
    seen.add(cursor.uuid);
    chain.push(cursor);
    cursor = cursor.parentUuid === null ? undefined : byUuid.get(cursor.parentUuid);
  }
  return chain.reverse();
}

// --- F2 (WS-21 fix round 23): a PARALLEL tool batch's side-branch results --------------------------
//
// claude writes a batch of parallel tool calls as one one-block `assistant` entry per call, chained
// one after another, and parents each call's `tool_result` entry on ITS OWN call's entry (the
// `sourceToolAssistantUUID` override in its `insertMessageChain`). The parentUuid walk from the leaf
// therefore passes through only ONE result -- the one the next turn was chained onto, normally the
// batch's last -- and every other call reached the provider with no output: "No tool output found
// for function call <id>" on the first turn after a claude -> Winter switch (the live gate's F2).
//
// claude's own reader has the same walk and splices the orphans back in straight afterwards: `Cer`
// (claude 2.1.250 dump, offset 20061141), called by its chain builder `hye` (20059033) right after
// the ancestry walk, logging `tengu_chain_parallel_tr_recovered`. For each group of chain assistant
// entries it collects the `user` entries with `tool_result` content whose parentUuid is a member of
// the group and that are not on the chain, and inserts them right after the group's LAST chain
// member -- so the batch stays contiguous and every result lands after its call.
//
// Winter's pass is that one, with two deliberate differences:
//   - the group is the RUN of consecutive chain `assistant` entries (one response's entries), not a
//     `message.id` -- this projection carries no message id, and the router's same-view loopback
//     answers every turn with one id, so an id group would lump unrelated turns. A recovered entry
//     must ALSO answer a call of the run that nothing on the chain answers yet (the pairing the
//     provider enforces), so a stray duplicate result is never replayed.
//   - claude's pass also recovers off-chain SIBLING assistant entries of the same message id. Not
//     here: in the batches claude writes, the next turn chains through a result whose call is the
//     batch's LAST entry, so every call entry is already on the chain; recovering assistant entries
//     would also resurrect calls a `resumeSessionAt` deliberately cut away.
// Recovered results come in call order (claude sorts by timestamp, which is its write order: the
// call order, for the batches measured). Only RESULTS come back: the skill body and attachments that
// hang off a recovered result's own branch stay out, as they do in claude's pass.
//
// A run that ENDS the chain gets nothing spliced after it. That is claude's `--resume-session-at`,
// which slices its RECOVERED chain at the target: slicing at a batch's last call cuts off the
// results spliced after it. It is also what keeps the chain's last element the chain's own tail.

function toolUseIdsOf(e: DialectEntry): string[] {
  if (e.type !== "assistant" || !Array.isArray(e.message?.content)) return [];
  return (e.message.content as unknown[]).flatMap((b) => (isRecord(b) && b.type === "tool_use" && typeof b.id === "string" ? [b.id] : []));
}

function toolResultIdsOf(e: DialectEntry): string[] {
  if (e.type !== "user" || !Array.isArray(e.message?.content)) return [];
  return (e.message.content as unknown[]).flatMap((b) => (isRecord(b) && b.type === "tool_result" && typeof b.tool_use_id === "string" ? [b.tool_use_id] : []));
}

/**
 * `chain` (root-first) with each parallel batch's off-chain results spliced in right after the
 * batch's last call entry. `pool` is where they are looked for (the loaded file, or what of it a
 * truncation keeps in play). Returns `chain` itself when nothing was recovered.
 */
export function recoverParallelToolResults(chain: readonly DialectEntry[], pool: readonly DialectEntry[]): DialectEntry[] {
  const onChain = new Set(chain.map((e) => e.uuid));
  const resultsByParent = new Map<string, DialectEntry[]>();
  for (const e of pool) {
    if (onChain.has(e.uuid) || e.parentUuid === null || toolResultIdsOf(e).length === 0) continue;
    const siblings = resultsByParent.get(e.parentUuid);
    if (siblings !== undefined) siblings.push(e);
    else resultsByParent.set(e.parentUuid, [e]);
  }
  if (resultsByParent.size === 0) return [...chain];

  const answered = new Set(chain.flatMap(toolResultIdsOf));
  const recovered = new Set<string>();
  const inserts = new Map<string, DialectEntry[]>();
  for (let start = 0; start < chain.length; ) {
    if (chain[start]!.type !== "assistant") {
      start++;
      continue;
    }
    let end = start;
    while (end + 1 < chain.length && chain[end + 1]!.type === "assistant") end++;
    if (end < chain.length - 1) {
      const found: DialectEntry[] = [];
      for (let k = start; k <= end; k++) {
        const member = chain[k]!;
        const open = toolUseIdsOf(member).filter((id) => !answered.has(id));
        if (open.length === 0) continue;
        for (const candidate of resultsByParent.get(member.uuid) ?? []) {
          if (recovered.has(candidate.uuid)) continue;
          const ids = toolResultIdsOf(candidate);
          if (!ids.some((id) => open.includes(id) && !answered.has(id))) continue;
          recovered.add(candidate.uuid);
          for (const id of ids) answered.add(id);
          found.push(candidate);
        }
      }
      if (found.length > 0) inserts.set(chain[end]!.uuid, found);
    }
    start = end + 1;
  }
  if (inserts.size === 0) return [...chain];
  return chain.flatMap((e) => [e, ...(inserts.get(e.uuid) ?? [])]);
}

// Ruling P1-R: "descendant" is graph membership, never file position — entry `candidateUuid`
// descends from `ancestorUuid` iff walking the CANDIDATE's own ancestry passes through the ancestor.
// Excludes the ancestor itself (a node is not its own descendant).
function isDescendant(byUuid: Map<string, DialectEntry>, ancestorUuid: string, candidateUuid: string): boolean {
  if (candidateUuid === ancestorUuid) return false;
  return ancestryChain(byUuid, candidateUuid).some((e) => e.uuid === ancestorUuid);
}

/**
 * `resumeSessionAt` — keep only `atUuid`'s own ancestry; `resumeDropsTurn` confirms the caller
 * intends to discard whatever DESCENDS from it. This NEVER mutates or deletes stored entries — the
 * store is append-only (WS-05 §6): whatever is excluded stays on disk untouched, and continuing
 * from `atUuid` grows a new branch alongside it.
 *
 * Ruling P1-R (fix-round 1 — settles this function's originally-provisional interpretation; see
 * resume.test.ts for the two scenarios that pin it): both "kept" and "dropped" are graph-defined,
 * never positional.
 *   - kept = atUuid's own ancestry (`ancestryChain` above), root to atUuid — independent of where
 *     atUuid sits in file order, and independent of anything else in the file.
 *   - dropped = every entry that DESCENDS from atUuid (its ancestry passes through atUuid),
 *     EXCLUDING atUuid itself. "Every dropped entry descends from the target" (the brief's
 *     original phrasing) IS the definition of "dropped" here — not a validation performed after
 *     computing "dropped" some other (positional) way.
 *   - an entry that is NEITHER an ancestor NOR a descendant of atUuid — an off-lineage sibling
 *     branch, e.g. one abandoned by an earlier, unrelated resumeSessionAt — is simply not on the
 *     lineage this operation concerns: it needs NO confirmation and triggers NO error regardless of
 *     dropsTurn, because resuming at atUuid neither keeps nor discards it; it was never part of
 *     this operation to begin with. Concretely: resuming at an already-abandoned tip (nothing
 *     downstream of it survives to be dropped) succeeds with `dropsTurn:false`.
 *   - dropsTurn:false + real descendants exist -> typed error (silently discarding real turn
 *     content without acknowledgment is refused); dropsTurn:true -> allowed.
 */
export function truncateAt(entries: DialectEntry[], opts: { atUuid: string; dropsTurn: boolean }): DialectEntry[] {
  const byUuid = buildUuidIndex(entries);
  if (!byUuid.has(opts.atUuid)) {
    throw new ResumeTruncationError(`resumeSessionAt target uuid not found in this transcript: ${opts.atUuid}`);
  }

  const kept = ancestryChain(byUuid, opts.atUuid);
  const dropped = entries.filter((e) => isDescendant(byUuid, opts.atUuid, e.uuid));

  if (dropped.length > 0 && !opts.dropsTurn) {
    throw new ResumeTruncationError(
      `resumeSessionAt would drop ${dropped.length} entr${dropped.length === 1 ? "y" : "ies"} descending from ${opts.atUuid}; pass resumeDropsTurn:true to confirm`,
    );
  }

  // F2 (fix round 23): a parallel batch inside the kept ancestry brings its side-branch results with
  // it -- `rebuildProviderMessages` finds them only in the entries it is handed, and the writer's
  // `initialConversationalUuids` must name them in the same order. Never a dropped entry, and never
  // after the last kept element: that stays `atUuid`, which the next append chains onto.
  const droppedUuids = new Set(dropped.map((e) => e.uuid));
  return recoverParallelToolResults(kept, entries.filter((e) => !droppedUuids.has(e.uuid)));
}

// --- rebuilding provider context from a resumed/continued/forked transcript ----------------------
//
// The inverse of engine.ts's own accumulation, which the dialect writer flattens into on-disk
// content-block arrays. Three shapes need un-flattening/anchoring to reproduce EXACTLY what a
// continuous, never-resumed run would have accumulated in memory (pinned by resume.test.ts's
// continuous-vs-split-run fidelity test, and — for the branch case — its own regression test):
//   - Ruling P1-Q (fix-round 1): anchor at the LEAF — the last APPENDED entry (file order IS append
//     order, so this is always the current tip, regardless of any earlier branching) — and walk its
//     ancestry back to the root via `ancestryChain`, exactly like truncateAt above. A PLAIN resume
//     (no resumeSessionAt on this call) of a session that branched earlier now reconstructs ONLY
//     the active branch — an abandoned tail is excluded by construction, closing the
//     merged-context gap this task's own initial report flagged as a concern. Degenerates to file
//     order for a linear (never-branched) session, so every non-branching test this suite already
//     had continues to pass unchanged. Whole-branch review Minor 4: this leaf-anchoring is itself
//     evidence-based — a resumeSessionAt call that appends NOTHING before the process ends (e.g. the
//     caller disconnects, or the run errors, before ever recording a turn at the new branch point)
//     leaves no entry anywhere with `parentUuid === atUuid`, so there is no on-disk trace that a
//     branch choice was ever made. The NEXT plain resume still anchors at the leaf — which, absent
//     any new entry, is simply whatever the physical file's last entry already was (the old,
//     possibly unrelated tip), not the abandoned resumeSessionAt target. This is a consequence of
//     the append-only, graph-not-linear-buffer model (WS-05 §7), not a bug in this function.
//   - a tool-result batch (including an EMPTY one — reviewer nit: engine.ts can persist
//     `recordUser([])` when a provider's tool_use turn requests zero calls) is a "user" entry whose
//     content is an array of tool_result blocks, or an empty array — pushed to engine.ts's
//     `messages` as role "tool" (the dialect has no "tool" role — tool results ride "user" on disk,
//     WS-05 §5.2 — but engine.ts's OWN in-memory history keeps them on a distinct role for
//     round/pairing bookkeeping). An empty array is unambiguously this shape too: this engine never
//     produces a genuine user turn with empty array content.
//   - a plain-text assistant reply was pushed as a bare STRING (`messages.push({role:"assistant",
//     content: turn.text})`), never as the single-element content-block array the dialect always
//     persists it as (assistantEntry's `content: Block[]` contract is array-always) — collapsed
//     back to a string here.
// A resumed history containing engine.ts's own synthetic P1-G (`[interrupted]`) / P1-H (`[error:
// …]`) tool_result markers is legitimate input: neither is special-cased below, since from the
// provider's perspective a synthetic tool_result satisfying a tool_use_id is indistinguishable from
// a real one, and both must round-trip verbatim to preserve the tool_use/tool_result pairing
// invariant on the very next provider request.
export function rebuildProviderMessages(entries: DialectEntry[]): ProviderMessage[] {
  if (entries.length === 0) return [];
  const byUuid = buildUuidIndex(entries);
  const leafUuid = entries[entries.length - 1]!.uuid; // file order is append order — the last entry is always the current tip
  const lineage = ancestryChain(byUuid, leafUuid);

  // --- Phase 5 Task 3 (R5-4): a compaction boundary CUTS the rebuilt history ----------------------
  //
  // Without this, a resumed session rebuilds the entire pre-compaction conversation -- silently
  // undoing the compaction on the first resume, and doing it in the WORST direction (straight back
  // over the threshold that triggered compaction in the first place). The boundary entry itself is
  // non-conversational, so the pre-existing "skip entries with no `message`" line below cannot catch
  // this: it skips the boundary and happily rebuilds everything around it.
  //
  // The cut follows the pinned relink semantics (derived-shapes-p5 item (f)): from the LAST boundary
  // on this lineage, history is `anchor_uuid` (the summary) followed by `preserved_messages.uuids` in
  // order, then everything appended after the boundary. `preserved_segment` is deliberately not read
  // -- the pin marks `preserved_messages` as SUPERSEDING it, and Winter never writes the older field.
  //
  // A boundary with NO `preserved_messages` (compaction summarized everything) keeps just the summary.
  //
  // Phase 10b Lane S, S3 (W18-13b): Claude's OWN native boundary is `type:"system",
  // subtype:"compact_boundary"` -- a DIFFERENT dialect `type` string than the legacy
  // `"compact_boundary"` entry, so both are recognised here. Whichever shape is LAST on the lineage
  // wins (W18-13e: a file compacted once in each shape cuts at the more recent one), independent of
  // which shape it happens to be.
  const isLegacyBoundary = (e: DialectEntry) => e.type === "compact_boundary";
  const isClaudeBoundary = (e: DialectEntry) => e.type === "system" && e.subtype === "compact_boundary";
  const lastBoundaryIndex = lineage.reduce((acc, e, i) => (isLegacyBoundary(e) || isClaudeBoundary(e) ? i : acc), -1);
  const effectiveLineage =
    lastBoundaryIndex === -1
      ? lineage
      : (() => {
          const boundary = lineage[lastBoundaryIndex]!;

          // Claude's native shape: `logicalParentUuid` is NEVER followed for history (W18-13's own
          // text) -- the boundary's real chain `parentUuid` is already `null`, so `ancestryChain`
          // stops here by construction, and the summary that follows it in the SAME lineage (parented
          // ON the boundary, per W18-12's write order) is already the very next lineage element:
          // "everything after the boundary" already starts with the summary itself, with NO
          // re-splicing needed, when nothing was preserved.
          //
          // Fix round 1 (LOAD-BEARING, controller ruling): Winter's own writer NOW names
          // `compactMetadata.preservedMessages` (camelCase) when it retained something (superseding
          // the original P10b-7 "never" reading -- see `claudeCompactBoundaryEntry`'s own header).
          // The preserved entries live BEFORE the null-parent cut, so unlike the legacy branch below
          // they are NOT reachable inside `lineage` at all -- they must be looked up from the
          // WHOLE-FILE `byUuid` index this function built at its own top, exactly the entries the
          // ancestry walk deliberately excluded. Order is summary, then `uuids` in order, then
          // everything appended after the boundary -- byte-exact to the golden's own relink order.
          //
          // Micro-round (pre-0.0.10-publish): this path also reads transcripts written by the REAL
          // claude binary on the Claude -> Winter return trip, so Winter's own writer invariants
          // (which never name a uuid in both `preservedMessages` and the post-boundary lineage) do
          // not bind here. De-duplicate by uuid against `restAfterSummary`: a uuid reachable both
          // ways appears exactly ONCE, at its post-cut position -- dropped from the preserved splice,
          // never from the post-cut tail.
          if (isClaudeBoundary(boundary)) {
            const claudeMeta = isRecord(boundary.compactMetadata) ? boundary.compactMetadata : undefined;
            const claudePreserved = claudeMeta !== undefined && isRecord(claudeMeta.preservedMessages) ? claudeMeta.preservedMessages : undefined;
            const claudePreservedUuids = claudePreserved !== undefined && Array.isArray(claudePreserved.uuids) ? (claudePreserved.uuids as unknown[]).filter((u): u is string => typeof u === "string") : [];
            const summaryAndAfter = lineage.slice(lastBoundaryIndex + 1);
            const [summaryEntry, ...restAfterSummary] = summaryAndAfter;
            const restAfterSummaryUuids = new Set(restAfterSummary.map((e) => e.uuid));
            const claudePreservedInOrder = claudePreservedUuids.flatMap((u) => {
              if (restAfterSummaryUuids.has(u)) return [];
              const found = byUuid.get(u);
              return found !== undefined ? [found] : [];
            });
            if (claudePreservedInOrder.length === 0) return summaryAndAfter;
            return summaryEntry !== undefined ? [summaryEntry, ...claudePreservedInOrder, ...restAfterSummary] : [...claudePreservedInOrder, ...restAfterSummary];
          }

          const meta = isRecord(boundary.compact_metadata) ? boundary.compact_metadata : undefined;
          const preserved = meta !== undefined && isRecord(meta.preserved_messages) ? meta.preserved_messages : undefined;
          const anchorUuid = preserved !== undefined && typeof preserved.anchor_uuid === "string" ? preserved.anchor_uuid : undefined;
          // ORDER IS THE PINNED RELINK ORDER, not file order: `uuids[0]` links to `anchor_uuid`, so
          // the anchor (the summary) comes FIRST and the preserved messages follow in `uuids` order.
          // File order would put the summary LAST -- it is appended after the entries it preserves --
          // which would hand the provider a conversation whose summary arrives after the messages it
          // summarizes.
          //
          // When a boundary names no anchor (nothing preserved), the summary is found by type; the
          // writer always appends exactly one immediately before the boundary. Both routes keep the
          // summary and nothing else from before the cut.
          const before = lineage.slice(0, lastBoundaryIndex);
          const byUuidBefore = new Map(before.map((e) => [e.uuid, e] as const));
          const anchor = anchorUuid !== undefined ? byUuidBefore.get(anchorUuid) : before.filter((e) => e.type === "compact_summary").at(-1);
          const preservedInOrder = preserved !== undefined && Array.isArray(preserved.uuids) ? (preserved.uuids as unknown[]).flatMap((u) => (typeof u === "string" ? [byUuidBefore.get(u)] : [])).filter((e): e is DialectEntry => e !== undefined) : [];
          const head = [...(anchor !== undefined ? [anchor] : []), ...preservedInOrder];
          return [...head, ...lineage.slice(lastBoundaryIndex + 1)];
        })();

  // F2 (fix round 23): a claude parallel batch's other results live on side branches of the walk --
  // spliced back in after the batch (`recoverParallelToolResults`, claude's `Cer`). Run on the
  // lineage AFTER the compaction cut, so only a batch that survives the cut can recover anything.
  const recoveredLineage = recoverParallelToolResults(effectiveLineage, entries);

  const messages: ProviderMessage[] = [];
  for (const e of recoveredLineage) {
    // SDK 0.0.16 (P16-5/P16-6): a persisted ATTACHMENT comes back as the same meta user message the
    // live engine appended -- rendered from its payload by the one renderer (context/attachments.ts),
    // so the folds see it and nothing is re-announced. A type Winter has no renderer for (claude's own
    // `total_tokens_reminder`, say) renders to nothing and is skipped, as before.
    if (e.type === "attachment") {
      if (e.attachment !== undefined) {
        const rebuilt = attachmentMessage(e.attachment);
        if (rebuilt !== undefined) messages.push(rebuilt);
      }
      continue;
    }
    const message = e.message;
    if (message === undefined) continue; // not a conversational entry — never fed to the provider (chain continuity is computed from the full entry array elsewhere, not from this function's output)
    const content = message.content;

    // Phase 5 Task 3: a `compact_summary` entry carries `{role:"user", content: <summary string>}` and
    // rebuilds as the first user message of the compacted conversation -- its own type rather than
    // `"user"` so a transcript reader can still tell a summary from something the human typed.
    // Phase 6 Task 3 (R6-7): the ENTRY's own uuid rides the rebuilt ASSISTANT message.
    //
    // Without it a resumed session has no anchor at all: `buildContinuationChain` is keyed on
    // `anchorUuid`, which IS this uuid, so a rebuilt history that dropped it could never be
    // re-associated with its provider-state records however complete the sidecar was.
    //
    // ASSISTANT ONLY, and the restriction is R6-7's own: "one `origin` record per assistant entry".
    // A user entry has no provider state and therefore no anchor, and stamping one would break the
    // continuous-vs-resumed fidelity this function's own tests pin -- the live engine pushes a user
    // message before any uuid exists for it.
    if (e.type === "user" || e.type === "compact_summary") {
      if (Array.isArray(content) && (content.length === 0 || content.every((b) => isRecord(b) && b.type === "tool_result"))) {
        messages.push({ role: "tool", content: content as ContentBlock[] });
      } else if (typeof content === "string") {
        messages.push({ role: "user", content });
      } else if (Array.isArray(content)) {
        // Not producible by this engine today (a user entry's content is always either plain text
        // or a — possibly empty — batch of tool_result blocks), but WS-05 §5.1's wider corpus
        // allows richer user content — pass through rather than silently dropping an
        // unrecognized-but-real shape.
        messages.push({ role: "user", content: content as ContentBlock[] });
      }
    } else if (e.type === "assistant") {
      // W18-13c (probe P6): claude writes a failed call as a synthetic `isApiErrorMessage: true`
      // assistant entry (`model: "<synthetic>"`, an `error`/`apiErrorStatus` pair) -- replaying it to
      // a provider as a real prior turn would feed it a call it never made. Skipped, never rebuilt.
      if (e.isApiErrorMessage === true) continue;
      // Fix round 3 (P10b-6, W18-17): carried STRUCTURALLY -- `ProviderMessage` stays closed (no
      // `model` field of its own; this repo's interfaces are additive-only, R6-3's own rule), exactly
      // mirroring what `renderer.ts`'s `structuralModel` fallback already reads off the object it is
      // handed. Built via a plain variable rather than a typed object literal so TypeScript's excess-
      // property check (which fires only on a literal assigned directly into a typed position) never
      // applies -- `messages.push` then only checks the STRUCTURAL fields it declares.
      const modelField = e.message?.model !== undefined ? { model: e.message.model } : {};
      if (Array.isArray(content) && content.length === 1 && isRecord(content[0]) && content[0]!.type === "text" && typeof content[0]!.text === "string") {
        messages.push({ role: "assistant", content: content[0]!.text as string, uuid: e.uuid, ...modelField });
      } else if (Array.isArray(content)) {
        messages.push({ role: "assistant", content: content as ContentBlock[], uuid: e.uuid, ...modelField });
      }
    }
    // Unknown entry types are skipped for provider context — never fed to a real provider.
  }
  return messages;
}

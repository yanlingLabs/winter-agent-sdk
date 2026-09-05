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
  message?: { role: string; content: unknown };
  // Phase 5 Task 3 (R5-4): carried through so `rebuildProviderMessages` can honour a compaction
  // boundary. Typed `unknown` and narrowed at the one read site -- this projection deliberately
  // mirrors only what resume READS, and a structurally-typed metadata object here would make every
  // reader believe the field had already been validated.
  compact_metadata?: unknown;
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
    const message = isRecord(rawMessage) && typeof rawMessage.role === "string" ? { role: rawMessage.role, content: rawMessage.content } : undefined;
    const compactMetadata = (e as { compact_metadata?: unknown }).compact_metadata;
    result.push({ type: e.type, uuid: e.uuid, parentUuid, ...(message !== undefined ? { message } : {}), ...(compactMetadata !== undefined ? { compact_metadata: compactMetadata } : {}) });
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

  return kept;
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
  const lastBoundaryIndex = lineage.reduce((acc, e, i) => (e.type === "compact_boundary" ? i : acc), -1);
  const effectiveLineage =
    lastBoundaryIndex === -1
      ? lineage
      : (() => {
          const boundary = lineage[lastBoundaryIndex]!;
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

  const messages: ProviderMessage[] = [];
  for (const e of effectiveLineage) {
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
      if (Array.isArray(content) && content.length === 1 && isRecord(content[0]) && content[0]!.type === "text" && typeof content[0]!.text === "string") {
        messages.push({ role: "assistant", content: content[0]!.text as string, uuid: e.uuid });
      } else if (Array.isArray(content)) {
        messages.push({ role: "assistant", content: content as ContentBlock[], uuid: e.uuid });
      }
    }
    // Unknown entry types are skipped for provider context — never fed to a real provider.
  }
  return messages;
}

// The Claude-dialect transcript writer/reader (WS-05 §5.2 / task-8 brief): converts the engine's
// turn content into Claude-transcript-compatible JSONL entries — uuid/parentUuid chain, sessionId,
// cwd, version, isSidechain, timestamps — and appends them through the Task-7
// WinterCompatibilitySessionStore. Winter-private producer/dialect metadata (WS-05 §5.4, narrowed
// to the fields P1 actually needs) rides a reserved sentinel SessionStoreEntry type folded into the
// store's summary sidecar (session-store.ts's DIALECT_RECORD_ENTRY_TYPE handling) — it is NEVER a
// transcript line (WS-05 §5.2: "never add a Winter-only transcript line for producer/version
// metadata").
//
// P1 scope: only the MAIN chain (isSidechain: false) at message boundaries — no init/lifecycle
// frames, no subagent transcripts, no resume (Task 9).
import { randomUUID } from "node:crypto";
import type { RuntimeConfig, PermissionUpdate, RuleSource } from "@yanlinglabs/winter-agent-sdk";
// Task 10 (WS-05 §6): the store, path-key helpers, and the store-level fork primitive all moved to
// the sdk package — this file imports them from there now, same dependency direction as the
// Task-1 protocol inversion (runtime -> sdk, never the reverse). forkSessionByKey is the relocated
// store-level primitive (packages/sdk/src/store/fork-session.ts): the ONLY caller left in this
// file, so it is imported directly here rather than re-exported through resume.ts (which no longer
// has any relationship to it — see task-10-report.md).
import {
  WinterCompatibilitySessionStore,
  DIALECT_RECORD_ENTRY_TYPE,
  resolveWinterHome,
  compatibilityKeys,
  forkSessionByKey,
  WinterStoreLeaseError,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@yanlinglabs/winter-agent-sdk";
import type { ContentBlock, ProviderMessage, SessionPersistence } from "../engine.ts";
import type { CompactBoundaryRecord, CompactBoundaryWriteResult } from "../compaction/seam.ts";
import { resolveProjectDirName } from "../paths/project-dir-name.ts";
import { findContinueTarget, findResumeTarget, truncateAt, toDialectEntries, rebuildProviderMessages, ResumeTargetError } from "./resume.ts";
// Task 8 (WS-07 §3.3 / phase ruling 2): the permission journal — ruleset.ts's own header names this
// task ("T8's canUseTool wiring") as its first real caller with something to journal.
// Task 10 (WS-08 §9 Amended / P2-A): the SAME journal file also carries hook audit records — see
// appendHookAuditJournal's own header (ruleset.ts) for why this reuses one file rather than a
// second sidecar.
import { appendPermissionJournal, appendHookAuditJournal, type HookAuditJournalRecord } from "../permissions/ruleset.ts";
// Task 11 (WS-07 §9): the durable approval store lives store-adjacent (SAME <winterHome>/projects/
// <projectKey>/ directory the session's own <sessionId>.jsonl and permission journal already use) —
// this module already resolves that exact (winterHome, projectKey, sessionId) triple on every
// branch below, so it is the natural, single construction site (mirrors buildWriter's own role for
// the session store itself). engine.ts imports the TYPE only from this same module too — no
// circularity, since permissions/approvals.ts has no dependency on either file.
import { createFileDurableApprovalStore, type DurableApprovalStore } from "../permissions/approvals.ts";
// Task 12 (WS-07 §10.5): the 3-consecutive/20-total auto-mode fallback counters, restart-durable —
// same rationale, same (winterHome, projectKey, sessionId) triple, same construction sites as
// approvalStore immediately above (T11's own precedent, extended). auto/caches.ts has no
// dependency on this module (or on engine.ts) — no circularity concern beyond what approvalStore's
// own import already established.
import { createFileAutoCounterStore, type AutoCounterStore } from "../permissions/auto/caches.ts";

// The dialect's own name for a content block. Same shapes engine.ts's ContentBlock already
// produces (text/tool_use/tool_result, P1-G's `interrupted` and P1-H's `error` markers included) —
// re-exported under the dialect's own vocabulary rather than duplicated, since at P1 scope the
// on-disk shape and the engine's in-memory turn-history shape coincide exactly. A real Claude
// transcript's content union is wider (WS-05 §5.1's corpus also lists advisor_tool_result / image /
// server_tool_use / thinking) — out of scope until a later task widens what the engine can produce.
export type Block = ContentBlock;

// The chain state a caller carries forward across calls: every dialect entry after the session's
// first links to the entry before it via parentUuid (WS-05 §5.2's "exact... parent chain"); `null`
// marks "no prior entry yet" (the main transcript's first line).
export interface Chain {
  parentUuid: string | null;
}

// Fields shared by every entry in one session but not part of DialectEntryBase's per-call inputs
// (chain/content) — sessionId/cwd/version never change turn to turn, so a caller builds one
// SessionCtx per session and reuses it across every userEntry/assistantEntry call.
export interface SessionCtx {
  sessionId: string;
  cwd: string;
  version: string; // engineVersion — see RUNTIME_ENGINE_VERSION below for Task 8's chosen source
  // Task 9 / Ruling P1-N (WS-05 §3.2): the resolved (WINTER_PROJECT_DIR_NAME-overridden, or
  // default) persistent projectKey this session is actually stored under — carried into the
  // dialect record's summary sidecar extension fields so a later resume can prefer this RECORDED
  // value over a fresh env resolution (resolveEngineSession below). Optional so existing callers
  // that predate Task 9 (and tests constructing a bare SessionCtx) keep compiling unchanged.
  projectDirName?: string;
}

export interface DialectEntryBase {
  type: string;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string; // ISO-8601
  cwd: string;
  version: string; // engineVersion
  isSidechain: boolean;
  [k: string]: unknown;
}

// A plain (no index signature) interface, deliberately NOT `Omit<DialectEntryBase, "type">`: TS's
// object-spread checking against a target INTERSECTION type (DialectEntryBase & {type: "..."; ...})
// doesn't reliably propagate a spread source's properties when that source's type carries — even
// indirectly via Omit/Pick over DialectEntryBase's own `[k: string]: unknown` — an index signature.
// Empirically confirmed while implementing userEntry/assistantEntry below (see task-8 report).
type BaseFields = {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  version: string;
  isSidechain: boolean;
};

function baseFields(ctx: SessionCtx, chain: Chain): BaseFields {
  return {
    uuid: randomUUID(),
    parentUuid: chain.parentUuid,
    sessionId: ctx.sessionId,
    timestamp: new Date().toISOString(),
    cwd: ctx.cwd,
    version: ctx.version,
    isSidechain: false, // P1 persists only the main chain — a subagent's `true` is later-task scope
  };
}

// Phase 4 Task 3 (WS-05 §5.2, WS-10 §7): a child (subagent) transcript's own two extra fields --
// `agentId` identifies WHICH child, `parentToolUseId` is the Agent-tool tool_use ID that spawned it
// (WS-05 §5.2's own "preserve... agentId, parentUuid, parent_tool_use_id" list; not to be confused
// with `parentUuid`, the CHAIN parent WITHIN this same child's own transcript, already carried by
// `chain.parentUuid` above and completely independent of this field). When supplied, every entry
// `userEntry`/`assistantEntry` produces carries `isSidechain: true` plus these two fields; when
// omitted (every pre-existing call site), the entry is byte-identical to before this task --
// `isSidechain: false`, no `agentId`/`parent_tool_use_id` keys at all (P1's own "persists only the
// main chain" scope, now genuinely optional rather than hardcoded).
export interface SidechainStamp {
  agentId: string;
  parentToolUseId: string;
}

// The brief's literal opts shape is `{ text: string; chain; ctx }`, but its own prose requires tool
// results to route through userEntry as content BLOCKS ("tool results → userEntry with tool_result
// blocks") — blocks are never a plain string. Read as a deliberate union: userEntry accepts EITHER
// a plain `text` string OR pre-built `content` blocks, both producing the same `string | Block[]`
// message.content the brief's own return type already declares.
export type UserEntryOpts = { chain: Chain; ctx: SessionCtx; sidechain?: SidechainStamp } & ({ text: string } | { content: Block[] });

export function userEntry(
  opts: UserEntryOpts,
): DialectEntryBase & { type: "user"; message: { role: "user"; content: string | Block[] } } {
  const content: string | Block[] = "text" in opts ? opts.text : opts.content;
  return {
    type: "user",
    ...baseFields(opts.ctx, opts.chain),
    // Overrides baseFields' own unconditional `isSidechain: false` -- see SidechainStamp's own
    // header for why this is a POST-baseFields spread rather than a baseFields parameter (it keeps
    // baseFields/BaseFields completely untouched for every existing caller).
    ...(opts.sidechain !== undefined ? { isSidechain: true as const, agentId: opts.sidechain.agentId, parent_tool_use_id: opts.sidechain.parentToolUseId } : {}),
    message: { role: "user", content },
  };
}

export function assistantEntry(opts: {
  content: Block[];
  chain: Chain;
  ctx: SessionCtx;
  sidechain?: SidechainStamp;
}): DialectEntryBase & { type: "assistant"; message: { role: "assistant"; content: Block[] } } {
  return {
    type: "assistant",
    ...baseFields(opts.ctx, opts.chain),
    ...(opts.sidechain !== undefined ? { isSidechain: true as const, agentId: opts.sidechain.agentId, parent_tool_use_id: opts.sidechain.parentToolUseId } : {}),
    message: { role: "assistant", content: opts.content },
  };
}

// --- Phase 5 Task 3 (R5-4, WS-05 §5): the compaction dialect entries ------------------------------
//
// TWO entries per compaction, appended in this order:
//
//   1. `compact_summary` -- CONVERSATIONAL (it carries a `message`), because the summary IS the
//      history after the boundary. On resume it rebuilds as the first user message of the compacted
//      conversation, which is what makes a resumed session see the same context the live session saw.
//   2. `compact_boundary` -- NON-conversational (no `message`), carrying the pinned six-field
//      `compact_metadata`. It is appended AFTER the summary specifically so it can name the summary
//      as `preserved_messages.anchor_uuid` -- the entry is a BACKWARD-LOOKING record of a cut that
//      has already been made, not a marker placed ahead of one.
//
// ENTRY NAMES ARE WINTER-DEFINED and disclosed as such: derived-shapes-p5 item (e) established that
// the pinned transcript entry union is CLI-internal by design (`sdk.d.ts:5362-5369` types
// `SessionStoreEntry` as a deliberately minimal structural supertype and says outright that the
// concrete union is not part of the SDK API surface). The `compact_metadata` FIELD SHAPE is pinned
// (item (f)); the entry `type` strings that carry it are not, and cannot be.
const MAX_TRACKED_CONVERSATIONAL_UUIDS = 4096;

export const COMPACT_SUMMARY_ENTRY_TYPE = "compact_summary";
export const COMPACT_BOUNDARY_ENTRY_TYPE = "compact_boundary";

export interface CompactMetadata {
  trigger: "manual" | "auto";
  pre_tokens: number;
  post_tokens?: number;
  duration_ms?: number;
  preserved_messages?: { anchor_uuid: string; uuids: string[] };
}

export function compactSummaryEntry(opts: {
  summary: string;
  chain: Chain;
  ctx: SessionCtx;
  sidechain?: SidechainStamp;
}): DialectEntryBase & { type: "compact_summary"; message: { role: "user"; content: string } } {
  return {
    type: COMPACT_SUMMARY_ENTRY_TYPE,
    ...baseFields(opts.ctx, opts.chain),
    ...(opts.sidechain !== undefined ? { isSidechain: true as const, agentId: opts.sidechain.agentId, parent_tool_use_id: opts.sidechain.parentToolUseId } : {}),
    // `role: "user"` rather than a third role: WS-05 §5.1's dialect has only user/assistant, and
    // resume.ts's rebuild maps a string-content user entry straight to a `user` ProviderMessage --
    // exactly what a summary should be when the conversation continues.
    message: { role: "user", content: opts.summary },
  };
}

export function compactBoundaryEntry(opts: {
  metadata: CompactMetadata;
  chain: Chain;
  ctx: SessionCtx;
  sidechain?: SidechainStamp;
}): DialectEntryBase & { type: "compact_boundary"; compact_metadata: CompactMetadata } {
  return {
    type: COMPACT_BOUNDARY_ENTRY_TYPE,
    ...baseFields(opts.ctx, opts.chain),
    ...(opts.sidechain !== undefined ? { isSidechain: true as const, agentId: opts.sidechain.agentId, parent_tool_use_id: opts.sidechain.parentToolUseId } : {}),
    compact_metadata: opts.metadata,
  };
}

export class TranscriptWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptWriterError";
  }
}

// Validates uuid uniqueness + parent reachability over exactly the entries that carry a `uuid`
// (WS-05 §5.2's chain guarantee applies to dialect entries; an unknown/foreign entry that happens
// to have no uuid at all is simply not part of the chain and must not make the validator choke).
function validateChain(entries: SessionStoreEntry[]): void {
  const withUuid = entries.filter((e): e is SessionStoreEntry & { uuid: string } => typeof e.uuid === "string");
  const seen = new Set<string>();
  for (const e of withUuid) {
    if (seen.has(e.uuid)) throw new TranscriptWriterError(`duplicate uuid in transcript: ${e.uuid}`);
    seen.add(e.uuid);
  }
  for (const e of withUuid) {
    const parentUuid = typeof e.parentUuid === "string" ? e.parentUuid : null;
    if (parentUuid !== null && !seen.has(parentUuid)) {
      throw new TranscriptWriterError(`entry ${e.uuid} has an unreachable parentUuid: ${parentUuid}`);
    }
  }
}

export interface TranscriptWriterOptions {
  store: SessionStore;
  key: SessionKey;
  ctx: SessionCtx;
  // Task 9: resume/continue/fork continue an EXISTING chain — the first entry this writer appends
  // must link to the resumed target's last entry, not start a fresh chain. Omitted/undefined ->
  // null, i.e. exactly P1's pre-Task-9 behavior (every writer starts a fresh chain).
  initialParentUuid?: string | null;
  // Phase 4 Task 3 (WS-05 §5.2, WS-10 §7): when supplied, EVERY entry this writer produces is
  // stamped `isSidechain: true` + `agentId`/`parent_tool_use_id` (SidechainStamp's own header) --
  // this is what `buildChildTranscriptWriter` below sets for a child's own writer; every
  // pre-existing caller omits it, staying byte-identical to before this task.
  sidechain?: SidechainStamp;
  // Phase 5 Task 3 (R5-4): the uuids of the CONVERSATIONAL entries already on this session's chain,
  // oldest-first -- resolveEngineSession seeds it on a resume/continue/fork so `recordCompactBoundary`
  // can name preserved messages that predate THIS run. Omitted for a fresh session (nothing precedes
  // it) and for every pre-P5 caller, in which case the writer names only what it appended itself.
  initialConversationalUuids?: readonly string[];
}

// Holds the chain head for one session and appends dialect entries through the Task-7 store — the
// TranscriptWriter-backed SessionPersistence implementation engine.ts's persistence seam (Ruling
// P1-B) adapts over (see createTranscriptPersistence below). The seam needed NO extension:
// recordUserEntry already accepts `string | ContentBlock[]`, which is exactly how both plain user
// text and tool-result blocks arrive.
export class TranscriptWriter implements SessionPersistence {
  private readonly store: SessionStore;
  private readonly key: SessionKey;
  private readonly ctx: SessionCtx;
  private readonly sidechain: SidechainStamp | undefined;
  private parentUuid: string | null;
  // Phase 5 Task 3: every conversational entry on this chain, oldest-first. `recordCompactBoundary`
  // names the last N of them as `preserved_messages.uuids`, which is how a resumed session relinks
  // the kept segment WITHOUT the transcript carrying a second copy of it (see compactBoundaryEntry).
  // Bounded: only the most recent MAX_TRACKED_CONVERSATIONAL_UUIDS are kept, because a boundary can
  // only ever preserve a retention window, never an unbounded history.
  private readonly conversationalUuids: string[];

  constructor(opts: TranscriptWriterOptions) {
    this.store = opts.store;
    this.key = opts.key;
    this.ctx = opts.ctx;
    this.sidechain = opts.sidechain;
    // Task 9: a resumed/continued/forked session seeds this with the target's last entry's uuid so
    // the very next append continues the SAME chain; every pre-Task-9 caller (and every fresh
    // session) omits it, preserving the original "every writer starts fresh" behavior exactly.
    // Phase 4 Task 3: a child writer ALSO always starts at `null` here (never a resumed position) --
    // a child transcript's own chain is independent of the main session's, and this task builds no
    // child-resume machinery (P4/Lane C's own future scope) that would ever pass a non-null value
    // alongside a `sidechain` option.
    this.parentUuid = opts.initialParentUuid ?? null;
    this.conversationalUuids = [...(opts.initialConversationalUuids ?? [])];
  }

  async recordUserEntry(content: string | Block[]): Promise<void> {
    const chain: Chain = { parentUuid: this.parentUuid };
    const sidechainOpt = this.sidechain !== undefined ? { sidechain: this.sidechain } : {};
    const entry = typeof content === "string" ? userEntry({ text: content, chain, ctx: this.ctx, ...sidechainOpt }) : userEntry({ content, chain, ctx: this.ctx, ...sidechainOpt });
    await this.appendWithDialectRecord(entry);
    this.parentUuid = entry.uuid;
    this.trackConversational(entry.uuid);
  }

  async recordAssistantEntry(content: Block[]): Promise<void> {
    const chain: Chain = { parentUuid: this.parentUuid };
    const entry = assistantEntry({ content, chain, ctx: this.ctx, ...(this.sidechain !== undefined ? { sidechain: this.sidechain } : {}) });
    await this.appendWithDialectRecord(entry);
    this.parentUuid = entry.uuid;
    this.trackConversational(entry.uuid);
  }

  private trackConversational(uuid: string): void {
    this.conversationalUuids.push(uuid);
    if (this.conversationalUuids.length > MAX_TRACKED_CONVERSATIONAL_UUIDS) this.conversationalUuids.splice(0, this.conversationalUuids.length - MAX_TRACKED_CONVERSATIONAL_UUIDS);
  }

  // Phase 5 Task 3 (R5-4): the SessionPersistence method the engine calls when a compaction commits.
  //
  // Appends the summary FIRST, then the boundary that names it -- see compactBoundaryEntry's own
  // header for why the boundary is backward-looking. `preserved_messages` names the last
  // `retainedCount` conversational entries this chain has (the summary itself is the `anchor_uuid`,
  // never one of the `uuids`), and is OMITTED ENTIRELY when nothing is retained, matching the pinned
  // "both are unset when compaction summarizes everything".
  //
  // Bounded-by-what-we-know, stated rather than hidden: if `retainedCount` exceeds the entries this
  // chain has tracked, the boundary names every one it has. That under-names rather than
  // over-names -- a resumed session then sees LESS context than the live one did, never context the
  // live session had already dropped.
  async recordCompactBoundary(record: CompactBoundaryRecord): Promise<CompactBoundaryWriteResult> {
    const summary = compactSummaryEntry({
      summary: record.summary,
      chain: { parentUuid: this.parentUuid },
      ctx: this.ctx,
      ...(this.sidechain !== undefined ? { sidechain: this.sidechain } : {}),
    });
    // The preserved set is computed BEFORE the summary joins the tracked list, so a summary can
    // never preserve itself.
    const preserved = record.retainedCount > 0 ? this.conversationalUuids.slice(-record.retainedCount) : [];
    await this.appendWithDialectRecord(summary);
    this.parentUuid = summary.uuid;

    const metadata: CompactMetadata = {
      trigger: record.trigger,
      pre_tokens: record.preTokens,
      ...(record.postTokens !== undefined ? { post_tokens: record.postTokens } : {}),
      ...(record.durationMs !== undefined ? { duration_ms: record.durationMs } : {}),
      ...(preserved.length > 0 ? { preserved_messages: { anchor_uuid: summary.uuid, uuids: preserved } } : {}),
    };
    const boundary = compactBoundaryEntry({ metadata, chain: { parentUuid: this.parentUuid }, ctx: this.ctx, ...(this.sidechain !== undefined ? { sidechain: this.sidechain } : {}) });
    await this.appendWithDialectRecord(boundary);
    this.parentUuid = boundary.uuid;

    // The summary is the new head of conversational history: everything before the boundary is
    // replaced by it plus whatever `preserved` names, so the tracked list is rebuilt to match what a
    // resume would rebuild. Without this, a SECOND compaction in the same run would name entries the
    // first one already discarded.
    this.conversationalUuids.length = 0;
    this.conversationalUuids.push(summary.uuid, ...preserved);

    // Fix round 1 (M3): handed back so the engine can put `preserved_messages` on the emitted frame.
    // These uuids are minted here and exist nowhere else.
    return { boundaryUuid: boundary.uuid, anchorUuid: summary.uuid, preservedUuids: preserved };
  }

  // WS-05 §5.3 / WS-10 §3.4/§7: the `.meta.json` sidecar, via the store's own `agent_metadata`
  // envelope partitioning (session-store.ts's append() -- NEVER written to the jsonl; the dialect
  // layer's own contribution here is nothing more than the envelope TYPE tag, matching
  // `appendWithDialectRecord`'s identical "the store partitions this, this writer just tags it"
  // division of labor). Available on ANY TranscriptWriter (the store itself doesn't restrict
  // `agent_metadata` to subpath keys), but its real caller is a CHILD writer
  // (buildChildTranscriptWriter below) -- WS-10 §3.4's own recorded-resolution fields
  // (requestedModel/effectiveModel/requestedEffort/effectiveEffort) and §7's ChildSessionRecord
  // shape are exactly what a caller is expected to pass as `metadata`, though this method itself
  // stays agnostic about the field set (a later task's own concern, not this store-plumbing seam's).
  // Each call REPLACES the sidecar wholesale (store's own "only the latest [envelope] survives") --
  // never a partial merge; a caller that wants to update one field re-sends the whole object.
  async writeMetadata(metadata: Record<string, unknown>): Promise<void> {
    await this.store.append(this.key, [{ type: "agent_metadata", ...metadata }]);
  }

  // No-op: every record*Entry call above already awaits store.append() before resolving, so there
  // is nothing buffered to flush at P1. Kept as a real method (not simply omitted) so a caller that
  // always calls store.flush?.() unconditionally (engine.ts does) sees consistent behavior whether
  // or not a store happens to buffer in some future revision.
  async flush(): Promise<void> {
    /* no-op — see comment above */
  }

  // Every append carries the dialect record ALONGSIDE the real entry: stateless (no "is this the
  // first append" bookkeeping) and self-healing (session-store.ts's foldSummary spreads `...previous`
  // before the fresh record, so even a corrupted/missing summary sidecar is restored on the very
  // next append rather than staying wrong until some explicit repair step).
  private async appendWithDialectRecord(entry: SessionStoreEntry): Promise<void> {
    const dialectRecord: SessionStoreEntry = {
      type: DIALECT_RECORD_ENTRY_TYPE,
      producerRuntime: "winter-agent",
      producerEngineVersion: this.ctx.version,
      dialectFamily: "claude-code-jsonl",
      // Ruling P1-N (2): persist the resolved projectKey alongside the session on every append —
      // stateless and self-healing exactly like the fields above (see this method's own header
      // comment), so a resumed session's recorded name is refreshed, never staled, on its very next
      // turn. Conditional spread: a caller predating Task 9 (or a bare test SessionCtx) simply omits
      // the field, matching exactOptionalPropertyTypes.
      ...(this.ctx.projectDirName !== undefined ? { projectDirName: this.ctx.projectDirName } : {}),
    };
    await this.store.append(this.key, [entry, dialectRecord]);
  }

  // Reads a transcript back through `store` (independent of any writer instance's own held
  // state — a fresh TranscriptWriter never resumes an existing chain at P1, but tests, and a future
  // resume feature, need to validate one that already exists) and asserts uuid uniqueness + parent
  // reachability (WS-05 §5.2). Pure pass-through otherwise — never normalizes an entry's shape, so
  // an unknown entry type / unknown fields survive completely untouched.
  static async readBack(store: SessionStore, key: SessionKey): Promise<SessionStoreEntry[]> {
    const entries = await store.load(key);
    if (entries === null) return [];
    validateChain(entries);
    return entries;
  }
}

// Task 8: "use the runtime package's real version... document your source." Chosen source:
// packages/runtime/package.json's own "version" field (currently independent of the root VERSION
// file's #.#.### convention — that mismatch already exists on main and is out of this task's
// scope). Hardcoded, rather than read at runtime, because main.ts is compiled to a single-file
// `$bunfs` binary (bun build --compile) that cannot do a dynamic/relative fs read of its own
// package.json at runtime — a static `import ... with { type: "json" }` was considered but adds an
// unproven compiled-binary dependency for a single string; a hardcoded constant plus this test-time
// parity check (dialect.test.ts's "engineVersion source" describe block, which runs under plain
// `bun test` — never compiled — so a real fs read there is safe) gets the same drift protection
// without touching the compiled path at all. verify:compiled is the proof this constant survives
// the real compiled binary unchanged.
export const RUNTIME_ENGINE_VERSION = "0.0.1";

// Task 9: what runEngine actually needs once resume/continue/fork/resumeSessionAt (or none of them)
// have been resolved — a persistence sink (or none, when persistSession:false), the prior
// conversation rebuilt into the engine's own ProviderMessage shape (empty for a fresh session), and
// the EFFECTIVE RuntimeConfig the engine should run with (sessionId overridden to the resolved
// continue/resume/fork target — see the header comment on resolveEngineSession below for why this
// lives here rather than inside engine.ts itself).
export interface ResolvedEngineSession {
  config: RuntimeConfig;
  store: SessionPersistence | undefined;
  initialMessages: ProviderMessage[];
  // Task 11 (WS-07 §9): undefined exactly when `store` is undefined (persistSession:false) — a
  // durable approval has nowhere to survive a process exit without a real session store either, so
  // the two are deliberately tied to the same condition rather than independently configurable.
  approvalStore?: DurableApprovalStore;
  // Task 12 (WS-07 §10.5): SAME tied-to-`store` condition as approvalStore immediately above — a
  // non-persistent session's fallback counters live for the life of the process only (engine.ts
  // falls back to an in-memory AutoCounterStore when this is undefined).
  autoStateStore?: AutoCounterStore;
}

// Task 8: wraps a TranscriptWriter with the ONE extra SessionPersistence method engine.ts's
// canUseTool wiring needs — recordPermissionUpdate — as a thin delegator rather than a
// TranscriptWriter constructor field/subclass: the journal's own location primitives (winterHome/
// projectKey/sessionId) are exactly this module's own already-resolved values at the ONE place
// (buildWriter, below) that constructs a writer, so there is nothing to gain from threading
// `winterHome` further into TranscriptWriterOptions itself, and every existing direct
// TranscriptWriter fixture (dialect.test.ts) stays unaffected — it never gains a journal capability
// (nor needs one) unless it goes through buildWriter/resolveEngineSession.
function withPermissionJournal(writer: TranscriptWriter, location: { winterHome: string; projectKey: string; sessionId: string }): SessionPersistence {
  return {
    recordUserEntry: (content) => writer.recordUserEntry(content),
    recordAssistantEntry: (content) => writer.recordAssistantEntry(content),
    // Phase 5 Task 3 (R5-4): forwarded, like every other write method -- this wrapper adds the
    // permission/hook journals and delegates everything else. It is an EXPLICIT forward rather than
    // a spread of `writer` because the wrapper is a fresh object literal, so a method the writer
    // grows and this list forgets simply vanishes at the seam, silently: the engine's own call site
    // is `store?.recordCompactBoundary !== undefined`, which would read "no store support" and skip
    // persisting every compaction with no error anywhere.
    recordCompactBoundary: (record) => writer.recordCompactBoundary(record),
    flush: () => writer.flush(),
    // Synchronous, matching appendPermissionJournal's own synchronous fs calls (openSync et al.,
    // ruleset.ts) — SessionPersistence's own `void | Promise<void>` return type accepts either, and
    // engine.ts's caller awaits unconditionally regardless (a no-op await on a non-promise).
    recordPermissionUpdate(update: PermissionUpdate, authority: RuleSource): void {
      appendPermissionJournal(location, update, { authority });
    },
    // Task 10 (WS-08 §9 Amended / P2-A): same journal file, sibling envelope kind — see
    // appendHookAuditJournal's own header (ruleset.ts) for the full rationale. `entry` arrives here
    // typed as engine.ts's own (richer) HookAuditRecord; HookAuditJournalRecord's wider field types
    // (plain `string` where runner.ts's own type has a literal union) accept it with no cast needed.
    recordHookAudit(entry: HookAuditJournalRecord): void {
      appendHookAuditJournal(location, entry);
    },
  };
}

function buildWriter(opts: {
  store: SessionStore;
  projectKey: string;
  sessionId: string;
  cwd: string;
  initialParentUuid: string | null;
  winterHome: string;
  // Phase 5 Task 3 (R5-4): the resumed chain's own conversational uuids -- see
  // TranscriptWriterOptions.initialConversationalUuids. Omitted for a fresh session.
  initialConversationalUuids?: readonly string[];
}): SessionPersistence {
  const writer = new TranscriptWriter({
    store: opts.store,
    key: { projectKey: opts.projectKey, sessionId: opts.sessionId },
    ctx: { sessionId: opts.sessionId, cwd: opts.cwd, version: RUNTIME_ENGINE_VERSION, projectDirName: opts.projectKey },
    initialParentUuid: opts.initialParentUuid,
    ...(opts.initialConversationalUuids !== undefined ? { initialConversationalUuids: opts.initialConversationalUuids } : {}),
  });
  return withPermissionJournal(writer, { winterHome: opts.winterHome, projectKey: opts.projectKey, sessionId: opts.sessionId });
}

// --- Phase 4 Task 3 (WS-05 §4/§5.2/§5.3, WS-10 §7): child (subagent) transcripts ------------------
//
// Layout, verbatim from WS-05 §4: `~/.winter/projects/<projectKey>/<backend-session-uuid>/
// subagents/agent-<agent-id>.jsonl` (+ `.meta.json`) -- the store's own SessionKey.subpath field
// (session-store.ts) is exactly this nested path, relative to the OWNING (parent) session's own
// key. `sessionId` on every entry stays the PARENT's own session id (a child transcript is "part
// of" its owning session -- WS-10 §7's own ChildSessionRecord.parentSessionId is a separate,
// out-of-band identity a caller already holds, not something re-derived from a transcript entry).

export function childTranscriptSubpath(agentId: string): string {
  return `subagents/agent-${agentId}`;
}

export interface ChildTranscriptWriterOptions {
  store: SessionStore;
  projectKey: string;
  parentSessionId: string;
  agentId: string;
  parentToolUseId: string;
  cwd: string;
}

// A child's own writer -- independent chain (always starts fresh, never resumed at construction;
// see TranscriptWriter's own constructor comment), every entry stamped `isSidechain: true` +
// `agentId`/`parent_tool_use_id`. Deliberately NO permission-journal wrapping (unlike buildWriter's
// own withPermissionJournal below) -- a child's own permission-decision durability is P4/Lane C's
// scope, not this store-plumbing MUST's.
export function buildChildTranscriptWriter(opts: ChildTranscriptWriterOptions): TranscriptWriter {
  return new TranscriptWriter({
    store: opts.store,
    key: { projectKey: opts.projectKey, sessionId: opts.parentSessionId, subpath: childTranscriptSubpath(opts.agentId) },
    ctx: { sessionId: opts.parentSessionId, cwd: opts.cwd, version: RUNTIME_ENGINE_VERSION, projectDirName: opts.projectKey },
    sidechain: { agentId: opts.agentId, parentToolUseId: opts.parentToolUseId },
  });
}

const CHILD_SUBKEY_PATTERN = /^subagents\/agent-(.+)$/;

// WS-05 §6/WS-10 §7 ("roster rebuild from durable storage"): enumerates a session's own children by
// their bare agentId (never the raw "subagents/agent-<id>" subkey string). `listSubkeys` is
// OPTIONAL on the exported `SessionStore` type (WS-03 §10 pins exactly six members, four required)
// -- a store without it simply has no children to report, rather than throwing. Any subkey this
// pattern doesn't recognize (a future, differently-shaped subpath -- e.g. `tool-results/*`, WS-05
// §4's own sibling directory) is silently excluded, never mistaken for a child id.
export async function listChildAgentIds(store: SessionStore, key: { projectKey: string; sessionId: string }): Promise<string[]> {
  const subkeys = (await store.listSubkeys?.(key)) ?? [];
  const ids: string[] = [];
  for (const subkey of subkeys) {
    const match = CHILD_SUBKEY_PATTERN.exec(subkey);
    if (match) ids.push(match[1]!);
  }
  return ids;
}

// Ruling from task-8's brief: "wire store when persistSession !== false", shared by both main.ts
// (real production entrypoint) and testing.ts (inMemoryProcess) so the ON-by-default decision lives
// in exactly one place. `resolveWinterHome` is a THUNK, not an eagerly-resolved string: it is
// called ONLY when persistence is actually active, so a caller that wants to guarantee "never touch
// the real environment unless a session actually persists" (testing.ts) can defer even constructing
// a fallback temp directory until it's known to be needed.
//
// Task 9 (WS-05 §7) extends this into the full continue/resume/fork/resumeSessionAt resolution —
// renamed from createTranscriptPersistence because it now does much more than construct a
// persistence sink. It replaces createTranscriptPersistence's exact two call sites (main.ts,
// testing.ts) rather than adding a third: engine.ts CANNOT do this resolution itself without
// importing this module, which would be circular (dialect.ts already imports types FROM engine.ts)
// — so the caller resolves the whole session BEFORE runEngine starts, and hands it an already-
// rebuilt `initialMessages` seed plus a `config` whose `sessionId` already reflects the resolved
// target (engine.ts's own init-frame/persistence code needs zero changes beyond that seam: it
// already writes `config.sessionId` verbatim into the init frame and the TranscriptWriter key).
//
// `env` is required (not defaulted to `process.env` internally) so every caller states explicitly
// which environment governs WINTER_PROJECT_DIR_NAME resolution — main.ts passes the real
// `process.env` (its own deliberate, documented policy); testing.ts passes its own `env` parameter
// (or `{}` when omitted), mirroring resolveInMemoryWinterHome's existing "never silently fall
// through to the real process.env" discipline.
export async function resolveEngineSession(opts: {
  config: RuntimeConfig;
  resolveWinterHome: () => string;
  env: Record<string, string | undefined>;
}): Promise<ResolvedEngineSession> {
  const { config } = opts;
  if (config.persistSession === false) {
    // WS-05 §7: "Non-persistent sessions ... are excluded from every resume surface." No store to
    // search or write — continue/resume/forkSession/resumeSessionAt are silently inert, exactly as
    // they would be if never set; never an error (sessionStore-style combination validation is
    // explicitly deferred to a later task, per this task's brief).
    return { config, store: undefined, initialMessages: [] };
  }

  const winterHome = opts.resolveWinterHome();
  const store = new WinterCompatibilitySessionStore({ winterHome });
  const defaultProjectKey = compatibilityKeys(config.cwd).transcriptProjectKey;
  // Ruling P1-N (1): resolve the persistent projectKey (WINTER_PROJECT_DIR_NAME override applied,
  // if any) up front — every branch below (fresh session AND continue's single-directory scope)
  // uses this SAME resolved value, never the raw default.
  const cwdKey = resolveProjectDirName(defaultProjectKey, opts.env);

  const wantsContinue = config.continue === true;
  const wantsResume = config.resume !== undefined;

  // Task 11 fix round 1 (apparent-safety-is-accident-not-policy note, per this project's own
  // vocabulary for exactly this shape of finding — see e.g. the CEF 30fps-cap investigation):
  // constructing an approvalStore HERE, for a sessionId this branch treats as brand-new, is safe
  // in effect ONLY because `initialMessages: []` below means engine.ts's own resume-consumption
  // scan (runEngine, before the turn loop) has nothing to match ANY record against — it looks for
  // a tool_result whose tool_use_id equals a pending/allowed record's own toolUseID, and an empty
  // history can never contain one. That is an ACCIDENT of this branch never rebuilding history, not
  // a deliberate collision guard: dialect.ts's own pre-existing Ruling P1-S comment (above,
  // `resolveEngineSession`'s eager-lease-claim paragraph) already documents the one acknowledged
  // gap this shares — a CALLER-PRE-ALLOCATED `config.sessionId` that happens to COLLIDE with an
  // existing, already-deferred session reaches this "fresh" path unchanged (continue/resume are
  // both false, so it is never resolved as a resume at all), and this branch would then construct
  // an approvalStore pointed at that COLLIDING session's real approvals file. Today, nothing bad
  // happens: any pending/allowed record already there is simply never touched, because there is no
  // history to substitute into. If a FUTURE change ever made this branch populate `initialMessages`
  // for any reason, this accidental protection disappears and the collision becomes a live
  // executable path with no deliberate guard behind it at all. Not fixed here (out of this fix
  // round's scope — the real fix is presumably at session-identity allocation, not here); flagged
  // so the accident is never mistaken for a policy.
  if (!wantsContinue && !wantsResume) {
    const writer = buildWriter({ store, projectKey: cwdKey, sessionId: config.sessionId, cwd: config.cwd, initialParentUuid: null, winterHome });
    return {
      config,
      store: writer,
      initialMessages: [],
      approvalStore: createFileDurableApprovalStore({ winterHome, projectKey: cwdKey, sessionId: config.sessionId }),
      autoStateStore: createFileAutoCounterStore({ winterHome, projectKey: cwdKey, sessionId: config.sessionId }),
    };
  }

  let targetSessionId: string;
  let targetProjectKey: string;

  if (wantsContinue) {
    const found = await findContinueTarget(store, cwdKey);
    if (found === null) {
      // WS-05 §7 doesn't specify behavior for "continue with nothing to continue" — starting a
      // fresh session under the same resolved project key is the least-surprising fallback (never
      // silently picks an unrelated session, never blocks the run on a typed error for what is, in
      // effect, just an empty project). Same accidental-not-deliberate collision safety as the
      // `!wantsContinue && !wantsResume` branch above — see that branch's own comment.
      const writer = buildWriter({ store, projectKey: cwdKey, sessionId: config.sessionId, cwd: config.cwd, initialParentUuid: null, winterHome });
      return {
        config,
        store: writer,
        initialMessages: [],
        approvalStore: createFileDurableApprovalStore({ winterHome, projectKey: cwdKey, sessionId: config.sessionId }),
        autoStateStore: createFileAutoCounterStore({ winterHome, projectKey: cwdKey, sessionId: config.sessionId }),
      };
    }
    targetSessionId = found;
    targetProjectKey = cwdKey; // continue is single-project by construction (WS-05 §7) — no search needed
  } else {
    targetSessionId = config.resume as string; // wantsResume guarantees this
    const found = await findResumeTarget(store, { sessionId: targetSessionId, cwdKey });
    targetProjectKey = found.projectKey;
  }

  if (config.forkSession === true) {
    // "forkSession on resume creates the fork FIRST then resumes the new uuid" (task brief) — the
    // fork lives alongside its source, in the SAME project directory (targetProjectKey unchanged).
    // forkSessionByKey only ever READS `src` (store.load) and appends to the brand-new forked uuid
    // — it never writes to the pre-fork target, so forking a snapshot of a session another live
    // process is still actively using is legitimate and must stay legal; the eager lease claim
    // below runs AFTER this block, against whichever identity (original or forked) is the ACTUAL
    // target from here on, so a fork never needs (and never takes) the pre-fork session's lease.
    const forked = await forkSessionByKey(store, { projectKey: targetProjectKey, sessionId: targetSessionId });
    targetSessionId = forked.sessionId;
  }

  // Whole-branch review Important 1 / Ruling P1-S: claim the writer lease for the resolved target
  // EAGERLY, here — before readBack/rebuild/init — never implicitly on the FIRST append deep inside
  // runEngine's turn loop. Without this, resuming/continuing into a session another LIVE process
  // already holds would sail straight through this function, emit a normal-looking init frame, run
  // the whole turn... and persist NOTHING: engine.ts's own "store failures are auxiliary, never
  // turn-fatal" posture (WS-03 §11) SWALLOWS the WinterStoreLeaseError its first recordUserEntry
  // would hit, so the run looks entirely successful on the wire while silently discarding
  // everything it thought it was recording. Failing HERE instead means main.ts's/testing.ts's own
  // pre-runEngine try/catch reports it BEFORE the init frame is ever written (WS-04 §6.1's "exited
  // before init"), exactly like an ambiguous/not-found resume target already does.
  //
  // Ordering matters beyond "as early as possible": acquiring the lease (which STEALS it from a
  // genuinely dead holder, per leases.ts's own stale-steal rule) strictly BEFORE readBack below is
  // what makes "repair deferred to the owner" in session-store.ts's load() fall out for free — by
  // the time readBack's load() runs, either this call already threw (a live foreign pid still holds
  // it, so load() would have deferred anyway), or this process is now the lock's own recorded pid,
  // so load() repairs a torn tail as the legitimate new owner rather than a racing bystander.
  //
  // Same-pid re-entry (T7's rule, leases.ts's acquireLease): the common case — nothing else holds
  // this lease, or this SAME process already does (e.g. an earlier turn in this same run) —
  // succeeds silently and cheaply; every existing resume/continue/fork test in this suite already
  // exercises exactly that path (create then resume, same test process throughout), so a regression
  // here would have broken all of them, not just a dedicated new test.
  //
  // Deliberately NOT extended to the fresh-session branches above (the early `!wantsContinue &&
  // !wantsResume` return, and `wantsContinue`'s own found-nothing fallback): both mint a BRAND NEW
  // sessionId with no pre-existing lease to contend for, so an eager acquire there would only add a
  // disk side effect (creating the project directory + an uncontended lock file) to every fresh run
  // for no safety benefit. One acknowledged residual gap this leaves (WS-03 §11 territory, not
  // fixed here): a CALLER-PRE-ALLOCATED sessionId (Options.sessionId) that happens to collide with
  // an existing, currently-live-owned session still reaches the silently-unpersisted state via this
  // fresh path, since it is never resolved as a "resume" at all.
  try {
    await store.acquireSessionLease({ projectKey: targetProjectKey, sessionId: targetSessionId });
  } catch (err) {
    if (err instanceof WinterStoreLeaseError) {
      throw new ResumeTargetError(
        "locked",
        `session ${targetSessionId} is in use by another live process (pid ${err.heldByPid}); refusing to resume it concurrently`,
      );
    }
    throw err;
  }

  const rawEntries = await TranscriptWriter.readBack(store, { projectKey: targetProjectKey, sessionId: targetSessionId });
  let chainEntries = toDialectEntries(rawEntries);
  if (config.resumeSessionAt !== undefined) {
    // Ruling P1-R: truncateAt now returns atUuid's own ANCESTRY (root..atUuid), not a positional
    // prefix — its last element is always atUuid itself, so `lastEntry` below correctly continues
    // the chain from atUuid regardless of where atUuid sat in the raw, untruncated file order.
    chainEntries = truncateAt(chainEntries, { atUuid: config.resumeSessionAt, dropsTurn: config.resumeDropsTurn ?? false });
  }

  // Ruling P1-Q: rebuildProviderMessages does its OWN internal ancestry walk (anchored at
  // chainEntries' last element) to exclude an abandoned tail from a PLAIN resume's provider
  // context — but `lastEntry` here intentionally stays the raw last-in-array element (never
  // ancestry-filtered itself): for chain CONTINUATION, the next appended entry must always link to
  // the actual physical tail of what was loaded (the true current tip), which for the untruncated
  // case is exactly this same last array element rebuildProviderMessages independently re-derives
  // as its own leaf — the two never disagree, since both read the identical input array's last
  // position.
  const initialMessages = rebuildProviderMessages(chainEntries);
  const lastEntry = chainEntries.length > 0 ? chainEntries[chainEntries.length - 1] : undefined;
  const initialParentUuid = lastEntry !== undefined ? lastEntry.uuid : null;

  // Ruling P1-N (3): continued writes target targetProjectKey — the value the search ABOVE
  // actually discovered the session under — never a second, independently fresh-resolved key. This
  // is what "prefer the recorded value over a fresh env resolution" buys concretely: even though
  // `cwdKey` was computed from THIS run's current environment, a resumed session already living
  // under a different (possibly now-stale) resolved name keeps writing there.
  // Phase 5 Task 3 (R5-4): a compaction on a RESUMED session must be able to name preserved entries
  // that predate this run, so the writer inherits the resumed chain's own conversational uuids.
  // Every entry kind that `rebuildProviderMessages` turns into a provider message is included, and
  // in the same order, so "the last N conversational entries" means the same thing on both sides.
  const initialConversationalUuids = chainEntries.filter((e) => e.message !== undefined && (e.type === "user" || e.type === "assistant" || e.type === "compact_summary")).map((e) => e.uuid);
  const writer = buildWriter({ store, projectKey: targetProjectKey, sessionId: targetSessionId, cwd: config.cwd, initialParentUuid, winterHome, initialConversationalUuids });
  const effectiveConfig: RuntimeConfig = { ...config, sessionId: targetSessionId };
  // Task 11 (WS-07 §9): the SAME (winterHome, targetProjectKey, targetSessionId) triple the writer
  // above just used — a deferred call from an EARLIER run of this exact session has its approvals
  // file right there, store-adjacent; engine.ts's own resume-consumption step (runEngine, before the
  // turn loop) is what actually reads it back and folds a resolution into `initialMessages`.
  const approvalStore = createFileDurableApprovalStore({ winterHome, projectKey: targetProjectKey, sessionId: targetSessionId });
  const autoStateStore = createFileAutoCounterStore({ winterHome, projectKey: targetProjectKey, sessionId: targetSessionId });
  return { config: effectiveConfig, store: writer, initialMessages, approvalStore, autoStateStore };
}

// main.ts's own production policy: config.winterHome (an explicit per-run override — RuntimeConfig
// already carries this field, wired for Task 9's resume machinery, but any caller may set it) wins;
// otherwise the real environment's WINTER_HOME (or ~/.winter) via resolveWinterHome, imported here
// so main.ts doesn't need its own separate import of it just for this one call.
export function resolveProductionWinterHome(config: RuntimeConfig, env: Record<string, string | undefined>): string {
  return config.winterHome ?? resolveWinterHome(env);
}

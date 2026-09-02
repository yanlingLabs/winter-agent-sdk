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
import { resolveProjectDirName } from "../paths/project-dir-name.ts";
import { findContinueTarget, findResumeTarget, truncateAt, toDialectEntries, rebuildProviderMessages, ResumeTargetError } from "./resume.ts";
// Task 8 (WS-07 §3.3 / phase ruling 2): the permission journal — ruleset.ts's own header names this
// task ("T8's canUseTool wiring") as its first real caller with something to journal.
// Task 10 (WS-08 §9 Amended / P2-A): the SAME journal file also carries hook audit records — see
// appendHookAuditJournal's own header (ruleset.ts) for why this reuses one file rather than a
// second sidecar.
import { appendPermissionJournal, appendHookAuditJournal, type HookAuditJournalRecord } from "../permissions/ruleset.ts";

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

// The brief's literal opts shape is `{ text: string; chain; ctx }`, but its own prose requires tool
// results to route through userEntry as content BLOCKS ("tool results → userEntry with tool_result
// blocks") — blocks are never a plain string. Read as a deliberate union: userEntry accepts EITHER
// a plain `text` string OR pre-built `content` blocks, both producing the same `string | Block[]`
// message.content the brief's own return type already declares.
export type UserEntryOpts = { chain: Chain; ctx: SessionCtx } & ({ text: string } | { content: Block[] });

export function userEntry(
  opts: UserEntryOpts,
): DialectEntryBase & { type: "user"; message: { role: "user"; content: string | Block[] } } {
  const content: string | Block[] = "text" in opts ? opts.text : opts.content;
  return {
    type: "user",
    ...baseFields(opts.ctx, opts.chain),
    message: { role: "user", content },
  };
}

export function assistantEntry(opts: {
  content: Block[];
  chain: Chain;
  ctx: SessionCtx;
}): DialectEntryBase & { type: "assistant"; message: { role: "assistant"; content: Block[] } } {
  return {
    type: "assistant",
    ...baseFields(opts.ctx, opts.chain),
    message: { role: "assistant", content: opts.content },
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
  private parentUuid: string | null;

  constructor(opts: TranscriptWriterOptions) {
    this.store = opts.store;
    this.key = opts.key;
    this.ctx = opts.ctx;
    // Task 9: a resumed/continued/forked session seeds this with the target's last entry's uuid so
    // the very next append continues the SAME chain; every pre-Task-9 caller (and every fresh
    // session) omits it, preserving the original "every writer starts fresh" behavior exactly.
    this.parentUuid = opts.initialParentUuid ?? null;
  }

  async recordUserEntry(content: string | Block[]): Promise<void> {
    const chain: Chain = { parentUuid: this.parentUuid };
    const entry = typeof content === "string" ? userEntry({ text: content, chain, ctx: this.ctx }) : userEntry({ content, chain, ctx: this.ctx });
    await this.appendWithDialectRecord(entry);
    this.parentUuid = entry.uuid;
  }

  async recordAssistantEntry(content: Block[]): Promise<void> {
    const chain: Chain = { parentUuid: this.parentUuid };
    const entry = assistantEntry({ content, chain, ctx: this.ctx });
    await this.appendWithDialectRecord(entry);
    this.parentUuid = entry.uuid;
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
}): SessionPersistence {
  const writer = new TranscriptWriter({
    store: opts.store,
    key: { projectKey: opts.projectKey, sessionId: opts.sessionId },
    ctx: { sessionId: opts.sessionId, cwd: opts.cwd, version: RUNTIME_ENGINE_VERSION, projectDirName: opts.projectKey },
    initialParentUuid: opts.initialParentUuid,
  });
  return withPermissionJournal(writer, { winterHome: opts.winterHome, projectKey: opts.projectKey, sessionId: opts.sessionId });
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

  if (!wantsContinue && !wantsResume) {
    const writer = buildWriter({ store, projectKey: cwdKey, sessionId: config.sessionId, cwd: config.cwd, initialParentUuid: null, winterHome });
    return { config, store: writer, initialMessages: [] };
  }

  let targetSessionId: string;
  let targetProjectKey: string;

  if (wantsContinue) {
    const found = await findContinueTarget(store, cwdKey);
    if (found === null) {
      // WS-05 §7 doesn't specify behavior for "continue with nothing to continue" — starting a
      // fresh session under the same resolved project key is the least-surprising fallback (never
      // silently picks an unrelated session, never blocks the run on a typed error for what is, in
      // effect, just an empty project).
      const writer = buildWriter({ store, projectKey: cwdKey, sessionId: config.sessionId, cwd: config.cwd, initialParentUuid: null, winterHome });
      return { config, store: writer, initialMessages: [] };
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
  const writer = buildWriter({ store, projectKey: targetProjectKey, sessionId: targetSessionId, cwd: config.cwd, initialParentUuid, winterHome });
  const effectiveConfig: RuntimeConfig = { ...config, sessionId: targetSessionId };
  return { config: effectiveConfig, store: writer, initialMessages };
}

// main.ts's own production policy: config.winterHome (an explicit per-run override — RuntimeConfig
// already carries this field, wired for Task 9's resume machinery, but any caller may set it) wins;
// otherwise the real environment's WINTER_HOME (or ~/.winter) via resolveWinterHome, imported here
// so main.ts doesn't need its own separate import of it just for this one call.
export function resolveProductionWinterHome(config: RuntimeConfig, env: Record<string, string | undefined>): string {
  return config.winterHome ?? resolveWinterHome(env);
}

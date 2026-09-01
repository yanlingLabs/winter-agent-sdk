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
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import type { ContentBlock, SessionPersistence } from "../engine.ts";
import { resolveWinterHome } from "../paths/home.ts";
import { compatibilityKeys } from "../paths/keys.ts";
import {
  WinterCompatibilitySessionStore,
  DIALECT_RECORD_ENTRY_TYPE,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "./session-store.ts";

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
    this.parentUuid = null; // P1 never resumes an existing chain (Task 9) — every writer starts fresh
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

// Ruling from task-8's brief: "wire store when persistSession !== false", shared by both main.ts
// (real production entrypoint) and testing.ts (inMemoryProcess) so the ON-by-default decision lives
// in exactly one place. `resolveWinterHome` is a THUNK, not an eagerly-resolved string: it is
// called ONLY when persistence is actually active, so a caller that wants to guarantee "never touch
// the real environment unless a session actually persists" (testing.ts) can defer even constructing
// a fallback temp directory until it's known to be needed.
export function createTranscriptPersistence(opts: { config: RuntimeConfig; resolveWinterHome: () => string }): SessionPersistence | undefined {
  if (opts.config.persistSession === false) return undefined;
  const winterHome = opts.resolveWinterHome();
  const store = new WinterCompatibilitySessionStore({ winterHome });
  const projectKey = compatibilityKeys(opts.config.cwd).transcriptProjectKey;
  return new TranscriptWriter({
    store,
    key: { projectKey, sessionId: opts.config.sessionId },
    ctx: { sessionId: opts.config.sessionId, cwd: opts.config.cwd, version: RUNTIME_ENGINE_VERSION },
  });
}

// main.ts's own production policy: config.winterHome (an explicit per-run override — RuntimeConfig
// already carries this field, wired for Task 9's resume machinery, but any caller may set it) wins;
// otherwise the real environment's WINTER_HOME (or ~/.winter) via resolveWinterHome, imported here
// so main.ts doesn't need its own separate import of it just for this one call.
export function resolveProductionWinterHome(config: RuntimeConfig, env: Record<string, string | undefined>): string {
  return config.winterHome ?? resolveWinterHome(env);
}

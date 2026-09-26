// Phase 6 Task 3 (R6-7, WS-05 §13): the provider-state sidecar -- the ONLY sink for opaque provider
// continuation state.
//
// WHAT THIS FILE IS FOR, stated once so nothing here reads as bookkeeping. `encrypted_content`,
// thinking signatures, `redacted_thinking.data`, `thoughtSignature`, xAI opaque items -- none of it
// may reach a model-readable file, a log line, a frame, or an error message (Global Constraints).
// Anthropic-family thinking blocks are the one exception and they ride IN-DIALECT, in the transcript,
// because the dialect itself defines them. Everything else lands here, in a neighbour file the pinned
// runtime provably does not touch: capture (H) drove session creation, a resume, six appending turns
// and an attempted compaction against the real pinned runtime and the sidecar's sha256 was unchanged
// end to end, with its marker appearing in zero of the 24 request bodies the loopback received.
//
// THE RECORD ENVELOPE IS `SessionStoreEntry`-SHAPED (R6-7 amended, OQ-P6-7), and each of its three
// envelope fields answers a constraint derived-shapes-p6.md item (h) found in the pinned declaration:
//
//   1. `type` is REQUIRED on `SessionStoreEntry` (`sdk.d.ts:5372-5377`). A record shaped
//      `{kind: "origin", …}` with no `type` does not type-check as a store entry at all, so `kind`
//      rides ALONGSIDE a `type` rather than instead of it.
//   2. `uuid` is the store's IDEMPOTENCY KEY (`5290-5294`): adapters upsert on it. `anchorUuid` must
//      therefore never double as the record's `uuid` -- every record for one assistant entry would
//      collide into a single upserted row. Each record gets its own v4.
//   3. The SAME envelope goes in the neighbour file and through the external-store
//      `subpath: "provider-state"` door, so a host swapping stores changes the transport and nothing
//      else. `subpath` is documented as opaque to the adapter, "just a storage-key suffix"
//      (`sdk.d.ts:5203-5205`) -- a positive licence for a non-transcript key, not a silence.
import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MessageOrigin, ProviderNativeState, ReasoningBlockAt } from "@yanlinglabs/winter-provider-runtime";
import { coerceInDialectReasoningBlock, isReasoningBlockItem, isWinterBookkeepingItem, reasoningBlockItems } from "@yanlinglabs/winter-provider-runtime";
import { PROVIDER_STATE_FILE_SUFFIX } from "@yanlinglabs/winter-agent-sdk";

/** The `SessionStoreEntry.type` discriminant every record carries. One string, one place. */
export const PROVIDER_STATE_ENTRY_TYPE = "winter_provider_state" as const;

/**
 * R6-7a: the subpath a NON-filesystem `SessionStore` receives these records under.
 *
 * Resume `load()`s this key DIRECTLY and never relies on `listSubkeys` -- that method is optional on
 * the pinned `SessionStore` (`sdk.d.ts:5353-5356`) and, when a host's adapter omits it, "resume only
 * materializes the main transcript". A provider-state subpath discovered by enumeration would be
 * written and then never found, silently.
 */
export const PROVIDER_STATE_SUBPATH = "provider-state" as const;

/**
 * The filename suffix of the neighbour file, RE-EXPORTED from the sdk store.
 *
 * ONE DECLARATION (re-review round 2). The sdk's `delete()` must name this file to remove it and
 * cannot import the runtime (WS-02 §3), so the string is declared there and imported here -- the same
 * direction every other shared store constant takes. This package still owns the record SEMANTICS;
 * only the literal moved. The P4-M read deny and the sidecar path builder both read it from here, so
 * they cannot drift from what the deletion transaction actually removes.
 */
export { PROVIDER_STATE_FILE_SUFFIX };

// WS-23 (reasoning-state): `reasoning-blocks` is an Anthropic-family turn's in-dialect thinking -- each
// `thinking` / `redacted_thinking` block VERBATIM plus `at`, its index in the turn's stream-order content
// (payload `{blocks: [{at, block}]}`). It is a kind of its own rather than a `native-state` record so an
// older runtime, whose `KINDS` filter below does not list it, drops it cleanly instead of replaying it as
// some other family's opaque items. See provider-runtime's `continuity/reasoning-blocks.ts`.
//
// LAYER 2 -- CACHE QUIRKS, keyed by provider+model (the record's own `provider`/`model`):
//   - `effort`: the assistant entry's `{effort?, perTurnEffort}` -- the top-level effort its request sent
//     and the level in force for its turn, which the per-message effort markers derive from;
//   - `tool-epoch` / `tool-changes`: the tool epoch's bookkeeping (context/tool-epoch.ts) -- the payload
//     is the attachment verbatim, anchored to the assistant entry it PRECEDED (the reply to the request
//     that introduced it), and put back right before that entry on a resume.
// All three used to ride the transcript (entry fields and attachment entries); none of it is portable to
// another model, so none of it belongs in a provider-neutral transcript.
export type ProviderStateKind = "origin" | "native-state" | "summary" | "handoff" | "reasoning-blocks" | "effort" | "tool-epoch" | "tool-changes";

/**
 * One sidecar record. The envelope (`type`/`uuid`/`timestamp`) plus R6-7's own payload fields.
 *
 * `anchorUuid` names the ASSISTANT ENTRY this record belongs to -- the uuid the engine pre-allocated
 * and passed through `recordAssistantEntry(content, { uuid })`. `itemIndex` orders multiple records
 * sharing one anchor. `payload` is opaque BY TYPE: `unknown`, so nothing is tempted to inspect it.
 */
export interface ProviderStateRecord {
  // The INDEX SIGNATURE is `SessionStoreEntry`'s own (`sdk.d.ts:5372-5377`), reproduced rather than
  // inherited: a record travels through a host's external store, which the pin types as an OPEN
  // struct, so a store that round-trips an extra key must not make the record un-assignable. The
  // INPUT type below is closed instead, so nothing junk can enter from Winter's own side.
  [k: string]: unknown;
  type: typeof PROVIDER_STATE_ENTRY_TYPE;
  uuid: string;
  timestamp: string;
  sessionId: string;
  anchorUuid: string;
  provider: string;
  model: string;
  family: string;
  continuationDomain?: string;
  itemIndex: number;
  kind: ProviderStateKind;
  payload: unknown;
}

/**
 * What a CALLER supplies. The three envelope fields are stamped here when omitted, so a producer
 * cannot forget the `type` discriminant or accidentally reuse the anchor as the record uuid -- the
 * two mistakes item (h) identifies as fatal to an external store. A fully-formed `ProviderStateRecord`
 * also satisfies this type, so a caller that has one (a replay, a test fixture) passes it unchanged.
 */
export interface ProviderStateRecordInput {
  type?: typeof PROVIDER_STATE_ENTRY_TYPE;
  uuid?: string;
  timestamp?: string;
  sessionId: string;
  anchorUuid: string;
  provider: string;
  model: string;
  family: string;
  continuationDomain?: string;
  itemIndex: number;
  kind: ProviderStateKind;
  payload: unknown;
}

/** Stamps the envelope. Separated from the append so the external-store door (which never touches a file) produces byte-identical records. */
export function toProviderStateRecord(input: ProviderStateRecordInput): ProviderStateRecord {
  return {
    type: PROVIDER_STATE_ENTRY_TYPE,
    // The record's OWN v4 -- never `anchorUuid` (item (h) constraint 2).
    uuid: input.uuid ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    sessionId: input.sessionId,
    anchorUuid: input.anchorUuid,
    provider: input.provider,
    model: input.model,
    family: input.family,
    ...(input.continuationDomain !== undefined ? { continuationDomain: input.continuationDomain } : {}),
    itemIndex: input.itemIndex,
    kind: input.kind,
    payload: input.payload,
  };
}

/**
 * `<dir>/<sessionId>.provider-state.jsonl` -- the neighbour of `<dir>/<sessionId>.jsonl`.
 *
 * DERIVED FROM THE TRANSCRIPT PATH rather than rebuilt from (winterHome, projectKey, sessionId),
 * which is what makes the CHILD case fall out for free: a child transcript at
 * `<sessionId>/subagents/agent-<id>.jsonl` yields `<sessionId>/subagents/agent-<id>.provider-state.jsonl`
 * with no second path-shaping rule to keep in step. R6-7 words the child path as
 * `<sessionId>/subagents/<agentId>.provider-state.jsonl`; the real child transcript basename is
 * `agent-<agentId>` (dialect.ts's `childTranscriptSubpath`), and matching the actual neighbour is what
 * "beside the child transcript" means -- recorded as a deliberate reading of the brief, not a drift.
 */
export function providerStateSidecarPath(transcriptPath: string): string {
  const dir = dirname(transcriptPath);
  const name = basename(transcriptPath);
  const stem = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
  return join(dir, `${stem}${PROVIDER_STATE_FILE_SUFFIX}`);
}

/**
 * Appends ONE record: 0600, `O_APPEND`, one `fsync` per record.
 *
 * `fsync` per record and not per batch, deliberately: the whole point of write-ahead ordering is that
 * the record is DURABLE before its entry is appended. A batched flush would make the ordering true in
 * memory and false on disk, which is the only place it matters.
 *
 * Returns the stamped record (a deviation from the brief's `void`, recorded): the caller needs the
 * minted `uuid` to write the identical envelope through an external store, and a producer that had to
 * re-derive it would be a second minting site.
 */
export function appendProviderState(path: string, input: ProviderStateRecordInput): ProviderStateRecord {
  const record = toProviderStateRecord(input);
  // THE WRITE-AHEAD WRITER CREATES ITS OWN DIRECTORY, and that is a consequence of the ordering rather
  // than a convenience: the record is appended BEFORE the transcript's first entry, so on a fresh
  // session the project directory the store would have created does not exist yet. 0o700 matches the
  // store's own `ensureSecureDir` posture for the same tree.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 0o600: the sidecar holds provider-opaque state -- not world- or group-readable, the same
  // permission the credentials file store uses for the same class of content. O_NOFOLLOW mirrors the
  // store's write-path symlink hardening (WS-05 §13): a followed write symlink could append
  // attacker-chosen bytes into an arbitrary file this process can write to.
  // WS-23 (reasoning-state): a write that died mid-line (the crash the bounded repair below exists for)
  // leaves the file without its final newline -- and the engine now RETRIES a failed reasoning write
  // once, so the next record would otherwise be glued onto the torn fragment and lost with it. A
  // leading newline closes the fragment off as its own malformed (skipped) line.
  const closeTorn = endsMidLine(path) ? "\n" : "";
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${closeTorn}${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

/** Does the file end without its trailing newline (a torn final line)? `false` for an absent or empty file. */
function endsMidLine(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * The most record bytes one read KEEPS. A sidecar is a few small records per assistant entry, so 64 MiB
 * is orders of magnitude above any ordinary session; the bound exists because this file is read on
 * EVERY resume and a file grown without limit (a very long session, a corrupt or attacker-grown file)
 * must not be read into memory without limit.
 *
 * WS-23 (reasoning-state, defect c): a bound on what is KEPT, not a refusal of the file. The read used
 * to throw past 64 MiB, and every caller turned the throw into an EMPTY chain -- one byte over the
 * limit and a session lost the native state of every turn it had, including the ones it was about to
 * continue from. Since the move of Anthropic thinking into the sidecar that is a session's whole
 * reasoning. Now the file is streamed and, once the kept records pass the bound, the OLDEST are let go:
 * the turns nearest the current work keep their state, and the oldest degrade to summary level (which
 * `buildContinuationChain` already handles, record by record).
 */
export const PROVIDER_STATE_MAX_READ_BYTES = 64 * 1024 * 1024;

/** One line longer than this is not a record Winter wrote (a single turn's state is far smaller); it is skipped unread. */
export const PROVIDER_STATE_MAX_LINE_BYTES = 16 * 1024 * 1024;

const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Reads a sidecar with BOUNDED REPAIR: a truncated final line is dropped and every earlier record is
 * kept.
 *
 * That is the crash the write-ahead ordering makes likely -- the process died mid-`writeSync` -- and
 * refusing the whole file for it would discard a session's entire continuation chain over one partial
 * line. A malformed line ANYWHERE (not just the last) is skipped for the same reason; the chain
 * degrades record by record rather than all at once, and `buildContinuationChain` already treats a
 * missing record as "degrade this message to summary-level".
 *
 * BOUNDED MEMORY (WS-23): streamed in 1 MiB chunks, a line past `PROVIDER_STATE_MAX_LINE_BYTES` is
 * skipped without being buffered, and the kept records never exceed `PROVIDER_STATE_MAX_READ_BYTES` --
 * the oldest go first (see the constant). `limits` exists for tests.
 *
 * A missing file is an EMPTY chain, never a throw: "no sidecar" and "sidecar emptied" are
 * indistinguishable by design in the pinned store contract (`load()` may return `null` for both,
 * `sdk.d.ts:5302-5314`), so the filesystem path answers the same way its store-backed twin must.
 */
export function readProviderState(path: string, limits: { maxKeptBytes?: number; maxLineBytes?: number } = {}): ProviderStateRecord[] {
  const maxKept = limits.maxKeptBytes ?? PROVIDER_STATE_MAX_READ_BYTES;
  const maxLine = limits.maxLineBytes ?? PROVIDER_STATE_MAX_LINE_BYTES;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  const kept: Array<{ record: ProviderStateRecord; bytes: number }> = [];
  let head = 0;
  let keptBytes = 0;
  let released = 0;
  const keep = (line: Buffer): void => {
    if (line.length === 0) return;
    const record = parseProviderStateLine(line.toString("utf8"));
    if (record === undefined) return;
    kept.push({ record, bytes: line.length });
    keptBytes += line.length;
    while (keptBytes > maxKept && head < kept.length) {
      keptBytes -= kept[head]!.bytes;
      head++;
      released++;
    }
  };
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, from);
        if (nl === -1 || nl >= n) break;
        if (!skipping) keep(Buffer.concat([...pending, chunk.subarray(from, nl)]));
        pending = [];
        pendingBytes = 0;
        skipping = false;
        from = nl + 1;
      }
      if (from < n && !skipping) {
        pendingBytes += n - from;
        if (pendingBytes > maxLine) {
          // An oversized line: dropped whole, without buffering the rest of it.
          skipping = true;
          pending = [];
          pendingBytes = 0;
        } else pending.push(Buffer.from(chunk.subarray(from, n)));
      }
    }
    // A final line with no newline is the torn write the bounded repair exists for; it parses only if
    // it happens to be whole (a record written by a pre-fsync crash of the NEXT append), else it is skipped.
    if (!skipping && pendingBytes > 0) keep(Buffer.concat(pending));
  } catch {
    // An unreadable file mid-stream: what was kept so far is still a valid (older-first) chain prefix.
  } finally {
    closeSync(fd);
  }
  if (released > 0) {
    // COUNTS ONLY -- never a payload. One line per read that had to let records go.
    console.error(`winter: provider-state sidecar ${basename(path)} holds more than ${maxKept} bytes of records; the ${released} oldest were not loaded, so their turns resume at summary level`);
  }
  return kept.slice(head).map((entry) => entry.record);
}

/**
 * One line -> one record, or `undefined`.
 *
 * VALIDATES STRUCTURALLY rather than casting: these bytes come off disk (or out of a host's own
 * `SessionStore`), and a cast would let a malformed `origin` payload surface as an incomprehensible
 * failure inside an adapter three layers away. Exported because the external-store door validates the
 * identical way -- one parser, two transports.
 */
export function parseProviderStateLine(line: string): ProviderStateRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined; // a truncated final line, or a corrupt one -- skipped, never fatal
  }
  return coerceProviderStateRecord(value);
}

const KINDS: ReadonlySet<string> = new Set<ProviderStateKind>(["origin", "native-state", "summary", "handoff", "reasoning-blocks", "effort", "tool-epoch", "tool-changes"]);

export function coerceProviderStateRecord(value: unknown): ProviderStateRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.type !== PROVIDER_STATE_ENTRY_TYPE) return undefined;
  if (typeof v.uuid !== "string" || typeof v.timestamp !== "string") return undefined;
  if (typeof v.sessionId !== "string" || typeof v.anchorUuid !== "string") return undefined;
  if (typeof v.provider !== "string" || typeof v.model !== "string" || typeof v.family !== "string") return undefined;
  if (typeof v.itemIndex !== "number" || typeof v.kind !== "string" || !KINDS.has(v.kind)) return undefined;
  return {
    type: PROVIDER_STATE_ENTRY_TYPE,
    uuid: v.uuid,
    timestamp: v.timestamp,
    sessionId: v.sessionId,
    anchorUuid: v.anchorUuid,
    provider: v.provider,
    model: v.model,
    family: v.family,
    ...(typeof v.continuationDomain === "string" ? { continuationDomain: v.continuationDomain } : {}),
    itemIndex: v.itemIndex,
    kind: v.kind as ProviderStateKind,
    payload: v.payload,
  };
}

// P6 fix wave: `copyProviderStateForFork` is GONE from here. The fork's chain is carried by the sdk
// store's own `WinterCompatibilitySessionStore.copyProviderStateForFork` (a generic line rewrite:
// fresh record `uuid`, re-owned `sessionId`, `anchorUuid` untouched), called by `forkSessionByKey`
// for BOTH fork doors -- the runtime's `resume + forkSession` path and the public `forkSession()`,
// which T3's re-review found chain-less. One primitive, one implementation; the codec here keeps the
// record SEMANTICS and the read side.

/** What one assistant entry's records fold into. `origin` is mandatory in a healthy chain; its ABSENCE is what degrades that message to summary-level. */
export interface ContinuationLink {
  origin?: MessageOrigin;
  nativeState?: ProviderNativeState;
  summary?: string;
  // Phase 10b Lane S, S4 (W18-15): which of two things `summary` actually is. Absent means a
  // provider-authored SUMMARY (the historical, only shape); `"exposed"` means the text is an open
  // model's own RAW reasoning, recorded verbatim because the family produces no summary of its own
  // (`engine.ts`'s `turnProvenance`) -- and `complete` says whether the WHOLE trace survived (a
  // normal stop, no dropped delta) or only a partial one. Never both a provider summary AND exposed
  // material on the same record: `turnProvenance` writes one payload per anchor, `summary` wins when
  // both are present on the turn.
  material?: "exposed";
  complete?: boolean;
  /** WS-23: when the `origin` record was written -- the time the reply landed, which the tool epoch's cache-TTL rule reads. */
  recordedAt?: string;
  /** WS-23 (layer 2): the entry's effort annotations, from an `effort` record. */
  effort?: { effort?: string; perTurnEffort?: string };
  /** WS-23 (layer 2): the tool-epoch bookkeeping that PRECEDED this entry, in write order (attachment payloads). */
  bookkeeping?: Array<{ type: string; [key: string]: unknown }>;
}

/**
 * Folds the records into a per-entry chain, keyed by `anchorUuid`.
 *
 * A RECORD WHOSE ANCHOR IS MISSING IS IGNORED, not an error: the write-ahead ordering makes exactly
 * that pair the likely crash (the record was fsync'd, the process died before its entry appended), so
 * it is garbage-collectable state rather than corruption. The OTHER crash pair -- an entry with no
 * record -- is not visible here at all: it shows up as an anchor the returned map has no key for, and
 * the caller degrades that message to summary-level and warns. Both halves are asserted in
 * provider-state.test.ts's crash-pair fixture.
 *
 * Records are folded in ARRAY ORDER (which is append order), so a later record of the same kind for
 * the same anchor wins -- a re-recorded `native-state` supersedes the one before it.
 */
export function buildContinuationChain(records: readonly ProviderStateRecord[], entryUuids: ReadonlySet<string>): Map<string, ContinuationLink> {
  const chain = new Map<string, ContinuationLink>();
  for (const record of records) {
    if (!entryUuids.has(record.anchorUuid)) continue;
    const link = chain.get(record.anchorUuid) ?? {};
    switch (record.kind) {
      case "origin":
        link.recordedAt = record.timestamp;
        link.origin = {
          providerId: record.provider,
          modelKey: record.model,
          family: record.family,
          ...(record.continuationDomain !== undefined ? { continuationDomain: record.continuationDomain } : {}),
        };
        break;
      case "native-state": {
        // WS-23: plus Winter's own bookkeeping items (a Responses output layout), stored apart under
        // `payload.winter` so an older runtime never replays one -- see engine.ts's `recordAssistant`.
        const vendorItems = readNativeItems(record.payload);
        const items = vendorItems !== undefined ? [...vendorItems, ...readWinterItems(record.payload)] : undefined;
        if (items !== undefined) {
          link.nativeState = {
            family: record.family,
            // A native-state record without a domain belongs to a row that certifies no shared domain
            // (R6-9 binds exact replay to a continuation DOMAIN, not to a family), so its state is valid
            // for the model that produced it and nothing else: the model key IS its domain.
            // WS-23 (defect e): this used to be the FAMILY string, which put xAI and OpenAI state in the
            // same pseudo-domain (`"openai"`) and made every count of "state that will not replay" wrong.
            continuationDomain: record.continuationDomain ?? record.model,
            // WS-23: a later `native-state` record supersedes the earlier one's items, never the
            // anchor's sidecar-carried reasoning blocks (a separate record kind, whatever the order).
            items: [...items, ...(link.nativeState?.items.filter(isReasoningBlockItem) ?? [])],
          };
        }
        break;
      }
      case "reasoning-blocks": {
        // Folded into `nativeState` as TAGGED items, after any items a `native-state` record carried, so
        // the renderer's one keep-or-drop rule covers them and only the Anthropic adapter's splice reads
        // them back. The domain is the record's own, exactly as for `native-state`.
        const blocks = readReasoningBlocks(record.payload);
        if (blocks !== undefined && blocks.length > 0) {
          const items = reasoningBlockItems(blocks);
          link.nativeState = {
            family: record.family,
            continuationDomain: link.nativeState?.continuationDomain ?? record.continuationDomain ?? record.model,
            items: [...(link.nativeState?.items.filter((item) => !isReasoningBlockItem(item)) ?? []), ...items],
          };
        }
        break;
      }
      case "summary": {
        const text = readSummaryText(record.payload);
        if (text !== undefined) link.summary = text;
        const material = readSummaryMaterial(record.payload);
        if (material !== undefined) link.material = material;
        const complete = readSummaryComplete(record.payload);
        if (complete !== undefined) link.complete = complete;
        break;
      }
      case "effort": {
        const effort = readEffort(record.payload);
        if (effort !== undefined) link.effort = effort;
        break;
      }
      case "tool-epoch":
      case "tool-changes": {
        const payload = record.payload;
        const expected = record.kind === "tool-epoch" ? "tool_epoch" : "tool_changes";
        if (typeof payload === "object" && payload !== null && !Array.isArray(payload) && (payload as { type?: unknown }).type === expected) {
          (link.bookkeeping ??= []).push(payload as { type: string; [key: string]: unknown });
        }
        break;
      }
      case "handoff":
        // Lane C's portable handoff. Carried in the sidecar and read by the renderer, never folded
        // into a link the engine itself acts on -- this switch is exhaustive so a new kind cannot be
        // silently ignored, and this arm records that the omission is deliberate.
        break;
    }
    chain.set(record.anchorUuid, link);
  }
  return chain;
}

/** The ledger's pinned alias: every lane types its renderer against `ReturnType<typeof buildContinuationChain>`, so the chain's shape has exactly one definition. */
export type ContinuationChain = ReturnType<typeof buildContinuationChain>;

function readNativeItems(payload: unknown): unknown[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items : undefined;
}

/** WS-23: a `reasoning-blocks` payload's `{at, block}` list, each entry checked structurally; `undefined` for a malformed payload. */
function readReasoningBlocks(payload: unknown): ReasoningBlockAt[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const blocks = (payload as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return undefined;
  const out: ReasoningBlockAt[] = [];
  for (const entry of blocks) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const at = (entry as { at?: unknown }).at;
    const block = coerceInDialectReasoningBlock((entry as { block?: unknown }).block);
    if (typeof at !== "number" || !Number.isInteger(at) || at < 0 || block === undefined) return undefined;
    out.push({ at, block });
  }
  return out;
}

/** WS-23: an `effort` payload -- `effort` and `perTurnEffort` strings, either optional, at least one present. */
function readEffort(payload: unknown): { effort?: string; perTurnEffort?: string } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { effort, perTurnEffort } = payload as { effort?: unknown; perTurnEffort?: unknown };
  const out = { ...(typeof effort === "string" ? { effort } : {}), ...(typeof perTurnEffort === "string" ? { perTurnEffort } : {}) };
  return Object.keys(out).length > 0 ? out : undefined;
}

function readWinterItems(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null) return [];
  const winter = (payload as { winter?: unknown }).winter;
  return Array.isArray(winter) ? winter.filter(isWinterBookkeepingItem) : [];
}

function readSummaryText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

/** W18-15: `material` is `"exposed"` or absent -- any other value is unknown-provenance and read as absent, never guessed at. */
function readSummaryMaterial(payload: unknown): "exposed" | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const material = (payload as { material?: unknown }).material;
  return material === "exposed" ? "exposed" : undefined;
}

/** W18-15: `complete` -- whether the recorded exposed reasoning is the WHOLE trace. */
function readSummaryComplete(payload: unknown): boolean | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const complete = (payload as { complete?: unknown }).complete;
  return typeof complete === "boolean" ? complete : undefined;
}

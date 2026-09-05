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
import { closeSync, constants as fsConstants, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MessageOrigin, ProviderNativeState } from "@yanlinglabs/winter-provider-runtime";
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

export type ProviderStateKind = "origin" | "native-state" | "summary" | "handoff";

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
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return record;
}

/**
 * The sidecar's own size ceiling for a single read. A sidecar is one small record per assistant entry,
 * so 64 MiB is orders of magnitude above any real session; the bound exists because a resume that
 * reads an attacker-grown (or simply corrupt) file into memory unbounded is a denial of service with
 * no upper limit, and this file is read on EVERY resume.
 */
export const PROVIDER_STATE_MAX_READ_BYTES = 64 * 1024 * 1024;

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
 * A missing file is an EMPTY chain, never a throw: "no sidecar" and "sidecar emptied" are
 * indistinguishable by design in the pinned store contract (`load()` may return `null` for both,
 * `sdk.d.ts:5302-5314`), so the filesystem path answers the same way its store-backed twin must.
 */
export function readProviderState(path: string): ProviderStateRecord[] {
  let raw: string;
  try {
    const size = statSync(path).size;
    if (size > PROVIDER_STATE_MAX_READ_BYTES) {
      // Refuse rather than truncate: a partial read of a JSONL chain would silently produce a
      // DIFFERENT chain, and a wrong chain is worse than an absent one (an absent one degrades
      // loudly, through the continuity warning).
      throw new ProviderStateTooLargeError(`provider-state sidecar exceeds ${PROVIDER_STATE_MAX_READ_BYTES} bytes: ${path}`);
    }
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof ProviderStateTooLargeError) throw err;
    return [];
  }
  const records: ProviderStateRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const record = parseProviderStateLine(line);
    if (record !== undefined) records.push(record);
  }
  return records;
}

export class ProviderStateTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderStateTooLargeError";
  }
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

const KINDS: ReadonlySet<string> = new Set<ProviderStateKind>(["origin", "native-state", "summary", "handoff"]);

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

/**
 * Copies a session's provider-state chain onto a FORK.
 *
 * `resume --fork-session` copies the transcript's entries with their `uuid`/`parentUuid` untouched
 * (only each entry's own `sessionId` is re-owned), so the fork's assistant entries carry the SAME
 * anchors the source's did -- which is exactly what makes copying the chain meaningful rather than a
 * best-effort guess. Without this, a forked session landed with no chain AND no identity, so its very
 * first resume took the pre-P6 silent path and lost every native continuation the source had
 * accumulated, with nothing said (review round 2, M3).
 *
 * Each record gets a FRESH `uuid` while keeping its `anchorUuid`: `uuid` is the store's idempotency
 * key (item (h)), so two sessions sharing record uuids would collide into one upserted row in any
 * store that dedupes on it. `sessionId` is re-owned to match the fork, mirroring what the transcript
 * copy already does to its entries.
 *
 * Returns the number of records copied -- `0` for a source with no sidecar, which is not an error:
 * a pre-P6 source has nothing to carry, and the fork is then in exactly the state the source was.
 */
export function copyProviderStateForFork(sourcePath: string, destPath: string, destSessionId: string): number {
  const records = readProviderState(sourcePath);
  for (const record of records) {
    appendProviderState(destPath, { ...record, uuid: randomUUID(), sessionId: destSessionId });
  }
  return records.length;
}

/** What one assistant entry's records fold into. `origin` is mandatory in a healthy chain; its ABSENCE is what degrades that message to summary-level. */
export interface ContinuationLink {
  origin?: MessageOrigin;
  nativeState?: ProviderNativeState;
  summary?: string;
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
        link.origin = {
          providerId: record.provider,
          modelKey: record.model,
          family: record.family,
          ...(record.continuationDomain !== undefined ? { continuationDomain: record.continuationDomain } : {}),
        };
        break;
      case "native-state": {
        const items = readNativeItems(record.payload);
        if (items !== undefined) {
          link.nativeState = {
            family: record.family,
            // A native-state record without a domain is unreplayable by definition (R6-9 binds exact
            // replay to a continuation DOMAIN, not to a family), so the family is the honest floor
            // rather than a fabricated domain id.
            continuationDomain: record.continuationDomain ?? record.family,
            items,
          };
        }
        break;
      }
      case "summary": {
        const text = readSummaryText(record.payload);
        if (text !== undefined) link.summary = text;
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

function readSummaryText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

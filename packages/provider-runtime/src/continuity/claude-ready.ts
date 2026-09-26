// Phase 10b Lane S, S6 (W18-14): the Claude-ready copy.
//
// ONE pure, deterministic, idempotent export the router wraps its `sessionStore` in
// (`official/options-template.ts:165`, Lane R): `load()` returns `toClaudeReady(canonical entries)`,
// and every append passes through untouched. It NEVER touches the canonical file (this module has no
// write side at all -- it is a pure function over arrays), and entry uuids never change.
//
// FIVE THINGS IT DOES, IN ORDER (spec letters):
//   (a) translates legacy Winter compaction (`compact_summary`/`compact_boundary`, snake_case) into
//       Claude's own native shape (`system/compact_boundary` + `isCompactSummary`, camelCase) -- the
//       summary keeps its own uuid, the boundary keeps the legacy boundary's uuid, and the chain is
//       relinked exactly as W18-12's own writer produces it (`runtime/src/store/dialect.ts`'s
//       `claudeCompactBoundaryEntry`/`claudeCompactSummaryEntry` -- this module cannot import that
//       package, so the shape is reproduced here rather than shared, and the conformance corpus is
//       what keeps the two from drifting apart);
//   (b) stamps a `message.id`/`message.type` on any assistant entry that lacks one (W18-11's own
//       `msg_winter_<uuid-hex>` derivation, redeclared for the same reason as (a) -- it is a PURE
//       function of the uuid, so re-deriving it here can never disagree with the one runtime/dialect
//       actually writes);
//   (c) deterministically remaps any tool id that fails Anthropic's `^[A-Za-z0-9_-]+$` or exceeds 128
//       characters to `toolu_winter_<hash>`, and remaps every `tool_result.tool_use_id` that
//       references it -- consistently, across the WHOLE entry array, not just within one message;
//   (d) drops `thinking`/`redacted_thinking` blocks whose origin is not first-party Anthropic IN THE
//       TARGET's own replay domain -- an entry with NO sidecar `origin` record at all counts as
//       first-party (it was written by the SAME official leg this copy is being served to; there is
//       no OTHER way an entry acquires an in-dialect `thinking` block with no sidecar trace of who
//       produced it);
//   (e) adds AT MOST ONE reasoning decoration per foreign assistant message that step (d) stripped,
//       from the sidecar's `summary`/`exposed` material ONLY -- never `native-state` (W18-18) --
//       spent newest-first against `opts.budgetChars`, mirroring `renderer.ts`'s own §9.6 discipline.
//       Reused primitives (`doorFor`, `buildDecoration`, `decorationOverhead`, the tag constant) are
//       the SAME ones the live renderer uses, so the two carriage mechanisms can never render two
//       different tag shapes for what is conceptually the same decoration.
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { createHash } from "node:crypto";
import type { ContentBlockLike, MessageOrigin } from "../types.ts";
import { MIN_DECORATION_BODY_CHARS, RECOVERED_REASONING_TAG, buildDecoration, decorationOverhead, doorFor, type DecorationKind } from "./decoration.ts";
import { sameDomain, type ContinuityEndpoint } from "./domains.ts";

/**
 * A sidecar (`<sessionId>.provider-state.jsonl`) record, structurally. Redeclared here rather than
 * imported from `runtime/src/store/provider-state.ts` -- provider-runtime must never import the
 * runtime (R6-4's cycle rule) -- so this is the STRUCTURAL shape a raw JSONL line (or the runtime's
 * own `ProviderStateRecord`, which is a superset) already satisfies; a caller with the real type
 * passes it here unchanged, no cast needed.
 */
// WS-23 (reasoning-state): kept in step with the runtime's own list (store/provider-state.ts), where each
// new kind is documented -- Anthropic thinking (`reasoning-blocks`) and the per-model cache quirks.
export type ProviderStateKind = "origin" | "native-state" | "summary" | "handoff" | "reasoning-blocks" | "effort" | "tool-epoch" | "tool-changes";
export interface ProviderStateRecord {
  type: string;
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

export interface ToClaudeReadyOptions {
  target: ContinuityEndpoint;
  resolveEndpoint: (origin: MessageOrigin) => ContinuityEndpoint;
  /** §9.6-style total budget across every decoration THIS copy adds. Absent = unbounded. */
  budgetChars?: number;
}

export interface ToClaudeReadyResult {
  entries: SessionStoreEntry[];
  /** Decorations dropped entirely (no room at all) or truncated to fit -- either way, material this copy could not carry in full. */
  dropped: number;
}

// W18-12's own preamble, byte-exact to the golden (`conformance/goldens/claude-2.1.250/compaction.jsonl`)
// -- redeclared for the same reason as `winterMessageIdFor` below: this package cannot import
// `runtime/src/store/dialect.ts`'s `CLAUDE_COMPACT_SUMMARY_PREAMBLE`, and both are pure literals a
// conformance test keeps in sync, not a shared runtime dependency.
const CLAUDE_COMPACT_SUMMARY_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";

// W18-11's own derivation, redeclared for the identical reason -- pure and deterministic, so two
// independent call sites deriving the same uuid always agree.
function winterMessageIdFor(uuid: string): string {
  return "msg_winter_" + uuid.replaceAll("-", "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// --- step (a): legacy compaction translation ------------------------------------------------------

function readLegacyPreservedMessages(meta: Record<string, unknown>): { anchorUuid: string; uuids: string[] } | undefined {
  const preserved = meta.preserved_messages;
  if (!isRecord(preserved)) return undefined;
  const anchorUuid = preserved.anchor_uuid;
  const uuids = preserved.uuids;
  if (typeof anchorUuid !== "string" || !Array.isArray(uuids)) return undefined;
  return { anchorUuid, uuids: uuids.filter((u): u is string => typeof u === "string") };
}

function buildClaudeBoundaryFromLegacy(boundary: SessionStoreEntry, summary: SessionStoreEntry): SessionStoreEntry {
  const legacyMeta = isRecord(boundary.compact_metadata) ? boundary.compact_metadata : {};
  const preserved = readLegacyPreservedMessages(legacyMeta);
  const logicalParentUuid = typeof summary.parentUuid === "string" ? summary.parentUuid : null;
  const { compact_metadata: _old, ...rest } = boundary;
  return {
    ...rest,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    parentUuid: null,
    ...(logicalParentUuid !== null ? { logicalParentUuid } : {}),
    compactMetadata: {
      trigger: legacyMeta.trigger,
      preTokens: legacyMeta.pre_tokens,
      ...(legacyMeta.post_tokens !== undefined ? { postTokens: legacyMeta.post_tokens } : {}),
      ...(legacyMeta.duration_ms !== undefined ? { durationMs: legacyMeta.duration_ms } : {}),
      ...(preserved !== undefined ? { preservedMessages: preserved } : {}),
    },
  };
}

function buildClaudeSummaryFromLegacy(summary: SessionStoreEntry, boundary: SessionStoreEntry): SessionStoreEntry {
  const message = isRecord(summary.message) ? summary.message : { role: "user", content: "" };
  const text = typeof message.content === "string" ? message.content : "";
  return {
    ...summary,
    type: "user",
    parentUuid: boundary.uuid,
    message: { role: "user", content: `${CLAUDE_COMPACT_SUMMARY_PREAMBLE}\n\n${text}` },
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  };
}

/**
 * Translates every legacy `compact_summary`/`compact_boundary` PAIR into Claude's native shape.
 * Idempotent by construction: a translated boundary's `type` is `"system"` and a translated summary's
 * is `"user"`, so a second pass finds no more `"compact_boundary"`/`"compact_summary"` entries to act
 * on and returns its input unchanged (structurally, not by identity -- see the top-level doc).
 */
function translateLegacyCompaction(entries: SessionStoreEntry[]): SessionStoreEntry[] {
  const byUuid = new Map<string, SessionStoreEntry>();
  for (const e of entries) if (typeof e.uuid === "string") byUuid.set(e.uuid, e);

  const boundaryBySummaryUuid = new Map<string, SessionStoreEntry>();
  for (const e of entries) {
    if (e.type === "compact_boundary" && typeof e.parentUuid === "string") {
      const summary = byUuid.get(e.parentUuid);
      if (summary?.type === "compact_summary") boundaryBySummaryUuid.set(e.parentUuid, e);
    }
  }

  return entries.map((entry) => {
    if (entry.type === "compact_boundary" && typeof entry.parentUuid === "string") {
      const summary = byUuid.get(entry.parentUuid);
      if (summary?.type === "compact_summary") return buildClaudeBoundaryFromLegacy(entry, summary);
    }
    if (entry.type === "compact_summary" && typeof entry.uuid === "string") {
      const boundary = boundaryBySummaryUuid.get(entry.uuid);
      if (boundary !== undefined) return buildClaudeSummaryFromLegacy(entry, boundary);
    }
    return entry;
  });
}

// --- shared content-block helpers -------------------------------------------------------------

function messageContentBlocks(entry: SessionStoreEntry): ContentBlockLike[] | undefined {
  const message = (entry as { message?: unknown }).message;
  if (!isRecord(message)) return undefined;
  return Array.isArray(message.content) ? (message.content as ContentBlockLike[]) : undefined;
}

function withContent(entry: SessionStoreEntry, message: Record<string, unknown>, content: ContentBlockLike[]): SessionStoreEntry {
  return { ...entry, message: { ...message, content } };
}

// --- step (c): deterministic tool-id remap ----------------------------------------------------

const VALID_TOOL_ID = /^[A-Za-z0-9_-]+$/;
const MAX_TOOL_ID_LENGTH = 128;

function needsToolIdRemap(id: string): boolean {
  return !VALID_TOOL_ID.test(id) || id.length > MAX_TOOL_ID_LENGTH;
}

/** `toolu_winter_<hash>` -- deterministic (same id always maps to the same replacement, across calls and across the two block kinds that name it). */
function remappedToolId(id: string): string {
  return `toolu_winter_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

function buildToolIdMap(entries: SessionStoreEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const content = messageContentBlocks(entry);
    if (content === undefined) continue;
    for (const block of content) {
      if (block.type === "tool_use" && needsToolIdRemap(block.id) && !map.has(block.id)) map.set(block.id, remappedToolId(block.id));
    }
  }
  return map;
}

function remapIdsInBlocks(blocks: ContentBlockLike[], toolIdMap: Map<string, string>): ContentBlockLike[] {
  if (toolIdMap.size === 0) return blocks;
  let changed = false;
  const mapped = blocks.map((block) => {
    if (block.type === "tool_use" && toolIdMap.has(block.id)) {
      changed = true;
      return { ...block, id: toolIdMap.get(block.id)! };
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string" && toolIdMap.has(block.tool_use_id)) {
      changed = true;
      return { ...block, tool_use_id: toolIdMap.get(block.tool_use_id)! };
    }
    return block;
  });
  return changed ? mapped : blocks;
}

/** Applies the remap consistently across EVERY entry -- a `tool_use` and the `tool_result` naming it can be in different entries. Idempotent: an id already remapped to `toolu_winter_<hash>` passes `needsToolIdRemap` as false, so a second pass's map is empty for it. */
function applyToolIdRemap(entries: SessionStoreEntry[], toolIdMap: Map<string, string>): SessionStoreEntry[] {
  if (toolIdMap.size === 0) return entries;
  return entries.map((entry) => {
    const content = messageContentBlocks(entry);
    if (content === undefined) return entry;
    const remapped = remapIdsInBlocks(content, toolIdMap);
    if (remapped === content) return entry;
    return withContent(entry, entry.message as Record<string, unknown>, remapped);
  });
}

// --- step (d): first-party-in-domain thinking retention -----------------------------------------

function stripThinkingBlocks(content: ContentBlockLike[]): { content: ContentBlockLike[]; strippedAny: boolean } {
  const kept = content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
  return { content: kept.length === content.length ? content : kept, strippedAny: kept.length !== content.length };
}

/** True once this content already carries a rendered tag -- the idempotency guard for step (e): a second `toClaudeReady` pass over an already-decorated copy must never add a second decoration. */
function alreadyDecorated(content: ContentBlockLike[]): boolean {
  return content.some((b) => b.type === "text" && b.text.includes(`<${RECOVERED_REASONING_TAG}`));
}

function readSummaryPayloadText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return typeof payload.text === "string" ? payload.text : undefined;
}

function readSummaryPayloadMaterial(payload: unknown): "exposed" | undefined {
  if (!isRecord(payload)) return undefined;
  return payload.material === "exposed" ? "exposed" : undefined;
}

function groupByAnchor(records: ProviderStateRecord[]): Map<string, ProviderStateRecord[]> {
  const map = new Map<string, ProviderStateRecord[]>();
  for (const record of records) {
    const list = map.get(record.anchorUuid) ?? [];
    list.push(record);
    map.set(record.anchorUuid, list);
  }
  return map;
}

/** The pure fold, exported for tests: builds the fully rewritten entries (steps a-d) plus the decoration CANDIDATES step (e) still needs to spend a budget over. */
export function toClaudeReady(entries: SessionStoreEntry[], sidecarRecords: ProviderStateRecord[], opts: ToClaudeReadyOptions): ToClaudeReadyResult {
  const afterCompaction = translateLegacyCompaction(entries);
  const toolIdMap = buildToolIdMap(afterCompaction);
  const afterToolRemap = applyToolIdRemap(afterCompaction, toolIdMap);
  const byAnchor = groupByAnchor(sidecarRecords);

  const result: SessionStoreEntry[] = new Array(afterToolRemap.length);
  const candidates: Array<{ index: number; source: { providerId: string; modelKey: string }; text: string; kind: DecorationKind }> = [];

  afterToolRemap.forEach((entry, index) => {
    if (entry.type !== "assistant") {
      result[index] = entry;
      return;
    }
    const content = messageContentBlocks(entry);
    if (content === undefined) {
      result[index] = entry;
      return;
    }
    const message = entry.message as Record<string, unknown>;
    const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
    // step (b): idempotent -- an entry that already has an id is never re-stamped.
    const stampedMessage: Record<string, unknown> = typeof message.id === "string" ? message : uuid !== undefined ? { id: winterMessageIdFor(uuid), type: "message", ...message } : message;

    const anchorRecords = uuid !== undefined ? (byAnchor.get(uuid) ?? []) : [];
    const originRecord = anchorRecords.find((r) => r.kind === "origin");

    // step (d), first leg: NO sidecar record at all counts as first-party (an official-written entry
    // with no sidecar trace of who produced it) -- kept verbatim, no strip, no decoration.
    if (originRecord === undefined) {
      result[index] = withContent(entry, stampedMessage, content);
      return;
    }

    const origin: MessageOrigin = {
      providerId: originRecord.provider,
      modelKey: originRecord.model,
      family: originRecord.family,
      ...(originRecord.continuationDomain !== undefined ? { continuationDomain: originRecord.continuationDomain } : {}),
    };
    const source = opts.resolveEndpoint(origin);

    // step (d), second leg: first-party Anthropic IN THE TARGET'S replay domain -- native replay,
    // thinking blocks (with their real signatures) ride unchanged.
    if (source.family === "anthropic" && sameDomain(source, opts.target)) {
      result[index] = withContent(entry, stampedMessage, content);
      return;
    }

    // A foreign origin's in-dialect thinking is stripped WHETHER OR NOT any is actually present --
    // an open-model (DeepSeek/GLM-style) foreign message carries NO thinking blocks at all (its
    // reasoning lives only in the sidecar), so gating decoration on "something was stripped" would
    // silently skip every open-model source. Stripping is a no-op (`stripped === content`) when
    // there is nothing to remove.
    const { content: stripped } = stripThinkingBlocks(content);
    if (alreadyDecorated(stripped)) {
      result[index] = withContent(entry, stampedMessage, stripped);
      return;
    }

    // step (e): material comes ONLY from the sidecar's own `summary`/`exposed` record -- never `native-state`.
    const summaryRecord = anchorRecords.find((r) => r.kind === "summary");
    const materialText = readSummaryPayloadText(summaryRecord?.payload);
    result[index] = withContent(entry, stampedMessage, stripped);
    if (materialText !== undefined && materialText.length > 0) {
      const kind: DecorationKind = readSummaryPayloadMaterial(summaryRecord?.payload) === "exposed" ? "exposed" : "summary";
      candidates.push({ index, source: { providerId: source.providerId, modelKey: source.modelKey }, text: materialText, kind });
    }
  });

  // step (e), the budget: spent NEWEST FIRST (renderer.ts's own §9.6 discipline), so material closest
  // to the current work survives when the budget cannot hold everything.
  let remaining = opts.budgetChars;
  let dropped = 0;
  const door = doorFor(opts.target);
  for (const candidate of [...candidates].reverse()) {
    if (remaining !== undefined && remaining < decorationOverhead(candidate.source, door, candidate.kind) + MIN_DECORATION_BODY_CHARS) {
      dropped++;
      continue;
    }
    const decoration = buildDecoration({
      text: candidate.text,
      source: candidate.source,
      door,
      kind: candidate.kind,
      ...(remaining !== undefined ? { maxChars: remaining } : {}),
    });
    if (remaining !== undefined) remaining = Math.max(0, remaining - decoration.text.length);
    if (decoration.truncated) dropped++;
    const target = result[candidate.index]!;
    const content = messageContentBlocks(target) ?? [];
    result[candidate.index] = withContent(target, target.message as Record<string, unknown>, [...content, { type: "text", text: decoration.text }]);
  }

  return { entries: result, dropped };
}

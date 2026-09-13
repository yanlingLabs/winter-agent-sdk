// Phase 10b Lane S, S7 (W18-20/21, P10b-1/2): the ONE pre-flight review the daemon calls before
// applying ANY model change that crosses families (same-leg or cross-runtime alike).
//
// `switchFactsFor` computes the facts `classifySwitch` (warnings.ts) already knows how to read, over
// the lineage AFTER THE LAST COMPACTION BOUNDARY -- carriage stops at a boundary by design (W18-16),
// so nothing before it should count toward "did the source reason since then". Boundary detection
// mirrors `runtime/src/store/resume.ts`'s own (both shapes: legacy snake_case `compact_boundary` and
// Claude's native `system/compact_boundary`) -- redeclared here for the same reason every other
// duplicated primitive in this lane is: provider-runtime must never import the runtime package.
//
// `reviewModelSwitch` is the seam the router's `reviewSwitch` (Lane R) and the daemon's pre-flight
// call both end up running: three skips, evaluated in order (same-profile, same-family, zero source
// turns), and otherwise the existing loss matrix, unchanged.
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import type { ProviderStateRecord } from "./claude-ready.ts";
import { sameFamily, type ContinuityEndpoint } from "./domains.ts";
import { classifySwitch, type SwitchClassification, type SwitchFacts } from "./warnings.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// --- boundary-cut lineage (mirrors resume.ts's ancestryChain + last-boundary cut) ------------------

interface Node {
  uuid: string;
  parentUuid: string | null;
  type: string;
  subtype?: string;
  role?: string;
}

function toNodes(entries: SessionStoreEntry[]): Node[] {
  const nodes: Node[] = [];
  for (const e of entries) {
    if (typeof e.uuid !== "string") continue;
    const parentUuid = typeof e.parentUuid === "string" ? e.parentUuid : null;
    const rawSubtype: unknown = e.subtype;
    const subtype = typeof rawSubtype === "string" ? rawSubtype : undefined;
    const message = (e as { message?: unknown }).message;
    const role = isRecord(message) && typeof message.role === "string" ? message.role : undefined;
    nodes.push({ uuid: e.uuid, parentUuid, type: e.type, ...(subtype !== undefined ? { subtype } : {}), ...(role !== undefined ? { role } : {}) });
  }
  return nodes;
}

function isBoundary(n: Node): boolean {
  return n.type === "compact_boundary" || (n.type === "system" && n.subtype === "compact_boundary");
}

/**
 * The lineage from the array's own last entry (file order is append order) back to the root,
 * cut at the LAST boundary on it -- everything at or before the boundary is excluded, matching
 * `resume.ts`'s own "carriage stops at a compaction boundary" (W18-16). No boundary at all -> the
 * whole ancestry.
 */
function lineageSinceLastBoundary(entries: SessionStoreEntry[]): Node[] {
  const nodes = toNodes(entries);
  if (nodes.length === 0) return [];
  const byUuid = new Map(nodes.map((n) => [n.uuid, n] as const));
  const leaf = nodes[nodes.length - 1]!;
  const chain: Node[] = [];
  const seen = new Set<string>();
  let cursor: Node | undefined = leaf;
  while (cursor !== undefined) {
    if (seen.has(cursor.uuid)) break;
    seen.add(cursor.uuid);
    chain.push(cursor);
    cursor = cursor.parentUuid === null ? undefined : byUuid.get(cursor.parentUuid);
  }
  chain.reverse(); // root-first
  const lastBoundaryIndex = chain.reduce((acc, n, i) => (isBoundary(n) ? i : acc), -1);
  return lastBoundaryIndex === -1 ? chain : chain.slice(lastBoundaryIndex + 1);
}

// --- sidecar lookups -------------------------------------------------------------------------------

function groupByAnchor(records: ProviderStateRecord[]): Map<string, ProviderStateRecord[]> {
  const map = new Map<string, ProviderStateRecord[]>();
  for (const record of records) {
    const list = map.get(record.anchorUuid) ?? [];
    list.push(record);
    map.set(record.anchorUuid, list);
  }
  return map;
}

function originOf(records: ProviderStateRecord[]): { providerId: string; modelKey: string } | undefined {
  const record = records.find((r) => r.kind === "origin");
  return record !== undefined ? { providerId: record.provider, modelKey: record.model } : undefined;
}

function summaryPayloadOf(records: ProviderStateRecord[]): { text?: string; material?: "exposed"; complete?: boolean } | undefined {
  const record = records.find((r) => r.kind === "summary");
  if (record === undefined || !isRecord(record.payload)) return undefined;
  const payload = record.payload;
  return {
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(payload.material === "exposed" ? { material: "exposed" as const } : {}),
    ...(typeof payload.complete === "boolean" ? { complete: payload.complete } : {}),
  };
}

/** An entry belongs to `from` when its own sidecar origin names it, OR it has no origin record at all -- the "no sidecar record = written by whichever leg is currently active" rule W18-14(d) states for the SAME reason. */
function belongsToSource(origin: { providerId: string; modelKey: string } | undefined, from: ContinuityEndpoint): boolean {
  return origin === undefined || (origin.providerId === from.providerId && origin.modelKey === from.modelKey);
}

function countCompletedToolResults(lineage: Node[], entries: SessionStoreEntry[]): number {
  const byUuid = new Map(entries.filter((e) => typeof e.uuid === "string").map((e) => [e.uuid as string, e]));
  let count = 0;
  for (const node of lineage) {
    if (node.role !== "user") continue;
    const raw = byUuid.get(node.uuid);
    const message = raw !== undefined ? (raw as { message?: unknown }).message : undefined;
    const content = isRecord(message) ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isRecord(block) && block.type === "tool_result" && block.denied !== true && block.error !== true) count++;
    }
  }
  return count;
}

/**
 * The facts `classifySwitch` reads, over the lineage since the last compaction boundary. Pure: reads
 * only `entries`/`sidecarRecords`, mutates neither.
 */
export function switchFactsFor(args: { entries: SessionStoreEntry[]; sidecarRecords: ProviderStateRecord[]; from: ContinuityEndpoint }): SwitchFacts & { sourceTurns: number } {
  const lineage = lineageSinceLastBoundary(args.entries);
  const byAnchor = groupByAnchor(args.sidecarRecords);

  const assistantTurns = lineage.filter((n) => n.type === "assistant");
  const sourceAssistantTurns = assistantTurns.filter((n) => belongsToSource(originOf(byAnchor.get(n.uuid) ?? []), args.from));

  const sourceTurns = sourceAssistantTurns.length;

  // summaryAvailable: a summary OR exposed record exists for the source's LAST assistant turn.
  const lastSourceTurn = sourceAssistantTurns.at(-1);
  const lastSourcePayload = lastSourceTurn !== undefined ? summaryPayloadOf(byAnchor.get(lastSourceTurn.uuid) ?? []) : undefined;
  const summaryAvailable = lastSourcePayload?.text !== undefined && lastSourcePayload.text.length > 0;

  // exposedComplete: every source-domain turn that reasoned (has ANY captured material) has an
  // exposed record with complete:true. Zero reasoning turns is NOT "complete" -- there is no
  // affirmative evidence to suppress a warning with, matching classifySwitch's own "unknown warns".
  const reasonedSourceTurns = sourceAssistantTurns
    .map((n) => summaryPayloadOf(byAnchor.get(n.uuid) ?? []))
    .filter((p): p is { text?: string; material?: "exposed"; complete?: boolean } => p !== undefined && p.text !== undefined && p.text.length > 0);
  const exposedComplete = reasonedSourceTurns.length > 0 && reasonedSourceTurns.every((p) => p.material === "exposed" && p.complete === true);

  const completedToolResults = countCompletedToolResults(lineage, args.entries);

  return {
    summaryAvailable,
    exposedComplete,
    completedToolResults,
    // The daemon DEFERS a move during a running turn and never aborts it (W18-20's own text) -- this
    // helper has no way to observe a running turn anyway (it reads a snapshot), so the fact is always
    // false, stated rather than omitted.
    midTurnAbort: false,
    sourceTurns,
  };
}

export type SwitchReview = { prompt: boolean; skipped?: "same-family" | "no-source-turns" | "same-profile"; classification?: SwitchClassification };

/**
 * The ONE pre-flight review (W18-20/21). Skips apply IN ORDER -- same-profile, same-family
 * (`sameFamily`), zero source turns -- each returning BEFORE `switchFactsFor`/`classifySwitch` ever
 * run (P10b-1/2: a same-family or no-op switch never prompts, and the router decides every skip, not
 * the daemon). Otherwise the existing loss matrix classifies, unchanged: `prompt` is exactly
 * `classification.lossClass === "warned-lossy"`.
 */
export function reviewModelSwitch(args: { entries: SessionStoreEntry[]; sidecarRecords: ProviderStateRecord[]; from: ContinuityEndpoint; to: ContinuityEndpoint; truncated?: boolean }): SwitchReview {
  const sameProfile = args.from.providerId === args.to.providerId && args.from.modelKey === args.to.modelKey;
  if (sameProfile) return { prompt: false, skipped: "same-profile" };
  if (sameFamily(args.from, args.to)) return { prompt: false, skipped: "same-family" };

  const facts = switchFactsFor({ entries: args.entries, sidecarRecords: args.sidecarRecords, from: args.from });
  if (facts.sourceTurns === 0) return { prompt: false, skipped: "no-source-turns" };

  const classification = classifySwitch(args.from, args.to, { ...facts, ...(args.truncated === true ? { truncated: true } : {}) });
  return { prompt: classification.lossClass === "warned-lossy", classification };
}

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
//
// Fix round 2 (controller ruling, LOAD-BEARING): "same-family" here means MODEL LINEAGE (WS-13c's
// `modelFamily` -- Claude/GPT/Gemini/DeepSeek/GLM), never the catalog PROVIDER's wire dialect
// `domains.ts`'s own `sameFamily` compares (`zai`, `deepseek` and `openai` are all `"openai"` there).
// See `sameModelFamily` below for the comparison and why it is deliberately its own function rather
// than a change to `domains.ts`.
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { loadCatalog, modelFamilyOf, OTHER_FAMILY_ID, type WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderStateRecord } from "./claude-ready.ts";
import type { ContinuityEndpoint } from "./domains.ts";
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
  /** An `assistant` entry's `tool_use` ids, in block order (F2). */
  toolUseIds: string[];
  /** A `user` entry's `tool_result` ids, in block order (F2). */
  toolResultIds: string[];
  /** claude's synthetic `isApiErrorMessage` assistant entry -- never a batch sibling (F2). */
  apiError: boolean;
}

function blockIds(message: unknown, blockType: "tool_use" | "tool_result", idKey: "id" | "tool_use_id"): string[] {
  const content = isRecord(message) ? message.content : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((b: unknown) => (isRecord(b) && b.type === blockType && typeof b[idKey] === "string" ? [b[idKey] as string] : []));
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
    nodes.push({
      uuid: e.uuid,
      parentUuid,
      type: e.type,
      ...(subtype !== undefined ? { subtype } : {}),
      ...(role !== undefined ? { role } : {}),
      toolUseIds: e.type === "assistant" ? blockIds(message, "tool_use", "id") : [],
      toolResultIds: e.type === "user" ? blockIds(message, "tool_result", "tool_use_id") : [],
      apiError: (e as { isApiErrorMessage?: unknown }).isApiErrorMessage === true,
    });
  }
  return nodes;
}

/**
 * F2 (WS-21 fix round 23): `runtime/src/store/resume.ts`'s `recoverParallelToolResults`, redeclared
 * (provider-runtime must never import the runtime package -- this file's own rule, above) so the
 * warning's "N completed tool results" counts exactly what the Winter leg's rebuild carries.
 *
 * claude writes a PARALLEL batch as one one-block `assistant` entry per call, chained one after
 * another, and parents each call's result on ITS OWN call's entry; it yields a concurrency-safe
 * batch's results in completion order (`getCompletedResults`, claude 2.1.250 dump offset 18548003)
 * and chains the next turn onto the last one. So the single parentUuid chain from the leaf holds one
 * result, and when an earlier call finished last, not even the later call entries. claude's own
 * reader splices both back in after its walk (`Cer`, 20061141). Here as there: for each run of
 * consecutive chain `assistant` entries that does not end the chain, the off-chain sibling call
 * entries (parented on a member or another sibling) and the off-chain results parented on any of
 * them that answer a call nothing on the chain answers yet are inserted right after the run's last
 * entry -- siblings first, then results in call order. A sibling comes back only when every call it
 * carries is then answered. resume.ts's header comment has the full reasoning and the deliberate
 * differences from `Cer` (grouped by the run and matched by `tool_use_id`, never by `message.id`).
 */
function recoverParallelToolResults(chain: Node[], pool: Node[]): Node[] {
  const onChain = new Set(chain.map((n) => n.uuid));
  const resultsByParent = new Map<string, Node[]>();
  const offChainAssistants: Node[] = [];
  for (const n of pool) {
    if (onChain.has(n.uuid) || n.parentUuid === null) continue;
    if (n.type === "assistant" && !n.apiError) offChainAssistants.push(n);
    if (n.toolResultIds.length === 0) continue;
    const siblings = resultsByParent.get(n.parentUuid);
    if (siblings !== undefined) siblings.push(n);
    else resultsByParent.set(n.parentUuid, [n]);
  }
  if (resultsByParent.size === 0 && offChainAssistants.length === 0) return chain;

  const answered = new Set(chain.flatMap((n) => n.toolResultIds));
  const recovered = new Set<string>();
  const resultsFor = (parentUuid: string, open: readonly string[]): { results: Node[]; ids: Set<string> } => {
    const results: Node[] = [];
    const ids = new Set<string>();
    for (const candidate of resultsByParent.get(parentUuid) ?? []) {
      if (recovered.has(candidate.uuid)) continue;
      if (!candidate.toolResultIds.some((id) => open.includes(id) && !ids.has(id))) continue;
      results.push(candidate);
      for (const id of candidate.toolResultIds) ids.add(id);
    }
    return { results, ids };
  };
  const take = (results: readonly Node[], ids: ReadonlySet<string>): void => {
    for (const r of results) recovered.add(r.uuid);
    for (const id of ids) answered.add(id);
  };

  const inserts = new Map<string, Node[]>();
  for (let start = 0; start < chain.length; ) {
    if (chain[start]!.type !== "assistant") {
      start++;
      continue;
    }
    let end = start;
    while (end + 1 < chain.length && chain[end + 1]!.type === "assistant") end++;
    if (end < chain.length - 1) {
      const memberResults: Node[] = [];
      for (let k = start; k <= end; k++) {
        const member = chain[k]!;
        const { results, ids } = resultsFor(member.uuid, member.toolUseIds.filter((id) => !answered.has(id)));
        take(results, ids);
        memberResults.push(...results);
      }
      const reachable = new Set(chain.slice(start, end + 1).map((n) => n.uuid));
      const siblings: Node[] = [];
      const siblingResults: Node[] = [];
      for (const candidate of offChainAssistants) {
        if (candidate.parentUuid === null || !reachable.has(candidate.parentUuid) || recovered.has(candidate.uuid)) continue;
        reachable.add(candidate.uuid);
        const { results, ids } = resultsFor(candidate.uuid, candidate.toolUseIds.filter((id) => !answered.has(id)));
        if (!candidate.toolUseIds.every((id) => answered.has(id) || ids.has(id))) continue;
        recovered.add(candidate.uuid);
        take(results, ids);
        siblings.push(candidate);
        siblingResults.push(...results);
      }
      const found = [...siblings, ...memberResults, ...siblingResults];
      if (found.length > 0) inserts.set(chain[end]!.uuid, found);
    }
    start = end + 1;
  }
  if (inserts.size === 0) return chain;
  return chain.flatMap((n) => [n, ...(inserts.get(n.uuid) ?? [])]);
}

function isBoundary(n: Node): boolean {
  return n.type === "compact_boundary" || (n.type === "system" && n.subtype === "compact_boundary");
}

/**
 * The lineage from the array's own last entry (file order is append order) back to the root,
 * cut at the LAST boundary on it -- everything at or before the boundary is excluded, matching
 * `resume.ts`'s own "carriage stops at a compaction boundary" (W18-16). No boundary at all -> the
 * whole ancestry. A parallel batch after the cut brings its side-branch results with it (F2,
 * `recoverParallelToolResults` above) -- recovered AFTER the cut, so a batch before it never counts.
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
  return recoverParallelToolResults(lastBoundaryIndex === -1 ? chain : chain.slice(lastBoundaryIndex + 1), nodes);
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

// --- same-family, by MODEL LINEAGE (controller ruling, fix round 2) --------------------------------
//
// `domains.ts`'s `sameFamily` compares `ContinuityEndpoint.family` -- the catalog PROVIDER's wire
// dialect (R13c-1's own distinction: `zai`, `deepseek` and `openai` are ALL `"openai"` there). This
// review's own "same-family never prompts" skip (P10b-1/2) is a DIFFERENT claim: the user's rule is
// family by MODEL LINEAGE -- Claude <-> Claude (Sonnet/Opus/Haiku/Fable, on any host), GPT <-> GPT
// (Terra/Luna/Sol/Astra...), Gemini <-> Gemini, DeepSeek <-> DeepSeek, GLM <-> GLM. Using the wire
// dialect here made GPT -> DeepSeek and GPT -> GLM skip silently (R-10b-8 requires them to prompt).
//
// So this comparison is DELIBERATELY SEPARATE from `domains.ts`'s `sameFamily` -- which keeps its own
// meaning for whatever else compares wire dialects (renderer.ts does not; nothing else in this
// package currently calls it) -- and lives here, next to the one caller that needs model lineage.
//
// WS-13c's `modelFamily` (`provider-catalog/src/families.ts`) is the model-lineage layer: derived at
// build from the model's own canonical id, independent of which provider/dialect serves it. Resolved
// via `modelFamilyOf(catalog, providerId, modelKey)`.
let compiledCatalog: WinterCatalog | undefined;
function catalogFor(catalog: WinterCatalog | undefined): WinterCatalog {
  return catalog ?? (compiledCatalog ??= loadCatalog());
}

/**
 * TRUE only when BOTH sides resolve to the SAME NAMED model-family id. An UNKNOWN family on either
 * side (no matching catalog row) is NEVER same-family -- the review must run and let `classifySwitch`
 * decide, rather than silently skip on a guess. `"other"` (WS-13c's catch-all for a row no matcher
 * claims) is treated the SAME way: two `"other"` rows share no proven lineage with each other, so
 * comparing them equal would be exactly the kind of guess this function exists to refuse.
 */
function sameModelFamily(a: ContinuityEndpoint, b: ContinuityEndpoint, catalog: WinterCatalog): boolean {
  const familyOfA = modelFamilyOf(catalog, a.providerId, a.modelKey);
  const familyOfB = modelFamilyOf(catalog, b.providerId, b.modelKey);
  if (familyOfA === undefined || familyOfB === undefined) return false;
  if (familyOfA === OTHER_FAMILY_ID || familyOfB === OTHER_FAMILY_ID) return false;
  return familyOfA === familyOfB;
}

/**
 * The ONE pre-flight review (W18-20/21). Skips apply IN ORDER -- same-profile, same-family (by MODEL
 * LINEAGE, `sameModelFamily` above -- fix round 2), zero source turns -- each returning BEFORE
 * `switchFactsFor`/`classifySwitch` ever run (P10b-1/2: a same-family or no-op switch never prompts,
 * and the router decides every skip, not the daemon). Otherwise the existing loss matrix classifies,
 * unchanged: `prompt` is exactly `classification.lossClass === "warned-lossy"`.
 *
 * `catalog` is an injection seam for tests ONLY (mirrors `adapters/anthropic/messages.ts`'s own
 * `opts.catalog ?? loadCatalog()` pattern) -- every production caller omits it and gets the real
 * compiled catalog, loaded once and memoised.
 */
export function reviewModelSwitch(args: { entries: SessionStoreEntry[]; sidecarRecords: ProviderStateRecord[]; from: ContinuityEndpoint; to: ContinuityEndpoint; truncated?: boolean; catalog?: WinterCatalog }): SwitchReview {
  const sameProfile = args.from.providerId === args.to.providerId && args.from.modelKey === args.to.modelKey;
  if (sameProfile) return { prompt: false, skipped: "same-profile" };
  if (sameModelFamily(args.from, args.to, catalogFor(args.catalog))) return { prompt: false, skipped: "same-family" };

  const facts = switchFactsFor({ entries: args.entries, sidecarRecords: args.sidecarRecords, from: args.from });
  if (facts.sourceTurns === 0) return { prompt: false, skipped: "no-source-turns" };

  const classification = classifySwitch(args.from, args.to, { ...facts, ...(args.truncated === true ? { truncated: true } : {}) });
  return { prompt: classification.lossClass === "warned-lossy", classification };
}

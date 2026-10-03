// SDK 0.0.16 Lane C (P16-6): the `agent_listing_delta` attachment -- which `subagent_type` values the
// Agent tool can spawn, told to the model in claude's attachment format.
//
// 0.0.15 rendered the FULL listing into a live-request-only user-context block on every turn (plus a
// session-memory delta), under an extra Winter title line. claude instead PERSISTS the listing: its
// attachment scan (start of every turn, after every tool round) folds the `agent_listing_delta`
// attachments already in the post-compaction history, and emits a new one only when the available
// set differs from what they announced. The first one is the initial listing; later ones say what
// was added or removed; nothing is said on a turn where nothing changed; a resumed session sees its
// old entries and stays silent; a compaction that drops them re-announces from scratch.
//
// This module builds the tool spec, one listing line and the delta payload. The rendered text lives
// in context/attachments.ts with every other attachment's.
import type { ProviderMessage } from "../engine.ts";
import { announcedAgentTypes, type AgentListingDeltaAttachment } from "./attachments.ts";
import { neutralizeReminderTags } from "./injection.ts";

/**
 * One agent type this session may list -- already resolved and already FILTERED to what the caller
 * (depth gating, and the deny-rule / required-MCP filters another lane adds) wants advertised. This
 * module makes no filtering decision of its own.
 */
export interface AgentListingEntry {
  agentType: string;
  whenToUse: string;
  /**
   * claude's `whenToUseLean`, used instead of `whenToUse` when the session's model takes the lean
   * prompt. HOOK ONLY in this lane: the lean-model rule is another lane's, so `leanModel` below is
   * never true yet.
   */
  whenToUseLean?: string;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
}

/** The `(Tools: ...)` text for one agent type. */
export function renderAgentToolSpec(entry: Pick<AgentListingEntry, "tools" | "disallowedTools">): string {
  const tools = entry.tools ?? [];
  const disallowed = entry.disallowedTools ?? [];
  if (tools.length > 0 && disallowed.length > 0) {
    const kept = tools.filter((name) => !disallowed.includes(name));
    return kept.length === 0 ? "None" : kept.join(", ");
  }
  if (tools.length > 0) return tools.join(", ");
  if (disallowed.length > 0) return `All tools except ${disallowed.join(", ")}`;
  return "All tools";
}

/** One listing line: `- <type>: <whenToUse> (Tools: <spec>)`. */
export function renderAgentListingLine(entry: AgentListingEntry, leanModel = false): string {
  const lean = entry.whenToUseLean;
  const description = leanModel && typeof lean === "string" && lean.length > 0 ? lean : entry.whenToUse;
  return neutralizeReminderTags(`- ${entry.agentType}: ${description} (Tools: ${renderAgentToolSpec(entry)})`);
}

export interface AgentListingDeltaOptions {
  /** Whether the session's model takes the lean `whenToUse`. Another lane decides; `false` until then. */
  leanModel?: boolean;
  /** Whether the initial listing carries the concurrency sentence. Winter has neither a plan tier nor a UI mode, so `true`. */
  showConcurrencyNote?: boolean;
}

/**
 * The `agent_listing_delta` attachment this history needs now, or `undefined` when the available set
 * equals what `history` already announced. `history` is the engine's own message list, which after a
 * compaction is already the post-boundary slice.
 */
export function computeAgentListingDelta(available: readonly AgentListingEntry[], history: readonly ProviderMessage[], opts: AgentListingDeltaOptions = {}): AgentListingDeltaAttachment | undefined {
  const announced = announcedAgentTypes(history);
  const availableTypes = new Set(available.map((entry) => entry.agentType));
  const added = available.filter((entry) => !announced.has(entry.agentType));
  const removed = [...announced].filter((type) => !availableTypes.has(type));
  if (added.length === 0 && removed.length === 0) return undefined;
  // Added entries sort by locale order (Array.prototype.sort is stable); removed names by code units.
  const sortedAdded = [...added].sort((a, b) => a.agentType.localeCompare(b.agentType));
  const sortedRemoved = [...removed].sort();
  const lean = opts.leanModel === true;
  return {
    type: "agent_listing_delta",
    addedTypes: sortedAdded.map((entry) => entry.agentType),
    addedLines: sortedAdded.map((entry) => renderAgentListingLine(entry, lean)),
    removedTypes: sortedRemoved,
    isInitial: announced.size === 0,
    showConcurrencyNote: opts.showConcurrencyNote ?? true,
  };
}

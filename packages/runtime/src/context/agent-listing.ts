// SDK 0.0.16 Lane C (P16-6): the `agent_listing_delta` attachment -- which `subagent_type` values the
// Agent tool can spawn, told to the model the way claude 0.3.250 tells it.
//
// 0.0.15 rendered the FULL listing into a live-request-only user-context block on every turn (plus a
// session-memory delta), under an extra Winter title line. claude instead PERSISTS the listing: its
// attachment scan (start of every turn, after every tool round) folds the `agent_listing_delta`
// attachments already in the post-compaction history, and emits a new one only when the available
// set differs from what they announced. The first one is the initial listing; later ones say what
// was added or removed; nothing is said on a turn where nothing changed; a resumed session sees its
// old entries and stays silent; a compaction that drops them re-announces from scratch.
//
// Ported from the pinned binary: `SSn` (the tool spec), `hrt` (one line), `s1t` (the delta). The
// rendered text lives in context/attachments.ts with every other attachment's.
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

/**
 * claude's `SSn`, exactly: both lists present -> `tools` minus the disallowed ones (`None` when that
 * leaves nothing); only `tools` -> `tools` joined (so `["*"]` renders `*`); only `disallowedTools` ->
 * `All tools except …` in DECLARED order; neither -> `All tools`.
 */
export function renderAgentToolSpec(entry: Pick<AgentListingEntry, "tools" | "disallowedTools">): string {
  const tools = entry.tools ?? [];
  const disallowed = entry.disallowedTools ?? [];
  if (tools.length > 0 && disallowed.length > 0) {
    const denied = new Set(disallowed);
    const effective = tools.filter((t) => !denied.has(t));
    return effective.length === 0 ? "None" : effective.join(", ");
  }
  if (tools.length > 0) return tools.join(", ");
  if (disallowed.length > 0) return `All tools except ${disallowed.join(", ")}`;
  return "All tools";
}

/** claude's `hrt`: `- <type>: <whenToUse> (Tools: <spec>)`. */
export function renderAgentListingLine(entry: AgentListingEntry, leanModel = false): string {
  const whenToUse = (leanModel && entry.whenToUseLean) || entry.whenToUse;
  return neutralizeReminderTags(`- ${entry.agentType}: ${whenToUse} (Tools: ${renderAgentToolSpec(entry)})`);
}

export interface AgentListingDeltaOptions {
  /** claude's `Iu(mz(model))` -- whether the session's model takes the lean `whenToUse`. Another lane decides; `false` until then. */
  leanModel?: boolean;
  /** claude's `plan !== "pro" && mode === "default"`. Winter has neither a plan tier nor a UI mode, so `true`. */
  showConcurrencyNote?: boolean;
}

/**
 * claude's `s1t`: the `agent_listing_delta` attachment this history needs now, or `undefined` when
 * the available set equals what `history` already announced. `history` is the engine's own message
 * list, which after a compaction is already claude's post-boundary slice.
 */
export function computeAgentListingDelta(available: readonly AgentListingEntry[], history: readonly ProviderMessage[], opts: AgentListingDeltaOptions = {}): AgentListingDeltaAttachment | undefined {
  const announced = announcedAgentTypes(history);
  const availableTypes = new Set(available.map((e) => e.agentType));
  const added = available.filter((e) => !announced.has(e.agentType));
  const removed: string[] = [];
  for (const type of announced) if (!availableTypes.has(type)) removed.push(type);
  if (added.length === 0 && removed.length === 0) return undefined;
  added.sort((a, b) => a.agentType.localeCompare(b.agentType));
  // claude sorts the removed names with the DEFAULT comparator (code-unit order), not localeCompare.
  removed.sort();
  return {
    type: "agent_listing_delta",
    addedTypes: added.map((e) => e.agentType),
    addedLines: added.map((e) => renderAgentListingLine(e, opts.leanModel === true)),
    removedTypes: removed,
    isInitial: announced.size === 0,
    showConcurrencyNote: opts.showConcurrencyNote ?? true,
  };
}

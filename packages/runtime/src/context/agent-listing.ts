// Spawn-surface parity (research §A3, scope item 3): the `agent_listing_delta`-equivalent block --
// the user-context attachment that tells the model WHICH `subagent_type` values actually exist this
// session, closing the root failure this whole lane exists for (a model guessing `general`/
// `explorer` because Winter listed no built-ins anywhere).
//
// PURE AND STATELESS BY DESIGN, matching `context/seam.ts`'s own documented posture for everything
// `SystemPromptInput` carries ("a PLAIN DATA snapshot... an assembler is trivially testable from a
// literal"). The "first listing gets the concurrency sentence" / "a later listing is a delta"
// distinction therefore does NOT live in a closure here -- the CALLER (an L2b integration point in
// engine.ts, which already tracks per-session mutable state like `currentAdvertisedCanonicalNames`)
// tracks the PRIOR agentType set across turns and passes it in as `prior`; omitting it means "this is
// the first listing this session has ever produced."

/** One row this session may render into the listing -- already RESOLVED and already FILTERED to what this particular caller (depth-gating, MCP-requirement, deny-rule filtering -- research §A3's own three filters, R-S8 defers the latter two) actually wants advertised. This module makes no filtering decision of its own. */
export interface AgentListingEntry {
  agentType: string;
  whenToUse: string;
  /** `undefined` or exactly `["*"]` = unrestricted (renders "All tools"). */
  tools?: readonly string[];
  disallowedTools?: readonly string[];
}

export interface AgentListingResult {
  /** `undefined` = nothing to inject this turn (not the first listing, and the agentType SET is unchanged from `prior`). A caller must not push an empty/redundant block onto `userContextBlocks`. */
  text: string | undefined;
  /** The agentType set THIS render saw, sorted -- the caller's own next `prior`. */
  agentTypes: string[];
}

const CONCURRENCY_SENTENCE = "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";

/**
 * research §A3's own `<spec>` rendering: `tools ∖ disallowed` | "None" | `tools.join(", ")` |
 * "All tools except X, Y" | "All tools" (a `["*"]`/absent `tools` is the "unrestricted" case).
 * `disallowedTools` is rendered SORTED (localeCompare) in the "except" form since it is describing a
 * SET of exclusions, not a declared, order-meaningful list the way `tools` itself is; the restricted
 * (non-wildcard) form preserves the DEFINITION's own declared tool order, minus whatever the
 * subtraction removes, since `tools.join(", ")` is literally what an unrestricted list renders as.
 */
function renderToolSpec(entry: Pick<AgentListingEntry, "tools" | "disallowedTools">): string {
  const disallowed = entry.disallowedTools ?? [];
  const isUnrestricted = entry.tools === undefined || (entry.tools.length === 1 && entry.tools[0] === "*");
  if (isUnrestricted) {
    if (disallowed.length === 0) return "All tools";
    return `All tools except ${[...disallowed].sort((a, b) => a.localeCompare(b)).join(", ")}`;
  }
  const disallowedSet = new Set(disallowed);
  const effective = entry.tools!.filter((t) => !disallowedSet.has(t));
  if (effective.length === 0) return "None";
  return effective.join(", ");
}

function renderRow(entry: AgentListingEntry): string {
  return `- ${entry.agentType}: ${entry.whenToUse} (Tools: ${renderToolSpec(entry)})`;
}

/**
 * `renderAgentListing`: the ONE producer of the listing text. `prior` omitted (or the FIRST call of a
 * session) renders the FULL "Available agent types for the Agent tool:" block plus the concurrency
 * sentence (research §A3: "First listing adds..."); a later call with `prior` renders only the DELTA
 * -- an "added" block, a "removed" block, both, or neither (`text: undefined` when the set is
 * unchanged).
 */
export function renderAgentListing(defs: readonly AgentListingEntry[], prior?: readonly string[]): AgentListingResult {
  const sorted = [...defs].sort((a, b) => a.agentType.localeCompare(b.agentType));
  const agentTypes = sorted.map((d) => d.agentType);

  if (prior === undefined) {
    const lines = ["Available agent types for the Agent tool:", ...sorted.map(renderRow), "", CONCURRENCY_SENTENCE];
    return { text: lines.join("\n"), agentTypes };
  }

  const priorSet = new Set(prior);
  const currentSet = new Set(agentTypes);
  const added = sorted.filter((d) => !priorSet.has(d.agentType));
  const removedNames = [...priorSet].filter((name) => !currentSet.has(name)).sort((a, b) => a.localeCompare(b));

  const blocks: string[] = [];
  if (added.length > 0) blocks.push(["New agent types are now available for the Agent tool:", ...added.map(renderRow)].join("\n"));
  if (removedNames.length > 0) blocks.push(["The following agent types are no longer available:", ...removedNames.map((name) => `- ${name}`)].join("\n"));

  return { text: blocks.length > 0 ? blocks.join("\n\n") : undefined, agentTypes };
}

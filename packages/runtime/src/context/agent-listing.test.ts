import { describe, test, expect } from "bun:test";
import { renderAgentListing, type AgentListingEntry } from "./agent-listing.ts";

const explore: AgentListingEntry = { agentType: "Explore", whenToUse: "Fast read-only search.", disallowedTools: ["Agent", "Edit", "Write"] };
const generalPurpose: AgentListingEntry = { agentType: "general-purpose", whenToUse: "General-purpose agent.", tools: ["*"] };
const claude: AgentListingEntry = { agentType: "claude", whenToUse: "Catch-all.", tools: ["*"] };
const statusline: AgentListingEntry = { agentType: "statusline-setup", whenToUse: "Configures the status line.", tools: ["Read", "Edit"] };

describe("renderAgentListing -- first listing (no prior)", () => {
  test("header, sorted rows, blank line, concurrency sentence", () => {
    const result = renderAgentListing([claude, explore, generalPurpose]);
    expect(result.text).toBe(
      [
        "Available agent types for the Agent tool:",
        "- claude: Catch-all. (Tools: All tools)",
        "- Explore: Fast read-only search. (Tools: All tools except Agent, Edit, Write)",
        "- general-purpose: General-purpose agent. (Tools: All tools)",
        "",
        "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.",
      ].join("\n"),
    );
  });

  test("returns the sorted agentTypes for the caller to persist as the next prior", () => {
    const result = renderAgentListing([claude, explore, generalPurpose]);
    expect(result.agentTypes).toEqual(["claude", "Explore", "general-purpose"]);
  });

  test("sorting is by agentType, localeCompare (case-folded collation, not raw codepoint)", () => {
    // 'claude' < 'Explore' under localeCompare's default case-insensitive-ish collation (c before e),
    // which differs from a plain codepoint sort where every uppercase letter sorts before every
    // lowercase one (that would put 'Explore' first regardless of the rest of the word).
    expect("claude".localeCompare("Explore")).toBeLessThan(0);
    expect(renderAgentListing([explore, claude]).agentTypes).toEqual(["claude", "Explore"]);
  });

  test("an empty definitions set still renders the header + concurrency sentence, no rows", () => {
    const result = renderAgentListing([]);
    expect(result.text).toBe(["Available agent types for the Agent tool:", "", "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently."].join("\n"));
    expect(result.agentTypes).toEqual([]);
  });

  test("tool spec forms: restricted list (tools ∖ disallowed), and None when every tool is disallowed", () => {
    const restricted: AgentListingEntry = { agentType: "reviewer", whenToUse: "Reviews.", tools: ["Read", "Grep", "Bash"], disallowedTools: ["Bash"] };
    expect(renderAgentListing([restricted]).text).toContain("(Tools: Read, Grep)");

    const none: AgentListingEntry = { agentType: "muted", whenToUse: "Nothing to do.", tools: ["Read"], disallowedTools: ["Read"] };
    expect(renderAgentListing([none]).text).toContain("(Tools: None)");
  });

  test("a plain tools list with no disallowedTools renders tools.join(', ') as-is", () => {
    expect(renderAgentListing([statusline]).text).toContain("(Tools: Read, Edit)");
  });
});

describe("renderAgentListing -- delta wording (prior given)", () => {
  test("no change at all -> text is undefined (never a redundant re-listing)", () => {
    const first = renderAgentListing([explore, claude]);
    const second = renderAgentListing([claude, explore], first.agentTypes);
    expect(second.text).toBeUndefined();
    expect(second.agentTypes).toEqual(first.agentTypes);
  });

  test("an addition renders the 'now available' block, only for the new entries", () => {
    const first = renderAgentListing([claude]);
    const second = renderAgentListing([claude, explore], first.agentTypes);
    expect(second.text).toBe(["New agent types are now available for the Agent tool:", "- Explore: Fast read-only search. (Tools: All tools except Agent, Edit, Write)"].join("\n"));
  });

  test("a removal renders the 'no longer available' block, names only", () => {
    const first = renderAgentListing([claude, explore]);
    const second = renderAgentListing([claude], first.agentTypes);
    expect(second.text).toBe(["The following agent types are no longer available:", "- Explore"].join("\n"));
  });

  test("simultaneous addition and removal renders both blocks, separated by a blank line", () => {
    const first = renderAgentListing([claude, explore]);
    const second = renderAgentListing([claude, generalPurpose], first.agentTypes);
    expect(second.text).toBe(
      [
        "New agent types are now available for the Agent tool:",
        "- general-purpose: General-purpose agent. (Tools: All tools)",
        "",
        "The following agent types are no longer available:",
        "- Explore",
      ].join("\n"),
    );
  });

  test("an empty prior (first listing produced zero agents) is still a real 'prior', not treated as omitted", () => {
    const second = renderAgentListing([claude], []);
    expect(second.text).toBe(["New agent types are now available for the Agent tool:", "- claude: Catch-all. (Tools: All tools)"].join("\n"));
  });
});

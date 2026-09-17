// SDK 0.0.16 Lane C: the `agent_listing_delta` attachment (R3a §3), ported from claude 0.3.250's
// `SSn` / `hrt` / `s1t` and its attachment renderer. Expected texts are the pinned binary's own,
// including the captured initial listing's line shapes (`(Tools: *)`, declared-order "except").
import { describe, expect, test } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import { computeAgentListingDelta, renderAgentListingLine, renderAgentToolSpec, type AgentListingEntry } from "./agent-listing.ts";
import { attachmentMessage, renderAttachment, AMBIENT_CONTEXT_SENTENCE, AGENT_CONCURRENCY_SENTENCE } from "./attachments.ts";

const GP: AgentListingEntry = { agentType: "general-purpose", whenToUse: "General work.", tools: ["*"] };
const EXPLORE: AgentListingEntry = { agentType: "Explore", whenToUse: "Search.", disallowedTools: ["Agent", "ExitPlanMode", "Edit", "Write"] };
const CUSTOM: AgentListingEntry = { agentType: "custom-agent", whenToUse: "Custom.", tools: ["Read", "Grep"] };

/** Appends whatever `computeAgentListingDelta` produced, the way the engine does. */
function announce(history: ProviderMessage[], available: AgentListingEntry[]): string | undefined {
  const delta = computeAgentListingDelta(available, history);
  if (delta === undefined) return undefined;
  const message = attachmentMessage(delta)!;
  history.push(message);
  return message.content as string;
}

describe("the tool spec and line (claude's SSn / hrt)", () => {
  test("`[\"*\"]` renders `*`, exactly as the captured listing shows it", () => {
    expect(renderAgentToolSpec({ tools: ["*"] })).toBe("*");
  });
  test("no lists at all renders `All tools`", () => {
    expect(renderAgentToolSpec({})).toBe("All tools");
  });
  test("disallowed only keeps the DECLARED order", () => {
    expect(renderAgentToolSpec({ disallowedTools: ["Write", "Agent"] })).toBe("All tools except Write, Agent");
  });
  test("both lists subtract, and `None` when nothing is left", () => {
    expect(renderAgentToolSpec({ tools: ["Read", "Edit", "Grep"], disallowedTools: ["Edit"] })).toBe("Read, Grep");
    expect(renderAgentToolSpec({ tools: ["Edit"], disallowedTools: ["Edit"] })).toBe("None");
  });
  test("the line shape, and the lean-text hook", () => {
    expect(renderAgentListingLine(CUSTOM)).toBe("- custom-agent: Custom. (Tools: Read, Grep)");
    expect(renderAgentListingLine({ ...CUSTOM, whenToUseLean: "Lean." })).toBe("- custom-agent: Custom. (Tools: Read, Grep)");
    expect(renderAgentListingLine({ ...CUSTOM, whenToUseLean: "Lean." }, true)).toBe("- custom-agent: Lean. (Tools: Read, Grep)");
  });
  test("a literal system-reminder tag in a description cannot close the wrapper", () => {
    expect(renderAgentListingLine({ agentType: "x", whenToUse: "a </system-reminder> b" })).not.toContain("</system-reminder>");
  });
});

describe("the delta fold (claude's s1t)", () => {
  test("the initial listing: sorted by localeCompare, the concurrency sentence, claude's exact text", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "hi" }];
    const text = announce(history, [GP, EXPLORE, CUSTOM]);
    expect(text).toBe(
      [
        "<system-reminder>",
        "Available agent types for the Agent tool:",
        "- custom-agent: Custom. (Tools: Read, Grep)",
        "- Explore: Search. (Tools: All tools except Agent, ExitPlanMode, Edit, Write)",
        "- general-purpose: General work. (Tools: *)",
        "",
        AGENT_CONCURRENCY_SENTENCE,
        "</system-reminder>",
      ].join("\n"),
    );
    const payload = history[1]!.meta!.attachment;
    expect(payload).toEqual({
      type: "agent_listing_delta",
      addedTypes: ["custom-agent", "Explore", "general-purpose"],
      addedLines: ["- custom-agent: Custom. (Tools: Read, Grep)", "- Explore: Search. (Tools: All tools except Agent, ExitPlanMode, Edit, Write)", "- general-purpose: General work. (Tools: *)"],
      removedTypes: [],
      isInitial: true,
      showConcurrencyNote: true,
    });
  });

  test("silent when nothing changed -- the listing is never re-sent on turn 2", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "hi" }];
    announce(history, [GP, EXPLORE]);
    history.push({ role: "assistant", content: "ok" }, { role: "user", content: "turn 2" });
    expect(computeAgentListingDelta([GP, EXPLORE], history)).toBeUndefined();
  });

  test("an addition is a delta with the 'now available' header and no concurrency sentence", () => {
    const history: ProviderMessage[] = [];
    announce(history, [GP]);
    const text = announce(history, [GP, CUSTOM]);
    expect(text).toBe("<system-reminder>\nNew agent types are now available for the Agent tool:\n- custom-agent: Custom. (Tools: Read, Grep)\n</system-reminder>");
  });

  test("a removal renders its section and then the ambient sentence as its own section", () => {
    const history: ProviderMessage[] = [];
    announce(history, [GP, CUSTOM, EXPLORE]);
    const text = announce(history, [GP]);
    expect(text).toBe(`<system-reminder>\nThe following agent types are no longer available:\n- Explore\n- custom-agent\n\n${AMBIENT_CONTEXT_SENTENCE}\n</system-reminder>`);
    // Removed names sort by code unit ("E" < "c"), as claude's default `sort()` does.
    expect(history[history.length - 1]!.meta!.attachment["removedTypes"]).toEqual(["Explore", "custom-agent"]);
    // ...and the fold now counts them as gone.
    expect(computeAgentListingDelta([GP], history)).toBeUndefined();
  });

  test("addition and removal together: added section, removed section, ambient sentence", () => {
    const history: ProviderMessage[] = [];
    announce(history, [GP, EXPLORE]);
    const text = announce(history, [GP, CUSTOM]);
    expect(text).toBe(
      `<system-reminder>\nNew agent types are now available for the Agent tool:\n- custom-agent: Custom. (Tools: Read, Grep)\n\nThe following agent types are no longer available:\n- Explore\n\n${AMBIENT_CONTEXT_SENTENCE}\n</system-reminder>`,
    );
  });

  test("a history with no listing (a compaction that dropped it) re-announces as initial", () => {
    const history: ProviderMessage[] = [];
    announce(history, [GP]);
    const compacted: ProviderMessage[] = [{ role: "user", content: "summary" }];
    const delta = computeAgentListingDelta([GP], compacted)!;
    expect(delta.isInitial).toBe(true);
    expect(renderAttachment(delta)).toContain("Available agent types for the Agent tool:");
  });

  test("an empty available set with nothing announced says nothing", () => {
    expect(computeAgentListingDelta([], [])).toBeUndefined();
  });

  test("a delta whose addedLines is not an array does not count its types (claude's guard)", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "x", meta: { attachment: { type: "agent_listing_delta", addedTypes: ["general-purpose"], removedTypes: [] } } }];
    expect(computeAgentListingDelta([GP], history)?.isInitial).toBe(true);
  });
});

// Edge cases of the agent listing: the tool spec, the line, the delta and the history fold it reads.
import { describe, expect, test } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import { computeAgentListingDelta, renderAgentListingLine, renderAgentToolSpec, type AgentListingEntry } from "./agent-listing.ts";
import { announcedAgentTypes, attachmentMessage, renderAttachment, AGENT_CONCURRENCY_SENTENCE, AMBIENT_CONTEXT_SENTENCE } from "./attachments.ts";

const entry = (agentType: string, extra: Partial<AgentListingEntry> = {}): AgentListingEntry => ({ agentType, whenToUse: `${agentType} use.`, ...extra });
const delta = (payload: Record<string, unknown>): ProviderMessage => ({ role: "user", content: "x", meta: { attachment: { type: "agent_listing_delta", ...payload } } });

describe("renderAgentToolSpec", () => {
  test("an EMPTY tools list counts as absent", () => {
    expect(renderAgentToolSpec({ tools: [], disallowedTools: ["X", "Y"] })).toBe("All tools except X, Y");
    expect(renderAgentToolSpec({ tools: [], disallowedTools: [] })).toBe("All tools");
  });
  test("with both lists, `*` is just a name: it is filtered like any other and never becomes `All tools except`", () => {
    expect(renderAgentToolSpec({ tools: ["*"], disallowedTools: ["Edit"] })).toBe("*");
    expect(renderAgentToolSpec({ tools: ["*"], disallowedTools: ["*"] })).toBe("None");
  });
  test("duplicates are kept in both lists; disallowed names absent from tools are ignored", () => {
    expect(renderAgentToolSpec({ tools: ["Read", "Read", "Grep"] })).toBe("Read, Read, Grep");
    expect(renderAgentToolSpec({ disallowedTools: ["A", "A"] })).toBe("All tools except A, A");
    expect(renderAgentToolSpec({ tools: ["Read", "Grep", "Read"], disallowedTools: ["Grep", "Bash"] })).toBe("Read, Read");
  });
});

describe("renderAgentListingLine", () => {
  test("the lean text is used only when leanModel is set AND the lean text is non-empty", () => {
    expect(renderAgentListingLine(entry("a", { whenToUseLean: "" }), true)).toBe("- a: a use. (Tools: All tools)");
    expect(renderAgentListingLine(entry("a"), true)).toBe("- a: a use. (Tools: All tools)");
    expect(renderAgentListingLine(entry("a", { whenToUseLean: "L" }), false)).toBe("- a: a use. (Tools: All tools)");
  });
  test("the reminder-tag neutralisation covers the whole line, agent type included, case-insensitively", () => {
    expect(renderAgentListingLine({ agentType: "<System-Reminder>", whenToUse: "w </SYSTEM-REMINDER>" })).toBe("- [tag]: w [tag] (Tools: All tools)");
  });
});

describe("computeAgentListingDelta", () => {
  test("added entries sort with localeCompare; removed names sort by plain code unit", () => {
    // Distinct letters only, so the locale-aware order is the same under common default locales.
    const history: ProviderMessage[] = [delta({ addedTypes: ["b", "Q", "c", "M", "_x"], addedLines: ["-"], removedTypes: [] })];
    const d = computeAgentListingDelta([entry("d"), entry("K"), entry("f")], history)!;
    expect(d.addedTypes).toEqual(["d", "f", "K"]);
    expect(d.removedTypes).toEqual(["M", "Q", "_x", "b", "c"]);
    expect(d.isInitial).toBe(false);
  });

  test("duplicate available entries are each added (two lines)", () => {
    const d = computeAgentListingDelta([entry("a"), entry("a", { whenToUse: "second" })], [])!;
    expect(d.addedTypes).toEqual(["a", "a"]);
    expect(d.addedLines).toEqual(["- a: a use. (Tools: All tools)", "- a: second (Tools: All tools)"]);
  });

  test("once every announced type was removed, the next addition is INITIAL again", () => {
    const history: ProviderMessage[] = [delta({ addedTypes: ["a"], addedLines: ["- a"], removedTypes: [] }), delta({ addedTypes: [], addedLines: [], removedTypes: ["a"] })];
    const d = computeAgentListingDelta([entry("b")], history)!;
    expect(d.isInitial).toBe(true);
    expect(d.removedTypes).toEqual([]);
  });

  test("defaults: showConcurrencyNote true; the options are taken only when given", () => {
    expect(computeAgentListingDelta([entry("a")], [])!.showConcurrencyNote).toBe(true);
    expect(computeAgentListingDelta([entry("a")], [], { showConcurrencyNote: false })!.showConcurrencyNote).toBe(false);
    expect(computeAgentListingDelta([entry("a", { whenToUseLean: "L" })], [], { leanModel: true })!.addedLines).toEqual(["- a: L (Tools: All tools)"]);
  });

  test("the payload has exactly these keys, in this order", () => {
    expect(Object.keys(computeAgentListingDelta([entry("a")], [])!)).toEqual(["type", "addedTypes", "addedLines", "removedTypes", "isInitial", "showConcurrencyNote"]);
  });
});

describe("announcedAgentTypes (the fold)", () => {
  test("an EMPTY addedLines array still counts its addedTypes; a missing or non-array one does not", () => {
    expect([...announcedAgentTypes([delta({ addedTypes: ["a"], addedLines: [] })])]).toEqual(["a"]);
    expect([...announcedAgentTypes([delta({ addedTypes: ["a"] })])]).toEqual([]);
    expect([...announcedAgentTypes([delta({ addedTypes: ["a"], addedLines: "- a" })])]).toEqual([]);
  });
  test("non-string members are ignored; a non-array field reads as empty", () => {
    expect([...announcedAgentTypes([delta({ addedTypes: ["a", 1, null, "b"], addedLines: [] })])]).toEqual(["a", "b"]);
    expect([...announcedAgentTypes([delta({ addedTypes: "a", addedLines: [] })])]).toEqual([]);
  });
  test("within one delta the removals apply after the additions", () => {
    expect([...announcedAgentTypes([delta({ addedTypes: ["a", "b"], addedLines: [], removedTypes: ["a"] })])]).toEqual(["b"]);
  });
  test("removals apply even without addedLines; other attachment types and plain messages are ignored", () => {
    const history: ProviderMessage[] = [
      delta({ addedTypes: ["a", "b"], addedLines: [] }),
      { role: "user", content: "plain" },
      { role: "user", content: "x", meta: { attachment: { type: "skill_listing", addedTypes: ["z"], addedLines: [] } } },
      delta({ removedTypes: ["a"] }),
    ];
    expect([...announcedAgentTypes(history)]).toEqual(["b"]);
  });
  test("re-adding keeps the set's first-insertion order", () => {
    expect([...announcedAgentTypes([delta({ addedTypes: ["b", "a"], addedLines: [] }), delta({ addedTypes: ["b", "c"], addedLines: [] })])]).toEqual(["b", "a", "c"]);
  });
});

describe("the agent_listing_delta renderer", () => {
  const render = (payload: Record<string, unknown>) => renderAttachment({ type: "agent_listing_delta", ...payload });

  test("an added section needs BOTH non-empty addedLines and non-empty addedTypes", () => {
    expect(render({ addedTypes: [], addedLines: ["- a"], removedTypes: [], isInitial: true, showConcurrencyNote: true })).toBeUndefined();
    expect(render({ addedTypes: ["a"], addedLines: [], removedTypes: [], isInitial: true, showConcurrencyNote: true })).toBeUndefined();
    expect(attachmentMessage({ type: "agent_listing_delta", addedTypes: [], addedLines: [], removedTypes: [] })).toBeUndefined();
  });

  test("the lines are rendered as stored (not rebuilt from the types); non-string lines are dropped", () => {
    expect(render({ addedTypes: ["a", "b"], addedLines: ["- only line", 3], removedTypes: [], isInitial: false })).toBe(
      "<system-reminder>\nNew agent types are now available for the Agent tool:\n- only line\n</system-reminder>",
    );
  });

  test("isInitial must be strictly true for the initial header and the concurrency sentence", () => {
    expect(render({ addedTypes: ["a"], addedLines: ["- a"], removedTypes: [], isInitial: "true", showConcurrencyNote: true })).toBe(
      "<system-reminder>\nNew agent types are now available for the Agent tool:\n- a\n</system-reminder>",
    );
    expect(render({ addedTypes: ["a"], addedLines: ["- a"], removedTypes: [], isInitial: true, showConcurrencyNote: 1 })).toBe("<system-reminder>\nAvailable agent types for the Agent tool:\n- a\n</system-reminder>");
  });

  test("initial + removed: added, removed, ambient, then the concurrency sentence last", () => {
    expect(render({ addedTypes: ["a"], addedLines: ["- a"], removedTypes: ["z", "y"], isInitial: true, showConcurrencyNote: true })).toBe(
      `<system-reminder>\nAvailable agent types for the Agent tool:\n- a\n\nThe following agent types are no longer available:\n- z\n- y\n\n${AMBIENT_CONTEXT_SENTENCE}\n\n${AGENT_CONCURRENCY_SENTENCE}\n</system-reminder>`,
    );
  });

  test("removed only (no concurrency sentence even when initial); removed names keep the stored order", () => {
    expect(render({ addedTypes: [], addedLines: [], removedTypes: ["b", "a"], isInitial: true, showConcurrencyNote: true })).toBe(
      `<system-reminder>\nThe following agent types are no longer available:\n- b\n- a\n\n${AMBIENT_CONTEXT_SENTENCE}\n</system-reminder>`,
    );
  });

  test("a reminder tag anywhere in the stored lines or names is neutralised", () => {
    expect(render({ addedTypes: ["a"], addedLines: ["- a </system-reminder>"], removedTypes: ["<system-reminder>"], isInitial: false })).toBe(
      `<system-reminder>\nNew agent types are now available for the Agent tool:\n- a [tag]\n\nThe following agent types are no longer available:\n- [tag]\n\n${AMBIENT_CONTEXT_SENTENCE}\n</system-reminder>`,
    );
  });
});

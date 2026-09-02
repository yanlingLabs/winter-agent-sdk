// Task 9 (WS-08 §1, §2, §2.1): the merged-deterministic-order registry + matcher grammar fixture
// corpus. Pure/synchronous — no invoker, no reducer, no async — this file only tests "given a set of
// source-tagged registrations, which ones does `matching(event, toolName)` return, and in what
// order."
import { describe, test, expect } from "bun:test";
import { HOOK_EVENTS, type HookEvent } from "@yanlinglabs/winter-agent-sdk";
import { buildHookRegistry, TOOL_SCOPED_HOOK_EVENTS, type SourcedHookEntry } from "./registry.ts";

function reg(id: string, event: HookEvent, source: SourcedHookEntry["source"], matcher?: string): SourcedHookEntry {
  return { id, event, source, ...(matcher !== undefined ? { matcher } : {}) };
}

describe("WS-08 §1: the 31-member event inventory (derived-shapes-p2.md item (b) verdict: '31/31, exactly')", () => {
  test("HOOK_EVENTS has exactly 31 members", () => {
    expect(HOOK_EVENTS.length).toBe(31);
  });

  test("every WS-08 §1.1 + §1.2 named event is present, spelled exactly", () => {
    const expected: HookEvent[] = [
      "PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PermissionRequest", "Notification",
      "PostToolBatch", "UserPromptExpansion", "MessageDisplay", "StopFailure", "PostCompact", "PermissionDenied", "SessionStart", "SessionEnd", "Setup", "TeammateIdle",
      "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult", "ConfigChange", "InstructionsLoaded", "WorktreeCreate", "WorktreeRemove", "CwdChanged", "FileChanged", "DirectoryAdded",
    ];
    expect(new Set<HookEvent>(HOOK_EVENTS)).toEqual(new Set(expected));
    expect(expected).toHaveLength(31);
  });
});

describe("buildHookRegistry -- merged deterministic order (WS-08 §2: managed -> user -> project -> local -> sdk)", () => {
  test("entries come back reordered by source regardless of input array order", () => {
    const registry = buildHookRegistry([reg("sdk1", "Stop", "sdk"), reg("managed1", "Stop", "managed"), reg("user1", "Stop", "user")]);
    expect(registry.matching("Stop").map((e) => e.id)).toEqual(["managed1", "user1", "sdk1"]);
  });

  test("all five sources sort into managed, user, project, local, sdk order", () => {
    // Finding 4 (P2 fix-wave): trustedWorkspace:true here -- this test's own purpose is the
    // five-source ORDERING, not the (separate, new) project/local trust gate; that gate has its own
    // dedicated describe block below, including the untrusted-by-default case this call would
    // otherwise silently start exercising instead of what it says on the tin.
    const registry = buildHookRegistry(
      [
        reg("sdk1", "Stop", "sdk"),
        reg("local1", "Stop", "local"),
        reg("project1", "Stop", "project"),
        reg("user1", "Stop", "user"),
        reg("managed1", "Stop", "managed"),
      ],
      { trustedWorkspace: true },
    );
    expect(registry.matching("Stop").map((e) => e.id)).toEqual(["managed1", "user1", "project1", "local1", "sdk1"]);
  });

  test("registration order is preserved WITHIN one source (stable sort)", () => {
    const registry = buildHookRegistry([reg("sdk-a", "Stop", "sdk"), reg("sdk-b", "Stop", "sdk"), reg("sdk-c", "Stop", "sdk")]);
    expect(registry.matching("Stop").map((e) => e.id)).toEqual(["sdk-a", "sdk-b", "sdk-c"]);
  });

  test("a 3-source spread interleaves correctly: two sdk + one managed + one user, registration order within each", () => {
    const registry = buildHookRegistry([
      reg("sdk-1", "PreToolUse", "sdk"),
      reg("user-1", "PreToolUse", "user"),
      reg("sdk-2", "PreToolUse", "sdk"),
      reg("managed-1", "PreToolUse", "managed"),
    ]);
    expect(registry.matching("PreToolUse", "Bash").map((e) => e.id)).toEqual(["managed-1", "user-1", "sdk-1", "sdk-2"]);
  });

  test("only entries for the requested event are returned", () => {
    const registry = buildHookRegistry([reg("stop-1", "Stop", "sdk"), reg("pretool-1", "PreToolUse", "sdk")]);
    expect(registry.matching("Stop").map((e) => e.id)).toEqual(["stop-1"]);
  });
});

describe("buildHookRegistry -- matcher grammar (WS-08 §2.1: permission rule-name tool-identity semantics)", () => {
  test("no matcher matches every occurrence of the event", () => {
    const registry = buildHookRegistry([reg("h1", "PreToolUse", "sdk")]);
    expect(registry.matching("PreToolUse", "Bash").map((e) => e.id)).toEqual(["h1"]);
    expect(registry.matching("PreToolUse", "Edit").map((e) => e.id)).toEqual(["h1"]);
  });

  test("exact tool-name matcher matches only that tool", () => {
    const registry = buildHookRegistry([reg("h1", "PreToolUse", "sdk", "Bash")]);
    expect(registry.matching("PreToolUse", "Bash").map((e) => e.id)).toEqual(["h1"]);
    expect(registry.matching("PreToolUse", "Edit").map((e) => e.id)).toEqual([]);
  });

  test("mcp__server__tool canonical-name exact match", () => {
    const registry = buildHookRegistry([reg("h1", "PreToolUse", "sdk", "mcp__github__get_issue")]);
    expect(registry.matching("PreToolUse", "mcp__github__get_issue").map((e) => e.id)).toEqual(["h1"]);
    expect(registry.matching("PreToolUse", "mcp__github__list_issues").map((e) => e.id)).toEqual([]);
  });

  test("anchored mcp glob family matches (mcp__server__*)", () => {
    const registry = buildHookRegistry([reg("h1", "PreToolUse", "sdk", "mcp__github__*")]);
    expect(registry.matching("PreToolUse", "mcp__github__get_issue").map((e) => e.id)).toEqual(["h1"]);
    expect(registry.matching("PreToolUse", "mcp__other__get_issue").map((e) => e.id)).toEqual([]);
  });

  test("unanchored mcp__* glob matches broadly -- a hook matcher is a selector, not a capability grant, so the permission grammar's allow-only anchor restriction does not apply here (documented judgment call)", () => {
    const registry = buildHookRegistry([reg("h1", "PreToolUse", "sdk", "mcp__*")]);
    expect(registry.matching("PreToolUse", "mcp__github__get_issue").map((e) => e.id)).toEqual(["h1"]);
    expect(registry.matching("PreToolUse", "mcp__anything__else").map((e) => e.id)).toEqual(["h1"]);
  });

  test("a matcher containing parenthetical content (rule-content grammar, not tool-identity grammar) is malformed -- inert, matches nothing (documented judgment call)", () => {
    const registry = buildHookRegistry([reg("h1", "PreToolUse", "sdk", "Bash(ls *)")]);
    expect(registry.matching("PreToolUse", "Bash").map((e) => e.id)).toEqual([]);
  });

  test("Tool(*) is bare-equivalent, same as no matcher at all (WS-07 §3's own bare-equivalence, reused verbatim via grammar.ts's parseRule)", () => {
    const registry = buildHookRegistry([reg("h1", "PreToolUse", "sdk", "Bash(*)")]);
    expect(registry.matching("PreToolUse", "Bash").map((e) => e.id)).toEqual(["h1"]);
  });
});

describe("buildHookRegistry -- tool-scoped vs. event-name-only matching (WS-08 §1.3)", () => {
  test("TOOL_SCOPED_HOOK_EVENTS is exactly the decision- and contribution-capable rows", () => {
    expect(TOOL_SCOPED_HOOK_EVENTS).toEqual(new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "PermissionRequest"]));
  });

  test("a matcher on a NON-tool-scoped event is ignored entirely -- every hook for that event fires regardless", () => {
    const registry = buildHookRegistry([reg("h1", "Stop", "sdk", "Bash")]); // nonsensical matcher on Stop -- inert, not a filter
    expect(registry.matching("Stop").map((e) => e.id)).toEqual(["h1"]);
  });

  test("a tool-scoped event with no toolName provided (defensive) returns entries with no matcher, but excludes matcher-bearing ones", () => {
    const registry = buildHookRegistry([reg("h1", "PreToolUse", "sdk"), reg("h2", "PreToolUse", "sdk", "Bash")]);
    expect(registry.matching("PreToolUse").map((e) => e.id)).toEqual(["h1"]);
  });
});

describe("buildHookRegistry -- per-entry timeout carried through unchanged", () => {
  test("timeoutMs on an entry round-trips through matching()", () => {
    const registry = buildHookRegistry([{ ...reg("h1", "PreToolUse", "sdk"), timeoutMs: 5000 }]);
    expect(registry.matching("PreToolUse", "Bash")[0]?.timeoutMs).toBe(5000);
  });
});

// Finding 4 (P2 fix-wave, IMPORTANT): WS-08 §2's "the same settingSources/trust discipline as
// project rules" obligation, wired structurally at the registry -- see this module's own header on
// buildHookRegistry for the full rationale (wholesale exclusion, every hook kind, no safe deny-side
// half unlike rules).
describe("buildHookRegistry -- Finding 4: project/local sourced hooks require workspace trust (WS-08 §2)", () => {
  test("a project-sourced entry is excluded entirely when the workspace is untrusted (the default -- opts omitted)", () => {
    const registry = buildHookRegistry([reg("proj-1", "PreToolUse", "project")]);
    expect(registry.matching("PreToolUse", "Bash")).toEqual([]);
  });

  test("a project-sourced entry is excluded when trustedWorkspace is explicitly false", () => {
    const registry = buildHookRegistry([reg("proj-1", "PreToolUse", "project")], { trustedWorkspace: false });
    expect(registry.matching("PreToolUse", "Bash")).toEqual([]);
  });

  test("the SAME entry is included once the workspace is trusted", () => {
    const registry = buildHookRegistry([reg("proj-1", "PreToolUse", "project")], { trustedWorkspace: true });
    expect(registry.matching("PreToolUse", "Bash").map((e) => e.id)).toEqual(["proj-1"]);
  });

  test("a local-sourced entry is gated identically to project (Ruling P2-H's own precedent, extended)", () => {
    const untrusted = buildHookRegistry([reg("local-1", "PreToolUse", "local")], { trustedWorkspace: false });
    expect(untrusted.matching("PreToolUse", "Bash")).toEqual([]);
    const trusted = buildHookRegistry([reg("local-1", "PreToolUse", "local")], { trustedWorkspace: true });
    expect(trusted.matching("PreToolUse", "Bash").map((e) => e.id)).toEqual(["local-1"]);
  });

  test("the exclusion is wholesale across every hook kind, not just decision-capable ones -- an OBSERVATIONAL Stop hook is excluded too", () => {
    const registry = buildHookRegistry([reg("proj-stop", "Stop", "project")], { trustedWorkspace: false });
    expect(registry.matching("Stop")).toEqual([]);
  });

  test("managed/user/sdk sourced entries are unaffected either way -- only project/local carry this obligation", () => {
    const entries = [reg("managed-1", "PreToolUse", "managed"), reg("user-1", "PreToolUse", "user"), reg("sdk-1", "PreToolUse", "sdk")];
    const untrusted = buildHookRegistry(entries, { trustedWorkspace: false });
    expect(untrusted.matching("PreToolUse", "Bash").map((e) => e.id).sort()).toEqual(["managed-1", "sdk-1", "user-1"]);
    const trusted = buildHookRegistry(entries, { trustedWorkspace: true });
    expect(trusted.matching("PreToolUse", "Bash").map((e) => e.id).sort()).toEqual(["managed-1", "sdk-1", "user-1"]);
  });

  test("an untrusted project entry is excluded from the merged-order output alongside a trusted-tier sibling -- the managed/user/sdk ordering is unaffected by the exclusion", () => {
    const registry = buildHookRegistry(
      [reg("sdk-1", "Stop", "sdk"), reg("proj-1", "Stop", "project"), reg("managed-1", "Stop", "managed")],
      { trustedWorkspace: false },
    );
    expect(registry.matching("Stop").map((e) => e.id)).toEqual(["managed-1", "sdk-1"]);
  });
});

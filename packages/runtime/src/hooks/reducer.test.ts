// Task 9 (WS-08 §4, verbatim): the multi-hook reducer's pure fixture corpus. `reduceHookOutcomes`
// takes an ALREADY-ORDERED list of (participant, outcome) pairs — the merged-deterministic-order
// concern (WS-08 §2) is registry.ts's job, and the async invocation/timeout/audit concerns are
// runner.ts's — this file tests ONLY the fold-to-one-composite math §4 pins, with no async, no I/O,
// and no invoker/audit doubles at all (per the task brief's own Step 1 instruction).
import { describe, test, expect } from "bun:test";
import { reduceHookOutcomes, type HookOutcome, type HookParticipant } from "./reducer.ts";
import type { PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";

function participant(overrides: Partial<HookParticipant> & Pick<HookParticipant, "id" | "event" | "source">): HookParticipant {
  return { ...overrides };
}

function entry(id: string, event: HookParticipant["event"], source: HookParticipant["source"], outcome: HookOutcome, extra?: Partial<HookParticipant>) {
  return { participant: participant({ id, event, source, ...extra }), outcome };
}

describe("reduceHookOutcomes -- strictest-wins precedence (WS-08 §4 rule 2, verbatim rank: deny > defer > ask > allow > none)", () => {
  test("deny alone", () => {
    const composite = reduceHookOutcomes([entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "deny", message: "no" })]);
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("no");
  });

  test("allow then deny -- deny wins (later, stronger)", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "allow" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "deny", message: "blocked" }),
    ]);
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("blocked");
  });

  test("deny then allow -- a later, weaker decision never overrides an earlier stronger one", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "deny", message: "blocked" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "allow" }),
    ]);
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("blocked");
  });

  test("defer outranks ask", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "ask" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "defer" }),
    ]);
    expect(composite.decision).toBe("defer");
  });

  test("deny outranks defer", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "defer" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "deny", message: "no" }),
    ]);
    expect(composite.decision).toBe("deny");
  });

  test("ask outranks allow", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "allow" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "ask" }),
    ]);
    expect(composite.decision).toBe("ask");
  });

  test("allow outranks no-decision (a 'none' outcome never wins the decision slot)", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "none" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "allow" }),
    ]);
    expect(composite.decision).toBe("allow");
  });

  test("all 'none' -- composite carries no decision at all", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "none" }),
      entry("h2", "PreToolUse", "sdk", { kind: "none" }),
    ]);
    expect(composite.decision).toBeUndefined();
  });

  test("a later EQUAL-strength decision does not overwrite the earlier one's message (earliest-of-tie wins, documented judgment call)", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "ask", message: "first" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "ask", message: "second" }),
    ]);
    expect(composite.decision).toBe("ask");
    expect(composite.message).toBe("first");
  });

  test("3-hook config spanning sources: managed(none) -> user(allow) -> sdk(deny) still strictest-wins deny", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "managed", { kind: "none" }),
      entry("h2", "PreToolUse", "user", { kind: "decision", decision: "allow" }),
      entry("h3", "PreToolUse", "sdk", { kind: "decision", decision: "deny", message: "final no" }),
    ]);
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("final no");
  });

  test("H1 allow+updatedPermissions overridden by H2's stricter deny -- H1's updatedPermissions is discarded, same scalar-slot rule as message/interrupt (controller-advisor-flagged gap)", () => {
    // HookOutcomeFields.updatedPermissions's own comment (T10): "the same earliest-of-tie /
    // override-discard rule as message/interrupt, not the transform-composition chain." H1's allow
    // (carrying a PermissionRequest permission-suggestion) loses to H2's later, stricter deny; H2
    // contributes no updatedPermissions of its own, so the slot is overwritten to `undefined` right
    // along with the decision -- never left dangling from the overridden winner.
    const suggestion: PermissionUpdate[] = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow", destination: "session" }];
    const composite = reduceHookOutcomes([
      entry("h1", "PermissionRequest", "sdk", { kind: "decision", decision: "allow", updatedPermissions: suggestion }),
      entry("h2", "PermissionRequest", "sdk", { kind: "decision", decision: "deny", message: "blocked" }),
    ]);
    expect(composite.decision).toBe("deny");
    expect(composite.updatedPermissions).toBeUndefined();
  });
});

describe("reduceHookOutcomes -- transform composition + discard-on-override (WS-08 §4 rule 3)", () => {
  test("a single hook's transform becomes the composite's transformedInput", () => {
    const composite = reduceHookOutcomes([entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "allow", transformedInput: { command: "ls" } })]);
    expect(composite.transformedInput).toEqual({ command: "ls" });
  });

  test("each hook sees the previous transform, and the LAST non-discarded contributor's transform wins when both survive", () => {
    // H1: none + transform X. H2: none + transform Y (chains from X, per execution order -- this
    // fixture only asserts the OBSERVABLE composite value, not the invocation-time chaining itself,
    // which is runner.ts's concern, not reducer.ts's pure-fold concern).
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "none", transformedInput: { command: "X" } }),
      entry("h2", "PreToolUse", "sdk", { kind: "none", transformedInput: { command: "Y" } }),
    ]);
    expect(composite.transformedInput).toEqual({ command: "Y" });
  });

  test("H1 allow+transformX overridden by H2's stricter ask (no transform of its own) -- H1's transform is discarded (composite carries no transformedInput)", () => {
    // Rule 3, verbatim: "A transformation from a hook whose decision was overridden by a stricter
    // one is discarded along with it." H1's allow loses to H2's ask; H2 contributes no transform of
    // its own, so nothing survives to become the composite's transformedInput.
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "allow", transformedInput: { command: "X" } }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "ask" }),
    ]);
    expect(composite.decision).toBe("ask");
    expect(composite.transformedInput).toBeUndefined();
  });

  test("H1 ask+transformX (wins) then H2 allow+transformY (overridden) -- composite carries X, not Y (the reviewer-probe case)", () => {
    // The exact scenario the advisor review flagged as the one a reviewer will probe: H2's own
    // transform is discarded along with its overridden decision, so the composite reverts to the
    // WINNING hook's own contribution (H1's X), not H2's (Y), even though H2 ran chronologically
    // after H1 and would ordinarily be "the latest write."
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "ask", transformedInput: { command: "X" } }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "allow", transformedInput: { command: "Y" } }),
    ]);
    expect(composite.decision).toBe("ask");
    expect(composite.transformedInput).toEqual({ command: "X" });
  });

  test("a 'none' hook's transform is NEVER discarded (it proposed no decision, so nothing of its own can be overridden), even after the winning decision", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "ask", transformedInput: { command: "X" } }),
      entry("h2", "PreToolUse", "sdk", { kind: "none", transformedInput: { command: "Z" } }),
    ]);
    expect(composite.decision).toBe("ask");
    expect(composite.transformedInput).toEqual({ command: "Z" });
  });

  test("transformedOutput (PostToolUse family) composes with the identical discard-on-override rule", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PostToolUse", "sdk", { kind: "none", transformedOutput: "first" }),
      entry("h2", "PostToolUse", "sdk", { kind: "none", transformedOutput: "second" }),
    ]);
    expect(composite.transformedOutput).toBe("second");
  });

  test("error/timeout/skipped outcomes never contribute a transform, even if a real one would otherwise chain through them", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "allow", transformedInput: { command: "X" } }),
      entry("h2", "PreToolUse", "sdk", { kind: "error", reason: "boom" }),
      entry("h3", "PreToolUse", "sdk", { kind: "decision", decision: "allow", transformedInput: { command: "Z" } }),
    ]);
    expect(composite.transformedInput).toEqual({ command: "Z" });
  });
});

describe("reduceHookOutcomes -- extraContext accumulates unconditionally (WS-08 §4 rule 4)", () => {
  test("ordered, attributed list -- one entry per hook that supplied extraContext, in evaluation order", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "managed", { kind: "none", extraContext: "ctx-from-h1" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "allow", extraContext: "ctx-from-h2" }),
    ]);
    expect(composite.extraContext).toEqual([
      { hookId: "h1", context: "ctx-from-h1" },
      { hookId: "h2", context: "ctx-from-h2" },
    ]);
  });

  test("UNQUALIFIED by override (documented judgment call): an overridden hook's extraContext still accumulates, unlike its transform", () => {
    // Rule 4 has no override-discard caveat the way rule 3 explicitly states one for transforms —
    // this fixture pins that literal asymmetry.
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "allow", extraContext: "from-overridden-h1" }),
      entry("h2", "PreToolUse", "sdk", { kind: "decision", decision: "ask", extraContext: "from-winning-h2" }),
    ]);
    expect(composite.decision).toBe("ask");
    expect(composite.extraContext).toEqual([
      { hookId: "h1", context: "from-overridden-h1" },
      { hookId: "h2", context: "from-winning-h2" },
    ]);
  });

  test("no extraContext anywhere -- field is absent, not an empty array (exactOptionalPropertyTypes discipline)", () => {
    const composite = reduceHookOutcomes([entry("h1", "PreToolUse", "sdk", { kind: "none" })]);
    expect(composite.extraContext).toBeUndefined();
  });

  test("hookName, when the participant carries one, is attributed alongside hookId", () => {
    const composite = reduceHookOutcomes([entry("h1", "PreToolUse", "sdk", { kind: "none", extraContext: "ctx" }, { name: "my-hook" })]);
    expect(composite.extraContext).toEqual([{ hookId: "h1", hookName: "my-hook", context: "ctx" }]);
  });
});

describe("reduceHookOutcomes -- classifierContext is a SEPARATE accumulator from extraContext (WS-08 §5, T12-consumed)", () => {
  test("a PostToolUse hook's classifierContext lands in its own bucket, not extraContext", () => {
    const composite = reduceHookOutcomes([entry("h1", "PostToolUse", "sdk", { kind: "none", classifierContext: "suspicious: wrote to /etc" })]);
    expect(composite.classifierContext).toEqual([{ hookId: "h1", context: "suspicious: wrote to /etc" }]);
    expect(composite.extraContext).toBeUndefined();
  });

  test("both accumulators fill independently when a hook supplies both", () => {
    const composite = reduceHookOutcomes([entry("h1", "PostToolUse", "sdk", { kind: "none", extraContext: "generic note", classifierContext: "classifier note" })]);
    expect(composite.extraContext).toEqual([{ hookId: "h1", context: "generic note" }]);
    expect(composite.classifierContext).toEqual([{ hookId: "h1", context: "classifier note" }]);
  });
});

describe("reduceHookOutcomes -- lifecycle records (WS-08 §4 rule 2's 'skipped' + P2-A's outcome vocabulary)", () => {
  test("every participant gets exactly one lifecycle record, in order, regardless of outcome kind", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "managed", { kind: "decision", decision: "deny", message: "no" }),
      entry("h2", "PreToolUse", "user", { kind: "skipped" }),
      entry("h3", "PreToolUse", "sdk", { kind: "skipped" }),
    ]);
    expect(composite.lifecycleMessages).toHaveLength(3);
    expect(composite.lifecycleMessages.map((m) => m.hookId)).toEqual(["h1", "h2", "h3"]);
    expect(composite.lifecycleMessages.map((m) => m.outcome)).toEqual(["decision", "skipped", "skipped"]);
    expect(composite.lifecycleMessages[0]!.decision).toBe("deny");
  });

  test("lifecycle records distinguish error/timeout/none/decision/skipped -- all five P2-A outcome kinds", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "sdk", { kind: "decision", decision: "allow" }),
      entry("h2", "PreToolUse", "sdk", { kind: "none" }),
      entry("h3", "PreToolUse", "sdk", { kind: "error", reason: "boom" }),
      entry("h4", "PreToolUse", "sdk", { kind: "timeout" }),
      entry("h5", "PreToolUse", "sdk", { kind: "skipped" }),
    ]);
    expect(composite.lifecycleMessages.map((m) => m.outcome)).toEqual(["decision", "none", "error", "timeout", "skipped"]);
  });

  test("lifecycle records carry the participant's event/source/matcher for audit attribution", () => {
    const composite = reduceHookOutcomes([entry("h1", "PreToolUse", "project", { kind: "none" }, { matcher: "Bash" })]);
    expect(composite.lifecycleMessages[0]).toMatchObject({ hookId: "h1", event: "PreToolUse", source: "project", matchedMatcher: "Bash" });
  });
});

describe("reduceHookOutcomes -- rule 5 (composite never grants more than a single allow could)", () => {
  test("an 'allow' composite is representable but carries no wider authority than any other single-hook allow -- structural: HookComposite.decision is the SAME 4-value type a single hook returns, no fifth 'stronger' value exists", () => {
    const composite = reduceHookOutcomes([
      entry("h1", "PreToolUse", "managed", { kind: "decision", decision: "allow" }),
      entry("h2", "PreToolUse", "user", { kind: "decision", decision: "allow" }),
    ]);
    expect(composite.decision).toBe("allow");
  });
});

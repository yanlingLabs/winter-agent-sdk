// Task 9: `createHookStage` — the adapter from this file's own `runHooks` composite down to
// evaluator.ts's EXISTING (T6-authored) 3-value `HookStage`/`HookDecision` seam contract. This file
// tests the ADAPTER in isolation (no evaluate(), no EvaluationContext) — evaluator.test.ts gets the
// full stage-1 integration (deny stops before rules, allow+later-deny-rule still denies, transform
// visible to rules) using a REAL HookStage built here, per the task brief's own Step 3.
import { describe, test, expect } from "bun:test";
import type { HookEvent } from "@yanlinglabs/winter-agent-sdk";
import { createHookStage } from "./hook-stage.ts";
import type { HookInvoker, HookAuditRecorder } from "./runner.ts";
import type { SourcedHookEntry, HookRegistry } from "./registry.ts";
import type { EvaluationContext } from "../permissions/evaluator.ts";

function fakeRegistry(entries: SourcedHookEntry[]): HookRegistry {
  return { matching: (event: HookEvent) => entries.filter((e) => e.event === event) };
}
function fixedInvoker(raw: unknown): HookInvoker {
  return { invoke: async () => raw };
}
function noopAudit(): HookAuditRecorder {
  return { record: () => {} };
}
function entry(id: string, overrides?: Partial<SourcedHookEntry>): SourcedHookEntry {
  return { id, event: "PreToolUse", source: "sdk", ...overrides };
}

const CALL = { toolName: "Bash", input: { command: "ls" } };
// A minimal stand-in: createHookStage's own preToolUse only ever reads `ctx.policy.version` (see
// this file's header) -- this test file exercises the ADAPTER in isolation, never evaluate() itself,
// so a full EvaluationContext (cwd/home/trustedWorkspace/hookStage/promptStage/autoEngine/
// specialChecks) would be unused ceremony here; evaluator.test.ts's Step-3 integration fixtures
// build the real thing.
const CTX = { policy: { version: 1 } } as unknown as EvaluationContext;

describe("createHookStage -- no hooks registered", () => {
  test("no_opinion, no transform", async () => {
    const stage = createHookStage({ registry: fakeRegistry([]), invoker: fixedInvoker({}), audit: noopAudit(), sessionId: "s1" });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision).toEqual({ decision: "no_opinion" });
  });
});

describe("createHookStage -- allow/deny/none map directly onto the existing 3-value seam", () => {
  test("a single hook 'allow' maps to seam 'allow', carrying its transform and hookId", async () => {
    const stage = createHookStage({
      registry: fakeRegistry([entry("h1")]),
      invoker: fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "ls -la" } } }),
      audit: noopAudit(),
      sessionId: "s1",
    });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision).toEqual({ decision: "allow", hookId: "h1", transformedInput: { command: "ls -la" } });
  });

  test("a single hook 'deny' maps to seam 'deny', carrying message and hookId", async () => {
    const stage = createHookStage({
      registry: fakeRegistry([entry("h1")]),
      invoker: fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no way" } }),
      audit: noopAudit(),
      sessionId: "s1",
    });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision).toEqual({ decision: "deny", hookId: "h1", message: "no way" });
  });

  test("a 'none' outcome with a transform maps to seam 'no_opinion' but STILL carries the transform (evaluate() applies it regardless of decision)", async () => {
    const stage = createHookStage({
      registry: fakeRegistry([entry("h1")]),
      invoker: fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "echo safe" } } }),
      audit: noopAudit(),
      sessionId: "s1",
    });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision).toEqual({ decision: "no_opinion", transformedInput: { command: "echo safe" } });
  });

  test("a gating error (rejecting invoker) contributes no decision -- no_opinion, never a denial by itself", async () => {
    const stage = createHookStage({
      registry: fakeRegistry([entry("h1")]),
      invoker: { invoke: async () => { throw new Error("boom"); } },
      audit: noopAudit(),
      sessionId: "s1",
    });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision).toEqual({ decision: "no_opinion" });
  });
});

describe("T10-CARRY 1: a hook 'ask' now forces seam 'ask' (was: fail-closed to 'deny')", () => {
  test("a hook 'ask' maps to seam 'ask', carrying message and hookId", async () => {
    const stage = createHookStage({
      registry: fakeRegistry([entry("h1")]),
      invoker: fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "needs a human" } }),
      audit: noopAudit(),
      sessionId: "s1",
    });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision).toEqual({ decision: "ask", hookId: "h1", message: "needs a human" });
  });

  test("a hook 'ask' with a transform still carries the transform (evaluate() applies it regardless of decision)", async () => {
    const stage = createHookStage({
      registry: fakeRegistry([entry("h1")]),
      invoker: fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", updatedInput: { command: "ls -la" } } }),
      audit: noopAudit(),
      sessionId: "s1",
    });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision).toEqual({ decision: "ask", hookId: "h1", transformedInput: { command: "ls -la" } });
  });
});

// T10-CARRY 1 correction: runner.ts's interpretPreToolUse UNCONDITIONALLY resolves a raw
// `permissionDecision: "defer"` to `"ask"` before the outcome ever reaches the reducer (see that
// function's own TODO(T11) comment) -- so a composite built from a REAL PreToolUse invocation can
// never actually carry `decision: "defer"`; what this fixture exercises is genuinely "ask" (the
// resolved value), same as the block above. Before CARRY 1, that didn't matter observably (ask and
// defer were combined into ONE fail-closed-to-deny branch); now that "ask" gets its own seam
// outcome, this fixture's real value flows through the SAME "ask" branch as a directly-returned
// ask, which is the CORRECT behavior -- a hook that returns "defer" for a call that can't yet be
// durably parked (TODO(T11)) still gets the interactive path instead of silently under- or
// over-enforcing.
describe("createHookStage -- a hook 'defer' resolves to 'ask' via runner.ts, which now forces seam 'ask' too", () => {
  test("a hook 'defer' ends up at seam 'ask' (both interim resolutions now connect end-to-end)", async () => {
    const stage = createHookStage({
      registry: fakeRegistry([entry("h1")]),
      invoker: fixedInvoker({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } }),
      audit: noopAudit(),
      sessionId: "s1",
    });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision.decision).toBe("ask");
    expect(decision.hookId).toBe("h1");
  });
});

// The adapter's OWN `composite.decision === "defer"` branch (hook-stage.ts) is therefore DEFENSIVE,
// CURRENTLY UNREACHABLE via createHookStage's real pipeline (PreToolUse is the only decision-capable
// event wired at P2, and its interpreter always pre-resolves defer->ask, above) -- kept for type
// completeness against HookComposite.decision's full HookPermissionDecision union (a hypothetical
// future producer that does NOT pre-resolve) and against reducer.ts's own spec-faithful 5-rank
// vocabulary. Its coverage lives at the reducer level (reducer.test.ts's synthetic "defer"-rank
// fixtures construct HookOutcomeEntry[] directly, bypassing runner.ts's resolution entirely) -- not
// exercisable here without doing the same, which would test the adapter's dead branch rather than
// its real integration behavior.

describe("createHookStage -- multi-hook composite flows through end to end", () => {
  test("h1 allow then h2 deny -- seam sees the reducer's strictest-wins deny", async () => {
    let calls = 0;
    const invoker: HookInvoker = {
      invoke: async () => {
        calls++;
        if (calls === 1) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "second hook says no" } };
      },
    };
    const stage = createHookStage({ registry: fakeRegistry([entry("h1"), entry("h2")]), invoker, audit: noopAudit(), sessionId: "s1" });
    const decision = await stage.preToolUse(CALL, CTX);
    expect(decision.decision).toBe("deny");
    expect(decision.hookId).toBe("h2");
    expect(decision.message).toBe("second hook says no");
  });
});

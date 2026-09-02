// Task 13 (FINAL task, Phase 2) -- the fixture-matrix sweep proving the phase's own conformance
// surface. WS-07 §12 + WS-08 §12 (conformance spec / WS-17 §5's "Permissions and dialogs" and "MCP,
// hooks, plugins, context" rows) enumerate the fixtures P2 owes. This file walks every bullet in
// both sections, SCOPED TO P2 per phase ruling 3 (only the ten named P2-fireable hook events "fire";
// the rest are typed, accepted-in-config, inert, and owned by later phases), and for each bullet
// records exactly one of:
//
//   "covered"  -- a real test already proves it, cited below by {file, testName}. The second
//                 describe block in this file reads each cited file and asserts the citation's
//                 substring is genuinely present, so a renamed or deleted cited test FAILS THIS
//                 FILE rather than going silently stale in a comment (this project's parity-tripwire
//                 idiom, applied to documentation-as-code).
//   "new"      -- a genuine P2-scoped gap Tasks 1-12 left uncovered; this file closes it directly
//                 (a real test below, cited the same way, pointing at itself).
//   "deferred" -- out of scope at P2 by spec/ruling; every deferred row NAMES ITS OWNING PHASE, per
//                 this task's brief ("deferred bullets listed with their owning phase") -- never a
//                 silent absence.
//
// Zero rows may lack one of the three. The matrix intentionally does NOT re-implement or duplicate
// the cited tests' own assertions -- table-driven here means "one row per spec bullet, one
// machine-checked pointer to where that bullet is actually proven", not "re-run everything".
//
// Two P2 FIX-WAVE items (accumulated in the phase ledger, never assigned to a specific task) are
// closed here because they are literally missing §12-mapped fixtures -- squarely this task's Step-1
// mandate regardless of which backlog they were filed under:
//   (A) PostToolUseFailure had no engine-level firing fixture (WS-08 §12 item 1's P2-fireable set).
//   (C) PermissionDenied had no fixture proving it fires for a HOOK-mechanism denial specifically
//       (the existing engine.test.ts fixture only exercises a RULE-mechanism denial).
// Every OTHER fix-wave item (O(n²) perf notes, stale comments, post-terminal-call rejection, etc.)
// is production-code churn outside this task's named files and is left exactly where the ledger put
// it -- not silently absorbed, not silently ignored; see this task's report for the explicit triage.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig, WinterFrame, ControlRequestFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ToolExecutor } from "../engine.ts";
import { scriptedProvider, stubExecutor } from "../provider/mock.ts";

// --- shared local test helpers (deliberately re-created, not imported cross-file: engine.test.ts's
// equivalents are file-private, and this file's own citations should be self-sufficient -- the same
// judgment call approvals.test.ts/auto/*.test.ts already make about not sharing test-only fixtures
// across files) -------------------------------------------------------------------------------

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId: "conformance-s", cwd: "/tmp/winter-conformance-fixture", model: "sonnet", ...overrides,
});

// Answers every "hook" control_request generically, collecting each one's {event, toolName,
// toolUseID, payload} for assertion -- mirrors engine.test.ts's own drain-and-answer idiom (e.g. its
// Task 10 all-events test) without reaching into that file's private helpers.
async function drainAnsweringHooksGenerically(host: { input: AsyncIterable<WinterFrame>; output: { write(f: WinterFrame): void } }): Promise<
  Array<{ event: string; toolName?: string; toolUseID?: string; payload?: unknown }>
> {
  const seen: Array<{ event: string; toolName?: string; toolUseID?: string; payload?: unknown }> = [];
  for await (const f of host.input) {
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const payload = cf.payload as { event: string; toolName?: string; toolUseID?: string; payload?: unknown };
      seen.push({
        event: payload.event,
        ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
        ...(payload.toolUseID !== undefined ? { toolUseID: payload.toolUseID } : {}),
        ...(payload.payload !== undefined ? { payload: payload.payload } : {}),
      });
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
    }
  }
  return seen;
}

// A PreToolUse hook answers with the given permissionDecision (and optional reason) generically;
// every OTHER hook event is answered with a bare no-opinion ack -- the same
// drainAnsweringPreToolUse shape engine.test.ts uses (Task 11's defer fixtures), re-created locally.
async function drainAnsweringPreToolUse(
  host: { input: AsyncIterable<WinterFrame>; output: { write(f: WinterFrame): void } },
  preToolUseOutput: unknown,
): Promise<WinterFrame[]> {
  const seen: WinterFrame[] = [];
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const payload = cf.payload as { event: string };
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: payload.event === "PreToolUse" ? preToolUseOutput : {} });
    }
  }
  return seen;
}

// ================================================================================================
// New coverage row (A): PostToolUseFailure -- engine-level, on a REAL tool-execution throw.
// ================================================================================================
//
// WS-08 §12 item 1 (full-inventory firing) requires every P2-fireable event observed at least once.
// engine.test.ts's own all-events fixture (Task 10) fires SessionStart/UserPromptSubmit/PostToolUse/
// PermissionDenied/Stop/SessionEnd -- it never exercises the FAILURE arm (a genuinely throwing tool
// executor), so PostToolUseFailure's own firing site (engine.ts, the try/catch sibling of
// PostToolUse) had no fixture naming it at the engine level; T9's own interpreter also has no
// dedicated by-name unit test (T10 review, fix-wave item A). This closes both: the failure-arm
// firing path here, at the level that actually proves it reaches a real host.
test("WS-08 §12.1 (P2-fireable set): PostToolUseFailure fires, engine-level, on a real tool-execution throw", async () => {
  const { host, runtime } = createInMemoryChannel();
  const throwingTools: ToolExecutor = {
    async execute() {
      throw new Error("conformance: tool boom");
    },
  };
  const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "failing_tool", input: { x: 1 } }] }]);
  const config = baseConfig({
    allowedTools: ["failing_tool"], // pre-approve (Ruling P2-I) -- this fixture is about the FAILURE hook, not permissions
    hooks: { PostToolUseFailure: [{ hookCount: 1, source: "sdk" }] },
  });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, tools: throwingTools });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const seenHookRequests = await drainAnsweringHooksGenerically(host);
  const code = await done;

  expect(code).toBe(0); // a thrown executor still ends the run cleanly (error_during_execution result), never a crashed process
  expect(seenHookRequests.map((r) => r.event)).toEqual(["PostToolUseFailure"]);
  const failure = seenHookRequests[0]!;
  expect(failure.toolName).toBe("failing_tool");
  expect(failure.toolUseID).toBe("call1");
  expect((failure.payload as { error?: string }).error).toContain("conformance: tool boom");
});

// ================================================================================================
// New coverage row (C): PermissionDenied fires for a HOOK-mechanism denial, distinctly from a rule.
// ================================================================================================
//
// engine.test.ts's own PermissionDenied fixture (Task 10, "SessionStart/UserPromptSubmit/..." above)
// only exercises a RULE-mechanism denial (disallowedTools). WS-08 §6 states PermissionDenied
// "observes denials (any stage)" -- the hook-mechanism half (a PreToolUse hook's own "deny") had no
// fixture naming it (T10 review, fix-wave item C: "hook-mechanism PermissionDenied engine-level
// belt-and-suspenders fixture"). This proves it fires AND that the denial's `mechanism`/
// `decision_reason_type` genuinely reflects "hook", not "rule" -- a discriminating assertion, not
// merely "the run didn't crash".
test("WS-08 §12.1 / §6: PermissionDenied fires for a HOOK-mechanism denial (PreToolUse deny), and decision_reason_type distinguishes it from a rule-mechanism denial", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] },
    { kind: "text", text: "done" }, // Ruling P2-I: the round continues past a denial -- this turn IS reached
  ]);
  // No allowedTools/disallowedTools/permissions at all -- the ONLY thing resolving this call is the
  // PreToolUse hook's own "deny" (mechanism "hook"), never a rule.
  const config = baseConfig({
    hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }], PermissionDenied: [{ hookCount: 1, source: "sdk" }] },
  });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const seen: Array<{ event: string; toolName?: string; toolUseID?: string; payload?: unknown }> = [];
  const collected: WinterFrame[] = [];
  for await (const f of host.input) {
    collected.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const payload = cf.payload as { event: string; toolName?: string; toolUseID?: string; payload?: unknown };
      seen.push({ event: payload.event, ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}), ...(payload.toolUseID !== undefined ? { toolUseID: payload.toolUseID } : {}), ...(payload.payload !== undefined ? { payload: payload.payload } : {}) });
      const answer =
        payload.event === "PreToolUse"
          ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "conformance: hook says no" } }
          : {};
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: answer });
    }
  }
  await done;

  expect(seen.map((r) => r.event)).toEqual(["PreToolUse", "PermissionDenied"]);
  const permissionDenied = seen[1]!;
  expect(permissionDenied.toolName).toBe("mystery_tool");
  expect(permissionDenied.toolUseID).toBe("call1");
  expect((permissionDenied.payload as { reason?: string }).reason).toContain("conformance: hook says no");

  // The public stream message (derived-shapes-p2.md item (d)) carries decision_reason_type -- proves
  // the denial's RECORDED mechanism is genuinely "hook", the discriminating half of this fixture.
  const msgs = dataMessages(collected);
  const permDeniedMsg = msgs.find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied") as
    | { decision_reason_type?: string; decision_reason?: string }
    | undefined;
  expect(permDeniedMsg).toBeDefined();
  expect(permDeniedMsg!.decision_reason_type).toBe("hook");

  // Round genuinely continued past the denial to a second provider turn.
  const result = msgs.at(-1) as { type: string; result?: string };
  expect(result.type).toBe("result");
  expect(result.result).toBe("done");
});

// A defer's own lifecycle-observability angle (a hook that DEFERS rather than denies, still
// observed by lifecycle messages) is already covered by engine.test.ts's Task 11 fixtures -- not
// re-proven here; this row's own point is PermissionDenied's mechanism attribution specifically.

// ================================================================================================
// The fixture matrix itself.
// ================================================================================================

interface Citation {
  /** Path to the test file, relative to THIS file. */
  file: string;
  /** An exact, verbatim substring of a real `test(...)`/`describe(...)` title in that file. */
  testName: string;
}

interface ConformanceRow {
  id: string;
  spec: string;
  bullet: string;
  status: "covered" | "new" | "deferred";
  citations?: Citation[];
  owningPhase?: string;
  note?: string;
}

// --- WS-07 §12 --------------------------------------------------------------------------------
//
// "Aligned to the conformance matrix 'Permissions and dialogs' (WS-17 §5): all six modes; bare and
// scoped allow/ask/deny; hook deny/modify + callback ordering; canUseTool, AskUserQuestion, user
// dialogs, cancellation, timeout; subagent inheritance + receiver-side messaging policy; and the
// invariant that an agent message cannot approve a user prompt or change configuration. Additional
// WS-07 fixtures: the §5/§6.7/§6.8 matrices cell-by-cell; wrapper-strip and compound-split corpora;
// symlink both-ends; Read-deny-blocks-Edit; '$defaults' splice-vs-replace; shadow-warning emission;
// stale-policy-version rejection; 3/20 fallback persistence across daemon restart; classifier
// no_verdict fail-closed."

const WS07_12: ConformanceRow[] = [
  {
    id: "WS07-01",
    spec: "WS-07 §12",
    bullet: "all six modes (default, acceptEdits, bypassPermissions, dontAsk, plan, auto)",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `default: unmatched + a genuinely no-opinion prompt stage resolves DENIED` },
      { file: "./evaluator.test.ts", testName: `Edit/Write recognized directly, in-bounds (cwd) -> auto-approved` },
      { file: "./evaluator.test.ts", testName: `bypassPermissions: an unmatched action (any tool) is ALLOWED and the prompt stage is never invoked` },
      { file: "./evaluator.test.ts", testName: `dontAsk: an unmatched non-read-only action is DENIED and the prompt stage is NEVER invoked` },
      { file: "./evaluator.test.ts", testName: `reads proceed: built-in read-only work is still allowed` },
      { file: "./evaluator.test.ts", testName: `auto (Task 12, default NO_OPINION_AUTO_ENGINE): routes to the classifier, never canUseTool` },
    ],
  },
  {
    id: "WS07-02",
    spec: "WS-07 §12",
    bullet: "bare and scoped allow/ask/deny",
    status: "covered",
    citations: [
      { file: "./grammar.test.ts", testName: `a bare tool name has no specifier and is bare-equivalent` },
      { file: "./grammar.test.ts", testName: `a scoped specifier is NOT bare-equivalent` },
      { file: "./evaluator.test.ts", testName: `bare deny (schema-removal class) sets deniedBareSchemaRemoval; scoped deny does not` },
      { file: "./evaluator.test.ts", testName: `an ask rule wins over a narrower allow rule` },
      { file: "./ruleset.test.ts", testName: `a matching deny and a matching allow from a DIFFERENT source are both reported independently` },
    ],
  },
  {
    id: "WS07-03",
    spec: "WS-07 §12",
    bullet: "hook deny/modify + callback ordering",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `hook deny short-circuits everything, even when an allow rule also matches` },
      { file: "./evaluator.test.ts", testName: `a real hook's transform is visible to rule matching` },
      { file: "../hooks/reducer.test.ts", testName: `3-hook config spanning sources: managed(none) -> user(allow) -> sdk(deny) still strictest-wins deny` },
    ],
  },
  {
    id: "WS07-04",
    spec: "WS-07 §12",
    bullet: "canUseTool",
    status: "covered",
    citations: [
      { file: "../../../sdk/src/query.test.ts", testName: `canUseTool receives the verbatim WS-07 §7.1 field set` },
      { file: "./prompt-stage.test.ts", testName: `builds the full WS-07 §7.1 payload: toolName, input, decisionReason, toolUseID, policyVersion, NO timeout` },
    ],
  },
  {
    id: "WS07-05",
    spec: "WS-07 §12",
    bullet: "AskUserQuestion",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `AskUserQuestion reaches the prompt stage even with NO matching ask rule and NO allow rule ever invents an answer` },
      { file: "./evaluator.test.ts", testName: `dontAsk: AskUserQuestion is denied outright, the prompt stage is NEVER invoked` },
    ],
  },
  {
    id: "WS07-06",
    spec: "WS-07 §12",
    bullet: "user dialogs (canUseTool's allow/deny write-back, the dialog's own answer shapes)",
    status: "covered",
    citations: [
      { file: "../../../sdk/src/query.test.ts", testName: `an allow PermissionResult (with updatedInput/updatedPermissions/decisionClassification) is written back verbatim` },
      { file: "../../../sdk/src/query.test.ts", testName: `a deny PermissionResult (with interrupt/decisionClassification) is written back verbatim` },
    ],
  },
  {
    id: "WS07-07",
    spec: "WS-07 §12",
    bullet: "cancellation",
    status: "covered",
    citations: [
      { file: "../engine.test.ts", testName: `a deny answer with interrupt:true stops the round AND produces the same provisional interrupted result as a host-originated interrupt` },
      { file: "../../../sdk/src/transport-equivalence.test.ts", testName: `interrupt mid-turn` },
    ],
  },
  {
    id: "WS07-08",
    spec: "WS-07 §12",
    bullet: "timeout (canUseTool has NO park timeout, by design -- WS-07 §9)",
    status: "covered",
    citations: [{ file: "./prompt-stage.test.ts", testName: `builds the full WS-07 §7.1 payload: toolName, input, decisionReason, toolUseID, policyVersion, NO timeout` }],
    note: "WS-07's own 'timeout' bullet is the ABSENCE of a park timeout on canUseTool (§9: 'no park timeout'), pinned by prompt-stage.test.ts's own NO-timeout assertion. Hook timeouts are a WS-08-owned mechanism -- see WS08-07 below.",
  },
  {
    id: "WS07-09",
    spec: "WS-07 §12",
    bullet: "subagent inheritance",
    status: "covered",
    citations: [
      { file: "./auto/inheritance.test.ts", testName: `forced onto every child regardless of definition override` },
      { file: "./auto/inheritance.test.ts", testName: `override to bypassPermissions is IGNORED when disableBypassPermissionsMode is set` },
    ],
    note: "Phase ruling 4: P2 ships logic + persisted shape only (computeChildPolicy, {effectiveMode, parentPolicyVersion, parentPolicyHash}); real children are P4.",
  },
  {
    id: "WS07-10",
    spec: "WS-07 §12",
    bullet: "receiver-side messaging policy",
    status: "deferred",
    owningPhase: "P4 (WS-10, subagents and messaging) -- SendMessage does not exist at P2; grep for SendMessage/receiver-side across packages/runtime and packages/sdk returns zero hits outside this matrix comment.",
  },
  {
    id: "WS07-11",
    spec: "WS-07 §12",
    bullet: "the invariant that an agent message cannot approve a user prompt or change configuration",
    status: "deferred",
    owningPhase: "P4 (WS-10) for the literal agent-MESSAGE case -- no cross-agent messaging exists at P2 to smuggle an approval through.",
    note: "A present-day HOOK-mechanism analog of the SAME invariant (a hook response cannot change permission settings beyond its documented updatedPermissions channel) is already covered: engine.test.ts, \"a PermissionRequest hook's updatedPermissions cannot smuggle a bypassPermissions mode switch past the SAME authority gate canUseTool's own suggestions go through\" (WS-08 §11's own answer-authority floor). That is a different mechanism than the WS-10 agent-message case this bullet names, so this row stays deferred rather than claimed covered.",
  },
  {
    id: "WS07-12",
    spec: "WS-07 §5",
    bullet: "baseline mode matrix, cell-by-cell (routine read-only / ordinary edit-write / other unmatched, × six modes)",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `default: a recognized read-only Bash command is allowed with zero rules configured` },
      { file: "./evaluator.test.ts", testName: `default: a Read call OUTSIDE cwd is NOT auto-allowed by the baseline` },
      { file: "./evaluator.test.ts", testName: `default: an unmatched non-read-only action reaches the prompt stage` },
      { file: "./evaluator.test.ts", testName: `out-of-root write prompts (not silently allowed by acceptEdits' own arm)` },
      { file: "./evaluator.test.ts", testName: `a non-write exploratory action falls to the ordinary pipeline (classifier borrow OFF at P2)` },
    ],
  },
  {
    id: "WS07-13",
    spec: "WS-07 §6.7",
    bullet: "protected-path matrix, cell-by-cell (all six modes)",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `default: prompt/callback` },
      { file: "./evaluator.test.ts", testName: `acceptEdits: prompt/callback` },
      { file: "./evaluator.test.ts", testName: `dontAsk: deny, canUseTool never called` },
      { file: "./evaluator.test.ts", testName: `bypassPermissions: allow, unconditionally (the ONE matrix cell where protected differs from critical)` },
      { file: "./evaluator.test.ts", testName: `plan (no session bypass): prompt` },
      { file: "./evaluator.test.ts", testName: `plan + session bypass enabled: allowed` },
      { file: "./evaluator.test.ts", testName: `auto (Task 12, default NO_OPINION_AUTO_ENGINE): routes to the classifier, never canUseTool -- fails closed with the stable 'Blocked by classifier' string` },
    ],
  },
  {
    id: "WS07-14",
    spec: "WS-07 §6.8",
    bullet: "critical-removal matrix, cell-by-cell (all six modes)",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `never silently allowed — reaches the prompt stage, fails closed absent a real answer` },
      { file: "./evaluator.test.ts", testName: `auto: never silently allowed — reaches the classifier (never canUseTool), fails closed with the stable 'Blocked by classifier' string` },
      { file: "./evaluator.test.ts", testName: `dontAsk: deny outright, canUseTool never called` },
      { file: "./evaluator.test.ts", testName: `bypassPermissions specifically: 'still prompts/callback'` },
      { file: "./evaluator.test.ts", testName: `plan + session bypass enabled: critical removal is STILL prompted, never relaxed` },
    ],
  },
  {
    id: "WS07-15",
    spec: "WS-07 §12",
    bullet: "wrapper-strip corpus",
    status: "covered",
    citations: [
      { file: "./grammar.test.ts", testName: `flag-free xargs is stripped` },
      { file: "./grammar.test.ts", testName: `chained wrappers strip in sequence` },
      { file: "./grammar.test.ts", testName: `a dangerous assignment NAME is not stripped on the allow side even with an innocuous-looking value` },
    ],
  },
  {
    id: "WS07-16",
    spec: "WS-07 §12",
    bullet: "compound-split corpus",
    status: "covered",
    citations: [
      { file: "./grammar.test.ts", testName: `splits on each documented operator` },
      { file: "./grammar.test.ts", testName: `every subcommand is independently permitted -- composition with matchesRule` },
      { file: "./evaluator.test.ts", testName: `is NOT read-only recognized (one dangerous subcommand taints the whole thing)` },
      { file: "./evaluator.test.ts", testName: `an allow rule only covers a compound command when it matches EVERY subcommand` },
    ],
  },
  {
    id: "WS07-17",
    spec: "WS-07 §3.1 / §12",
    bullet: "symlink both-ends",
    status: "covered",
    citations: [
      { file: "./paths.test.ts", testName: `both ends match: allow succeeds, deny fires (ordinary in-bounds symlink)` },
      { file: "./paths.test.ts", testName: `allow requires BOTH ends: a link outside the allowed subtree whose target resolves inside it is NOT allowed` },
      { file: "./evaluator.test.ts", testName: `deny-via-target: a Read deny on secrets/** fires on a symlink OUTSIDE secrets/ whose target resolves INTO it` },
      { file: "./evaluator.test.ts", testName: `cwd-baseline-escape: default mode, a symlink INSIDE cwd whose target resolves OUTSIDE it is NOT routine-read-only-in-cwd` },
    ],
  },
  {
    id: "WS07-18",
    spec: "WS-07 §3.1 / §12",
    bullet: "Read-deny-blocks-Edit",
    status: "covered",
    citations: [
      { file: "./paths.test.ts", testName: `a matching Read deny rule blocks Edit/Write on the same path` },
      { file: "./evaluator.test.ts", testName: `default mode: a Read deny on the path blocks an Edit, before ever reaching the mode/prompt stage` },
      { file: "./evaluator.test.ts", testName: `MAJOR fix round 1: a recognized Bash fs-op (sed -i) touching a Read-denied path is blocked` },
    ],
  },
  {
    id: "WS07-19",
    spec: "WS-07 §10.2 / §12",
    bullet: `"$defaults" splice-vs-replace`,
    status: "covered",
    citations: [
      { file: "./auto/config.test.ts", testName: `['$defaults'] alone -- splices in the built-ins verbatim, not flagged as a replacement` },
      { file: "./auto/config.test.ts", testName: `an array WITHOUT '$defaults' -- REPLACES the full default list and is flagged security-relevant` },
      { file: "./auto/config.test.ts", testName: `['my-extra-allow', '$defaults'] -- splices defaults AT the token's position, extra entries preserved` },
    ],
  },
  {
    id: "WS07-20",
    spec: "WS-07 §7.3 / §12",
    bullet: "shadow-warning emission",
    status: "covered",
    citations: [
      { file: "../../../sdk/src/query.test.ts", testName: `shadow warning: canUseTool + permissionMode 'bypassPermissions' -> exactly one WINTER_SDK_CAN_USE_TOOL_SHADOWED warning` },
      { file: "../../../sdk/src/query.test.ts", testName: `shadow warning: canUseTool + a BARE allowedTools entry -> exactly one warning` },
      { file: "../../../sdk/src/query.test.ts", testName: `shadow warning: a SCOPED allowedTools entry (has a specifier) does NOT warn` },
    ],
  },
  {
    id: "WS07-21",
    spec: "WS-07 §2 / §12",
    bullet: "stale-policy-version rejection",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `the returned record's policyVersion reflects the snapshot passed in ctx.policy, not any later mutation` },
      { file: "./evaluator.test.ts", testName: `stale-policy-during-hook-RPC: the SAME re-evaluation loop that already covers canUseTool also covers a PermissionRequest hook` },
      { file: "../engine.test.ts", testName: `a permission answer computed under a policy that changed WHILE the RPC was in flight is discarded and re-evaluated fresh` },
    ],
  },
  {
    id: "WS07-22",
    spec: "WS-07 §10.5 / §12",
    bullet: "3/20 fallback persistence across daemon restart",
    status: "covered",
    citations: [
      { file: "./auto/caches.test.ts", testName: `counters survive a reopen against the same location` },
      { file: "./auto/caches.test.ts", testName: `fallback state (3-consecutive) survives a reopen` },
      { file: "./auto/caches.test.ts", testName: `20 total denies trip fallback even if never 3 in a row, and it is STICKY` },
    ],
    note: "'Restart' is proven as a fresh store instance reopened against the same on-disk location (a real daemon restart's own observable contract from the store's point of view) -- this is the T12 plan's own 'persisted across a store reopen' language.",
  },
  {
    id: "WS07-23",
    spec: "WS-07 §10.6-5 / §12",
    bullet: "classifier no_verdict fail-closed",
    status: "covered",
    citations: [
      { file: "./auto/engine.test.ts", testName: `always returns no_verdict, never consults the call` },
      { file: "./evaluator.test.ts", testName: `auto (Task 12, default NO_OPINION_AUTO_ENGINE): routes to the classifier, never canUseTool -- fails closed with the stable 'Blocked by classifier' string` },
      { file: "./auto/engine.test.ts", testName: `P2's real production path -- alwaysNoVerdictClassifier's no_verdict ALSO emits permission_denied under auto (fail-closed denial-as-tool_result, WS-07 §10.6-5)` },
    ],
  },
];

// --- WS-08 §12 --------------------------------------------------------------------------------

const WS08_12: ConformanceRow[] = [
  {
    id: "WS08-01",
    spec: "WS-08 §12 item 1",
    bullet: "full-inventory event firing -- each §1 event observed at least once (P2-fireable set per phase ruling 3), on both topologies",
    status: "covered",
    citations: [
      { file: "../engine.test.ts", testName: `SessionStart/UserPromptSubmit/PostToolUse/PermissionDenied/Stop/SessionEnd all fire real 'hook' control_requests, in order, through the real registry+bridge` },
      { file: "./evaluator.test.ts", testName: `a real hook 'deny' stops the call before stage 2 ever runs` },
      { file: "./evaluator.test.ts", testName: `stage 6 (generic unmatched action): a PermissionRequest hook 'allow' answers in place of canUseTool` },
      { file: "./conformance.test.ts", testName: `PostToolUseFailure fires, engine-level, on a real tool-execution throw` },
      { file: "./conformance.test.ts", testName: `PermissionDenied fires for a HOOK-mechanism denial (PreToolUse deny), and decision_reason_type distinguishes it from a rule-mechanism denial` },
    ],
    note:
      "9 of the 10 phase-ruling-3 P2-fireable events (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, PermissionRequest, PermissionDenied, SessionStart, SessionEnd) have a real firing fixture (PermissionDenied now proven for BOTH the rule-mechanism case, cited above, and the hook-mechanism case, this file's own new row). Notification does NOT -- see the dedicated WS08-EVT-NOTIFICATION row below; it is a genuine ruling-vs-implementation discrepancy, not folded into this row's 'covered' verdict. Both-topologies argument (structural, not 10x-duplicated): the hook RPC round trip (registry -> bridge -> host -> back) is the SAME mechanism for every event, and it is already proven leg-invariant end-to-end on inMemory/child/compiled by transport-equivalence.test.ts's hooked-tool-round scenario (Task 10) -- per-event leg-invariance follows structurally from one shared transport, so this row cites per-event firing at the engine/unit level rather than re-registering 9 more equivalence scenarios.",
  },
  {
    id: "WS08-EVT-NOTIFICATION",
    spec: "WS-08 §1 / phase ruling 3",
    bullet: "Notification event actually fires (named in phase ruling 3's P2-fireable list)",
    status: "deferred",
    owningPhase:
      "UNASSIGNED -- open question for the controller, not a spec-scoped later phase. Phase ruling 3 names Notification as part of the P2-fireable set (\"only the P2-fireable set actually fires: ... Notification\"), but engine.ts has ZERO call sites for it (its only 7 fireObservationalHook(...) call sites are SessionStart/UserPromptSubmit/PermissionDenied/PostToolUse/PostToolUseFailure/Stop/SessionEnd; PreToolUse/PermissionRequest fire from evaluator.ts separately). No P2_FIREABLE-style exported constant exists anywhere in the codebase to have caught this mismatch structurally. WS-08 itself only says 'runtime notifications' fire it, without naming a concrete Winter-internal trigger condition, and none of T9/T10/T12's own concern lists (progress.md) flag this absence -- unlike hook_progress (Carry 2), nobody has adjudicated Notification's gap yet.",
    note:
      "Recommended resolution (not made unilaterally here, per this task's own no-silent-resolution discipline): either (a) phase ruling 3's list is amended to move Notification to the typed-inert set with an owning phase once a concrete trigger is designed, or (b) a future task defines one (candidate: a settings-hot-reload or auto-mode-fallback-state UI notice). This task's file list does not include engine.ts, so no firing site is added here.",
  },
  {
    id: "WS08-02",
    spec: "WS-08 §12 item 2",
    bullet: "matcher exactness, including mcp__server__tool identity and canonical-name-after-alias matching",
    status: "covered",
    citations: [
      { file: "../hooks/registry.test.ts", testName: `exact tool-name matcher matches only that tool` },
      { file: "../hooks/registry.test.ts", testName: `mcp__server__tool canonical-name exact match` },
      { file: "../hooks/registry.test.ts", testName: `anchored mcp glob family matches (mcp__server__*)` },
    ],
    note:
      "The matcher GRAMMAR is fully tested including synthetic mcp__-shaped tool-name strings (registry.ts's matcher is pure string logic, needs no real MCP server to exercise). 'Canonical-name-AFTER-ALIAS' is a narrower claim -- there is no tool-alias resolution mechanism at P2 at all (WS-06's tool catalog/alias table is P3), so that half is out of scope, not merely untested; owning phase P3 (WS-06/WS-09).",
  },
  {
    id: "WS08-03",
    spec: "WS-08 §12 item 3",
    bullet: "reducer order + strictest-wins under 2-/3-hook configs spanning sources, transform composition, discarded-transform-on-override",
    status: "covered",
    citations: [
      { file: "../hooks/reducer.test.ts", testName: `deny then allow -- a later, weaker decision never overrides an earlier stronger one` },
      { file: "../hooks/reducer.test.ts", testName: `3-hook config spanning sources: managed(none) -> user(allow) -> sdk(deny) still strictest-wins deny` },
      { file: "../hooks/reducer.test.ts", testName: `H1 allow+transformX overridden by H2's stricter ask (no transform of its own) -- H1's transform is discarded` },
    ],
  },
  {
    id: "WS08-04",
    spec: "WS-08 §12 item 4",
    bullet: "PreToolUse allow not overriding a later deny rule, ask rule, interaction-required metadata, or the critical-removal floor",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `hook allow is advisory only — a deny rule downstream still wins` },
      { file: "./evaluator.test.ts", testName: `hook allow is advisory only — a matching ASK rule still forces the prompt path` },
      { file: "./evaluator.test.ts", testName: `a PreToolUse hook 'allow' does not clear the critical-removal circuit breaker either` },
    ],
  },
  {
    id: "WS08-05",
    spec: "WS-08 §12 item 5",
    bullet: "PermissionRequest answer vs canUseTool answer -- one decision record, provenance preserved",
    status: "covered",
    citations: [
      { file: "./evaluator.test.ts", testName: `a PermissionRequest hook 'allow' answers in place of canUseTool -- canUseTool never invoked` },
      { file: "./evaluator.test.ts", testName: `a PermissionRequest hook returning null (no opinion) falls through to the REAL promptStage/canUseTool, mechanism 'canUseTool' -- the SAME record shape as the hook-answered case, just a different mechanism` },
    ],
  },
  {
    id: "WS08-06",
    spec: "WS-08 §12 item 6",
    bullet: "defer -> process exit -> resume with revalidation; stale policy-version answer rejected",
    status: "covered",
    citations: [
      { file: "../hooks/hook-stage.test.ts", testName: `a hook 'defer' ends up at seam 'defer', carrying hookId/message/transform like every other decision` },
      { file: "./approvals.test.ts", testName: `persistence: a FRESH store instance over the same location replays prior state (process-exit-and-resume)` },
      { file: "../engine.test.ts", testName: `a deferred call's approval, consumed 'allowed' on a LATER run, executes exactly once across two resumes` },
      { file: "../engine.test.ts", testName: `a policyMode mismatch on resume expires the pending approval instead of executing it` },
    ],
  },
  {
    id: "WS08-07",
    spec: "WS-08 §12 item 7",
    bullet: "the §8 failure matrix row-by-row: gating error/timeout, observational error, malformed output, invalid defer",
    status: "covered",
    citations: [
      { file: "../hooks/runner.test.ts", testName: `gating hook error: no contribution, recorded, evaluation CONTINUES with remaining hooks -- NEVER a tool denial by itself` },
      { file: "../hooks/runner.test.ts", testName: `gating hook timeout: distinct outcome kind from 'error', no contribution, evaluation continues` },
      { file: "../hooks/runner.test.ts", testName: `observational (PostToolUse) hook error: logged, never affects the composite` },
      { file: "../hooks/runner.test.ts", testName: `malformed output (not an object at all) = that hook's error` },
      { file: "../hooks/runner.test.ts", testName: `invalid defer on a non-suspendable event (Notification) = hook contract error` },
    ],
  },
  {
    id: "WS08-08",
    spec: "WS-08 §12 item 8",
    bullet: "includeHookEvents on/off -- public-stream difference with audit-stream invariance",
    status: "covered",
    citations: [
      { file: "../engine.test.ts", testName: `includeHookEvents gates the public hook_started/hook_response messages; the audit trail (store.recordHookAudit) fires either way` },
      { file: "../engine.test.ts", testName: `SessionStart's own lifecycle messages emit UNCONDITIONALLY, even with includeHookEvents absent/false` },
    ],
  },
  {
    id: "WS08-09",
    spec: "WS-08 §12 item 9",
    bullet: "pre/post hooks around bridged (aliased/MCP) and ordinary calls, and around subagent tool calls with agentID correlation",
    status: "covered",
    citations: [
      { file: "../../../sdk/src/transport-equivalence.test.ts", testName: `hooked tool round with includeHookEvents: PreToolUse hook allow + the public hook_started/hook_response lifecycle frames are identical across legs` },
      { file: "./prompt-stage.test.ts", testName: `agentID/blockedPath thread through verbatim when present on the call/meta` },
    ],
    note:
      "'Ordinary calls' + the agentID FIELD-THREADING mechanism are proven now. Aliased/MCP-bridged calls and real subagent-originated tool calls have no producer at P2 (tool aliasing is WS-06/P3; real child processes are P4) -- that portion is out of scope, not merely untested. Owning phases: P3 (WS-06/WS-09, aliased/MCP) and P4 (WS-10, real subagent tool calls).",
  },
  {
    id: "WS08-10",
    spec: "WS-08 §12 item 10",
    bullet: "unknown-event configuration accepted-and-inert; unknown output fields round-tripped losslessly",
    status: "covered",
    citations: [
      { file: "../hooks/from-config.test.ts", testName: `an unrecognized event name is silently skipped -- accepted+preserved+INERT` },
      { file: "../hooks/runner.test.ts", testName: `unknown fields on an otherwise well-formed output are preserved losslessly` },
    ],
  },
  {
    id: "WS08-PROGRESS",
    spec: "WS-08 §9 (Carry 2)",
    bullet: "hook_progress (the T9/T10 lifecycle-trio middle frame) is produced by a real code path",
    status: "deferred",
    owningPhase:
      "Most likely P5 (WS-11 settings/filesystem hooks) -- reasoned, not directly ruled: the ONLY hook mechanism P2 has is a single-shot SDK-callback (`HookCallback`: one Promise resolution, no intermediate-streaming affordance at all), so there is structurally nothing at P2 that could ever emit a MIDDLE lifecycle frame between hook_started and hook_response. SDKHookProgressMessage's own pinned shape (`stdout`/`stderr`/`output` accumulating text) matches a long-running SUBPROCESS command-spec hook streaming its own output live -- exactly the filesystem/command-spec hook family that phase ruling 1 explicitly defers to P5 ('command-spec hooks typed but inert until P5 settings'). Confirmed absent: grep for a hook_progress producer anywhere in packages/runtime/src/hooks -- registry.ts/reducer.ts/runner.ts have no emission call site; runner.test.ts and engine.test.ts's own lifecycle fixtures only ever observe started/response.",
  },
];

describe("WS-07 §12 + WS-08 §12 fixture matrix (P2-scoped per phase ruling 3)", () => {
  const ALL_ROWS = [...WS07_12, ...WS08_12];

  test("every row is covered, newly tested here, or deferred with a named owning phase -- zero unexplained bullets", () => {
    for (const row of ALL_ROWS) {
      if (row.status === "deferred") {
        expect(row.owningPhase, `${row.id} (${row.bullet}): a deferred row must name its owning phase`).toBeTruthy();
      } else {
        expect(row.citations?.length ?? 0, `${row.id} (${row.bullet}): a ${row.status} row must carry at least one citation`).toBeGreaterThan(0);
      }
    }
  });

  test("every citation's file exists and genuinely contains the cited substring -- a renamed or deleted cited test fails HERE, not silently in a stale comment", () => {
    const fileCache = new Map<string, string>();
    const readCited = (relPath: string): string => {
      let content = fileCache.get(relPath);
      if (content === undefined) {
        const abs = fileURLToPath(new URL(relPath, import.meta.url));
        content = readFileSync(abs, "utf8");
        fileCache.set(relPath, content);
      }
      return content;
    };
    for (const row of [...WS07_12, ...WS08_12]) {
      for (const c of row.citations ?? []) {
        const content = readCited(c.file);
        expect(content.includes(c.testName), `${row.id}: citation not found -- ${c.file} does not contain a test/describe title matching "${c.testName}"`).toBe(true);
      }
    }
  });

  test("row ids are unique", () => {
    const ids = ALL_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("summary counts (informational -- printed for the task report, not itself a pass/fail condition beyond the above)", () => {
    const covered = ALL_ROWS.filter((r) => r.status === "covered").length;
    const newRows = ALL_ROWS.filter((r) => r.status === "new").length;
    const deferred = ALL_ROWS.filter((r) => r.status === "deferred").length;
    expect(covered + newRows + deferred).toBe(ALL_ROWS.length);
  });
});

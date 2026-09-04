// WS-10 §5: foreground/background policy. `run_in_background` (AgentInput) is an INVOCATION
// REQUEST, never the whole rule. Resolution order, verbatim:
//
//   agent-team constraints
//     -> WINTER_DISABLE_BACKGROUND_TASKS
//       -> fork mode (interactive default: on -> background; SDK default: off)
//         -> the invocation's run_in_background
//           -> whether the result is immediately needed
//
// Read as a chain of overrides (highest-priority first), not a "first non-empty wins" precedence
// list the way the model chain (WS-10 §3.1) is: each stage can still be overridden by a LATER one
// UNLESS the earlier stage is a hard veto. This function's own JUDGMENT CALLS, made explicit because
// WS-10 §5 gives a diagram + one prose sentence rather than a fully mechanical algorithm:
//
//   1. "agent-team constraints" (WS-10's own first, highest stage) has no concept anywhere in this
//      codebase yet -- teams are a capability-gated, unimplemented feature (WS-10 §17 Open Question
//      1, the SAME gate `AgentInput.name` is withheld behind). Modeled here as a documented no-op
//      pass-through so a future team-aware layer slots in ahead of this function without changing
//      its own signature.
//   2. WINTER_DISABLE_BACKGROUND_TASKS is a hard, host-level kill switch -- it outranks even
//      AgentDefinition.background:true's own "MAY force" (WS-10 §2/§5): a definition cannot
//      re-enable what a host administrator explicitly disabled process-wide.
//   3. AgentDefinition.background:true is addressed here as a FORCE ranking directly beneath the env
//      kill-switch (WS-10 §5's own bullet, stated outside the chain diagram itself) -- it overrides
//      even an explicit invocation `run_in_background:false`, matching "force" read literally.
//   4. The fork-mode default establishes a BASE answer; the invocation's own explicit request (when
//      given) overrides that base -- "an invocation request, not the whole rule" reads naturally as
//      "the model's own ask wins over an ambient default," never the reverse.
//   5. With NO explicit invocation request, "is the result needed immediately" is consulted as the
//      deciding tie-break -- this is the one case WS-10 explicitly forbids hard-coding a fixed
//      answer for ("Winter MUST NOT hard-code 'omitted means foreground' or 'omitted means
//      background' independent of mode and settings").
export type ForegroundBackgroundDecision = { background: boolean; reason: string };

export interface ResolveForegroundBackgroundInput {
  // AgentInput.run_in_background, verbatim (undefined = the model didn't specify one).
  invocationRequest?: boolean;
  // AgentDefinition.background -- WS-10 §2/§5: "MAY force background behavior in supported cases."
  definitionBackground?: boolean;
  isFork: boolean;
  // WS-10 §5's own "interactive default: on -> background" -- no interactive-CLI product surface
  // exists anywhere in packages/runtime (this is a daemon-shaped SDK runtime, never the interactive
  // terminal product WS-10 §5 also describes) -- exposed as a parameter (never hardcoded true) so a
  // FUTURE interactive surface can flip it without touching this function; every caller in this
  // phase leaves it unset, which resolves to the "SDK default: off" branch.
  interactiveDefault?: boolean;
  // WS-10 §5's own closing clause: "the generated tool description biases the model toward
  // background with run_in_background:false when the next action depends on the result." This is
  // the CALLER's own judgment about whether its particular call site can actually use a background
  // result later. tools/impl/agent.ts's own foreground Agent-tool call always awaits its own result
  // synchronously regardless of fg/bg (the tool's OWN return value is what the model's next turn
  // sees either way) -- this parameter exists as a real decision point for a future non-tool caller
  // whose own control flow could genuinely differ.
  resultNeededImmediately?: boolean;
  env?: Record<string, string | undefined>;
}

function isTruthyEnv(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

// RULING R4-7: `.winter/agents/*.md` loads only in a TRUSTED workspace (a checked-in definition is
// code execution + a permission participant, WS-10 §2/§17). No settings-file/trust-store loader
// exists anywhere in this codebase yet to derive a real signal from -- engine.ts's own
// `trustedWorkspace` (Finding 4, P2 fix-wave) is hardcoded `false` process-wide for the identical
// reason, and this function deliberately matches that SAME posture rather than inventing a
// second, divergent notion of trust. A real signal (once one exists) replaces this ONE function's
// body; every caller (today, only tools/impl/agent.ts's own `loadAgentDefinitions` call) is
// already written against it as a seam, never a hardcoded literal at the call site.
//
// WHOLE-BRANCH M11 (P4 fix wave) -- TWO CONSTANTS THAT MUST FLIP TOGETHER, named here so the second
// one cannot be missed: this function and engine.ts's own `const trustedWorkspace` (declared once and
// shared by the permission evaluator's `EvaluationContext.trustedWorkspace` and the hook registry's
// own trust gate). They used to be two independent hardcoded `false`s answering the SAME question --
// correct-safe, but when P5 lands a real settings/trust-store signal, wiring one and leaving the
// other gives a session where a checked-in `.winter/agents/*.md` loads while project-scoped
// permission rules stay gated, or the reverse.
//
// CLOSED in the fix wave's follow-up round (item 6, whole-branch M11): this function no longer
// derives anything. It CONSUMES the engine's own verdict, threaded onto every ToolExecutionContext
// as `trustedWorkspace` (registry.ts) from the one `const trustedWorkspace` in engine.ts. P5 flips
// that constant and both consumers move together, by construction.
//
// Argument-less and context-less callers still get `false`: absent reads as UNTRUSTED, never as
// trusted, so a hand-built test context or a future caller that forgets to thread it can only ever
// be stricter than the session actually is.
export function resolveWorkspaceTrust(ctx?: { trustedWorkspace?: boolean }): boolean {
  return ctx?.trustedWorkspace === true;
}

export function resolveForegroundBackground(input: ResolveForegroundBackgroundInput): ForegroundBackgroundDecision {
  const env = input.env ?? process.env;

  // Stage 1 (agent-team constraints): documented no-op -- see header.

  // Stage 2: hard kill switch.
  if (isTruthyEnv(env["WINTER_DISABLE_BACKGROUND_TASKS"])) {
    return { background: false, reason: "WINTER_DISABLE_BACKGROUND_TASKS" };
  }

  // WS-10 §5's own standalone bullet: a definition FORCES background once past the kill switch.
  if (input.definitionBackground === true) {
    return { background: true, reason: "AgentDefinition.background" };
  }

  // Stage 3: fork-mode base default.
  const forkDefault = input.isFork && input.interactiveDefault === true;

  // Stage 4: the invocation's own explicit choice overrides the base default.
  if (input.invocationRequest !== undefined) {
    return { background: input.invocationRequest, reason: "invocation run_in_background" };
  }

  // Stage 5: no explicit request -- consult "is the result needed immediately" rather than
  // defaulting silently.
  if (input.resultNeededImmediately !== undefined) {
    return { background: !input.resultNeededImmediately, reason: "result-needed" };
  }

  return { background: forkDefault, reason: input.isFork ? "fork mode default" : "SDK default (foreground)" };
}

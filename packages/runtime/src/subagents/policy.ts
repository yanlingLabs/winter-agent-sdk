import { WINTER_BRAND, envName, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
// WS-10 §5: foreground/background policy. `run_in_background` (AgentInput) is an INVOCATION
// REQUEST, never the whole rule. Resolution order, verbatim:
//
//   agent-team constraints
//     -> WINTER_DISABLE_BACKGROUND_TASKS
//       -> a fork (always background)
//         -> the invocation's run_in_background
//           -> whether the result is immediately needed
//             -> background (SDK 0.0.16's default, as in claude)
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
//   5. With NO explicit invocation request, "is the result needed immediately" is consulted first (no
//      caller supplies it today), and the final answer is BACKGROUND -- SDK 0.0.16, matching claude,
//      whose own formula is "background unless run_in_background is explicitly false". WS-10's
//      "MUST NOT hard-code ... independent of mode and settings" is satisfied by the two things that
//      still decide it: the host kill switch (stage 2) and the invocation's own flag (stage 4).
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
  /** P7a (D19): the session's brand -- the background kill switch's env NAME. Omitted = `WINTER_BRAND`. */
  brand?: Pick<BrandProfile, "envPrefix">;
}

function isTruthyEnv(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

// RULING R4-7: a project `agents/*.md` loads only in a TRUSTED workspace (a checked-in definition is
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
// other gives a session where a checked-in project agent definition loads while project-scoped
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

/**
 * Spawn-surface parity: the STAGE 2 kill switch alone, exported -- `tools/descriptors/agent.ts`'s
 * own schema function (item 5) needs "is background disabled" to decide whether `run_in_background`
 * is even in the advertised schema (research §A2: "DROPPED from the schema when background tasks are
 * disabled"), without re-deriving this env read a second time or pulling in the rest of
 * `resolveForegroundBackground`'s own five-stage chain.
 */
export function resolveBackgroundTasksDisabled(env: Record<string, string | undefined> = process.env, brand?: Pick<BrandProfile, "envPrefix">): boolean {
  return isTruthyEnv(env[envName(brand ?? WINTER_BRAND, "DISABLE_BACKGROUND_TASKS")]);
}

export function resolveForegroundBackground(input: ResolveForegroundBackgroundInput): ForegroundBackgroundDecision {
  const env = input.env ?? process.env;

  // Stage 1 (agent-team constraints): documented no-op -- see header.

  // Stage 2: hard kill switch.
  const killSwitch = envName(input.brand ?? WINTER_BRAND, "DISABLE_BACKGROUND_TASKS");
  if (resolveBackgroundTasksDisabled(env, input.brand)) {
    return { background: false, reason: killSwitch };
  }

  // WS-10 §5's own standalone bullet: a definition FORCES background once past the kill switch.
  if (input.definitionBackground === true) {
    return { background: true, reason: "AgentDefinition.background" };
  }

  // Stage 3: a FORK always runs in the background (R3a §2: the pin's fork definition forces it, and a
  // fork inherits the parent's live conversation precisely so the parent can carry on meanwhile).
  // Ranked here, above the invocation's own request, for the same "force" reading as
  // `definitionBackground` above it.
  if (input.isFork) {
    return { background: true, reason: "fork" };
  }

  // Stage 4: the invocation's own explicit choice.
  if (input.invocationRequest !== undefined) {
    return { background: input.invocationRequest, reason: "invocation run_in_background" };
  }

  // Stage 5: no explicit request -- a caller that can say whether it needs the result immediately is
  // still asked (no Winter caller does today; kept as the seam it has always been).
  if (input.resultNeededImmediately !== undefined) {
    return { background: !input.resultNeededImmediately, reason: "result-needed" };
  }

  // SDK 0.0.16 Lane N: BACKGROUND IS THE DEFAULT, as in claude -- whose own formula reduces to
  // "background unless `run_in_background: false`" once past its kill switch (spawn-surface research
  // §A2's `background default` line). This was blocked by R-S7 for one concrete reason, now gone: the
  // engine never told the model about a background completion, so an un-flagged spawn would have been
  // fire-and-forget. It now does -- mid-turn after a tool round, or as its own turn -- and a
  // closed-input session holds its `result` until that has happened
  // (`subagents/notification-queue.ts`, `engine.ts`'s own wind-down).
  //
  // `WINTER_DISABLE_BACKGROUND_TASKS` (stage 2) remains the kill switch that restores the old
  // behaviour wholesale, and an explicit `run_in_background: false` still runs one spawn in the
  // foreground.
  return { background: true, reason: "SDK default (background)" };
}

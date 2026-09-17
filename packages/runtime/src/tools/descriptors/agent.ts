// WS-06 §3.3 "Agent" -- implement-now, captured model schema (declared superset noted in the
// description). [WS-10] owns lifecycle/definition/model-resolution/fork semantics; T1 registers the
// descriptor only. `resume`/`max_turns` are deliberately NOT input fields (see WS-06 §3.3).
//
// Spawn-surface parity (research §A2/§A3, scope item 5): claude's own Agent schema/description are
// NOT static -- `run_in_background` drops from the schema when background tasks are disabled or the
// fork gate is on, the `model` field's own text gains a fork clause when fork is on, and the tool
// description gains a whole fork section when fork is on. None of that can be decided at THIS file's
// import time: `stub({...})` below runs once, at module load, and the fork gate is a per-session
// `RuntimeConfig`/env fact (`builtin-agents.ts`'s own `resolveForkSubagentEnabled`) -- reading env at
// module load is exactly what `brand-gate.test.ts` rule 9 forbids, and a session's own gate state
// cannot be known before a session exists anyway.
//
// So the gate-aware pieces are PURE FUNCTIONS, exported for a per-turn caller (`engine.ts`'s own
// `toolSpecFor`, `:~4894-4911` -- the SAME per-call clone-and-substitute site that already re-renders
// the `model` enum from the active slot set; this descriptor's static registration below is the
// gate-OFF default, exactly like the model enum's own "the pinned four... is also what a session with
// no active slot set wired still advertises"). Lane L2b is expected to call `agentInputSchemaFor` /
// `renderAgentToolDescription` from that same special-case, alongside the existing slot-enum clone.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";
import type { JSONSchema } from "../registry.ts";
import { AGENT_MODEL_SLOTS_BLOCK, AGENT_TOOL_CANONICAL_NAME } from "../../provider/slots.ts";

export interface AgentToolGateState {
  /** R-S5: is `subagent_type: "fork"` selectable this session? */
  forkEnabled: boolean;
  /** research §A2: is `run_in_background` withheld because a host kill-switch is set? (`subagents/policy.ts`'s own `resolveBackgroundTasksDisabled`.) */
  backgroundDisabled: boolean;
  /** research §A3: is the `general-purpose` built-in actually available this session (R-S6's `allBuiltinsDisabled` kill switch off, or a same-named override present)? Governs the omitted-`subagent_type` sentence. */
  generalPurposeAvailable: boolean;
  /**
   * I4 (fix wave): the EFFECTIVE default `subagents/policy.ts`'s `resolveForegroundBackground`
   * actually applies at its own stage 5, when `run_in_background` is advertised at all (i.e. neither
   * `forkEnabled` nor `backgroundDisabled` is true -- see `agentInputSchemaFor` below). `true` (SDK
   * 0.0.16, matching claude) unless a host opted out via `RuntimeConfig.backgroundByDefault` / the
   * `WINTER_BACKGROUND_BY_DEFAULT` env fallback. Optional (default `true`) so every pre-I4 gate
   * object literal in this file's own tests keeps typechecking unchanged.
   */
  backgroundByDefault?: boolean;
}

/** The gate-OFF defaults the static registration below uses -- byte-identical to this descriptor's pre-parity shape wherever every gate reads as it always has (fork off, background on and the default, general-purpose present). */
export const AGENT_TOOL_GATE_DEFAULTS: AgentToolGateState = { forkEnabled: false, backgroundDisabled: false, generalPurposeAvailable: true, backgroundByDefault: true };

function modelFieldDescription(forkEnabled: boolean): string {
  // research §A2, adapted per R-S9: the FOUR-MEMBER FAMILY-SLOT ENUM stays Winter's own (a user
  // directive, not a claude mirror) -- only the surrounding prose is claude's own structure/wording,
  // updated for "the agent definition's model frontmatter" (unchanged: Winter's own frontmatter field
  // is also literally named `model`) and, when fork is on, claude's own ignored-for-fork clause.
  const base =
    "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent.";
  return forkEnabled ? `${base} Ignored for subagent_type: "fork" — forks always inherit the parent model.` : base;
}

// SDK 0.0.16 Lane N: claude's own text, verbatim (a short field description -- R-S10), because it is
// now TRUE of Winter. R-S7 withheld it for one concrete reason: Winter's engine never told the model
// about a background completion, so "you will be notified when one completes" would have been a false
// promise. The notification channel (`subagents/notification-queue.ts`) is what makes the sentence
// accurate, and `subagents/policy.ts` is where the matching default lives.
const RUN_IN_BACKGROUND_DESCRIPTION =
  "Agents run in the background by default; you will be notified when one completes. Set to false only when your very next action depends on this agent's result and nothing else could usefully happen while it runs — otherwise leave it in the background so the user can hand you other work.";

// I4 (fix wave): Winter's OWN text, for the one state `RUN_IN_BACKGROUND_DESCRIPTION` above cannot
// honestly describe -- a session where a host opted out of the 0.0.16 background default
// (`RuntimeConfig.backgroundByDefault: false` / `WINTER_BACKGROUND_BY_DEFAULT`). That constant's own
// FIRST SENTENCE is a factual claim ("Agents run in the background by default"), and it stays
// byte-identical for the sessions it is still true of (the M1 restriction on rewording it) -- this is
// a SECOND, separate constant, selected instead of it, never a rewrite of it.
const RUN_IN_BACKGROUND_DESCRIPTION_FOREGROUND_DEFAULT =
  "This session's host has turned off the background default: agents run in the foreground unless you set this to true. Set it to true to launch one asynchronously instead — you get a task id and a notification when it completes, and can do other useful work while it runs.";

// research §A2: kept verbatim -- this text names no claude-specific product or env var, so there is
// nothing in it that needs a Winter substitution (scope item 5: "Keep isolation enum [...] with
// claude's description").
const ISOLATION_DESCRIPTION =
  'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo. "remote" launches the agent in a remote cloud environment (always runs in background; availability is gated).';

/**
 * research §A2's own field table, gate-aware (scope item 5: drop `run_in_background` when fork is on
 * or a background kill switch is set; `name` stays withheld per the pre-existing P4-J(d) ruling,
 * untouched by this lane).
 */
export function agentInputSchemaFor(gates: AgentToolGateState = AGENT_TOOL_GATE_DEFAULTS): JSONSchema {
  const properties: Record<string, JSONSchema> = {
    description: { type: "string", description: "A short (3-5 word) description of the task" },
    prompt: { type: "string", description: "The task for the agent to perform" },
    subagent_type: { type: "string", description: "The type of specialized agent to use for this task" },
    // WS-13c §3 (P6.6, R-S9): the STATIC DEFAULT, and the pinned four are deliberately what it is. A
    // session with an active slot set wired gets this property's `enum` re-rendered from that family
    // (engine.ts's `toolSpecFor` clones the schema per turn -- this object is never mutated), and a
    // session without one keeps exactly the enum it always had. The enum ITSELF is Winter's own
    // per-family slot-name vocabulary (R-S9: "stays per family... only its description text
    // changes") -- never claude's four literal model names.
    model: { type: "string", enum: ["sonnet", "opus", "haiku", "fable"], description: modelFieldDescription(gates.forkEnabled) },
    isolation: { type: "string", enum: ["worktree", "remote"], description: ISOLATION_DESCRIPTION },
    // `name` is DELIBERATELY ABSENT from the model-visible schema (Phase 4 Task 8, rider 22).
    // WS-10 §17 Open Question 1, verbatim: "the pinned default session did not advertise `name`
    // (report §41); the exact capability predicate that turns it on (teams feature state) must be
    // captured before Winter advertises it -- until then Winter accepts the field host-side and
    // withholds it from the model schema." R4-8 restates it as a capture-pending obligation.
    //
    // HOST-SIDE ACCEPTANCE IS UNAFFECTED and is regression-pinned: `tools/impl/agent.ts` reads
    // `name` off its raw `input` and threads it onto `SpawnChildRequest.name` regardless of what
    // this schema advertises (nothing in this codebase validates a call against a descriptor's
    // inputSchema -- registry.ts's own JSONSchema type is explicitly "not a validator"), so this
    // change is purely about what the MODEL is told exists. Restoring the field is a one-line
    // edit here once a real capture pins the teams-feature predicate.
  };
  // research §A2: "DROPPED from the schema when background tasks are disabled... or fork is on."
  if (!gates.forkEnabled && !gates.backgroundDisabled) {
    // I4 (fix wave): the field's own description must agree with the EFFECTIVE default -- a host
    // that opted out (`backgroundByDefault: false`) still gets `run_in_background` on the schema
    // (this knob never touches that; only the kill switch/fork gate do), but the text describing
    // what happens when it is omitted must say foreground, not the SDK 0.0.16 background claim.
    properties["run_in_background"] = {
      type: "boolean",
      description: (gates.backgroundByDefault ?? true) ? RUN_IN_BACKGROUND_DESCRIPTION : RUN_IN_BACKGROUND_DESCRIPTION_FOREGROUND_DEFAULT,
    };
  }
  return { type: "object", properties, required: ["description", "prompt"] };
}

// Exported (not module-private): lane L2b's own runtime refusal in `tools/impl/agent.ts` for an
// OMITTED `subagent_type` (research §A7: "Omitted subagent_type → general-purpose (else
// 'subagent_type is required...')") needs the IDENTICAL wording this tool description advertises --
// two independently-typed copies of the same sentence is exactly how a future edit drifts them apart.
export const OMITTED_TYPE_SENTENCE_AVAILABLE = "If omitted, the general-purpose agent is used.";
/** The shared head of both omitted-type texts (research §A3/§A7): the description's sentence and the runtime refusal's message. */
export const OMITTED_TYPE_REQUIRED_PREFIX = "subagent_type is required: the general-purpose agent is not available in this session";
export const OMITTED_TYPE_SENTENCE_UNAVAILABLE = `${OMITTED_TYPE_REQUIRED_PREFIX}, so choose one of the listed agent types.`;

const FORK_SECTION = [
  "",
  'Forking: subagent_type: "fork" spawns an agent that inherits this session\'s own conversation, system prompt and tool pool exactly as they stand right now, instead of starting from a fresh agent definition. Use it when a task needs everything you already know and re-explaining that in the prompt would lose something real. model is ignored for a fork — it always runs on this session\'s own model.',
].join("\n");

/**
 * C1 (fix wave) / I4: the one paragraph in the description that must never contradict
 * `subagents/policy.ts`'s `resolveForegroundBackground` -- broken out of `renderAgentToolDescription`
 * so each of its four reachable states (schema-advertised x background-by-default, or not-advertised
 * x which of the two reasons withheld it) gets its OWN accurate sentence, never a claim inferred by
 * omission. `undefined` is itself a valid answer (the pre-existing "kill switch + fork both off is
 * the only advertised state" case never needed one, and still doesn't).
 */
function backgroundSection(gates: AgentToolGateState): string | undefined {
  const backgroundByDefault = gates.backgroundByDefault ?? true;
  if (!gates.forkEnabled && !gates.backgroundDisabled) {
    // The ordinary, advertised case: `run_in_background` is on the schema, and its own field
    // description (RUN_IN_BACKGROUND_DESCRIPTION / _FOREGROUND_DEFAULT) already states the default
    // in claude's own short form -- this paragraph restates it at description length, with the
    // mechanics (task id, notification, inline result) the field description has no room for.
    return backgroundByDefault
      ? "By default, an agent you launch runs in the BACKGROUND: this call returns right away with a task id, not the agent's own output, and you are notified later — as a task notification — when it finishes. Set run_in_background: false when your very next action depends on this agent's result and nothing else could usefully happen while it runs; that runs it in the foreground instead, so this call does not return until it finishes and its result comes back as this call's own output."
      : "This session's host has turned off the background default: by default, an agent you launch runs in the FOREGROUND, and this call does not return until it finishes, its result coming back as this call's own output. Set run_in_background: true to launch it asynchronously instead — you get a task id and a notification when it completes, and can do other useful work while it runs.";
  }
  if (gates.backgroundDisabled) {
    // The kill switch (stage 2) outranks everything, including a fork -- foreground, unconditionally,
    // with no flag to change it (the schema carries no `run_in_background` in this state at all).
    return "This host has disabled background subagents entirely: every agent you launch here runs in the foreground, and this call does not return until it finishes, its result coming back as this call's own output.";
  }
  // Fork is enabled and the kill switch is not: `run_in_background` is still withheld from the
  // schema (research §A2's own claude-matching rule), but the underlying default is UNCHANGED for an
  // ORDINARY (non-fork) spawn -- only an actual fork is forced to the background unconditionally
  // (stage 3, ahead of this knob). Both facts stated, so neither is a claim the resolver could refute.
  return backgroundByDefault
    ? "There is no run_in_background override in this session: an ordinary agent you launch runs in the background by default, the same as anywhere else. A fork (see below) always runs in the background regardless."
    : "There is no run_in_background override in this session: an ordinary agent you launch runs in the foreground by default. A fork (see below) always runs in the background regardless.";
}

/**
 * research §A3's own structure, Winter-worded, gate-aware.
 *
 * R-S10 (whole-branch review r2 finding 3, controller ruling): a tool DESCRIPTION is multi-sentence
 * prose and must be Winter-authored throughout, including its OPENING sentences -- an earlier
 * version of this function argued the opening two sentences were "mechanism statements... reused as
 * given, not claude prose" and left them byte-identical to claude's own pinned text (the exact
 * strings the review's r2 finding 3 names). That argument does not survive R-S10: a fact being true
 * of Winter's own runtime does not license copying the SENTENCE Anthropic used to state it. Both
 * opening sentences below are reworded to carry the identical information (how an agent is launched
 * and specialized; that the available types are announced in an injected reminder) in Winter's own
 * words. `OMITTED_TYPE_SENTENCE_AVAILABLE`/`_UNAVAILABLE` are UNCHANGED -- R-S10's own allowance
 * covers a short functional one-liner reused as BOTH a description sentence and a refusal message
 * (the shared-constant discipline two lines up exists precisely so the two never drift), which is
 * the category the ruling exempts.
 */
export function renderAgentToolDescription(gates: AgentToolGateState = AGENT_TOOL_GATE_DEFAULTS): string {
  const parts = [
    "Spawn a subagent to carry a self-contained piece of a task on your behalf; each agent type brings its own specialization and its own tool access.",
    "The agent types available to you right now are announced in a runtime-injected reminder earlier in this conversation.",
    gates.generalPurposeAvailable ? OMITTED_TYPE_SENTENCE_AVAILABLE : OMITTED_TYPE_SENTENCE_UNAVAILABLE,
    [
      "When to use the Agent tool:",
      "- The task is complex or long enough that doing it inline would spend a lot of your own context on intermediate steps you don't need to keep.",
      "- The task is naturally delegable: a self-contained search, a focused piece of research, an isolated implementation step.",
      "- Several pieces of work are independent of one another — batch their launches into one message so they proceed side by side instead of one after another.",
    ].join("\n"),
    [
      "Writing the prompt:",
      "- State the task and the result you expect concretely; the agent sees only what you put in `prompt`, never the rest of this conversation.",
      '- Say what "done" looks like, including the form you want the answer back in.',
      "- Do not ask a specialized agent type to do something outside its own specialization (for example, a read-only agent to make an edit) — pick a different type instead.",
    ].join("\n"),
    // C1 (fix wave): rewritten for the SDK 0.0.16 background default (`subagents/policy.ts`'s own
    // stage 5) -- the old text claimed foreground was the default, which stopped being true once
    // Lane N wired a background completion back to the model as a task notification. `backgroundByDefault`
    // (I4) is the host's own opt-out of that default, and the paragraph must state whichever is
    // actually true for THIS session, never a claim `resolveForegroundBackground` would contradict.
    backgroundSection(gates),
    [
      "When NOT to use the Agent tool:",
      "- For something you can finish yourself in one or two tool calls — delegating adds a round trip for no benefit.",
      "- When you need the result immediately and there is nothing else useful to do while waiting — that's what running it in the foreground is for, not a reason to skip the tool.",
      "- To avoid doing the work yourself; a subagent is how you parallelize or offload genuinely separable work, not a way to skip it.",
    ].join("\n"),
    gates.forkEnabled ? FORK_SECTION : undefined,
  ];
  return parts.filter((p): p is string => p !== undefined).join("\n\n");
}

stub({
  canonicalName: AGENT_TOOL_CANONICAL_NAME,
  advertisedName: AGENT_TOOL_CANONICAL_NAME,
  source: "builtin",
  inputSchema: agentInputSchemaFor(AGENT_TOOL_GATE_DEFAULTS),
  // WS-13c §3: the marker block is where the active family's one-line-per-slot listing goes
  // (`<name> — <canonicalModelId>: <description> (<reason>)`). The engine substitutes it per turn on
  // a CLONE, and STRIPS the whole block when no active slot set is wired -- so the static text a
  // scripted double advertises never contains the placeholder.
  description: renderAgentToolDescription(AGENT_TOOL_GATE_DEFAULTS) + AGENT_MODEL_SLOTS_BLOCK,
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): gated on "winter.subagents" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P4/WS-10), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.subagents"],
  disposition: "implement-now",
});

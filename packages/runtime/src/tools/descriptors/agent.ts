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
}

/** The gate-OFF defaults the static registration below uses -- byte-identical to this descriptor's pre-parity shape wherever every gate reads as it always has (fork off, background on, general-purpose present). */
export const AGENT_TOOL_GATE_DEFAULTS: AgentToolGateState = { forkEnabled: false, backgroundDisabled: false, generalPurposeAvailable: true };

function modelFieldDescription(forkEnabled: boolean): string {
  // research §A2, adapted per R-S9: the FOUR-MEMBER FAMILY-SLOT ENUM stays Winter's own (a user
  // directive, not a claude mirror) -- only the surrounding prose is claude's own structure/wording,
  // updated for "the agent definition's model frontmatter" (unchanged: Winter's own frontmatter field
  // is also literally named `model`) and, when fork is on, claude's own ignored-for-fork clause.
  const base =
    "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent.";
  return forkEnabled ? `${base} Ignored for subagent_type: "fork" — forks always inherit the parent model.` : base;
}

// R-S7: Winter's engine does not hold the turn's result while a background agent runs, so the
// FOREGROUND default is real and load-bearing, not a wording choice -- this text describes Winter's
// OWN actual default, and DELIBERATELY does not use claude's "Agents run in the background by
// default..." sentence (research §A2's own verbatim claude text), because that sentence would be
// false for Winter's own behavior. See R-S7 in the scope file for the full ruling.
const RUN_IN_BACKGROUND_DESCRIPTION =
  'Whether to run this agent in the background instead of waiting for its result. Defaults to false: the call blocks until the agent finishes, and its result comes back as this tool call\'s own output. Set to true to launch it asynchronously instead — you get a task id and a notification when it completes, and can do other useful work in the meantime. Prefer leaving this false when your very next action depends on the result and nothing else could usefully happen while you wait.';

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
    properties["run_in_background"] = { type: "boolean", description: RUN_IN_BACKGROUND_DESCRIPTION };
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
 * research §A3's own structure, Winter-worded, gate-aware. The two sentences the scope brief quotes
 * verbatim ("Available agent types are listed in <system-reminder> messages in the conversation." /
 * "If omitted, the general-purpose agent is used.") are mechanism statements about how THIS session's
 * own listing (item 3, `renderAgentListing`) and lookup (item 1, `findAgentByType`'s omitted-type
 * fallback) actually behave -- reused as given, not claude prose.
 */
export function renderAgentToolDescription(gates: AgentToolGateState = AGENT_TOOL_GATE_DEFAULTS): string {
  const backgroundAdvertised = !gates.forkEnabled && !gates.backgroundDisabled;
  const parts = [
    "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.",
    "Available agent types are listed in <system-reminder> messages in the conversation.",
    gates.generalPurposeAvailable ? OMITTED_TYPE_SENTENCE_AVAILABLE : OMITTED_TYPE_SENTENCE_UNAVAILABLE,
    [
      "When to use the Agent tool:",
      "- The task is complex or long enough that doing it inline would spend a lot of your own context on intermediate steps you don't need to keep.",
      "- The task is naturally delegable: a self-contained search, a focused piece of research, an isolated implementation step.",
      "- You have several independent pieces of work to launch — send them in a single message with multiple tool uses so they run concurrently.",
    ].join("\n"),
    [
      "Writing the prompt:",
      "- State the task and the result you expect concretely; the agent sees only what you put in `prompt`, never the rest of this conversation.",
      '- Say what "done" looks like, including the form you want the answer back in.',
      "- Do not ask a specialized agent type to do something outside its own specialization (for example, a read-only agent to make an edit) — pick a different type instead.",
    ].join("\n"),
    backgroundAdvertised
      ? [
          "By default, an agent you launch runs in the FOREGROUND: this call does not return until it finishes, and its result comes back as this call's own output. Set run_in_background: true to launch it asynchronously instead — you get a task id and a notification when it completes, and can do other useful work while it runs.",
        ].join("\n")
      : undefined,
    [
      "When NOT to use the Agent tool:",
      "- For something you can finish yourself in one or two tool calls — delegating adds a round trip for no benefit.",
      "- When you need the result immediately and there is nothing else useful to do while waiting — prefer the foreground for that, not avoiding the tool.",
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

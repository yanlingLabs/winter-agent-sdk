// Phase 4 Task 3 (WS-10 §3.5/§4/§7/§9/§15, R4-4): the child-engine seam. Lane C (Task 6) implements
// `ChildEngineDeps`/`ChildHandle` and registers the factory via `registerChildEngineFactory`; Lane D
// (Task 7) consumes `ChildHandle` ONLY (never anything else exported here) -- the seam contract
// tests (subagents/seam-contracts-p4.test.ts) bind both to this file's own shapes.
//
// "In-process engine instance per R4-4" (the plan's own phrasing): a child is architecturally just
// another `runEngine()` invocation running inside THIS SAME process, never a second spawned `winter`
// child (that would be `isolation` in the OS-process sense, which WS-10 §8 reserves for a totally
// different, capability-gated concept -- filesystem worktree isolation, not process isolation). This
// file therefore owns the CORRELATION plumbing a child's own frame stream needs to be woven back into
// the parent's real host connection (`transformChildFrame` below), since Lane C's own child-engine.ts
// builds a child by calling `runEngine()` again with a synthetic input/output pair, and needs
// something to bridge that pair to the ACTUAL host connection this run owns.
import type { ActiveSlotSet, ControlResponseFrame, McpServerConfigForProcessTransport, OutputFormat, PermissionMode, RuntimeAgentDefinition, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import type { RecordedModelEffort } from "./resolution.ts";
import type { McpServerStateSource } from "../mcp/state.ts"; // type-only -- see this file's own header; no runtime cycle
import type { McpControlSeam } from "../mcp/control-seam.ts"; // type-only
import type { ChildPolicyResult } from "../permissions/auto/inheritance.ts";
import type { ProviderMessage } from "../engine.ts"; // type-only -- see this file's own header; no runtime cycle (Bun/tsc erase `import type` entirely)
import type { GlobalAgentMessage, DeliveryOutcome } from "../messaging/adapter.ts"; // type-only; see messaging/adapter.ts's own header for why this is a safe mutual reference

// --- Lane C implements; Lane D consumes ONLY these (verbatim from the brief's Interfaces block) ---

export type ChildStatus = "running" | "completed" | "stopped" | "failed";

export interface ChildSessionRecord {
  id: string;
  parentSessionId: string;
  parentToolUseId: string;
  transcript: string;
  status: ChildStatus;
  runtime: "winter-agent";
  /** R-6c-20: the record's model block IS `RecordedModelEffort` (`effectiveProvider`/`slot` included) — one declaration, no local intersection. */
  model: RecordedModelEffort;
  permission: { effectiveMode: PermissionMode; parentPolicyHash: string; parentPolicyVersion: number };
  name?: string;
}

// WS-10 §1.4's own 3-branch AgentOutput union, narrowed to the "completed"/local-terminal cases a
// ChildHandle's own result() can resolve (the "async_launched"/"remote_launched" IMMEDIATE branches
// are the Agent TOOL's own synchronous return shape, Lane C's tools/impl/agent.ts concern -- this is
// what result() resolves to ONCE the child itself is actually done, background or not). A minimal,
// deliberately incomplete slice of derived-shapes-p4.md item (d)'s own full field list (toolStats/
// usage/worktreePath omitted) -- widen when a real consumer needs one of those fields; inventing
// them speculatively here would be exactly the "seam that speaks for downstream code it does not
// own" this task's own R4-2 discipline exists to avoid.
export interface ChildResult {
  status: "completed" | "stopped" | "failed";
  content: string;
  resolvedModel?: string;
  totalToolUseCount?: number;
  totalDurationMs?: number;
  /**
   * RULING P5-I (Phase 5 fix wave): the child's VALIDATED structured result, when it produced one.
   *
   * `SpawnChildRequest.outputFormat` threads a schema into the child's own generation config, and the
   * child's engine validates against it and puts the value on `result.structured_output` -- and
   * nothing carried it back across this seam. Lane W's `agent({schema})` therefore re-parsed the
   * child's final TEXT and re-validated it through the same validator, which a child forced onto
   * `StructuredOutput` generally does not produce at all, so the call mostly resolved `null`.
   *
   * ABSENT when the child produced none, and a consumer must fall back to the text re-parse only
   * then -- never treat unvalidated data as validated (the ruling's own wording).
   */
  structuredOutput?: unknown;
}

export interface ChildHandle {
  readonly record: ChildSessionRecord;
  status(): ChildStatus;
  steer(msg: GlobalAgentMessage): Promise<DeliveryOutcome>;
  resume(msg: GlobalAgentMessage): Promise<DeliveryOutcome>;
  result(): Promise<ChildResult>;
  stop(): Promise<void>;
}

// WS-10 §2's own AgentDefinition surface, ALREADY fully pinned as the wire-shaped
// `RuntimeAgentDefinition` (protocol/config.ts) -- "resolved" (WS-10 §2's own "programmatic and
// filesystem-defined agents MUST coexist", precedence resolution) is Lane C's own job
// (subagents/resolution.ts), but the RESOLVED SHAPE itself needs no new fields beyond what's already
// pinned: resolution picks WHICH definition wins and merges precedence, it doesn't grow the field
// set. A type alias, not a fresh interface, so Lane C's own resolver can return a plain
// RuntimeAgentDefinition with zero adaptation.
export type ResolvedAgentDefinition = RuntimeAgentDefinition;

export interface SpawnChildRequest {
  parentToolUseId: string;
  definition?: ResolvedAgentDefinition;
  fork?: true;
  prompt: string;
  model?: string;
  runInBackground: boolean;
  isolation?: "worktree";
  name?: string;
  // Phase 5 Task 3 (R5-10): the child's own structured-output contract. Set by Lane W's `agent({schema})`
  // so a workflow-spawned agent rides the IDENTICAL StructuredOutput path the top-level session uses
  // -- registration, validation, the retry counter and the exhaustion result are all the engine's,
  // reached through `RuntimeConfig.outputFormat` on the child's generation config. A child that sets
  // it needs no second validator and no bespoke result shape.
  //
  // Typed as the pinned `OutputFormat` union rather than a bare schema so the two cannot drift.
  outputFormat?: OutputFormat;
}

export interface ChildInheritance {
  policy: ChildPolicyResult; // computeChildPolicy on the P2-M comparator
  tools: string[];
  model: string;
  effort: string;
  thinking: unknown;
  systemPrompt: string;
  /**
   * Phase 5 Task 8 (rider 12, WS-11 §6.5 "dispatch-children inherit the parent's style"): the
   * parent's resolved output-style NAME.
   *
   * Lane C's report named this exactly: the assembler already applies whatever arrives on
   * `input.outputStyle`/`config.outputStyle`, so the MECHANISM was ready and only the CHANNEL was
   * missing -- `ChildInheritance` carried policy/tools/model/effort/thinking/systemPrompt/messages/
   * sessionRoot and nothing about style, and `buildChildInheritance` set none of it on the child's
   * `RuntimeConfig`. A child therefore silently ran under the default style however the parent was
   * configured.
   *
   * Absent when the parent configured none, which is the same thing as "the default" -- never a
   * fabricated `"default"` string, so a child of a parent with no style is byte-identical to a
   * pre-P5 child.
   */
  outputStyle?: string;
  messages?: ProviderMessage[]; // fork only
  sessionRoot: string;
  /**
   * Phase 6 Task 3 (R6-17): the PARENT's RESOLVED provider identity.
   *
   * `model` above is the child's own bare string (a definition's override, or the parent's). This is
   * what that string resolves AGAINST: `AgentDefinition.model` goes through the same selection path
   * as the session's, against the PARENT's provider unless the id is itself qualified. Without this
   * field a child with a bare model id had no provider to resolve against at all and would either
   * pick the host's default or fail -- neither of which is "the parent's provider".
   *
   * It is also what makes a child's own provider-state records identify themselves: a child writes
   * its own sidecar beside its own transcript, and `provider`/`model`/`family` on those records come
   * from here.
   *
   * Absent when the parent has not resolved one (every pre-P6 session and every test double), which
   * reads as "no provider identity to inherit" -- never a fabricated one.
   */
  provider?: { providerId: string; modelKey: string; family: string; continuationDomain?: string };
  /**
   * R6-17 / P4 carry: the parent's EFFECTIVE reasoning configuration, from real session concepts.
   *
   * `effort` above is a `string` and its base value was the literal `"inherit"` -- an honest
   * placeholder written when `RuntimeConfig` carried no session-level effort concept at all. It does
   * now (`config.effort`/`config.thinking`, T2's option mirrors), so these two fields carry the real
   * resolved values a definition's own override is layered on top of. Kept SEPARATE from `effort`/
   * `thinking` above rather than replacing them: those are the REQUESTED values (a definition's, or
   * the placeholder), and WS-10 §3.4's recorded-resolution fields want both halves.
   */
  effectiveEffort?: "low" | "medium" | "high" | "xhigh" | "max" | number;
  effectiveThinking?: { type: "disabled" } | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" } | { type: "adaptive"; display?: "summarized" | "omitted" };
  /**
   * WS-13c §3 (recorded on the child, extending WS-10 §3.4): the SLOT the parent's `AgentInput.model`
   * named, and where that slot came from.
   *
   * `model` above is the bare string as sent; this says what it MEANT — `{ family: "gpt", name:
   * "astra", source: "family-default" }`. Without it a child's record cannot distinguish a slot the
   * session advertised from a unique foreign name the model copied out of older context (§3
   * acceptance (b)), which is exactly the case §8's cross-family resume has to reason about.
   *
   * `source` is the FULL four-member `ActiveSlotSet["source"]` union, not a narrowed copy: this is
   * assigned straight from `SlotProviderResolution`, and a three-member twin here would make
   * `claude-pinned` unrepresentable on the very record that documents a cross-family spawn.
   *
   * Absent when the parent resolved no slot (every pre-P6.6 session, every test double, and every
   * child whose model came from `AgentDefinition.model` host-side rather than from the tool).
   */
  slot?: { family: string; name: string; source: ActiveSlotSet["source"] };
}

// engine.ts's own spawn seam: Lane C supplies the implementation via a registered factory (below);
// the engine calls it from the Agent tool's executor path (`ToolExecutionContext.session.spawnChild`,
// engine.ts).
export interface ChildEngineDeps {
  spawn(req: SpawnChildRequest, inherit: ChildInheritance): Promise<ChildHandle>;
}

// --- The factory-registration point (this spine's own addition, per the brief's "the engine exposes
// a factory-registration point lane C fills" instruction) --------------------------------------------
//
// RUN-BOUND, not a bare `ChildEngineDeps` value: a child's own runtime-originated control_requests
// (its own permission/hook/elicitation RPCs) have nowhere to go except back out through THIS run's
// own real host connection (R4-4's "in-process engine instance" -- a child shares the parent's one
// wire connection to the host, it does not open a second one), and a child's own DATA frames need
// this run's own `forwardSubagentText` setting to know whether text/thinking gets forwarded. Both
// facts are per-RUN, not global, so the registered factory is a function of a small run context,
// called ONCE per `runEngine()` invocation (mirroring how `createRpcBridge(output)`/`realHookStage`
// are themselves built fresh per run, immediately below this seam's own call site in engine.ts) --
// never a bare, run-independent `ChildEngineDeps` singleton the way `registerTool`/`replaceExecutor`
// are (those describe a process-wide CATALOG; a child's own spawn deps are session-scoped).
export interface ChildEngineRunContext {
  // The OWNING top-level session id -- identical at every nesting level, because (Phase 4 fix wave,
  // I1) a child engine's own `RuntimeConfig.sessionId` IS this value: WS-10 addressing has one
  // owning session with N agents in it, distinguished by `agentId`, never N sessions.
  parentSessionId: string;
  // Phase 4 fix wave (I1): the SPAWNING engine's own agent key -- `config.agentId` when the spawner
  // is itself a child, absent for the one top-level session. Distinct from `parentSessionId`, which
  // no longer identifies the spawner once every descendant shares it: without this, the spawn-depth
  // table (limits.ts) would read depth 0 for every nesting level and WINTER_MAX_SUBAGENT_SPAWN_DEPTH
  // would bound nothing. Optional so a pre-existing hand-built run context keeps compiling; absent
  // means "the spawner is the top-level session", which is exactly true for such a caller.
  parentAgentId?: string;
  // Forwards ONE child WinterFrame to the REAL host-facing output this run owns, applying the
  // parent_tool_use_id correlation + the forwardSubagentText gate (transformChildFrame below) --
  // pre-bound to this run's own real output sink and forwardSubagentText setting so Lane C's own
  // child-engine.ts never has to re-derive either. A no-op return (the frame is swallowed, e.g. the
  // child's own init/result frames) is a legitimate, silent outcome, not an error.
  forwardChildFrame(frame: WinterFrame, correlation: { parentToolUseId: string; agentId: string }): void;
  // Phase 4 Task 8 (rider 19, RULING P4-I): the child bridge ROSTER hook. A child engine's own
  // permission/hook `control_request` is forwarded (verbatim, by `transformChildFrame` above) onto
  // the PARENT's real stream, because that is the only connection a host is listening on -- but the
  // host's `control_response` then arrives at the PARENT's pump, whose single `RpcBridge` has no
  // matching requestId and drops it. The child's own bridge never sees the answer, so a child under
  // any prompting mode hangs on that one call until the stall watchdog aborts it.
  //
  // P4-I's ruling: "the pump routes control_response by requestId to the issuing CHILD bridge via a
  // bridge roster on the run context (pump-side lookup; the child engine stays unaware of the parent
  // pump)". This is that roster's registration half: a child engine calls it with its OWN
  // `handleResponse` (the RpcBridge method, which already returns whether it matched), and the
  // parent pump consults every registered handler for any response its own bridge did not claim.
  // Returns an unregister function the child calls when its generation ends.
  //
  // OPTIONAL so a pre-existing ChildEngineRunContext producer (this phase's own contract-test fakes)
  // keeps compiling; a child that cannot register simply behaves as it did before P4-I.
  registerChildResponseHandler?(handle: (frame: ControlResponseFrame) => boolean): () => void;
  /**
   * RULING P5-J (Phase 5 fix wave): fold a DESCENDANT's provider usage into the OWNING session's
   * cumulative spend.
   *
   * A per-run accessor rather than a construction-time mirror, for the reason every other live
   * accessor on this interface exists: a registered factory is built once and the accountant belongs
   * to a RUN. Without it a workflow's `budget` bounded only the parent's own turns while every agent
   * it spawned spent freely -- which is what made `budget.spent()` report an honest but useless 0.
   *
   * Adds to the cumulative counter ONLY, never to `contextTokens()`: a child's tokens are spend the
   * session is responsible for, and they are not part of the parent's own next request.
   */
  recordDescendantUsage?(usage: { inputTokens: number; outputTokens: number }): void;
  // Phase 4 Task 8 (rider 26, PRECISED; RULING P4-J(e)): the parent's CURRENT live policy, for
  // WS-10 §9's "a child resume applies the stricter of the recorded and current parent policy".
  // Lane C's Q1 finding: `resolveChildResumeMode` had ZERO call sites anywhere in the repository and
  // was structurally unreachable -- `policyStateStore` is a `runEngine` local and no seam exposed it.
  // The lane's own fix round added the optional `ChildEngineFactoryDeps.getParentPolicy`; this is the
  // matching field on the RUN context, which is what a factory built once per process (main.ts) can
  // actually be handed per-spawn. Optional for the same fake-compatibility reason as above; absent
  // means the pre-P4-D behaviour (reuse the recorded mode verbatim).
  getParentPolicy?(): { mode: PermissionMode; version: number; hash: string };
  // Phase 4 fix wave (C1 CRITICAL + I6, whole-branch review): the parent's CURRENT LIVE permission
  // RULES, in the raw `disallowedTools`/`permissions.*` spelling a child's own `RuntimeConfig` takes.
  //
  // WHY THIS EXISTS AT ALL. WS-07 §3.3 makes `allowedTools`, `disallowedTools` and
  // `permissions.{allow,ask,deny}` ONE rule source (`buildSdkSourcedEntries` turns all five into
  // `source:"sdk"` entries) -- but Lane C's I1 fix mirrored only the second spelling, at CONSTRUCTION
  // time, so two escapes stood open: (a) a scoped `disallowedTools:["Bash(rm *)"]` never reached a
  // child at all (`Bash` stays advertised, so the child's complement-deny does not cover it, and the
  // scoped rule was never rebuilt) -- and under WS-07 §11's forced bypass the child ran `rm` with no
  // prompt; (b) `allowedTools` was not mirrored either, so a `default`-mode child re-prompted for
  // every tool the parent had pre-approved. Both directions of the same omission, plus the LIVE gap:
  // a rule added mid-session (a `PermissionUpdate`, or WS-07 §9's journal-restored rules) never
  // reached ANY child, because a factory registered once at startup can only see its own
  // construction-time snapshot.
  //
  // Read FRESH per generation (spawn AND resume) from the parent's live `PolicyStateStore`, exactly
  // like `getParentPolicy` above -- never a spawn-time snapshot. Returns raw rule strings
  // (`Bash(rm *)`, `Read`) rebuilt from the live `SourcedRuleSet`, deliberately flattened onto the
  // `sdk` source in the child: the engine's own `managed` BASELINE_DENY_RULES floor is re-seeded by
  // every `runEngine` on its own and is therefore excluded here (mirroring it would re-tag a managed
  // rule as `sdk` in the child, weakening its authority for no gain).
  //
  // OPTIONAL for the same fake-compatibility reason as the two fields above; absent means the
  // pre-fix-wave behaviour (`ChildEngineFactoryDeps.parentPermissionRules`, the construction-time
  // mirror, is the fallback).
  getParentRules?(): ParentRuleMirror;
  // Phase 4 fix wave (I2, whole-branch review): the parent's LIVE MCP state, so a child is not an
  // MCP island. Upstream's own model is that a subagent uses the SESSION's MCP servers; before this
  // fix a child inherited `winter.mcp` (so the four WS-09 §1.4 bridge tools and `WaitForMcpServers`
  // were ADVERTISED inside it) while its own `runEngine` registered a ToolSearch runtime with no
  // state source and no lifecycle at all -- so the bridge tools answered "no MCP lifecycle is
  // configured for this session" and `WaitForMcpServers` answered a WRONG `ready:true` with every
  // requested name in `unknown`. Handing the child the parent's own state source + control seam
  // makes its ToolSearch/WaitForMcpServers answers real; the lifecycle half falls out of I1 (a
  // bridge tool resolves `getSessionMcpLifecycle(ctx.sessionId)`, which is now the owning session's).
  //
  // Returns the run's RESOLVED pair (caller-supplied or engine-built are indistinguishable here),
  // plus the session's own declared server map so a definition's `mcpServers` string entries -- the
  // "name a server this session already declares" spelling of `AgentMcpServerSpec` -- can be
  // resolved rather than silently dropped.
  getParentMcpState?(): ParentMcpState;
  // Phase 4 fix wave, follow-up (8) -- whole-branch M7's ONE non-neutral entry. The session's own
  // PROGRAMMATIC `Options.agents` map, mirrored down so a GRANDCHILD spawn can resolve a
  // `subagent_type` the session declared. Without it, `ctx.agents` is undefined inside a child, so a
  // nested `Agent(subagent_type: "reviewer")` answers "unknown subagent_type" for a definition the
  // host demonstrably configured -- while the SAME call from the top-level session succeeds. Every
  // other M7 gap is stricter-or-neutral; this one silently breaks a working configuration one level
  // down.
  //
  // A definition-shaped WIDENING is impossible here: the map is the parent's own, verbatim, and a
  // resolved definition is still bounded by the child's inherited tool pool and the parent's live
  // rules (getParentRules above). Read at CALL time, like the two accessors above, so a host that
  // mutates its own map between spawns is not serving a stale copy.
  getParentAgents?(): Record<string, unknown> | undefined;
}

export interface ParentMcpState {
  stateSource?: McpServerStateSource;
  controlSeam?: McpControlSeam;
  declaredServers?: Record<string, McpServerConfigForProcessTransport>;
}

// The three rule buckets a child's own `RuntimeConfig.permissions` carries. `allowedTools`/
// `disallowedTools` are deliberately NOT separate fields here: they are the SAME rule source (WS-07
// §3.3), and the parent's live rule set no longer distinguishes which of the five spellings an entry
// arrived through -- so the child receives every one of them as `permissions.{allow,ask,deny}`,
// which is exactly equivalent at evaluation time and cannot drift into a two-spelling asymmetry
// again.
export interface ParentRuleMirror {
  allow: string[];
  ask: string[];
  deny: string[];
}

export type ChildEngineFactory = (runCtx: ChildEngineRunContext) => ChildEngineDeps;

let childEngineFactory: ChildEngineFactory | undefined;

export function registerChildEngineFactory(factory: ChildEngineFactory): void {
  childEngineFactory = factory;
}

export function getChildEngineFactory(): ChildEngineFactory | undefined {
  return childEngineFactory;
}

// Test-only escape hatch (mirrors registry.ts's own unregisterToolForTest / mcp/state.ts's own
// factory-per-call precedent): resets the module-level singleton so one test file's registration
// never leaks into another's assertions under bun's shared-module-instance test runner.
export function resetChildEngineFactoryForTest(): void {
  childEngineFactory = undefined;
}

// --- Host-stream correlation (WS-10 §4): the PURE transform half of MUST 5's own "child-frame
// correlation gated by forwardSubagentText" requirement -- deliberately separated from the I/O
// (writing to the real output) that ChildEngineRunContext.forwardChildFrame performs, so the
// decision logic itself is unit-testable without a live FrameSink. Returns the frame to actually
// forward, or `null` to mean "swallow this one, silently."
// ---------------------------------------------------------------------------------------------
export function transformChildFrame(
  frame: WinterFrame,
  correlation: { parentToolUseId: string; agentId: string },
  forwardSubagentText: boolean,
): WinterFrame | null {
  // WS-04 §4.1: a child's own `init` handshake is purely internal to ITS OWN runEngine() call --
  // never surfaced on the parent's real stream, which has already sent its own `init` long ago.
  if (frame.type === "init") return null;
  // control_request/control_response correlate by their OWN requestId regardless of source (the
  // bridge-multiplexing half of MUST 5 -- see engine.ts's own pump comment for how a response is
  // routed back to whichever bridge, parent's or a child's, actually issued the matching request) --
  // passed through completely unmodified.
  if (frame.type === "control_request" || frame.type === "control_response") return frame;
  if (frame.type !== "data") return frame; // unknown/other: lossless pass-through (WS-04 §2)

  const message = frame.message as { type?: string; [k: string]: unknown };
  // WS-04 §4: exactly ONE terminal result per turn on the (parent's) main stream -- a child's own
  // completion is never a second top-level "result" frame; it surfaces through the Agent tool's own
  // synchronous return value or the task_notification/task_progress family (P3's existing frames),
  // never by impersonating the main turn's own terminal result.
  if (message["type"] === "result") return null;
  // Phase 4 Task 8 (rider 23, PRECISED; RULING P4-J(c)): the DATA-WRAPPED SDK-facing init message
  // is swallowed too, not just the wire-level `init` frame above. Lane C found the gap empirically
  // (a live debug capture, not a hypothesis): a child's `{type:"system", subtype:"init"}` data frame
  // fell through every specific check to the catch-all below and reached the parent's real stream
  // carrying the CHILD's own session_id/cwd/model/tools -- so this function's own header promise
  // ("a child's own init handshake ... never surfaced on the parent's real stream") was true of one
  // of the two shapes only.
  //
  // The artifact settles which of the comment and the code was right: derived-shapes-p4 §(d) records
  // that `SDKSystemMessage` carries NO `parent_tool_use_id` field at all (`parent_tool_use_id` is on
  // exactly 6 SDKMessage variants, and the system message is not one of them). A forwarded child
  // init is therefore structurally UNCORRELATABLE -- a host receiving it cannot tell it apart from
  // the session's own identity frame, which it would be impersonating. The comment was right; the
  // code was incomplete.
  if (message["type"] === "system" && message["subtype"] === "init") return null;

  if (message["type"] === "assistant") {
    const inner = message["message"] as { content?: Array<{ type?: string; [k: string]: unknown }> } | undefined;
    const blocks = inner?.content ?? [];
    // WS-10 §4: "by default only tool_use/tool_result blocks... are forwarded... forwardSubagentText
    // additionally forwards subagent text/thinking blocks." tool_use always survives; text/thinking
    // survive only when forwardSubagentText is on.
    const filtered = forwardSubagentText ? blocks : blocks.filter((b) => b["type"] === "tool_use");
    if (filtered.length === 0) return null; // nothing left worth forwarding this frame for
    return {
      ...frame,
      message: { ...message, message: { ...inner, content: filtered }, parent_tool_use_id: correlation.parentToolUseId },
    } as WinterFrame;
  }

  // Phase 6 Task 3 (R6-5): a child's LIVE TOKEN STREAM.
  //
  // Two things this frame needs that the catch-all below cannot give it. (1) `parent_tool_use_id` IS
  // a declared field on `stream_event` (derived-shapes-p6.md item (a)), so an uncorrelated child
  // stream event reaches a host looking exactly like the main thread's own -- the same
  // impersonation the init carve-out above exists to prevent. (2) `forwardSubagentText` gates it:
  // the deltas inside are the child's text and thinking, which WS-10 §4 forwards only when that
  // option is on. Forwarding them here while the completed `assistant` frame above filters them out
  // would let a child's prose reach the parent stream in delta form past its own gate.
  if (message["type"] === "stream_event") {
    if (!forwardSubagentText) return null;
    return { ...frame, message: { ...message, parent_tool_use_id: correlation.parentToolUseId } } as WinterFrame;
  }

  if (message["type"] === "user") {
    // This engine's own "user" data-frame convention carries only tool_result blocks (engine.ts's
    // round loop) -- WS-10 §4's "tool_use/tool_result blocks... are forwarded" applies
    // unconditionally, independent of forwardSubagentText.
    return { ...frame, message: { ...message, parent_tool_use_id: correlation.parentToolUseId } } as WinterFrame;
  }

  // Every other system-subtype data frame (hook lifecycle, permission_denied, task_* progress,
  // status, etc.): forwarded unchanged. These are the child's own genuine activity, reported as
  // their own independent frames -- "never flattened into the main assistant stream" is satisfied
  // at the object-identity level (nothing here merges child content INTO a parent message), even
  // for the subset of frame kinds this function doesn't itself stamp a correlation field onto.
  return frame;
}

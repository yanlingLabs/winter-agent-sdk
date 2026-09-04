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
import type { PermissionMode, RuntimeAgentDefinition, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
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
  model: { requestedModel?: string; effectiveModel: string; requestedEffort?: string; effectiveEffort: string };
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
}

export interface ChildInheritance {
  policy: ChildPolicyResult; // computeChildPolicy on the P2-M comparator
  tools: string[];
  model: string;
  effort: string;
  thinking: unknown;
  systemPrompt: string;
  messages?: ProviderMessage[]; // fork only
  sessionRoot: string;
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
  parentSessionId: string;
  // Forwards ONE child WinterFrame to the REAL host-facing output this run owns, applying the
  // parent_tool_use_id correlation + the forwardSubagentText gate (transformChildFrame below) --
  // pre-bound to this run's own real output sink and forwardSubagentText setting so Lane C's own
  // child-engine.ts never has to re-derive either. A no-op return (the frame is swallowed, e.g. the
  // child's own init/result frames) is a legitimate, silent outcome, not an error.
  forwardChildFrame(frame: WinterFrame, correlation: { parentToolUseId: string; agentId: string }): void;
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

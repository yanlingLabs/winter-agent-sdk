// SDK 0.0.40: how each call of a tool round is SCHEDULED (claude's `isConcurrencySafe` rule, plus lanes).
//
// The engine walks a round's calls in call order. Each call is one of:
//   - CONCURRENT: it runs beside the round's other concurrent and lane calls, up to `MAX_TOOL_CONCURRENCY`
//     in flight. Started as soon as its own checks (hook stop, availability, permission -- one at a time,
//     in call order) have passed.
//   - LANE: it runs beside everything else too, but never beside another call of the SAME lane -- a lane's
//     calls run one at a time across the whole SESSION, subagents included (a host-declared exclusive
//     resource: Winter's `Computer` and `Browser`). A call takes its lane after its own checks and card, and
//     keeps it until its host work has really stopped -- see `ToolLaneTails`.
//   - SERIAL (a barrier): it waits for every call in flight to finish, then runs alone.
//
// Concurrent means "provably read-only" -- or, for a host's own in-process tool, "the host vouches its calls
// cannot interfere" -- and nothing is guessed:
//   - a BUILT-IN is concurrent only when it is named below -- the file readers and searchers, the web tools
//     and `Agent` (subagents run in parallel, as in claude) -- or when it is `Bash` with a command that is
//     read-only by claude's own classification (`permissions/bash-read-only.ts`). A built-in that changes
//     the session's own state is not: `ToolSearch` loads tools (its references are collected per call),
//     `TaskOutput` / `Monitor` follow live tasks.
//   - an MCP, in-process SDK or plugin tool is concurrent only when its server lists it `readOnlyHint: true`
//     (claude's rule for MCP tools); otherwise it is in its host-declared lane (`McpSdkServerConfig.toolLanes`,
//     in-process servers only), else concurrent when the HOST declared it concurrency-safe
//     (`McpSdkServerConfig.concurrentTools`, SDK 0.0.41, in-process servers only -- a tool that is safe to
//     run beside others without being read-only, like Winter's `SpawnSession`: the descriptor's
//     `concurrencySafe`, which nothing but this scheduler reads), else serial.
//   - a name the registry does not know (a host's own executor, a test double) is serial.
import { getRegisteredTool } from "./registry.ts";
import { isBashCommandReadOnly } from "../permissions/bash-read-only.ts";

/** At most this many concurrent/lane calls of one round run at once (claude's default). */
export const MAX_TOOL_CONCURRENCY = 10;

/** The built-ins that always run concurrently, by canonical name. */
export const CONCURRENCY_SAFE_BUILTINS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LSP", "WebFetch", "WebSearch", "Search", "Agent"]);

/** What `Bash`'s read-only classification needs to know about the session (claude reads the same three). */
export interface BashReadOnlyContext {
  cwd: string;
  originalCwd: string;
  sandboxEnabled: boolean;
}

export type CallScheduling = { kind: "concurrent" } | { kind: "lane"; lane: string } | { kind: "serial" };

/** How a call to `name` (the registered name it will run as) with `input` is scheduled. */
export function schedulingForCall(name: string, input: unknown, bash?: BashReadOnlyContext): CallScheduling {
  const descriptor = getRegisteredTool(name)?.descriptor;
  if (descriptor === undefined) return { kind: "serial" };
  if (descriptor.source === "builtin") {
    if (CONCURRENCY_SAFE_BUILTINS.has(descriptor.canonicalName)) return { kind: "concurrent" };
    if (descriptor.canonicalName === "Bash" && bash !== undefined) {
      const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined;
      // A sandbox escape is never read-only scheduling-wise: it is decided by its own permission path.
      const escapes = typeof input === "object" && input !== null && (input as { dangerouslyDisableSandbox?: unknown }).dangerouslyDisableSandbox === true;
      if (typeof command === "string" && !escapes && isBashCommandReadOnly(command, bash)) return { kind: "concurrent" };
    }
    return { kind: "serial" };
  }
  if (descriptor.source === "mcp" || descriptor.source === "sdk" || descriptor.source === "plugin") {
    if (descriptor.annotations?.readOnlyHint === true) return { kind: "concurrent" };
    if (descriptor.concurrencyLane !== undefined) return { kind: "lane", lane: descriptor.concurrencyLane };
    // SDK 0.0.41: host-declared concurrency-safe (NOT read-only). Checked after the lane: a tool in both is
    // in its lane, the stricter answer (registration already keeps at most one of the two).
    if (descriptor.concurrencySafe === true) return { kind: "concurrent" };
  }
  return { kind: "serial" };
}

/**
 * A SESSION's lanes: for each lane, the last call that entered it (settling once that call is done).
 *
 * One map per session, shared by the top-level engine and every subagent engine of the session (it rides
 * `EngineOptions.toolLaneTails` and the child-engine factory's deps), so a lane is exclusive across the
 * whole session -- two concurrent subagents, or a parent and its subagent, never run the same lane at once.
 * A call enters its lane only once its OWN checks are done -- hook stop, permission, any approval card --
 * so a call parked on a card holds no lane. One engine's calls finish their checks one at a time in call
 * order, so they enter a lane in call order; across engines, in the order their calls became ready. A call
 * holds its lane until it is done AND its execution has really stopped: an interrupted in-process host tool
 * keeps the lane until the host answers the cancel, or `SDK_MCP_CANCEL_GRACE_MS` runs out. Never rejects.
 */
export type ToolLaneTails = Map<string, Promise<unknown>>;

/**
 * How long an interrupted `sdk_mcp_call` stays pending after its `control_cancel_request`, waiting for the
 * host to answer that the tool stopped (a host that answers nothing after a cancel -- an older SDK -- costs
 * the lane this long). Until it settles, the call's concurrency lane stays held.
 */
export const SDK_MCP_CANCEL_GRACE_MS = 5_000;

/** A fresh, empty set of lanes for one session. */
export function createToolLaneTails(): ToolLaneTails {
  return new Map();
}

/**
 * Enter `lane` with `tail` (a call's never-rejecting settle): returns the previous tail to wait for, if any,
 * and drops the entry once `tail` settles while it is still the lane's last call (no unbounded growth).
 */
export function enterToolLane(lanes: ToolLaneTails, lane: string, tail: Promise<unknown>): Promise<unknown> | undefined {
  const previous = lanes.get(lane);
  // The lane's new tail settles only once BOTH this call and every holder before it are done: a call that
  // gives up while still waiting its turn (an interrupt) must not let the next one start beside a holder
  // that is still running.
  const chained = previous === undefined ? tail : Promise.all([previous, tail]).then(() => undefined);
  lanes.set(lane, chained);
  void chained.finally(() => {
    if (lanes.get(lane) === chained) lanes.delete(lane);
  });
  return previous;
}

/** Whether a call to `name` always runs beside other concurrent calls (no lane, no input-dependence). */
export function isConcurrencySafeTool(name: string): boolean {
  return schedulingForCall(name, undefined).kind === "concurrent";
}

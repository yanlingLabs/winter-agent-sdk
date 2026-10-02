// SDK 0.0.40: which calls of a tool round may run AT THE SAME TIME (claude's `isConcurrencySafe` rule).
//
// The engine runs a round's calls in call order, but consecutive CONCURRENCY-SAFE calls overlap: each is
// started as soon as its own checks (hook stop, availability, permission -- run one at a time, in call
// order) have passed, up to `MAX_TOOL_CONCURRENCY` in flight. Any other call is a BARRIER: it waits for
// every call in flight to finish, then runs alone (engine.ts's tool round).
//
// SAFE means "provably read-only", and nothing is guessed:
//   - a BUILT-IN is safe only when it is named below -- the file readers and searchers and the web tools,
//     the set claude itself runs concurrently. A built-in that reads but changes the session's own state
//     is not: `ToolSearch` loads tools (its references are collected per call), `TaskOutput` / `Monitor`
//     follow live tasks.
//   - an MCP, in-process SDK or plugin tool is safe only when the server's own listing marks it
//     `readOnlyHint: true` (claude's rule for MCP tools). No hint, or any other value, is unsafe.
//   - a name the registry does not know (a host's own executor, a test double) is unsafe.
import { getRegisteredTool } from "./registry.ts";

/** At most this many concurrency-safe calls of one round run at once (claude's default). */
export const MAX_TOOL_CONCURRENCY = 10;

/** The built-ins that may run concurrently, by canonical name. */
export const CONCURRENCY_SAFE_BUILTINS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LSP", "WebFetch", "WebSearch", "Search"]);

/** Whether a call to `name` (the registered name the call will run as) may run beside other safe calls. */
export function isConcurrencySafeTool(name: string): boolean {
  const descriptor = getRegisteredTool(name)?.descriptor;
  if (descriptor === undefined) return false;
  if (descriptor.source === "builtin") return CONCURRENCY_SAFE_BUILTINS.has(descriptor.canonicalName);
  if (descriptor.source === "mcp" || descriptor.source === "sdk" || descriptor.source === "plugin") return descriptor.annotations?.readOnlyHint === true;
  return false;
}

// Phase 4 Task 5 (LANE B, WS-06 §3.5 "ToolSearch" implement-now; WS-09 §8): the real ToolSearch
// executor. THIN by design -- the actual query-parsing/ranking/wait-retry/result-shape algorithm
// lives in `../../toolsearch/search.ts` (`executeToolSearch`), fully unit-tested there with no
// engine involvement at all. This file's only job is the ctx-adapter: resolve THIS session's
// `ToolSearchSessionRuntime` (keyed by `ctx.sessionId` -- see search.ts's own "Session runtime
// registry" section for why that side-channel exists and what still needs engine.ts's own wiring)
// and fold `executeToolSearch`'s outcome into the registry's `ToolResultPayload` shape.
import "../descriptors/tool-search.ts"; // self-sufficiency: guarantees the "ToolSearch" stub is registered before replaceExecutor runs below.
import { replaceExecutor, type ToolExecutor, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { executeToolSearch, getToolSearchSessionRuntime } from "../../toolsearch/search.ts";

export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

// Same shape/spirit as registry.ts's own `session.spawnChild` "no child engine factory registered"
// precedent (registry.ts's own comment: "a typed, non-crashing tool-result error... mirroring how a
// missing ChildEngineDeps factory registration is handled one level down") -- a session with no
// runtime registered here means engine.ts has not yet been updated to call
// `registerToolSearchSessionRuntime` for this run (this lane's own NEEDS_CONTEXT; see search.ts's
// header), not a model input error, so it is reported plainly rather than crashing the tool call.
function notWiredResult(): ToolResultPayload {
  return {
    output:
      "Error: ToolSearch has no session runtime registered for this session (WS-09 §8) -- engine.ts must call registerToolSearchSessionRuntime(sessionId, ...) once per run (toolsearch/search.ts); this is a host wiring gap, not a model input error.",
    isError: true,
  };
}

export const toolSearchExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    // Fix wave follow-up (5) / Lane X NEEDS_CONTEXT 1: `ctx.agentId ?? ctx.sessionId`, deliberately NOT
    // the bare `ctx.sessionId` the four MCP BRIDGE tools use. Lane X's I1 gives a child its PARENT's
    // `config.sessionId` and keys every session-scoped registration by `config.agentId ?? config.sessionId`,
    // so the two lookups have to disagree on purpose: a bridge tool must resolve the OWNING session's
    // MCP lifecycle (that is the I2 fix -- a child is not an MCP island), while ToolSearch must resolve
    // the CHILD's OWN runtime, whose `disallowedTools` is the complement of the child's inherited
    // allowlist. Resolving the parent's runtime here let a child `select:` a tool its own pool
    // excludes -- and on this path that name is exactly what `emitToolReference` then marks LOADED.
    // Falls back to the session id for a main-engine call, which carries no agentId at all.
    const runtime = getToolSearchSessionRuntime(ctx.agentId ?? ctx.sessionId);
    if (!runtime) return notWiredResult();

    const outcome = await executeToolSearch(input, { ...runtime, ...(ctx.emitToolReference !== undefined ? { emitToolReference: ctx.emitToolReference } : {}) });
    if (!outcome.ok) return { output: `Error: ${outcome.message}`, isError: true };
    return { output: JSON.stringify(outcome.result) };
  },
};

replaceExecutor(TOOL_SEARCH_TOOL_NAME, toolSearchExecutor);

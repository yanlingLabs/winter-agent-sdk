// Phase 4 Task 5 (LANE B, WS-09 §8.2/§8.5): the ToolSearch tool CONTRACT -- query parsing
// (select:/keyword), the pending-MCP-server wait+retry, and the pinned result shape. The actual
// `ToolExecutor` engine.ts dispatches a `tool_use` call to lives in
// `../tools/impl/tool-search.ts`, as a thin ctx-adapter over `executeToolSearch` below (never a
// second copy of this algorithm) -- see this file's own "Session runtime registry" section for why
// that split exists and what it still needs from engine.ts.
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import type { DeferralActivation } from "../tools/registry.ts";
import type { McpServerStateSource } from "../mcp/state.ts";
import { computeExposurePartition } from "./exposure.ts";
import { rankCandidates, type RankableCandidate } from "./ranking.ts";

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_PENDING_WAIT_MS = 5000;

// --- WS-09 §8.2's own pinned result shape, verbatim field-for-field --------------------------------

export interface FailedMcpServerEntry {
  name: string;
  errorCode?: string;
  error?: string;
}

export interface ToolSearchResult {
  matches: string[];
  query: string;
  total_deferred_tools: number;
  pending_mcp_servers?: string[];
  failed_mcp_servers?: FailedMcpServerEntry[];
}

export type ToolSearchOutcome = { ok: true; result: ToolSearchResult } | { ok: false; message: string };

// --- Dependencies -----------------------------------------------------------------------------------
//
// Everything below is a plain value/getter this lane can construct entirely in-memory for tests
// (createFakeMcpServerStateSource, a literal DeferralActivation, a plain PermissionMode). None of it
// requires engine.ts.
export interface ToolSearchDeps {
  // A getter, not a frozen value -- mirrors engine.ts's own `isDeferredAndUnloaded` closure (which
  // re-reads `policyStateStore.getState().mode` fresh on every call, never a value captured once at
  // session start) so a mid-session `setPermissionMode`/ExitPlanMode is reflected on the very next
  // ToolSearch call, exactly like every other mode-sensitive decision in this codebase.
  getMode(): PermissionMode;
  // Frozen for the life of the run, mirroring engine.ts's own `const deferralActivation` (RULING
  // P4-A: ENABLE_TOOL_SEARCH/provider-support/deferrable-share are resolved once at run start, not
  // re-read per call).
  activation: DeferralActivation;
  platform?: NodeJS.Platform;
  capabilities?: readonly string[];
  disallowedTools?: readonly string[];
  insideSubagent?: boolean;
  familyMetadata?: { taskNative?: boolean };
  // Absent = no MCP servers/state tracked at all for this run (every session before Lane A's real
  // transports exist, and every session with zero configured servers) -- ToolSearch still works
  // perfectly well over whatever is already eagerly/deferredly registered; it simply never has
  // anything to wait for.
  stateSource?: McpServerStateSource;
  // RULING P4-E amended (fix wave): the HOST's own `Options.toolAliases`, threaded through to
  // `computeExposurePartition`'s alias-EXCLUSION pass so ToolSearch's candidate pool never offers a
  // spelling `init.tools` withheld. Optional, and the Winter-branch DEFAULT canonical table is
  // applied unconditionally regardless -- so a runtime registered without this field still gets the
  // whole-branch C2 guarantee for the two canonical twins; this only widens the same guarantee to a
  // host-configured alias edge. Present on the SESSION-scoped shape (engine.ts registers it once per
  // run from `RuntimeConfig.toolAliases`), never per call.
  toolAliases?: Record<string, string>;
  // WS-09 §8.2 "Successful selection returns tool_reference blocks" / [WS-06] §1.3 -- the SAME seam
  // `ToolExecutionContext.emitToolReference` already is (registry.ts, Task 3): marks `names` loaded
  // in the session's own LoadedToolSet AND emits the wire tool_reference block, as one atomic
  // caller-facing action. Optional so a pure unit test can omit it entirely and just inspect the
  // returned `ToolSearchResult`.
  emitToolReference?(names: string[]): void;
  // Test-only override; production omits this (defaults to the pinned 5000ms).
  pendingWaitMs?: number;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

// WS-09 §8.2: "`select:ToolName` with multiple comma-separated names." Returns `undefined` for an
// ordinary keyword query (no "select:" prefix); returns (possibly empty) trimmed names otherwise --
// `query === "select:"` alone is a valid, if useless, direct-selection call for zero names, not a
// keyword search for the literal string "select:".
function parseSelect(query: string): string[] | undefined {
  const prefix = "select:";
  if (!query.startsWith(prefix)) return undefined;
  return query
    .slice(prefix.length)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function exposureQuery(deps: ToolSearchDeps) {
  return {
    mode: deps.getMode(),
    activation: deps.activation,
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
    ...(deps.capabilities !== undefined ? { capabilities: deps.capabilities } : {}),
    ...(deps.disallowedTools !== undefined ? { disallowedTools: deps.disallowedTools } : {}),
    ...(deps.insideSubagent !== undefined ? { insideSubagent: deps.insideSubagent } : {}),
    ...(deps.familyMetadata !== undefined ? { familyMetadata: deps.familyMetadata } : {}),
    ...(deps.toolAliases !== undefined ? { toolAliases: deps.toolAliases } : {}),
  };
}

interface Attempt {
  matches: string[];
  totalDeferredTools: number;
}

// One full pass over the LIVE registry (WS-09 §8.5 "Ground truth" -- recomputed fresh every call,
// never cached across the wait/retry boundary below). `select:` resolves against the union of
// EAGER+DEFERRED (never `hidden`, and never the raw, un-filtered registry) -- a model cannot select a
// tool it was never even shown as existing; selecting an already-eager name is a harmless, idempotent
// match (WS-09 §8.2 does not restrict `select:` to the deferred pool, and an eager name is already
// unconditionally callable regardless). Keyword search, by contrast, searches ONLY the currently
// deferred pool: an eager tool's full schema is already in the model's context, so resurfacing it as
// a "discovery" would be noise, not signal.
function runAttempt(query: string, selectNames: string[] | undefined, maxResults: number, deps: ToolSearchDeps): Attempt {
  const partition = computeExposurePartition(exposureQuery(deps));
  if (selectNames !== undefined) {
    const selectable = new Set([...partition.eager, ...partition.deferred].map((d) => d.canonicalName));
    return { matches: selectNames.filter((n) => selectable.has(n)), totalDeferredTools: partition.totalDeferredTools };
  }
  const candidates: RankableCandidate[] = partition.deferred.map((d) => ({
    name: d.canonicalName,
    description: d.description,
    ...(d.searchHint !== undefined ? { searchHint: d.searchHint } : {}),
  }));
  return { matches: rankCandidates(query, candidates, maxResults), totalDeferredTools: partition.totalDeferredTools };
}

// WS-09 §8.2: "wait up to 5 seconds for relevant pending MCP servers, refresh their catalogs, and
// retry the selection." "Relevant" is UNPINNED (§8.3/§12 Q3's own "replaceable"/"unpublished
// internals" posture extends naturally to this heuristic too -- flagged for T8 below, same as
// ranking.ts's own internals). This lane's reading, chosen for robustness over cleverness: for
// `select:`, a pending server is relevant when some UNRESOLVED requested name actually starts with
// that server's own `mcp__<server>__` construction (the exact forward format registerMcpServerTools
// itself uses, registry.ts -- never a fragile reverse-parse of the canonical name, which would be
// ambiguous for any server identifier containing "__"); for keyword search, relevance cannot be
// determined ahead of a server actually connecting, so every currently-pending server is waited on.
// Waits/retries EXACTLY ONCE, per the spec's own singular "retry" framing -- never a loop.
function relevantPendingServerNames(pendingServers: readonly string[], selectNames: string[] | undefined, unresolvedNow: string[]): string[] | undefined {
  if (selectNames === undefined) return pendingServers.length > 0 ? [...pendingServers] : undefined;
  const relevant = pendingServers.filter((server) => unresolvedNow.some((n) => n.startsWith(`mcp__${server}__`)));
  return relevant.length > 0 ? relevant : undefined;
}

export async function executeToolSearch(input: unknown, deps: ToolSearchDeps): Promise<ToolSearchOutcome> {
  const rec = asRecord(input);
  if (typeof rec.query !== "string") {
    return { ok: false, message: "ToolSearch input.query must be a string" };
  }
  const query = rec.query;
  const maxResults = typeof rec.max_results === "number" && Number.isFinite(rec.max_results) && rec.max_results > 0 ? Math.floor(rec.max_results) : DEFAULT_MAX_RESULTS;
  const pendingWaitMs = deps.pendingWaitMs ?? DEFAULT_PENDING_WAIT_MS;
  const selectNames = parseSelect(query);

  let attempt = runAttempt(query, selectNames, maxResults, deps);
  // "Incomplete": select mode found fewer names than requested; keyword mode found nothing at all.
  const incomplete = selectNames !== undefined ? attempt.matches.length < selectNames.length : attempt.matches.length === 0;

  if (incomplete && deps.stateSource !== undefined) {
    const snapshot = deps.stateSource.snapshot();
    const pendingNow = snapshot.filter((s) => s.state === "pending").map((s) => s.name);
    const unresolvedNow = selectNames !== undefined ? selectNames.filter((n) => !attempt.matches.includes(n)) : [];
    const waitTargets = relevantPendingServerNames(pendingNow, selectNames, unresolvedNow);
    if (waitTargets !== undefined) {
      await deps.stateSource.waitForPending(waitTargets, pendingWaitMs);
      attempt = runAttempt(query, selectNames, maxResults, deps); // retry against the now-refreshed registry
    }
  }

  const finalSnapshot = deps.stateSource?.snapshot() ?? [];
  const pendingFinal = finalSnapshot.filter((s) => s.state === "pending").map((s) => s.name);
  const failedFinal: FailedMcpServerEntry[] = finalSnapshot
    .filter((s) => s.state === "failed")
    .map((s) => ({ name: s.name, ...(s.errorCode !== undefined ? { errorCode: s.errorCode } : {}), ...(s.error !== undefined ? { error: s.error } : {}) }));

  if (attempt.matches.length > 0) deps.emitToolReference?.(attempt.matches);

  const result: ToolSearchResult = {
    matches: attempt.matches,
    query,
    total_deferred_tools: attempt.totalDeferredTools,
    ...(pendingFinal.length > 0 ? { pending_mcp_servers: pendingFinal } : {}),
    ...(failedFinal.length > 0 ? { failed_mcp_servers: failedFinal } : {}),
  };
  return { ok: true, result };
}

// --- Session runtime registry --------------------------------------------------------------------
//
// `ToolSearchDeps` above needs three things engine.ts computes but `ToolExecutionContext`
// (registry.ts, R4-10 no-touch) does not expose to a generic tool executor today: the run's frozen
// `DeferralActivation`, its live permission-mode getter, and its `McpServerStateSource` (all three
// are `runEngine`-closure-local -- confirmed by reading engine.ts directly: `deferralActivation` and
// `loadedToolSet` are `const`/local bindings inside `runEngine`, and `EngineOptions.mcpServerStateSource`
// is consumed only inside that same function body; nothing re-exposes any of them on
// `RegistryToolExecutorDeps`/`ToolExecutionContext`).
//
// `ToolExecutionContext.sessionId` IS on the interface, though (registry.ts) -- so a session-KEYED
// side table, populated by whoever builds a run's tool executor and read by the executor itself via
// `ctx.sessionId`, closes the gap with zero edits to any no-touch file. This mirrors an established
// idiom already in this codebase for the identical class of problem (a stateless registry-dispatched
// executor that needs to reach run-closure-local state): `subagents/child-handle.ts`'s
// `registerChildEngineFactory`/`getChildEngineFactory` (a single global factory, invoked with
// per-call context supplied explicitly) and `tools/impl/background-task-runtime.ts`'s own
// module-level task table (keyed by taskId instead of sessionId, for the identical reason). A Map
// keyed by sessionId -- rather than one single global slot -- is required here specifically because,
// unlike "one child-engine implementation for the whole process," MCP server state and deferral
// activation are genuinely PER-SESSION (this file's own `ToolSearchDeps.activation` doc comment), and
// concurrent `runEngine` calls in one process (tests do exactly this) must never observe each other's
// registrations.
//
// STALE-COMMENT SWEEP (P4 fix wave, KNOWN (8)): this paragraph used to be a NEEDS_CONTEXT saying no
// file that lane could edit was able to CALL `registerToolSearchSessionRuntime`. DISCHARGED by Task
// 8 rider 2 -- engine.ts registers this run's runtime right after `deferralActivation` and the
// effective MCP state source are in scope, and unregisters it in the run's own teardown. What
// remains true, and is why it is written down: a session with nothing registered (a hand-built test
// context, or a tool call arriving after teardown) still gets a typed, NON-crashing tool-result
// error from both `tools/impl/tool-search.ts` and `tools/impl/wait-for-mcp-servers.ts` -- the exact
// same shape registry.ts's own `session.spawnChild` uses for "no child engine factory is registered
// yet" ("mirroring how a missing ChildEngineDeps factory registration is handled one level down").
//
// M3(c) -- CLOSED in the fix wave's follow-up round (item 2), both halves: the disposer returned by
// `registerToolSearchSessionRuntime` is identity-checked (below), and engine.ts's teardown calls THAT
// rather than the unconditional by-key `unregisterToolSearchSessionRuntime`. Before both, a resumed
// child generation registering under the same agent key could have its runtime deleted by generation
// 1's still-draining teardown.
//
// Deliberately `Omit<..., "emitToolReference">`, NOT the full `ToolSearchDeps` -- `emitToolReference`
// is per-CALL (it comes from `ToolExecutionContext`, itself built fresh per tool call by
// buildRegistryToolExecutor) whereas this record is per-SESSION (registered once, read on every
// call). Keeping it out of the registered shape means a caller cannot accidentally register a
// runtime carrying its own stale/synthetic `emitToolReference` that would then fire instead of (or
// in addition to) the real `ctx.emitToolReference` a ToolExecutionContext supplies -- exactly the
// split-brain T3's own seam comment on `ToolExecutionContext.emitToolReference` closed for the
// engine ("a caller can never do one without the other"): a registered-but-not-ctx emitter would
// mark a name loaded without ever emitting the matching wire `tool_reference` block. The impl-layer
// executors (`tools/impl/tool-search.ts`) are the ONE place that recombines this record with the
// call's own `ctx.emitToolReference` into a full `ToolSearchDeps`.
export type ToolSearchSessionRuntime = Omit<ToolSearchDeps, "emitToolReference">;

const sessionRuntimes = new Map<string, ToolSearchSessionRuntime>();

// Returns an unsubscribe function mirroring every other subscribe-shaped seam in this codebase
// (McpServerStateSource.subscribe, onRegistryChange) -- a caller (engine.ts, once wired) can register
// at run start and unregister via the returned closure at run end without needing to keep the
// sessionId around separately for a second, differently-named teardown call.
// The disposer is IDENTITY-CHECKED (whole-branch review M3(c), fix wave follow-up item 2), mirroring
// `registerSessionMcpLifecycle`'s own disposer verbatim. Deleting by KEY alone is unsafe the moment
// two generations can share one key: a child's `stop()` immediately followed by `resume()` registers
// generation 2 under the same agent key while generation 1's teardown is still draining, and a
// key-only delete lets the DEAD generation remove the LIVE one's runtime -- after which every
// ToolSearch/WaitForMcpServers call in that child answers "no session runtime registered" forever.
// Checking identity makes a late disposer a no-op instead.
export function registerToolSearchSessionRuntime(sessionId: string, runtime: ToolSearchSessionRuntime): () => void {
  sessionRuntimes.set(sessionId, runtime);
  return () => {
    if (sessionRuntimes.get(sessionId) === runtime) sessionRuntimes.delete(sessionId);
  };
}

// The UNCONDITIONAL by-key delete. Kept for tests and for a caller that genuinely means "whatever is
// registered under this key, drop it" -- production teardown must use the disposer returned by
// `registerToolSearchSessionRuntime` instead (engine.ts does), for the generation race above.
export function unregisterToolSearchSessionRuntime(sessionId: string): void {
  sessionRuntimes.delete(sessionId);
}

export function getToolSearchSessionRuntime(sessionId: string): ToolSearchSessionRuntime | undefined {
  return sessionRuntimes.get(sessionId);
}

// Re-exported so a caller building a `select:` query, or parsing one back out for a test, never
// hand-rolls the "select:" prefix literal a second time.
export { parseSelect as parseToolSearchSelect };

// Phase 4 Task 4 (Lane A), WS-09 §1.2/§2/§2.1/§9: the multi-server orchestrator -- source precedence
// resolution, the three-deadline connection model, and Lane A's own REAL `McpServerStateSource`
// (mcp/state.ts's own header: "the REAL implementation... is Lane A's own job"). One instance per
// session (never a singleton -- mirrors mcp/state.ts's own fake and registry.ts's own
// createLoadedToolSet precedent: two concurrent sessions must never share connection state).
//
// Scope: this file owns connection lifecycle for the THREE REAL transports (stdio/http/sse) plus
// the STATE-ONLY feed for "sdk"-typed `config.mcpServers` entries (RULING P4-C) -- it never
// registers or unregisters tools for "sdk" entries, because T3's own `engine.ts` already does that,
// completely, directly from the wire-populated `tools[]` field
// (`packages/sdk/src/protocol/config.ts`'s `McpSdkServerConfig.tools`, populated by query.ts's
// `toWireMcpServers` whenever the host's `instance` implements `WinterMcpServerInstance`). Feeding
// this lane's OWN `McpServerStateSource` for those same entries too means BOTH the `system/init.tools`
// names array (T3's own mechanism) AND the `system/init.mcp_servers` status array (this lane's own
// mechanism) agree a configured "sdk" server exists, without this file ever touching the registry
// for a name T3's own registration loop already owns -- see registry.ts's own "same-server replace
// preserves executor" header for exactly why a SECOND, independent caller mutating the same
// registered name would be a real hazard, not just redundant.
//
// The standing `winter` server (mcp/winter-server.ts) never appears here either: it is registry-
// native (RULING P4-B, registry.ts's own `RESERVED_MCP_SERVER_NAMES`) and has no "connection" to
// report in the first place -- `resolveMcpServerSources` below refuses the literal name "winter"
// from every source, the same way `registerMcpServerTools` itself refuses it, so a host that
// (accidentally or otherwise) configures a server named "winter" gets a typed rejection long before
// this file would ever try to connect to it.
import type { McpServerConfigForProcessTransport } from "@yanlinglabs/winter-agent-sdk";
import { registerMcpServerTools, unregisterMcpServerTools, replaceExecutor, type McpToolDefinition, type ToolExecutionContext, type ToolResultPayload } from "../tools/registry.ts";
import { WINTER_SERVER_NAME } from "./winter-server.ts";
import type { McpServerState, McpServerStateKind, McpServerStateSource } from "./state.ts";
import type { McpControlSeam } from "./control-seam.ts";
import type { McpEnvConfig } from "./env.ts";
import { capMcpOutput } from "./output-cap.ts";
import { connectMcpServer, McpConnectError, type McpToolInfo, type ConnectedMcpClient } from "./client.ts";
import type { ElicitationAsker } from "./elicitation.ts";
import type { InProcessMcpServer } from "./transports/sdk.ts";
import { createMcpControlSeam } from "./control.ts";

// --- §1.2: source precedence, duplicate reporting, strictMcpConfig, trust gating ------------------

// The four config SOURCES WS-09 §1.2's precedence table names, plus a fifth, LIFECYCLE-INTERNAL-ONLY
// value: "dynamic" is never produced by `resolveMcpServerSources` (only assigned by this file's own
// `setServers` handling, control.ts's real consumer) -- it marks a server added live, after startup,
// through `setMcpServers`. Kept as one origin type (not two parallel concepts) because both
// `McpControlSeam.setServers`'s own replace-eligibility rule (derived-shapes-p4.md item (b)'s Open
// Question 3) and `resolveMcpServerSources`'s own precedence order need to reason about "did this
// name arrive through the SDK-explicit/live-control path, or through file/settings/plugin
// discovery" as the SAME axis.
export type McpConfigSourceOrigin = "explicit" | "settings" | "project" | "plugin" | "dynamic";

// WS-09 §1.2's own precedence order, highest first. "dynamic" is deliberately absent -- it is never
// a resolution INPUT (resolveMcpServerSources never produces or accepts it), only an internal
// bookkeeping tag control.ts's setServers applies after the fact.
const SOURCE_PRECEDENCE: readonly McpConfigSourceOrigin[] = ["explicit", "settings", "project", "plugin"];

export interface McpServerSource {
  origin: McpConfigSourceOrigin;
  // RAW, not-yet-validated per-name config objects -- may contain a claudeai-proxy shape, an
  // unrecognized `type`, or a structurally incomplete object; validateServerConfig (below) is what
  // turns this into a real McpServerConfigForProcessTransport or a typed rejection.
  servers: Readonly<Record<string, unknown>>;
}

export interface ResolvedMcpServerEntry {
  name: string;
  origin: McpConfigSourceOrigin;
  config: McpServerConfigForProcessTransport;
}
export interface ShadowedMcpServerEntry {
  name: string;
  origin: McpConfigSourceOrigin; // the LOSING declaration's own source
  shadowedBy: McpConfigSourceOrigin; // the source that already won this name
}
export interface RejectedMcpServerEntry {
  name: string;
  origin: McpConfigSourceOrigin;
  reason: string;
}
export interface ResolveMcpServerSourcesResult {
  resolved: ResolvedMcpServerEntry[];
  // WS-09 §1.2: "the losing declaration is reported, never silently merged" -- a PERFECTLY VALID
  // config that simply arrived at a lower-precedence source than an already-resolved name.
  shadowed: ShadowedMcpServerEntry[];
  // A declaration that is itself invalid (claudeai-proxy/unknown type/malformed) or refused by the
  // trust gate -- distinct in KIND from `shadowed` (a shadowed config was never wrong, just outranked).
  rejected: RejectedMcpServerEntry[];
}

const KNOWN_TYPES = new Set(["stdio", "http", "sse", "sdk"]);

// WS-09 §1.1: "the ordinary McpServerConfig union does not accept that backend-private variant
// [claudeai-proxy]... Winter MUST NOT accept or emulate it at runtime" -- checked FIRST, ahead of
// the generic unknown-type rejection below, so its own rejection reason names the exact thing WS-09
// §1.1 is about rather than a generic "unrecognized type" message.
function validateServerConfig(raw: unknown): { ok: true; config: McpServerConfigForProcessTransport } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "MCP server config must be an object" };
  }
  const type = (raw as { type?: unknown }).type;
  if (type === "claudeai-proxy") {
    return { ok: false, reason: 'the Claude-AI-proxy server config ({type:"claudeai-proxy",...}) is a backend-private status/config variant -- Winter never accepts or emulates it at runtime (WS-09 §1.1)' };
  }
  if (type !== undefined && !KNOWN_TYPES.has(type as string)) {
    return { ok: false, reason: `unrecognized MCP server config "type": ${JSON.stringify(type)}` };
  }
  // `type` absent or "stdio" -- WS-09 derived-shapes item (a): `type` is the ONLY optional
  // discriminant of the four variants; absence structurally means stdio.
  if (type === undefined || type === "stdio") {
    if (typeof (raw as { command?: unknown }).command !== "string") {
      return { ok: false, reason: "stdio MCP server config is missing a string 'command'" };
    }
  } else if (type === "http" || type === "sse") {
    if (typeof (raw as { url?: unknown }).url !== "string") {
      return { ok: false, reason: `${type} MCP server config is missing a string 'url'` };
    }
  } else {
    // type === "sdk"
    if (typeof (raw as { name?: unknown }).name !== "string") {
      return { ok: false, reason: "sdk MCP server config is missing a string 'name'" };
    }
  }
  return { ok: true, config: raw as McpServerConfigForProcessTransport };
}
export { validateServerConfig };

function isStdioLikeRaw(raw: unknown): boolean {
  const type = (raw as { type?: unknown } | null)?.type;
  return type === undefined || type === "stdio";
}

// Pure function of injected source maps + a trust boolean (no file I/O, no settings-loader, no
// trust-computation -- ruleset.ts's own `{trustedWorkspace: boolean}` parameter precedent is
// followed exactly: WHERE `.winter/mcp.json`/settings actually get read from disk, and HOW
// workspace trust is computed, are integration concerns for whoever assembles `McpServerSource[]`
// in a live session -- see this task's own report for the exact recipe).
export function resolveMcpServerSources(sources: readonly McpServerSource[], opts: { strictMcpConfig?: boolean; trustedWorkspace: boolean }): ResolveMcpServerSourcesResult {
  const resolved: ResolvedMcpServerEntry[] = [];
  const shadowed: ShadowedMcpServerEntry[] = [];
  const rejected: RejectedMcpServerEntry[] = [];
  // WS-09 §1.2: strictMcpConfig means ONLY explicitly-supplied servers exist -- ambient discovery
  // (settings/project/plugin) is SKIPPED entirely, not merely deprioritized underneath "explicit".
  const eligible = opts.strictMcpConfig ? sources.filter((s) => s.origin === "explicit") : sources;

  const byOrigin = new Map<McpConfigSourceOrigin, McpServerSource[]>();
  for (const s of eligible) {
    const list = byOrigin.get(s.origin) ?? [];
    list.push(s);
    byOrigin.set(s.origin, list);
  }

  // A name's fate (which source claimed it, valid or not) -- processed in PRECEDENCE order so a
  // lower-precedence source can never displace an already-decided name, matching WS-09 §1.2's own
  // "one server name resolves to exactly one config" verbatim.
  const claimed = new Map<string, McpConfigSourceOrigin>();

  for (const origin of SOURCE_PRECEDENCE) {
    for (const source of byOrigin.get(origin) ?? []) {
      for (const [name, raw] of Object.entries(source.servers)) {
        const priorClaim = claimed.get(name);
        if (priorClaim !== undefined) {
          // Already decided by a higher-precedence source -- reported as shadowed regardless of
          // whether THIS declaration would itself have been valid; DISCLOSED CHOICE: a rejected
          // higher-precedence claim still occupies the name (see the `rejected` branch below), so a
          // name is never silently backfilled from a lower-precedence source just because the
          // winning declaration turned out to be broken/untrusted.
          shadowed.push({ name, origin, shadowedBy: priorClaim });
          continue;
        }
        claimed.set(name, origin);

        if (name === WINTER_SERVER_NAME) {
          rejected.push({ name, origin, reason: `"${WINTER_SERVER_NAME}" is a reserved server identity (RULING P4-B, the standing Winter server) -- no source may configure a live MCP server under this name` });
          continue;
        }
        // WS-09 §1.2 Trust: "a checked-in .winter/mcp.json never auto-runs a stdio server in an
        // untrusted workspace" -- named for stdio specifically (the highest-risk capability, local
        // process execution); http/sse/sdk project-sourced configs are NOT gated here, a disclosed
        // scoping choice rather than a silent broadening of WS-09's own literal MUST.
        if (origin === "project" && isStdioLikeRaw(raw) && !opts.trustedWorkspace) {
          rejected.push({ name, origin, reason: "project-sourced stdio MCP server configs require a trusted workspace (WS-09 §1.2, the P2-H class); this workspace is not trusted" });
          continue;
        }
        const validated = validateServerConfig(raw);
        if (!validated.ok) {
          rejected.push({ name, origin, reason: validated.reason });
          continue;
        }
        resolved.push({ name, origin, config: validated.config });
      }
    }
  }
  return { resolved, shadowed, rejected };
}

// --- The state board: this lane's REAL McpServerStateSource (mcp/state.ts's own interface) -------

// Every optional field below is `T | undefined` explicitly, not the bare `field?: T` shorthand:
// under this package's `exactOptionalPropertyTypes: true`, `field?: T` fixes the ASSIGNABLE type at
// exactly `T` (the `?` only permits OMITTING the key at construction) -- `slot.errorCode = undefined`
// (this file's own "clear on transition unless supplied" rule, and `slot.client = undefined` on
// close) would not typecheck without the explicit `| undefined` (found by the typechecker while
// writing this file).
interface ConnectionSlot {
  name: string;
  origin: McpConfigSourceOrigin;
  config: McpServerConfigForProcessTransport;
  client?: ConnectedMcpClient | undefined;
  toolNames: string[];
  state: McpServerStateKind;
  errorCode?: string | undefined;
  error?: string | undefined;
  // WS-09 §2.1 "connected<->disabled via toggle": toggling back on restores INSTANTLY from this,
  // never through a fresh "pending" reconnect -- populated on a successful connect/cache-serve,
  // read (and left untouched) by enableSlot.
  savedTools?: McpToolInfo[] | undefined;
  // Fix round 1 (MAJOR M2): a per-slot connect-ATTEMPT generation. Bumped by `beginAttempt` (every
  // call site that starts a real connect: connectOneServer's cache-miss path, the on-demand
  // "cached -> connect" path in installExecutorsForSlot) and by every operation that supersedes
  // whatever is in flight (disableSlot, removeSlot, dispose -- addAndConnect and reconnectExisting
  // supersede implicitly, via a fresh slot object or a nested connectOneServer call that bumps this
  // itself). `isCurrentAttempt` is the single place that reads it back before any attempt commits a
  // visible side effect (slot.client, tool registration/executor install, setSlotState) -- see this
  // file's own report for the exact race this closes.
  gen: number;
  // Post-fix-round advisory finding: two CONCURRENT on-demand connects (both hitting this same
  // "cached -> connect" branch at once) must never race each other via beginAttempt/isCurrentAttempt
  // -- that mechanism is for SUPERSEDING an attempt something else legitimately wants dead
  // (disable/remove/reconnect/replace), not for two callers who both just want the SAME "connect on
  // first use" outcome. `inflight` lets every concurrent on-demand caller share the ONE real attempt
  // already in progress instead of starting a second that would invalidate the first's own gen.
  inflight?: Promise<boolean> | undefined;
}

function toWireState(slot: ConnectionSlot): McpServerState {
  return {
    name: slot.name,
    state: slot.state,
    toolNames: slot.toolNames,
    ...(slot.errorCode !== undefined ? { errorCode: slot.errorCode } : {}),
    ...(slot.error !== undefined ? { error: slot.error } : {}),
  };
}

// Mirrors mcp/state.ts's own createFakeMcpServerStateSource almost exactly (subscribe/notify/
// waitForPending) -- the REAL difference is that transitions are driven by actual connection
// attempts below, never by a test calling `.transition()` directly.
function createStateBoard() {
  const slots = new Map<string, ConnectionSlot>();
  const listeners = new Set<(states: McpServerState[]) => void>();

  function snapshotArray(): McpServerState[] {
    return Array.from(slots.values()).map(toWireState);
  }
  function notify(): void {
    const snap = snapshotArray();
    for (const cb of listeners) {
      try {
        cb(snap);
      } catch (err) {
        console.error("mcp/lifecycle: a McpServerStateSource subscriber threw", err);
      }
    }
  }
  // Fix-round-1 parity with mcp/state.ts's own fake (MAJOR item 3): `toolNames` carries over from
  // the prior state when a transition omits it (a real reconnect that hasn't re-discovered tools
  // yet), but `errorCode`/`error` are CLEARED unless the caller explicitly supplies them -- an error
  // belongs to the state that produced it.
  function setSlotState(name: string, state: McpServerStateKind, extra?: { errorCode?: string; error?: string; toolNames?: string[] }): void {
    const slot = slots.get(name);
    if (!slot) return;
    slot.state = state;
    if (extra?.toolNames !== undefined) slot.toolNames = extra.toolNames;
    slot.errorCode = extra?.errorCode;
    slot.error = extra?.error;
    notify();
  }
  function waitForPending(servers: string[] | undefined, deadlineMs: number): Promise<McpServerState[]> {
    const targets = servers ?? Array.from(slots.keys());
    const anyStillPending = () => targets.some((n) => slots.get(n)?.state === "pending");
    if (!anyStillPending()) return Promise.resolve(snapshotArray());
    return new Promise<McpServerState[]>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(snapshotArray());
      }, deadlineMs);
      timer.unref?.();
      unsubscribe = subscribe(() => {
        if (settled || anyStillPending()) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(snapshotArray());
      });
    });
  }
  function subscribe(cb: (states: McpServerState[]) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  const stateSource: McpServerStateSource = { snapshot: snapshotArray, subscribe, waitForPending };
  return { slots, stateSource, setSlotState, notify };
}

// `alwaysLoad` exists on the stdio/http/sse variants but NOT on `McpSdkServerConfig` (registry.ts's
// own `buildMcpToolDescriptor` comment: an SDK server's "always load" knob is a per-tool `_meta`
// mechanism instead, WS-09 §9's own footnote) -- a helper rather than four repeated narrows, since
// `McpServerConfigForProcessTransport` is a union and `alwaysLoad` is not a common property across
// every member (a bare `.alwaysLoad` access does not typecheck without narrowing `type !== "sdk"`
// first). Every call site in this file only ever reaches this for a non-"sdk" slot in the first
// place (RULING P4-C's own sdk-slot path never calls it), so `undefined` for "sdk" is unreachable in
// practice, not just a defensive fallback -- returned anyway so the function has an honest total
// signature.
function getAlwaysLoad(config: McpServerConfigForProcessTransport): boolean | undefined {
  return config.type === "sdk" ? undefined : config.alwaysLoad;
}

// Returns the already-conditioned partial object for a `registerMcpServerTools` opts spread --
// NOT a bare `getAlwaysLoad(config) !== undefined ? {alwaysLoad: getAlwaysLoad(config)} : {}` at
// each call site: `tsc` cannot narrow a SECOND, independent call to the same function based on the
// first call's own result (each invocation is an unrelated expression to the checker), which under
// `exactOptionalPropertyTypes` left the spread's inferred type as `{alwaysLoad?: boolean|undefined}`
// instead of the properly-conditioned `{alwaysLoad: boolean} | {}` union (found while writing this
// file). Calling `getAlwaysLoad` exactly ONCE, in a local, is what actually narrows.
function alwaysLoadOpt(config: McpServerConfigForProcessTransport): { alwaysLoad: boolean } | Record<string, never> {
  const value = getAlwaysLoad(config);
  return value !== undefined ? { alwaysLoad: value } : {};
}

// --- Tool-call timeout resolution (WS-09 §1.1/§2: per-server `timeout` overrides MCP_TOOL_TIMEOUT) --

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000; // mirrors T3's own sdk_mcp_call bridge default (engine.ts)

function resolveToolCallTimeoutMs(config: McpServerConfigForProcessTransport, env: McpEnvConfig): number {
  // WS-09 §1.1 doc-asserted boundary: values below 1000ms are IGNORED, falling through to
  // MCP_TOOL_TIMEOUT or the default (derived-shapes-p4.md item (a)).
  if (config.timeout !== undefined && config.timeout >= 1000) return config.timeout;
  return env.toolTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
}

function contentToText(content: readonly unknown[]): string {
  const parts = content.map((block) => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
      return (block as { text: string }).text;
    }
    return JSON.stringify(block);
  });
  return parts.join("\n");
}

function toolInfoToDefinition(tool: McpToolInfo): McpToolDefinition {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
  };
}

// --- The discovery cache (WS-09 §2: "MCP_DISCOVERY_CACHE=1... a remote HTTP/SSE server with a
// valid cache entry supplies its cached tool list without connecting") ---------------------------

export interface McpDiscoveryCache {
  get(key: string): McpToolInfo[] | undefined;
  set(key: string, tools: McpToolInfo[]): void;
}

// In-memory, process-lifetime-only default (CAPTURE-PENDING, R4-8 class: WS-09 names no persistence
// mechanism at all for this cache -- Open Question 2 treats the whole feature as "explicit-env-only,
// rollout state out of scope," so a real cross-process/cross-restart cache store is speculative
// infrastructure this phase has no pinned shape to build against). Injectable so a future task can
// supply a durable implementation without this file's own connection logic changing at all.
export function createInMemoryDiscoveryCache(): McpDiscoveryCache {
  const map = new Map<string, McpToolInfo[]>();
  return {
    get: (key) => map.get(key),
    set: (key, tools) => {
      map.set(key, tools);
    },
  };
}

function isCacheableTransport(config: McpServerConfigForProcessTransport): boolean {
  // WS-09 §2 table, verbatim: "a remote HTTP/SSE server" -- never stdio (a local process has no
  // remote discovery-cache concept) and never sdk (RULING P4-C's own state-only feed path, which
  // never reaches this function at all -- see this file's own header).
  return config.type === "http" || config.type === "sse";
}

// --- The orchestrator ----------------------------------------------------------------------------

export interface McpLifecycleDeps {
  // Already fully resolved (resolveMcpServerSources's own output, or a hand-built equivalent) --
  // this constructor does not itself call resolveMcpServerSources; a caller that wants source-
  // precedence handling calls it first and passes `.resolved` here.
  servers: readonly ResolvedMcpServerEntry[];
  envConfig: McpEnvConfig;
  elicitationAsk: ElicitationAsker;
  // Keyed by server name -- required for a `config.type === "sdk"` entry to be a REAL connection
  // (this lane's own fixtures; a future direct-instance producer). Absent for a given "sdk" name
  // means RULING P4-C's state-only feed path (no live object to connect to; T3's own engine.ts is
  // the actual tool bridge for that case, see this file's own header).
  inProcessServers?: Readonly<Record<string, InProcessMcpServer>>;
  discoveryCache?: McpDiscoveryCache;
}

export type RefreshServerToolsResult = { ok: true; toolNames: string[] } | { ok: false; reason: string };

export interface McpLifecycle {
  readonly stateSource: McpServerStateSource;
  readonly controlSeam: McpControlSeam;
  // WS-09 §2's three-deadline startup model. Resolves once the startup obligations are satisfied
  // (see this function's own body for exactly which servers it does/doesn't wait for); every
  // ordinary (non-alwaysLoad) server keeps connecting in the background regardless of when this
  // resolves.
  start(): Promise<void>;
  // Closes every live connection and unregisters every tool this instance ever registered -- for
  // tests and orderly shutdown; never called by production code today (this instance is not yet
  // wired into a live session's teardown path, see this task's own report).
  dispose(): Promise<void>;
  // --- The bridge-tool surface (WS-09 §1.4; tools/impl/{list-mcp-resources-tool,
  // read-mcp-resource-tool, read-mcp-resource-dir-tool, refresh-mcp-tools}.ts) -----------------
  //
  // Deliberately STRICT: only a server in the live `"connected"` state (a real, present `client`)
  // is ever returned/refreshed here -- a `"cached"` server's tools are advertised (WS-09 §2.1: it
  // "counts as ready"), but WS-09's own "first live call" trigger is scoped, in this
  // implementation, to ORDINARY TOOL CALLS (installExecutorsForSlot's own on-demand connect) and
  // deliberately NOT extended to these bridge tools -- a disclosed scope choice, not an oversight.
  listConnectedServerNames(): string[];
  getConnectedClient(server: string): ConnectedMcpClient | undefined;
  // WS-09 §1.4: "re-queries connected servers' tool lists; never establishes a disconnected
  // connection." Refusing (a typed `{ok:false}`, never a connection attempt) for any server not
  // ALREADY `"connected"` is what makes that guarantee structural rather than a convention this
  // function could accidentally violate.
  refreshServerTools(server: string): Promise<RefreshServerToolsResult>;
}

// --- Phase 4 Task 8 (rider 11): the per-session lifecycle registry -------------------------------
//
// The four WS-09 §1.4 bridge tools reach their lifecycle through an `McpLifecycleResolver`
// (`(ctx: ToolExecutionContext) => McpLifecycle | undefined`, tools/impl/list-mcp-resources-tool.ts)
// and each installs an INERT default at module load. This is what a live run registers into so that
// default becomes real -- keyed by SESSION id, deliberately, and not (a) a module singleton, because
// a host process runs many concurrent sessions and each owns its own connections, nor (b) a per-run
// `replaceExecutor`, which would mutate the process-wide tool registry once per run and leave the
// LAST run's closure installed for every later one. Mirrors toolsearch/search.ts's own
// session-keyed runtime registry exactly, for the same reason it exists there.
const sessionLifecycles = new Map<string, McpLifecycle>();

export function registerSessionMcpLifecycle(sessionId: string, lifecycle: McpLifecycle): () => void {
  sessionLifecycles.set(sessionId, lifecycle);
  return () => {
    if (sessionLifecycles.get(sessionId) === lifecycle) sessionLifecycles.delete(sessionId);
  };
}

export function getSessionMcpLifecycle(sessionId: string): McpLifecycle | undefined {
  return sessionLifecycles.get(sessionId);
}

export function createMcpLifecycle(deps: McpLifecycleDeps): McpLifecycle {
  const { slots, stateSource, setSlotState } = createStateBoard();
  const discoveryCache = deps.discoveryCache ?? createInMemoryDiscoveryCache();

  for (const entry of deps.servers) {
    // "pending" (not "unconfigured" -- WS-09 §2.1 reserves that state for a NAME referenced by
    // some request but absent from this session's config entirely, which never applies to an
    // entry that came from `deps.servers` in the first place; that "referenced but unknown" case is
    // instead simply ABSENT from this state board's own snapshot, for a higher layer -- e.g. Lane
    // B's WaitForMcpServers -- to classify against the set of names it actually asked about).
    // `start()` immediately (synchronously, before this constructor returns to its own caller)
    // transitions every non-"sdk" slot through `connectOneServer`'s own `setSlotState(...,
    // "pending")` anyway, so this placeholder is observable only in the narrow window between
    // construction and `start()` -- a real state, not a lie, since every one of these servers IS
    // about to attempt a connection.
    slots.set(entry.name, { name: entry.name, origin: entry.origin, config: entry.config, toolNames: [], state: "pending", gen: 0 });
  }

  function installExecutorsForSlot(slot: ConnectionSlot, tools: readonly McpToolInfo[]): void {
    for (const tool of tools) {
      const canonicalName = `mcp__${slot.name}__${tool.name}`;
      const toolName = tool.name;
      replaceExecutor(canonicalName, {
        async execute(input: unknown, _ctx: ToolExecutionContext): Promise<ToolResultPayload> {
          // WS-09 §2.1: a `cached` server's live connection is deferred to its first tool call.
          if (slot.state === "cached" && !slot.client) {
            // Fix round 1 (MAJOR M2, then a post-fix-round correction): this is a SECOND
            // connect-attempt call site (the first is connectOneServer's own cache-miss path) -- a
            // disable/remove/reconnect racing it must not let it commit a client, tool registration,
            // or state transition for a slot that moved on. But TWO CONCURRENT calls into THIS branch
            // must never race EACH OTHER that way: `slot.inflight` lets every concurrent caller share
            // the one real attempt already under way, instead of each minting its own generation and
            // invalidating the other's (the exact regression this comment now prevents -- see
            // ConnectionSlot.inflight's own doc comment).
            let gen: number | undefined;
            try {
              const committed = await (slot.inflight ??= (async () => {
                gen = beginAttempt(slot);
                try {
                  return await connectSlotForReal(slot, gen);
                } finally {
                  slot.inflight = undefined;
                }
              })());
              if (!committed) {
                // Superseded while connecting (by disable/remove/reconnect/replace -- never by a
                // fellow concurrent on-demand caller, which shares this same attempt instead) --
                // whatever superseded it owns the slot's state now; this call just reports "not
                // connected" rather than resurrecting it.
                return { output: `Error: mcp server "${slot.name}" is not connected (state: ${slot.state})`, isError: true };
              }
            } catch (err) {
              if (gen === undefined || !isCurrentAttempt(slot, gen)) {
                // Superseded while FAILING -- something else already owns this slot's state; a
                // stale failure must never stomp it. `gen === undefined` covers a caller that only
                // ever AWAITED the shared `inflight` promise without minting its own generation (it
                // was not the one that started the attempt, so it has nothing of its own to check).
                return { output: `Error: mcp server "${slot.name}" is not connected (state: ${slot.state})`, isError: true };
              }
              const code = err instanceof McpConnectError ? err.code : "unknown";
              const message = err instanceof Error ? err.message : String(err);
              // WS-09 §2.1: "a cached server whose first live call fails re-classifies to failed and
              // its tools are withdrawn rather than left dangling."
              setSlotState(slot.name, code === "needs_auth" ? "needsAuth" : "failed", { errorCode: code, error: message });
              unregisterMcpServerTools(slot.name);
              return { output: `Error: mcp server "${slot.name}" (cached) failed to connect on first use: ${message}`, isError: true };
            }
          }
          if (!slot.client) {
            return { output: `Error: mcp server "${slot.name}" is not connected (state: ${slot.state})`, isError: true };
          }
          const timeoutMs = resolveToolCallTimeoutMs(slot.config, deps.envConfig);
          try {
            const result = await slot.client.callTool(toolName, (input ?? {}) as Record<string, unknown>, { timeoutMs });
            const capped = capMcpOutput(contentToText(result.content), deps.envConfig.maxOutputTokens);
            return { output: capped.text, ...(result.isError === true ? { isError: true as const } : {}) };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { output: `Error: mcp tool call "${toolName}" on server "${slot.name}" failed: ${message}`, isError: true };
          }
        },
      });
    }
  }

  // Fix round 1 (MAJOR M2, corrected post-`8939e0f`): `slots.get(slot.name) === slot` catches every
  // seam that REPLACES or REMOVES the slot object (addAndConnect, removeSlot); `slot.gen === gen`
  // catches every seam that supersedes an in-flight attempt WITHOUT touching the map (disableSlot; a
  // second connectOneServer call via reconnectExisting/enableSlot, through beginAttempt's own
  // unconditional bump). A second CONCURRENT on-demand-connect call (installExecutorsForSlot's own
  // "cached -> connect" branch) is deliberately NOT on this list any more -- it shares the one
  // in-flight attempt via `slot.inflight` instead of superseding it (the M2-correction fix); this
  // check still protects that SHARED attempt against a genuine disable/remove/reconnect/replace race,
  // it just no longer treats a second on-demand caller as one itself. Deliberately state-agnostic --
  // no `expected: "pending" | "cached"` parameter -- because EVERY mutation capable of invalidating
  // an attempt already bumps gen or replaces identity (enumerated in ConnectionSlot's own `gen`
  // comment); "same slot object, same gen" is therefore already sufficient proof that nothing else
  // has touched this slot since the attempt began, whatever its state string happens to be.
  function isCurrentAttempt(slot: ConnectionSlot, gen: number): boolean {
    return slots.get(slot.name) === slot && slot.gen === gen;
  }

  // Bumps and returns the slot's own attempt generation -- called exactly once by whichever call
  // site is STARTING a real connect (connectOneServer's cache-miss path; the on-demand
  // "cached -> connect" path in installExecutorsForSlot). The returned value is what that attempt's
  // own completion handling must present to `isCurrentAttempt` before committing any visible side
  // effect.
  function beginAttempt(slot: ConnectionSlot): number {
    return ++slot.gen;
  }

  // Returns whether it actually committed (`false` means a caller-visible supersede happened while
  // this attempt was connecting -- disable/remove/reconnect/on-demand-replace) -- every caller MUST
  // branch on this rather than assuming a resolved promise means "connected."
  async function connectSlotForReal(slot: ConnectionSlot, gen: number): Promise<boolean> {
    const client = await connectMcpServer({
      name: slot.name,
      config: slot.config,
      // MCP_TIMEOUT -- the PER-SERVER connection bound (never the batch-snapshot deadline, never a
      // tool-call timeout; see client.ts's own header).
      connectTimeoutMs: deps.envConfig.timeoutMs,
      elicitationAsk: deps.elicitationAsk,
      ...(deps.inProcessServers?.[slot.name] !== undefined ? { inProcessServer: deps.inProcessServers[slot.name] } : {}),
    });
    const tools = await client.listTools();
    if (!isCurrentAttempt(slot, gen)) {
      // Superseded while connecting -- whatever superseded this attempt (disableSlot, removeSlot,
      // reconnectExisting, a replacement addAndConnect, or a second connect attempt on this same
      // slot) already owns the slot's visible state. Committing here would silently resurrect a
      // disabled server, leak a registered tool for a removed one, or double-register against a
      // replacement -- close what THIS attempt opened and walk away quietly (fix round 1, MAJOR M2).
      await client.close().catch(() => {});
      return false;
    }
    slot.client = client;
    slot.toolNames = tools.map((t) => t.name);
    slot.savedTools = tools;
    registerMcpServerTools(slot.name, tools.map(toolInfoToDefinition), {
      deferredDefault: true, // WS-09 §8: connected MCP tools are exactly the "deferrable external action tools" Tool Search targets
      ...alwaysLoadOpt(slot.config),
    });
    installExecutorsForSlot(slot, tools);
    if (deps.envConfig.discoveryCache && isCacheableTransport(slot.config)) {
      discoveryCache.set(slot.name, tools);
    }
    return true;
  }

  function connectOneServer(slot: ConnectionSlot): Promise<void> {
    const gen = beginAttempt(slot);
    setSlotState(slot.name, "pending");
    if (deps.envConfig.discoveryCache && isCacheableTransport(slot.config)) {
      const cached = discoveryCache.get(slot.name);
      if (cached) {
        // Synchronous, no I/O in between setSlotState("pending") above and here -- no staleness
        // window exists for this branch (nothing else can run and supersede it mid-way).
        slot.toolNames = cached.map((t) => t.name);
        slot.savedTools = cached;
        registerMcpServerTools(slot.name, cached.map(toolInfoToDefinition), {
          deferredDefault: true,
          ...alwaysLoadOpt(slot.config),
        });
        installExecutorsForSlot(slot, cached);
        setSlotState(slot.name, "cached", { toolNames: slot.toolNames });
        return Promise.resolve();
      }
    }
    return connectSlotForReal(slot, gen).then(
      (committed) => {
        // `committed` already implies `isCurrentAttempt` was true the instant connectSlotForReal
        // checked it, and nothing asynchronous runs between that check and this callback -- but
        // re-checking here costs nothing and keeps this callback correct even if that internal
        // ordering ever changes.
        if (!committed || !isCurrentAttempt(slot, gen)) return;
        setSlotState(slot.name, "connected", { toolNames: slot.toolNames });
      },
      (err: unknown) => {
        // A stale FAILURE must never stomp a slot that has since moved on (e.g. disabled, or a
        // replacement connect already succeeded) -- same staleness discipline as the success path.
        if (!isCurrentAttempt(slot, gen)) return;
        const code = err instanceof McpConnectError ? err.code : "unknown";
        const message = err instanceof Error ? err.message : String(err);
        setSlotState(slot.name, code === "needs_auth" ? "needsAuth" : "failed", { errorCode: code, error: message });
      },
    );
  }

  // RULING P4-C: "in-process SDK servers appear in system/init.mcp_servers as connected" -- state
  // only, see this file's own header for why tool registration is deliberately NEVER performed here.
  function feedSdkSlotConnected(slot: ConnectionSlot): void {
    const toolNames = slot.config.type === "sdk" ? (slot.config.tools ?? []).map((t) => t.name) : [];
    setSlotState(slot.name, "connected", { toolNames });
  }

  async function start(): Promise<void> {
    const alwaysLoadWaits: Promise<void>[] = [];
    for (const slot of slots.values()) {
      // RULING P4-C's state-only feed applies ONLY when there is no live instance to actually
      // connect to (T3's own engine.ts is the real tool bridge for that case, see this file's own
      // header) -- an "sdk" entry THIS caller supplied a real `inProcessServers[name]` for (this
      // lane's own fixtures; a future direct-instance producer) gets the FULL real-connection
      // treatment below instead, exactly like any other transport, so its tools are actually
      // discovered and registered through this file's own machinery.
      if (slot.config.type === "sdk" && deps.inProcessServers?.[slot.name] === undefined) {
        feedSdkSlotConnected(slot);
        continue;
      }
      const attempt = connectOneServer(slot);
      // WS-09 §2: "alwaysLoad: true... makes startup wait for that server, subject to the 5s
      // blocking connect deadline unless served from cache" -- true regardless of the nonblocking
      // default. An in-process "sdk" connection (a real inProcessServer supplied) is ALSO always
      // awaited here, unconditionally on the config's own (nonexistent, for "sdk") alwaysLoad flag:
      // WS-09 §2's own text says an in-process server "has no external process/network connection
      // to await" -- there is no slow I/O for the nonblocking background pool to usefully defer, so
      // treating it as awaited-by-default (rather than racing the rest of `start()`'s own callers
      // against an in-memory connect that was always going to finish near-instantly anyway) is both
      // the more spec-faithful reading and avoids a real observable race on `start()`'s own return.
      if (getAlwaysLoad(slot.config) === true || (slot.config.type === "sdk" && deps.inProcessServers?.[slot.name] !== undefined)) {
        alwaysLoadWaits.push(attempt);
      }
    }
    if (deps.envConfig.connectionNonblocking === false) {
      // MCP_CONNECTION_NONBLOCKING=0: startup waits for the WHOLE batch, bounded by the
      // batch-snapshot deadline.
      await stateSource.waitForPending(undefined, deps.envConfig.connectTimeoutMs);
    } else if (alwaysLoadWaits.length > 0) {
      await Promise.race([Promise.all(alwaysLoadWaits), new Promise<void>((resolve) => setTimeout(resolve, deps.envConfig.connectTimeoutMs).unref?.())]);
    }
    // Otherwise: fully nonblocking, `start()` returns immediately; every ordinary server keeps
    // connecting in the background (WS-09 §2's own default row).
  }

  async function dispose(): Promise<void> {
    for (const slot of slots.values()) {
      // Fix round 1 (MAJOR M2): invalidate any in-flight connect attempt for EVERY slot before/while
      // tearing down -- otherwise a pending attempt resolving after dispose() returns can re-register
      // tools and reopen a client for a lifecycle instance that no longer exists from its caller's
      // point of view.
      slot.gen++;
      if (slot.client) {
        await slot.client.close().catch(() => {});
        slot.client = undefined;
      }
      unregisterMcpServerTools(slot.name);
    }
  }

  function listConnectedServerNames(): string[] {
    return Array.from(slots.values())
      .filter((s) => s.state === "connected" && s.client !== undefined)
      .map((s) => s.name);
  }

  function getConnectedClient(name: string): ConnectedMcpClient | undefined {
    const slot = slots.get(name);
    return slot?.state === "connected" ? slot.client : undefined;
  }

  async function refreshServerTools(name: string): Promise<RefreshServerToolsResult> {
    const slot = slots.get(name);
    if (!slot) return { ok: false, reason: `unknown MCP server "${name}"` };
    if (slot.state !== "connected" || !slot.client) {
      // WS-09 §1.4's own MUST: "never establishes a disconnected connection" -- refused, not
      // upgraded into a connection attempt, for EVERY non-"connected" state (including "cached",
      // which has no live client to re-query yet -- see this file's own header on that scope
      // choice, and "pending"/"failed"/"needsAuth"/"disabled"/"unconfigured", none of which have
      // one either).
      // `slot` is guaranteed defined here (the `!slot` branch above already returned) -- no `??`
      // fallback needed, and none of this state board's real states is ever literally
      // "unconfigured" (see the constructor's own comment on that deliberate choice).
      return { ok: false, reason: `server "${name}" is not connected (state: ${slot.state}) -- RefreshMcpTools never establishes a new connection` };
    }
    const client = slot.client;
    // Fix round 1 (MAJOR M2, disclosed extension -- no separate RED cycle): a SNAPSHOT, not a bump.
    // A refresh does not itself start a new connect "attempt" in the gen sense (it reuses the live
    // client, never opens a new one) -- this exists only so a disable/remove/reconnect racing this
    // refresh's own listTools() call is detected before committing the refreshed tool list, the same
    // staleness discipline as a real connect attempt, applied to the one other place this file
    // commits registry/state changes after an unguarded `await`.
    const gen = slot.gen;
    try {
      const tools = await client.listTools();
      if (!isCurrentAttempt(slot, gen)) {
        return { ok: false, reason: `server "${name}" changed state while refreshing (now: ${slot.state}) -- discarding this refresh's result` };
      }
      slot.toolNames = tools.map((t) => t.name);
      slot.savedTools = tools;
      registerMcpServerTools(name, tools.map(toolInfoToDefinition), {
        deferredDefault: true,
        ...alwaysLoadOpt(slot.config),
      });
      installExecutorsForSlot(slot, tools);
      // Still "connected" -- a refresh is not itself a state TRANSITION, but subscribers (and a
      // future `system/init.tools` re-derivation) need to observe the possibly-changed tool list,
      // so this still notifies via setSlotState rather than mutating `slot.toolNames` silently.
      setSlotState(name, "connected", { toolNames: slot.toolNames });
      return { ok: true, toolNames: slot.toolNames };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `refreshing server "${name}" failed: ${message}` };
    }
  }

  // --- McpLifecycleInternals: the seam control.ts implements McpControlSeam against ---------------
  const internals: McpLifecycleInternals = {
    hasSlot: (name) => slots.has(name),
    getSlotOrigin: (name) => slots.get(name)?.origin,
    listSlotNames: () => Array.from(slots.keys()),
    async reconnectExisting(name: string): Promise<void> {
      const slot = slots.get(name)!;
      if (slot.client) {
        await slot.client.close().catch(() => {});
        slot.client = undefined;
      }
      unregisterMcpServerTools(name);
      // WS-09 §2.1: "any->pending via reconnectMcpServer" -- unconditional, even from `disabled`.
      await connectOneServer(slot);
      if (slot.state === "failed" || slot.state === "needsAuth") {
        throw new Error(slot.error ?? `mcp: reconnect "${name}" failed (state: ${slot.state})`);
      }
    },
    disableSlot(name: string): void {
      const slot = slots.get(name)!;
      // Fix round 1 (MAJOR M2): THE load-bearing bump for this seam -- disabling never replaces or
      // removes the slot object (see below), so this is the ONLY signal an in-flight connect attempt
      // has to detect "something superseded me." Without it: a connect started before this call
      // resolves AFTER it, and its completion handler would re-register tools and flip the state
      // straight back to "connected", silently undoing the disable.
      slot.gen++;
      // Deliberately does NOT close `slot.client`: WS-09 §2.1 names this transition
      // "connected<->disabled via toggle" -- direct, never through `pending` -- which only makes
      // sense as a PURE VISIBILITY toggle (hide the tools from the model-visible registry) over an
      // otherwise-healthy connection, not a connection-lifecycle event. Tearing down a live
      // transport here would make `enableSlot` need a fresh handshake to come back, contradicting
      // the "instant, no pending" shape the transition table itself pins. The live connection
      // (idle, unregistered) is closed for real only by `dispose()`/`removeSlot`/`reconnectExisting`.
      unregisterMcpServerTools(name);
      setSlotState(name, "disabled", { toolNames: slot.toolNames });
    },
    async enableSlot(name: string): Promise<void> {
      const slot = slots.get(name)!;
      // Common case: the connection disableSlot deliberately left alive is still there -- restoring
      // is genuinely instant (re-register the SAME already-known tool list against the SAME live
      // client), exactly matching "connected<->disabled via toggle" as a direct transition.
      if (slot.client) {
        const tools = slot.savedTools ?? [];
        registerMcpServerTools(name, tools.map(toolInfoToDefinition), {
          deferredDefault: true,
          ...alwaysLoadOpt(slot.config),
        });
        installExecutorsForSlot(slot, tools);
        setSlotState(name, "connected", { toolNames: tools.map((t) => t.name) });
        return;
      }
      // Rare/edge case, disclosed: the connection died on its own while disabled (or this server
      // was toggled on before its very first connection attempt ever completed -- e.g. immediately
      // after `addAndConnect`). No live client to restore from -- treated as an ordinary reconnect
      // (a fresh "pending" cycle) rather than a hard error, since refusing outright would leave the
      // server permanently stuck.
      await connectOneServer(slot);
    },
    async addAndConnect(name: string, origin: McpConfigSourceOrigin, config: McpServerConfigForProcessTransport): Promise<void> {
      // A pre-existing slot under this SAME name (a `setMcpServers` call re-declaring an
      // already-managed server, WS-09 §2.1's own "any->pending via... setMcpServers" transition)
      // must have its live connection closed BEFORE the slot object is replaced -- otherwise the
      // old `ConnectedMcpClient` (and whatever transport/process it holds) is orphaned: nothing else
      // holds a reference to it once `slots.set` below drops the old slot object, and
      // `replaceExecutor`'s own clean overwrite (installExecutorsForSlot, called from the fresh
      // slot's own connectOneServer) has no way to know a PRIOR connection needs closing first.
      const existing = slots.get(name);
      // Fix round 1 (MAJOR M2): belt-and-suspenders -- `slots.set` below already replaces the slot
      // OBJECT, which alone makes any in-flight attempt on the OLD slot fail its identity check
      // (`slots.get(name) === slot`); bumping the old slot's own gen too costs nothing and keeps the
      // invariant "supersede = bump" uniform across every seam, not just this one.
      if (existing) existing.gen++;
      if (existing?.client) {
        await existing.client.close().catch(() => {});
      }
      slots.set(name, { name, origin, config, toolNames: [], state: "pending", gen: 0 }); // see the constructor loop's own comment on this same choice
      // Fire-and-forget, matching WS-09 §2's own nonblocking startup default -- a live
      // `setMcpServers` call is not "startup," and nothing in WS-09 §3 asks it to block until the
      // new server actually finishes connecting.
      void connectOneServer(slots.get(name)!);
    },
    async removeSlot(name: string): Promise<void> {
      const slot = slots.get(name);
      if (!slot) return;
      // Fix round 1 (MAJOR M2): belt-and-suspenders -- `slots.delete` below already makes any
      // in-flight attempt's identity check fail (`slots.get(name) === slot` becomes false once the
      // map no longer has the name at all), but bumping keeps "supersede = bump" uniform.
      slot.gen++;
      if (slot.client) {
        await slot.client.close().catch(() => {});
      }
      unregisterMcpServerTools(name);
      slots.delete(name);
    },
  };

  return { stateSource, controlSeam: createMcpControlSeam(internals), start, dispose, listConnectedServerNames, getConnectedClient, refreshServerTools };
}

// Exported so control.ts (a sibling file, never a circular import back into this one -- it only
// imports this TYPE) can implement `McpControlSeam` against it without either file reaching into
// the other's private closures.
export interface McpLifecycleInternals {
  hasSlot(name: string): boolean;
  getSlotOrigin(name: string): McpConfigSourceOrigin | undefined;
  listSlotNames(): string[];
  reconnectExisting(name: string): Promise<void>; // throws on failure -- matches the pinned Query.reconnectMcpServer contract
  disableSlot(name: string): void;
  enableSlot(name: string): Promise<void>;
  addAndConnect(name: string, origin: McpConfigSourceOrigin, config: McpServerConfigForProcessTransport): Promise<void>;
  removeSlot(name: string): Promise<void>;
}

// WS-06 §1: the ToolDescriptor registry -- the one object every consumer (ToolSearch, permissions,
// hooks, telemetry, execution) operates on (report §85). This module owns:
//   - the ToolDescriptor/RegisteredTool/ToolExecutionContext/ToolExecutor shapes (§1.1, verbatim,
//     plus the seams Phase 3's task-1 brief pins on top of it),
//   - the module-level registry index (a singleton -- see "Why a singleton" below),
//   - availability resolution + buildAdvertisedSet (§1.5),
//   - the ENGINE-FACING adapter (buildRegistryToolExecutor) that lets engine.ts dispatch a tool_use
//     call through this registry while its own pre-existing ToolExecutor seam (`{id,name,input} ->
//     {output}`) stays byte-for-byte untouched -- see that function's own header for the wrap
//     contract, and engine.ts's own comment at its call site for how the two are stitched together.
//
// Ownership boundary (R3-5): this file (the "index") is edited ONLY by this task, forever. Every
// descriptors/*.ts file registers exactly one stub via `registerTool` at module load; every later
// lane's REAL executor lives in a SIBLING `tools/impl/*.ts` file that imports `replaceExecutor` --
// lanes never edit a descriptor file or this one.
//
// Why a singleton (not a per-run instance): the registry is a CATALOG (which tools Winter knows how
// to describe/execute), not session data -- every engine run in one process shares the identical
// set of tool DEFINITIONS, and `registerTool`/`replaceExecutor` are specified as free top-level
// functions, not methods on a constructed instance (task-1 brief's own Interfaces block). Per-session
// state (cwd, permission mode, read history, background tasks) lives on ToolExecutionContext
// instead, built fresh per call by buildRegistryToolExecutor below. Verified empirically that bun's
// test runner shares ONE module registry across every test file in a `bun test` invocation (a
// module's top-level side effects run exactly once; state persists across files) -- so registry
// MUTATION in tests (replaceExecutor) MUST target throwaway, invented canonical names, never a real
// WS-06 entry, or one test file's mutation would leak into another's assertions. registry.test.ts
// follows that rule throughout.
//
// Deviation note (report this in task-1-report.md): WS-06 §1.1 types `disposition` as a 4-member
// union (`implement-now | implement-later | correctly-absent | winter-backed-equivalent`), but §2's
// own table uses a 5th literal value, `winter-backed-later`, for SendUserFile and
// ShareOnboardingGuide (Artifact's "winter-backed-later" appears only as a prose NOTE about a
// possible future product decision, not as its actual disposition column, which reads
// "correctly-absent (v1)"). Per-tool ground truth (§2/§3) is treated as authoritative over §1.1's
// introductory type sketch; `ToolDisposition` below widens to 5 members rather than silently
// mis-filing those two tools under an existing value.
import type { PermissionMode, BackgroundTaskMessage, BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { parseRule } from "../permissions/grammar.ts";
// Fix round 1, RULING P3-B: probeReadWouldPrompt's boolean widened to this named 3-state result --
// imported (type-only, erased at build time; no runtime cycle since evaluator.ts never imports this
// file) rather than hand-copying the `"silent" | "prompt" | "deny"` literal union in two places.
import type { ReadAccessProbe } from "../permissions/evaluator.ts";
import type { SessionReadState } from "./read-state.ts";
// Task 8 (P3 close-out, "Settings threading" MUST): type-only, erased at build time -- no runtime
// cycle (../sandbox/profile.ts imports only node:path and ../permissions/paths.ts, never this file).
// ToolExecutionContext.sandboxSettings below is what lets Bash/Monitor's real executors read the
// session's EFFECTIVE sandbox config instead of the DEFAULT_SANDBOX_SETTINGS module constant every
// lane shipped against (Lane C's own report, "documented scope gaps": "no `sandbox` field exists
// anywhere in packages/sdk/src").
import type { SandboxSettings } from "../sandbox/profile.ts";
// Phase 4 Task 3: type-only -- no runtime cycle (subagents/child-handle.ts never imports this file).
import type { SpawnChildRequest, ChildHandle } from "../subagents/child-handle.ts";

// --- §1.1: ToolDescriptor + supporting types -----------------------------------------------------

// No canonical JSONSchema type exists anywhere in this monorepo (verified before writing this file)
// -- a minimal, self-describing structural type is enough for a registry that stores/serves schema
// DATA; it is not a validator. Deliberately permissive (an index signature) so a descriptor's schema
// can carry whatever JSON Schema keywords its own WS-06 §3 shape needs without fighting this type.
export interface JSONSchema {
  type?: string | readonly string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | readonly JSONSchema[];
  required?: readonly string[];
  enum?: readonly unknown[];
  const?: unknown;
  description?: string;
  additionalProperties?: boolean | JSONSchema;
  oneOf?: readonly JSONSchema[];
  anyOf?: readonly JSONSchema[];
  allOf?: readonly JSONSchema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  [key: string]: unknown;
}

// report §54; widened Phase 4 Task 2. WS-09 §4's own prose enumerates only three hints
// (readOnlyHint/destructiveHint/openWorldHint), matching WS-06 §1.1's identical three-field comment
// -- but the REAL MCP protocol `ToolAnnotations` type carries five (verified empirically against
// @modelcontextprotocol/sdk@1.30.0's own `Client.listTools()` result shape: a registered tool's
// listed `annotations` object includes `title`/`idempotentHint` alongside the three WS-09 §4 names).
// WS-09 §4's own MUST ("preserved end-to-end") is taken literally over its truncated enumeration:
// dropping a real connected server's `idempotentHint`/`title` here would silently violate
// "end-to-end" the first time Lane A (Task 4) forwards one through registerMcpServerTools below.
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
  idempotentHint?: boolean;
}

// §1.4 table, verbatim set of classes. A descriptor pins exactly ONE -- two §2 rows document a dual
// class in prose (Monitor "execute/network", EnterWorktree/ExitWorktree "mode/edit"); each such
// descriptor file picks the PRIMARY one and records the choice in its own comment (a documented
// judgment call, not a silent one) rather than widening this type to a set.
export type PermissionClass = "read" | "edit" | "execute" | "network" | "interaction" | "messaging" | "task" | "mode" | "mcp" | "hosted";

// §1.5 + hard requirement 6: declarative gates ONLY -- every field here is plain data (strings,
// booleans, arrays), never a closure, so WS-17's capability matrix can be GENERATED by enumerating
// this shape rather than executing code. Absent field = "no restriction on that axis."
export interface AvailabilityPredicate {
  modes?: readonly PermissionMode[];
  platforms?: readonly NodeJS.Platform[];
  requiresFeatures?: readonly string[];
  // WS-09: WaitForMcpServers is advertised only when ToolSearch is disabled.
  requiresToolSearchDisabled?: true;
  // Phase 4 Task 8 (rider 4), the exact inverse of the gate immediately above: the ToolSearch tool
  // ITSELF is advertised only when Tool Search is genuinely ACTIVE for this session. Lane B's own
  // report flagged the absence: the descriptor was unconditionally `exposure: "eager"`, so a session
  // with deferral inactive (the default -- `ENABLE_TOOL_SEARCH` unset, deferrable share 0) advertised
  // a search tool whose entire deferred pool is empty by construction (resolveDeferral collapses every
  // `deferred: true` descriptor to "eager" when activation is off, so `total_deferred_tools` is 0 and
  // every query returns nothing). WS-09 §8.4's "advertised only when ToolSearch is disabled" pins the
  // complement for WaitForMcpServers explicitly; the pair now partitions cleanly -- exactly one of the
  // two is advertised in any session, never both and never neither.
  requiresToolSearchEnabled?: true;
  // R3-4 (WS-06 open question 3, provisional default): the task graph + TodoWrite are HIDDEN when
  // the resolved model family is marked task-native; absent familyMetadata (no catalog populated
  // yet, P6) reads as "not task-native" -- i.e. SHOWN by default, matching CC's own "older models
  // keep them" behavior this ruling mirrors.
  hiddenWhenFamilyTaskNative?: true;
  // AskUserQuestion: "Not available inside Agent-tool subagents" (WS-06 §3.3). `false` here means
  // "never shown when the caller's own AdvertisedSetInputs.insideSubagent is true" -- a fixed
  // literal (not a boolean) so a descriptor can only ever assert this one direction, matching how
  // every other field above is a plain gate rather than an arbitrary predicate.
  insideSubagent?: false;
}

// See this file's header "Deviation note."
export type ToolDisposition = "implement-now" | "implement-later" | "correctly-absent" | "winter-backed-equivalent" | "winter-backed-later";

export interface ToolDescriptor {
  canonicalName: string;
  advertisedName: string;
  source: "builtin" | "mcp" | "sdk" | "plugin" | "host";
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  description: string;
  searchHint?: string;
  annotations?: ToolAnnotations;
  exposure: "eager" | "deferred" | "hidden";
  permissionClass: PermissionClass;
  availability: AvailabilityPredicate;
  capabilityRequirements: string[];
  disposition: ToolDisposition;
  versionIntroduced?: string;
  // --- Phase 4 Task 2 additions (WS-09 §8.5/§9 deferral policy + §4/§6 MCP passthrough) -----------
  //
  // `deferred` is the descriptor's DECLARED Tool-Search eligibility -- resolveDeferral (below) turns
  // this + a session's mode/activation into the actual eager/deferred/hidden verdict. Deliberately
  // separate from the pre-existing `exposure` field above (P3-era; still the ONLY thing
  // buildAdvertisedSet's own isAvailable/hidden-filtering consults -- this task does not rewire that
  // pipeline to read `deferred`; per the task-2 brief, engine/exposure wiring is Task 3's and Lane
  // B's (toolsearch/exposure.ts) job). Absent/false = never eligible, byte-identical to every P3
  // descriptor's existing behavior (none of them set this field). `readonly PermissionMode[]` =
  // eligible ONLY in the listed modes (WS-09 §9: "deferred only in listed modes"); outside them,
  // treated exactly like `false`.
  deferred?: boolean | readonly PermissionMode[];
  // WS-09 §1.1/§2: "alwaysLoad: true forces the server's complete tools eager (never deferred)".
  // Unconditionally overrides `deferred` to "eager" in resolveDeferral. The connection-lifecycle
  // half of this flag (forcing the nonblocking startup default to wait) is Lane A's own concern
  // (mcp/env.ts's `connectionNonblocking` + the per-server config's own `alwaysLoad`, WS-09 §1.1)
  // -- this is only the descriptor-level mirror resolveDeferral reads.
  alwaysLoad?: boolean;
  // WS-09 §4/§6: the RAW MCP `_meta` bag a connected server attached to this tool
  // (registerMcpServerTools, below), preserved VERBATIM -- including any `anthropic/`-namespaced
  // key, per WS-09 §6's own MUST ("preserved... verbatim including the anthropic/ key literal ...
  // not a brandable name"). Kept alongside `interaction` (immediately below, DERIVED from this bag
  // at registration time) so a consumer can still read back the exact original object for
  // round-trip fixtures, or a future key this task does not itself interpret.
  _meta?: Record<string, unknown>;
  // WS-09 §6: set to the literal "required" ONLY when `_meta["anthropic/requiresUserInteraction"]
  // === true` at registration time -- [WS-07]'s stage-3 mandatory-interaction gate is Task 3's own
  // wiring; this field is the derived signal it will read. A single-literal union (not a boolean),
  // matching this file's own `AvailabilityPredicate.insideSubagent` precedent immediately above
  // ("a fixed literal ... so a descriptor can only ever assert this one direction") -- room for a
  // future second forced-interaction reason without a breaking boolean-to-string migration.
  interaction?: "required";
}

// --- Per-tool execution seams (task-1 brief's Interfaces block, verbatim) --------------------------

// Minimal by design: T1 is the spine, not the wire format. `output` is the model-visible tool_result
// text (folds directly into engine.ts's own pre-existing ContentBlock.tool_result.content); `isError`
// is a structured flag a real executor MAY set so a future task (T2/T8) can surface it more richly
// on the wire -- at T1 the adapter below folds it into `output` itself (see foldResult), since
// engine.ts's existing ToolExecutor contract has no separate per-call error channel to hand it to
// without touching dispatch (forbidden -- "wrap, do not rewrite").
export interface ToolResultPayload {
  output: string;
  isError?: boolean;
}

export interface ToolExecutionContext {
  cwd: string;
  home: string;
  /**
   * Phase 5 fix wave, I1: the RESOLVED winter root for this session (`<PREFIX>HOME` when set),
   * DISTINCT from `home` above, which is the OS home directory.
   *
   * The two are not interchangeable and confusing them is a shipped-bug class in this codebase --
   * see `SkillIndexOptions.winterHome`'s own header. A tool that needs to name Winter's own storage
   * (the agents user tier, a seatbelt deny, the checkpoint store) reads THIS; a tool that needs the
   * user's home for a `~`-anchored path reads `home`. Absent for a hand-built context, in which case
   * every consumer falls back to `<home>/<brand.homeDirName>/...` -- the pre-fix behaviour.
   */
  winterHome?: string;
  /**
   * P7a (D19): the session's RESOLVED brand profile, threaded from `RuntimeConfig.brand`.
   *
   * Every tool that names a Winter-owned surface from inside its own executor -- the project
   * dot-dir a workflow/worktree/cron file lives under, an env variable, the instructions file --
   * reads it from HERE rather than spelling one. OPTIONAL for the same reason as
   * `insideSubagent`/`trustedWorkspace` (~25 hand-built test contexts with no shared builder);
   * ABSENT READS AS `WINTER_BRAND`, which is byte-identical to the behaviour before this field.
   */
  brand?: BrandProfile;
  sessionId: string;
  readState: SessionReadState;
  // Phase 3 Task 2 (WS-06 §3.5): narrowed from Task 1's placeholder `unknown` now that the real,
  // closed background-task message union exists (packages/sdk/src/protocol/frames.ts) -- a lane's
  // real tool executor now gets full compile-time checking on what it emits, and engine.ts's own
  // emitFrame closure can hand the value straight to `output.write` with no unchecked cast (see that
  // closure's own header comment, and this field's sibling on RegistryToolExecutorDeps below).
  emitFrame: (frame: BackgroundTaskMessage) => void;
  // Phase 4 Task 3 (MUST 6, WS-09 §8.2/§8.3): the `tool_reference`-emission seam Lane B's own
  // ToolSearch executor calls immediately after a successful selection ("Successful selection
  // returns tool_reference blocks making the tools callable next step"). Deliberately bundles BOTH
  // halves of "make it callable" into one call: it marks `names` loaded in this session's own
  // LoadedToolSet (satisfying the load-first execution-boundary check, engine.ts's own
  // isDeferredAndUnloaded) AND emits the wire-level tool_reference block telling the MODEL those
  // names are now callable -- a caller can never do one without the other, closing the split-brain
  // a two-seam design would allow. No pinned official shape exists to mirror (T1's own item (c)
  // finding: `tool_reference` is declaration-absent, sourced only from a runtime capture) -- the
  // wire shape this emits is WINTER-OWNED (see engine.ts's own real implementation). OPTIONAL, same
  // "~25 unrelated test files with no central ctx builder" reason as insideSubagent/agentId/
  // spawnChild above; the real engine always supplies it.
  emitToolReference?: (names: string[]) => void;
  permissions: { probeReadAccess(filePath: string): ReadAccessProbe };
  tempDir: string;
  // Task 8 (P3 close-out, "Settings threading" MUST): the session's EFFECTIVE sandbox configuration
  // (RuntimeConfig.sandbox, resolved once per run against DEFAULT_SANDBOX_SETTINGS by engine.ts --
  // see buildDefaultToolExecutor's own comment). Non-optional: every ToolExecutionContext this
  // registry ever builds carries a real, resolved value, never `undefined`, so a real executor
  // (bash.ts, monitor.ts) never needs its own fallback-to-default branch.
  sandboxSettings: SandboxSettings;
  /**
   * Phase 6 Task 3 (R6-6, P4 carry): the engine's per-turn abort signal.
   *
   * ABORTED when the turn is interrupted. Bash and Monitor honour it -- their process-group kill
   * already existed, and this is the channel that reaches it: before this field the interrupt was a
   * raced Promise the engine stopped waiting on while the child kept running to completion.
   * An executor that ignores the field behaves exactly as before.
   *
   * OPTIONAL, matching `insideSubagent`/`emitToolReference` and for the identical reason: ~25
   * `impl/*.test.ts` files build a `ToolExecutionContext` by hand with no shared builder, and a
   * required field would force a throwaway stub into every one of them.
   */
  signal?: AbortSignal;
  // Task 8 (P3 close-out, "Settings threading" MUST; WS-12 §5.3): the session's configured outputs
  // directory (RuntimeConfig.outputsDir), when one was configured -- a Winter product extension, not
  // a CC-pinned field. Optional (most sessions configure none): absent means "no $OUTDIR export, no
  // extra writable root," byte-identical to before this field existed.
  outDir?: string;
  // Phase 4 Task 3 (WS-10 §4/§9, WS-07 §11): true for a CHILD engine's own tool calls, absent/false
  // for the main engine -- threaded straight from RuntimeConfig.insideSubagent (which already
  // existed as a P3 wire field feeding ONLY buildAdvertisedSet's own AskUserQuestion exclusion;
  // this is its first appearance on ToolExecutionContext itself, for a tool executor that needs to
  // know its own nesting without threading a second, parallel signal). OPTIONAL (unlike
  // `sandboxSettings`'s own "always a real value" precedent): ~20 pre-existing `impl/*.test.ts`
  // files construct a ToolExecutionContext directly with no shared builder this task could extend
  // in one place, and nothing in this phase's own tool code reads this field yet -- absent reads as
  // `false`, matching RuntimeConfig.insideSubagent's own established "absent means not known-true"
  // convention (buildAdvertisedSet's identical field, registry.ts's own AdvertisedSetInputs).
  insideSubagent?: boolean;
  // WS-10 §8: true when this run is a child spawned with `isolation: "worktree"` -- its filesystem
  // root is PINNED to that isolation workspace. A signal only, at Task 3: no consumer in this
  // codebase reads it yet (EnterWorktree/ExitWorktree's own future interaction with an
  // already-isolated child is Lane C's own scope) -- exists so ToolExecutionContext's shape is
  // already complete for that future consumer, mirroring this whole file's own "seam exists before
  // its real consumer does" precedent (e.g. AutoEngine/HookStage at P1). Optional for the identical
  // reason as `insideSubagent` immediately above.
  isolationPinnedCwd?: boolean;
  // Whole-branch review M11 (fix wave follow-up 6): the session's PROJECT-TRUST verdict, resolved
  // ONCE by engine.ts and threaded here so no consumer re-derives one. Two independent hardcoded
  // `false`s used to answer this same question -- engine.ts's own `const trustedWorkspace` (feeding
  // the permission evaluator's `EvaluationContext.trustedWorkspace` and the hook registry's trust
  // gate) and `subagents/policy.ts`'s `resolveWorkspaceTrust()` (feeding project agent definitions
  // loading, RULING R4-7). Both were correct-safe, but when P5 lands a real settings/trust signal,
  // wiring one and missing the other gives a session where a checked-in agent definition loads while
  // project-scoped permission rules stay gated, or the reverse. There is now ONE producer.
  // Optional for the same reason as `insideSubagent`/`agentId` above (~25 hand-built test contexts
  // with no shared builder); ABSENT READS AS UNTRUSTED, never as trusted.
  trustedWorkspace?: boolean;
  // The running child's own id, absent for the main engine -- threaded from RuntimeConfig.agentId
  // (Phase 4 Task 3's own new wire field). The SAME identity already threaded through
  // PermissionCall.agentId/PromptStageMeta.agentID/HookAuditRecord.agentID elsewhere in this run;
  // exposed here too so a tool executor that needs to self-identify (e.g. a future messaging tool
  // addressing itself) never has to reach back into engine-internal state for it.
  agentId?: string;
  // Phase 4 Task 8 (WS-10 "Execution amendments -- Per-call tool-use id"): the id of the
  // model-emitted `tool_use` block this execution is answering -- `EngineToolCall.id`, threaded
  // through `buildRegistryToolExecutor` below. Two production consumers, both of which had to
  // invent a synthetic stand-in until this landed: `tools/impl/agent.ts`'s
  // `SpawnChildRequest.parentToolUseId` (WS-10 §4's "child progress correlated, keyed by parent
  // tool-use ID" -- a randomUUID() was internally self-consistent but was never the model's own id,
  // so a host correlating a child's forwarded frames against the tool_use block it saw could not
  // match them) and `tools/impl/send-message.ts`'s message-id derivation (WS-10 §12: "messageId is
  // stable across retries, derived/persisted from the sender session plus tool-call ID" -- a fresh
  // synthetic id per call made the retry-returns-the-stored-outcome guarantee unreachable in
  // production, though the router layer itself was always correct).
  //
  // OPTIONAL for the identical reason as `insideSubagent`/`agentId` above (~25 pre-existing
  // `impl/*.test.ts` files construct a ToolExecutionContext by hand with no shared builder); the
  // real engine always supplies it. Absent means "this executor cannot know its own tool_use id" --
  // each consumer owns its own documented fallback, never a fabricated-but-plausible value.
  toolUseId?: string;
  // Phase 4 Task 8 (Lane C Gap #3, WS-10 §2): the session's PROGRAMMATIC agent definitions
  // (`Options.agents` -> `RuntimeConfig.agents`), surfaced to a tool executor so
  // `tools/impl/agent.ts` can pass them to `loadAgentDefinitions`'s own already-implemented
  // `programmatic` parameter. Before this field existed, only FILESYSTEM-defined agents
  // (user-tier agent definitions, and project-tier ones in a trusted workspace) were resolvable via
  // `subagent_type` in production, silently ignoring every programmatically-supplied definition --
  // a real gap WS-10 §2's own "programmatic definitions and filesystem-defined agents MUST coexist"
  // forbids. Typed structurally (never importing subagents/definitions.ts's own type here) to keep
  // this module free of a runtime dependency on that one; `loadAgentDefinitions` accepts the same
  // shape by construction. Optional/absent = "no programmatic definitions this session."
  agents?: Readonly<Record<string, unknown>>;
  session: {
    setCwd(p: string): void;
    addBoundedRoot(p: string): void;
    // M5 (fix wave, P3 close-out): the removal half of `addBoundedRoot` -- EnterWorktree's own
    // `addBoundedRoot` call had no corresponding "remove a bounded root" seam anywhere on this
    // interface, so the session's filesystem permission fence kept including a worktree's path for
    // the rest of the run even after ExitWorktree(action:"remove") deleted it from disk. Not a
    // security regression by itself (a wider fence that includes a now-nonexistent path grants no
    // NEW capability), but asymmetric with the add half and worth closing directly. Removes an
    // EXACT match only (the identical string `addBoundedRoot` was given) -- never a prefix/subpath
    // match, so it can never accidentally shrink a DIFFERENT, still-live bounded root.
    removeBoundedRoot(p: string): void;
    // RULING P3-L (fix wave, P3 close-out): the session's ENGINE-OWNED "root" -- distinct from the
    // live, freely-drifting `ctx.cwd` (a `cd` can move that anywhere within the allowed set; see
    // bash.ts's own cwd-carry). Initialized from `config.cwd` and moved ONLY by EnterWorktree (to
    // the new worktree path) and ExitWorktree (back to the main worktree) -- never by a plain `cd`.
    // Two consumers need this EXACT distinction: (1) bash.ts's cwd-carry allowed-set, which must not
    // let a `cd` into tempDir/outDir "stick" as though it were a real working directory (I3), and
    // (2) cron.ts's durable store key (M3) and CronCreate(durable)'s write-recognition target
    // (RULING P3-K) -- both must survive an in-worktree `cd` into a subdirectory without silently
    // keying off wherever the live cwd happens to have drifted to.
    getSessionRoot(): string;
    setSessionRoot(p: string): void;
    setPermissionMode(mode: PermissionMode): void;
    // Task 8 (P3 close-out, "Settings threading" MUST): the identical "cwd or additionalDirectories"
    // notion permissions/evaluator.ts's own boundedRoots() already computes for the STANDING
    // evaluator (rule-derived addDirectories grants + RuntimeConfig.additionalDirectories +
    // EnterWorktree's own addBoundedRoot calls) -- reused here, not re-derived, so a tool executor's
    // notion of "which directories this session may freely write to" can never drift from the
    // permission engine's own. See engine.ts's own session-seam construction for the real wiring.
    getBoundedRoots(): string[];
    // RULING P3-H (Task 8, P3 close-out): the getter half of the write-only posture-mutation seam
    // above -- Lane E's own reviewer found that ExitPlanMode's unconditional `setPermissionMode
    // ("default")` clobbers a mode the HOST already applied via a canUseTool `updatedPermissions`
    // suggestion (engine.ts applies suggested updates BEFORE calling tools.execute() for the
    // approved call), because ExitPlanMode had no way to observe "is the live mode still actually
    // 'plan'" before deciding whether to flip it. Reads the SAME live PolicyStateStore
    // `setPermissionMode` itself mutates -- never a separate, potentially-stale snapshot.
    getPermissionMode(): PermissionMode;
    // Phase 4 Task 3 (WS-10 §1/§3.5, R4-4): the Agent tool's own spawn seam -- a FOURTH,
    // DELIBERATE addition to ToolExecutionContext.session beyond the three fields (insideSubagent/
    // isolationPinnedCwd/agentId) MUST 5's own text enumerates by name. Called out explicitly here
    // rather than left to be discovered as an undocumented extra: `buildChildInheritance` (engine.ts)
    // needs live, run-closure-only state (the policy store, the current advertised tool set, the
    // session root) that a bare ToolExecutionContext field cannot carry as static data the way
    // insideSubagent/agentId can -- a METHOD is the only shape that can compute it lazily, on the
    // actual call, from that closure.
    //
    // OPTIONAL, deliberately (unlike every other `session.*` method on this interface): every
    // pre-existing `impl/*.test.ts` file (and registry.test.ts's own fixtures) builds its own
    // minimal, ad hoc `session` fake with no central builder this task could extend in one place --
    // making this required would force ~25 unrelated test files to grow a throwaway `spawnChild`
    // stub for a capability nothing in THIS phase's own test suite exercises. The real engine
    // (engine.ts's buildDefaultToolExecutor) always supplies a real implementation; Lane C's own
    // tools/impl/agent.ts (the one production caller) is expected to treat an absent method as "no
    // child-spawn capability configured for this run" (a typed, non-crashing tool-result error),
    // mirroring how a missing `ChildEngineDeps` factory registration is handled one level down.
    spawnChild?(req: SpawnChildRequest): Promise<ChildHandle>;
  };
}

export interface ToolExecutor {
  execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload>;
}

// RULING P3-F (Task 8, P3 close-out): the `extractPaths` seam CONTRACT, made explicit here rather
// than left implicit in each lane's own file. Established by Lane A's own review finding (RULING
// P3-F, task-4 report): a lane's `extractPaths` function returns RAW, UNRESOLVED candidate strings
// straight out of the tool's own input (e.g. a `Read` call's literal, un-normalized `file_path` --
// relative or absolute, whatever the caller typed) -- it MUST NOT resolve against `process.cwd()`,
// bake in any other daemon-process-level default, or otherwise assume a cwd of its own. Rationale:
// this function signature (`(input: unknown) => {...}`, no `ctx`/cwd parameter at all) has no
// session context to resolve against in the first place, and baking the WRONG cwd in either
// direction (the daemon's own vs. the session's) would be a silent correctness bug the seam's own
// caller could never detect. The CONSUMER (today: permissions/approvals.ts's own durable-approval
// "normalized paths" revalidation axis, RULING P3-F's other half -- see that file's own
// extractNormalizedTargets) is responsible for resolving each raw candidate against ITS OWN session
// ctx (cwd/home) before comparing or matching. Every current implementation (read.ts/glob.ts/
// grep.ts/bash.ts) already follows this contract as of Lane A's own fix round 1 and Lane C's
// original submission; this comment is what pins it as a REQUIREMENT for every future one too.
export interface RegisteredTool {
  descriptor: ToolDescriptor;
  executor?: ToolExecutor;
  extractPaths?: (input: unknown) => { reads: string[]; writes: string[] };
}

// --- The index --------------------------------------------------------------------------------------

const registry = new Map<string, RegisteredTool>();

// Stubs pre-registered by descriptors/*.ts; lanes call replaceExecutor (never this) once their real
// executor exists. Throws on a duplicate name -- every WS-06 §2 name is registered EXACTLY once, by
// EXACTLY one descriptor file; a second registration under the same canonicalName is always a bug
// (a copy-paste name collision, or a lane accidentally re-declaring a stub instead of calling
// replaceExecutor), never a legitimate update path.
export function registerTool(t: RegisteredTool): void {
  if (registry.has(t.descriptor.canonicalName)) {
    throw new Error(`tools/registry: "${t.descriptor.canonicalName}" is already registered -- each WS-06 name is registered exactly once, by exactly one descriptors/*.ts file`);
  }
  registry.set(t.descriptor.canonicalName, t);
}

// A lane's OWN, permanent way to install its real executor over T1's stub -- called once, at module
// load, from the lane's own tools/impl/*.ts file. Throws when no stub exists yet under that name
// (a lane file targeting the wrong canonicalName, or racing ahead of the descriptor that registers
// it) rather than silently creating a fresh, descriptor-less entry.
export function replaceExecutor(canonicalName: string, executor: ToolExecutor, extractPaths?: RegisteredTool["extractPaths"]): void {
  const existing = registry.get(canonicalName);
  if (!existing) {
    throw new Error(`tools/registry: replaceExecutor("${canonicalName}") -- no stub is registered under that name yet (descriptors/*.ts must register it first)`);
  }
  registry.set(canonicalName, { ...existing, executor, ...(extractPaths !== undefined ? { extractPaths } : {}) });
}

export function getRegisteredTool(canonicalName: string): RegisteredTool | undefined {
  return registry.get(canonicalName);
}

export function listRegisteredTools(): readonly RegisteredTool[] {
  return Array.from(registry.values());
}

// --- Phase 5 Task 3 (R5-10): host-generated tools -------------------------------------------------
//
// `registerTool` is the BOOTSTRAP primitive: one stub per WS-06 §2 name, registered once at module
// load, throwing on a duplicate because a second registration under a WS-06 name is always a bug.
// A HOST-GENERATED tool is the opposite shape in every respect: its descriptor is computed per
// SESSION from that session's own options (`StructuredOutput`'s `input_schema` IS the caller's
// `outputFormat` schema, capture (6)), it exists only while that session runs, and the registry is a
// process-wide singleton every in-memory-leg run shares -- so registration must be idempotent within
// a run and MUST be undone when the run ends, exactly as `registerMcpServerTools`/
// `unregisterMcpServerTools` already are for the other per-session registration family.
//
// The returned disposer is IDENTITY-CHECKED rather than an unconditional delete-by-name, for the
// same reason `disposeToolSearchSessionRuntime` is (engine.ts): two in-memory runs in one process can
// overlap, and a by-name delete during one run's teardown would remove the OTHER run's live
// registration. A disposer whose entry has since been replaced is a no-op.
//
/**
 * The ONLY names a host-generated registration may claim (fix round 1, M1).
 *
 * WS-06 §3.6 declares `StructuredOutput`'s `input_schema` as "GENERATED per-call from the caller's
 * requested output schema -- never one static interface", and its own P3 descriptor
 * (descriptors/structured-output.ts) calls its schema a placeholder the host substitutes. That
 * declaration is what makes the name generatable; nothing else in the catalogue carries it.
 *
 * Defined HERE rather than in structured/seam.ts so the registry depends on nothing to enforce its
 * own guard; that module re-exports it for Lane K.
 */
export const HOST_GENERATABLE_TOOL_NAMES: ReadonlySet<string> = new Set(["StructuredOutput"]);

// THE NAME GUARD IS AN ALLOWLIST, not a property check (fix round 1, M1). The first version refused
// to shadow a descriptor whose `source !== "host"` -- which excluded nothing, because EIGHT
// registered WS-06 descriptors are themselves `source: "host"` (Artifact, ClaudeDesign, Projects,
// RemoteTrigger, SendUserFile, ShareOnboardingGuide, ShowOnboardingRolePicker, StructuredOutput).
// Registering under "Artifact" therefore replaced the real descriptor, and the disposer deleted it
// from the process-wide registry for the rest of the process. `HOST_GENERATABLE_TOOL_NAMES`
// (structured/seam.ts) is sourced from the CATALOGUE's own "generated per-call" declaration instead.
//
// SHADOW-AND-RESTORE, not create-and-delete: the one generatable name ALREADY has a WS-06 stub
// (descriptors/structured-output.ts), so a registration necessarily shadows it and the disposer must
// put it back. `undefined` means "there was nothing here" and deletes -- never `set(name, undefined)`.
//
// WHOLE-BRANCH MINOR m6, CARRIED WITH ITS TRIGGER (fix wave). This registry is PROCESS-GLOBAL and
// keyed by NAME ALONE, which is the one P5 registry not keyed by session or agent id (I5 keyed the
// workflow host; skills/toolsearch/mcp/plugin-agents were already keyed). The consequence, concretely:
// a workflow child carrying its own `schema` registers `StructuredOutput`, shadowing its
// still-running parent's entry; at the child's teardown `registry.get(name) === childEntry` holds,
// so the child restores the PRISTINE WS-06 stub and deletes the pristine map entry -- and the
// parent's own later disposer then finds someone else's entry and correctly does nothing. The parent
// finishes its run with the stub in place of its per-session descriptor.
//
// INERT AT P5, WHICH IS WHY IT IS CARRIED AND NOT FIXED: `ProviderRequest` carries no tool schemas
// at all, and the engine validates structured output against its own `outputFormatSchema` rather
// than against whatever this registry holds. Nothing reads the descriptor that gets clobbered.
//
// THE TRIGGER IS SPECIFIC: it goes live the moment `inputSchema` joins the provider request, which
// is P6's scope. Key the descriptor by session (or read the schema from engine-local state) BEFORE
// that lands. Written here rather than only in a report because the P6 change that makes this live
// will be made in the request builder, not in this file, and its author has no reason to read this.
export function registerHostGeneratedTool(t: RegisteredTool): () => void {
  const name = t.descriptor.canonicalName;
  if (!HOST_GENERATABLE_TOOL_NAMES.has(name)) {
    throw new Error(
      `tools/registry: registerHostGeneratedTool("${name}") -- "${name}" is not a host-generatable name. Only names the WS-06 catalogue declares as generated-per-session may be claimed (see HOST_GENERATABLE_TOOL_NAMES); every other name belongs to a static descriptor a registration here would silently replace for the life of the process.`,
    );
  }
  // The PRISTINE descriptor -- what was there before ANY host-generated registration claimed this
  // name -- not merely "whatever the previous registration was". Two overlapping in-memory runs
  // nest: run B shadows run A's descriptor, so restoring "what B shadowed" would put A's per-session
  // schema back and lose the WS-06 stub permanently. Observed, not theorised: the idempotence test
  // caught exactly that on the first run of this fix.
  if (!hostGeneratedPristine.has(name)) {
    const existing = registry.get(name);
    hostGeneratedPristine.set(name, existing);
  }
  const entry: RegisteredTool = t;
  registry.set(name, entry);
  return () => {
    // Identity-checked (the disposeToolSearchSessionRuntime precedent): two overlapping in-memory
    // runs share this process, and an unconditional restore during one teardown would clobber the
    // other's live registration. Only the LAST live generated registration restores.
    if (registry.get(name) !== entry) return;
    const pristine = hostGeneratedPristine.get(name);
    hostGeneratedPristine.delete(name);
    if (pristine !== undefined) registry.set(name, pristine);
    else registry.delete(name); // `undefined` means "nothing was here" -- never set(name, undefined)
  };
}

// Keyed by canonical name; holds `undefined` when the name was genuinely unregistered before the
// first host-generated claim, which is why `.has()` and not `.get() !== undefined` gates the write.
const hostGeneratedPristine = new Map<string, RegisteredTool | undefined>();

// Test-only escape hatch: registry.test.ts (and any future test) uses this ONLY on throwaway,
// invented canonical names it registered itself -- never on a real WS-06 entry (see this file's
// header for why: the registry is a shared, process-wide singleton under bun's test runner).
export function unregisterToolForTest(canonicalName: string): void {
  registry.delete(canonicalName);
}

// --- Phase 4 Task 2: live MCP server registration (WS-09 §1.3/§2.1/§3/§4/§6) ----------------------
//
// `registerTool`/`replaceExecutor` above are P3's BOOTSTRAP primitives (one stub per WS-06 §2 name,
// registered once at module load by descriptors/*.ts). The functions below are the LIVE mutation
// surface a real, running session uses as MCP servers connect/reconnect/disconnect/refresh their
// tool lists (WS-09 §2.1's seven-state model; report §57/§64: "the tool registry MUST support live
// mutation... without a session restart"). They own a SEPARATE bookkeeping index (below) so a
// same-server re-registration can be told apart from a name that pre-exists via some OTHER
// mechanism entirely (a static WS-06 descriptor stub). The historical instance was the advisor's
// server-qualified twin, which P7a/D29 retired in favour of the bare native name -- see
// mcp/winter-server.ts, which builds a real `McpServer` object directly rather than calling
// registerMcpServerTools, and which therefore cannot collide with a static stub at all.
//
// Set-replace, not per-tool upsert: EVERY call to registerMcpServerTools(server, tools, opts)
// replaces server's ENTIRE owned name set with exactly `tools` -- a name this server owned before
// but that is absent from the new `tools` list (a tool a server dropped after a reconnect, or that
// RefreshMcpTools discovered was removed, WS-09 §1.4) is deleted, never left dangling.
// registerMcpServerTools(server, [], opts) is therefore equivalent to
// unregisterMcpServerTools(server) (both drop every name the server owned; a seam-contracts-p4.test.ts
// case pins this).
//
// Preserve-executor-on-replace: a SAME-SERVER re-registration (e.g. RefreshMcpTools re-querying an
// already-connected server whose tool DESCRIPTIONS changed) replaces ONLY the descriptor, preserving
// whatever `executor`/`extractPaths` Lane A already installed via replaceExecutor -- mirroring
// replaceExecutor's own `{...existing, executor, ...}` spread precedent. This has a real consequence
// for Lane A's own executor design, spelled out again at seam-contracts-p4.test.ts's own header:
// a per-tool executor must not close over stale per-connection state (e.g. a specific transport
// client instance) that a reconnect would invalidate -- either keep a mutable slot the executor
// reads through, or re-call replaceExecutor after every reconnect.
export interface McpToolDefinition {
  // The BARE tool name exactly as the connected server itself calls it (never pre-namespaced) --
  // this function computes the canonical `mcp__<server>__<tool>` form itself (WS-09 §1.3).
  name: string;
  description?: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: ToolAnnotations;
  // WS-09 §6: the RAW MCP `_meta` bag exactly as the server sent it (e.g. a real `tools/list`
  // response's per-tool `_meta` field) -- preserved verbatim onto the descriptor's own `_meta`, and
  // used (read-only) to derive `interaction` below.
  _meta?: Record<string, unknown>;
}

const mcpServerOwnedNames = new Map<string, Set<string>>(); // server -> canonical names it currently owns
const mcpToolOwner = new Map<string, string>(); // canonical name -> owning server (reverse index)
const registryChangeListeners = new Set<() => void>();

function notifyRegistryChange(): void {
  // Every listener runs even if an earlier one throws -- one bad subscriber must never starve the
  // others (mirrors this codebase's established hook/subscriber error-isolation posture elsewhere,
  // e.g. query.ts's own per-callback swallow policy).
  for (const cb of registryChangeListeners) {
    try {
      cb();
    } catch (err) {
      console.error("tools/registry: onRegistryChange listener threw", err);
    }
  }
}

// WS-09 §3/§57/§64: subscribe to LIVE registry mutations. THREE producers, and only three:
// registerMcpServerTools / unregisterMcpServerTools (see those functions' own headers) and, since
// Phase 5 Task 2, `onCompaction` below -- a compaction reset changes which deferred tools are
// advertised, which is the same "re-derive system/init.tools" obligation a server-level event
// carries. Fires ONCE per call in every case, never once per tool. Deliberately NOT fired by
// registerTool/replaceExecutor/unregisterToolForTest (P3's bootstrap-time and test-only
// primitives) -- see this section's own header for the scoping rationale. Returns an unsubscribe
// function, mirroring McpServerStateSource.subscribe's own shape (mcp/state.ts) and this codebase's
// existing HookCallbackMatcher-adjacent subscribe/unsubscribe idiom.
export function onRegistryChange(cb: () => void): () => void {
  registryChangeListeners.add(cb);
  return () => {
    registryChangeListeners.delete(cb);
  };
}

function buildMcpToolDescriptor(server: string, tool: McpToolDefinition, opts: { alwaysLoad?: boolean; deferredDefault: boolean | readonly PermissionMode[] }): ToolDescriptor {
  const canonicalName = `mcp__${server}__${tool.name}`;
  // WS-09 §6 verbatim: the literal `anthropic/` key, checked for an EXACT `=== true` (any other
  // value, or the key's absence, leaves `interaction` unset -- never a truthy-coercion).
  const requiresInteraction = tool._meta?.["anthropic/requiresUserInteraction"] === true;
  // See the `alwaysLoad` field below for the full rationale. `undefined` (rather than `false`) when
  // NEITHER source asserts it, so the field stays genuinely absent -- resolveDeferral only ever
  // checks `=== true`, and an explicit `false` would be a claim the registration never made.
  const perToolAlwaysLoad = tool._meta?.["anthropic/alwaysLoad"] === true;
  const alwaysLoadResolved = perToolAlwaysLoad || opts.alwaysLoad === true ? true : opts.alwaysLoad;
  return {
    canonicalName,
    advertisedName: canonicalName,
    source: "mcp",
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    // Real MCP `Tool.description` is optional; WS-06 §1.1's own ToolDescriptor.description is not --
    // "" is the neutral default for a server that omits it (no spec-pinned alternative exists).
    description: tool.description ?? "",
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    // Static P3-era axis -- see ToolDescriptor.exposure's own doc comment above; a dynamically
    // registered MCP tool starts "eager" here exactly like every other implement-now descriptor
    // (buildAdvertisedSet's own hidden/correctly-absent filtering is unaffected either way). Live
    // eager/deferred/hidden resolution for Tool Search is `deferred` + resolveDeferral, below.
    exposure: "eager",
    permissionClass: "mcp",
    availability: {},
    // I4 (P3 fix wave) precedent: WebSearch/LSP/ToolSearch/WaitForMcpServers/ListMcpResourcesTool
    // all gate on "winter.mcp" because they had no executor yet. A live-registered MCP tool is
    // gated the SAME way for the SAME reason (a fresh registerMcpServerTools call from Lane A has
    // no executor until a following replaceExecutor lands) -- MUST 7 / the plan's own "Carries"
    // list: this stays HOST-SUPPLIED this task; T8 flips it to runtime-derived once real MCP
    // executors exist end to end. Do not remove this token here without that same T8 change.
    capabilityRequirements: ["winter.mcp"],
    disposition: "implement-now",
    // Phase 4 Task 8 (rider 13, RULING P4-G): per-TOOL `_meta["anthropic/alwaysLoad"]` is honored
    // here, OR'd with the server-wide `opts.alwaysLoad`. Lane A's own report named this as a spine
    // gap it could not work around: `opts.alwaysLoad` is server-wide only, so a real server marking
    // DIFFERENT tools with different `_meta` values had no way to reach resolveDeferral's per-tool
    // verdict (splitting one server's tools across multiple registerMcpServerTools calls would
    // corrupt set-replace semantics). The pinned mechanism is exactly this shape --
    // derived-shapes-p4 item (a): `createSdkMcpServer({alwaysLoad:true})` "applies via
    // `_meta['anthropic/alwaysLoad']` on every tool the server registers; a per-tool
    // `tool({alwaysLoad})` still works independently and is OR'd with the server-level flag." Same
    // exact-`=== true` discipline as `requiresUserInteraction` above: any other value, or absence,
    // contributes nothing (never a truthy coercion).
    ...(alwaysLoadResolved !== undefined ? { alwaysLoad: alwaysLoadResolved } : {}),
    deferred: opts.deferredDefault,
    ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
    ...(requiresInteraction ? { interaction: "required" as const } : {}),
  };
}

// Fix round 1, RULING P4-B (MAJOR item 2): the standing server's own name is RESERVED as a live-MCP server identity,
// independent of whatever happens to be statically registered under it at any given moment. The
// standing server (mcp/winter-server.ts) is registry-native -- it builds its own real
// @modelcontextprotocol/sdk McpServer object and is NEVER installed through this function -- so a
// call like registerMcpServerTools(<that name>, [{name: "browser", ...}]) must be refused even for a
// tool name that has never been seen before and so would not trip the ordinary per-name collision
// check below (that check only catches a name that already happens to be registered; a brand-new
// name under the reserved server would sail straight through it and silently create a SECOND,
// disconnected standing-server identity in the shared registry). Exact-match only, not case-insensitive --
// mirrors mcp/env.ts's own documented exact-match-only posture; case variants are deliberately
// NOT reserved (registry.test.ts pins this both ways). Not imported from mcp/winter-server.ts's own
// WINTER_SERVER_NAME constant: that module already imports FROM this file (it reads the advisor
// descriptor via getRegisteredTool), so a runtime import in the other direction would be a real
// import cycle, not merely a type-only one -- registry.test.ts instead imports WINTER_SERVER_NAME
// directly and asserts it against this literal, which is the drift tripwire without the cycle.
const RESERVED_MCP_SERVER_NAMES = new Set<string>([WINTER_BRAND.mcpServerName]);

// --- P7a (D19): the standing server's identity under a host's own brand ----------------------------
//
// THE PROBLEM. The standing server's canonical twins (its `send_message`/`list_agents` entries,
// descriptors/winter-*.ts) are registered AT MODULE LOAD, into this process-global index, long
// before any session's `--config-json` -- and therefore its brand -- exists. Deriving their names
// from `WINTER_BRAND` alone would satisfy the sweep gate and still leave a reuser advertising
// somebody else's server name; worse, it would leave the alias TABLE pointing at the reuser's
// spelling while the only registered tool carries Winter's, so `SendMessage`'s canonical target
// would resolve to nothing. The two halves have to move together.
//
// THE SHAPE. A per-session RENAME, disposed on teardown -- the same lifecycle
// `registerHostGeneratedTool` and `registerMcpServerTools`/`unregisterMcpServerTools` already have,
// and for the identical reason: a per-session fact has to reach a process-wide index somehow, and
// "register, then withdraw" is how this file has always done it. `production-wiring.ts` calls it
// once and adds the disposer to its own `dispose()`.
//
// A NO-OP UNDER `WINTER_BRAND`, by construction: `from === to` for every entry, so an unbranded
// session never touches the registry at all and every existing test is byte-identical.
//
// THE ONE-LIVE-BRAND ASSUMPTION, disclosed: two CONCURRENT sessions under DIFFERENT brands in one
// process would fight over these names, exactly as two concurrent sessions already fight over a
// live MCP server's names. That is the same "one-live-engine assumption" `subagents/limits.ts` and
// `tools/background-tasks.ts` record; a genuinely multi-tenant host is a WS-15 concern.
export function rebrandStandingServerTools(renames: ReadonlyArray<{ from: string; to: string }>, serverName: string): () => void {
  const applied: Array<{ from: string; to: string; entry: RegisteredTool }> = [];
  for (const { from, to } of renames) {
    if (from === to) continue;
    const entry = registry.get(from);
    // A name already taken under the new spelling is left ALONE rather than overwritten: the
    // collision belongs to whoever claimed it, and silently replacing a registered tool is the one
    // thing `registerTool` refuses to do.
    if (entry === undefined || registry.has(to)) continue;
    const renamed: RegisteredTool = { ...entry, descriptor: { ...entry.descriptor, canonicalName: to, advertisedName: to } };
    registry.set(to, renamed);
    registry.delete(from);
    applied.push({ from, to, entry });
  }
  const reservedHere = !RESERVED_MCP_SERVER_NAMES.has(serverName);
  if (reservedHere) RESERVED_MCP_SERVER_NAMES.add(serverName);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const { from, to, entry } of applied) {
      // Identity-checked, the `registerHostGeneratedTool` precedent: only withdraw a name this
      // call actually installed and that nothing has replaced since.
      if (registry.get(to)?.descriptor.canonicalName === to) registry.delete(to);
      if (!registry.has(from)) registry.set(from, entry);
    }
    if (reservedHere) RESERVED_MCP_SERVER_NAMES.delete(serverName);
  };
}

// P4 fix wave, KNOWN (1) -- SAME-BATCH duplicate names, ruled DEDUPE-FIRST-WINS (never throw).
//
// Two independent layers can hand this function a list with the same `name` twice: a real server's
// `tools/list` response (deduped at the protocol layer by `mcp/client.ts`'s own `dedupeTools`, which
// also keeps the FIRST occurrence and warns) and any direct caller -- an in-process SDK server, a
// test, a future settings-driven registration -- that never goes through that client at all. Before
// this, the second layer fell through to the commit loop's `registry.set`, i.e. LAST-write-wins, so
// the two layers disagreed about which occurrence survives and the second definition silently
// replaced the first at one layer and was silently dropped at the other.
//
// Ruled first-wins here, matching `client.ts`, and ruled NON-throwing: registry.test.ts's rider-16
// fixture already pins "registers exactly one entry and never throws", a duplicate name is a
// SERVER-side anomaly rather than a caller error, and throwing would take out an entire server's
// registration over one malformed entry. Visible, never silent: one console diagnostic per dropped
// occurrence, the same channel and shape `client.ts` uses.
function dedupeSameBatch(server: string, tools: readonly McpToolDefinition[]): readonly McpToolDefinition[] {
  const seen = new Set<string>();
  const out: McpToolDefinition[] = [];
  let dropped = false;
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      dropped = true;
      console.error(
        `winter: registerMcpServerTools: server "${server}" supplied duplicate tool name "${tool.name}" in ONE batch -- keeping the first occurrence, ignoring the rest`,
      );
      continue;
    }
    seen.add(tool.name);
    out.push(tool);
  }
  // Identity-preserving for the overwhelmingly common clean batch: no copy, no allocation.
  return dropped ? out : tools;
}

export function registerMcpServerTools(
  server: string,
  incomingTools: readonly McpToolDefinition[],
  opts: { alwaysLoad?: boolean; deferredDefault: boolean | readonly PermissionMode[] },
): void {
  if (RESERVED_MCP_SERVER_NAMES.has(server)) {
    throw new Error(
      `registerMcpServerTools: "${server}" is a RESERVED server name -- the standing Winter server ` +
        `(mcp/winter-server.ts) owns this identity and is registry-native; it is never installed through ` +
        `this live-mutation function, and nothing else may register live tools under it either.`,
    );
  }

  // Deduped BEFORE anything else reads the list, so the validate phase, the set-replace bookkeeping
  // and the commit loop all see the identical, single-occurrence batch (a second occurrence surviving
  // into the commit loop is precisely what made this last-write-wins).
  const tools = dedupeSameBatch(server, incomingTools);
  const newNames = new Set(tools.map((t) => `mcp__${server}__${t.name}`));
  const previouslyOwned = mcpServerOwnedNames.get(server);

  // Fix round 1, NIT item 4: symmetric with unregisterMcpServerTools's own silent no-op below -- a
  // server with nothing owned before and nothing in the new list has genuinely nothing to change.
  // Returning here (rather than falling through to an unconditional mcpServerOwnedNames.set +
  // notifyRegistryChange at the bottom) avoids firing a spurious onRegistryChange, and avoids
  // planting a phantom empty-Set bookkeeping entry, for a call that mutated nothing observable.
  if (tools.length === 0 && (previouslyOwned === undefined || previouslyOwned.size === 0)) return;

  // Fix round 1, MAJOR item 1 -- VALIDATE-THEN-COMMIT: every incoming name is checked for a
  // collision/foreign-ownership BEFORE anything below is mutated. The previous version validated
  // and mutated in the SAME loop, so a throw partway through a batch (e.g. register(server, [a, c,
  // d]) where "d" collides) left the OLD set-replace deletion already applied ("b", owned before but
  // absent from the new list, already deleted) and some of the NEW insertions already applied ("a"
  // updated, "c" inserted) while `mcpServerOwnedNames` was never updated to reflect any of it (the
  // throw happens before that assignment) -- so a subsequent `unregisterMcpServerTools(server)` would
  // only ever see the STALE pre-call owned set and could never reach "c", orphaning it in the
  // registry forever. Validating the whole batch first means a throw here leaves registry/
  // mcpToolOwner/mcpServerOwnedNames byte-identical to their pre-call state -- nothing is ever
  // half-applied (registry.test.ts pins this exact scenario).
  for (const tool of tools) {
    const canonicalName = `mcp__${server}__${tool.name}`;
    const existingOwner = mcpToolOwner.get(canonicalName);
    if (registry.has(canonicalName) && existingOwner === undefined) {
      throw new Error(
        `registerMcpServerTools: "${canonicalName}" is already registered by a non-live-MCP mechanism ` +
          `(e.g. a static WS-06 descriptor stub, or the standing winter server's own advisor identity) -- ` +
          `refusing to overwrite it. If this name is meant to be a live-connected MCP tool, its static ` +
          `registration must be removed first.`,
      );
    }
    if (existingOwner !== undefined && existingOwner !== server) {
      // Should be structurally impossible (canonical names are namespaced per-server) -- defended
      // anyway rather than silently reassigning ownership across servers.
      throw new Error(`registerMcpServerTools: "${canonicalName}" is already owned by server "${existingOwner}", not "${server}"`);
    }
  }

  // Commit phase: validation above already proved every name in `tools` is either brand-new or
  // already owned by THIS server -- every step below is now guaranteed to succeed.
  //
  // Set-replace (this section's own header): drop anything this server owned before that is absent
  // from the new list, BEFORE inserting anything new -- so a name that moves from "owned by this
  // server, not in the new list" straight to "owned by this server, in the new list" (impossible in
  // one call since a name can't be both, but keeps the two phases strictly ordered regardless) never
  // observes a transient duplicate-ownership state.
  if (previouslyOwned) {
    for (const oldName of previouslyOwned) {
      if (!newNames.has(oldName)) {
        registry.delete(oldName);
        mcpToolOwner.delete(oldName);
      }
    }
  }

  const nowOwned = new Set<string>();
  for (const tool of tools) {
    const canonicalName = `mcp__${server}__${tool.name}`;
    const existingEntry = registry.get(canonicalName); // present only on a same-server replace (validated above)
    const descriptor = buildMcpToolDescriptor(server, tool, opts);
    registry.set(canonicalName, existingEntry ? { ...existingEntry, descriptor } : { descriptor });
    mcpToolOwner.set(canonicalName, server);
    nowOwned.add(canonicalName);
  }
  mcpServerOwnedNames.set(server, nowOwned);
  notifyRegistryChange(); // once per call, never once per tool
}

export function unregisterMcpServerTools(server: string): void {
  const owned = mcpServerOwnedNames.get(server);
  mcpServerOwnedNames.delete(server);
  if (!owned || owned.size === 0) return; // idempotent no-op: nothing changed, nothing to notify
  for (const name of owned) {
    registry.delete(name);
    mcpToolOwner.delete(name);
  }
  notifyRegistryChange();
}

// --- Phase 4 Task 2: the deferral primitive (WS-09 §8.5/§9) ---------------------------------------

// Per-session bookkeeping of which deferred tools Tool Search has materialized THIS session (WS-09
// §8.5 "Loaded set"). One instance per session -- unlike the module-level `registry` Map above, this
// is explicitly NOT a singleton (the interface + factory shape the task-2 brief pins verbatim), since
// two concurrent sessions must never share load state.
export interface LoadedToolSet {
  isLoaded(name: string): boolean;
  // Partitions `names` by whether a descriptor is currently registered under that name (existence,
  // not exposure/disposition -- resolveDeferral is the separate, session-aware decision of WHETHER a
  // name should have been deferred at all; this only tracks WHICH names are now loaded). Idempotent:
  // an already-loaded name loading again stays loaded and is reported in `loaded` again.
  load(names: string[]): { loaded: string[]; unknown: string[] };
  // WS-09 §8.5 "Compaction reset": drops everything from the loaded set that is NOT in `evidenced`
  // -- an INTERSECTION with the current set, never a union. A name in `evidenced` that was never
  // loaded in the first place does NOT appear in the set afterward (this function only ever REMOVES
  // membership, consistent with the spec's own "drops everything not in evidenced" phrasing, and
  // with "MUST NOT drop tools that remained evidenced" -- the ones that remain are exactly the
  // intersection, nothing is ever added back).
  reset(evidenced: string[]): void;
  snapshot(): string[];
}

export function createLoadedToolSet(): LoadedToolSet {
  const loaded = new Set<string>();
  return {
    isLoaded(name: string): boolean {
      return loaded.has(name);
    },
    load(names: string[]): { loaded: string[]; unknown: string[] } {
      const loadedNow: string[] = [];
      const unknown: string[] = [];
      for (const name of names) {
        if (getRegisteredTool(name) !== undefined) {
          loaded.add(name);
          loadedNow.push(name);
        } else {
          unknown.push(name);
        }
      }
      return { loaded: loadedNow, unknown };
    },
    reset(evidenced: string[]): void {
      const evidencedSet = new Set(evidenced);
      for (const name of loaded) {
        if (!evidencedSet.has(name)) loaded.delete(name);
      }
    },
    snapshot(): string[] {
      return Array.from(loaded);
    },
  };
}

// --- Phase 5 Task 2 (R5-4 / WS-09 §8.5 "Compaction reset"; the P4 carry R4-6 named) --------------
//
// The seam a compaction calls when it has finished summarizing: everything Tool Search materialized
// this session goes back to searchable-not-loaded EXCEPT the names that survived into the compacted
// context ("evidenced" -- a tool whose call/result the summary still carries, so the model can
// legitimately keep calling it without re-discovery).
//
// SHAPE NOTE vs the Task 2 brief. The brief writes `onCompaction(registry: ToolRegistry, evidenced)`.
// There is no `ToolRegistry` type in this codebase and there deliberately cannot be one here: the
// descriptor registry is a process-wide SINGLETON (this module's own `registry` Map), shared by
// every session in a process, and resetting it per-compaction would blow away another session's
// tools. The only per-SESSION registry state is the `LoadedToolSet` -- exactly what WS-09 §8.5's
// reset is about -- so that is what this takes.
//
// Three behaviours the contract test pins, none of which `LoadedToolSet.reset` gives on its own:
//   1. the kept set is `evidenced` INTERSECT still-registered -- an evidenced name whose descriptor
//      vanished mid-session (its MCP server disconnected) must not stay loaded, or the very next
//      turn advertises a tool that cannot be called;
//   2. it only ever REMOVES: an evidenced name that was never loaded does not become loaded;
//   3. it announces once, through the same `onRegistryChange` a server-level mutation uses, because
//      the advertised set genuinely changed and a consumer re-deriving `system/init.tools` has to
//      hear about it.
export function onCompaction(loaded: LoadedToolSet, evidencedToolNames: readonly string[]): void {
  const stillRegistered = evidencedToolNames.filter((name) => getRegisteredTool(name) !== undefined);
  loaded.reset(stillRegistered);
  notifyRegistryChange();
}

// WS-09 §8.1: ENABLE_TOOL_SEARCH's exact value semantics, ALREADY PARSED (see
// packages/runtime/src/mcp/env.ts's parseMcpEnvConfig, which imports this exact field's type rather
// than redeclaring a second literal union that could drift from this one).
export interface DeferralActivation {
  enableToolSearch: "unset" | "true" | "false" | "auto" | { auto: number };
  providerSupportsToolSearch: boolean;
  // WS-09 §8.1 "auto"/"auto:N": a PERCENT (0-100), the SAME unit as the threshold values ("10%",
  // "auto:N"'s own "custom percentage threshold") -- deliberately not a 0..1 fraction, so
  // `deferrableContextShare >= 10` and `auto:15`'s own literal `15` compare directly with no
  // conversion step at either producer (whoever computes the live share -- Lane B/T3) or consumer
  // (resolveDeferral immediately below). A unit mismatch here is exactly the class of producer/
  // consumer drift R4-2 exists to catch, so it is pinned in this doc comment, not left implicit.
  deferrableContextShare: number;
}

// RULING P4-A (Phase 4 Task 3): "is Tool Search genuinely active in this session at all" as its OWN
// pure function of `DeferralActivation` alone -- no descriptor-specific floors (those stay in
// resolveDeferral below, which calls this for its own tail rather than re-deriving the identical
// logic a second time). This is the mechanism that makes a contradictory advertise-and-defer state
// "impossible by construction" (the ruling's own phrase): the SAME boolean this function returns is
// what engine.ts derives `RuntimeConfig.toolSearchEnabled`'s SESSION-WIDE effective value from (the
// WaitForMcpServers advertisement gate) -- so a session can never simultaneously defer at least one
// eligible descriptor via resolveDeferral while ALSO advertising WaitForMcpServers as if deferral
// were off, because both readings are now literally the same function call on the same activation
// value, not two independently-maintained booleans (T2's own report Concern 8, now closed).
export function isDeferralActive(activation: DeferralActivation): boolean {
  // WS-09 §8.1: "Provider fallbacks are part of the contract... a provider that cannot speak Tool
  // Search at all gets full injection regardless of every other input."
  if (activation.providerSupportsToolSearch === false) return false;
  const etc = activation.enableToolSearch;
  if (etc === "false") return false;
  if (etc === "true") return true;
  // "unset" is CAPTURE-PENDING (R4-8 class): treated identically to bare "auto" (the 10% default)
  // as the most defensible reading of "normal automatic behavior" without a live capture -- kept as
  // its own branch (never silently merged into the "auto" string literal) so a future capture-driven
  // correction is a one-line change. Recorded as a concern in task-2-report.md, carried here.
  if (etc === "unset" || etc === "auto") return activation.deferrableContextShare >= 10;
  return activation.deferrableContextShare >= etc.auto; // { auto: N }
}

// WS-09 §9's exposure-mapping table, resolved for one descriptor in one session. Boundary: a share
// EXACTLY AT the threshold counts as active (>=, not >) -- pinned by a seam-contracts-p4.test.ts
// fixture, and now enforced structurally via isDeferralActive's own single implementation (RULING
// P4-A) rather than a second, independently-maintained copy of the same threshold arithmetic.
export function resolveDeferral(descriptor: ToolDescriptor, mode: PermissionMode, activation: DeferralActivation): "eager" | "deferred" | "hidden" {
  // Floor: a descriptor already marked hidden on the pre-existing, static WS-06 axis (e.g. a
  // correctly-absent placeholder, or a mode-gated internal) stays hidden regardless of any deferral
  // input -- defends a future caller (Lane B) that runs this over registry output that was not
  // pre-filtered by buildAdvertisedSet's own hidden-exclusion.
  if (descriptor.exposure === "hidden") return "hidden";
  // WS-09 §9 "hidden = registry mode-visibility exclusion": the SAME AvailabilityPredicate.modes
  // gate buildAdvertisedSet's own isAvailable() already enforces, re-applied here so a caller that
  // consults resolveDeferral directly gets an answer consistent with the advertised set without
  // separately re-deriving mode-visibility itself.
  const modes = descriptor.availability.modes;
  if (modes !== undefined && !modes.includes(mode)) return "hidden";
  // WS-09 §8: "Core built-ins... remain loaded up front... never deferred through the public
  // surface" -- an unconditional override, checked before alwaysLoad/deferred so a builtin can never
  // be mis-marked deferred by a future descriptor edit.
  if (descriptor.source === "builtin") return "eager";
  // WS-09 §2 table: "alwaysLoad: true forces the server's complete tools eager (never deferred)".
  if (descriptor.alwaysLoad === true) return "eager";

  const declared = descriptor.deferred;
  const eligible = declared === true ? true : Array.isArray(declared) ? declared.includes(mode) : false;
  if (!eligible) return "eager";

  return isDeferralActive(activation) ? "deferred" : "eager";
}

// --- Phase 4 Task 3 (RULING P4-A): the advertised-set partition ------------------------------------
//
// `buildAdvertisedSet` itself (below) is UNCHANGED -- its own pre-existing, fully-tested filter
// pipeline (disposition/exposure/mode/platform/features/capabilities/disallowedTools) is exactly
// what every pre-existing caller (registry.test.ts, the I4 conformance test, engine.ts's own
// pre-Task-3 call site) already depends on, byte-for-byte. This function is `resolveDeferral`
// WIRED INTO that pipeline's OUTPUT (per the brief's own "wires resolveDeferral into
// buildAdvertisedSet -- registry.ts, spine, not Lane B" instruction), producing the
// eager/deferred/hidden partition on top of it, in the SAME module, rather than requiring every
// caller to run the two passes manually. `system/init.tools` (WS-09 §2.1's own consequence clause)
// is `eager` PLUS whichever `deferred` names are already in the session's own `LoadedToolSet` --
// composed by the caller (engine.ts) from this function's own three arrays, never invented as a
// fourth pre-merged field here (keeping the three partitions independently inspectable, e.g. for
// ToolSearch's own `total_deferred_tools` count, Lane B's job).
export interface AdvertisedPartition {
  eager: ToolDescriptor[];
  deferred: ToolDescriptor[];
  hidden: ToolDescriptor[];
}

export function partitionAdvertisedTools(cfg: AdvertisedSetInputs, activation: DeferralActivation): AdvertisedPartition {
  const candidates = buildAdvertisedSet(cfg);
  const partition: AdvertisedPartition = { eager: [], deferred: [], hidden: [] };
  for (const descriptor of candidates) {
    const verdict = resolveDeferral(descriptor, cfg.mode, activation);
    partition[verdict].push(descriptor);
  }
  return partition;
}

// Phase 4 Task 3 (MUST 6, WS-09 §8.2/§8.5): the EXACT execution-boundary predicate engine.ts's own
// tool-call loop consults before ever reaching permission evaluation ("load ≠ permission" -- an
// unloaded deferred tool is not yet ELIGIBLE to run at all). Exported (rather than left as a private
// engine.ts closure) so the seam contract tests exercise the IDENTICAL code path production traffic
// runs through, never a re-implementation that could silently drift from it. Looks up the LIVE
// registry by name (never a frozen snapshot) via the already-exported `getRegisteredTool` -- an
// unknown name is not this predicate's concern (`false`; the registry's own "unknown tool" result
// handles it elsewhere).
export function isLoadFirstBlocked(toolName: string, mode: PermissionMode, activation: DeferralActivation, loaded: LoadedToolSet): boolean {
  const descriptor = getRegisteredTool(toolName)?.descriptor;
  if (!descriptor) return false;
  return resolveDeferral(descriptor, mode, activation) === "deferred" && !loaded.isLoaded(toolName);
}

// --- §1.5: availability resolution + buildAdvertisedSet ---------------------------------------------

// N1 (fix wave, P3 close-out): STALE as of T8 -- this paragraph described the T1-era state
// (deliberately unwired, engine.ts's two init frames pinned `tools: []`). T8 wired
// `system/init.tools` to a REAL `buildAdvertisedSet({mode, platform, disallowedTools, ...})` call
// (WS-06 §6 obligation 1); the fix wave's own Part B item 1 additionally threads
// capabilities/toolSearchEnabled/insideSubagent/familyMetadata from RuntimeConfig into that SAME
// call (engine.ts's own comment there has the current, non-stale account). This function remains a
// pure, fully-tested function -- that half of the original claim was never stale -- but it is no
// longer merely "shipped ahead of its own wiring."
export interface AdvertisedSetInputs {
  mode: PermissionMode;
  platform?: NodeJS.Platform;
  features?: Readonly<Record<string, boolean>>;
  // Resolved runtime capability tokens (e.g. "winter.search-backend", "pwsh", "mcp:<server>") --
  // matched 1:1 against each descriptor's own `capabilityRequirements` (ToolDescriptor, above).
  capabilities?: readonly string[];
  familyMetadata?: { taskNative?: boolean };
  toolSearchEnabled?: boolean;
  insideSubagent?: boolean;
  // §1.5 "requested tool config": an explicit allowlist of canonical names to advertise. Absent =
  // no restriction on this axis (every other gate still applies).
  tools?: readonly string[];
  // Recorded on this input shape for documentation/completeness ONLY -- §1.3 pins allowedTools as
  // PRE-APPROVAL, never a visibility allowlist ("an eager tool may still require approval; a
  // deferred tool may already be pre-approved"). buildAdvertisedSet below MUST NOT filter on this
  // field; a test in registry.test.ts pins that a call site cannot use allowedTools to hide a tool.
  allowedTools?: readonly string[];
  // Raw config-grammar strings (the SAME shapes RuntimeConfig.disallowedTools/Options.disallowedTools
  // carry). A BARE entry (`"Bash"`, or `"Bash(*)"` wildcardAll -- grammar.ts's own isBareEquivalent)
  // removes the schema; a SCOPED entry (`"Bash(rm:*)"`) leaves it visible (§1.3) -- reusing
  // grammar.ts's parseRule here is what keeps this bare/scoped split from drifting out of sync with
  // permissions/ruleset.ts's own identical parsing of the same strings.
  disallowedTools?: readonly string[];
}

// Phase 4 Task 8 (rider 27): exported so the ENGINE's own round loop can apply the identical
// predicate at the execution boundary, ahead of permission evaluation -- never a re-implementation.
// See engine.ts's own call site for why the check has to run there and not only in the registry
// adapter below (a tool whose permission class forces an interactive prompt, e.g. AskUserQuestion,
// never reaches the adapter at all: it parks on an unanswerable permission RPC first, which is
// precisely the stall rider 27 exists to eliminate).
export function isToolAvailable(descriptor: ToolDescriptor, cfg: AdvertisedSetInputs): boolean {
  return isAvailable(descriptor, cfg);
}

function isAvailable(descriptor: ToolDescriptor, cfg: AdvertisedSetInputs): boolean {
  const a = descriptor.availability;
  if (a.modes !== undefined && !a.modes.includes(cfg.mode)) return false;
  if (a.platforms !== undefined && cfg.platform !== undefined && !a.platforms.includes(cfg.platform)) return false;
  if (a.requiresFeatures !== undefined && !a.requiresFeatures.every((f) => cfg.features?.[f] === true)) return false;
  if (a.requiresToolSearchDisabled === true && cfg.toolSearchEnabled !== false) return false;
  if (a.requiresToolSearchEnabled === true && cfg.toolSearchEnabled !== true) return false;
  if (a.hiddenWhenFamilyTaskNative === true && cfg.familyMetadata?.taskNative === true) return false;
  if (a.insideSubagent === false && cfg.insideSubagent === true) return false;
  if (!descriptor.capabilityRequirements.every((c) => cfg.capabilities?.includes(c) === true)) return false;
  return true;
}

// --- Phase 4 Task 8: runtime-DERIVED capability tokens --------------------------------------------
//
// The I4 fix wave (P3 close-out) introduced `winter.mcp` / `winter.subagents` /
// `winter.global-messaging` as capability gates on the MCP, subagent, and messaging descriptor
// families, for one stated reason, quoted from those descriptor files verbatim: "this descriptor has
// no `impl/*.ts` executor anywhere in the codebase yet (owned by P4/WS-09|WS-10), so advertising it
// unconditionally handed a real model a schema for a tool that always answers 'registered but not
// yet executable'". They were placeholders for a fact about the BUILD, not about a session's
// configuration -- and the registry's own comment (mirrored in transport-equivalence.test.ts) named
// the flip explicitly: "T8 flips it to runtime-derived later, not this task."
//
// Phase 4's four lanes shipped every one of those executors, and Task 8's own impl barrel
// (tools/impl/index.ts) is what makes them reach a live session. So the derivation is exactly the
// original rationale, inverted: a family's token resolves iff that family's representative tool
// actually HAS an executor in the live registry.
//
// Why executor-presence and not, say, "this session configured MCP servers" or "a child engine
// factory is registered": both of those are LEG-DEPENDENT. `system/init.tools` must be byte-identical
// across the in-memory, spawned-child, and compiled-binary transports (WS-04 §12 makes a divergence a
// release blocker), and a process-global factory registration or a per-session config knob differs
// between a test harness driving runEngine in-process and a real spawned `winter`. Executor presence
// does not: engine.ts imports the impl barrel unconditionally, on every leg, at module load. The
// tokens a host supplies explicitly (`Options.capabilities`) are UNIONED on top -- never replaced --
// so a host can still add tokens this function knows nothing about (`winter.reviewer-model`,
// `pwsh`, `mcp:<server>`), and no host can turn a derived one off (a session where the executor
// genuinely exists but the tool is unwanted is `disallowedTools`' job, WS-07 §3, not a capability
// gate's).
export interface RuntimeDerivedCapability {
  token: string;
  // The canonical name whose live executor presence proves the family shipped. One representative
  // per family (never the whole family) -- every tool in a family lands through the same barrel
  // import, so a partial family is a build error, not a runtime state to model.
  probeTool: string;
  // An ADDITIONAL, session-scoped condition beyond "the family shipped". Only `winter.mcp` has one,
  // and it exists because of direct capture evidence rather than a judgment call -- see
  // SessionCapabilityFacts below.
  requiresSessionFact?: keyof SessionCapabilityFacts;
}

// Per-session facts the derivation consults. Every field must be threaded IDENTICALLY on all three
// transports (it comes off RuntimeConfig, which is serialized into `--config-json`), or
// `system/init.tools` diverges between legs -- which WS-04 §12 makes a release blocker.
export interface SessionCapabilityFacts {
  // Does this session declare any MCP server at all?
  //
  // EVIDENCE (scripts/capture-official-golden.ts Scenario D, run against the pinned 0.3.250 runtime
  // against a loopback endpoint): the official runtime's own DEFAULT session -- zero MCP config --
  // advertises 24 tools, and NONE of ListMcpResourcesTool / ReadMcpResourceTool /
  // ReadMcpResourceDirTool / RefreshMcpTools / WaitForMcpServers / ToolSearch is among them. The
  // same capture confirms Agent, SendMessage and ListAgents ARE advertised by default. So the
  // MCP-family tools are not "shipped or not"; they are conditional on the session actually having
  // MCP, and the subagent/messaging families are not conditional at all. WS-00 §1: evidence wins
  // over a symmetric-looking derivation.
  hasMcpServers: boolean;
}

export const RUNTIME_DERIVED_CAPABILITIES: readonly RuntimeDerivedCapability[] = [
  // WS-09 §1.4 bridge tools + §8's ToolSearch/WaitForMcpServers (Lane A + Lane B). Gated ALSO on the
  // session declaring at least one MCP server -- see SessionCapabilityFacts.hasMcpServers for the
  // capture evidence behind that second condition.
  { token: "winter.mcp", probeTool: "ListMcpResourcesTool", requiresSessionFact: "hasMcpServers" },
  // WS-10 §1 Agent (Lane C). SendMessage/ListAgents also carry this token (an I4-era choice this
  // task does not re-file), so Agent is the family's least ambiguous probe.
  { token: "winter.subagents", probeTool: "Agent" },
  // WS-10 §10 messaging (Lane D). ReadNotifications is the token's only descriptor consumer, but
  // SendMessage is the family's own entry point and lands through the same barrel import.
  { token: "winter.global-messaging", probeTool: "SendMessage" },
  // --- Phase 5 Task 8: the two P5 families ------------------------------------------------------
  //
  // Identical derivation, identical rationale. Both descriptors carry their token because the I4 fix
  // wave gated them on "this descriptor has no impl/*.ts executor anywhere in the codebase yet
  // (owned by P5/WS-11)"; P5's lanes shipped both executors and `tools/impl/index.ts` is what makes
  // them reach a live session, so the token now resolves iff that executor is genuinely present.
  //
  // NO `requiresSessionFact` on either, and that is a POSITIVE finding rather than an omission:
  // capture (g) pins the default advertised set at exactly 24 tools INCLUDING `Workflow` and
  // `Skill`, in a session with no skills, no plugins and no workflows on disk -- so neither is
  // conditional on configuration the way the MCP family is. An empty skills index still advertises
  // the tool; it just has nothing to load.
  { token: "winter.skills", probeTool: "Skill" },
  { token: "winter.workflows", probeTool: "Workflow" },
];

export function deriveRuntimeCapabilities(facts: SessionCapabilityFacts): string[] {
  return RUNTIME_DERIVED_CAPABILITIES.filter(
    (c) => getRegisteredTool(c.probeTool)?.executor !== undefined && (c.requiresSessionFact === undefined || facts[c.requiresSessionFact]),
  ).map((c) => c.token);
}

// The one place a session's EFFECTIVE capability token set is computed: derived tokens unioned with
// whatever the host supplied. Order is derived-then-host, deduped; nothing downstream depends on
// order (every consumer is a membership test), but keeping it stable keeps a fixture stable.
export function resolveSessionCapabilities(hostSupplied: readonly string[] | undefined, facts: SessionCapabilityFacts): string[] {
  return [...new Set([...deriveRuntimeCapabilities(facts), ...(hostSupplied ?? [])])];
}

// Exported (fix wave, LANE Y / RULING P4-E amended) so `toolsearch/aliases.ts`'s own alias-exclusion
// pass asks the IDENTICAL question `buildAdvertisedSet` below asks -- a second copy of "is this name
// bare-denied?" living in the alias layer is exactly the producer/consumer drift R4-2 exists to catch,
// and this one is security-relevant.
export function isBareDenied(canonicalName: string, disallowedTools: readonly string[] | undefined): boolean {
  if (!disallowedTools) return false;
  return disallowedTools.some((raw) => {
    const parsed = parseRule(raw);
    return parsed.toolName === canonicalName && parsed.isBareEquivalent;
  });
}

// The §1.5 pipeline: requested tool config -> resolve runtime capabilities -> final active registry.
// `correctly-absent` entries are excluded unconditionally, regardless of every other input (their
// whole point is that no config can ever surface them -- WS-06 §2's own definition: "not registered,
// not advertised... the absence is itself a conformance assertion"); every other exposure==="hidden"
// entry (the deliberately-never-advertised-yet-registered kind, if a future lane ever adds one) is
// excluded the same way.
export function buildAdvertisedSet(cfg: AdvertisedSetInputs): ToolDescriptor[] {
  const requested = cfg.tools;
  return listRegisteredTools()
    .map((t) => t.descriptor)
    .filter((d) => d.disposition !== "correctly-absent")
    .filter((d) => d.exposure !== "hidden")
    .filter((d) => requested === undefined || requested.includes(d.canonicalName))
    .filter((d) => isAvailable(d, cfg))
    .filter((d) => !isBareDenied(d.canonicalName, cfg.disallowedTools));
}

// --- The engine-facing adapter: wraps the registry behind engine.ts's PRE-EXISTING ToolExecutor -----
//
// engine.ts's own `ToolExecutor` (defined there, unchanged by this task) is call-shaped:
// `execute(call: {id,name,input}): Promise<{output: string}>`. This adapter satisfies that EXACT
// shape structurally (engine.ts never imports this file's types to check -- TS structural typing
// does the work) so `runEngine` can use it as a drop-in `tools` value without engine.ts's own
// dispatch loop (`tools.execute(executedCall)`, ~L886/~L1259) changing by one character -- "wrap the
// existing tools.execute seam, do not rewrite dispatch."
//
// A call for a name with no registered descriptor at all, a `correctly-absent` name, or a stub with
// no executor yet all resolve to a NORMAL (non-throwing) result with `isError` folded into the text
// -- never a thrown error. Throwing here would surface as engine.ts's own whole-ROUND
// `error_during_execution` (Ruling P1-H), which is the wrong severity for "this stub isn't wired up
// yet"; a tool_result the model can read and react to is what WS-06's own "typed not-yet-executable
// errors" phrasing (phase plan self-review) calls for. The three cases are kept textually distinct
// (unknown / correctly-absent / not-yet-executable) because T8's own conformance sweep (WS-06 §6
// obligation 2) needs to tell "never existed" apart from "exists but is intentionally never
// advertised" apart from "exists, ships later."
export interface EngineToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface EngineToolResult {
  output: string;
}
export interface EngineFacingToolExecutor {
  /** Phase 6 Task 3 (R6-6): `opts.signal` is the engine's per-turn abort. It reaches a real executor as `ToolExecutionContext.signal`. */
  execute(call: EngineToolCall, opts?: { signal?: AbortSignal }): Promise<EngineToolResult>;
}

function unknownToolResult(name: string): ToolResultPayload {
  return { output: `Error: unknown tool "${name}" -- no descriptor is registered under that name`, isError: true };
}
function correctlyAbsentResult(name: string): ToolResultPayload {
  return {
    output: `Error: "${name}" is correctly absent from this Winter session (WS-06 §2) -- it is never callable, matching the official branch`,
    isError: true,
  };
}
function notYetExecutableResult(name: string): ToolResultPayload {
  return {
    output: `Error: "${name}" is registered but not yet executable in this phase -- its executor ships in a later Winter phase (WS-06 §2/§3)`,
    isError: true,
  };
}

// The adapter's own result -> engine-wire fold. Deliberately a pass-through (never a text prefix
// mangle) -- `isError` is informational for a future richer wire surface (T2/T8); every constructor
// above already writes complete, human/model-legible text into `output` itself, so folding never
// needs to invent additional prefixing here.
function foldResult(result: ToolResultPayload): EngineToolResult {
  return { output: result.output };
}

export interface RegistryToolExecutorDeps {
  sessionId: string;
  home: string;
  /** Phase 5 fix wave, I1: the resolved winter root -- see `ToolExecutionContext.winterHome`. */
  winterHome?: string;
  /** P7a (D19): the session's resolved brand -- see `ToolExecutionContext.brand`. */
  brand?: BrandProfile;
  // A getter, not a snapshot: the session posture-mutation seam (`session.setCwd`) mutates the
  // SAME live value this reads, so a tool call made after a worktree switch sees the new cwd.
  getCwd: () => string;
  probeReadAccess: (filePath: string) => ReadAccessProbe;
  // Phase 3 Task 2: same narrowing as ToolExecutionContext.emitFrame above -- this is the deps-level
  // value that field is built from, just below.
  emitFrame: (frame: BackgroundTaskMessage) => void;
  // Phase 4 Task 3 (MUST 6): the deps-level value ToolExecutionContext.emitToolReference is built
  // from -- see that field's own comment.
  emitToolReference?: (names: string[]) => void;
  session: ToolExecutionContext["session"];
  readState: SessionReadState;
  // A getter, not a string: see this module's own `ToolExecutionContext.tempDir` field and
  // engine.ts's call site for why this MUST stay lazy (resolving it eagerly on every call would
  // create real `/tmp/winter-<uid>/...` directories for every tool_use, including ones that never
  // touch tempDir at all -- e.g. the differential/query.test.ts equivalence stand-ins below).
  getTempDir: () => string;
  // Task 8 (P3 close-out, "Settings threading" MUST): resolved ONCE per run by engine.ts (config.
  // sandbox ?? DEFAULT_SANDBOX_SETTINGS) -- see ToolExecutionContext.sandboxSettings's own comment.
  sandboxSettings: SandboxSettings;
  outDir?: string;
  // Phase 4 Task 3: mirrors ToolExecutionContext's own three fields exactly -- see that interface's
  // own comments for the full rationale. `insideSubagent`/`isolationPinnedCwd` default `false` when
  // omitted (every pre-existing caller), matching RuntimeConfig.insideSubagent's own existing
  // "absent means not known-true" convention rather than requiring every call site to spell out the
  // negative case explicitly.
  insideSubagent?: boolean;
  isolationPinnedCwd?: boolean;
  // M11 (fix wave follow-up 6): engine.ts's single project-trust verdict, forwarded onto every
  // ToolExecutionContext this executor builds. Absent reads as UNTRUSTED.
  trustedWorkspace?: boolean;
  agentId?: string;
  // Phase 4 Task 8: mirrors ToolExecutionContext.agents exactly -- see that field's own comment.
  agents?: Readonly<Record<string, unknown>>;
  // Phase 4 Task 8 (rider 27): the session's own availability inputs, so this adapter can enforce
  // `isAvailable` AT DISPATCH rather than only at advertisement. Rationale, from Lane C's own I3
  // finding: `AskUserQuestion`'s `availability: { insideSubagent: false }` excluded it from a child's
  // ADVERTISED set but nothing consulted availability before EXECUTING a called tool -- a child that
  // called it anyway reached the real executor and STALLED on a host round-trip it could never get
  // an answer for, aborted only by the 600 s stall watchdog. An advertised-but-excluded tool call
  // must return a typed refusal, never a stall.
  //
  // Deliberately SCOPED to `isAvailable`'s own axes (modes/platforms/features/toolSearchDisabled/
  // familyTaskNative/insideSubagent/capabilities) -- NEVER exposure, disposition, or disallowedTools:
  // `exposure: "hidden"` is a legitimate "registered, deliberately unadvertised, still directly
  // callable" posture that real fixtures depend on (scripts/differential.ts's own
  // `differential_bgtask_probe`, called by a committed golden), `disposition` is already handled
  // above, and `disallowedTools` is the permission engine's own enforcement path (WS-07 §3), not
  // this adapter's. A getter, not a snapshot: `mode` and the loaded capability set can both move
  // mid-session. Absent = no dispatch-time availability enforcement (every pre-existing caller,
  // byte-identical to before this field existed).
  getAvailabilityInputs?: () => AdvertisedSetInputs;
}

// Phase 4 Task 8 (rider 27): the shared dispatch-time availability refusal. Text names the axis
// generically rather than re-deriving WHICH gate failed -- `isAvailable` is a conjunction and a
// caller that needs the specific axis has the descriptor in hand already.
function unavailableResult(name: string): ToolResultPayload {
  return {
    output: `Error: "${name}" is not available in this session's current configuration (WS-06 §1.5 availability) -- it is registered but excluded here, so it was not executed`,
    isError: true,
  };
}

export function buildRegistryToolExecutor(deps: RegistryToolExecutorDeps): EngineFacingToolExecutor {
  return {
    async execute(call: EngineToolCall, opts?: { signal?: AbortSignal }): Promise<EngineToolResult> {
      const registered = getRegisteredTool(call.name);
      if (!registered) return foldResult(unknownToolResult(call.name));
      if (registered.descriptor.disposition === "correctly-absent") return foldResult(correctlyAbsentResult(call.name));
      // Rider 27: availability is enforced HERE, before `executor` is even consulted -- an excluded
      // tool must refuse identically whether or not its executor happens to exist yet.
      if (deps.getAvailabilityInputs !== undefined && !isAvailable(registered.descriptor, deps.getAvailabilityInputs())) {
        return foldResult(unavailableResult(call.name));
      }
      if (!registered.executor) return foldResult(notYetExecutableResult(call.name));

      // A getter-backed object literal: satisfies `ToolExecutionContext.tempDir: string`
      // structurally (every consumer just reads `ctx.tempDir`) while keeping resolution lazy -- see
      // `getTempDir`'s own doc comment above.
      const ctx: ToolExecutionContext = {
        cwd: deps.getCwd(),
        home: deps.home,
        // I1: forwarded so a tool naming Winter's own storage uses the RESOLVED root, not the OS home.
        ...(deps.winterHome !== undefined ? { winterHome: deps.winterHome } : {}),
        ...(deps.brand !== undefined ? { brand: deps.brand } : {}),
        sessionId: deps.sessionId,
        readState: deps.readState,
        emitFrame: deps.emitFrame,
        ...(deps.emitToolReference !== undefined ? { emitToolReference: deps.emitToolReference } : {}),
        permissions: { probeReadAccess: deps.probeReadAccess },
        // Phase 6 Task 3 (R6-6): conditionally spread, so a call made with no signal produces a ctx
        // byte-identical to before this field existed (exactOptionalPropertyTypes).
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        get tempDir() {
          return deps.getTempDir();
        },
        session: deps.session,
        sandboxSettings: deps.sandboxSettings,
        ...(deps.outDir !== undefined ? { outDir: deps.outDir } : {}),
        insideSubagent: deps.insideSubagent === true,
        isolationPinnedCwd: deps.isolationPinnedCwd === true,
        trustedWorkspace: deps.trustedWorkspace === true,
        ...(deps.agentId !== undefined ? { agentId: deps.agentId } : {}),
        // Phase 4 Task 8: the model's own tool_use id for THIS call -- see
        // ToolExecutionContext.toolUseId's own comment. Always present here (EngineToolCall.id is a
        // required field); optional only on the interface, for hand-built test contexts.
        toolUseId: call.id,
        ...(deps.agents !== undefined ? { agents: deps.agents } : {}),
      };
      const result = await registered.executor.execute(call.input, ctx);
      return foldResult(result);
    },
  };
}

// --- Fix round 1, RULING P3-C: the fallback-composed adapter main.ts uses -------------------------
//
// main.ts (the real child/compiled entrypoint) cannot itself build a RegistryToolExecutorDeps -- that
// requires engine-internal live state (currentCwd, the running PolicyState, output.write, the
// session's own readState/tempDir resolver) that only exists once runEngine is already executing, so
// main.ts can only ever supply `tools` from OUTSIDE the call, or omit it and let engine.ts's own
// `buildDefaultToolExecutor` build `deps` internally. Omitting `tools` alone is not enough on its
// own, though: `buildRegistryToolExecutor` above deliberately returns a typed, non-throwing
// unknownToolResult for any name with NO registered descriptor at all (by design -- see that
// function's own header) -- correct for a genuine WS-06 name that simply has no `impl/*.ts` yet
// (`notYetExecutableResult`), but wrong for the pre-existing scripted test-double names
// ("test_tool"/"mystery_tool"/"long_task") that every child/compiled transport-equivalence scenario
// and differential-adjacent test already depends on echoing exactly like stubExecutor always has --
// those names have NO WS-06 descriptor at all and never will.
//
// `buildRegistryToolExecutorWithFallback` composes the two: a name absent from the registry
// ENTIRELY (`getRegisteredTool(name) === undefined`, checked directly -- never by matching
// `unknownToolResult`'s own text) delegates to `fallback` instead of producing the registry's own
// "unknown tool" error; every other outcome (correctly-absent, not-yet-executable, or a real
// dispatch) is untouched, so a genuine WS-06 stub without an executor yet STILL reports
// not-yet-executable rather than silently echoing -- that distinction is exactly what T8's
// conformance sweep (this file's own header, "unknown / correctly-absent / not-yet-executable") and
// the phase ledger's own "typed not-yet-executable errors" phrasing both depend on staying real.
// `fallback` is typed `EngineFacingToolExecutor` (not, say, engine.ts's own `ToolExecutor` by name)
// so any value structurally matching `{id,name,input} -> {output}` -- stubExecutor included --
// satisfies it with no cast.
export function buildRegistryToolExecutorWithFallback(deps: RegistryToolExecutorDeps, fallback: EngineFacingToolExecutor): EngineFacingToolExecutor {
  const registryExecutor = buildRegistryToolExecutor(deps);
  return {
    async execute(call: EngineToolCall): Promise<EngineToolResult> {
      if (getRegisteredTool(call.name) === undefined) return fallback.execute(call);
      return registryExecutor.execute(call);
    },
  };
}

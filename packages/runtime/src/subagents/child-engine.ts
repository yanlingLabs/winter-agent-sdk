// WS-10 (RULING R4-4): the real `ChildEngineDeps` implementation -- a child is an IN-PROCESS
// `runEngine()` instance, sharing this process's own registry/provider, never a second spawned OS
// process. Registered via `registerChildEngineFactory` (child-handle.ts, T3-frozen); consumed by
// engine.ts's own `ctx.session.spawnChild` (also frozen) through the factory-registration seam.
//
// --- Three seam gaps this file cannot close on its own (raised with the controller; see this
// lane's own report) ------------------------------------------------------------------------------
//
// (1) PROVIDER/STORE INJECTION -- CLOSED by Phase 4 Task 8 (rider 18). Neither
// `ChildEngineRunContext`, `SpawnChildRequest`, nor `ChildInheritance` carries a `Provider` or a
// `SessionStore`, so `createChildEngineFactory` below takes them as CONSTRUCTION-TIME dependencies
// (`ChildEngineFactoryDeps`), matching the frozen `(runCtx) => ChildEngineDeps` factory shape. The
// ONE production registration lives in `subagents/register-default-factory.ts` and is called by
// BOTH entrypoints (main.ts and testing.ts's inMemoryProcess), so all three transport legs derive
// their factory from one piece of code -- see that file's own header for why a shared helper rather
// than a one-liner in main.ts.
//
// (2) CHILD PERMISSION/HOOK CONTROL-RPC ROUTING -- CLOSED by Phase 4 Task 8 (rider 19, RULING
// P4-I). This section previously documented a live gap: the engine pump held exactly ONE `RpcBridge`
// per `runEngine()` and answered every `control_response` against it, so a child's own permission/
// hook request -- forwarded up to the real host, answered on the PARENT's stream -- was dropped by
// the parent's bridge and never reached the child's own, hanging that call until this file's stall
// watchdog aborted it. P4-I's ruling: "the pump routes control_response by requestId to the issuing
// CHILD bridge via a bridge roster on the run context (pump-side lookup; the child engine stays
// unaware of the parent pump)". Implemented as `ChildEngineRunContext.registerChildResponseHandler`
// (child-handle.ts): this wrapper records every requestId it forwards UP (`forwardedHostRequestIds`
// below), and its registered handler claims the matching response and writes it back into the
// child's OWN input channel -- so the child engine's own pump routes it to its own bridge exactly as
// if the host had answered directly. The handler is unregistered at settle().
// COMPANION (rider 20): an outstanding host request PAUSES this generation's stall watchdog -- a
// human at a child's permission prompt is not a child making no progress. The clock still fires for
// a genuine stall with nothing outstanding (child-engine.test.ts pins both directions).
//
// (3) PROGRAMMATIC AgentDefinition VISIBILITY -- CLOSED by Phase 4 Task 8 (Lane C's Gap #3):
// `ToolExecutionContext.agents` exists now and engine.ts's `buildDefaultToolExecutor` threads
// `config.agents` onto it, so tools/impl/agent.ts's `subagent_type` resolution sees a session's
// programmatic agents alongside the filesystem-defined ones.
//
// --- Child RuntimeConfig fidelity gaps (whole-branch review M7; DISCLOSED, not closed) ----------
//
// The child config below deliberately mirrors a SUBSET of the parent's. Everything omitted is
// stricter or neutral EXCEPT the third item, which is a real functional gap:
//   * `additionalDirectories` / `outputsDir` ($OUTDIR) -- absent: a child's writable set is
//     narrower than its parent's, never wider.
//   * `toolAliases` -- absent: a child sees native names only; nothing is renamed, so no rule or
//     hook matcher can be dodged by an alias the child alone knows.
//   * `agents` -- CLOSED in the fix wave's follow-up round (item 8): mirrored from the live
//     `runCtx.getParentAgents()` onto the child config, so a GRANDCHILD spawn resolves a
//     programmatic `subagent_type` the session declared. This was the one entry in this list that
//     was NOT merely stricter -- it silently broke a working host configuration one level down
//     while the identical call from the top-level session succeeded.
//   * `toolSearchEnabled` -- absent: a child's deferral activation comes from the environment
//     alone, so a host that enabled Tool Search per-session does not have it inside children.
//   * `approvalStore` / `autoStateStore` -- not passed to the child's `runEngine`: a child's
//     durable approvals and auto-mode counters are in-memory for its own lifetime.
// The fix wave closed the three entries that were NOT neutral -- the parent's live permission rules
// (C1/I6), the session's MCP state (I2/I4), and the programmatic `agents` map (M7, follow-up round);
// this list is what genuinely remains.
//
// --- Fix round 1 (controller review): two in-authority defects found and closed -----------------
//
// (C1, CRITICAL) `AgentDefinition.prompt` -- "System prompt of the child" (WS-10 §2) -- was parsed,
// validated, and persisted, but never actually DELIVERED to the child: `firstTurnText` below
// concatenated only `initialPrompt` + `req.prompt`. A `subagent_type` child ran with no persona at
// all. RULING P4-J (controller): until P5 lands the engine's real system-prompt channel
// (`Provider.generate` takes `{messages}` only -- no `system` parameter, engine.ts:200-202 -- so the
// first-user-turn concatenation is genuinely the only channel that exists), `definition.prompt` is
// delivered as the LEADING, clearly-delimited block of the child's first turn, layered onto
// `inherit.systemPrompt` (engine.ts's own `buildChildInheritance` sets this to `""` as "the honest
// base a definition's own prompt is expected to be layered onto") so a future engine that starts
// populating that field is composed with, never silently overridden by, a definition's own prompt.
// Fixed below (`resolvedSystemPrompt`); a dedicated end-to-end test proves the definition body
// reaches the child's own first provider call, in the pinned order prompt -> initialPrompt ->
// req.prompt.
//
// (I1, IMPORTANT) The child `RuntimeConfig` silently dropped the parent's `permissions.{allow,ask,
// deny}` rules and `hooks` -- WS-07 §11's "same rules... over child actions" was not delivered, and
// -- the security-relevant direction -- a forced-bypass child (WS-07 §11 forces bypass onto every
// descendant of a bypass parent) auto-approved exactly what the parent's own deny/ask rules forbid
// (the hardcoded `BASELINE_DENY_RULES` floor still bound; the SESSION's own configured rules did
// not). Undisclosed in this file's own otherwise-meticulous gap list -- an oversight, not a judgment
// call, now fixed the same way `disableBypassPermissionsMode`/`forwardSubagentText` already were:
// `parentPermissionRules`/`parentHooks`/`parentSandbox` are construction-time mirrors on
// `ChildEngineFactoryDeps` below, applied to every child's own `RuntimeConfig`. This closes the
// STATIC case (a host that configures rules/hooks at startup now binds every descendant); the LIVE
// case for RULES is closed by the P4 fix wave's own `runCtx.getParentRules()` (see
// `resolveParentRules` below): the parent's rules are re-read per child GENERATION, so a rule added
// mid-session binds the next spawn or resume. HOOKS remain a construction-time mirror -- no
// equivalent live accessor exists for them, and a hook change mid-run still does not reach an
// already-registered factory. Carried.
//
// (M1, MINOR) `record.transcript` was a hand-built, relative store KEY (missing the `~/.winter/
// projects/` prefix a real path needs) computed UNCONDITIONALLY -- including when no store is
// configured at all, in which case no transcript exists and the value named a file that would never
// be created. Fixed: an optional `winterHome` construction-time mirror resolves a genuine absolute
// path (WS-05's own documented layout) when supplied; a plain, honest sentinel string replaces it
// entirely when no store is configured, so a consumer (tools/impl/agent.ts's own `.output` stub)
// never points the model at a file that cannot exist.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { RuntimeConfig, WinterFrame, SessionStore, ControlResponseFrame, RuntimeHooksConfig, SandboxSettingsConfig, PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, createContextAccountant, type ContextAccountant, type EngineSettingsRuleSeed, type Provider, type ProviderMessage } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { getRegisteredTool, listRegisteredTools } from "../tools/registry.ts";
import { buildChildTranscriptWriter, childTranscriptSubpath, TranscriptWriter } from "../store/dialect.ts";
import { toDialectEntries, rebuildProviderMessages } from "../store/resume.ts";
import type {
  ChildHandle,
  ChildSessionRecord,
  ChildResult,
  SpawnChildRequest,
  ChildInheritance,
  ChildEngineDeps,
  ChildEngineFactory,
  ChildEngineRunContext,
} from "./child-handle.ts";
import type { GlobalAgentMessage, DeliveryOutcome } from "../messaging/adapter.ts";
import { checkAndRegisterSpawn, releaseSpawn } from "./limits.ts";
import { createStallWatchdog, resolveStallTimeoutMs } from "./watchdog.ts";
import { resolveModelAlias, describeRequestedModel, resolveEffort, recordModelEffort, type ModelCatalog, type RecordedModelEffort } from "./resolution.ts";
import { resolveForkInitialMessages } from "./fork.ts";
import { createWorkspace, cleanupWorkspace } from "./workspace.ts";
import { validateAgentDefinition } from "./definitions.ts";
import { resolveChildResumeMode, ChildResumeModeIncomparableError } from "../permissions/auto/inheritance.ts";
// Phase 5 Task 8: the parent's assembler and skill index reach a child through the factory deps --
// see ChildEngineFactoryDeps for why each one is a real gap rather than a nicety.
import type { SystemPromptAssembler } from "../context/seam.ts";
import { registerSkillSessionRuntime, clearSkillSessionRuntime, type SkillSessionRuntime } from "../skills/runtime.ts";
import type { SkillListing } from "../context/seam.ts";
import type { StructuredOutputSeam } from "../structured/seam.ts";
import type { SourcedHookEntry } from "../hooks/registry.ts";
import type { CompactionController } from "../compaction/seam.ts";

/** The identity an R6-17 child's own provider reports. `authRefKind` is the CHILD's material's kind (Ruling E-1), never the parent's. */
export interface ChildProviderIdentity {
  providerId: string;
  modelKey: string;
  family: string;
  continuationDomain?: string;
  adapterId?: string;
  adapterVersion?: string;
  catalogVersion?: string;
  authRefKind?: string;
}

/**
 * What `resolveChildProvider` answers. `refused` (Ruling E-1, R-E3) is the cross-provider child with
 * no credential of its own: the resolver names the child, the provider and the reason, the spawn
 * path says so on stderr AND on a `continuity_warning` frame, and the child runs on the
 * DEFERRED-REFUSAL provider it carries -- its first generation lands on R6-F with NO request. Never
 * the parent's provider: a foreign model id on the parent's wire is exactly what a refusal exists to
 * prevent.
 */
export type ChildProviderResolution =
  | { provider: Provider; identity: ChildProviderIdentity }
  | { refused: { providerId: string; modelKey: string; reason: string }; provider: Provider; identity: ChildProviderIdentity };

export interface ChildEngineFactoryDeps {
  provider: Provider;
  /**
   * Ruling E-1: the operator's channel for a refused cross-provider child. `main.ts` writes it to
   * the process's stderr, `testing.ts` to the in-memory leg's own stderr queue -- the same two sinks
   * every wiring warning already uses. Absent means the stderr half is silent (the frame still goes).
   */
  warn?: (line: string) => void;
  /**
   * Phase 6 Task 10 (R6-17): THE CHILD'S OWN PROVIDER.
   *
   * `AgentDefinition.model` is a real per-child model selection, and until this seam existed a child
   * that named one ran off `deps.provider` -- the PARENT's already-resolved adapter, pinned to the
   * parent's model id and, for a qualified `<providerId>/<model>` key, to the parent's PROVIDER. The
   * child's model then travelled only as `ProviderRequest.model`, so a cross-provider child sent one
   * vendor's model id to another vendor's endpoint.
   *
   * Returns `undefined` when the model resolves to the same thing the parent is already running (or
   * cannot be resolved at all), in which case the parent's provider is used unchanged -- which is
   * every pre-P6 child and every session whose provider is the reserved test double.
   *
   * The IDENTITY comes back with it deliberately: a child running its own provider that reported its
   * PARENT's identity would write provider-state records naming a model it never called, and the
   * resume side reads those records to decide what may be replayed natively.
   */
  resolveChildProvider?: (model: string) => ChildProviderResolution | undefined | Promise<ChildProviderResolution | undefined>;
  // Durable storage for child transcripts -- when omitted, children run WITHOUT persistence
  // (matching this codebase's own established `persistSession:false` behavior elsewhere: the engine
  // runs fine with no store, it just does not survive a restart, and `resume()` degrades to
  // "starts fresh with no rebuilt history," disclosed at that call site below).
  store?: SessionStore;
  // Fix round 1 (finding M1): an ABSOLUTE-path mirror for the SAME store `store` above points at --
  // no public API resolves a SessionStore key to a real filesystem path (session-store.ts's own
  // `winterHome` is a private field), so a genuine, model-readable transcript path (WS-12 §7.2's own
  // "return the durable transcript path through the tool result") is only possible when the caller
  // supplies this alongside `store`. Absent: `record.transcript` degrades to a relative store key
  // (still meaningful to a caller holding the same store object, just not directly `cat`-able).
  winterHome?: string;
  env?: Record<string, string | undefined>;
  modelCatalog?: ModelCatalog;
  // WS-10 §5's own fork-mode interactive default -- see policy.ts's own header for why this stays a
  // parameter (no interactive-CLI surface exists anywhere in packages/runtime today).
  interactiveDefault?: boolean;
  // A construction-time-fixed mirror of the top-level session's own
  // `permissions.disableBypassPermissionsMode` (WS-07 §6.4) -- gap (1) above means this cannot be
  // read fresh, per spawn, from the live parent; a process-wide default is the best available
  // approximation, and errs toward the SAFE direction (a host that sets this expects it to bind on
  // every descendant, not just the immediate session).
  disableBypassPermissionsMode?: boolean;
  // A construction-time-fixed mirror of the top-level session's own `forwardSubagentText` --
  // applies UNIFORMLY to every nesting level for the identical reason: the ORIGINAL top-level value
  // is not reachable through the frozen per-run seam once a grandchild spawns its own child.
  forwardSubagentText?: boolean;
  // Fix round 1 (finding I1): construction-time mirrors of the top-level session's own
  // `permissions.{allow,ask,deny}` and `hooks` -- the SAME "cannot be read fresh per spawn" caveat
  // as `disableBypassPermissionsMode` above applies identically (gap (2)'s root cause: nothing
  // reachable from a registered factory sees the parent's LIVE configuration, only whatever was true
  // when the factory was constructed). Merged into every child's own `RuntimeConfig.permissions`/
  // `.hooks` in `baseConfig` below. Absent (every pre-existing caller): a child gets NEITHER --
  // exactly today's pre-fix-round behavior, never a silent behavior change for an existing caller
  // that doesn't opt in.
  parentPermissionRules?: { allow?: string[]; ask?: string[]; deny?: string[] };
  parentHooks?: RuntimeHooksConfig;
  // Mirrored alongside `parentHooks` (WS-08) -- without this, a mirrored hook config never actually
  // causes the child's own engine to emit the hook_started/hook_progress/hook_response lifecycle
  // frames a host would use to observe it (transformChildFrame's own catch-all already forwards
  // them unmodified once emitted; this is what makes the child emit them at all).
  parentIncludeHookEvents?: boolean;
  // WS-12 §8: NOT a security fix (DEFAULT_SANDBOX_SETTINGS is already the strictest posture a child
  // falls back to -- see this file's own fix-round-1 header) -- a fidelity mirror only, so a host
  // that deliberately LOOSENED its own sandbox (e.g. a configured network exclusion) has that
  // loosening reach its descendants too, rather than every child silently reverting to the default.
  parentSandbox?: SandboxSettingsConfig;
  // Fix round 1 (finding Q1, forward-compat): WS-07 §11's own "resume applies the stricter of
  // recorded vs. current parent policy" is structurally unreachable in production today --
  // `resolveChildResumeMode` (permissions/auto/inheritance.ts) has ZERO call sites anywhere in this
  // repository (confirmed by direct grep), because nothing reachable from `ChildEngineRunContext`/
  // `SpawnChildRequest`/`ChildInheritance` exposes the parent's CURRENT live policy -- the identical
  // root cause as gap (2). This optional accessor is the SAME shape the controller's own review
  // names as the real per-spawn seam T8 should eventually add to `ChildEngineRunContext` --
  // supplying it here (today: only a test) makes `resume()` below apply P4-D's stricter-of
  // comparator and surface its own `ChildResumeModeIncomparableError` as a typed, non-retryable
  // refusal instead of either ignoring the parent's current policy or letting the error escape
  // uncaught. Absent (production, until T8 wires the real per-spawn field): `resume()` falls back to
  // the recorded mode verbatim -- exactly today's pre-fix-round behavior, a strict widening of
  // capability, never a behavior change for any existing caller.
  getParentPolicy?: () => { mode: PermissionMode; version: number; hash: string };
  // --- Phase 5 Task 8 --------------------------------------------------------------------------
  //
  // Lane C's report: "the pinned child-persona test will break the moment the assembler is
  // registered for children", and item 6 of its "What T8 must wire". Without this a child runs with
  // NO assembler while its parent has one -- so `agentSystemPrompt` becomes the child's WHOLE system
  // prompt (the engine's R5-16 fallback) and it loses the minimal prompt, the dynamic sections,
  // WINTER.md and the memory block its parent has. Supplied by
  // `subagents/register-default-factory.ts` from the ONE production wiring, so all three transport
  // legs behave alike.
  systemPromptAssembler?: SystemPromptAssembler;
  // The session's own skill index, so a child can actually invoke a skill. `skills/runtime.ts` is
  // keyed `agentId ?? sessionId` -- deliberately, so a child never resolves against its PARENT's
  // `skills` option -- which means a child with no registration of its own gets a typed "no skills
  // runtime" refusal for every `Skill` call. Registered per GENERATION below and withdrawn at
  // settle, mirroring how the MCP/ToolSearch session registries are already handled.
  skillRuntime?: { index: SkillSessionRuntime["index"]; skillOverrides?: SkillSessionRuntime["skillOverrides"] };
  // Phase 5 fix wave (B-low): the model-facing LISTING, alongside the index above. The two are a
  // pair and only one of them was threaded: a child could invoke `Skill(name)` but was never told
  // which names exist, so its listing was the empty set while its parent's was full. That is not a
  // smaller surface, it is a surface the model cannot discover -- it can only guess a name. The
  // engine already gates the block on `Skill` actually being advertised to that agent, so a child
  // whose tool set excludes `Skill` still gets nothing (see EngineOptions.skillListing).
  skillListing?: SkillListing;
  /**
   * Phase 5 residual round (NEW-4): THE SETTINGS SEED, tags intact.
   *
   * C1 gave the parent its settings-file rules and I1 gave it the resolved-root floors; neither
   * reached a child, so the MANAGED tier -- the strongest one, and the only one a forced-bypass
   * child still honours -- stopped at the session boundary. A model reached it by delegating.
   *
   * NOT the `getParentRules` mirror, deliberately: a mirrored entry arrives re-tagged `sdk`, and
   * stage 2 under forced bypass honours `managed` denies alone, so the mirror is inert in precisely
   * the hostile case. Passing the seed keeps every source tag, which is also what keeps the child's
   * P5-A/P5-D per-tier gates identical to its parent's.
   */
  settingsRules?: EngineSettingsRuleSeed;
  // The session's structured-output seam. A child needs it whenever `SpawnChildRequest.outputFormat`
  // is set -- which Lane W's `agent({schema})` does on every schema'd call -- because `outputFormat`
  // with NO seam is a hard `error_during_execution` on the child's first round (T3's concern 3), and
  // a `Workflow` run would then fail on its first schema'd agent call rather than validating.
  // THE PARENT'S OWN INSTANCE (Lane K's NEEDS_CONTEXT 6): one compiled-validator cache per session.
  structuredOutput?: StructuredOutputSeam;
  // --- Phase 5 fix wave, I4 ----------------------------------------------------------------------
  //
  // T8 threaded THREE of the parent's session seams to children (assembler, skills, structured) and
  // left these two behind.
  //
  // `extraHookEntries` is the security half. `engine.ts` builds `allHookEntries = [...config.hooks
  // entries, ...extraHookEntries]` for the PARENT only, and a child mirrors `hooks: deps.parentHooks`
  // -- the `Options.hooks` CALLBACKS alone. So a `PreToolUse` command hook a user wrote into
  // `~/.winter/settings.json` to deny `rm -rf` ran for the parent's Bash calls and was SILENT for
  // every subagent's: WS-07 §11 ("the same rules apply over child actions") and WS-08 §2, in a new
  // dimension of the P4 C1 class (a child auto-approving what its parent gates).
  //
  // `compactionController` is the correctness half: with none, `maybeAutoCompact` returns immediately
  // and a long-running child never compacts. Inert against a mock provider, live at P6.
  extraHookEntries?: readonly SourcedHookEntry[];
  compactionController?: CompactionController;
  /**
   * Phase 5 residual round, NEW-2: ONE CONTROLLER PER SPAWN, not one per session.
   *
   * `compactionController` above is a single instance built once for the whole factory, so every
   * SIBLING child shared one `lastSummary` memo. The comment at its construction site claimed
   * "per-parent", and the reason it gives -- a child folding its own history into the parent's memo
   * -- applies between siblings just as exactly.
   *
   * Bounded rather than dramatic: `compaction/controller.ts`'s carry-forward is gated on the input's
   * head message being content-equal to `lastSummary`, so a sibling's summary can only be carried
   * into a child whose own head is byte-identical to it. That is rare, and it is also not a property
   * anyone reasoned about -- it is the accident that kept a shared memo from being visible.
   *
   * Per SPAWN and not per GENERATION: a child that compacts and then resumes must keep its own memo
   * across generations, which is exactly what the memo is for.
   */
  compactionControllerFactory?: () => CompactionController;
}

export function createChildEngineFactory(deps: ChildEngineFactoryDeps): ChildEngineFactory {
  return (runCtx: ChildEngineRunContext): ChildEngineDeps => ({
    spawn(req: SpawnChildRequest, inherit: ChildInheritance): Promise<ChildHandle> {
      return spawnChildEngine(req, inherit, runCtx, deps);
    },
  });
}

// The result-frame's own subset this file actually reads -- SdkMessage's own "result" variant
// (frames.ts) carries far more, but only `is_error`/`result` are needed to produce a ChildResult.
interface ResultLikeMessage {
  type?: string;
  is_error?: boolean;
  result?: string;
  [k: string]: unknown;
}

async function spawnChildEngine(req: SpawnChildRequest, inherit: ChildInheritance, runCtx: ChildEngineRunContext, deps: ChildEngineFactoryDeps): Promise<ChildHandle> {
  const agentId = randomUUID();
  // NEW-2: this child's OWN controller, minted once here and reused by every generation below. Falls
  // back to the shared instance so a host that supplies only `compactionController` keeps working.
  const ownCompactionController = deps.compactionControllerFactory !== undefined ? deps.compactionControllerFactory() : deps.compactionController;
  const env = deps.env ?? process.env;

  // WS-10 §6: depth/concurrency checked BEFORE any real work (workspace creation, store I/O) --
  // a rejected spawn should be cheap and side-effect-free.
  // Phase 4 fix wave (I1): keyed by the SPAWNER's own agent key -- see limits.ts's own header for
  // why `parentSessionId` alone would now read depth 0 at every nesting level.
  checkAndRegisterSpawn({ parentKey: runCtx.parentAgentId ?? runCtx.parentSessionId, childKey: agentId, env });
  let spawnRegistered = true;

  try {
    // --- Model/effort resolution (WS-10 §3) -----------------------------------------------------
    const requestedModel = describeRequestedModel(req);
    const resolvedModel = resolveModelAlias(inherit.model, deps.modelCatalog); // may throw UnresolvableModelAliasError
    const resolvedEffort = resolveEffort(inherit.effort);
    // Phase 6 Task 10 (R6-17): resolved HERE, once, from the model this child actually settled on --
    // never from `req.model`, which may be an alias, and never inside the runEngine call, where a
    // second resolution could disagree with the one `config.model` was built from.
    // ASYNC since the fix wave (Ruling E-1): a child on ANOTHER provider than the parent's has its
    // own credential probed before the spawn commits to it, and a probe is a store read.
    const childResolution = await deps.resolveChildProvider?.(resolvedModel.effectiveModel);
    // P6.6 (WS-13c §8): the parent's identity AT THIS SPAWN. `inherit.provider` (R6-17, an EXISTING
    // field -- `ChildInheritance.provider`, child-handle.ts) is `buildChildInheritance`'s own read of
    // the parent's LIVE `currentProviderIdentity` (engine.ts:2405), taken fresh at the moment of THIS
    // spawn -- it already reflects any `set_model` that landed before this child existed, with no new
    // wiring required. Fix round 1 (I2): a `deps.parentIdentity` override used to sit in front of
    // this with `deps.parentIdentity ?? inherit.provider` -- backwards precedence for an unwired,
    // untested field (a future construction-time wiring of it would silently SHADOW the live value
    // on every spawn, exactly the "a second source can only lie or drift" the ruling names) -- and
    // was deleted rather than reordered: nothing needs a second source when the live one already
    // covers every production spawn and is proven to (cross-family-resume.test.ts's own
    // production-source cases). Captured ONCE, here, and reused verbatim by `resume()` below --
    // WS-13c §8 compares against what was true when this child was BORN, never against whatever the
    // parent is doing by the time it resumes.
    const parentIdentityAtSpawn: ChildProviderIdentity | undefined = inherit.provider;
    // P6.6 (WS-13c §8, Lane D Task 5 -- the investigation this lane's own report opens with):
    // `childProvider` is now ALWAYS materialised, never left `undefined`. Before this fix, a
    // "same-provider" child (the final `else` branch below) recorded NO identity of its own at all,
    // and `startGeneration` fell through to a bare `childProvider?.provider ?? deps.provider` on
    // EVERY generation -- spawn and every future resume alike -- by a fresh, un-memoized property
    // read of `deps`. Nothing pinned a resumed child to what was true when IT was spawned: `deps`
    // (and `deps.provider`) are a plain, caller-held, mutable reference this closure keeps reading
    // by property access forever, so a LATER reassignment of that one property (a test simulating a
    // parent's family switch; a future production change that makes it track the session's live
    // model) would move an already-spawned child's resume() silently. Freezing `{provider, identity}`
    // into this OBJECT now is what makes `resume()` immune to that: the object keeps its OWN
    // reference regardless of what `deps.provider` is reassigned to afterward (proven in this lane's
    // own cross-family-resume.test.ts's same-provider case). `.identity` stays `undefined` -- never a
    // fabricated `{providerId: "", ...}` sentinel -- when `inherit.provider` does not exist, so a
    // pre-R6-17 caller or a bare test double still records no `effectiveProvider` at all:
    // byte-identical to every child spawned before this change (Fix round 1, I2's own "must refuse,
    // never synthesise" instruction: this stays `undefined`, so `resume()` below has NOTHING to
    // contradict and proceeds unrefused -- see the `if (again === undefined)` branch's own comment).
    let childProvider: { provider: Provider; identity: ChildProviderIdentity | undefined };
    if (childResolution !== undefined && "refused" in childResolution) {
      // RULING E-1 / R-E3: never the parent's provider. Both the operator and the host are told, in
      // words that name the child and the provider -- counts and identity only, never credential
      // material (Global Constraints) -- and the child runs on the deferred-refusal provider the
      // resolver handed back: its first generation is R6-F's result, with no request on any wire.
      const { providerId, modelKey, reason } = childResolution.refused;
      const line = `child agent "${req.name ?? req.definition?.description ?? "agent"}" (${agentId}) asked for model "${modelKey}" on provider "${providerId}", which this session has no credential for: ${reason}; the child's first generation will fail with a typed provider error and no request is made`;
      deps.warn?.(`winter: ${line}`);
      try {
        runCtx.forwardChildFrame(
          {
            type: "data",
            message: {
              type: "system",
              subtype: "continuity_warning",
              warning: "child_provider_refused",
              detail: line,
              uuid: randomUUID(),
              session_id: runCtx.parentSessionId,
            },
          },
          { parentToolUseId: req.parentToolUseId, agentId },
        );
      } catch {
        /* a torn-down parent stream must never fail a spawn over a warning */
      }
      childProvider = { provider: childResolution.provider, identity: childResolution.identity };
    } else if (childResolution !== undefined) {
      childProvider = childResolution;
    } else {
      // Same-provider (or no resolver configured): materialise rather than leave undefined -- see
      // the header comment above `let childProvider` for why this is the fix.
      childProvider = { provider: deps.provider, identity: parentIdentityAtSpawn };
    }
    const modelEffort = recordModelEffort({
      ...(requestedModel !== undefined ? { requestedModel } : {}),
      resolved: resolvedModel,
      effort: resolvedEffort,
      // WS-13c §3/§8: recorded ONLY when there is a real identity to report (never the absence of
      // one) -- see `RecordedModelEffort.effectiveProvider`'s own doc: this is what resume() reads
      // back as the child's OWN authoritative provider, independent of the parent's current one.
      ...(childProvider.identity !== undefined ? { effectiveProvider: childProvider.identity.providerId } : {}),
      // WS-13c §3: the slot the request named, when it named one (Lane A stamps `inherit.slot`; this
      // is the one call site that turns it into a durable record).
      ...(inherit.slot !== undefined ? { slot: inherit.slot } : {}),
    });

    // --- Tool restriction (WS-10 §2) -------------------------------------------------------------
    // `inherit.tools` is the resolved allowlist (a fork's exact pool, a definition's own
    // restriction, or the session's current advertised pool for a bare child -- engine.ts's own
    // buildChildInheritance already picked the right one). `AdvertisedSetInputs.tools` is never
    // wired from RuntimeConfig anywhere (engine.ts, frozen, deliberately leaves it unset --
    // registry.ts's own header: "AdvertisedSetInputs.allowedTools exists for documentation only...
    // cfg.tools is left unset here"), so the only mechanism reachable from this lane that is
    // actually ENFORCED (both hidden from advertisement AND denied at evaluation time, not merely
    // hidden) is `disallowedTools` -- computed as the complement of the allowlist against every
    // registered canonical tool name, unioned with the resolved definition's own `disallowedTools`.
    const allToolNames = listRegisteredTools().map((t) => t.descriptor.canonicalName);
    const allowSet = new Set(inherit.tools);
    const complementDeny = allToolNames.filter((name) => !allowSet.has(name));
    const disallowedTools = [...new Set([...complementDeny, ...(req.definition?.disallowedTools ?? [])])];

    // A capability-gated tool (WebSearch/LSP/Agent itself/etc.) is excluded from a session's own
    // advertised set unless its own `capabilityRequirements` are satisfied (registry.ts's own
    // `isAvailable`). A child built with NO capabilities at all would therefore silently lose every
    // one of those tools regardless of the allowlist above -- including Agent itself
    // (`winter.subagents`), which would make nested spawns impossible. Derived as the union of every
    // ALLOWED tool's own capabilityRequirements: the parent necessarily already held these tokens
    // (it advertised these exact tools to its own model), so granting the identical set to the child
    // never widens anything beyond what the parent itself already had.
    const capabilities = [...new Set(inherit.tools.flatMap((name) => getRegisteredTool(name)?.descriptor.capabilityRequirements ?? []))];

    // WS-10 §2: "tools must include Skill if skills is used" -- validation only (skills has no
    // runtime anywhere in this codebase yet). Surfaced in the eventual spawn notice text, never a
    // hard refusal -- the definition already came from a trusted source (programmatic config, or a
    // filesystem file gated by RULING R4-7).
    const definitionWarnings = req.definition !== undefined ? validateAgentDefinition(req.definition) : [];

    // --- MCP (WS-10 §2 `AgentDefinition.mcpServers`; fix wave I2 + I4) ---------------------------
    //
    // I2: the parent's own resolved MCP state, so this child is not an MCP island -- its
    // `WaitForMcpServers`/ToolSearch answers are computed against the SESSION's real server state
    // instead of a child-local void (which answered a WRONG `ready:true`). The lifecycle half needs
    // nothing here: a bridge tool resolves `getSessionMcpLifecycle(ctx.sessionId)`, and since I1 a
    // child's ctx.sessionId IS the owning session's.
    //
    // I4: `AgentDefinition.mcpServers` was accepted, round-tripped and then SILENTLY DROPPED -- the
    // one wrong option of the three the review names. `AgentMcpServerSpec` is
    // `string | Record<name, config>`: an OBJECT entry declares a CHILD-SCOPED server (connected by
    // this child's own lifecycle, torn down with it -- its tools are registered while the child
    // lives and are absent from the parent's own frozen `init.tools`), while a STRING entry NAMES a
    // server the session already declares, which the child already reaches through the inherited
    // state above -- so it is satisfied by inheritance when the session declares that name, and a
    // legible warning (never a silent drop) when it does not.
    const parentMcp = runCtx.getParentMcpState?.();
    // Fix wave follow-up (8): read at spawn, from the live accessor, never captured at factory
    // construction (the C1/I6 lesson applied to the one remaining non-neutral M7 gap).
    const parentAgents = runCtx.getParentAgents?.();
    const childScopedMcpServers: NonNullable<RuntimeConfig["mcpServers"]> = {};
    for (const spec of req.definition?.mcpServers ?? []) {
      if (typeof spec === "string") {
        if (parentMcp?.declaredServers?.[spec] === undefined) {
          definitionWarnings.push(`mcpServers names "${spec}", which this session does not declare -- ignored`);
        }
        continue;
      }
      for (const [name, cfg] of Object.entries(spec)) childScopedMcpServers[name] = cfg;
    }
    const hasChildScopedMcpServers = Object.keys(childScopedMcpServers).length > 0;

    // --- Isolation (WS-10 §8) --------------------------------------------------------------------
    const workspaceResult = await createWorkspace({ parentCwd: inherit.sessionRoot, ...(req.isolation !== undefined ? { isolation: req.isolation } : {}), agentId });
    if (!workspaceResult.ok) {
      throw new Error(`winter: Agent spawn failed -- ${workspaceResult.error}`);
    }
    const workspace = workspaceResult.workspace;

    // --- Durable transcript (WS-05 §4/§5.2/§5.3, WS-10 §7) --------------------------------------
    const childStore = deps.store;
    const projectKey = compatibilityKeys(inherit.sessionRoot).transcriptProjectKey;
    const childKey = { projectKey, sessionId: runCtx.parentSessionId, subpath: childTranscriptSubpath(agentId) };
    const writer: TranscriptWriter | undefined =
      childStore !== undefined
        ? buildChildTranscriptWriter({ store: childStore, projectKey, parentSessionId: runCtx.parentSessionId, agentId, parentToolUseId: req.parentToolUseId, cwd: workspace.root })
        : undefined;
    // Fix round 1 (finding M1): never claim a transcript that cannot exist (no store configured),
    // and prefer a genuine ABSOLUTE path (WS-05's own documented layout) over a bare, non-readable
    // store key whenever this factory was given its own `winterHome` to resolve one -- the store's
    // own `winterHome` is a PRIVATE field (no public API resolves a key to a real path; verified by
    // reading session-store.ts), so an absolute path is only available when the caller supplies it
    // itself as a construction-time value, exactly like every other mirror on `ChildEngineFactoryDeps`.
    const transcriptPath =
      childStore === undefined
        ? "none -- no durable session store is configured for this run"
        : deps.winterHome !== undefined
          ? `${deps.winterHome}/projects/${projectKey}/${runCtx.parentSessionId}/${childTranscriptSubpath(agentId)}.jsonl`
          : `${projectKey}/${runCtx.parentSessionId}/${childTranscriptSubpath(agentId)}.jsonl`; // a store exists but this factory has no winterHome to resolve an absolute path -- a relative store key, not directly readable by path, but still a meaningful identifier for a caller holding the same store object

    // WS-13c §8: `ChildSessionRecord.model` IS `RecordedModelEffort` (R-6c-20), so `effectiveProvider`/`slot` type-check without a local widening.
    const record: ChildSessionRecord = {
      id: agentId,
      parentSessionId: runCtx.parentSessionId,
      parentToolUseId: req.parentToolUseId,
      transcript: transcriptPath,
      status: "running",
      runtime: "winter-agent",
      model: modelEffort,
      permission: inherit.policy,
      ...(req.name !== undefined ? { name: req.name } : {}),
    };
    void writer?.writeMetadata({ ...record });

    let resolveResultOnce!: (r: ChildResult) => void;
    const resultPromise = new Promise<ChildResult>((resolve) => {
      resolveResultOnce = resolve;
    });

    let currentSink: { write(f: WinterFrame): void } | undefined;
    // Reassigned by EVERY startGeneration call, below -- `.stop()` (external to any one generation)
    // must route through the SAME gated `settle` a generation's own watchdog/observe() use
    // internally, never a parallel, ungated status mutation: otherwise a `.stop()` that races a
    // genuine (interrupted) "result" frame arriving moments later could have its own "stopped"
    // status silently overwritten back to "failed" by that frame's own observe()/settle() call,
    // since THAT call would see an unset generationSettled flag and proceed as if nothing had
    // settled yet. Routing both through the one gate makes whichever fires FIRST win, permanently.
    // `settle` itself now owns calling the generation's own `abortGeneration` (see its own comment),
    // so `.stop()` needs no separate abort handle of its own any more.
    let currentSettle: ((status: "completed" | "failed" | "stopped", content: string) => void) | undefined;

    // One generation = one live `runEngine()` invocation, from its initial "user" turn until IT
    // reaches a terminal frame (or is stopped/stalls). `resume()` starts a NEW generation against
    // the SAME `record`/`resultPromise` -- WS-10 §7's own durable-object contract, and the
    // seam-contracts-p4.test.ts fixture's own pinned behavior: `result()` resolves EXACTLY ONCE, for
    // the life of the handle -- a later generation's own eventual outcome is observable only through
    // its own forwarded frames (WS-10 §4), never a second settlement of THIS promise (a native
    // Promise's `resolve` is itself idempotent, so calling `resolveResultOnce` again from a later
    // generation is a harmless no-op, never a second, conflicting value).
    function startGeneration(config: RuntimeConfig, initialMessages: ProviderMessage[], liveText: string, agentSystemPrompt?: string): void {
      const channel = createInMemoryChannel();
      currentSink = channel.host.output;
      const startedAt = Date.now();
      let totalToolUseCount = 0;
      let lastAssistantText = "";
      let generationSettled = false;

      const watchdog = createStallWatchdog(resolveStallTimeoutMs(env), (err) => {
        settle("failed", err.message); // settle() itself now owns calling abortGeneration()
      });

      // Every interrupt/end_input control_request THIS wrapper issues (never the model's own) is
      // tracked by requestId -- the nested child engine acknowledges host-initiated control_requests
      // with its own control_response (the same generic RpcBridge correlation mechanism also used for
      // permission/hook requests), and that response would otherwise be forwarded verbatim, by the
      // read loop below, straight up to the REAL parent host stream: two stray control_response
      // frames per completed child, "answering" requests the real host never issued -- harmless to a
      // human, but it corrupts a byte-level trace-equivalence check (T8), and a careless future
      // host-side bridge could conceivably misfile one against an unrelated in-flight request of its
      // own.
      const ownRequestIds = new Set<string>();
      // Phase 4 Task 8 (rider 19, RULING P4-I): every control_request THIS CHILD's own engine issued
      // (a permission prompt, a hook invocation) that this wrapper forwarded UP to the real host --
      // the exact complement of `ownRequestIds` above. The host answers on the PARENT's stream,
      // where the parent's single RpcBridge finds no matching requestId and would drop it (the whole
      // Gap #2 hang Lane C documented). The parent pump now offers such a response to every
      // registered child handler; this one claims the ids it forwarded and writes the frame back
      // into the child's OWN input, so the child engine's own pump routes it to its own bridge
      // exactly as if the host had answered it directly. The child stays entirely unaware of the
      // parent pump, per P4-I's own wording.
      const forwardedHostRequestIds = new Set<string>();
      const unregisterResponseHandler = runCtx.registerChildResponseHandler?.((frame: ControlResponseFrame): boolean => {
        if (!forwardedHostRequestIds.has(frame.requestId)) return false;
        forwardedHostRequestIds.delete(frame.requestId);
        // Rider 20: the human has answered -- the progress clock starts counting again (only once
        // the LAST outstanding request is answered; `resume` is depth-counted).
        watchdog.resume();
        try {
          channel.host.output.write(frame);
        } catch {
          /* a torn-down child channel must never crash the parent's pump */
        }
        return true;
      });
      function abortGeneration(): void {
        try {
          const requestId = randomUUID();
          ownRequestIds.add(requestId);
          channel.host.output.write({ type: "control_request", requestId, subtype: "interrupt", payload: undefined });
        } catch {
          /* a torn-down channel must never crash the abort path */
        }
        try {
          const requestId = randomUUID();
          ownRequestIds.add(requestId);
          channel.host.output.write({ type: "control_request", requestId, subtype: "end_input", payload: undefined });
        } catch {
          /* see above */
        }
      }

      function settle(status: "completed" | "failed" | "stopped", content: string): void {
        if (generationSettled) return;
        generationSettled = true;
        record.status = status;
        // Rider 19: stop claiming responses for a generation that is over -- otherwise a late answer
        // would be written into a torn-down channel, and the roster would grow one dead entry per
        // completed child for the process's whole lifetime.
        unregisterResponseHandler?.();
        // Phase 5 Task 8: drop this child's skill runtime -- same singleton hygiene as the response
        // handler above. `resume()` re-registers it for the next generation, so a resumed child is
        // not left without one.
        if (deps.skillRuntime !== undefined) clearSkillSessionRuntime(agentId);
        forwardedHostRequestIds.clear();
        watchdog.cancel();
        releaseSpawn(agentId);
        void writer?.writeMetadata({ ...record });
        // WS-10 §8: "auto-cleaned when unchanged" -- fire-and-forget, regardless of which terminal
        // status this generation reached (a stopped/failed child's own worktree is reclaimed exactly
        // like a completed one's, IF genuinely unchanged; real, undiscarded work is left in place
        // either way -- see workspace.ts's own cleanupWorkspace for the exact safety checks).
        // Fire-and-forget by design, but never an UNHANDLED rejection: a cleanup that cannot run is
        // a no-op result, not a crash landing on an unrelated test or turn.
        void cleanupWorkspace(workspace).catch(() => undefined);
        // A "completed"/"failed" settlement is reached via observe()'s OWN "result" data frame --
        // i.e. the nested engine finished a turn and is now sitting idle, waiting for its OWN next
        // "user" input frame, which nothing will ever send it. Without this call, that engine
        // instance (plus its writer, plus this read loop) leaks for the rest of the daemon's process
        // lifetime, once per completed child, forever -- a zombie engine, not merely a zombie
        // promise. `interrupt` on an already-idle engine is a documented no-op; a second/duplicate
        // `end_input` is harmless (`Queue.end` is idempotent) -- so calling this unconditionally, on
        // EVERY terminal status (not only the abrupt-stop/stall paths), is always safe.
        abortGeneration();
        resolveResultOnce({
          status,
          content,
          resolvedModel: config.model,
          totalToolUseCount,
          totalDurationMs: Date.now() - startedAt,
          ...(structuredOutput !== undefined ? { structuredOutput: structuredOutput.value } : {}),
        });
      }
      currentSettle = settle;

      // P5-I: a BOX, not a bare value, so "the child produced `undefined`" and "the child produced
      // nothing" stay distinguishable -- the seam's own contract is that absence means fall back to
      // the text re-parse, and a bare `undefined` would make a legitimate result look like absence.
      let structuredOutput: { value: unknown } | undefined;
      function observe(frame: WinterFrame): void {
        if (frame.type !== "data") return;
        const message = frame.message as ResultLikeMessage & { message?: { content?: Array<{ type?: string; text?: string; [k: string]: unknown }> } };
        if (message.type === "assistant") {
          for (const block of message.message?.content ?? []) {
            if (block["type"] === "tool_use") totalToolUseCount += 1;
            if (block["type"] === "text" && typeof block["text"] === "string") lastAssistantText = block["text"] as string;
          }
        } else if (message.type === "result") {
          const isError = message.is_error === true;
          const resultText = typeof message.result === "string" ? message.result : lastAssistantText;
          // RULING P5-I: the engine's structured SUCCESS variant sets `structured_output` and NO
          // `result` (engine.ts) -- which is exactly why `resultText` falls back to the last
          // assistant text above, and exactly why the validated object needs its own channel. Read
          // by PRESENCE of the key, not by truthiness: `null`, `0` and `""` are all legitimate
          // values a caller's schema may permit.
          if ("structured_output" in message) structuredOutput = { value: message["structured_output"] };
          settle(isError ? "failed" : "completed", resultText);
        }
      }

      const correlation = { parentToolUseId: req.parentToolUseId, agentId };
      void (async () => {
        try {
          for await (const frame of channel.host.input) {
            watchdog.poke();
            observe(frame);
            // `UnknownFrame`'s own wide `type: string` (frames.ts) defeats plain discriminated
            // narrowing here (same reason engine.ts's own pump casts at its identical check) -- an
            // explicit cast, matching that established, frozen precedent exactly.
            if (frame.type === "control_response" && ownRequestIds.has((frame as ControlResponseFrame).requestId)) {
              ownRequestIds.delete((frame as ControlResponseFrame).requestId); // our own interrupt/end_input handshake -- never surfaced to the real host
              continue;
            }
            // Phase 4 Task 8 (riders 19/20): a control_request coming OUT of the child is the child's
            // own engine asking the host something (a permission decision, a hook invocation). Record
            // its id so the roster handler above can route the answer back, and PAUSE the stall
            // watchdog: a child waiting on a human is not a child making no progress (RULING P4-I's
            // own companion ruling), and the 600 s clock would otherwise abort a genuinely-answerable
            // prompt out from under the person answering it.
            //
            // Phase 4 fix wave (T8 review M5): the pause happens ONLY AFTER the forward has actually
            // SUCCEEDED, and the id is only claimed then. Pausing first (the previous order) meant a
            // forward that THREW -- a torn-down parent stream, which the catch below is here for --
            // left the clock paused with a request nobody had received and nobody would ever answer:
            // the unbounded wait the T8 report's own concern 6 discloses, reachable with no human
            // involved at all. On a failed forward the request never reached the host, so the child
            // is genuinely making no progress and the stall clock must keep running.
            try {
              runCtx.forwardChildFrame(frame, correlation);
              if (frame.type === "control_request") {
                forwardedHostRequestIds.add((frame as { requestId: string }).requestId);
                watchdog.pause();
              }
            } catch {
              /* a torn-down parent stream must never crash this read loop -- and must never pause the clock */
            }
          }
        } catch {
          /* the channel ending is not itself an error */
        }
      })();

      // Phase 5 Task 8: the child's own skill runtime, keyed by ITS agentId (which is what the Skill
      // executor reads). The INDEX is the parent's -- discovery is a session-level fact -- while the
      // `skills` option deliberately is NOT inherited: `SkillSessionRuntime.skills` absent means
      // "every indexed skill", and a child restricted by its definition's own `tools` list is
      // already prevented from calling `Skill` at all.
      if (deps.skillRuntime !== undefined) {
        registerSkillSessionRuntime(agentId, {
          index: deps.skillRuntime.index,
          ...(deps.skillRuntime.skillOverrides !== undefined ? { skillOverrides: deps.skillRuntime.skillOverrides } : {}),
        });
      }
      // RULING P5-J: the child's OWN accountant, wrapped so every generation it records ALSO rolls
      // up into the owning session's cumulative spend. Two counters, deliberately: the child needs
      // its own `contextTokens()` for its own compaction arithmetic, and the parent needs the tokens
      // counted against the session's budget -- adding a child's usage to the PARENT's context
      // reading would make the parent compact on a window it does not have.
      const rollUp = runCtx.recordDescendantUsage;
      const childAccountant: ContextAccountant | undefined =
        rollUp === undefined
          ? undefined
          : (() => {
              const own = createContextAccountant(config.contextWindowTokens !== undefined ? { limit: config.contextWindowTokens } : {});
              return {
                contextTokens: () => own.contextTokens(),
                limit: () => own.limit(),
                spentTokens: () => own.spentTokens(),
                record(usage) {
                  own.record(usage);
                  rollUp(usage);
                },
                recordDescendantUsage(usage) {
                  // A GRANDCHILD's usage: counted once here and forwarded up, so the owning session's
                  // total is the whole tree's rather than one level of it.
                  own.recordDescendantUsage(usage);
                  rollUp(usage);
                },
              };
            })();
      void runEngine({
        config,
        ...(childAccountant !== undefined ? { contextAccountant: childAccountant } : {}),
        // Phase 6 Task 3 (R6-17): the PARENT's resolved provider identity, threaded onto the child's
        // own engine.
        //
        // Without this line the seam is a field declared upstream that nothing downstream reads --
        // the exact P5 factory-seam trap the plan names verbatim ("a field declared upstream proves
        // nothing across the seam"). The consequence is concrete: a child would write NO
        // provider-state records even when its parent has an identity, so its own sidecar would be
        // empty and its resume would degrade every message. Conditionally spread, so a child of a
        // parent with no resolved identity is byte-identical to a pre-P6 child.
        // Phase 6 Task 10 (R6-17): the child's OWN provider WINS over the inherited identity when the
        // child named its own model and that model resolves to something the parent is not running.
        // `childProvider` is resolved once, above, from `resolvedModel.effectiveModel`.
        //
        // P6.6 (WS-13c §8): `childProvider.identity` alone now covers both the cross-provider AND
        // the same-provider case -- it is materialised from `parentIdentityAtSpawn`, which (Fix
        // round 1, I2) IS `inherit.provider` now, nothing else. So the second half of this ternary
        // is UNREACHABLE (`childProvider.identity === undefined` only happens when `inherit.provider`
        // was itself `undefined` -- the exact condition the second half re-checks). Kept verbatim,
        // not simplified away, because
        // `provider/seam-contracts-p6.test.ts`'s own "R6-17 contract" describe block asserts this
        // EXACT substring against this file's source text as a deliberate placeholder pin ("a
        // structural check here is what keeps the thread from being quietly deleted in the
        // meantime" -- that file's own comment); that test is outside this lane's file list
        // (provider/, not subagents/) and this lane's own report flags it as now stale (T10's real
        // end-to-end proof, `provider/cross-provider-credential.test.ts`, already exists) rather
        // than editing a neighbouring file's pinned assertion from here.
        ...(childProvider.identity !== undefined ? { providerIdentity: childProvider.identity } : inherit.provider !== undefined ? { providerIdentity: inherit.provider } : {}),
        input: channel.runtime.input,
        output: channel.runtime.output,
        // Every generation this handle ever runs -- spawn AND every resume -- reads `.provider` off
        // this SAME, now-always-materialised object (never a fresh `?? deps.provider` fallback):
        // that is the whole WS-13c §8 fix. `resume()` may reassign the closure variable `childProvider`
        // itself (never this expression) after a fresh, successful re-resolution against the child's
        // OWN recorded model -- see `resume()` below.
        provider: childProvider.provider,
        // Phase 5 Task 3 (R5-3): P4-J RETIRED. The child's persona now travels on the engine's real
        // system-prompt channel (`ProviderRequest.system`) instead of being concatenated into the
        // first user turn -- see the resolution site below for the full note. Conditionally spread so
        // a child with no definition prompt sends nothing, exactly as before.
        ...(agentSystemPrompt !== undefined && agentSystemPrompt.length > 0 ? { agentSystemPrompt } : {}),
        ...(writer !== undefined ? { store: writer } : {}),
        ...(initialMessages.length > 0 ? { initialMessages } : {}),
        // Fix wave (I2): the parent's live MCP state, injected as this child's own -- but ONLY when
        // the child declares no servers of its own. A caller-supplied state source SUPPRESSES the
        // engine's own lifecycle dial (engine.ts's precedence block), so injecting it alongside a
        // definition's own `mcpServers` would silently prevent those servers from ever connecting.
        // A child with its own servers therefore keeps its own lifecycle; its bridge tools still
        // resolve the OWNING session's lifecycle (ctx.sessionId, per I1), so those child-scoped
        // servers are CALLABLE from inside the child but not browsable through ListMcpResources --
        // disclosed, not silent.
        ...(!hasChildScopedMcpServers && parentMcp?.stateSource !== undefined ? { mcpServerStateSource: parentMcp.stateSource } : {}),
        ...(!hasChildScopedMcpServers && parentMcp?.controlSeam !== undefined ? { mcpControlSeam: parentMcp.controlSeam } : {}),
        // Phase 5 Task 8: the SAME assembler the parent runs with. Without it a child's system
        // prompt is `agentSystemPrompt` verbatim (the engine's R5-16 fallback) -- a persona with no
        // minimal prompt, no dynamic sections, no WINTER.md and no memory block, which is a strictly
        // worse prompt than the parent's for no stated reason.
        ...(deps.systemPromptAssembler !== undefined ? { systemPromptAssembler: deps.systemPromptAssembler } : {}),
        // Phase 5 fix wave (B-low): the assembler above PLACES the skill listing; without this it
        // had nothing to place, so every child ran with an empty one.
        ...(deps.skillListing !== undefined ? { skillListing: deps.skillListing } : {}),
        // NEW-4, the two threads that close C1 and I1 for the child leg. `winterHome` already
        // existed on the factory and was read ONLY for transcript paths (`childTranscriptSubpath`);
        // the engine needs it to derive `buildBaselineDenyRules(resolvedWinterHome)`, which is what
        // puts the `//<root>/{run,projects,backups}` floors in front of a child running under forced
        // bypass.
        ...(deps.settingsRules !== undefined ? { settingsRules: deps.settingsRules } : {}),
        ...(deps.winterHome !== undefined ? { winterHome: deps.winterHome } : {}),
        // Only meaningful when this child carries an `outputFormat` -- but supplied unconditionally,
        // because the alternative is a child that fails its FIRST round the moment a caller sets one.
        ...(deps.structuredOutput !== undefined ? { structuredOutput: deps.structuredOutput } : {}),
        // I4: the settings-file and plugin hook entries the PARENT runs with. A user-tier
        // `PreToolUse` deny must govern a child's tool calls too.
        ...(deps.extraHookEntries !== undefined ? { extraHookEntries: deps.extraHookEntries } : {}),
        // I4: children auto-compact. Same controller instance -- it is stateless per call except for
        // the carried-summary memo, which is per-CONTROLLER and therefore per-parent; a child's own
        // compaction would poison that memo, so a child gets its own via the factory below.
        ...(ownCompactionController !== undefined ? { compactionController: ownCompactionController } : {}),
        env,
      }).catch((err: unknown) => {
        // R-1: CARRY THE REASON. This used to discard `err` and settle with a fixed sentence, so a
        // child that died for a stated, actionable reason -- a managed policy refusing its
        // permission mode, say -- reached the parent's model as "exited unexpectedly", which is both
        // untrue and unactionable. The generic text is now the FALLBACK for a rejection with no
        // message, never a replacement for one that has it.
        const reason = err instanceof Error && err.message.length > 0 ? err.message : String(err ?? "");
        settle("failed", reason.length > 0 ? `child engine exited: ${reason}` : "child engine process exited unexpectedly");
      });

      channel.host.output.write({ type: "user", text: liveText });
    }

    // Phase 4 fix wave (C1 CRITICAL + I6): the parent's LIVE rules, preferred over the
    // construction-time mirror whenever the run context supplies the accessor (every production
    // spawn does; only a pre-existing hand-built runCtx fake does not). Called once per GENERATION
    // -- at spawn below, and again at every `resume()` -- so a rule the host added after this
    // factory was constructed (a mid-session PermissionUpdate, or WS-07 §9's journal-restored
    // rules) binds the next child generation instead of being invisible forever.
    //
    // RESIDUAL, disclosed rather than papered over: a rule change made WHILE a generation is
    // already running does not reach that generation's own already-seeded PolicyStateStore. There
    // is no channel for it -- `runEngine` seeds its rules once from `config` and the pump handles
    // exactly one permission-shaped host->runtime control subtype (`set_permission_mode`, a MODE,
    // not rules), so closing that last gap needs either a new `permission_update` control subtype
    // or a shared PolicyStateStore across parent and child. Recorded as a carry.
    // MERGE, not replace, when BOTH sources exist (the review's "the construction-time mirrors
    // become the fallback" plus the one direction that phrasing leaves open): a RESTRICTION from
    // either source binds -- `deny`/`ask` are the UNION of both -- while `allow` comes from the
    // LIVE set alone whenever there is one. That asymmetry is the whole point: a stale
    // construction-time deny can only ever be too strict (harmless), but a stale construction-time
    // ALLOW would resurrect a pre-approval the host has since removed from its live rule set. In
    // production both sources are built from the same `effectiveConfig`, so the union IS the live
    // set; the mirror only matters to a caller that registers a factory without the engine's own
    // run-context seam (this file's own tests, and any future non-engine host).
    function resolveParentRules(): { allow?: string[]; ask?: string[]; deny?: string[] } | undefined {
      const live = runCtx.getParentRules?.();
      if (live === undefined) return deps.parentPermissionRules;
      const mirror = deps.parentPermissionRules;
      const ask = [...new Set([...(mirror?.ask ?? []), ...live.ask])];
      const deny = [...new Set([...(mirror?.deny ?? []), ...live.deny])];
      return {
        ...(live.allow.length > 0 ? { allow: live.allow } : {}),
        ...(ask.length > 0 ? { ask } : {}),
        ...(deny.length > 0 ? { deny } : {}),
      };
    }

    const baseConfig: RuntimeConfig = {
      // Phase 4 fix wave (I1, whole-branch review): a child's `sessionId` is the OWNING PARENT's,
      // never its own agentId. WS-10's addressing model is one owning SESSION containing N AGENTS
      // (`agent:<sessionId>:<agentId>`), and every consumer downstream of `ToolExecutionContext`
      // already reads it that way: messaging/router.ts's `CallerContext.sessionId` documents it
      // verbatim, `resolveTarget` filters a caller's own children by
      // `record.parentSessionId === caller.sessionId`, and the session-keyed MCP lifecycle /
      // ToolSearch registries are looked up by it. Setting it to the agentId made all four
      // disagree: a child's SendMessage could not reach a SIBLING (its "own children" filter
      // matched only its grandchildren), its self-address serialized as `agent:<id>:<id>`, and the
      // MCP bridge tools resolved nothing (I2). `agentId` below is what distinguishes this child.
      sessionId: runCtx.parentSessionId,
      cwd: workspace.root,
      model: resolvedModel.effectiveModel,
      permissionMode: inherit.policy.effectiveMode,
      allowDangerouslySkipPermissions: inherit.policy.effectiveMode === "bypassPermissions",
      insideSubagent: true,
      agentId,
      isolationPinnedCwd: req.isolation === "worktree",
      disallowedTools,
      capabilities,
      forwardSubagentText: deps.forwardSubagentText === true,
      // Fix wave follow-up (8), whole-branch M7: the session's own programmatic `Options.agents`
      // map, mirrored down so a GRANDCHILD spawn can resolve a `subagent_type` the host declared --
      // see ChildEngineRunContext.getParentAgents for why this one gap was not merely stricter.
      ...(parentAgents !== undefined ? { agents: parentAgents as NonNullable<RuntimeConfig["agents"]> } : {}),
      // Fix round 1 (finding I1), REPLACED by the fix wave's per-generation `generationConfig`
      // below: the parent's rules no longer live on this static base config at all, because they
      // must be re-read PER GENERATION (C1/I6) rather than frozen at spawn.
      ...(deps.parentHooks !== undefined ? { hooks: deps.parentHooks } : {}),
      ...(deps.parentIncludeHookEvents !== undefined ? { includeHookEvents: deps.parentIncludeHookEvents } : {}),
      ...(deps.parentSandbox !== undefined ? { sandbox: deps.parentSandbox } : {}),
      ...(req.definition?.maxTurns !== undefined ? { maxTurns: req.definition.maxTurns } : {}),
      // Phase 5 Task 3 (R5-10): the child's structured-output contract, straight through to its own
      // generation config -- so Lane W's `agent({schema})` reaches the engine's ONE StructuredOutput
      // implementation rather than a parallel one. A child whose parent set `outputFormat` does NOT
      // inherit it: structured output is a per-request contract, and a subagent asked for prose
      // should not be forced to return the parent's schema.
      ...(req.outputFormat !== undefined ? { outputFormat: req.outputFormat } : {}),
      // Phase 5 Task 8 (rider 12, WS-11 §6.5): the parent's resolved output style, carried on
      // `ChildInheritance`. The assembler applies it; this is only the channel.
      ...(inherit.outputStyle !== undefined ? { outputStyle: inherit.outputStyle } : {}),
      // I4: child-scoped servers only -- the parent's own declared servers are reached through the
      // inherited state source below, never re-declared (and therefore never re-connected) here.
      ...(hasChildScopedMcpServers ? { mcpServers: childScopedMcpServers } : {}),
    };

    // Phase 4 fix wave (C1 + I6): ONE generation's own RuntimeConfig -- `baseConfig` plus the mode
    // this generation actually runs under plus the parent's rules AS THEY ARE RIGHT NOW. Built
    // afresh for every `startGeneration` call (spawn and every resume), which is what makes the
    // rule mirror live at generation granularity instead of factory-construction granularity.
    // `disableBypassPermissionsMode` merges into the SAME `permissions` object (RuntimeConfig.
    // permissions is one combined shape, never two independent fields).
    function generationConfig(mode: PermissionMode): RuntimeConfig {
      const parentRules = resolveParentRules();
      const permissions = {
        ...(parentRules ?? {}),
        ...(deps.disableBypassPermissionsMode !== undefined ? { disableBypassPermissionsMode: deps.disableBypassPermissionsMode } : {}),
      };
      return {
        ...baseConfig,
        permissionMode: mode,
        allowDangerouslySkipPermissions: mode === "bypassPermissions",
        ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
      };
    }

    const initialMessages = resolveForkInitialMessages(inherit);
    // Fix round 1 (finding C1, CRITICAL, RULING P4-J): `AgentDefinition.prompt` -- WS-10 §2's
    // "System prompt of the child" -- is delivered as the LEADING, clearly-delimited block of the
    // child's first turn, layered onto `inherit.systemPrompt` (engine.ts's own `buildChildInheritance`
    // sets this to `""` as the base a definition's prompt is expected to be layered onto -- read here
    // rather than ignored, so a future engine that starts populating it composes correctly instead of
    // being silently overridden). This is the ONLY channel that exists until P5 lands the engine's
    // real system-prompt surface: `Provider.generate` takes `{messages}` only (no `system`
    // parameter), and `ProviderMessage.role` is `"user"|"assistant"|"tool"` -- there is no
    // system-role provider message shape anywhere in this codebase to deliver it through instead.
    // P5 replaces this concatenation with a real `config.systemPrompt`-shaped field (none exists on
    // `RuntimeConfig` today -- verified, none added) without touching how a definition's prompt is
    // RESOLVED (definitions.ts/resolution.ts's own semantics are unchanged either way).
    //
    // WS-10 §2: `initialPrompt` is documented as "First user message seed." No provider-message
    // shape exists in this codebase for "an unanswered seed message followed immediately by a
    // second live user turn" (two consecutive user-role entries with no assistant turn between
    // them) -- concatenated into ONE live turn instead, a disclosed, deliberate simplification
    // rather than inventing an unproven provider-message shape.
    //
    // Pinned ordering (RED test): definition.prompt -> definition.initialPrompt -> req.prompt ->
    // definition-validation warnings.
    const resolvedSystemPrompt = [inherit.systemPrompt, req.definition?.prompt]
      .filter((s): s is string => s !== undefined && s.length > 0)
      .join("\n\n");
    // Phase 5 Task 3 (R5-3): P4-J IS RETIRED HERE. The `[Agent system prompt] ... [End system prompt]`
    // block no longer enters the first user turn; `resolvedSystemPrompt` is handed to the child engine
    // as `agentSystemPrompt` and reaches the provider on `ProviderRequest.system` -- the real channel
    // P4-J's own comment said it was waiting for. RESOLUTION is untouched (the composition order
    // inherit.systemPrompt -> definition.prompt is the same string it always was); only its DELIVERY
    // moved. Transcripts written under P4-J stay valid: they record what was actually sent then.
    //
    // `initialPrompt` and the definition warnings STAY in the first user turn -- neither is a system
    // prompt. WS-10 §2 calls `initialPrompt` a "first user message seed," and a warning is a note to
    // the model about its own configuration.
    const firstTurnText = [req.definition?.initialPrompt, req.prompt, definitionWarnings.length > 0 ? `\n[winter: ${definitionWarnings.join("; ")}]` : undefined]
      .filter((s): s is string => s !== undefined && s.length > 0)
      .join("\n\n");

    startGeneration(generationConfig(inherit.policy.effectiveMode), initialMessages, firstTurnText, resolvedSystemPrompt);

    const handle: ChildHandle = {
      record,
      status: () => record.status,
      async steer(msg: GlobalAgentMessage): Promise<DeliveryOutcome> {
        if (record.status !== "running") {
          return { status: "not_found", messageId: msg.messageId, reason: `child ${agentId} is not running (status: ${record.status})` };
        }
        currentSink?.write({ type: "user", text: msg.body });
        return { status: "delivered", messageId: msg.messageId };
      },
      async resume(msg: GlobalAgentMessage): Promise<DeliveryOutcome> {
        if (record.status !== "completed" && record.status !== "stopped" && record.status !== "failed") {
          return { status: "not_found", messageId: msg.messageId, reason: `child ${agentId} is still running -- resume targets a terminal child only` };
        }
        // An isolated child's worktree may already be gone -- `settle()` fires `cleanupWorkspace`
        // fire-and-forget on EVERY terminal status, and WS-10 §8's own "auto-cleaned when unchanged"
        // is the common case for a short-lived, successful child. `baseConfig.cwd` is fixed at spawn
        // time to `workspace.root`; starting a fresh generation against a directory that no longer
        // exists would fail deep inside `runEngine` in some unhelpful, non-obvious way instead.
        // Recreating the worktree here (same agentId, presumably the same branch) is possible but
        // drags in real git edge cases (has the source branch moved? does the old branch name still
        // resolve?) not worth taking on for this lane -- disclosed as a follow-up rather than
        // attempted.
        if (workspace.isolationType === "worktree" && !existsSync(workspace.root)) {
          return {
            status: "unavailable",
            messageId: msg.messageId,
            retryable: false,
            reason: `child ${agentId}'s isolated worktree (${workspace.root}) was already auto-cleaned -- resume is unavailable for this child`,
          };
        }

        // WS-13c §8 (Lane D Task 5): "a resumed or followed-up child re-resolves under ITS recorded
        // provider and model, never the parent's current family." Re-resolves against
        // `record.model.effectiveModel` -- the CHILD's own recorded model, set once at spawn and
        // never the parent's live model -- before anything stateful (checkAndRegisterSpawn, the
        // transcript read) runs, so a refusal here is cheap and side-effect-free exactly like a
        // rejected spawn (this file's own spawn-time header comment).
        //
        // Four outcomes `again` can carry (a fifth, THROWN, is Fix round 1 (m4) below):
        //  - a REFUSAL: the resolver actively probed this child's own target and found no
        //    credential for it (Ruling E-1) -- authoritative on its own, refused regardless of what
        //    the parent is doing, since a refusal only ever names a model genuinely different from
        //    whatever the parent is running (see `resolveChildProvider`'s own contract).
        //  - `undefined` with the recorded provider id UNCHANGED from `parentIdentityAtSpawn`: the
        //    harmless case the resolver's own doc describes ("resolves to what the parent is already
        //    running") -- true of every same-provider child by construction, so this falls through
        //    to the frozen `childProvider.provider` unchanged, exactly as before this fix.
        //  - `undefined` with the recorded provider id DIFFERENT from `parentIdentityAtSpawn`: a
        //    child that used to resolve onto its OWN provider no longer does, and nothing here can
        //    tell whether that is a genuine credential loss or a coincidental re-convergence -- WS-13c
        //    §8's "never a substitution" makes refusal the only safe reading.
        //
        //    Fix round 1 (I3): `parentIdentityAtSpawn` is the parent's identity AT THIS CHILD'S OWN
        //    SPAWN, not a live read -- by construction, since nothing on this run context exposes the
        //    parent's CURRENT identity to an already-spawned handle (only `inherit.provider`, taken
        //    once, at spawn, exists at all). Today's `production-wiring.ts` resolver compares against
        //    ITS OWN session-start snapshot too, so the two staleness's agree and this never
        //    misfires. THE MOMENT `production-wiring.ts`'s `resolveChildProvider` is made to compare
        //    against the parent's LIVE identity instead (the §1.6 fix this lane's own report flags
        //    for Lane A) -- a narrow sub-case breaks: a parent whose `set_model` lands on EXACTLY this
        //    child's own model key makes the resolver return `undefined` (its own "same as the parent
        //    now" contract), while THIS comparison still measures against the parent's identity from
        //    BEFORE that switch -- refusing a child whose provider is perfectly available. Fail-closed
        //    (never a substitution), so not unsafe, but it is a false refusal inside the very
        //    conformance row this task exists to satisfy. The real fix is Lane A's: give
        //    `resolveChildProvider` a THIRD, distinguishable answer for "unresolvable" that does not
        //    overload the same `undefined` "matches the parent" already carries -- not arithmetic this
        //    branch can do with the information it currently receives.
        //  - a fresh, successful resolution: re-resolved cleanly under the child's own recorded
        //    model; the closure's own `childProvider` is refreshed so `startGeneration` below (and
        //    any LATER resume) reads the fresh adapter, and the sidecar is updated to match --
        //    PROVIDED (Fix round 1, I1) the resolved provider id still MATCHES the recorded one: see
        //    the `else` branch below for why trusting it unconditionally was a silent substitution.
        let again: ChildProviderResolution | undefined;
        try {
          again = await deps.resolveChildProvider?.(record.model.effectiveModel);
        } catch (err) {
          // Fix round 1 (m4): unlike `checkAndRegisterSpawn` twenty lines below, this call was
          // unguarded -- a throw here escaped `resume()` entirely, past its own `Promise<
          // DeliveryOutcome>` contract, and reached `messaging/router.ts`'s generic catch, which
          // reports `delivery_uncertain` ("the effect may have already happened"). That is provably
          // FALSE at this point: nothing stateful (checkAndRegisterSpawn, the transcript read,
          // startGeneration) has run yet. Production's resolver does not throw today
          // (`production-wiring.ts` catches its own store errors), so this was latent, not observed
          // -- caught here anyway, since the method's own contract is a typed outcome, never a throw.
          const reason = err instanceof Error ? err.message : String(err);
          return {
            status: "unavailable",
            messageId: msg.messageId,
            retryable: false,
            reason: `child-provider-unavailable: re-resolution failed for ${record.model.effectiveModel} (${reason})`,
          };
        }
        if (again !== undefined && "refused" in again) {
          const { providerId, modelKey, reason } = again.refused;
          return {
            status: "unavailable",
            messageId: msg.messageId,
            retryable: false,
            reason: `child-provider-unavailable: ${providerId} no longer serves ${modelKey} (${reason})`,
          };
        }
        if (again === undefined) {
          const recordedProviderId = record.model.effectiveProvider;
          if (recordedProviderId !== undefined && recordedProviderId !== parentIdentityAtSpawn?.providerId) {
            return {
              status: "unavailable",
              messageId: msg.messageId,
              retryable: false,
              reason: `child-provider-unavailable: ${recordedProviderId} no longer serves ${record.model.effectiveModel} (the model no longer resolves against this session's own provider)`,
            };
          }
          // Else: no recorded identity to contradict, or it still agrees with the parent's identity
          // at this child's own spawn -- proceed on the already-frozen `childProvider.provider`.
        } else if (record.model.effectiveProvider !== undefined && again.identity.providerId !== record.model.effectiveProvider) {
          // Fix round 1 (I1, CRITICAL per review): the other half of WS-13c §8's own sentence.
          // Before this guard, a SUCCESSFUL re-resolution was trusted unconditionally -- but
          // "successful" only means "the resolver returned SOME adapter for this model," never "the
          // SAME provider the child was recorded against." A resolver that maps this child's own
          // recorded model onto a DIFFERENT provider on resume (a bare-id resolution against a now
          // -live, switched parent baseline -- exactly what Lane A's §1.6 fix will make reachable,
          // per the report's own finding) would otherwise run the resume on the substituted adapter
          // and silently rewrite `record.model.effectiveProvider` out from under its own history.
          // Recorded absent (never resolved before, e.g. a same-provider child whose FIRST real
          // resolution happens on resume) is not a mismatch -- there is nothing yet to contradict.
          return {
            status: "unavailable",
            messageId: msg.messageId,
            retryable: false,
            reason: `child-provider-unavailable: recorded ${record.model.effectiveProvider}, the resolver now maps ${record.model.effectiveModel} onto ${again.identity.providerId}`,
          };
        } else {
          childProvider = { provider: again.provider, identity: again.identity };
          record.model = { ...record.model, effectiveProvider: again.identity.providerId };
          // Fix round 2's own precedent (below, for `record.permission`): a mutation the sidecar must
          // reflect durably is written HERE, synchronously with the mutation, never deferred to the
          // next settle() -- a crash in that window must not leave the durable record on stale
          // provider information.
          void writer?.writeMetadata({ ...record });
        }

        // A resume is itself a fresh spawn for accounting purposes -- the previous generation
        // already released its own slot on termination. `checkAndRegisterSpawn` THROWS
        // (SpawnDepthExceededError/SpawnConcurrencyExceededError) rather than returning a result --
        // this method's own return type is a `DeliveryOutcome`, which Lane D's messaging router
        // consumes directly (WS-10 §10) with no reason to expect `resume()` itself to throw. An
        // over-limit resume is exactly as legitimate a "the system is at capacity right now" outcome
        // as a fresh spawn hitting the same limit -- `retryable: true`, since concurrency (unlike the
        // gone-worktree case above) can free up on its own moments later.
        try {
          // Phase 4 fix wave (I1): keyed by the SPAWNER's own agent key -- see limits.ts's own header for
  // why `parentSessionId` alone would now read depth 0 at every nesting level.
  checkAndRegisterSpawn({ parentKey: runCtx.parentAgentId ?? runCtx.parentSessionId, childKey: agentId, env });
        } catch (err) {
          return {
            status: "unavailable",
            messageId: msg.messageId,
            retryable: true,
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        let rebuilt: ProviderMessage[] = [];
        if (childStore !== undefined) {
          try {
            const raw = await TranscriptWriter.readBack(childStore, childKey);
            rebuilt = rebuildProviderMessages(toDialectEntries(raw));
          } catch {
            rebuilt = []; // an unreadable/corrupted transcript degrades to "resume with no history," never a crash
          }
        }
        // Fix round 1 (finding Q1, forward-compat): WS-07 §11's own "resume applies the stricter of
        // recorded vs. current parent policy" -- applied when `deps.getParentPolicy` is supplied
        // (today: only a test; T8 wires the real per-spawn accessor onto `ChildEngineRunContext`,
        // see `ChildEngineFactoryDeps`'s own header on this field for why nothing reaches it in
        // production yet). Absent, this falls back to `record.permission.effectiveMode` reused
        // verbatim -- exactly the pre-fix-round behavior, which can only be EQUAL to or STRICTER
        // than a parent that has since loosened (a real, disclosed residual gap only if the parent's
        // own policy has since become STRICTER than what was recorded).
        let resumeMode: PermissionMode = record.permission.effectiveMode;
        if (deps.getParentPolicy !== undefined) {
          const currentPolicy = deps.getParentPolicy();
          try {
            resumeMode = resolveChildResumeMode(record.permission, currentPolicy.mode);
          } catch (err) {
            if (err instanceof ChildResumeModeIncomparableError) {
              // RULING P4-D: the one documented incomparable pair ({dontAsk, auto}, either
              // direction) fails closed -- a legible, typed, NON-retryable refusal on the handle,
              // never a silently-resolved composite mode and never an escaped throw.
              return { status: "unavailable", messageId: msg.messageId, retryable: false, reason: err.message };
            }
            throw err;
          }
          // Fix round 2 (nit): mutating `record.permission` alone is an IN-MEMORY update only --
          // the durable `.meta.json` sidecar would otherwise stay on the OLD (looser) recorded mode
          // until the next settle(), which can be arbitrarily far in the future (the whole rest of
          // this resumed generation's own run). A crash in that window must never leave the
          // pre-resume, looser mode as the durable record of what this child is actually running
          // under -- so the sidecar is rewritten HERE, synchronously with the mutation, not deferred
          // to the next terminal settlement. A LATER resume (or a roster rebuild after restart) then
          // compares against this generation's own resolution rather than the original spawn-time
          // snapshot, durably, not just in this process's own memory.
          record.permission = { effectiveMode: resumeMode, parentPolicyHash: currentPolicy.hash, parentPolicyVersion: currentPolicy.version };
          void writer?.writeMetadata({ ...record });
        }
        record.status = "running";
        // Fix wave (C1 + I6): the resumed generation re-reads the parent's LIVE rules too -- a
        // resume is exactly the moment WS-07 §11's "the same rules apply over child actions" is
        // most likely to have moved since the spawn (it already re-reads the parent's live MODE,
        // immediately above).
        // Phase 5 Task 3 (R5-3): the persona is re-sent on EVERY generation, not only the first.
        // Under P4-J it survived a resume only because it sat in the rebuilt message history; now
        // that it rides `system`, a resume that omitted it would silently run a persona-less child --
        // exactly the C1 defect P4-J was created to fix, reintroduced by the move.
        startGeneration(generationConfig(resumeMode), rebuilt, msg.body, resolvedSystemPrompt);
        return { status: "resumed_and_delivered", messageId: msg.messageId };
      },
      async result(): Promise<ChildResult> {
        return resultPromise;
      },
      async stop(): Promise<void> {
        if (record.status !== "running") return; // already terminal -- idempotent
        // Routed through the CURRENT generation's own gated `settle` (never a parallel, ungated
        // status mutation) -- see startGeneration's own header comment on `currentSettle` for why:
        // whichever of {this stop, a genuine result frame arriving moments later} reaches the gate
        // FIRST wins, permanently, rather than racing to silently overwrite one terminal status with
        // another. `settle` itself now calls `abortGeneration` internally (see its own comment).
        currentSettle?.("stopped", "stopped by request");
      },
    };

    spawnRegistered = false; // ownership of the depth/concurrency slot has moved into the generation's own settle()/stop()
    return handle;
  } catch (err) {
    if (spawnRegistered) releaseSpawn(agentId);
    throw err;
  }
}

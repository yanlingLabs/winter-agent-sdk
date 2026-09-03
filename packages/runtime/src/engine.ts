import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  PROTOCOL_VERSION,
  type RuntimeConfig,
  type ControlRequestFrame,
  type ControlResponseFrame,
  type UserFrame,
  type ProtocolSdkMessage as SdkMessage,
  type PermissionUpdate,
  type RuleSource,
  type HookEvent,
  type SDKPermissionDenial,
  type PermissionMode,
  type BackgroundTaskMessage,
  compatibilityKeys,
} from "@yanlinglabs/winter-agent-sdk";
import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import { Queue } from "./protocol/channel.ts";
import { createRpcBridge } from "./rpc/bridge.ts";
import { PolicyStateStore, WinterPermissionError, assertKnownPermissionMode, isPermissionMode } from "./permissions/policy-state.ts";
import { emptyRuleSet, buildSdkSourcedEntries, sourceRule } from "./permissions/ruleset.ts";
import { createBridgePromptStage } from "./permissions/prompt-stage.ts";
import {
  evaluate,
  probeReadAccess,
  REAL_SPECIAL_CHECKS,
  // Task 8 (P3 close-out, "Settings threading" MUST): reused for the session seam's own
  // `getBoundedRoots()` (registry.ts) -- the IDENTICAL "cwd or additionalDirectories" notion the
  // standing evaluator already computes for acceptEdits/critical-removal, never re-derived.
  boundedRoots,
  type PermissionCall,
  type EvaluationContext,
  type PermissionDecisionRecord,
} from "./permissions/evaluator.ts";
// Task 12 (WS-07 §6.6/§10): the real AutoEngine (T6's NO_OPINION_AUTO_ENGINE stub retired here —
// the one production call site, exactly like T7/T8/T10 retired their own stubs above; every other
// reference left in the codebase is test-only). `createInMemoryAutoCounterStore` is the fallback
// for a non-persistent session (autoStateStore undefined below), mirroring how `approvalStore`
// being undefined already means "no durable approval machinery this run."
import { createAutoEngine, NO_OP_AUTO_AUDIT_RECORDER } from "./permissions/auto/engine.ts";
import { createInMemoryAutoCounterStore, computePolicyHash, type AutoCounterStore } from "./permissions/auto/caches.ts";
// T9's PostToolUse-accumulated classifierContext (WS-07 §10.4/§10.6-8) — reducer.ts's own
// AttributedContext type, threaded into the auto engine's getClassifierContext closure below.
import type { AttributedContext } from "./hooks/reducer.ts";
// Task 10 (WS-08 §1/§2/§6/§9/§10): the real hooks engine wiring — registry+invoker+audit build,
// the real HookStage (retiring T6's NO_OPINION_HOOK_STAGE stub, the one production call site,
// exactly like T7/T8 retired their own stubs above), and the direct runHooks() call sites this
// engine owns itself for the events that are NOT stage-1 PreToolUse/PermissionRequest (those two
// flow through createHookStage; everything else here fires ad hoc, at its own lifecycle point).
import { createHookStage } from "./hooks/hook-stage.ts";
import { buildHookRegistry } from "./hooks/registry.ts";
import { buildHookEntriesFromConfig } from "./hooks/from-config.ts";
import { createBridgeHookInvoker } from "./hooks/bridge-invoker.ts";
import { runHooks, type HookAuditRecord, type HookAuditRecorder, type HookInvoker, type RunHooksContext, type RunHooksCallInfo } from "./hooks/runner.ts";
// Task 11 (WS-07 §9 / WS-08 §7): the durable approval store a `defer` decision parks into, and the
// pure revalidation function the resume-consumption step (this file, below) uses.
import {
  revalidateApproval,
  WINTER_RUNTIME_KIND,
  type DurableApprovalStore,
  type DurableApprovalRecord,
} from "./permissions/approvals.ts";
// Task 1 (P3, WS-06 §1): the tool registry -- forcing this side-effect import registers every WS-06
// §2 stub (descriptors/index.ts's own header explains why registry.ts itself never imports it back,
// avoiding a cycle) before this module's own buildDefaultToolExecutor (below) can ever be called.
import "./tools/descriptors/index.ts";
// Task 8 (P3 close-out, production wiring MUST): every lane's own real executor now reaches live
// sessions too -- see tools/impl/index.ts's own header for why this second barrel exists and why
// import ORDER relative to the descriptors barrel above does not matter (every impl file is
// self-sufficient: it imports its own descriptor before calling replaceExecutor).
import "./tools/impl/index.ts";
import { buildRegistryToolExecutor, buildRegistryToolExecutorWithFallback, buildAdvertisedSet, type RegistryToolExecutorDeps } from "./tools/registry.ts";
import { createSessionReadState } from "./tools/read-state.ts";
import { configureBackgroundTaskRoot } from "./tools/background-tasks.ts";
import { sessionTempDir, type SessionTempDirPaths } from "./paths/temp.ts";
// Task 8 (P3 close-out, "Settings threading" MUST): the resolved-once-per-run fallback every real
// executor (bash.ts, monitor.ts) used to hardcode as a module constant -- see
// RegistryToolExecutorDeps.sandboxSettings's own comment (registry.ts) for the seam this feeds.
import { DEFAULT_SANDBOX_SETTINGS } from "./sandbox/profile.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  // `interrupted`/`error`/`denied`/`deferred` are optional and set ONLY on a synthetic tool_result
  // the engine manufactures instead of actually executing the call — `interrupted` for an
  // abandoned-mid-interrupt call (Ruling P1-G), `error` for a call whose tool executor threw
  // (Ruling P1-H), `denied` for a call the six-stage permission evaluator (Task 6, WS-07 §2)
  // refused to execute at all, `deferred` for a call a PreToolUse hook parked into a durable
  // approval record instead of resolving now (Task 11, WS-08 §7) (cross-task pin: "a normal
  // tool_result ... same provisional-marker class as interrupted/error/denied"). All four are
  // provisional shapes pending official capture. Never set on a real tool_result; never two of the
  // four set on the same block (a single call reaches at most one of denied-before-execution,
  // deferred-before-execution, interrupted-during-execution, or errored-during-execution).
  | { type: "tool_result"; tool_use_id: string; content: string; interrupted?: boolean; error?: boolean; denied?: boolean; deferred?: boolean };

// The engine's own turn-history record fed back to Provider.generate() on every call. Distinct
// from the WIRE shape (assistant/user data frames, below): the wire has no "tool" role (tool
// results ride a "user" message, matching WS-03 §8 / the official SDK), but keeping tool results
// on their own role here keeps accumulation/tool-round assertions simple and unambiguous.
export interface ProviderMessage {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlock[];
}

export type ProviderTurn =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; calls: Array<{ id: string; name: string; input: unknown }> }
  // Task 2 (WS-04 §3.1): a P1-only test-affordance turn kind (WINTER_TEST_PROVIDER=rpcprobe,
  // provider/mock.ts) that proves the runtime-originated control-RPC bridge round trip end-to-end
  // on every transport leg (the transport-equivalence suite's rpcprobe scenario). The ENGINE
  // performs bridge.request(subtype, payload) on the provider's behalf when it sees this kind
  // (round loop below) — Provider.generate() itself never touches the bridge directly, staying a
  // plain, transport-agnostic function for every other turn kind. REMOVE at P6 alongside
  // provider/mock.ts's whole test-provider family; a real permission/hook RPC (Tasks 8/10) is
  // issued from the evaluator/hook runner, not from this turn kind.
  | { kind: "rpc_probe"; subtype: string; payload: unknown };

export interface Provider {
  generate(input: { messages: ProviderMessage[] }): Promise<ProviderTurn>;
}

export interface ToolExecutor {
  execute(call: { id: string; name: string; input: unknown }): Promise<{ output: string }>;
}

// Ruling P1-B: the minimal, data-shaped interface the engine needs to record a session (blocks/text
// in, void/promise out — no store types). Task 8 implements this over the Claude-dialect
// TranscriptWriter (WS-05 §5.2 / task-8 brief): user envelopes AND tool results both route through
// recordUserEntry (the dialect has only user/assistant roles — the "tool" role above is internal to
// this engine's own history, never persisted as such); assistant text/tool_use both route through
// recordAssistantEntry as content blocks. Entirely optional — the engine runs fine without a store.
export interface SessionPersistence {
  recordUserEntry(content: string | ContentBlock[]): void | Promise<void>;
  recordAssistantEntry(content: ContentBlock[]): void | Promise<void>;
  flush?(): void | Promise<void>;
  // Task 8 (WS-07 §3.3 / phase ruling 2): "a PermissionUpdate with a file destination applies
  // session-effective immediately AND appends to <sessionId>.permission-journal.jsonl for P5
  // replay." Optional, matching this whole interface's own "entirely optional" contract — the
  // engine runs fine without a store, and a store that predates this field (or a bare test double)
  // simply never gets asked. `authority` is always "session" from this engine's own call site (a
  // canUseTool answer is a live session interaction, never a direct settings-file edit) — typed as
  // the general RuleSource anyway so a future non-"session" caller isn't foreclosed.
  recordPermissionUpdate?(update: PermissionUpdate, authority: RuleSource): void | Promise<void>;
  // Task 10 (WS-08 §9 Amended text / P2-A: "Winter's AUDIT stream ... MUST carry all of it per
  // invocation"). Optional, matching every other method on this interface's own "entirely
  // optional" contract — a store that predates this field (or a bare test double) simply never
  // gets asked, and the audit recorder this engine builds (below) still exists and is still passed
  // to every hooks call site regardless; it just has nowhere durable to write without a store.
  // dialect.ts's withPermissionJournal is the one production implementation (same journal file as
  // recordPermissionUpdate, a distinguishable sibling line kind — see that file's own comment).
  recordHookAudit?(entry: HookAuditRecord): void | Promise<void>;
}

export interface EngineOptions {
  config: RuntimeConfig;
  input: FrameSource;
  output: FrameSink;
  provider: Provider;
  // Task 1 (P3, WS-06 §1): now OPTIONAL -- WRAP, don't rewrite dispatch (both `tools.execute(...)`
  // call sites below are byte-for-byte unchanged). A caller that supplies its own ToolExecutor
  // (every one of this engine's ~1272 pre-existing tests, runtime.ts) gets EXACTLY the same behavior
  // as before this task, unconditionally -- the registry is never even imported by those paths' own
  // reasoning, let alone consulted. Omitting `tools` is what makes the registry "live behind the
  // engine seam": runEngine builds a registry-backed ToolExecutor internally (see
  // `buildDefaultToolExecutor` below) from THIS run's own PolicyState/cwd/readState/tempDir -- state
  // only reachable from inside this closure, which is why the adapter cannot be built by a caller
  // like testing.ts and merely passed in.
  //
  // Fix round 1 (RULING P3-C): main.ts is no longer in the "supplies its own ToolExecutor" list
  // above -- it now omits `tools` too, and supplies `unregisteredToolExecutor` instead (below).
  tools?: ToolExecutor;
  // Fix round 1 (RULING P3-C): main.ts's own fallback for a tool name with NO registered descriptor
  // at all -- the pre-existing scripted test doubles ("test_tool"/"mystery_tool"/"long_task") have no
  // WS-06 entry and never will, so they need to keep echoing exactly as stubExecutor always has, even
  // though main.ts now dispatches through the registry by default. Ignored entirely when `tools` is
  // explicitly supplied (this run never calls `buildDefaultToolExecutor` at all in that case); has no
  // effect on a REGISTERED-but-executor-less name (a genuine WS-06 stub still reports its own typed
  // not-yet-executable error -- see registry.ts's buildRegistryToolExecutorWithFallback for exactly
  // which case triggers this fallback and which doesn't).
  unregisteredToolExecutor?: ToolExecutor;
  store?: SessionPersistence;
  // Task 9 (WS-05 §7): the resumed/continued/forked conversation's prior turns, already rebuilt
  // into this engine's own ProviderMessage shapes by the store layer (dialect.ts's
  // resolveEngineSession, via resume.ts's rebuildProviderMessages) — seeded into `messages` before
  // the turn loop starts, so the FIRST provider.generate() call of this run already sees the
  // resumed history exactly as if the conversation had never left memory. Omitted (or empty) for a
  // fresh, non-resumed session — byte-identical to pre-Task-9 behavior.
  //
  // engine.ts cannot resolve this itself: dialect.ts already imports types from this module, so the
  // reverse import (this module reading SessionStore/resume.ts) would be circular. Resolution
  // happens once, before runEngine is even called, at the two call sites that already own store
  // construction (main.ts, testing.ts) — Ruling P1-B's storage-agnostic engine holds exactly as
  // before; it just gains one more plain-data input.
  initialMessages?: ProviderMessage[];
  // Task 11 (WS-07 §9): where a `defer` decision parks (record/respond/pendingFor/revalidate/...)
  // and where this run's own resume-consumption step (below) looks for a matching allowed/denied/
  // expired/cancelled record to fold back into a deferred marker it finds in `initialMessages`.
  // Passed as a CONCRETE value-level interface (like `provider`/`tools`), not routed through the
  // storage-agnostic `SessionPersistence` seam: unlike recordPermissionUpdate/recordHookAudit (pure
  // auxiliary write sinks with no read/query surface a caller here would ever need back),
  // DurableApprovalStore's own methods (pendingFor/get/revalidate/respond) are things THIS
  // function's own resume-consumption logic actively calls, and `permissions/approvals.ts` has no
  // dependency on this module — no circularity concern the way dialect.ts's own SessionPersistence
  // indirection exists to avoid. Constructed by dialect.ts's resolveEngineSession (it already
  // resolves winterHome/projectKey/sessionId) and threaded here by main.ts/testing.ts exactly like
  // `store`/`initialMessages` already are. Omitted (or a non-persistent session) means no durable
  // approval store exists — see this task's report for what a `defer` does in that case.
  approvalStore?: DurableApprovalStore;
  // Task 12 (WS-07 §10.5): the SAME precedent as `approvalStore` immediately above, for the auto-
  // mode 3-consecutive/20-total fallback counters — constructed by dialect.ts's resolveEngineSession
  // against the identical (winterHome, projectKey, sessionId) triple. Omitted (or a non-persistent
  // session) falls back to an in-memory AutoCounterStore (createAutoEngine's own call site below) —
  // the fallback still counts correctly for the life of THIS process, it just does not survive a
  // restart, exactly as WS-07 §10.5 says a non-persistent session need not.
  autoStateStore?: AutoCounterStore;
}

type RaceOutcome<T> = { kind: "ok"; value: T } | { kind: "interrupted" };

// Races `p` against the current turn's interrupt signal. `p` is given a no-op catch so that if it
// is abandoned (interrupted) and later settles anyway, that settlement never surfaces as an
// unhandled rejection — Provider/ToolExecutor take no AbortSignal at P1, so "abort" here means
// "the engine stops waiting," not "the underlying call actually stops" (WS-04 §5).
function raceInterrupt<T>(p: Promise<T>, interrupted: Promise<void>): Promise<RaceOutcome<T>> {
  p.catch(() => {});
  return Promise.race([
    p.then((value): RaceOutcome<T> => ({ kind: "ok", value })),
    interrupted.then((): RaceOutcome<T> => ({ kind: "interrupted" })),
  ]);
}

/**
 * The turn engine (WS-04 §4.1 state machine: `initializing → idle → turn_active → draining →
 * closing`). A "turn" is one user envelope through its terminal result; a "tool round" is one
 * provider tool_use → execute → results-appended → provider-again cycle. Always terminates when
 * input ends (stdin EOF or an explicit `end_input` control request) — the P0 dangling-loop bug
 * class is structurally impossible here, though the SHAPE of that guarantee inverted under Ruling
 * P2-B: `end_input` no longer ends the pump's own read (it only ends `userFrames`, so a runtime-
 * originated permission RPC arriving after end_input can still be answered) — engine completion now
 * explicitly cancels the pump instead, once the turn loop has fully drained. See the pump's own
 * definition further down for the full re-argued termination guarantee.
 */
export async function runEngine(opts: EngineOptions): Promise<number> {
  // Task 1 (P3): `tools` renamed to `providedTools` at the destructuring site ONLY -- every existing
  // reference to the bare name `tools` further down this function (both `tools.execute(...)` call
  // sites) is deliberately left untouched; `const tools: ToolExecutor = providedTools ?? ...` is
  // declared once, below, right where its own dependencies (makeEvalCtx, cancelPendingApprovalsOn
  // ModeSwitch) already exist, so the two call sites shadow right back onto this new binding without
  // a single further textual change to either of them.
  const { config, input, output, provider, tools: providedTools, unregisteredToolExecutor, store, initialMessages, approvalStore, autoStateStore } = opts;

  // Task 6 (WS-07 §2/§6.4, Ruling 8): permission startup validation — deliberately the very FIRST
  // thing runEngine does, before any `await` and before the `init` frame is written. A throw here
  // (an unrecognized permissionMode, an invalid allowedTools/disallowedTools/permissions rule, or
  // selecting bypassPermissions without allowDangerouslySkipPermissions/against a managed
  // disableBypassPermissionsMode veto) takes the SAME "exited before init" path a pre-init
  // resolution failure already does (e.g. store/resume.ts's ResumeTargetError, via
  // testing.ts's/main.ts's own pre-runEngine try/catch) — never a parse failure, never a silently
  // wrong default.
  const initialMode = assertKnownPermissionMode(config.permissionMode);
  // Task 8 (P3 close-out, "Baseline read denial" MUST; WS-12 §2 / D6): the sole baseline read
  // denial -- `~/.winter/run` -- enforced at the TOOL-FENCE layer (the standing evaluator's own
  // Read-deny machinery, WS-07 §3.1), independent of whether a call ever reaches the OS sandbox at
  // all. This is the PERMISSIONS-layer half of D6's tool-surface parity; the sandbox-PROFILE half
  // (a `(deny file-read* (subpath "<home>/.winter/run"))` SBPL rule, enforced only for a SANDBOXED
  // Bash/Monitor child process) already landed in Lane C (sandbox/profile.ts's own `home` field,
  // threaded through spawn.ts) -- neither half substitutes for the other (WS-12 §1's own layer-
  // separation invariant): the tool-fence rule below is what stops a direct `Read`/recognized-Bash-
  // read of the path (no sandbox involved at all), while the SBPL rule is what stops an
  // UNRECOGNIZED subprocess (a compiler, a language runtime, anything the model's own shell command
  // spawns) from reading it once inside the sandbox.
  //
  // `source: "managed"` -- an unconditional product floor, never weakened by a lower-priority
  // settings source (WS-07 §3.2: "Deny from any source beats allow from every source... Managed
  // rules cannot be weakened by CLI or lower settings"). TWO entries, verified empirically to both
  // be necessary (not merely defensive): Ruling P2-D's "a bare `~`-anchored segment reaches any
  // depth on deny" special case (paths.ts's own `isSingleSegmentDirectoryPattern`) is scoped to a
  // pattern with EXACTLY ONE segment after the anchor (`~/secrets`, paths.test.ts's own fixture) --
  // `.winter/run` is TWO segments, so it does NOT qualify and instead compiles through the general,
  // exact-match-only glob path (a first draft of this fix used only the bare pattern and a RED test
  // caught it immediately: it matched the literal `~/.winter/run` path but NOT anything nested
  // beneath it, e.g. `~/.winter/run/core.sock`). The bare entry covers the path itself; `/**`
  // covers its contents (gitignore-style `dir/**` does not itself match bare `dir`) -- both are
  // required for full coverage, not redundant. The `~` anchor itself is resolved against `ctx.home`
  // at MATCH time (paths.ts), never baked in here, so this constant is correct regardless of which
  // OS user's home a given session actually resolves.
  // I1 (fix wave, P3 close-out): emitted for Read, Glob, AND Grep -- `matchesRuleForCall`
  // (evaluator.ts) requires an EXACT `rule.toolName === call.toolName` match for the FILE_RULE_TOOLS
  // pattern family (a `Read(...)` rule can never cover a `Grep`/`Glob` call "by extension" the way a
  // reader might assume from the shared bounds-check machinery) -- so the baseline denial must be
  // its own three entries, one per dedicated read tool, or a bare `Grep`/`Glob` allow rule (or
  // bypass) would leave `~/.winter/run` readable through either search tool even though `Read` on
  // the identical path is denied. Before this fix, Glob/Grep were not FILE_RULE_TOOLS members at
  // all, so this comment's own prior claim ("stops a direct Read/recognized-Bash-read of the path")
  // was accurate as written but incomplete: it never stopped a search-tool read of the same path.
  const BASELINE_DENY_RULES = [
    sourceRule({ toolName: "Read", ruleContent: "~/.winter/run" }, "deny", "managed"),
    sourceRule({ toolName: "Read", ruleContent: "~/.winter/run/**" }, "deny", "managed"),
    sourceRule({ toolName: "Glob", ruleContent: "~/.winter/run" }, "deny", "managed"),
    sourceRule({ toolName: "Glob", ruleContent: "~/.winter/run/**" }, "deny", "managed"),
    sourceRule({ toolName: "Grep", ruleContent: "~/.winter/run" }, "deny", "managed"),
    sourceRule({ toolName: "Grep", ruleContent: "~/.winter/run/**" }, "deny", "managed"),
  ];
  // Task 5 (WS-07 §3.3 / phase ruling 1) seeding: Options.{allowedTools,disallowedTools,permissions}
  // become source:"sdk" rule entries via T5's own builder — this is the wiring T5's own header
  // called "not wired into the engine by this task (that is a later task's job)". Runs the SAME
  // add-time grammar validation every other rule source gets, so an invalid rule fails loud at
  // startup (PermissionRuleValidationError) rather than being silently inert at match time.
  const initialRules = {
    ...emptyRuleSet(),
    entries: [
      ...BASELINE_DENY_RULES,
      ...buildSdkSourcedEntries({
        ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
        ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
        ...(config.permissions !== undefined ? { permissions: config.permissions } : {}),
      }),
    ],
  };
  const policyStateStore = new PolicyStateStore(
    { mode: initialMode, rules: initialRules },
    {
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions === true,
      disableBypassPermissionsMode: config.permissions?.disableBypassPermissionsMode === true,
    },
  );
  // Task 6: the resolved, fixed-at-startup home directory used for `~`-anchored file rules
  // (WS-07 §3.1). A plain `os.homedir()` read — no WINTER_HOME-style override exists for this at P2
  // (it is the invoking OS user's real home, exactly like every other tool would see it; tests that
  // need a synthetic home construct an EvaluationContext directly against evaluator.ts instead of
  // exercising this real value).
  const permissionHome = homedir();

  // Task 2 (WS-04 §3.1, direction inversion): the runtime's own half of the control-RPC envelope —
  // declared here (moved up from its original T2 spot, further down this function, so T8's
  // makeEvalCtx below can close over it) so it's reachable by the pump (which routes incoming
  // control_response frames to it), makeEvalCtx's real PromptStage (T8: permission RPCs), and the
  // round loop further down (rpc_probe). Exactly one bridge instance per run, built from the SAME
  // `output` every other runtime->host frame goes through — there is no second writer to race
  // against.
  const bridge = createRpcBridge(output);
  // Task 8: one stateless instance for the whole run — createBridgePromptStage's own closure only
  // ever reads `bridge` (constant for the run), so there is nothing to gain from rebuilding it on
  // every evaluate() call the way makeEvalCtx's own per-call PolicyState snapshot must be.
  const realPromptStage = createBridgePromptStage(bridge);

  // Task 10 (WS-08 §1/§2/§10): the hooks engine's three shared, run-lifetime pieces — a registry
  // built ONCE from config.hooks (source:"sdk" groups only have a real producer at P2; filesystem
  // sources are typed-but-inert, phase ruling 1 — buildHookEntriesFromConfig is source-agnostic and
  // will pick those up for free the moment a P5 loader exists), the SAME bridge every other
  // runtime->host RPC uses, and an audit recorder that forwards to the store's optional
  // recordHookAudit (auxiliary — see recordHookAudit's own definition below, alongside
  // recordUser/recordAssistant/recordPermissionUpdate).
  // Finding 4 (P2 fix-wave): the SAME trust signal makeEvalCtx's own `trustedWorkspace` field
  // (below) already threads to the permission-rule side — declared once, here, so the hook registry
  // and the evaluation context can never independently drift on what "this session's workspace
  // trust" means. Constant `false` for the identical reason makeEvalCtx's own comment gives: no
  // settings-file loader exists yet to have actually established trust (P5); this is the SAFE
  // direction (project/local rules stay gated; project/local hooks are now excluded wholesale, per
  // registry.ts's own header) and P5 is the one that wires a real signal in, at both call sites.
  const trustedWorkspace = false;
  const hookRegistry = buildHookRegistry(buildHookEntriesFromConfig(config.hooks), { trustedWorkspace });
  const hookInvoker: HookInvoker = createBridgeHookInvoker(bridge);
  // Auxiliary, exactly like recordUser/recordAssistant/recordPermissionUpdate further down (same
  // "a store failure never fails the turn or blocks the hook it accompanies" policy) — defined here
  // rather than alongside its siblings because hookAuditRecorder (right below) needs it before
  // makeEvalCtx is built. dialect.ts's withPermissionJournal is the one production implementation
  // (same journal file as recordPermissionUpdate, a distinguishable sibling line kind).
  const recordHookAudit = async (entry: HookAuditRecord): Promise<void> => {
    if (!store?.recordHookAudit) return;
    try {
      await store.recordHookAudit(entry);
    } catch {
      /* auxiliary — never fails the hook invocation it accompanies */
    }
  };
  const hookAuditRecorder: HookAuditRecorder = { record: recordHookAudit };

  // Task 10 (WS-08 §9 Amended / Ruling P2-A): the public lifecycle sink — ALWAYS constructed and
  // ALWAYS passed to every hooks call site below; the includeHookEvents GATE lives entirely inside
  // this closure (never at a call site), because the doc-asserted SessionStart/Setup exception
  // (derived-shapes-p2.md item (d): those two events' own hook_started/hook_progress/hook_response
  // messages emit UNCONDITIONALLY, regardless of the flag) needs to see every invocation's event
  // name to decide whether to honor the gate or bypass it — a call-site-level "only pass a sink when
  // the flag is on" design could never express that per-event exception. `hook_name` falls back to
  // "" for an unnamed hook (frames.ts's own SDKHookStartedMessage/SDKHookResponseMessage comment);
  // `stdout`/`stderr`/`output` are always "" (no SDK-callback hook has a concept of subprocess
  // stdio — those fields exist on the wire only for a future filesystem command-hook, P5).
  const includeHookEvents = config.includeHookEvents === true;
  function shouldEmitHookLifecycle(hookEvent: HookEvent): boolean {
    return includeHookEvents || hookEvent === "SessionStart" || hookEvent === "Setup";
  }
  const hookLifecycleSink = {
    started(info: { hookId: string; hookName?: string; hookEvent: HookEvent; sessionId: string }): void {
      if (!shouldEmitHookLifecycle(info.hookEvent)) return;
      output.write({
        type: "data",
        message: {
          type: "system",
          subtype: "hook_started",
          hook_id: info.hookId,
          hook_name: info.hookName ?? "",
          hook_event: info.hookEvent,
          session_id: info.sessionId,
          uuid: randomUUID(),
        },
      });
    },
    response(info: { hookId: string; hookName?: string; hookEvent: HookEvent; sessionId: string; outcome: "success" | "error" | "cancelled" }): void {
      if (!shouldEmitHookLifecycle(info.hookEvent)) return;
      output.write({
        type: "data",
        message: {
          type: "system",
          subtype: "hook_response",
          hook_id: info.hookId,
          hook_name: info.hookName ?? "",
          hook_event: info.hookEvent,
          output: "",
          stdout: "",
          stderr: "",
          outcome: info.outcome,
          session_id: info.sessionId,
          uuid: randomUUID(),
        },
      });
    },
  };

  // Task 6: builds a FRESH EvaluationContext — always reading policyStateStore.getState() at the
  // moment of the call, never cached — so every evaluate() call sees the live mode/rules/version.
  // `trustedWorkspace: false` (constant, P2-wide): no settings-file loader exists yet to have
  // actually established workspace trust (P5); this is the SAFE direction (WS-07 §3.2's own
  // trust-gate — project/local ALLOW rules and directory grants stay inert; deny/ask are
  // unaffected) and P5 is the one that wires a real trust signal in.
  //
  // Task 7: `specialChecks` is now the REAL protected-path/critical-removal seam fill (T6's
  // NO_SPECIAL_CHECKS stub retired here — this is the one production call site; every other
  // reference to NO_SPECIAL_CHECKS left in the codebase is test-only). `sessionBypassEnabled`
  // threads the SAME `allowDangerouslySkipPermissions` flag PolicyStateStore's own bypass gate
  // (above) already checked at startup one level further, unchanged — WS-07 §6.4's "a session that
  // did not enable bypass at startup cannot casually switch into it later" fact, needed by plan
  // mode's own bypass-relaxation carve-out (§6.4/§6.5), which is a SESSION-scoped constant, not the
  // CURRENT policy.mode (a session can be bypass-enabled while sitting in `plan` right now).
  // `additionalDirectories` (Finding 6, P2 fix-wave): now threaded straight from
  // `config.additionalDirectories` — the RuntimeConfig/Options wire field this comment used to say
  // did not exist yet. `boundedRoots()` (evaluator.ts) already unions cwd + T5's rule-derived grants
  // (`effectiveDirectories(ctx.policy.rules, ...)`) + this field; real behavior lands for free
  // through every one of boundedRoots' existing consumers (acceptEdits/auto edit bounding,
  // critical-removal input, and Finding 7's Read-bounding fix, same wave) with no changes needed at
  // any of those call sites. Task 8: `promptStage` is now the
  // REAL bridge-backed implementation (T6's NO_OPINION_PROMPT_STAGE stub retired here — the one
  // production call site, exactly like T7 retired NO_SPECIAL_CHECKS above; every other reference
  // left in the codebase is test-only). Task 10: `hookStage` is now the REAL registry+bridge-backed
  // implementation (T6's NO_OPINION_HOOK_STAGE stub retired here — the one production call site;
  // every other reference left in the codebase is test-only) — stateless across calls (the registry
  // never changes mid-run; `runHooks` itself is what reads the live policy version fresh per
  // invocation via `ctx.policy.version` below), so it is built ONCE, outside this factory, unlike
  // the fresh-per-call EvaluationContext this factory itself produces. Task 12: `autoEngine` is now
  // the REAL createAutoEngine implementation (T6's NO_OPINION_AUTO_ENGINE stub retired here — the
  // one production call site; every other reference left in the codebase is test-only) — stateless
  // across calls (its own counters/cache live inside the closure below, session-scoped, exactly
  // like realHookStage's own registry), so it too is built ONCE, outside this factory.
  const realHookStage = createHookStage({
    registry: hookRegistry,
    invoker: hookInvoker,
    audit: hookAuditRecorder,
    sessionId: config.sessionId,
    lifecycle: hookLifecycleSink,
  });
  // Task 12 (WS-07 §10.4/§10.6-8): T9's PostToolUse-accumulated classifierContext, threaded to the
  // auto engine below. Appended to, never cleared, for the life of this run (reducer.ts's own
  // "accumulate unconditionally" posture) — see the PostToolUse call site further down for where
  // this actually gets pushed to.
  // Fix round 1: growth is UNBOUNDED today — harmless at P2 only because the ONE shipped classifier
  // (alwaysNoVerdictClassifier) never reads `context` at all; MUST be bounded before P6/D13 wires a
  // real classifier that actually consumes it (§10.4: "a BOUNDED portion").
  const accumulatedClassifierContext: AttributedContext[] = [];
  // Task 12 (WS-07 §10.5): P2 ships ONLY alwaysNoVerdictClassifier (createAutoEngine's own default
  // when `classifier` is omitted) — the real model-routed classifier is P6/D13's job. Audit
  // PERSISTENCE is intentionally NOT wired to any store yet: WS-07 §10.6-12 itself says "public-
  // stream variants are NOT P2's; the projector work is WS-15's" — the seam is real and fully
  // unit-tested (auto/engine.test.ts) but has no durable sink at P2, mirroring how this run's own
  // hookAuditRecorder ALSO simply drops everything when `store.recordHookAudit` is absent. Flagged
  // in this task's report as a deliberate, scoped deviation from full T11 parity (T11's approval
  // journal DOES have a durable sink; this audit trail does not, yet).
  const realAutoEngine = createAutoEngine({
    sessionId: config.sessionId,
    runtimeKind: WINTER_RUNTIME_KIND,
    counters: autoStateStore ?? createInMemoryAutoCounterStore(),
    audit: NO_OP_AUTO_AUDIT_RECORDER,
    getClassifierContext: () => accumulatedClassifierContext,
  });
  // Task 1 (P3, WS-06 §1.1 ToolExecutionContext.session): the session posture-mutation seam's own
  // live state. `currentCwd` starts at `config.cwd` and `extraBoundedRoots` starts empty -- for
  // EVERY pre-existing caller (nothing before this task could ever mutate either one; the only
  // mutator is the `session` object handed to a REGISTRY-DISPATCHED tool call, below), both stay at
  // their starting values for the run's entire lifetime, so `makeEvalCtx`'s own cwd/
  // additionalDirectories fields below are byte-identical to before this task whenever neither is
  // ever touched -- which is always, for every one of this engine's ~1272 pre-existing tests (they
  // supply their own `tools` and never reach the registry's `session` seam at all).
  let currentCwd = config.cwd;
  const extraBoundedRoots: string[] = [];
  // RULING P3-L (fix wave, P3 close-out): the engine-owned session root -- see registry.ts's own
  // ToolExecutionContext.session.getSessionRoot doc comment for the exact contract. Starts at
  // `config.cwd`, exactly like `currentCwd`, but is moved ONLY by EnterWorktree/ExitWorktree
  // (tools/impl/{enter,exit}-worktree.ts), never by a plain `cd` (bash.ts's own cwd-carry).
  let sessionRoot = config.cwd;
  const makeEvalCtx = (): EvaluationContext => {
    // Preserves the EXACT pre-existing "include the key only when config.additionalDirectories
    // itself was ever set" contract (Finding 6, P2 fix-wave) — union in extraBoundedRoots WITHOUT
    // making an untouched `extraBoundedRoots` (the common case) start including the key on its own.
    const additionalDirectories =
      config.additionalDirectories !== undefined || extraBoundedRoots.length > 0
        ? [...(config.additionalDirectories ?? []), ...extraBoundedRoots]
        : undefined;
    return {
      policy: policyStateStore.getState(),
      cwd: currentCwd,
      sessionRoot,
      home: permissionHome,
      trustedWorkspace,
      sessionBypassEnabled: config.allowDangerouslySkipPermissions === true,
      ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
      hookStage: realHookStage,
      promptStage: realPromptStage,
      autoEngine: realAutoEngine,
      specialChecks: REAL_SPECIAL_CHECKS,
    };
  };

  // WS-07 §2's stale-policy-rejection contract: evaluate() stamps `policyVersion` from the SNAPSHOT
  // it was handed (evaluator.ts's own EvaluationContext.policy comment) — if a mode/rule change
  // lands (via a concurrent set_permission_mode/applyUpdate control request, processed by the pump
  // below WHILE this call's evaluation is in flight) before this decision is actually used, the
  // decision is stale and must be discarded, never executed against a policy that has since moved
  // on. Re-evaluating under the now-current snapshot is the correct recovery (not merely rejecting):
  // the call still needs an answer under WHATEVER policy is active now.
  async function evaluateWithFreshPolicy(call: PermissionCall) {
    let record = await evaluate(call, makeEvalCtx());
    while (record.policyVersion !== policyStateStore.getState().version) {
      record = await evaluate(call, makeEvalCtx());
    }
    return record;
  }

  // Task 10 (T9-CARRY 2, reassigned; WS-08 §1.3): fires an event OBSERVATIONALLY through the SAME
  // registry/invoker/audit/lifecycle trio realHookStage itself is built from — used for every
  // engine-lifecycle event that is NOT stage-1 PreToolUse/PermissionRequest (those two flow through
  // evaluate()'s own HookStage seam because their composite genuinely GATES the pipeline; every
  // event fired here is "declaration-owned... observational at P2" per §1.3's own classification —
  // fired, audited, and streamed if includeHookEvents is on, but its own SyncHookJSONOutput fields
  // (additionalContext, sessionTitle, etc.) are read by NOBODY downstream yet. Consuming those is
  // real future work (§13 Open Question 4 for the turn-lifecycle events specifically), not silently
  // assumed here — this comment is the flag). Always AWAITED, never raced against a turn's own
  // interrupt signal — the SAME deliberate choice engine.ts's own pre-existing rpc_probe turn kind
  // makes ("a real permission/hook RPC will need to decide its own interrupt-during-wait semantics,
  // which may differ from this"); a future task may revisit.
  //
  // `policyVersion` is read fresh, once, per call — these events don't participate in
  // evaluateWithFreshPolicy's own stale-policy retry loop (there is no DECISION here to go stale;
  // an observational hook's audit record is a historical fact about whatever policy was live the
  // moment it fired, not a pending answer that can be invalidated by a later mode switch).
  // Task 12: now RETURNS the composite (was `Promise<void>`, discarding it) — every existing call
  // site below still just `await`s this without using the result (unaffected, a widening); the
  // PostToolUse call site is the one new consumer (its own `classifierContext` accumulation).
  async function fireObservationalHook(event: HookEvent, call: RunHooksCallInfo) {
    return runHooks(event, call, {
      registry: hookRegistry,
      invoker: hookInvoker,
      audit: hookAuditRecorder,
      sessionId: config.sessionId,
      policyVersion: policyStateStore.getState().version,
      lifecycle: hookLifecycleSink,
    });
  }

  // Store failures are auxiliary, never turn-fatal (WS-03 §11 — a mirror failure becomes a
  // `mirror_error` event, not a retroactive turn failure). P1 has no such event to emit yet, so
  // this just swallows; a future WS-03 §11/WS-16 mirror-layer task is expected to route the catch
  // body to that event (T8 fix-wave: this comment previously, and now stale-ly, said "Task 8 is
  // expected to" — Task 8 shipped without adding it; re-pointed at its real future owner).
  const recordUser = async (content: string | ContentBlock[]): Promise<void> => {
    if (!store) return;
    try {
      await store.recordUserEntry(content);
    } catch {
      /* auxiliary — see comment above */
    }
  };
  const recordAssistant = async (content: ContentBlock[]): Promise<void> => {
    if (!store) return;
    try {
      await store.recordAssistantEntry(content);
    } catch {
      /* auxiliary — see comment above */
    }
  };
  const flushStore = async (): Promise<void> => {
    if (!store?.flush) return;
    try {
      await store.flush();
    } catch {
      /* auxiliary — see comment above */
    }
  };
  // Task 8 (WS-07 §3.3 / phase ruling 2): same auxiliary-failure policy as recordUser/recordAssistant
  // above — a journal write failing must never fail the turn or block the tool call it accompanies
  // (the live PolicyStateStore.applyUpdate already succeeded by the time this runs; the journal is a
  // durability side channel for P5 replay, not the source of truth for THIS run's own live policy).
  const recordPermissionUpdate = async (update: PermissionUpdate, authority: RuleSource): Promise<void> => {
    if (!store?.recordPermissionUpdate) return;
    try {
      await store.recordPermissionUpdate(update, authority);
    } catch {
      /* auxiliary — see comment above */
    }
  };

  // Task 11 (WS-07 §2's mode-switch semantics): "a mode switch mid-park discards incompatible
  // pending records." A durable approval is issued under a specific policyMode/policyVersion
  // (evaluate()'s own stamp) — ANY genuine mode switch invalidates every record still "pending" for
  // this session (they were never going to revalidate cleanly against the new mode anyway; this is
  // a proactive cleanup, not a correctness requirement the resume-revalidation step doesn't already
  // enforce on its own). Called from BOTH mode-switch doors this engine has (policy-state.ts's own
  // header names the equivalence explicitly: "a SECOND DOOR into the same room" — `updatedPermissions`
  // can carry a `type:"setMode"` update mid-turn just as easily as a direct `set_permission_mode`
  // control request) — see both call sites below. `previousMode === nextMode` is a no-op (a
  // same-mode setMode call, or a rejected/gated switch that left the mode unchanged, is not a
  // "switch" at all). Auxiliary — a cancellation failure never fails the mode switch itself, same
  // policy as every other store side effect in this function.
  const cancelPendingApprovalsOnModeSwitch = (previousMode: string, nextMode: string): void => {
    if (!approvalStore || previousMode === nextMode) return;
    try {
      approvalStore.cancelPendingFor({ sessionId: config.sessionId }, `permission mode switched from ${previousMode} to ${nextMode}`);
    } catch {
      /* auxiliary — see comment above */
    }
  };

  // Task 1 (P3, WS-06 §1): the tools seam becomes registry-backed. Built ONLY when the caller omits
  // `tools` (buildDefaultToolExecutor, below) -- everything in this block is unreachable, and
  // therefore inert, for a caller that supplies its own ToolExecutor (every pre-existing test,
  // runtime.ts): `providedTools ?? buildDefaultToolExecutor()` short-circuits before this function's
  // body ever runs whenever `providedTools` is defined. Fix round 1 (RULING P3-C): main.ts now omits
  // `tools`, so it DOES run this block -- see `unregisteredToolExecutor`'s own doc comment
  // (EngineOptions, above) for how it still keeps its pre-existing scripted test doubles working.
  //
  // `session`: the posture-mutation seam Lane E's plan/worktree tools mutate through, wired to this
  // run's own PolicyState/cwd owners declared above (`currentCwd`/`extraBoundedRoots`,
  // `policyStateStore`) -- see ToolExecutionContext.session's own doc comment (registry.ts) for the
  // exact contract. `setPermissionMode` reuses the SAME bypass-gated `policyStateStore.setMode` path
  // + `cancelPendingApprovalsOnModeSwitch` door 1/2 precedent every other mode-switch caller in this
  // file already goes through (set_permission_mode control request; canUseTool/hook
  // updatedPermissions) -- a THIRD door into the identical room, never a parallel implementation of
  // the switch itself. A rejected switch (the bypass gate) throws -- this executes INSIDE a tool
  // executor's own async function, so it rejects that call's promise and surfaces as this round's
  // ordinary error_during_execution (Ruling P1-H), the same severity any other executor-thrown error
  // gets; it is not expected to be reachable via EnterPlanMode/EnterWorktree (neither ever requests
  // "bypassPermissions", the only mode the gate can reject).
  //
  // `getTempDir`/`configureBackgroundTaskRoot`: memoized ONCE per run, lazily -- `sessionTempDir`
  // creates real `/tmp/winter-<uid>/...` directories (D18), so this must never run just because a
  // tool call happened; only a REAL executor that actually reads `ctx.tempDir` (or calls
  // createBackgroundTask) triggers it (see registry.ts's own ToolExecutionContext.tempDir comment
  // and background-tasks.ts's own header for the one-live-engine assumption this accepts).
  // `tempProjectKey` is derived from `config.cwd` (the session's STARTING cwd), deliberately never
  // `currentCwd` -- D18's session-temp identity is fixed for the run's whole lifetime, the same way
  // `permissionHome`/`policyStateStore`'s own initial mode are; it must not drift if a tool later
  // switches worktrees mid-session.
  let cachedSessionTempPaths: SessionTempDirPaths | undefined;
  function resolveSessionTempPaths(): SessionTempDirPaths {
    if (!cachedSessionTempPaths) {
      cachedSessionTempPaths = sessionTempDir({
        tempProjectKey: compatibilityKeys(config.cwd).tempProjectKey,
        backendUuid: config.sessionId,
      });
    }
    return cachedSessionTempPaths;
  }
  function buildDefaultToolExecutor(): ToolExecutor {
    configureBackgroundTaskRoot(resolveSessionTempPaths);
    const deps: RegistryToolExecutorDeps = {
      sessionId: config.sessionId,
      home: permissionHome,
      getCwd: () => currentCwd,
      probeReadAccess: (filePath: string) => probeReadAccess(filePath, makeEvalCtx()),
      // Task 2 (P3, WS-06 §3.5) completes this seam's engine plumbing. registry.ts's own
      // ToolExecutionContext.emitFrame is now typed `(frame: BackgroundTaskMessage) => void` (narrowed
      // from Task 1's placeholder `unknown`), so `frame` here is already one of the six real, closed
      // shapes -- wrapping it in a "data" envelope and hand it to `output.write` needs no cast at all;
      // TS itself proves `{type:"data", message: frame}` satisfies `WinterFrame` structurally, since
      // BackgroundTaskMessage's six members are now part of SdkMessage's own union (frames.ts).
      // Synchronous, like every other output.write call in this file -- three emitFrame calls made
      // back-to-back inside one executor land on the wire in that exact call order (WS-06 §3.5
      // "delivers these frames onto the wire in order").
      emitFrame: (frame: BackgroundTaskMessage): void => {
        output.write({ type: "data", message: frame });
      },
      session: {
        setCwd(p: string): void {
          currentCwd = p;
        },
        addBoundedRoot(p: string): void {
          extraBoundedRoots.push(p);
        },
        // RULING P3-L: see registry.ts's own doc comment. `getSessionRoot` is a plain read of this
        // closure's own `sessionRoot` (never re-derived from `currentCwd`, which is exactly the
        // value it must stay independent of); `setSessionRoot` is called ONLY by EnterWorktree/
        // ExitWorktree.
        getSessionRoot(): string {
          return sessionRoot;
        },
        setSessionRoot(p: string): void {
          sessionRoot = p;
        },
        setPermissionMode(mode: PermissionMode): void {
          const previousMode = policyStateStore.getState().mode;
          const result = policyStateStore.setMode(mode);
          if (!result.ok) {
            throw new WinterPermissionError(result.error.message);
          }
          cancelPendingApprovalsOnModeSwitch(previousMode, result.effectiveMode);
        },
        // Task 8 (P3 close-out, "Settings threading" MUST): `makeEvalCtx()` is cheap and side-
        // effect-free (built fresh per call throughout this file already, e.g. the probeReadAccess
        // line above) -- reusing evaluator.ts's own boundedRoots() here is what keeps a tool
        // executor's notion of "writable roots" from ever drifting from the standing evaluator's.
        getBoundedRoots(): string[] {
          return boundedRoots(makeEvalCtx());
        },
        // RULING P3-H: reads the SAME live PolicyStateStore `setPermissionMode` (above) mutates --
        // never a separate, potentially-stale snapshot. See registry.ts's own
        // ToolExecutionContext.session.getPermissionMode comment for why this exists.
        getPermissionMode(): PermissionMode {
          return policyStateStore.getState().mode;
        },
      },
      // Ruling P3-D carry (task-1 report, spine amendment section): `config.cwd` -- the run's own
      // STARTING cwd -- was in scope here all along; passing it is what lets the read-before-edit
      // ladder's canonicalization resolve a RELATIVE file_path/notebook_path the same way for every
      // caller in this run, instead of silently defaulting to `process.cwd()` (the daemon's own
      // process-wide cwd, never a per-session concept). Deliberately `config.cwd`, not the live
      // `currentCwd` -- SessionReadStateOptions.cwd is fixed at CONSTRUCTION time by design (its own
      // header: "never per-call, so one session's keying stays internally consistent"), and this
      // call site runs exactly once, before any tool call could have switched worktrees, so the two
      // would read identically here regardless; `config.cwd` names the invariant this actually is.
      readState: createSessionReadState({ cwd: config.cwd }),
      getTempDir: () => resolveSessionTempPaths().root,
      sandboxSettings: config.sandbox ?? DEFAULT_SANDBOX_SETTINGS,
      ...(config.outputsDir !== undefined ? { outDir: config.outputsDir } : {}),
    };
    // Fix round 1 (RULING P3-C): main.ts is the one caller that supplies `unregisteredToolExecutor`
    // (stubExecutor) -- every OTHER caller of this default (testing.ts's inMemoryProcess, when ITS
    // OWN `tools` param is also omitted) has none, and keeps the registry's plain, typed "unknown
    // tool" error for an unregistered name exactly as before this fix round.
    return unregisteredToolExecutor !== undefined ? buildRegistryToolExecutorWithFallback(deps, unregisteredToolExecutor) : buildRegistryToolExecutor(deps);
  }
  const tools: ToolExecutor = providedTools ?? buildDefaultToolExecutor();

  // `init` MUST be the first runtime→host frame (WS-04 §4.1 `initializing`), from resolved runtime
  // state. T8 (WS-06 §6 obligation 1): the advertised tool list is no longer hardcoded empty --
  // buildAdvertisedSet's own header comment named this exact wiring as "T8's own job... once every
  // lane's real executor/capability story exists to describe", which is now true (all five P3 lanes
  // merged). `familyMetadata`/`capabilities`/`toolSearchEnabled`/`insideSubagent` are left unset here
  // deliberately -- each has a documented, spec-correct default when absent (AvailabilityPredicate's
  // own comments: absent familyMetadata reads as "not task-native", i.e. shown; absent capabilities
  // requires an EMPTY capabilityRequirements list to pass, which every implement-now descriptor
  // already has), and a real resolution story for any of them (the provider catalog's family
  // metadata [WS-13]; MCP-server-derived capability tokens [WS-09]) is a LATER phase's own job, not
  // invented here. `disallowedTools` threads the run's own deny-grammar config straight through,
  // matching what the permissions engine already sees from the same `config` object -- RuntimeConfig
  // carries no separate "requested tool config" allowlist distinct from `allowedTools` (which stays
  // OUT of this call by design: AdvertisedSetInputs.allowedTools exists for documentation only, and
  // a test in registry.test.ts pins that buildAdvertisedSet must never filter on it -- §1.3's
  // pre-approval-is-not-a-visibility-allowlist rule), so `cfg.tools` is left unset here (its
  // documented default: "no restriction on this axis").
  const advertisedToolNames = buildAdvertisedSet({
    mode: policyStateStore.getState().mode,
    platform: process.platform,
    ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
  }).map((d) => d.advertisedName);
  output.write({
    type: "init",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: config.sessionId,
    cwd: config.cwd,
    model: config.model,
    permissionMode: policyStateStore.getState().mode,
    tools: advertisedToolNames,
  });
  output.write({
    type: "data",
    message: {
      type: "system",
      subtype: "init",
      session_id: config.sessionId,
      cwd: config.cwd,
      model: config.model,
      permissionMode: policyStateStore.getState().mode,
      tools: advertisedToolNames,
    },
  });

  const userFrames = new Queue<UserFrame>();
  // Non-null exactly while a turn is turn_active; the pump calls it (a no-op while idle) when an
  // `interrupt` control request arrives. Kept as a plain callback rather than an AbortController
  // because Provider/ToolExecutor take no signal at P1 (see raceInterrupt above). A ref OBJECT
  // rather than a bare `let`: TS's control-flow narrowing carries the `null` seen at this
  // declaration into the pump closure below and never widens it back across that closure's
  // internal `await`s (a known CFA limitation with values mutated by a second, concurrently
  // -running closure) — `.current` on an object sidesteps that narrowing.
  const interruptCurrentTurn: { current: (() => void) | null } = { current: null };

  // Ruling P2-B: an explicit, engine-controlled shutdown signal for the pump — resolved exactly
  // once, from OUTSIDE the pump (after the turn loop below fully drains; see that call site's own
  // comment) — because a `for await` loop can only be `break`-ed by code physically inside it, and
  // "stop reading, from outside, once we know it's safe" has no other expression. See the pump's
  // own header comment (just below) for the full re-argued termination guarantee this replaces.
  let stopReading!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    stopReading = resolve;
  });

  // The ONLY reader of `input` (WS-04 §4.1). Decoupling "read a frame" from "process a turn" is
  // what lets `interrupt`/`end_input` land WHILE a turn is blocked awaiting the provider or a tool
  // — a single sequential `for await` over `input` could never observe a new frame until the
  // blocked call happened to settle on its own, which would make interrupt meaningless.
  //
  // *** Ruling P2-B — the two-sided end_input fix, engine side (WS-04 §1: fix BOTH sides together
  // or the topologies diverge; see query.ts's own stdin.end() relocation for the wrapper side) ***
  // Before this ruling, `end_input` made the pump `break` outright — the ONLY reader of `input`
  // stopped reading ANY further frame, including a `control_response` answering a runtime-
  // originated permission RPC (T8). A single-shot query sends its one prompt, then `end_input`,
  // essentially immediately — almost always BEFORE the tool call that needs a permission decision
  // has even run. With the old `break`, that permission RPC's `bridge.request()` (no park timeout,
  // WS-04 §3) then awaited a `control_response` the pump had already stopped listening for: a
  // structural deadlock, not a timing accident — the RPC could not have been answered no matter how
  // fast the host replied, because engine.ts itself was no longer reading.
  //
  // The fix inverts what `end_input` means to this loop: it now means "no more USER envelopes" —
  // `userFrames.end()`, below — NOT "stop reading frames." The pump keeps routing every other frame
  // kind (control_response above all) for as long as the turn loop might still need one delivered.
  //
  // Termination, RE-ARGUED for the new direction (P1's own guarantee — "the pump always reaches its
  // own teardown, which always ends userFrames, which always ends the turn loop" — assumed end_input
  // ended the pump, which is exactly the assumption this ruling retires):
  //   1. `userFrames` ending is now guaranteed by TWO independent paths, either sufficient on its
  //      own: (a) `input` truly ends on its own (real stdin EOF / process death — unchanged from
  //      P1; the pump's own `finally` below still runs on ANY exit, ending userFrames exactly as
  //      before), or (b) an explicit `end_input` frame arrives, calling `userFrames.end()` directly
  //      — independent of whether `input` itself ever ends.
  //   2. Given `userFrames` ends, the turn loop (`for await (const userFrame of userFrames)`,
  //      further down) is GUARANTEED to eventually finish draining every already-queued turn and
  //      exit its own for-await — each turn's processing is fully awaited in sequence before the
  //      loop advances, so "the loop exits" and "no turn is still mid-flight, awaiting anything
  //      (including a bridge response)" are the same fact.
  //   3. What NOW guarantees the pump itself ends (the piece P1's argument no longer supplies):
  //      engine completion EXPLICITLY cancels the pump's read — `stopReading()` is called (see its
  //      call site below) ONLY after the turn loop's own for-await has exited, i.e. only once (2)
  //      already holds. There is no cycle: stopping the pump is strictly sequenced to happen after
  //      the turn loop provably has no more work, so cancelling it can never orphan an in-flight
  //      bridge request. If `input` already ended on its own before the turn loop drains (no
  //      end_input, true EOF — path (a) above), the pump has already exited by then and the later
  //      `stopReading()` call is a harmless, already-redundant no-op (resolving an unobserved
  //      promise).
  //   4. Point 3 is where "the pump ends" is proven; it is NOT yet where "runEngine returns" is
  //      proven, because a no-park-timeout bridge.request() (WS-04 §3, Task 8's permission RPC) can
  //      be mid-flight precisely on path (a) — true EOF racing ahead of the turn loop, rather than
  //      end_input's own turn-loop-drains-first sequencing. The pump's own `finally` (below) closes
  //      this: it calls `bridge.rejectAllPending(...)` unconditionally on every exit. On the `stop`
  //      path this is a verified no-op (point 3's invariant already guarantees no request is
  //      pending); on the true-EOF path it is what turns an otherwise-permanent hang into a clean
  //      denial (prompt-stage.ts's rejection handling + Ruling P2-I), letting the stuck turn — and
  //      therefore runEngine itself — complete. (Found by review — see the `finally` block's own
  //      comment for the full mechanism.)
  // Manually driving the iterator (rather than `for await`) is what makes racing it against
  // `stopSignal` possible at all — `for await` offers no hook to await "the next value OR a stop
  // signal, whichever comes first."
  const pump = (async () => {
    const iterator = input[Symbol.asyncIterator]();
    try {
      while (true) {
        const outcome = await Promise.race([
          iterator.next().then((result) => ({ kind: "frame" as const, result })),
          stopSignal.then(() => ({ kind: "stop" as const })),
        ]);
        if (outcome.kind === "stop") return; // engine completion cancelled the pump's read — see header above
        if (outcome.result.done) return; // true input EOF (path (a) above)
        const frame = outcome.result.value;

        if (frame.type === "user") {
          userFrames.write(frame as UserFrame);
          continue;
        }
        if (frame.type === "control_response") {
          // Task 2 direction inversion: this is the ACK for a request the RUNTIME originated
          // (bridge.request() — rpc_probe, and now T8's real permission RPC), arriving
          // host->runtime. handleResponse itself never throws and logs+drops an unmatched/stale
          // requestId (WS-04: a stale response must never kill the run) — nothing more to do here.
          // Ruling P2-B: reachable AFTER end_input too now — this is the exact frame kind the fix
          // exists to keep delivering.
          bridge.handleResponse(frame as ControlResponseFrame);
          continue;
        }
        if (frame.type === "control_request") {
          const cf = frame as ControlRequestFrame;
          if (cf.subtype === "end_input") {
            output.write({ type: "control_response", requestId: cf.requestId, ok: true });
            // Ruling P2-B: "no more USER envelopes," NOT "stop reading frames" — see this const's
            // own header. `continue`, never `break`: the pump keeps pumping past this point.
            userFrames.end();
            continue;
          }
          if (cf.subtype === "interrupt") {
            output.write({ type: "control_response", requestId: cf.requestId, ok: true });
            interruptCurrentTurn.current?.(); // no-op while idle: nothing active to abort
            continue;
          }
          if (cf.subtype === "set_permission_mode") {
            // Task 6 (WS-07 §2/§6.4) upgrade over T2's minimal handler: still validates the payload
            // is one of the six public values (unchanged — a wire-level guard against arbitrary
            // strings), then routes the actual switch through PolicyStateStore.setMode, which bumps
            // `policyVersion` on success and applies the SAME bypassPermissions gate startup
            // validation uses (checkBypassGate) — `ok:false` with a typed error code
            // ("bypass_not_allowed" / "bypass_disabled") on a gated rejection, never a silent no-op.
            const mode = cf.payload; // WS-04 §3.1: request payload is the bare PermissionMode value
            if (typeof mode !== "string" || !isPermissionMode(mode)) {
              output.write({
                type: "control_response",
                requestId: cf.requestId,
                ok: false,
                error: { code: "invalid_mode", message: `invalid permission mode: ${JSON.stringify(mode)}` },
              });
              continue;
            }
            const previousMode = policyStateStore.getState().mode;
            const result = policyStateStore.setMode(mode);
            if (!result.ok) {
              output.write({ type: "control_response", requestId: cf.requestId, ok: false, error: result.error });
              continue;
            }
            // Task 11: door 1 of 2 — see cancelPendingApprovalsOnModeSwitch's own header.
            cancelPendingApprovalsOnModeSwitch(previousMode, result.effectiveMode);
            output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { effectiveMode: result.effectiveMode } });
            continue;
          }
          // WS-04 §3.1: an unrecognized subtype gets a structured error response, never a dropped
          // request or a process death.
          const resp: ControlResponseFrame = {
            type: "control_response",
            requestId: cf.requestId,
            ok: false,
            error: { code: "unknown_subtype", message: `unrecognized control subtype '${cf.subtype}'` },
          };
          output.write(resp);
          continue;
        }
        // Other/unknown top-level frame types (hook/MCP RPCs, other control subtypes) land in later
        // phases; ignored here, matching the P0 precedent of skipping non-"user" frames rather than
        // erroring.
      }
    } finally {
      userFrames.end();
      // Deliberately NOT calling iterator.return() here: at the moment the pump is cancelled via
      // stopSignal, the LOSING `iterator.next()` call is typically still pending, with the
      // underlying generator (a real stdin read, or the in-memory Queue's own generator) suspended
      // INSIDE an await on a promise that legitimately never settles again (no more writes are
      // coming — that's exactly why we're stopping). Calling `.return()` on a generator suspended at
      // an unsettled internal await does NOT unwind immediately (unlike calling it at a `yield`
      // point, which `for await...of`'s own `break` handling relies on, safely, for the OTHER exit
      // path here — true EOF) — it waits for that internal await to settle first, which in this
      // exact situation never happens. An earlier version of this fix called `iterator.return()`
      // here as a "harmless courtesy cleanup" and it deadlocked runEngine's own returned promise
      // (confirmed empirically — see the task report). The abandoned generator is simply left to be
      // garbage-collected once nothing references it any longer (a real child process exits via
      // main.ts's own process.exit() regardless; the in-memory Queue has no other resource to
      // release) — never a hang, just a resolver reference sitting inert.
      //
      // Termination re-argument, the remaining gap (found by review): step 3 above shows
      // `stopReading()` is only ever called after the turn loop has no more work — so on the `stop`
      // exit path, `bridge`'s pending map is already empty by that same invariant, and the call below
      // is a no-op. But on the TRUE-EOF exit path (`outcome.result.done`, or the loop's other early
      // returns), `input` itself is what ended — independent of whether the turn loop has finished —
      // so a turn can still be genuinely mid-flight, awaiting a no-park-timeout `bridge.request()`
      // (WS-04 §3, e.g. Task 8's permission RPC) that can now NEVER be answered: nothing is left to
      // route a `control_response` even if one existed. Without this call, THAT specific request
      // parks forever and runEngine never returns. `rejectAllPending` turns that unreachable hang
      // into a clean resolution: prompt-stage.ts's `catch` already maps ANY bridge rejection to "no
      // opinion" (null), and Ruling P2-I already maps "no opinion" to a denial — so the stuck turn
      // completes with a denied tool_result, exactly as if the (now-impossible) answer had been "no."
      bridge.rejectAllPending(new Error("winter: input ended before this control request could be answered"));
    }
  })();

  // T9-CARRY 2 (reassigned to T10; WS-08 §1.1): "engine start, after init." Fired here — AFTER the
  // pump has started running (the `const pump = ...` assignment above has already invoked its IIFE;
  // by the time control reaches this line the pump's own `while(true)` loop is actively listening
  // for control_response frames) and BEFORE the turn loop begins — never any earlier: a hook RPC
  // issued before the pump exists would have nothing routing its eventual answer back to the
  // bridge, and would need to rely solely on the runner's own per-hook timeout to ever resolve.
  await fireObservationalHook("SessionStart", {
    payload: { source: config.forkSession === true ? "fork" : config.resume !== undefined || config.continue === true ? "resume" : "startup" },
  });

  const messages: ProviderMessage[] = initialMessages ? [...initialMessages] : [];

  // --- Task 11 (WS-07 §9): resume-consumption ------------------------------------------------------
  //
  // DESIGN (this task's own documented judgment call — the spec states WHAT must hold ["the call
  // executes exactly once"] but not HOW a later resume finds and applies a resolution; capture-noted
  // per the brief). Runs ONCE, here, before the turn loop starts (mirrors SessionStart's own "after
  // pump start, before turn loop" placement) — a fresh, never-deferred session has nothing to do
  // (`approvalStore.listFor` returns `[]`, or `approvalStore` itself is undefined).
  //
  // Locating the candidate: resume.ts's own rebuildProviderMessages comment already establishes that
  // a synthetic marker (interrupted/error, and now `deferred`) round-trips VERBATIM through
  // persist->readBack->rebuild, identically to a real tool_result — this scan keys off
  // `record.toolUseID` matching a tool_result's own `tool_use_id` (the store's own authority on
  // which calls are outstanding), treating the `deferred` flag as corroboration only, per this
  // task's own advisor-reviewed robustness note — a hypothetical future dialect change that stopped
  // persisting that one boolean would not silently break this scan.
  //
  // The PERSISTED "[deferred]" line is NEVER rewritten (the store is append-only, WS-05 §6) — only
  // THIS RUN's in-memory `messages` (and therefore the very next provider.generate() call) sees the
  // corrected value. A real tool_use_id has at most one tool_result in valid provider history; this
  // REPLACES the one block already there, never appends a second (appending a second would be
  // provider-invalid — a duplicate tool_result for one tool_use_id).
  //
  // EXACTLY-ONCE EXECUTION (the correctness core of this design): an "allowed" record is executed
  // via `tools.execute()` at most once across its ENTIRE lifetime, regardless of how many times this
  // session is later resumed — `approvalStore.markConsumed` persists the output (or error) the FIRST
  // time, and every later resume substitutes the CACHED result without revalidating or executing
  // again (the `consumedAt` fast path below) — re-validating an already-executed call protects
  // nothing, since the side effect already happened. Revalidation instead runs on the FIRST resume
  // that finds a "pending" or "allowed"-not-yet-consumed record — WS-07 §9's own "ANY mismatch ->
  // expired, never execute" applies to allowed just as much as to pending, since "allowed" alone
  // never proves the call is still safe to run against a session/mode/path/runtime that has since
  // moved on.
  //
  // Fix round 1, Ruling P2-L: the pre-fix-round-1 version of this design was "executes exactly
  // once" in NAME only — a hard process kill between tools.execute() returning and markConsumed()
  // persisting left the record "allowed" with no consumedAt, indistinguishable from "never
  // attempted" to a later resume, which would re-execute (at LEAST once, not EXACTLY once, for a
  // possibly non-idempotent side effect). `approvalStore.markConsuming()` closes this: a durable
  // "about to execute" fact written BEFORE the risky call, so a later resume that finds intent
  // without a result fails closed to "expired" rather than guessing. This sequential
  // crash-recovery guarantee itself assumes no SECOND live process is doing the identical thing for
  // the same session CONCURRENTLY — see the "allowed" branch's own comment, below, for the eager
  // writer-lease dependency (dialect.ts's Ruling P1-S) that provides that assumption.
  //
  // "denied"/"cancelled"/"expired" never execute and are recomputed fresh on every resume (pure
  // data, no side effect, so no consumedAt bookkeeping is needed for them at all).
  if (approvalStore) {
    for (const record of approvalStore.listFor({ sessionId: config.sessionId })) {
      let foundAt: { mi: number; bi: number } | undefined;
      outer: for (let mi = 0; mi < messages.length; mi++) {
        const message = messages[mi]!;
        if (message.role !== "tool" || !Array.isArray(message.content)) continue;
        for (let bi = 0; bi < message.content.length; bi++) {
          const block = message.content[bi]!;
          if (block.type === "tool_result" && block.tool_use_id === record.toolUseID) {
            foundAt = { mi, bi };
            break outer;
          }
        }
      }
      if (foundAt === undefined) continue; // no on-disk trace of this record's own [deferred] marker in THIS run's rebuilt history

      const { mi, bi } = foundAt;
      const substitute = (fields: { content: string; denied?: boolean; error?: boolean }): void => {
        const current = messages[mi]!;
        const blocks = (current.content as ContentBlock[]).slice();
        blocks[bi] = {
          type: "tool_result",
          tool_use_id: record.toolUseID,
          content: fields.content,
          ...(fields.denied === true ? { denied: true } : {}),
          ...(fields.error === true ? { error: true } : {}),
        };
        messages[mi] = { ...current, content: blocks };
      };

      if (record.consumedAt !== undefined) {
        substitute({ content: record.consumedResult ?? "", ...(record.consumedIsError === true ? { error: true } : {}) });
        continue;
      }

      // Fix round 1, Ruling P2-L (write-ahead consumption intent): a "consuming" marker with NO
      // matching "consumed" outcome is the crash signature — a PRIOR resume already called
      // approvalStore.markConsuming() (below) and then died somewhere between that write and
      // tools.execute() returning (or between execute() returning and markConsumed() persisting).
      // Whether the side effect actually ran is now UNKNOWABLE from persisted state alone. Fail
      // closed: expire, never re-execute — "executes exactly once" would otherwise silently become
      // "executes at least once" for a non-idempotent tool. This check runs BEFORE the state-based
      // branching below (and therefore before revalidation) because it is not a context-drift
      // question at all — an intent-without-result is disqualifying regardless of whether the
      // current context would otherwise still revalidate cleanly.
      if (record.consumingAt !== undefined) {
        const reason = "a prior execution attempt for this approval did not record its outcome (the process may have been interrupted mid-execution); re-approval is required";
        approvalStore.expire(record.requestId, reason);
        substitute({ content: `Approval expired: ${reason}`, denied: true });
        continue;
      }

      if (record.state === "pending" || record.state === "allowed") {
        // Ruling P2-K/P1-S dependency (documented here, not merely in the report): this
        // revalidate-then-execute window assumes no SECOND live process can be doing the identical
        // thing for the SAME session concurrently — that guarantee is NOT provided by anything in
        // this function. It comes from dialect.ts's resolveEngineSession eagerly claiming the
        // session's writer lease (Ruling P1-S) before this code ever runs: a second resume attempt
        // against the same session fails outright at session-resolution time (ResumeTargetError
        // "locked"), long before it could reach this loop. Without that eager claim, two concurrent
        // resumes could both revalidate successfully and both execute — a race markConsuming()
        // alone does not close (it protects sequential crash-recovery, not concurrent execution).
        const revalidationCtx = {
          runtimeKind: WINTER_RUNTIME_KIND,
          sessionId: config.sessionId,
          backendSessionId: config.sessionId,
          toolUseID: record.toolUseID,
          policyMode: policyStateStore.getState().mode,
          policyVersion: policyStateStore.getState().version,
          // Item 10 (P2 fix-wave): the LIVE content hash this resume's own current policy computes
          // to — compared against the record's own frozen, issuance-time hash (see approvals.ts's
          // own revalidateApproval comment for the full rationale).
          policyHash: computePolicyHash(policyStateStore.getState()),
          cwd: config.cwd,
          home: permissionHome,
        };
        const verdict = revalidateApproval(record, revalidationCtx);
        if (!verdict.ok) {
          approvalStore.expire(record.requestId, verdict.reason);
          substitute({ content: `Approval expired: ${verdict.reason}`, denied: true });
          continue;
        }
        if (record.state === "pending") continue; // genuinely still pending and still valid -- leave the [deferred] marker as is

        // "allowed" + revalidated -- execute exactly once. A responder's own transformedInput (the
        // durable analog of canUseTool's updatedInput, WS-07 §7.2) wins over the original input when
        // present, taken verbatim with no re-validation — the SAME posture engine.ts's real-time
        // canUseTool path already documents for its own updatedInput (no tool registry/schema exists
        // at P2 to re-check against).
        const inputToExecute = record.resolution?.transformedInput ?? record.originalInput;
        // Ruling P2-L: the write-ahead marker, persisted BEFORE the risky operation — see
        // markConsuming's own interface comment (approvals.ts) for the full rationale.
        approvalStore.markConsuming(record.requestId);
        try {
          const result = await tools.execute({ id: record.toolUseID, name: record.toolName, input: inputToExecute });
          approvalStore.markConsumed(record.requestId, { output: result.output });
          substitute({ content: result.output });
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          approvalStore.markConsumed(record.requestId, { output: `[error: ${text}]`, isError: true });
          substitute({ content: `[error: ${text}]`, error: true });
        }
        continue;
      }

      // "denied" / "cancelled" -- never executes; recomputed fresh every resume (pure data).
      substitute({ content: record.resolution?.message ?? record.resolution?.reason ?? `Approval ${record.state}`, denied: true });
    }
  }
  // Ruling P1-F: maxTurns is the RUN's cumulative agentic tool-use round-trip cap (report §8 /
  // WS-03 §5) — it never resets per user envelope. Declared here, outside the turn loop, so it
  // persists for runEngine's whole lifetime; once spent, EVERY subsequent tool_use attempt in this
  // run fails with error_max_turns (sticky-over-limit — incrementing past the limit is harmless,
  // there's no need to cap the counter itself). A plain-text turn never touches this counter, so a
  // text-only envelope always succeeds regardless of how much of the budget prior turns spent.
  let rounds = 0;

  for await (const userFrame of userFrames) {
    // Set BEFORE any await this turn (including recordUser below) so the entire turn — from the
    // moment its envelope is accepted — is interruptible (WS-04 §5).
    let interruptResolve!: () => void;
    const interruptSignal = new Promise<void>((resolve) => {
      interruptResolve = resolve;
    });
    interruptCurrentTurn.current = interruptResolve;

    // Finding 3 (P2 fix-wave, IMPORTANT): result.permission_denials, the array the frozen
    // derived-shapes doc calls "the record to trust ... the array is the ledger" (permission_denied
    // stream messages are best-effort/advisory only, per that same doc's own load-bearing finding).
    // Reset PER USER TURN (never across turns) — this is "what did THIS turn deny," mirroring how
    // each turn gets exactly one terminal result. Pushed to from the ONE denyCall site below, which
    // both fail-closed-defer denials (no durable approval store; persisting the record itself
    // failed) already route through — nothing else needs separate instrumentation.
    const turnPermissionDenials: SDKPermissionDenial[] = [];

    const userText = userFrame.text;
    messages.push({ role: "user", content: userText });
    await recordUser(userText);

    // T9-CARRY 2 (reassigned to T10; WS-08 §1.1): "user envelope accepted, BEFORE the turn's
    // provider call" — fired here, after the envelope is durably recorded but before
    // provider.generate() is ever invoked. Its own output shape (additionalContext/sessionTitle/
    // suppressOriginalPrompt) is declaration-owned and OBSERVATIONAL at P2 (WS-08 §1.3 / open
    // question 4: "any gating behavior beyond the declaration is ... never assumed") — nothing here
    // consumes it; a future task that wants UserPromptSubmit to actually suppress/rewrite the
    // prompt has a real seam to build against (this call site), not a gap to discover.
    await fireObservationalHook("UserPromptSubmit", { payload: { prompt: userText } });

    // Finding 3 (P2 fix-wave): `permission_denials` is deliberately OMITTED from this variable's own
    // type — every one of the several construction sites below builds a plain result shape exactly
    // as before this fix wave; the field is stamped exactly once, at the single terminal-write site
    // (via a spread), rather than repeated at each `finalResult = {...}` assignment.
    let finalResult: Omit<Extract<SdkMessage, { type: "result" }>, "permission_denials"> | null = null;
    let interrupted = false;

    roundLoop: while (true) {
      let turn: ProviderTurn;
      try {
        const raced = await raceInterrupt(provider.generate({ messages: [...messages] }), interruptSignal);
        if (raced.kind === "interrupted") {
          interrupted = true;
          break roundLoop;
        }
        turn = raced.value;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        finalResult = { type: "result", subtype: "error_during_execution", is_error: true, result: text };
        break roundLoop;
      }

      if (turn.kind === "text") {
        // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await —
        // the terminal result below is the sole durability barrier for this turn; P6 (partial
        // streaming) must revisit this ordering once intermediate frames become resumable state.
        output.write({ type: "data", message: { type: "assistant", message: { content: [{ type: "text", text: turn.text }] } } });
        messages.push({ role: "assistant", content: turn.text });
        await recordAssistant([{ type: "text", text: turn.text }]);
        finalResult = { type: "result", subtype: "success", is_error: false, result: turn.text };
        break roundLoop;
      }

      if (turn.kind === "rpc_probe") {
        // See this type's own comment on ProviderTurn above: P1-only, REMOVE at P6. Every path
        // below ends in `break roundLoop` so TS's narrowing of `turn` to the tool_use variant past
        // this point (via `turn.calls` further down) still holds.
        //
        // Deliberately NOT raced against interruptSignal the way provider.generate()/tools.execute()
        // are above: an interrupt arriving while this await is in flight still gets ACKed by the
        // pump (unconditional), but has no effect on this wait — a known gap acceptable for a
        // P1-only test scaffold that's never itself interrupted, not a spec requirement. A real
        // permission/hook RPC (Tasks 8/10) will need to decide its own interrupt-during-wait
        // semantics (WS-07/WS-08), which may differ from this.
        let replyText: string;
        try {
          const response = await bridge.request<{ text: string }>(turn.subtype, turn.payload);
          replyText = `rpc reply: ${response.text}`;
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          finalResult = { type: "result", subtype: "error_during_execution", is_error: true, result: text };
          break roundLoop;
        }
        output.write({ type: "data", message: { type: "assistant", message: { content: [{ type: "text", text: replyText }] } } });
        messages.push({ role: "assistant", content: replyText });
        await recordAssistant([{ type: "text", text: replyText }]);
        finalResult = { type: "result", subtype: "success", is_error: false, result: replyText };
        break roundLoop;
      }

      // tool_use: one round trip regardless of how many calls it batches ("a tool round = provider
      // tool_use → execute → results appended → provider again" — counted once per such cycle).
      rounds++;
      if (config.maxTurns !== undefined && rounds > config.maxTurns) {
        finalResult = { type: "result", subtype: "error_max_turns", is_error: true };
        break roundLoop;
      }

      const toolUseBlocks: ContentBlock[] = turn.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }));
      // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await — the
      // terminal result is the sole durability barrier; P6 (partial streaming) must revisit this.
      output.write({ type: "data", message: { type: "assistant", message: { content: toolUseBlocks } } });
      messages.push({ role: "assistant", content: toolUseBlocks });
      await recordAssistant(toolUseBlocks);

      const resultBlocks: ContentBlock[] = [];
      // Set (alongside `finalResult`) exactly when a call in THIS round throws — kept as its own
      // variable, rather than re-deriving from `finalResult`, because `finalResult` can ALSO be set
      // by the provider.generate() catch above, which already does its own `break roundLoop` and
      // never reaches this point in the same iteration; this flag only ever reflects a throw from
      // the loop directly below it.
      let toolThrowText: string | null = null;
      for (const call of turn.calls) {
        try {
          // Task 6 (WS-07 §2, WS-04 §4 ordering rule 5): the permission gate slots HERE — between
          // this round's tool_use emission (already written/pushed/recorded above) and execution.
          // Calls in one round evaluate SEQUENTIALLY in call order (this `for` loop's own order); a
          // deny produces its synthetic tool_result and the loop CONTINUES to the next call — it
          // does not `break` the round, matching "each-call-independent" semantics (unlike an
          // interrupt or a thrown executor, which legitimately do stop the round early below).
          const permissionCall: PermissionCall = {
            toolName: call.name,
            input: typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {},
            toolUseId: call.id,
          };
          const decisionRaced = await raceInterrupt(evaluateWithFreshPolicy(permissionCall), interruptSignal);
          if (decisionRaced.kind === "interrupted") {
            interrupted = true;
            break;
          }
          const decision = decisionRaced.value;

          // Denial emission, factored out (Task 11) so BOTH a real evaluate()-driven denial AND a
          // fail-closed-defer denial (this call's own new branch, below — no durable approval store
          // reachable, or persisting the record itself failed) share the identical tool_result +
          // permission_denied system message + PermissionDenied hook triple. `interrupt` stays OUT
          // of this helper deliberately: only a REAL PermissionDecisionRecord ever carries it
          // (WS-07 §7.2's own union) — an engine-originated fail-closed denial invents no such
          // signal, so the one real call site below still handles it inline, after calling this.
          const denyCall = async (message: string, mechanism: string, ruleRef?: string): Promise<void> => {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: message, denied: true });
            // Finding 3 (P2 fix-wave, IMPORTANT): the ONE accumulation site — every denial reaches
            // here (hook/rule/mode/canUseTool/autoEngine, plus both fail-closed-defer cases below),
            // so this single push is the array's complete producer. `tool_input` is `permissionCall.
            // input` — the ORIGINAL, un-hook-transformed input the call was evaluated against
            // (matching the pinned 3-field shape's own semantics, and the tool_use block the model
            // itself already saw), never `executedCall.input`, which a canUseTool answer's own
            // updatedInput may have since narrowed/redirected.
            turnPermissionDenials.push({ tool_name: call.name, tool_use_id: call.id, tool_input: permissionCall.input });
            // Task 10 (WS-08 §6 / derived-shapes-p2.md item (d)): the public SDKPermissionDeniedMessage
            // is UNCONDITIONAL — never gated by includeHookEvents (that item's own "Correction to
            // this task's own brief framing": only the hook_started/hook_progress/hook_response
            // trio is gated) — and fires on ANY-stage denial regardless of `mechanism` (hook/rule/
            // mode/canUseTool/autoEngine all reach this one call site, plus Task 11's own two
            // engine-originated fail-closed-defer cases). Best-effort/advisory per that same item's
            // own load-bearing finding — the tool_result block above (and, since this fix wave,
            // `result.permission_denials`) is the authoritative record; this stream message is
            // UX/telemetry only. `decision_reason_type`/`decision_reason` are Winter's own mapping
            // of PermissionDecisionRecord's mechanism/ruleRef — the pinned declaration names the
            // fields without pinning their exact semantics beyond advisory/UI-facing.
            output.write({
              type: "data",
              message: {
                type: "system",
                subtype: "permission_denied",
                tool_name: call.name,
                tool_use_id: call.id,
                ...(permissionCall.agentId !== undefined ? { agent_id: permissionCall.agentId } : {}),
                decision_reason_type: mechanism,
                ...(ruleRef !== undefined ? { decision_reason: ruleRef } : {}),
                message,
                session_id: config.sessionId,
                uuid: randomUUID(),
              },
            });
            // WS-08's own PermissionDenied HOOK EVENT (distinct from the stream message above) —
            // purely observational (§6: "observes denials ... for logging/telemetry/UX; it cannot
            // reverse them"), fired for the SAME every-mechanism denial. Not raced against
            // interruptSignal (this whole call-info-building/firing step is synchronous-cheap and
            // deliberately unraced, matching the rpc_probe turn kind's own precedent elsewhere in
            // this file).
            await fireObservationalHook("PermissionDenied", {
              toolUseID: call.id,
              toolName: call.name,
              input: permissionCall.input,
              payload: { reason: message },
            });
          };

          // --- Task 11 (WS-07 §9 / WS-08 §7): a `defer` decision parks the call durably ----------
          if (decision.decision === "defer") {
            const deferMessage = decision.message ?? "a PreToolUse hook deferred this call for durable approval";
            // Fail-closed case 1: no durable approval store reachable for this run (e.g.
            // persistSession:false — there is nowhere to durably park a call that, by definition,
            // needs to survive this process exiting). WS-07 §6.1's "never implicitly allowed" floor
            // applies just as much to an un-parkable park as to an unresolved prompt — a phantom
            // "[deferred]" marker nothing could ever resume would be strictly worse than a denial.
            if (!approvalStore) {
              await denyCall(`Denied: cannot defer -- no durable approval store is available for this session (${deferMessage})`, "hook");
              continue;
            }
            const requestId = randomUUID();
            const executedInput = decision.transformedInput ?? permissionCall.input;
            const approval: DurableApprovalRecord = {
              runtimeKind: WINTER_RUNTIME_KIND,
              sessionId: config.sessionId,
              backendSessionId: config.sessionId,
              requestId,
              toolUseID: call.id,
              ...(permissionCall.agentId !== undefined ? { agentID: permissionCall.agentId } : {}),
              toolName: call.name,
              originalInput: executedInput,
              displayMetadata: { decisionReason: deferMessage },
              policyMode: policyStateStore.getState().mode,
              policyVersion: decision.policyVersion,
              // Item 10 (P2 fix-wave): the content-based hash a later resume's own revalidation
              // compares against (see approvals.ts's own revalidateApproval comment). Computed from
              // the SAME live policyStateStore.getState() `decision.policyVersion` was itself
              // stamped from -- evaluateWithFreshPolicy's own re-evaluation loop guarantees the two
              // already agree by the time this branch runs, so this is exactly the policy the
              // deferred decision was actually made under, not a later, possibly-already-moved-on
              // snapshot.
              policyHash: computePolicyHash(policyStateStore.getState()),
              issuedAt: new Date().toISOString(),
              state: "pending",
              issuedCwd: config.cwd,
              issuedHome: permissionHome,
            };
            // Fail-closed case 2: the store exists but persisting THIS record threw. Unlike
            // recordUser/recordPermissionUpdate/recordHookAudit (auxiliary mirrors of in-memory
            // truth the turn is already correct without), the persisted approval record IS the
            // feature here — "the run can END cleanly with the record persisted" (this task's own
            // brief) presumes persistence succeeded. A park whose record failed to write is
            // unresolvable forever (worse than a denial, which the agent can at least react to) —
            // so this is its own denial, never a swallowed auxiliary failure, and the synthetic
            // "[deferred]" marker below is never emitted for a record that was never actually
            // durable.
            try {
              approvalStore.record(approval);
            } catch (err) {
              const text = err instanceof Error ? err.message : String(err);
              await denyCall(`Denied: failed to persist the durable approval record (${text})`, "hook");
              continue;
            }
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: "[deferred]", deferred: true });
            // Winter-original public system message (no pinned upstream shape exists for a durable
            // defer — WS-07 §9 itself frames the durable-approval layer as a Winter product
            // addition over the SDK-compatible surface, not an upstream wire pin, unlike
            // permission_denied's own derived-shapes provenance). Mirrors permission_denied's own
            // field shape/spirit; `request_id` is this record's own correlator for a later
            // out-of-band respond().
            output.write({
              type: "data",
              message: {
                type: "system",
                subtype: "permission_deferred",
                tool_name: call.name,
                tool_use_id: call.id,
                ...(permissionCall.agentId !== undefined ? { agent_id: permissionCall.agentId } : {}),
                request_id: requestId,
                message: deferMessage,
                session_id: config.sessionId,
                uuid: randomUUID(),
              },
            });
            continue;
          }

          if (decision.decision !== "allow") {
            // decision.decision === "deny" here (defer is handled above; a matched ask rule is
            // already resolved to a terminal allow/deny by the prompt stage inside evaluate() itself,
            // never surfaced as its own pending state). Cross-task pin: a denial is a NORMAL
            // tool_result, `denied: true`, flowing through the SAME emit/push/record cluster below
            // as every other result — this is what makes dontAsk's deny-not-hang fall out
            // structurally (WS-07 §6.3).
            const deniedMessage = decision.message ?? "Permission denied";
            await denyCall(deniedMessage, decision.mechanism, decision.ruleRef);
            // Task 8 (WS-07 §7.2): a deny's `interrupt: true` ADDITIONALLY triggers the engine's
            // existing interrupt path — "interrupt can stop more than the individual call." Mirrors
            // every other in-round interrupt trigger: mark `interrupted`, fire the SAME turn-wide
            // signal a host-originated `interrupt` control request fires (so any later await in this
            // turn also observes it), and stop processing further calls in this round — the
            // post-loop padding logic below fills in synthetic `[interrupted]` results for any call
            // this round never got to. `allow` never carries `interrupt` (WS-07 §7.2's own union),
            // so this check is scoped to the deny branch by construction, not by an extra guard.
            if (decision.interrupt === true) {
              interrupted = true;
              interruptCurrentTurn.current?.();
              break;
            }
            continue;
          }
          // Task 8 (WS-07 §7.2): updatedPermissions applies each suggested update to the LIVE
          // policy, bumping policyVersion (authority "session" — a canUseTool answer is a live
          // session interaction, never a direct settings-file edit; policy-state.ts's own authority
          // gate still governs whether a file-destined suggestion may actually land there). Applied
          // BEFORE executing this call: the update affects FUTURE calls only (this call's own
          // decision is already final), so ordering relative to tools.execute() below is not
          // observable either way — applying it here simply keeps every side effect of "the
          // permission decision resolved" together, before moving on to "now run the tool."
          if (decision.updatedPermissions) {
            for (const update of decision.updatedPermissions) {
              // Finding 8 (P2 fix-wave, MINOR): (a) applyUpdate's OWN {ok:false} result (the bypass
              // gate rejecting a setMode suggestion) was previously discarded — the update was
              // journaled as APPLIED regardless, so a bypass-gated setMode suggestion was rejected
              // LIVE but journaled as though it had succeeded (P5's replay would faithfully write a
              // mutation the live gate refused — the P2-H envelope work exists precisely so the
              // journal never misleads replay). (b) applyUpdate's OWN typed throws (an invalid rule
              // inside addRules/replaceRules -> PermissionRuleValidationError; a forged destination
              // -> PermissionUpdateAuthorityError) previously escaped uncaught into this round's own
              // try/catch, turning an ALREADY-APPROVED call into a whole-turn error_during_execution
              // over nothing worse than one bad suggestion string — policy-state.ts's own applyUpdate
              // comment flagged this exact caller as needing its own try/catch, never honored until
              // now. Both failure modes below drop ONLY the suggestion (stderr note, journal
              // untouched) — the call itself was already approved and proceeds regardless.
              try {
                // Task 11: door 2 of 2 (policy-state.ts's own "second door into the same room" —
                // `applyUpdate` can carry a `type:"setMode"` update just as easily as a direct
                // set_permission_mode control request) — see cancelPendingApprovalsOnModeSwitch's own
                // header. Captured/compared around applyUpdate regardless of update type; a no-op for
                // every non-"setMode" update since the mode value cannot have moved.
                const previousMode = policyStateStore.getState().mode;
                const applied = policyStateStore.applyUpdate(update, { authority: "session" });
                if (!applied.ok) {
                  console.error(`winter: dropped a canUseTool/hook-suggested permission update rejected by the bypass gate (${applied.error.code}): ${applied.error.message}`);
                  continue;
                }
                cancelPendingApprovalsOnModeSwitch(previousMode, policyStateStore.getState().mode);
                // Phase ruling 2: "applies session-effective immediately AND appends to the
                // permission journal" — the live application above and the durability journal below
                // are two independent effects of the SAME update, not a fallback chain; journaling
                // failure (auxiliary, see recordPermissionUpdate's own comment) never undoes or
                // blocks the live application that already happened.
                await recordPermissionUpdate(update, "session");
              } catch (err) {
                const text = err instanceof Error ? err.message : String(err);
                console.error(`winter: dropped a malformed canUseTool/hook-suggested permission update: ${text}`);
              }
            }
          }
          // WS-07 §7.2: updatedInput/transformedInput sanitizes/narrows/redirects the EXECUTED call
          // — the tool_use block already emitted above keeps the model's ORIGINAL input; only what
          // actually runs (and therefore the tool_result that comes back) reflects the transform.
          // SEAM (P3, no tool registry/schema yet at P2): a host-supplied updatedInput is taken
          // verbatim, with no re-validation against the tool's own input schema before execution —
          // P3's tool registry (WS-06) is where that re-check belongs; until then a canUseTool
          // callback that returns a shape the target tool cannot handle surfaces as that tool's own
          // execution error, not a permission-layer one.
          const executedCall = decision.transformedInput !== undefined ? { ...call, input: decision.transformedInput } : call;
          const raced = await raceInterrupt(tools.execute(executedCall), interruptSignal);
          if (raced.kind === "interrupted") {
            interrupted = true;
            break;
          }
          resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: raced.value.output });
          // Task 10 (WS-08 §5; PreToolUse/PostToolUse/PostToolUseFailure "fire at the tool round"):
          // contribution-capable, observational at P2 — its own transformedOutput/extraContext
          // fields still have no consumer (a future WS-08 task's job); `classifierContext` DOES have
          // a consumer now (Task 12, WS-07 §10.4/§10.6-8) — see the accumulation immediately below.
          // Fired + audited + streamed regardless, per the SAME "declaration-owned... not silently
          // assumed" posture as every other ad hoc call site in this function. Fires ONLY after a
          // genuinely successful execution — never for a denied call (never executed at all) or an
          // interrupted one (abandoned mid-flight, not completed).
          const postToolUseComposite = await fireObservationalHook("PostToolUse", {
            toolUseID: call.id,
            toolName: call.name,
            input: executedCall.input as Record<string, unknown>,
            payload: { tool_response: raced.value.output },
          });
          // Task 12: T9's own accumulation contract (reducer.ts's Rule 4) is "unconditional, never
          // override-discard" — mirrored here at the one place this composite is actually consumed.
          if (postToolUseComposite.classifierContext !== undefined) {
            accumulatedClassifierContext.push(...postToolUseComposite.classifierContext);
          }
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          finalResult = { type: "result", subtype: "error_during_execution", is_error: true, result: text };
          toolThrowText = text;
          // Task 10 (WS-08 §5): the failure-arm sibling of PostToolUse above — fires when this
          // call's own tool executor threw (or, less commonly, when an earlier step in this SAME
          // try block threw first, e.g. evaluateWithFreshPolicy or the updatedPermissions loop —
          // `executedCall`/`decision` are try-block-scoped and not reachable from `catch`, so this
          // uses `call`'s own raw, untransformed input, the one value guaranteed available
          // regardless of which line inside the try actually threw).
          await fireObservationalHook("PostToolUseFailure", {
            toolUseID: call.id,
            toolName: call.name,
            input: typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {},
            payload: { error: text },
          });
          break;
        }
      }

      if (toolThrowText !== null) {
        // Ruling P1-H: the tool_use/tool_result pairing invariant must hold in ACCUMULATED HISTORY
        // (and on the wire, and in persistence) even when a tool executor THROWS mid-round — the
        // assistant's tool_use was already pushed into `messages` above, so every one of its calls
        // needs a matching tool_result or the history a real provider's next request (and Task 8's
        // persistence) would carry a dangling tool_use, which a real provider rejects outright.
        // Provisional shape pending official capture (same class as the interrupted-result shape
        // below, whose comment this mirrors): content "[error: <thrown>]" + `error: true` marks a
        // call that never got a real result because its round's tool executor threw — covers both
        // the call that threw and any calls after it in this round that never got to run. Uses the
        // SAME Error-message-or-String(err) rendering as `finalResult.result` above (`text`) rather
        // than an unconditional `String(thrown)` — see the task-8 report's deviations for why.
        const resultedIds = new Set(resultBlocks.map((b) => (b as { tool_use_id: string }).tool_use_id));
        for (const call of turn.calls) {
          if (!resultedIds.has(call.id)) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `[error: ${toolThrowText}]`, error: true });
          }
        }
      }

      if (interrupted) {
        // Ruling P1-G: the tool_use/tool_result pairing invariant must hold in ACCUMULATED HISTORY
        // even when a round is cut short — the assistant's tool_use was already pushed into
        // `messages` above, so every one of its calls needs a matching tool_result or the history
        // Task 8 persists (and any real provider's next request) carries a dangling tool_use, which
        // a real provider rejects outright. Provisional shape pending official capture (same
        // standing pattern as the interrupted-result shape below): content "[interrupted]" +
        // `interrupted: true` marks a call that never got a real result because the turn was
        // interrupted — covers both "never started" and "was mid-execution when interrupted" calls.
        const resultedIds = new Set(resultBlocks.map((b) => (b as { tool_use_id: string }).tool_use_id));
        for (const call of turn.calls) {
          if (!resultedIds.has(call.id)) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: "[interrupted]", interrupted: true });
          }
        }
      }

      // Emitted/pushed/recorded unconditionally (normal completion, padded-after-interrupt, OR
      // padded-after-throw) so the wire, the in-memory history, and persistence never disagree about
      // whether this round's tool_result exists — an implementation-shape choice under P1-G (later
      // extended by P1-H to the throw path): previously nothing was emitted here on interrupt (nor,
      // until P1-H, on a throw), which under-delivered relative to WS-04 §5's drain-after-interrupt
      // contract ("buffered data of the interrupted turn, then its terminal result").
      // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await — the
      // terminal result is the sole durability barrier; P6 (partial streaming) must revisit this.
      output.write({ type: "data", message: { type: "user", message: { content: resultBlocks } } });
      messages.push({ role: "tool", content: resultBlocks });
      await recordUser(resultBlocks);

      if (finalResult) break roundLoop; // relocated below the emit/push/record (Ruling P1-H) — see comment above
      if (interrupted) break roundLoop;
      // loop back for the next provider.generate() call
    }

    // T9-CARRY 2 (reassigned to T10; WS-08 §1.1): "when the main agent is about to stop" — fired
    // HERE, deliberately BEFORE the turn's terminal result is written below (advisor-confirmed
    // placement, not merely tidy): the single-shot wrapper's own readLoop only breaks out once it
    // observes the terminal `result` data frame (query.ts), so it is STILL actively reading stdout
    // at this exact point — a Stop hook RPC issued here is genuinely answerable on every prompt
    // shape. Firing it any later (e.g. after the result write) would make it unanswerable in
    // single-shot mode for the identical structural reason SessionEnd needed the bridge's
    // closed-flag fix (see that call site's own comment, further down this function). Declaration-
    // owned/observational output (WS-08 §1.3, §13 open question 4) — not consumed here.
    await fireObservationalHook("Stop", { payload: { stop_hook_active: false } });

    interruptCurrentTurn.current = null;

    // Terminal-over-abort (WS-04 §5 drain-after-interrupt; the same principle query.ts's wrapper
    // pins for its own abort-vs-terminal race): a turn that genuinely completed wins even if an
    // interrupt landed in the same tick as completion (e.g., during the recordAssistant/recordUser
    // await just before this check). Only the ABSENCE of a terminal result falls through to the
    // provisional interrupted shape.
    //
    // Finding 3 (P2 fix-wave): `permission_denials` is stamped HERE, once, regardless of which of
    // the several `finalResult = {...}` construction sites above (or the provisional
    // interrupted-result fallback below) produced this turn's terminal shape — a single seam rather
    // than instrumenting every construction site individually. Pin-verified ALWAYS PRESENT (never
    // optional) on the real declaration, so every result carries it, `[]` when this turn denied
    // nothing.
    if (finalResult) {
      output.write({ type: "data", message: { ...finalResult, permission_denials: turnPermissionDenials } });
    } else {
      // Provisional shape pending official capture (standing controller ruling) — no `result` text.
      output.write({ type: "data", message: { type: "result", subtype: "success", is_error: false, interrupted: true, permission_denials: turnPermissionDenials } });
    }
    await flushStore();
  }

  // T9-CARRY 2 (reassigned to T10; WS-08 §1.1): "teardown" — fired HERE, after the turn loop has
  // fully drained but strictly BEFORE `stopReading()` below, so the pump (still alive at this exact
  // point per Ruling P2-B's own guarantee, point 2) can still route this hook RPC's eventual
  // control_response. This is the ONE lifecycle call site genuinely at risk of racing a dead
  // connection even with correct placement: a single-shot wrapper's own readLoop has ALREADY broken
  // out (it stops reading stdout entirely the instant it sees the turn's terminal `result` frame,
  // written well before this point) and closes its stdin shortly after — meaning THIS runtime's own
  // `input` can hit true EOF (triggering the pump's `bridge.rejectAllPending`, see that call site's
  // own comment) before or immediately after this request is even issued, regardless of how this
  // call site is placed. Structurally unanswerable in single-shot mode, not a race to win — which is
  // exactly why the bridge itself was extended (this task, rpc/bridge.ts) to reject a request
  // immediately once closed, rather than letting it sit until the 30s observational timeout: without
  // that fix, EVERY single-shot query with any hook configured would stall SessionEnd for up to 30s
  // before runEngine could return. With it, this call resolves promptly either way — a genuine
  // answer in streaming mode (the wrapper is still reading), or an immediate rejection (folded by
  // runHooks into a normal {kind:"error"} audit outcome, never a hang) in single-shot mode.
  await fireObservationalHook("SessionEnd", { payload: { reason: "other" } });

  // Ruling P2-B: the turn loop's own `for await (const userFrame of userFrames)` above has now
  // exited — every queued turn has fully drained (see the pump's own header, point 2) — so it is
  // now safe to explicitly cancel the pump's read. This is the NEW guarantee that ends the pump in
  // the inverted direction: if `input` already ended on its own (no end_input was ever sent), the
  // pump is already resolved and this is a harmless no-op; if the pump is still alive (end_input
  // was seen but `input` itself never closed), this is what actually stops it.
  stopReading();
  await pump.catch(() => {}); // the pump only throws on a truly unexpected input-source error; never let that crash teardown
  output.end();
  return 0;
}

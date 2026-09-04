// WS-10 (RULING R4-4): the real `ChildEngineDeps` implementation -- a child is an IN-PROCESS
// `runEngine()` instance, sharing this process's own registry/provider, never a second spawned OS
// process. Registered via `registerChildEngineFactory` (child-handle.ts, T3-frozen); consumed by
// engine.ts's own `ctx.session.spawnChild` (also frozen) through the factory-registration seam.
//
// --- Three seam gaps this file cannot close on its own (raised with the controller; see this
// lane's own report) ------------------------------------------------------------------------------
//
// (1) PROVIDER/STORE INJECTION: neither `ChildEngineRunContext` (parentSessionId +
// forwardChildFrame only), `SpawnChildRequest`, nor `ChildInheritance` carries a `Provider` or a
// `SessionStore` -- `runEngine` cannot run without one. `createChildEngineFactory` below therefore
// takes them as CONSTRUCTION-TIME dependencies (`ChildEngineFactoryDeps`), matching the frozen
// `(runCtx) => ChildEngineDeps` factory shape: `registerChildEngineFactory(createChildEngineFactory(
// {provider, store, ...}))` must be called ONCE, near where main.ts already builds its own top-level
// provider/store -- main.ts is on this lane's never-modify list, so that ONE call is NOT made by
// this lane's own commits. Until it lands, a real production session's Agent tool calls fail with
// the PRE-EXISTING, already-tested "no child engine factory is registered" error (engine.ts) rather
// than truly spawning a child. Every test in this lane registers the factory directly (mirroring
// T3's own fix-round-1 spawn-seam-test precedent), so the logic below is fully proven regardless.
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
// (3) PROGRAMMATIC AgentDefinition VISIBILITY: `ToolExecutionContext` (registry.ts, frozen) has no
// field surfacing `RuntimeConfig.agents` to a tool executor -- tools/impl/agent.ts's own
// `subagent_type` resolution can therefore only ever see filesystem-defined agents
// (`~/.winter/agents/`, and `.winter/agents/*.md` in a trusted workspace); a session's own
// programmatic `Options.agents` map is invisible to a running Agent tool call. definitions.ts's own
// `loadAgentDefinitions` accepts a `programmatic` parameter for exactly this reason -- fully correct
// and independently tested -- but tools/impl/agent.ts always passes `undefined` for it today. Fixing
// this needs one new field on `ToolExecutionContext` (registry.ts) plus one conditional-spread line
// in engine.ts's `buildDefaultToolExecutor`, both outside this lane's file authority.
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
// STATIC case (a host that configures rules/hooks at startup now binds every descendant); it does
// NOT close the LIVE case -- a rule/hook change made to the parent's OWN session mid-run has no
// channel to reach an already-registered factory (the identical root cause as gap (2) above); a
// real per-spawn fix needs a `ChildEngineRunContext` field carrying the parent's CURRENT rules/hooks,
// which is T8's seam to add.
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
import { runEngine, type Provider, type ProviderMessage } from "../engine.ts";
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
import { resolveModelAlias, describeRequestedModel, resolveEffort, recordModelEffort, type ModelCatalog } from "./resolution.ts";
import { resolveForkInitialMessages } from "./fork.ts";
import { createWorkspace, cleanupWorkspace } from "./workspace.ts";
import { validateAgentDefinition } from "./definitions.ts";
import { resolveChildResumeMode, ChildResumeModeIncomparableError } from "../permissions/auto/inheritance.ts";

export interface ChildEngineFactoryDeps {
  provider: Provider;
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
  const env = deps.env ?? process.env;

  // WS-10 §6: depth/concurrency checked BEFORE any real work (workspace creation, store I/O) --
  // a rejected spawn should be cheap and side-effect-free.
  checkAndRegisterSpawn({ parentSessionId: runCtx.parentSessionId, childSessionId: agentId, env });
  let spawnRegistered = true;

  try {
    // --- Model/effort resolution (WS-10 §3) -----------------------------------------------------
    const requestedModel = describeRequestedModel(req);
    const resolvedModel = resolveModelAlias(inherit.model, deps.modelCatalog); // may throw UnresolvableModelAliasError
    const resolvedEffort = resolveEffort(inherit.effort);
    const modelEffort = recordModelEffort({ ...(requestedModel !== undefined ? { requestedModel } : {}), resolved: resolvedModel, effort: resolvedEffort });

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
    function startGeneration(config: RuntimeConfig, initialMessages: ProviderMessage[], liveText: string): void {
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
        forwardedHostRequestIds.clear();
        watchdog.cancel();
        releaseSpawn(agentId);
        void writer?.writeMetadata({ ...record });
        // WS-10 §8: "auto-cleaned when unchanged" -- fire-and-forget, regardless of which terminal
        // status this generation reached (a stopped/failed child's own worktree is reclaimed exactly
        // like a completed one's, IF genuinely unchanged; real, undiscarded work is left in place
        // either way -- see workspace.ts's own cleanupWorkspace for the exact safety checks).
        void cleanupWorkspace(workspace);
        // A "completed"/"failed" settlement is reached via observe()'s OWN "result" data frame --
        // i.e. the nested engine finished a turn and is now sitting idle, waiting for its OWN next
        // "user" input frame, which nothing will ever send it. Without this call, that engine
        // instance (plus its writer, plus this read loop) leaks for the rest of the daemon's process
        // lifetime, once per completed child, forever -- a zombie engine, not merely a zombie
        // promise. `interrupt` on an already-idle engine is a documented no-op; a second/duplicate
        // `end_input` is harmless (`Queue.end` is idempotent) -- so calling this unconditionally, on
        // EVERY terminal status (not only the abrupt-stop/stall paths), is always safe.
        abortGeneration();
        resolveResultOnce({ status, content, resolvedModel: config.model, totalToolUseCount, totalDurationMs: Date.now() - startedAt });
      }
      currentSettle = settle;

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
            if (frame.type === "control_request") {
              forwardedHostRequestIds.add((frame as { requestId: string }).requestId);
              watchdog.pause();
            }
            try {
              runCtx.forwardChildFrame(frame, correlation);
            } catch {
              /* a torn-down parent stream must never crash this read loop */
            }
          }
        } catch {
          /* the channel ending is not itself an error */
        }
      })();

      void runEngine({
        config,
        input: channel.runtime.input,
        output: channel.runtime.output,
        provider: deps.provider,
        ...(writer !== undefined ? { store: writer } : {}),
        ...(initialMessages.length > 0 ? { initialMessages } : {}),
        env,
      }).catch(() => {
        settle("failed", "child engine process exited unexpectedly");
      });

      channel.host.output.write({ type: "user", text: liveText });
    }

    const baseConfig: RuntimeConfig = {
      sessionId: agentId,
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
      // Fix round 1 (finding I1): the parent's own `permissions.{allow,ask,deny}` rules and `hooks`
      // are now mirrored onto every child -- a construction-time SNAPSHOT (see ChildEngineFactoryDeps'
      // own header on `parentPermissionRules`/`parentHooks` for the residual live-update gap this
      // does NOT close). `disableBypassPermissionsMode` merges into the SAME `permissions` object
      // (RuntimeConfig.permissions is one combined shape, never two independent fields).
      ...(deps.disableBypassPermissionsMode !== undefined || deps.parentPermissionRules !== undefined
        ? {
            permissions: {
              ...(deps.parentPermissionRules ?? {}),
              ...(deps.disableBypassPermissionsMode !== undefined ? { disableBypassPermissionsMode: deps.disableBypassPermissionsMode } : {}),
            },
          }
        : {}),
      ...(deps.parentHooks !== undefined ? { hooks: deps.parentHooks } : {}),
      ...(deps.parentIncludeHookEvents !== undefined ? { includeHookEvents: deps.parentIncludeHookEvents } : {}),
      ...(deps.parentSandbox !== undefined ? { sandbox: deps.parentSandbox } : {}),
      ...(req.definition?.maxTurns !== undefined ? { maxTurns: req.definition.maxTurns } : {}),
    };

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
    const firstTurnText = [
      resolvedSystemPrompt.length > 0 ? `[Agent system prompt]\n${resolvedSystemPrompt}\n[End system prompt]` : undefined,
      req.definition?.initialPrompt,
      req.prompt,
      definitionWarnings.length > 0 ? `\n[winter: ${definitionWarnings.join("; ")}]` : undefined,
    ]
      .filter((s): s is string => s !== undefined && s.length > 0)
      .join("\n\n");

    startGeneration(baseConfig, initialMessages, firstTurnText);

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

        // A resume is itself a fresh spawn for accounting purposes -- the previous generation
        // already released its own slot on termination. `checkAndRegisterSpawn` THROWS
        // (SpawnDepthExceededError/SpawnConcurrencyExceededError) rather than returning a result --
        // this method's own return type is a `DeliveryOutcome`, which Lane D's messaging router
        // consumes directly (WS-10 §10) with no reason to expect `resume()` itself to throw. An
        // over-limit resume is exactly as legitimate a "the system is at capacity right now" outcome
        // as a fresh spawn hitting the same limit -- `retryable: true`, since concurrency (unlike the
        // gone-worktree case above) can free up on its own moments later.
        try {
          checkAndRegisterSpawn({ parentSessionId: runCtx.parentSessionId, childSessionId: agentId, env });
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
        const resumeConfig: RuntimeConfig =
          resumeMode === baseConfig.permissionMode ? baseConfig : { ...baseConfig, permissionMode: resumeMode, allowDangerouslySkipPermissions: resumeMode === "bypassPermissions" };
        startGeneration(resumeConfig, rebuilt, msg.body);
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

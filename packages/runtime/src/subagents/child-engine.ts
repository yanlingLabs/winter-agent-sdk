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
// (2) CHILD PERMISSION/HOOK CONTROL-RPC ROUTING: `child-handle.ts`'s own header comment (lines
// ~154-157) says control_request/control_response frames "correlate by their OWN requestId
// regardless of source... see engine.ts's own pump comment for how a response is routed back to
// whichever bridge, parent's or a child's, actually issued the matching request" -- but the ACTUAL
// frozen engine.ts pump (~line 1376) constructs exactly ONE `RpcBridge` per `runEngine()` call and
// calls `bridge.handleResponse(frame)` UNCONDITIONALLY against it, with no fallback to any child's
// own bridge. A child's own permission/hook control_request is forwarded (via
// `runCtx.forwardChildFrame`, fire-and-forget, one-way) up to the REAL top-level host; when that
// host answers, the `control_response` arrives on the PARENT's OWN real input stream, where the
// PARENT's OWN bridge finds an unknown requestId and drops it -- the CHILD's own bridge (which
// issued the request) never sees the answer, and the call hangs until this file's own stall
// watchdog eventually aborts it. This is a genuine discrepancy between child-handle.ts's own
// descriptive comment and the shipped, frozen engine.ts pump, not a misunderstanding of it -- fixing
// it requires either a new `ChildEngineRunContext` method engine.ts calls on an unmatched response,
// or the pump itself consulting the child roster, both engine.ts edits outside this lane's
// authority. CONSEQUENCE, disclosed rather than hidden: children spawned under `bypassPermissions`
// (a common, spec-legitimate case -- WS-07 §11 FORCES it onto descendants of a bypass parent) never
// hit this at all, since bypass mode resolves without ever issuing a permission control_request.
// Children spawned under a mode that can reach a genuine interactive prompt (`default`/`plan`/
// `acceptEdits` past its bounded-edit allowance/`auto` on a classifier miss) WILL hang on that one
// tool call today -- a real, bounded failure (the stall watchdog catches it), never a silent wrong
// answer or an unbounded hang. Verified explicitly by this lane's own tests (see child-engine.test.ts
// "a child under a prompting mode that reaches a real prompt stalls, and the watchdog catches it").
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
import { randomUUID } from "node:crypto";
import type { RuntimeConfig, WinterFrame, SessionStore } from "@yanlinglabs/winter-agent-sdk";
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

export interface ChildEngineFactoryDeps {
  provider: Provider;
  // Durable storage for child transcripts -- when omitted, children run WITHOUT persistence
  // (matching this codebase's own established `persistSession:false` behavior elsewhere: the engine
  // runs fine with no store, it just does not survive a restart, and `resume()` degrades to
  // "starts fresh with no rebuilt history," disclosed at that call site below).
  store?: SessionStore;
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
    const transcriptPath = `${projectKey}/${runCtx.parentSessionId}/${childTranscriptSubpath(agentId)}.jsonl`;

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
    // Both reassigned by EVERY startGeneration call, below -- `.stop()` (external to any one
    // generation) must route through the SAME gated `settle` a generation's own watchdog/observe()
    // use internally, never a parallel, ungated status mutation: otherwise a `.stop()` that races a
    // genuine (interrupted) "result" frame arriving moments later could have its own "stopped"
    // status silently overwritten back to "failed" by that frame's own observe()/settle() call,
    // since THAT call would see an unset generationSettled flag and proceed as if nothing had
    // settled yet. Routing both through the one gate makes whichever fires FIRST win, permanently.
    let currentSettle: ((status: "completed" | "failed" | "stopped", content: string) => void) | undefined;
    let currentAbort: (() => void) | undefined;

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
        settle("failed", err.message);
        abortGeneration();
      });

      function abortGeneration(): void {
        try {
          channel.host.output.write({ type: "control_request", requestId: randomUUID(), subtype: "interrupt", payload: undefined });
        } catch {
          /* a torn-down channel must never crash the abort path */
        }
        try {
          channel.host.output.write({ type: "control_request", requestId: randomUUID(), subtype: "end_input", payload: undefined });
        } catch {
          /* see above */
        }
      }
      currentAbort = abortGeneration;

      function settle(status: "completed" | "failed" | "stopped", content: string): void {
        if (generationSettled) return;
        generationSettled = true;
        record.status = status;
        watchdog.cancel();
        releaseSpawn(agentId);
        void writer?.writeMetadata({ ...record });
        // WS-10 §8: "auto-cleaned when unchanged" -- fire-and-forget, regardless of which terminal
        // status this generation reached (a stopped/failed child's own worktree is reclaimed exactly
        // like a completed one's, IF genuinely unchanged; real, undiscarded work is left in place
        // either way -- see workspace.ts's own cleanupWorkspace for the exact safety checks).
        void cleanupWorkspace(workspace);
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
      ...(deps.disableBypassPermissionsMode !== undefined ? { permissions: { disableBypassPermissionsMode: deps.disableBypassPermissionsMode } } : {}),
      ...(req.definition?.maxTurns !== undefined ? { maxTurns: req.definition.maxTurns } : {}),
    };

    const initialMessages = resolveForkInitialMessages(inherit);
    // WS-10 §2: `initialPrompt` is documented as "First user message seed." No provider-message
    // shape exists in this codebase for "an unanswered seed message followed immediately by a
    // second live user turn" (two consecutive user-role entries with no assistant turn between
    // them) -- concatenated into ONE live turn instead, a disclosed, deliberate simplification
    // rather than inventing an unproven provider-message shape.
    const firstTurnText = [req.definition?.initialPrompt, req.prompt, definitionWarnings.length > 0 ? `\n[winter: ${definitionWarnings.join("; ")}]` : undefined]
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
        // A resume is itself a fresh spawn for accounting purposes -- the previous generation
        // already released its own slot on termination.
        checkAndRegisterSpawn({ parentSessionId: runCtx.parentSessionId, childSessionId: agentId, env });

        let rebuilt: ProviderMessage[] = [];
        if (childStore !== undefined) {
          try {
            const raw = await TranscriptWriter.readBack(childStore, childKey);
            rebuilt = rebuildProviderMessages(toDialectEntries(raw));
          } catch {
            rebuilt = []; // an unreadable/corrupted transcript degrades to "resume with no history," never a crash
          }
        }
        // WS-07 §11's own "resume applies the stricter of recorded vs. current parent policy" is
        // NOT applied here: neither this method's own `GlobalAgentMessage` parameter nor anything
        // else reachable from child-engine.ts exposes the PARENT's CURRENT live policy state (gap
        // (2)'s identical root cause -- the frozen seam has no channel for it). The recorded
        // `record.permission.effectiveMode` is reused verbatim, which can only be EQUAL to or
        // STRICTER than a parent that has since loosened, and is a real, disclosed residual gap
        // only if the parent's own policy has since become STRICTER than what was recorded --
        // flagged in this lane's own report rather than silently assumed safe.
        record.status = "running";
        startGeneration(baseConfig, rebuilt, msg.body);
        return { status: "resumed_and_delivered", messageId: msg.messageId };
      },
      async result(): Promise<ChildResult> {
        return resultPromise;
      },
      async stop(): Promise<void> {
        if (record.status !== "running") return; // already terminal -- idempotent
        // Routed through the CURRENT generation's own gated `settle`/`abortGeneration` (never a
        // parallel, ungated status mutation) -- see startGeneration's own header comment on
        // `currentSettle`/`currentAbort` for why: whichever of {this stop, a genuine result frame
        // arriving moments later} reaches the gate FIRST wins, permanently, rather than racing to
        // silently overwrite one terminal status with another.
        currentSettle?.("stopped", "stopped by request");
        currentAbort?.();
      },
    };

    spawnRegistered = false; // ownership of the depth/concurrency slot has moved into the generation's own settle()/stop()
    return handle;
  } catch (err) {
    if (spawnRegistered) releaseSpawn(agentId);
    throw err;
  }
}

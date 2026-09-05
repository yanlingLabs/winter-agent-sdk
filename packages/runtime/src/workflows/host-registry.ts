// Phase 5 Lane W (task 4): the SESSION-SCOPED registration seam the Workflow tool reads.
//
// WHY THIS EXISTS. `WorkflowRunHost` (workflows/seam.ts, frozen) bundles four things a run needs:
// `createTask`, `spawnAgent`, `structured` and `accountant`. A tool executor is handed a
// `ToolExecutionContext`, and that context carries exactly TWO of the ingredients -- `emitFrame` +
// `createBackgroundTask` for the first, `session.spawnChild` for the second. It carries NEITHER the
// structured-output seam NOR the context accountant, and it carries neither the session's
// `winterHome` nor its `projectKey`, which capture (3)'s persisted-script path is built from.
// `tools/registry.ts` and `engine.ts` are both frozen to this lane (R5-12), so there is no way to add
// them to the context.
//
// So this is the same shape every other lane reached for when it needed run-scoped state a frozen
// context could not carry: a module singleton with a `register` / `get` / `resetForTest` trio
// (`messaging/router.ts`'s `registerMessagingRuntime`, `toolsearch/search.ts`'s session runtime,
// `subagents/child-handle.ts`'s factory). With nothing registered, the Workflow tool answers a typed
// tool error rather than crashing -- the identical inert-default posture those modules document.
//
// ENGINE WIRING LANDED IN T8 (rider 21): `engine.ts` registers once per run and withdraws at
// teardown, so the Workflow tool is live rather than inert. What is still owed there is the
// SESSION KEY -- see `registerWorkflowSession` below.
import type { RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import type { ContextAccountant } from "../engine.ts";
import type { StructuredOutputSeam } from "../structured/seam.ts";

export interface WorkflowSessionRuntime {
  /**
   * THE REGISTRATION KEY (fix wave, whole-branch I5). The engine's own `config.sessionId`.
   *
   * OPTIONAL ONLY FOR COMPILE COMPATIBILITY, and the omission is not the intended shape: an
   * unkeyed registration lands in the single legacy slot below, which is exactly the
   * one-live-session-per-process assumption I5 is about. `engine.ts` (the sole production
   * registrant) is another lane's file in this wave and still omits it -- see this module's own
   * "PRODUCTION WIRING" note.
   *
   * A CHILD engine reaches the registration site with its PARENT's `config.sessionId`, which is why
   * registration is FIRST-WINS: see `registerWorkflowSession`.
   */
  sessionId?: string;
  /** The `.winter` directory this session persists under -- `resolveWinterHome()`'s value, whose `projects/` child holds the session area. */
  winterHome: string;
  /** `compatibilityKeys(cwd).transcriptProjectKey`, after `resolveProjectDirName` -- the SAME key the transcript store uses, never a second derivation. */
  projectKey: string;
  /** The session's own temp directory (paths/temp.ts) -- where per-run journals live (store.ts's `workflowRunsDir`). */
  sessionTempDir: string;
  /** Borrowed from Lane K through the seam (R5-12's named W->K coupling) -- never a second validator. */
  structured: StructuredOutputSeam;
  /** The session's live context accounting. Passed straight to `WorkflowRunHost.accountant`. */
  accountant: ContextAccountant;
  /**
   * The session's CUMULATIVE token spend, for `budget.spent()` -- RULING P5-J (spine, fix wave).
   *
   * Deliberately NOT `accountant.contextTokens()`, which is the last provider call's context SIZE:
   * an overwrite rather than an accumulation, non-monotonic, and blind to a workflow's own agents
   * (each child builds its own accountant). Absent = `spent()` reports 0 and a ceiling never trips,
   * which is honest; substituting the wrong quantity would look plausible and bound nothing.
   *
   * P5-J is expected to add the counter to `ContextAccountant` and route child usage into the
   * parent's; when it lands, T8 wires that accessor here.
   */
  spentTokens?: () => number;
  /**
   * The workflow budget ceiling, if the host set one. `null`/absent is the DEFAULT and means no
   * ceiling (WS-11 §1.6 as amended by the task brief). No `WorkflowInput` field carries this -- it is
   * a host/session-level setting, which is why it arrives here rather than through the tool call.
   */
  budgetTotal?: number | null;
  /**
   * Resolves `agent({ agentType })` against the SAME registry the Agent tool uses (WS-11 §1.6:
   * "a custom subagent type resolved from the same registry as the Agent tool"). Injected rather
   * than called directly so this module keeps no dependency on `subagents/definitions.ts`, and so a
   * host that has already loaded its definitions does not make the runtime re-read the filesystem
   * once per `agent()` call.
   *
   * Absent = no custom types resolve; `agent({agentType})` then spawns a child whose definition
   * records the unresolved name (runtime.ts's `resolveChildDefinition`), never a silent generic one.
   */
  resolveAgentType?(
    agentType: string,
    ctx: { cwd: string; trustedWorkspace: boolean },
  ): RuntimeAgentDefinition | undefined;
}

// --- The registry (fix wave, whole-branch I5: SESSION-KEYED) --------------------------------------
//
// WHAT I5 FOUND. This was `let active` -- one runtime per PROCESS. In a host that runs two live
// sessions (the daemon), session B's first `Workflow` call read whatever session A had registered:
// B's script persisted under A's `projects/<key>/` directory, B's budget read A's accountant, and
// A's teardown answered "no workflow runtime is configured for this session" for B. Every sibling
// registry this file's header cites as precedent -- `skills/runtime.ts`, `toolsearch/search.ts`,
// `mcp/lifecycle.ts`'s `registerSessionMcpLifecycle` -- is keyed by session or agent id.
const bySession = new Map<string, WorkflowSessionRuntime>();
// The pre-I5 slot, kept for exactly one caller: a registration that supplies no `sessionId`. See
// `registerWorkflowSession`.
let legacyUnkeyed: WorkflowSessionRuntime | undefined;

/**
 * Register this session's runtime and return an IDENTITY-CHECKED disposer (the shape
 * `registerSessionMcpLifecycle` already uses): the disposer withdraws the registration only while it
 * is still the one this call made, so a stopped-and-immediately-restarted run's late teardown cannot
 * remove the live generation's runtime.
 *
 * FIRST-WINS PER SESSION ID, deliberately. A CHILD engine reaches the production registration site
 * (`engine.ts`) with `config.sessionId` -- which for a child IS the parent's id -- because the child
 * is given the parent's structured-output seam, the condition that site gates on. Last-wins would
 * therefore let a child replace its parent's registration mid-run (different `sessionTempDir`,
 * different `projectKey`) and withdraw it at the child's teardown: the daemon defect, reachable
 * inside one session. First-wins makes the child's register/dispose pair a no-op, which is also the
 * "children resolve against the parent's registration" reading the seam already documents.
 *
 * PRODUCTION WIRING IS **NEEDS_CONTEXT** (this wave's lane split): `engine.ts` is another lane's
 * file, so its two call sites still pass no `sessionId` and still call `clearWorkflowSession()` with
 * no argument -- which is why the legacy slot below exists and why production behaviour is BYTE
 * IDENTICAL to the pre-fix build until those two lines change to
 * `registerWorkflowSession({ sessionId: config.sessionId, ... })` and `disposeWorkflowSession?.()`.
 */
export function registerWorkflowSession(runtime: WorkflowSessionRuntime): () => void {
  const key = runtime.sessionId;
  if (key === undefined) {
    legacyUnkeyed = runtime;
    return () => {
      if (legacyUnkeyed === runtime) legacyUnkeyed = undefined;
    };
  }
  if (bySession.has(key)) return () => {}; // first-wins: a child's registration never displaces its parent's
  bySession.set(key, runtime);
  return () => {
    if (bySession.get(key) === runtime) bySession.delete(key);
  };
}

/**
 * The runtime registered for `sessionId`, or the legacy unkeyed one when no keyed registration
 * exists for it (the pre-I5 production path, unchanged). `undefined` when nothing is registered at
 * all -- the Workflow tool answers a typed tool error rather than crashing.
 */
export function getWorkflowSession(sessionId?: string): WorkflowSessionRuntime | undefined {
  if (sessionId !== undefined) {
    const keyed = bySession.get(sessionId);
    if (keyed !== undefined) return keyed;
  }
  return legacyUnkeyed;
}

/**
 * Withdraw one session's registration. PRODUCTION teardown calls this (engine.ts, at the end of
 * every run) for the reason the registration shape makes concrete: a run that left its registration
 * standing would let a LATER session's Workflow call persist its script under the finished session's
 * `projects/<key>/<uuid>/` directory.
 *
 * With no argument it clears the LEGACY slot only -- never the whole map. Clearing every session
 * would reinstate I5 in the other direction: one run's teardown disabling every other live session's
 * workflows.
 *
 * AT ENGINE TEARDOWN, USE THE DISPOSER `registerWorkflowSession` RETURNS -- never
 * `clearWorkflowSession(config.sessionId)`. First-wins protects REGISTRATION from a child engine
 * (which arrives with its parent's `config.sessionId`); only the identity-checked disposer protects
 * WITHDRAWAL from the same child, whose teardown would otherwise delete its still-running parent's
 * entry by key. This by-key form is for a host that is genuinely ending that session.
 */
export function clearWorkflowSession(sessionId?: string): void {
  if (sessionId === undefined) {
    legacyUnkeyed = undefined;
    return;
  }
  bySession.delete(sessionId);
}

/**
 * Test-only: clears EVERY registration, keyed and legacy. Same rationale as every sibling singleton
 * in this codebase: bun's test runner shares ONE module instance across every file in a run, so one
 * file's registration would otherwise leak into another's assertions.
 */
export function resetWorkflowSessionForTest(): void {
  bySession.clear();
  legacyUnkeyed = undefined;
}

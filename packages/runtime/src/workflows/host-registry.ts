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
// ENGINE WIRING IS **NEEDS_CONTEXT** for T8: nothing in this branch calls `registerWorkflowSession`,
// because the one file that could (engine.ts) is frozen. Until it does, the Workflow tool is
// registered and inert. The report names this as the lane's single production-wiring gap.
import type { ContextAccountant } from "../engine.ts";
import type { StructuredOutputSeam } from "../structured/seam.ts";

export interface WorkflowSessionRuntime {
  /** The `.winter` directory this session persists under -- `resolveWinterHome()`'s value, whose `projects/` child holds the session area. */
  winterHome: string;
  /** `compatibilityKeys(cwd).transcriptProjectKey`, after `resolveProjectDirName` -- the SAME key the transcript store uses, never a second derivation. */
  projectKey: string;
  /** The session's own temp directory (paths/temp.ts) -- where per-run journals live (store.ts's `workflowRunsDir`). */
  sessionTempDir: string;
  /** Borrowed from Lane K through the seam (R5-12's named W->K coupling) -- never a second validator. */
  structured: StructuredOutputSeam;
  /** The session's live accounting -- what `budget.spent()` reads. */
  accountant: ContextAccountant;
  /**
   * The workflow budget ceiling, if the host set one. `null`/absent is the DEFAULT and means no
   * ceiling (WS-11 §1.6 as amended by the task brief). No `WorkflowInput` field carries this -- it is
   * a host/session-level setting, which is why it arrives here rather than through the tool call.
   */
  budgetTotal?: number | null;
}

let active: WorkflowSessionRuntime | undefined;

export function registerWorkflowSession(runtime: WorkflowSessionRuntime): void {
  active = runtime;
}

export function getWorkflowSession(): WorkflowSessionRuntime | undefined {
  return active;
}

/**
 * Test-only escape hatch, same rationale as every sibling singleton in this codebase: bun's test
 * runner shares ONE module instance across every file in a run, so one file's registration would
 * otherwise leak into another's assertions.
 */
export function resetWorkflowSessionForTest(): void {
  active = undefined;
}

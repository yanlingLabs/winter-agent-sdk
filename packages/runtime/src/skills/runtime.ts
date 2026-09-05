// Phase 5 Lane S: the per-session skill runtime the Skill executor resolves.
//
// SHAPE AND PRECEDENT: a session-keyed side registry, exactly like
// `toolsearch/search.ts`'s `registerToolSearchSessionRuntime`. It exists for the same reason that
// one does -- `ToolResultPayload` is `{ output, isError? }` and `ToolExecutionContext` is frozen to
// this lane (R5-12), so a tool executor has no other channel to reach session state or to hand an
// attachment back. A module singleton keyed by session id is the established Winter answer, and
// engine.ts already registers ToolSearch's twin per run.
//
// KEYED BY `agentId ?? sessionId`, matching tool-search.ts's own key exactly and for the identical
// reason: a child engine carries its PARENT's `config.sessionId`, so keying by session alone would
// resolve a child's invocation against the parent's `skills` option. A child restricted to no skills
// would silently inherit the parent's whole set.
import type { SkillsOption } from "@yanlinglabs/winter-agent-sdk";
import type { InvokedSkillsAttachment } from "./attachment.ts";
import type { SkillOverrides } from "./listing.ts";
import type { SkillIndex } from "./store.ts";

export interface SkillSessionRuntime {
  index: SkillIndex;
  /** This session's `Options.skills`. Absent means every indexed skill (capture (4)). */
  skills?: SkillsOption | undefined;
  /** `Settings.skillOverrides` for this session. */
  skillOverrides?: SkillOverrides | undefined;
  /**
   * The attachment SINK. Absent is legitimate (a host that does not persist attachments), and the
   * executor still returns the body -- the attachment is a record of the invocation, never a
   * precondition for it. A throwing sink must never fail the tool call, so the executor guards it.
   */
  onInvoked?: ((attachment: InvokedSkillsAttachment) => void) | undefined;
}

const runtimes = new Map<string, SkillSessionRuntime>();

export function registerSkillSessionRuntime(key: string, runtime: SkillSessionRuntime): void {
  runtimes.set(key, runtime);
}

export function getSkillSessionRuntime(key: string): SkillSessionRuntime | undefined {
  return runtimes.get(key);
}

/** Called on run teardown. A registry that only ever grows would leak an index per session. */
export function clearSkillSessionRuntime(key: string): void {
  runtimes.delete(key);
}

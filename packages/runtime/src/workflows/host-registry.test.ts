// Phase 5 fix wave (whole-branch I5): the workflow host registry is SESSION-KEYED.
//
// The finding this file pins: `host-registry.ts` held ONE runtime per process (`let active`), so in
// a multi-session host (the daemon) session B's `Workflow` call built its runtime from session A's
// `winterHome`/`projectKey`/`accountant`/`structured` -- persisting B's script under A's project
// key -- and A's teardown answered "no workflow runtime is configured" for B. Every sibling
// registry in this codebase (`skills/runtime.ts`, `toolsearch/search.ts`, `mcp/lifecycle.ts`'s
// `registerSessionMcpLifecycle`) is keyed by session/agent id; this one was keyed by nothing.
//
// FIRST-WINS, not last-wins, is the second half of the fix and it is not a stylistic choice: a CHILD
// engine reaches the same registration site (`engine.ts:1957`) with the PARENT's `config.sessionId`
// (`subagents/child-engine.ts:576` hands the child the parent's structured seam, which is the
// condition that site gates on). Last-wins would let a child's registration replace its parent's mid
// run and its teardown withdraw it -- the same defect as the daemon case, reachable in one session.
import { afterEach, describe, expect, test } from "bun:test";
import { registerWorkflowSession, getWorkflowSession, clearWorkflowSession, resetWorkflowSessionForTest, type WorkflowSessionRuntime } from "./host-registry.ts";
import { fakeStructuredOutputSeam } from "../structured/seam.ts";
import { createContextAccountant } from "../engine.ts";

function runtime(sessionId: string | undefined, projectKey: string): WorkflowSessionRuntime {
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    winterHome: `/synthetic/${projectKey}/.winter`,
    projectKey,
    sessionTempDir: `/synthetic/${projectKey}/tmp`,
    structured: fakeStructuredOutputSeam(),
    accountant: createContextAccountant({ limit: 100_000 }),
  };
}

afterEach(() => {
  resetWorkflowSessionForTest();
});

describe("I5 -- one registration per SESSION, never one per process", () => {
  test("two live sessions each resolve their OWN runtime", () => {
    registerWorkflowSession(runtime("sess-A", "-proj-a"));
    registerWorkflowSession(runtime("sess-B", "-proj-b"));

    expect(getWorkflowSession("sess-A")?.projectKey).toBe("-proj-a");
    expect(getWorkflowSession("sess-B")?.projectKey).toBe("-proj-b");
  });

  test("session A's teardown leaves session B's registration standing", () => {
    registerWorkflowSession(runtime("sess-A", "-proj-a"));
    registerWorkflowSession(runtime("sess-B", "-proj-b"));

    clearWorkflowSession("sess-A");

    expect(getWorkflowSession("sess-A")).toBeUndefined();
    expect(getWorkflowSession("sess-B")?.projectKey).toBe("-proj-b");
  });

  test("a CHILD registering under its parent's session id does not displace the parent, and its disposer is a no-op", () => {
    const parent = runtime("sess-A", "-parent");
    const disposeParent = registerWorkflowSession(parent);
    // The child engine reaches the same site with `config.sessionId` -- the PARENT's id.
    const disposeChild = registerWorkflowSession(runtime("sess-A", "-child"));

    expect(getWorkflowSession("sess-A")?.projectKey).toBe("-parent");
    disposeChild();
    expect(getWorkflowSession("sess-A")?.projectKey).toBe("-parent");

    disposeParent();
    expect(getWorkflowSession("sess-A")).toBeUndefined();
  });

  test("the disposer is IDENTITY-CHECKED: a stale run's teardown cannot withdraw the live registration under the same id", () => {
    const first = registerWorkflowSession(runtime("sess-A", "-gen1"));
    clearWorkflowSession("sess-A"); // generation 1 ends
    registerWorkflowSession(runtime("sess-A", "-gen2")); // generation 2 starts under the same id

    first(); // generation 1's late teardown

    expect(getWorkflowSession("sess-A")?.projectKey).toBe("-gen2");
  });

  test("an UNKEYED registration stays resolvable by any session -- the pre-fix engine wiring is unchanged", () => {
    // engine.ts still registers without a `sessionId` (its two lines are the main writer's file in
    // this wave); until they pass one, lookup falls back to the single legacy slot exactly as before.
    registerWorkflowSession(runtime(undefined, "-legacy"));
    expect(getWorkflowSession("any-session")?.projectKey).toBe("-legacy");
    clearWorkflowSession();
    expect(getWorkflowSession("any-session")).toBeUndefined();
  });

  test("a KEYED registration wins over a legacy one for its own session, and the legacy one still serves the rest", () => {
    registerWorkflowSession(runtime(undefined, "-legacy"));
    registerWorkflowSession(runtime("sess-A", "-keyed"));

    expect(getWorkflowSession("sess-A")?.projectKey).toBe("-keyed");
    expect(getWorkflowSession("sess-B")?.projectKey).toBe("-legacy");
  });
});

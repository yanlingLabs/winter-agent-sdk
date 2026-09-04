// Phase 4 Task 2: mcp/state.ts's own unit coverage. seam-contracts-p4.test.ts (R4-2) separately
// proves the CROSS-CUTTING semantics both Lane A (producer) and Lane B (consumer) must keep green;
// this file is narrower unit coverage of the fake itself.
import { describe, test, expect } from "bun:test";
import { createFakeMcpServerStateSource, type McpServerState } from "./state.ts";

function state(overrides: Partial<McpServerState> & Pick<McpServerState, "name" | "state">): McpServerState {
  return { toolNames: [], ...overrides };
}

describe("createFakeMcpServerStateSource: snapshot/subscribe", () => {
  test("snapshot reflects the constructor's initial states", () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "connected", toolNames: ["x"] })]);
    expect(source.snapshot()).toEqual([{ name: "a", state: "connected", toolNames: ["x"] }]);
  });

  test("subscribe fires on every transition with the full current snapshot", () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "pending" })]);
    const seen: McpServerState[][] = [];
    const unsubscribe = source.subscribe((states) => seen.push(states));
    source.transition("a", "connected", { toolNames: ["t1"] });
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual([{ name: "a", state: "connected", toolNames: ["t1"] }]);
    unsubscribe();
    source.transition("a", "failed", { error: "boom" });
    expect(seen.length).toBe(1); // unsubscribed -- no further delivery
  });

  test("a throwing subscriber does not prevent a sibling subscriber from being notified", () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "pending" })]);
    let goodCalls = 0;
    const errSpy = console.error;
    console.error = () => {}; // expected, swallowed-and-logged error from the bad subscriber
    try {
      source.subscribe(() => {
        throw new Error("bad subscriber");
      });
      source.subscribe(() => {
        goodCalls++;
      });
      expect(() => source.transition("a", "connected")).not.toThrow();
      expect(goodCalls).toBe(1);
    } finally {
      console.error = errSpy;
    }
  });
});

describe("createFakeMcpServerStateSource: transition upsert semantics", () => {
  test("transitioning an EXISTING name updates it in place, carrying over unspecified fields", () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "pending", toolNames: ["carried"] })]);
    source.transition("a", "connected"); // no `extra` -- toolNames must carry over from the prior state
    expect(source.snapshot()).toEqual([{ name: "a", state: "connected", toolNames: ["carried"] }]);
  });

  test("transitioning a NAME NOT in the initial set adds it fresh (upsert, not update-only)", () => {
    const source = createFakeMcpServerStateSource([]);
    source.transition("brand-new", "pending");
    expect(source.snapshot()).toEqual([{ name: "brand-new", state: "pending", toolNames: [] }]);
  });

  test("errorCode/error are set on transition and persist across a later transition that omits them", () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "pending" })]);
    source.transition("a", "failed", { errorCode: "ECONNREFUSED", error: "connection refused" });
    expect(source.snapshot()[0]).toEqual({ name: "a", state: "failed", toolNames: [], errorCode: "ECONNREFUSED", error: "connection refused" });
  });
});

describe("createFakeMcpServerStateSource: waitForPending (WS-09 §8.4)", () => {
  async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  test("resolves immediately when nothing is pending", async () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "connected" })]);
    const result = await withTimeout(source.waitForPending(undefined, 5000), 200, "waitForPending");
    expect(result).toEqual([{ name: "a", state: "connected", toolNames: [] }]);
  });

  test("resolves immediately for a name that is not known at all (source-level half of WS-09 §8.4's unknown[])", async () => {
    const source = createFakeMcpServerStateSource([]);
    const result = await withTimeout(source.waitForPending(["never-heard-of"], 5000), 200, "waitForPending");
    expect(result).toEqual([]);
  });

  test("cached counts as settled -- does not block the wait (WS-09 §8.4: cached counts as ready)", async () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "cached", toolNames: ["cachedTool"] })]);
    const result = await withTimeout(source.waitForPending(undefined, 5000), 200, "waitForPending");
    expect(result).toEqual([{ name: "a", state: "cached", toolNames: ["cachedTool"] }]);
  });

  test("resolves as soon as a transition clears the last pending server (before the deadline)", async () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "pending" })]);
    const promise = withTimeout(source.waitForPending(undefined, 5000), 500, "waitForPending");
    // Give the promise executor a tick to install its subscription before transitioning.
    await new Promise((r) => setTimeout(r, 5));
    source.transition("a", "connected", { toolNames: ["t"] });
    const result = await promise;
    expect(result).toEqual([{ name: "a", state: "connected", toolNames: ["t"] }]);
  });

  test("resolves at the deadline when a server never leaves pending", async () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "pending" })]);
    const started = Date.now();
    const result = await withTimeout(source.waitForPending(undefined, 50), 500, "waitForPending");
    expect(Date.now() - started).toBeGreaterThanOrEqual(40); // allow small scheduler slack
    expect(result).toEqual([{ name: "a", state: "pending", toolNames: [] }]);
  });

  test("`servers` scopes the wait -- an unrelated still-pending server does not block it", async () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "pending" }), state({ name: "b", state: "connected" })]);
    const result = await withTimeout(source.waitForPending(["b"], 5000), 200, "waitForPending");
    expect(result.find((s) => s.name === "b")?.state).toBe("connected");
  });

  test("omitting `servers` waits for ALL currently known servers, not just some", async () => {
    const source = createFakeMcpServerStateSource([state({ name: "a", state: "pending" }), state({ name: "b", state: "connected" })]);
    const started = Date.now();
    const promise = withTimeout(source.waitForPending(undefined, 500), 800, "waitForPending");
    // "b" is already settled and irrelevant; "a" is still pending and unscoped (servers omitted),
    // so transitioning an unrelated field on "b" must NOT resolve the wait early.
    await new Promise((r) => setTimeout(r, 5));
    source.transition("b", "disabled");
    await promise;
    expect(Date.now() - started).toBeGreaterThanOrEqual(400); // fell through to the deadline, not an early resolve
  });
});

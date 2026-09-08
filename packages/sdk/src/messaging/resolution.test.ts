import { describe, test, expect } from "bun:test";
import { resolveTarget, childToListedRuntimeObject, type ResolutionInputs } from "./resolution.ts";
import { serializeRuntimeAddress, type ListedRuntimeObject } from "./adapter.ts";
import { sameAddress } from "./addressing.ts";
import { createFakeChild } from "./child-fake.test-support.ts";
import type { ChildLike } from "./adapter.ts";

const PARENT = "parent-1"; // matches createFakeChild's own default ChildLikeRecord.parentSessionId

function peerRow(overrides: Partial<ListedRuntimeObject> & { winterSessionId: string }): ListedRuntimeObject {
  const { winterSessionId, ...rest } = overrides;
  return {
    address: serializeRuntimeAddress({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId }),
    objectKind: "session",
    runtimeKind: "winter-agent",
    status: "running",
    mode: "default",
    capabilities: { message: true, resume: false, notifyWhenIdle: true, reply: true },
    ...rest,
  };
}

function baseInputs(overrides: Partial<ResolutionInputs> = {}): ResolutionInputs {
  return { to: "", callerParentSessionId: PARENT, children: [], peers: [], ...overrides };
}

describe("childToListedRuntimeObject", () => {
  test("a running child maps to status running, message:true, resume:false", () => {
    const child = createFakeChild({ id: "c1", name: "worker" });
    const row = childToListedRuntimeObject(PARENT, child);
    expect(row.status).toBe("running");
    expect(row.objectKind).toBe("agent");
    expect(row.name).toBe("worker");
    expect(row.capabilities).toEqual({ message: true, resume: false, notifyWhenIdle: false, reply: true });
    expect(row.address).toBe(`agent:${PARENT}:c1`);
  });
  test("a completed (terminal) child maps to status exited, message:false, resume:true", () => {
    const child = createFakeChild({ id: "c1" });
    child.setStatus("completed");
    const row = childToListedRuntimeObject(PARENT, child);
    expect(row.status).toBe("exited");
    expect(row.capabilities).toEqual({ message: false, resume: true, notifyWhenIdle: false, reply: false });
  });
  test("a child with no name omits the name field entirely (never name: undefined)", () => {
    const child = createFakeChild({ id: "c1" });
    const row = childToListedRuntimeObject(PARENT, child);
    expect("name" in row).toBe(false);
  });
});

describe("resolveTarget rule 1: exact canonical address wins", () => {
  test("resolves a canonical agent address to its ChildLike when owned by the caller's parent", () => {
    const child = createFakeChild({ id: "c1" });
    const result = resolveTarget(baseInputs({ to: `agent:${PARENT}:c1`, children: [child] }));
    expect(result).toEqual({ kind: "resolved", address: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: PARENT, parentWinterSessionId: PARENT, childId: "c1" }, child });
  });
  test("a canonical agent address owned by a DIFFERENT parent is not_found (not reachable from another parent, WS-10 §10.3)", () => {
    const child = createFakeChild({ id: "c1", parentSessionId: "s_other" });
    const result = resolveTarget(baseInputs({ to: "agent:s_other:c1", children: [child] }));
    expect(result.kind).toBe("not_found");
  });
  test("resolves a canonical session address when a matching peer row exists", () => {
    const peer = peerRow({ winterSessionId: "s_peer" });
    const result = resolveTarget(baseInputs({ to: "session:s_peer", peers: [peer] }));
    expect(result).toEqual({ kind: "resolved", address: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_peer" } });
  });
  test("a canonical session address with no matching peer row is not_found", () => {
    const result = resolveTarget(baseInputs({ to: "session:s_ghost" }));
    expect(result.kind).toBe("not_found");
  });
  test("canonical resolution takes priority even when a same-named child or peer also exists", () => {
    const child = createFakeChild({ id: "c1", name: `agent:${PARENT}:c1` }); // a maliciously confusing display name
    const result = resolveTarget(baseInputs({ to: `agent:${PARENT}:c1`, children: [child] }));
    expect(result.kind).toBe("resolved");
  });
});

describe("resolveTarget rule 2: a stable child ID within the caller's owning parent wins over a name", () => {
  test("resolves a bare child id directly", () => {
    const child = createFakeChild({ id: "c1" });
    const result = resolveTarget(baseInputs({ to: "c1", children: [child] }));
    expect(result).toEqual({ kind: "resolved", address: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: PARENT, parentWinterSessionId: PARENT, childId: "c1" }, child });
  });
  test("a child id belonging to a DIFFERENT parent is invisible to this lookup (falls through to name resolution, then not_found)", () => {
    const child = createFakeChild({ id: "c1", parentSessionId: "s_other" });
    const result = resolveTarget(baseInputs({ to: "c1", children: [child] }));
    expect(result.kind).toBe("not_found");
  });
  test("a child id wins even when some OTHER child has that same string as its display name", () => {
    const target = createFakeChild({ id: "c1" });
    const decoy = createFakeChild({ id: "c2", name: "c1" });
    const result = resolveTarget(baseInputs({ to: "c1", children: [target, decoy] }));
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.child?.record.id).toBe("c1");
  });
});

describe("resolveTarget rule 3: a display name resolves only when exactly one eligible object owns it", () => {
  test("resolves a uniquely-named child", () => {
    const child = createFakeChild({ id: "c1", name: "researcher" });
    const result = resolveTarget(baseInputs({ to: "researcher", children: [child] }));
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.child?.record.id).toBe("c1");
  });
  test("resolves a uniquely-named peer session", () => {
    const peer = peerRow({ winterSessionId: "s_peer", name: "planner" });
    const result = resolveTarget(baseInputs({ to: "planner", peers: [peer] }));
    expect(result).toEqual({ kind: "resolved", address: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_peer" } });
  });
  test("a name belonging to a child of a DIFFERENT parent is not visible to this caller", () => {
    const child = createFakeChild({ id: "c1", name: "researcher", parentSessionId: "s_other" });
    const result = resolveTarget(baseInputs({ to: "researcher", children: [child] }));
    expect(result.kind).toBe("not_found");
  });
});

describe("resolveTarget rule 4: ambiguity returns candidates, never an arbitrary choice", () => {
  test("two peers sharing a display name are ambiguous", () => {
    const peerA = peerRow({ winterSessionId: "s_a", name: "dup" });
    const peerB = peerRow({ winterSessionId: "s_b", name: "dup" });
    const result = resolveTarget(baseInputs({ to: "dup", peers: [peerA, peerB] }));
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates).toEqual(expect.arrayContaining([peerA, peerB]));
  });
  test("a child and a peer sharing a display name are ambiguous", () => {
    const child = createFakeChild({ id: "c1", name: "dup" });
    const peer = peerRow({ winterSessionId: "s_a", name: "dup" });
    const result = resolveTarget(baseInputs({ to: "dup", children: [child], peers: [peer] }));
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates).toEqual(expect.arrayContaining([peer, expect.objectContaining({ objectKind: "agent" })]));
    }
  });
});

describe("resolveTarget rule 5: a name previously used by a different child triggers a stale-name refusal", () => {
  test("two children (one terminal, one current) that both ever held the same name -> stale, not resolved/ambiguous", () => {
    const first = createFakeChild({ id: "c1", name: "assistant" });
    first.setStatus("completed");
    const second = createFakeChild({ id: "c2", name: "assistant" });
    const result = resolveTarget(baseInputs({ to: "assistant", children: [first, second] }));
    expect(result.kind).toBe("stale");
  });
  test("a stale name is still reachable via its canonical address (rule 1 bypasses the staleness check)", () => {
    const first = createFakeChild({ id: "c1", name: "assistant" });
    const second = createFakeChild({ id: "c2", name: "assistant" });
    const canonical = resolveTarget(baseInputs({ to: `agent:${PARENT}:c2`, children: [first, second] }));
    expect(canonical.kind).toBe("resolved");
    const byName = resolveTarget(baseInputs({ to: "assistant", children: [first, second] }));
    expect(byName.kind).toBe("stale");
  });
});

describe("resolveTarget rule 6 (names never grant permission) -- resolution never returns a permission/capability, only identity", () => {
  test("a resolved child result carries no permission-bearing field beyond the address/handle", () => {
    const child = createFakeChild({ id: "c1", name: "x" });
    const result = resolveTarget(baseInputs({ to: "x", children: [child] }));
    expect(Object.keys(result).sort()).toEqual(["address", "child", "kind"]);
  });
});

describe("resolveTarget: not_found", () => {
  test("an unrecognized name/id with nothing registered is not_found", () => {
    const result = resolveTarget(baseInputs({ to: "nobody-by-this-name" }));
    expect(result.kind).toBe("not_found");
  });
});

// --- Fix r1 (I2): a resolved address carries the ROW's declared runtime kind -------------------------
//
// The finding: `parseRuntimeAddress` can only ever stamp a default, because WS-10 §11's serialized
// form deliberately carries no runtime kind. `resolveTarget` used to hand that default straight back,
// so a `claude-agent` peer row resolved to a `winter-agent`-typed address -- and the router picks its
// ADAPTER by that field, which would have sent every Claude-driven session to the Winter branch.
describe("runtime kind: the peer ROW is authoritative, never the parsed address", () => {
  const claudePeer = peerRow({ winterSessionId: "s_claude", name: "reviewer", runtimeKind: "claude-agent" });

  test("resolving a claude-agent peer BY NAME yields a claude-agent address", () => {
    const result = resolveTarget(baseInputs({ to: "reviewer", peers: [claudePeer] }));
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.address.runtimeKind).toBe("claude-agent");
    expect(result.address.winterSessionId).toBe("s_claude");
  });

  test("resolving the SAME peer by its CANONICAL address yields it too -- both branches carry the kind", () => {
    // Rule 1 and rule 3 are separate code paths and only one of them used to be wrong in a way a test
    // would notice; pinning both is what keeps a future edit from fixing one and leaving the other.
    const result = resolveTarget(baseInputs({ to: claudePeer.address, peers: [claudePeer] }));
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.address.runtimeKind).toBe("claude-agent");
  });

  test("a CHILD still resolves as winter-agent -- a child of a Winter session is one by construction", () => {
    const child = createFakeChild({ id: "c1", name: "worker" });
    const result = resolveTarget(baseInputs({ to: "worker", children: [child] }));
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.address.runtimeKind).toBe("winter-agent");
  });

  test("sameAddress is unaffected: two addresses differing ONLY in runtimeKind are the same object", () => {
    // The serialized form carries no kind, which is why the overlay is needed at all -- and why
    // identity comparisons must not start disagreeing now that the field actually varies.
    const winter = { objectKind: "session" as const, runtimeKind: "winter-agent" as const, winterSessionId: "s_claude" };
    const claude = { ...winter, runtimeKind: "claude-agent" as const };
    expect(sameAddress(winter, claude)).toBe(true);
  });
});

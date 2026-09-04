// Pure unit tests for roster.ts (WS-10 §7): drives a REAL WinterCompatibilitySessionStore against a
// temp winterHome (matching child-engine.test.ts's own "durable resume" precedent) but writes
// agent_metadata sidecars DIRECTLY via store.append -- never through a real spawned child -- so this
// suite stays a fast, isolated proof of the rebuild logic itself, independent of child-engine.ts's
// own much heavier engine-level proof.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WinterCompatibilitySessionStore } from "@yanlinglabs/winter-agent-sdk";
import { childTranscriptSubpath } from "../store/dialect.ts";
import { rebuildChildRoster, successfulRecords } from "./roster.ts";
import type { ChildSessionRecord } from "./child-handle.ts";

const projectKey = "roster-test-project";
const parentSessionId = "parent-1";

function fakeRecord(agentId: string, overrides: Partial<ChildSessionRecord> = {}): ChildSessionRecord {
  return {
    id: agentId,
    parentSessionId,
    parentToolUseId: `call-${agentId}`,
    transcript: `${projectKey}/${parentSessionId}/${childTranscriptSubpath(agentId)}.jsonl`,
    status: "completed",
    runtime: "winter-agent",
    model: { effectiveModel: "sonnet", effectiveEffort: "inherit" },
    permission: { effectiveMode: "bypassPermissions", parentPolicyHash: "h1", parentPolicyVersion: 1 },
    ...overrides,
  };
}

const tempDirs: string[] = [];
function mkWinterHome(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-lane-c-roster-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("rebuildChildRoster (WS-10 §7)", () => {
  test("no children at all -> an empty roster, never an error", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toEqual([]);
  });

  test("rebuilds a metadata-only child (one that never produced native transcript output)", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    const agentId = "a1";
    const childKey = { projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath(agentId) };
    await store.append(childKey, [{ type: "agent_metadata", ...fakeRecord(agentId) }]);

    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toEqual({ ok: true, record: fakeRecord(agentId) });
  });

  test("rebuilds multiple children, each keeping its own record distinct", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    for (const agentId of ["a1", "a2", "a3"]) {
      const childKey = { projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath(agentId) };
      await store.append(childKey, [{ type: "agent_metadata", ...fakeRecord(agentId, { status: agentId === "a2" ? "failed" : "completed" }) }]);
    }
    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(3);
    const records = successfulRecords(roster);
    expect(records.map((r) => r.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(records.find((r) => r.id === "a2")?.status).toBe("failed");
  });

  test("writeMetadata's own 'wholesale replace' semantics -- a SECOND append supersedes the first, never accumulates", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    const agentId = "a1";
    const childKey = { projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath(agentId) };
    await store.append(childKey, [{ type: "agent_metadata", ...fakeRecord(agentId, { status: "running" }) }]);
    await store.append(childKey, [{ type: "agent_metadata", ...fakeRecord(agentId, { status: "completed" }) }]);

    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toEqual({ ok: true, record: fakeRecord(agentId, { status: "completed" }) });
  });

  test("a child transcript with a native entry but NO agent_metadata sidecar surfaces as a legible ok:false, not a crash", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    const agentId = "a1";
    const childKey = { projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath(agentId) };
    // A bare native-shaped entry (no `uuid`, so validateChain's own chain check does not choke on
    // it) with no agent_metadata alongside it -- e.g. a sidecar deleted out of band.
    await store.append(childKey, [{ type: "summary", text: "not a real child metadata entry" }]);

    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(1);
    expect(roster[0]!.ok).toBe(false);
    if (!roster[0]!.ok) {
      expect(roster[0]!.agentId).toBe(agentId);
      expect(roster[0]!.reason).toContain("no agent_metadata sidecar");
    }
  });

  test("a corrupted/malformed agent_metadata sidecar (missing required fields) surfaces as ok:false, not a crash or a bogus record", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    const agentId = "a1";
    const childKey = { projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath(agentId) };
    await store.append(childKey, [{ type: "agent_metadata", id: agentId /* missing parentSessionId/parentToolUseId/status */ }]);

    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(1);
    expect(roster[0]!.ok).toBe(false);
    if (!roster[0]!.ok) expect(roster[0]!.reason).toContain("corrupted");
  });

  test("one bad child's own storage never prevents the REST of the roster from rebuilding", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    await store.append({ projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath("good") }, [{ type: "agent_metadata", ...fakeRecord("good") }]);
    await store.append({ projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath("bad") }, [{ type: "summary", text: "no metadata here" }]);

    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(2);
    const good = roster.find((r) => r.ok && r.record.id === "good");
    const bad = roster.find((r) => !r.ok && r.agentId === "bad");
    expect(good?.ok).toBe(true);
    expect(bad?.ok).toBe(false);
  });

  test("a DIFFERENT parent session's children are never mixed into this roster", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    await store.append({ projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath("mine") }, [{ type: "agent_metadata", ...fakeRecord("mine") }]);
    await store.append({ projectKey, sessionId: "other-parent", subpath: childTranscriptSubpath("theirs") }, [{ type: "agent_metadata", ...fakeRecord("theirs", { parentSessionId: "other-parent" }) }]);

    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(1);
    expect(successfulRecords(roster).map((r) => r.id)).toEqual(["mine"]);
  });

  test("fix round 1 (finding I4): a restart-orphaned 'running' record is reconciled to a terminal 'stopped' status, marked reconciled:'orphaned', never left permanently stuck", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    const agentId = "orphan-1";
    const childKey = { projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath(agentId) };
    // The daemon died mid-run -- the LAST sidecar write this child ever got was its own spawn-time
    // "running" write; nothing ever settled it to a terminal status.
    await store.append(childKey, [{ type: "agent_metadata", ...fakeRecord(agentId, { status: "running" }) }]);

    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(1);
    const entry = roster[0]!;
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.record.status).toBe("stopped");
      expect(entry.reconciled).toBe("orphaned");
      // Every OTHER field survives the reconciliation untouched -- only `status` changes.
      expect(entry.record).toEqual({ ...fakeRecord(agentId, { status: "running" }), status: "stopped" });
    }
    // successfulRecords() surfaces the reconciled (now-terminal) record like any other -- a caller
    // that only wants "the roster" sees a resumable child, never a permanently-stuck "running" one.
    expect(successfulRecords(roster)).toEqual([{ ...fakeRecord(agentId, { status: "running" }), status: "stopped" }]);
  });

  test("a NORMAL terminal record (never running at rebuild time) is never marked reconciled", async () => {
    const store = new WinterCompatibilitySessionStore({ winterHome: mkWinterHome() });
    const agentId = "normal-1";
    await store.append({ projectKey, sessionId: parentSessionId, subpath: childTranscriptSubpath(agentId) }, [{ type: "agent_metadata", ...fakeRecord(agentId, { status: "completed" }) }]);

    const roster = await rebuildChildRoster(store, { projectKey, sessionId: parentSessionId });
    expect(roster).toHaveLength(1);
    const entry = roster[0]!;
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.reconciled).toBeUndefined();
      expect(entry.record.status).toBe("completed");
    }
  });
});

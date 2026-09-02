// Task 11 (WS-07 §9): the durable approval store's own fixture corpus. Most behavior is exercised
// against BOTH implementations (in-memory + file-backed) via `withEachStore` below — the interface
// contract must not silently drift between the ephemeral test double and the real thing. File-only
// concerns (directory/file permissions, persistence surviving a fresh store instance) get their own
// dedicated describe block, mirroring ruleset.test.ts's own real-fs regime for the permission
// journal (mkdtempSync + realpathSync, for the identical macOS-symlink reason documented there).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, statSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemoryApprovalStore,
  createFileDurableApprovalStore,
  revalidateApproval,
  DurableApprovalStoreError,
  WINTER_RUNTIME_KIND,
  type DurableApprovalStore,
  type DurableApprovalRecord,
  type RevalidationContext,
} from "./approvals.ts";

function tmpHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-approvals-")));
}

function approval(overrides: Partial<DurableApprovalRecord> = {}): DurableApprovalRecord {
  return {
    runtimeKind: WINTER_RUNTIME_KIND,
    sessionId: "sess-1",
    backendSessionId: "sess-1",
    requestId: "req-1",
    toolUseID: "tool-1",
    toolName: "Bash",
    originalInput: { command: "long-running-thing" },
    displayMetadata: { decisionReason: "a PreToolUse hook deferred this call" },
    policyMode: "default",
    policyVersion: 0,
    issuedAt: "2026-09-02T00:00:00.000Z",
    state: "pending",
    issuedCwd: "/work",
    issuedHome: "/synthetic/home/tester",
    ...overrides,
  };
}

function ctxFor(a: DurableApprovalRecord, overrides: Partial<RevalidationContext> = {}): RevalidationContext {
  return {
    runtimeKind: a.runtimeKind,
    sessionId: a.sessionId,
    backendSessionId: a.backendSessionId,
    toolUseID: a.toolUseID,
    policyMode: a.policyMode,
    policyVersion: a.policyVersion,
    cwd: a.issuedCwd,
    home: a.issuedHome,
    ...overrides,
  };
}

// --- shared contract: both implementations must agree ----------------------------------------------

function withEachStore(name: string, run: (make: () => DurableApprovalStore) => void): void {
  describe(`${name} [in-memory]`, () => run(() => createInMemoryApprovalStore()));
  describe(`${name} [file-backed]`, () => run(() => createFileDurableApprovalStore({ winterHome: tmpHome(), projectKey: "proj", sessionId: "sess-1" })));
}

withEachStore("record + get", (make) => {
  test("a recorded approval is retrievable, state pending", () => {
    const store = make();
    store.record(approval());
    const found = store.get("req-1");
    expect(found?.state).toBe("pending");
    expect(found?.toolName).toBe("Bash");
  });

  test("get() on an unknown requestId is undefined, never a throw", () => {
    const store = make();
    expect(store.get("nope")).toBeUndefined();
  });
});

withEachStore("respond() — first-response-wins with mechanism provenance", (make) => {
  test("allow transitions pending -> allowed, resolution carries mechanism", () => {
    const store = make();
    store.record(approval());
    const result = store.respond("req-1", { outcome: "allowed", mechanism: "canUseTool" });
    expect(result.applied).toBe(true);
    expect(result.record.state).toBe("allowed");
    expect(result.record.resolution?.mechanism).toBe("canUseTool");
  });

  test("deny transitions pending -> denied, message carried", () => {
    const store = make();
    store.record(approval());
    const result = store.respond("req-1", { outcome: "denied", mechanism: "hook", message: "no" });
    expect(result.record.state).toBe("denied");
    expect(result.record.resolution?.message).toBe("no");
  });

  test("a second response is a typed no-op — first mechanism/outcome survives (WS-08 §7.4 provenance)", () => {
    const store = make();
    store.record(approval());
    const first = store.respond("req-1", { outcome: "allowed", mechanism: "hook" });
    expect(first.applied).toBe(true);
    const second = store.respond("req-1", { outcome: "denied", mechanism: "canUseTool" });
    expect(second.applied).toBe(false);
    const final = store.get("req-1")!;
    expect(final.state).toBe("allowed"); // NOT denied — the first response wins
    expect(final.resolution?.mechanism).toBe("hook"); // provenance of the FIRST responder preserved
  });

  test("race shape: a PermissionRequest hook answers first, a later canUseTool-shaped answer is the no-op", () => {
    const store = make();
    store.record(approval());
    const hookAnswer = store.respond("req-1", { outcome: "allowed", mechanism: "hook", message: "hook approved it" });
    expect(hookAnswer.applied).toBe(true);
    const canUseToolAnswer = store.respond("req-1", { outcome: "allowed", mechanism: "canUseTool" });
    expect(canUseToolAnswer.applied).toBe(false);
    expect(store.get("req-1")!.resolution?.mechanism).toBe("hook");
  });

  test("respond() on an unknown requestId throws DurableApprovalStoreError (never a silent no-op)", () => {
    const store = make();
    expect(() => store.respond("ghost", { outcome: "allowed", mechanism: "hook" })).toThrow(DurableApprovalStoreError);
  });

  test("T8-CARRY: decisionClassification is persisted on resolution (first real consumer of T8's plumbing)", () => {
    const store = make();
    store.record(approval());
    const result = store.respond("req-1", { outcome: "allowed", mechanism: "canUseTool", decisionClassification: "user_permanent" });
    expect(result.record.resolution?.decisionClassification).toBe("user_permanent");
    expect(store.get("req-1")!.resolution?.decisionClassification).toBe("user_permanent");
  });

  test("a responder's transformedInput is carried on the resolution (durable analog of canUseTool's updatedInput)", () => {
    const store = make();
    store.record(approval());
    store.respond("req-1", { outcome: "allowed", mechanism: "hook", transformedInput: { command: "sanitized" } });
    expect(store.get("req-1")!.resolution?.transformedInput).toEqual({ command: "sanitized" });
  });
});

withEachStore("pendingFor / listFor", (make) => {
  test("pendingFor returns only state:pending records for the given session", () => {
    const store = make();
    store.record(approval({ requestId: "req-1" }));
    store.record(approval({ requestId: "req-2" }));
    store.respond("req-2", { outcome: "allowed", mechanism: "hook" });
    const pending = store.pendingFor({ sessionId: "sess-1" });
    expect(pending.map((r) => r.requestId)).toEqual(["req-1"]);
  });

  test("listFor returns every record regardless of state", () => {
    const store = make();
    store.record(approval({ requestId: "req-1" }));
    store.record(approval({ requestId: "req-2" }));
    store.respond("req-2", { outcome: "denied", mechanism: "hook" });
    const all = store.listFor({ sessionId: "sess-1" });
    expect(all.map((r) => r.requestId).sort()).toEqual(["req-1", "req-2"]);
  });

  test("a different session's records are never returned", () => {
    const store = make();
    store.record(approval({ requestId: "req-1", sessionId: "sess-1" }));
    store.record(approval({ requestId: "req-2", sessionId: "sess-2" }));
    expect(store.listFor({ sessionId: "sess-1" }).map((r) => r.requestId)).toEqual(["req-1"]);
    expect(store.listFor({ sessionId: "sess-2" }).map((r) => r.requestId)).toEqual(["req-2"]);
  });
});

withEachStore("cancelPendingFor — mode-switch semantics (WS-07 §2)", (make) => {
  test("cancels every pending record for the session, leaves already-resolved ones untouched", () => {
    const store = make();
    store.record(approval({ requestId: "req-1" }));
    store.record(approval({ requestId: "req-2" }));
    store.respond("req-2", { outcome: "allowed", mechanism: "hook" });
    store.cancelPendingFor({ sessionId: "sess-1" }, "mode switched to plan");
    expect(store.get("req-1")!.state).toBe("cancelled");
    expect(store.get("req-1")!.resolution?.reason).toBe("mode switched to plan");
    expect(store.get("req-2")!.state).toBe("allowed"); // untouched — was never pending by the time this ran
  });

  test("a no-op when nothing is pending", () => {
    const store = make();
    store.record(approval({ requestId: "req-1" }));
    store.respond("req-1", { outcome: "denied", mechanism: "hook" });
    expect(() => store.cancelPendingFor({ sessionId: "sess-1" }, "mode switch")).not.toThrow();
    expect(store.get("req-1")!.state).toBe("denied");
  });
});

withEachStore("expire — revalidation-mismatch-driven transition", (make) => {
  test("transitions a pending record to expired", () => {
    const store = make();
    store.record(approval());
    store.expire("req-1", "session mismatch");
    expect(store.get("req-1")!.state).toBe("expired");
    expect(store.get("req-1")!.resolution?.reason).toBe("session mismatch");
  });

  test("transitions an allowed-but-not-yet-consumed record to expired (revalidation runs before execution)", () => {
    const store = make();
    store.record(approval());
    store.respond("req-1", { outcome: "allowed", mechanism: "hook" });
    store.expire("req-1", "policy drift");
    expect(store.get("req-1")!.state).toBe("expired");
  });

  test("never retroactively expires an already-consumed (executed) approval", () => {
    const store = make();
    store.record(approval());
    store.respond("req-1", { outcome: "allowed", mechanism: "hook" });
    store.markConsumed("req-1", { output: "it ran" });
    store.expire("req-1", "too late");
    expect(store.get("req-1")!.state).toBe("allowed"); // NOT expired -- already executed
    expect(store.get("req-1")!.consumedResult).toBe("it ran");
  });
});

withEachStore("markConsumed — exactly-once execution bookkeeping", (make) => {
  test("records the executed result", () => {
    const store = make();
    store.record(approval());
    store.respond("req-1", { outcome: "allowed", mechanism: "hook" });
    store.markConsumed("req-1", { output: "42" });
    const record = store.get("req-1")!;
    expect(record.consumedAt).toBeDefined();
    expect(record.consumedResult).toBe("42");
    expect(record.consumedIsError).toBeUndefined();
  });

  test("first execution wins — a second markConsumed call for the same requestId is a no-op", () => {
    const store = make();
    store.record(approval());
    store.respond("req-1", { outcome: "allowed", mechanism: "hook" });
    store.markConsumed("req-1", { output: "first result" });
    store.markConsumed("req-1", { output: "second result" });
    expect(store.get("req-1")!.consumedResult).toBe("first result");
  });

  test("records an error result with consumedIsError", () => {
    const store = make();
    store.record(approval());
    store.respond("req-1", { outcome: "allowed", mechanism: "hook" });
    store.markConsumed("req-1", { output: "[error: boom]", isError: true });
    expect(store.get("req-1")!.consumedIsError).toBe(true);
  });
});

// --- revalidateApproval — the 5 axes, each its own fixture (WS-07 §9) --------------------------------

describe("revalidateApproval — the 5 revalidation axes", () => {
  test("happy path: every axis matches -> ok", () => {
    const a = approval();
    expect(revalidateApproval(a, ctxFor(a))).toEqual({ ok: true });
  });

  test("axis: session mismatch", () => {
    const a = approval();
    const v = revalidateApproval(a, ctxFor(a, { sessionId: "sess-OTHER" }));
    expect(v).toEqual({ ok: false, axis: "session", reason: expect.stringContaining("session mismatch") });
  });

  test("axis: toolUseID mismatch", () => {
    const a = approval();
    const v = revalidateApproval(a, ctxFor(a, { toolUseID: "tool-OTHER" }));
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ axis: "toolCall" });
  });

  test("axis: mode+policyVersion mismatch (mode differs)", () => {
    const a = approval();
    const v = revalidateApproval(a, ctxFor(a, { policyMode: "bypassPermissions" }));
    expect(v).toMatchObject({ ok: false, axis: "policy" });
  });

  test("axis: mode+policyVersion mismatch (version differs)", () => {
    const a = approval();
    const v = revalidateApproval(a, ctxFor(a, { policyVersion: 7 }));
    expect(v).toMatchObject({ ok: false, axis: "policy" });
  });

  test("axis: normalized paths/destinations drift (relative path now resolves elsewhere under a new cwd)", () => {
    const a = approval({ toolName: "Edit", originalInput: { file_path: "notes.txt" }, issuedCwd: "/work/a" });
    const v = revalidateApproval(a, ctxFor(a, { cwd: "/work/b" }));
    expect(v).toMatchObject({ ok: false, axis: "paths" });
  });

  test("axis: paths do NOT drift when cwd is unchanged, even for a path-bearing tool", () => {
    const a = approval({ toolName: "Edit", originalInput: { file_path: "notes.txt" }, issuedCwd: "/work/a" });
    expect(revalidateApproval(a, ctxFor(a))).toEqual({ ok: true });
  });

  test("axis: runtime ownership mismatch (backendSessionId differs)", () => {
    const a = approval();
    const v = revalidateApproval(a, ctxFor(a, { backendSessionId: "some-other-backend" }));
    expect(v).toMatchObject({ ok: false, axis: "runtime" });
  });

  test("axis: runtime ownership mismatch (runtimeKind differs)", () => {
    const a = approval();
    const v = revalidateApproval(a, ctxFor(a, { runtimeKind: "claude-agent" }));
    expect(v).toMatchObject({ ok: false, axis: "runtime" });
  });
});

// --- file-backed specifics: directory/file hardening + persistence across a fresh instance ----------

describe("createFileDurableApprovalStore — real fs (mirrors ruleset.ts's permission-journal discipline)", () => {
  test("creates the projects/<projectKey> dir chain at 0700 and the jsonl file at 0600 on first write", () => {
    const home = tmpHome();
    const store = createFileDurableApprovalStore({ winterHome: home, projectKey: "proj", sessionId: "sess-1" });
    store.record(approval());
    const path = join(home, "projects", "proj", "sess-1.approvals.jsonl");
    expect((statSync(path).mode & 0o777)).toBe(0o600);
    expect((statSync(join(home, "projects", "proj")).mode & 0o777)).toBe(0o700);
  });

  test("every line is a distinguishable envelope, never a bare record/response", () => {
    const home = tmpHome();
    const store = createFileDurableApprovalStore({ winterHome: home, projectKey: "proj", sessionId: "sess-1" });
    store.record(approval());
    store.respond("req-1", { outcome: "allowed", mechanism: "hook" });
    const lines = readFileSync(join(home, "projects", "proj", "sess-1.approvals.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe("record");
    expect(JSON.parse(lines[1]!).kind).toBe("response");
  });

  test("persistence: a FRESH store instance over the same location replays prior state (process-exit-and-resume)", () => {
    const home = tmpHome();
    const location = { winterHome: home, projectKey: "proj", sessionId: "sess-1" };
    const first = createFileDurableApprovalStore(location);
    first.record(approval());
    first.respond("req-1", { outcome: "allowed", mechanism: "canUseTool", decisionClassification: "user_temporary" });

    // A brand-new store object, as a resumed process would construct — no shared in-memory state
    // with `first` at all, only the same on-disk location.
    const second = createFileDurableApprovalStore(location);
    const record = second.get("req-1");
    expect(record?.state).toBe("allowed");
    expect(record?.resolution?.mechanism).toBe("canUseTool");
    expect(record?.resolution?.decisionClassification).toBe("user_temporary");
  });

  test("persistence: first-response-wins survives a reload too (two responses appended before any reload)", () => {
    const home = tmpHome();
    const location = { winterHome: home, projectKey: "proj", sessionId: "sess-1" };
    const first = createFileDurableApprovalStore(location);
    first.record(approval());
    first.respond("req-1", { outcome: "allowed", mechanism: "hook" });
    // A second, unguarded low-level append simulating a racing writer that skipped the in-process
    // guard (e.g. two separate processes appending concurrently) -- respond() itself already
    // refuses this in-process (tested above); this proves the REPLAY fold is equally strict.
    expect(() => first.respond("req-1", { outcome: "denied", mechanism: "canUseTool" })).not.toThrow();

    const reloaded = createFileDurableApprovalStore(location);
    expect(reloaded.get("req-1")!.state).toBe("allowed");
  });

  test("a session with nothing deferred yet has no file and reads back an empty store", () => {
    const home = tmpHome();
    const store = createFileDurableApprovalStore({ winterHome: home, projectKey: "proj", sessionId: "sess-1" });
    expect(store.listFor({ sessionId: "sess-1" })).toEqual([]);
    expect(store.get("anything")).toBeUndefined();
  });
});

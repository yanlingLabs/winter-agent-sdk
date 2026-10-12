import { afterEach, expect, test, spyOn } from "bun:test";
import * as childRegistry from "../subagents/child-handle.ts";
import * as providerState from "../store/provider-state.ts";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WinterCompatibilitySessionStore, compatibilityKeys, encodeFrame, splitFrames, TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY, type RuntimeConfig, type PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import { runEmbeddedSession } from "../embedded.ts";
import { Queue } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { echoProvider } from "../provider/mock.ts";
import type { ChildHandle } from "../subagents/child-handle.ts";
import { buildChildTranscriptWriter, resolveEngineSession } from "../store/dialect.ts";
import { readHookAuditJournal } from "../permissions/ruleset.ts";
import { durableOperationGuard } from "../store/durable-authority.ts";
import type { DurableApprovalRecord } from "../permissions/approvals.ts";
import { createFileDurableApprovalStore } from "../permissions/approvals.ts";
import { createFileAutoCounterStore } from "../permissions/auto/caches.ts";
import { acquireProtectedStoreBootstrap, createProtectedRuntimeStore, createProtectedStoreBootstrap, releaseProtectedStoreBootstrap, type ProtectedStoreOwnershipPort, type ProtectedStoreOwner, type ProtectedStoreScope, type PreviousBootTerminationEvidence, type ProtectedStoreOwnershipOutcome } from "./store-bootstrap.ts";

const boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", previous = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Deliberately synthetic: proves adapter plumbing and scope checks, NEVER native exclusion,
 * cross-process ownership, guest death, namespace cleanup or a passed VM gate. */
class SyntheticOwnershipPort implements ProtectedStoreOwnershipPort {
  holders = new Map<string, string>();
  releases = 0;
  mode: "true" | "absent" | "false" | "wrong-scope" | "wrong-boot" | "wrong-owner" = "true";
  teardown: "confirmed-stopped" | "uncertain" | "absent" = "confirmed-stopped";
  proofs = 0;
  proofMismatch: keyof ProtectedStoreScope = "incarnationId";
  failRelease = false;
  failTeardownProof = false;
  wrongTeardownScope = false;
  identityUnavailable = false;
  async acquire(scope: Readonly<ProtectedStoreScope>): Promise<ProtectedStoreOwner> {
    const key = `${scope.storeHome}/${scope.sessionId}`;
    if (this.holders.has(key)) throw new Error("synthetic owner already held");
    const ownerToken = `synthetic-${Math.random()}`;
    this.holders.set(key, ownerToken);
    return {
      scope, ownerToken, signal: new AbortController().signal,
      assertHeld: () => { if (this.holders.get(key) !== ownerToken) throw new Error("synthetic owner lost"); },
      processIdentity: pid => !this.identityUnavailable && pid === process.pid ? { bootId: scope.currentBootId, startTicks: "123" } : null,
      previousBootTermination: previousBootId => {
        this.proofs++;
        if (this.mode === "absent") return null;
        if (this.mode === "false") return false as unknown as PreviousBootTerminationEvidence;
        return { scope: this.mode === "wrong-scope" ? { ...scope, [this.proofMismatch]: this.proofMismatch === "leaseEpoch" ? scope.leaseEpoch + 1 : "another" } : scope,
          ownerToken: this.mode === "wrong-owner" ? "unrelated" : ownerToken,
          previousBootId: this.mode === "wrong-boot" ? boot : previousBootId };
      },
      runtimeTeardownEvidence: () => {
        if (this.failTeardownProof) throw new Error("synthetic teardown proof failed");
        return this.teardown === "absent" ? null : { scope: this.wrongTeardownScope ? { ...scope, leaseEpoch: scope.leaseEpoch + 1 } : scope, ownerToken, outcome: this.teardown };
      },
      release: async () => { if (this.failRelease) throw new Error("synthetic release failed"); if (this.holders.get(key) !== ownerToken) throw new Error("not our synthetic hold"); this.holders.delete(key); this.releases++; },
    };
  }
}
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-protected-bootstrap-"))); directories.push(dir);
  const storeHome = join(dir, "store"), cwd = join(dir, "workspace"); mkdirSync(storeHome); mkdirSync(cwd);
  const scope: ProtectedStoreScope = { workspaceId: "workspace", sessionId: "conversation", incarnationId: "incarnation", leaseEpoch: 2, storeHome, currentBootId: boot };
  const config: RuntimeConfig = { sessionId: scope.sessionId, cwd, winterHome: storeHome, storeHome, model: "winter-test/calls", settingSources: [], sandbox: { enabled: false }, autoMemory: { enabled: false }, allowedTools: ["Agent", "SendMessage", "ListAgents"], forwardSubagentText: true };
  const project = compatibilityKeys(cwd).transcriptProjectKey;
  const lock = join(storeHome, "projects", project, `${scope.sessionId}.lock`);
  const env = { WINTER_HOME: storeHome, WINTER_STORE_HOME: storeHome, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY };
  const port = new SyntheticOwnershipPort();
  return { scope, config, project, lock, env, port };
}
function stale(f: ReturnType<typeof fixture>) {
  mkdirSync(join(f.scope.storeHome, "projects", f.project), { recursive: true });
  const bytes = JSON.stringify({ pid: process.pid, startTimeMs: 0, processIdentity: { bootId: previous, startTicks: "123" } });
  writeFileSync(f.lock, bytes); return bytes;
}
async function entry(f: ReturnType<typeof fixture>, prompt: string, config: RuntimeConfig = f.config, capability = createProtectedStoreBootstrap(f.scope, f.port)) {
  const frames: string[] = [], diagnostics: string[] = [], outcomes: ProtectedStoreOwnershipOutcome[] = [];
  const code = await runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify(config)], env: f.env,
    protectedStoreBootstrap: capability,
    onProtectedStoreOwnershipOutcome: outcome => outcomes.push(outcome),
    input: { async *[Symbol.asyncIterator]() { yield encodeFrame({ type: "user", text: prompt }); } },
    write: chunk => frames.push(chunk), writeErr: chunk => diagnostics.push(chunk) });
  return { code, frames: frames.join(""), diagnostics: diagnostics.join(""), outcomes };
}

test("missing native ownership adapter and forged/cloned capabilities fail closed", async () => {
  const f = fixture();
  expect(() => createProtectedStoreBootstrap(f.scope)).toThrow("native_owner_unavailable");
  const capability = createProtectedStoreBootstrap(f.scope, f.port);
  await expect(acquireProtectedStoreBootstrap(JSON.parse(JSON.stringify(capability)), f.config, f.scope.storeHome)).rejects.toThrow("bootstrap_invalid");
  const result = await entry(f, "nothing", f.config, {} as typeof capability);
  expect(result.code).toBe(1); expect(result.frames).toBe(""); expect(f.port.holders.size).toBe(0);
  expect(result.outcomes).toEqual([{ status: "not-acquired", reason: "bootstrap-invalid", scope: null }]);
});

test.each(["absent", "false", "wrong-scope", "wrong-boot", "wrong-owner"] as const)("real embedded entry refuses %s previous-boot evidence without replacing bytes", async mode => {
  const f = fixture(); const bytes = stale(f); f.port.mode = mode;
  const result = await entry(f, "must not run");
  expect(result.code).toBe(1); expect(result.frames).toBe("");
  expect(readFileSync(f.lock, "utf8")).toBe(bytes); expect(f.port.proofs).toBe(1); expect(f.port.releases).toBe(1);
});

test.each(["workspaceId", "sessionId", "incarnationId", "leaseEpoch", "storeHome", "currentBootId"] as const)("termination proof is bound to exact %s", async field => {
  const f = fixture(); const bytes = stale(f); f.port.mode = "wrong-scope"; f.port.proofMismatch = field;
  const result = await entry(f, "must not run");
  expect(result.code).toBe(1); expect(result.frames).toBe(""); expect(readFileSync(f.lock, "utf8")).toBe(bytes);
});

test("owner loss refuses existing stores and failed native release is never reported as released", async () => {
  const f = fixture(); const bootstrap = createProtectedStoreBootstrap(f.scope, f.port);
  const capability = await acquireProtectedStoreBootstrap(bootstrap, f.config, f.scope.storeHome);
  const store = createProtectedRuntimeStore(capability, f.scope.storeHome);
  await expect(acquireProtectedStoreBootstrap(bootstrap, f.config, f.scope.storeHome)).rejects.toThrow("bootstrap_in_use");
  f.port.holders.clear();
  await expect(store.acquireSessionLease({ projectKey: f.project, sessionId: f.scope.sessionId })).rejects.toThrow("synthetic owner lost");
  const second = fixture();
  const next = await acquireProtectedStoreBootstrap(createProtectedStoreBootstrap(second.scope, second.port), second.config, second.scope.storeHome);
  second.port.failRelease = true;
  expect(await releaseProtectedStoreBootstrap(next)).toMatchObject({ status: "release-failed", reason: "native-release-failed", scope: second.scope });
  expect(await releaseProtectedStoreBootstrap(next)).toMatchObject({ status: "release-failed" });
  expect(second.port.holders.size).toBe(1); expect(second.port.releases).toBe(0);
});

test("exact scoped prior-boot proof reaches actual root store, even with identical PID and ticks", async () => {
  const f = fixture(); stale(f);
  const capability = await acquireProtectedStoreBootstrap(createProtectedStoreBootstrap(f.scope, f.port), f.config, f.scope.storeHome);
  const resolved = await resolveEngineSession({ config: f.config, resolveWinterHome: () => f.scope.storeHome, env: f.env, protectedStoreBootstrap: capability });
  expect(JSON.parse(readFileSync(f.lock, "utf8")).processIdentity).toEqual({ bootId: boot, startTicks: "123" });
  await resolved.store!.recordUserEntry("PERSISTED_ROOT_MARKER");
  expect(readFileSync(f.lock.replace(/\.lock$/, ".jsonl"), "utf8")).toContain("PERSISTED_ROOT_MARKER");
  const concrete = createProtectedRuntimeStore(capability, f.scope.storeHome);
  await expect(concrete.acquireSessionLease({ projectKey: f.project, sessionId: "sibling" })).rejects.toThrow("scope_mismatch");
  await expect(concrete.load({ projectKey: f.project, sessionId: "sibling", subpath: "subagents/agent-other" })).rejects.toThrow("scope_mismatch");
  await expect(concrete.delete({ projectKey: f.project, sessionId: "sibling" })).rejects.toThrow("scope_mismatch");
  const sibling = new WinterCompatibilitySessionStore({ winterHome: f.scope.storeHome });
  await sibling.append({ projectKey: f.project, sessionId: "sibling" }, [{ type: "user", text: "sibling fixture" }]);
  expect((await concrete.listSessions(f.project)).map(session => session.sessionId)).toEqual([f.scope.sessionId]);
  expect((await concrete.listSessionSummaries(f.project)).map(session => session.sessionId)).toEqual([f.scope.sessionId]);
  expect(await releaseProtectedStoreBootstrap(capability)).toMatchObject({ status: "released" });
  await expect(concrete.load({ projectKey: f.project, sessionId: f.scope.sessionId })).rejects.toThrow("owner_lost");
});

test.each(["session", "root", "resume", "continue", "fork"] as const)("trusted bootstrap refuses wrong %s scope before ownership or store access", async mismatch => {
  const f = fixture(); const bytes = stale(f);
  const config = { ...f.config, ...(mismatch === "session" ? { sessionId: "sibling" } : mismatch === "root" ? { storeHome: f.config.cwd } : mismatch === "resume" ? { resume: "sibling" } : mismatch === "continue" ? { continue: true } : { forkSession: true }) };
  const result = await entry(f, "must not run", config);
  expect(result.code).toBe(1); expect(result.frames).toBe(""); expect(f.port.proofs).toBe(0); expect(f.port.releases).toBe(0); expect(readFileSync(f.lock, "utf8")).toBe(bytes);
  expect(result.outcomes).toEqual([{ status: "not-acquired", reason: "scope-mismatch", scope: f.scope }]);
});

test("JSON/env recovery lookalikes never enter the trusted injection path", async () => {
  const f = fixture(); expect((await entry(f, "seed")).code).toBe(0); const bytes = stale(f);
  const frames: string[] = [], diagnostics: string[] = [];
  const config = { ...f.config, resume: f.scope.sessionId, protectedStoreBootstrap: { scope: f.scope, previousBootTerminated: true }, leaseIdentity: { confirmPreviousBootTerminated: true } };
  const code = await runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify(config)], env: { ...f.env, WINTER_PREVIOUS_BOOT_TERMINATED: "true" },
    input: { async *[Symbol.asyncIterator]() {} }, write: c => frames.push(c), writeErr: c => diagnostics.push(c) });
  // This host runs macOS: foreign Linux leases also refuse without a Linux identity probe.
  expect(code).toBe(1); expect(frames).toEqual([]); expect(readFileSync(f.lock, "utf8")).toBe(bytes); expect(f.port.proofs).toBe(0);
});

test("a real sealed bootstrap never bypasses the confined-guest startup hard refusal", async () => {
  const f = fixture(); const bytes = stale(f);
  const result = await entry(f, "must not run", { ...f.config, executionPosture: "confined-guest" });
  expect(result.code).toBe(1); expect(result.frames).toBe(""); expect(result.diagnostics).toContain("no local execution fallback");
  expect(f.port.holders.size).toBe(0); expect(f.port.proofs).toBe(0); expect(readFileSync(f.lock, "utf8")).toBe(bytes);
  expect(result.outcomes).toEqual([{ status: "not-acquired", reason: "startup-refused", scope: f.scope }]);
});

test("two actual embedded opens compete for one synthetic owner, held while the first runtime is pending", async () => {
  const f = fixture(); const input = new Queue<string>(); let initialized!: () => void;
  const ready = new Promise<void>(resolve => { initialized = resolve; });
  const first = runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify(f.config)], env: f.env, input,
    protectedStoreBootstrap: createProtectedStoreBootstrap(f.scope, f.port),
    onProtectedStoreOwnershipOutcome: () => {},
    write: chunk => { if (splitFrames(chunk, "").frames.some(frame => frame.type === "init")) initialized(); }, writeErr: () => {} });
  await ready;
  expect(f.port.holders.size).toBe(1); expect(f.port.releases).toBe(0);
  const competing = await entry(f, "must not run");
  expect(competing.code).toBe(1); expect(competing.frames).toBe(""); expect(competing.diagnostics).toContain("synthetic owner already held");
  expect(f.port.releases).toBe(0);
  input.end(); expect(await first).toBe(0); expect(f.port.releases).toBe(1);
}, 10_000);

test.each(["uncertain", "absent"] as const)("completed runtime retains owner on %s native teardown acknowledgement", async teardown => {
  const f = fixture(); f.port.teardown = teardown;
  const result = await entry(f, "done");
  expect(result.code).toBe(0); expect(result.diagnostics).toContain("ownership retained, recovery required");
  expect(result.outcomes).toEqual([{ status: "retained", reason: "teardown-unconfirmed", scope: f.scope }]);
  expect(f.port.holders.size).toBe(1); expect(f.port.releases).toBe(0);
  expect((await entry(f, "must not run")).code).toBe(1);
});

test.each([false, true])("a pending descendant teardown retains ownership; failed cleanup is observed (%s)", async fail => {
  const f = fixture();
  const capability = await acquireProtectedStoreBootstrap(createProtectedStoreBootstrap(f.scope, f.port), f.config, f.scope.storeHome);
  const resolved = await resolveEngineSession({ config: f.config, resolveWinterHome: () => f.scope.storeHome, env: f.env, protectedStoreBootstrap: capability });
  let entered!: () => void, finish!: () => void, reject!: (error: Error) => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const cleanup = new Promise<void>((resolve, failure) => { finish = resolve; reject = failure; });
  const handle: ChildHandle = {
    record: { id: "child", runtime: "winter-agent", parentSessionId: f.scope.sessionId, parentToolUseId: "spawn", transcript: "fixture", spawnDepth: 1, status: "completed", model: { effectiveModel: "winter-test/echo", effectiveEffort: "medium" }, permission: { effectiveMode: "default", parentPolicyHash: "fixture", parentPolicyVersion: 1 } },
    status: () => "completed", steer: async msg => ({ status: "not_found", messageId: msg.messageId, reason: "fixture" }),
    resume: async msg => ({ status: "unavailable", messageId: msg.messageId, retryable: false, reason: "fixture" }),
    result: async () => ({ status: "completed", content: "fixture" }), stop: async () => {},
    generationDone: () => { entered(); return cleanup; },
  };
  let returned = false, uncertain = false;
  const run = runEngine({ config: f.config, env: f.env, provider: echoProvider, store: resolved.store!, restoredChildren: [handle],
    input: { async *[Symbol.asyncIterator]() { yield { type: "user", text: "go" } as const; } }, output: { write() {}, end() {} },
    onTeardownUncertain: () => { uncertain = true; } }).then(code => { returned = true; return code; });
  await reached;
  expect(returned).toBe(false); expect(f.port.releases).toBe(0); expect(f.port.holders.size).toBe(1);
  if (fail) reject(new Error("synthetic namespace cleanup failed")); else finish();
  expect(await run).toBe(0); expect(uncertain).toBe(fail);
  if (!uncertain) expect(await releaseProtectedStoreBootstrap(capability)).toMatchObject({ status: "released" });
  expect(f.port.releases).toBe(fail ? 0 : 1);
}, 10_000);

test("ordinary, specialized, nested and forked children retain identity through actual scoped root restart", async () => {
  const f = fixture();
  const config = { ...f.config, forkSubagent: true, agents: { specialized: { description: "Specialized", prompt: "special persona", tools: ["Agent"] } } };
  const call = (input: unknown) => `CALL Agent ${JSON.stringify(input)}`;
  const initial = await entry(f, [
    call({ name: "ordinary", description: "ordinary", prompt: "ORDINARY_MARKER", run_in_background: false }),
    call({ name: "special", subagent_type: "specialized", description: "special", prompt: call({ name: "leaf", description: "leaf", prompt: "NESTED_MARKER", run_in_background: false }), run_in_background: false }),
    call({ name: "forked", subagent_type: "fork", description: "fork", prompt: "FORK_MARKER", run_in_background: false }),
  ].join("\n"), config);
  expect(initial.code, initial.diagnostics).toBe(0);
  const subdir = join(f.scope.storeHome, "projects", f.project, f.scope.sessionId, "subagents");
  const names = readdirSync(subdir).filter(name => name.endsWith(".meta.json")).sort();
  const records = names.map(name => JSON.parse(readFileSync(join(subdir, name), "utf8")));
  expect(records.map(record => record.name).sort()).toEqual(["forked", "leaf", "ordinary", "special"]); expect(records.find(record => record.name === "leaf").spawnDepth).toBe(2);
  expect(records.find(record => record.name === "forked").execution.request.fork).toBe(true);
  const leaf = records.find(record => record.name === "leaf"), forked = records.find(record => record.name === "forked");
  const leafPath = join(subdir, `agent-${leaf.id}.jsonl`), forkPath = join(subdir, `agent-${forked.id}.jsonl`);
  const before = readFileSync(leafPath, "utf8"), forkBefore = readFileSync(forkPath, "utf8"); stale(f);
  const resumed = await entry(f, `CALL ListAgents {}\nCALL SendMessage ${JSON.stringify({ to: leaf.id, message: "NESTED_FOLLOWUP" })}\nCALL SendMessage ${JSON.stringify({ to: forked.id, message: "FORK_FOLLOWUP" })}`, { ...config, resume: f.scope.sessionId });
  expect(resumed.code, resumed.diagnostics).toBe(0); expect(resumed.frames).toContain("resumed_and_delivered");
  expect(readFileSync(leafPath, "utf8").startsWith(before)).toBe(true); expect(readFileSync(leafPath, "utf8")).toContain("NESTED_FOLLOWUP");
  expect(readFileSync(forkPath, "utf8").startsWith(forkBefore)).toBe(true); expect(readFileSync(forkPath, "utf8")).toContain("FORK_FOLLOWUP");
  expect(readdirSync(subdir).filter(name => name.endsWith(".meta.json")).sort()).toEqual(names);
  expect(f.port.releases).toBe(2);
}, 20_000);

test("the actual registered child cleanup observer retains embedded ownership", async () => {
  const f = fixture(); const register = childRegistry.registerChildEngineFactory;
  const registration = spyOn(childRegistry, "registerChildEngineFactory").mockImplementation(factory => register(context => factory({
    ...context,
    // Failure in the CHILD's actual context disposer, reached through the registered production
    // factory. No direct runEngine/child-factory dependency injection can mask seam forwarding.
    bindRestoredDescendants: () => () => { throw new Error("synthetic registered child cleanup failed"); },
  })));
  try {
    const result = await entry(f, `CALL Agent ${JSON.stringify({ description: "child cleanup probe", prompt: "CHILD_MARKER", run_in_background: false })}`);
    expect(result.code).toBe(0); expect(result.frames).toContain("CHILD_MARKER");
    expect(result.outcomes).toEqual([{ status: "retained", reason: "teardown-uncertain", scope: f.scope }]);
    expect(f.port.releases).toBe(0); expect(f.port.holders.size).toBe(1);
  } finally { registration.mockRestore(); }
}, 10_000);

test.each(["success", "native-release", "proof-exception", "proof-scope"] as const)("embedded terminal ownership outcome is machine-readable after %s", async mode => {
  const f = fixture();
  f.port.failRelease = mode === "native-release"; f.port.failTeardownProof = mode === "proof-exception"; f.port.wrongTeardownScope = mode === "proof-scope";
  const result = await entry(f, "done");
  const status = mode === "success" ? "released" : mode === "native-release" ? "release-failed" : "retained";
  const reason = mode === "success" ? "completed" : mode === "native-release" ? "native-release-failed" : mode === "proof-exception" ? "teardown-proof-failed" : "teardown-proof-invalid";
  expect(result.code).toBe(0); expect(result.outcomes).toEqual([{ status, reason, scope: f.scope }]);
  expect(f.port.releases).toBe(mode === "success" ? 1 : 0);
});

test("a protected embedded launch requires a trusted terminal observer before acquiring ownership", async () => {
  const f = fixture(); const diagnostics: string[] = [];
  const code = await runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify(f.config)], env: f.env,
    protectedStoreBootstrap: createProtectedStoreBootstrap(f.scope, f.port),
    input: { async *[Symbol.asyncIterator]() {} }, write: () => {}, writeErr: text => diagnostics.push(text) });
  expect(code).toBe(1); expect(diagnostics.join("")).toContain("requires a machine-readable terminal ownership observer");
  expect(f.port.holders.size).toBe(0);
});

test("failed acquisition cleanup has an explicit release-failed terminal outcome", async () => {
  const f = fixture(); f.port.identityUnavailable = true; f.port.failRelease = true;
  const result = await entry(f, "must not run");
  expect(result.code).toBe(1); expect(result.frames).toBe("");
  expect(result.outcomes).toEqual([{ status: "release-failed", reason: "native-release-failed", scope: f.scope }]);
  expect(f.port.holders.size).toBe(1); expect(f.port.releases).toBe(0);
});

test("startup refusal after ownership acquisition reports actual retained native state", async () => {
  const f = fixture(); stale(f); f.port.mode = "absent"; f.port.teardown = "uncertain";
  const result = await entry(f, "must not run");
  expect(result.code).toBe(1); expect(result.frames).toBe("");
  expect(result.outcomes).toEqual([{ status: "retained", reason: "teardown-unconfirmed", scope: f.scope }]);
  expect(f.port.holders.size).toBe(1); expect(f.port.releases).toBe(0);
});

test("actual root and child durable sidecars refuse all reads/writes after confirmed release", async () => {
  const f = fixture();
  const capability = await acquireProtectedStoreBootstrap(createProtectedStoreBootstrap(f.scope, f.port), f.config, f.scope.storeHome);
  const concrete = createProtectedRuntimeStore(capability, f.scope.storeHome);
  const resolved = await resolveEngineSession({ config: f.config, resolveWinterHome: () => f.scope.storeHome, env: f.env, protectedStoreBootstrap: capability });
  const child = buildChildTranscriptWriter({ store: concrete, projectKey: f.project, parentSessionId: f.scope.sessionId, agentId: "child", parentToolUseId: "spawn", cwd: f.config.cwd, winterHome: f.scope.storeHome });
  const record: providerState.ProviderStateRecordInput = { sessionId: f.scope.sessionId, anchorUuid: "anchor", provider: "openai", model: "fixture", family: "openai", itemIndex: 0, kind: "origin", payload: {} };
  await resolved.store!.recordUserEntry("ROOT_MARKER"); await resolved.store!.recordProviderState!(record); await child.recordProviderState(record);
  resolved.autoStateStore!.recordDeny(f.scope.sessionId);
  const approval: DurableApprovalRecord = { runtimeKind: "winter-agent", sessionId: f.scope.sessionId, backendSessionId: f.scope.sessionId, requestId: "request", toolUseID: "call", toolName: "Read", originalInput: {}, displayMetadata: { decisionReason: "fixture" }, policyMode: "default", policyVersion: 1, issuedAt: "2026-10-12T00:00:00Z", state: "pending", issuedCwd: f.config.cwd, issuedHome: f.scope.storeHome };
  resolved.approvalStore!.record(approval);
  const update: PermissionUpdate = { type: "addRules", rules: [], behavior: "allow", destination: "userSettings" };
  resolved.store!.recordPermissionUpdate!(update, "sdk");
  resolved.store!.recordHookAudit!({ hookId: "hook", hookEvent: "SessionStart", sessionId: f.scope.sessionId, uuid: "audit", outcome: "none" });
  const location = { winterHome: f.scope.storeHome, projectKey: f.project, sessionId: f.scope.sessionId };
  const guard = durableOperationGuard(concrete, f.scope.storeHome, { projectKey: f.project, sessionId: f.scope.sessionId });
  expect(readHookAuditJournal(location, undefined, guard)).toHaveLength(1);
  const base = join(f.scope.storeHome, "projects", f.project, f.scope.sessionId);
  const paths = [`${base}.jsonl`, `${base}.provider-state.jsonl`, `${base}.permission-journal.jsonl`, `${base}.approvals.jsonl`, `${base}.auto-state.json`, join(base, "subagents", "agent-child.provider-state.jsonl")];
  const bytes = paths.map(path => readFileSync(path, "utf8"));
  expect(await releaseProtectedStoreBootstrap(capability)).toMatchObject({ status: "released" });
  const actions = [
    () => resolved.store!.recordUserEntry("DENIED"), () => resolved.store!.recordProviderState!(record), () => resolved.store!.loadProviderState!(),
    () => child.recordProviderState(record), () => child.loadProviderState(),
    () => resolved.store!.recordPermissionUpdate!(update, "sdk"), () => resolved.store!.recordHookAudit!({ hookId: "denied", hookEvent: "SessionEnd", sessionId: f.scope.sessionId, uuid: "denied", outcome: "none" }),
    () => readHookAuditJournal(location, undefined, guard), () => resolved.autoStateStore!.get(f.scope.sessionId), () => resolved.autoStateStore!.recordDeny(f.scope.sessionId), () => resolved.autoStateStore!.recordAllow(f.scope.sessionId),
    () => resolved.approvalStore!.record(approval), () => resolved.approvalStore!.get("request"), () => resolved.approvalStore!.pendingFor({ sessionId: f.scope.sessionId }),
    () => resolved.approvalStore!.listFor({ sessionId: f.scope.sessionId }), () => resolved.approvalStore!.respond("request", { outcome: "denied", mechanism: "hook" }),
    () => resolved.approvalStore!.cancelPendingFor({ sessionId: f.scope.sessionId }, "denied"), () => resolved.approvalStore!.expire("request", "denied"),
    () => resolved.approvalStore!.markConsumed("request", { output: "denied" }), () => resolved.approvalStore!.markConsuming("request"),
    () => resolved.approvalStore!.revalidate(approval, { runtimeKind: "winter-agent", sessionId: f.scope.sessionId, backendSessionId: f.scope.sessionId, toolUseID: "call", policyMode: "default", policyVersion: 1, policyHash: "fixture", cwd: f.config.cwd, home: f.scope.storeHome }),
    () => createFileDurableApprovalStore(location, guard), () => createFileAutoCounterStore(location, guard),
  ];
  for (const action of actions) await expect((async () => action())()).rejects.toThrow("owner_lost");
  expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(bytes);
});

test("release retains native ownership until an admitted asynchronous provider sidecar write settles", async () => {
  const f = fixture(); const capability = await acquireProtectedStoreBootstrap(createProtectedStoreBootstrap(f.scope, f.port), f.config, f.scope.storeHome);
  const resolved = await resolveEngineSession({ config: f.config, resolveWinterHome: () => f.scope.storeHome, env: f.env, protectedStoreBootstrap: capability });
  const original = providerState.appendProviderState; let complete!: () => void;
  const barrier = new Promise<void>(resolve => { complete = resolve; });
  // Suspend the actual provider sink's filesystem primitive, rather than a parallel fake store.
  const append = spyOn(providerState, "appendProviderState").mockImplementation((path, input) => barrier.then(() => original(path, input)) as unknown as ReturnType<typeof original>);
  const path = join(f.scope.storeHome, "projects", f.project, `${f.scope.sessionId}.provider-state.jsonl`);
  try {
    const pending = resolved.store!.recordProviderState!({ sessionId: f.scope.sessionId, anchorUuid: "anchor", provider: "openai", model: "fixture", family: "openai", itemIndex: 0, kind: "origin", payload: {} });
    expect(existsSync(path)).toBe(false);
    expect(await releaseProtectedStoreBootstrap(capability)).toMatchObject({ status: "retained", reason: "durable-operations-pending" });
    expect(f.port.releases).toBe(0); expect(f.port.holders.size).toBe(1);
    await expect(resolved.store!.loadProviderState!()).rejects.toThrow("owner_lost");
    complete(); await pending; expect(readFileSync(path, "utf8")).toContain("anchor");
    expect(await releaseProtectedStoreBootstrap(capability)).toMatchObject({ status: "released" }); expect(f.port.releases).toBe(1);
    await expect(resolved.store!.recordProviderState!({ sessionId: f.scope.sessionId, anchorUuid: "DENIED", provider: "openai", model: "fixture", family: "openai", itemIndex: 0, kind: "origin", payload: {} })).rejects.toThrow("owner_lost");
    expect(readFileSync(path, "utf8")).not.toContain("DENIED");
  } finally { complete(); append.mockRestore(); }
});

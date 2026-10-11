import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WinterCompatibilitySessionStore, compatibilityKeys, encodeFrame, splitFrames, TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY, type RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { runEmbeddedSession } from "../embedded.ts";
import { Queue } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { echoProvider } from "../provider/mock.ts";
import type { ChildHandle } from "../subagents/child-handle.ts";
import { resolveEngineSession } from "../store/dialect.ts";
import { acquireProtectedStoreBootstrap, createProtectedRuntimeStore, createProtectedStoreBootstrap, releaseProtectedStoreBootstrap, type ProtectedStoreOwnershipPort, type ProtectedStoreOwner, type ProtectedStoreScope, type PreviousBootTerminationEvidence } from "./store-bootstrap.ts";

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
  async acquire(scope: Readonly<ProtectedStoreScope>): Promise<ProtectedStoreOwner> {
    const key = `${scope.storeHome}/${scope.sessionId}`;
    if (this.holders.has(key)) throw new Error("synthetic owner already held");
    const ownerToken = `synthetic-${Math.random()}`;
    this.holders.set(key, ownerToken);
    return {
      scope, ownerToken, signal: new AbortController().signal,
      assertHeld: () => { if (this.holders.get(key) !== ownerToken) throw new Error("synthetic owner lost"); },
      processIdentity: pid => pid === process.pid ? { bootId: scope.currentBootId, startTicks: "123" } : null,
      previousBootTermination: previousBootId => {
        this.proofs++;
        if (this.mode === "absent") return null;
        if (this.mode === "false") return false as unknown as PreviousBootTerminationEvidence;
        return { scope: this.mode === "wrong-scope" ? { ...scope, [this.proofMismatch]: this.proofMismatch === "leaseEpoch" ? scope.leaseEpoch + 1 : "another" } : scope,
          ownerToken: this.mode === "wrong-owner" ? "unrelated" : ownerToken,
          previousBootId: this.mode === "wrong-boot" ? boot : previousBootId };
      },
      runtimeTeardownEvidence: () => this.teardown === "absent" ? null : { scope, ownerToken, outcome: this.teardown },
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
  const frames: string[] = [], diagnostics: string[] = [];
  const code = await runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify(config)], env: f.env,
    protectedStoreBootstrap: capability,
    input: { async *[Symbol.asyncIterator]() { yield encodeFrame({ type: "user", text: prompt }); } },
    write: chunk => frames.push(chunk), writeErr: chunk => diagnostics.push(chunk) });
  return { code, frames: frames.join(""), diagnostics: diagnostics.join("") };
}

test("missing native ownership adapter and forged/cloned capabilities fail closed", async () => {
  const f = fixture();
  expect(() => createProtectedStoreBootstrap(f.scope)).toThrow("native_owner_unavailable");
  const capability = createProtectedStoreBootstrap(f.scope, f.port);
  await expect(acquireProtectedStoreBootstrap(JSON.parse(JSON.stringify(capability)), f.config, f.scope.storeHome)).rejects.toThrow("bootstrap_invalid");
  const result = await entry(f, "nothing", f.config, {} as typeof capability);
  expect(result.code).toBe(1); expect(result.frames).toBe(""); expect(f.port.holders.size).toBe(0);
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
  await expect(releaseProtectedStoreBootstrap(next)).rejects.toThrow("synthetic release failed");
  await expect(releaseProtectedStoreBootstrap(next)).rejects.toThrow("owner_lost");
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
  expect(await releaseProtectedStoreBootstrap(capability)).toBe("released");
  await expect(concrete.load({ projectKey: f.project, sessionId: f.scope.sessionId })).rejects.toThrow("owner_lost");
});

test.each(["session", "root", "resume", "continue", "fork"] as const)("trusted bootstrap refuses wrong %s scope before ownership or store access", async mismatch => {
  const f = fixture(); const bytes = stale(f);
  const config = { ...f.config, ...(mismatch === "session" ? { sessionId: "sibling" } : mismatch === "root" ? { storeHome: f.config.cwd } : mismatch === "resume" ? { resume: "sibling" } : mismatch === "continue" ? { continue: true } : { forkSession: true }) };
  const result = await entry(f, "must not run", config);
  expect(result.code).toBe(1); expect(result.frames).toBe(""); expect(f.port.proofs).toBe(0); expect(f.port.releases).toBe(0); expect(readFileSync(f.lock, "utf8")).toBe(bytes);
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
});

test("two actual embedded opens compete for one synthetic owner, held while the first runtime is pending", async () => {
  const f = fixture(); const input = new Queue<string>(); let initialized!: () => void;
  const ready = new Promise<void>(resolve => { initialized = resolve; });
  const first = runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify(f.config)], env: f.env, input,
    protectedStoreBootstrap: createProtectedStoreBootstrap(f.scope, f.port),
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
  if (!uncertain) expect(await releaseProtectedStoreBootstrap(capability)).toBe("released");
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

// Phase 4 fix wave (I3): the PRODUCTION wiring proof for WS-10 §7's "the roster rebuilds from
// durable storage". `roster.test.ts` proves the rebuild FUNCTION; this file proves a real resumed
// session actually calls it -- the gap the whole-branch review found (a MUST cited as covered by
// unit tests of a function with zero production callers).
//
// Drives `inMemoryProcess` (the same entrypoint wiring main.ts performs, per
// register-default-factory.ts's own cross-leg argument) end to end: session 1 spawns a REAL child
// through the REAL Agent tool, the process ends, and session 2 resumes the same session and asks
// `ListAgents` what it can see.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig, WinterFrame, PermissionMode, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import type { Provider } from "../engine.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";
import { resetChildEngineFactoryForTest } from "./child-handle.ts";
import { restoredChildHandle } from "./restore.ts";
import { userMessageText } from "../provider/mock.ts";

const CHILD_MARKER = "restore-fixture child prompt";

const tempDirs: string[] = [];
function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-fixwave-restore-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function runOneEnvelope(config: RuntimeConfig, home: string, provider: Provider): Promise<WinterFrame[]> {
  const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, undefined, { WINTER_HOME: home });
  proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
  proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  const frames: WinterFrame[] = [];
  let carry = "";
  for await (const chunk of proc.stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    frames.push(...split.frames);
  }
  await proc.exited;
  return frames;
}

// A pure function of the messages it sees -- ONE provider instance serves both the parent's turns
// and the spawned child's (createChildEngineFactory hands `deps.provider` straight to the child).
const spawningProvider: Provider = {
  async generate({ messages }) {
    const firstUser = messages.find((m) => m.role === "user");
    const firstText = userMessageText(firstUser);
    if (firstText.includes(CHILD_MARKER)) return { kind: "text", text: "child finished" };
    const alreadySpawned = messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.name === "Agent"));
    if (alreadySpawned) return { kind: "text", text: "parent finished" };
    return { kind: "tool_use", calls: [{ id: "agent-call-1", name: "Agent", input: { description: "restore fixture", prompt: CHILD_MARKER, name: "restorable" } }] };
  },
};

const listingProvider: Provider = {
  async generate({ messages }) {
    const alreadyListed = messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.name === "ListAgents"));
    if (alreadyListed) return { kind: "text", text: "listed" };
    return { kind: "tool_use", calls: [{ id: "list-call-1", name: "ListAgents", input: {} }] };
  },
};

function toolResultContent(frames: WinterFrame[], toolUseId: string): string | undefined {
  return frames
    .filter((f) => f.type === "data")
    .map((f) => (f as { message: SdkMessage }).message)
    .filter((m) => m.type === "user")
    .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []))
    .find((b) => b.tool_use_id === toolUseId)?.content;
}

describe("WS-10 §7: a resumed session rebuilds its child roster from durable storage (fix wave I3)", () => {
  test("a child spawned in session 1 is listed by ListAgents after the session is RESUMED in a fresh runtime instance", async () => {
    const home = freshHome();
    const cwd = "/winter-fixture";
    const sessionId = randomUUID();

    const firstFrames = await runOneEnvelope({ sessionId, cwd, model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }, home, spawningProvider);
    const spawnResult = toolResultContent(firstFrames, "agent-call-1");
    expect(spawnResult, "session 1 must genuinely spawn a child").toBeDefined();
    const agentId = (JSON.parse(spawnResult!) as { agentId: string }).agentId;
    expect(typeof agentId).toBe("string");

    // A SEPARATE run, resuming the same session -- the shape a restart takes (store/resume.test.ts's
    // own established fixture): a fresh instance id plus `resume`.
    const secondFrames = await runOneEnvelope(
      { sessionId: randomUUID(), cwd, model: "winter-test/echo", resume: sessionId, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
      home,
      listingProvider,
    );
    const listing = toolResultContent(secondFrames, "list-call-1");
    expect(listing, "the resumed session must produce a ListAgents result").toBeDefined();
    // Before the fix: `rebuildChildRoster` had NO production caller, the resumed run started with an
    // empty roster, and this listing was empty -- the prior child was unreachable by any tool.
    expect(listing!).toContain(agentId);
    expect(listing!).toContain("restorable");
  }, 20_000);

  test("a FORK does not inherit the source session's children (a fork is a new session; its children belong to the source)", async () => {
    const home = freshHome();
    const cwd = "/winter-fixture";
    const sessionId = randomUUID();
    const firstFrames = await runOneEnvelope({ sessionId, cwd, model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }, home, spawningProvider);
    const agentId = (JSON.parse(toolResultContent(firstFrames, "agent-call-1")!) as { agentId: string }).agentId;

    const forkFrames = await runOneEnvelope(
      { sessionId: randomUUID(), cwd, model: "winter-test/echo", resume: sessionId, forkSession: true, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
      home,
      listingProvider,
    );
    expect(toolResultContent(forkFrames, "list-call-1")!).not.toContain(agentId);
  }, 20_000);
});

describe("restoredChildHandle: an unbound handle preserves identity and refuses execution", () => {
  test("a restored handle answers from the durable record and refuses steer/resume with a legible, NON-retryable reason", async () => {
    const record = {
      id: "agent-x",
      parentSessionId: "session-x",
      parentToolUseId: "call-x",
      transcript: "/tmp/nowhere/agent-agent-x.jsonl",
      status: "stopped" as const,
      runtime: "winter-agent" as const,
      model: { effectiveModel: "sonnet", effectiveEffort: "inherit" },
      permission: { effectiveMode: "default" as const, parentPolicyHash: "h", parentPolicyVersion: 1 },
    };
    const handle = restoredChildHandle(record);
    expect(handle.status()).toBe("stopped");
    const msg = { messageId: "m1" } as never;
    expect((await handle.steer(msg)).status).toBe("not_found");
    const resumed = await handle.resume(msg);
    expect(resumed.status).toBe("unavailable");
    expect(resumed).toMatchObject({ retryable: false });
    expect("reason" in resumed ? resumed.reason : "").toContain("restored from durable storage");
    expect((await handle.result()).status).toBe("stopped");
    await handle.stop(); // idempotent, never throws
  });
});

// The factory and store are real; the provider is deterministic and never contacts a service.
import { WinterCompatibilitySessionStore, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { createChildEngineFactory } from "./child-engine.ts";
import { bindRestoredChildren } from "./restore.ts";
import { currentRunningSubagentCount } from "./limits.ts";
import { TranscriptWriter } from "../store/dialect.ts";
import { snapshotChildExecution, bindChildExecutionProjectKey } from "./execution-snapshot.ts";
import type { ChildHandle, ChildInheritance, ChildSessionRecord } from "./child-handle.ts";
import { spyOn } from "bun:test";

async function waitForSettled(handle: ChildHandle): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (handle.status() === "running") {
    if (Date.now() > deadline) throw new Error("child did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function inheritance(root: string): ChildInheritance {
  return { policy: { effectiveMode: "default", parentPolicyVersion: 1, parentPolicyHash: "original" }, tools: ["Read", "Bash"], model: "winter-test/echo", effort: "inherit", thinking: undefined, systemPrompt: "", sessionRoot: root };
}
function message(body: string) { return { messageId: randomUUID(), body } as never; }

async function persistedChild(effectiveMode: PermissionMode = "default", permissionMode?: string) {
  const root = freshHome();
  const store = new WinterCompatibilitySessionStore({ winterHome: root });
  const deps = createChildEngineFactory({ provider: { async generate() { return { kind: "text", text: "original answer" }; } }, store, winterHome: root })({ parentSessionId: "cold-parent", forwardChildFrame() {} });
  const inherited = inheritance(root);
  inherited.policy.effectiveMode = effectiveMode;
  const child = await deps.spawn({ parentToolUseId: "original-spawn", prompt: "original marker", runInBackground: false, name: "cold-child", definition: { description: "persona fixture", prompt: "saved persona", tools: ["Read", "Bash"], ...(permissionMode !== undefined ? { permissionMode } : {}) } }, inherited);
  await waitForSettled(child);
  await child.generationDone?.();
  return { root, store, record: JSON.parse(JSON.stringify(child.record)) as ChildSessionRecord };
}

describe("durable child execution continuation", () => {
  test("a fresh factory keeps persona, history and identity while applying current tool and policy restrictions", async () => {
    const { root, store, record } = await persistedChild();
    const requests: Array<{ text: string; system: string; tools: string[] }> = [];
    const factory = createChildEngineFactory({ store, winterHome: root, provider: {
      async generate(request) {
        requests.push({ text: JSON.stringify(request.messages), system: request.system ?? "", tools: (request.tools ?? []).map((tool) => tool.name) });
        return { kind: "text", text: "new answer" };
      },
    } })({ parentSessionId: record.parentSessionId, forwardChildFrame() {}, getParentTools: () => ["Read"], getParentPolicy: () => ({ mode: "plan", version: 2, hash: "current" }), getParentRules: () => ({ allow: [], ask: [], deny: ["Bash"] }) });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect((await restored.resume(message("followup"))).status).toBe("resumed_and_delivered");
    await waitForSettled(restored);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.text).toContain("original marker");
    expect(requests[0]!.text).toContain("original answer");
    expect(requests[0]!.text).toContain("followup");
    expect(requests[0]!.system).toContain("saved persona");
    expect(requests[0]!.tools).not.toContain("Bash");
    expect(restored.record.id).toBe(record.id);
    expect(restored.record.permission).toEqual({ effectiveMode: "plan", parentPolicyVersion: 2, parentPolicyHash: "current" });
    const entries = await TranscriptWriter.readBack(store, { projectKey: compatibilityKeys(root).transcriptProjectKey, sessionId: record.parentSessionId, subpath: `subagents/agent-${record.id}` });
    const messages = entries.filter((entry) => entry.type === "user" || entry.type === "assistant");
    expect(messages.filter((entry) => entry.parentUuid === null)).toHaveLength(1);
    expect(currentRunningSubagentCount()).toBe(0);
  });

  test.each(["missing", "corrupt"])("%s child history refuses before execution and releases the concurrency slot", async (kind) => {
    const { root, store, record } = await persistedChild();
    let calls = 0;
    const load = spyOn(store, "load").mockResolvedValue(kind === "missing" ? null : [{ type: "user", uuid: "broken", parentUuid: "absent", message: { role: "user", content: "orphan" } }]);
    try {
      const deps = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { calls++; return { kind: "text", text: "must not run" }; } } })({ parentSessionId: record.parentSessionId, forwardChildFrame() {} });
      const restored = restoredChildHandle(record);
      bindRestoredChildren([restored], deps.restore!);
      const outcome = await restored.resume(message("followup"));
      expect(outcome).toMatchObject({ status: "unavailable", retryable: false });
      expect(calls).toBe(0);
      expect(restored.status()).toBe("completed");
      expect(currentRunningSubagentCount()).toBe(0);
    } finally { load.mockRestore(); }
  });

  test("stop during lazy restoration cancels delivery, and concurrent resumes create one handle", async () => {
    const { record } = await persistedChild();
    const restored = restoredChildHandle(record);
    let release!: (handle: ChildHandle) => void;
    const gate = new Promise<ChildHandle>((resolve) => { release = resolve; });
    let creations = 0;
    let deliveries = 0;
    const live: ChildHandle = { record, status: () => record.status, async steer(msg) { return { status: "delivered", messageId: msg.messageId }; }, async resume(msg) { deliveries++; return { status: "resumed_and_delivered", messageId: msg.messageId }; }, async result() { return { status: "completed", content: "done" }; }, async stop() {} };
    bindRestoredChildren([restored], async () => { creations++; return gate; });
    const pending = restored.resume(message("first"));
    expect(await restored.resume(message("duplicate"))).toMatchObject({ status: "unavailable", retryable: true });
    await restored.stop();
    release(live);
    expect(await pending).toMatchObject({ status: "unavailable", retryable: false });
    expect(creations).toBe(1);
    expect(deliveries).toBe(0);
  });

  test("MCP credentials and arbitrary definition fields never enter the execution snapshot", () => {
    const root = "/snapshot-fixture";
    const secret = "credential-fixture-do-not-store";
    const snapshot = snapshotChildExecution({ projectKey: "fixture", workspace: { root, isolationType: "normal", cleanupPolicy: "keep" }, inheritance: inheritance(root), request: { parentToolUseId: "call", prompt: "task", runInBackground: false, agentType: "reviewer", definition: { description: "safe", prompt: "persona", mcpServers: [{ private: { type: "http", url: "https://example.invalid", headers: { Authorization: secret } } }], injectedCredential: secret } as never } });
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.scopedMcpServerNames).toEqual(["private"]);
    expect(snapshot.request.definition?.prompt).toBe("persona");
  });
});

describe("cold resume cancellation and lineage", () => {
  test.each(["provider resolution", "transcript loading"])("stop during %s prevents a new generation and releases its slot", async (stage) => {
    const { root, store, record } = await persistedChild();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let providerCalls = 0;
    const deps = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { providerCalls++; return { kind: "text", text: "must not run" }; } }, ...(stage === "provider resolution" ? { async resolveChildProvider() { entered(); await blocked; return undefined; } } : {}) })({ parentSessionId: record.parentSessionId, forwardChildFrame() {} });
    const live = await deps.restore!(record);
    let load: ReturnType<typeof spyOn> | undefined;
    if (stage === "transcript loading") {
      const originalLoad = store.load.bind(store);
      load = spyOn(store, "load").mockImplementation(async (key) => { entered(); await blocked; return originalLoad(key); });
    }
    try {
      const pending = live.resume(message("cancel me"));
      await waiting;
      await live.stop();
      release();
      expect(await pending).toMatchObject({ status: "unavailable", retryable: false });
      expect(providerCalls).toBe(0);
      expect(live.status()).toBe("stopped");
      expect(currentRunningSubagentCount()).toBe(0);
    } finally { release(); load?.mockRestore(); }
  });

  test("a dormant ancestor contributes its own policy/tool restrictions to a cold descendant", async () => {
    const { root, store, record } = await persistedChild();
    const ancestor = JSON.parse(JSON.stringify(record)) as ChildSessionRecord;
    ancestor.id = "immediate-parent";
    ancestor.permission.effectiveMode = "plan";
    ancestor.execution!.inheritance.tools = ["Read"];
    ancestor.execution!.request.definition!.disallowedTools = ["Bash"];
    record.spawnDepth = 2;
    record.execution!.parentAgentId = ancestor.id;
    let tools: string[] = [];
    const deps = createChildEngineFactory({ store, winterHome: root, provider: { async generate(request) { tools = (request.tools ?? []).map((tool) => tool.name); return { kind: "text", text: "nested answer" }; } } })({ parentSessionId: record.parentSessionId, getRecordedChild: (id) => id === ancestor.id ? ancestor : undefined, getParentTools: () => ["Read", "Bash"], getParentPolicy: () => ({ mode: "default", version: 2, hash: "root" }), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], deps.restore!);
    expect((await restored.resume(message("nested followup"))).status).toBe("resumed_and_delivered");
    await waitForSettled(restored);
    expect(tools).not.toContain("Bash");
    expect(record.permission.effectiveMode).toBe("plan");
    expect(record.spawnDepth).toBe(2);
    expect(record.execution!.parentAgentId).toBe(ancestor.id);
  });

  test("a malformed snapshot and a cyclic ancestor lineage fail without executing", async () => {
    const { root, store, record } = await persistedChild();
    let calls = 0;
    const deps = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { calls++; return { kind: "text", text: "must not run" }; } } })({ parentSessionId: record.parentSessionId, getRecordedChild: () => record, forwardChildFrame() {} });
    const broken = JSON.parse(JSON.stringify(record)) as ChildSessionRecord;
    broken.execution!.inheritance.requestLayout = { systemBlocks: [], userContext: [], tools: null } as never;
    const malformed = restoredChildHandle(broken);
    bindRestoredChildren([malformed], deps.restore!);
    expect(await malformed.resume(message("followup"))).toMatchObject({ status: "unavailable", retryable: false });
    record.spawnDepth = 2;
    record.execution!.parentAgentId = record.id;
    const cyclic = restoredChildHandle(record);
    bindRestoredChildren([cyclic], deps.restore!);
    expect(await cyclic.resume(message("followup"))).toMatchObject({ status: "unavailable", retryable: false });
    expect(calls).toBe(0);
    expect(currentRunningSubagentCount()).toBe(0);
  });

  test("a named definition's scoped MCP transports reattach from the current host, and missing definitions refuse", async () => {
    const { root, store, record } = await persistedChild();
    record.execution!.request.agentType = "reviewer";
    record.execution!.scopedMcpServerNames = ["private"];
    let calls = 0;
    const provider: Provider = { async generate() { calls++; return { kind: "text", text: "must not run" }; } };
    const factory = createChildEngineFactory({ store, winterHome: root, provider });
    const current = factory({ parentSessionId: record.parentSessionId, getParentAgents: () => ({ reviewer: { prompt: "current definition", mcpServers: [{ private: { type: "http", url: "https://example.invalid", headers: { Authorization: "host-owned-current-secret" } } }] } }), forwardChildFrame() {} });
    const dormant = await current.restore!(record);
    expect(dormant.record.id).toBe(record.id);
    expect(calls).toBe(0);
    const missing = factory({ parentSessionId: record.parentSessionId, forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], missing.restore!);
    expect(await restored.resume(message("followup"))).toMatchObject({ status: "unavailable", retryable: false });
    expect(JSON.stringify(record)).not.toContain("host-owned-current-secret");
  });
});

describe("restored child parent-context rebinding", () => {
  test.each(["running", "materializing"])("a context change while %s uses the newest parent for the next generation", async (stage) => {
    const { record } = await persistedChild();
    const restored = restoredChildHandle(record);
    let finishConstruction!: (handle: ChildHandle) => void;
    const constructing = new Promise<ChildHandle>((resolve) => { finishConstruction = resolve; });
    let oldDeliveries = 0;
    let newDeliveries = 0;
    let teardownWaits = 0;
    const makeHandle = (latest: boolean): ChildHandle => ({
      record, status: () => record.status,
      async resume(msg) { if (latest) newDeliveries++; else oldDeliveries++; record.status = "running"; return { status: "resumed_and_delivered", messageId: msg.messageId }; },
      async steer(msg) { return { status: "delivered", messageId: msg.messageId }; },
      async stop() { record.status = "stopped"; }, async result() { return { status: "completed", content: "done" }; },
      async generationDone() { teardownWaits++; },
    });
    const old = makeHandle(false);
    bindRestoredChildren([restored], async () => stage === "materializing" ? constructing : old);
    const first = restored.resume(message("first"));
    if (stage === "running") await first;
    bindRestoredChildren([restored], async () => makeHandle(true));
    if (stage === "materializing") { finishConstruction(old); await first; }
    else { record.status = "completed"; expect((await restored.resume(message("second"))).status).toBe("resumed_and_delivered"); }
    expect(oldDeliveries).toBe(stage === "running" ? 1 : 0);
    expect(newDeliveries).toBe(1);
    expect(teardownWaits).toBe(stage === "running" ? 1 : 0);
    await restored.stop();
  });
});

test("a new parent binding that fails during materialization never revives the older candidate", async () => {
  const { record } = await persistedChild();
  const restored = restoredChildHandle(record);
  let release!: (handle: ChildHandle) => void;
  const gate = new Promise<ChildHandle>((resolve) => { release = resolve; });
  let oldDeliveries = 0;
  let freshAttempts = 0;
  const old: ChildHandle = { record, status: () => record.status, async steer(msg) { return { status: "delivered", messageId: msg.messageId }; }, async resume(msg) { oldDeliveries++; return { status: "resumed_and_delivered", messageId: msg.messageId }; }, async result() { return { status: "completed", content: "old" }; }, async stop() {} };
  bindRestoredChildren([restored], async () => gate);
  const pending = restored.resume(message("first"));
  bindRestoredChildren([restored], async () => { freshAttempts++; throw new Error("new parent is unavailable"); });
  release(old);
  expect(await pending).toMatchObject({ status: "unavailable", retryable: false });
  expect(await restored.resume(message("retry"))).toMatchObject({ status: "unavailable", retryable: false });
  expect(freshAttempts).toBe(2);
  expect(oldDeliveries).toBe(0);
});

test("a parent binding change during a resumed provider probe cancels the old pending generation", async () => {
  const { root, store, record } = await persistedChild();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let oldCalls = 0;
  let resolutions = 0;
  const old = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { oldCalls++; return { kind: "text", text: "old context answer" }; } }, async resolveChildProvider() { resolutions++; if (resolutions === 2) { entered(); await blocked; } return undefined; } })({ parentSessionId: record.parentSessionId, forwardChildFrame() {} });
  const restored = restoredChildHandle(record);
  bindRestoredChildren([restored], old.restore!);
  expect((await restored.resume(message("first"))).status).toBe("resumed_and_delivered");
  await waitForSettled(restored);
  const pending = restored.resume(message("must not dispatch on old context"));
  await waiting;
  let newCalls = 0;
  const latest = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { newCalls++; return { kind: "text", text: "current context answer" }; } } })({ parentSessionId: record.parentSessionId, forwardChildFrame() {} });
  bindRestoredChildren([restored], latest.restore!);
  release();
  expect(await pending).toMatchObject({ status: "unavailable", retryable: true });
  expect(restored.status()).toBe("completed");
  const metadata = await store.load({ projectKey: record.execution!.projectKey, sessionId: record.parentSessionId, subpath: `subagents/agent-${record.id}` });
  expect(metadata?.find((entry) => entry.type === "agent_metadata")?.status).toBe("completed");
  expect(oldCalls).toBe(1);
  expect(currentRunningSubagentCount()).toBe(0);
  expect((await restored.resume(message("use latest context"))).status).toBe("resumed_and_delivered");
  await waitForSettled(restored);
  expect(newCalls).toBe(1);
});

test("finite numeric definition effort and maxTurns preserve the successful spawn contract on cold restore", async () => {
  const root = freshHome();
  const store = new WinterCompatibilitySessionStore({ winterHome: root });
  let calls = 0;
  const provider: Provider = { async generate() { calls++; return { kind: "text", text: "numeric contract answer" }; } };
  const first = createChildEngineFactory({ store, winterHome: root, provider })({ parentSessionId: "numeric-parent", forwardChildFrame() {} });
  const child = await first.spawn({ parentToolUseId: "numeric-spawn", prompt: "initial task", runInBackground: false, definition: { description: "numeric fixture", prompt: "numeric persona", effort: 0, maxTurns: 0 } }, { ...inheritance(root), effort: "0", effectiveEffort: 0 });
  await waitForSettled(child);
  await child.generationDone?.();
  expect(child.status()).toBe("completed");
  expect(calls).toBe(1);
  const record = JSON.parse(JSON.stringify(child.record)) as ChildSessionRecord;
  const second = createChildEngineFactory({ store, winterHome: root, provider })({ parentSessionId: record.parentSessionId, forwardChildFrame() {} });
  const restored = restoredChildHandle(record);
  bindRestoredChildren([restored], second.restore!);
  expect(await restored.resume(message("numeric followup"))).toMatchObject({ status: "resumed_and_delivered" });
  await waitForSettled(restored);
  expect(calls).toBe(2);
  expect(restored.status()).toBe("completed");
  expect(record.execution!.request.definition!.effort).toBe(0);
  expect(record.execution!.request.definition!.maxTurns).toBe(0);
});

describe("current definition and workspace authority on cold continuation", () => {
  test.each([true, false])("a named child refreshes persona and durably intersects authority (live parent policy: %s)", async (withParentPolicy) => {
    const { root, store, record } = await persistedChild();
    record.execution!.request.agentType = "reviewer";
    record.execution!.request.definition!.memory = "user";
    record.execution!.request.definition!.disallowedTools = ["Write"];
    const seen: Array<{ system: string; tools: string[] }> = [];
    let current = { description: "current reviewer", prompt: "current trusted persona", tools: ["Read"], disallowedTools: ["Bash"], permissionMode: "plan", memory: "project" };
    const factory = createChildEngineFactory({ store, winterHome: root, provider: { async generate(request) { seen.push({ system: request.system ?? "", tools: (request.tools ?? []).map((tool) => tool.name) }); return { kind: "text", text: "current answer" }; } } })({ parentSessionId: record.parentSessionId, getParentTools: () => ["Read", "Bash", "Write"], getCurrentAgentDefinition: () => current as never, ...(withParentPolicy ? { getParentPolicy: () => ({ mode: "default" as const, version: 2, hash: "current" }) } : {}), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("first followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    await restored.generationDone?.();
    expect(seen[0]!.system).toContain("current trusted persona");
    expect(seen[0]!.system).not.toContain("saved persona");
    expect(seen[0]!.tools).toEqual(["Read"]);
    expect(record.permission.effectiveMode).toBe("plan");
    expect(record.execution!.request.definition!.memory).toBeUndefined();
    expect(record.execution!.request.definition!.disallowedTools).toEqual(["Write", "Bash"]);
    const stored = await store.load({ projectKey: record.execution!.projectKey, sessionId: record.parentSessionId, subpath: `subagents/agent-${record.id}` });
    const metadata = stored!.find((entry) => entry.type === "agent_metadata")!;
    expect((metadata.permission as typeof record.permission).effectiveMode).toBe("plan");
    expect((metadata.execution as typeof record.execution)!.inheritance.tools).toEqual(["Read"]);
    current = { ...current, prompt: "second current persona", tools: ["Read", "Bash", "Write"], disallowedTools: [], permissionMode: "default", memory: "user" };
    expect(await restored.resume(message("second followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    expect(seen[1]!.system).toContain("second current persona");
    expect(seen[1]!.tools).toEqual(["Read"]);
    expect(record.permission.effectiveMode).toBe("plan");
    expect(record.execution!.request.definition!.memory).toBeUndefined();
  });

  test.each(["removed", "no longer trusted", "fork"])("a %s named definition refuses before provider execution", async (kind) => {
    const { root, store, record } = await persistedChild();
    record.execution!.request.agentType = kind === "fork" ? "fork" : "reviewer";
    if (kind === "fork") record.execution!.request.fork = true;
    let calls = 0;
    const factory = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { calls++; return { kind: "text", text: "must not run" }; } } })({ parentSessionId: record.parentSessionId, getCurrentAgentDefinition: () => undefined, ...(kind === "no longer trusted" ? { getParentAgents: () => ({ reviewer: { description: "cached", prompt: "cached untrusted definition" } }) } : {}), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("followup"))).toMatchObject({ status: "unavailable", retryable: false });
    expect(calls).toBe(0);
    expect(restored.status()).toBe("completed");
  });

  test.each(["cwd", "root", "project key", "roster key"])("a mismatched %s cannot redirect a restored child", async (kind) => {
    const { root, store, record } = await persistedChild();
    if (kind === "root") record.execution!.workspace.root = join(root, "unexpected");
    if (kind === "project key" || kind === "roster key") record.execution!.projectKey = "unrelated-project";
    if (kind === "roster key") bindChildExecutionProjectKey(record, compatibilityKeys(root).transcriptProjectKey);
    let calls = 0;
    const factory = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { calls++; return { kind: "text", text: "must not run" }; } } })({ parentSessionId: record.parentSessionId, getParentWorkspace: () => ({ cwd: kind === "cwd" ? join(root, "moved") : root, projectKey: compatibilityKeys(root).transcriptProjectKey }), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("followup"))).toMatchObject({ status: "unavailable", retryable: false });
    expect(calls).toBe(0);
  });

  test.each(["current narrowed tools", "current Agent(type) restriction", "saved Agent(type) restriction"])("a dormant ancestor enforces %s on direct descendant continuation", async (kind) => {
    const { root, store, record } = await persistedChild();
    const ancestor = JSON.parse(JSON.stringify(record)) as ChildSessionRecord;
    ancestor.id = "dormant-reviewer";
    ancestor.execution!.request.agentType = "reviewer";
    record.execution!.request.agentType = "worker";
    record.spawnDepth = 2;
    record.execution!.parentAgentId = ancestor.id;
    if (kind === "saved Agent(type) restriction") ancestor.execution!.request.definition!.tools = ["*", "Agent(Explore)"];
    let tools: string[] = [];
    let calls = 0;
    const parent = { description: "current reviewer", prompt: "parent persona", tools: kind === "current narrowed tools" ? ["Read"] : kind === "current Agent(type) restriction" ? ["*", "Agent(Explore)"] : ["*"], permissionMode: "plan" };
    const factory = createChildEngineFactory({ store, winterHome: root, provider: { async generate(request) { calls++; tools = (request.tools ?? []).map((tool) => tool.name); return { kind: "text", text: "nested answer" }; } } })({ parentSessionId: record.parentSessionId, getRecordedChild: (id) => id === ancestor.id ? ancestor : undefined, getParentTools: () => ["Read", "Bash"], getCurrentAgentDefinition: (name) => (name === "reviewer" ? parent : { description: "current worker", prompt: "worker persona", tools: ["Read", "Bash"] }) as never, getParentPolicy: () => ({ mode: "default", version: 2, hash: "root" }), getParentWorkspace: () => ({ cwd: root, projectKey: compatibilityKeys(root).transcriptProjectKey }), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    const outcome = await restored.resume(message("direct nested followup"));
    if (kind === "current narrowed tools") {
      expect(outcome).toMatchObject({ status: "resumed_and_delivered" });
      await waitForSettled(restored);
      expect(tools).toEqual(["Read"]);
      expect(record.permission.effectiveMode).toBe("plan");
    } else {
      expect(outcome).toMatchObject({ status: "unavailable", retryable: false });
      expect(calls).toBe(0);
    }
  });
});

describe("cold continuation retains fresh-spawn forced modes and durable floors", () => {
  const forcedModes: PermissionMode[] = ["auto", "acceptEdits", "bypassPermissions"];
  const definitionModes: Array<string | undefined> = ["default", "plan", "dontAsk", "auto", "acceptEdits", "bypassPermissions", "bubble", undefined];
  test.each(forcedModes.flatMap((parent) => definitionModes.map((definition) => ({ parent, definition }))))("$parent parent ignores $definition definition override on cold resume", async ({ parent, definition }) => {
    const { root, store, record } = await persistedChild(parent, definition);
    record.execution!.request.agentType = "reviewer";
    let calls = 0;
    const actualModes: string[] = [];
    const factory = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { calls++; return { kind: "text", text: "forced answer" }; } } })({ parentSessionId: record.parentSessionId, getParentPolicy: () => ({ mode: parent, version: 2, hash: "forced-current" }), getCurrentAgentDefinition: () => ({ description: "current", prompt: "current persona", ...(definition !== undefined ? { permissionMode: definition } : {}) }), forwardChildFrame(frame) { const data = frame as { message?: { subtype?: string; permissionMode?: string } }; if (data.message?.subtype === "init" && data.message.permissionMode !== undefined) actualModes.push(data.message.permissionMode); } });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("forced followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    await restored.generationDone?.();
    expect(calls).toBe(1);
    expect(actualModes).toContain(parent);
    expect(record.permission).toEqual({ effectiveMode: parent, parentPolicyVersion: 2, parentPolicyHash: "forced-current" });
    const stored = await store.load({ projectKey: record.execution!.projectKey, sessionId: record.parentSessionId, subpath: `subagents/agent-${record.id}` });
    expect((stored!.find((entry) => entry.type === "agent_metadata")!.permission as typeof record.permission).effectiveMode).toBe(parent);
  });

  const changed: Array<{ saved: PermissionMode; parent: PermissionMode; definition: PermissionMode; expected?: PermissionMode }> = [
    { saved: "default", parent: "auto", definition: "plan", expected: "auto" },
    { saved: "plan", parent: "auto", definition: "dontAsk", expected: "plan" },
    { saved: "default", parent: "acceptEdits", definition: "plan", expected: "default" },
    { saved: "plan", parent: "bypassPermissions", definition: "default", expected: "plan" },
    { saved: "dontAsk", parent: "auto", definition: "plan" },
    { saved: "auto", parent: "default", definition: "dontAsk" },
    { saved: "auto", parent: "dontAsk", definition: "default" },
    { saved: "auto", parent: "plan", definition: "default", expected: "plan" },
  ];
  test.each(changed)("saved $saved under changed $parent parent and $definition definition preserves its floor", async ({ saved, parent, definition, expected }) => {
    const { root, store, record } = await persistedChild(saved);
    record.execution!.request.agentType = "reviewer";
    let calls = 0;
    const factory = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { calls++; return { kind: "text", text: "changed answer" }; } } })({ parentSessionId: record.parentSessionId, getParentPolicy: () => ({ mode: parent, version: 2, hash: "changed-current" }), getCurrentAgentDefinition: () => ({ description: "current", prompt: "current persona", permissionMode: definition }), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    const outcome = await restored.resume(message("changed followup"));
    if (expected === undefined) {
      expect(outcome).toMatchObject({ status: "unavailable", retryable: false });
      expect("reason" in outcome ? outcome.reason : "").toContain("INCOMPARABLE");
      expect(calls).toBe(0);
      expect(record.permission.effectiveMode).toBe(saved);
    } else {
      expect(outcome).toMatchObject({ status: "resumed_and_delivered" });
      await waitForSettled(restored);
      await restored.generationDone?.();
      expect(calls).toBe(1);
      expect(record.permission.effectiveMode).toBe(expected);
    }
    expect(currentRunningSubagentCount()).toBe(0);
  });

  test("a dormant ancestor's forced auto mode ignores plan definitions while retaining a saved plan descendant", async () => {
    const { root, store, record } = await persistedChild("auto", "plan");
    const ancestor = JSON.parse(JSON.stringify(record)) as ChildSessionRecord;
    ancestor.id = "forced-dormant-parent";
    ancestor.execution!.request.agentType = "reviewer";
    record.execution!.parentAgentId = ancestor.id;
    record.execution!.request.agentType = "worker";
    record.spawnDepth = 2;
    let calls = 0;
    const factory = createChildEngineFactory({ store, winterHome: root, getParentPolicy: () => ({ mode: "auto", version: 2, hash: "root-auto" }), provider: { async generate() { calls++; return { kind: "text", text: "nested forced answer" }; } } })({ parentSessionId: record.parentSessionId, getRecordedChild: (id) => id === ancestor.id ? ancestor : undefined, getParentPolicy: () => ({ mode: "auto", version: 2, hash: "root-auto" }), getCurrentAgentDefinition: () => ({ description: "current", prompt: "current persona", permissionMode: "plan" }), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("nested forced followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    await restored.generationDone?.();
    expect(record.permission.effectiveMode).toBe("auto");
    record.permission.effectiveMode = "plan";
    expect(await restored.resume(message("retain saved plan"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    expect(record.permission.effectiveMode).toBe("plan");
    expect(calls).toBe(2);
  });

  test("the current host's bypass veto applies before a definition is restored", async () => {
    const { root, store, record } = await persistedChild();
    record.execution!.request.agentType = "reviewer";
    const modes: string[] = [];
    const factory = createChildEngineFactory({ store, winterHome: root, disableBypassPermissionsMode: true, provider: { async generate() { return { kind: "text", text: "veto answer" }; } } })({ parentSessionId: record.parentSessionId, getParentPolicy: () => ({ mode: "default", version: 2, hash: "veto-current" }), getCurrentAgentDefinition: () => ({ description: "current", prompt: "current persona", permissionMode: "bypassPermissions" }), forwardChildFrame(frame) { const data = frame as { message?: { subtype?: string; permissionMode?: string } }; if (data.message?.subtype === "init" && data.message.permissionMode !== undefined) modes.push(data.message.permissionMode); } });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("veto followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    expect(modes).toContain("default");
    expect(record.permission.effectiveMode).toBe("default");
  });
});

describe("cold continuation normalizes definition tool names before intersecting authority", () => {
  test("a registered old name still carries its configured legacy deny onto the current tool", async () => {
    const { root, store, record } = await persistedChild();
    record.execution!.request.agentType = "reviewer";
    record.execution!.request.definition!.disallowedTools = ["Read"];
    let tools: string[] = [];
    const factory = createChildEngineFactory({ store, winterHome: root, parentLegacyToolNames: { Read: "Bash" }, provider: { async generate(request) { tools = (request.tools ?? []).map((tool) => tool.name); return { kind: "text", text: "collision answer" }; } } })({ parentSessionId: record.parentSessionId, getParentTools: () => ["Read", "Bash"], getCurrentAgentDefinition: () => ({ description: "current", prompt: "current persona", tools: ["Read", "Bash"] }), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("collision followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    expect(tools).toEqual([]);
    expect(record.execution!.request.definition!.disallowedTools).toEqual(["Read", "Bash"]);
  });

  test.each([
    { source: "saved", spelling: "Agent" },
    { source: "current", spelling: "Agent" },
    { source: "saved", spelling: "OldAgent" },
    { source: "current", spelling: "OldAgent" },
    { source: "saved rules", spelling: "OldAgent" },
  ])("a dormant ancestor's $source $spelling(type) deny blocks direct descendant continuation", async ({ source, spelling }) => {
    const { root, store, record } = await persistedChild();
    const ancestor = JSON.parse(JSON.stringify(record)) as ChildSessionRecord;
    ancestor.id = "denied-dormant-parent";
    ancestor.execution!.request.agentType = "reviewer";
    record.execution!.parentAgentId = ancestor.id;
    record.execution!.request.agentType = "worker";
    record.spawnDepth = 2;
    const rule = `${spelling}(Explore, worker)`;
    if (source === "saved") ancestor.execution!.request.definition!.disallowedTools = [rule];
    if (source === "saved rules") ancestor.execution!.restrictions.deny = [rule];
    let calls = 0;
    const factory = createChildEngineFactory({ store, winterHome: root, parentLegacyToolNames: { OldAgent: "Agent" }, provider: { async generate() { calls++; return { kind: "text", text: "must not run" }; } } })({ parentSessionId: record.parentSessionId, getRecordedChild: (id) => id === ancestor.id ? ancestor : undefined, getCurrentAgentDefinition: (name) => ({ description: "current", prompt: "current persona", tools: ["*"], disallowedTools: name === "reviewer" && source === "current" ? [rule] : [] }), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    const outcome = await restored.resume(message("denied worker"));
    expect(outcome).toMatchObject({ status: "unavailable", retryable: false });
    expect("reason" in outcome ? outcome.reason : "").toContain("denied by permission rule 'Agent(Explore, worker)'");
    expect(calls).toBe(0);
    expect(currentRunningSubagentCount()).toBe(0);
  });

  const cases = [
    { label: "saved legacy, current canonical", saved: ["OldRead"], current: ["Read"], savedDeny: [], currentDeny: [], expected: ["Read"] },
    { label: "saved canonical, current legacy", saved: ["Read"], current: ["OldRead"], savedDeny: [], currentDeny: [], expected: ["Read"] },
    { label: "both legacy", saved: ["OldRead"], current: ["OldRead"], savedDeny: [], currentDeny: [], expected: ["Read"] },
    { label: "saved legacy deny", saved: ["*"], current: ["*"], savedDeny: ["OldRead"], currentDeny: [], expected: ["Bash"] },
    { label: "current legacy deny", saved: ["*"], current: ["*"], savedDeny: [], currentDeny: ["OldBash"], expected: ["Read"] },
    { label: "canonical deny", saved: ["*"], current: ["*"], savedDeny: ["Bash"], currentDeny: [], expected: ["Read"] },
  ];
  test.each(cases)("$label preserves fresh-spawn tool availability", async ({ saved, current, savedDeny, currentDeny, expected }) => {
    const { root, store, record } = await persistedChild();
    record.execution!.request.agentType = "reviewer";
    record.execution!.request.definition!.tools = saved;
    record.execution!.request.definition!.disallowedTools = savedDeny;
    let tools: string[] = [];
    const factory = createChildEngineFactory({ store, winterHome: root, parentLegacyToolNames: { OldRead: "Read", OldBash: "Bash" }, provider: { async generate(request) { tools = (request.tools ?? []).map((tool) => tool.name); return { kind: "text", text: "normalized answer" }; } } })({ parentSessionId: record.parentSessionId, getParentTools: () => ["Read", "Bash"], getCurrentAgentDefinition: () => ({ description: "current", prompt: "current persona", tools: current, disallowedTools: currentDeny }), forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("normalized followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    await restored.generationDone?.();
    expect(tools).toEqual(expected);
    expect(record.execution!.inheritance.tools).toEqual(expected);
    expect(record.execution!.request.definition!.disallowedTools).toEqual([...new Set([...savedDeny, ...currentDeny].map((name) => name === "OldRead" ? "Read" : name === "OldBash" ? "Bash" : name))]);
  });

  test("saved/current Agent(type) scopes intersect independently of canonical and legacy ordinary tools", async () => {
    const { root, store, record } = await persistedChild();
    const ancestor = JSON.parse(JSON.stringify(record)) as ChildSessionRecord;
    ancestor.id = "scoped-dormant-parent";
    ancestor.execution!.request.agentType = "reviewer";
    ancestor.execution!.request.definition!.tools = ["*", "Agent(worker,Explore)"];
    record.execution!.parentAgentId = ancestor.id;
    record.execution!.request.agentType = "worker";
    record.spawnDepth = 2;
    let tools: string[] = [];
    const factory = createChildEngineFactory({ store, winterHome: root, parentLegacyToolNames: { OldRead: "Read" }, provider: { async generate(request) { tools = (request.tools ?? []).map((tool) => tool.name); return { kind: "text", text: "scoped answer" }; } } })({ parentSessionId: record.parentSessionId, getRecordedChild: (id) => id === ancestor.id ? ancestor : undefined, getParentTools: () => ["Read", "Bash"], getCurrentAgentDefinition: (name) => name === "reviewer" ? { description: "current parent", prompt: "current parent persona", tools: ["OldRead", "Agent(worker,Plan)"] } : { description: "worker", prompt: "current worker", tools: ["Read", "Bash"] }, forwardChildFrame() {} });
    const restored = restoredChildHandle(record);
    bindRestoredChildren([restored], factory.restore!);
    expect(await restored.resume(message("allowed worker"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitForSettled(restored);
    expect(tools).toEqual(["Read"]);
    record.execution!.request.agentType = "Explore";
    expect(await restored.resume(message("saved-only type"))).toMatchObject({ status: "unavailable", retryable: false });
    record.execution!.request.agentType = "Plan";
    expect(await restored.resume(message("current-only type"))).toMatchObject({ status: "unavailable", retryable: false });
  });
});

test("failure to persist a fresh child snapshot warns and runs once without resumability", async () => {
  const root = freshHome();
  const store = new WinterCompatibilitySessionStore({ winterHome: root });
  const append = spyOn(store, "append").mockRejectedValue(new Error("private store error contents"));
  let calls = 0;
  const warnings: string[] = [];
  try {
    const factory = createChildEngineFactory({ store, winterHome: root, warn: (line) => warnings.push(line), provider: { async generate() { calls++; return { kind: "text", text: "successful original generation" }; } } })({ parentSessionId: "lease-fixture", forwardChildFrame() {} });
    const child = await factory.spawn({ parentToolUseId: "lease-spawn", prompt: "task", runInBackground: false }, inheritance(root));
    await waitForSettled(child);
    await child.generationDone?.();
    expect(await child.result()).toMatchObject({ status: "completed", content: "successful original generation" });
    expect(child.record.execution).toBeUndefined();
    expect(child.record.transcript).toContain("persistence is unavailable");
    expect(warnings.join("\n")).toContain("without durable resumability");
    expect(warnings.join("\n")).not.toContain("private store error contents");
    expect(await child.resume(message("cannot resume"))).toMatchObject({ status: "unavailable", retryable: false });
    expect(calls).toBe(1);
    expect(currentRunningSubagentCount()).toBe(0);
  } finally { append.mockRestore(); }
});

test("an unknown MCP string reference ignored at spawn does not become a cold-resume dependency", async () => {
  const root = freshHome();
  const store = new WinterCompatibilitySessionStore({ winterHome: root });
  let calls = 0;
  const factory = createChildEngineFactory({ store, winterHome: root, provider: { async generate() { calls++; return { kind: "text", text: "MCP fixture answer" }; } } })({ parentSessionId: "unknown-mcp-parent", forwardChildFrame() {} });
  const child = await factory.spawn({ parentToolUseId: "mcp-spawn", prompt: "task", runInBackground: false, definition: { description: "MCP fixture", prompt: "persona", mcpServers: ["not-declared"] } }, inheritance(root));
  await waitForSettled(child);
  await child.generationDone?.();
  expect(child.record.execution!.inheritedMcpServerNames).toEqual([]);
  const restored = restoredChildHandle(JSON.parse(JSON.stringify(child.record)) as ChildSessionRecord);
  bindRestoredChildren([restored], factory.restore!);
  expect(await restored.resume(message("MCP followup"))).toMatchObject({ status: "resumed_and_delivered" });
  await waitForSettled(restored);
  expect(calls).toBe(2);
});

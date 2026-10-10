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
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
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
import { snapshotChildExecution } from "./execution-snapshot.ts";
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

async function persistedChild() {
  const root = freshHome();
  const store = new WinterCompatibilitySessionStore({ winterHome: root });
  const deps = createChildEngineFactory({ provider: { async generate() { return { kind: "text", text: "original answer" }; } }, store, winterHome: root })({ parentSessionId: "cold-parent", forwardChildFrame() {} });
  const child = await deps.spawn({ parentToolUseId: "original-spawn", prompt: "original marker", runInBackground: false, name: "cold-child", definition: { description: "persona fixture", prompt: "saved persona", tools: ["Read", "Bash"] } }, inheritance(root));
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
  expect(await pending).toMatchObject({ status: "unavailable", retryable: false });
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

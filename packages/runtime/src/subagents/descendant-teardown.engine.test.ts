import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WinterCompatibilitySessionStore, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type Provider } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { userMessageText } from "../provider/mock.ts";
import { registerTool, unregisterToolForTest } from "../tools/registry.ts";
import { createChildEngineFactory } from "./child-engine.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type ChildHandle, type ChildInheritance, type ChildSessionRecord } from "./child-handle.ts";
import { currentRunningSubagentCount, resetSpawnLimitsForTest } from "./limits.ts";
import { bindRestoredChildren, drainRestoredChildren, restoredChildHandle } from "./restore.ts";

const homes: string[] = [];
const PROBE = "descendant_teardown_permission_probe";
// The running-subagent counter is process-wide: under a whole-repo `bun test`, a file that runs earlier
// and leaves a child counted would otherwise shift this file's exact counts (the v0.0.59 release job
// read 3 where 2 are running here). Start every test from zero, as `afterEach` already ends it.
beforeEach(() => resetSpawnLimitsForTest());
afterEach(() => {
  unregisterToolForTest(PROBE);
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("descendant teardown condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function message(body: string) { return { messageId: randomUUID(), body } as never; }

async function persistedFamily() {
  const home = mkdtempSync(join(tmpdir(), "winter-descendant-teardown-"));
  homes.push(home);
  const cwd = home;
  const sessionId = randomUUID();
  const store = new WinterCompatibilitySessionStore({ winterHome: home });
  const finishSeedParent = deferred();
  const factory = createChildEngineFactory({ store, winterHome: home, provider: { async generate({ messages }) {
    if (messages.some((entry) => userMessageText(entry).includes("original parent"))) await finishSeedParent.promise;
    return { kind: "text", text: "original answer" };
  } } });
  const inheritance: ChildInheritance = { policy: { effectiveMode: "default", parentPolicyHash: "original", parentPolicyVersion: 1 }, tools: [PROBE], model: "winter-test/echo", effort: "inherit", thinking: undefined, systemPrompt: "", sessionRoot: cwd };
  const parent = await factory({ parentSessionId: sessionId, forwardChildFrame() {} }).spawn({ parentToolUseId: "parent-call", prompt: "original parent", runInBackground: false }, inheritance);
  const grandchild = await factory({ parentSessionId: sessionId, parentAgentId: parent.record.id, forwardChildFrame() {} }).spawn({ parentToolUseId: "grandchild-call", prompt: "original grandchild", runInBackground: false }, inheritance);
  await grandchild.result();
  await grandchild.generationDone?.();
  finishSeedParent.resolve();
  await parent.result();
  await parent.generationDone?.();
  return { home, cwd, sessionId, store, parent: restoredChildHandle(structuredClone(parent.record)), grandchild: restoredChildHandle(structuredClone(grandchild.record)) };
}

test.each(["parent", "root"])("%s shutdown drains restored descendants and forwards pending permission cancellation before closing the output", async (ending) => {
  let executions = 0;
  registerTool({ descriptor: { canonicalName: PROBE, advertisedName: PROBE, source: "builtin", inputSchema: { type: "object" }, description: "test permission prompt", exposure: "eager", permissionClass: "edit", availability: {}, capabilityRequirements: [], disposition: "implement-now" }, executor: { async execute() { executions++; return { output: "approved" }; } } });
  const family = await persistedFamily();
  const finishParent = deferred();
  const parentEntered = deferred();
  let grandchildGenerations = 0;
  const provider: Provider = { async generate({ messages }) {
    const text = messages.filter((m) => m.role === "user").map(userMessageText).join("\n");
    if (text.includes("original grandchild")) {
      if (++grandchildGenerations > 1) return { kind: "text", text: "grandchild resumed on root" };
      return { kind: "tool_use", calls: [{ id: "grandchild-permission", name: PROBE, input: {} }] };
    }
    if (text.includes("original parent")) { parentEntered.resolve(); await finishParent.promise; return { kind: "text", text: "parent completed" }; }
    return { kind: "text", text: "root completed" };
  } };
  registerChildEngineFactory(createChildEngineFactory({ store: family.store, winterHome: family.home, provider }));
  const { host, runtime } = createInMemoryChannel();
  const frames: WinterFrame[] = [];
  const done = runEngine({ config: { sessionId: family.sessionId, cwd: family.cwd, model: "winter-test/echo", permissionMode: "default", forwardSubagentText: true }, input: runtime.input, output: runtime.output, provider, restoredChildren: [family.parent, family.grandchild], winterHome: family.home });
  const reader = (async () => { for await (const frame of host.input) frames.push(frame); })();
  try {
    await waitUntil(() => frames.some((frame) => frame.type === "data" && (frame.message as { subtype?: string }).subtype === "init"));
    expect(await family.parent.resume(message("parent followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await parentEntered.promise;
    expect(await family.grandchild.resume(message("grandchild followup"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitUntil(() => frames.some((frame) => frame.type === "control_request" && frame.subtype === "permission"));
    const request = frames.find((frame) => frame.type === "control_request" && frame.subtype === "permission")! as { requestId: string };
    expect(family.grandchild.status()).toBe("running");
    expect(currentRunningSubagentCount()).toBe(2);
    if (ending === "parent") finishParent.resolve();
    else {
      host.output.write({ type: "user", text: "finish root" });
      host.output.write({ type: "control_request", requestId: "root-shutdown", subtype: "end_input", payload: undefined });
      await done;
    }
    await family.parent.generationDone?.();
    expect(family.grandchild.status()).toBe("stopped");
    expect(currentRunningSubagentCount()).toBe(0);
    expect(executions).toBe(0);
    // Cancellation must traverse G -> P -> root before P ends its stream.
    await waitUntil(() => frames.some((frame) => frame.type === "control_cancel_request" && frame.requestId === request.requestId));
    if (ending === "parent") {
      expect(await family.grandchild.resume(message("root followup"))).toMatchObject({ status: "resumed_and_delivered" });
      await waitUntil(() => family.grandchild.status() !== "running");
      await family.grandchild.generationDone?.();
      expect(family.grandchild.status()).toBe("completed");
      expect(currentRunningSubagentCount()).toBe(0);
      await waitUntil(() => frames.some((frame) => frame.type === "data" && JSON.stringify(frame.message).includes("grandchild resumed on root")));
    } else {
      // A parent's completed drain must not reopen its fallback while the root itself is ending.
      expect(await family.grandchild.resume(message("after root shutdown"))).toMatchObject({ status: "unavailable", retryable: true });
      expect(currentRunningSubagentCount()).toBe(0);
    }
  } finally {
    finishParent.resolve();
    await family.parent.stop();
    await family.grandchild.stop();
    host.output.write({ type: "user", text: "finish root" });
    host.output.write({ type: "control_request", requestId: "finish", subtype: "end_input", payload: undefined });
    await done;
    await reader;
  }
}, 10_000);

test("teardown invalidates a lazy materialization before awaiting it and rejects new resumes until root rebinding", async () => {
  const record = { id: "pending-descendant", parentSessionId: "session", parentToolUseId: "call", transcript: "/unused", runtime: "winter-agent", status: "completed", model: { effectiveModel: "winter-test/echo", effectiveEffort: "inherit" }, permission: { effectiveMode: "default", parentPolicyHash: "original", parentPolicyVersion: 1 } } as ChildSessionRecord;
  const child = restoredChildHandle(record);
  const materialized = deferred<ChildHandle>();
  let dispatches = 0;
  const live: ChildHandle = { record, status: () => record.status, async resume(msg) { dispatches++; return { status: "resumed_and_delivered", messageId: msg.messageId }; }, async steer(msg) { return { status: "delivered", messageId: msg.messageId }; }, async result() { return { status: "completed", content: "done" }; }, async stop() {}, async generationDone() {} };
  bindRestoredChildren([child], async () => materialized.promise);
  const resume = child.resume(message("pending"));
  const drain = drainRestoredChildren([child]);
  expect(await child.resume(message("during teardown"))).toMatchObject({ status: "unavailable", retryable: true });
  materialized.resolve(live);
  expect(await resume).toMatchObject({ status: "unavailable", retryable: true });
  await drain;
  expect(dispatches).toBe(0);
  bindRestoredChildren([child], async () => live);
  expect(await child.resume(message("root followup"))).toMatchObject({ status: "resumed_and_delivered" });
  expect(dispatches).toBe(1);
});

test("teardown cancels a resumed provider probe before dispatch and leaves no concurrency slot behind", async () => {
  const family = await persistedFamily();
  const probeEntered = deferred();
  const finishProbe = deferred();
  let probes = 0;
  let generations = 0;
  const context = { parentSessionId: family.sessionId, parentAgentId: family.parent.record.id, forwardChildFrame() {} };
  const factory = createChildEngineFactory({ store: family.store, winterHome: family.home, provider: { async generate() { generations++; return { kind: "text", text: "fresh answer" }; } }, async resolveChildProvider() {
    if (++probes === 1) { probeEntered.resolve(); await finishProbe.promise; }
    return undefined;
  } })(context);
  bindRestoredChildren([family.grandchild], factory.restore!);
  const pending = family.grandchild.resume(message("pending provider probe"));
  try {
    await probeEntered.promise;
    expect(currentRunningSubagentCount()).toBe(0);
    const drained = drainRestoredChildren([family.grandchild]);
    expect(await family.grandchild.resume(message("while draining"))).toMatchObject({ status: "unavailable", retryable: true });
    finishProbe.resolve();
    expect(await pending).toMatchObject({ status: "unavailable", retryable: true });
    await drained;
    expect(currentRunningSubagentCount()).toBe(0);
    expect(generations).toBe(0);
    bindRestoredChildren([family.grandchild], factory.restore!);
    expect(await family.grandchild.resume(message("fresh context"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitUntil(() => family.grandchild.status() !== "running");
    await family.grandchild.generationDone?.();
    expect(generations).toBe(1);
    expect(currentRunningSubagentCount()).toBe(0);
  } finally { finishProbe.resolve(); await family.grandchild.stop(); await family.grandchild.generationDone?.(); }
});

test("context teardown during running metadata persistence preserves the completed child and refuses dispatch retryably", async () => {
  const family = await persistedFamily();
  const child = family.grandchild;
  const metadataEntered = deferred();
  const finishMetadata = deferred();
  const append = family.store.append.bind(family.store);
  let blockedOnce = false;
  let generations = 0;
  const appendSpy = spyOn(family.store, "append").mockImplementation(async (key, entries) => {
    if (!blockedOnce && key.subpath === `subagents/agent-${child.record.id}` && entries.some((entry) => entry.type === "agent_metadata" && entry.status === "running")) {
      blockedOnce = true;
      metadataEntered.resolve();
      await finishMetadata.promise;
    }
    await append(key, entries);
  });
  const factory = createChildEngineFactory({ store: family.store, winterHome: family.home, provider: { async generate() { generations++; return { kind: "text", text: "fresh answer" }; } } })({ parentSessionId: family.sessionId, parentAgentId: family.parent.record.id, forwardChildFrame() {} });
  bindRestoredChildren([child], factory.restore!);
  expect(child.status()).toBe("completed");
  const pending = child.resume(message("pending metadata persistence"));
  try {
    await metadataEntered.promise;
    expect(child.status()).toBe("running");
    expect(currentRunningSubagentCount()).toBe(1);
    const drained = drainRestoredChildren([child]);
    expect(await child.resume(message("while draining"))).toMatchObject({ status: "unavailable", retryable: true });
    finishMetadata.resolve();
    expect(await pending).toMatchObject({ status: "unavailable", retryable: true });
    await drained;
    expect(child.status()).toBe("completed");
    const entries = await family.store.load({ projectKey: child.record.execution!.projectKey, sessionId: family.sessionId, subpath: `subagents/agent-${child.record.id}` });
    expect(entries?.find((entry) => entry.type === "agent_metadata")?.status).toBe("completed");
    expect(generations).toBe(0);
    expect(currentRunningSubagentCount()).toBe(0);
    bindRestoredChildren([child], factory.restore!);
    expect(await child.resume(message("fresh context"))).toMatchObject({ status: "resumed_and_delivered" });
    await waitUntil(() => child.status() !== "running");
    await child.generationDone?.();
    expect(child.status()).toBe("completed");
    expect(generations).toBe(1);
    expect(currentRunningSubagentCount()).toBe(0);
  } finally {
    finishMetadata.resolve();
    await pending;
    await child.stop();
    await child.generationDone?.();
    appendSpy.mockRestore();
  }
});

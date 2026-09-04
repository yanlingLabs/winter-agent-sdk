// Engine-level proof for child-engine.ts (WS-10, R4-4): every test here drives a REAL `runEngine`
// for the PARENT, with `createChildEngineFactory` registered as the REAL child engine factory --
// never a fake ChildHandle. What's proven: the actual wiring (tool call -> registry dispatch ->
// ctx.session.spawnChild -> the real factory -> a real nested runEngine() -> a real result back),
// not merely the pure functions underneath it (already unit-proven in limits/watchdog/resolution/
// policy/fork/workspace/definitions .test.ts).
import { describe, test, expect, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterFrame, RuntimeConfig, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { WinterCompatibilitySessionStore } from "@yanlinglabs/winter-agent-sdk";
import { runEngine } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { registerTool, unregisterToolForTest, type ToolExecutionContext } from "../tools/registry.ts";
import { echoProvider, scriptedProvider } from "../provider/mock.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type SpawnChildRequest } from "./child-handle.ts";
import { createChildEngineFactory, type ChildEngineFactoryDeps } from "./child-engine.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

// Defaults to bypassPermissions (mirroring engine.test.ts's own fix-round-1 spawn-seam precedent):
// a custom fixture tool with no pre-existing rule still reaches a REAL prompt under any
// prompting mode (permissionClass:"read" does NOT itself bypass evaluation -- confirmed
// empirically while writing this file: "read-only free" in WS-07's own prose describes specific
// built-in tools' own behavior, not a blanket exemption for anything merely LABELED "read"), and
// nothing in these tests answers a host-facing permission prompt. Tests that specifically need a
// real prompting mode (the disclosed-gap test below) override this AND pre-seed an explicit allow
// rule for their own outer fixture tool call instead.
const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId: "parent-s", cwd: "/tmp/winter-lane-c-child-engine-tests", model: "sonnet",
  permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
  ...overrides,
});

// --- Fixture tools -----------------------------------------------------------------------------

const SPAWN_PROBE = "t6_spawn_probe";
function registerSpawnProbe(): void {
  registerTool({
    descriptor: {
      canonicalName: SPAWN_PROBE, advertisedName: SPAWN_PROBE, source: "builtin", inputSchema: { type: "object" },
      description: "spawns a child, awaits result(), returns record+result as JSON", exposure: "eager", permissionClass: "read",
      availability: {}, capabilityRequirements: [], disposition: "implement-now",
    },
    executor: {
      async execute(input: unknown, ctx: ToolExecutionContext) {
        if (!ctx.session.spawnChild) return { output: "no spawnChild capability configured", isError: true };
        const handle = await ctx.session.spawnChild(input as SpawnChildRequest);
        const result = await handle.result();
        return { output: JSON.stringify({ record: handle.record, result }) };
      },
    },
  });
}

// A blocking tool the CHILD's own scripted provider calls -- its executor awaits a promise the
// TEST controls (`release()`), giving deterministic control over "the child is genuinely still
// mid-turn" without racing real timers.
function registerBlockingTool(name: string): { release: () => void } {
  let releaseFn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  registerTool({
    descriptor: {
      canonicalName: name, advertisedName: name, source: "builtin", inputSchema: { type: "object" },
      description: "test: blocks until released", exposure: "eager", permissionClass: "read",
      availability: {}, capabilityRequirements: [], disposition: "implement-now",
    },
    executor: { async execute() { await gate; return { output: "released" }; } },
  });
  return { release: () => releaseFn?.() };
}

// A fixture tool that spawns a child and returns the handle's own steer/resume/stop OUTCOME
// directly (without awaiting result()), so a test can interleave assertions against a still-running
// child from OUTSIDE the tool call boundary via the returned agentId + a shared registry.
const liveHandles = new Map<string, Awaited<ReturnType<NonNullable<ToolExecutionContext["session"]["spawnChild"]>>>>();
const SPAWN_AND_REGISTER = "t6_spawn_and_register";
function registerSpawnAndRegister(): void {
  registerTool({
    descriptor: {
      canonicalName: SPAWN_AND_REGISTER, advertisedName: SPAWN_AND_REGISTER, source: "builtin", inputSchema: { type: "object" },
      description: "spawns a child and stashes the handle by agentId for the test to interact with directly", exposure: "eager", permissionClass: "read",
      availability: {}, capabilityRequirements: [], disposition: "implement-now",
    },
    executor: {
      async execute(input: unknown, ctx: ToolExecutionContext) {
        if (!ctx.session.spawnChild) return { output: "no spawnChild capability configured", isError: true };
        const handle = await ctx.session.spawnChild(input as SpawnChildRequest);
        liveHandles.set(handle.record.id, handle);
        return { output: JSON.stringify({ agentId: handle.record.id }) };
      },
    },
  });
}

function fakeGlobalMessage(body: string): import("../messaging/adapter.ts").GlobalAgentMessage {
  const addr = { objectKind: "session" as const, runtimeKind: "winter-agent" as const, winterSessionId: "s1" };
  return {
    messageId: `m-${randomUUID()}`, from: addr, fromGeneration: 1, to: addr, toGeneration: 1,
    body, notifyWhenIdle: false, createdAt: Date.now(), expiresAt: Date.now() + 60_000, hopCount: 0, senderPermissionClass: "unknown",
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!predicate()) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
}

const cleanupToolNames: string[] = [];
afterEach(() => {
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
  liveHandles.clear();
  for (const name of cleanupToolNames.splice(0)) unregisterToolForTest(name);
});

function driveParent(deps: ChildEngineFactoryDeps, config: RuntimeConfig, turns: Parameters<typeof scriptedProvider>[0]): Promise<{ code: number; frames: WinterFrame[] }> {
  registerChildEngineFactory(createChildEngineFactory(deps));
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider(turns);
  const donePromise = runEngine({ config, input: runtime.input, output: runtime.output, provider });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
  return drain(host.input).then(async (frames) => ({ code: await donePromise, frames }));
}

describe("child-engine.ts: foreground spawn end-to-end (WS-10 §1/§3/§4/§7)", () => {
  test("resolves the child's own answer; records the WS-10 §3.4 model/effort fields; forwards child frames correlated to the parent stream", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "hello child", runInBackground: false };
    // forwardSubagentText belongs on the PARENT's own RuntimeConfig -- engine.ts's own
    // ctx.session.spawnChild wiring (frozen) reads `config.forwardSubagentText` (the PARENT's),
    // never anything from ChildEngineFactoryDeps (which only governs what a CHILD, spawning its own
    // grandchildren, would use as ITS OWN default -- a different, nested-level concern).
    const { code, frames } = await driveParent(
      { provider: echoProvider },
      baseConfig({ forwardSubagentText: true }),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);

    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
    const parsed = JSON.parse(block.content) as { record: { model: unknown; permission: unknown }; result: { status: string; content: string } };

    expect(parsed.result.status).toBe("completed");
    expect(parsed.result.content).toBe("echo: hello child");
    expect(parsed.record.model).toEqual({ effectiveModel: "sonnet", effectiveEffort: "inherit" });
    // The parent's own baseConfig() default is bypassPermissions (see that helper's own comment) --
    // WS-07 §11 FORCES bypass onto every descendant, so a bare child inherits it too.
    expect(parsed.record.permission).toMatchObject({ effectiveMode: "bypassPermissions" });

    // The child's own assistant text (forwardSubagentText:true) reached the parent stream, stamped
    // with parent_tool_use_id -- correlated, never flattened into the parent's own main turn.
    const childAssistant = msgs.find(
      (m): m is Extract<SdkMessage, { type: "assistant" }> => m.type === "assistant" && (m as { parent_tool_use_id?: string }).parent_tool_use_id === "call-1",
    );
    expect(childAssistant).toBeDefined();
    // Never a second top-level "result" on the parent's own main stream -- the child's own result is
    // swallowed (transformChildFrame's own WS-04 §4 contract).
    const resultFrames = msgs.filter((m) => m.type === "result");
    expect(resultFrames.length).toBe(1);
  });

  test("an AgentDefinition's own tools allowlist DENIES a call to a tool outside it -- not merely hides it", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const req: SpawnChildRequest = {
      parentToolUseId: "call-1",
      prompt: "try something forbidden",
      runInBackground: false,
      definition: { description: "narrow", prompt: "narrow", tools: ["SomeOtherTool"] },
    };
    // The child's own provider tries Bash (NOT in its allowlist) then, once denied, answers with text.
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "b1", name: "Bash", input: { command: "echo hi" } }] },
      { kind: "text", text: "saw the denial" },
    ]);
    // tool_use/tool_result blocks forward unconditionally (WS-10 §4) -- no forwardSubagentText
    // needed for this assertion, which only inspects a "user" (tool_result) data frame.
    const { frames } = await driveParent({ provider: childProvider }, baseConfig(), [
      { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
      { kind: "text", text: "parent done" },
    ]);
    const msgs = dataMessages(frames);
    const userMsgs = msgs.filter((m): m is Extract<SdkMessage, { type: "user" }> => m.type === "user" && (m as { parent_tool_use_id?: string }).parent_tool_use_id === "call-1");
    const deniedBlock = userMsgs
      .flatMap((m) => (m as unknown as { message: { content: Array<{ tool_use_id: string; denied?: boolean }> } }).message.content)
      .find((b) => b.tool_use_id === "b1");
    expect(deniedBlock?.denied).toBe(true);
  });
});

describe("child-engine.ts: limits (WS-10 §6) surface as legible tool_result errors, never a crash", () => {
  test("an unresolvable model alias never silently substitutes -- surfaces the typed error text", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "hi", runInBackground: false, model: "opus" };
    const { code, frames } = await driveParent(
      { provider: echoProvider, modelCatalog: { availableModels: ["claude-sonnet-4-5"] } },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "unreachable" }],
    );
    expect(code).toBe(0); // a tool-executor throw is a normal exit, never a rejected runEngine promise
    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string; error?: boolean }> } };
    const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
    expect(block.error).toBe(true);
    expect(block.content).toContain("opus");
  });

  test("concurrency exceeded (max 1) rejects a second spawn while the first is still genuinely running", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const BLOCK_TOOL = "t6_block_a";
    cleanupToolNames.push(BLOCK_TOOL);
    const gate = registerBlockingTool(BLOCK_TOOL);
    const blockedReq: SpawnChildRequest = {
      parentToolUseId: "call-1", prompt: "block", runInBackground: false,
      definition: { description: "d", prompt: "d", tools: [BLOCK_TOOL] },
    };
    const blockedProvider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "b1", name: BLOCK_TOOL, input: {} }] }, { kind: "text", text: "unblocked" }]);

    registerChildEngineFactory(createChildEngineFactory({ provider: blockedProvider, env: { WINTER_MAX_CONCURRENT_SUBAGENTS: "1" } }));
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: blockedReq }] },
      { kind: "tool_use", calls: [{ id: "call-2", name: SPAWN_AND_REGISTER, input: { ...blockedReq, parentToolUseId: "call-2" } }] },
      { kind: "text", text: "done" },
    ]);
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    gate.release();

    const msgs = dataMessages(frames);
    const userMsgs = msgs.filter((m): m is Extract<SdkMessage, { type: "user" }> => m.type === "user");
    const call2Result = userMsgs.flatMap((m) => (m as unknown as { message: { content: Array<{ tool_use_id: string; content: string; error?: boolean }> } }).message.content).find((b) => b.tool_use_id === "call-2");
    expect(call2Result?.error).toBe(true);
    expect(call2Result?.content).toContain("already running");
  });
});

describe("child-engine.ts: steer/resume/stop against a real, deterministically-blocked child (WS-10 §7/§9/§15)", () => {
  test("steer() while genuinely mid-turn delivers; the child then finishes normally once unblocked", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const BLOCK_TOOL = "t6_block_steer";
    cleanupToolNames.push(BLOCK_TOOL);
    const gate = registerBlockingTool(BLOCK_TOOL);
    const req: SpawnChildRequest = {
      parentToolUseId: "call-1", prompt: "block then finish", runInBackground: false,
      definition: { description: "d", prompt: "d", tools: [BLOCK_TOOL] },
    };
    const childProvider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "b1", name: BLOCK_TOOL, input: {} }] }, { kind: "text", text: "finished" }]);
    registerChildEngineFactory(createChildEngineFactory({ provider: childProvider }));

    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] }, { kind: "text", text: "done" }]);
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const drainPromise = drain(host.input);

    await waitUntil(() => liveHandles.size === 1);
    const handle = [...liveHandles.values()][0]!;
    await waitUntil(() => handle.status() === "running"); // true immediately, but proves the accessor before any steer

    const outcome = await handle.steer(fakeGlobalMessage("still there?"));
    expect(outcome.status).toBe("delivered");

    gate.release();
    const result = await handle.result();
    expect(result.status).toBe("completed");
    expect(result.content).toBe("finished");

    await drainPromise;
    await done;
  });

  test("stop() terminates a genuinely-blocked child and PERMANENTLY settles result() as 'stopped' -- a later interrupted-turn result frame never overwrites it", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const BLOCK_TOOL = "t6_block_stop";
    cleanupToolNames.push(BLOCK_TOOL);
    const gate = registerBlockingTool(BLOCK_TOOL);
    const req: SpawnChildRequest = {
      parentToolUseId: "call-1", prompt: "block forever", runInBackground: false,
      definition: { description: "d", prompt: "d", tools: [BLOCK_TOOL] },
    };
    // A second scripted turn exists so that IF the interrupted engine somehow still asked the
    // provider again, it would produce a normal completion -- proving stop()'s own "stopped" status
    // is not merely "nothing else ever happened to run."
    const childProvider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "b1", name: BLOCK_TOOL, input: {} }] }, { kind: "text", text: "should never be observed as the final status" }]);
    registerChildEngineFactory(createChildEngineFactory({ provider: childProvider }));

    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] }, { kind: "text", text: "done" }]);
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const drainPromise = drain(host.input);

    await waitUntil(() => liveHandles.size === 1);
    const handle = [...liveHandles.values()][0]!;
    await handle.stop();
    expect(handle.status()).toBe("stopped");
    const result = await handle.result();
    // toMatchObject, not toEqual -- the real implementation's own ChildResult also carries
    // resolvedModel/totalDurationMs/totalToolUseCount (a widening beyond the minimal fake's own
    // {status, content}-only stop() result, which ChildResult's own optional fields allow).
    expect(result).toMatchObject({ status: "stopped", content: "stopped by request" });

    // Release the blocked tool AFTER stop() -- the interrupted engine's own eventual (if any)
    // activity must never resurrect the child out of "stopped".
    gate.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(handle.status()).toBe("stopped");

    await drainPromise;
    await done;
  });
});

describe("child-engine.ts: durable resume (WS-10 §7)", () => {
  test("resume() after natural completion rebuilds history from the durable transcript and runs a fresh turn", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const winterHome = mkdtempSync(join(tmpdir(), "winter-lane-c-resume-"));
    const parentCwd = mkdtempSync(join(tmpdir(), "winter-lane-c-resume-repo-"));
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome });
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "first turn", runInBackground: false };
      registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider, store }));

      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] }, { kind: "text", text: "done" }]);
      const parentConfig = baseConfig({ cwd: parentCwd });
      const done = runEngine({ config: parentConfig, input: runtime.input, output: runtime.output, provider });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      const drainPromise = drain(host.input);

      await waitUntil(() => liveHandles.size === 1);
      const handle = [...liveHandles.values()][0]!;
      await waitUntil(() => handle.status() === "completed");
      expect((await handle.result()).content).toBe("echo: first turn");

      const outcome = await handle.resume(fakeGlobalMessage("second turn"));
      expect(outcome.status).toBe("resumed_and_delivered");
      expect(handle.status()).toBe("running");
      await waitUntil(() => handle.status() === "completed");

      // result() itself never re-settles past its FIRST completion (the seam-contracts-p4.test.ts
      // fixture's own pinned behavior) -- the SECOND generation's own outcome is observable only
      // through record.status, proven above, never through a second resolution of result().
      expect((await handle.result()).content).toBe("echo: first turn");

      await drainPromise;
      await done;
    } finally {
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });
});

describe("child-engine.ts: disclosed gap -- child permission control-RPCs under a prompting mode (see this file's own header, gap 2)", () => {
  test("a child under 'default' mode that reaches a real permission prompt STALLS, and the watchdog aborts it with a typed error rather than hanging forever", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    // Deliberately NOT bypassPermissions (the advisor's own instruction: testing only under bypass
    // would hide this gap entirely, since bypass mode never issues a permission control_request --
    // and computeChildPolicy FORCES bypass onto every descendant of a bypass parent, so the child
    // would inherit it too). An explicit allow rule pre-approves the OUTER call to the fixture tool
    // itself (its own permissionClass:"read" does not, alone, bypass evaluation under default mode
    // -- confirmed empirically, and is exactly what originally exposed this whole gap while writing
    // this file) so ONLY the child's own inner tool call is left genuinely unresolved.
    //
    // NOT "Bash": empirically, under this codebase's own default-mode evaluation, a sandboxed Bash
    // call runs WITHOUT ever reaching a permission prompt at all (sandboxing is apparently treated
    // as sufficient without an explicit rule) -- a genuinely interesting, real behavior, but not the
    // one this test needs. A fresh, unknown custom tool with no special-cased treatment is what
    // reliably reaches stage 6 (prompt) under default mode with no matching rule.
    const NEEDS_PROMPT = "t6_needs_prompt";
    cleanupToolNames.push(NEEDS_PROMPT);
    registerTool({
      descriptor: {
        canonicalName: NEEDS_PROMPT, advertisedName: NEEDS_PROMPT, source: "builtin", inputSchema: { type: "object" },
        description: "a plain custom tool with no special-cased auto-approval", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: { async execute() { return { output: "should never actually run in this test" }; } },
    });
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "run a command", runInBackground: false };
    const childProvider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "b1", name: NEEDS_PROMPT, input: {} }] }]);
    const { code, frames } = await driveParent(
      { provider: childProvider, env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "40" } },
      baseConfig({ permissionMode: "default", allowDangerouslySkipPermissions: false, permissions: { allow: [SPAWN_PROBE] } }),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "unreachable" }],
    );
    expect(code).toBe(0);
    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
    const parsed = JSON.parse(block.content) as { result: { status: string; content: string } };
    expect(parsed.result.status).toBe("failed");
    expect(parsed.result.content).toContain("stalled");
  }, 2000);
});

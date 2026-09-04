// Engine-level proof for child-engine.ts (WS-10, R4-4): every test here drives a REAL `runEngine`
// for the PARENT, with `createChildEngineFactory` registered as the REAL child engine factory --
// never a fake ChildHandle. What's proven: the actual wiring (tool call -> registry dispatch ->
// ctx.session.spawnChild -> the real factory -> a real nested runEngine() -> a real result back),
// not merely the pure functions underneath it (already unit-proven in limits/watchdog/resolution/
// policy/fork/workspace/definitions .test.ts).
import { describe, test, expect, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterFrame, RuntimeConfig, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { WinterCompatibilitySessionStore } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type Provider } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { registerTool, unregisterToolForTest, type ToolExecutionContext } from "../tools/registry.ts";
import { echoProvider, scriptedProvider } from "../provider/mock.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type SpawnChildRequest } from "./child-handle.ts";
import { createChildEngineFactory, type ChildEngineFactoryDeps } from "./child-engine.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";
import { loadAgentDefinitions } from "./definitions.ts";

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

// --- Hermetic git fixture helper (mirrors workspace.test.ts's own established pattern exactly --
// this machine has GLOBAL git hooks installed; GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_NOSYSTEM=1
// make fixture SETUP hermetic). Repo identity is LOCAL-ONLY and synthetic. Needed here (rather than
// importing workspace.test.ts's own copy, which isn't exported) only for the advisor fix-round C
// regression below -- a real git repo is the one precondition `isolation:"worktree"` requires.
async function runGitFixture(args: string[], cwd: string): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  // Both stdout AND stderr are drained (even though only stderr's text is used) -- matching
  // workspace.test.ts's own established pattern exactly: an unread `stdout: "pipe"` stream is a
  // latent resource-handle risk best not deviated from without reason.
  const [, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: exitCode === 0, stderr: stderr.trim() };
}
async function initFixtureRepo(dir: string): Promise<void> {
  const run = async (args: string[]) => {
    const result = await runGitFixture(args, dir);
    if (!result.ok) throw new Error(`fixture setup "git ${args.join(" ")}" failed: ${result.stderr}`);
  };
  await run(["init", "-b", "main"]);
  await run(["config", "user.email", "lane-c-fixture@example.invalid"]);
  await run(["config", "user.name", "Lane C Fixture"]);
  await run(["commit", "--allow-empty", "-m", "initial commit"]);
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

    // Fix-D regression: THIS wrapper's own internal interrupt/end_input handshake (fired once by
    // abortGeneration() when the child naturally completes -- see child-engine.ts's own settle()
    // comment) must never leak its own control_response acks onto the PARENT's real stream. The
    // ONLY control_request/control_response pair that genuinely belongs to this TEST itself is
    // "end-1" (the parent's own end_input, written above) -- any OTHER requestId showing up here
    // would be exactly the two-stray-frames-per-completed-child leak that fix closed.
    const controlResponses = frames.filter((f): f is Extract<WinterFrame, { type: "control_response" }> => f.type === "control_response");
    expect(controlResponses.length).toBeGreaterThan(0); // "end-1"'s own ack must still be here
    for (const cr of controlResponses) {
      expect(cr.requestId).toBe("end-1");
    }
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
      // Fix round 1 (finding I2): NOT echoProvider -- it only ever looks at the LATEST user message,
      // so `rebuilt = []` (the exact bug this test's own ORIGINAL assertions failed to catch) would
      // pass unchanged. This fixture instead RECORDS what it was actually called with, directly into
      // a closure-captured array -- never relying on the child's own reply being forwarded anywhere
      // (the parent's own top-level engine has typically already finished and torn down its own
      // output stream long before a TEST-driven resume() even starts a second generation, since
      // SPAWN_AND_REGISTER never awaits the child -- observing via the wire would be racy by
      // construction, not merely inconvenient).
      const observedCalls: Array<{ messageCount: number; userTexts: string[] }> = [];
      const historyRevealingProvider: Provider = {
        async generate({ messages }) {
          const userTexts = messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "[blocks]"));
          observedCalls.push({ messageCount: messages.length, userTexts });
          return { kind: "text", text: "ok" };
        },
      };
      registerChildEngineFactory(createChildEngineFactory({ provider: historyRevealingProvider, store }));

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
      expect(observedCalls).toEqual([{ messageCount: 1, userTexts: ["first turn"] }]);

      const outcome = await handle.resume(fakeGlobalMessage("second turn"));
      expect(outcome.status).toBe("resumed_and_delivered");
      expect(handle.status()).toBe("running");
      await waitUntil(() => handle.status() === "completed");

      await drainPromise;
      await done;

      // THE discriminating assertion (I2): the second generation's own provider call must have
      // seen the REBUILT history (gen 1's own user+assistant turns) PLUS the new "second turn" --
      // never just a bare single-message conversation, which is exactly what `rebuilt = []` (the
      // bug this test previously could not detect) would produce.
      expect(observedCalls).toHaveLength(2);
      expect(observedCalls[1]).toEqual({ messageCount: 3, userTexts: ["first turn", "second turn"] });
    } finally {
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(parentCwd, { recursive: true, force: true });
    }
  });

  test("resume() when concurrency is exhausted returns an 'unavailable'/retryable outcome, never a throw (advisor fix B)", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const BLOCK_TOOL = "t6_block_resume_capacity";
    cleanupToolNames.push(BLOCK_TOOL);
    const gate = registerBlockingTool(BLOCK_TOOL);

    // A bespoke fixture (SPAWN_PROBE's own "await full completion" behavior, combined with
    // SPAWN_AND_REGISTER's own "stash the handle" behavior): the ordinary SPAWN_AND_REGISTER
    // returns as soon as spawnChild() resolves with a handle, well BEFORE the child itself has
    // actually run its own turn to completion -- racy for this test's own purpose, which needs
    // child1 to be GENUINELY terminal (and its concurrency slot GENUINELY released) before child2
    // ever attempts to spawn. Awaiting result() inside the SAME tool call makes that deterministic:
    // the parent's own engine loop does not advance to its next scripted turn (call-2) until this
    // tool call's own promise resolves.
    const SPAWN_AWAIT_AND_REGISTER = "t6_spawn_await_and_register";
    cleanupToolNames.push(SPAWN_AWAIT_AND_REGISTER);
    registerTool({
      descriptor: {
        canonicalName: SPAWN_AWAIT_AND_REGISTER, advertisedName: SPAWN_AWAIT_AND_REGISTER, source: "builtin", inputSchema: { type: "object" },
        description: "spawns a child, awaits its full completion, then stashes the handle for the test to resume() later", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        async execute(input: unknown, ctx: ToolExecutionContext) {
          if (!ctx.session.spawnChild) return { output: "no spawnChild capability configured", isError: true };
          const handle = await ctx.session.spawnChild(input as SpawnChildRequest);
          await handle.result();
          liveHandles.set(handle.record.id, handle);
          return { output: JSON.stringify({ agentId: handle.record.id }) };
        },
      },
    });

    // ONE provider instance is shared by BOTH children spawned through this ONE registered factory
    // (registerChildEngineFactory is a process-wide singleton -- there is no way to hand two
    // genuinely-concurrent children two DIFFERENT provider instances in this harness). A plain
    // scriptedProvider's shared internal queue is NOT safe for two concurrent callers (both would
    // pop from the SAME array, racing) -- this inline provider instead branches on each child's OWN
    // accumulated `messages`, which stays correctly partitioned per child (every spawned child is
    // its own separate runEngine() call with its own separate conversation state).
    //
    // NOT keyed off "the last user-role message" (a first empirical attempt spun forever): a tool
    // result in THIS engine's own ProviderMessage shape is its own `role: "tool"` entry (engine.ts),
    // never a second `role: "user"` one the way the raw Anthropic API wraps tool_result in a
    // user-role message -- so the FIRST/only "user" message never changes for a single-prompt
    // child's whole life, and branching on it forever re-decides "hold the slot" -> tool_use, then
    // (once the test's own one-shot gate gets released the FIRST time) the RE-triggered tool call
    // resolves instantly forever, a tight zero-delay tool_use/execute cycle. Keying on "have I
    // already emitted the one tool_use I'm supposed to emit" is the actually-correct completion
    // signal for a provider meant to call a tool exactly once, then finish.
    const dualProvider: Provider = {
      async generate({ messages }) {
        const alreadyCalledBlockTool = messages.some(
          (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.name === BLOCK_TOOL),
        );
        if (alreadyCalledBlockTool) return { kind: "text", text: "quick done" };
        const firstUser = messages.find((m) => m.role === "user");
        const text = typeof firstUser?.content === "string" ? firstUser.content : "";
        if (text.includes("hold the slot")) return { kind: "tool_use", calls: [{ id: `b-${randomUUID()}`, name: BLOCK_TOOL, input: {} }] };
        return { kind: "text", text: "quick done" };
      },
    };
    registerChildEngineFactory(createChildEngineFactory({ provider: dualProvider, env: { WINTER_MAX_CONCURRENT_SUBAGENTS: "1" } }));

    const quickReq: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "quick", runInBackground: false };
    const blockingReq: SpawnChildRequest = {
      parentToolUseId: "call-2", prompt: "hold the slot", runInBackground: false,
      definition: { description: "d", prompt: "d", tools: [BLOCK_TOOL] },
    };
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AWAIT_AND_REGISTER, input: quickReq }] },
      { kind: "tool_use", calls: [{ id: "call-2", name: SPAWN_AND_REGISTER, input: blockingReq }] },
      { kind: "text", text: "done" },
    ]);
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const drainPromise = drain(host.input);

    // call-1's own tool call does not resolve until child1 has ALREADY reached "completed" (it
    // awaits result() itself) -- so by the time BOTH handles are registered, child1's concurrency
    // slot is deterministically already released and child2 deterministically holds the only one.
    await waitUntil(() => liveHandles.size === 2);
    const spawned = [...liveHandles.values()];
    const quickHandle = spawned.find((h) => h.record.parentToolUseId === "call-1")!;
    const blockingHandle = spawned.find((h) => h.record.parentToolUseId === "call-2")!;
    expect(quickHandle.status()).toBe("completed");

    // The SECOND (blocking) child now holds the one-and-only concurrency slot -- a resume() attempt
    // on the FIRST, already-terminal child must surface that as a legible DeliveryOutcome, never an
    // uncaught throw propagating out of resume() itself (Lane D's messaging router calls this with
    // no try/catch of its own).
    const outcome = await quickHandle.resume(fakeGlobalMessage("try again"));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(true);
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
    expect(quickHandle.status()).toBe("completed"); // a rejected resume never flips status to "running"

    gate.release();
    await waitUntil(() => blockingHandle.status() !== "running");
    await drainPromise;
    await done;
  });

  test("resume() of an isolated child whose auto-cleaned worktree no longer exists -> 'unavailable'/retryable:false (advisor fix C)", async () => {
    const parentCwd = mkdtempSync(join(tmpdir(), "winter-lane-c-resume-worktree-"));
    try {
      await initFixtureRepo(parentCwd);
      registerSpawnAndRegister();
      cleanupToolNames.push(SPAWN_AND_REGISTER);
      registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider }));

      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "first turn", runInBackground: false, isolation: "worktree" };
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
      // The child made no changes of its own -- WS-10 §8's own "auto-cleaned when unchanged" fires
      // as part of settle() (fire-and-forget), so poll for the worktree's own actual disappearance
      // rather than assuming it is synchronously done the instant status flips to "completed".
      const worktreePath = join(parentCwd, ".winter", "worktrees", `agent-${handle.record.id}`);
      await waitUntil(() => !existsSync(worktreePath));

      const outcome = await handle.resume(fakeGlobalMessage("second turn"));
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.retryable).toBe(false);
        expect(outcome.reason).toContain("auto-cleaned");
      }
      expect(handle.status()).toBe("completed"); // unchanged -- never flipped to "running"

      await drainPromise;
      await done;
    } finally {
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

describe("child-engine.ts: fix round 1 (controller review) -- C1 CRITICAL: AgentDefinition.prompt reaches the child", () => {
  test("a programmatic definition's own prompt is the leading block of the child's first turn, ordered before initialPrompt and req.prompt", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const req: SpawnChildRequest = {
      parentToolUseId: "call-1",
      prompt: "the actual task text",
      runInBackground: false,
      definition: { description: "d", prompt: "You are a meticulous code reviewer persona.", initialPrompt: "Seed context text." },
    };
    const { code, frames } = await driveParent(
      { provider: echoProvider },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
    const parsed = JSON.parse(block.content) as { result: { content: string } };
    const seenText = parsed.result.content; // echoProvider echoes the FULL first-turn text verbatim
    expect(seenText).toContain("You are a meticulous code reviewer persona.");
    const personaIndex = seenText.indexOf("You are a meticulous code reviewer persona.");
    const seedIndex = seenText.indexOf("Seed context text.");
    const taskIndex = seenText.indexOf("the actual task text");
    expect(personaIndex).toBeGreaterThanOrEqual(0);
    expect(seedIndex).toBeGreaterThan(personaIndex); // prompt -> initialPrompt
    expect(taskIndex).toBeGreaterThan(seedIndex); // initialPrompt -> req.prompt
  });

  test("a filesystem AgentDefinition's own prompt (the .md file's full body) reaches the child, end-to-end from a real mkdtemp ~/.winter/agents/*.md file", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-lane-c-c1-fs-"));
    try {
      mkdirSync(join(home, ".winter", "agents"), { recursive: true });
      writeFileSync(join(home, ".winter", "agents", "reviewer.md"), "---\ndescription: reviews code\n---\nYou are a persona from a REAL markdown file on disk.");
      const definitions = loadAgentDefinitions({ cwd: mkdtempSync(join(tmpdir(), "winter-lane-c-c1-cwd-")), home, trustedWorkspace: false });
      const definition = definitions.get("reviewer");
      expect(definition?.prompt).toBe("You are a persona from a REAL markdown file on disk.");

      registerSpawnProbe();
      cleanupToolNames.push(SPAWN_PROBE);
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "review this diff", runInBackground: false, definition: definition! };
      const { code, frames } = await driveParent(
        { provider: echoProvider },
        baseConfig(),
        [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
      );
      expect(code).toBe(0);
      const msgs = dataMessages(frames);
      const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
      const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
      const parsed = JSON.parse(block.content) as { result: { content: string } };
      expect(parsed.result.content).toContain("You are a persona from a REAL markdown file on disk.");
      expect(parsed.result.content).toContain("review this diff");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("child-engine.ts: fix round 1 (controller review) -- I1: permission rules / hooks mirrored onto the child", () => {
  test("a forced-bypass child still DENIES a parent-denied tool call (parentPermissionRules mirrored)", async () => {
    const DENIED_TOOL = "t6_i1_denied_tool";
    cleanupToolNames.push(DENIED_TOOL);
    registerTool({
      descriptor: {
        canonicalName: DENIED_TOOL, advertisedName: DENIED_TOOL, source: "builtin", inputSchema: { type: "object" },
        description: "would run normally if not denied", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: { async execute() { return { output: "SHOULD NEVER RUN -- denied by a parent rule" }; } },
    });
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "b1", name: DENIED_TOOL, input: {} }] },
      { kind: "text", text: "acknowledged the denial" },
    ]);
    registerChildEngineFactory(createChildEngineFactory({ provider: childProvider, parentPermissionRules: { deny: [DENIED_TOOL] } }));
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "try the denied tool", runInBackground: false };
    // baseConfig()'s own default is bypassPermissions -- WS-07 §11 forces this onto every
    // descendant, so the child inherits bypass too. Without the parentPermissionRules mirror, a
    // forced-bypass child would have NO deny rules at all and would auto-approve this call.
    const { code, frames } = await driveParent(
      { provider: echoProvider },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    // The parent's own spawn-and-await tool call: registerSpawnProbe awaits the child's OWN
    // result(), which is the CHILD's own generation outcome -- if the denial ever let the tool
    // actually run, `content` would contain "SHOULD NEVER RUN".
    void code;
    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
    const parsed = JSON.parse(block.content) as { result: { status: string; content: string } };
    expect(parsed.result.content).not.toContain("SHOULD NEVER RUN");
    expect(parsed.result.status).toBe("completed"); // the child gracefully finished (2nd scripted turn) after seeing the denial, never crashed
  });

  test("parentHooks + parentIncludeHookEvents cause the child's own engine to emit hook_started for a matching tool call (config-level mirroring proven; the hook's own RESPONSE is Gap #2's already-disclosed stall, not re-proven here)", async () => {
    const HOOKED_TOOL = "t6_i1_hooked_tool";
    cleanupToolNames.push(HOOKED_TOOL);
    registerTool({
      descriptor: {
        canonicalName: HOOKED_TOOL, advertisedName: HOOKED_TOOL, source: "builtin", inputSchema: { type: "object" },
        description: "a tool a PreToolUse hook matches", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: { async execute() { return { output: "ran" }; } },
    });
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const childProvider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "b1", name: HOOKED_TOOL, input: {} }] }]);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "call the hooked tool", runInBackground: false };
    const { code, frames } = await driveParent(
      {
        provider: childProvider,
        parentHooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] },
        parentIncludeHookEvents: true,
        env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "150" }, // the hook's own control_request is Gap #2-blocked -- bound the stall
      },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    // hook_started is forwarded via transformChildFrame's own catch-all (every other system-subtype
    // data frame forwarded unchanged) -- its presence proves the mirrored `hooks`/`includeHookEvents`
    // config reached the child's own runEngine() and actually activated hook machinery for its call.
    const hookStarted = frames.find((f) => f.type === "data" && (f as { message?: { subtype?: string } }).message?.subtype === "hook_started");
    expect(hookStarted).toBeDefined();
  }, 2000);
});

describe("child-engine.ts: fix round 1 (controller review) -- Q1 forward-compat: resolveChildResumeMode applied when getParentPolicy is supplied", () => {
  test("resume() applies the stricter-of comparator when the parent's current policy is stricter than the recorded one", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    // "auto" is recorded at spawn time; the parent's CURRENT policy has since tightened to "plan"
    // (stricter on axis 1, RULING P2-M/P4-D: plan dominates every non-silencing mode including auto).
    registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider, getParentPolicy: () => ({ mode: "plan", version: 2, hash: "h2" }) }));
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "first turn", runInBackground: false };
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] }, { kind: "text", text: "done" }]);
    const done = runEngine({ config: baseConfig({ permissionMode: "auto", allowDangerouslySkipPermissions: false, permissions: { allow: [SPAWN_AND_REGISTER] } }), input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const drainPromise = drain(host.input);

    await waitUntil(() => liveHandles.size === 1);
    const handle = [...liveHandles.values()][0]!;
    await waitUntil(() => handle.status() === "completed");
    expect(handle.record.permission.effectiveMode).toBe("auto"); // recorded at spawn time

    const outcome = await handle.resume(fakeGlobalMessage("second turn"));
    expect(outcome.status).toBe("resumed_and_delivered");
    await waitUntil(() => handle.status() === "completed");
    // The resumed generation's own effective mode is the STRICTER of {recorded:"auto", current:"plan"} = "plan".
    expect(handle.record.permission.effectiveMode).toBe("plan");
    expect(handle.record.permission.parentPolicyVersion).toBe(2);
    expect(handle.record.permission.parentPolicyHash).toBe("h2");

    await drainPromise;
    await done;
  });

  test("the incomparable pair (dontAsk<->auto) fails resume closed as a typed, non-retryable refusal, never a throw or a silently-resolved mode", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider, getParentPolicy: () => ({ mode: "auto", version: 3, hash: "h3" }) }));
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "first turn", runInBackground: false };
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] }, { kind: "text", text: "done" }]);
    const done = runEngine({ config: baseConfig({ permissionMode: "dontAsk", allowDangerouslySkipPermissions: false, permissions: { allow: [SPAWN_AND_REGISTER] } }), input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const drainPromise = drain(host.input);

    await waitUntil(() => liveHandles.size === 1);
    const handle = [...liveHandles.values()][0]!;
    await waitUntil(() => handle.status() === "completed");
    expect(handle.record.permission.effectiveMode).toBe("dontAsk");

    const outcome = await handle.resume(fakeGlobalMessage("second turn"));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(false);
      expect(outcome.reason).toContain("INCOMPARABLE");
    }
    // A failed-closed resume never flips status to "running" and never mutates the recorded policy.
    expect(handle.status()).toBe("completed");
    expect(handle.record.permission.effectiveMode).toBe("dontAsk");

    await drainPromise;
    await done;
  });
});

describe("child-engine.ts: fix round 1 (controller review) -- I3: insideSubagent / isolationPinnedCwd carries", () => {
  test("insideSubagent:true reaches a child's own tool calls, and a child calling AskUserQuestion is never advertised it -- but IF called anyway, it stalls via Gap #2 exactly like an unanswered permission prompt (never a clean refusal, never a clean success)", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "auq-1", name: "AskUserQuestion", input: { questions: [{ question: "q?", header: "H", options: [{ label: "a" }, { label: "b" }] }] } }] },
    ]);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "ask something", runInBackground: false };
    const { code, frames } = await driveParent(
      { provider: childProvider, env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "60" } },
      baseConfig(),
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

  test("isolationPinnedCwd is true for an isolation:'worktree' child and false for a bare child (ctx plumbing correct; ExitWorktree's OWN executor is a cross-lane gap -- see NEEDS_CONTEXT below, not asserted here as 'refused')", async () => {
    const PROBE_TOOL = "t6_i3_flags_probe";
    cleanupToolNames.push(PROBE_TOOL);
    const seen: Array<{ insideSubagent: boolean | undefined; isolationPinnedCwd: boolean | undefined }> = [];
    registerTool({
      descriptor: {
        canonicalName: PROBE_TOOL, advertisedName: PROBE_TOOL, source: "builtin", inputSchema: { type: "object" },
        description: "reports the two P3 carries it observes on its own ctx", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        async execute(_input: unknown, ctx: ToolExecutionContext) {
          seen.push({ insideSubagent: ctx.insideSubagent, isolationPinnedCwd: ctx.isolationPinnedCwd });
          return { output: "ok" };
        },
      },
    });
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const cwd = mkdtempSync(join(tmpdir(), "winter-lane-c-i3-repo-"));
    try {
      await initFixtureRepo(cwd);
      const childProvider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "p1", name: PROBE_TOOL, input: {} }] },
        { kind: "text", text: "done" },
      ]);
      registerChildEngineFactory(createChildEngineFactory({ provider: childProvider }));
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "probe flags", runInBackground: false, isolation: "worktree" };
      await driveParent({ provider: childProvider }, baseConfig({ cwd }), [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }]);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.insideSubagent).toBe(true);
      expect(seen[0]!.isolationPinnedCwd).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("child-engine.ts: fix round 1 (controller review) -- M1: record.transcript is a real, honest path", () => {
  test("with winterHome supplied, record.transcript is a genuine absolute path under <winterHome>/projects/...", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const winterHome = mkdtempSync(join(tmpdir(), "winter-lane-c-m1-"));
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome });
      registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider, store, winterHome }));
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "hi", runInBackground: false };
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] }, { kind: "text", text: "done" }]);
      const parentConfig = baseConfig();
      const done = runEngine({ config: parentConfig, input: runtime.input, output: runtime.output, provider });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      const drainPromise = drain(host.input);
      await waitUntil(() => liveHandles.size === 1);
      const handle = [...liveHandles.values()][0]!;
      expect(handle.record.transcript.startsWith(winterHome)).toBe(true);
      expect(handle.record.transcript).toContain("/projects/");
      expect(handle.record.transcript.endsWith(`agent-${handle.record.id}.jsonl`)).toBe(true);
      await waitUntil(() => handle.status() === "completed");
      await drainPromise;
      await done;
    } finally {
      rmSync(winterHome, { recursive: true, force: true });
    }
  });

  test("with no store configured, record.transcript is an honest sentinel, never a path that will never exist", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider })); // no store
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "hi", runInBackground: false };
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] }, { kind: "text", text: "done" }]);
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const drainPromise = drain(host.input);
    await waitUntil(() => liveHandles.size === 1);
    const handle = [...liveHandles.values()][0]!;
    expect(handle.record.transcript).toContain("no durable session store is configured");
    expect(handle.record.transcript).not.toContain(".jsonl");
    await waitUntil(() => handle.status() === "completed");
    await drainPromise;
    await done;
  });
});

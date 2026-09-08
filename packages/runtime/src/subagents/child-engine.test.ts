// Engine-level proof for child-engine.ts (WS-10, R4-4): every test here drives a REAL `runEngine`
// for the PARENT, with `createChildEngineFactory` registered as the REAL child engine factory --
// never a fake ChildHandle. What's proven: the actual wiring (tool call -> registry dispatch ->
// ctx.session.spawnChild -> the real factory -> a real nested runEngine() -> a real result back),
// not merely the pure functions underneath it (already unit-proven in limits/watchdog/resolution/
// policy/fork/workspace/definitions .test.ts).
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterFrame, RuntimeConfig, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { WinterCompatibilitySessionStore, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, createContextAccountant, type Provider } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { registerTool, unregisterToolForTest, buildAdvertisedSet, type ToolExecutionContext } from "../tools/registry.ts";
import { echoProvider, scriptedProvider, testProviderByName, recordedProviderSystems, resetRecordedProviderSystems } from "../provider/mock.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type SpawnChildRequest, type ChildInheritance } from "./child-handle.ts";
// Phase 5 Task 8: the two child threads with no fixture of their own until now.
import { createStructuredOutputSeam } from "../structured/ajv-seam.ts";
import { SkillIndex } from "../skills/store.ts";
import type { CompactionController } from "../compaction/seam.ts";
import { createChildEngineFactory, type ChildEngineFactoryDeps } from "./child-engine.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";
import { loadAgentDefinitions } from "./definitions.ts";
import { TranscriptWriter } from "../store/dialect.ts";
import { withHttpFixture, defaultFixtureSpec } from "../mcp/test-fixtures.ts";
import { getToolSearchSessionRuntime } from "../toolsearch/search.ts";
// Phase 5 residual round (NEW-4): the REAL production wiring and the REAL default child factory --
// see the NEW-4 describe block for why a hand-built seed would measure the wrong thing.
import { buildProductionWiring } from "../production-wiring.ts";
import { registerDefaultChildEngineFactory } from "./register-default-factory.ts";
// Residual round 2 (R-2): the real entrypoint, because the entrypoint IS the defect.
import { inMemoryProcess } from "../testing.ts";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";

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
  sessionId: "parent-s", cwd: "/tmp/winter-lane-c-child-engine-tests", model: "winter-test/echo",
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
function registerBlockingTool(name: string): { release: () => void; entered: () => boolean } {
  let releaseFn: (() => void) | undefined;
  let wasEntered = false;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  registerTool({
    descriptor: {
      canonicalName: name, advertisedName: name, source: "builtin", inputSchema: { type: "object" },
      description: "test: blocks until released", exposure: "eager", permissionClass: "read",
      availability: {}, capabilityRequirements: [], disposition: "implement-now",
    },
    // `entered` is P7a's addition and it is the whole difference between a test that WAITS FOR THE
    // MECHANISM and one that reads a scheduling accident: without it, "the generation is blocked in
    // this tool" is indistinguishable from "the generation has not started yet", and both look like
    // `status() === "running"`.
    executor: {
      async execute() {
        wasEntered = true;
        await gate;
        return { output: "released" };
      },
    },
  });
  return { release: () => releaseFn?.(), entered: () => wasEntered };
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
// Per-test teardown a test can append to (a console spy, a timer) -- always drained, even when the
// test throws, so a mocked `console.error` can never leak into the next file.
const afterEachRestore: Array<() => void> = [];
afterEach(() => {
  for (const restore of afterEachRestore.splice(0)) restore();
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

// Phase 4 Task 8 (rider 19, RULING P4-I): the variant of `driveParent` above that ANSWERS the
// runtime-originated control_requests it sees, the way a real host with a `canUseTool`/hook handler
// does. `driveParent` merely drains, which is why every pre-P4-I scenario that reached a real
// permission prompt could only ever observe a stall.
//
// Phase 4 fix wave (T8 review I1): `answer` may return a PROMISE, and a promised reply is written
// FIRE-AND-FORGET -- the read loop keeps draining while the answer is pending, exactly as a real
// host with a human at a prompt behaves. Awaiting inside the loop would stop draining the very
// stream the answer has to travel back over. This is what makes a genuinely LATE answer testable,
// which is what rider 20's watchdog pause needs in order to be falsifiable at all.
function driveParentAnswering(
  deps: ChildEngineFactoryDeps,
  config: RuntimeConfig,
  turns: Parameters<typeof scriptedProvider>[0],
  answer: (frame: Extract<WinterFrame, { type: "control_request" }>) => { ok: boolean; payload?: unknown } | undefined | Promise<{ ok: boolean; payload?: unknown } | undefined>,
): Promise<{ code: number; frames: WinterFrame[] }> {
  registerChildEngineFactory(createChildEngineFactory(deps));
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider(turns);
  const donePromise = runEngine({ config, input: runtime.input, output: runtime.output, provider });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  const reading = (async () => {
    for await (const frame of host.input) {
      frames.push(frame);
      if (frame.type !== "control_request") continue;
      const requestId = (frame as { requestId: string }).requestId;
      void Promise.resolve(answer(frame as Extract<WinterFrame, { type: "control_request" }>)).then((reply) => {
        if (reply === undefined) return;
        host.output.write({
          type: "control_response",
          requestId,
          ok: reply.ok,
          ...(reply.payload !== undefined ? { payload: reply.payload } : {}),
        });
      });
    }
  })();
  return reading.then(async () => ({ code: await donePromise, frames }));
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
    expect(parsed.record.model).toEqual({ effectiveModel: "winter-test/echo", effectiveEffort: "inherit" });
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

describe("child-engine.ts: child permission/hook control-RPC routing (RULING P4-I, closed by T8; was 'disclosed gap 2')", () => {
  test("RULING P4-I: a child under 'default' mode that reaches a real permission prompt RECEIVES its answer through the parent pump's child-bridge roster, and completes", async () => {
    const droppedLogs: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("dropping control_response")) droppedLogs.push(line);
    });
    afterEachRestore.push(() => errorSpy.mockRestore());
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
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "b1", name: NEEDS_PROMPT, input: {} }] },
      { kind: "text", text: "child finished after the prompt was answered" },
    ]);
    // The stall watchdog is set SHORT (40 ms) on purpose: if rider 20's pause did not hold, this
    // scenario would abort with a typed "stalled" error long before the answer could arrive, and the
    // assertions below would fail loudly rather than by timing out.
    let sawPermissionRequest = false;
    const { code, frames } = await driveParentAnswering(
      { provider: childProvider, env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "40" } },
      baseConfig({ permissionMode: "default", allowDangerouslySkipPermissions: false, permissions: { allow: [SPAWN_PROBE] } }),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
      async (frame) => {
        if (frame.subtype !== "permission") return undefined;
        sawPermissionRequest = true;
        // Phase 4 fix wave (T8 review I1): a REAL 80 ms delay -- TWICE the stall timeout -- so this
        // test cannot pass by the answer merely beating the clock. Before the fix wave this comment
        // claimed a delay the code did not implement (the callback returned synchronously), so the
        // whole scenario passed with `watchdog.pause()` DELETED. It now passes only because the
        // clock is genuinely PAUSED while the request is outstanding (RULING P4-I's companion
        // ruling: a human thinking is not a stall).
        await new Promise((r) => setTimeout(r, 80));
        return { ok: true, payload: { behavior: "allow" } };
      },
    );
    expect(code).toBe(0);
    expect(sawPermissionRequest, "the child's own permission control_request must reach the real host stream").toBe(true);
    const msgs = dataMessages(frames);
    // Collected across EVERY `user` data frame, never a single-frame `.find()`: the child now
    // genuinely emits its own tool_result too (forwarded, stamped with parent_tool_use_id), so the
    // FIRST user frame on this stream is the CHILD's, not the parent's -- the exact trap this file's
    // own fix round 2 documented.
    const block = msgs
      .filter((m) => m.type === "user")
      .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []))
      .find((b) => b.tool_use_id === "call-1")!;
    const parsed = JSON.parse(block.content) as { result: { status: string; content: string } };
    // BEFORE P4-I this was `failed` / "stalled": the answer landed on the PARENT's pump, whose single
    // RpcBridge had no matching requestId and dropped it, so the child's own bridge never saw it.
    expect(parsed.result.status).toBe("completed");
    expect(parsed.result.content).toContain("child finished after the prompt was answered");
    // NEW-2 (residual round): the routing WORKS, and it must also be QUIET. The pump used to offer
    // every response to the parent's own bridge FIRST, so the production P4-I path logged
    // "dropping control_response for unknown or already-settled requestId" on stderr for every
    // child-routed answer -- a misleading diagnostic for the success path, and one that would mask
    // the real "nobody claimed this" case it exists to report.
    expect(droppedLogs, `the child-routed answer must not log a drop: ${droppedLogs.join(" | ")}`).toEqual([]);
  }, 5000);

  // The complement, so rider 20's pause cannot silently disarm the watchdog altogether: a child that
  // makes no progress and has NO outstanding host request is still a genuine stall, and is still
  // aborted with the typed error.
  test("rider 20 complement: a child with NO outstanding host request that makes no progress is still aborted by the watchdog", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "hang", runInBackground: false };
    const { code, frames } = await driveParent(
      { provider: testProviderByName("hang"), env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "40" } },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
    const parsed = JSON.parse(block.content) as { result: { status: string; content: string } };
    expect(parsed.result.status).toBe("failed");
    expect(parsed.result.content).toContain("stalled");
  }, 5000);
});

// Phase 5 Task 3 (R5-3): P4-J is RETIRED. The guarantee these tests exist for is unchanged -- a
// definition's `prompt` must reach the child -- but the CHANNEL moved from the first user turn to
// `ProviderRequest.system`, so the assertions move with it. They now read the LIVE provider request
// (recordedProviderSystems), which is the ground truth the Global Constraints name; the old
// first-turn-text assertions would have kept passing on a stale channel if the move were ever
// reverted halfway.
describe("child-engine.ts: C1 CRITICAL (P4-J, RETIRED by R5-3): AgentDefinition.prompt reaches the child -- now on `system`", () => {
  test("a programmatic definition's prompt is the child's SYSTEM prompt; initialPrompt and req.prompt stay in the first user turn, in order", async () => {
    resetRecordedProviderSystems(); // the recorder is process-wide -- a reader MUST clear it first
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

    // The persona is on `system` now -- and is NOT in the first user turn any more.
    expect(recordedProviderSystems()).toContain("You are a meticulous code reviewer persona.");
    expect(seenText).not.toContain("You are a meticulous code reviewer persona.");
    expect(seenText).not.toContain("[Agent system prompt]");

    // The other two are user-turn content by definition (WS-10 §2 calls initialPrompt a "first user
    // message seed") and keep their pinned order.
    const seedIndex = seenText.indexOf("Seed context text.");
    const taskIndex = seenText.indexOf("the actual task text");
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(taskIndex).toBeGreaterThan(seedIndex); // initialPrompt -> req.prompt
  });

  test("a filesystem AgentDefinition's own prompt (the .md file's full body) reaches the child, end-to-end from a real mkdtemp ~/.winter/agents/*.md file", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-lane-c-c1-fs-"));
    try {
      mkdirSync(join(home, ".winter", "agents"), { recursive: true });
      writeFileSync(join(home, ".winter", "agents", "reviewer.md"), "---\ndescription: reviews code\n---\nYou are a persona from a REAL markdown file on disk.");
      resetRecordedProviderSystems(); // the recorder is process-wide -- a reader MUST clear it first
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
      expect(recordedProviderSystems()).toContain("You are a persona from a REAL markdown file on disk.");
      expect(parsed.result.content).toContain("review this diff");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // ==============================================================================================
  // T8 rider 13: the SAME guarantee, against a child that HAS an assembler.
  // ==============================================================================================
  //
  // The two tests above use `toContain` on `recordedProviderSystems()` -- an ARRAY membership check,
  // i.e. EXACT ELEMENT EQUALITY -- which holds only because the factories they register carry no
  // assembler, so the engine's R5-16 fallback forwards `agentSystemPrompt` verbatim as the whole
  // system prompt. They are kept: that fallback is real, and it is what any host driving
  // `runEngine` directly still gets.
  //
  // What they CANNOT see is the production path, which since T8 registers an assembler for children
  // too (`register-default-factory.ts`, from the one shared wiring). Any assembler COMPOSES the
  // persona with other text, so exact element equality is structurally false there -- and would have
  // stayed green while production silently changed, because these fixtures build their own factory.
  // Lane C's report predicted exactly this ("the pinned child-persona test will break the moment the
  // assembler is registered for children"); this is the companion that actually holds the line.
  test("rider 13: WITH an assembler registered for children, the persona is COMPOSED into `system`, never replaced or dropped", async () => {
    resetRecordedProviderSystems();
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const PERSONA = "You are a meticulous code reviewer persona.";
    const req: SpawnChildRequest = {
      parentToolUseId: "call-1",
      prompt: "the actual task text",
      runInBackground: false,
      definition: { description: "reviewer", prompt: PERSONA },
    };
    const { code } = await driveParent(
      {
        provider: echoProvider,
        // A DETERMINISTIC assembler, not Lane C's real one: what is under test is the CHANNEL (does
        // the persona survive composition), and a real assembler would drag a memory directory and a
        // machine-specific path into the assertion for no gain.
        systemPromptAssembler: {
          assemble: (input) => ({ system: `[[PREFIX]]\n${input.agentPrompt ?? ""}\n[[SUFFIX]]`, userContextBlocks: [] }),
        },
      },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);

    const systems = recordedProviderSystems().filter((s): s is string => typeof s === "string");
    // NOT `toContain(PERSONA)`: the persona is no longer an element of its own. It is a SUBSTRING of
    // exactly one composed prompt, and the composition is present around it -- which is what proves
    // the assembler ran rather than being bypassed.
    const composed = systems.filter((s) => s.includes(PERSONA));
    expect(composed.length).toBeGreaterThan(0);
    expect(composed[0]).toContain("[[PREFIX]]");
    expect(composed[0]).toContain("[[SUFFIX]]");
    expect(systems).not.toContain(PERSONA); // the verbatim-forward fallback did NOT run
  });
});

describe("child-engine.ts: fix round 1 (controller review) -- I1: permission rules / hooks mirrored onto the child", () => {
  test("a forced-bypass child still DENIES a parent-denied tool call (parentPermissionRules mirrored)", async () => {
    // Fix round 2 (finding N1): the ORIGINAL version of this test had TWO bugs, both caught by the
    // reviewer reverting the `parentPermissionRules` spread locally and finding the test still
    // passed (1 pass / 0 fail with the fix fully reverted -- a false-positive test, not a real
    // regression proof). (1) It registered the REAL factory (with parentPermissionRules) and then
    // immediately called `driveParent({provider: echoProvider}, ...)`, whose own first statement
    // re-registers the factory and CLOBBERS it -- the SAME `driveParent`-clobbers-a-prior-
    // registration bug already found and fixed twice elsewhere in this file (the AskUserQuestion and
    // hooks tests, same fix round) -- so the child actually ran under echoProvider and never called
    // DENIED_TOOL at all: no `b1` tool_result ever existed. (2) `result.content` is the unconditional
    // SECOND scripted turn ("acknowledged the denial") on EVERY path, denied or not, so
    // `not.toContain("SHOULD NEVER RUN")` could never fail regardless -- the tool's own actual output
    // lands in the `b1` tool_result block, which the test never inspected at all.
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
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "try the denied tool", runInBackground: false };
    // baseConfig()'s own default is bypassPermissions -- WS-07 §11 forces this onto every
    // descendant, so the child inherits bypass too. Without the parentPermissionRules mirror, a
    // forced-bypass child would have NO deny rules at all and would auto-approve this call.
    const { code, frames } = await driveParent(
      { provider: childProvider, parentPermissionRules: { deny: [DENIED_TOOL] } },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    // tool_use/tool_result blocks forward unconditionally (WS-10 §4) -- collected across ALL "user"
    // data frames stamped with the child's own parent_tool_use_id, mirroring the established
    // allowlist-denial test's own pattern exactly (a single-frame `find` throws once the child emits
    // its own tool call, since more than one "user"-type frame then exists on the stream).
    const msgs = dataMessages(frames);
    const userMsgs = msgs.filter((m): m is Extract<SdkMessage, { type: "user" }> => m.type === "user" && (m as { parent_tool_use_id?: string }).parent_tool_use_id === "call-1");
    const deniedBlock = userMsgs
      .flatMap((m) => (m as unknown as { message: { content: Array<{ tool_use_id: string; denied?: boolean; content?: string }> } }).message.content)
      .find((b) => b.tool_use_id === "b1");
    expect(deniedBlock?.denied).toBe(true);
    expect(deniedBlock?.content).toContain("Denied by permission rule");
    expect(deniedBlock?.content).not.toContain("SHOULD NEVER RUN");
  });

  // Phase 4 Task 8 (rider 19, RULING P4-I): this test's own title used to end "...the hook's own
  // RESPONSE is Gap #2's already-disclosed stall, not re-proven here". P4-I closed that gap, so the
  // scenario is now driven to COMPLETION: the host answers the child's hook control_request and the
  // hooked call actually runs.
  test("parentHooks + parentIncludeHookEvents cause the child's own engine to emit hook_started, the host ANSWERS the hook RPC, and the hooked call completes", async () => {
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
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "b1", name: HOOKED_TOOL, input: {} }] },
      { kind: "text", text: "child done after the hook answered" },
    ]);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "call the hooked tool", runInBackground: false };
    let sawHookRequest = false;
    const { code, frames } = await driveParentAnswering(
      {
        provider: childProvider,
        parentHooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] },
        parentIncludeHookEvents: true,
        // SHORT (60 ms) and genuinely beaten: the answer below waits 120 ms -- TWICE this timeout --
        // with the hook request outstanding, so rider 20's pause is load-bearing here for the HOOK
        // control_request exactly as the sibling P4-I test proves it for the PERMISSION one. (Fix
        // wave, T8 review M5's second half: this comment previously claimed the timeout was
        // "still SHORT" against a callback that answered synchronously, so the clock was beaten
        // trivially and the pause was not exercised at all.)
        env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "60" },
      },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
      async (frame) => {
        if (frame.subtype !== "hook") return undefined;
        sawHookRequest = true;
        await new Promise((r) => setTimeout(r, 120));
        return { ok: true, payload: {} }; // an observational, no-opinion hook answer
      },
    );
    expect(code).toBe(0);
    // hook_started is forwarded via transformChildFrame's own catch-all (every other system-subtype
    // data frame forwarded unchanged) -- its presence proves the mirrored `hooks`/`includeHookEvents`
    // config reached the child's own runEngine() and actually activated hook machinery for its call.
    const hookStarted = frames.find((f) => f.type === "data" && (f as { message?: { subtype?: string } }).message?.subtype === "hook_started");
    expect(hookStarted).toBeDefined();
    // P4-I: the hook RPC genuinely round-tripped -- the child received the answer and finished.
    expect(sawHookRequest).toBe(true);
    const block = dataMessages(frames)
      .filter((m) => m.type === "user")
      .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []))
      .find((b) => b.tool_use_id === "call-1")!;
    const parsed = JSON.parse(block.content) as { result: { status: string; content: string } };
    expect(parsed.result.status).toBe("completed");
  }, 5000);
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

  test("fix round 2 (nit): the tightened policy is persisted to the durable sidecar IMMEDIATELY on resume(), never deferred to the next settle()", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const winterHome = mkdtempSync(join(tmpdir(), "winter-lane-c-q1-persist-"));
    // THE CHILD'S OWN PROVIDER BLOCKS ON ITS SECOND GENERATION, and that is P7a's fix.
    //
    // This test used to register a SECOND child-engine factory (with a `resumeProvider` whose first
    // turn called a blocking TOOL) after the child had already spawned. That call is INERT for a
    // live handle -- `engine.ts`'s `spawnChild` reads `getChildEngineFactory()` exactly once, at
    // spawn, and `ChildHandle.resume` never consults it again -- so the resumed generation ran on
    // the spawn-time `echoProvider`, settled on its own, and the blocking tool was never invoked at
    // all. `status() === "running"` then passed on an ASYNC-SCHEDULING ACCIDENT (`record.status =
    // "running"` is a synchronous write inside `resume()`, observed before the fire-and-forget
    // generation had run a single round), and the sidecar read RACED a terminal write from the
    // settling generation -- destroying the test's own stated isolation (P6.6 Lane D report §1.4 /
    // review m3: "green for the wrong reason").
    //
    // The block is now in the SPAWN-TIME provider, where it is actually reachable, and it is the
    // PROVIDER rather than a tool: a tool call in the resumed generation's `plan` mode raises a
    // permission request that nothing in this test answers, so the generation would hang before
    // reaching the tool -- indistinguishable, from outside, from the accident this fix removes.
    // Blocking inside `generate()` needs no permission and no advertised tool, and it is a STRICTER
    // isolation than the original intent: the resumed generation cannot settle at all.
    let releaseSecondGeneration: (() => void) | undefined;
    const secondGenerationBlocked = new Promise<void>((resolve) => {
      releaseSecondGeneration = resolve;
    });
    let generations = 0;
    let secondGenerationEntered = false;
    const childProvider: Provider = {
      async generate() {
        generations += 1;
        if (generations === 1) return { kind: "text", text: "first turn done" };
        secondGenerationEntered = true;
        await secondGenerationBlocked;
        return { kind: "text", text: "second turn done" };
      },
    };
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome });
      // "auto" recorded at spawn; the parent's current policy has since tightened to "plan".
      registerChildEngineFactory(createChildEngineFactory({ provider: childProvider, store, getParentPolicy: () => ({ mode: "plan", version: 5, hash: "h5" }) }));
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
      expect(generations).toBe(1); // the spawn generation, and only it

      const outcome = await handle.resume(fakeGlobalMessage("second turn"));
      expect(outcome.status).toBe("resumed_and_delivered");
      // AWAIT THE MECHANISM, not a tick. This flag flips INSIDE the resumed generation's own
      // `generate()`, so the wait returns only once that generation has genuinely started and is
      // parked on a promise nothing resolves yet. Without it, "blocked mid-generation" and "has not
      // started at all" are the same observation -- which is exactly what the old test could not
      // tell apart.
      await waitUntil(() => secondGenerationEntered);
      expect(generations).toBe(2);
      // The in-memory record already reflects it (proven by the sibling test above) -- this test's
      // own point is the DURABLE sidecar, read back independently through the store, not through
      // `handle.record` at all.
      expect(handle.status()).toBe("running"); // genuinely still running -- parked inside generate()

      // Matches child-engine.ts's own key construction exactly: projectKey derived from the
      // PARENT's own cwd (baseConfig()'s own literal default, unoverridden in this test), sessionId
      // the parent's own sessionId ("parent-s", baseConfig()'s own literal default).
      const projectKey = compatibilityKeys("/tmp/winter-lane-c-child-engine-tests").transcriptProjectKey;
      const childKey = { projectKey, sessionId: "parent-s", subpath: `subagents/agent-${handle.record.id}` };
      const raw = await TranscriptWriter.readBack(store, childKey);
      const metadata = raw.find((e) => e.type === "agent_metadata") as { permission?: { effectiveMode?: string; parentPolicyVersion?: number; parentPolicyHash?: string } } | undefined;
      expect(metadata?.permission?.effectiveMode).toBe("plan");
      expect(metadata?.permission?.parentPolicyVersion).toBe(5);
      expect(metadata?.permission?.parentPolicyHash).toBe("h5");

      releaseSecondGeneration?.();
      await waitUntil(() => handle.status() !== "running");
      await drainPromise;
      await done;
    } finally {
      releaseSecondGeneration?.(); // never leave a parked generation behind, even on a failed assertion
      rmSync(winterHome, { recursive: true, force: true });
    }
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
  // Phase 4 Task 8 (rider 27): this test's own title used to end "...it STALLS via Gap #2 ... never a
  // clean refusal, never a clean success", which is exactly the defect rider 27 names: an
  // availability exclusion that only governed ADVERTISEMENT, with nothing consulting it at dispatch,
  // so a child that called the tool anyway reached the real executor and hung on a host round-trip
  // it could never be answered on. Dispatch-time enforcement (registry.ts's
  // buildRegistryToolExecutor, `getAvailabilityInputs`) turns that stall into an immediate, typed
  // refusal -- so the assertion flips from "stalled" to "refused, and the child still completes".
  test("insideSubagent:true reaches a child's own tool calls, and a child calling AskUserQuestion gets a TYPED REFUSAL at dispatch (rider 27), never a stall", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "auq-1", name: "AskUserQuestion", input: { questions: [{ question: "q?", header: "H", options: [{ label: "a" }, { label: "b" }] }] } }] },
      { kind: "text", text: "child recovered from the refusal" },
    ]);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "ask something", runInBackground: false };
    const { code, frames } = await driveParent(
      // A SHORT stall timeout on purpose: if the call stalled the way it used to, this would abort
      // with a typed "stalled" error and the assertions below would fail loudly.
      { provider: childProvider, env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "60" } },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    const msgs = dataMessages(frames);
    const blocks = msgs
      .filter((m) => m.type === "user")
      .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []));
    // The CHILD's own inner call was refused, typed, at dispatch -- WS-06 §3.3's "not available
    // inside Agent-tool subagents" is now enforced, not merely advertised.
    const inner = blocks.find((b) => b.tool_use_id === "auq-1");
    expect(inner, "the child's own AskUserQuestion tool_result must reach the parent stream").toBeDefined();
    expect(inner!.content).toContain("not available in this session");
    // ...and the child went on to complete normally rather than being aborted.
    const outer = blocks.find((b) => b.tool_use_id === "call-1")!;
    const parsed = JSON.parse(outer.content) as { result: { status: string; content: string } };
    expect(parsed.result.status).toBe("completed");
    expect(parsed.result.content).toContain("child recovered from the refusal");
  }, 5000);

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

// --- P7a fix wave item 2: a child's provider-state sidecar is DURABLE -----------------------------
//
// `buildChildTranscriptWriter` attaches a `providerStateSink` only when it is given a `winterHome`
// (dialect.ts spreads it conditionally). This call site omitted it, so NO production child ever had
// one: every child ran on an in-memory chain and its provider-state records -- R6-9's `origin`, the
// native-state items a resume replays, the cross-family `handoff` -- died with the process. The
// defect was invisible to every existing test because `record.transcript` (the M1 block above) named
// the right path while nothing beside it was ever written.
//
// This drives a REAL spawn under a mkdtemp home with a parent that HAS a resolved provider identity
// (that identity is what `recordAssistant` needs before it writes any record at all), then asserts
// the file exists on disk and carries the child's own `origin` record.
describe("child-engine.ts: P7a fix wave item 2 -- a child's provider-state sidecar is durable", () => {
  test("a child spawned by a factory holding winterHome writes its sidecar beside its own transcript", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const winterHome = mkdtempSync(join(tmpdir(), "winter-p7a-child-sidecar-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-p7a-child-sidecar-cwd-"));
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome });
      registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider, store, winterHome }));
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "hi", runInBackground: false };
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] }, { kind: "text", text: "done" }]);
      const parentConfig = baseConfig({ sessionId: "parent-sidecar", cwd });
      const done = runEngine({
        config: parentConfig,
        input: runtime.input,
        output: runtime.output,
        provider,
        // The parent's RESOLVED identity: `buildChildInheritance` copies it onto `inherit.provider`,
        // the factory freezes it as the child's own, and the child engine stamps every record with
        // it. Without an identity anywhere the engine writes no provider-state records at all -- so
        // this is the precondition the assertion needs, not an artificial prop.
        providerIdentity: { providerId: "winter-test", modelKey: "winter-test/echo", family: "winter-test" },
      });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      const drainPromise = drain(host.input);
      await waitUntil(() => liveHandles.size === 1);
      const handle = [...liveHandles.values()][0]!;
      await waitUntil(() => handle.status() === "completed");
      await drainPromise;
      await done;

      // Derived INDEPENDENTLY of `record.transcript` (which the M1 block already pins) -- from the
      // documented WS-05 §4 layout the factory itself is built on.
      const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
      const sidecar = join(winterHome, "projects", projectKey, "parent-sidecar", "subagents", `agent-${handle.record.id}.provider-state.jsonl`);
      expect(existsSync(sidecar)).toBe(true);
      const records = readFileSync(sidecar, "utf8").trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(records.length).toBeGreaterThan(0);
      // The child's OWN records, naming the identity it actually ran on -- never the parent's file.
      expect(records[0]!.kind).toBe("origin");
      expect(records[0]!.model).toBe("winter-test/echo");
      // And it really is the transcript's NEIGHBOUR, which is the whole point of deriving the sidecar
      // path from the transcript path inside dialect.ts.
      expect(sidecar).toBe(`${handle.record.transcript.slice(0, -".jsonl".length)}.provider-state.jsonl`);
    } finally {
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// --- Phase 4 fix wave: C1 (CRITICAL) + I6 -- the parent's LIVE rules bind every child ------------
//
// The whole-branch review's own two escapes, plus the two directions of the same omission. Every
// test here registers the factory through `driveParent`/`driveParentAnswering`, which pass NO
// `parentPermissionRules` at all -- so a test that passes here is passing through the LIVE
// `runCtx.getParentRules()` accessor, never the construction-time mirror (that mirror keeps its own
// pre-existing tests; this block is what proves the accessor is the one production uses).

// A fixture tool that RECORDS every input it is called with -- "did the child actually execute
// this?" is the only assertion that distinguishes "denied" from "denied-looking" for a tool whose
// result text a denial would never produce anyway.
function registerRecordingTool(name: string, opts: { capabilityRequirements?: string[] } = {}): { ran: Array<Record<string, unknown>> } {
  const ran: Array<Record<string, unknown>> = [];
  registerTool({
    descriptor: {
      canonicalName: name, advertisedName: name, source: "builtin", inputSchema: { type: "object" },
      description: "fix-wave fixture: records every execution", exposure: "eager", permissionClass: "read",
      availability: {}, capabilityRequirements: opts.capabilityRequirements ?? [], disposition: "implement-now",
    },
    executor: {
      async execute(input: unknown) {
        ran.push((input ?? {}) as Record<string, unknown>);
        return { output: `${name} RAN` };
      },
    },
  });
  return { ran };
}

describe("child-engine.ts: the parent's LIVE permission rules bind every child (fix wave C1/I6, WS-07 §3.3/§11)", () => {
  test("C1(a): a SCOPED parent deny (disallowedTools: 'Tool(rm *)') survives into a forced-bypass child -- the matching call is denied, a non-matching one still runs", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const CMD = "t6fw_scoped_cmd";
    cleanupToolNames.push(CMD);
    const probe = registerRecordingTool(CMD);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "run two commands", runInBackground: false };
    // The child tries the DENIED shape first, then a benign one -- so a green result cannot come
    // from the tool being unreachable/unregistered altogether (the benign call proves it is live).
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: CMD, input: { command: "rm -rf /tmp/winter-fixwave-must-never-run" } }] },
      { kind: "tool_use", calls: [{ id: "c2", name: CMD, input: { command: "ls" } }] },
      { kind: "text", text: "child done" },
    ]);
    // bypassPermissions (baseConfig's default) is the security-relevant case: WS-07 §11 FORCES it
    // onto the child, and before this fix the scoped rule reached the child through no channel at
    // all -- `CMD` stays in the parent's advertised set (isBareDenied only removes bare-equivalent
    // rules), so the child's complement-deny never covered it either.
    const { code } = await driveParent(
      { provider: childProvider },
      baseConfig({ disallowedTools: [`${CMD}(rm *)`] }),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    expect(probe.ran.map((i) => i["command"])).toEqual(["ls"]);
  }, 10_000);

  test("C1(b): a definition's `tools` INTERSECTS the parent's advertised pool -- it can never re-enable a tool the parent does not have", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    // Excluded from the PARENT's advertised set by a capability gate, NOT by a deny rule -- so this
    // test isolates the `engine.ts` intersection itself. (The review's own PROBE 2 shape -- a
    // bare `disallowedTools` deny plus a definition naming that tool -- is now closed twice over:
    // by this intersection AND by the live deny rule reaching the child; the next test pins that
    // one directly.)
    const WIDENED = "t6fw_capability_gated";
    cleanupToolNames.push(WIDENED);
    const probe = registerRecordingTool(WIDENED, { capabilityRequirements: ["winter.fixwave-absent"] });
    const req: SpawnChildRequest = {
      parentToolUseId: "call-1", prompt: "use the widened tool", runInBackground: false,
      definition: { description: "widener", prompt: "you may use the widened tool", tools: [WIDENED] },
    };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: WIDENED, input: {} }] },
      { kind: "text", text: "child done" },
    ]);
    const { code } = await driveParent({ provider: childProvider }, baseConfig(), [
      { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
      { kind: "text", text: "parent done" },
    ]);
    expect(code).toBe(0);
    expect(probe.ran).toEqual([]);
  }, 10_000);

  test("C1(b) / PROBE 2: a definition naming a parent-BARE-DENIED tool still cannot execute it under forced bypass", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const DENIED = "t6fw_probe_denied";
    cleanupToolNames.push(DENIED);
    const probe = registerRecordingTool(DENIED);
    const req: SpawnChildRequest = {
      parentToolUseId: "call-1", prompt: "child-probe", runInBackground: false,
      definition: { description: "prober", prompt: "persona", tools: [DENIED] },
    };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "cc1", name: DENIED, input: {} }] },
      { kind: "text", text: "child done" },
    ]);
    const { code } = await driveParent({ provider: childProvider }, baseConfig({ disallowedTools: [DENIED] }), [
      { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
      { kind: "text", text: "parent done" },
    ]);
    expect(code).toBe(0);
    expect(probe.ran).toEqual([]);
  }, 10_000);

  test("I6: a parent's `allowedTools` pre-approval reaches a `default`-mode child -- the child never re-prompts for it", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const ALLOWED = "t6fw_preapproved";
    cleanupToolNames.push(ALLOWED);
    const probe = registerRecordingTool(ALLOWED);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "use the pre-approved tool", runInBackground: false };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: ALLOWED, input: {} }] },
      { kind: "text", text: "child done" },
    ]);
    // Every permission request is answered DENY, so the two assertions are independent: no prompt
    // was issued at all (the allow rule resolved the call at stage 5), and the tool genuinely ran.
    // Before the fix the child prompted, got the deny, and never ran the parent's own pre-approved
    // tool -- the exact "a default-mode child re-prompts for what the parent pre-approved" failure.
    let sawPermissionRequest = false;
    const { code } = await driveParentAnswering(
      { provider: childProvider, env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "2000" } },
      baseConfig({ permissionMode: "default", allowDangerouslySkipPermissions: false, allowedTools: [SPAWN_PROBE, ALLOWED] }),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
      (frame) => {
        if (frame.subtype !== "permission") return undefined;
        sawPermissionRequest = true;
        return { ok: true, payload: { behavior: "deny", message: "no prompt should ever have been issued" } };
      },
    );
    expect(code).toBe(0);
    expect(sawPermissionRequest, "an allowedTools pre-approval must resolve the child's call without a prompt").toBe(false);
    expect(probe.ran.length).toBe(1);
  }, 10_000);

  test("C1/I6 (the widening direction): a project-sourced ALLOW rule that is INERT in the untrusted parent does NOT become live in the child", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const GATE = "t6fw_trust_gate";
    const PROJECT_ALLOWED = "t6fw_project_allowed";
    cleanupToolNames.push(GATE, PROJECT_ALLOWED);
    registerRecordingTool(GATE);
    const probe = registerRecordingTool(PROJECT_ALLOWED);
    const req: SpawnChildRequest = { parentToolUseId: "call-2", prompt: "use the project-allowed tool", runInBackground: false };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: PROJECT_ALLOWED, input: {} }] },
      { kind: "text", text: "child done" },
    ]);
    // WS-07 §3.2 / Ruling P2-H: a project/local ALLOW rule requires workspace trust, and
    // `trustedWorkspace` is hardcoded false today -- so this rule is INERT in the parent. Only
    // `cliArg` is authority-restricted at the write path, so a host's own canUseTool can genuinely
    // author it under `session` authority, which is exactly what happens here.
    let sawChildPrompt = false;
    const { code } = await driveParentAnswering(
      { provider: childProvider, env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "2000" } },
      baseConfig({ permissionMode: "default", allowDangerouslySkipPermissions: false }),
      [
        { kind: "tool_use", calls: [{ id: "call-1", name: GATE, input: {} }] },
        { kind: "tool_use", calls: [{ id: "call-2", name: SPAWN_PROBE, input: req }] },
        { kind: "text", text: "parent done" },
      ],
      (frame) => {
        if (frame.subtype !== "permission") return undefined;
        const payload = frame.payload as { toolName?: string } | undefined;
        if (payload?.toolName === GATE) {
          return {
            ok: true,
            payload: {
              behavior: "allow",
              updatedPermissions: [{ type: "addRules", rules: [{ toolName: PROJECT_ALLOWED }], behavior: "allow", destination: "projectSettings" }],
            },
          };
        }
        if (payload?.toolName === SPAWN_PROBE) return { ok: true, payload: { behavior: "allow" } };
        // The child's own call: DENIED. It can only run if the inert project rule was mirrored into
        // the child as a live `sdk` allow, which would resolve it at stage 5 with no prompt at all.
        sawChildPrompt = true;
        return { ok: true, payload: { behavior: "deny", message: "the project rule must not be live in a child" } };
      },
    );
    expect(code).toBe(0);
    expect(probe.ran, "an untrusted project ALLOW must not become live inside a child").toEqual([]);
    expect(sawChildPrompt, "the child's call must still reach a prompt, i.e. no rule resolved it").toBe(true);
  }, 10_000);

  test("I6 (live): a rule added to the PARENT mid-run (updatedPermissions) binds a child spawned afterwards", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const GATE = "t6fw_gate";
    const LIVE_DENIED = "t6fw_live_denied";
    cleanupToolNames.push(GATE, LIVE_DENIED);
    registerRecordingTool(GATE);
    const probe = registerRecordingTool(LIVE_DENIED);
    const req: SpawnChildRequest = { parentToolUseId: "call-2", prompt: "use the live-denied tool", runInBackground: false };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: LIVE_DENIED, input: {} }] },
      { kind: "text", text: "child done" },
    ]);
    const { code } = await driveParentAnswering(
      { provider: childProvider, env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "2000" } },
      baseConfig({ permissionMode: "default", allowDangerouslySkipPermissions: false }),
      [
        // Turn 1: an ordinary call the host approves -- carrying a session-scoped deny for a tool
        // NOTHING has denied at config time. Nothing about this rule exists when the child engine
        // factory is constructed, which is exactly why a construction-time mirror cannot see it.
        { kind: "tool_use", calls: [{ id: "call-1", name: GATE, input: {} }] },
        // Turn 2: NOW spawn. The child must inherit the rule added during turn 1.
        { kind: "tool_use", calls: [{ id: "call-2", name: SPAWN_PROBE, input: req }] },
        { kind: "text", text: "parent done" },
      ],
      (frame) => {
        if (frame.subtype !== "permission") return undefined;
        const payload = frame.payload as { toolName?: string } | undefined;
        if (payload?.toolName === GATE) {
          return {
            ok: true,
            payload: {
              behavior: "allow",
              updatedPermissions: [{ type: "addRules", rules: [{ toolName: LIVE_DENIED }], behavior: "deny", destination: "session" }],
            },
          };
        }
        // Everything else (the parent's own spawn call, and -- before the fix -- the child's call to
        // the live-denied tool) is ALLOWED, so the assertion below can only be satisfied by the rule
        // itself having reached the child.
        return { ok: true, payload: { behavior: "allow" } };
      },
    );
    expect(code).toBe(0);
    expect(probe.ran).toEqual([]);
  }, 10_000);
});

// --- Phase 4 fix wave: I1 -- a child's sessionId is the OWNING PARENT's --------------------------

describe("child-engine.ts: child session identity (fix wave I1, WS-10 addressing)", () => {
  test("a child's ctx.sessionId is the PARENT's session id and its agentId is distinct -- the self-address is well-formed, never agent:<id>:<id>", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const IDENTITY = "t6fw_identity";
    cleanupToolNames.push(IDENTITY);
    const seen: Array<{ sessionId: string; agentId: string | undefined; insideSubagent: boolean | undefined }> = [];
    registerTool({
      descriptor: {
        canonicalName: IDENTITY, advertisedName: IDENTITY, source: "builtin", inputSchema: { type: "object" },
        description: "records the executing context's own identity", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        async execute(_input: unknown, ctx: ToolExecutionContext) {
          seen.push({ sessionId: ctx.sessionId, agentId: ctx.agentId, insideSubagent: ctx.insideSubagent });
          return { output: "recorded" };
        },
      },
    });
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "identify yourself", runInBackground: false };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: IDENTITY, input: {} }] },
      { kind: "text", text: "child done" },
    ]);
    const { code } = await driveParent({ provider: childProvider }, baseConfig({ sessionId: "parent-identity-s" }), [
      { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
      { kind: "text", text: "parent done" },
    ]);
    expect(code).toBe(0);
    expect(seen.length).toBe(1);
    // The review's own PROBE 2 observed `ctx.sessionId === ctx.agentId` here -- the malformed
    // identity that made `callerAddress` build `agent:<agentId>:<agentId>`.
    expect(seen[0]!.sessionId).toBe("parent-identity-s");
    expect(seen[0]!.agentId).toBeDefined();
    expect(seen[0]!.agentId).not.toBe(seen[0]!.sessionId);
    expect(seen[0]!.insideSubagent).toBe(true);
  }, 10_000);

  test("a child can SendMessage to a SIBLING (both children of the same session), not only to its own grandchildren", async () => {
    registerSpawnProbe();
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_PROBE, SPAWN_AND_REGISTER);
    // ONE provider instance serves BOTH children (createChildEngineFactory hands `deps.provider`
    // straight to every child's nested runEngine), so it must be a PURE FUNCTION of the messages it
    // sees -- the established discipline for provider/mock.ts's own "subagent"/"childmsg" arms.
    const childProvider: Provider = {
      async generate({ messages }) {
        const firstUser = messages.find((m) => m.role === "user");
        const firstText = typeof firstUser?.content === "string" ? firstUser.content : "";
        if (firstText.includes("BETA")) return { kind: "text", text: "beta done" };
        for (const m of messages) {
          if (!Array.isArray(m.content)) continue;
          for (const b of m.content) {
            if (b.type === "tool_result" && b.tool_use_id === "a1") return { kind: "text", text: `SENDRESULT:${b.content}` };
          }
        }
        return { kind: "tool_use", calls: [{ id: "a1", name: "SendMessage", input: { to: "beta", message: "hi sibling" } }] };
      },
    };
    const beta: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "BETA", runInBackground: true, name: "beta" };
    const alpha: SpawnChildRequest = { parentToolUseId: "call-2", prompt: "ALPHA: message your sibling", runInBackground: false };
    const { code, frames } = await driveParent({ provider: childProvider }, baseConfig({ sessionId: "parent-siblings-s" }), [
      { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: beta }] },
      { kind: "tool_use", calls: [{ id: "call-2", name: SPAWN_PROBE, input: alpha }] },
      { kind: "text", text: "parent done" },
    ]);
    expect(code).toBe(0);
    const block = dataMessages(frames)
      .filter((m) => m.type === "user")
      .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []))
      .find((b) => b.tool_use_id === "call-2")!;
    const parsed = JSON.parse(block.content) as { result: { status: string; content: string } };
    expect(parsed.result.status).toBe("completed");
    // Before the fix: `not_found` -- alpha's own "children" filter (record.parentSessionId ===
    // caller.sessionId) compared beta's PARENT session id against alpha's own AGENT id, so a
    // sibling was structurally unreachable and `ListAgents` from a child listed only grandchildren.
    expect(parsed.result.content).not.toContain("not_found");
    expect(parsed.result.content).toMatch(/"status":"(delivered|queued|resumed_and_delivered)"/);
  }, 10_000);
});

// --- Phase 4 fix wave: I2 + I4 -- a child is not an MCP island ----------------------------------
//
// Every test here drives a REAL loopback MCP server (mcp/test-fixtures.ts's Streamable-HTTP
// fixture) through a REAL parent `runEngine`, and executes the bridge family INSIDE a real child --
// the P3-class gap the review named ("advertised in a golden, executed by nothing").

describe("child-engine.ts: children share the session's MCP state (fix wave I2/I4, WS-09 §1.4/§8.4, WS-10 §2)", () => {
  test("I2: WaitForMcpServers and ListMcpResourcesTool executed INSIDE a child answer with the PARENT's real server state", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    await withHttpFixture(defaultFixtureSpec(), async (url) => {
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "inspect the session's MCP servers", runInBackground: false };
      const childProvider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "c1", name: "WaitForMcpServers", input: { servers: ["fixture"] } }] },
        { kind: "tool_use", calls: [{ id: "c2", name: "ListMcpResourcesTool", input: {} }] },
        { kind: "text", text: "child inspected mcp" },
      ]);
      const { code, frames } = await driveParent(
        { provider: childProvider },
        baseConfig({ sessionId: "parent-mcp-s", mcpServers: { fixture: { type: "http", url: url.href } } }),
        [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
      );
      expect(code).toBe(0);
      // The child's own tool_result blocks are forwarded to the parent's stream stamped with the
      // parent's tool_use id (WS-10 §4), which is where these answers are observed.
      const blocks = dataMessages(frames)
        .filter((m) => m.type === "user")
        .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []));
      const wait = JSON.parse(blocks.find((b) => b.tool_use_id === "c1")!.content) as { ready: boolean; connected: string[]; unknown: string[] };
      // Before the fix: `{ready:true, connected:[], unknown:["fixture"]}` -- a WRONG answer, not
      // merely an inert one (wait-for-mcp-servers.ts's own no-state-source branch).
      expect(wait.connected).toEqual(["fixture"]);
      expect(wait.unknown).toEqual([]);
      const listRaw = blocks.find((b) => b.tool_use_id === "c2")!.content;
      // Before the fix: "no MCP lifecycle is configured for this session".
      expect(listRaw).not.toContain("no MCP lifecycle");
      expect(listRaw).toContain("fixture://text.txt");
    });
  }, 20_000);

  test("I2: a child can CALL the session's own MCP tool -- through the PARENT's sdk_mcp_call bridge -- and sees exactly the parent's servers", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    // An `sdk`-type server: its tools register synchronously at parent startup (engine.ts's
    // sdk-wire path), so they are in the parent's advertised pool -- and therefore in the child's
    // inherited pool -- deterministically, with no connect race. Its executor forwards the call as
    // an `sdk_mcp_call` control_request on the PARENT's stream (the child has no second wire),
    // which this host answers: the P4-I "by trace only" claim, now driven for real from a child.
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "call the session's mcp tool", runInBackground: false };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: "mcp__fixture__echo", input: { text: "from-the-child" } }] },
      { kind: "tool_use", calls: [{ id: "c2", name: "WaitForMcpServers", input: {} }] },
      { kind: "text", text: "child called mcp" },
    ]);
    let sawSdkMcpCall = false;
    const { code, frames } = await driveParentAnswering(
      { provider: childProvider },
      baseConfig({ sessionId: "parent-mcp-call-s", mcpServers: { fixture: { type: "sdk", name: "fixture", tools: [{ name: "echo", inputSchema: { type: "object" } }] } } }),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
      (frame) => {
        if (frame.subtype !== "sdk_mcp_call") return undefined;
        sawSdkMcpCall = true;
        const payload = frame.payload as { server: string; tool: string; arguments: Record<string, unknown> };
        return { ok: true, payload: { content: [{ type: "text", text: `echo:${String(payload.arguments["text"])}` }] } };
      },
    );
    expect(code).toBe(0);
    expect(sawSdkMcpCall, "a child's MCP tool call must reach the host through the PARENT's own bridge").toBe(true);
    const blocks = dataMessages(frames)
      .filter((m) => m.type === "user")
      .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []));
    expect(blocks.find((b) => b.tool_use_id === "c1")!.content).toContain("echo:from-the-child");
    const wait = JSON.parse(blocks.find((b) => b.tool_use_id === "c2")!.content) as { connected: string[] };
    expect(wait.connected).toEqual(["fixture"]); // EXACTLY the parent's set -- no more, no less
  }, 20_000);

  // Fix wave follow-up (8), whole-branch M7: the session's programmatic `Options.agents` map reaches
  // a child, so a GRANDCHILD spawn can resolve a `subagent_type` the host declared. Probed on
  // `ctx.agents` because that is exactly the value `tools/impl/agent.ts` passes to
  // `loadAgentDefinitions({programmatic})` -- whose "resolves a programmatic definition / answers
  // unknown subagent_type when it cannot" behaviour is already pinned in `tools/impl/agent.test.ts`.
  // Pre-fix this was `undefined` inside every child, so a nested Agent call answered "unknown
  // subagent_type" for a definition the SAME call from the top-level session resolves.
  test("M7: the parent's programmatic `agents` map reaches the child, so a grandchild can resolve a subagent_type", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const AGENTS_PROBE = "t6fw_agents_probe";
    cleanupToolNames.push(AGENTS_PROBE);
    let childAgents: unknown;
    registerTool({
      descriptor: {
        canonicalName: AGENTS_PROBE, advertisedName: AGENTS_PROBE, source: "builtin", inputSchema: { type: "object" },
        description: "reports this run's own ctx.agents", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        async execute(_input: unknown, ctx: ToolExecutionContext) {
          childAgents = ctx.agents;
          return { output: "probed" };
        },
      },
    });
    const programmatic = { reviewer: { description: "reviews code", prompt: "You are a careful reviewer." } };
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "probe your agents map", runInBackground: false };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: AGENTS_PROBE, input: {} }] },
      { kind: "text", text: "probed" },
    ]);
    const { code } = await driveParent(
      { provider: childProvider },
      baseConfig({ sessionId: "parent-agents-mirror", agents: programmatic }),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    expect(childAgents, "ctx.agents is undefined inside a child until the map is mirrored").toEqual(programmatic);
  }, 20_000);

  // RULING P4-N (residual round): the `winter.mcp` family follows the LIVE SLOT COUNT at every
  // nesting level -- a child of a zero-MCP session advertises none of it.
  //
  // The regression this pins: after M2 every parent builds a lifecycle (so it always has a state
  // source, possibly over an EMPTY board), and Lane X's I2 hands that board down to every child. The
  // predicate used to short-circuit on "a caller supplied a state source", on the heuristic that such
  // a caller owns an MCP stack -- true of a daemon, false of the commonest caller there is, a parent
  // engine. So a child of a session with no MCP at all derived `winter.mcp` from an empty board.
  test("P4-N: a child of a ZERO-MCP session advertises NONE of the winter.mcp family; a child of a real one advertises it", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const CAPS_PROBE = "t6fw_child_caps_probe";
    cleanupToolNames.push(CAPS_PROBE);
    const MCP_FAMILY = ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "RefreshMcpTools"] as const;
    let childAdvertised: string[] | undefined;
    let childCaps: string[] = [];
    registerTool({
      descriptor: {
        canonicalName: CAPS_PROBE, advertisedName: CAPS_PROBE, source: "builtin", inputSchema: { type: "object" },
        description: "reports which MCP-family tools this run can dispatch", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        // Read off the CHILD's own registered ToolSearch session runtime (the same lookup Lane X's
        // I2 test uses), because a child's `system/init` is swallowed by `transformChildFrame` and
        // its advertised set is therefore not observable on the parent's wire at all. That runtime's
        // `capabilities` is the live getter this ruling changed, and it is the exact value the
        // child's own advertised partition and dispatch-time availability check both consult.
        async execute(_input: unknown, ctx: ToolExecutionContext) {
          const caps = [...(getToolSearchSessionRuntime(ctx.agentId ?? ctx.sessionId)?.capabilities ?? [])];
          childCaps = caps;
          childAdvertised = MCP_FAMILY.filter((n) => buildAdvertisedSet({ mode: "default", capabilities: caps }).some((d) => d.canonicalName === n));
          return { output: "probed" };
        },
      },
    });

    async function childCapabilities(parentConfig: RuntimeConfig): Promise<string[]> {
      childAdvertised = undefined;
      childCaps = [];
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "probe your caps", runInBackground: false };
      const childProvider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "c1", name: CAPS_PROBE, input: {} }] },
        { kind: "text", text: "probed" },
      ]);
      await driveParent({ provider: childProvider }, parentConfig, [
        { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
        { kind: "text", text: "parent done" },
      ]);
      return childCaps;
    }

    // A parent with NO MCP at all -> the child must not derive winter.mcp.
    const none = await childCapabilities(baseConfig({ sessionId: "p4n-zero-mcp" }));
    expect(none, "a child of a zero-MCP session must not derive winter.mcp").not.toContain("winter.mcp");
    expect(childAdvertised).toEqual([]);

    // The control: a parent that declares a REAL server -> the child does derive it, so the
    // assertion above is about the empty board and not about children never getting the token.
    const some = await childCapabilities(
      baseConfig({ sessionId: "p4n-real-mcp", mcpServers: { fixture: { type: "sdk", name: "fixture", tools: [{ name: "echo", inputSchema: { type: "object" } }] } } }),
    );
    expect(some, "a child of a session with a live server still derives winter.mcp").toContain("winter.mcp");
  }, 20_000);

  test("I2: the CHILD's own ToolSearch session runtime carries the parent's MCP state source, not an empty one", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const RUNTIME_PROBE = "t6fw_toolsearch_runtime_probe";
    cleanupToolNames.push(RUNTIME_PROBE);
    // White-box, deliberately: the two session-keyed lookups (`ctx.sessionId` for the owning
    // session's registrations, the child's own `agentId` for its own) must BOTH answer correctly,
    // or a later change to either lookup silently reintroduces the wrong `ready:true`.
    let childRuntimeHadStateSource: boolean | undefined;
    registerTool({
      descriptor: {
        canonicalName: RUNTIME_PROBE, advertisedName: RUNTIME_PROBE, source: "builtin", inputSchema: { type: "object" },
        description: "reads this run's own registered ToolSearch session runtime", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        async execute(_input: unknown, ctx: ToolExecutionContext) {
          childRuntimeHadStateSource = getToolSearchSessionRuntime(ctx.agentId ?? ctx.sessionId)?.stateSource !== undefined;
          return { output: "probed" };
        },
      },
    });
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "probe your own runtime", runInBackground: false };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: RUNTIME_PROBE, input: {} }] },
      { kind: "text", text: "probed" },
    ]);
    const { code } = await driveParent(
      { provider: childProvider },
      baseConfig({ sessionId: "parent-ts-runtime-s", mcpServers: { fixture: { type: "sdk", name: "fixture", tools: [{ name: "echo", inputSchema: { type: "object" } }] } } }),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    expect(childRuntimeHadStateSource).toBe(true);
  }, 20_000);

  test("I4: a definition's own `mcpServers` connect as CHILD-SCOPED servers -- callable inside the child, absent from the parent's advertised set", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const childOnlySpec = {
      tools: [{ name: "shout", description: "uppercases", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, handler: (args: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: `SHOUT:${String(args.text)}` }] }) }],
      resources: [],
    };
    await withHttpFixture(childOnlySpec, async (url) => {
      const req: SpawnChildRequest = {
        parentToolUseId: "call-1", prompt: "use your own server", runInBackground: false,
        definition: {
          description: "child with its own MCP server", prompt: "persona",
          mcpServers: [{ childsrv: { type: "http", url: url.href } }, "not-declared-anywhere"],
        },
      };
      const scripted = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "c1", name: "mcp__childsrv__shout", input: { text: "hi" } }] },
        { kind: "text", text: "child used its own server" },
      ]);
      // Captures the child's own first turn so the STRING-entry warning can be asserted where it
      // is actually delivered (child-engine.ts's firstTurnText).
      let childFirstTurn = "";
      const childProvider: Provider = {
        async generate(args) {
          if (childFirstTurn === "") {
            const firstUser = args.messages.find((m) => m.role === "user");
            childFirstTurn = typeof firstUser?.content === "string" ? firstUser.content : "";
          }
          return scripted.generate(args);
        },
      };
      // MCP_CONNECTION_NONBLOCKING=0 makes the CHILD's own startup wait for its server batch, so
      // its advertised set deterministically contains the server's tools (the same connect race
      // engine.test.ts's own elicitation scenario had to close). `deps.env` is the child engine's
      // own environment.
      const { code, frames } = await driveParent({ provider: childProvider, env: { MCP_CONNECTION_NONBLOCKING: "0" } }, baseConfig({ sessionId: "parent-i4-s" }), [
        { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
        { kind: "text", text: "parent done" },
      ]);
      expect(code).toBe(0);
      const blocks = dataMessages(frames)
        .filter((m) => m.type === "user")
        .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []));
      // Before the fix: `AgentDefinition.mcpServers` was dropped on the floor, so this name was
      // never registered at all and the call answered an "unknown tool" error.
      expect(blocks.find((b) => b.tool_use_id === "c1")!.content).toContain("SHOUT:hi");
      // The PARENT declared no servers: its own init.tools carries neither the child's server's
      // tool nor the winter.mcp-gated bridge family.
      const init = frames.find((f) => f.type === "init") as { tools: string[] };
      expect(init.tools).not.toContain("mcp__childsrv__shout");
      expect(init.tools).not.toContain("ListMcpResourcesTool");
      // A STRING entry naming a server the session does not declare is warned about, never dropped
      // silently -- the warning rides the child's own first turn (child-engine.ts's firstTurnText).
      expect(childFirstTurn).toContain('mcpServers names "not-declared-anywhere"');
    });
  }, 20_000);
});

// --- Phase 4 fix wave: I5 -- interrupt and teardown stop in-process children ---------------------

// Spawns a child, stashes the handle for the test, AND awaits its result -- the FOREGROUND shape
// (tools/impl/agent.ts's own non-background branch), so an interrupt genuinely abandons a call that
// is mid-await on a live child.
const SPAWN_AWAIT_REGISTER = "t6fw_spawn_await_register";
function registerSpawnAwaitRegister(): void {
  registerTool({
    descriptor: {
      canonicalName: SPAWN_AWAIT_REGISTER, advertisedName: SPAWN_AWAIT_REGISTER, source: "builtin", inputSchema: { type: "object" },
      description: "spawns a child, stashes the handle, and awaits its result", exposure: "eager", permissionClass: "read",
      availability: {}, capabilityRequirements: [], disposition: "implement-now",
    },
    executor: {
      async execute(input: unknown, ctx: ToolExecutionContext) {
        if (!ctx.session.spawnChild) return { output: "no spawnChild capability configured", isError: true };
        const handle = await ctx.session.spawnChild(input as SpawnChildRequest);
        liveHandles.set(handle.record.id, handle);
        const result = await handle.result();
        return { output: JSON.stringify({ agentId: handle.record.id, result }) };
      },
    },
  });
}

describe("child-engine.ts: interrupt and teardown stop live children (fix wave I5, WS-04 §5)", () => {
  test("interrupting the parent's turn STOPS the foreground child the abandoned Agent call was awaiting -- it executes no further tools", async () => {
    registerSpawnAwaitRegister();
    cleanupToolNames.push(SPAWN_AWAIT_REGISTER);
    const SLOW = "t6fw_slow";
    const MARKER = "t6fw_after_interrupt";
    cleanupToolNames.push(SLOW, MARKER);
    let slowStarted = false;
    registerTool({
      descriptor: {
        canonicalName: SLOW, advertisedName: SLOW, source: "builtin", inputSchema: { type: "object" },
        description: "returns after a short real delay", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        async execute() {
          slowStarted = true;
          await new Promise((r) => setTimeout(r, 250));
          return { output: "slow done" };
        },
      },
    });
    const marker = registerRecordingTool(MARKER);
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "work slowly", runInBackground: false };
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: SLOW, input: {} }] },
      // Reached ONLY if the child kept running past the parent's interrupt -- which is exactly the
      // abandoned-but-alive engine loop the review describes ("an unbounded engine loop that can
      // call further tools and spawn further children").
      { kind: "tool_use", calls: [{ id: "c2", name: MARKER, input: {} }] },
      { kind: "text", text: "child finished anyway" },
    ]);
    registerChildEngineFactory(createChildEngineFactory({ provider: childProvider }));
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AWAIT_REGISTER, input: req }] },
      { kind: "text", text: "parent done" },
    ]);
    const done = runEngine({ config: baseConfig({ sessionId: "parent-interrupt-s" }), input: runtime.input, output: runtime.output, provider });
    host.output.write({ type: "user", text: "go" });
    const drainPromise = drain(host.input);
    await waitUntil(() => liveHandles.size === 1 && slowStarted);
    const handle = [...liveHandles.values()][0]!;
    host.output.write({ type: "control_request", requestId: "int-1", subtype: "interrupt", payload: undefined });
    await waitUntil(() => handle.status() !== "running");
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    await drainPromise;
    await done;
    expect(handle.status()).toBe("stopped");
    expect(marker.ran, "an abandoned foreground child must not keep executing tools").toEqual([]);
  }, 15_000);

  test("teardown STOPS a background child that is still running -- never withdrawn from the roster while still alive", async () => {
    registerSpawnAndRegister();
    cleanupToolNames.push(SPAWN_AND_REGISTER);
    const BLOCKER = "t6fw_teardown_blocker";
    cleanupToolNames.push(BLOCKER);
    const gate = registerBlockingTool(BLOCKER);
    try {
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "block forever", runInBackground: true };
      const childProvider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "c1", name: BLOCKER, input: {} }] },
        { kind: "text", text: "child finished" },
      ]);
      const { code } = await driveParent({ provider: childProvider }, baseConfig({ sessionId: "parent-teardown-s" }), [
        { kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_AND_REGISTER, input: req }] },
        { kind: "text", text: "parent done" },
      ]);
      expect(code).toBe(0);
      const handle = [...liveHandles.values()][0]!;
      // Before the fix: still "running" AFTER runEngine returned -- live, executing, and already
      // withdrawn from the messaging roster, i.e. unaddressable by anything.
      expect(handle.status()).toBe("stopped");
    } finally {
      gate.release();
    }
  }, 15_000);
});

// --- Phase 4 fix wave: T8 review M5 -- a THROWING forward must not pause the clock forever -------

describe("child-engine.ts: the watchdog pause is paired with a SUCCESSFUL forward (fix wave, T8 review M5)", () => {
  test("a child whose control_request forward THROWS (torn-down parent stream) is still reaped by the stall watchdog, never left waiting forever", async () => {
    const NEEDS_PROMPT = "t6fw_m5_needs_prompt";
    cleanupToolNames.push(NEEDS_PROMPT);
    const probe = registerRecordingTool(NEEDS_PROMPT);
    const childProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: NEEDS_PROMPT, input: {} }] },
      { kind: "text", text: "never reached" },
    ]);
    // Driven through the factory DIRECTLY (not a parent runEngine): the whole point is a run
    // context whose `forwardChildFrame` throws, which a real engine's own closure never does.
    const factory = createChildEngineFactory({ provider: childProvider, env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "60" } });
    const deps = factory({
      parentSessionId: "parent-m5-s",
      forwardChildFrame: (frame) => {
        if (frame.type === "control_request") throw new Error("the parent stream is torn down");
      },
    });
    const handle = await deps.spawn(
      { parentToolUseId: "call-1", prompt: "reach a prompt", runInBackground: false },
      {
        // `default` mode with no matching rule is what makes the child's own call reach a real
        // permission control_request -- the frame whose forward throws.
        policy: { effectiveMode: "default", parentPolicyVersion: 1, parentPolicyHash: "h" },
        tools: [NEEDS_PROMPT],
        model: "winter-test/echo",
        effort: "inherit",
        thinking: undefined,
        systemPrompt: "",
        sessionRoot: tmpdir(),
      },
    );
    // BOUNDED: without the fix the watchdog is paused for a request the host never received, so
    // `result()` never settles at all -- this race turns that hang into a loud, fast failure.
    const outcome = await Promise.race([
      handle.result().then((r) => r.status as string),
      new Promise<string>((r) => setTimeout(() => r("NEVER SETTLED -- the watchdog was left paused"), 2000)),
    ]);
    expect(outcome).toBe("failed");
    expect(probe.ran, "the child's call was never approved, so it must never have executed").toEqual([]);
  }, 10_000);
});

// ================================================================================================
// T8 rider 12 / WS-11 §6.5: "dispatch-children inherit the parent's style."
// ================================================================================================
//
// Lane C's report: the assembler already applies whatever arrives on `config.outputStyle`, so the
// MECHANISM was ready -- `ChildInheritance` simply had no field for it and `buildChildInheritance`
// set nothing, so a child silently ran under the default style however its parent was configured.
// Asserted on the CHILD's own config, through a probe assembler, because that is the only place the
// two ends of the channel meet.
describe("child-engine.ts: rider 12 -- a dispatch-child inherits its parent's output style", () => {
  test("the parent's `outputStyle` reaches the CHILD's own RuntimeConfig", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const seenChildStyles: (string | undefined)[] = [];
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "task", runInBackground: false };
    const { code } = await driveParent(
      {
        provider: echoProvider,
        systemPromptAssembler: {
          assemble: (input) => {
            // `insideSubagent` is the child's own marker -- the parent's assemble() call reaches
            // here too, and recording both would make the assertion ambiguous.
            if (input.config.insideSubagent === true) seenChildStyles.push(input.config.outputStyle);
            return { system: "probe", userContextBlocks: [] };
          },
        },
      },
      { ...baseConfig(), outputStyle: "explanatory" },
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    expect(seenChildStyles.length).toBeGreaterThan(0);
    expect(seenChildStyles.every((s) => s === "explanatory")).toBe(true);
  });

  test("a parent with NO style configured passes none -- absence, never a fabricated \"default\"", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const seenChildStyles: (string | undefined)[] = [];
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "task", runInBackground: false };
    const { code } = await driveParent(
      {
        provider: echoProvider,
        systemPromptAssembler: {
          assemble: (input) => {
            if (input.config.insideSubagent === true) seenChildStyles.push(input.config.outputStyle);
            return { system: "probe", userContextBlocks: [] };
          },
        },
      },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    expect(seenChildStyles.length).toBeGreaterThan(0);
    expect(seenChildStyles.every((s) => s === undefined)).toBe(true);
  });
});

// ================================================================================================
// T8: the two OTHER child threads, which the persona and output-style fixtures above do not reach.
// ================================================================================================
//
// `systemPromptAssembler` and `outputStyle` each have their own fixture; `structuredOutput` and
// `skillRuntime` reached children through conditional spreads with no test at all -- implied-covered
// by their neighbours, which is exactly the shape a review catches. Each has an obvious RED probe
// (drop the spread), and each closes a failure a caller would meet on their first real use.
describe("child-engine.ts: T8 -- the structured seam and the skill index reach a child", () => {
  test("a child with `outputFormat` set does NOT hard-fail its first round -- the parent's structured seam reaches it", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    // WITHOUT the thread this is T3's concern 3 verbatim: `outputFormat` with no seam is a hard
    // `error_during_execution` on the child's first round -- which is what Lane W's `agent({schema})`
    // would hit on every schema'd call, since it rides exactly this field.
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const req: SpawnChildRequest = {
      parentToolUseId: "call-1",
      prompt: "decide",
      runInBackground: false,
      outputFormat: { type: "json_schema", schema },
    };
    const { code, frames } = await driveParent(
      { provider: echoProvider, structuredOutput: createStructuredOutputSeam() },
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
    // The child ran a real turn. The specific thing being excluded is the configuration error:
    // "outputFormat is configured but no structured-output seam is registered for this session".
    expect(block.content).not.toContain("no structured-output seam is registered");
  });

  test("WITHOUT the seam, the same child fails with the R5-10 configuration error -- the RED half, kept as the discriminator", async () => {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "decide", runInBackground: false, outputFormat: { type: "json_schema", schema } };
    const { code, frames } = await driveParent(
      { provider: echoProvider }, // no structuredOutput -- a factory built the way every pre-T8 one was
      baseConfig(),
      [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
    );
    expect(code).toBe(0);
    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const block = toolResult.message.content.find((b) => b.tool_use_id === "call-1")!;
    expect(block.content).toContain("no structured-output seam is registered");
  });

  test("a `Skill` call INSIDE a child resolves -- the parent's index is registered under the CHILD's own agent id", async () => {
    // `skills/runtime.ts` is keyed `agentId ?? sessionId`, deliberately, so a child never resolves
    // against its PARENT's `skills` option -- which also means a child with no registration of its
    // own answers "no skills runtime" to every `Skill` call. The registration is per GENERATION and
    // is withdrawn at settle.
    const skillHome = mkdtempSync(join(tmpdir(), "winter-t8-childskill-"));
    try {
      mkdirSync(join(skillHome, "skills", "childprobe"), { recursive: true });
      writeFileSync(join(skillHome, "skills", "childprobe", "SKILL.md"), "---\nname: childprobe\ndescription: a child skill probe\n---\nCHILD SKILL BODY MARKER\n");
      const index = SkillIndex.build({ cwd: mkdtempSync(join(tmpdir(), "winter-t8-childskill-cwd-")), winterHome: skillHome, settingSources: ["user"] });
      expect(index.names()).toEqual(["childprobe"]);

      registerSpawnProbe();
      cleanupToolNames.push(SPAWN_PROBE);
      const seen: string[] = [];
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "use it", runInBackground: false };
      // The CHILD's own provider script: one `Skill` call, then text. `driveParent`'s scripted
      // provider is the PARENT's; a child gets `deps.provider`, which is this one.
      const childProvider: Provider = {
        async generate({ messages }) {
          // The CHILD's own view of its Skill call's result -- read straight off the messages the
          // child engine hands its provider on the next round. That is the only place the body
          // appears without `forwardSubagentText`, and it is the ground truth for "did the executor
          // resolve, or answer a typed refusal".
          for (const m of messages) {
            if (m.role !== "tool" || !Array.isArray(m.content)) continue;
            for (const b of m.content as Array<{ tool_use_id?: string; content?: unknown }>) {
              if (b.tool_use_id === "child-skill-1" && typeof b.content === "string") seen.push(b.content);
            }
          }
          if (seen.length > 0) return { kind: "text", text: "child done" };
          return { kind: "tool_use", calls: [{ id: "child-skill-1", name: "Skill", input: { skill: "childprobe" } }] };
        },
      };
      const { code, frames } = await driveParent(
        { provider: childProvider, skillRuntime: { index } },
        { ...baseConfig(), allowedTools: [SPAWN_PROBE, "Skill"] },
        [{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }],
      );
      expect(code).toBe(0);
      void frames;
      expect(seen.length, "the child's Skill call produced a tool_result").toBeGreaterThan(0);
      // THE RESULT IS THE BODY (WS-11 §2.3). A typed refusal is also a tool_result, so the marker is
      // what distinguishes "resolved and loaded" from "answered politely" -- the same discriminator
      // the cross-leg skill round uses.
      expect(seen[0]).toContain("CHILD SKILL BODY MARKER");
    } finally {
      rmSync(skillHome, { recursive: true, force: true });
    }
  });
});

// ================================================================================================
// Phase 5 fix wave, I4 — children get the settings-file hook entries and a compaction controller.
// ================================================================================================
//
// T8 threaded THREE of the parent's session seams to children and left these two behind. The hook
// half is the security one, and the scenario is concrete: a user writes a `PreToolUse` command hook
// into `~/.winter/settings.json` that denies `rm -rf`. It ran for the parent's Bash calls and was
// SILENT for every subagent's -- WS-07 §11 and WS-08 §2, in a new dimension of the P4 C1 class.
describe("child-engine.ts: I4 -- a settings-file hook governs a CHILD, and a child can compact", () => {
  // DRIVEN BY ITS OWN HARNESS, not `driveParent`. That helper's `baseConfig()` runs under
  // `bypassPermissions` from a FIXED, possibly-absent cwd -- and under bypass the permission
  // pipeline short-circuits before the hook stage, so a bypass child never consults `PreToolUse` at
  // all and the fixture would measure nothing. Found by running it: the marker never appeared while
  // the identical wiring, driven in `default` mode from a real temp cwd, fired every time.
  async function driveWithChild(
    deps: Partial<ChildEngineFactoryDeps> & { provider: Provider },
    cwd: string,
    childCalls: string[],
    extra: Partial<RuntimeConfig> = {},
  ): Promise<number> {
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    registerChildEngineFactory(createChildEngineFactory(deps as ChildEngineFactoryDeps));
    const { host, runtime } = createInMemoryChannel();
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "do a thing", runInBackground: false };
    const done = runEngine({
      config: {
        sessionId: `i4-${Math.random().toString(36).slice(2, 8)}`,
        cwd,
        model: "winter-test/echo",
        // `permissions.allow`, NOT `allowedTools`: only the former is mirrored onto a child
        // (`parentPermissionRules`, the P4 C1 fix), so without it the child's own call reaches a
        // prompt nothing here answers and the child stalls instead of running its tool.
        permissions: { allow: [SPAWN_PROBE, ...childCalls] },
        ...extra,
      },
      input: runtime.input,
      output: runtime.output,
      provider: scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }]),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined });
    await drain(host.input);
    return done;
  }

  /** A child that makes exactly one tool call, then answers with text. */
  function childCalling(name: string): Provider {
    return {
      async generate({ messages }) {
        if (messages.some((m) => m.role === "tool")) return { kind: "text", text: "child done" };
        return { kind: "tool_use", calls: [{ id: "child-1", name, input: {} }] };
      },
    };
  }

  test("a PreToolUse command hook supplied to the factory FIRES inside a child", async () => {
    // A REAL `{type:"command"}` entry -- what a settings-file hook block actually produces, and the
    // only shape observable without a host: a callback-shaped entry routes to
    // `createBridgeHookInvoker`, which sends a control_request nothing here answers. The MARKER FILE
    // is the observable, because a hook that ran and a hook that was never consulted produce the
    // same frames.
    const dir = mkdtempSync(join(tmpdir(), "winter-i4-hook-"));
    try {
      const marker = join(dir, "fired.txt");
      const code = await driveWithChild(
        {
          provider: childCalling("ReadNotifications"),
          extraHookEntries: [{ id: "PreToolUse:user:0:0", event: "PreToolUse", source: "user", command: `printf child > ${marker}` }] as unknown as NonNullable<ChildEngineFactoryDeps["extraHookEntries"]>,
        },
        dir,
        ["ReadNotifications"],
      );
      expect(code).toBe(0);
      expect(existsSync(marker), "the parent's settings-file hook entries must reach the child's own registry").toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child WITHOUT the thread never fires it -- the discriminating half", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-i4-nohook-"));
    try {
      const marker = join(dir, "fired.txt");
      const code = await driveWithChild({ provider: childCalling("ReadNotifications") }, dir, ["ReadNotifications"]);
      expect(code).toBe(0);
      expect(existsSync(marker), "a factory built the pre-I4 way leaves the child ungoverned").toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child CROSSING the context threshold compacts -- the controller reaches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-i4-compact-"));
    try {
      const compactions: number[] = [];
      const controller: CompactionController = {
        shouldCompact: (accountant) => accountant.contextTokens() >= 900,
        async compact(input) {
          compactions.push(input.messages.length);
          return { summary: "child summary", retained: input.messages.slice(-1), preTokens: input.accountant.contextTokens(), evidencedToolNames: [] };
        },
      };
      // The CHILD's provider reports enough usage to cross AND answers the summarizer separately --
      // Lane K's own named trap: the summarizer runs on the same provider object.
      let turn = 0;
      const childProvider: Provider = {
        async generate(input) {
          if (input.system?.includes("compacting a conversation") === true) return { kind: "text", text: "SUMMARY" };
          turn++;
          if (turn === 1) return { kind: "tool_use", calls: [{ id: "child-1", name: "ReadNotifications", input: {} }], usage: { inputTokens: 950, outputTokens: 0 } };
          return { kind: "text", text: "child done", usage: { inputTokens: 950, outputTokens: 0 } };
        },
      };
      const code = await driveWithChild({ provider: childProvider, compactionController: controller }, dir, ["ReadNotifications"], { contextWindowTokens: 1000 });
      expect(code).toBe(0);
      expect(compactions.length, "with no controller `maybeAutoCompact` returns immediately and a child never compacts").toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ================================================================================================
// Phase 5 fix wave, RULINGS P5-I and P5-J — the two values that never crossed the child seam.
// ================================================================================================
describe("child-engine.ts: P5-I -- the child's VALIDATED structured object reaches the parent", () => {
  /** The parent's own tool_result for `call-1`, wherever it lands in the stream. */
  function agentResultFor(frames: WinterFrame[], toolUseId: string): Record<string, unknown> {
    for (const msg of dataMessages(frames)) {
      if (msg.type !== "user") continue;
      const content = (msg as unknown as { message?: { content?: Array<{ tool_use_id?: string; content?: string }> } }).message?.content;
      const block = content?.find((b) => b.tool_use_id === toolUseId);
      if (block?.content === undefined) continue;
      return JSON.parse(block.content) as Record<string, unknown>;
    }
    throw new Error(`no tool_result for ${toolUseId}`);
  }

  test("a child with `outputFormat` returns its validated object on `ChildResult.structuredOutput`", async () => {
    // THE GAP: the engine's structured SUCCESS variant sets `structured_output` and NO `result`, and
    // `observe` read `message.result` -- so the validated object never crossed the P4 seam and Lane
    // W's `agent({schema})` fell back to re-parsing the child's final TEXT, which a child forced onto
    // `StructuredOutput` generally does not produce. It mostly resolved `null`.
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const dir = mkdtempSync(join(tmpdir(), "winter-p5i-"));
    try {
      const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false };
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "decide", runInBackground: false, outputFormat: { type: "json_schema", schema } };
      const childProvider: Provider = {
        async generate() {
          return { kind: "tool_use", calls: [{ id: "so-1", name: "StructuredOutput", input: { verdict: "ship it" } }] };
        },
      };
      registerChildEngineFactory(createChildEngineFactory({ provider: childProvider, structuredOutput: createStructuredOutputSeam() }));
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: { sessionId: "p5i", cwd: dir, model: "winter-test/echo", permissions: { allow: [SPAWN_PROBE, "StructuredOutput"] } },
        input: runtime.input,
        output: runtime.output,
        provider: scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }]),
      });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      expect(await done).toBe(0);

      const parsed = agentResultFor(frames, "call-1") as { result: { structuredOutput?: unknown } };
      expect(parsed.result.structuredOutput, "the child's own engine validated this; nothing re-parses it").toEqual({ verdict: "ship it" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child that produced NO structured output leaves the field ABSENT -- so a consumer knows to fall back", async () => {
    // Absence is the contract: `agent({schema})`'s text re-parse is a FALLBACK, and a `undefined`
    // that meant "the child produced undefined" would make a legitimate result look like absence.
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const dir = mkdtempSync(join(tmpdir(), "winter-p5i-none-"));
    try {
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "just talk", runInBackground: false };
      registerChildEngineFactory(createChildEngineFactory({ provider: echoProvider }));
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: { sessionId: "p5i-none", cwd: dir, model: "winter-test/echo", permissions: { allow: [SPAWN_PROBE] } },
        input: runtime.input,
        output: runtime.output,
        provider: scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "parent done" }]),
      });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      expect(await done).toBe(0);
      const parsed = agentResultFor(frames, "call-1") as { result: Record<string, unknown> };
      expect("structuredOutput" in parsed.result).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("child-engine.ts: P5-J -- a child's spend rolls up into the owning session's cumulative total", () => {
  test("two child turns add to the PARENT's `spentTokens()`, and leave its `contextTokens()` alone", async () => {
    // The distinction IS the ruling. `contextTokens()` is the last call's context SIZE -- it is
    // overwritten, it goes DOWN after a compaction, and a budget ceiling built on it is un-reached by
    // a smaller call. `spentTokens()` only grows. A child's tokens are spend the session is
    // responsible for and are NOT part of the parent's next request, so they must reach one counter
    // and not the other.
    registerSpawnProbe();
    cleanupToolNames.push(SPAWN_PROBE);
    const dir = mkdtempSync(join(tmpdir(), "winter-p5j-"));
    try {
      const parentAccountant = createContextAccountant({ limit: 100000 });
      const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "work", runInBackground: false };
      let childTurn = 0;
      const childProvider: Provider = {
        async generate({ messages }) {
          childTurn++;
          if (messages.some((m) => m.role === "tool")) return { kind: "text", text: "child done", usage: { inputTokens: 30, outputTokens: 0 } };
          return { kind: "tool_use", calls: [{ id: "c", name: "ReadNotifications", input: {} }], usage: { inputTokens: 20, outputTokens: 0 } };
        },
      };
      registerChildEngineFactory(createChildEngineFactory({ provider: childProvider }));
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: { sessionId: "p5j", cwd: dir, model: "winter-test/echo", permissions: { allow: [SPAWN_PROBE, "ReadNotifications"] } },
        input: runtime.input,
        output: runtime.output,
        provider: scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }], usage: { inputTokens: 7, outputTokens: 0 } }, { kind: "text", text: "parent done", usage: { inputTokens: 11, outputTokens: 0 } }]),
        contextAccountant: parentAccountant,
      });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined });
      await drain(host.input);
      expect(await done).toBe(0);
      expect(childTurn, "the child really ran two generations").toBe(2);
      // 7 + 11 (the parent's own) + 20 + 30 (the child's, rolled up) = 68.
      expect(parentAccountant.spentTokens()).toBe(68);
      // ...and the context reading is the PARENT's LAST call alone, untouched by the child.
      expect(parentAccountant.contextTokens()).toBe(11);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ==================================================================================================
// Phase 5 residual round, NEW-4 (whole-branch re-review, BLOCKING).
//
// C1 and I1 were rated on the PARENT engine. Inside a real child they did not bind at all: the
// managed tier -- the strongest one, the tier every "managed beats everything" rule in the evaluator
// exists for -- was dropped on the way down, and so were the resolved-root floors. The model reaches
// both simply by delegating to a subagent.
//
// TWO INDEPENDENT MECHANISMS, which is why threading one thing was never going to be enough:
//   (a) `engine.ts`'s `getParentRules` mirror SKIPS every `source === "managed"` entry. That skip was
//       written when `managed` meant only the hard-coded `BASELINE_DENY_RULES`, where mirroring
//       would have re-tagged a managed rule as `sdk` for zero coverage. The fix wave falsified the
//       premise: C1 now seeds managed-TIER settings rules as `managed`, and I1 emits the
//       resolved-root twins as `managed`.
//   (b) the child's `runEngine` received neither `settingsRules` nor `winterHome`. `deps.winterHome`
//       existed on the factory and was used only for transcript paths.
//
// THE FIX IS THE SEED, NOT A WIDER MIRROR. Re-tagging a managed deny as `sdk` in the child would not
// bind under a forced-bypass child at all -- stage 2 honours only `managed` denies there -- so the
// mirror is exactly the wrong vehicle. The child seeds the same `SettingsRuleSeed` its parent did,
// tags intact, and the `managed` skip in `getParentRules` becomes correct again.
//
// EVERY TEST CARRIES ITS PARENT-DIRECT CONTROL IN THE SAME BODY. A child-only assertion cannot
// distinguish "the child is governed" from "the rule was never in force anywhere".
// ==================================================================================================
describe("child-engine.ts: NEW-4 -- managed-tier settings rules and the resolved-root floors bind INSIDE a child", () => {
  const CHILD_TOOL = "t_new4_probe";

  /** A child that makes exactly one call to `name`, then answers with text. */
  function childCalling(name: string, input: Record<string, unknown> = {}): Provider {
    return {
      async generate({ messages }) {
        if (messages.some((m) => m.role === "tool")) return { kind: "text", text: "child done" };
        return { kind: "tool_use", calls: [{ id: "child-1", name, input }] };
      },
    };
  }

  /**
   * Drives a REAL parent `runEngine` over a REAL `buildProductionWiring`, spawning a REAL child
   * through `registerDefaultChildEngineFactory` -- the same call `main.ts` and `testing.ts` make.
   *
   * Going through the wiring rather than hand-building a `SettingsRuleSeed` is the point: NEW-4 is a
   * THREADING defect, so a fixture that constructs the seed itself would prove the evaluator works
   * while skipping the entire span where the value went missing.
   */
  async function runWithWiring(opts: {
    cwd: string;
    home: string;
    managedSettings?: Record<string, unknown>;
    userSettings?: Record<string, unknown>;
    childProvider: Provider;
    allow: string[];
    permissionMode?: string;
    parentCallsToolDirectly?: { name: string; input: Record<string, unknown> };
    /** NEW-2: spawn a SECOND child in the same run -- the sibling case. */
    spawnTwice?: boolean;
    /** Overrides applied AFTER the wiring's own `childFactoryOptions`, to observe what a child got. */
    childFactoryOverrides?: Record<string, unknown>;
  }): Promise<{ prompts: number; frames: WinterFrame[] }> {
    // Registered at most ONCE per test: `registerTool` throws on a duplicate canonical name, and the
    // control/measurement pairs below call this helper twice in one body.
    if (!cleanupToolNames.includes(SPAWN_PROBE)) {
      registerSpawnProbe();
      cleanupToolNames.push(SPAWN_PROBE);
    }
    if (opts.userSettings !== undefined) writeFileSync(join(opts.home, "settings.json"), JSON.stringify(opts.userSettings));

    const config = {
      sessionId: `new4-${randomUUID()}`,
      cwd: opts.cwd,
      model: "winter-test/echo",
      permissions: { allow: [SPAWN_PROBE, ...opts.allow] },
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(opts.managedSettings !== undefined ? { managedSettings: opts.managedSettings } : {}),
    } as unknown as RuntimeConfig;

    const wiring = await buildProductionWiring({ config, env: {}, winterHome: opts.home });
    registerDefaultChildEngineFactory({
      provider: opts.childProvider,
      config,
      env: {},
      winterHome: opts.home,
      ...wiring.childFactoryOptions,
      ...(opts.childFactoryOverrides ?? {}),
    });

    const { host, runtime } = createInMemoryChannel();
    const req: SpawnChildRequest = { parentToolUseId: "call-1", prompt: "do a thing", runInBackground: false };
    // The parent's OWN direct call, when asked for, runs FIRST -- so the control and the measurement
    // are the same run against the same rule set, never two runs that might differ for other reasons.
    const parentScript = opts.parentCallsToolDirectly !== undefined
      ? [
          { kind: "tool_use" as const, calls: [{ id: "call-0", name: opts.parentCallsToolDirectly.name, input: opts.parentCallsToolDirectly.input }] },
          { kind: "tool_use" as const, calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
          { kind: "text" as const, text: "parent done" },
        ]
      : opts.spawnTwice === true
        ? [
            { kind: "tool_use" as const, calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
            { kind: "tool_use" as const, calls: [{ id: "call-2", name: SPAWN_PROBE, input: { ...req, parentToolUseId: "call-2" } }] },
            { kind: "text" as const, text: "parent done" },
          ]
        : [
            { kind: "tool_use" as const, calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] },
            { kind: "text" as const, text: "parent done" },
          ];

    let prompts = 0;
    const done = runEngine({
      config,
      ...wiring.engineOptions,
      input: runtime.input,
      output: runtime.output,
      provider: scriptedProvider(parentScript),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) {
      // Any permission prompt is DENIED, so a rule that only downgrades deny->ask still fails the
      // "did it run" assertion rather than hanging the test. Subtype `"permission"` and the
      // `{ok, payload}` envelope, per `settings-permissions-wiring.test.ts`'s own driver -- a
      // mis-shaped response is never rejected, it is simply never matched, and the run hangs.
      if (f.type === "control_request" && (f as { subtype?: string }).subtype === "permission") {
        prompts++;
        host.output.write({ type: "control_response", requestId: (f as { requestId: string }).requestId, ok: true, payload: { behavior: "deny", message: "test denies every prompt" } } as unknown as WinterFrame);
        continue;
      }
      frames.push(f);
    }
    await done;
    wiring.dispose();
    return { prompts, frames };
  }

  /**
   * A child that writes `file`, then answers with text. `Write` rather than a synthetic tool because
   * a SCOPED rule (`Tool(pattern)`) needs a tool with real rule-input semantics -- a registered test
   * double supplies none, so `t_probe(blocked)` matches nothing and the fixture measures the
   * matcher's silence instead of the seed's absence. Found by running it: the first draft's child
   * called the double eight times under a rule that could never apply.
   */
  function childWriting(file: string): Provider {
    return {
      async generate({ messages }) {
        if (messages.some((m) => m.role === "tool")) return { kind: "text", text: "child done" };
        return { kind: "tool_use", calls: [{ id: "child-1", name: "Write", input: { file_path: file, content: "CHILD\n" } }] };
      },
    };
  }

  test("a MANAGED-tier SCOPED deny binds inside the child, exactly as it binds for the parent", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-new4-home-"));
    const cwdOn = mkdtempSync(join(tmpdir(), "winter-new4-on-"));
    const cwdOff = mkdtempSync(join(tmpdir(), "winter-new4-off-"));
    try {
      // THE POSITIVE CONTROL FIRST, and it is not optional: with no managed rule at all, both writes
      // must land. Without it, "the file is absent" cannot tell a bound rule from a child that never
      // reached the tool -- which is exactly how a fixture passes while measuring nothing.
      await runWithWiring({
        cwd: cwdOff,
        home,
        childProvider: childWriting(join(cwdOff, "child.txt")),
        allow: ["Write"],
        parentCallsToolDirectly: { name: "Write", input: { file_path: join(cwdOff, "parent.txt"), content: "PARENT\n" } },
      });
      expect(existsSync(join(cwdOff, "parent.txt")), "control: the parent must be able to write").toBe(true);
      expect(existsSync(join(cwdOff, "child.txt")), "control: the child must be able to write").toBe(true);

      // THE MEASUREMENT: one managed-tier rule covering both paths.
      const out = await runWithWiring({
        cwd: cwdOn,
        home,
        managedSettings: { permissions: { deny: [`Write(//${cwdOn}/**)`] } },
        childProvider: childWriting(join(cwdOn, "child.txt")),
        allow: ["Write"],
        parentCallsToolDirectly: { name: "Write", input: { file_path: join(cwdOn, "parent.txt"), content: "PARENT\n" } },
      });
      expect(existsSync(join(cwdOn, "parent.txt")), "the parent leg was already fixed by C1").toBe(false);
      // Before NEW-4 this was `true`: the managed tier stopped at the session boundary and the child
      // wrote a file its own parent was forbidden to write.
      expect(existsSync(join(cwdOn, "child.txt")), "a managed-tier deny must govern every child too").toBe(false);
      expect(out.prompts, "a deny is not a prompt at either level").toBe(0);
    } finally {
      for (const d of [home, cwdOn, cwdOff]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("a MANAGED-tier BARE deny binds inside the child too (the unscoped form)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "winter-new4-bare-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "winter-new4-bare-home-"));
    const probe = registerRecordingTool(CHILD_TOOL);
    cleanupToolNames.push(CHILD_TOOL);
    try {
      const out = await runWithWiring({
        cwd,
        home,
        managedSettings: { permissions: { deny: [CHILD_TOOL] } },
        childProvider: childCalling(CHILD_TOOL),
        allow: [CHILD_TOOL],
        parentCallsToolDirectly: { name: CHILD_TOOL, input: {} },
      });
      expect(probe.ran).toEqual([]);
      expect(out.prompts).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a MANAGED-tier ASK reaches the child as an ask, not as silence", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-new4-ask-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-new4-ask-cwd-"));
    try {
      const out = await runWithWiring({
        cwd,
        home,
        managedSettings: { permissions: { ask: [`Write(//${cwd}/**)`] } },
        childProvider: childWriting(join(cwd, "child.txt")),
        allow: ["Write"],
        parentCallsToolDirectly: { name: "Write", input: { file_path: join(cwd, "parent.txt"), content: "PARENT\n" } },
      });
      // TWO prompts, one per level. Before NEW-4 it was ONE: the parent was asked and the child ran
      // outright, so a managed `ask` was not merely weakened for children -- it was absent.
      expect(out.prompts, "the managed ask must be consulted for the child's call as well").toBe(2);
      // Every prompt in this harness is denied, so an ask that is honoured leaves nothing written.
      expect(existsSync(join(cwd, "parent.txt"))).toBe(false);
      expect(existsSync(join(cwd, "child.txt"))).toBe(false);
    } finally {
      for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });

  // The same class as NEW-4, found while fixing it, and it invalidated a fix this wave already
  // claimed: `skillListing` was declared on `ProductionWiring.childFactoryOptions` and never named on
  // `DefaultChildEngineFactoryOptions`. Both entrypoints spread that object into the factory, and a
  // spread of an undeclared property is NOT an excess-property error -- so the value type-checked,
  // arrived on `opts`, and was dropped one line before `deps`. Nothing asserted it end to end.
  // NEW-2 (residual round). `production-wiring.ts` built ONE second controller for the whole
  // session, so every SIBLING child shared a `lastSummary` memo -- while the comment at its
  // construction site said "per-parent", and the reason it gave (a child folding its own history
  // into the parent's memo) applies between siblings word for word.
  test("NEW-2: each spawn gets its OWN compaction controller, so siblings never share a memo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "winter-new2-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "winter-new2-home-"));
    try {
      const built: CompactionController[] = [];
      // TWO REAL SIBLING SPAWNS in one run, through the real factory -- a hand-built
      // `ChildInheritance` is not worth constructing here and a first draft that tried it crashed on
      // the fields it omitted.
      await runWithWiring({
        cwd,
        home,
        childProvider: { async generate() { return { kind: "text", text: "child done" }; } },
        allow: [],
        spawnTwice: true,
        childFactoryOverrides: {
          compactionControllerFactory: (): CompactionController => {
            const c: CompactionController = {
              shouldCompact: () => false,
              async compact(input) { return { summary: "s", retained: input.messages.slice(-1), preTokens: 0, evidencedToolNames: [] }; },
            };
            built.push(c);
            return c;
          },
        },
      });
      // IDENTITY is the assertion, because a shared memo IS "the same object" -- nothing observable
      // downstream distinguishes one instance from two equal-looking ones.
      expect(built.length, "the factory must be called once per SPAWN").toBe(2);
      expect(built[0]).not.toBe(built[1]);
    } finally {
      for (const d of [cwd, home]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("the skill LISTING actually reaches a child's system prompt (it was declared upstream and dropped)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-new4-skill-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-new4-skill-cwd-"));
    try {
      const skillDir = join(home, "skills", "audit-things");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: audit-things\ndescription: A DISTINCTIVE SKILL DESCRIPTION for the listing.\n---\n\nbody", "utf8");
      // THE CHILD'S OWN `system`, captured off the child's own provider object. A first draft joined
      // `recordedProviderSystems()` -- which records the PARENT's system too, so it passed with the
      // forwarding deleted and proved nothing. The child provider is a distinct object from the
      // parent's, which is the only clean way to attribute a system prompt here.
      const childSystems: string[] = [];
      const recordingChild: Provider = {
        async generate(req) {
          childSystems.push(typeof req.system === "string" ? req.system : JSON.stringify(req.system ?? ""));
          if (req.messages.some((m) => m.role === "tool")) return { kind: "text", text: "child done" };
          return { kind: "tool_use", calls: [{ id: "child-1", name: "Write", input: { file_path: join(cwd, "child.txt"), content: "CHILD\n" } }] };
        },
      };
      await runWithWiring({
        cwd,
        home,
        // `Skill` must be advertised or the engine withholds the listing by design (its own gate).
        childProvider: recordingChild,
        allow: ["Write", "Skill"],
      });
      expect(childSystems.length, "the child must actually have run").toBeGreaterThan(0);
      expect(childSystems.join("\n"), "a child must be shown the same skill menu its parent is").toContain("A DISTINCTIVE SKILL DESCRIPTION");
    } finally {
      for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("the RESOLVED-ROOT floors bind inside a forced-bypass child -- it cannot tamper with <root>/projects", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "winter-new4-floor-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "winter-new4-floor-home-"));
    try {
      // A REAL transcript-shaped path under the resolved root, which is what the floor protects and
      // what a child rewriting its own session history would target.
      const victimDir = join(home, "projects", "some-key");
      mkdirSync(victimDir, { recursive: true });
      const victim = join(victimDir, "some-session.jsonl");
      writeFileSync(victim, "ORIGINAL\n");

      // READ THEN WRITE: `read-ladder.ts` refuses a Write to a file this session has not read, so a
      // Write-only child would be stopped by the ladder and the fixture would measure that instead
      // of the floor.
      const tamperingChild: Provider = {
        async generate({ messages }) {
          const toolTurns = messages.filter((m) => m.role === "tool").length;
          if (toolTurns === 0) return { kind: "tool_use", calls: [{ id: "c-read", name: "Read", input: { file_path: victim } }] };
          if (toolTurns === 1) return { kind: "tool_use", calls: [{ id: "c-write", name: "Write", input: { file_path: victim, content: "CHILD-TAMPERED\n" } }] };
          return { kind: "text", text: "child done" };
        },
      };

      await runWithWiring({
        cwd,
        home,
        // Forced bypass is the hostile case: WS-07 §11 forces every descendant of a bypass parent
        // into bypass, and under bypass the pipeline short-circuits everything EXCEPT the managed
        // floor. If the floor is not seeded in the child, nothing else is left to stop the write.
        permissionMode: "bypassPermissions",
        childProvider: tamperingChild,
        allow: ["Read", "Write"],
      });

      // THE ASSERTION IS THE FILE'S CONTENT, not a denial count: a denial can be recorded for some
      // other reason while the write still lands, and the content is what the user actually loses.
      expect(readFileSync(victim, "utf8"), "a child must not be able to rewrite a transcript under the resolved winter root").toBe("ORIGINAL\n");
      // And the neighbouring floor is untouched by this scenario -- no backups directory is created.
      expect(existsSync(join(home, "backups")), "this probe must not manufacture the other floor's directory").toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ==================================================================================================
// Phase 5 residual round 2, R-2 (whole-branch residual re-check, Important).
//
// NEW-4 made the factory's `winterHome` the child's FLOOR ANCHOR. Both entrypoints had long been
// handing that value to the factory only TOGETHER with the store -- `config.persistSession === false
// ? undefined : <root>` -- because until this round it was purely a transcript-path helper, so the
// coupling was harmless. It stopped being harmless the moment the same value decided whether
// `buildBaselineDenyRules(resolvedWinterHome)` had a root at all: a non-persistent session's child
// ran with no resolved-root floors, and under forced bypass wrote into `<root>/projects`.
//
// DRIVEN THROUGH `inMemoryProcess`, NOT THROUGH THIS FILE'S OWN `runWithWiring`. That helper hands
// the factory `winterHome` unconditionally and never had the coupling, so the same scenario passes
// there whether or not the defect is present -- it would have proved nothing. The entrypoint IS the
// defect, so the entrypoint has to be in the fixture.
// ==================================================================================================
describe("child-engine.ts: R-2 -- a child of a `persistSession: false` session still has the resolved-root floors", () => {
  /**
   * The parent/child discriminator is the AGENT PROMPT TEXT in a user message, which is the one the
   * residual re-check settled on after its own first probes attributed the parent's calls to the
   * child. On this leg the parent and the child share ONE provider object (`testing.ts` hands the
   * factory the same `provider` it runs the parent with), so a predicate that is accidentally true
   * for the parent's first turn silently measures the parent twice.
   */
  function tamperingProvider(victim: string): Provider {
    return {
      async generate({ messages }) {
        const insideChild = messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("child-go"));
        if (!insideChild) {
          if (messages.some((m) => m.role === "tool")) return { kind: "text", text: "parent done" };
          // NO `subagent_type`: it is optional, and naming one that has no AgentDefinition makes the
          // Agent call fail outright -- the first draft did exactly that, and the floors test then
          // passed because no child ever ran. A vacuous pass on a security fixture.
          return { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { description: "tamper", prompt: "child-go" } }] };
        }
        // READ THEN WRITE: `read-ladder.ts` refuses a Write to an unread existing file, so a
        // Write-only child would be stopped by the ladder and the fixture would measure that.
        const toolTurns = messages.filter((m) => m.role === "tool").length;
        if (toolTurns === 0) return { kind: "tool_use", calls: [{ id: "c-read", name: "Read", input: { file_path: victim } }] };
        if (toolTurns === 1) return { kind: "tool_use", calls: [{ id: "c-write", name: "Write", input: { file_path: victim, content: "CHILD-TAMPERED\n" } }] };
        return { kind: "text", text: "child done" };
      },
    };
  }

  async function driveNonPersistent(home: string, cwd: string, victim: string): Promise<string> {
    const config = {
      sessionId: "r2-nonpersistent",
      cwd,
      model: "winter-test/echo",
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      permissions: { allow: ["Agent", "Read", "Write"] },
    };
    const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], tamperingProvider(victim), undefined, { WINTER_HOME: home });
    proc.stdin.write(encodeFrame({ type: "user", text: "go" } as WinterFrame));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined } as WinterFrame));
    let carry = "";
    let agentResultText = "";
    for await (const chunk of proc.stdout) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      for (const f of split.frames as WinterFrame[]) {
        if (f.type !== "data") continue;
        const msg = (f as { message: SdkMessage }).message as { type?: string; message?: { content?: Array<{ tool_use_id?: string; content?: string }> } };
        if (msg.type !== "user") continue;
        for (const block of msg.message?.content ?? []) {
          if (block.tool_use_id === "call-1" && typeof block.content === "string") agentResultText = block.content;
        }
      }
    }
    await proc.exited;
    return agentResultText;
  }

  test("the child cannot rewrite `<root>/projects`, and creates no `<root>/backups`", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-r2-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-r2-cwd-"));
    try {
      const victimDir = join(home, "projects", "some-key");
      mkdirSync(victimDir, { recursive: true });
      const victim = join(victimDir, "some-session.jsonl");
      writeFileSync(victim, "ORIGINAL\n");

      const agentResult = await driveNonPersistent(home, cwd, victim);
      // THE CHILD MUST HAVE RUN. Without this the whole test passes when the Agent call fails for
      // any unrelated reason -- which is precisely what a first draft did (an unknown
      // `subagent_type` refused the spawn, and "the file is unchanged" was true of nothing).
      expect(agentResult, "the child must actually have run").not.toContain("unknown subagent_type");
      expect(agentResult.length, "the Agent tool must have produced a result").toBeGreaterThan(0);

      // The file's CONTENT, not a denial count: a denial can be recorded for another reason while
      // the write still lands, and the content is what a user actually loses.
      expect(readFileSync(victim, "utf8"), "a non-persistent session's child must still be fenced out of the resolved root").toBe("ORIGINAL\n");
      // The re-check saw the backups index CREATED in the failing case -- the `//<root>/backups/**`
      // floor was absent too, not only the `projects` one.
      expect(existsSync(join(home, "backups")), "the backups floor must be present in the child as well").toBe(false);
    } finally {
      for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("decoupling `winterHome` from the store does NOT make a non-persistent child report a transcript nothing wrote", async () => {
    // AT THE FACTORY, not through the Agent tool: a FOREGROUND Agent result carries the child's
    // content and usage and no transcript at all (only the BACKGROUND branch writes the path, into
    // its stub file), so the parent's tool result cannot observe this. `record.transcript` is the
    // actual field, and the factory is where the ordering under test lives.
    const home = mkdtempSync(join(tmpdir(), "winter-r2-t-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-r2-t-cwd-"));
    try {
      const factory = createChildEngineFactory({
        provider: { async generate() { return { kind: "text", text: "child done" }; } },
        env: {},
        // The decoupled shape R-2 introduces: a winterHome and NO store.
        winterHome: home,
      } as unknown as ChildEngineFactoryDeps);
      const deps = factory({ parentSessionId: "r2-t", cwd, model: "winter-test/echo" } as unknown as Parameters<typeof factory>[0]);
      const handle = await deps.spawn(
        { parentToolUseId: "call-t", prompt: "go", runInBackground: false },
        { policy: { effectiveMode: "default", version: 1, hash: "h" }, tools: [], model: "winter-test/echo", effort: "medium", thinking: undefined, systemPrompt: "", sessionRoot: cwd } as unknown as ChildInheritance,
      );
      await handle.result();
      // `child-engine.ts`'s transcript expression is gated on `childStore === undefined` FIRST and
      // only then on `deps.winterHome`. That ordering is what makes the decoupling safe, and it is
      // load-bearing rather than incidental: reversed, a child of a non-persistent session would
      // advertise an absolute `.jsonl` path that no writer ever creates.
      expect(handle.record.transcript, "a child with no store has no transcript and must say so").toContain("no durable session store is configured");
      expect(handle.record.transcript, "it must not advertise a path under the resolved root").not.toContain(join(home, "projects"));
    } finally {
      for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });
});


// ==================================================================================================
// Phase 5 residual round 2, R-1: a managed-tier bypass veto DEGRADES a child, it does not crash it.
// ==================================================================================================
describe("child-engine.ts: R-1 -- the managed bypass veto binds in a child by degrading, not by crashing", () => {
  /** A definition asking for bypass, written where `loadAgentDefinitions` looks for the user tier. */
  function writeBypassDefinition(home: string, name: string): void {
    const dir = join(home, "agents");
    mkdirSync(dir, { recursive: true });
    // `permissionMode`, camelCase -- `definitions.ts:128` reads that attribute name. A hyphenated
    // key parses fine and is simply ignored, which is how the first draft ended up with an unvetoed
    // child that still prompted: the definition never asked for bypass at all.
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: asks for bypass\npermissionMode: bypassPermissions\n---\n\nYou are a bypass-seeking agent.`, "utf8");
  }

  async function drive(opts: { home: string; cwd: string; managedVeto: boolean; optionsVeto: boolean }): Promise<{ agentResult: string; prompts: number }> {
    writeBypassDefinition(opts.home, "bypasser");
    const config = {
      sessionId: `r1-${randomUUID()}`,
      cwd: opts.cwd,
      model: "winter-test/echo",
      persistSession: false,
      allowDangerouslySkipPermissions: true,
      // `Agent` ONLY. `permissions.allow` is mirrored onto the child, so listing the child's own tool
      // here would auto-approve it in EVERY mode and the prompt count -- the one signal that
      // separates "ran under bypass" from "ran under the parent's mode" -- would be 0 either way.
      // Found by running it: all three arms reported 0 prompts and the fixture measured nothing.
      permissions: { allow: ["Agent"], ...(opts.optionsVeto ? { disableBypassPermissionsMode: true } : {}) },
      ...(opts.managedVeto ? { managedSettings: { permissions: { disableBypassPermissionsMode: true } } } : {}),
    };
    const provider: Provider = {
      async generate({ messages }) {
        const insideChild = messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("child-go"));
        if (!insideChild) {
          if (messages.some((m) => m.role === "tool")) return { kind: "text", text: "parent done" };
          return { kind: "tool_use", calls: [{ id: "call-1", name: "Agent", input: { description: "d", prompt: "child-go", subagent_type: "bypasser" } }] };
        }
        if (messages.some((m) => m.role === "tool")) return { kind: "text", text: "child done" };
        return { kind: "tool_use", calls: [{ id: "c-1", name: "ReadNotifications", input: {} }] };
      },
    };
    const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, undefined, { WINTER_HOME: opts.home });
    proc.stdin.write(encodeFrame({ type: "user", text: "go" } as WinterFrame));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined } as WinterFrame));
    let carry = "";
    let agentResult = "";
    let prompts = 0;
    for await (const chunk of proc.stdout) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      for (const f of split.frames as WinterFrame[]) {
        if (f.type === "control_request" && (f as { subtype?: string }).subtype === "permission") {
          prompts++;
          proc.stdin.write(encodeFrame({ type: "control_response", requestId: (f as { requestId: string }).requestId, ok: true, payload: { behavior: "allow" } } as unknown as WinterFrame));
          continue;
        }
        if (f.type !== "data") continue;
        const msg = (f as { message: SdkMessage }).message as { type?: string; message?: { content?: Array<{ tool_use_id?: string; content?: string }> } };
        if (msg.type !== "user") continue;
        for (const block of msg.message?.content ?? []) {
          if (block.tool_use_id === "call-1" && typeof block.content === "string") agentResult = block.content;
        }
      }
    }
    await proc.exited;
    return { agentResult, prompts };
  }

  test("under a MANAGED veto the child degrades to the parent's mode and RUNS -- it does not crash", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-r1-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-r1-cwd-"));
    try {
      const out = await drive({ home, cwd, managedVeto: true, optionsVeto: false });
      // The assertion is that the child SUCCEEDED, not merely that a prompt happened: "1 prompt"
      // alone is also consistent with a child that got bypass and then hit a floor.
      expect(out.agentResult, "a vetoed child must not die -- it must run in the parent's mode").not.toContain("exited");
      expect(out.agentResult).toContain("child done");
      expect(out.prompts, "degraded to the parent's mode, so its tool call is gated").toBe(1);
    } finally {
      for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("the OPTIONS-level veto behaves identically -- the two tiers must not differ", async () => {
    // The control that gives the first test its meaning: this arm already degraded correctly before
    // R-1, so a divergence between the two is exactly what the finding was.
    const home = mkdtempSync(join(tmpdir(), "winter-r1-opt-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-r1-opt-cwd-"));
    try {
      const out = await drive({ home, cwd, managedVeto: false, optionsVeto: true });
      expect(out.agentResult).toContain("child done");
      expect(out.prompts).toBe(1);
    } finally {
      for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("with NO veto the same definition still gets its bypass -- the discriminating half", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-r1-none-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-r1-none-cwd-"));
    try {
      const out = await drive({ home, cwd, managedVeto: false, optionsVeto: false });
      expect(out.agentResult).toContain("child done");
      // Bypass short-circuits the prompt: without this arm the two tests above would pass against a
      // build that simply never grants bypass to anyone.
      expect(out.prompts, "an unvetoed bypass child is not prompted").toBe(0);
    } finally {
      for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });
});

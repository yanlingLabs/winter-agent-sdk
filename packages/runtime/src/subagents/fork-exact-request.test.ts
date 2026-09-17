// SDK 0.0.16 (P16-7, R3a §2): engine-level proof that a FORK sends the parent's exact request
// layout -- system prompt/blocks, tool specs, userContext -- verbatim, never a second render, and
// that its `permissionMode: "bubble"` really does bubble an approval prompt up to the real host.
// Lane F's own files: `subagents/fork.ts`, `subagents/child-engine.ts`'s fork branch,
// `engine.ts`'s `buildChildInheritance` fork path + the `exactRequestLayout` bypass, and
// `permissions/policy-state.ts`'s `BUBBLE_PERMISSION_MODE`. `fork.test.ts` unit-proves
// `buildForkInitialMessages`/`buildForkDirectiveText` in isolation; this file proves the WIRING --
// real two-level `runEngine` (parent + a REAL `createChildEngineFactory`-registered child), the same
// "never a fake ChildHandle" discipline `child-engine.test.ts` already established.
import { describe, test, expect, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WinterFrame, RuntimeConfig, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { runEngine, type Provider, type ProviderMessage, type ProviderToolSpec } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { registerTool, unregisterToolForTest, type ToolExecutionContext } from "../tools/registry.ts";
import { scriptedProvider } from "../provider/mock.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type SpawnChildRequest } from "./child-handle.ts";
import { createChildEngineFactory, type ChildEngineFactoryDeps } from "./child-engine.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";
import type { SystemPromptAssembler, SystemPromptInput, AssembledPrompt } from "../context/seam.ts";
import type { ContextEntry } from "../context/request-layout.ts";
import { BUBBLE_PERMISSION_MODE } from "../permissions/policy-state.ts";

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}
function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId: `fork-exact-${randomUUID()}`,
  cwd: "/tmp/winter-lane-f-fork-exact",
  model: "winter-test/echo",
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  ...overrides,
});

// Same fixture shape `child-engine.test.ts`'s own SPAWN_PROBE uses -- spawns via
// `ctx.session.spawnChild(input)` directly with `input` AS the `SpawnChildRequest`, bypassing
// `tools/impl/agent.ts`'s own name-resolution/gating layer entirely (a different lane's file; this
// suite tests only what `buildChildInheritance`/`child-engine.ts`'s fork branch do with a REQUEST
// that already carries `fork: true`).
const SPAWN_PROBE = "t_lane_f_spawn_probe";
function registerSpawnProbe(): void {
  registerTool({
    descriptor: {
      canonicalName: SPAWN_PROBE, advertisedName: SPAWN_PROBE, source: "builtin", inputSchema: { type: "object" },
      description: "spawns a child (test fixture), awaits result()", exposure: "eager", permissionClass: "read",
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

// A deterministic, trackable `SystemPromptAssembler` -- proves BOTH that a fork's own request
// carries the parent's exact bytes AND that the assembler is never re-invoked to produce them.
function trackingAssembler(system: string, userContext: ContextEntry[]): { assembler: SystemPromptAssembler; assembleCallCount: () => number; userContextCallCount: () => number } {
  let assembleCalls = 0;
  let userContextCalls = 0;
  const assembler: SystemPromptAssembler = {
    assemble(_input: SystemPromptInput): AssembledPrompt {
      assembleCalls++;
      return { system, systemParts: { staticParts: [system], dynamicParts: [], hasBoundary: false } };
    },
    userContext(_input: SystemPromptInput): ContextEntry[] {
      userContextCalls++;
      return [...userContext];
    },
  };
  return { assembler, assembleCallCount: () => assembleCalls, userContextCallCount: () => userContextCalls };
}

interface CapturedChildRequest {
  system?: string;
  systemBlocks?: unknown;
  tools?: ProviderToolSpec[];
  messages: ProviderMessage[];
}

/** Wraps any `Provider` and records every request it receives, verbatim, before delegating. */
function capturingProvider(sink: CapturedChildRequest[], inner: Provider): Provider {
  return {
    async generate(req) {
      const systemBlocks = (req as unknown as { systemBlocks?: unknown }).systemBlocks;
      sink.push({
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(systemBlocks !== undefined ? { systemBlocks } : {}),
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        messages: req.messages as ProviderMessage[],
      });
      return inner.generate(req);
    },
  };
}

/** The CHILD's own provider -- records every request it receives and answers with plain text. */
function capturingChildProvider(sink: CapturedChildRequest[]): Provider {
  return capturingProvider(sink, { async generate() { return { kind: "text", text: "fork child done" }; } });
}

afterEach(() => {
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
  unregisterToolForTest(SPAWN_PROBE);
});

describe("SDK 0.0.16 (P16-7): a fork's request is the parent's own captured layout, verbatim", () => {
  test("child's system/tools/index-0 userContext message byte-match the parent's own last request; the assembler is never re-invoked for the child", async () => {
    registerSpawnProbe();
    const parentRequests: CapturedChildRequest[] = [];
    const childRequests: CapturedChildRequest[] = [];
    const { assembler, assembleCallCount, userContextCallCount } = trackingAssembler("PARENT SYSTEM PROMPT MARKER", [["claudeMd", "PARENT PROJECT RULES MARKER"]]);
    registerChildEngineFactory(createChildEngineFactory({ provider: capturingChildProvider(childRequests) } as ChildEngineFactoryDeps));

    const config = baseConfig();
    const { host, runtime } = createInMemoryChannel();
    const scripted = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "spawn-fork-1", name: SPAWN_PROBE, input: { parentToolUseId: "spawn-fork-1", prompt: "investigate", runInBackground: true, fork: true } }] },
      { kind: "text", text: "parent: fork kicked off" },
    ]);
    const parentProvider = capturingProvider(parentRequests, scripted);
    const donePromise = runEngine({ config, input: runtime.input, output: runtime.output, provider: parentProvider, systemPromptAssembler: assembler });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    const code = await donePromise;
    expect(code).toBe(0);

    // Sanity: the parent's own tool call succeeded (no error text on its tool_result).
    const msgs = dataMessages(frames);
    const toolResultMsg = msgs.find((m) => m.type === "user") as unknown as { message?: { content?: Array<{ tool_use_id: string; content: string; error?: boolean }> } } | undefined;
    const block = toolResultMsg?.message?.content?.find((b) => b.tool_use_id === "spawn-fork-1");
    expect(block?.error).not.toBe(true);

    // The PARENT's own FIRST request (the one that produced the Agent(fork) tool_use, and whose
    // layout `recordSessionRequestLayout` captured for the fork to inherit) -- a second, later
    // parent request follows once the spawn's own tool_result comes back, irrelevant here.
    expect(parentRequests.length).toBeGreaterThanOrEqual(1);
    const parentReq = parentRequests[0]!;
    expect(parentReq.system).toContain("PARENT SYSTEM PROMPT MARKER");

    // The CHILD's own first (and only) request -- byte-identical system/tools to the PARENT's own.
    expect(childRequests.length).toBe(1);
    const childReq = childRequests[0]!;
    expect(childReq.system).toBe(parentReq.system);
    expect(JSON.stringify(childReq.tools ?? [])).toBe(JSON.stringify(parentReq.tools ?? []));

    // The child's own index-0 message carries the SAME rendered userContext text the parent's own
    // request did (byte-identical, since it is rendered from the SAME captured entries).
    expect(JSON.stringify(childReq.messages[0])).toEqual(JSON.stringify(parentReq.messages[0]));
    expect(JSON.stringify(childReq.messages[0])).toContain("PARENT PROJECT RULES MARKER");

    // The assembler was invoked ONLY for the parent's own single turn -- never for the fork child
    // (`assemblePrompt`'s own exact-mode short-circuit never calls it at all).
    expect(assembleCallCount()).toBe(1);
    expect(userContextCallCount()).toBe(1);
  });

  test("fork's own history: [parent's history minus the unanswered assistant message] + [clone: only this fork's own tool_use] + [tool_result(placeholder) + directive, merged into one message]", async () => {
    registerSpawnProbe();
    const childRequests: CapturedChildRequest[] = [];
    const { assembler } = trackingAssembler("sys", []);
    registerChildEngineFactory(createChildEngineFactory({ provider: capturingChildProvider(childRequests) } as ChildEngineFactoryDeps));

    const config = baseConfig();
    const { host, runtime } = createInMemoryChannel();
    const parentProvider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "spawn-fork-2", name: SPAWN_PROBE, input: { parentToolUseId: "spawn-fork-2", prompt: "MY OWN DIRECTIVE MARKER", runInBackground: true, fork: true } }] },
      { kind: "text", text: "parent: done" },
    ]);
    const donePromise = runEngine({ config, input: runtime.input, output: runtime.output, provider: parentProvider, systemPromptAssembler: assembler });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await donePromise;

    expect(childRequests.length).toBe(1);
    const messages = childRequests[0]!.messages;
    // index 0: the merged [userContext + "please fork..." prompt] (no userContext entries here, so
    // it collapses to the bare prompt text) -- the ORIGINAL user turn, untouched.
    expect(JSON.stringify(messages[0]?.content)).toContain("go");

    // The clone: an assistant message carrying exactly one tool_use block, THIS fork's own id.
    const clone = messages[1]!;
    expect(clone.role).toBe("assistant");
    const cloneBlocks = clone.content as Array<{ type: string; id?: string }>;
    expect(cloneBlocks).toHaveLength(1);
    expect(cloneBlocks[0]?.type).toBe("tool_use");
    expect(cloneBlocks[0]?.id).toBe("spawn-fork-2");

    // The tail: ONE message carrying the placeholder tool_result AND the directive text (merged).
    const tail = messages[2]!;
    const tailBlocks = tail.content as Array<{ type: string; tool_use_id?: string; content?: unknown; text?: string }>;
    const placeholder = tailBlocks.find((b) => b.type === "tool_result");
    const directive = tailBlocks.find((b) => b.type === "text");
    expect(placeholder?.tool_use_id).toBe("spawn-fork-2");
    expect(placeholder?.content).toBe("Fork started — processing in background");
    expect(directive?.text?.endsWith("Your directive: MY OWN DIRECTIVE MARKER")).toBe(true);
    expect(messages.length).toBe(3);
  });

  test("permissionMode 'bubble': the fork keeps the parent's LIVE mode, and its own approval prompt reaches the real host stream", async () => {
    registerSpawnProbe();
    // A tool the CHILD's own scripted provider calls that has no baseline allow rule -- it must ask.
    const APPROVAL_GATED = "t_lane_f_needs_approval";
    registerTool({
      descriptor: {
        canonicalName: APPROVAL_GATED, advertisedName: APPROVAL_GATED, source: "builtin", inputSchema: { type: "object" },
        description: "requires an explicit approval under a prompting mode", exposure: "eager", permissionClass: "edit",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: { async execute() { return { output: "approved and ran" }; } },
    });
    try {
      const childProvider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "needs-1", name: APPROVAL_GATED, input: {} }] },
        { kind: "text", text: "child: done after approval" },
      ]);
      registerChildEngineFactory(createChildEngineFactory({ provider: childProvider } as ChildEngineFactoryDeps));

      // The PARENT itself runs in `default` (a real prompting mode, NOT bypass) -- `permissionMode:
      // "bubble"` on the fork's own definition is irrelevant here (this fixture spawns via
      // SPAWN_PROBE with a bare `fork:true` request, no `definition`), so this proves the SAME
      // underlying mechanism "bubble" is documented as an alias for: a child with no permissionMode
      // override keeps the parent's live mode (here, `default`) and its own approval prompt is
      // forwarded to the real host -- exactly what a `permissionMode:"bubble"` fork would also do
      // (fork.ts's own history-building has no permissionMode concept; that resolution lives entirely
      // in `engine.ts`'s `buildChildInheritance`, proven directly in the next test).
      // The OUTER spawn call needs its own allow rule under `default` mode (permissionClass:"read"
      // alone does not bypass evaluation -- child-engine.test.ts's own established precedent, header
      // comment above test "RULING P4-I"), so only the CHILD's own inner call is left genuinely
      // unresolved and reaches a real "permission" control_request.
      const config = baseConfig({ permissionMode: "default", allowDangerouslySkipPermissions: false, permissions: { allow: [SPAWN_PROBE] } });
      const { host, runtime } = createInMemoryChannel();
      const parentProvider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "spawn-fork-3", name: SPAWN_PROBE, input: { parentToolUseId: "spawn-fork-3", prompt: "go", runInBackground: false, fork: true } }] },
        { kind: "text", text: "parent: fork finished" },
      ]);
      const donePromise = runEngine({ config, input: runtime.input, output: runtime.output, provider: parentProvider });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });

      const frames: WinterFrame[] = [];
      let answered = false;
      const reading = (async () => {
        for await (const frame of host.input) {
          frames.push(frame);
          if (frame.type !== "control_request") continue;
          const cr = frame as Extract<WinterFrame, { type: "control_request" }>;
          if (cr.subtype !== "permission") continue;
          const payload = cr.payload as { toolName?: string } | undefined;
          if (payload?.toolName !== APPROVAL_GATED) continue;
          answered = true;
          host.output.write({ type: "control_response", requestId: cr.requestId, ok: true, payload: { behavior: "allow" } });
        }
      })();
      await reading;
      const code = await donePromise;
      expect(code).toBe(0);

      // The approval prompt genuinely reached the REAL HOST stream (this test's own read loop, one
      // level above the child) -- proving the child's own permission decision bubbled up rather than
      // being resolved silently inside the child's own (never-attached) process.
      expect(answered).toBe(true);
      const permissionFrame = frames.find((f) => f.type === "control_request" && (f as Extract<WinterFrame, { type: "control_request" }>).subtype === "permission");
      expect(permissionFrame).toBeDefined();
    } finally {
      unregisterToolForTest(APPROVAL_GATED);
    }
  });

  test("permissionMode 'bubble' on the definition resolves through buildChildInheritance to the PARENT's live mode -- never a crash, never a fixed mode of its own", async () => {
    registerSpawnProbe();
    const childRequests: CapturedChildRequest[] = [];
    registerChildEngineFactory(createChildEngineFactory({ provider: capturingChildProvider(childRequests) } as ChildEngineFactoryDeps));

    const config = baseConfig({ permissionMode: "plan", permissions: { allow: [SPAWN_PROBE] } }); // an unusual, distinctive live parent mode
    const { host, runtime } = createInMemoryChannel();
    const parentProvider = scriptedProvider([
      {
        kind: "tool_use",
        calls: [
          {
            id: "spawn-fork-4",
            name: SPAWN_PROBE,
            input: { parentToolUseId: "spawn-fork-4", prompt: "go", runInBackground: true, fork: true, definition: { description: "fork", prompt: "unused", permissionMode: BUBBLE_PERMISSION_MODE } },
          },
        ],
      },
      { kind: "text", text: "parent: done" },
    ]);
    const donePromise = runEngine({ config, input: runtime.input, output: runtime.output, provider: parentProvider });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    const code = await donePromise;
    expect(code).toBe(0);

    const msgs = dataMessages(frames);
    const toolResultMsg = msgs.find((m) => m.type === "user") as unknown as { message?: { content?: Array<{ tool_use_id: string; content: string; error?: boolean }> } } | undefined;
    const block = toolResultMsg?.message?.content?.find((b) => b.tool_use_id === "spawn-fork-4");
    // A crash/refusal would show up here as an error tool_result -- "bubble" must never be treated as
    // an UNKNOWN mode requiring a typed refusal.
    expect(block?.error).not.toBe(true);
    const parsed = JSON.parse(block!.content) as { record: { permission: { effectiveMode: string } } };
    expect(parsed.record.permission.effectiveMode).toBe("plan"); // the PARENT's own live mode, not a fixed "bubble" value
  });
});

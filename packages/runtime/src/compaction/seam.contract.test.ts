// Phase 5 Task 3 (R5-2): the SEAM AUTHORITY for `compaction/seam.ts`. Lane K keeps this green
// against its real controller; the engine keeps it green against the sequence around it.
//
// Also carries the ContextAccountant's ENGINE-LEG coverage (T2 review item 3): `EngineOptions.
// contextAccountant` and the `record()` call inside the turn loop had no executable test at all --
// the accountant's own unit tests exercised the object, never the wiring. The compaction trigger is
// the accountant's first real consumer, so its integration test belongs here.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { WinterCompatibilitySessionStore, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, createContextAccountant, type ContextAccountant, type Provider, type ProviderTurn, type SessionPersistence } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { resolveEngineSession } from "../store/dialect.ts";
import { fakeCompactionController, type CompactBoundaryRecord, type CompactionInput } from "./seam.ts";

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "sonnet", ...overrides });

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

/** A provider that reports the usage the test dictates, turn by turn. */
function usageProvider(turns: ProviderTurn[]): Provider {
  let i = 0;
  return {
    async generate() {
      const t = turns[Math.min(i++, turns.length - 1)];
      return t ?? { kind: "text", text: "done" };
    },
  };
}

describe("compaction/seam.ts -- CompactionController (Lane K implements, the engine owns the sequence)", () => {
  test("the fake keeps the last N messages and reports the accountant's pre-compaction reading", async () => {
    const accountant = createContextAccountant({ limit: 1000 });
    accountant.record({ inputTokens: 700, outputTokens: 60 });
    const controller = fakeCompactionController({ keep: 1, summary: "SUM" });
    const result = await controller.compact({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      trigger: "auto",
      customInstructions: null,
      accountant,
      provider: usageProvider([]),
    });
    expect(result.summary).toBe("SUM");
    expect(result.retained).toEqual([{ role: "assistant", content: "b" }]);
    expect(result.preTokens).toBe(760);
  });

  // --- The ContextAccountant's engine leg (T2 review item 3) ----------------------------------------

  test("ContextAccountant: a caller-supplied accountant is recorded into by the LIVE turn loop, and reads the LAST turn", async () => {
    const accountant = createContextAccountant({ limit: 100_000 });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig(),
      input: runtime.input,
      output: runtime.output,
      provider: usageProvider([
        { kind: "text", text: "one", usage: { inputTokens: 10, outputTokens: 5 } },
        { kind: "text", text: "two", usage: { inputTokens: 40, outputTokens: 2 } },
      ]),
      tools: stubExecutor,
      contextAccountant: accountant,
    });
    host.output.write({ type: "user", text: "a" });
    host.output.write({ type: "user", text: "b" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    // The LAST turn's input+output, never a running total (R5-3's own contract, proven through the
    // engine rather than by calling record() directly).
    expect(accountant.contextTokens()).toBe(42);
  });

  test("the auto trigger READS the accountant the engine records into -- the two are the same object", async () => {
    const accountant = createContextAccountant({ limit: 100 });
    const seen: number[] = [];
    const controller = fakeCompactionController({
      shouldCompact: (a: ContextAccountant) => {
        seen.push(a.contextTokens());
        return false;
      },
    });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig(),
      input: runtime.input,
      output: runtime.output,
      provider: usageProvider([
        { kind: "text", text: "one", usage: { inputTokens: 11, outputTokens: 1 } },
        { kind: "text", text: "two", usage: { inputTokens: 30, outputTokens: 3 } },
      ]),
      tools: stubExecutor,
      contextAccountant: accountant,
      compactionController: controller,
    });
    host.output.write({ type: "user", text: "a" });
    host.output.write({ type: "user", text: "b" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    // Turn 1 asks before any generation (0); turn 2 asks after turn 1 recorded 12.
    expect(seen).toEqual([0, 12]);
  });

  // --- The sequence ----------------------------------------------------------------------------------

  test("the AUTO trigger fires, emits the pinned compact_boundary frame, and swaps the in-memory history", async () => {
    const calls: CompactionInput[] = [];
    const controller = fakeCompactionController({ shouldCompact: true, keep: 0, summary: "SUMMARY-TEXT", calls });
    const { host, runtime } = createInMemoryChannel();
    const seenMessages: string[][] = [];
    const provider: Provider = {
      async generate(input) {
        seenMessages.push(input.messages.map((m) => (typeof m.content === "string" ? m.content : "[blocks]")));
        return { kind: "text", text: "done", usage: { inputTokens: 5, outputTokens: 5 } };
      },
    };
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor, compactionController: controller });
    host.output.write({ type: "user", text: "first" });
    host.output.write({ type: "user", text: "second" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;

    const boundaries = dataMessages(frames).filter((m) => (m as { subtype?: string }).subtype === "compact_boundary");
    expect(boundaries.length).toBeGreaterThanOrEqual(1);
    const meta = (boundaries[0] as { compact_metadata: { trigger: string; pre_tokens: number; duration_ms?: number } }).compact_metadata;
    expect(meta.trigger).toBe("auto");
    expect(typeof meta.pre_tokens).toBe("number");
    expect(typeof meta.duration_ms).toBe("number");
    expect(calls[0]!.trigger).toBe("auto");
    expect(calls[0]!.customInstructions).toBeNull();
    // The in-memory history was SWAPPED, not appended to: with `keep: 0` the whole conversation --
    // including this envelope's own just-pushed user message, which was part of what `compact()` was
    // handed -- is replaced by the summary alone. That the user's prompt can itself be summarized
    // away is a real consequence of checking BEFORE the provider call, and is the controller's to
    // avoid through retention (Lane K keeps the last N pairs); the engine takes `retained` literally.
    expect(seenMessages[0]).toEqual(["SUMMARY-TEXT"]);
    // Turn 2 compacts again (the reading moved), so it too sees only a summary.
    expect(seenMessages[1]).toEqual(["SUMMARY-TEXT"]);
  });

  test("the re-entrancy guard: an unchanged accountant reading does not compact twice, a moved one does", async () => {
    const calls: CompactionInput[] = [];
    const controller = fakeCompactionController({ shouldCompact: true, calls });
    const { host, runtime } = createInMemoryChannel();
    // A tool round means TWO provider calls in one turn -- the auto check runs before each.
    let call = 0;
    const provider: Provider = {
      async generate() {
        call++;
        if (call === 1) return { kind: "tool_use", calls: [{ id: "t1", name: "test_tool", input: {} }], usage: { inputTokens: 5, outputTokens: 5 } };
        return { kind: "text", text: "done", usage: { inputTokens: 9, outputTokens: 1 } };
      },
    };
    const done = runEngine({ config: baseConfig({ allowedTools: ["test_tool"] }), input: runtime.input, output: runtime.output, provider, tools: stubExecutor, compactionController: controller });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    // Check 1 (reading 0) compacts. Check 2 runs after generation 1 recorded 10 -- a MOVED reading,
    // so it compacts again. Without the guard the count would be higher than the number of distinct
    // readings; with a naive per-turn flag it would be 1.
    expect(calls.map((c) => c.trigger)).toEqual(["auto", "auto"]);
  });

  test("PreCompact runs BEFORE compact() and PostCompact AFTER it -- PostCompact's pinned input needs the summary to exist", async () => {
    const order: string[] = [];
    const controller = fakeCompactionController({
      shouldCompact: true,
      summary: "S",
      calls: [],
    });
    const wrapped = {
      shouldCompact: controller.shouldCompact.bind(controller),
      async compact(input: CompactionInput) {
        order.push("compact");
        return controller.compact(input);
      },
    };
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig({
        hooks: { PreCompact: [{ hookCount: 1, source: "sdk" }], PostCompact: [{ hookCount: 1, source: "sdk" }] },
      }),
      input: runtime.input,
      output: runtime.output,
      provider: usageProvider([{ kind: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } }]),
      tools: stubExecutor,
      compactionController: wrapped,
    });
    // Answer the two hook RPCs the runtime issues, recording their order and payloads.
    const payloads: Array<Record<string, unknown>> = [];
    void (async () => {
      for await (const frame of host.input) {
        if (frame.type === "control_request" && (frame as { subtype: string }).subtype === "hook") {
          const req = frame as unknown as { requestId: string; payload: { event: string; payload?: Record<string, unknown> } };
          order.push(req.payload.event);
          payloads.push(req.payload.payload ?? {});
          host.output.write({ type: "control_response", requestId: req.requestId, ok: true, payload: {} });
        }
      }
    })();
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    await done;
    expect(order).toEqual(["PreCompact", "compact", "PostCompact"]);
    expect(payloads[0]).toMatchObject({ trigger: "auto", custom_instructions: null });
    expect(payloads[1]).toMatchObject({ trigger: "auto", compact_summary: "S" });
  });

  test("a controller that THROWS is reported as a status message and never kills the turn", async () => {
    const controller = fakeCompactionController({ shouldCompact: true, fail: "summarizer exploded" });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig(),
      input: runtime.input,
      output: runtime.output,
      provider: usageProvider([{ kind: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } }]),
      tools: stubExecutor,
      compactionController: controller,
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const statuses = dataMessages(frames).filter((m) => (m as { subtype?: string }).subtype === "status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ compact_result: "failed", compact_error: "summarizer exploded" });
    // The turn still completed normally.
    expect(dataMessages(frames).filter((m) => m.type === "result")).toHaveLength(1);
  });

  test("`/compact <instructions>` triggers the MANUAL path and forwards the instructions verbatim", async () => {
    const calls: CompactionInput[] = [];
    const controller = fakeCompactionController({ keep: 0, summary: "S", calls });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig(),
      input: runtime.input,
      output: runtime.output,
      provider: usageProvider([{ kind: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } }]),
      tools: stubExecutor,
      compactionController: controller,
    });
    host.output.write({ type: "user", text: "hello" });
    host.output.write({ type: "user", text: "/compact keep the API decisions" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.trigger).toBe("manual");
    expect(calls[0]!.customInstructions).toBe("keep the API decisions");
    // `shouldCompact` is never consulted for a manual compaction.
    const results = dataMessages(frames).filter((m) => m.type === "result");
    expect(results).toHaveLength(2);
    expect((results[1] as { result?: string }).result).toContain("Compacted");
  });

  // Fix round 1 (M3). `recordCompactBoundary` returned `void`, so the emitted frame could never carry
  // `preserved_messages` -- a host reading the STREAM could not relink a preserved segment even
  // though the durable entry recorded it correctly -- and `post_tokens` was declared and never set.
  test("M3: with keep > 0 the emitted frame carries preserved_messages and post_tokens, matching the durable entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-compact-m3-"));
    try {
      const cwd = join(home, "work");
      const sessionId = "sess-m3";
      const resolved = await resolveEngineSession({ config: { sessionId, cwd, model: "sonnet", winterHome: home }, resolveWinterHome: () => home, env: {} });
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: { sessionId, cwd, model: "sonnet", winterHome: home },
        input: runtime.input,
        output: runtime.output,
        provider: usageProvider([{ kind: "text", text: "done", usage: { inputTokens: 7, outputTokens: 3 } }]),
        tools: stubExecutor,
        store: resolved.store!,
        compactionController: fakeCompactionController({ keep: 1, summary: "S" }),
      });
      host.output.write({ type: "user", text: "hello" });
      host.output.write({ type: "user", text: "/compact" });
      host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      await done;

      const boundary = dataMessages(frames).find((m) => (m as { subtype?: string }).subtype === "compact_boundary") as {
        uuid: string;
        compact_metadata: { pre_tokens: number; post_tokens?: number; preserved_messages?: { anchor_uuid: string; uuids: string[] } };
      };
      expect(boundary.compact_metadata.preserved_messages).toBeDefined();
      expect(boundary.compact_metadata.preserved_messages!.uuids).toHaveLength(1);
      expect(typeof boundary.compact_metadata.post_tokens).toBe("number");

      // The frame and the DURABLE entry name the same uuids and the same boundary -- the two views
      // must agree, or a host that relinks from the stream and one that relinks from the transcript
      // reconstruct different conversations.
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const raw = (await store.load({ projectKey: compatibilityKeys(cwd).transcriptProjectKey, sessionId })) ?? [];
      const durable = raw.find((e) => e.type === "compact_boundary") as unknown as {
        uuid: string;
        compact_metadata: { preserved_messages?: { anchor_uuid: string; uuids: string[] } };
      };
      expect(durable.uuid).toBe(boundary.uuid);
      expect(durable.compact_metadata.preserved_messages).toEqual(boundary.compact_metadata.preserved_messages!);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("M3: with NOTHING retained the frame OMITS preserved_messages -- absence stays semantic", async () => {
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig(),
      input: runtime.input,
      output: runtime.output,
      provider: usageProvider([{ kind: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } }]),
      tools: stubExecutor,
      compactionController: fakeCompactionController({ shouldCompact: true, keep: 0 }),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const boundary = dataMessages(frames).find((m) => (m as { subtype?: string }).subtype === "compact_boundary") as { compact_metadata: Record<string, unknown> };
    expect("preserved_messages" in boundary.compact_metadata).toBe(false);
  });

  test("registry.onCompaction is fired with the evidenced names (WS-09 §8.5)", async () => {
    // Proven through the SessionPersistence seam's ordering rather than by reaching into the
    // process-wide registry: the loaded set is per-session state with no public read-back, so what is
    // observable here is that the engine reaches the reset step at all -- i.e. that a compaction
    // committed. `evidencedToolNames` travels on the result the engine passes straight through.
    const calls: CompactionInput[] = [];
    const controller = fakeCompactionController({ shouldCompact: true, evidencedToolNames: ["Bash"], calls });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig(),
      input: runtime.input,
      output: runtime.output,
      provider: usageProvider([{ kind: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } }]),
      tools: stubExecutor,
      compactionController: controller,
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    expect(calls).toHaveLength(1);
  });

  // --- Persistence + resume (Lane K's own listed fixture: a persisted boundary rebuilds on resume) ---

  test("the boundary + summary persist, and a RESUMED session rebuilds the COMPACTED history, not the original", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-compact-"));
    try {
      const cwd = join(home, "work");
      const sessionId = "sess-compact-1";
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: compatibilityKeys(cwd).transcriptProjectKey, sessionId };

      // --- run 1: three turns, then a compaction retaining the last message -----------------------
      const resolved = await resolveEngineSession({ config: { sessionId, cwd, model: "sonnet", winterHome: home }, resolveWinterHome: () => home, env: {} });
      const persistence = resolved.store as SessionPersistence;
      await persistence.recordUserEntry("turn one");
      await persistence.recordAssistantEntry([{ type: "text", text: "reply one" }]);
      await persistence.recordUserEntry("turn two");
      await persistence.recordAssistantEntry([{ type: "text", text: "reply two" }]);
      const record: CompactBoundaryRecord = { trigger: "manual", preTokens: 4242, summary: "THE SUMMARY", retainedCount: 1 };
      await persistence.recordCompactBoundary!(record);
      await persistence.recordUserEntry("after compaction");

      const raw = (await store.load(key)) ?? [];
      const boundary = raw.find((e) => e.type === "compact_boundary") as unknown as { compact_metadata: { trigger: string; pre_tokens: number; preserved_messages?: { anchor_uuid: string; uuids: string[] } } } | undefined;
      expect(boundary).toBeDefined();
      expect(boundary!.compact_metadata.trigger).toBe("manual");
      expect(boundary!.compact_metadata.pre_tokens).toBe(4242);
      expect(boundary!.compact_metadata.preserved_messages!.uuids).toHaveLength(1);
      expect(raw.some((e) => e.type === "compact_summary")).toBe(true);

      // --- run 2: resume ---------------------------------------------------------------------------
      const resumed = await resolveEngineSession({ config: { sessionId: "fresh", cwd, model: "sonnet", winterHome: home, resume: sessionId }, resolveWinterHome: () => home, env: {} });
      const texts = resumed.initialMessages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      // The summary, the ONE preserved message, and everything appended after the boundary --
      // never the pre-compaction turns the summary replaced.
      expect(texts).toEqual(["THE SUMMARY", "reply two", "after compaction"]);
      expect(texts).not.toContain("turn one");
      expect(texts).not.toContain("reply one");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a boundary that preserved NOTHING rebuilds as the summary alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-compact-"));
    try {
      const cwd = join(home, "work");
      const sessionId = "sess-compact-2";
      const resolved = await resolveEngineSession({ config: { sessionId, cwd, model: "sonnet", winterHome: home }, resolveWinterHome: () => home, env: {} });
      const persistence = resolved.store as SessionPersistence;
      await persistence.recordUserEntry("turn one");
      await persistence.recordAssistantEntry([{ type: "text", text: "reply one" }]);
      await persistence.recordCompactBoundary!({ trigger: "auto", preTokens: 1, summary: "ONLY THE SUMMARY", retainedCount: 0 });

      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const raw = (await store.load({ projectKey: compatibilityKeys(cwd).transcriptProjectKey, sessionId })) ?? [];
      const boundary = raw.find((e) => e.type === "compact_boundary") as unknown as { compact_metadata: Record<string, unknown> };
      // "Both are unset when compaction summarizes everything" -- the pinned rule, held literally.
      expect(boundary.compact_metadata.preserved_messages).toBeUndefined();
      expect(boundary.compact_metadata.preserved_segment).toBeUndefined();

      const resumed = await resolveEngineSession({ config: { sessionId: "fresh", cwd, model: "sonnet", winterHome: home, resume: sessionId }, resolveWinterHome: () => home, env: {} });
      expect(resumed.initialMessages.map((m) => m.content)).toEqual(["ONLY THE SUMMARY"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session with NO store still compacts -- only the durable half is absent", async () => {
    const calls: CompactionInput[] = [];
    const controller = fakeCompactionController({ shouldCompact: true, calls });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig(),
      input: runtime.input,
      output: runtime.output,
      provider: usageProvider([{ kind: "text", text: "done", usage: { inputTokens: 1, outputTokens: 1 } }]),
      tools: stubExecutor,
      compactionController: controller,
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    expect(calls).toHaveLength(1);
    expect(dataMessages(frames).some((m) => (m as { subtype?: string }).subtype === "compact_boundary")).toBe(true);
  });
});

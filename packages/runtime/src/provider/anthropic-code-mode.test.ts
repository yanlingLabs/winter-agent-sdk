// WS-23: the Anthropic path under CODE-MODE conditions, end to end -- the REAL Anthropic adapter
// (resolved through `buildSessionProvider` from the compiled catalog's own Claude rows) driven by the
// REAL `runEngine` against a loopback fake. What each case asserts is what a provider was actually
// SENT (`fake.requests`) and what the transcript was actually GIVEN (the store's `recordAssistantEntry`),
// because neither is visible from a unit test of any one layer: the fold, the engine's assembly, the
// wire serializer and the history renderer all touch the same blocks on the way through.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage as SdkMessage, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type ContentBlock } from "../engine.ts";
import { stubExecutor } from "./mock.ts";
import { buildSessionProvider } from "./session-provider.ts";
import { assistantEntry, userEntry, type SessionCtx } from "../store/dialect.ts";
import { rebuildProviderMessages } from "../store/resume.ts";
import { fakeAnthropicCatalog, startAnthropicFake, type AnthropicFake, type FakeResponse } from "./anthropic-fake.test-support.ts";

interface SessionRun {
  frames: WinterFrame[];
  messages: SdkMessage[];
  /** Every `content` the engine handed the transcript writer, in order. */
  recorded: ContentBlock[][];
  fake: AnthropicFake;
}

async function runSession(opts: { model: string; script: (index: number, body: Record<string, unknown>) => FakeResponse; prompts?: string[]; config?: Partial<RuntimeConfig>; engine?: Record<string, unknown> }): Promise<SessionRun> {
  const fake = await startAnthropicFake((request, index) => opts.script(index, request.body));
  // HERMETIC BY CONSTRUCTION, not by configuration alone: any request this session makes to anything
  // but the fake is refused before it leaves the process, so a wiring regression that falls back to
  // the adapter's compiled endpoint fails the test loudly instead of calling the real API.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!target.startsWith(fake.url)) throw new Error(`hermetic fixture: refused a request to ${new URL(target).origin}`);
    return await realFetch(input, init);
  }) as typeof fetch;
  try {
    const catalog = fakeAnthropicCatalog(fake.url, [opts.model]);
    const config = {
      sessionId: "ws23",
      cwd: "/tmp/ws23",
      model: opts.model,
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // THE CONNECTION IS PINNED TO THE FAKE, explicitly. The `anthropic` row is the one provider this
      // adapter does NOT copy a catalog endpoint into the profile for (it has its own compiled
      // default, `https://api.anthropic.com`), so without a session connection every request here
      // would leave the machine. A user `baseUrl` with `local: true` is the documented way a host
      // points a session at a loopback endpoint.
      provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
      ...opts.config,
    } as RuntimeConfig;
    const wiring = buildSessionProvider({ config, env: {}, catalog, credentials: createMemoryCredentialStore() });
    const recorded: ContentBlock[][] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: wiring.provider,
      tools: stubExecutor,
      providerIdentity: {
        providerId: wiring.identity!.providerId,
        modelKey: wiring.identity!.modelKey,
        family: String(wiring.resolved?.adapter.family ?? ""),
        ...(wiring.identity!.continuationDomain !== undefined ? { continuationDomain: wiring.identity!.continuationDomain } : {}),
      },
      store: {
        recordUserEntry: () => {},
        recordAssistantEntry: (content: ContentBlock[]) => void recorded.push(content),
        recordAttachmentEntry: () => {},
      },
      ...(opts.engine ?? {}),
    } as never);
    for (const prompt of opts.prompts ?? ["go"]) host.output.write({ type: "user", text: prompt });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    await done;
    const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
    return { frames, messages, recorded, fake };
  } finally {
    globalThis.fetch = realFetch;
    await fake.close();
  }
}

const assistantTurns = (body: Record<string, unknown>): Array<{ role: string; content: Array<Record<string, unknown>> }> =>
  (body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>).filter((m) => m.role === "assistant");

const result = (messages: SdkMessage[]): Record<string, unknown> => messages.find((m) => m.type === "result") as Record<string, unknown>;

// --- item 1: block order ------------------------------------------------------------------------------

/** The interleaving a Claude tool loop produces with interleaved thinking. */
const INTERLEAVED: FakeResponse = {
  blocks: [
    { type: "thinking", thinking: "plan the search", signature: "sig-one" },
    { type: "text", text: "Let me look for it." },
    { type: "thinking", thinking: "Glob is the right tool", signature: "sig-two" },
    { type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*.ts" } },
  ],
  stopReason: "tool_use",
};

const INTERLEAVED_BLOCKS = [
  { type: "thinking", thinking: "plan the search", signature: "sig-one" },
  { type: "text", text: "Let me look for it." },
  { type: "thinking", thinking: "Glob is the right tool", signature: "sig-two" },
  { type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*.ts" } },
];

describe("WS-23 item 1: [thinking, text, thinking, tool_use] keeps its order across a tool round trip", () => {
  for (const model of ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5-5"]) {
    test(`${model}: the transcript, the frame and the NEXT request's body all carry the stream's own order, signatures untouched`, async () => {
      const run = await runSession({
        model,
        script: (index) => (index === 0 ? INTERLEAVED : { blocks: [{ type: "text", text: "found nothing" }], stopReason: "end_turn" }),
      });
      expect(run.fake.requests).toHaveLength(2);

      // The transcript.
      expect(run.recorded[0]).toEqual(INTERLEAVED_BLOCKS as ContentBlock[]);
      // The assistant frame the host saw.
      const assistantFrame = run.messages.find((m) => m.type === "assistant") as { message: { content: unknown[] } };
      expect(assistantFrame.message.content).toEqual(INTERLEAVED_BLOCKS);

      // The replay: the second request's assistant turn is the SAME four blocks, in place, byte-identical
      // (the only addition the wire may make is the message-level cache marker on the LAST message,
      // which is the user's tool result, not this turn).
      const replay = assistantTurns(run.fake.requests[1]!.body);
      expect(replay).toHaveLength(1);
      expect(replay[0]!.content).toEqual(INTERLEAVED_BLOCKS);
      // …and the tool result answers the call that turn made.
      const lastUser = (run.fake.requests[1]!.body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>).at(-1)!;
      expect(lastUser.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
      expect(result(run.messages)).toMatchObject({ subtype: "success", is_error: false, result: "found nothing" });
    });
  }

  test("a RESUMED session rebuilds the same order from the transcript it was given", async () => {
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      script: (index) => (index === 0 ? INTERLEAVED : { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" }),
    });
    const ctx: SessionCtx = { sessionId: "ws23", cwd: "/tmp/ws23", version: "test" };
    const user = userEntry({ text: "go", chain: { parentUuid: null }, ctx });
    const assistant = assistantEntry({ content: run.recorded[0]! as never, chain: { parentUuid: user.uuid }, ctx });
    const rebuilt = rebuildProviderMessages([user, assistant] as never);
    expect(rebuilt.find((m) => m.role === "assistant")?.content).toEqual(INTERLEAVED_BLOCKS as ContentBlock[]);
  });

  test("an ordinary [text, tool_use] turn is persisted exactly as before (the per-kind assembly and the stream order agree)", async () => {
    const run = await runSession({
      model: "anthropic/claude-sonnet-5",
      script: (index) =>
        index === 0
          ? { blocks: [{ type: "text", text: "checking" }, { type: "tool_use", id: "toolu_2", name: "Glob", input: { pattern: "x" } }], stopReason: "tool_use" }
          : { blocks: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    });
    expect(run.recorded[0]).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "toolu_2", name: "Glob", input: { pattern: "x" } },
    ]);
    // A text-only turn still records one text block.
    expect(run.recorded[1]).toEqual([{ type: "text", text: "ok" }]);
  });
});

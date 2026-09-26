// WS-23 (anthropic-cache C1, wired into the hardening lane's reactive recovery): an OVERFLOW-driven
// compaction never re-sends the history that was just refused as too long. End to end on the wire:
// the real engine, the real catalog-resolved Anthropic provider and the REAL compaction controller
// against a loopback Messages endpoint -- a `prompt is too long` 400, then the reactive compaction's
// summary request (the redacted, tool-less one, NOT the session's prefix), then the retried round on
// the compacted history.
import { expect, test } from "bun:test";
import type { ProtocolSdkMessage as SdkMessage, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { stubExecutor } from "./mock.ts";
import { buildSessionProvider } from "./session-provider.ts";
import { createCompactionController } from "../compaction/controller.ts";
import { WINTER_PREFIX_SUMMARY_INSTRUCTION } from "../compaction/summarizer.ts";
import { fakeAnthropicCatalog, startAnthropicFake, type FakeResponse } from "./anthropic-fake.test-support.ts";

const PROMPT_TOO_LONG: FakeResponse = { status: 400, error: { type: "invalid_request_error", message: "prompt is too long: 1000321 tokens > 1000000 maximum" } };
const TEXT = (text: string): FakeResponse => ({ blocks: [{ type: "text", text }], stopReason: "end_turn" });

test("overflow -> reactive compaction on the REDACTED request (never the refused prefix) -> the retry succeeds", async () => {
  const model = "anthropic/claude-opus-5-5";
  // 0: one, 1: two, 2: the overflow, 3: the summary, 4: the retried round.
  const fake = await startAnthropicFake((_request, index) => (index === 2 ? PROMPT_TOO_LONG : index === 3 ? TEXT("SUMMARY-OF-EARLIER-TURNS") : TEXT(index === 4 ? "recovered" : `reply ${index}`)));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!target.startsWith(fake.url)) throw new Error(`hermetic fixture: refused a request to ${new URL(target).origin}`);
    return await realFetch(input, init);
  }) as typeof fetch;
  try {
    const config = {
      sessionId: "ws23-overflow",
      cwd: "/tmp/ws23-overflow",
      model,
      effort: "high",
      persistSession: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
    } as RuntimeConfig;
    const wiring = buildSessionProvider({ config, env: {}, catalog: fakeAnthropicCatalog(fake.url, [model]), credentials: createMemoryCredentialStore() });
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: wiring.provider,
      tools: stubExecutor,
      providerIdentity: { providerId: wiring.identity!.providerId, modelKey: wiring.identity!.modelKey, family: String(wiring.resolved?.adapter.family ?? "") },
      compactionController: createCompactionController({ retainedPairs: 1 }),
    } as never);
    for (const prompt of ["first", "second", "third"]) host.output.write({ type: "user", text: prompt });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    await done;
    const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);

    expect(fake.requests).toHaveLength(5);
    const overflowed = fake.requests[2]!.body;
    const summary = fake.requests[3]!.body;
    // THE POINT: the summary request is NOT the refused request plus an instruction.
    expect(JSON.stringify(summary)).not.toContain(WINTER_PREFIX_SUMMARY_INSTRUCTION.slice(0, 40));
    expect(summary["tools"]).toBeUndefined();
    expect(JSON.stringify(summary["system"])).toContain("compacting a conversation");
    expect((summary["messages"] as unknown[]).length).toBeLessThan((overflowed["messages"] as unknown[]).length);
    // Only what the compaction REPLACES reaches the summariser: the retained turn ("third") does not.
    expect(JSON.stringify(summary["messages"])).not.toContain("third");
    // The retry runs on the compacted history and the turn ends on its answer.
    expect(JSON.stringify(fake.requests[4]!.body["messages"])).toContain("SUMMARY-OF-EARLIER-TURNS");
    // The compaction rewrote the history the last fingerprint described, so the retry opts into cache
    // diagnostics afresh rather than naming a response whose prefix is gone.
    expect(fake.requests[1]!.body["diagnostics"]).toEqual({ previous_message_id: "msg_fake" });
    expect(fake.requests[4]!.body["diagnostics"]).toEqual({ previous_message_id: null });
    const results = messages.filter((m) => m.type === "result") as Array<Record<string, unknown>>;
    expect(results.at(-1)).toMatchObject({ subtype: "success", is_error: false, result: "recovered" });
  } finally {
    globalThis.fetch = realFetch;
    await fake.close();
  }
});

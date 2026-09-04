// Phase 5 Task 3 (R5-2): the SEAM AUTHORITY for `commands/seam.ts`. Lane S keeps this green against
// its real filesystem resolver; the engine keeps it green against its consumption.
import { test, expect, describe } from "bun:test";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderRequest } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { fakeCommandResolver, looksLikeCommand, resolveBuiltinCommand, type CommandResolver } from "./seam.ts";

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "sonnet", ...overrides });

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

function recordingProvider(): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    provider: {
      async generate(input) {
        requests.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
        return { kind: "text", text: "done" };
      },
    },
  };
}

async function runWith(prompts: string[], resolver?: CommandResolver): Promise<{ requests: ProviderRequest[]; messages: SdkMessage[] }> {
  const { host, runtime } = createInMemoryChannel();
  const { provider, requests } = recordingProvider();
  const done = runEngine({
    config: baseConfig(),
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
    ...(resolver !== undefined ? { commandResolver: resolver } : {}),
  });
  for (const p of prompts) host.output.write({ type: "user", text: p });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  return { requests, messages: dataMessages(frames) };
}

describe("commands/seam.ts -- CommandResolver (Lane S implements the filesystem half)", () => {
  test("resolveBuiltinCommand recognises `/compact` with and without instructions, and nothing else", () => {
    expect(resolveBuiltinCommand("/compact")).toEqual({ kind: "builtin", name: "compact", args: "" });
    expect(resolveBuiltinCommand("/compact  focus on the API design  ")).toEqual({ kind: "builtin", name: "compact", args: "focus on the API design" });
    expect(resolveBuiltinCommand("/compaction")).toBeUndefined(); // the name must be the WHOLE first token
    expect(resolveBuiltinCommand("/review")).toBeUndefined();
    expect(resolveBuiltinCommand("compact")).toBeUndefined();
    expect(resolveBuiltinCommand("please /compact this")).toBeUndefined(); // never mid-prompt
  });

  test("looksLikeCommand gates what reaches a resolver at all", () => {
    expect(looksLikeCommand("/review")).toBe(true);
    expect(looksLikeCommand("hello")).toBe(false);
    expect(looksLikeCommand("/")).toBe(false);
    expect(looksLikeCommand("//comment")).toBe(false);
  });

  // --- The engine's half -----------------------------------------------------------------------------

  test("an `expand` resolution is what the MODEL sees -- the un-expanded `/name args` never reaches the provider", async () => {
    const resolver = fakeCommandResolver({ review: "Please review $ARGUMENTS carefully." });
    const { requests } = await runWith(["/review src/main.ts"], resolver);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[0]!.content).toBe("Please review src/main.ts carefully.");
  });

  test("a non-command prompt never reaches the resolver, and is used verbatim", async () => {
    const calls: Array<{ prompt: string; cwd: string }> = [];
    const resolver = fakeCommandResolver({ review: "body" }, { calls });
    const { requests } = await runWith(["just a normal prompt"], resolver);
    expect(calls).toHaveLength(0);
    expect(requests[0]!.messages[0]!.content).toBe("just a normal prompt");
  });

  test("an unresolved `/name` is passed through verbatim -- never an error, never a dropped turn", async () => {
    const resolver = fakeCommandResolver({});
    const { requests, messages } = await runWith(["/nosuchcommand arg"], resolver);
    expect(requests[0]!.messages[0]!.content).toBe("/nosuchcommand arg");
    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
  });

  test("the resolver is handed the session cwd, not process.cwd()", async () => {
    const calls: Array<{ prompt: string; cwd: string }> = [];
    await runWith(["/review x"], fakeCommandResolver({ review: "b" }, { calls }));
    expect(calls[0]!.cwd).toBe("/tmp/x");
  });

  test("the ENGINE's built-in wins over a resolver entry of the same name -- a repo command cannot shadow /compact", async () => {
    const calls: Array<{ prompt: string; cwd: string }> = [];
    const resolver = fakeCommandResolver({ compact: "SHADOWED BODY" }, { calls });
    const { requests } = await runWith(["/compact"], resolver);
    expect(calls).toHaveLength(0); // never even offered to the resolver
    expect(requests).toHaveLength(0); // and never sent to the model
  });

  test("`/compact` with NO compaction controller reports unavailability and still terminates the turn -- never a silent no-op", async () => {
    const { requests, messages } = await runWith(["/compact"], undefined);
    expect(requests).toHaveLength(0); // the model never sees a /compact envelope
    const results = messages.filter((m) => m.type === "result");
    expect(results).toHaveLength(1);
    expect((results[0] as { subtype: string }).subtype).toBe("success");
    expect((results[0] as { result?: string }).result ?? "").toContain("compaction");
  });

  test("a session with NO resolver at all still resolves the built-in, and still passes ordinary prompts through", async () => {
    const { requests } = await runWith(["hello"], undefined);
    expect(requests[0]!.messages[0]!.content).toBe("hello");
  });

  test("the fake substitutes $ARGUMENTS everywhere it occurs, and with an empty string when no args are given", async () => {
    const resolver = fakeCommandResolver({ dup: "[$ARGUMENTS] and again [$ARGUMENTS]" });
    expect(await resolver.resolve("/dup one two", "/w")).toEqual({ kind: "expand", text: "[one two] and again [one two]", source: "fake:dup" });
    expect(await resolver.resolve("/dup", "/w")).toEqual({ kind: "expand", text: "[] and again []", source: "fake:dup" });
  });
});

// SDK 0.0.40, through the REAL engine: each call of a round reaches the host in its own `user` frame the
// moment the call is done -- proved without timing: the second call cannot finish until the HOST has
// received the first call's frame (under the pre-0.0.40 batched write this test deadlocks). And the model's
// side is untouched: the transcript records the round as ONE user entry and the next request carries the
// results together, in call order.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions, type ProviderRequest } from "./engine.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "winter-per-call-engine-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const userFrameIds = (f: WinterFrame): string[] | undefined => {
  const msg = (f as { message?: { type?: string; message?: { content?: Array<{ type?: string; tool_use_id?: string }> } } }).message;
  if (f.type !== "data" || msg?.type !== "user") return undefined;
  return (msg.message?.content ?? []).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id!);
};

describe("a round's results reach the host one call at a time", () => {
  test("the second call finishes only after the host has the first call's frame; the model still sees one tool message", async () => {
    const requests: ProviderRequest[] = [];
    const recorded: unknown[] = [];
    let hostHasFirst!: () => void;
    const hostHasFirstP = new Promise<void>((r) => (hostHasFirst = r));
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: { sessionId: "s-per-call", cwd: dir, model: "anthropic/claude-sonnet-5-5", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
      input: runtime.input,
      output: runtime.output,
      provider: {
        async generate(req) {
          requests.push({ ...req, messages: structuredClone(req.messages) });
          if (requests.length === 1) {
            return { kind: "tool_use", calls: [{ id: "quick", name: "Read", input: { file_path: "a" } }, { id: "slow", name: "Read", input: { file_path: "b" } }, { id: "last", name: "Read", input: { file_path: "c" } }] };
          }
          return { kind: "text", text: "done" };
        },
      },
      tools: {
        async execute(call: { id: string }) {
          if (call.id === "slow") {
            // Bounded, so a regression fails loudly rather than hanging the suite.
            const waited = await Promise.race([hostHasFirstP.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
            return { output: waited ? "slow: the host already had quick" : "slow: TIMED OUT waiting for the host" };
          }
          return { output: `${call.id} result` };
        },
      },
      providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5-5", family: "anthropic" },
      describeModel: () => ({}),
      store: {
        recordUserEntry(content: string | ContentBlock[]) { recorded.push(structuredClone(content)); },
        recordAssistantEntry() {},
      },
    } as EngineOptions);
    const frames: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) {
        frames.push(f);
        if (userFrameIds(f)?.includes("quick")) hostHasFirst();
      }
    })();
    host.output.write({ type: "user", text: "read them" });
    for (let n = 0; n < 3000 && !frames.some((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result"); n++) await new Promise((r) => setTimeout(r, 2));
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reader;

    // The host: one frame per call, in call order, each carrying exactly its own result.
    const perCall = frames.map(userFrameIds).filter((ids): ids is string[] => ids !== undefined && ids.length > 0);
    expect(perCall).toEqual([["quick"], ["slow"], ["last"]]);
    // The slow call really did finish AFTER the host had the quick call's frame.
    const slowBlock = JSON.stringify(frames.find((f) => userFrameIds(f)?.includes("slow")));
    expect(slowBlock).toContain("the host already had quick");

    // The model: the round's three results in ONE tool message, in call order -- exactly as before 0.0.40.
    const toolMessages = requests[1]!.messages.filter((m) => (m as { role: string }).role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(((toolMessages[0] as { content: ContentBlock[] }).content).map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual(["quick", "slow", "last"]);
    // The transcript: ONE user entry for the round.
    const roundEntries = recorded.filter((c) => Array.isArray(c) && (c as ContentBlock[]).some((b) => b.type === "tool_result"));
    expect(roundEntries).toHaveLength(1);
    expect((roundEntries[0] as ContentBlock[]).map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual(["quick", "slow", "last"]);
  });
});

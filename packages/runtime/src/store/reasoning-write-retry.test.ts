// WS-23 (reasoning-state, user decision 6): a sidecar write that fails for REASONING is retried once;
// if the retry fails too, the turn still completes and a visible `continuity_warning` says so.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type ContentBlock, type EngineOptions } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { appendProviderState, readProviderState, type ProviderStateRecordInput } from "./provider-state.ts";

/** Drives one turn whose reply carries a thinking block, against a store whose `reasoning-blocks` writes fail `failures` times. */
async function run(failures: number): Promise<{ frames: WinterFrame[]; attempts: ProviderStateRecordInput[]; written: ProviderStateRecordInput[]; entries: ContentBlock[][] }> {
  const attempts: ProviderStateRecordInput[] = [];
  const written: ProviderStateRecordInput[] = [];
  const entries: ContentBlock[][] = [];
  let left = failures;
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "s-retry", cwd: "/winter-fixture", model: "anthropic/claude-opus-5-5" },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate() {
        return { kind: "text", text: "answer", thinking: { blocks: [{ type: "thinking", thinking: "reasoned", signature: "sig-1" }] } };
      },
    },
    tools: stubExecutor,
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" },
    store: {
      recordUserEntry() {},
      recordAssistantEntry(content: ContentBlock[]) {
        entries.push(content);
      },
      recordProviderState(record: ProviderStateRecordInput) {
        attempts.push(record);
        if (record.kind === "reasoning-blocks" && left > 0) {
          left--;
          throw new Error("disk full");
        }
        written.push(record);
      },
    },
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  host.output.write({ type: "user", text: "go" });
  for (let n = 0; n < 2000 && !frames.some((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result"); n++) await new Promise((r) => setTimeout(r, 2));
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return { frames, attempts, written, entries };
}

const warnings = (frames: WinterFrame[]): Array<{ warning: string; detail: string }> =>
  frames.flatMap((f) => (f.type === "data" && (f as { message: { subtype?: string } }).message.subtype === "continuity_warning" ? [(f as unknown as { message: { warning: string; detail: string } }).message] : []));
const result = (frames: WinterFrame[]): { is_error: boolean; result: string } | undefined =>
  frames.map((f) => (f as { message?: { type: string } }).message).find((m) => m?.type === "result") as { is_error: boolean; result: string } | undefined;

describe("a failed reasoning write (WS-23 decision 6)", () => {
  test("one failure: retried as the SAME record (same uuid), written, and nothing is said", async () => {
    const { frames, attempts, written, entries } = await run(1);
    const tries = attempts.filter((r) => r.kind === "reasoning-blocks");
    expect(tries).toHaveLength(2);
    expect(tries[0]!.uuid).toBeDefined();
    expect(tries[1]!.uuid).toBe(tries[0]!.uuid);
    expect(written.filter((r) => r.kind === "reasoning-blocks")).toHaveLength(1);
    expect(warnings(frames)).toEqual([]);
    expect(result(frames)).toMatchObject({ is_error: false, result: "answer" });
    // The transcript entry is neutral either way.
    expect(entries).toEqual([[{ type: "text", text: "answer" }]]);
  });

  test("the retry fails too: the turn COMPLETES, and one visible warning names the kind -- never the payload", async () => {
    const { frames, written } = await run(2);
    expect(written.filter((r) => r.kind === "reasoning-blocks")).toHaveLength(0);
    expect(result(frames)).toMatchObject({ is_error: false, result: "answer" });
    const [warning, ...rest] = warnings(frames);
    expect(rest).toEqual([]);
    expect(warning!.warning).toBe("reasoning_state_unsaved");
    expect(warning!.detail).toContain("reasoning-blocks");
    expect(JSON.stringify(frames)).not.toContain("sig-1");
  });
});

describe("a retried append after a torn line (the crash the bounded repair exists for)", () => {
  test("the torn fragment is closed off as its own skipped line; the retried record survives", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-ws23-torn-"));
    try {
      const path = join(home, "s.provider-state.jsonl");
      const base = { sessionId: "s", anchorUuid: "a", provider: "anthropic", model: "anthropic/claude-opus-5-5", family: "anthropic", itemIndex: 0 } as const;
      const first = appendProviderState(path, { ...base, kind: "origin", payload: {} });
      appendFileSync(path, '{"type":"winter_provider_state","uuid":"torn');
      const retried = appendProviderState(path, { ...base, itemIndex: 1, kind: "reasoning-blocks", payload: { blocks: [] } });
      expect(readProviderState(path)).toEqual([first, retried]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

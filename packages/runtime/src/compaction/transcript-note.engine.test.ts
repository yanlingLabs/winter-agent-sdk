// 2026-10-07: what the ENGINE hands the controller after a compaction is decided --
//   - `transcriptNote` (claude parity, tool-aware): only a main session with a durable store whose tool
//     pool offers `Read` is told where its full transcript is; chat's allowed list has no `Read`, so a chat
//     session never is (a prompt must never name a tool the session was not given);
//   - `estimatedTokens`: when the accountant has measured nothing yet (a fresh process -- a resume -- that
//     compacts before its first generation), the fit check's own estimate, so `pre_tokens` is never 0.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderMessage } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { resolveEngineSession } from "../store/dialect.ts";
import { fakeCompactionController, type CompactionInput } from "./seam.ts";
import { transcriptNote } from "./summarizer.ts";

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

const textProvider: Provider = { async generate() { return { kind: "text", text: "ok", usage: { inputTokens: 40, outputTokens: 2 } }; } };

const history: ProviderMessage[] = [
  { role: "user", content: "x".repeat(7_000) },
  { role: "assistant", content: "y".repeat(3_500) },
];

/** Runs `/compact` once on a fresh engine (nothing measured yet) and returns what the controller was handed. */
async function compactOnce(opts: { config: RuntimeConfig; store?: Parameters<typeof runEngine>[0]["store"]; initialMessages?: ProviderMessage[] }): Promise<{ input: CompactionInput; frames: WinterFrame[] }> {
  const calls: CompactionInput[] = [];
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: opts.config,
    input: runtime.input,
    output: runtime.output,
    provider: textProvider,
    tools: stubExecutor,
    compactionController: fakeCompactionController({ calls, keep: 0, summary: "SUM" }),
    ...(opts.store !== undefined ? { store: opts.store } : {}),
    ...(opts.initialMessages !== undefined ? { initialMessages: opts.initialMessages } : {}),
  });
  host.output.write({ type: "user", text: "/compact" });
  host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;
  expect(calls).toHaveLength(1);
  return { input: calls[0]!, frames };
}

describe("compaction: the transcript note is handed in only when the session can read it", () => {
  test("a main session with a durable store and the full built-in set (Read included) is told its transcript's own path", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-note-code-"));
    try {
      const config: RuntimeConfig = { sessionId: "sess-note-1", cwd: join(home, "work"), model: "sonnet", winterHome: home };
      const resolved = await resolveEngineSession({ config, resolveWinterHome: () => home, env: {} });
      const path = resolved.store!.transcriptPath!;
      expect(path).toBe(join(home, "projects", path.split("/").at(-2)!, "sess-note-1.jsonl"));
      const { input } = await compactOnce({ config: resolved.config, store: resolved.store!, initialMessages: history });
      expect(input.transcriptNote).toBe(transcriptNote(path));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session whose allowed tools leave out Read (chat's shape) gets no note, durable store or not", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-note-chat-"));
    try {
      const config: RuntimeConfig = { sessionId: "sess-note-2", cwd: join(home, "work"), model: "sonnet", winterHome: home, tools: ["WebFetch", "AskUserQuestion"] };
      const resolved = await resolveEngineSession({ config, resolveWinterHome: () => home, env: {} });
      expect(resolved.store?.transcriptPath).toBeDefined();
      const { input } = await compactOnce({ config: resolved.config, store: resolved.store!, initialMessages: history });
      expect(input.transcriptNote).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Read denied by disallowedTools: no note", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-note-deny-"));
    try {
      const config: RuntimeConfig = { sessionId: "sess-note-3", cwd: join(home, "work"), model: "sonnet", winterHome: home, disallowedTools: ["Read"] };
      const resolved = await resolveEngineSession({ config, resolveWinterHome: () => home, env: {} });
      const { input } = await compactOnce({ config: resolved.config, store: resolved.store!, initialMessages: history });
      expect(input.transcriptNote).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no durable store (nothing to point at): no note", async () => {
    const { input } = await compactOnce({ config: { sessionId: "s", cwd: "/tmp/x", model: "sonnet" }, initialMessages: history });
    expect(input.transcriptNote).toBeUndefined();
  });
});

describe("compaction: pre_tokens in a process that has measured nothing yet", () => {
  test("the controller is handed the fit check's estimate, and the boundary frame records it -- not 0", async () => {
    const { input, frames } = await compactOnce({ config: { sessionId: "s", cwd: "/tmp/x", model: "sonnet" }, initialMessages: history });
    // 10,500 characters of history at the estimator's ~3.5 characters per token (plus its margin).
    expect(input.estimatedTokens).toBeGreaterThan(2_500);
    const boundary = frames
      .filter((f) => f.type === "data")
      .map((f) => (f as { message: SdkMessage }).message)
      .find((m) => (m as { subtype?: string }).subtype === "compact_boundary") as unknown as { compact_metadata: { pre_tokens: number } } | undefined;
    expect(boundary?.compact_metadata.pre_tokens).toBe(Math.round(input.estimatedTokens!));
  });

  test("once a generation has been measured, no estimate is taken -- the measurement is what is recorded", async () => {
    const calls: CompactionInput[] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: { sessionId: "s", cwd: "/tmp/x", model: "sonnet" },
      input: runtime.input,
      output: runtime.output,
      provider: textProvider,
      tools: stubExecutor,
      compactionController: fakeCompactionController({ calls, keep: 0, summary: "SUM" }),
    });
    host.output.write({ type: "user", text: "hello" });
    host.output.write({ type: "user", text: "/compact" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.estimatedTokens).toBeUndefined();
    expect(calls[0]!.accountant.contextTokens()).toBeGreaterThan(0);
  });
});

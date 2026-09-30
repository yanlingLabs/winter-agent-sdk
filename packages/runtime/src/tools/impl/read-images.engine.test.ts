// Code-mode images, end to end through the REAL engine and the REAL Read executor (no tool double):
//
//   1. an image Read reaches the provider's next request as a `tool_result` whose content is an image
//      block -- the model is shown the image, not base64 text;
//   2. the host's `user` frame carries the same block shape with its `data` emptied (the frame is one
//      NDJSON line on the child's stdout, bounded by the host SDK's 1 MiB `maxBufferSize`);
//   3. the transcript entry stores the base64 image inside the tool_result, claude's own shape, and a
//      session resumed from that JSONL sends the image again, byte-identical on the Anthropic wire;
//   4. on a model whose row reads no images, the result is the short text refusal, never base64;
//   5. an ordinary text Read is unchanged (a plain string result).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStoreEntry, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { assistantEntry, userEntry, type SessionCtx } from "../../store/dialect.ts";
import { rebuildProviderMessages, toDialectEntries } from "../../store/resume.ts";
import { createInMemoryChannel } from "../../protocol/channel.ts";
import { ProviderTurnError, runEngine, type ContentBlock, type EngineOptions, type ModelDescription, type ProviderMessage, type ProviderRequest } from "../../engine.ts";
import { IMAGE_BUDGET_NOTE } from "@yanlinglabs/winter-provider-runtime";
import { toWireMessages } from "../../../../provider-runtime/src/adapters/anthropic/messages.ts";
import { MODEL_DOES_NOT_SUPPORT_IMAGES } from "./read.ts";

// A real 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const PNG_B64 = PNG.toString("base64");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "winter-read-images-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  requests: ProviderRequest[];
  entries: SessionStoreEntry[];
  frames: WinterFrame[];
}

/**
 * One session: the user asks, the scripted model calls Read on `readPath` (when given), then answers.
 * The store double is built from the REAL dialect builders, so `entries` is exactly what the JSONL holds.
 */
async function run(opts: { readPath?: string; description?: ModelDescription; initialMessages?: ProviderMessage[] }): Promise<RunResult> {
  const requests: ProviderRequest[] = [];
  const entries: SessionStoreEntry[] = [];
  const ctx: SessionCtx = { sessionId: "s-images", cwd: dir, version: "0" };
  let parent: string | null = null;
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "s-images", cwd: dir, model: "anthropic/claude-sonnet-5-5" },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        if (opts.readPath !== undefined && requests.length === 1) return { kind: "tool_use", calls: [{ id: "toolu_read_1", name: "Read", input: { file_path: opts.readPath } }] };
        return { kind: "text", text: `reply ${requests.length}` };
      },
    },
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5-5", family: "anthropic" },
    describeModel: () => opts.description ?? {},
    ...(opts.initialMessages !== undefined ? { initialMessages: opts.initialMessages } : {}),
    store: {
      recordUserEntry(content: string | ContentBlock[]) {
        const e = typeof content === "string" ? userEntry({ text: content, chain: { parentUuid: parent }, ctx }) : userEntry({ content, chain: { parentUuid: parent }, ctx });
        entries.push(e as unknown as SessionStoreEntry);
        parent = e.uuid;
      },
      recordAssistantEntry(content: ContentBlock[], o?: { uuid?: string }) {
        const e = assistantEntry({ content, chain: { parentUuid: parent }, ctx, ...(o ?? {}) });
        entries.push(e as unknown as SessionStoreEntry);
        parent = e.uuid;
      },
    },
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  host.output.write({ type: "user", text: "look at the picture" });
  for (let n = 0; n < 2000 && !frames.some((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result"); n++) await new Promise((r) => setTimeout(r, 2));
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return { requests, entries, frames };
}

type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;

function toolResultIn(messages: readonly ProviderMessage[]): ToolResult {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    const found = m.content.find((b): b is ToolResult => b.type === "tool_result");
    if (found !== undefined) return found;
  }
  throw new Error("no tool_result in the request");
}

function toolRoundFrame(frames: WinterFrame[]): { content: unknown[] } {
  const frame = frames.find((f) => {
    const msg = (f as { message?: { type?: string; message?: { content?: unknown } } }).message;
    return f.type === "data" && msg?.type === "user" && Array.isArray(msg.message?.content) && (msg.message!.content as Array<{ type?: string }>).some((b) => b.type === "tool_result");
  });
  if (frame === undefined) throw new Error("no tool-round user frame");
  return (frame as unknown as { message: { message: { content: unknown[] } } }).message.message;
}

describe("an image Read through the engine (code-mode images)", () => {
  test("the next request carries the image as a tool_result image block -- not base64 text", async () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, PNG);
    const { requests } = await run({ readPath: path });
    expect(requests).toHaveLength(2);
    const result = toolResultIn(requests[1]!.messages);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }]);
    // And on the Anthropic wire: an image block inside the tool_result, where the Messages API takes it.
    const wire = JSON.stringify(toWireMessages(requests[1]!.messages));
    expect(wire).toContain(`"type":"tool_result","tool_use_id":"toolu_read_1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${PNG_B64}"}}]`);
    expect(wire).not.toContain("winterReadBlocks");
  });

  test("the HOST's frame keeps the block shape with the image bytes emptied", async () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, PNG);
    const { frames } = await run({ readPath: path });
    const message = toolRoundFrame(frames);
    expect(message.content).toEqual([{ type: "tool_result", tool_use_id: "toolu_read_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }] }]);
    expect(JSON.stringify(frames)).not.toContain(PNG_B64);
  });

  test("the transcript stores the base64 image in the tool_result, and a resumed session sends it again", async () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, PNG);
    const live = await run({ readPath: path });
    // What the JSONL holds, line for line: a user entry whose tool_result content is claude's image block.
    const jsonl = live.entries.map((e) => JSON.stringify(e)).join("\n");
    const lines = jsonl.split("\n").map((l) => JSON.parse(l) as { type: string; message?: { content?: unknown } });
    const resultEntry = lines.find((l) => l.type === "user" && Array.isArray(l.message?.content) && (l.message!.content as Array<{ type: string }>)[0]?.type === "tool_result");
    expect(resultEntry?.message?.content).toEqual([{ type: "tool_result", tool_use_id: "toolu_read_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }] }]);

    // Resume from the parsed JSONL and ask again: the first resumed request carries the same image.
    const resumedHistory = rebuildProviderMessages(toDialectEntries(lines as unknown as SessionStoreEntry[]));
    const resumed = await run({ initialMessages: resumedHistory });
    const resumedResult = toolResultIn(resumed.requests[0]!.messages);
    expect(resumedResult.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }]);
    // Byte-identical on the wire to the live session's image, so the provider sees the same prompt.
    const wireResult = (msgs: ProviderMessage[]) => JSON.stringify(toWireMessages(msgs)).match(/"type":"tool_result".*?\]\}/)?.[0];
    expect(wireResult(resumed.requests[0]!.messages)).toBe(wireResult(live.requests[1]!.messages));
  });

  test("THE GATE: on a model whose row reads no images, the result is the text refusal -- never base64", async () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, PNG);
    const { requests, frames } = await run({ readPath: path, description: { readsImages: false } });
    const result = toolResultIn(requests[1]!.messages);
    expect(result.content).toBe(`${MODEL_DOES_NOT_SUPPORT_IMAGES}: ${path}`);
    expect(result.is_error).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(PNG_B64);
    expect(JSON.stringify(frames)).not.toContain(PNG_B64);
  });

  test("an ordinary text Read is unchanged: a plain string result", async () => {
    const path = join(dir, "notes.txt");
    writeFileSync(path, "hello text");
    const { requests, frames } = await run({ readPath: path });
    expect(toolResultIn(requests[1]!.messages).content).toBe("hello text");
    expect(toolRoundFrame(frames).content).toEqual([{ type: "tool_result", tool_use_id: "toolu_read_1", content: "hello text" }]);
  });
});

// --- Code-mode images: a provider's refusal for the request's IMAGES --------------------------------------

async function runWithProvider(generate: (req: ProviderRequest) => Promise<unknown>, initialMessages: ProviderMessage[]): Promise<WinterFrame[]> {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "s-image-refusal", cwd: dir, model: "anthropic/claude-sonnet-5-5" },
    input: runtime.input,
    output: runtime.output,
    provider: { generate: generate as never },
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5-5", family: "anthropic" },
    describeModel: () => ({}),
    initialMessages,
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  host.output.write({ type: "user", text: "and now?" });
  for (let n = 0; n < 2000 && !frames.some((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result"); n++) await new Promise((r) => setTimeout(r, 2));
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return frames;
}

const imageHistory = (): ProviderMessage[] => [0, 1, 2].flatMap((i): ProviderMessage[] => [
  { role: "user", content: [{ type: "text", text: `shot ${i}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: `IMG${i}` } }] },
  { role: "assistant", content: `seen ${i}` },
]);

function imagesIn(req: ProviderRequest): string[] {
  const out: string[] = [];
  for (const m of req.messages) if (typeof m.content !== "string") for (const b of m.content) if (b.type === "image") out.push(b.source.data);
  return out;
}

describe("a refusal for the request's IMAGES", () => {
  test("gets ONE retry that keeps only the newest image, every earlier one a note -- and that shape sticks", async () => {
    const requests: ProviderRequest[] = [];
    const frames = await runWithProvider(async (req) => {
      requests.push({ ...req, messages: structuredClone(req.messages) });
      if (imagesIn(req).length > 1) throw new ProviderTurnError("provider request failed (bad_request): HTTP 400 — too many images", { status: 400, code: "bad_request", retryable: false, imageOverflow: true });
      return { kind: "text", text: "fine" };
    }, imageHistory());
    expect(requests.map(imagesIn)).toEqual([["IMG0", "IMG1", "IMG2"], ["IMG2"]]);
    expect(JSON.stringify(requests[1]!.messages)).toContain(IMAGE_BUDGET_NOTE);
    const result = frames.find((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result") as unknown as { message: { subtype: string; result?: string } };
    expect(result.message.subtype).toBe("success");
  });

  test("a SECOND refusal is not retried again: the provider's own error is what the turn ends with", async () => {
    let calls = 0;
    const frames = await runWithProvider(async () => {
      calls++;
      throw new ProviderTurnError("provider request failed (bad_request): HTTP 400 — too many images", { status: 400, code: "bad_request", retryable: false, imageOverflow: true });
    }, imageHistory());
    expect(calls).toBe(2);
    const result = frames.find((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result") as unknown as { message: { is_error: boolean; result?: string } };
    expect(result.message.is_error).toBe(true);
    expect(result.message.result).toContain("too many images");
  });
});

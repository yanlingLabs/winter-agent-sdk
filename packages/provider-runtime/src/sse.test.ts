import { describe, expect, test } from "bun:test";
import { ProviderStallError } from "./errors.ts";
import { parseSse } from "./sse.ts";

/** A stream of pre-baked chunks, optionally with a gap before one of them (to exercise the stall timer). */
function streamOf(chunks: Array<string | { delayMs: number; text?: string }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i++]!;
      if (typeof chunk === "string") {
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      await new Promise((r) => setTimeout(r, chunk.delayMs));
      if (chunk.text === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk.text));
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>, opts: Parameters<typeof parseSse>[1]): Promise<Array<{ event?: string; data: string }>> {
  const out: Array<{ event?: string; data: string }> = [];
  for await (const ev of parseSse(stream, opts)) out.push(ev);
  return out;
}

describe("parseSse — framing", () => {
  test("parses named events with data", async () => {
    const events = await collect(streamOf(['event: message_start\ndata: {"a":1}\n\n', 'event: content_block_delta\ndata: {"b":2}\n\n']), { stallTimeoutMs: 1000 });
    expect(events).toEqual([
      { event: "message_start", data: '{"a":1}' },
      { event: "content_block_delta", data: '{"b":2}' },
    ]);
  });

  test("an event with no `event:` line omits the field rather than inventing a name", async () => {
    const events = await collect(streamOf(['data: {"a":1}\n\n']), { stallTimeoutMs: 1000 });
    expect(events).toEqual([{ data: '{"a":1}' }]);
    expect("event" in events[0]!).toBe(false);
  });

  test("joins MULTI-LINE data with \\n, per the SSE spec", async () => {
    const events = await collect(streamOf(["data: line one\ndata: line two\ndata: line three\n\n"]), { stallTimeoutMs: 1000 });
    expect(events).toEqual([{ data: "line one\nline two\nline three" }]);
  });

  test("handles CRLF line endings and CRLF event boundaries", async () => {
    const events = await collect(streamOf(['event: ping\r\ndata: {"x":1}\r\n\r\ndata: second\r\n\r\n']), { stallTimeoutMs: 1000 });
    expect(events).toEqual([{ event: "ping", data: '{"x":1}' }, { data: "second" }]);
  });

  test("survives an event split across chunk boundaries, including mid-token and mid-CRLF", async () => {
    const events = await collect(streamOf(["eve", "nt: message_st", 'art\r', '\ndata: {"a"', ":1}\r\n\r", "\n"]), { stallTimeoutMs: 1000 });
    expect(events).toEqual([{ event: "message_start", data: '{"a":1}' }]);
  });

  test("survives a MULTI-BYTE character split across chunks", async () => {
    const encoder = new TextEncoder();
    const full = encoder.encode("data: café — done\n\n");
    const cut = 11; // lands inside the two-byte "é"
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(full.slice(0, cut));
        controller.enqueue(full.slice(cut));
        controller.close();
      },
    });
    expect(await collect(stream, { stallTimeoutMs: 1000 })).toEqual([{ data: "café — done" }]);
  });

  test("strips exactly ONE leading space from a field value", async () => {
    const events = await collect(streamOf(["data:  two spaces\n\n", "data:no space\n\n"]), { stallTimeoutMs: 1000 });
    expect(events).toEqual([{ data: " two spaces" }, { data: "no space" }]);
  });

  test("passes `[DONE]` through as ordinary data — the sentinel is the CALLER's to interpret", async () => {
    const events = await collect(streamOf(["data: [DONE]\n\n"]), { stallTimeoutMs: 1000 });
    expect(events).toEqual([{ data: "[DONE]" }]);
  });

  test("flushes a trailing event that arrives without its terminating blank line", async () => {
    // The SSE spec discards an incomplete final block. Winter flushes it deliberately: a provider
    // that closes the connection right after its last `data:` would otherwise silently lose that
    // event, which for an OpenAI-family stream is `[DONE]` — the one that ends the turn.
    const events = await collect(streamOf(["data: last\n"]), { stallTimeoutMs: 1000 });
    expect(events).toEqual([{ data: "last" }]);
  });

  test("ignores an empty stream and a stream of only blank lines", async () => {
    expect(await collect(streamOf([]), { stallTimeoutMs: 1000 })).toEqual([]);
    expect(await collect(streamOf(["\n\n\n\n"]), { stallTimeoutMs: 1000 })).toEqual([]);
  });
});

describe("parseSse — comments and keepalives", () => {
  test("drops `:` comment lines without yielding, but they still count as traffic", async () => {
    // OpenRouter sends `: OPENROUTER PROCESSING` keepalives, and Anthropic sends `event: ping`.
    // A parser that only reset its stall timer on YIELDED events would kill a healthy stream that
    // is doing exactly what the protocol says to do while a slow model thinks.
    const events = await collect(streamOf([": OPENROUTER PROCESSING\n\n", ": keepalive\n\n", "data: real\n\n"]), { stallTimeoutMs: 1000 });
    expect(events).toEqual([{ data: "real" }]);
  });

  test("a keepalive-only stream does NOT stall out", async () => {
    const chunks: Array<string | { delayMs: number; text?: string }> = [];
    for (let i = 0; i < 6; i++) chunks.push({ delayMs: 30, text: ": ping\n\n" });
    chunks.push({ delayMs: 30, text: "data: finally\n\n" });
    const events = await collect(streamOf(chunks), { stallTimeoutMs: 100 });
    expect(events).toEqual([{ data: "finally" }]);
  });

  test("counts EVERY byte through onBytes, comments included", async () => {
    let bytes = 0;
    await collect(streamOf([": ping\n\n", "data: x\n\n"]), { stallTimeoutMs: 1000, onBytes: (n) => (bytes += n) });
    expect(bytes).toBe(new TextEncoder().encode(": ping\n\ndata: x\n\n").byteLength);
  });
});

describe("parseSse — stall and abort", () => {
  test("throws ProviderStallError after stallTimeoutMs of silence", async () => {
    const stream = streamOf(["data: first\n\n", { delayMs: 5000, text: "data: never\n\n" }]);
    const err = await collect(stream, { stallTimeoutMs: 60 }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderStallError);
    expect((err as Error).message).toContain("60");
  });

  test("the stall clock is per-CHUNK, not per-stream — a long but steady stream never trips it", async () => {
    const chunks: Array<string | { delayMs: number; text?: string }> = [];
    for (let i = 0; i < 8; i++) chunks.push({ delayMs: 25, text: `data: ${i}\n\n` });
    const events = await collect(streamOf(chunks), { stallTimeoutMs: 80 });
    expect(events).toHaveLength(8);
  });

  test("an aborted signal ends the generator with an AbortError", async () => {
    const controller = new AbortController();
    const stream = streamOf(["data: first\n\n", { delayMs: 5000, text: "data: never\n\n" }]);
    const iterating = collect(stream, { stallTimeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const err = await iterating.then(() => undefined, (e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });

  test("an ALREADY-aborted signal refuses before it even LOCKS the stream", async () => {
    // Asserting on a `pull` counter would test the platform, not this parser: a ReadableStream with
    // a default queuing strategy pulls once at construction to fill its queue, reader or no reader
    // (measured — the naive version of this test failed with pulls === 1). `locked` is the property
    // that actually distinguishes "parseSse touched this stream" from "it did not", and leaving a
    // stream unlocked is what lets a caller hand it to something else after a pre-aborted attempt.
    const controller = new AbortController();
    controller.abort();
    const stream = streamOf(["data: x\n\n"]);
    await expect(collect(stream, { stallTimeoutMs: 1000, signal: controller.signal })).rejects.toBeDefined();
    expect(stream.locked).toBe(false);
  });

  test("releases the underlying reader when the consumer breaks out early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: a\n\ndata: b\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const _ev of parseSse(stream, { stallTimeoutMs: 1000 })) break;
    // A generator abandoned mid-iteration must not leave a locked reader and a live timer behind:
    // an adapter that gives up on a stream is the normal case (a tool call ends the turn early).
    expect(cancelled).toBe(true);
  });
});

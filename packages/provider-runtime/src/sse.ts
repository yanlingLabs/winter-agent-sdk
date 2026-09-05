// Server-Sent Events parsing with a stall watchdog. FROZEN as of P6 T2's merge (R6-12).
//
// Every provider family in the P6 cohort streams over SSE (Anthropic's `event:`-named frames,
// OpenAI's `data:`-only frames terminated by `[DONE]`, Gemini's JSON-per-event), so this is the one
// framing layer under all of them. It yields RAW `{ event?, data }` pairs and interprets nothing:
// `[DONE]` is passed through as ordinary data because it is an OpenAI-family convention, not an SSE
// one, and an adapter is the right place to know that.
//
// Three details that are easy to get wrong and expensive to get wrong:
//
//   1. THE STALL CLOCK RESETS ON BYTES, NOT ON YIELDED EVENTS. Anthropic sends `event: ping` and
//      OpenRouter sends `: OPENROUTER PROCESSING` comments precisely to hold a connection open while
//      a model thinks. A watchdog that only saw yielded events would kill a healthy stream for doing
//      exactly what the protocol prescribes.
//   2. CHUNK BOUNDARIES FALL ANYWHERE — mid-field-name, mid-CRLF, mid-UTF-8. The decoder runs in
//      streaming mode and the boundary search never treats a lone trailing `\r` as a terminator.
//   3. THE READER IS ALWAYS RELEASED. An adapter abandoning a stream (a tool call ends the turn) is
//      the normal case, not an error path, and a `for await ... break` must not leave a locked
//      reader and a live timer behind.

import { ProviderStallError } from "./errors.ts";

export interface SseOptions {
  /** Milliseconds of TOTAL SILENCE (no bytes at all) after which the stream is abandoned as stalled. */
  stallTimeoutMs: number;
  signal?: AbortSignal;
  /** Called with every chunk's byte count — telemetry counts bytes, never content (Global Constraints). */
  onBytes?: (n: number) => void;
}

export interface SseEvent {
  event?: string;
  data: string;
}

function abortError(): Error {
  const err = new Error("provider stream aborted");
  err.name = "AbortError";
  return err;
}

/** `\r\n\r\n`, `\n\n` or `\r\r`. Ordered so a split `\r\n\r` + `\n` can never be mistaken for a `\r\r` boundary. */
const EVENT_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
const LINE_SPLIT = /\r\n|\n|\r/;

/**
 * Races a read against the stall timeout and the caller's abort signal.
 *
 * The timer is created and cleared per read, so the deadline is "silence since the last byte",
 * never "elapsed since the stream opened" — a long, steady generation must not trip it.
 */
async function readWithStall<T>(
  read: Promise<T>,
  stallTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderStallError(`provider stream produced no bytes for ${stallTimeoutMs}ms`)), stallTimeoutMs);
        if (signal !== undefined) {
          onAbort = () => reject(abortError());
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** Turns one raw block (the text between two event boundaries) into an event, or `undefined` when it carried only comments. */
function parseBlock(block: string): SseEvent | undefined {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(LINE_SPLIT)) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // a comment — a keepalive, by convention
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    // Exactly ONE leading space is stripped from the value, per the SSE spec. `data:  x` is " x".
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    // `id` and `retry` are deliberately dropped: no provider in the P6 cohort uses last-event-id
    // resumption, and a reconnect that replayed a partially-consumed turn would violate R6-6's own
    // no-unsafe-replay rule anyway.
  }
  if (dataLines.length === 0) return undefined;
  return eventName === undefined ? { data: dataLines.join("\n") } : { event: eventName, data: dataLines.join("\n") };
}

export async function* parseSse(body: ReadableStream<Uint8Array>, opts: SseOptions): AsyncGenerator<SseEvent> {
  if (opts.signal?.aborted === true) throw abortError();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await readWithStall(reader.read(), opts.stallTimeoutMs, opts.signal);
      if (chunk.done) break;
      const bytes = chunk.value;
      opts.onBytes?.(bytes.byteLength);
      buffer += decoder.decode(bytes, { stream: true });
      for (;;) {
        const match = EVENT_BOUNDARY.exec(buffer);
        if (match === null) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseBlock(block);
        if (event !== undefined) yield event;
      }
    }
    buffer += decoder.decode();
    // A trailing block with no terminating blank line: the SSE spec discards it, Winter flushes it.
    // A provider that closes right after its last `data:` would otherwise silently lose that event,
    // which for an OpenAI-family stream is `[DONE]` — the one that ends the turn.
    const trailing = parseBlock(buffer);
    if (trailing !== undefined) yield trailing;
  } finally {
    // `cancel()` releases the lock AND signals the source; both matter for an abandoned stream.
    // Swallowing its rejection is deliberate: the stream may already be errored or closed, and a
    // cleanup failure must never replace the real reason the caller stopped.
    void reader.cancel().catch(() => {});
  }
}

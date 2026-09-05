// The AWS event-stream binary framing, decoded by hand. Lane N (Task 9, R6-16).
//
// ConverseStream is NOT SSE. `sse.ts` is the framing layer under every other family in the P6
// cohort; Bedrock answers `application/vnd.amazon.eventstream`, a length-prefixed binary format with
// two CRC-32 checks per message. So this file is to Bedrock what `parseSse` is to everyone else —
// with one deliberate difference in shape, explained below.
//
// THE WIRE FORMAT, in full (every offset big-endian):
//
//   +--------------------------------------------------------------+
//   | total length (4) | headers length (4) | prelude CRC-32 (4)    |   <- the PRELUDE, 12 bytes
//   +--------------------------------------------------------------+
//   | headers (headers length bytes)                                |
//   +--------------------------------------------------------------+
//   | payload (total length - 16 - headers length bytes)             |
//   +--------------------------------------------------------------+
//   | message CRC-32 (4)                                            |
//   +--------------------------------------------------------------+
//
//   The prelude CRC covers the FIRST EIGHT BYTES only (the two lengths). The message CRC covers
//   everything from byte 0 up to but not including itself. One header is `1-byte name length | name
//   | 1-byte value type | value`, and the value's encoding depends on the type (below).
//
// WHY TWO CHECKSUMS, and why this decoder verifies both rather than trusting TCP. The prelude CRC is
// what makes the format self-synchronising: `total length` is read BEFORE anything has been
// validated, so a corrupted length field would otherwise have this decoder wait for — or allocate —
// an arbitrary number of bytes on the strength of four bytes nobody checked. Verifying the prelude
// before honouring its lengths is the whole reason the field exists, and skipping it (a tempting
// simplification, since the message CRC would catch the corruption eventually) converts a detectable
// error into a hang or an allocation the size of whatever the noise happened to say.
//
// WHY A PUSH DECODER RATHER THAN AN ASYNC GENERATOR OVER THE BODY. `parseSse` owns its reader and
// yields events; this one is a PURE INCREMENTAL PARSER that is handed bytes and returns whatever
// messages those bytes completed. The split is what keeps R6-6's stall watchdog honest: the clock
// must reset ON BYTES, not on completed frames (`sse.ts`'s own rule 1), and a single Bedrock frame
// carrying a large image or a long reasoning block legitimately arrives across many chunks with real
// gaps between them. A generator that owned the read loop would have to fold the watchdog in here,
// where "silence" is indistinguishable from "a big frame still arriving". The adapter races each
// `reader.read()` against the deadline and feeds the result in; this file decides nothing about time.

import { crc32 } from "./crc32.ts";

/** The 12-byte prelude plus the 4-byte trailing message CRC: the smallest possible frame carries neither headers nor payload. */
const PRELUDE_BYTES = 12;
const MESSAGE_OVERHEAD_BYTES = 16;

/**
 * AWS's own documented ceilings: 16 MiB per message, 128 KiB of headers. Enforced rather than
 * assumed — `total length` is attacker-controlled in the only sense that matters (it is four bytes
 * off a socket), and a decoder that honoured a 4 GiB length would buffer until the process died.
 * `boundedFetch`'s `maxBodyBytes` bounds the WHOLE response; this bounds one frame.
 */
export const MAX_EVENT_STREAM_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_EVENT_STREAM_HEADER_BYTES = 128 * 1024;

export type EventStreamDecodeErrorCode = "prelude-crc" | "message-crc" | "length" | "header" | "limit";

/** A malformed frame. Carries a CODE rather than only a message so the adapter can normalize it without matching on prose. */
export class EventStreamDecodeError extends Error {
  readonly code: EventStreamDecodeErrorCode;
  constructor(code: EventStreamDecodeErrorCode, message: string) {
    super(message);
    this.name = "EventStreamDecodeError";
    this.code = code;
  }
}

/**
 * A decoded header value.
 *
 * Every AWS header type is decoded, not just the string type Bedrock uses in practice, and that is a
 * robustness decision rather than completeness for its own sake: header parsing is POSITIONAL, so an
 * unrecognised value type has no length and the parser cannot skip past it — one unexpected type
 * byte would desynchronise the rest of the header block and every frame after it. Decoding all ten
 * means an unexpected type is carried, not fatal.
 */
export type EventStreamHeaderValue = boolean | number | bigint | string | Uint8Array;

export interface EventStreamMessage {
  /** Header names are used verbatim (`:message-type`, `:event-type`, `:content-type`) — AWS's are case-sensitive and colon-prefixed. */
  headers: Record<string, EventStreamHeaderValue>;
  payload: Uint8Array;
}

/** Reads one header block. Positional and total: the block is fully consumed or the frame is rejected. */
function decodeHeaders(view: DataView, start: number, end: number): Record<string, EventStreamHeaderValue> {
  const headers: Record<string, EventStreamHeaderValue> = {};
  const decoder = new TextDecoder();
  let offset = start;
  const need = (n: number, what: string): void => {
    if (offset + n > end) throw new EventStreamDecodeError("header", `event-stream header block ended mid-${what}`);
  };
  while (offset < end) {
    need(1, "name length");
    const nameLength = view.getUint8(offset);
    offset += 1;
    need(nameLength, "name");
    const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + offset, nameLength));
    offset += nameLength;
    need(1, "value type");
    const type = view.getUint8(offset);
    offset += 1;
    switch (type) {
      case 0:
        headers[name] = true;
        break;
      case 1:
        headers[name] = false;
        break;
      case 2:
        need(1, "byte value");
        headers[name] = view.getInt8(offset);
        offset += 1;
        break;
      case 3:
        need(2, "short value");
        headers[name] = view.getInt16(offset);
        offset += 2;
        break;
      case 4:
        need(4, "integer value");
        headers[name] = view.getInt32(offset);
        offset += 4;
        break;
      case 5:
        // A LONG stays a bigint. Narrowing it to `number` would silently lose precision above 2^53,
        // and this decoder's job is to report what arrived, not to round it.
        need(8, "long value");
        headers[name] = view.getBigInt64(offset);
        offset += 8;
        break;
      case 6:
      case 7: {
        need(2, "value length");
        const length = view.getUint16(offset);
        offset += 2;
        need(length, type === 7 ? "string value" : "byte-array value");
        const bytes = new Uint8Array(view.buffer.slice(view.byteOffset + offset, view.byteOffset + offset + length));
        headers[name] = type === 7 ? decoder.decode(bytes) : bytes;
        offset += length;
        break;
      }
      case 8:
        need(8, "timestamp value");
        headers[name] = view.getBigInt64(offset);
        offset += 8;
        break;
      case 9: {
        need(16, "uuid value");
        const bytes = new Uint8Array(view.buffer.slice(view.byteOffset + offset, view.byteOffset + offset + 16));
        headers[name] = bytes;
        offset += 16;
        break;
      }
      default:
        // FATAL, and deliberately so — see `EventStreamHeaderValue`'s own note. An unknown type has
        // no length, so there is no safe offset to continue from; guessing would corrupt every
        // header after it and, through the block length, every frame after that.
        throw new EventStreamDecodeError("header", `event-stream header "${name}" has unknown value type ${type}`);
    }
  }
  return headers;
}

export interface EventStreamDecoder {
  /** Feeds bytes in; returns every message those bytes COMPLETED, in order. Throws `EventStreamDecodeError` on a malformed frame. */
  push(chunk: Uint8Array): EventStreamMessage[];
  /** Bytes held back as a partial frame. `> 0` at end-of-stream means the response was truncated. */
  pending(): number;
}

/**
 * An incremental event-stream decoder.
 *
 * BUFFERS BY CONCATENATION, deliberately, rather than keeping a chunk list and a cursor. A frame is
 * bounded at 16 MiB and the common one is a few hundred bytes, so the copy is not where a streaming
 * turn spends its time — and the alternative (a rope with cross-chunk reads) is exactly the kind of
 * index arithmetic that produces a decoder which works until a frame lands on a chunk boundary in
 * the one place nobody tested. `eventstream.test.ts` feeds a frame BYTE BY BYTE for that reason.
 */
export function createEventStreamDecoder(): EventStreamDecoder {
  let buffer = new Uint8Array(0);

  return {
    push(chunk: Uint8Array): EventStreamMessage[] {
      if (chunk.length > 0) {
        const merged = new Uint8Array(buffer.length + chunk.length);
        merged.set(buffer, 0);
        merged.set(chunk, buffer.length);
        buffer = merged;
      }

      const messages: EventStreamMessage[] = [];
      for (;;) {
        if (buffer.length < PRELUDE_BYTES) break;
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const totalLength = view.getUint32(0);
        const headersLength = view.getUint32(4);
        const declaredPreludeCrc = view.getUint32(8);

        // THE PRELUDE CRC IS CHECKED BEFORE EITHER LENGTH IS HONOURED. See the file header: this is
        // the check that stops four corrupted bytes from becoming a multi-gigabyte wait.
        const actualPreludeCrc = crc32(buffer.subarray(0, 8));
        if (actualPreludeCrc !== declaredPreludeCrc) {
          throw new EventStreamDecodeError(
            "prelude-crc",
            `event-stream prelude CRC mismatch: the frame declared ${declaredPreludeCrc} and the bytes compute to ${actualPreludeCrc}`,
          );
        }
        if (totalLength > MAX_EVENT_STREAM_MESSAGE_BYTES) {
          throw new EventStreamDecodeError("limit", `event-stream frame declares ${totalLength} bytes, above the ${MAX_EVENT_STREAM_MESSAGE_BYTES}-byte limit`);
        }
        if (headersLength > MAX_EVENT_STREAM_HEADER_BYTES) {
          throw new EventStreamDecodeError("limit", `event-stream frame declares ${headersLength} header bytes, above the ${MAX_EVENT_STREAM_HEADER_BYTES}-byte limit`);
        }
        if (totalLength < MESSAGE_OVERHEAD_BYTES + headersLength) {
          throw new EventStreamDecodeError(
            "length",
            `event-stream frame declares ${totalLength} total bytes, which cannot hold its own ${MESSAGE_OVERHEAD_BYTES}-byte framing plus ${headersLength} header bytes`,
          );
        }
        // NOT an error — just not here yet. This is the ordinary case for every frame that spans a
        // chunk boundary, which for a large frame is most of them.
        if (buffer.length < totalLength) break;

        const declaredMessageCrc = view.getUint32(totalLength - 4);
        const actualMessageCrc = crc32(buffer.subarray(0, totalLength - 4));
        if (actualMessageCrc !== declaredMessageCrc) {
          throw new EventStreamDecodeError(
            "message-crc",
            `event-stream message CRC mismatch: the frame declared ${declaredMessageCrc} and the bytes compute to ${actualMessageCrc}`,
          );
        }

        const headers = decodeHeaders(view, PRELUDE_BYTES, PRELUDE_BYTES + headersLength);
        // COPIED out of the buffer rather than viewed into it: the buffer is re-sliced on the next
        // line and reassigned on every push, so a view would alias bytes this decoder no longer owns.
        const payload = buffer.slice(PRELUDE_BYTES + headersLength, totalLength - 4);
        messages.push({ headers, payload });
        buffer = buffer.slice(totalLength);
      }
      return messages;
    },

    pending(): number {
      return buffer.length;
    },
  };
}

/** The `:message-type` values AWS defines. `event` is a stream item; the other two are terminal failures. */
export type EventStreamMessageType = "event" | "exception" | "error";

/** A header read as a string, or `undefined` when absent or of another type. The accessor every caller should use — a header's TYPE is wire data, not an assumption. */
export function stringHeader(message: EventStreamMessage, name: string): string | undefined {
  const value = message.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The frame's `:message-type`, defaulting to `event`.
 *
 * The default is the documented behaviour rather than leniency: AWS's own decoders treat an absent
 * `:message-type` as an event, and Bedrock's happy path is entirely events.
 */
export function messageType(message: EventStreamMessage): EventStreamMessageType {
  const raw = stringHeader(message, ":message-type");
  return raw === "exception" || raw === "error" ? raw : "event";
}

/**
 * The frame's payload as parsed JSON, or `undefined` when it is not JSON at all.
 *
 * `undefined` rather than a throw, because the two cases have different meanings to the adapter: a
 * frame whose payload is unparseable is a `bad_request`-class provider failure (corpus case
 * `error-malformed`), while an EMPTY payload is legitimate — `contentBlockStop` and the exception
 * frames carry nothing.
 */
export function jsonPayload(message: EventStreamMessage): Record<string, unknown> | undefined {
  if (message.payload.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(message.payload)) as unknown;
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

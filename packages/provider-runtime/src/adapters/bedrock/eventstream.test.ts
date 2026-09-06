import { describe, expect, test } from "bun:test";
import { crc32 } from "./crc32.ts";
import { EventStreamDecodeError, createEventStreamDecoder, jsonPayload, messageType, stringHeader, type EventStreamHeaderValue } from "./eventstream.ts";
import { concatFrames, converseStreamEvent, converseStreamException, encodeEventStreamMessage } from "./testing.ts";

/**
 * THE REFERENCE FRAME, byte for byte, from an INDEPENDENT implementation.
 *
 * Built by Python (`struct.pack` for the big-endian lengths, `zlib.crc32` for both checksums) from
 * exactly the inputs the first test restates. Its 148 bytes are what stop this file from being a
 * round-trip through one author's own arithmetic: a wrong endianness, a wrong prelude span, a wrong
 * CRC polynomial or a wrong header encoding would each round-trip perfectly through
 * `testing.ts` -> `eventstream.ts` and fail this constant.
 */
const REFERENCE_FRAME_HEX =
  "0000009400000057b4ab9aee0d3a6d6573736167652d747970650700056576656e740b3a6576656e742d74797065070011636f6e74656e74426c6f636b44656c74610d3a636f6e74656e742d747970650700106170706c69636174696f6e2f6a736f6e7b22636f6e74656e74426c6f636b496e646578223a302c2264656c7461223a7b2274657874223a224869227d7d5db19242";

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the AWS event-stream frame encoding", () => {
  test("our encoder reproduces a frame built by Python's struct + zlib.crc32, byte for byte", () => {
    const built = encodeEventStreamMessage(
      [
        { name: ":message-type", value: "event" },
        { name: ":event-type", value: "contentBlockDelta" },
        { name: ":content-type", value: "application/json" },
      ],
      new TextEncoder().encode('{"contentBlockIndex":0,"delta":{"text":"Hi"}}'),
    );
    expect(toHex(built)).toBe(REFERENCE_FRAME_HEX);
    // And the lengths the prelude declares are the real ones: 148 total, 87 of headers.
    expect(built.length).toBe(148);
    expect(new DataView(built.buffer).getUint32(0)).toBe(148);
    expect(new DataView(built.buffer).getUint32(4)).toBe(87);
  });

  test("the reference bytes decode to the event they encode", () => {
    const decoder = createEventStreamDecoder();
    const [message] = decoder.push(fromHex(REFERENCE_FRAME_HEX));
    expect(message).toBeDefined();
    expect(stringHeader(message!, ":event-type")).toBe("contentBlockDelta");
    expect(messageType(message!)).toBe("event");
    expect(jsonPayload(message!)).toEqual({ contentBlockIndex: 0, delta: { text: "Hi" } });
    expect(decoder.pending()).toBe(0);
  });
});

describe("createEventStreamDecoder", () => {
  test("decodes several frames delivered in one chunk, in order", () => {
    const decoder = createEventStreamDecoder();
    const messages = decoder.push(
      concatFrames([
        converseStreamEvent("messageStart", { role: "assistant" }),
        converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "one" } }),
        converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "two" } }),
        converseStreamEvent("messageStop", { stopReason: "end_turn" }),
      ]),
    );
    expect(messages.map((m) => stringHeader(m, ":event-type"))).toEqual(["messageStart", "contentBlockDelta", "contentBlockDelta", "messageStop"]);
    expect(messages.map((m) => (jsonPayload(m)?.delta as { text?: string } | undefined)?.text)).toEqual([undefined, "one", "two", undefined]);
  });

  test("a frame delivered ONE BYTE AT A TIME decodes identically, and completes only on its last byte", () => {
    // The boundary case a buffering decoder gets wrong: a chunk can end mid-prelude, mid-header
    // name, mid-length or mid-payload, and every one of those splits happens here.
    const frame = converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "split" } });
    const decoder = createEventStreamDecoder();
    let completed = 0;
    for (let i = 0; i < frame.length; i++) {
      const out = decoder.push(frame.subarray(i, i + 1));
      completed += out.length;
      if (i < frame.length - 1) {
        expect(out).toHaveLength(0);
        expect(decoder.pending()).toBe(i + 1);
      } else {
        expect(out).toHaveLength(1);
        expect(jsonPayload(out[0]!)).toEqual({ contentBlockIndex: 0, delta: { text: "split" } });
      }
    }
    expect(completed).toBe(1);
    expect(decoder.pending()).toBe(0);
  });

  test("a chunk carrying one and a half frames yields the whole one and holds the remainder", () => {
    const first = converseStreamEvent("messageStart", { role: "assistant" });
    const second = converseStreamEvent("messageStop", { stopReason: "end_turn" });
    const decoder = createEventStreamDecoder();
    const half = second.subarray(0, 20);
    const firstBatch = decoder.push(concatFrames([first, new Uint8Array(half)]));
    expect(firstBatch).toHaveLength(1);
    expect(decoder.pending()).toBe(20);
    const secondBatch = decoder.push(second.subarray(20));
    expect(secondBatch).toHaveLength(1);
    expect(stringHeader(secondBatch[0]!, ":event-type")).toBe("messageStop");
    expect(decoder.pending()).toBe(0);
  });

  test("a CORRUPTED PAYLOAD is caught by the message CRC", () => {
    const frame = converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } });
    const corrupted = new Uint8Array(frame);
    // Flip a bit inside the JSON payload, leaving both declared lengths and the prelude CRC intact —
    // so ONLY the message CRC can catch it.
    corrupted[corrupted.length - 6] = corrupted[corrupted.length - 6]! ^ 0x01;
    const decoder = createEventStreamDecoder();
    let thrown: unknown;
    try {
      decoder.push(corrupted);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EventStreamDecodeError);
    expect((thrown as EventStreamDecodeError).code).toBe("message-crc");
  });

  test("a CORRUPTED LENGTH FIELD is caught by the prelude CRC, BEFORE the length is honoured", () => {
    // The check that matters most: without it, these four bytes would make the decoder wait for
    // 0x7F000094 bytes that will never arrive — a hang, not an error.
    const frame = converseStreamEvent("messageStart", { role: "assistant" });
    const corrupted = new Uint8Array(frame);
    corrupted[0] = 0x7f;
    const decoder = createEventStreamDecoder();
    let thrown: unknown;
    try {
      decoder.push(corrupted);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EventStreamDecodeError);
    expect((thrown as EventStreamDecodeError).code).toBe("prelude-crc");
  });

  test("a frame whose declared total cannot hold its own framing is rejected as a length error", () => {
    // Built by hand so the prelude CRC is VALID and only the length relationship is wrong —
    // otherwise the prelude check would mask this one and the branch would be untested.
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 16);
    view.setUint32(4, 40); // 40 header bytes inside a 16-byte frame: impossible.
    view.setUint32(8, crc32(bytes.subarray(0, 8)));
    const decoder = createEventStreamDecoder();
    let thrown: unknown;
    try {
      decoder.push(bytes);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EventStreamDecodeError);
    expect((thrown as EventStreamDecodeError).code).toBe("length");
  });

  test("an exception frame is typed as such and carries its :exception-type", () => {
    const decoder = createEventStreamDecoder();
    const [message] = decoder.push(converseStreamException("ThrottlingException", { message: "slow down" }));
    expect(messageType(message!)).toBe("exception");
    expect(stringHeader(message!, ":exception-type")).toBe("ThrottlingException");
    expect(jsonPayload(message!)).toEqual({ message: "slow down" });
  });

  test("an empty payload parses as an empty object, an unparseable one as undefined", () => {
    const decoder = createEventStreamDecoder();
    const [stop] = decoder.push(encodeEventStreamMessage([{ name: ":event-type", value: "contentBlockStop" }], new Uint8Array(0)));
    expect(jsonPayload(stop!)).toEqual({});
    const [broken] = decoder.push(encodeEventStreamMessage([{ name: ":event-type", value: "contentBlockDelta" }], new TextEncoder().encode("{not json")));
    // `undefined` and not a throw: the adapter needs to tell "no payload" (legitimate) from
    // "unparseable payload" (a provider failure) and they must not collapse.
    expect(jsonPayload(broken!)).toBeUndefined();
  });

  test("every AWS header value type decodes to its own JavaScript value", () => {
    // Review r1/M10: types 2-6, 8 and 9 were implemented and untested. They are not decoration —
    // header parsing is POSITIONAL, so a type whose LENGTH this decoder gets wrong desynchronises
    // every header after it and, through the block length, every frame after that. Each row below is
    // one type byte, its encoded value bytes, and what it must decode to.
    const cases: Array<{ name: string; type: number; value: number[]; expected: EventStreamHeaderValue }> = [
      { name: "t0", type: 0, value: [], expected: true },
      { name: "t1", type: 1, value: [], expected: false },
      { name: "t2", type: 2, value: [0xff], expected: -1 },                                  // byte, SIGNED
      { name: "t3", type: 3, value: [0xff, 0xfe], expected: -2 },                            // short, signed
      { name: "t4", type: 4, value: [0x00, 0x00, 0x01, 0x00], expected: 256 },               // integer
      { name: "t5", type: 5, value: [0, 0, 0, 0, 0, 0, 0x01, 0x00], expected: 256n },        // long, a bigint
      { name: "t6", type: 6, value: [0x00, 0x02, 0xde, 0xad], expected: new Uint8Array([0xde, 0xad]) }, // byte array
      { name: "t8", type: 8, value: [0, 0, 0, 0, 0, 0, 0x01, 0x00], expected: 256n },        // timestamp
      { name: "t9", type: 9, value: [...Array(16).keys()], expected: new Uint8Array([...Array(16).keys()]) }, // uuid
    ];

    // ONE frame carrying ALL of them, in order: that is what proves each type's length is right,
    // because a single wrong length corrupts every header after it rather than only its own.
    const headerBytes: number[] = [];
    for (const c of cases) {
      const name = new TextEncoder().encode(c.name);
      headerBytes.push(name.length, ...name, c.type, ...c.value);
    }
    const payload = new TextEncoder().encode("{}");
    const total = 16 + headerBytes.length + payload.length;
    const frame = new Uint8Array(total);
    const view = new DataView(frame.buffer);
    view.setUint32(0, total);
    view.setUint32(4, headerBytes.length);
    view.setUint32(8, crc32(frame.subarray(0, 8)));
    frame.set(headerBytes, 12);
    frame.set(payload, 12 + headerBytes.length);
    view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));

    const [message] = createEventStreamDecoder().push(frame);
    expect(message).toBeDefined();
    for (const c of cases) expect(message!.headers[c.name]).toEqual(c.expected);
    // The block was consumed EXACTLY: a wrong length would leave a trailing name or swallow one.
    expect(Object.keys(message!.headers).sort()).toEqual(cases.map((c) => c.name).sort());
    expect(jsonPayload(message!)).toEqual({});
  });

  test("an UNKNOWN header value type is fatal rather than silently desynchronising the block", () => {
    // The other half of the positional argument: an unknown type has no length, so there is no safe
    // offset to continue from. Guessing would corrupt every header after it.
    const name = new TextEncoder().encode("weird");
    const headerBytes = [name.length, ...name, 0x7f];
    const total = 16 + headerBytes.length;
    const frame = new Uint8Array(total);
    const view = new DataView(frame.buffer);
    view.setUint32(0, total);
    view.setUint32(4, headerBytes.length);
    view.setUint32(8, crc32(frame.subarray(0, 8)));
    frame.set(headerBytes, 12);
    view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)));
    let thrown: unknown;
    try {
      createEventStreamDecoder().push(frame);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EventStreamDecodeError);
    expect((thrown as EventStreamDecodeError).code).toBe("header");
  });

  test("a non-string header value never masquerades as a string", () => {
    const decoder = createEventStreamDecoder();
    // A boolean-true header (type 0), which carries no bytes at all.
    const frame = new Uint8Array(16 + 8);
    const view = new DataView(frame.buffer);
    const name = new TextEncoder().encode(":flag");
    view.setUint32(0, frame.length);
    view.setUint32(4, 7);
    view.setUint32(8, crc32(frame.subarray(0, 8)));
    view.setUint8(12, name.length);
    frame.set(name, 13);
    view.setUint8(18, 0);
    view.setUint32(frame.length - 4, crc32(frame.subarray(0, frame.length - 4)));
    const [message] = decoder.push(frame);
    expect(message!.headers[":flag"]).toBe(true);
    expect(stringHeader(message!, ":flag")).toBeUndefined();
  });
});

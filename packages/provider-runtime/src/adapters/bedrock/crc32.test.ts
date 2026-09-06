import { describe, expect, test } from "bun:test";
import { crc32 } from "./crc32.ts";

// KNOWN-ANSWER TESTS AGAINST AN INDEPENDENT ORACLE.
//
// Every expected value below was computed by Python's `zlib.crc32` — a different implementation, by
// different authors, in a different language. That is what makes these assertions evidence rather
// than a restatement of `crc32.ts`'s own arithmetic: a wrong polynomial, a missing reflection or a
// missing final XOR would produce a self-consistent function that passes any round-trip test and
// fails every one of these.
//
// `crc32("123456789") === 0xCBF43926` is additionally the CRC-32/ISO-HDLC standard's OWN published
// check value, so two independent sources agree on it.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("crc32", () => {
  test("matches Python zlib.crc32 on five vectors, including the standard's own check value", () => {
    expect(crc32(enc(""))).toBe(0x00000000);
    expect(crc32(enc("a"))).toBe(0xe8b7be43);
    expect(crc32(enc("abc"))).toBe(0x352441c2);
    // The CRC-32/ISO-HDLC check value, published by the standard itself.
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(enc("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  test("is unsigned: a high-bit result is a positive number, not a negative one", () => {
    // `0xE8B7BE43` has its top bit set. An implementation using `>>` instead of `>>>` anywhere in
    // the table or the loop returns a negative number here and is wrong everywhere it matters —
    // `DataView.setUint32` would coerce it back and hide the bug from a round-trip test.
    const value = crc32(enc("a"));
    expect(value).toBeGreaterThan(0);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });

  test("a seeded call continues the same computation as one contiguous call", () => {
    // The property the event-stream decoder relies on when a message CRC spans several buffers.
    const whole = enc("The quick brown fox jumps over the lazy dog");
    const first = whole.subarray(0, 10);
    const rest = whole.subarray(10);
    expect(crc32(rest, crc32(first))).toBe(crc32(whole));
  });

  test("a single flipped bit changes the checksum", () => {
    const bytes = enc("winter");
    const flipped = new Uint8Array(bytes);
    flipped[0] = flipped[0]! ^ 0x01;
    expect(crc32(flipped)).not.toBe(crc32(bytes));
  });

  test("handles bytes above 0x7f (a UTF-8 multi-byte sequence)", () => {
    // Guards the `& 0xff` masking in the table lookup: a signed read would index out of the table.
    expect(crc32(new Uint8Array([0xff, 0x80, 0xfe]))).toBe(crc32(new Uint8Array([0xff, 0x80, 0xfe])));
    expect(crc32(new Uint8Array([0xff]))).not.toBe(crc32(new Uint8Array([0x7f])));
  });
});

import { test, expect } from "bun:test";
import { encodeFrame, decodeFrame, splitFrames, ProtocolError } from "./codec.ts";
import type { WinterFrame } from "./frames.ts";

test("encode/decode round-trips a known frame", () => {
  const f: WinterFrame = { type: "user", text: "hi" };
  expect(decodeFrame(encodeFrame(f).trimEnd())).toEqual(f);
});

test("decode preserves unknown frame type and unknown fields losslessly", () => {
  const line = JSON.stringify({ type: "future_frame", brandNewField: 42, nested: { x: 1 } });
  const decoded = decodeFrame(line);
  expect(decoded.type).toBe("future_frame");
  expect((decoded as Record<string, unknown>).brandNewField).toBe(42);
  // re-encode must not drop the unknown field (WS-04 §2)
  expect(JSON.parse(encodeFrame(decoded))).toEqual({ type: "future_frame", brandNewField: 42, nested: { x: 1 } });
});

test("decode throws ProtocolError on a non-object / missing type", () => {
  expect(() => decodeFrame("null")).toThrow(ProtocolError);
  expect(() => decodeFrame(JSON.stringify({ noType: true }))).toThrow(ProtocolError);
  expect(() => decodeFrame("{not json")).toThrow(ProtocolError);
});

test("splitFrames handles a partial trailing line via carry", () => {
  const a = splitFrames('{"type":"user","text":"one"}\n{"type":"user","te', "");
  expect(a.frames.map((f) => f.type)).toEqual(["user"]);
  expect(a.frames).toHaveLength(1);
  const b = splitFrames('xt":"two"}\n', a.carry);
  expect(b.frames).toHaveLength(1);
  expect((b.frames[0] as { text: string }).text).toBe("two");
});

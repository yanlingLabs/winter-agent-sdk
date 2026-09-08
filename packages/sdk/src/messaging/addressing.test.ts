import { describe, test, expect } from "bun:test";
import {
  validateToField,
  parseRuntimeAddress,
  buildSessionAddress,
  buildChildAddress,
  sameAddress,
} from "./addressing.ts";

describe("validateToField (WS-10 §10.1)", () => {
  test("accepts an ordinary short string", () => {
    expect(validateToField("agent-foo")).toEqual({ ok: true });
  });
  test("rejects non-string input", () => {
    expect(validateToField(42)).toEqual({ ok: false, message: "to must be a non-empty string" });
  });
  test("rejects an empty string", () => {
    expect(validateToField("")).toEqual({ ok: false, message: "to must be a non-empty string" });
  });
  test("rejects over 300 characters", () => {
    const long = "a".repeat(301);
    const result = validateToField(long);
    expect(result.ok).toBe(false);
  });
  test("accepts exactly 300 characters", () => {
    expect(validateToField("a".repeat(300))).toEqual({ ok: true });
  });
  test("rejects a newline", () => {
    expect(validateToField("foo\nbar").ok).toBe(false);
  });
  test("rejects a carriage return", () => {
    expect(validateToField("foo\rbar").ok).toBe(false);
  });
  test('rejects "*" anywhere ("*" broadcast forbidden)', () => {
    expect(validateToField("*").ok).toBe(false);
    expect(validateToField("team-*").ok).toBe(false);
  });
});

describe("parseRuntimeAddress / buildSessionAddress / buildChildAddress round-trip (WS-10 §11)", () => {
  test("a session address round-trips through the opaque string form", () => {
    const addr = buildSessionAddress("s_abc");
    expect(parseRuntimeAddress("session:s_abc")).toEqual(addr);
  });
  test("an agent address round-trips through the opaque string form", () => {
    const addr = buildChildAddress("s_abc", "child-1");
    expect(parseRuntimeAddress("agent:s_abc:child-1")).toEqual(addr);
  });
  test("a plain display name is not a canonical address (returns undefined)", () => {
    expect(parseRuntimeAddress("researcher")).toBeUndefined();
  });
  test("a bare child id with no prefix is not a canonical address", () => {
    expect(parseRuntimeAddress("child-1")).toBeUndefined();
  });
  test("malformed session: form (empty id) returns undefined", () => {
    expect(parseRuntimeAddress("session:")).toBeUndefined();
  });
  test("malformed agent: form (missing childId) returns undefined", () => {
    expect(parseRuntimeAddress("agent:s_abc:")).toBeUndefined();
  });
  test("malformed agent: form (missing parent) returns undefined", () => {
    expect(parseRuntimeAddress("agent::child-1")).toBeUndefined();
  });
  test("malformed agent: form (no colon separator at all) returns undefined", () => {
    expect(parseRuntimeAddress("agent:onlyonesegment")).toBeUndefined();
  });
  test("garbage input returns undefined", () => {
    expect(parseRuntimeAddress("not-an-address-at-all")).toBeUndefined();
  });
});

describe("sameAddress (self-target detection, WS-10 §16)", () => {
  test("two structurally identical session addresses are the same", () => {
    expect(sameAddress(buildSessionAddress("s_abc"), buildSessionAddress("s_abc"))).toBe(true);
  });
  test("two different session ids are not the same", () => {
    expect(sameAddress(buildSessionAddress("s_abc"), buildSessionAddress("s_xyz"))).toBe(false);
  });
  test("two structurally identical agent addresses are the same even if only one carries an explicit parentWinterSessionId", () => {
    const a = buildChildAddress("s_abc", "child-1");
    const b = { objectKind: "agent" as const, runtimeKind: "winter-agent" as const, winterSessionId: "s_abc", childId: "child-1" };
    expect(sameAddress(a, b)).toBe(true);
  });
  test("a session address and an agent address are never the same", () => {
    expect(sameAddress(buildSessionAddress("s_abc"), buildChildAddress("s_abc", "child-1"))).toBe(false);
  });
  test("a malformed address (agent with no childId) is safely not-equal rather than throwing", () => {
    const malformed = { objectKind: "agent" as const, runtimeKind: "winter-agent" as const, winterSessionId: "s_abc" };
    expect(sameAddress(malformed, buildSessionAddress("s_abc"))).toBe(false);
  });
});

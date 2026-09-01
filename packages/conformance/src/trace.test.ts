import { test, expect } from "bun:test";
import { normalizeTrace, compareTraces } from "./trace.ts";
import type { ConformanceTraceEntry } from "./trace.ts";

const raw: ConformanceTraceEntry[] = [
  { sequence: 0, direction: "runtime-to-host", kind: "system/init", payload: { session_id: "s_abc", model: "sonnet" } },
  { sequence: 1, direction: "runtime-to-host", kind: "assistant", payload: { text: "echo: hi" } },
  { sequence: 2, direction: "runtime-to-host", kind: "result", payload: { subtype: "success", total_cost_usd: 0.001 } },
];

test("normalizeTrace strips volatile ids/costs but keeps kind + order + error subtype", () => {
  const n = normalizeTrace(raw);
  expect(n.map((e) => e.kind)).toEqual(["system/init", "assistant", "result"]);
  expect((n[0]!.payload as Record<string, unknown>).session_id).toBeUndefined(); // volatile id stripped
  expect((n[2]!.payload as Record<string, unknown>).total_cost_usd).toBeUndefined(); // cost stripped
  expect((n[2]!.payload as Record<string, unknown>).subtype).toBe("success"); // subtype PRESERVED (never hidden)
});

test("compareTraces detects an ordering/discriminator difference", () => {
  const a = normalizeTrace(raw);
  const swapped = [raw[0]!, raw[2]!, raw[1]!].map((e, i) => ({ ...e, sequence: i }));
  expect(compareTraces(a, normalizeTrace(swapped)).length).toBeGreaterThan(0);
});

test("compareTraces detects a payload difference at the same kind", () => {
  const a = normalizeTrace([{ sequence: 0, direction: "runtime-to-host", kind: "result", payload: { subtype: "success" } }]);
  const b = normalizeTrace([{ sequence: 0, direction: "runtime-to-host", kind: "result", payload: { subtype: "error_during_execution" } }]);
  const diffs = compareTraces(a, b);
  expect(diffs.length).toBeGreaterThan(0);
  expect(diffs[0]).toContain("payload@0");
});

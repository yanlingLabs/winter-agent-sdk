export interface ConformanceTraceEntry {
  sequence: number;
  direction: "runtime-to-host" | "host-to-runtime" | "callback" | "process";
  kind: string; payload: unknown;
  timestampClass?: "before" | "same-boundary" | "after";
}
const VOLATILE = new Set(["session_id", "sessionId", "uuid", "toolUseID", "requestId", "total_cost_usd", "duration_ms", "durationMs", "timestamp"]);

export function normalizeTrace(entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] {
  return entries.map((e, i) => ({ ...e, sequence: i, payload: strip(e.payload) }));
}
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (!VOLATILE.has(k)) out[k] = strip(val);
    return out;
  }
  return v;
}
// Comparison-time-only canonicalization (Task 11): recursively sorts object keys before
// stringifying so two payloads built in different key orders (e.g. two independent producers, or
// the same producer across a refactor that reorders an object literal/spread) never register as a
// spurious diff. Deliberately NOT used by normalizeTrace or anywhere a golden is written to disk —
// committed goldens keep whatever key order their producer emitted; only the comparison below is
// order-insensitive.
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
function canonicalStringify(v: unknown): string {
  return JSON.stringify(sortKeysDeep(v));
}

export function compareTraces(a: ConformanceTraceEntry[], b: ConformanceTraceEntry[]): string[] {
  const diffs: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (!x || !y) { diffs.push(`length mismatch at ${i}`); continue; }
    if (x.kind !== y.kind) diffs.push(`kind@${i}: ${x.kind} != ${y.kind}`);
    if (canonicalStringify(x.payload) !== canonicalStringify(y.payload)) diffs.push(`payload@${i} (${x.kind}) differs`);
  }
  return diffs;
}

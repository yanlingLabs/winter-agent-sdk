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
export function compareTraces(a: ConformanceTraceEntry[], b: ConformanceTraceEntry[]): string[] {
  const diffs: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (!x || !y) { diffs.push(`length mismatch at ${i}`); continue; }
    if (x.kind !== y.kind) diffs.push(`kind@${i}: ${x.kind} != ${y.kind}`);
    if (JSON.stringify(x.payload) !== JSON.stringify(y.payload)) diffs.push(`payload@${i} (${x.kind}) differs`);
  }
  return diffs;
}

import { query } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import { normalizeTrace, compareTraces, type ConformanceTraceEntry } from "winter-conformance/trace";
import { readFileSync } from "node:fs";

export async function traceWinterPlainQuery(): Promise<ConformanceTraceEntry[]> {
  const entries: ConformanceTraceEntry[] = [];
  let seq = 0;
  // cwd is pinned to a synthetic constant (never process.cwd()'s default) so the recorded trace —
  // and the committed golden compared against it — is byte-identical across machines and CI
  // runners, whose checkout paths differ. The in-memory runtime never touches the filesystem with
  // it (WS-17 §4: differential traces must be deterministic).
  for await (const msg of query({
    prompt: "hi",
    options: { model: "sonnet", cwd: "/winter-fixture", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) },
  })) {
    const kind = msg.type === "system" ? `system/${(msg as { subtype: string }).subtype}` : msg.type;
    entries.push({ sequence: seq++, direction: "runtime-to-host", kind, payload: msg });
  }
  return normalizeTrace(entries);
}

if (import.meta.main) {
  const winter = await traceWinterPlainQuery();
  const golden = JSON.parse(readFileSync(new URL("../packages/conformance/goldens/plain-query.trace.json", import.meta.url), "utf8"));
  const diffs = compareTraces(winter, golden);
  if (diffs.length) { console.error("DIFFERENTIAL FAIL:\n" + diffs.join("\n")); process.exit(1); }
  console.log("differential OK: winter plain-query matches golden");
}

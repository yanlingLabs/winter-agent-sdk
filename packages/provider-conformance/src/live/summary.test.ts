// P6.5 Lane L (WS-13b §7): the per-target row's shape and its output discipline.
//
// SAFE TO RUN UNDER `bun test`, and the reason is structural rather than a promise: every function
// under test is PURE over a finished `LiveReport` value. No adapter, no endpoint, no clock and no
// credential is constructed anywhere in this file, so the rule stated in `index.ts`'s header — a
// fixture that drives the live cases must pin BOTH the endpoint and the adapter — does not arise
// here, because nothing in this file drives them.
//
// What it is FOR: `formatLiveRow` is the one line of this gate's output most likely to be pasted
// into a report or a commit message, which makes "identifiers, a verdict, a duration and Winter's
// own identity — and nothing else" a property worth pinning rather than trusting to review.
import { test, expect, describe } from "bun:test";
import { formatLiveRow, liveRowSummary, type LiveReport } from "./index.ts";

/** A finished report, built by hand. The `detail` strings are what a real run's cases produce. */
function report(overrides: Partial<LiveReport> = {}): LiveReport {
  return {
    providerId: "aihorde",
    adapterId: "winter.openai-chat",
    adapterVersion: "1.0.0",
    modelKey: "aihorde/koboldcpp",
    outcomes: [
      { id: "discovery", status: "ok", detail: "3 model id(s), partial=false, cached=false, warnings=0", ms: 120 },
      { id: "text-turn", status: "ok", detail: "stopReason=stop, textBytes=6, usage=12 in / 3 out", ms: 800 },
      { id: "tool-round", status: "ok", detail: "calls=1, argumentBytes=13, parseable=true, stopReason=tool_use", ms: 900 },
      { id: "thinking-summary", status: "skipped", detail: "the descriptor records no reasoning support for this model", ms: 0 },
      { id: "count-tokens", status: "skipped", detail: "this adapter offers no countTokens (R6-15: post_tokens is then omitted, never estimated)", ms: 0 },
    ],
    ok: true,
    ...overrides,
  };
}

describe("WS-13b §7: the per-target live row", () => {
  test("folds a finished report into identifiers, a verdict, a summed duration and Winter's own identity", () => {
    expect(liveRowSummary(report(), { kind: "keyless", identityHeader: "winter-agent-sdk/0.0.1" })).toEqual({
      providerId: "aihorde",
      model: "aihorde/koboldcpp",
      kind: "keyless",
      ok: true,
      latencyMs: 1820,
      toolCallOk: true,
      identityHeader: "winter-agent-sdk/0.0.1",
    });
  });

  test("`model` is the CATALOG KEY, so a row says which catalog row it is evidence for -- never the provider-local id", () => {
    // The distinction that matters when a `_MODEL` override is in play: the wire carries the local
    // id, the row names the key, and only the key identifies a row to promote from `candidate`.
    const row = liveRowSummary(report({ modelKey: "xai-oauth/grok-4" }), { kind: "oauth", identityHeader: "winter-agent-sdk/0.0.1" });
    expect(row.model).toBe("xai-oauth/grok-4");
  });

  test("`toolCallOk` is false when the tool round was SKIPPED, not only when it failed -- the column answers `can this row be driven agentically?`", () => {
    const skipped = report({
      outcomes: report().outcomes.map((o) => (o.id === "tool-round" ? { ...o, status: "skipped" as const, detail: 'the descriptor\'s tool calling is "none"' } : o)),
    });
    expect(liveRowSummary(skipped, { kind: "api-key", identityHeader: "winter-agent-sdk/0.0.1" }).toolCallOk).toBe(false);
    // ...and the report is still `ok`, because a skip is a capability fact and not a failure. The two
    // columns say different things and a reader needs both.
    expect(liveRowSummary(skipped, { kind: "api-key", identityHeader: "winter-agent-sdk/0.0.1" }).ok).toBe(true);
  });

  test("a failed run is `ok=false` with the latency it actually spent -- a gate that reported 0ms for a timeout would hide the one symptom that matters", () => {
    const failed = report({
      ok: false,
      outcomes: [{ id: "text-turn", status: "failed", detail: "the stream never reported a stop reason", ms: 60_000 }],
    });
    const row = liveRowSummary(failed, { kind: "api-key", identityHeader: "winter-agent-sdk/0.0.1" });
    expect([row.ok, row.latencyMs, row.toolCallOk]).toEqual([false, 60_000, false]);
  });

  test("the formatted line carries every field as `key=value`, and NOTHING a provider returned", () => {
    const line = formatLiveRow(liveRowSummary(report(), { kind: "keyless", identityHeader: "winter-agent-sdk/0.0.1" }));
    expect(line.trim()).toBe("live-row providerId=aihorde model=aihorde/koboldcpp kind=keyless ok=true latencyMs=1820 toolCallOk=true identityHeader=winter-agent-sdk/0.0.1");
    // The negative half, and the one with teeth: every case's `detail` is Winter-authored measurement
    // text, but it is still per-case narrative, and none of it belongs on the row. Asserting the
    // exact line above already implies this; asserting it by CONTENT is what survives the line being
    // reordered or extended later.
    for (const outcome of report().outcomes) expect(line).not.toContain(outcome.detail);
  });

  test("a report with no outcomes at all is a 0ms row rather than a throw -- an adapter that failed to resolve still gets a row", () => {
    const empty = liveRowSummary(report({ outcomes: [], ok: false }), { kind: "oauth", identityHeader: "winter-agent-sdk/0.0.1" });
    expect([empty.latencyMs, empty.toolCallOk, empty.ok]).toEqual([0, false, false]);
  });
});

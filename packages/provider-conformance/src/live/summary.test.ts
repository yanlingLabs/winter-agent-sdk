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
import { CredentialResolutionError } from "@yanlinglabs/winter-provider-runtime";
import { describeThrown } from "../corpus/classifier-safety.ts";
import { AUTH_DIMENSION_FIELDS, authDimensionsOf, LIVE_CASES } from "./cases.ts";
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

describe("WS-13b §4: the inference-path reversion condition reports AUTH DIMENSIONS, never the vendor's body", () => {
  const MARKER = "MARKER-vendor-prose-must-not-survive-7c1e";

  test("only the allowlisted fields survive -- a marker sitting in the SAME body does not", () => {
    // The property that makes reporting anything at all safe. The body below is the shape xAI's proxy
    // answers a refused subscription bearer with, plus a marker standing in for every human-readable
    // sentence a vendor also puts there.
    const body = `{"error":{"message":"${MARKER}: your request could not be authorized","auth_kind":"bearer","x_xai_token_auth":"none","scope":"grok-cli:access","request_id":"req_abc"}}`;
    const dimensions = authDimensionsOf(body);
    expect(dimensions).toEqual(["auth_kind=bearer", "x_xai_token_auth=none", "scope=grok-cli:access"]);
    expect(dimensions.join(" ")).not.toContain(MARKER);
    // ...and a field OUTSIDE the allowlist is dropped even though it is structured and harmless-looking.
    expect(dimensions.join(" ")).not.toContain("req_abc");
  });

  test("a value that is a SENTENCE contributes nothing -- the bound is a scalar shape, not a length", () => {
    // Without the scalar bound, `auth_kind` could smuggle a whole message past the allowlist by being
    // assigned one.
    expect(authDimensionsOf(`auth_kind: "${MARKER} and then some prose"`)).toEqual([`auth_kind=${MARKER}`]);
    expect(authDimensionsOf("nothing auth-shaped here at all")).toEqual([]);
  });

  test("the allowlist is a CLOSED list -- every field it names is one an auth refusal reports, and nothing else is read", () => {
    expect([...AUTH_DIMENSION_FIELDS]).toEqual(["auth_kind", "x_xai_token_auth", "token_auth", "scope"]);
    // The one header this whole condition is about is NOT among them, because Winter never sends it
    // and never reads back a claim that it would have helped (D21).
    expect(AUTH_DIMENSION_FIELDS.join(" ").toLowerCase()).not.toContain("x-xai-token-auth");
  });

  test("the case is part of the live run, and its question names the property it tests", () => {
    const spec = LIVE_CASES.find((c) => c.id === "honest-identity-inference");
    expect(spec?.question).toContain("no vendor client header");
  });
});

describe("WS-13b: an OAuth target's failure never puts its keychain ACCOUNT on the operator's terminal", () => {
  test("`describeThrown` on a CredentialResolutionError renders the class and code, and NOT the redacted ref its message carries", () => {
    // Review round 1, minor 7. `refreshOauthMaterial` and the keychain store both build their errors
    // with `redactRef(ref)` in the MESSAGE — which reproduces `keychain:<service>/<account>`, and
    // Global Constraints class an account id with keys and tokens. Nothing in the live gate prints
    // such a message: `runLiveCases` renders a non-`LiveCaseAssertionError` through `describeThrown`,
    // which reads FIELDS. That is a property of the renderer rather than of any one call site, so it
    // is asserted rather than left to the shape of today's callers.
    const err = new CredentialResolutionError("io", "oauth refresh for keychain:com.winter.live.20260906/xai-oauth:acct-secret-0001 failed with HTTP 500");
    const rendered = describeThrown(err);
    expect(rendered).not.toContain("acct-secret-0001");
    expect(rendered).not.toContain("com.winter.live.20260906");
    // ...and it is not empty: the class and the normalized code are what a reader needs.
    expect(rendered).toContain("CredentialResolutionError");
    expect(rendered).toContain("code=io");
  });
});

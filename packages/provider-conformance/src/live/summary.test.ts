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
import type { ProviderAdapter, ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
import { AUTH_DIMENSION_FIELDS, authDimensionsOf, LIVE_CASE_IMPLS, LIVE_CASES, type LiveCaseContext, type LiveCaseResult } from "./cases.ts";
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

// -------------------------------------------------------------------------------------------------
// Review round 2, I1: the reversion SEMANTICS belong to the OAuth rows, not to every subscription row.
//
// Four catalog rows are `pricingBasis: "subscription"` — `xai-oauth` and `codex-oauth` (entitlements
// reached under Winter's own identity) and `clinepass` and `kimi-coding` (ordinary API-KEY products
// with a seat price). Under one gate a mistyped key on `clinepass` was reported as WS-13b §4's
// reversion condition, the remediation named `xai-oauth` whichever row had failed, and a success on an
// api-key row was stamped with an identity claim that request never made.
//
// HERMETIC WITHOUT AN ENDPOINT TO PIN. `live/index.ts`'s header rule — a fixture driving these cases
// must pin BOTH the endpoint and the adapter — is about fixtures that can reach a network. The
// adapter below is an in-memory generator: there is no `fetch`, no URL and no credential anywhere in
// this block, so there is no endpoint to pin and nothing that could resolve to a vendor.
// -------------------------------------------------------------------------------------------------
describe("WS-13b §4 (review r2 I1): a subscription row's refusal is read by its AUTH PATH, not by its price", () => {
  const REFUSAL_BODY = '{"error":{"message":"unauthorized","auth_kind":"bearer","x_xai_token_auth":"none"}}';

  /** An adapter that answers one turn with the scripted outcome. No network, no credential, no clock. */
  function scriptedAdapter(outcome: { kind: "auth-error" } | { kind: "ok" }): ProviderAdapter {
    return {
      id: "winter.fixture",
      version: "0.0.0-fixture",
      family: "openai",
      protocol: "openai-chat-completions",
      async validateCredential() {
        return { ok: true };
      },
      async listModels() {
        return { models: [], partial: false, cached: false, warnings: [] };
      },
      streamTurn(): AsyncIterable<ProviderEvent> {
        return (async function* () {
          if (outcome.kind === "auth-error") {
            yield { type: "error", error: { code: "auth", message: REFUSAL_BODY, status: 401, retryable: false } } as ProviderEvent;
            return;
          }
          yield { type: "text_delta", text: "ready" } as ProviderEvent;
          yield { type: "done", stopReason: "end_turn" } as ProviderEvent;
        })();
      },
      mapEffort() {
        return { ok: true, value: undefined };
      },
      capabilities() {
        return { toolCalling: "native", readableState: "none" };
      },
    } as unknown as ProviderAdapter;
  }

  function caseCtx(providerId: string, targetKind: "api-key" | "oauth", outcome: { kind: "auth-error" } | { kind: "ok" }): LiveCaseContext {
    return {
      providerId,
      adapter: scriptedAdapter(outcome),
      // The only ProviderContext fields these cases touch. `connection.baseUrl` is a loopback port
      // nothing listens on, and nothing in this fixture dials it.
      ctx: { connection: { providerId, baseUrl: "http://127.0.0.1:1", local: true }, credentials: {}, authRef: { kind: "none" }, stallTimeoutMs: 1_000, log: () => {} } as unknown as LiveCaseContext["ctx"],
      model: "probe-model",
      descriptor: {} as NonNullable<LiveCaseContext["descriptor"]>,
      pricingBasis: "subscription",
      targetKind,
    };
  }

  const run = (ctx: LiveCaseContext): Promise<LiveCaseResult> => LIVE_CASE_IMPLS["honest-identity-inference"](ctx);

  test("`xai-oauth`: an OAuth entitlement's 401 IS the reversion condition, names its own provider in the remediation, and reports the vendor's auth dimensions", async () => {
    const err = await run(caseCtx("xai-oauth", "oauth", { kind: "auth-error" })).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.name).toBe("LiveCaseAssertionError");
    expect(err?.message).toContain("reversion condition");
    expect(err?.message).toContain('providers["xai-oauth"].enabled');
    expect(err?.message).toContain("x_xai_token_auth=none");
    // The vendor's prose is not carried across even though the allowlisted fields are.
    expect(err?.message).not.toContain("unauthorized");
    // ...and Winter states what it did not do.
    expect(err?.message).toContain("did NOT retry with the product's client header");
  });

  test("`codex-oauth`: the SAME semantics, and the remediation names CODEX -- an operator following it disables the row that actually failed", async () => {
    // The bug this test exists for: the remediation was a hardcoded `xai-oauth`, so an operator whose
    // codex entitlement was refused would have disabled a provider they were not even testing while
    // the one that failed stayed on. The close-out live run exercises codex-oauth.
    const err = await run(caseCtx("codex-oauth", "oauth", { kind: "auth-error" })).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain('providers["codex-oauth"].enabled');
    expect(err?.message).not.toContain("xai-oauth");
    expect(err?.message).toContain("reversion condition");
  });

  test("`clinepass`: an API-KEY row on a subscription plan reads its 401 as a KEY failure -- never as the vendor rejecting Winter's identity", async () => {
    const err = await run(caseCtx("clinepass", "api-key", { kind: "auth-error" })).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.name).toBe("LiveCaseAssertionError");
    expect(err?.message).toContain("clinepass");
    expect(err?.message).toContain("this says nothing about Winter's identity");
    // The three things a false alarm would have said.
    expect(err?.message).not.toContain("reversion condition");
    expect(err?.message).not.toContain("xai-oauth");
    expect(err?.message).not.toContain("impersonation");
  });

  test("the SUCCESS stamp is for OAuth rows only -- an api-key turn never asked whether an unregistered agent identity is served", async () => {
    const oauthOk = await run(caseCtx("xai-oauth", "oauth", { kind: "ok" }));
    expect(oauthOk.status).toBe("ok");
    expect(oauthOk.detail).toContain("PROMOTABLE");
    expect(oauthOk.detail).toContain("NO vendor client header sent");

    const keyOk = await run(caseCtx("clinepass", "api-key", { kind: "ok" }));
    expect(keyOk.status).toBe("ok");
    expect(keyOk.detail).not.toContain("PROMOTABLE");
    expect(keyOk.detail).not.toContain("vendor client header");
    expect(keyOk.detail).toContain("No identity claim");
  });

  test("a run that did not say which path the credential came down DECLINES -- the wrong reading of a refusal is an accusation", async () => {
    const { targetKind: _dropped, ...withoutKind } = caseCtx("xai-oauth", "oauth", { kind: "auth-error" });
    const result = await run(withoutKind as LiveCaseContext);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("neither reading");
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

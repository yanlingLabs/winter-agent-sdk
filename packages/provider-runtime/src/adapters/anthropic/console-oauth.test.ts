// D20 (RETIRED 2026-09-13, P10a-1): this file used to drive the Anthropic Console PKCE login
// end-to-end against a loopback fake -- the callback server, the PKCE binding, the profile lookup
// that named the record, the whole flow. That flow is gone for good: on 2026-09-13 the platform
// refused its grant for every derivable request shape, and the user ruled that Console OAuth goes
// ONLY through Anthropic's own brokers (`claude auth login --console` / `ant auth print-credentials`),
// never a re-implementation of the OAuth protocol itself. `console-oauth.ts`'s own banner carries the
// full account of what was retired and why. The REPLACEMENT -- spawning those two binaries, proved
// against real executable stubs -- lives in `console-broker.test.ts`, per the same-day amendment
// putting that broker in this SDK too; this file now proves only what survives of the OLD one.
//
// THE DERIVATION RECORD STAYS. `packages/conformance/compat/anthropic/0.3.250/derived-shapes-p6b.md`
// §2 and `derived-p6b.ts` are UNCHANGED as history (the doc's §2 header now says RETIRED, dated) --
// every field this file used to assert was genuinely read out of the pinned artifact, and nothing
// here disputes that. What changed is which of those fields still ship: `betaHeader` is the only one
// with a live consumer (`messages.ts`'s bearer arm), so it is the only one still gated against the
// derivation table below.
import { describe, expect, test } from "bun:test";
import { CONSOLE_BEARER, anthropicCredentialRef } from "./console-oauth.ts";
import { DERIVED } from "../../../../conformance/compat/anthropic/0.3.250/derived-p6b.ts";

describe("D20: Anthropic Console OAuth (RETIRED login; the surviving constant)", () => {
  test("`CONSOLE_BEARER.betaHeader` is the derived value, not typed from memory -- the ONE field of the old CONSOLE_OAUTH table still shipped", () => {
    // NOT an exhaustive `toEqual` against `DERIVED.consoleOauth` anymore: that table is the FULL
    // historical derivation (nine fields), and `CONSOLE_BEARER` is deliberately the one-field subset
    // that survived retirement. A field-by-field comparison here would either fail on the eight gone
    // fields or silently narrow to fewer than the ones committed history — this asserts the ONE field
    // that still ships against the ONE field of the record it was derived from.
    expect(CONSOLE_BEARER.betaHeader).toBe(DERIVED.consoleOauth.betaHeader);
    expect(Object.keys(CONSOLE_BEARER)).toEqual(["betaHeader"]);
  });

  test("`anthropicCredentialRef` is the ONE spelling of the record name — a host never assembles it by hand", () => {
    expect(anthropicCredentialRef("acct-x")).toEqual({ kind: "keychain", account: "anthropic:acct-x" });
    expect(anthropicCredentialRef("acct-x", "com.winter.core.dev")).toEqual({ kind: "keychain", account: "anthropic:acct-x", service: "com.winter.core.dev" });
  });
});

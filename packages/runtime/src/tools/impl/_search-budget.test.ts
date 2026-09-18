import { afterEach, describe, expect, test } from "bun:test";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { maxWebSearchesPerSessionEnvName, reserveWebSearchCall, resetWebSearchBudgetForTest, resolveMaxWebSearchesPerSession, webSearchBudgetRefusalText, webSearchCallsUsed, DEFAULT_MAX_WEB_SEARCHES_PER_SESSION } from "./_search-budget.ts";

afterEach(resetWebSearchBudgetForTest);

describe("the env override -- branded, never a literal", () => {
  test("the default cap is 200; a valid override wins; junk/zero/negative fall back to the default", () => {
    const name = maxWebSearchesPerSessionEnvName();
    expect(resolveMaxWebSearchesPerSession({})).toBe(DEFAULT_MAX_WEB_SEARCHES_PER_SESSION);
    expect(resolveMaxWebSearchesPerSession({ [name]: "5" })).toBe(5);
    expect(resolveMaxWebSearchesPerSession({ [name]: "0" })).toBe(DEFAULT_MAX_WEB_SEARCHES_PER_SESSION);
    expect(resolveMaxWebSearchesPerSession({ [name]: "-3" })).toBe(DEFAULT_MAX_WEB_SEARCHES_PER_SESSION);
    expect(resolveMaxWebSearchesPerSession({ [name]: "not-a-number" })).toBe(DEFAULT_MAX_WEB_SEARCHES_PER_SESSION);
    expect(resolveMaxWebSearchesPerSession({ [name]: "3.7" })).toBe(DEFAULT_MAX_WEB_SEARCHES_PER_SESSION);
  });

  test("a custom brand's prefix produces its own env name, not Winter's", () => {
    const customBrand = { envPrefix: "ACME_" };
    expect(maxWebSearchesPerSessionEnvName(customBrand)).toBe("ACME_MAX_WEB_SEARCHES_PER_SESSION");
    expect(maxWebSearchesPerSessionEnvName()).toBe(`${WINTER_BRAND.envPrefix}MAX_WEB_SEARCHES_PER_SESSION`);
  });
});

describe("reserveWebSearchCall -- counted BEFORE the search runs, shared across the session", () => {
  test("under the cap: reserved, `used` is the count BEFORE this call", () => {
    expect(reserveWebSearchCall("s1", 3)).toEqual({ ok: true, used: 0, cap: 3 });
    expect(reserveWebSearchCall("s1", 3)).toEqual({ ok: true, used: 1, cap: 3 });
    expect(reserveWebSearchCall("s1", 3)).toEqual({ ok: true, used: 2, cap: 3 });
    expect(webSearchCallsUsed("s1")).toBe(3);
  });

  test("at the cap: refused, and the counter does NOT advance -- the 201st and 202nd calls both read the same 'used'", () => {
    for (let i = 0; i < 3; i++) reserveWebSearchCall("s2", 3);
    expect(reserveWebSearchCall("s2", 3)).toEqual({ ok: false, used: 3, cap: 3 });
    expect(reserveWebSearchCall("s2", 3)).toEqual({ ok: false, used: 3, cap: 3 });
    expect(webSearchCallsUsed("s2")).toBe(3);
  });

  test("SHARED across a session and its children: a child's own tool calls count against the SAME session id", () => {
    // The sharing mechanism is nothing more than "key on sessionId, never agentId" -- a child shares
    // its parent's session id by construction (session-runtime.ts's own header). Simulated here by
    // simply reserving under the identical sessionId twice, exactly as a parent's and a child's own
    // tool calls would.
    expect(reserveWebSearchCall("root-session", 2)).toEqual({ ok: true, used: 0, cap: 2 });
    expect(reserveWebSearchCall("root-session", 2)).toEqual({ ok: true, used: 1, cap: 2 }); // "the child's" call
    expect(reserveWebSearchCall("root-session", 2)).toEqual({ ok: false, used: 2, cap: 2 });
  });

  test("a different session id starts at zero -- 'reset with the session' needs no explicit teardown", () => {
    reserveWebSearchCall("s3", 1);
    expect(webSearchCallsUsed("s3")).toBe(1);
    expect(webSearchCallsUsed("a-session-never-seen-before")).toBe(0);
  });
});

describe("webSearchBudgetRefusalText -- claude's own wording, Winter's env name substituted", () => {
  test("names the exact used/cap counts and the branded env var, verbatim otherwise", () => {
    const text = webSearchBudgetRefusalText(200, 200);
    expect(text).toBe(
      `Web search was not performed: this session has used its web search budget (200 of 200 WebSearch calls). Continue with the information already gathered instead of issuing more searches. If more searches are genuinely needed, ask the user to raise ${maxWebSearchesPerSessionEnvName()}.`,
    );
  });

  test("a custom brand's env name rides the same text", () => {
    const text = webSearchBudgetRefusalText(5, 5, { envPrefix: "ACME_" });
    expect(text).toContain("ACME_MAX_WEB_SEARCHES_PER_SESSION");
    expect(text).not.toContain(WINTER_BRAND.envPrefix);
  });
});

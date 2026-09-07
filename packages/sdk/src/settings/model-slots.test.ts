// P6.6 Lane B (WS-13c §5, D27): `validateModelSlots` — whole-set validation of `settings.modelSlots`.
//
// The `lookup` fixture below is a fixed-up version of the one in the Task 3 brief (Step 1): the
// brief's `keyToCanonicalId` map had only ONE entry ("openai/gpt-6-astra" -> "gpt-6-astra"), which
// left `keyToCanonicalId` untested by the "valid cross-family set" case — that case's second slot,
// `model: "anthropic/claude-opus-5"`, is a catalog KEY (the `rowsForCanonicalId("claude-opus-5")` row
// below carries exactly that string as its own `key`), so it must resolve through `keyToCanonicalId`,
// not by guessing at the string's shape. `validateModelSlots` deliberately does NOT strip an
// unrecognised `"foo/"` prefix and retry as a bare canonical id — that would let a slot validate
// against a provider the lookup never confirmed serves it, silently — so the fixture, not the
// validator, gets the missing entry. See the Task 3 report for this call.
import { describe, expect, test } from "bun:test";
import { validateModelSlots, type ModelSlotsLookup } from "./model-slots.ts";

const CATALOG: Record<string, Array<{ key: string; providerId: string }>> = {
  "gpt-6-astra": [{ key: "openai/gpt-6-astra", providerId: "openai" }],
  "claude-opus-5": [{ key: "anthropic/claude-opus-5", providerId: "anthropic" }],
};
const KEYS: Record<string, string> = {
  "openai/gpt-6-astra": "gpt-6-astra",
  "anthropic/claude-opus-5": "claude-opus-5",
};
const lookup: ModelSlotsLookup = {
  rowsForCanonicalId: (id: string) => CATALOG[id] ?? [],
  keyToCanonicalId: (key: string) => KEYS[key],
};

describe("validateModelSlots — whole-set (WS-13c §5)", () => {
  test("a valid cross-family set passes whole", () =>
    expect(
      validateModelSlots(
        [
          { name: "master", model: "gpt-6-astra" },
          { name: "strong", model: "anthropic/claude-opus-5" },
        ],
        lookup,
      ),
    ).toMatchObject({ ok: true }));

  test("a valid set round-trips `provider` and `description` verbatim, and `model` is kept exactly as given (not canonicalised)", () => {
    const r = validateModelSlots([{ name: "cheap", model: "anthropic/claude-opus-5", provider: "anthropic", description: "the balanced everyday pick" }], lookup);
    expect(r).toEqual({ ok: true, slots: [{ name: "cheap", model: "anthropic/claude-opus-5", provider: "anthropic", description: "the balanced everyday pick" }] });
  });

  test.each([
    [[], "at least one"],
    [[1, 2, 3, 4, 5].map((i) => ({ name: `s${i}`, model: "gpt-6-astra" })), "at most four"],
    [[{ name: "Master", model: "gpt-6-astra" }], "name"],
    [[{ name: "opus", model: "gpt-6-astra" }], "reserved"],
    [
      [
        { name: "a", model: "gpt-6-astra" },
        { name: "a", model: "gpt-6-astra" },
      ],
      "duplicate",
    ],
    [[{ name: "a", model: "gpt-9-nowhere" }], "no catalog row"],
    [[{ name: "a", model: "gpt-6-astra", provider: "anthropic" }], "does not serve"],
    [[{ name: "a", model: "gpt-6-astra", description: "only $5" }], "currency"],
    ["not-an-array", "array"],
  ])("refuses the whole set: %j", (raw, needle) => {
    const r = validateModelSlots(raw, lookup);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain(needle);
  });
});

describe("validateModelSlots — WHOLE-SET semantics", () => {
  test("a bad SECOND entry refuses the set whole — the valid first entry is not returned partially", () => {
    const r = validateModelSlots(
      [
        { name: "good", model: "gpt-6-astra" },
        { name: "opus", model: "gpt-6-astra" }, // reserved name
      ],
      lookup,
    );
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("reserved") });
  });

  test("an entry that is not an object refuses the set", () => {
    const r = validateModelSlots([null], lookup);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("modelSlots[0]");
  });

  test("a non-string, non-empty-string, or malformed provider is refused before the serve check", () => {
    const r = validateModelSlots([{ name: "a", model: "gpt-6-astra", provider: 7 }], lookup);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("provider");
  });

  test("a description over 200 characters is refused", () => {
    const r = validateModelSlots([{ name: "a", model: "gpt-6-astra", description: "x".repeat(201) }], lookup);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("200");
  });

  test("a description of exactly 200 characters is accepted", () => {
    const r = validateModelSlots([{ name: "a", model: "gpt-6-astra", description: "x".repeat(200) }], lookup);
    expect(r.ok).toBe(true);
  });
});

// --- The CURRENCY_RE widening (P6.6 addendum) ------------------------------------------------------
//
// `CURRENCY_RE` (`@yanlinglabs/winter-provider-catalog`) is the brief's verbatim regex and is
// deliberately PARTIAL for the reviewed `overlay/families.json` text it was written to gate. A
// custom slot's `description` is unreviewed end-user input, so this module widens the check with
// exactly the four additions the addendum names (EUR, ¥, ¢, "cent(s)") rather than accepting the
// gap. See model-slots.ts's `EXTRA_CURRENCY_RE` comment for why the list stops there.
describe("validateModelSlots — currency check, widened for custom (unreviewed) descriptions", () => {
  test.each([
    ["only $5", "the shared CURRENCY_RE catch, unchanged"],
    ["10 USD flat", "the shared CURRENCY_RE catch, unchanged"],
    ["costs 0.25 EUR per call", "decimal EUR — the addendum's own missed case"],
    ["¥5 per run", "the yen symbol — the addendum's own missed case"],
    ["5¢ per token", "the cent symbol — the addendum's own missed case"],
    ["about 5 cents a call", "the word \"cents\" — the addendum's own missed case"],
    ["1 cent", "the singular \"cent\""],
  ])("flags a currency amount: %s (%s)", (description) => {
    const r = validateModelSlots([{ name: "a", model: "gpt-6-astra", description }], lookup);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("currency");
  });

  test.each([
    ["the fast, cheap implementer of the same lineup", "a real WS-13c §9 slot description — no amount, must not false-positive"],
    ["the strongest GLM; agentic coding on the GLM Coding plan", "another real §9 description — contains no digit at all"],
    ["not far from Terra on implementation capability, and probably the best cheap implementer on the market", "a real §9 description with no currency"],
    ["10 candidates were considered", "a digit followed by an unrelated word starting with 'c' — must not false-positive on a bare trailing letter"],
  ])("does not flag ordinary text: %s (%s)", (description) => {
    const r = validateModelSlots([{ name: "a", model: "gpt-6-astra", description }], lookup);
    expect(r.ok).toBe(true);
  });

  // Documented non-goal (see model-slots.ts's EXTRA_CURRENCY_RE comment): the addendum's own list of
  // misses includes bare "10c" shorthand, which this module does NOT catch — the risk of an English
  // sentence with an innocent digit-then-"c" collision (there is no realistic phrasing this repo's
  // slot descriptions would use, but the shorthand itself is genuinely ambiguous with e.g. a units
  // suffix) was judged worse than the rare real miss. Recorded as a test so the gap stays a decision,
  // not a blind spot.
  test("does NOT flag bare '10c' shorthand (a deliberate scope limit, not an oversight)", () => {
    const r = validateModelSlots([{ name: "a", model: "gpt-6-astra", description: "roughly 10c per call" }], lookup);
    expect(r.ok).toBe(true);
  });
});

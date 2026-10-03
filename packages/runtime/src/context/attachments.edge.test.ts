// Edge cases of the skill-listing resume seed.
import { describe, expect, test } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import { skillListingResumeSeed } from "./attachments.ts";

const listing = (payload: Record<string, unknown>): ProviderMessage => ({ role: "user", content: "x", meta: { attachment: { type: "skill_listing", ...payload } } });

describe("skillListingResumeSeed", () => {
  test("no listing at all: no names, no suppression", () => {
    expect(skillListingResumeSeed([])).toEqual({ names: [], suppressNext: false });
    expect(skillListingResumeSeed([{ role: "user", content: "p" }])).toEqual({ names: [], suppressNext: false });
  });

  test("names concatenate in history order; duplicates are kept; non-strings are dropped", () => {
    expect(skillListingResumeSeed([listing({ names: ["a", "b"] }), listing({ names: ["b", 7, null, "c"] })])).toEqual({ names: ["a", "b", "b", "c"], suppressNext: false });
  });

  test("an EMPTY names array is not legacy", () => {
    expect(skillListingResumeSeed([listing({ names: [] })])).toEqual({ names: [], suppressNext: false });
  });

  test("any listing whose names is missing or not an array asks for suppression, wherever it sits", () => {
    expect(skillListingResumeSeed([listing({}), listing({ names: ["a"] })])).toEqual({ names: ["a"], suppressNext: true });
    expect(skillListingResumeSeed([listing({ names: ["a"] }), listing({ names: "b" })])).toEqual({ names: ["a"], suppressNext: true });
    expect(skillListingResumeSeed([listing({ names: null })])).toEqual({ names: [], suppressNext: true });
  });

  test("other attachment types never count, even with a names field", () => {
    expect(skillListingResumeSeed([{ role: "user", content: "x", meta: { attachment: { type: "date_change", names: ["z"] } } }, { role: "user", content: "x", meta: { attachment: { type: "agent_listing_delta" } } }])).toEqual({
      names: [],
      suppressNext: false,
    });
  });
});

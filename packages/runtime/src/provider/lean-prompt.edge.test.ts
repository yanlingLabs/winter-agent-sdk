// Edge cases of `claudeModelTakesFullPrompt`: how the model key is reduced to an id, and exactly which
// spellings of the Opus 4 line count as one of the full-prompt builds.
import { describe, expect, test } from "bun:test";
import { claudeModelTakesFullPrompt } from "./lean-prompt.ts";

const cases = (rows: ReadonlyArray<readonly [string, boolean]>): void => {
  for (const [key, expected] of rows) expect(claudeModelTakesFullPrompt(key), JSON.stringify(key)).toBe(expected);
};

describe("claudeModelTakesFullPrompt: reducing the key to an id", () => {
  test("only the text after the LAST slash is the id; a provider part never matters", () => {
    cases([
      ["a/b/claude-opus-4-1", true],
      ["mysonnet/claude-opus-5", false], // `sonnet` in the provider part does not count
      ["x/claude-opus-4-1/", false], // a trailing slash leaves an empty id
      ["anthropic/", false],
      ["/", false],
      ["", false],
    ]);
  });

  test("the id is compared case-insensitively", () => {
    cases([
      ["ANTHROPIC/CLAUDE-OPUS-4-1", true],
      ["Claude-Sonnet-X", true],
      ["CLAUDE-OPUS-5", false],
    ]);
  });
});

describe("claudeModelTakesFullPrompt: the substring families", () => {
  test("`claude-3-`, `haiku` and `sonnet` anywhere in the id are full", () => {
    cases([
      ["xhaikux", true],
      ["claude-3-", true],
      ["claude-3.5-sonnet", true], // via `sonnet`, not via `claude-3-`
      ["claude-3", false], // no trailing dash
      ["claude-opus-4-8-sonnet", true],
    ]);
  });
});

describe("claudeModelTakesFullPrompt: the Opus 4 line", () => {
  test("bare Opus 4 and its dated id are the 4.0 build", () => {
    cases([
      ["claude-opus-4", true],
      ["claude-opus-4-20250514", true],
    ]);
  });

  test("a minor is one or two digits after `-` or `.`, optionally followed by an 8-digit date", () => {
    cases([
      ["claude-opus-4-1-20250805", true],
      ["claude-opus-4.1", true],
      ["claude-opus-4.5-20250101", true],
      ["claude-opus-4-5-2025010", false], // a 7-digit date is not a date
      ["claude-opus-4-1-20250805-extra", false],
      ["claude-opus-4-1x", false],
      ["claude-opus-4-", false],
      ["claude-opus-4-1-", false],
      ["claude-opus-4..1", false],
      ["claude-opus-4.-1", false],
      ["claude-opus-4-123", false],
    ]);
  });

  test("the minor is matched as written: 0, 1, 5, 6 and 7 are full; anything else is lean", () => {
    cases([
      ["claude-opus-4-0", true],
      ["claude-opus-4-1", true],
      ["claude-opus-4-5", true],
      ["claude-opus-4-6", true],
      ["claude-opus-4-7", true],
      ["claude-opus-4-2", false],
      ["claude-opus-4-3", false],
      ["claude-opus-4-4", false],
      ["claude-opus-4-8", false],
      ["claude-opus-4-9", false],
      ["claude-opus-4-10", false],
      ["claude-opus-4-05", false], // a zero-padded minor is not "5"
      ["claude-opus-4-00", false],
      ["claude-opus-45", false],
    ]);
  });

  test("the id must START with `claude-opus-4`", () => {
    cases([
      ["x-claude-opus-4-1", false],
      ["anthropic.claude-opus-4-1", false],
    ]);
  });
});

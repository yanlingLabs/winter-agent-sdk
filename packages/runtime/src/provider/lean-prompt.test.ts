import { describe, expect, test } from "bun:test";
import { claudeModelTakesFullPrompt } from "./lean-prompt.ts";

describe("claudeModelTakesFullPrompt -- claude's own model-id list, not a tier lookup", () => {
  test("FULL: the claude-3 line, every haiku and sonnet, and the five named Opus 4.x builds", () => {
    for (const key of [
      "anthropic/claude-3-5-sonnet-20241022",
      "anthropic/claude-3-opus-20240229",
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-4.5",
      "claude-opus-4-0",
      "anthropic/claude-opus-4-20250514",
      "anthropic/claude-opus-4-1",
      "anthropic/claude-opus-4-1-20250805",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-7",
    ]) {
      expect(claudeModelTakesFullPrompt(key), key).toBe(true);
    }
  });

  test("LEAN: Opus 4.8, Opus 5, the tier above Opus, and any id the list does not know", () => {
    for (const key of ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-8-20260801", "anthropic/claude-opus-5", "anthropic/claude-fable-5-1", "claude-mythos-5", "anthropic/claude-opus-4-2", "anthropic/claude-opus-4-10", "anthropic/some-future-model"]) {
      expect(claudeModelTakesFullPrompt(key), key).toBe(false);
    }
  });
});

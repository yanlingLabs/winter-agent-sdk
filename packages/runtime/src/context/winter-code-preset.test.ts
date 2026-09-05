// Phase 5 Lane C (task 6) -- the INDEPENDENTLY AUTHORED `winter_code` preset (WS-11 §6.2, R5-9).
//
// The preset's contents are checked STRUCTURALLY -- every category WS-11 §6.2 names is present as
// its own section, the version is stamped, the alias resolves -- and never by comparison against
// any vendor text, which this lane is forbidden to read, quote or paraphrase.
import { test, expect, describe } from "bun:test";
import {
  isWinterCodePreset,
  resolvePresetSystemPrompt,
  WINTER_CODE_PRESET,
  WINTER_CODE_PRESET_CATEGORIES,
  WINTER_CODE_PRESET_VERSION,
} from "./winter-code-preset.ts";
import { MINIMAL_PROMPT, MINIMAL_PROMPT_MAX_LINES, MINIMAL_PROMPT_VERSION } from "./minimal-prompt.ts";

describe("context/winter-code-preset.ts -- category coverage (WS-11 §6.2)", () => {
  test("all eight named categories are present, each as its own `## ` section", () => {
    expect(WINTER_CODE_PRESET_CATEGORIES).toEqual([
      "Task execution",
      "Careful actions",
      "Tools",
      "Tone and style",
      "Session guidance",
      "Auto memory",
      "Environment",
      "Context management",
    ]);
    for (const category of WINTER_CODE_PRESET_CATEGORIES) {
      expect(WINTER_CODE_PRESET).toContain(`\n## ${category}\n`);
    }
  });

  test("the sections appear in the declared order, and each carries real body text", () => {
    const positions = WINTER_CODE_PRESET_CATEGORIES.map((c) => WINTER_CODE_PRESET.indexOf(`\n## ${c}\n`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const sections = WINTER_CODE_PRESET.split(/\n## /).slice(1);
    expect(sections).toHaveLength(WINTER_CODE_PRESET_CATEGORIES.length);
    for (const section of sections) {
      expect(section.split("\n").slice(1).join("\n").trim().length).toBeGreaterThan(200);
    }
  });

  test("the preset is versioned", () => {
    expect(WINTER_CODE_PRESET_VERSION).toMatch(/^winter_code@\d+$/);
  });

  test("the auto-memory section is PATH-FREE -- the cacheable half of the prompt carries no machine-specific path", () => {
    const section = WINTER_CODE_PRESET.split("\n## Auto memory\n")[1]!.split("\n## ")[0]!;
    expect(section).not.toMatch(/[/~]\.winter/);
    expect(section).not.toContain("/Users/");
    expect(section).not.toContain("MEMORY.md");
  });

  test("the preset names no vendor product, company or model", () => {
    for (const forbidden of ["Claude", "claude", "Anthropic", "anthropic", "Norma", "GPT", "OpenAI"]) {
      expect(WINTER_CODE_PRESET).not.toContain(forbidden);
    }
  });
});

describe("context/winter-code-preset.ts -- the preset arm's own resolution", () => {
  test("`claude_code` is accepted (the pinned closed literal) and so is Winter's `winter_code` alias", () => {
    expect(isWinterCodePreset("claude_code")).toBe(true);
    expect(isWinterCodePreset("winter_code")).toBe(true);
  });

  test("an unknown preset name is NOT accepted", () => {
    expect(isWinterCodePreset("something_else")).toBe(false);
    expect(isWinterCodePreset("")).toBe(false);
  });

  test("`append` lands AFTER the preset, never replacing any of it", () => {
    const out = resolvePresetSystemPrompt({ type: "preset", preset: "claude_code", append: "EXTRA HOUSE RULE" });
    expect(out.startsWith(WINTER_CODE_PRESET.trim())).toBe(true);
    expect(out.endsWith("EXTRA HOUSE RULE")).toBe(true);
  });

  test("no `append` yields the preset alone, with no trailing separator", () => {
    expect(resolvePresetSystemPrompt({ type: "preset", preset: "claude_code" })).toBe(WINTER_CODE_PRESET.trim());
  });

  test("a whitespace-only append adds nothing", () => {
    expect(resolvePresetSystemPrompt({ type: "preset", preset: "claude_code", append: "   \n " })).toBe(WINTER_CODE_PRESET.trim());
  });
});

describe("context/minimal-prompt.ts -- R5-9's authored default", () => {
  test("it is at most 20 lines", () => {
    expect(MINIMAL_PROMPT_MAX_LINES).toBe(20);
    expect(MINIMAL_PROMPT.split("\n")).not.toHaveLength(0);
    expect(MINIMAL_PROMPT.split("\n").length).toBeLessThanOrEqual(MINIMAL_PROMPT_MAX_LINES);
  });

  test("it is versioned and non-empty", () => {
    expect(MINIMAL_PROMPT_VERSION).toMatch(/^winter_minimal@\d+$/);
    expect(MINIMAL_PROMPT.trim().length).toBeGreaterThan(100);
  });

  test("it is tool-calling guidance ONLY -- it carries none of the preset's product categories", () => {
    for (const category of WINTER_CODE_PRESET_CATEGORIES) {
      expect(MINIMAL_PROMPT).not.toContain(`## ${category}`);
    }
    expect(MINIMAL_PROMPT).not.toContain("##");
    expect(MINIMAL_PROMPT.length).toBeLessThan(WINTER_CODE_PRESET.length / 4);
  });

  test("it names no vendor product, company or model either", () => {
    for (const forbidden of ["Claude", "Anthropic", "Norma", "GPT", "OpenAI"]) {
      expect(MINIMAL_PROMPT).not.toContain(forbidden);
    }
  });
});

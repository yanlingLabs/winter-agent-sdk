// Phase 5 Lane C (task 6) -- the dynamic (machine/session-specific) block (WS-11 §6.3, R5-9).
import { test, expect, describe } from "bun:test";
import { DYNAMIC_SECTIONS_HEADING, renderDynamicSections } from "./dynamic-sections.ts";

const base = { cwd: "/work/proj", platform: "darwin", osVersion: "25.6.0", shell: "/bin/zsh", date: "2026-09-05" };

describe("context/dynamic-sections.ts", () => {
  test("R5-9's whole list is rendered when every input is present", () => {
    const out = renderDynamicSections({ ...base, gitSummary: "branch main, 2 modified", memoryDir: "/home/projects/k/memory" });
    expect(out).toContain(DYNAMIC_SECTIONS_HEADING);
    expect(out).toContain("/work/proj");
    expect(out).toContain("darwin");
    expect(out).toContain("25.6.0");
    expect(out).toContain("/bin/zsh");
    expect(out).toContain("2026-09-05");
    expect(out).toContain("branch main, 2 modified");
    expect(out).toContain("/home/projects/k/memory");
  });

  test("an absent git summary omits its line entirely -- never an empty or 'unknown' one", () => {
    const out = renderDynamicSections(base);
    expect(out.toLowerCase()).not.toContain("git");
    expect(out).not.toContain("undefined");
  });

  test("an absent memory directory omits its line -- this is how `autoMemoryEnabled: false` reads here", () => {
    const out = renderDynamicSections(base);
    expect(out.toLowerCase()).not.toContain("memory");
  });

  test("empty-string inputs are treated as absent, not rendered as blanks", () => {
    const out = renderDynamicSections({ ...base, shell: "", osVersion: "", gitSummary: "  ", memoryDir: "" });
    expect(out).not.toContain("Shell:");
    expect(out.toLowerCase()).not.toContain("git");
    expect(out.toLowerCase()).not.toContain("memory");
    expect(out).toContain("/work/proj");
  });

  test("a multi-line git summary is indented under its own line rather than breaking the list", () => {
    const out = renderDynamicSections({ ...base, gitSummary: "branch main\nM src/a.ts\nM src/b.ts" });
    const lines = out.split("\n");
    const gitIndex = lines.findIndex((l) => l.includes("branch main"));
    expect(gitIndex).toBeGreaterThan(0);
    expect(lines[gitIndex + 1]).toMatch(/^\s+M src\/a\.ts$/);
  });

  test("the block is stable for identical inputs -- the same envelope's rounds cannot disagree", () => {
    expect(renderDynamicSections(base)).toBe(renderDynamicSections(base));
  });

  test("its heading does not collide with the preset's own `## Environment` category", () => {
    expect(DYNAMIC_SECTIONS_HEADING).not.toBe("## Environment");
  });
});

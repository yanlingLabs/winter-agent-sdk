// Phase 5 Lane C (task 6) -- `createSystemPromptAssembler`, implementing Ruling R5-9 as amended.
//
// The seam authority is `context/seam.contract.test.ts` (Task 3): where this file and that one
// disagree, that one wins. This file is the LANE's authority for what the assembler PUTS in the
// prompt; the last describe block is the ground-truth check the Global Constraints demand -- an
// assembler that returns the right string and an engine that drops it look identical from the
// assembler's own tests, so one test drives a real `runEngine` and reads the live request.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, Settings, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { DEFAULT_PLANS_DIRECTORY, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderRequest } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import type { SystemPromptInput } from "./seam.ts";
import { createSystemPromptAssembler } from "./assembler.ts";
import { MINIMAL_PROMPT, MINIMAL_PROMPT_VERSION } from "./minimal-prompt.ts";
import { WINTER_CODE_PRESET, WINTER_CODE_PRESET_VERSION } from "./winter-code-preset.ts";
import { DYNAMIC_SECTIONS_HEADING } from "./dynamic-sections.ts";
import { MEMORY_INDEX_BASENAME } from "./memory.ts";
import { WINTER_MD_BASENAME } from "./winter-md.ts";
import { _clearProjectRootCacheForTests } from "./winter-md.ts";
import { _clearMemoryKeyCacheForTests, memoryDirFor } from "./memory-key.ts";
import { DEFAULT_PLAN_BODY } from "./plan-mode.ts";
import { makeGitFixture, type GitFixture } from "./git-fixture.ts";

let home: string;
let cwd: string;

beforeEach(() => {
  _clearProjectRootCacheForTests();
  _clearMemoryKeyCacheForTests();
  home = mkdtempSync(join(tmpdir(), "winter-asm-home-"));
  cwd = mkdtempSync(join(tmpdir(), "winter-asm-proj-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function cfg(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { sessionId: "s", cwd, model: "sonnet", ...overrides };
}

function inputFor(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    config: cfg(),
    cwd,
    env: {},
    platform: "darwin",
    osVersion: "25.6.0",
    shell: "/bin/zsh",
    date: "2026-09-05",
    planMode: false,
    ...overrides,
  };
}

function assemble(overrides: Partial<SystemPromptInput> = {}, settings?: Settings): ReturnType<ReturnType<typeof createSystemPromptAssembler>["assemble"]> {
  const assembler = createSystemPromptAssembler({ home, ...(settings !== undefined ? { settings: () => settings } : {}) });
  return assembler.assemble(inputFor(overrides));
}

// --- The four arms of `systemPrompt` -------------------------------------------------------------

describe("assembler -- R5-9's four arms", () => {
  test("undefined renders the AUTHORED MINIMAL prompt, stamped with its own version", () => {
    const out = assemble();
    expect(out.system).toContain(MINIMAL_PROMPT);
    expect(out.system).not.toContain(WINTER_CODE_PRESET);
    expect(out.presetVersion).toBe(MINIMAL_PROMPT_VERSION);
  });

  test("a string REPLACES the authored prompt entirely, and stamps no version", () => {
    const out = assemble({ config: cfg({ systemPrompt: "ONLY MY WORDS" }) });
    expect(out.system).toContain("ONLY MY WORDS");
    expect(out.system).not.toContain(MINIMAL_PROMPT);
    expect(out.system).not.toContain(WINTER_CODE_PRESET);
    expect(out.presetVersion).toBeUndefined();
  });

  test("a string prompt STILL renders the dynamic sections (item (c): they are not the caller's to remove)", () => {
    const out = assemble({ config: cfg({ systemPrompt: "ONLY MY WORDS" }) });
    expect(out.system).toContain(DYNAMIC_SECTIONS_HEADING);
    expect(out.system).toContain(cwd);
  });

  test("the preset arm renders the authored winter_code preset, stamped", () => {
    const out = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" } }) });
    expect(out.system).toContain(WINTER_CODE_PRESET);
    expect(out.presetVersion).toBe(WINTER_CODE_PRESET_VERSION);
  });

  test("the Winter-side `winter_code` alias resolves identically -- it reaches the runtime as JSON, not through the pinned type", () => {
    const viaAlias = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "winter_code" as "claude_code" } }) });
    const viaPinned = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" } }) });
    expect(viaAlias.system).toBe(viaPinned.system);
    expect(viaAlias.presetVersion).toBe(WINTER_CODE_PRESET_VERSION);
  });

  test("`append` lands after the preset and never displaces any of it", () => {
    const out = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code", append: "HOUSE RULE" } }) });
    expect(out.system).toContain(WINTER_CODE_PRESET);
    expect(out.system.indexOf("HOUSE RULE")).toBeGreaterThan(out.system.indexOf(WINTER_CODE_PRESET));
  });

  test("an unrecognised preset spelling still gets the one preset Winter has -- `type: 'preset'` IS the request", () => {
    const out = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "some_future_preset" as "claude_code" } }) });
    expect(out.system).toContain(WINTER_CODE_PRESET);
    expect(out.system).not.toContain(MINIMAL_PROMPT);
  });
});

describe("assembler -- the `string[]` arm and SYSTEM_PROMPT_DYNAMIC_BOUNDARY", () => {
  test("blocks are joined, and the boundary SENTINEL itself never reaches the prompt", () => {
    const out = assemble({ config: cfg({ systemPrompt: ["STATIC ONE", "STATIC TWO", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "SESSION SPECIFIC"] }) });
    expect(out.system).toContain("STATIC ONE");
    expect(out.system).toContain("STATIC TWO");
    expect(out.system).toContain("SESSION SPECIFIC");
    expect(out.system).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });

  test("Winter's own dynamic sections land in the DYNAMIC half -- after the boundary position, never before it", () => {
    const out = assemble({ config: cfg({ systemPrompt: ["STATIC ONE", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "SESSION SPECIFIC"] }) });
    expect(out.system.indexOf("STATIC ONE")).toBeLessThan(out.system.indexOf("SESSION SPECIFIC"));
    expect(out.system.indexOf("SESSION SPECIFIC")).toBeLessThan(out.system.indexOf(DYNAMIC_SECTIONS_HEADING));
  });

  test("with NO boundary the whole array is static, and the dynamic sections follow it", () => {
    const out = assemble({ config: cfg({ systemPrompt: ["A", "B"] }) });
    expect(out.system.indexOf("A")).toBeLessThan(out.system.indexOf("B"));
    expect(out.system.indexOf("B")).toBeLessThan(out.system.indexOf(DYNAMIC_SECTIONS_HEADING));
  });

  test("only a STANDALONE element is a boundary -- an element merely CONTAINING the sentinel is ordinary text", () => {
    const out = assemble({ config: cfg({ systemPrompt: [`prefix ${SYSTEM_PROMPT_DYNAMIC_BOUNDARY} suffix`, "SECOND"] }) });
    expect(out.system).toContain(`prefix ${SYSTEM_PROMPT_DYNAMIC_BOUNDARY} suffix`);
    expect(out.system).toContain("SECOND");
  });

  test("an empty array is not an empty prompt -- the dynamic sections still render", () => {
    const out = assemble({ config: cfg({ systemPrompt: [] }) });
    expect(out.system).toContain(DYNAMIC_SECTIONS_HEADING);
    expect(out.system.length).toBeGreaterThan(0);
  });
});

// --- excludeDynamicSections (WS-11 §6.3) ----------------------------------------------------------

describe("assembler -- excludeDynamicSections", () => {
  test("true MOVES the dynamic block out of `system` and makes it the FIRST user-context block", () => {
    writeFileSync(join(cwd, WINTER_MD_BASENAME), "PROJECT RULES", "utf8");
    const out = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true } }) });
    expect(out.system).not.toContain(DYNAMIC_SECTIONS_HEADING);
    expect(out.system).toContain(WINTER_CODE_PRESET);
    expect(out.userContextBlocks[0]).toContain(DYNAMIC_SECTIONS_HEADING);
    expect(out.userContextBlocks[0]).toContain(cwd);
  });

  test("the moved block leaves the authored prompt itself untouched -- that is the point (a cacheable prefix)", () => {
    const excluded = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true } }) });
    const included = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" } }) });
    expect(included.system.startsWith(excluded.system)).toBe(true);
  });

  test("false / absent keeps the dynamic block in `system`", () => {
    for (const sp of [{ type: "preset", preset: "claude_code" } as const, { type: "preset", preset: "claude_code", excludeDynamicSections: false } as const]) {
      const out = assemble({ config: cfg({ systemPrompt: sp }) });
      expect(out.system).toContain(DYNAMIC_SECTIONS_HEADING);
      expect(out.userContextBlocks.some((b) => b.includes(DYNAMIC_SECTIONS_HEADING))).toBe(false);
    }
  });

  test("it is INERT for a string prompt (item (c): its own pinned doc says it has no effect there)", () => {
    const out = assemble({ config: cfg({ systemPrompt: "MY WORDS", excludeDynamicSections: true } as unknown as Partial<RuntimeConfig>) });
    expect(out.system).toContain(DYNAMIC_SECTIONS_HEADING);
    expect(out.userContextBlocks.some((b) => b.includes(DYNAMIC_SECTIONS_HEADING))).toBe(false);
  });
});

// --- agentPrompt (R5-3) ---------------------------------------------------------------------------

describe("assembler -- the child persona MUST be composed into `system` (R5-3)", () => {
  test("it reaches `system` on the default arm", () => {
    const out = assemble({ agentPrompt: "You are a meticulous reviewer." });
    expect(out.system).toContain("You are a meticulous reviewer.");
    expect(out.system).toContain(MINIMAL_PROMPT);
  });

  test("it reaches `system` on EVERY arm -- an assembler that dropped it would silently un-persona every subagent", () => {
    const arms: RuntimeConfig["systemPrompt"][] = [undefined, "CALLER STRING", ["A", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "B"], { type: "preset", preset: "claude_code" }];
    for (const systemPrompt of arms) {
      const out = assemble({ config: cfg(systemPrompt === undefined ? {} : { systemPrompt }), agentPrompt: "PERSONA-X" });
      expect(out.system).toContain("PERSONA-X");
    }
  });

  test("it never leaks into the user-context blocks", () => {
    const out = assemble({ agentPrompt: "PERSONA-X" });
    expect(out.userContextBlocks.some((b) => b.includes("PERSONA-X"))).toBe(false);
  });
});

// --- WINTER.md + memory as user context -----------------------------------------------------------

describe("assembler -- WINTER.md and memory are user context, in a pinned order", () => {
  test("WINTER.md never reaches `system`, and the pinned order is dynamic (if moved) -> user -> project -> memory", () => {
    writeFileSync(join(home, WINTER_MD_BASENAME), "USER RULES", "utf8");
    writeFileSync(join(cwd, WINTER_MD_BASENAME), "PROJECT RULES", "utf8");
    const memDir = memoryDirFor({ cwd, home, env: {} });
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, MEMORY_INDEX_BASENAME), "- [x](x.md) — a stored fact", "utf8");

    const out = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true } }) });
    expect(out.system).not.toContain("USER RULES");
    expect(out.system).not.toContain("PROJECT RULES");
    expect(out.system).not.toContain("a stored fact");

    const order = out.userContextBlocks.map((b) =>
      b.includes(DYNAMIC_SECTIONS_HEADING) ? "dynamic" : b.includes("USER RULES") ? "user" : b.includes("PROJECT RULES") ? "project" : b.includes("a stored fact") ? "memory" : "?",
    );
    expect(order).toEqual(["dynamic", "user", "project", "memory"]);
  });

  test("with the dynamic block left in `system`, the remaining order is unchanged", () => {
    writeFileSync(join(home, WINTER_MD_BASENAME), "USER RULES", "utf8");
    writeFileSync(join(cwd, WINTER_MD_BASENAME), "PROJECT RULES", "utf8");
    const out = assemble();
    const order = out.userContextBlocks.map((b) => (b.includes("USER RULES") ? "user" : b.includes("PROJECT RULES") ? "project" : "memory"));
    expect(order).toEqual(["user", "project", "memory"]);
  });

  test("project WINTER.md is SOURCE-gated at the assembler too", () => {
    writeFileSync(join(cwd, WINTER_MD_BASENAME), "PROJECT RULES", "utf8");
    const out = assemble({ config: cfg({ settingSources: ["user"] }) });
    expect(out.userContextBlocks.some((b) => b.includes("PROJECT RULES"))).toBe(false);
  });
});

describe("assembler -- auto-memory", () => {
  test("enabled by default: the block is injected and the directory is named in the dynamic sections", () => {
    const out = assemble();
    const memDir = memoryDirFor({ cwd, home, env: {} });
    expect(out.userContextBlocks.some((b) => b.includes(memDir))).toBe(true);
    expect(out.system).toContain(memDir);
  });

  test("`autoMemoryEnabled: false` removes BOTH the block and the dynamic-section line", () => {
    const out = assemble({}, { autoMemoryEnabled: false });
    const memDir = memoryDirFor({ cwd, home, env: {} });
    expect(out.userContextBlocks.some((b) => b.includes(memDir))).toBe(false);
    expect(out.system).not.toContain(memDir);
    expect(out.system).not.toContain("Auto-memory directory");
  });

  test("`autoMemoryDirectory` relocates it", () => {
    const elsewhere = join(cwd, "custom-memory");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, MEMORY_INDEX_BASENAME), "- [y](y.md) — relocated fact", "utf8");
    const out = assemble({}, { autoMemoryDirectory: elsewhere });
    expect(out.userContextBlocks.some((b) => b.includes("relocated fact"))).toBe(true);
    expect(out.userContextBlocks.some((b) => b.includes(memoryDirFor({ cwd, home, env: {} })))).toBe(false);
  });

  test("an explicit `SystemPromptInput.memoryDir` wins over the setting", () => {
    const hostDir = join(cwd, "host-memory");
    const out = assemble({ memoryDir: hostDir }, { autoMemoryDirectory: join(cwd, "settings-memory") });
    expect(out.userContextBlocks.some((b) => b.includes(hostDir))).toBe(true);
    expect(out.userContextBlocks.some((b) => b.includes("settings-memory"))).toBe(false);
  });

  test("the guidance is present even with no MEMORY.md, and the index appears once there is one", () => {
    expect(assemble().userContextBlocks.some((b) => b.includes("Auto-memory for this project"))).toBe(true);
    const memDir = memoryDirFor({ cwd, home, env: {} });
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, MEMORY_INDEX_BASENAME), "- [z](z.md) — indexed", "utf8");
    expect(assemble().userContextBlocks.some((b) => b.includes("indexed"))).toBe(true);
  });
});

describe("assembler -- a linked worktree assembles the SAME memory directory as its main checkout", () => {
  let fx: GitFixture;
  beforeEach(() => {
    fx = makeGitFixture();
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  test("both cwds name one memory directory in the assembled prompt", () => {
    const assembler = createSystemPromptAssembler({ home });
    const fromMain = assembler.assemble(inputFor({ config: cfg({ cwd: fx.main }), cwd: fx.main }));
    const fromWorktree = assembler.assemble(inputFor({ config: cfg({ cwd: fx.worktree }), cwd: fx.worktree }));
    const shared = memoryDirFor({ cwd: fx.main, home, env: {} });
    expect(fromMain.system).toContain(shared);
    expect(fromWorktree.system).toContain(shared);
  });
});

// --- Output styles (WS-11 §6.5) -------------------------------------------------------------------

describe("assembler -- output styles, and the byte-identical-when-unset invariant", () => {
  test("SNAPSHOT: with no style set the assembled prompt is byte-identical to the explicit `default`", () => {
    const unset = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" } }) });
    const explicit = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" }, outputStyle: "default" }) });
    const viaSettings = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" } }) }, { outputStyle: "default" });
    expect(explicit.system).toBe(unset.system);
    expect(viaSettings.system).toBe(unset.system);
    // ...and the style machinery contributed no text of its own to that prompt.
    for (const name of ["proactive", "explanatory", "learning"]) expect(unset.system).not.toContain(name);
  });

  test("an unresolvable style name changes nothing either", () => {
    const unset = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" } }) });
    const bogus = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" }, outputStyle: "../../etc/passwd" }) });
    expect(bogus.system).toBe(unset.system);
  });

  test("a built-in AUGMENTS: the authored preset survives and the style body follows it", () => {
    const out = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" }, outputStyle: "explanatory" }) });
    expect(out.system).toContain(WINTER_CODE_PRESET);
    expect(out.system).toContain("Explain as you work");
    expect(out.system.indexOf(WINTER_CODE_PRESET)).toBeLessThan(out.system.indexOf("Explain as you work"));
  });

  test("a USER-tier style with keep-coding-instructions:false REPLACES the authored prompt", () => {
    mkdirSync(join(home, "output-styles"), { recursive: true });
    writeFileSync(join(home, "output-styles", "takeover.md"), "---\ndescription: d\nkeep-coding-instructions: false\n---\nI AM THE PROMPT NOW\n", "utf8");
    const out = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code" }, outputStyle: "takeover" }) });
    expect(out.system).toContain("I AM THE PROMPT NOW");
    expect(out.system).not.toContain(WINTER_CODE_PRESET);
    // The mechanics that are not the authored prompt still stand.
    expect(out.system).toContain(DYNAMIC_SECTIONS_HEADING);
  });

  test("a style NEVER edits a caller-supplied string prompt -- `systemPrompt: <string>` means what it says", () => {
    mkdirSync(join(home, "output-styles"), { recursive: true });
    writeFileSync(join(home, "output-styles", "takeover.md"), "---\ndescription: d\nkeep-coding-instructions: false\n---\nI AM THE PROMPT NOW\n", "utf8");
    const out = assemble({ config: cfg({ systemPrompt: "CALLER TEXT", outputStyle: "takeover" }) });
    expect(out.system).toContain("CALLER TEXT");
    expect(out.system).not.toContain("I AM THE PROMPT NOW");
  });

  test("precedence: the input's name beats the config's, which beats the settings file's", () => {
    const fromSettings = assemble({}, { outputStyle: "learning" });
    expect(fromSettings.system).toContain("TODO(human)");
    const fromConfig = assemble({ config: cfg({ outputStyle: "explanatory" }) }, { outputStyle: "learning" });
    expect(fromConfig.system).toContain("Explain as you work");
    expect(fromConfig.system).not.toContain("TODO(human)");
    const fromInput = assemble({ config: cfg({ outputStyle: "explanatory" }), outputStyle: "proactive" }, { outputStyle: "learning" });
    expect(fromInput.system).toContain("Operate proactively");
  });

  test("a child inherits the style through the assembler input (§6.5) -- the same assembler, a child-shaped input", () => {
    const out = assemble({ outputStyle: "proactive", agentPrompt: "PERSONA" });
    expect(out.system).toContain("Operate proactively");
    expect(out.system).toContain("PERSONA");
  });
});

// --- Plan mode ------------------------------------------------------------------------------------

describe("assembler -- plan mode", () => {
  test("the block appears only while planMode is live", () => {
    expect(assemble({ planMode: false }).system).not.toContain(DEFAULT_PLAN_BODY);
    expect(assemble({ planMode: true }).system).toContain(DEFAULT_PLAN_BODY);
  });

  test("`hostPlanBody` replaces the body, mechanics intact", () => {
    const out = assemble({ planMode: true, hostPlanBody: "HOUSE PLAN RULES" });
    expect(out.system).toContain("HOUSE PLAN RULES");
    expect(out.system).not.toContain(DEFAULT_PLAN_BODY);
    expect(out.system).toContain("ExitPlanMode");
  });

  test("plansDirectory: config beats settings beats the DEFAULT (discharging T2-M2's unconsumed constant)", () => {
    expect(assemble({ planMode: true }).system).toContain(DEFAULT_PLANS_DIRECTORY);
    expect(assemble({ planMode: true }, { plansDirectory: "docs/plans" }).system).toContain("docs/plans");
    expect(assemble({ planMode: true, config: cfg({ plansDirectory: "cfg/plans" }) }, { plansDirectory: "docs/plans" }).system).toContain("cfg/plans");
  });
});

// --- Skills (R5-17) -------------------------------------------------------------------------------

describe("assembler -- the skill listing (R5-17: Lane S produces it, C only places it)", () => {
  test("a listing is rendered into `system`, names and descriptions intact", () => {
    const out = assemble({ skillListing: [{ name: "pdf-fill", description: "Fill a PDF form", source: "project" }] });
    expect(out.system).toContain("pdf-fill");
    expect(out.system).toContain("Fill a PDF form");
  });

  test("an absent or empty listing contributes nothing at all -- never a dangling empty header", () => {
    expect(assemble().system).not.toMatch(/skill/i);
    expect(assemble({ skillListing: [] }).system).not.toMatch(/skill/i);
  });

  test("descriptions are not re-truncated here -- the listing arrives POST-truncation (R5-17)", () => {
    const long = "d".repeat(500);
    expect(assemble({ skillListing: [{ name: "s", description: long, source: "user" }] }).system).toContain(long);
  });
});

// --- Structural guarantees ------------------------------------------------------------------------

describe("assembler -- structural guarantees", () => {
  test("the assembled `system` is never legitimately empty, on any arm (T3 report item 6)", () => {
    const arms: RuntimeConfig["systemPrompt"][] = [undefined, "", [], ["", ""], { type: "preset", preset: "claude_code" }];
    for (const systemPrompt of arms) {
      const out = assemble({ config: cfg(systemPrompt === undefined ? {} : { systemPrompt }) });
      expect(out.system.trim().length).toBeGreaterThan(0);
    }
  });

  test("assembly is deterministic: the same input twice produces byte-identical output", () => {
    writeFileSync(join(cwd, WINTER_MD_BASENAME), "PROJECT RULES", "utf8");
    const a = assemble({ planMode: true, skillListing: [{ name: "s", description: "d", source: "builtin" }] });
    const b = assemble({ planMode: true, skillListing: [{ name: "s", description: "d", source: "builtin" }] });
    expect(a.system).toBe(b.system);
    expect(a.userContextBlocks).toEqual(b.userContextBlocks);
  });

  test("no block is empty, and none contains a stray `undefined`", () => {
    writeFileSync(join(cwd, WINTER_MD_BASENAME), "PROJECT RULES", "utf8");
    const out = assemble({ config: cfg({ systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true } }) });
    for (const block of out.userContextBlocks) {
      expect(block.trim().length).toBeGreaterThan(0);
      expect(block).not.toContain("undefined");
    }
    expect(out.system).not.toContain("undefined");
  });

  test("the settings getter is read at ASSEMBLE time, so a hot settings reload takes effect with no reconstruction", () => {
    let live: Settings = { outputStyle: "explanatory" };
    const assembler = createSystemPromptAssembler({ home, settings: () => live });
    expect(assembler.assemble(inputFor()).system).toContain("Explain as you work");
    live = { outputStyle: "learning" };
    expect(assembler.assemble(inputFor()).system).toContain("TODO(human)");
  });
});

// --- GROUND TRUTH: the live provider request ------------------------------------------------------

describe("assembler -- ground truth is the LIVE request, not the assembler's return value", () => {
  test("the real assembler's system prompt and user-context blocks reach the provider", async () => {
    writeFileSync(join(cwd, WINTER_MD_BASENAME), "PROJECT RULES FROM DISK", "utf8");
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
      async generate(input) {
        requests.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
        return { kind: "text", text: "done" };
      },
    };
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: { sessionId: "s", cwd, model: "sonnet", systemPrompt: { type: "preset", preset: "claude_code" } },
      input: runtime.input,
      output: runtime.output,
      provider,
      tools: stubExecutor,
      systemPromptAssembler: createSystemPromptAssembler({ home }),
    });
    host.output.write({ type: "user", text: "hello" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    await done;

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.system).toContain(WINTER_CODE_PRESET);
    expect(req.system).toContain(DYNAMIC_SECTIONS_HEADING);
    // The blocks reached the LIVE user message, ahead of the prompt text, and WINTER.md is not in `system`.
    expect(req.system).not.toContain("PROJECT RULES FROM DISK");
    const userContent = String(req.messages.find((m) => m.role === "user")!.content);
    expect(userContent).toContain("PROJECT RULES FROM DISK");
    expect(userContent.endsWith("hello")).toBe(true);
  });
});

// Phase 5 Task 8: the SETTINGS-PROVENANCE scenario, plus the guards `production-wiring.ts` carries
// that nothing else exercises.
//
// IN-MEMORY BY DESIGN (the task brief says so), and the reason is what it proves rather than a
// convenience: a settings file's effect on a session is observable on the WIRE only through
// `system/init` and through what the assembler puts on the provider request, and both of those are
// leg-invariant by construction (the wiring is one function both entrypoints call). What is NOT
// leg-invariant, and is what this file is really about, is whether the right TIER won -- which needs
// a controlled `~/.winter` tree that a cross-leg comparison would have to build twice.
//
// EVERY FIXTURE BUILDS AN `mkdtemp` HOME AND PASSES IT EXPLICITLY. Nothing here reads `~/.winter`,
// `~/.norma`, `~/.claude`, the Keychain, or a real user's settings, and no path contains a real
// username.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "./testing.ts";
import { buildProductionWiring, assertEffectiveSettings, withAutoSkillPermissions } from "./production-wiring.ts";
import type { DetailedResolvedSettings } from "./settings/resolve.ts";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "winter-t8-wiring-home-"));
  cwd = mkdtempSync(join(tmpdir(), "winter-t8-wiring-cwd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function writeSettings(dir: string, settings: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
}

/** Drives ONE envelope through the real in-memory process and returns every data message. */
async function runOne(config: RuntimeConfig, env: Record<string, string | undefined>): Promise<SdkMessage[]> {
  const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], undefined, undefined, env);
  proc.stdin.write(encodeFrame({ type: "user", text: "hi" }));
  proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined }));
  const out: SdkMessage[] = [];
  let carry = "";
  for await (const chunk of proc.stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    for (const frame of split.frames as WinterFrame[]) {
      if (frame.type === "data") out.push((frame as { message: SdkMessage }).message);
    }
  }
  await proc.exited;
  return out;
}

function initFrame(msgs: SdkMessage[]): Record<string, unknown> {
  const init = msgs.find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "init");
  expect(init, "every run emits a system/init data frame").toBeDefined();
  return init as unknown as Record<string, unknown>;
}

describe("T8 settings provenance: the resolved tier a session actually runs under", () => {
  test("a USER-tier settings file's outputStyle reaches system/init.output_style", async () => {
    writeSettings(home, { outputStyle: "explanatory" });
    const msgs = await runOne({ sessionId: "prov-1", cwd, model: "sonnet", winterHome: home, settingSources: ["user"] }, { WINTER_HOME: home });
    expect(initFrame(msgs).output_style).toBe("explanatory");
  });

  test("`settingSources: []` reads NO file at all -- the same tree resolves to the default", async () => {
    // The discriminating half of the pair above. Without it, a green assertion could equally mean
    // "the file was read" or "the default happened to match".
    writeSettings(home, { outputStyle: "explanatory" });
    const msgs = await runOne({ sessionId: "prov-2", cwd, model: "sonnet", winterHome: home, settingSources: [] }, { WINTER_HOME: home });
    expect(initFrame(msgs).output_style).toBe("default");
  });

  test("an explicit `config.outputStyle` BEATS the settings file -- the chain is config > settings > default", async () => {
    writeSettings(home, { outputStyle: "explanatory" });
    const msgs = await runOne({ sessionId: "prov-3", cwd, model: "sonnet", winterHome: home, settingSources: ["user"], outputStyle: "learning" }, { WINTER_HOME: home });
    expect(initFrame(msgs).output_style).toBe("learning");
  });

  test("the PROJECT tier loses `autoMemoryDirectory` (OVERLAY_NEVER_KEYS) while the USER tier keeps it", async () => {
    // RULING P5-A's self-grant shape, at the wire: a repo-committed settings file pointing this
    // session's memory at a directory the REPOSITORY chose. The memory directory is observable
    // because the assembler names it in the auto-memory user-context block, which `echoProvider`
    // echoes back -- the same channel every other P5 golden reads it through.
    const stolen = join(cwd, "repo-chosen-memory");
    writeSettings(join(cwd, ".winter"), { autoMemoryDirectory: stolen });
    const project = await runOne({ sessionId: "prov-4", cwd, model: "sonnet", winterHome: home, settingSources: ["project"] }, { WINTER_HOME: home });
    const projectText = JSON.stringify(project);
    expect(projectText).not.toContain(stolen);

    // The identical key from the USER tier IS honoured -- which is what makes the assertion above a
    // statement about the TIER rather than about the key being unimplemented.
    const mine = join(home, "user-chosen-memory");
    writeSettings(home, { autoMemoryDirectory: mine });
    const user = await runOne({ sessionId: "prov-5", cwd, model: "sonnet", winterHome: home, settingSources: ["user"] }, { WINTER_HOME: home });
    expect(JSON.stringify(user)).toContain(mine);
  });

  test("`slash_commands` and `skills` reflect the resolved surface, not a hardcoded empty array", async () => {
    mkdirSync(join(home, "skills", "prov-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "prov-skill", "SKILL.md"), "---\nname: prov-skill\ndescription: a provenance probe\n---\nBODY\n");
    mkdirSync(join(home, "commands"), { recursive: true });
    writeFileSync(join(home, "commands", "prov-cmd.md"), "---\ndescription: a provenance probe command\n---\nDO THE THING\n");
    const msgs = await runOne({ sessionId: "prov-6", cwd, model: "sonnet", winterHome: home, settingSources: ["user"] }, { WINTER_HOME: home });
    const init = initFrame(msgs);
    expect(init.skills).toEqual(["prov-skill"]);
    // Built-ins FIRST (the engine claims `/compact` before any resolver is consulted), then the
    // resolver's own enumeration: skills, then command files.
    expect(init.slash_commands).toEqual(["compact", "prov-skill", "prov-cmd"]);
  });

  test("the same tree with `settingSources: []` advertises neither -- source gating reaches BOTH producers", async () => {
    mkdirSync(join(home, "skills", "prov-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "prov-skill", "SKILL.md"), "---\nname: prov-skill\ndescription: a provenance probe\n---\nBODY\n");
    mkdirSync(join(home, "commands"), { recursive: true });
    writeFileSync(join(home, "commands", "prov-cmd.md"), "---\ndescription: a probe\n---\nDO IT\n");
    const msgs = await runOne({ sessionId: "prov-7", cwd, model: "sonnet", winterHome: home, settingSources: [] }, { WINTER_HOME: home });
    const init = initFrame(msgs);
    expect(init.skills).toEqual([]);
    expect(init.slash_commands).toEqual(["compact"]); // the built-in is code, never a filesystem tier
  });
});

describe("T8 production wiring: the guards it carries", () => {
  test("`skills: []` means NONE -- not 'all', which an empty-set membership check would have read it as", async () => {
    mkdirSync(join(home, "skills", "prov-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "prov-skill", "SKILL.md"), "---\nname: prov-skill\ndescription: a probe\n---\nBODY\n");
    const wiring = await buildProductionWiring({
      config: { sessionId: "s", cwd, model: "sonnet", winterHome: home, settingSources: ["user"], skills: [] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toEqual([]);
      expect(wiring.engineOptions.skillListing).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });

  test("`skills` omitted means EVERY indexed skill (capture (4): omission is not skills-off)", async () => {
    mkdirSync(join(home, "skills", "prov-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "prov-skill", "SKILL.md"), "---\nname: prov-skill\ndescription: a probe\n---\nBODY\n");
    const wiring = await buildProductionWiring({
      config: { sessionId: "s", cwd, model: "sonnet", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toEqual(["prov-skill"]);
      expect(wiring.engineOptions.skillListing.map((s) => s.name)).toEqual(["prov-skill"]);
    } finally {
      wiring.dispose();
    }
  });

  test("an unknown name in `skills` is a WARNING, not a throw -- and the name never reaches the frame", async () => {
    const wiring = await buildProductionWiring({
      config: { sessionId: "s", cwd, model: "sonnet", winterHome: home, settingSources: ["user"], skills: ["does-not-exist"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.some((w) => w.includes("does-not-exist"))).toBe(true);
      expect(wiring.engineOptions.initSkills).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });

  test("`withAutoSkillPermissions` adds the BARE rule for the default, one per name for a list, and nothing when unset", () => {
    const base: RuntimeConfig = { sessionId: "s", cwd, model: "sonnet" };
    expect(withAutoSkillPermissions(base).allowedTools).toBeUndefined();
    expect(withAutoSkillPermissions({ ...base, skills: "all" }).allowedTools).toEqual(["Skill"]);
    expect(withAutoSkillPermissions({ ...base, skills: ["a", "b"] }).allowedTools).toEqual(["Skill(a)", "Skill(b)"]);
    // A host's own entries survive, and a duplicate is not added twice.
    expect(withAutoSkillPermissions({ ...base, skills: ["a"], allowedTools: ["Read", "Skill(a)"] }).allowedTools).toEqual(["Read", "Skill(a)"]);
  });

  test("rider 24: `assertEffectiveSettings` THROWS when handed a raw per-source view", () => {
    // The guard's whole point: `effective` and a per-source `values` are STRUCTURALLY IDENTICAL, so
    // an edit swapping one for the other type-checks and passes every other test in this repository.
    const projectRaw = { autoMemoryDirectory: "/repo/chosen" };
    const resolved = {
      effective: {},
      provenance: {},
      sources: [],
      perSource: [{ source: "project" as const, settings: projectRaw, values: projectRaw, loaded: true }],
    } as unknown as DetailedResolvedSettings;
    expect(() => assertEffectiveSettings(projectRaw, resolved)).toThrow(/RAW settings view/);
    // The correct view -- the project tier's contribution filtered out -- passes.
    expect(() => assertEffectiveSettings({}, resolved)).not.toThrow();
  });

  test("rider 24: the guard compares by VALUE -- a raw project view with the same PRESENCE as effective is still caught", () => {
    // The case a presence check misses, and the one that matters most: when the PROJECT tier and a
    // higher tier BOTH set the key, `effective` holds the higher tier's value while a raw project
    // view holds the project's. Same presence, different value -- exactly what OVERLAY_NEVER_KEYS
    // exists to drop, and exactly what a `key in settings` test would wave through.
    const projectRaw = { autoMemoryDirectory: "/repo/chosen" };
    const userRaw = { autoMemoryDirectory: "/home/chosen" };
    const resolved = {
      effective: userRaw,
      provenance: {},
      sources: [],
      perSource: [
        { source: "user" as const, settings: userRaw, values: userRaw, loaded: true },
        { source: "project" as const, settings: projectRaw, values: projectRaw, loaded: true },
      ],
    } as unknown as DetailedResolvedSettings;
    expect(() => assertEffectiveSettings(projectRaw, resolved)).toThrow(/RAW settings view/);
    expect(() => assertEffectiveSettings(userRaw, resolved)).not.toThrow();
  });

  // m7 (whole-branch review): the fixture that did not exist, and whose absence WAS the minor.
  // Every fixture above hands the guard a hand-built object; the production call site hands it
  // `resolved.effective`, and against the old predicate that comparison was `x === x`. These two
  // pass the PRODUCTION shape both ways round.
  test("m7: handed `resolved.effective`, the guard passes when the filter ran and THROWS when it did not", () => {
    const projectRaw = { autoMemoryDirectory: "/repo/chosen", outputStyle: "repo-style" };
    const base = {
      provenance: {},
      sources: [],
      perSource: [{ source: "project" as const, settings: projectRaw, values: projectRaw, loaded: true }],
    };
    // (a) the real shape: `withoutOverlayNeverKeys` dropped both keys, so `effective` is clean.
    const filtered = { ...base, effective: {} } as unknown as DetailedResolvedSettings;
    expect(() => assertEffectiveSettings(filtered.effective, filtered)).not.toThrow();

    // (b) a REGRESSION in resolveSettings' own filter -- the project's values reach `effective`.
    // The old predicate compared `effective` to `effective` and could not see this at all.
    const unfiltered = { ...base, effective: projectRaw } as unknown as DetailedResolvedSettings;
    expect(() => assertEffectiveSettings(unfiltered.effective, unfiltered)).toThrow(/RAW settings view/);
  });

  test("m7: another tier choosing the SAME value is not a regression", () => {
    // The one legitimate way `effective` may carry the project's value. A guard without this
    // exemption would fail a session whose user settings happen to agree with the repository.
    const shared = { outputStyle: "explanatory" };
    const resolved = {
      effective: shared,
      provenance: {},
      sources: [],
      perSource: [
        { source: "user" as const, settings: shared, values: shared, loaded: true },
        { source: "project" as const, settings: shared, values: shared, loaded: true },
      ],
    } as unknown as DetailedResolvedSettings;
    expect(() => assertEffectiveSettings(resolved.effective, resolved)).not.toThrow();
  });

  test("rider 24: a USER-tier `autoMemoryDirectory` is NOT a raw view -- the guard fires on the project tier alone", () => {
    const userRaw = { autoMemoryDirectory: "/home/chosen" };
    const resolved = {
      effective: userRaw,
      provenance: {},
      sources: [],
      perSource: [{ source: "user" as const, settings: userRaw, values: userRaw, loaded: true }],
    } as unknown as DetailedResolvedSettings;
    expect(() => assertEffectiveSettings(userRaw, resolved)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 5 fix wave, Lane Y addendum item 3 + nit n3: what an operator is actually TOLD.
// ---------------------------------------------------------------------------------------------
describe("wiring warnings are prose an operator can act on", () => {
  test("n3: a rejected mcp config names its origin, its path and its reason -- not a JSON blob", async () => {
    mkdirSync(join(cwd, ".winter"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "mcp.json"), "{ this is not json");
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-mcp-warn", cwd, model: "m" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      const warning = wiring.warnings.find((w) => w.includes("mcp config"));
      expect(warning).toBeDefined();
      expect(warning).toContain("from project");
      expect(warning).toContain(join(cwd, ".winter", "mcp.json"));
      expect(warning).toContain("not valid JSON");
      // The nit itself: no serialised record. A `{"origin":...}` string passes every assertion
      // above by accident, so the shape is pinned directly.
      expect(warning).not.toContain('{"');
    } finally {
      wiring.dispose();
    }
  });

  test("item 3: a wiring warning reaches the IN-MEMORY leg's stderr, as it does a spawned child's", async () => {
    mkdirSync(join(cwd, ".winter"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "mcp.json"), "{ this is not json");
    const config = { sessionId: "s-stderr", cwd, model: "m", persistSession: false } as unknown as RuntimeConfig;
    const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], undefined, undefined, { WINTER_HOME: home });
    // The handle has always DECLARED `stderr?: AsyncIterable<string>` (SpawnedRuntimeProcess); this
    // leg simply never populated it, which is what made every wiring warning invisible here.
    expect(proc.stderr).toBeDefined();
    proc.stdin.end();
    const chunks: string[] = [];
    for await (const chunk of proc.stderr!) chunks.push(chunk);
    await proc.exited;
    const text = chunks.join("");
    expect(text).toContain("winter: mcp config from project");
    expect(text).toContain("not valid JSON");
  });

  test("item 3: `SkillIndex.errors()` is consumed if present (structural, pending Lane Y's method)", async () => {
    // Guards the CONSUMER, which is the half that lives in my files. It reads `errors()` off the
    // index structurally, so this asserts the contract it will honour rather than the values Lane Y
    // has not landed yet: a wiring built over an index WITHOUT the method must not throw, and must
    // not invent warnings. When `errors()` lands, the `skill: ` prefix below is what carries it.
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-skill-warn", cwd, model: "m" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.filter((w) => w.startsWith("skill: "))).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });
});

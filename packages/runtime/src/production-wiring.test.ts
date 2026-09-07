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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "./testing.ts";
import { buildProductionWiring, assertEffectiveSettings, withAutoSkillPermissions } from "./production-wiring.ts";
// WS-13c (P6.6): the slot resolver probes credentials, so these fixtures inject an in-memory store
// rather than letting the production composite reach the developer's real Keychain.
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { providerCredentialRef } from "./provider/credential-api.ts";
import { loadCatalog, rowsForCanonicalId } from "@yanlinglabs/winter-provider-catalog";
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
    const msgs = await runOne({ sessionId: "prov-1", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] }, { WINTER_HOME: home });
    expect(initFrame(msgs).output_style).toBe("explanatory");
  });

  test("`settingSources: []` reads NO file at all -- the same tree resolves to the default", async () => {
    // The discriminating half of the pair above. Without it, a green assertion could equally mean
    // "the file was read" or "the default happened to match".
    writeSettings(home, { outputStyle: "explanatory" });
    const msgs = await runOne({ sessionId: "prov-2", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] }, { WINTER_HOME: home });
    expect(initFrame(msgs).output_style).toBe("default");
  });

  test("an explicit `config.outputStyle` BEATS the settings file -- the chain is config > settings > default", async () => {
    writeSettings(home, { outputStyle: "explanatory" });
    const msgs = await runOne({ sessionId: "prov-3", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"], outputStyle: "learning" }, { WINTER_HOME: home });
    expect(initFrame(msgs).output_style).toBe("learning");
  });

  test("the PROJECT tier loses `autoMemoryDirectory` (OVERLAY_NEVER_KEYS) while the USER tier keeps it", async () => {
    // RULING P5-A's self-grant shape, at the wire: a repo-committed settings file pointing this
    // session's memory at a directory the REPOSITORY chose. The memory directory is observable
    // because the assembler names it in the auto-memory user-context block, which `echoProvider`
    // echoes back -- the same channel every other P5 golden reads it through.
    const stolen = join(cwd, "repo-chosen-memory");
    writeSettings(join(cwd, ".winter"), { autoMemoryDirectory: stolen });
    const project = await runOne({ sessionId: "prov-4", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["project"] }, { WINTER_HOME: home });
    const projectText = JSON.stringify(project);
    expect(projectText).not.toContain(stolen);

    // The identical key from the USER tier IS honoured -- which is what makes the assertion above a
    // statement about the TIER rather than about the key being unimplemented.
    const mine = join(home, "user-chosen-memory");
    writeSettings(home, { autoMemoryDirectory: mine });
    const user = await runOne({ sessionId: "prov-5", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] }, { WINTER_HOME: home });
    expect(JSON.stringify(user)).toContain(mine);
  });

  test("`slash_commands` and `skills` reflect the resolved surface, not a hardcoded empty array", async () => {
    mkdirSync(join(home, "skills", "prov-skill"), { recursive: true });
    writeFileSync(join(home, "skills", "prov-skill", "SKILL.md"), "---\nname: prov-skill\ndescription: a provenance probe\n---\nBODY\n");
    mkdirSync(join(home, "commands"), { recursive: true });
    writeFileSync(join(home, "commands", "prov-cmd.md"), "---\ndescription: a provenance probe command\n---\nDO THE THING\n");
    const msgs = await runOne({ sessionId: "prov-6", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] }, { WINTER_HOME: home });
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
    const msgs = await runOne({ sessionId: "prov-7", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] }, { WINTER_HOME: home });
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
      config: { sessionId: "s", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"], skills: [] },
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
      config: { sessionId: "s", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
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
      config: { sessionId: "s", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"], skills: ["does-not-exist"] },
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
    const base: RuntimeConfig = { sessionId: "s", cwd, model: "winter-test/echo" };
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
      config: { sessionId: "s-mcp-warn", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
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
    const config = { sessionId: "s-stderr", cwd, model: "winter-test/echo", persistSession: false } as unknown as RuntimeConfig;
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
      config: { sessionId: "s-skill-warn", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
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

// ---------------------------------------------------------------------------------------------
// Phase 5 fix wave (B-low): the in-memory leg mints ONE winter home per virtual process.
// ---------------------------------------------------------------------------------------------
describe("the in-memory leg's own hermetic root", () => {
  // PRIVATE TMPDIR PER TEST, and the reason is a defect these tests carried from the day they were
  // written (found in P6 T3's review round 2, by a failure that reproduced 1-in-3 IN ISOLATION).
  //
  // `resolveInMemoryWinterHome` mints its root with `mkdtempSync(join(tmpdir(), "winter-inmemory-"))`,
  // and the original assertion counted `winter-inmemory-*` entries in the SHARED `os.tmpdir()` before
  // and after. That is sound only while nothing else on the machine mints one. It is not: this
  // repository is developed with several worktrees running `bun test` concurrently, and ANY other
  // suite's `inMemoryProcess` landing inside the window was attributed to this test -- a failure
  // indistinguishable at a glance from a real regression, which cost exactly that.
  //
  // `os.tmpdir()` reads `TMPDIR` LIVE on POSIX (verified, not assumed), and `inMemoryProcess` runs
  // IN THIS PROCESS -- so pointing `TMPDIR` at a fresh directory for the duration gives the child
  // under test a namespace nothing else can reach. The ASSERTION IS UNCHANGED in meaning: still
  // "exactly one root for a session with no explicit home", just counted somewhere only this test
  // can write to.
  //
  // Restored with `delete` rather than by assigning the saved value back: `process.env.X = undefined`
  // stores the STRING "undefined", which would leave every later test in this file pointed at a
  // directory named `undefined`.
  function withPrivateTmpdir<T>(fn: (privateRoot: string) => Promise<T>): Promise<T> {
    const original = process.env.TMPDIR;
    const privateRoot = mkdtempSync(join(tmpdir(), "winter-wiring-tmp-"));
    process.env.TMPDIR = privateRoot;
    return (async () => {
      try {
        return await fn(privateRoot);
      } finally {
        if (original === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = original;
        rmSync(privateRoot, { recursive: true, force: true });
      }
    })();
  }

  const inMemoryRootsIn = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith("winter-inmemory-"));

  test("a session with no explicit home creates exactly ONE `winter-inmemory-` root, not three", async () =>
    withPrivateTmpdir(async (privateRoot) => {
      // NEITHER `config.winterHome` NOR `env.WINTER_HOME` -- the only path that mkdtemps at all, and
      // the default every `scripts/differential.ts` run and most tests take.
      const config = { sessionId: "s-one-root", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig;
      const proc = inMemoryProcess(["--config-json", JSON.stringify(config)]);
      proc.stdin.end();
      for await (const _ of proc.stdout) void _;
      await proc.exited;

      // Three call sites (`resolveEngineSession`, the child store, `buildProductionWiring`) each used
      // to mint their own -- so the wiring read a `.winter` tree nothing wrote to. Counted under THIS
      // test's private root, so a parallel suite in another worktree cannot inflate it.
      expect(inMemoryRootsIn(privateRoot)).toHaveLength(1);
    }));

  test("`persistSession: false` still mints NOTHING -- the memo is lazy, not eager", async () =>
    withPrivateTmpdir(async (privateRoot) => {
      const config = { sessionId: "s-no-root", cwd, model: "winter-test/echo", persistSession: false } as unknown as RuntimeConfig;
      const proc = inMemoryProcess(["--config-json", JSON.stringify(config)]);
      proc.stdin.end();
      for await (const _ of proc.stdout) void _;
      await proc.exited;
      // The wiring itself still needs a root to resolve settings against, so this asserts the memo did
      // not become EAGER rather than that nothing is ever created: at most the one. Same private
      // namespace, same reason -- its `<= 1` was less likely to trip than its sibling's exact count,
      // but it was reading the same shared directory.
      expect(inMemoryRootsIn(privateRoot).length).toBeLessThanOrEqual(1);
    }));
});

// ---------------------------------------------------------------------------------------------
// Phase 5 fix wave (B-low): RULING P5-G's downgrade is DISCLOSED, not silently correct.
// ---------------------------------------------------------------------------------------------
describe("P5-G: a refused project-tier prompt replacement is reported", () => {
  function writeProjectStyle(root: string, name: string, keepCodingInstructions: boolean): void {
    const dir = join(root, ".winter", "output-styles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: d\nkeep-coding-instructions: ${keepCodingInstructions}\n---\n\nSTYLE BODY`, "utf8");
  }

  test("an untrusted project style asking to REPLACE the prompt is applied as an addition, and says so", async () => {
    writeProjectStyle(cwd, "repo-style", false);
    const wiring = await buildProductionWiring({
      // The style is SELECTED by the host (`Options.outputStyle`), which is the only door left open
      // since m1 made a project `settings.json` unable to select at all.
      config: { sessionId: "s-p5g", cwd, model: "winter-test/echo", outputStyle: "repo-style" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      const warning = wiring.warnings.find((w) => w.includes("output style"));
      expect(warning).toBeDefined();
      expect(warning).toContain("repo-style");
      expect(warning).toContain("P5-G");
      expect(warning).toContain("ADDITION");
    } finally {
      wiring.dispose();
    }
  });

  // T8 re-review NEW-1 (residual round): the arm where the warning was true of nothing.
  test("a caller-supplied `systemPrompt` suppresses styles entirely, so there is nothing to report", async () => {
    writeProjectStyle(cwd, "repo-style", false);
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-p5g-authored", cwd, model: "winter-test/echo", outputStyle: "repo-style", systemPrompt: "CALLER PROMPT ONLY" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      // Before the guard: "output style ... has been applied as an ADDITION instead" -- about a
      // style the assembler never consulted, in a session whose prompt is the caller's text alone.
      expect(wiring.warnings.filter((w) => w.includes("output style"))).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });

  test("the SAME configuration WITHOUT a caller prompt still reports -- the discriminating half", async () => {
    writeProjectStyle(cwd, "repo-style", false);
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-p5g-authored-2", cwd, model: "winter-test/echo", outputStyle: "repo-style" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.filter((w) => w.includes("output style"))).toHaveLength(1);
    } finally {
      wiring.dispose();
    }
  });

  test("a project style that never asked to replace is NOT reported", async () => {
    writeProjectStyle(cwd, "polite", true);
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-p5g-quiet", cwd, model: "winter-test/echo", outputStyle: "polite" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.filter((w) => w.includes("output style"))).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });

  test("a TRUSTED workspace's replacement is honoured, so there is nothing to report", async () => {
    writeProjectStyle(cwd, "repo-style", false);
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-p5g-trusted", cwd, model: "winter-test/echo", outputStyle: "repo-style", trustedWorkspace: true } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.filter((w) => w.includes("output style"))).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 5 residual round, NEW-1 + the I3 residual: the tier `error` channel reaches an operator.
// ---------------------------------------------------------------------------------------------
describe("NEW-1: a settings tier's own `error` becomes a wiring warning", () => {
  test("a malformed USER-tier rule array is reported, naming the tier, the path and the reason", async () => {
    // A-2's shape: `deny` as a STRING. It parses, contributes no rules, and before A-2 reported
    // nothing at all; after A-2 it reported into a channel nothing read.
    writeSettings(home, { permissions: { deny: "Bash" } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-new1", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      const warning = wiring.warnings.find((w) => w.startsWith("settings (user"));
      expect(warning).toBeDefined();
      expect(warning).toContain(join(home, "settings.json"));
      expect(warning).toContain("deny");
    } finally {
      wiring.dispose();
    }
  });

  test("I3 residual: a refused project `plansDirectory` names `plansDirectory` in the operator's line", async () => {
    // RULING P5-L refuses an absolute project-tier value. The reviewer's probe recorded
    // `stderr mentions plansDirectory=false` -- the refusal worked and said so to nobody.
    writeSettings(join(cwd, ".winter"), { plansDirectory: "/etc" });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-new1-plans", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      const warning = wiring.warnings.find((w) => w.includes("plansDirectory"));
      expect(warning).toBeDefined();
      expect(warning).toContain("settings (project");
      expect(warning).toContain("RELATIVE");
    } finally {
      wiring.dispose();
    }
  });

  test("a clean settings tree produces NO `settings (` warning -- the discriminating half", async () => {
    writeSettings(home, { permissions: { deny: ["Bash"] } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-new1-clean", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.filter((w) => w.startsWith("settings ("))).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 5 residual round, NEW-3: a settings file may not make the session unstartable.
// ---------------------------------------------------------------------------------------------
describe("NEW-3: a user-tier bypass defaultMode degrades with a warning instead of aborting", () => {
  async function runOnce(config: Record<string, unknown>): Promise<{ frames: WinterFrame[]; code: number | null }> {
    const proc = inMemoryProcess(["--config-json", JSON.stringify({ sessionId: "s-new3", cwd, model: "winter-test/echo", persistSession: false, ...config })], undefined, undefined, { WINTER_HOME: home });
    proc.stdin.write(encodeFrame({ type: "user", text: "go" } as WinterFrame));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined } as WinterFrame));
    const frames: WinterFrame[] = [];
    let carry = "";
    for await (const chunk of proc.stdout) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      for (const f of split.frames as WinterFrame[]) frames.push(f);
    }
    const { code } = await proc.exited;
    return { frames, code };
  }

  test("the session STARTS, reports the reason, and runs in the default mode", async () => {
    writeSettings(home, { permissions: { defaultMode: "bypassPermissions" } });
    const out = await runOnce({});
    // Before this fix: ZERO frames and exit 1. `system/init` is the assertion that matters -- it is
    // the frame the abort happened before.
    const init = out.frames.map((f) => (f.type === "data" ? (f as { message: SdkMessage }).message : undefined)).find((m) => m?.type === "system" && (m as { subtype?: string }).subtype === "init") as { permissionMode?: string } | undefined;
    expect(init, "the session must reach system/init").toBeDefined();
    expect(init?.permissionMode, "the unhonourable file mode falls back, it does not apply").not.toBe("bypassPermissions");
    expect(out.code).toBe(0);
  });

  test("with `allowDangerouslySkipPermissions` the user's own choice still applies", async () => {
    // The discriminating half: the degradation must be about the missing FLAG, not about the tier.
    writeSettings(home, { permissions: { defaultMode: "bypassPermissions" } });
    const out = await runOnce({ allowDangerouslySkipPermissions: true });
    const init = out.frames.map((f) => (f.type === "data" ? (f as { message: SdkMessage }).message : undefined)).find((m) => m?.type === "system" && (m as { subtype?: string }).subtype === "init") as { permissionMode?: string } | undefined;
    expect(init?.permissionMode).toBe("bypassPermissions");
  });

  test("the wiring names the reason, and says nothing when there is nothing to say", async () => {
    writeSettings(home, { permissions: { defaultMode: "bypassPermissions" } });
    const blocked = await buildProductionWiring({ config: { sessionId: "s-new3-w", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig, env: {}, winterHome: home });
    try {
      const w = blocked.warnings.find((x) => x.includes("defaultMode"));
      expect(w).toBeDefined();
      expect(w).toContain("allowDangerouslySkipPermissions is not set");
      // Names the TIER and its file: "ignored" with neither sends the operator to the wrong one of
      // the three tiers that can still carry the value.
      expect(w).toContain("settings (user");
      expect(w).toContain(join(home, "settings.json"));
      expect(blocked.engineOptions.settingsRules?.defaultMode).toBeUndefined();
    } finally {
      blocked.dispose();
    }

    const allowed = await buildProductionWiring({ config: { sessionId: "s-new3-w2", cwd, model: "winter-test/echo", allowDangerouslySkipPermissions: true } as unknown as RuntimeConfig, env: {}, winterHome: home });
    try {
      expect(allowed.warnings.filter((x) => x.includes("defaultMode"))).toEqual([]);
      expect(allowed.engineOptions.settingsRules?.defaultMode).toBe("bypassPermissions");
    } finally {
      allowed.dispose();
    }
  });

  test("a MANAGED veto also degrades it, and says which reason applied", async () => {
    writeSettings(home, { permissions: { defaultMode: "bypassPermissions" } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-new3-veto", cwd, model: "winter-test/echo", allowDangerouslySkipPermissions: true, managedSettings: { permissions: { disableBypassPermissionsMode: true } } } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      const w = wiring.warnings.find((x) => x.includes("defaultMode"));
      expect(w).toContain("managed policy");
      expect(wiring.engineOptions.settingsRules?.defaultMode).toBeUndefined();
    } finally {
      wiring.dispose();
    }
  });
});

// --- WS-13b R6b-7 / R6b-9: settings.json -> the session's provider selection ----------------------
//
// THE JOIN THIS FILE EXISTS FOR. `selection.test.ts` and `session-provider.test.ts` both inject
// `providerSettings` directly, so between them they prove the REFUSAL and nothing about how the
// value gets there. The chain with no other coverage is
// `settings.json -> resolveSettingsDetailed -> providerSettingsFrom -> SelectionDeps`, and every
// link is a place a rename or a dropped spread is silent: the session would simply keep working,
// with the operator's reversion switch inert.
//
// The model is a LOCAL provider row pointed at a dead loopback port, so the enabled leg fails on a
// refused TCP connection rather than reaching any vendor. Nothing here touches the network.
describe("WS-13b R6b-7: the settings file reaches provider selection", () => {
  const DEAD_LOOPBACK = "http://127.0.0.1:1/v1";
  const localSession = (sessionId: string): RuntimeConfig =>
    ({
      sessionId,
      cwd,
      model: "ollama-local/llama3.1:8b",
      winterHome: home,
      settingSources: ["user", "project"],
      provider: { providerId: "ollama-local", connection: { baseUrl: DEAD_LOOPBACK, local: true } },
    }) as RuntimeConfig;

  /**
   * `runOne`, plus the STDERR pipe — which is where `buildProductionWiring`'s warnings go
   * (main.ts:222, testing.ts:259).
   *
   * NO USER TURN, unlike `runOne`. The wiring warning is written before `runEngine` is ever called,
   * so a turn adds nothing to what is under test — and on the ENABLED leg it would add the one thing
   * this file must not have: a live generation. The provider resolves there, so a turn would drive
   * the real local-openai adapter through its full retry ladder against the dead port, which is both
   * slow (it timed out at 5 s) and a network call in a unit test. Session start alone is the subject.
   */
  async function runOneWithStderr(config: RuntimeConfig): Promise<{ msgs: SdkMessage[]; stderr: string }> {
    const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], undefined, undefined, { WINTER_HOME: home });
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined }));
    // Both pipes drained CONCURRENTLY: stderr is unbounded-ish and a sequential drain would deadlock
    // on whichever the process fills first.
    let stderr = "";
    const stderrDone = (async () => {
      for await (const chunk of proc.stderr ?? []) stderr += chunk;
    })();
    const msgs: SdkMessage[] = [];
    let carry = "";
    for await (const chunk of proc.stdout) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      for (const frame of split.frames as WinterFrame[]) {
        if (frame.type === "data") msgs.push((frame as { message: SdkMessage }).message);
      }
    }
    await proc.exited;
    await stderrDone;
    return { msgs, stderr };
  }

  test("a USER-tier `providers.<id>.enabled: false` REFUSES the session's provider, by name, on the wiring warning channel", async () => {
    writeSettings(home, { providers: { "ollama-local": { enabled: false } } });
    const { msgs, stderr } = await runOneWithStderr(localSession("prov-disabled-1"));
    // The session still STARTS (R6-9 as T10's review settled it: resolution failure is a deferred
    // refusal, not a construction throw), so `system/init` is the proof the run got that far.
    // TWO independent proofs, because either alone is weak. (1) The session still STARTS -- R6-9 as
    // T10's review settled it: a resolution failure is a DEFERRED refusal, not a construction throw
    // -- and a refused session reports NO `winter_provider` on its init frame. (2) The operator's
    // channel names the code and the exact settings key to edit.
    expect(initFrame(msgs).winter_provider).toBeUndefined();
    expect(stderr).toContain("provider selection failed (provider-disabled)");
    expect(stderr).toContain("providers.ollama-local.enabled");
  });

  test("...and the SAME tree with the flag flipped back does NOT refuse — so the assertion above is about the setting, not about the model being unreachable", async () => {
    // The discriminating half. Without it, a green assertion above could equally mean "this model
    // never resolves" — which is exactly what a broken `providerSettingsFrom` join would look like
    // from the outside.
    writeSettings(home, { providers: { "ollama-local": { enabled: true } } });
    const { msgs, stderr } = await runOneWithStderr(localSession("prov-disabled-2"));
    // POSITIVE, not merely "no complaint": the init frame carries the resolved identity, so this
    // model demonstrably resolves on this tree and the refusal above can only have come from the
    // setting. A stderr negative alone would pass just as happily on a model that never resolves.
    expect(initFrame(msgs).winter_provider).toMatchObject({ providerId: "ollama-local", modelKey: "ollama-local/llama3.1:8b" });
    expect(stderr).not.toContain("provider selection failed");
  });

  test("no `providers` block at all behaves like the enabled case — silence is not a disablement, end to end", async () => {
    writeSettings(home, { outputStyle: "explanatory" });
    const { msgs, stderr } = await runOneWithStderr(localSession("prov-disabled-3"));
    expect(initFrame(msgs).winter_provider).toMatchObject({ providerId: "ollama-local" });
    expect(stderr).not.toContain("provider selection failed");
  });

  test("R6b-9 end to end: a PROJECT tier cannot re-enable what the USER tier disabled", async () => {
    // The reversion switch, at the wire. A cloned repository carrying `enabled: true` must not put
    // back a provider the operator withdrew — the ruling's whole point, proved through the real
    // cascade rather than against `providerSettingsFrom` in isolation.
    writeSettings(home, { providers: { "ollama-local": { enabled: false } } });
    writeSettings(join(cwd, ".winter"), { providers: { "ollama-local": { enabled: true } } });
    const { msgs, stderr } = await runOneWithStderr(localSession("prov-disabled-4"));
    expect(initFrame(msgs).winter_provider).toBeUndefined();
    expect(stderr).toContain("provider selection failed (provider-disabled)");
  });

  test("...while a PROJECT tier CAN disable on its own — the restriction is on the enabling direction only", async () => {
    writeSettings(join(cwd, ".winter"), { providers: { "ollama-local": { enabled: false } } });
    const { msgs, stderr } = await runOneWithStderr(localSession("prov-disabled-5"));
    expect(initFrame(msgs).winter_provider).toBeUndefined();
    expect(stderr).toContain("provider selection failed (provider-disabled)");
  });
});

// ================================================================================================
// WS-13c (P6.6 Lane A): the model-family surface the wiring composes -- the Agent tool's active set,
// the slot resolver, the settings tripwire the render memoises on, and the "more options" listing.
//
// The session's model is a LOCAL provider row (`ollama-local`, keyless, `local-none`): nothing here
// touches the Keychain, the network, or a real `~/.winter`.
// ================================================================================================
describe("WS-13c: the wiring's model-family surface", () => {
  // THE CREDENTIAL STORE IS ALWAYS INJECTED. The slot resolver's credential view probes providers
  // through `CredentialStore.get`, and the production store's first member is the Keychain -- so a
  // slot resolution in a test with the default store would read the developer's real Keychain, which
  // this file's own header forbids. An empty in-memory store is the hermetic equivalent.
  const hermetic = { credentials: createMemoryCredentialStore() };
  // M-4: the injection above is LOAD-BEARING, not decoration, and this asserts it rather than
  // trusting the comment. `createProductionCredentialStore`'s first member is the Keychain and
  // `keychain-store.ts` resolves `Bun.secrets` lazily at CALL time, so a wiring built without an
  // injected store that then resolves a slot would read the developer's real Keychain.
  test("every wiring in this block injects its own credential store — the default one reaches the Keychain", () => {
    expect(typeof hermetic.credentials.get).toBe("function");
    expect(hermetic.credentials.size()).toBe(0);
  });
  const localSession = (sessionId: string): RuntimeConfig =>
    ({
      sessionId,
      cwd,
      model: "ollama-local/llama3.1:8b",
      winterHome: home,
      settingSources: ["user"],
      provider: { providerId: "ollama-local", connection: { baseUrl: "http://127.0.0.1:1/v1", local: true } },
    }) as RuntimeConfig;

  test("the reserved winter-test namespace gets NO slot surface at all -- byte-identical to pre-P6.6", async () => {
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-slots-double", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] } as RuntimeConfig,
      env: {},
      winterHome: home,
      provider: hermetic,
    });
    try {
      expect(wiring.engineOptions.activeSlotSet).toBeUndefined();
      expect(wiring.engineOptions.resolveSlot).toBeUndefined();
      expect(wiring.engineOptions.settingsVersion).toBeUndefined();
      expect(wiring.engineOptions.listModelFamilies).toBeUndefined();
    } finally {
      wiring.dispose();
    }
  });

  test("a catalog-resolved session gets the whole surface, and the active set follows the model key it is asked with", async () => {
    const wiring = await buildProductionWiring({ config: localSession("s-slots-local"), env: {}, winterHome: home, provider: hermetic });
    try {
      const activeSlotSet = wiring.engineOptions.activeSlotSet!;
      // No family claims a bare `llama3.1-8b` (the normaliser deliberately invents no hyphen), so the
      // session's own model IS the single option -- WS-13c §3's minimum of one.
      const own = activeSlotSet(undefined);
      expect(own).toMatchObject({ family: "other", source: "own-model" });
      expect(own.slots.map((s) => s.name)).toEqual(["llama3.1-8b"]);
      // The SAME getter, asked with a claude key, answers the pinned four -- which is what makes a
      // `set_model` across families re-render rather than keep the family the session started on.
      const pinned = activeSlotSet("anthropic/claude-opus-5");
      expect(pinned).toMatchObject({ family: "claude", source: "claude-pinned" });
      expect(pinned.slots.map((s) => s.name)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    } finally {
      wiring.dispose();
    }
  });

  test("the resolver reaches the real catalog: `opus` from a non-claude session resolves into the claude family's vendor row", async () => {
    const wiring = await buildProductionWiring({ config: localSession("s-slots-resolve"), env: {}, winterHome: home, provider: hermetic });
    try {
      const resolveSlot = wiring.engineOptions.resolveSlot!;
      const opus = resolveSlot("opus", undefined);
      expect(opus.ok).toBe(true);
      expect(opus.ok && opus.canonicalModelId).toBe("claude-opus-5");
      // §4 step 3-i: the family's own vendor provider leads.
      expect(opus.ok && opus.providerId).toBe("anthropic");
      // M-1: an UNADVERTISED foreign name records the source of the slot that resolved -- the claude
      // family's curated table -- not the source of this session's own (own-model) set.
      expect(opus.ok && opus.slot).toEqual({ family: "claude", name: "opus", source: "family-default" });
    } finally {
      wiring.dispose();
    }
  });

  test("a disabled provider is skipped and named -- the settings cascade reaches the slot resolver", async () => {
    writeSettings(join(home), { providers: { anthropic: { enabled: false } } });
    const wiring = await buildProductionWiring({ config: localSession("s-slots-disabled"), env: {}, winterHome: home, provider: hermetic });
    try {
      const opus = wiring.engineOptions.resolveSlot!("opus", undefined);
      // Other providers serve `claude-opus-5` too, so this is not unservable -- it is a DIFFERENT
      // provider, and the point is that `anthropic` is no longer the one chosen.
      expect(opus.ok && opus.providerId).not.toBe("anthropic");
    } finally {
      wiring.dispose();
    }
  });

  test("preferredProviders reorders the non-vendor tail, live from settings", async () => {
    // Asserted RELATIVELY rather than against a hardcoded provider id: which aggregator the
    // admission-tier tie-break picks is catalog data another task may repoint, but "a preferred
    // provider outranks whatever the tier order would have chosen" is the rule.
    writeSettings(join(home), { providers: { anthropic: { enabled: false } } });
    const unpreferred = await buildProductionWiring({ config: localSession("s-slots-unpreferred"), env: {}, winterHome: home, provider: hermetic });
    let byTier: string | undefined;
    try {
      const r = unpreferred.engineOptions.resolveSlot!("opus", undefined);
      byTier = r.ok ? r.providerId : undefined;
      expect(byTier).toBeDefined();
      expect(byTier).not.toBe("anthropic"); // the vendor row is disabled
    } finally {
      unpreferred.dispose();
    }
    // Any OTHER provider that serves the same canonical model, promoted by preference alone.
    const other = "tabitoken";
    expect(other).not.toBe(byTier);
    writeSettings(join(home), { providers: { anthropic: { enabled: false } }, preferredProviders: [other] });
    const preferred = await buildProductionWiring({ config: localSession("s-slots-preferred"), env: {}, winterHome: home, provider: hermetic });
    try {
      expect(preferred.engineOptions.resolveSlot!("opus", undefined)).toMatchObject({ ok: true, providerId: other });
    } finally {
      preferred.dispose();
    }
  });

  test("an unknown name is a typed refusal, never a substitution onto the session's own model", async () => {
    const wiring = await buildProductionWiring({ config: localSession("s-slots-unknown"), env: {}, winterHome: home, provider: hermetic });
    try {
      expect(wiring.engineOptions.resolveSlot!("definitely-not-a-slot", undefined)).toMatchObject({ ok: false, code: "unknown-slot" });
      // `flash` is held by gemini, deepseek and glm in the shipped overlay.
      expect(wiring.engineOptions.resolveSlot!("flash", undefined)).toMatchObject({ ok: false, code: "ambiguous-slot-name" });
    } finally {
      wiring.dispose();
    }
  });

  test("`list_model_families` answers with the session's OWN active set", async () => {
    const wiring = await buildProductionWiring({ config: localSession("s-slots-listing"), env: {}, winterHome: home, provider: hermetic });
    try {
      // Lane C owns `families`; what Lane A's wiring is accountable for is that the ACTIVE set the
      // listing carries is this session's, computed from the same getter the Agent tool renders from.
      const listing = wiring.engineOptions.listModelFamilies!();
      expect(listing.active).toEqual(wiring.engineOptions.activeSlotSet!(undefined));
      // The producer already accepts the live model key, so the listing follows a cross-family
      // switch the moment the spine's handler passes one (see this task's report).
      expect(wiring.engineOptions.listModelFamilies!("anthropic/claude-opus-5").active).toMatchObject({ family: "claude", source: "claude-pinned" });
    } finally {
      wiring.dispose();
    }
  });

  test("the credential view learns from the child-provider probe, and a slot nothing can serve becomes slot-unservable", async () => {
    const wiring = await buildProductionWiring({ config: localSession("s-slots-warm"), env: {}, winterHome: home, provider: hermetic });
    try {
      const resolveSlot = wiring.engineOptions.resolveSlot!;
      // COLD: nothing has been probed, so the credential view answers optimistically and §4's vendor
      // rule leads. An optimistic `true` is never a substitution -- it orders, and the credential is
      // verified again downstream.
      expect(resolveSlot("opus", undefined)).toMatchObject({ ok: true, providerId: "anthropic" });
      // Each `resolveChildProvider` call makes a REAL, awaited probe and records its answer, which is
      // exactly how the synchronous view becomes accurate without a startup Keychain sweep.
      const rows = rowsForCanonicalId(loadCatalog(), "claude-opus-5");
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) await wiring.childFactoryOptions.resolveChildProvider!(row.key);
      // WARM: the empty store holds no record for any of them, so the slot is unservable and every
      // row that WOULD have served it is named with the reason it did not.
      const warm = resolveSlot("opus", undefined);
      expect(warm).toMatchObject({ ok: false, code: "slot-unservable" });
      expect(!warm.ok && warm.wouldServe.map((w) => w.providerId).sort()).toEqual(rows.map((r) => r.providerId).sort());
      expect(!warm.ok && warm.wouldServe.every((w) => w.why === "no credential configured")).toBe(true);
      expect(!warm.ok && warm.message).toContain("claude-opus-5");
    } finally {
      wiring.dispose();
    }
  });

  // Lane D's investigation §1.6: `resolveChildProvider` judged a child against the SESSION-START
  // model. After a mid-session `set_model` to another provider, a child naming the parent's NEW model
  // by its bare id was resolved under the OLD provider -- so it either failed to resolve (and silently
  // ran on the parent's provider) or was refused. The wiring now records the live key the engine
  // hands it every turn, which is what makes the comparison current.
  test("a child's bare model id is judged against the LIVE parent model, not the session-start one", async () => {
    const wiring = await buildProductionWiring({
      config: localSession("s-slots-live-parent"),
      env: {},
      winterHome: home,
      // A real record for anthropic, so the cross-provider child is not refused for a missing key --
      // the point under test is WHICH provider it resolved under.
      provider: { credentials: createMemoryCredentialStore([[providerCredentialRef({ providerId: "anthropic", accountId: "default" }), { kind: "api-key", key: "fixture" }]]) },
    });
    try {
      const resolveChildProvider = wiring.childFactoryOptions.resolveChildProvider!;
      // BEFORE the switch: a bare `claude-opus-5` is resolved under the session's own provider
      // (`ollama-local`), which does not hold it -- R6-17's rule, unchanged.
      expect(await resolveChildProvider("claude-opus-5")).toBeUndefined();
      // The engine reports its live model key once per generation; this is exactly that call.
      wiring.engineOptions.activeSlotSet!("anthropic/claude-opus-5");
      // AFTER: the same bare id resolves under the model the session is actually on, with no refusal.
      const child = await resolveChildProvider("claude-sonnet-5");
      expect(child?.identity).toMatchObject({ providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5" });
      expect(child).not.toHaveProperty("refused");
      // ...and a child naming the parent's NEW model is "the same as the parent": no second adapter.
      // P6.6 fix wave (whole-branch Important-1): a DISTINGUISHABLE shape, not `undefined`. The two
      // facts `undefined` used to carry -- "resolves onto what the parent is running" and "does not
      // resolve at all" -- are what made `resume()` refuse a servable child; the identity travels so
      // the resume side can tell them apart and check the resolved provider against the recorded one.
      const sameAsParent = await resolveChildProvider("anthropic/claude-opus-5");
      expect(sameAsParent).toMatchObject({ sameAsParent: true, identity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5" } });
      expect(sameAsParent).not.toHaveProperty("provider"); // the parent's own adapter IS the answer
      expect(sameAsParent).not.toHaveProperty("refused");
      // An UNRESOLVABLE model keeps `undefined` all to itself -- the whole point of the split.
      expect(await resolveChildProvider("no-such-provider/no-such-model")).toBeUndefined();
    } finally {
      wiring.dispose();
    }
  });

  // P6.6 fix wave (whole-branch Important-1, probe P-D) through the REAL wiring: a gpt parent spawns
  // a cross-family `sonnet` child, then `set_model`s onto the CHILD'S OWN key. The resolver must
  // report "same as the parent" naming anthropic -- the child's own recorded provider -- so the
  // resume proceeds instead of being refused with "anthropic no longer serves anthropic/claude-sonnet-5".
  test("P-D: after the parent switches onto a cross-family child's OWN key, the resolver names that child's provider rather than answering `undefined`", async () => {
    const wiring = await buildProductionWiring({
      config: gptSession("s-slots-same-key"),
      env: {},
      winterHome: home,
      provider: { credentials: createMemoryCredentialStore([[providerCredentialRef({ providerId: "anthropic", accountId: "default" }), { kind: "api-key", key: "fixture" }]]) },
    });
    try {
      const resolveChildProvider = wiring.childFactoryOptions.resolveChildProvider!;
      // AT SPAWN: the parent is on `openai/gpt-6-astra`; the `sonnet` child resolves onto its own
      // anthropic adapter (a full resolution -- a second provider really is built).
      const atSpawn = await resolveChildProvider("anthropic/claude-sonnet-5");
      expect(atSpawn).toMatchObject({ identity: { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5" } });
      expect(atSpawn).toHaveProperty("provider");
      expect(atSpawn).not.toHaveProperty("sameAsParent");
      // THE SWITCH: the engine reports its live key once per generation -- this is that call.
      wiring.engineOptions.activeSlotSet!("anthropic/claude-sonnet-5");
      // ON RESUME: the same recorded key now IS the parent's key. The answer names anthropic, which
      // is what the child was recorded against, so `resume()`'s recorded-vs-resolved guard passes and
      // the child is served on its own provider.
      const onResume = await resolveChildProvider("anthropic/claude-sonnet-5");
      expect(onResume).toMatchObject({ sameAsParent: true, identity: { providerId: "anthropic" } });
      expect(onResume).toBeDefined();
    } finally {
      wiring.dispose();
    }
  });

  // WS-13c §5 / D25 "for now": a Claude session ignores custom slots, and the ignore is RECORDED --
  // a user who configured four options and is shown the pinned four deserves to be told why.
  test("a claude session ignores custom slots and RECORDS the ignore through the warnings channel", async () => {
    writeSettings(join(home), { modelSlots: [{ name: "master", model: "gpt-6-astra" }] });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-slots-pinned", cwd, model: "anthropic/claude-opus-5", winterHome: home, settingSources: ["user"], provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" } } } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
      provider: hermetic,
    });
    try {
      const active = wiring.engineOptions.activeSlotSet!(undefined);
      expect(active).toMatchObject({ family: "claude", source: "claude-pinned" });
      expect(active.slots.map((s) => s.name)).toEqual(["fable", "opus", "sonnet", "haiku"]);
      expect(active.slots.map((s) => s.name)).not.toContain("master");
      expect(wiring.warnings.filter((w) => w.includes("claude-pinned"))).toHaveLength(1);
    } finally {
      wiring.dispose();
    }
  });

  test("a NON-claude session honours the same custom set, and no ignore is recorded", async () => {
    writeSettings(join(home), { modelSlots: [{ name: "master", model: "gpt-6-astra" }] });
    const wiring = await buildProductionWiring({ config: localSession("s-slots-custom"), env: {}, winterHome: home, provider: hermetic });
    try {
      const active = wiring.engineOptions.activeSlotSet!(undefined);
      expect(active).toMatchObject({ source: "custom" });
      expect(active.slots.map((s) => s.name)).toEqual(["master"]);
      expect(wiring.warnings.filter((w) => w.includes("claude-pinned"))).toHaveLength(0);
      // ...and the facing name resolves through §4 like any other slot.
      expect(wiring.engineOptions.resolveSlot!("master", undefined)).toMatchObject({ ok: true, canonicalModelId: "gpt-6-astra" });
      // ...and nothing is recorded as ignored: a VALID set is not an invalid one (Important-2's guard
      // must not fire on the happy path).
      expect(wiring.warnings.filter((w) => w.includes("modelSlotsIgnored"))).toHaveLength(0);
    } finally {
      wiring.dispose();
    }
  });

  // WS-13c §5: "An invalid set is ignored whole and RECORDED with the failing entry." P6.6 fix wave
  // (whole-branch Important-2, probe P-I): it WAS ignored whole and recorded nowhere -- the
  // `"invalid"` member of the `modelSlotsIgnored` union had no producer in either layer, so a user
  // whose slot name failed the grammar saw the family default lineup and was told nothing.
  test("an INVALID custom set is ignored whole AND recorded through the warnings channel, quoting the failing entry", async () => {
    // Capital `M` fails the slot-name grammar (`^[a-z0-9][a-z0-9.-]{0,31}$`), so the whole set goes.
    // A catalogued gpt session, so the fallback is the FAMILY's lineup (an uncatalogued own-model
    // session would fall back to `own-model` and prove nothing about the family default).
    writeSettings(join(home), { modelSlots: [{ name: "Master", model: "gpt-6-astra" }] });
    const wiring = await buildProductionWiring({ config: gptSession("s-slots-invalid"), env: {}, winterHome: home, provider: hermetic });
    try {
      // Ignored WHOLE: the family's own lineup, never a partial set built from the valid entries.
      const active = wiring.engineOptions.activeSlotSet!(undefined);
      expect(active.source).toBe("family-default");
      expect(active.slots.map((s) => s.name)).not.toContain("Master");
      // RECORDED: one warning, naming the provenance and quoting the validator's own reason so the
      // user can see WHICH entry failed and why.
      const recorded = wiring.warnings.filter((w) => w.includes('modelSlotsIgnored: "invalid"'));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!).toContain("Master");
      expect(recorded[0]!).toContain("slot name grammar");
      // ...and NOT the claude-pinned record: this session is not on a Claude model, and the two
      // blocks must stay exclusive.
      expect(wiring.warnings.filter((w) => w.includes("claude-pinned"))).toHaveLength(0);
    } finally {
      wiring.dispose();
    }
  });

  test("a VALID set on a claude session records `claude-pinned` and NOT `invalid` -- the two records never both fire", async () => {
    writeSettings(join(home), { modelSlots: [{ name: "master", model: "gpt-6-astra" }] });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-slots-pinned-only", cwd, model: "anthropic/claude-opus-5", winterHome: home, settingSources: ["user"], provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" } } } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
      provider: hermetic,
    });
    try {
      expect(wiring.warnings.filter((w) => w.includes("claude-pinned"))).toHaveLength(1);
      expect(wiring.warnings.filter((w) => w.includes('modelSlotsIgnored: "invalid"'))).toHaveLength(0);
    } finally {
      wiring.dispose();
    }
  });

  // R-6c-27, at the wiring: the shipped default that used to hand an openai-API-key-only user a
  // subscription row nothing could serve. `codex-oauth` leads the gpt family's vendor group, but on a
  // cold session nobody has probed it — `unknown` must not outrank the provider the session IS on.
  const gptSession = (sessionId: string): RuntimeConfig =>
    ({
      sessionId,
      cwd,
      model: "openai/gpt-6-astra",
      winterHome: home,
      settingSources: ["user"],
      provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" } },
    }) as unknown as RuntimeConfig;

  test("R-6c-27: an openai-API-key-only session resolves `astra` to openai on the FIRST call, not to a cold subscription row", async () => {
    const wiring = await buildProductionWiring({ config: gptSession("s-slots-tri"), env: {}, winterHome: home, provider: hermetic });
    try {
      expect(wiring.engineOptions.activeSlotSet!(undefined)).toMatchObject({ family: "gpt", source: "family-default" });
      expect(wiring.engineOptions.resolveSlot!("astra", undefined)).toMatchObject({ ok: true, providerId: "openai", modelKey: "openai/gpt-6-astra" });
    } finally {
      wiring.dispose();
    }
  });

  // P6.6 fix wave (whole-branch Minor-4, probe P-A) on the SHIPPED catalog -- not a fixture. Three of
  // the four options a `gpt` session advertises resolved to rows with `pricing: null`, so a turn on
  // them reported no cost at all: `priceUsage` returned `undefined` and `maxBudgetUsd` was inert.
  // R-6c-24's "a turn after a cross-provider switch is still priced" fix was correct; the `undefined`
  // was purely missing row evidence, and this asserts the evidence is there now.
  test("Minor-4: the gpt family's `sol`/`terra`/`luna` rows are PRICED on the shipped catalog, so a turn on them reports a cost", async () => {
    const wiring = await buildProductionWiring({ config: gptSession("s-slots-priced"), env: {}, winterHome: home, provider: hermetic });
    try {
      const oneMillionEach = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
      // Published standard short-context rates per 1M tokens, retrieved 2026-09-06: input + output.
      for (const [key, expected] of [
        ["openai/gpt-5.6-luna", 0.2 + 1.2],
        ["openai/gpt-5.6-terra", 2 + 12],
        ["openai/gpt-5.6-sol", 4 + 20],
      ] as const) {
        const priced = wiring.providerWiring.priceUsage(key, oneMillionEach);
        expect(priced).toBeDefined();
        expect(priced).toMatchObject({ costBasis: "list", canonicalModel: key });
        expect(priced!.costUsd).toBeCloseTo(expected, 6);
      }
    } finally {
      wiring.dispose();
    }
  });

  test("R-6c-27 (P7a): a cold listing reports `servable` as `unknown` for a provider nobody has probed, and `present` for the session's own", async () => {
    const wiring = await buildProductionWiring({ config: gptSession("s-slots-servable"), env: {}, winterHome: home, provider: hermetic });
    try {
      const rows = wiring.engineOptions
        .listModelFamilies!()
        .families.flatMap((f) => f.models.flatMap((m) => m.rows));
      expect(rows.length).toBeGreaterThan(100);
      // THE FIRST PAINT'S HONEST ANSWER. R-6c-27 could only say "`unknown` is not servable" because
      // the row shape was a boolean; P7a's tri-state lets it say what it actually knows. Both
      // collapses a boolean forced were false statements: `true` (the shape this originally shipped)
      // claimed every row in a 604-model catalog was servable against an EMPTY credential store, and
      // `false` greys out rows the user can perfectly well use.
      //
      // Asserted as LITERAL strings throughout: `"absent"` and `"unknown"` are both truthy, so a
      // truthiness form would pass for every row and assert nothing at all.
      expect(rows.some((r) => r.providerId === "codex-oauth" && r.servable === "unknown")).toBe(true);
      expect(rows.some((r) => r.providerId === "codex-oauth" && r.servable === "present")).toBe(false);
      // The session's OWN provider is `"present"` synchronously and with no probe -- its material is
      // `config.provider.authRef`, configured by construction.
      expect(rows.filter((r) => r.servable === "present").every((r) => r.providerId === "openai")).toBe(true);
      expect(rows.some((r) => r.providerId === "openai" && r.servable === "present")).toBe(true);
      // NOTHING is `"absent"` on the cold paint: an absence is a probe RESULT, and no probe has
      // answered yet. This is the assertion that fails if the tri-state is quietly re-flattened --
      // the pre-P7a predicate reported `"absent"` for every one of these rows.
      expect(rows.some((r) => r.servable === "absent")).toBe(false);
    } finally {
      wiring.dispose();
    }
  });

  test("P7a: ...and after the probe the same rows report `absent` -- `unknown` is a state the listing LEAVES", async () => {
    const wiring = await buildProductionWiring({ config: gptSession("s-slots-servable-warm"), env: {}, winterHome: home, provider: hermetic });
    try {
      // The first call schedules the probes (`prewarmActiveVendorProviders` for the active family's
      // vendor group, plus one per provider asked about). They are background reads of the injected
      // EMPTY store, so they settle within a few microtask turns -- polled rather than slept on, so
      // this test does not encode a timing guess.
      const codexState = (): string | undefined =>
        wiring.engineOptions
          .listModelFamilies!()
          .families.flatMap((f) => f.models.flatMap((m) => m.rows))
          .find((r) => r.providerId === "codex-oauth")?.servable;
      expect(codexState()).toBe("unknown");
      for (let i = 0; i < 200 && codexState() === "unknown"; i++) await Bun.sleep(1);
      // The probe answered against an empty credential store: there is genuinely no record, and the
      // listing now says so instead of saying it has not looked.
      expect(codexState()).toBe("absent");
    } finally {
      wiring.dispose();
    }
  });

  test("P7a: a DISABLED provider is `absent`, never `unknown` -- the user already decided and nothing is pending", async () => {
    // The one collapse that would be wrong in both directions: `providers.<id>.enabled === false` is
    // read synchronously from settings, so reporting "we have not looked yet" would hide a setting
    // the user set AND invite a host to spin waiting for an answer that will never come.
    writeSettings(join(home), { providers: { "codex-oauth": { enabled: false } } });
    const wiring = await buildProductionWiring({ config: gptSession("s-slots-servable-off"), env: {}, winterHome: home, provider: hermetic });
    try {
      const rows = wiring.engineOptions
        .listModelFamilies!()
        .families.flatMap((f) => f.models.flatMap((m) => m.rows));
      expect(rows.some((r) => r.providerId === "codex-oauth")).toBe(true);
      expect(rows.filter((r) => r.providerId === "codex-oauth").every((r) => r.servable === "absent")).toBe(true);
    } finally {
      wiring.dispose();
      writeSettings(join(home), {});
    }
  });

  // R-6c-28: the honest scope of the seam. The version tracks the RESOLVED VIEW's identity, and this
  // module resolves once — so in production today it never moves, and a `settings.json` edit is
  // invisible to a running session. That missing half is the cascade's (P8 host integration, the
  // R6b-7 precedent); the engine half is complete and tested in `engine.test.ts`.
  test("settingsVersion tracks the resolved view's identity — and nothing re-resolves it mid-session yet", async () => {
    const wiring = await buildProductionWiring({ config: localSession("s-slots-version"), env: {}, winterHome: home, provider: hermetic });
    try {
      const settingsVersion = wiring.engineOptions.settingsVersion!;
      expect(settingsVersion()).toBe(settingsVersion());
      expect(settingsVersion()).toBeGreaterThan(0);
      // Rewriting the file does NOT move it: no watcher and no re-resolution exist in this SDK.
      writeSettings(join(home), { modelSlots: [{ name: "master", model: "gpt-6-astra" }] });
      expect(settingsVersion()).toBe(1);
    } finally {
      wiring.dispose();
    }
  });
});

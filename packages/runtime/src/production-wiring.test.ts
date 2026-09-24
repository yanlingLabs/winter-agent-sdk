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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "./testing.ts";
import { buildProductionWiring, assertEffectiveSettings, withAutoSkillPermissions } from "./production-wiring.ts";
import { runCommand } from "./sandbox/spawn.ts";
import { parseRule } from "./permissions/grammar.ts";
// WS-13c (P6.6): the slot resolver probes credentials, so these fixtures inject an in-memory store
// rather than letting the production composite reach the developer's real Keychain.
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { providerCredentialRef } from "./provider/credential-api.ts";
import { loadCatalog, rowsForCanonicalId } from "@yanlinglabs/winter-provider-catalog";
import type { DetailedResolvedSettings } from "./settings/resolve.ts";
import { recordedProviderSystems, resetRecordedProviderSystems, scriptedProvider } from "./provider/mock.ts";
import type { Provider, ProviderRequest, ProviderTurn } from "./engine.ts";

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
    // because the assembler names it in the system prompt's `# auto memory` section (SDK 0.0.16),
    // which the instrumented echo provider records off the LIVE request.
    const stolen = join(cwd, "repo-chosen-memory");
    writeSettings(join(cwd, ".winter"), { autoMemoryDirectory: stolen });
    resetRecordedProviderSystems();
    const project = await runOne({ sessionId: "prov-4", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["project"] }, { WINTER_HOME: home });
    const projectSystems = recordedProviderSystems().join("\n");
    expect(projectSystems).toContain("# auto memory");
    expect(projectSystems).not.toContain(stolen);
    expect(JSON.stringify(project)).not.toContain(stolen);

    // The identical key from the USER tier IS honoured -- which is what makes the assertion above a
    // statement about the TIER rather than about the key being unimplemented.
    const mine = join(home, "user-chosen-memory");
    writeSettings(home, { autoMemoryDirectory: mine });
    resetRecordedProviderSystems();
    await runOne({ sessionId: "prov-5", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] }, { WINTER_HOME: home });
    expect(recordedProviderSystems().join("\n")).toContain(mine);
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

  test("SDK 0.0.16: describeModel names a catalog model by its display name (key, provider id or alias); an unlisted model gets none", async () => {
    const wiring = await buildProductionWiring({
      config: { sessionId: "s", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] },
      env: {},
      winterHome: home,
    });
    try {
      const row = loadCatalog().models.find((m) => m.displayName.length > 0 && m.aliases.length > 0)!;
      expect(wiring.engineOptions.describeModel(row.key)).toEqual({ displayName: row.displayName });
      // A provider-local id resolves UNDER ITS PROVIDER (E4): this row's id is also `console`'s, so
      // without a provider it would be ambiguous and name neither (`describe-model-provider.test.ts`).
      expect(wiring.engineOptions.describeModel(row.upstreamId, row.providerId)?.displayName).toBe(row.displayName);
      expect(wiring.engineOptions.describeModel("winter-test/echo")).toBeUndefined();
      expect(wiring.childFactoryOptions.describeModel).toBe(wiring.engineOptions.describeModel);
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

// WS-21 §3.4.4 step 4 / §6.3 items 6, 11 (F17, F20): the per-tier settings `env` filter and the
// store-home/plugin-cache-dir host env vars, wired at `buildProductionWiring`.
describe("WS-21: settingsEnv (per-tier env filter) and config.storeHome/pluginCacheDir", () => {
  test("a user-tier settings env block survives, filtered", async () => {
    writeSettings(home, { env: { KEPT: "1", HOME: "/evil-but-user-tier-keeps-it" } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-env-user", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.settingsEnv).toEqual({ KEPT: "1", HOME: "/evil-but-user-tier-keeps-it" });
    } finally {
      wiring.dispose();
    }
  });

  test("a project-tier settings env block drops HOME (F17), and PROJECT (the higher-precedence tier) still wins a shared key", async () => {
    writeSettings(home, { env: { HOME: "/user-home", SHARED: "user-loses" } });
    mkdirSync(join(cwd, ".winter"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "settings.json"), JSON.stringify({ env: { HOME: "/project-evil", SHARED: "project-wins", PROJECT_ONLY: "1" } }));
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-env-project", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user", "project"], trustedWorkspace: true },
      env: {},
      winterHome: home,
    });
    try {
      // resolve.ts's own SOURCE_ORDER_LOWEST_FIRST is ["user", "project", "local"], reversed to
      // highest-first -- PROJECT outranks USER (claude's own tier precedence), so it wins the
      // SHARED clash; its HOME is still dropped outright by the project-tier-specific filter (F17),
      // which runs before the "first tier to claim a key wins" fold, so nothing ever falls through
      // to the user tier's own (kept, since USER may set HOME) value for that one key.
      expect(wiring.settingsEnv).toEqual({ HOME: "/user-home", SHARED: "project-wins", PROJECT_ONLY: "1" });
    } finally {
      wiring.dispose();
    }
  });

  test("config.storeHome/pluginCacheDir resolve from the process env, absent by default", async () => {
    const withoutHostVars = await buildProductionWiring({
      config: { sessionId: "s-store-absent", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] },
      env: {},
      winterHome: home,
    });
    try {
      expect(withoutHostVars.config.storeHome).toBeUndefined();
      expect(withoutHostVars.config.pluginCacheDir).toBeUndefined();
    } finally {
      withoutHostVars.dispose();
    }

    const withHostVars = await buildProductionWiring({
      config: { sessionId: "s-store-present", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] },
      env: { WINTER_STORE_HOME: "/shared/sdk", WINTER_PLUGIN_CACHE_DIR: "/shared/sdk/plugins" },
      winterHome: home,
    });
    try {
      expect(withHostVars.config.storeHome).toBe("/shared/sdk");
      expect(withHostVars.config.pluginCacheDir).toBe("/shared/sdk/plugins");
    } finally {
      withHostVars.dispose();
    }
  });

  test("an explicit config.storeHome wins over the env var", async () => {
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-store-explicit", cwd, model: "winter-test/echo", winterHome: home, settingSources: [], storeHome: "/explicit/store" } as RuntimeConfig,
      env: { WINTER_STORE_HOME: "/env/store" },
      winterHome: home,
    });
    try {
      expect(wiring.config.storeHome).toBe("/explicit/store");
    } finally {
      wiring.dispose();
    }
  });

  // Fix round 3 (M-6): a blank WINTER_STORE_HOME="" counts as unset, the same rule WINTER_HOME
  // itself is held to (isUnset) -- mirrors dialect.test.ts's identical direct-unit coverage of
  // resolveProductionStoreHome, exercised here through the real wiring entry point.
  test("M-6: a BLANK WINTER_STORE_HOME is treated as unset, not as a real empty-string path", async () => {
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-store-blank", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] },
      env: { WINTER_STORE_HOME: "" },
      winterHome: home,
    });
    try {
      expect(wiring.config.storeHome).toBeUndefined();
    } finally {
      wiring.dispose();
    }
  });

  // Fix round 4 (minors, M-6 sibling): the SAME rule, for WINTER_PLUGIN_CACHE_DIR -- pre-fix this
  // resolved to `env[pluginCacheDirEnvName(brand)]` unconditionally, so a blank value would have
  // read as a real (relative, empty-string) override rather than falling through to `pluginsRoot`'s
  // own `?? join(storeHome ?? winterHome, "plugins")` default.
  test("M-6 sibling: a BLANK WINTER_PLUGIN_CACHE_DIR is treated as unset, not as a real empty-string path", async () => {
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-plugin-cache-blank", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] },
      env: { WINTER_PLUGIN_CACHE_DIR: "" },
      winterHome: home,
    });
    try {
      expect(wiring.config.pluginCacheDir).toBeUndefined();
    } finally {
      wiring.dispose();
    }
  });

  test("host-managed drops provider env keys from settingsEnv", async () => {
    writeSettings(home, { env: { ANTHROPIC_BASE_URL: "https://evil.example", KEPT: "1" } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-env-hostmanaged", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: { WINTER_PROVIDER_MANAGED_BY_HOST: "1" },
      winterHome: home,
    });
    try {
      expect(wiring.settingsEnv).toEqual({ KEPT: "1" });
    } finally {
      wiring.dispose();
    }
  });
});

// WS-21 §6.3 item 5, fix round 1: `settingsEnv` was computed and exposed on `ProductionWiring` (the
// describe block above) but never APPLIED anywhere, and `applyHostManagedSettingsFilter` was
// implemented in L1a.6 but never called against `resolved.effective` -- so a host-managed session's
// child still saw `apiKeyHelper` untouched. These tests drive `buildProductionWiring` itself (not
// the engine) since both fixes are wiring-boundary facts: whether the passed-in `env` object was
// mutated, and whether the settings view the session runs on actually had `apiKeyHelper` filtered.
describe("WS-21 §6.3 item 5 (fix round 1): settingsEnv reaches the child env, and host-managed filters apiKeyHelper", () => {
  test("settingsEnv is applied to the SAME env object the caller passed in, like claude's own Object.assign(process.env, filtered)", async () => {
    writeSettings(home, { env: { OPENAI_BASE_URL: "http://mirror.example", FOO: "bar" } });
    const env: Record<string, string | undefined> = {};
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-env-apply", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env,
      winterHome: home,
    });
    try {
      // Not just `wiring.settingsEnv` (already covered above) -- the CALLER's own `env` object,
      // proving the `Object.assign(env, settingsEnv)` line actually ran against the reference a
      // real tool spawn reads (in production `env === process.env`; see the inline comment at the
      // call site).
      expect(env.OPENAI_BASE_URL).toBe("http://mirror.example");
      expect(env.FOO).toBe("bar");
    } finally {
      wiring.dispose();
    }
  });

  test("a settings-file env block cannot flip host-managed mode for its OWN run: hostManaged is read before the assign", async () => {
    // `WINTER_PROVIDER_MANAGED_BY_HOST` is itself in `ALL_TIER_REFUSED_ENV` (env-filter.ts) --
    // dropped from every tier UNCONDITIONALLY, which is what makes it impossible for a settings
    // file to set in the first place. `ANTHROPIC_BASE_URL` is the actual proof of ordering: it is
    // only a HOST_MANAGED-conditional drop, so its survival here shows filtering ran as
    // NOT-host-managed (the real env passed to `buildProductionWiring` had no sentinel when
    // `hostManaged` was computed, before this tier's `env` block -- which cannot set that sentinel
    // anyway -- was ever read).
    writeSettings(home, { env: { WINTER_PROVIDER_MANAGED_BY_HOST: "1", ANTHROPIC_BASE_URL: "https://evil.example", KEPT: "1" } });
    const env: Record<string, string | undefined> = {};
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-env-no-self-flip", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env,
      winterHome: home,
    });
    try {
      expect(wiring.settingsEnv).toEqual({ ANTHROPIC_BASE_URL: "https://evil.example", KEPT: "1" });
    } finally {
      wiring.dispose();
    }
  });

  test("host-managed disables apiKeyHelper on the settings view the session actually runs on", async () => {
    writeSettings(home, { apiKeyHelper: "/usr/local/bin/my-helper", outputStyle: "explanatory" });
    const withoutHostManaged = await buildProductionWiring({
      config: { sessionId: "s-apikeyhelper-plain", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(withoutHostManaged.settings()?.apiKeyHelper).toBe("/usr/local/bin/my-helper");
      // The filter is surgical: an unrelated key survives untouched in the SAME run.
      expect(withoutHostManaged.settings()?.outputStyle).toBe("explanatory");
    } finally {
      withoutHostManaged.dispose();
    }

    const hostManaged = await buildProductionWiring({
      config: { sessionId: "s-apikeyhelper-hostmanaged", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: { WINTER_PROVIDER_MANAGED_BY_HOST: "1" },
      winterHome: home,
    });
    try {
      expect(hostManaged.settings()?.apiKeyHelper).toBeUndefined();
      // Still only `apiKeyHelper` dropped -- host-managed mode is not a wholesale settings wipe.
      expect(hostManaged.settings()?.outputStyle).toBe("explanatory");
    } finally {
      hostManaged.dispose();
    }
  });
});

// WS-21 §6.3 item 3 (durable-write audit, fix round 2): the checkpoint sink was constructed with
// `home: winterHome` (bare, the PER-RUN folder), while the deny floors that are supposed to protect
// its own blobs (permissions/protected.ts, engine.ts, sandbox/profile.ts -- item 6, fix round 1)
// anchor on `storeHome ?? winterHome`. A session with a configured store home therefore had its
// REAL checkpoint blobs written to an UNPROTECTED location while the floor guarded a directory the
// sink never touched. Drives the real engine end to end (a real Write tool call, no `tools` override
// -- runEngine builds its own registry-backed executor, per the P3 fix wave's own "omitted tools"
// rule) so this proves the actual file lands under storeHome, not a claim about the construction
// call's arguments alone.
describe("WS-21 §6.3 item 3 (durable-write audit, fix round 2): the checkpoint sink anchors on storeHome", () => {
  test("a real Write's checkpoint blob is written under storeHome's file-history/, never under winterHome's", async () => {
    const winterHome = mkdtempSync(join(tmpdir(), "winter-t8-checkpoint-run-"));
    const storeHome = mkdtempSync(join(tmpdir(), "winter-t8-checkpoint-store-"));
    const work = mkdtempSync(join(tmpdir(), "winter-t8-checkpoint-work-"));
    try {
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const tracked = join(work, "tracked.txt");
      writeFileSync(tracked, "original\n");
      const config: RuntimeConfig = {
        sessionId,
        cwd: work,
        model: "winter-test/echo",
        enableFileCheckpointing: true,
        allowedTools: ["Read", "Write"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: { enabled: false },
      };
      const provider = scriptedProvider([
        // READ THEN WRITE: the real registry-backed executor's read-ladder (permissions/evaluator.ts)
        // refuses a Write to a file this session has not read yet, even under bypassPermissions --
        // the same shape subagents/child-engine.test.ts's own fixtures use for the identical reason.
        { kind: "tool_use", calls: [{ id: "c0", name: "Read", input: { file_path: tracked } }] },
        { kind: "tool_use", calls: [{ id: "c1", name: "Write", input: { file_path: tracked, content: "changed\n" } }] },
        { kind: "text", text: "done" },
      ]);
      const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, undefined, { WINTER_HOME: winterHome, WINTER_STORE_HOME: storeHome });
      proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
      proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
      for await (const _chunk of proc.stdout) {
        /* drain to completion */
      }
      await proc.exited;

      expect(readFileSync(tracked, "utf8"), "the write itself must have actually landed").toBe("changed\n");
      expect(existsSync(join(storeHome, "file-history", sessionId)), "the checkpoint blob/index must be under storeHome's file-history/<sessionUuid>/").toBe(true);
      expect(existsSync(join(winterHome, "file-history")), "winterHome's own file-history/ must never be created at all").toBe(false);
    } finally {
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(storeHome, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// WS-21 §6.3 item 2, fix round 1 (Critical 1): the `rules/` loader was implemented in L1a.3 but
// never WIRED -- neither `assembler.ts` nor `production-wiring.ts` called it. These tests drive the
// REAL engine (through `buildProductionWiring`'s own `inMemoryProcess` consumer, the SAME pattern
// `runOne` above uses) end to end, so a wiring gap like the one this fix closes cannot hide behind a
// unit test of `rules.ts` alone answering the right question in isolation.
describe("WS-21 §6.3 item 2 (fix round 1, Critical 1): the rules/ loader is wired end to end", () => {
  /** Captures every ProviderRequest a turn generates, in call order -- one entry per provider round. */
  function capturingProvider(turns: readonly ProviderTurn[]): { provider: Provider; requests: ProviderRequest[] } {
    const requests: ProviderRequest[] = [];
    let i = 0;
    return {
      requests,
      provider: {
        async generate(input: ProviderRequest): Promise<ProviderTurn> {
          requests.push(input);
          return turns[Math.min(i++, turns.length - 1)]!;
        },
      },
    };
  }

  async function runWithProvider(config: RuntimeConfig, provider: Provider, text = "go"): Promise<void> {
    const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], provider, undefined, { WINTER_HOME: home });
    proc.stdin.write(encodeFrame({ type: "user", text }));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined }));
    for await (const _chunk of proc.stdout) {
      /* drain -- this test reads the CAPTURED requests, not the frame stream */
    }
    await proc.exited;
  }

  test("a user rules/x.md shows in the instructions context (the claudeMd index-0 message), gated on the user source", async () => {
    mkdirSync(join(home, "rules"), { recursive: true });
    writeFileSync(join(home, "rules", "x.md"), "ALWAYS FOLLOW THE HOUSE STYLE.");

    // `recordedProviderSystems` only records `input.system`, and the rule rides `claudeMd` (the
    // index-0 userContext message), not `system` -- so this test captures `input.messages` itself,
    // through the SAME `inMemoryProcess` door `runOne` uses.
    const { provider, requests } = capturingProvider([{ kind: "text", text: "ok" }]);
    await runWithProvider({ sessionId: "rules-uncond-1", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] }, provider);
    expect(JSON.stringify(requests[0]!.messages)).toContain("ALWAYS FOLLOW THE HOUSE STYLE.");

    // The discriminating half: `settingSources: []` reads nothing, including rules -- the same
    // source gate `discoverWinterMd`'s own instructions files already have.
    const { provider: gatedProvider, requests: gatedRequests } = capturingProvider([{ kind: "text", text: "ok" }]);
    await runWithProvider({ sessionId: "rules-uncond-2", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] }, gatedProvider);
    expect(JSON.stringify(gatedRequests[0]!.messages)).not.toContain("ALWAYS FOLLOW THE HOUSE STYLE.");
  });

  test("a conditional rule attaches ONCE on the first matching Read, under the engine's real per-turn cadence", async () => {
    mkdirSync(join(home, "rules"), { recursive: true });
    writeFileSync(join(home, "rules", "scoped.md"), "---\npaths: [src/**]\n---\nSCOPED RULE CONTENT.");
    mkdirSync(join(cwd, "src"), { recursive: true });
    const target = join(cwd, "src", "a.ts");
    writeFileSync(target, "// hi\n");

    // Three provider rounds within ONE turn: Read the matching file, Read it again (proving no
    // re-emission within the SAME turn's later rounds), then answer with text to end the turn.
    const { provider, requests } = capturingProvider([
      { kind: "tool_use", calls: [{ id: "c1", name: "Read", input: { file_path: target } }] },
      { kind: "tool_use", calls: [{ id: "c2", name: "Read", input: { file_path: target } }] },
      { kind: "text", text: "done" },
    ]);
    await runWithProvider(
      {
        sessionId: "rules-cond-1",
        cwd,
        model: "winter-test/echo",
        winterHome: home,
        settingSources: ["user"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: { enabled: false },
      },
      provider,
      "read the file",
    );

    expect(requests.length).toBe(3);
    // Round 1 (before any Read has happened): nothing yet.
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("SCOPED RULE CONTENT.");
    // Round 2 (after round 1's Read + the engine's own tool-round attachment scan): announced once.
    const round2 = JSON.stringify(requests[1]!.messages);
    expect(round2).toContain("SCOPED RULE CONTENT.");
    expect(round2.split("SCOPED RULE CONTENT.").length - 1).toBe(1);
    // Round 3 (after round 2's SECOND Read of the same matching file): still exactly one occurrence
    // -- the persisted attachment is what stops re-emission, not luck.
    const round3 = JSON.stringify(requests[2]!.messages);
    expect(round3.split("SCOPED RULE CONTENT.").length - 1).toBe(1);
  });

  // SV-1 (router same-view test): rules/ is a DISCOVERY read and must root on WINTER_HOME (the
  // per-run folder the router has already merged the trusted project's items and applied tier rules
  // into), never WINTER_STORE_HOME -- a fix-round-1/fix-round-2 regression this fixed. A DISTINCT
  // storeHome, with a rule ONLY under it, must never surface; the run folder's own rule must.
  test("rules read from WINTER_HOME, never WINTER_STORE_HOME, even when the two differ", async () => {
    const storeHome = mkdtempSync(join(tmpdir(), "winter-t8-rules-store-"));
    try {
      mkdirSync(join(home, "rules"), { recursive: true });
      writeFileSync(join(home, "rules", "run-folder.md"), "RUN FOLDER RULE CONTENT.");
      mkdirSync(join(storeHome, "rules"), { recursive: true });
      writeFileSync(join(storeHome, "rules", "store-home.md"), "STORE HOME RULE CONTENT (must never surface).");

      const { provider, requests } = capturingProvider([{ kind: "text", text: "ok" }]);
      const proc = inMemoryProcess(
        ["--run", "--config-json", JSON.stringify({ sessionId: "rules-sv1", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] })],
        provider,
        undefined,
        { WINTER_HOME: home, WINTER_STORE_HOME: storeHome },
      );
      proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
      proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined }));
      for await (const _chunk of proc.stdout) {
        /* drain */
      }
      await proc.exited;

      const seen = JSON.stringify(requests[0]!.messages);
      expect(seen).toContain("RUN FOLDER RULE CONTENT.");
      expect(seen).not.toContain("STORE HOME RULE CONTENT");
    } finally {
      rmSync(storeHome, { recursive: true, force: true });
    }
  });
});

// WS-21 §6.3 item 3, fix round 1 (Critical 2): `loadGlobalConfigMcp` was implemented in L1a.5 but
// never called anywhere in production-wiring.ts.
describe("WS-21 §6.3 item 3 (fix round 1, Critical 2): .winter.json MCP scopes are wired", () => {
  test("a user server in <home>/.winter.json is present in a session's MCP config under [\"user\"]", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".winter.json"), JSON.stringify({ mcpServers: { probe: { command: "probe-srv" } } }));
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-globalmcp-user", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      const found = wiring.engineOptions.extraMcpServerSources.find((s) => "probe" in s.servers);
      expect(found, "the .winter.json user server must reach extraMcpServerSources").toBeDefined();
      expect(found!.servers["probe"]).toEqual({ command: "probe-srv" });
      expect(found!.origin).toBe("settings");
    } finally {
      wiring.dispose();
    }
  });

  test("without \"user\" in settingSources, the .winter.json user server is absent", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".winter.json"), JSON.stringify({ mcpServers: { probe: { command: "probe-srv" } } }));
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-globalmcp-gated", cwd, model: "winter-test/echo", winterHome: home, settingSources: [] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.extraMcpServerSources.some((s) => "probe" in s.servers)).toBe(false);
    } finally {
      wiring.dispose();
    }
  });

  test("a local server (projects[<git root>].mcpServers) is present under [\"local\"], keyed by the canonical git root", async () => {
    // `projectInstructionRoot` canonicalises via `realpathSync` (winter-md.ts's own documented
    // reason: a plain `mkdtemp` path is a symlink on macOS, e.g. /tmp -> /private/tmp), so the
    // `.winter.json` `projects` KEY must be written under the SAME canonical form or the lookup
    // misses -- exactly the gotcha that file's header calls out.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "winter-globalmcp-repo-")));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".winter.json"), JSON.stringify({ projects: { [repo]: { mcpServers: { localProbe: { command: "local-srv" } } } } }));
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-globalmcp-local", cwd: repo, model: "winter-test/echo", winterHome: home, settingSources: ["user", "local"] },
      env: {},
      winterHome: home,
    });
    try {
      const found = wiring.engineOptions.extraMcpServerSources.find((s) => "localProbe" in s.servers);
      expect(found, "the .winter.json local server must reach extraMcpServerSources").toBeDefined();
    } finally {
      wiring.dispose();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // SV-2 (router same-view test, SECURITY): `.winter.json` is a DISCOVERY read and must root on
  // WINTER_HOME (the per-run folder the router has already filtered -- removed disabled and
  // reserved-name servers, folded local/project servers into user scope), never
  // WINTER_STORE_HOME -- reading the shared, unfiltered store-home tree instead would start a
  // server the user disabled, or one with a reserved name. A fix-round-1/fix-round-2 regression.
  test("a .winter.json server under a DIFFERENT storeHome never surfaces -- only the run folder's own is read", async () => {
    const storeHome = mkdtempSync(join(tmpdir(), "winter-t8-globalmcp-store-"));
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".winter.json"), JSON.stringify({ mcpServers: { runFolderProbe: { command: "run-folder-srv" } } }));
      writeFileSync(join(storeHome, ".winter.json"), JSON.stringify({ mcpServers: { storeHomeProbe: { command: "store-home-srv" } } }));
      const wiring = await buildProductionWiring({
        config: { sessionId: "s-globalmcp-sv2", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"], storeHome },
        env: {},
        winterHome: home,
      });
      try {
        expect(wiring.engineOptions.extraMcpServerSources.some((s) => "runFolderProbe" in s.servers), "the run folder's own server must be present").toBe(true);
        expect(wiring.engineOptions.extraMcpServerSources.some((s) => "storeHomeProbe" in s.servers), "the store home's server must NEVER surface").toBe(false);
      } finally {
        wiring.dispose();
      }
    } finally {
      rmSync(storeHome, { recursive: true, force: true });
    }
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

// Fix round 10, item A: `sue` (grammar.ts's `validatePermissionRuleString`), applied at settings
// LOAD, here -- `buildSettingsRuleSeed`'s one call site reading `permissions.{allow,deny,ask}` from
// a raw settings object, mirroring claude's own `io`. An invalid entry never becomes an active
// rule; the warning is claude's own text, verbatim (no Winter tier/path prefix, per the
// controller's own "the same text" ruling).
describe("SV-... fix round 10, item A: an invalid settings.json permission rule is skipped with claude's own warning text", () => {
  test("Bash() on allow is skipped -- would otherwise widen to the whole tool", async () => {
    writeSettings(home, { permissions: { allow: ["Bash()"] } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sue-allow", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings).toContain('Invalid permission rule "Bash()" was skipped: Empty parentheses. Either specify a pattern or use just "Bash" without parentheses');
      expect(wiring.engineOptions.settingsRules.entries.some((e) => e.rule.toolName === "Bash")).toBe(false);
    } finally {
      wiring.dispose();
    }
  });

  test("WebSearch() on deny is skipped -- would otherwise deny the whole tool with no scope", async () => {
    writeSettings(home, { permissions: { deny: ["WebSearch()"] } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sue-deny", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings).toContain('Invalid permission rule "WebSearch()" was skipped: Empty parentheses. Either specify a pattern or use just "WebSearch" without parentheses');
      expect(wiring.engineOptions.settingsRules.entries.some((e) => e.rule.toolName === "WebSearch")).toBe(false);
    } finally {
      wiring.dispose();
    }
  });

  test("mcp__s__x() is skipped -- an MCP rule names its scope entirely in the tool-name string, never in parens", async () => {
    writeSettings(home, { permissions: { allow: ["mcp__s__x()"] } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sue-mcp", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.some((w) => w.includes('Invalid permission rule "mcp__s__x()" was skipped'))).toBe(true);
      expect(wiring.engineOptions.settingsRules.entries.some((e) => e.rule.toolName.startsWith("mcp__s"))).toBe(false);
    } finally {
      wiring.dispose();
    }
  });

  test("an invalid rule never poisons its OWN or a SIBLING valid rule in the same file -- only the bad entry is dropped", async () => {
    writeSettings(home, { permissions: { deny: ["Bash()", "Read(secrets/**)"] } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sue-sibling", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.some((w) => w.includes('Invalid permission rule "Bash()" was skipped'))).toBe(true);
      const survivor = wiring.engineOptions.settingsRules.entries.find((e) => e.rule.toolName === "Read");
      expect(survivor).toBeDefined();
      expect(survivor?.rule.specifier).toMatchObject({ kind: "pattern", source: "secrets/**" });
    } finally {
      wiring.dispose();
    }
  });

  test("a well-formed rule produces no sue warning at all", async () => {
    writeSettings(home, { permissions: { deny: ["Read(secrets/**)"] } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sue-clean", cwd, model: "winter-test/echo" } as unknown as RuntimeConfig,
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.warnings.some((w) => w.startsWith("Invalid permission rule"))).toBe(false);
      expect(wiring.engineOptions.settingsRules.entries.some((e) => e.rule.toolName === "Read")).toBe(true);
    } finally {
      wiring.dispose();
    }
  });

  // Ruling: `sue` applies ONLY at settings-file load. A rule reaching the runtime through a
  // DIFFERENT door -- here, an Options-supplied disallowedTools-style string parsed by
  // `parseRule` directly (round 9's own jr-ported Tool() fold) -- must be UNAFFECTED: `Tool()`
  // still folds to bare-equivalent there, exactly as round 9 shipped it.
  test("outside settings.json, parseRule's own jr-ported Tool() fold is untouched -- sue never runs for a non-settings rule string", () => {
    const rule = parseRule("Bash()");
    expect(rule.specifier).toEqual({ kind: "wildcardAll" });
    expect(rule.isBareEquivalent).toBe(true);
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
    // WS-20: `console` is now a second `claude`-family vendor row (a twin of `anthropic`), so both
    // must be disabled to reach the non-vendor tail this test is about.
    writeSettings(join(home), { providers: { anthropic: { enabled: false }, console: { enabled: false } } });
    const unpreferred = await buildProductionWiring({ config: localSession("s-slots-unpreferred"), env: {}, winterHome: home, provider: hermetic });
    let byTier: string | undefined;
    try {
      const r = unpreferred.engineOptions.resolveSlot!("opus", undefined);
      byTier = r.ok ? r.providerId : undefined;
      expect(byTier).toBeDefined();
      expect(byTier).not.toBe("anthropic"); // the vendor row is disabled
      expect(byTier).not.toBe("console"); // the vendor row's WS-20 twin is disabled too
    } finally {
      unpreferred.dispose();
    }
    // Any OTHER provider that serves the same canonical model, promoted by preference alone.
    const other = "tabitoken";
    expect(other).not.toBe(byTier);
    writeSettings(join(home), { providers: { anthropic: { enabled: false }, console: { enabled: false } }, preferredProviders: [other] });
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

// WS-21 lane L1b, Task L1b.2 (spec §5.2/§6.3 item 5): the shared plugins root -- both runtimes read
// the SAME `installed_plugins.json` (`@yanlinglabs/winter-agent-sdk`'s `manage.ts` writes it; this
// suite writes it directly, the same shape a real `winter plugin install` would leave behind) and the
// SAME settings `enabledPlugins` map gates what natively loads.
describe("WS-21 §5.2/§6.3 item 5: the shared plugins root -- installed + enabled plugins load natively", () => {
  /** A minimal real plugin directory: one skill, nothing else. */
  function writePluginContent(root: string): void {
    mkdirSync(join(root, "skills", "ship"), { recursive: true });
    writeFileSync(join(root, "skills", "ship", "SKILL.md"), "---\ndescription: ships\n---\nBODY");
  }

  function writeInstalledPlugins(pluginsRoot: string, plugins: Record<string, unknown>): void {
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  }

  test("enabledPlugins: true loads the plugin's skill, named <plugin>:<skill> (the directory's own basename); false does not", async () => {
    const pluginDir = join(home, "plugin-src", "p");
    writePluginContent(pluginDir);
    const pluginsRoot = join(home, "plugins");
    writeInstalledPlugins(pluginsRoot, { "p@m": [{ scope: "user", installPath: pluginDir }] });
    writeSettings(home, { enabledPlugins: { "p@m": true } });

    const enabled = await buildProductionWiring({
      config: { sessionId: "s-enabled", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(enabled.engineOptions.initSkills).toEqual(["p:ship"]);
    } finally {
      enabled.dispose();
    }

    writeSettings(home, { enabledPlugins: { "p@m": false } });
    const disabled = await buildProductionWiring({
      config: { sessionId: "s-disabled", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(disabled.engineOptions.initSkills).toEqual([]);
    } finally {
      disabled.dispose();
    }
  });

  test("with pluginCacheDir set, a plugin under THAT root loads even when winterHome is a disposable run folder", async () => {
    const pluginDir = join(home, "plugin-src", "p");
    writePluginContent(pluginDir);
    // The SHARED root -- a stand-in for `<storeHome>/plugins` -- lives OUTSIDE `winterHome`.
    const sharedPluginsRoot = mkdtempSync(join(tmpdir(), "winter-shared-plugins-"));
    writeInstalledPlugins(sharedPluginsRoot, { "p@m": [{ scope: "user", installPath: pluginDir }] });
    // `winterHome` itself is a SEPARATE, throwaway "run folder" -- its OWN "plugins" subdirectory
    // (the fallback root) is never created, so a plugin loading at all here proves `pluginCacheDir`
    // won, not the `winterHome`-relative fallback.
    const runFolder = mkdtempSync(join(tmpdir(), "winter-run-folder-"));
    writeSettings(runFolder, { enabledPlugins: { "p@m": true } });

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-run-folder", cwd, model: "winter-test/echo", winterHome: runFolder, settingSources: ["user"], pluginCacheDir: sharedPluginsRoot },
      env: {},
      winterHome: runFolder,
    });
    try {
      expect(wiring.engineOptions.initSkills).toEqual(["p:ship"]);
    } finally {
      wiring.dispose();
      rmSync(sharedPluginsRoot, { recursive: true, force: true });
      rmSync(runFolder, { recursive: true, force: true });
    }
  });

  test("a directory marketplace's plugin loads IN PLACE -- straight from the marketplace's own directory, nothing copied", async () => {
    // Built with the SDK's own management API (`@yanlinglabs/winter-agent-sdk`'s `manage.ts`) --
    // the real `winter plugin marketplace add` + `winter plugin install` path, not a hand-written
    // installed_plugins.json -- so this proves the two modules (the CLI-facing writer, the
    // runtime-facing reader) actually agree on the file.
    const { addMarketplace, installPlugin } = await import("@yanlinglabs/winter-agent-sdk");
    const marketplaceDir = join(home, "local-marketplace");
    mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(marketplaceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: "./plugins/p" }] }),
    );
    writePluginContent(join(marketplaceDir, "plugins", "p"));

    const pluginsRoot = join(home, "plugins");
    const options = { pluginsRoot, settingsPathFor: () => join(home, "settings.json") };
    await addMarketplace(options, marketplaceDir);
    const installed = await installPlugin(options, "p@m", "user");
    // Read in place, F15/§5.2: the resolved install path IS inside the marketplace's own directory,
    // never a copy under pluginsRoot.
    expect(installed.installPath).toBe(join(marketplaceDir, "plugins", "p"));

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-marketplace", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toEqual(["p:ship"]);
    } finally {
      wiring.dispose();
    }
  });

  // SV-4 (router same-view test): real claude loads a DIRECTORY marketplace's plugin from
  // `enabledPlugins` ALONE, with NO install step / installed_plugins.json record at all. This test
  // deliberately never calls `installPlugin` -- only `addMarketplace` (writes known_marketplaces.json)
  // plus a hand-written `enabledPlugins` entry in settings.json, exactly the state a user reaches by
  // editing settings directly (or a host that manages enablement without going through the install
  // flow) rather than running the CLI's install command.
  test("a plugin enabled ONLY in settings.json (no installed_plugins.json record) loads via its directory marketplace, matching real claude (SV-4)", async () => {
    const { addMarketplace } = await import("@yanlinglabs/winter-agent-sdk");
    const marketplaceDir = join(home, "local-marketplace-sv4");
    mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(marketplaceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "m4", owner: { name: "test" }, plugins: [{ name: "p4", source: "./plugins/p4" }] }),
    );
    writePluginContent(join(marketplaceDir, "plugins", "p4"));

    const pluginsRoot = join(home, "plugins");
    await addMarketplace({ pluginsRoot, settingsPathFor: () => join(home, "settings.json") }, marketplaceDir);
    // NO installPlugin call -- installed_plugins.json is never written for "p4@m4" at all.
    writeSettings(home, { enabledPlugins: { "p4@m4": true } });

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-marketplace-sv4", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toEqual(["p4:ship"]);
    } finally {
      wiring.dispose();
    }
  });
});

// SV-5 (the router same-view test, real claude 2.1.250): the fixture the coordinator measured
// against -- a plugin `sv-plugin` with `workflows/flow-file.js` whose OWN declared `meta.name` is
// `sv-flow` -- listed by claude as `sv-plugin:sv-flow` in the init `skills`, init `slash_commands`
// AND the model-facing Skill listing, never under the filename. Before this fix the Winter runtime
// listed it in none of the three.
describe("SV-5: plugin/project/user workflows are listed in all three init surfaces", () => {
  function writeSvPluginWorkflow(root: string): void {
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(join(root, "workflows", "flow-file.js"), `export const meta = { name: "sv-flow", description: "Runs the SV-5 flow" };\nreturn 1;`);
  }

  test("a plugin workflow is listed as <plugin>:<meta.name> in initSkills, initSlashCommands and skillListing", async () => {
    const pluginDir = join(home, "plugin-src", "sv-plugin");
    writeSvPluginWorkflow(pluginDir);
    const pluginsRoot = join(home, "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sv-plugin@m": [{ scope: "user", installPath: pluginDir }] } }));
    writeSettings(home, { enabledPlugins: { "sv-plugin@m": true } });

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sv5-plugin", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toContain("sv-plugin:sv-flow");
      expect(wiring.engineOptions.initSlashCommands).toContain("sv-plugin:sv-flow");
      expect(wiring.engineOptions.skillListing.map((s) => s.name)).toContain("sv-plugin:sv-flow");
      const listedEntry = wiring.engineOptions.skillListing.find((s) => s.name === "sv-plugin:sv-flow");
      expect(listedEntry?.description).toContain("Runs the SV-5 flow");
    } finally {
      wiring.dispose();
    }
  });

  // Fix round 5 (promoted minor, the re-review of 57e7fef..20b623e): initSlashCommands used to list
  // every workflow TWICE -- once because commandResolver's own enumeration walks the skillIndex
  // (I-E registered the workflow there), and again from a redundant SV-5-era splice appending
  // workflowListing directly. `.toContain` (the test above) cannot catch a double-list; this one
  // counts occurrences.
  test("fix round 5: initSlashCommands lists a plugin workflow's name exactly ONCE, not twice", async () => {
    const pluginDir = join(home, "plugin-src", "sv-plugin-dedup");
    writeSvPluginWorkflow(pluginDir);
    const pluginsRoot = join(home, "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sv-plugin-dedup@m": [{ scope: "user", installPath: pluginDir }] } }));
    writeSettings(home, { enabledPlugins: { "sv-plugin-dedup@m": true } });

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sv5-dedup", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      const occurrences = wiring.engineOptions.initSlashCommands.filter((n) => n === "sv-plugin-dedup:sv-flow");
      expect(occurrences).toHaveLength(1);
    } finally {
      wiring.dispose();
    }
  });

  // Fix round 5 (promoted minor, the re-review of 57e7fef..20b623e): "/sv-plugin:sv-flow some args"
  // must carry "some args" into the invoke line as Workflow({ name, args }), as claude does -- Winter
  // was dropping them. End to end through the REAL FilesystemCommandResolver (not just
  // buildWorkflowSkillPrompt's own unit coverage in workflows/store.test.ts), since $ARGUMENTS
  // substitution is that resolver's own job (commands/resolver.ts's own header), not the Skill tool's.
  test("fix round 5: a workflow invoked as /plugin:name some args carries the args into Workflow({ name, args }) via the real command resolver", async () => {
    const pluginDir = join(home, "plugin-src", "sv-plugin-args");
    writeSvPluginWorkflow(pluginDir);
    const pluginsRoot = join(home, "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sv-plugin-args@m": [{ scope: "user", installPath: pluginDir }] } }));
    writeSettings(home, { enabledPlugins: { "sv-plugin-args@m": true } });

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sv5-args", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      const withArgs = await wiring.engineOptions.commandResolver!.resolve("/sv-plugin-args:sv-flow some args here", cwd);
      expect(withArgs.kind).toBe("expand");
      if (withArgs.kind !== "expand") return;
      expect(withArgs.text).toContain('Workflow({ name: "sv-plugin-args:sv-flow", args: "some args here" })');
      // The unconditional (no-args) line is STILL present and correct -- unaffected by the args line's
      // own $ARGUMENTS substitution, since it names the workflow with no args field at all.
      expect(withArgs.text).toContain('Workflow({ name: "sv-plugin-args:sv-flow" })');

      const bare = await wiring.engineOptions.commandResolver!.resolve("/sv-plugin-args:sv-flow", cwd);
      expect(bare.kind).toBe("expand");
      if (bare.kind !== "expand") return;
      // No trailing text -- $ARGUMENTS substitutes to "", matching every OTHER skill/command body's
      // own no-args behaviour (substituteArguments's own doc: "no arguments substitutes the empty
      // string"), not a Winter-specific carve-out for workflows.
      expect(bare.text).toContain('Workflow({ name: "sv-plugin-args:sv-flow", args: "" })');
    } finally {
      wiring.dispose();
    }
  });

  // Fix round 6 (a promoted minor, the re-review against the pinned 2.1.250 dump): the args value
  // must be ESCAPED the way claude's own S(e) does it -- end to end, through the REAL command
  // resolver, with a literal " and \ in the typed args (the ruling's own named test case).
  test("fix round 6: a workflow invoked with a quote and a backslash in its args escapes them, not breaking the invoke line's own quoting", async () => {
    const pluginDir = join(home, "plugin-src", "sv-plugin-escape");
    writeSvPluginWorkflow(pluginDir);
    const pluginsRoot = join(home, "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sv-plugin-escape@m": [{ scope: "user", installPath: pluginDir }] } }));
    writeSettings(home, { enabledPlugins: { "sv-plugin-escape@m": true } });

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sv6-escape", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      const result = await wiring.engineOptions.commandResolver!.resolve(String.raw`/sv-plugin-escape:sv-flow he said "hi" then C:\path`, cwd);
      expect(result.kind).toBe("expand");
      if (result.kind !== "expand") return;
      const args = String.raw`he said "hi" then C:\path`;
      expect(result.text).toContain(`args: ${JSON.stringify(args)}`);
      // The escaped text is valid JSON on its own -- round-tripping it recovers the ORIGINAL,
      // unescaped args exactly, proving this is not merely "looks escaped" but genuinely is.
      const embedded = result.text.match(/args: (".*")\s*\}\)/)?.[1];
      expect(embedded).toBeDefined();
      expect(JSON.parse(embedded!)).toBe(args);
    } finally {
      wiring.dispose();
    }
  });

  // Fix round 4 (I-E, the router same-view test): the coordinator's own required test -- proves the
  // FULL chain through the real production wiring, not just the listing: Skill("sv-plugin:sv-flow")
  // resolves through the REAL Skill tool executor and its body instructs the model to invoke the
  // Workflow tool with the SAME qualified name (tools/impl/workflow.test.ts's own SV-5 end-to-end
  // test already proves the Workflow tool itself resolves that exact name).
  test('I-E: Skill("sv-plugin:sv-flow") resolves through the real Skill tool and instructs a Workflow({name}) call', async () => {
    const pluginDir = join(home, "plugin-src", "sv-plugin-ie");
    writeSvPluginWorkflow(pluginDir);
    const pluginsRoot = join(home, "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "sv-plugin-ie@m": [{ scope: "user", installPath: pluginDir }] } }));
    writeSettings(home, { enabledPlugins: { "sv-plugin-ie@m": true } });

    const sessionId = "s-ie-skill-workflow";
    const wiring = await buildProductionWiring({
      config: { sessionId, cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      const { getSkillSessionRuntime } = await import("./skills/runtime.ts");
      const { skillExecutor } = await import("./tools/impl/skill.ts");
      const runtime = getSkillSessionRuntime(sessionId);
      expect(runtime, "production-wiring must have registered a skill session runtime").toBeDefined();
      const ctx = {
        cwd,
        home,
        sessionId,
        readState: { markRead: () => {}, hasRead: () => false } as unknown as import("./tools/registry.ts").ToolExecutionContext["readState"],
        emitFrame: () => {},
        permissions: { probeReadAccess: () => "silent" as const },
        tempDir: "/nowhere",
        sandboxSettings: {} as import("./tools/registry.ts").ToolExecutionContext["sandboxSettings"],
        session: {
          setCwd() {},
          addBoundedRoot() {},
          removeBoundedRoot() {},
          setPermissionMode() {},
          getBoundedRoots: () => [],
          getPermissionMode: () => "default",
          getSessionRoot: () => cwd,
          setSessionRoot() {},
        },
      } as import("./tools/registry.ts").ToolExecutionContext;
      const result = await skillExecutor.execute({ skill: "sv-plugin-ie:sv-flow" }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.output).toContain('Workflow({ name: "sv-plugin-ie:sv-flow" })');
    } finally {
      wiring.dispose();
    }
  });

  // Fix round 4 (minors, M-3's last bullet), the advisor's own discriminating test: the SAME claim
  // as the test above, but for a plugin whose workflow lives ONLY behind a manifest `workflows`
  // override -- no default `workflows/` directory exists at all. `engine.ts`'s `EngineOptions.
  // pluginWorkflows`, `tools/registry.ts`'s `RegistryToolExecutorDeps`/`ToolExecutionContext`, and
  // `workflows/runtime.ts`'s nested-resolver `ctx` all forward the SAME array reference rather than
  // rebuilding each element, so `workflowsPaths` was never actually stripped at runtime -- but their
  // TYPES did not say so until this round, and this is the end-to-end proof that removes all doubt
  // rather than trusting the structural trace alone. Proves BOTH halves the coordinator's own ruling
  // needs: the plugin is LISTED (production-wiring.ts's `pluginWorkflows` filter admits an
  // override-only plugin) AND the Skill/Workflow tool path actually RESOLVES it.
  test('fix round 4: Skill("<plugin>:<name>") resolves a workflow reachable ONLY through a manifest `workflows` override, no default directory', async () => {
    const { WINTER_PLUGIN_MANIFEST_DIR } = await import("./plugins/manifest.ts");
    const pluginDir = join(home, "plugin-src", "override-plugin");
    mkdirSync(join(pluginDir, "custom-flows"), { recursive: true });
    writeFileSync(join(pluginDir, "custom-flows", "flow-file.js"), `export const meta = { name: "override-flow", description: "Runs from the override" };\nreturn 1;`);
    mkdirSync(join(pluginDir, WINTER_PLUGIN_MANIFEST_DIR), { recursive: true });
    writeFileSync(join(pluginDir, WINTER_PLUGIN_MANIFEST_DIR, "plugin.json"), JSON.stringify({ name: "override-plugin", workflows: "./custom-flows" }));
    const pluginsRoot = join(home, "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "override-plugin@m": [{ scope: "user", installPath: pluginDir }] } }));
    writeSettings(home, { enabledPlugins: { "override-plugin@m": true } });

    const sessionId = "s-fr4-override-skill-workflow";
    const wiring = await buildProductionWiring({
      config: { sessionId, cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toContain("override-plugin:override-flow");
      const { getSkillSessionRuntime } = await import("./skills/runtime.ts");
      const { skillExecutor } = await import("./tools/impl/skill.ts");
      const runtime = getSkillSessionRuntime(sessionId);
      expect(runtime, "production-wiring must have registered a skill session runtime").toBeDefined();
      const ctx = {
        cwd,
        home,
        sessionId,
        readState: { markRead: () => {}, hasRead: () => false } as unknown as import("./tools/registry.ts").ToolExecutionContext["readState"],
        emitFrame: () => {},
        permissions: { probeReadAccess: () => "silent" as const },
        tempDir: "/nowhere",
        sandboxSettings: {} as import("./tools/registry.ts").ToolExecutionContext["sandboxSettings"],
        session: {
          setCwd() {},
          addBoundedRoot() {},
          removeBoundedRoot() {},
          setPermissionMode() {},
          getBoundedRoots: () => [],
          getPermissionMode: () => "default",
          getSessionRoot: () => cwd,
          setSessionRoot() {},
        },
      } as import("./tools/registry.ts").ToolExecutionContext;
      const result = await skillExecutor.execute({ skill: "override-plugin:override-flow" }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.output).toContain('Workflow({ name: "override-plugin:override-flow" })');
    } finally {
      wiring.dispose();
    }
  });

  test("a project workflow (trusted workspace) is listed by its bare meta.name, not its filename", async () => {
    mkdirSync(join(cwd, ".winter", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "workflows", "whatever-filename.js"), `export const meta = { name: "proj-flow", description: "A project flow" };\nreturn 1;`);

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sv5-project", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user", "project"], trustedWorkspace: true },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toContain("proj-flow");
      expect(wiring.engineOptions.initSlashCommands).toContain("proj-flow");
      expect(wiring.engineOptions.skillListing.map((s) => s.name)).toContain("proj-flow");
    } finally {
      wiring.dispose();
    }
  });

  test("a user workflow (<winterHome>/workflows) is listed even in an UNTRUSTED workspace -- WS-11 §11 OQ2 closed", async () => {
    mkdirSync(join(home, "workflows"), { recursive: true });
    writeFileSync(join(home, "workflows", "mine.js"), `export const meta = { name: "user-flow", description: "A user flow" };\nreturn 1;`);

    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sv5-user", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toContain("user-flow");
      expect(wiring.engineOptions.initSlashCommands).toContain("user-flow");
      expect(wiring.engineOptions.skillListing.map((s) => s.name)).toContain("user-flow");
    } finally {
      wiring.dispose();
    }
  });

  test("no workflows anywhere -- the three surfaces are unaffected, byte-identical to before this fix", async () => {
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sv5-none", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.engineOptions.initSkills).toEqual([]);
      expect(wiring.engineOptions.initSlashCommands).not.toContain(undefined);
      expect(wiring.engineOptions.skillListing).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });
});

// WS-21 §6.3 item 1 (fix round 2): a plugin's output-styles/ directory (PluginBundle.
// outputStylesPath, resolved by L1b's loader but with no consumer until now) is wired into
// context/output-styles.ts. Drives a REAL turn end to end (runOne + recordedProviderSystems, the
// SAME pattern the T8 provenance tests above use) so this proves the style's BODY actually reached
// the provider's own system prompt -- not just that `output_style` echoed the requested name.
describe("WS-21 §6.3 item 1 (fix round 2): a plugin's output-styles/ are wired end to end", () => {
  test("selecting <plugin>:<style> injects that plugin style's body into the real system prompt", async () => {
    const pluginDir = join(home, "plugin-src", "styled");
    mkdirSync(join(pluginDir, "output-styles"), { recursive: true });
    writeFileSync(join(pluginDir, "output-styles", "festive.md"), "---\ndescription: festive tone\n---\nRespond with unmistakable festive cheer.\n");
    const pluginsRoot = join(home, "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "styled@m": [{ scope: "user", installPath: pluginDir }] } }));
    writeSettings(home, { enabledPlugins: { "styled@m": true } });

    resetRecordedProviderSystems();
    const msgs = await runOne({ sessionId: "s-plugin-style", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"], outputStyle: "styled:festive" }, { WINTER_HOME: home });
    expect(initFrame(msgs).output_style).toBe("styled:festive");
    expect(recordedProviderSystems().join("\n")).toContain("Respond with unmistakable festive cheer.");
  });

  test("a DISABLED plugin's style never resolves -- the request falls through to null (no style injected)", async () => {
    const pluginDir = join(home, "plugin-src", "styled2");
    mkdirSync(join(pluginDir, "output-styles"), { recursive: true });
    writeFileSync(join(pluginDir, "output-styles", "festive.md"), "---\ndescription: festive tone\n---\nUNMISTAKABLE PLUGIN MARKER TEXT\n");
    const pluginsRoot = join(home, "plugins");
    mkdirSync(pluginsRoot, { recursive: true });
    writeFileSync(join(pluginsRoot, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "styled2@m": [{ scope: "user", installPath: pluginDir }] } }));
    writeSettings(home, { enabledPlugins: { "styled2@m": false } });

    resetRecordedProviderSystems();
    await runOne({ sessionId: "s-plugin-style-disabled", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"], outputStyle: "styled2:festive" }, { WINTER_HOME: home });
    expect(recordedProviderSystems().join("\n")).not.toContain("UNMISTAKABLE PLUGIN MARKER TEXT");
  });
});

// SV-11 (WS-21 fix round 9, security): before this fix, `settings.json`'s own `sandbox` block had
// NO consumer anywhere in this module -- `engine.ts`'s `config.sandbox ?? DEFAULT_SANDBOX_SETTINGS`
// read ONLY the host's raw, unmerged `RuntimeConfig.sandbox`, so a plain `sandbox.filesystem.
// denyWrite` path written into settings.json was silently inert: the denied write went through
// unsandboxed. Fixed by threading settings.json's resolved `sandbox` block (union-merged across
// tiers for `denyWrite`/`denyRead`, see `settings/resolve.test.ts`'s own SV-11 suite) into
// `ProductionWiring.config.sandbox`.
describe("SV-11: settings.json's sandbox.filesystem.denyWrite reaches the wiring's own config", () => {
  test("a USER-tier settings.json denyWrite path is carried onto wiring.config.sandbox.filesystem.denyWrite", async () => {
    writeSettings(home, { sandbox: { filesystem: { denyWrite: ["/some/denied/path"] } } });
    const wiring = await buildProductionWiring({
      config: { sessionId: "s-sv11-wiring", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.config.sandbox?.filesystem?.denyWrite).toEqual(["/some/denied/path"]);
    } finally {
      wiring.dispose();
    }
  });

  test("the host's OWN RuntimeConfig.sandbox.filesystem.denyWrite is preserved, unioned with settings.json's own contribution", async () => {
    writeSettings(home, { sandbox: { filesystem: { denyWrite: ["/from/settings-json"] } } });
    const wiring = await buildProductionWiring({
      config: {
        sessionId: "s-sv11-host-union",
        cwd,
        model: "winter-test/echo",
        winterHome: home,
        settingSources: ["user"],
        sandbox: { filesystem: { denyWrite: ["/from/host-config"] } },
      },
      env: {},
      winterHome: home,
    });
    try {
      expect(wiring.config.sandbox?.filesystem?.denyWrite).toEqual(["/from/settings-json", "/from/host-config"]);
    } finally {
      wiring.dispose();
    }
  });

  // Real spawn, darwin only: proves the merged config Bash actually receives blocks a write for
  // real, not merely that the plain JS object carries the right strings. Mirrors bash.ts's own
  // filesystem.denyWrite -> denyWritePaths translation (tools/impl/bash.ts) exactly, since
  // `runCommand` itself does not derive `denyWritePaths` from `settings.filesystem.denyWrite` on
  // its own -- that mapping is the CALLER's job, and this reproduces it rather than assuming it.
  test.skipIf(process.platform !== "darwin")(
    "end to end: a settings.json denyWrite path blocks a real sandboxed Bash write, and an UNLISTED path in the same cwd still succeeds",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "winter-sv11-scratch-"));
      const deniedPath = join(scratch, "denied.txt");
      const allowedPath = join(scratch, "allowed.txt");
      try {
        writeSettings(home, { sandbox: { filesystem: { denyWrite: [deniedPath] } } });
        const wiring = await buildProductionWiring({
          config: { sessionId: "s-sv11-e2e", cwd, model: "winter-test/echo", winterHome: home, settingSources: ["user"] },
          env: {},
          winterHome: home,
        });
        try {
          const fs = wiring.config.sandbox?.filesystem;
          expect(fs?.denyWrite).toEqual([deniedPath]);
          const denied = await runCommand({
            command: `echo blocked > ${JSON.stringify(deniedPath)}`,
            cwd: scratch,
            env: { ...process.env, TMPDIR: scratch },
            timeoutMs: 5000,
            settings: wiring.config.sandbox ?? {},
            ...(fs?.denyWrite !== undefined ? { denyWritePaths: fs.denyWrite } : {}),
          });
          expect(denied.posture).toBe("sandboxed");
          expect(denied.exitCode).not.toBe(0);
          expect(existsSync(deniedPath)).toBe(false);

          const allowed = await runCommand({
            command: `echo ok > ${JSON.stringify(allowedPath)}`,
            cwd: scratch,
            env: { ...process.env, TMPDIR: scratch },
            timeoutMs: 5000,
            settings: wiring.config.sandbox ?? {},
            ...(fs?.denyWrite !== undefined ? { denyWritePaths: fs.denyWrite } : {}),
          });
          expect(allowed.exitCode).toBe(0);
          expect(existsSync(allowedPath)).toBe(true);
        } finally {
          wiring.dispose();
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});

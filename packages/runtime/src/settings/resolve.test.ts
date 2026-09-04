// Phase 5 Task 2 (R5-8 as AMENDED after Task 1): settings resolution.
//
// Hermeticity: every case uses a fresh mkdtemp cwd AND a fresh mkdtemp winterHome, threaded
// EXPLICITLY through `resolveSettingsDetailed`'s own `winterHome` option -- never through
// process.env mutation (a shared-process `bun test` run would race) and never through the pinned
// `resolveSettings` wrapper's env-derived default, which would read a real `~/.winter`.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSettings,
  resolveSettingsDetailed,
  filterEscalatingDefaultMode,
  applyWorkspaceTrust,
  OVERLAY_NEVER_KEYS,
  SETTING_SOURCES,
  settingsPathFor,
  type SettingSource,
} from "./resolve.ts";

let cwd = "";
let home = "";
const cleanup: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "winter-p5-settings-cwd-"));
  home = mkdtempSync(join(tmpdir(), "winter-p5-settings-home-"));
  cleanup.push(cwd, home);
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeUser(values: unknown): void {
  writeFileSync(join(home, "settings.json"), JSON.stringify(values));
}
function writeProject(values: unknown): void {
  mkdirSync(join(cwd, ".winter"), { recursive: true });
  writeFileSync(join(cwd, ".winter", "settings.json"), JSON.stringify(values));
}
function writeLocal(values: unknown): void {
  mkdirSync(join(cwd, ".winter"), { recursive: true });
  writeFileSync(join(cwd, ".winter", "settings.local.json"), JSON.stringify(values));
}
async function resolve(opts: { settingSources?: SettingSource[]; managedSettings?: Record<string, unknown>; serverManagedSettings?: Record<string, unknown>; inline?: Record<string, unknown> } = {}) {
  return resolveSettingsDetailed({ cwd, winterHome: home, ...opts });
}

describe("SettingSource + per-tier loading", () => {
  test("the union is exactly the pinned three, in the pinned order", () => {
    expect(SETTING_SOURCES).toEqual(["user", "project", "local"]);
  });

  test("each tier resolves to its own WS-01 §2.2 path", () => {
    expect(settingsPathFor("user", { cwd, winterHome: home })).toBe(join(home, "settings.json"));
    expect(settingsPathFor("project", { cwd, winterHome: home })).toBe(join(cwd, ".winter", "settings.json"));
    expect(settingsPathFor("local", { cwd, winterHome: home })).toBe(join(cwd, ".winter", "settings.local.json"));
  });

  test("omitted settingSources loads all three tiers", async () => {
    writeUser({ outputStyle: "u" });
    writeProject({ plansDirectory: "p" });
    writeLocal({ apiKeyHelper: "l" });
    const r = await resolve();
    expect(r.effective["outputStyle"]).toBe("u");
    expect(r.effective["plansDirectory"]).toBe("p");
    expect(r.effective["apiKeyHelper"]).toBe("l");
  });

  test("settingSources: [] disables filesystem settings entirely", async () => {
    writeUser({ outputStyle: "u" });
    writeProject({ plansDirectory: "p" });
    writeLocal({ apiKeyHelper: "l" });
    const r = await resolve({ settingSources: [] });
    expect(r.effective).toEqual({});
    expect(r.perSource).toEqual([]);
    expect(r.sources).toEqual([]);
  });

  test("a rule in a file whose tier is NOT selected has no effect (capture (1) cells C/H)", async () => {
    writeProject({ permissions: { allow: ["Write"] } });
    const r = await resolve({ settingSources: ["local"] });
    expect(r.effective["permissions"]).toBeUndefined();
  });

  test("malformed JSON is reported on perSource.error and never thrown", async () => {
    mkdirSync(join(cwd, ".winter"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "settings.json"), "{ not json");
    const r = await resolve({ settingSources: ["project"] });
    const entry = r.perSource.find((e) => e.source === "project");
    expect(entry).toBeDefined();
    expect(entry?.loaded).toBe(false);
    expect(typeof entry?.error).toBe("string");
    expect(entry?.values).toEqual({});
    expect(r.effective).toEqual({});
  });

  test("a settings file whose top level is not an object is an error, not a merge", async () => {
    writeProject([1, 2, 3]);
    const r = await resolve({ settingSources: ["project"] });
    expect(r.perSource.find((e) => e.source === "project")?.loaded).toBe(false);
    expect(r.effective).toEqual({});
  });

  test("an absent file contributes no source entry at all", async () => {
    const r = await resolve({ settingSources: ["user", "project", "local"] });
    expect(r.perSource).toEqual([]);
    expect(r.sources).toEqual([]);
  });
});

describe("precedence + provenance", () => {
  test("managed > flag > local > project > user for scalars", async () => {
    writeUser({ outputStyle: "user" });
    writeProject({ outputStyle: "project" });
    writeLocal({ outputStyle: "local" });
    expect((await resolve({ settingSources: ["user"] })).effective["outputStyle"]).toBe("user");
    expect((await resolve({ settingSources: ["user", "project"] })).effective["outputStyle"]).toBe("project");
    expect((await resolve({ settingSources: ["user", "project", "local"] })).effective["outputStyle"]).toBe("local");
    expect((await resolve({ inline: { outputStyle: "flag" } })).effective["outputStyle"]).toBe("flag");
    expect((await resolve({ inline: { outputStyle: "flag" }, managedSettings: { outputStyle: "managed" } })).effective["outputStyle"]).toBe("managed");
  });

  test("provenance is per TOP-LEVEL key and names the winning tier + its path", async () => {
    writeUser({ outputStyle: "user", plansDirectory: "u" });
    writeLocal({ outputStyle: "local" });
    const r = await resolve();
    expect(r.provenance["outputStyle"]?.source).toBe("local");
    expect(r.provenance["outputStyle"]?.path).toBe(join(cwd, ".winter", "settings.local.json"));
    expect(r.provenance["plansDirectory"]?.source).toBe("user");
  });

  test("a nested object merges across tiers but provenance stays per TOP-LEVEL key (capture (1))", async () => {
    writeProject({ permissions: { allow: ["Write"] } });
    writeLocal({ permissions: { defaultMode: "acceptEdits" } });
    const r = await resolve();
    expect(r.effective["permissions"]).toEqual({ allow: ["Write"], defaultMode: "acceptEdits" });
    expect(r.provenance["permissions"]?.source).toBe("local");
  });

  test("arrays are REPLACED by the higher tier, never concatenated -- and every tier's own array stays visible per source", async () => {
    writeProject({ permissions: { allow: ["Write"] } });
    writeLocal({ permissions: { allow: ["Bash"] } });
    const r = await resolve();
    expect((r.effective["permissions"] as { allow: string[] }).allow).toEqual(["Bash"]);
    const project = r.perSource.find((e) => e.source === "project");
    expect((project?.values["permissions"] as { allow: string[] }).allow).toEqual(["Write"]);
  });

  test("managedSettings and serverManagedSettings both report source 'managed' with a policyOrigin", async () => {
    const r = await resolve({ managedSettings: { outputStyle: "m" }, serverManagedSettings: { plansDirectory: "s" } });
    expect(r.provenance["outputStyle"]?.source).toBe("managed");
    expect(r.provenance["outputStyle"]?.policyOrigin).toBe("file");
    expect(r.provenance["plansDirectory"]?.source).toBe("managed");
    expect(r.provenance["plansDirectory"]?.policyOrigin).toBe("remote");
  });

  test("the inline/sdk tier reports source 'flag'", async () => {
    const r = await resolve({ inline: { outputStyle: "f" } });
    expect(r.provenance["outputStyle"]?.source).toBe("flag");
  });

  test("`sources` is ordered highest-precedence first and carries the RAW per-tier settings", async () => {
    writeUser({ outputStyle: "user" });
    writeProject({ outputStyle: "project" });
    writeLocal({ outputStyle: "local" });
    const r = await resolve({ managedSettings: { outputStyle: "managed" }, inline: { outputStyle: "flag" } });
    expect(r.sources.map((s) => s.source)).toEqual(["managed", "flag", "local", "project", "user"]);
    expect(r.sources.map((s) => s.settings["outputStyle"])).toEqual(["managed", "flag", "local", "project", "user"]);
  });
});

describe("OVERLAY_NEVER_KEYS (T1 (a) / OQ-P5-2)", () => {
  test("the list is the auto-memory directory plus Winter's own autoMode", () => {
    expect([...OVERLAY_NEVER_KEYS].sort()).toEqual(["autoMemoryDirectory", "autoMode"]);
  });

  test("a never-key set in PROJECT settings never reaches `effective`", async () => {
    writeProject({ autoMemoryDirectory: "/evil", autoMode: "on", outputStyle: "project" });
    const r = await resolve({ settingSources: ["project"] });
    expect(r.effective["autoMemoryDirectory"]).toBeUndefined();
    expect(r.effective["autoMode"]).toBeUndefined();
    expect(r.provenance["autoMemoryDirectory"]).toBeUndefined();
    expect(r.effective["outputStyle"]).toBe("project"); // the rest of the tier is untouched
  });

  test("the same keys ARE taken from local and user (project-only restriction)", async () => {
    writeLocal({ autoMemoryDirectory: "/local" });
    writeUser({ autoMode: "user" });
    const r = await resolve();
    expect(r.effective["autoMemoryDirectory"]).toBe("/local");
    expect(r.effective["autoMode"]).toBe("user");
  });

  test("the RAW per-source view still shows what the project file said (escape hatch, not a lie)", async () => {
    writeProject({ autoMemoryDirectory: "/evil" });
    const r = await resolve({ settingSources: ["project"] });
    expect(r.perSource.find((e) => e.source === "project")?.values["autoMemoryDirectory"]).toBe("/evil");
  });
});

describe("filterEscalatingDefaultMode (pinned; capture (1)'s declared-API table)", () => {
  async function modeAfterFilter(): Promise<unknown> {
    const r = await resolve();
    const filtered = filterEscalatingDefaultMode(r);
    return (filtered["permissions"] as { defaultMode?: string } | undefined)?.defaultMode;
  }

  test("an escalating acceptEdits from PROJECT is dropped, leaving allow/deny intact", async () => {
    writeProject({ permissions: { defaultMode: "acceptEdits", allow: ["Write"], deny: ["Bash"] } });
    const r = await resolve();
    const filtered = filterEscalatingDefaultMode(r);
    expect((filtered["permissions"] as { defaultMode?: string }).defaultMode).toBeUndefined();
    expect((filtered["permissions"] as { allow: string[] }).allow).toEqual(["Write"]);
    expect((filtered["permissions"] as { deny: string[] }).deny).toEqual(["Bash"]);
  });

  test("bypassPermissions from PROJECT is dropped", async () => {
    writeProject({ permissions: { defaultMode: "bypassPermissions" } });
    expect(await modeAfterFilter()).toBeUndefined();
  });

  test("a NON-escalating plan from PROJECT is retained", async () => {
    writeProject({ permissions: { defaultMode: "plan" } });
    expect(await modeAfterFilter()).toBe("plan");
  });

  test("an escalating acceptEdits from LOCAL is retained", async () => {
    writeLocal({ permissions: { defaultMode: "acceptEdits" } });
    expect(await modeAfterFilter()).toBe("acceptEdits");
  });

  test("the winning setter is found by walking `sources`, not by the coarse per-top-level provenance", async () => {
    // provenance.permissions would say `local` here (local wins the top-level key), yet the
    // ESCALATING defaultMode was set by project alone -- the walk drops it, the coarse read would not.
    writeProject({ permissions: { defaultMode: "acceptEdits" } });
    writeLocal({ permissions: { allow: ["Write"] } });
    const r = await resolve();
    expect(r.provenance["permissions"]?.source).toBe("local");
    expect(await modeAfterFilter()).toBeUndefined();
  });

  test("the input is never mutated", async () => {
    writeProject({ permissions: { defaultMode: "acceptEdits", allow: ["Write"] } });
    const r = await resolve();
    filterEscalatingDefaultMode(r);
    expect((r.effective["permissions"] as { defaultMode?: string }).defaultMode).toBe("acceptEdits");
  });
});

describe("applyWorkspaceTrust (RULING P5-A)", () => {
  test("untrusted: a PROJECT allow list is dropped, deny and ask survive", async () => {
    writeProject({ permissions: { allow: ["Write"], deny: ["Bash"], ask: ["Read"] } });
    const r = await resolve();
    const filtered = applyWorkspaceTrust(r, { trustedWorkspace: false });
    const perms = filtered["permissions"] as { allow?: string[]; deny?: string[]; ask?: string[] };
    expect(perms.allow).toBeUndefined();
    expect(perms.deny).toEqual(["Bash"]);
    expect(perms.ask).toEqual(["Read"]);
  });

  test("untrusted: a PROJECT additionalDirectories is dropped", async () => {
    writeProject({ permissions: { additionalDirectories: ["/elsewhere"] } });
    const filtered = applyWorkspaceTrust(await resolve(), { trustedWorkspace: false });
    expect((filtered["permissions"] as { additionalDirectories?: string[] }).additionalDirectories).toBeUndefined();
  });

  test("trusted: the same PROJECT allow list widens", async () => {
    writeProject({ permissions: { allow: ["Write"], additionalDirectories: ["/elsewhere"] } });
    const filtered = applyWorkspaceTrust(await resolve(), { trustedWorkspace: true });
    const perms = filtered["permissions"] as { allow?: string[]; additionalDirectories?: string[] };
    expect(perms.allow).toEqual(["Write"]);
    expect(perms.additionalDirectories).toEqual(["/elsewhere"]);
  });

  test("untrusted: a LOCAL allow list still widens (P5-A: the filter is per TIER, not per directory)", async () => {
    writeLocal({ permissions: { allow: ["Write"] } });
    const filtered = applyWorkspaceTrust(await resolve(), { trustedWorkspace: false });
    expect((filtered["permissions"] as { allow?: string[] }).allow).toEqual(["Write"]);
  });

  test("untrusted: a USER allow list still widens", async () => {
    writeUser({ permissions: { allow: ["Write"] } });
    const filtered = applyWorkspaceTrust(await resolve(), { trustedWorkspace: false });
    expect((filtered["permissions"] as { allow?: string[] }).allow).toEqual(["Write"]);
  });

  test("untrusted: a project DENY beats a local ALLOW (capture (1) cell K) -- both survive the filter", async () => {
    writeProject({ permissions: { deny: ["Write"] } });
    writeLocal({ permissions: { allow: ["Write"] } });
    const filtered = applyWorkspaceTrust(await resolve(), { trustedWorkspace: false });
    const perms = filtered["permissions"] as { allow?: string[]; deny?: string[] };
    expect(perms.deny).toEqual(["Write"]);
    expect(perms.allow).toEqual(["Write"]);
  });

  test("it also applies the pinned escalating-defaultMode filter", async () => {
    writeProject({ permissions: { defaultMode: "bypassPermissions", allow: ["Write"] } });
    const filtered = applyWorkspaceTrust(await resolve(), { trustedWorkspace: false });
    const perms = filtered["permissions"] as { defaultMode?: string; allow?: string[] };
    expect(perms.defaultMode).toBeUndefined();
    expect(perms.allow).toBeUndefined();
  });

  test("a trusted workspace keeps an escalating project defaultMode out anyway (the pinned filter is tier-based, not trust-based)", async () => {
    writeProject({ permissions: { defaultMode: "bypassPermissions" } });
    const filtered = applyWorkspaceTrust(await resolve(), { trustedWorkspace: true });
    expect((filtered["permissions"] as { defaultMode?: string }).defaultMode).toBeUndefined();
  });
});

describe("resolveSettings (the pinned wrapper)", () => {
  test("returns exactly the three pinned fields, and no Winter-side extras", async () => {
    const r = await resolveSettings({ cwd, settingSources: [] });
    expect(Object.keys(r).sort()).toEqual(["effective", "provenance", "sources"]);
  });

  test("delegates to the same resolution: managedSettings wins with settingSources disabled", async () => {
    const r = await resolveSettings({ cwd, settingSources: [], managedSettings: { outputStyle: "m" } });
    expect(r.effective["outputStyle"]).toBe("m");
    expect(r.provenance["outputStyle"]?.source).toBe("managed");
  });

  test("called with no arguments at all it still resolves (no throw), with a cwd default", async () => {
    const r = await resolveSettings({ settingSources: [] });
    expect(r.effective).toEqual({});
  });
});

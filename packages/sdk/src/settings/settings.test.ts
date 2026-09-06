// WS-13b R6b-7: `settings.providers.<id>.enabled`, resolved through the P5 cascade.
//
// Hermeticity, same rule as `runtime/src/settings/resolve.test.ts`: a fresh mkdtemp cwd AND a fresh
// mkdtemp winterHome, threaded EXPLICITLY through `resolveSettingsDetailed`'s own `winterHome`
// option -- never through process.env mutation (a shared-process `bun test` run would race) and
// never through the pinned `resolveSettings` wrapper's env-derived default, which would read the
// developer's real `~/.winter`.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettingsDetailed } from "./resolve.ts";
import { providerSettingsFrom } from "./types.ts";

let cwd = "";
let home = "";
const cleanup: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "winter-p6b-providers-cwd-"));
  home = mkdtempSync(join(tmpdir(), "winter-p6b-providers-home-"));
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

const resolve = async (): Promise<ReturnType<typeof providerSettingsFrom>> => providerSettingsFrom((await resolveSettingsDetailed({ cwd, winterHome: home, env: {} })).effective);

describe("settings.providers.<id>.enabled (WS-13b R6b-7)", () => {
  test("resolves through the cascade and defaults to true", async () => {
    writeUser({ providers: { "xai-oauth": { enabled: false } } });
    const providers = await resolve();
    expect(providers["xai-oauth"]?.enabled).toBe(false);
    // Absent means ENABLED. A provider nobody has an opinion about is simply not IN the map -- the
    // helper narrows what the settings DECLARE and invents no rows -- and every reader treats that
    // absence as enabled. Both halves are asserted, because "not in the map" and "in the map as
    // enabled" are only the same thing if the reader agrees, and `selection.ts`'s own test pins the
    // reader's half.
    expect(providers["openai"]).toBeUndefined();
    expect(providers["openai"]?.enabled ?? true).toBe(true);
  });

  test("the per-provider merge is DEEP: a project tier naming one provider does not erase the user's other entries", async () => {
    // The failure this pins is the shallow-merge one: `{ providers: {...} }` replaced wholesale
    // would silently re-enable everything the user turned off the moment a repository expressed an
    // opinion about a single unrelated provider.
    writeUser({ providers: { "xai-oauth": { enabled: false }, qoder: { enabled: false } } });
    writeProject({ providers: { deepseek: { enabled: false } } });
    const providers = await resolve();
    expect(providers["xai-oauth"]?.enabled).toBe(false);
    expect(providers["qoder"]?.enabled).toBe(false);
    expect(providers["deepseek"]?.enabled).toBe(false);
  });

  // --- RULING R6b-9: restrictive-only across tiers -------------------------------------------------
  //
  // This key is R6b-7's reversion switch, so the enabling direction is the one that has to be
  // protected: a repository that could re-enable a provider its operator withdrew would make the
  // switch worthless the moment it mattered.
  test("R6b-9: a PROJECT tier can never re-enable what the USER tier disabled — the reversion switch is operator-immune", async () => {
    writeUser({ providers: { qoder: { enabled: false } } });
    writeProject({ providers: { qoder: { enabled: true } } });
    expect((await resolve())["qoder"]?.enabled).toBe(false);
  });

  test("R6b-9: it works in the other direction too — a PROJECT `false` disables even though the user said nothing", async () => {
    // The discriminating half. Without it, the assertion above could equally mean "the project tier
    // is ignored for this key", which is a different (and wrong) rule: disabling is a tightening
    // every tier may make.
    writeProject({ providers: { qoder: { enabled: false } } });
    expect((await resolve())["qoder"]?.enabled).toBe(false);
  });

  test("R6b-9: ANY tier's `false` wins, and it does not disturb the sibling ids either tier enabled", async () => {
    writeUser({ providers: { qoder: { enabled: true }, deepseek: { enabled: true } } });
    writeProject({ providers: { qoder: { enabled: false } } });
    const providers = await resolve();
    expect(providers["qoder"]?.enabled).toBe(false);
    expect(providers["deepseek"]?.enabled).toBe(true);
  });

  test("R6b-9 does NOT invent rows: a provider no tier mentions stays absent from the map", async () => {
    writeUser({ providers: { qoder: { enabled: false } } });
    expect((await resolve())["openai"]).toBeUndefined();
  });

  test("a higher tier still wins on every OTHER shape in the block — only `enabled: false` is sticky", async () => {
    writeUser({ providers: { qoder: { enabled: true, note: "user" } } });
    writeProject({ providers: { qoder: { enabled: true, note: "project" } } });
    const raw = (await resolveSettingsDetailed({ cwd, winterHome: home, env: {} })).effective["providers"] as Record<string, { note?: string }>;
    expect(raw["qoder"]?.note).toBe("project");
  });

  test("a malformed block is inert rather than fatal — a settings file is JSON and may say anything", async () => {
    writeUser({ providers: { qoder: "yes", "": { enabled: false }, ok: { enabled: false } } });
    const providers = await resolve();
    // The non-object entry and the empty id are dropped; the well-formed sibling still resolves.
    expect(providers["qoder"]).toBeUndefined();
    expect(providers[""]).toBeUndefined();
    expect(providers["ok"]?.enabled).toBe(false);
  });

  test("no `providers` block at all resolves to an empty map, which reads as `everything enabled`", async () => {
    expect(await resolve()).toEqual({});
  });

  test("a non-boolean `enabled` is ignored rather than coerced — only an explicit `false` disables", async () => {
    // Coercing the STRING `"false"` to `false` would disable a provider on the strength of a typo;
    // the declared id is kept (the user did name it) and reads as enabled.
    writeUser({ providers: { qoder: { enabled: "false" } } });
    expect((await resolve())["qoder"]).toEqual({ enabled: true });
  });
});

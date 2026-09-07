// P6.6 Lane B (WS-13c §5, D27, RULING R13c-7): `resolveSettingsDetailed`'s trust gate on
// `modelSlots`/`preferredProviders`.
//
// Hermeticity, same rule as settings.test.ts (and `packages/runtime/src/settings/resolve.test.ts`):
// a fresh mkdtemp cwd AND a fresh mkdtemp winterHome, threaded EXPLICITLY through
// `resolveSettingsDetailed`'s own `winterHome` option -- never through process.env mutation (a
// shared-process `bun test` run would race) and never through the pinned `resolveSettings` wrapper's
// env-derived default, which would read the developer's real `~/.winter`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettingsDetailed } from "./resolve.ts";
import { providerSettingsFrom } from "./types.ts";

let cwd = "";
let home = "";
const cleanup: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "winter-p6c-slots-cwd-"));
  home = mkdtempSync(join(tmpdir(), "winter-p6c-slots-home-"));
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

describe("modelSlots / preferredProviders trust gate (WS-13c §5, R13c-7)", () => {
  test("untrusted workspace: the project's modelSlots/preferredProviders are dropped, the user tier's own values survive, the drop is recorded on the project source, and the RAW project entry still carries what the repo actually committed", async () => {
    writeUser({ modelSlots: [{ name: "cheap", model: "user-model" }], preferredProviders: ["user-provider"] });
    writeProject({ modelSlots: [{ name: "cheap", model: "project-model" }], preferredProviders: ["project-provider"] });

    const resolved = await resolveSettingsDetailed({ cwd, winterHome: home, env: {} });

    expect(resolved.effective["modelSlots"]).toEqual([{ name: "cheap", model: "user-model" }]);
    expect(resolved.effective["preferredProviders"]).toEqual(["user-provider"]);
    expect(resolved.effective["modelSlotsIgnored"]).toBe("untrusted-project");

    const projectEntry = resolved.perSource.find((e) => e.source === "project");
    expect(projectEntry?.error).toContain("modelSlots");
    expect(projectEntry?.error).toContain("untrusted");
    // `sources`/`perSource` are the pinned escape hatch and must never lie about what the
    // repo-committed file actually said, even though `effective` no longer reflects it.
    expect(projectEntry?.settings["modelSlots"]).toEqual([{ name: "cheap", model: "project-model" }]);
    expect(projectEntry?.settings["preferredProviders"]).toEqual(["project-provider"]);
  });

  test("untrusted workspace, only the project tier sets them: modelSlotsIgnored is still recorded even with no user-tier value to fall back to", async () => {
    writeProject({ modelSlots: [{ name: "cheap", model: "project-model" }] });

    const resolved = await resolveSettingsDetailed({ cwd, winterHome: home, env: {} });

    expect(resolved.effective["modelSlots"]).toBeUndefined();
    expect(resolved.effective["modelSlotsIgnored"]).toBe("untrusted-project");
  });

  test("trustedWorkspace: true — the project tier wins with ordinary precedence, and nothing is recorded as ignored", async () => {
    writeUser({ modelSlots: [{ name: "cheap", model: "user-model" }], preferredProviders: ["user-provider"] });
    writeProject({ modelSlots: [{ name: "cheap", model: "project-model" }], preferredProviders: ["project-provider"] });

    const resolved = await resolveSettingsDetailed({ cwd, winterHome: home, env: {}, trustedWorkspace: true });

    expect(resolved.effective["modelSlots"]).toEqual([{ name: "cheap", model: "project-model" }]);
    expect(resolved.effective["preferredProviders"]).toEqual(["project-provider"]);
    expect(resolved.effective["modelSlotsIgnored"]).toBeUndefined();
    const projectEntry = resolved.perSource.find((e) => e.source === "project");
    expect(projectEntry?.error).toBeUndefined();
  });

  test("a non-array user-tier modelSlots passes through untouched — shape validation is the runtime's job (validateModelSlots), not the resolver's", async () => {
    writeUser({ modelSlots: "not-an-array" });

    const resolved = await resolveSettingsDetailed({ cwd, winterHome: home, env: {}, settingSources: ["user"] });

    // Deliberately typed away: `Settings.modelSlots` is `ModelSlotSetting[] | undefined`, but the
    // whole point of this test is that the resolver does NOT enforce that shape -- an invalid raw
    // value from a file is a runtime fact this layer passes through, not a type the SDK proves.
    expect(resolved.effective["modelSlots"] as unknown).toBe("not-an-array");
    expect(resolved.effective["modelSlotsIgnored"]).toBeUndefined();
  });

  test("an untrusted project's OTHER keys are unaffected — only modelSlots/preferredProviders are stripped", async () => {
    writeProject({ modelSlots: [{ name: "cheap", model: "project-model" }], outputStyle: "repo-style" });

    const resolved = await resolveSettingsDetailed({ cwd, winterHome: home, env: {} });

    // `outputStyle` is a genuinely different, pre-existing gate (OVERLAY_NEVER_KEYS) — asserting it
    // here pins that this lane's new filter composes with the old one rather than replacing it.
    expect(resolved.effective["modelSlots"]).toBeUndefined();
    expect(resolved.effective["outputStyle"]).toBeUndefined();
  });

  test("providers.<id>.enabled is unaffected by this lane's change: a PROJECT tier still can never re-enable what the USER tier disabled (re-run of settings.test.ts's R6b-9 case)", async () => {
    writeUser({ providers: { qoder: { enabled: false } } });
    writeProject({ providers: { qoder: { enabled: true } }, modelSlots: [{ name: "cheap", model: "project-model" }] });

    const resolved = await resolveSettingsDetailed({ cwd, winterHome: home, env: {} });
    const providers = providerSettingsFrom(resolved.effective);

    expect(providers["qoder"]?.enabled).toBe(false);
  });
});

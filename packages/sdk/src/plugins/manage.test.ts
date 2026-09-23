// WS-21 lane L1b, Task L1b.3: the plugin-management API's own write discipline (F15), on temp
// directories and a local directory marketplace only -- no network, matching the brief's test scope.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginManagerError,
  addMarketplace,
  installPlugin,
  listMarketplaces,
  listPlugins,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin,
  updateMarketplace,
  type PluginManagerOptions,
} from "./manage.ts";

let home: string;
let pluginsRoot: string;
let marketplaceDir: string;
let userSettingsPath: string;
let options: PluginManagerOptions;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "winter-plugin-manage-test-"));
  pluginsRoot = join(home, "sdk", "plugins");
  userSettingsPath = join(home, "sdk", "settings.json");
  marketplaceDir = join(home, "local-marketplace");
  mkdirSync(join(marketplaceDir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(marketplaceDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "m",
      owner: { name: "test" },
      plugins: [
        { name: "p", source: "./plugins/p", version: "1.0.0" },
        { name: "q", source: "./plugins/q", version: "2.0.0" },
      ],
    }),
  );
  options = { pluginsRoot, settingsPathFor: () => userSettingsPath };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("addMarketplace: a local directory, read in place", () => {
  test("adds a directory marketplace from its manifest's own name, nothing copied", async () => {
    const info = await addMarketplace(options, marketplaceDir);
    expect(info).toEqual({ name: "m", source: marketplaceDir, kind: "directory", path: marketplaceDir });

    const listed = await listMarketplaces(options);
    expect(listed).toEqual([{ name: "m", source: marketplaceDir, kind: "directory", path: marketplaceDir }]);

    // Read in place: no copy anywhere under pluginsRoot other than the two management files themselves.
    const raw = readFileSync(join(pluginsRoot, "known_marketplaces.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, { installLocation: string; source: { source: string; path?: string } }>;
    expect(parsed["m"]?.installLocation).toBe(marketplaceDir);
    expect(parsed["m"]?.source).toEqual({ source: "directory", path: marketplaceDir });
  });

  test("git/github/url sources are classified but refused typed -- no network in this build", async () => {
    await expect(addMarketplace(options, "https://example.com/marketplace.json")).rejects.toThrow(PluginManagerError);
    await expect(addMarketplace(options, "owner/repo")).rejects.toThrow(PluginManagerError);
    await expect(addMarketplace(options, "git@github.com:owner/repo.git")).rejects.toThrow(PluginManagerError);
  });

  test("removeMarketplace forgets it; updateMarketplace re-validates a directory marketplace in place", async () => {
    await addMarketplace(options, marketplaceDir);
    await updateMarketplace(options, "m"); // re-validates the manifest is still there; does not throw
    await removeMarketplace(options, "m");
    expect(await listMarketplaces(options)).toEqual([]);
    await expect(removeMarketplace(options, "m")).rejects.toThrow(PluginManagerError);
  });
});

describe("installPlugin: writes the V2 record AND enabledPlugins", () => {
  test("install p@m at user scope resolves the manifest's own relative source, and enables it", async () => {
    await addMarketplace(options, marketplaceDir);
    const installed = await installPlugin(options, "p@m", "user");
    expect(installed).toEqual({ id: "p", version: "1.0.0", installPath: join(marketplaceDir, "plugins", "p"), scope: "user" });

    const rawPlugins = readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8");
    const parsed = JSON.parse(rawPlugins) as { version: number; plugins: Record<string, Array<{ scope: string; installPath: string; version?: string; installedAt?: string }>> };
    expect(parsed.version).toBe(2);
    expect(parsed.plugins["p@m"]).toEqual([{ scope: "user", installPath: join(marketplaceDir, "plugins", "p"), version: "1.0.0", installedAt: expect.any(String) }]);

    const rawSettings = readFileSync(userSettingsPath, "utf8");
    const settings = JSON.parse(rawSettings) as { enabledPlugins?: Record<string, boolean> };
    expect(settings.enabledPlugins?.["p@m"]).toBe(true);

    const listing = await listPlugins(options);
    expect(listing).toEqual([{ id: "p", version: "1.0.0", installPath: join(marketplaceDir, "plugins", "p"), scope: "user", enabled: true, marketplace: "m" }]);
  });

  // Fix round 3 (I-1, security): end to end through installPlugin, not just the unit-level resolver
  // (marketplace-path.test.ts) -- a malicious marketplace manifest entry must never install to a
  // path outside the marketplace directory.
  test("I-1: a marketplace entry naming an escaping source is REFUSED typed, never installed -- SECURITY", async () => {
    writeFileSync(
      join(marketplaceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "m", owner: { name: "test" }, plugins: [{ name: "evil", source: "../../etc/passwd" }] }),
    );
    await addMarketplace(options, marketplaceDir);
    await expect(installPlugin(options, "evil@m", "user")).rejects.toThrow(PluginManagerError);
    expect(await listPlugins(options)).toEqual([]);
  });

  test("I-1: an ABSOLUTE source is refused typed, never installed -- SECURITY", async () => {
    writeFileSync(
      join(marketplaceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "m", owner: { name: "test" }, plugins: [{ name: "evil", source: "/etc" }] }),
    );
    await addMarketplace(options, marketplaceDir);
    await expect(installPlugin(options, "evil@m", "user")).rejects.toThrow(PluginManagerError);
  });

  test("I-1: metadata.pluginRoot and an already-relative source do not double-join", async () => {
    writeFileSync(
      join(marketplaceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: "./plugins/p" }], metadata: { pluginRoot: "./plugins" } }),
    );
    await addMarketplace(options, marketplaceDir);
    const installed = await installPlugin(options, "p@m", "user");
    expect(installed.installPath).toBe(join(marketplaceDir, "plugins", "p")); // NOT plugins/plugins/p
  });

  test("I-1: a bare source name with no metadata.pluginRoot is refused typed, matching claude's own rule", async () => {
    writeFileSync(
      join(marketplaceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "m", owner: { name: "test" }, plugins: [{ name: "p", source: "p" }] }),
    );
    await addMarketplace(options, marketplaceDir);
    await expect(installPlugin(options, "p@m", "user")).rejects.toThrow(PluginManagerError);
  });

  test("setPluginEnabled(false) flips enabledPlugins to false without touching the installed record", async () => {
    await addMarketplace(options, marketplaceDir);
    await installPlugin(options, "p@m", "user");
    await setPluginEnabled(options, "p@m", "user", false);

    const settings = JSON.parse(readFileSync(userSettingsPath, "utf8")) as { enabledPlugins?: Record<string, boolean> };
    expect(settings.enabledPlugins?.["p@m"]).toBe(false);

    const [listing] = await listPlugins(options);
    expect(listing?.enabled).toBe(false);
    expect(listing?.installPath).toBe(join(marketplaceDir, "plugins", "p")); // unchanged
  });

  test("uninstallPlugin removes the V2 record and clears enabledPlugins", async () => {
    await addMarketplace(options, marketplaceDir);
    await installPlugin(options, "p@m", "user");
    await uninstallPlugin(options, "p@m", "user");

    expect(await listPlugins(options)).toEqual([]);
    const parsed = JSON.parse(readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8")) as { plugins: Record<string, unknown> };
    expect(parsed.plugins["p@m"]).toBeUndefined();
    const settings = JSON.parse(readFileSync(userSettingsPath, "utf8")) as { enabledPlugins?: Record<string, boolean> };
    expect(settings.enabledPlugins?.["p@m"]).toBeUndefined();

    await expect(uninstallPlugin(options, "p@m", "user")).rejects.toThrow(PluginManagerError);
  });

  test("a bare spec with no \"@marketplace\" is refused typed -- no bare-name inference in this build", async () => {
    await expect(installPlugin(options, "p", "user")).rejects.toThrow(PluginManagerError);
  });

  test("a plugin the marketplace does not list is refused typed", async () => {
    await addMarketplace(options, marketplaceDir);
    await expect(installPlugin(options, "nope@m", "user")).rejects.toThrow(PluginManagerError);
  });

  // A hand-edited settings.json with a trailing comma (or any other malformed JSON) must never be
  // silently REPLACED by a document holding only `enabledPlugins` -- every other key (permissions,
  // hooks, env, …) would be gone. `loadSettingsFile` reports this shape as present-but-unloaded with
  // an empty value map so a READER degrades safely; a WRITER must refuse instead of trusting that
  // empty map as "the file's real content".
  test("a malformed settings.json refuses the enable/install write typed rather than overwriting it", async () => {
    mkdirSync(join(home, "sdk"), { recursive: true });
    writeFileSync(userSettingsPath, '{"permissions": {"allow": ["Bash"],}}'); // trailing comma: invalid JSON
    await addMarketplace(options, marketplaceDir);
    await expect(installPlugin(options, "p@m", "user")).rejects.toThrow(PluginManagerError);
    // Untouched -- still the same malformed bytes, not overwritten with a partial document.
    expect(readFileSync(userSettingsPath, "utf8")).toBe('{"permissions": {"allow": ["Bash"],}}');
  });

  // Controller fix round 1, finding 1: the settings check must run BEFORE installed_plugins.json is
  // touched at all -- otherwise a refused settings write leaves a plugin installed but never
  // enabled, with nothing recording why. installPlugin's own pre-flight (not just
  // setEnabledInSettings's own, later guard) is what this pins.
  test("a malformed settings.json refuses BEFORE installed_plugins.json is written -- no orphaned install record, and a PRE-EXISTING sibling record survives untouched", async () => {
    await addMarketplace(options, marketplaceDir);
    // A sibling plugin installed BEFORE settings ever went bad -- the refused install of "p@m" below
    // must leave this record exactly as it was, proving the pre-flight refuses cleanly rather than
    // touching (or losing) installed_plugins.json's EXISTING content on its way to refusing.
    await installPlugin(options, "q@m", "user");
    const beforeAttempt = readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8");

    writeFileSync(userSettingsPath, '{"permissions": {"allow": ["Bash"],}}'); // trailing comma: invalid JSON
    await expect(installPlugin(options, "p@m", "user")).rejects.toThrow(PluginManagerError);

    // installed_plugins.json is BYTE-IDENTICAL to before the refused attempt: "p@m" was never added,
    // and "q@m"'s own pre-existing record is untouched.
    expect(readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8")).toBe(beforeAttempt);
    const parsed = JSON.parse(beforeAttempt) as { plugins: Record<string, unknown> };
    expect(Object.keys(parsed.plugins)).toEqual(["q@m"]);
  });

  // Same shape, uninstall side (controller fix round 2, out-of-scope finding from the re-review):
  // removing "p@m"'s record happens BEFORE `setEnabledInSettings(..., undefined)`, so a refused
  // settings write must leave BOTH installed_plugins.json's own record for "p@m" AND the settings
  // file untouched -- otherwise a stale `enabledPlugins["p@m"]: true` survives for a plugin that
  // `installed_plugins.json` (correctly) still lists as installed, which is at least self-consistent
  // -- but if the removal had run FIRST (the pre-fix ordering), the record would be gone while the
  // stale `true` remained, and `setPluginEnabled` would then refuse it as "not installed" with no
  // way back through the ordinary API.
  test("a malformed settings.json refuses uninstallPlugin BEFORE the record is removed -- the record and the settings file are both unchanged", async () => {
    await addMarketplace(options, marketplaceDir);
    await installPlugin(options, "p@m", "user");
    const installedBefore = readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8");

    writeFileSync(userSettingsPath, '{"permissions": {"allow": ["Bash"],}}'); // trailing comma: invalid JSON
    await expect(uninstallPlugin(options, "p@m", "user")).rejects.toThrow(PluginManagerError);

    expect(readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8")).toBe(installedBefore);
    expect(readFileSync(userSettingsPath, "utf8")).toBe('{"permissions": {"allow": ["Bash"],}}');
    // The plugin is still reported INSTALLED (installed_plugins.json's own record is untouched --
    // this is the fix's whole point). `enabled` reads `false` here, not because the record's own
    // enablement changed, but because `readEnabledFromSettings` cannot read a malformed file at all
    // and answers conservatively -- the SAME "can't prove it's on, so report off" degrade a reader
    // always makes, unrelated to this fix. The point this test pins is narrower and unconditional:
    // uninstall never half-applies (record gone, stale settings surviving) -- see the pre-fix
    // ordering this replaces, where the record WOULD have been gone already at this point.
    const [listing] = await listPlugins(options);
    expect(listing?.id).toBe("p");
    expect(listing?.enabled).toBe(false);
  });
});

// F15's own claim: `installed_plugins.json` has NO lock, so two CONCURRENT writers -- real OS
// processes, never an in-process `Promise.all` (which cannot exercise a cross-process race at all)
// -- must still leave it valid JSON holding one of the two outcomes. Two legitimate outcomes, per
// the write's own read-modify-write shape (never a torn file, `rename()` is atomic):
//   - BOTH plugins present, if the two processes' read/write windows did not overlap (the second
//     process's read saw the first one's already-written record and merged onto it);
//   - EXACTLY ONE plugin present, if they raced on the same base read -- the later `rename()` wins
//     and its writer's in-memory snapshot never saw the other's addition (claude's own "last writer
//     wins", concurrent sessions do this too).
// A THIRD outcome -- corrupt JSON, or a key present with a mangled/partial record -- would be the
// real bug this test exists to catch; it is refused by construction (write-temp-then-rename never
// exposes a partial write), so this test's job is to prove that holds under a REAL race, not to
// pick which of the two legitimate outcomes shows up on this machine.
describe("installed_plugins.json under real concurrent writers (two separate bun processes)", () => {
  test("two processes installing different plugins leave the file valid, holding one or both", async () => {
    await addMarketplace(options, marketplaceDir);
    const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "manage-concurrency.fixture.ts");

    const spawnOne = (spec: string) => Bun.spawn([process.execPath, fixturePath, pluginsRoot, userSettingsPath, spec], { stdout: "pipe", stderr: "pipe" });
    const [procP, procQ] = [spawnOne("p@m"), spawnOne("q@m")];
    const [exitP, exitQ] = await Promise.all([procP.exited, procQ.exited]);
    if (exitP !== 0) throw new Error(`p@m installer exited ${exitP}: ${await new Response(procP.stderr).text()}`);
    if (exitQ !== 0) throw new Error(`q@m installer exited ${exitQ}: ${await new Response(procQ.stderr).text()}`);

    const raw = readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8");
    const parsed = JSON.parse(raw) as { version: number; plugins: Record<string, unknown> }; // JSON.parse itself proves "valid JSON"
    expect(parsed.version).toBe(2);
    const keys = Object.keys(parsed.plugins);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(["p@m", "q@m"]).toContain(key);
  });
});

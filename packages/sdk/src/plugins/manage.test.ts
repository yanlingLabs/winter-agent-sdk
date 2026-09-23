// WS-21 lane L1b, Task L1b.3: the plugin-management API's own write discipline (F15), on temp
// directories and a local directory marketplace only -- no network, matching the brief's test scope.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

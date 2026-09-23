// WS-21 lane L1b, Task L1b.3's concurrency test helper: run as a SEPARATE bun process (never
// imported), so two real OS processes race `installPlugin`'s read-modify-write of
// `installed_plugins.json` with no in-process coordination possible between them -- an in-process
// `Promise.all` of two calls would never exercise the cross-process "no lock" claim F15 makes.
//
// Usage: `bun manage-concurrency.fixture.ts <pluginsRoot> <settingsPath> <spec>`
// `spec` is `"<name>@<marketplace>"`; the marketplace must already be known (added by the test
// BEFORE spawning either process) so both processes race on exactly one file --
// `installed_plugins.json` -- rather than also on `known_marketplaces.json`.
import { installPlugin, type PluginManagerOptions } from "./manage.ts";

const [pluginsRoot, settingsPath, spec] = process.argv.slice(2);
if (pluginsRoot === undefined || settingsPath === undefined || spec === undefined) {
  console.error("usage: manage-concurrency.fixture.ts <pluginsRoot> <settingsPath> <spec>");
  process.exit(2);
}

const options: PluginManagerOptions = {
  pluginsRoot,
  settingsPathFor: () => settingsPath,
};

await installPlugin(options, spec, "user");

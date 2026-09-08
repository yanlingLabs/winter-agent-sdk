import { readFileSync, writeFileSync } from "node:fs";
import { Glob } from "bun";

export interface Manifest { path: string; json: Record<string, unknown>; }

export function toSemver(v: string): string { return v.split(".").map((s) => String(parseInt(s, 10))).join("."); }

export function computeSyncedManifests(version: string, manifests: Manifest[]): Manifest[] {
  const semver = toSemver(version);
  return manifests.map((m) => {
    const json: Record<string, unknown> = { ...m.json, version: semver };
    const opt = json.optionalDependencies as Record<string, string> | undefined;
    if (opt) for (const k of Object.keys(opt)) if (k.startsWith("@yanlinglabs/") && opt[k] !== "workspace:*") opt[k] = semver;
    const dep = json.dependencies as Record<string, string> | undefined;
    if (dep) for (const k of Object.keys(dep)) if (k.startsWith("@yanlinglabs/") && dep[k] !== "workspace:*") dep[k] = semver;
    return { path: m.path, json };
  });
}

/**
 * `RUNTIME_ENGINE_VERSION`, the ONE version string that is not in a manifest.
 *
 * `packages/runtime/src/store/dialect.ts` hardcodes the runtime's engine version rather than reading
 * its own package.json, and its header explains why: `main.ts` compiles to a single-file `$bunfs`
 * binary that cannot do a relative fs read of a manifest at run time. The drift protection was a
 * test-time parity check alone -- which WORKS (it caught this at 0.0.2) but only AFTER the bump, as
 * a red suite in the middle of a release, fixed by hand every time.
 *
 * So `version:sync` restamps it, and the parity test in `dialect.test.ts` stays as the proof. The
 * rewrite is anchored on the exact `export const NAME = "..."` line, so it cannot touch prose that
 * merely mentions the constant, and it returns the source UNCHANGED when the line is absent (a
 * caller then sees no write rather than a silent corruption).
 */
export function stampRuntimeEngineVersion(source: string, semver: string): string {
  return source.replace(/(export const RUNTIME_ENGINE_VERSION = ")[^"]*(")/, `$1${semver}$2`);
}

if (import.meta.main) {
  const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  const cwd = import.meta.dir.replace(/\/scripts$/, "");
  const paths = [...new Glob("packages/**/package.json").scanSync({ cwd })]
    .filter((p) => !p.includes("node_modules"));
  const manifests = paths.map((p) => ({ path: p, json: JSON.parse(readFileSync(`${cwd}/${p}`, "utf8")) }));
  for (const m of computeSyncedManifests(version, manifests)) writeFileSync(`${cwd}/${m.path}`, JSON.stringify(m.json, null, 2) + "\n");
  const dialectPath = `${cwd}/packages/runtime/src/store/dialect.ts`;
  const dialectBefore = readFileSync(dialectPath, "utf8");
  const dialectAfter = stampRuntimeEngineVersion(dialectBefore, toSemver(version));
  if (dialectAfter !== dialectBefore) writeFileSync(dialectPath, dialectAfter);
  console.log(`synced ${manifests.length} manifests${dialectAfter !== dialectBefore ? " + RUNTIME_ENGINE_VERSION" : ""} to ${version}`);
}

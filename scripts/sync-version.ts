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
 * `RUNTIME_ENGINE_VERSION` and `SDK_VERSION`, the version strings that are not in a manifest.
 *
 * `packages/runtime/src/store/dialect.ts` hardcodes the runtime's engine version, and
 * `packages/sdk/src/version.ts` hardcodes the sdk's own version, rather than reading their
 * package.json at run time: both compile into a single-file `$bunfs` binary that cannot do a
 * relative fs read of a manifest (and, for the sdk, `import … with { type: "json" }` breaks the
 * dist-only tsc emit). The drift protection was a test-time parity check alone -- which WORKS (it
 * caught RUNTIME_ENGINE_VERSION drift at 0.0.2) but only AFTER the bump, as a red suite in the
 * middle of a release, fixed by hand every time.
 *
 * So `version:sync` restamps both, and the parity tests (`dialect.test.ts`, `version.test.ts`) stay
 * as the proof. The rewrite is anchored on the exact `export const NAME = "..."` declaration for an
 * arbitrary `name` (optionally typed, `export const NAME: string = "..."`), so it cannot touch prose
 * that merely mentions the constant, and it returns the source UNCHANGED when the declaration is
 * absent (a caller then sees no write rather than a silent corruption).
 */
export function stampVersionConstant(source: string, name: string, semver: string): string {
  const re = new RegExp(`(export const ${name}(?::\\s*string)? = ")[^"]*(")`);
  return re.test(source) ? source.replace(re, `$1${semver}$2`) : source;
}

/** Compatibility wrapper: `version:sync` originally stamped only this one constant. */
export function stampRuntimeEngineVersion(source: string, semver: string): string {
  return stampVersionConstant(source, "RUNTIME_ENGINE_VERSION", semver);
}

if (import.meta.main) {
  const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  const cwd = import.meta.dir.replace(/\/scripts$/, "");
  const paths = [...new Glob("packages/**/package.json").scanSync({ cwd })]
    .filter((p) => !p.includes("node_modules"));
  const manifests = paths.map((p) => ({ path: p, json: JSON.parse(readFileSync(`${cwd}/${p}`, "utf8")) }));
  for (const m of computeSyncedManifests(version, manifests)) writeFileSync(`${cwd}/${m.path}`, JSON.stringify(m.json, null, 2) + "\n");
  const semver = toSemver(version);
  const stamped: string[] = [];
  const targets: Array<{ path: string; name: string; label: string }> = [
    { path: `${cwd}/packages/runtime/src/store/dialect.ts`, name: "RUNTIME_ENGINE_VERSION", label: "RUNTIME_ENGINE_VERSION" },
    { path: `${cwd}/packages/sdk/src/version.ts`, name: "SDK_VERSION", label: "SDK_VERSION" },
  ];
  for (const t of targets) {
    const before = readFileSync(t.path, "utf8");
    const after = stampVersionConstant(before, t.name, semver);
    if (after !== before) {
      writeFileSync(t.path, after);
      stamped.push(t.label);
    }
  }
  console.log(`synced ${manifests.length} manifests${stamped.length ? ` + ${stamped.join(" + ")}` : ""} to ${version}`);
}

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

if (import.meta.main) {
  const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  const cwd = import.meta.dir.replace(/\/scripts$/, "");
  const paths = [...new Glob("packages/**/package.json").scanSync({ cwd })]
    .filter((p) => !p.includes("node_modules"));
  const manifests = paths.map((p) => ({ path: p, json: JSON.parse(readFileSync(`${cwd}/${p}`, "utf8")) }));
  for (const m of computeSyncedManifests(version, manifests)) writeFileSync(`${cwd}/${m.path}`, JSON.stringify(m.json, null, 2) + "\n");
  console.log(`synced ${manifests.length} manifests to ${version}`);
}

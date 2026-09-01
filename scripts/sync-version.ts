import { readFileSync, writeFileSync } from "node:fs";
import { Glob } from "bun";

export interface Manifest { path: string; json: Record<string, unknown>; }

export function computeSyncedManifests(version: string, manifests: Manifest[]): Manifest[] {
  return manifests.map((m) => {
    const json = { ...m.json, version };
    const opt = json.optionalDependencies as Record<string, string> | undefined;
    if (opt) for (const k of Object.keys(opt)) if (k.startsWith("@yanlinglabs/")) opt[k] = version;
    const dep = json.dependencies as Record<string, string> | undefined;
    if (dep) for (const k of Object.keys(dep)) if (k.startsWith("@yanlinglabs/") && dep[k] !== "workspace:*") dep[k] = version;
    return { path: m.path, json };
  });
}

if (import.meta.main) {
  const rootDir = new URL("..", import.meta.url);
  const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  const cwd = import.meta.dir.replace(/\/scripts$/, "");
  const paths = [...new Glob("packages/**/package.json").scanSync({ cwd })]
    .filter((p) => !p.includes("node_modules"));
  const manifests = paths.map((p) => ({ path: p, json: JSON.parse(readFileSync(`${cwd}/${p}`, "utf8")) }));
  for (const m of computeSyncedManifests(version, manifests)) writeFileSync(`${cwd}/${m.path}`, JSON.stringify(m.json, null, 2) + "\n");
  console.log(`synced ${manifests.length} manifests to ${version}`);
}

import { readFileSync, writeFileSync } from "node:fs";
export function bump(v: string, kind: "patch" | "minor" | "major"): string {
  const [maj, min, pat] = v.split(".").map(Number) as [number, number, number];
  if (kind === "major") return `${maj + 1}.0.000`;
  if (kind === "minor") return `${maj}.${min + 1}.000`;
  return `${maj}.${min}.${String(pat + 1).padStart(3, "0")}`;
}
if (import.meta.main) {
  const kind = process.argv.includes("--major") ? "major" : process.argv.includes("--minor") ? "minor" : "patch";
  const url = new URL("../VERSION", import.meta.url);
  const next = bump(readFileSync(url, "utf8").trim(), kind);
  writeFileSync(url, next + "\n"); console.log(next);
}

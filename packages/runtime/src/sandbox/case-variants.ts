// Case-variant write roots on a case-SENSITIVE volume (macOS only; see profile.ts's
// `buildCaseVariantRootFence` for the measured Seatbelt behaviour).
//
// Seatbelt matches every path filter ignoring case, so on a case-sensitive volume a write root
// `/v/proj` also admits a distinct `/v/PROJ`, and no profile rule can tell them apart. This module
// gives spawn.ts the two facts it needs before building a profile:
//   - which write roots sit on a case-sensitive volume (`pathconf(_PC_CASE_SENSITIVE)`), and
//   - for such a root, which OTHER existing paths Seatbelt would treat as that root (case variants).
// Both fail closed: a volume whose case sensitivity cannot be read counts as case-sensitive, and a
// directory that cannot be listed while looking for variants counts as holding one.
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** `_PC_CASE_SENSITIVE` from macOS <sys/unistd.h>. */
const PC_CASE_SENSITIVE = 11;

type PathconfFn = (path: string) => number;
let pathconfImpl: PathconfFn | null | undefined;

/** libSystem's `pathconf` through `bun:ffi` (loaded once), or null when it cannot be bound. */
function loadPathconf(): PathconfFn | null {
  if (pathconfImpl !== undefined) return pathconfImpl;
  pathconfImpl = null;
  if (process.platform !== "darwin") return pathconfImpl;
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const lib = ffi.dlopen("/usr/lib/libSystem.B.dylib", { pathconf: { args: ["ptr", "i32"], returns: "i64" } });
    pathconfImpl = (path: string) => Number(lib.symbols.pathconf(Buffer.from(`${path}\0`, "utf8"), PC_CASE_SENSITIVE));
  } catch {
    pathconfImpl = null;
  }
  return pathconfImpl;
}

let caseSensitivityOverride: ((path: string) => boolean) | undefined;

/** TEST-ONLY seam: decide case sensitivity without a real volume. Returns the restore function. */
export function setCaseSensitivityProbeForTest(probe: ((path: string) => boolean) | undefined): () => void {
  const previous = caseSensitivityOverride;
  caseSensitivityOverride = probe;
  return () => {
    caseSensitivityOverride = previous;
  };
}

/**
 * Whether `path` (or, when it does not exist yet, its nearest existing ancestor) is on a
 * case-sensitive volume. `pathconf` answers 1 (sensitive) or 0 (insensitive); anything else -- no
 * `bun:ffi`, an error -- is treated as case-sensitive, which only adds checks and a create deny.
 */
export function isOnCaseSensitiveVolume(path: string): boolean {
  if (caseSensitivityOverride !== undefined) return caseSensitivityOverride(path);
  const pathconf = loadPathconf();
  if (pathconf === null) return true;
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    return pathconf(probe) !== 0;
  } catch {
    return true;
  }
}

/** How two names compare when case is ignored. Folds more than Seatbelt might (NFD, upper-then-lower), which only reports more variants. */
function foldName(name: string): string {
  return name.normalize("NFD").toUpperCase().toLowerCase();
}

/**
 * Every EXISTING path, other than `root` itself, that matches `root` ignoring case: walking down
 * `root`'s segments, a directory on a case-sensitive volume is listed and each entry whose name equals
 * the next segment ignoring case is followed (a directory on a case-insensitive volume cannot hold two
 * such names, so the segment is taken as written). Paths inside one of `exemptRoots` (another write
 * root, already writable) are not reported. A directory on a case-sensitive volume that cannot be
 * listed is reported itself, so the caller refuses rather than guess.
 */
export function findCaseVariantsOf(root: string, exemptRoots: readonly string[] = []): string[] {
  const segments = root.split("/").filter((s) => s.length > 0);
  let candidates = ["/"];
  for (const segment of segments) {
    const next: string[] = [];
    for (const parent of candidates) {
      if (!isOnCaseSensitiveVolume(parent)) {
        next.push(join(parent, segment));
        continue;
      }
      let entries: string[];
      try {
        entries = readdirSync(parent);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        return [parent];
      }
      const want = foldName(segment);
      for (const entry of entries) if (foldName(entry) === want) next.push(join(parent, entry));
    }
    candidates = next;
    if (candidates.length === 0) return [];
  }
  const inside = (p: string, r: string) => p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
  return candidates.filter((p) => p !== root && !exemptRoots.some((r) => inside(p, r)));
}

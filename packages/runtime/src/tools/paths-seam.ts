// The normalization half of the P2 T11 carry: "Bash cwd-drift path extraction for the approvals
// paths axis (WS-06 normalization owns it)" (Phase 2 completion report). `RegisteredTool.
// extractPaths` (registry.ts) is the per-tool contract every tool-specific extractor implements;
// this module is the SHARED, tool-agnostic primitive every one of them normalizes THROUGH, so
// "resolve a candidate path against the directory this call actually ran under" is computed
// identically everywhere instead of once per tool.
//
// Bash's own cwd-DRIFT-aware extraction (recognizing an embedded `cd` before resolving a LATER
// relative path against the post-`cd` directory, not the call's starting cwd) is Lane C's own
// grammar work (Task 3, "extractPaths for Bash reuses T3's grammar... the T11 carry") -- this file
// supplies the generic resolve-and-dedupe step an extractor calls once it has already worked out
// the effective base directory for each candidate; it never inspects command text itself.
import { resolve } from "node:path";
import type { RegisteredTool } from "./registry.ts";

export type ExtractPaths = NonNullable<RegisteredTool["extractPaths"]>;
export type ExtractedPaths = ReturnType<ExtractPaths>;

// Resolves every candidate against `baseDir` and de-duplicates the result, preserving first-seen
// order. Callers pass already-identified path strings (relative or absolute); this performs no
// command parsing of its own.
export function resolveCandidatePaths(candidates: readonly string[], baseDir: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolve(baseDir, candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

// Convenience composer for the {reads, writes} shape every extractPaths implementation returns --
// e.g. a Bash extractor that recognizes both a blessed fs-op path and a redirect target as
// candidates for the SAME call can build each half independently and merge once.
export function mergePathSets(a: ExtractedPaths, b: ExtractedPaths): ExtractedPaths {
  return {
    reads: [...new Set([...a.reads, ...b.reads])],
    writes: [...new Set([...a.writes, ...b.writes])],
  };
}

// An empty {reads, writes} result -- the correct default for a tool with nothing path-shaped in its
// input; exported so extractPaths implementations never hand-roll `{ reads: [], writes: [] }`.
export function emptyPathSet(): ExtractedPaths {
  return { reads: [], writes: [] };
}

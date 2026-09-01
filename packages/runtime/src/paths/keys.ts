import { realpathSync } from "node:fs";
import { resolve as resolvePath, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { transcriptProjectKey } from "./project-key.ts";

// The pinned consumer NFC-normalizes the resolved path on macOS before deriving a key (its own
// realpath/resolve chain applies this unconditionally on darwin, ahead of the sanitizer). Without
// it, an NFD-decomposed path (a precomposed letter expressed as base + combining mark — a form
// some macOS filesystem APIs can hand back) and its NFC-precomposed equivalent sanitize to
// DIFFERENT lengths, because a combining mark is its own non-alnum character. Two spellings of
// "the same path" would then produce different keys, defeating cross-runtime compatibility. Winter
// mirrors this exactly: darwin-only, matching the pinned consumer's own platform gate.
function platformNormalize(p: string): string {
  return process.platform === "darwin" ? p.normalize("NFC") : p;
}

// resolve(relative-or-absolute) -> realpath (best effort) -> platform normalize. Mirrors the
// pinned consumer's own cwd-resolution chain that feeds its project-key function.
function resolveCanonical(raw: string): string {
  const resolved = resolvePath(raw);
  try {
    return platformNormalize(realpathSync(resolved));
  } catch {
    return platformNormalize(resolved); // best-effort fallback — matches the pinned consumer
  }
}

// The main repo root for `resolvedCwd`, via git's own "common dir" — deliberately NOT "toplevel",
// which would give every linked worktree its own separate directory and defeat shared memory.
// `git rev-parse --git-common-dir` returns a path relative to cwd from inside the main worktree
// (including a `../`-laden relative path from a subdirectory) and an absolute path from inside a
// linked worktree (verified empirically against real git 2.50 across all three cases; task-6
// report). Returns null when `resolvedCwd` isn't inside a git repository, or git itself is
// unavailable — callers fall back to scoping memory the same as the transcript/temp keys.
function gitCommonRoot(resolvedCwd: string): string | null {
  try {
    const raw = execFileSync("git", ["-C", resolvedCwd, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonDir = isAbsolute(raw) ? raw : resolvePath(resolvedCwd, raw);
    return platformNormalize(dirname(realpathSync(commonDir)));
  } catch {
    return null;
  }
}

export interface CompatibilityKeys {
  transcriptProjectKey: string; // transcript/list/resume scope
  memoryProjectKey: string; // git-common-root scope, so worktrees (and subdirectories) share memory
  tempProjectKey: string; // actual session cwd scope, matching Claude temp behavior
}

// WS-05 §3.2's three named keys. They normally match; only memoryProjectKey can diverge, and only
// when `cwd` sits inside a git repository whose common dir resolves to a root DIFFERENT from `cwd`
// itself — a linked worktree, or simply any subdirectory of a repo.
export function compatibilityKeys(cwd: string): CompatibilityKeys {
  const resolvedCwd = resolveCanonical(cwd);
  const cwdKey = transcriptProjectKey(resolvedCwd);
  const commonRoot = gitCommonRoot(resolvedCwd);
  const memoryKey = commonRoot === null ? cwdKey : transcriptProjectKey(commonRoot);
  return { transcriptProjectKey: cwdKey, memoryProjectKey: memoryKey, tempProjectKey: cwdKey };
}

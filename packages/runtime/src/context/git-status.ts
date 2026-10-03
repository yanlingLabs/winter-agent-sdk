// SDK 0.0.16 Lane C (P16-5): the systemContext `gitStatus` snapshot, in the shape claude's own
// requests carry.
//
// Five git reads in parallel, joined into blank-line-separated parts --
//   <snapshot caveat>                       (Winter's own wording)
//   Current branch: <branch>
//   Main branch (you will usually use this for PRs): <main>
//   Git user: <user.name>                  (only when set)
//   Status:\n<git status --short, or (clean)>   (cut at 2 000 characters, with the hint line)
//   Recent commits:\n<git log --oneline -n 5>
// A directory that is not a git work tree has NO gitStatus at all. A single git read that fails
// contributes an empty string (a non-zero exit is not an error here); only an unexpected failure
// drops the whole snapshot.
//
// The ENGINE calls this once per session context (memoized, cleared by compaction) and appends the
// result to the system prompt as the final `gitStatus: <text>` part. Whether it is wanted at all is
// the assembler's call (`AssembledPrompt.systemContextPlacement`): never for a caller-supplied
// prompt, never for an `omitProjectContext` agent (Explore/Plan), never with the kill switch or
// `includeGitInstructions: false`.
import { execFile } from "node:child_process";

/** Winter's snapshot caveat (claude's sentence says the same thing in its own words). */
export const GIT_STATUS_CAVEAT = "This git status was captured when the session began; it is a snapshot and does not change as the conversation goes on.";

/** The shell tool the truncation hint names (Winter's advertised name is claude's). */
const BASH_TOOL_NAME = "Bash";

/** Where the short status is cut. */
export const GIT_STATUS_MAX_CHARS = 2000;

const GIT_TIMEOUT_MS = 10_000;

interface GitResult {
  code: number;
  stdout: string;
}

type GitEnv = Record<string, string | undefined> | undefined;

function runGit(cwd: string, args: readonly string[], env?: GitEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", ...(env !== undefined ? { env: env as NodeJS.ProcessEnv } : {}) }, (err, stdout) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 1;
      resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}

/** The checked-out branch for the `Current branch:` line. */
async function currentBranch(cwd: string, env: GitEnv): Promise<string> {
  // git's own abbreviation of HEAD: the short branch name, or `HEAD` when detached. An unborn branch
  // makes the query fail, which also reads as `HEAD`.
  const { code, stdout } = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], env);
  const name = stdout.trim();
  return code === 0 && name.length > 0 ? name : "HEAD";
}

/** Whether `refs/remotes/origin/<name>` exists locally. */
async function originRefExists(cwd: string, name: string, env: GitEnv): Promise<boolean> {
  const { code } = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`], env);
  return code === 0;
}

/** Tried in order when origin/HEAD names no usable branch. */
const FALLBACK_MAIN_BRANCHES = ["main", "master"] as const;

/** The branch named on the `Main branch ...:` line. */
async function mainBranch(cwd: string, env: GitEnv): Promise<string> {
  // origin/HEAD's target first -- only when origin actually has that branch.
  const head = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], env);
  if (head.code === 0) {
    let name = head.stdout.trim();
    if (name.startsWith("origin/")) name = name.slice("origin/".length);
    if (name.length > 0 && (await originRefExists(cwd, name, env))) return name;
  }
  for (const candidate of FALLBACK_MAIN_BRANCHES) {
    if (await originRefExists(cwd, candidate, env)) return candidate;
  }
  return "main";
}

async function isGitWorkTree(cwd: string, env: GitEnv): Promise<boolean> {
  const { code, stdout } = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], env);
  return code === 0 && stdout.trim() === "true";
}

/**
 * The `gitStatus` value for `cwd`, or `undefined` when there is none. Never throws. `env` is for
 * tests (a hermetic git config); the engine runs git with the process environment, as the
 * instructions-file and memory-key git reads already do.
 */
export async function computeGitStatus(cwd: string, env?: Record<string, string | undefined>): Promise<string | undefined> {
  try {
    if (!(await isGitWorkTree(cwd, env))) return undefined;
    const trimmedOut = async (args: readonly string[]): Promise<string> => (await runGit(cwd, args, env)).stdout.trim();
    const [branch, main, status, log, user] = await Promise.all([
      currentBranch(cwd, env),
      mainBranch(cwd, env),
      trimmedOut(["--no-optional-locks", "status", "--short"]),
      trimmedOut(["--no-optional-locks", "log", "--oneline", "-n", "5"]),
      trimmedOut(["config", "user.name"]),
    ]);
    const cappedStatus =
      status.length > GIT_STATUS_MAX_CHARS
        ? `${status.substring(0, GIT_STATUS_MAX_CHARS)}\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${BASH_TOOL_NAME})`
        : status;
    return [
      GIT_STATUS_CAVEAT,
      `Current branch: ${branch}`,
      `Main branch (you will usually use this for PRs): ${main}`,
      ...(user.length > 0 ? [`Git user: ${user}`] : []),
      `Status:\n${cappedStatus || "(clean)"}`,
      `Recent commits:\n${log}`,
    ].join("\n\n");
  } catch {
    return undefined;
  }
}

/**
 * The kill switch (claude's `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS`, Winter's `<PREFIX>DISABLE_GIT_INSTRUCTIONS`)
 * over the `includeGitInstructions` setting (default true). An explicit env value wins either way,
 * as claude's does: a truthy value disables, a falsy one ("0"/"false"/"no"/"off") enables.
 */
export function gitInstructionsEnabled(envValue: string | undefined, includeGitInstructions: unknown): boolean {
  const raw = envValue?.trim().toLowerCase();
  if (raw !== undefined && raw.length > 0) return raw === "0" || raw === "false" || raw === "no" || raw === "off";
  return includeGitInstructions !== false;
}

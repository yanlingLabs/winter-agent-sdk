// SDK 0.0.16 Lane C (P16-5): the systemContext `gitStatus` snapshot, in claude 0.3.250's shape.
//
// claude's `aHe`, ported: five git reads in parallel, joined into blank-line-separated parts --
//   <snapshot caveat>                       (Winter's own wording)
//   Current branch: <branch>
//   Main branch (you will usually use this for PRs): <main>
//   Git user: <user.name>                  (only when set)
//   Status:\n<git status --short, or (clean)>   (cut at 2 000 characters, with claude's hint line)
//   Recent commits:\n<git log --oneline -n 5>
// A directory that is not a git work tree has NO gitStatus at all. A single git read that fails
// contributes an empty string (claude's reads never throw on a non-zero exit); only an unexpected
// failure drops the whole snapshot.
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

/** claude's `hde`. */
export const GIT_STATUS_MAX_CHARS = 2000;

const MAIN_BRANCH_CANDIDATES = ["main", "master"] as const;
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

/** claude's `$a`: the checked-out branch, `HEAD` when detached or unknown. */
async function currentBranch(cwd: string, env: GitEnv): Promise<string> {
  const { code, stdout } = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], env);
  return code === 0 ? stdout.trim() || "HEAD" : "HEAD";
}

/** claude's `$S`: origin's HEAD when it resolves, else the first of main/master origin has, else `main`. */
async function mainBranch(cwd: string, env: GitEnv): Promise<string> {
  const head = await runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], env);
  if (head.code === 0) {
    const name = head.stdout.trim().replace(/^origin\//, "");
    if (name.length > 0 && (await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`], env)).code === 0) return name;
  }
  for (const candidate of MAIN_BRANCH_CANDIDATES) {
    if ((await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], env)).code === 0) return candidate;
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
 * as claude's `VU` does: a truthy value disables, a falsy one ("0"/"false"/"no"/"off") enables.
 */
export function gitInstructionsEnabled(envValue: string | undefined, includeGitInstructions: unknown): boolean {
  const raw = envValue?.trim().toLowerCase();
  if (raw !== undefined && raw.length > 0) return raw === "0" || raw === "false" || raw === "no" || raw === "off";
  return includeGitInstructions !== false;
}

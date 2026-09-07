// Phase 5 Lane W (task 4), WS-11 §1.3: where a workflow's SOURCE comes from, and where a run's
// script GOES.
//
// THE RETIREMENT DELTA (WS-11 §1.3, stated as a retirement rather than a difference): Norma's `name`
// meant "save this script to `~/.norma/workflows/<name>.js` when the run completes." CC's `name`
// means the opposite -- "resolve an EXISTING script by this name." Norma's save-on-completion is
// retired outright; nothing in this file writes to a `workflows/` name store, and the only write it
// performs is the per-invocation persistence below, which is keyed by runId and is not a name store
// at all.
//
// NO USER-LEVEL STORE. Norma resolved `<normaHome>/workflows/<name>.js` as a second, lower-priority
// root. WS-11 §11 OQ2 records that whether the pinned runtime has a user-level store is UNCAPTURED,
// and WS-01 forbids inventing names -- so this resolves the project convention only. Adding the user
// root later is additive; shipping it now and finding the pin disagrees would not be.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

/**
 * The path-traversal guard, applied BEFORE any filesystem call ever sees the name -- `name` arrives
 * from a tool-call argument, i.e. from the model, and is about to be joined into a path. Same
 * alphabet and same rationale as Norma's original: no dots and no slashes, so a bare "." or ".."
 * stem is refused outright rather than relying on the `.js` suffix to accidentally neuter it into
 * "..js".
 */
const WORKFLOW_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** The project workflows directory for a brand -- `<brand.projectDirName>/workflows`. */
export function projectWorkflowsDir(brand?: Pick<BrandProfile, "projectDirName">): string {
  return join((brand ?? WINTER_BRAND).projectDirName, "workflows");
}

/** Winter's own value, for every caller that has not threaded a brand. */
export const PROJECT_WORKFLOWS_DIR = projectWorkflowsDir();

export type ResolvedWorkflowSource =
  | { ok: true; source: string; path: string | undefined; source_kind: "project" | "builtin" }
  | { ok: false; error: string };

export interface ResolveWorkflowByNameOptions {
  cwd: string;
  /**
   * TRUST-GATED, deliberately, and this is a disclosed judgment call (see the lane report).
   *
   * A `.winter/workflows/*.js` file is EXECUTABLE CODE a project supplies and the model runs -- the
   * same category as `.winter/agents/*.md`, which RULING R4-7 keeps trust-gated, and not the
   * category of skills/commands/WINTER.md, which P5-T1 capture (b) makes merely SOURCE-gated. Norma
   * trust-gated its own project workflow directory for the same reason. The consequence is real and
   * worth stating: in an untrusted workspace `name` resolves nothing, so a freshly-cloned repo's
   * workflows do not run until the workspace is trusted. `script`/`scriptPath` are unaffected.
   */
  trustedWorkspace: boolean;
  /** Injectable for the test that proves built-ins are consulted first; production passes nothing. */
  builtins?: Record<string, string>;
  /** P7a (D19): the session's brand -- the project dot-dir workflows live under. Omitted = `WINTER_BRAND`. */
  brand?: Pick<BrandProfile, "projectDirName">;
}

/**
 * WS-11 §1.3's built-in registry. EMPTY, and empty on purpose: WS-01 forbids inventing names, and no
 * built-in workflow has been captured from the pinned runtime. The lookup exists so adding one later
 * is a data change rather than a control-flow change.
 */
const BUILTIN_WORKFLOWS: Readonly<Record<string, string>> = Object.freeze({});

export function listBuiltinWorkflows(): string[] {
  return Object.keys(BUILTIN_WORKFLOWS);
}

/** Built-ins first, then the trusted project directory. Never throws. */
export function resolveWorkflowByName(name: string, opts: ResolveWorkflowByNameOptions): ResolvedWorkflowSource {
  if (!WORKFLOW_NAME_RE.test(name)) {
    return { ok: false, error: `invalid workflow name ${JSON.stringify(name)}: expected [A-Za-z0-9_-]+ (no dots, no path separators)` };
  }
  const builtin = (opts.builtins ?? BUILTIN_WORKFLOWS)[name];
  if (typeof builtin === "string") return { ok: true, source: builtin, path: undefined, source_kind: "builtin" };

  const workflowsDir = projectWorkflowsDir(opts.brand);
  if (!opts.trustedWorkspace) {
    return {
      ok: false,
      error: `workflow "${name}" was not resolved: ${workflowsDir}/ is only read in a TRUSTED workspace (a project workflow is executable code, like a project agent definition -- R4-7). Pass the script inline with \`script\`, or trust the workspace.`,
    };
  }
  const path = join(opts.cwd, workflowsDir, `${name}.js`);
  try {
    if (!statSync(path).isFile()) throw new Error("not a regular file");
    return { ok: true, source: readFileSync(path, "utf8"), path, source_kind: "project" };
  } catch {
    return { ok: false, error: `unknown workflow "${name}": no ${workflowsDir}/${name}.js in this project, and no built-in by that name` };
  }
}

// --- Persistence (WS-11 §1.3 + capture (3)) -------------------------------------------------------
//
// "Every invocation automatically persists its script under the session's durable area and returns
// the path in the tool result; iteration is `Edit` on that file + re-invoke with `{ scriptPath }`."
//
// THE PATH IS NOT NEGOTIABLE. Capture (3) walked all three temp roots of the pinned runtime and found
// the file at exactly one place, and RULING P5-B carved a model-writable hole in the P4-M write floor
// with the SAME six fixed positions. Persisting one segment off does not merely mismatch the pin --
// it lands outside the carve-out, where the baseline deny rules make the file unwritable, and the
// documented edit-then-rerun loop silently stops working.

export interface SessionScriptLocation {
  /** The resolved winter root in production (`resolveWinterHome()`), whose `projects/` child this addresses. */
  winterHome: string;
  projectKey: string;
  /** The session UUID -- the `<session-uuid>` segment of capture (3)'s path. */
  sessionId: string;
}

function sessionDir(loc: SessionScriptLocation): string {
  return join(loc.winterHome, "projects", loc.projectKey, loc.sessionId);
}

/** Winter-owned tree, 0700 throughout (WS-05 §9), same rule as every other directory this codebase creates. */
function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * A meta name is model-supplied and becomes a FILENAME. The name has already passed the meta
 * parser, which does not constrain its characters at all -- so it is sanitized here rather than
 * trusted. Anything outside the slug alphabet collapses to `-`, which cannot climb a directory.
 */
function sanitizeFileStem(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "workflow" : cleaned.slice(0, 80);
}

export interface PersistWorkflowScriptInput extends SessionScriptLocation {
  /** `meta.name` (capture (3): `<meta.name>-<runId>.js`). */
  name: string;
  runId: string;
  source: string;
}

/** Writes the script and returns its absolute path. Overwrites for the same run, so one run keeps one path. */
export function persistWorkflowScript(input: PersistWorkflowScriptInput): string {
  const dir = join(sessionDir(input), "workflows", "scripts");
  ensureDir(dir);
  const path = join(dir, `${sanitizeFileStem(input.name)}-${input.runId}.js`);
  writeFileSync(path, input.source, { mode: 0o600 });
  return path;
}

/** Capture (3)'s sibling: `<session>/subagents/workflows/<runId>` -- what `WorkflowOutput.transcriptDir` reports. */
export function workflowTranscriptDir(input: SessionScriptLocation & { runId: string }): string {
  return join(sessionDir(input), "subagents", "workflows", input.runId);
}

/**
 * The JOURNAL root -- under the SESSION TEMP directory, not the durable projects area.
 *
 * Deliberate, and disclosed. `resumeFromRunId` is SAME-SESSION-ONLY by contract (WS-11 §1.5,
 * `sdk-tools.d.ts:2786`), so a journal has no job to do once the session ends; capture (3) pinned the
 * durable location of the SCRIPT and says nothing about a journal; and WS-01 forbids inventing a new
 * durable directory name. Session temp is the D18 layout's own answer for per-session working state.
 */
export function workflowRunsDir(sessionTempDir: string): string {
  return join(sessionTempDir, "workflows", "runs");
}

// Materialize the pinned upstream tree — the ONLY step of the pipeline that touches a network.
//
// WS-13 §3 step 2: a shallow, blob-filtered git fetch of the pinned TAG, materializing only a
// versioned path allowlist. Never the ~452 MB application npm tarball, never `main`.
//
// Three properties this module exists to guarantee, each of which has a test that removes it:
//
//   1. THE PIN IS VERIFIED, NOT TRUSTED. `git rev-parse <tag>` must equal the recorded tag OBJECT
//      and `git rev-parse <tag>^{commit}` must equal the recorded COMMIT. A re-tag upstream — the
//      one thing a version string cannot survive — is therefore a hard refusal rather than a silent
//      change of what "the same pin" means. (This is not hypothetical bookkeeping: v3.8.50 is an
//      ANNOTATED tag, so its own object id `6f5d4e00…` is NOT a commit, and `git clone --branch`
//      says so out loud. The research report records that id as "resolving to" the release; taking
//      it as the commit would have pinned nothing.)
//   2. NO UPSTREAM CODE RUNS. Nothing here evaluates, imports, or executes a materialized file —
//      `literal-extractor.ts` only ever parses text. git itself is run with `core.hooksPath` pointed
//      at an empty directory so a hostile repository's hooks cannot execute either, and with
//      `--template=` so the clone gets no sample hooks at all.
//   3. THE BOUNDARY NEVER WIDENS. Every materialized path is checked against the allowlist AFTER
//      checkout, not merely handed to sparse-checkout before it. A pattern that turns out to match
//      more than its author expected is caught by the check, not by a reviewer's eyesight.
//
// Node-portable by construction (this package is inside tsconfig.sdk-fence.json): `node:` builtins
// only, no Bun API, no `fetch`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

/** The recorded pin. All four fields are checked against the fetched clone before anything is read. */
export interface UpstreamPin {
  repository: string;
  tag: string;
  /** The annotated tag's OWN object id. */
  tagObject: string;
  /** The tag peeled to a commit — this is what the catalog records as `upstream.commit`. */
  commit: string;
}

/** One allowlist path entry. `pattern` is a git sparse-checkout pattern rooted at the repository. */
export interface AllowlistPath {
  pattern: string;
  role: "extract" | "claim" | "notice";
  why: string;
}

export interface MaterializedFile {
  /** Repository-relative, `/`-separated. */
  path: string;
  /** git's own blob id — authoritative, and directly comparable with `git ls-tree` upstream. */
  blobId: string;
  /** sha256 of the materialized bytes, so a manifest entry is verifiable without git. */
  sha256: string;
  bytes: number;
  role: AllowlistPath["role"];
  /** The allowlist pattern that admitted this path. */
  admittedBy: string;
}

export interface FetchResult {
  /** Absolute path of the checkout root. Valid until `cleanup()`. */
  root: string;
  commit: string;
  tagObject: string;
  files: MaterializedFile[];
  read(path: string): string;
  cleanup(): void;
}

/** Thrown for every refusal in this module. A pin/boundary failure is never a warning. */
export class UpstreamFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamFetchError";
  }
}

/**
 * Translate one git sparse-checkout `--no-cone` pattern into a matcher.
 *
 * Deliberately supports only the subset the allowlist actually uses — a leading `/` anchor,
 * `**` (any depth) and `*` (one segment) — and rejects anything else, because a pattern this
 * function silently mis-parses is a boundary hole that looks like a boundary.
 */
export function compilePathPattern(pattern: string): (path: string) => boolean {
  if (!pattern.startsWith("/")) {
    throw new UpstreamFetchError(`allowlist pattern ${JSON.stringify(pattern)} must be repository-anchored (start with "/")`);
  }
  if (/[?\[\]{}]/.test(pattern)) {
    throw new UpstreamFetchError(`allowlist pattern ${JSON.stringify(pattern)} uses a glob feature this extractor deliberately does not implement`);
  }
  const body = pattern.slice(1);
  // Escape regex metacharacters, then re-introduce the two wildcards we do support. `**` becomes
  // "any characters"; a lone `*` becomes "any characters except a separator".
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "*") {
      if (body[i + 1] === "*") {
        re += ".*";
        i++;
        // `foo/**` should also match `foo` itself is NOT wanted here: an allowlist entry names a
        // subtree's CONTENTS. Trailing `/` in the source pattern is already consumed.
      } else {
        re += "[^/]*";
      }
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const compiled = new RegExp(`^${re}$`);
  return (path: string): boolean => compiled.test(path);
}

function git(cwd: string, args: string[], hooksPath: string): string {
  return execFileSync("git", ["-c", `core.hooksPath=${hooksPath}`, "-c", "advice.detachedHead=false", ...args], {
    cwd,
    encoding: "utf8",
    // A hostile or broken repository must not be able to hand us an unbounded stdout.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
  }
}

export interface FetchOptions {
  /** Where the scratch checkout goes. Defaults to a fresh mkdtemp under the OS temp dir. */
  parentDir?: string;
  /** Overrides `pin.repository` — the tests point this at a `file://` fixture repository. */
  repositoryOverride?: string;
}

/**
 * Clone the pinned tag, materialize exactly the allowlisted paths, verify, and hash.
 *
 * The caller MUST call `cleanup()` (the sync script does it in a `finally`): the checkout is a
 * scratch directory outside the repository and nothing but the generated JSON and the two upstream
 * notice files ever survives it.
 */
export function fetchUpstream(pin: UpstreamPin, paths: AllowlistPath[], options: FetchOptions = {}): FetchResult {
  const parent = options.parentDir ?? mkdtempSync(join(tmpdir(), "winter-omniroute-"));
  const root = join(parent, "src");
  // An EMPTY hooks directory, passed to every git invocation: a repository cannot run its own code
  // during our clone/checkout. `--template=` additionally stops git seeding the clone with the
  // sample hooks it would otherwise copy from the system template dir.
  const hooksPath = join(parent, "empty-hooks");
  mkdirSync(hooksPath, { recursive: true });

  const cleanup = (): void => {
    rmSync(parent, { recursive: true, force: true });
  };

  try {
    const repository = options.repositoryOverride ?? pin.repository;
    git(parent, ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--template=", "--branch", pin.tag, repository, root], hooksPath);

    // --- (1) verify the pin BEFORE reading a single byte of content ---------------------------
    const resolvedTagObject = git(root, ["rev-parse", pin.tag], hooksPath);
    if (resolvedTagObject !== pin.tagObject) {
      throw new UpstreamFetchError(
        `pin mismatch: tag ${pin.tag} resolves to object ${resolvedTagObject}, but UPSTREAM.json records ${pin.tagObject}. Upstream re-tagged, or the pin is wrong — refusing to extract.`,
      );
    }
    const resolvedCommit = git(root, ["rev-parse", `${pin.tag}^{commit}`], hooksPath);
    if (resolvedCommit !== pin.commit) {
      throw new UpstreamFetchError(
        `pin mismatch: tag ${pin.tag} PEELS to commit ${resolvedCommit}, but UPSTREAM.json records ${pin.commit}. Refusing to extract.`,
      );
    }

    // --- (2) materialize only the allowlist ---------------------------------------------------
    const matchers = paths.map((p) => ({ entry: p, matches: compilePathPattern(p.pattern) }));
    git(root, ["sparse-checkout", "init", "--no-cone"], hooksPath);
    git(root, ["sparse-checkout", "set", "--no-cone", ...paths.map((p) => p.pattern)], hooksPath);
    git(root, ["checkout", pin.commit], hooksPath);

    // --- (3) re-check the boundary against what actually landed --------------------------------
    const materialized: string[] = [];
    walk(root, root, materialized);
    materialized.sort();

    const blobIds = new Map<string, string>();
    for (const line of git(root, ["ls-tree", "-r", pin.commit], hooksPath).split("\n")) {
      // `<mode> <type> <object>\t<path>`
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const meta = line.slice(0, tab).split(/\s+/);
      const objectId = meta[2];
      if (objectId === undefined) continue;
      blobIds.set(line.slice(tab + 1), objectId);
    }

    const files: MaterializedFile[] = [];
    for (const path of materialized) {
      const hit = matchers.find((m) => m.matches(path));
      if (hit === undefined) {
        throw new UpstreamFetchError(
          `boundary violation: ${path} was materialized but matches no allowlist pattern. The extractor never widens the source boundary — add a reviewed entry to third_party/omniroute-provider-source/allowlist.json or narrow the pattern that pulled it in.`,
        );
      }
      const bytes = readFileSync(join(root, path));
      const blobId = blobIds.get(path);
      if (blobId === undefined) {
        throw new UpstreamFetchError(`${path} is in the working tree but not in the pinned commit's tree — refusing to hash an unpinned file`);
      }
      files.push({
        path,
        blobId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: statSync(join(root, path)).size,
        role: hit.entry.role,
        admittedBy: hit.entry.pattern,
      });
    }

    return {
      root,
      commit: resolvedCommit,
      tagObject: resolvedTagObject,
      files,
      read(path: string): string {
        return readFileSync(join(root, path), "utf8");
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// WS-21 §6.3 item 4 (F17): `@import` expansion, claude's tier rule.
//
// TOKEN GRAMMAR (claude's documented `@path` import syntax): `@path`, `@./path`, `@~/path` or
// `@/path`, a run of non-whitespace characters with `\ ` as an escaped space, a trailing `#fragment`
// stripped before resolution. A BARE `@path` (no `./` prefix) is relative, identically to `@./path`.
// Code-span/code-block skipping is done with a small hand-rolled scanner rather than a markdown lexer
// (Winter has no `marked` dependency anywhere in this workspace -- subagents/definitions.ts's header
// states the same "no new dependency" constraint).
//
// WHAT DIFFERS FROM claude, deliberately: claude adds each included file as a SEPARATE context entry
// ahead of the including file and never touches the `@path` text in place. This function does an
// INLINE EXPANSION instead (the brief's own interface: one `content` string out), because
// winter-md.ts's `WinterMdBlock`/rules.ts's `LoadedRule` are both already "one string per file"
// shapes with no second-entry channel to grow one into. The net effect the model sees is the same:
// the referenced content is present, once, reachable from the importing file.
//
// TIER SCOPE (F17, pinned): a USER-tier file follows an `@import` ANYWHERE (`includeExternal`,
// unrestricted). A PROJECT or LOCAL file follows one only when the resolved target is inside
// `projectRoot` -- outside it, the import is DROPPED (reported, never expanded) rather than pulling
// arbitrary filesystem content into a repository's own instructions. The tier is fixed for the
// whole expansion: a project file's own nested imports stay project-scoped too.
//
// AN UNRESOLVED TOKEN (missing file, depth exceeded, out-of-scope, or not even shaped like a valid
// import) STAYS AS LITERAL TEXT -- there is nothing to substitute, so the `@path` the author wrote
// is left exactly as written, never silently deleted.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type ImportTier = "user" | "project" | "local";

export interface ExpandImportsInput {
  content: string;
  /** The file this content came from -- imports resolve relative to ITS directory. */
  filePath: string;
  tier: ImportTier;
  /** `null` when there is no repository (a bare `cwd`); a project/local import then never resolves. */
  projectRoot: string | null;
  /** Default 5 (F17 / the plan brief). */
  maxDepth?: number;
}

export interface ExpandImportsResult {
  content: string;
  /** Absolute paths of every import this expansion DROPPED (out-of-scope for a project/local file). Depth-capped and missing imports are not reported here -- they are ordinary "nothing to substitute" outcomes, not scope refusals. */
  dropped: string[];
}

const DEFAULT_MAX_DEPTH = 5;

/**
 * A fresh global pattern for `@` import tokens: group 1 is what precedes the `@` (the start of the
 * text, or one whitespace character), group 2 the raw token text after the `@`.
 */
function importTokenPattern(): RegExp {
  // `^` without the `m` flag is the start of the scanned text only; a token at a later line start is
  // matched through the newline before it. A token unit is any non-whitespace, non-backslash
  // character, or a backslash-escaped space.
  return /(^|\s)@((?:[^\s\\]|\\ )+)/g;
}

/** The first characters a bare relative import path may start with. */
const BARE_IMPORT_START = /^[A-Za-z0-9._-]/;

/** The import path a raw token names (fragment cut, escaped spaces restored), or `undefined` when it is not a valid import. */
function importTokenPath(rawToken: string): string | undefined {
  const hash = rawToken.indexOf("#");
  const withoutFragment = hash === -1 ? rawToken : rawToken.slice(0, hash);
  if (withoutFragment.length === 0) return undefined;
  const path = withoutFragment.replaceAll("\\ ", " ");
  if (path.startsWith("./") || path.startsWith("~/")) return path;
  if (path.startsWith("/")) return path === "/" ? undefined : path;
  return BARE_IMPORT_START.test(path) ? path : undefined;
}

function resolveImportPath(token: string, containingFileDir: string): string {
  if (token.startsWith("~/")) return resolve(homedir(), token.slice(2));
  if (token.startsWith("/")) return resolve(token);
  return resolve(containingFileDir, token); // "./x" or a bare relative "x" -- both relative to the file
}

/**
 * WS-21 §6.3 item 7 (fix round 1): `resolve()` alone is a LEXICAL check -- a project/local file's
 * `@import` naming `link/secret.md`, where `link` is a symlink inside `projectRoot` pointing at
 * `/etc` (or anywhere else outside the repo), resolved to a path textually under `projectRoot` and
 * therefore passed this gate, even though the file it actually reads lives outside the scope this
 * tier is supposed to be confined to.
 *
 * Realpath-canonicalizes both sides so the comparison is on where the bytes actually come from, not
 * on the text of the path -- but ONLY when the TARGET exists: a target that does not exist yet has
 * nothing on disk whose real location could diverge from its written path, and `realpathSync` would
 * just throw ENOENT for no benefit. That case falls back to the plain lexical comparison (byte-
 * identical to this function's pre-fix behaviour), and the pre-existing "missing file -> unresolved,
 * literal text stays" rule a few lines below in `replaceImportTokens` is what decides its fate --
 * never a scope-drop for a path that merely looks out-of-root before anything has been written there.
 *
 * `root` is realpath'd too (falling back to its lexical form if that fails, e.g. a root that does
 * not exist): a legitimate in-root target must not fail this check only because `projectRoot` itself
 * is reached through an OS-level symlink (macOS's `/tmp` -> `/private/tmp` is the recurring case
 * every fixture in this workspace has to account for), the same class of gotcha `sandbox/profile.ts`'s
 * `canonicalizePath` exists for on the sandbox side.
 */
function isInsideRoot(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  if (!existsSync(p)) {
    return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
  }
  const canonicalPath = realpathSync(p);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(r);
  } catch {
    canonicalRoot = r;
  }
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(canonicalRoot.endsWith("/") ? canonicalRoot : `${canonicalRoot}/`);
}

/** Splits `content` into lines, each RETAINING its own trailing `\n` (the last line may have none), so segments can be rejoined with no separator and reproduce the original byte-for-byte. */
function splitLinesKeepEol(content: string): string[] {
  return content.length === 0 ? [] : content.split(/(?<=\n)/);
}

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Buckets `content` into runs of fenced-code-block lines and everything else. A `@path` inside a
 * fenced block is never a candidate for expansion -- the whole point of "code spans and code blocks
 * are skipped" (F17 / the brief). Deliberately simple: a closing fence is recognised by its first
 * character matching the opener's (backtick vs tilde), not by an exact character-count match --
 * good enough for the rule/instructions files this loader reads, and erring toward TREATING MORE
 * content as code (never expanding inside it) is the safe direction for a skip rule.
 */
function segmentCodeAndText(content: string): { text: string; code: boolean }[] {
  const segments: { text: string; code: boolean }[] = [];
  let buf: string[] = [];
  let inCode = false;
  let fenceChar: string | null = null;
  const flush = (code: boolean): void => {
    if (buf.length > 0) segments.push({ text: buf.join(""), code });
    buf = [];
  };
  for (const line of splitLinesKeepEol(content)) {
    const fenceMatch = FENCE_LINE_RE.exec(line);
    if (!inCode && fenceMatch) {
      flush(false);
      inCode = true;
      fenceChar = fenceMatch[1]!.charAt(0);
      buf.push(line);
      continue;
    }
    if (inCode) {
      buf.push(line);
      if (fenceMatch && fenceMatch[1]!.charAt(0) === fenceChar) {
        flush(true);
        inCode = false;
        fenceChar = null;
      }
      continue;
    }
    buf.push(line);
  }
  flush(inCode);
  return segments;
}

interface ExpandCtx {
  tier: ImportTier;
  projectRoot: string | null;
  maxDepth: number;
  dropped: string[];
  visited: ReadonlySet<string>;
}

function expandOnce(content: string, containingFileDir: string, depth: number, ctx: ExpandCtx): string {
  return segmentCodeAndText(content)
    .map((seg) => (seg.code ? seg.text : expandTextRun(seg.text, containingFileDir, depth, ctx)))
    .join("");
}

/** Splits out INLINE code spans (single-backtick, non-multiline) before scanning for `@path` tokens -- a `@path` written inside `` `like this` `` is code too, not just fenced-block content. */
function expandTextRun(text: string, containingFileDir: string, depth: number, ctx: ExpandCtx): string {
  const parts = text.split(/(`[^`\n]*`)/);
  return parts.map((part, i) => (i % 2 === 1 ? part : replaceImportTokens(part, containingFileDir, depth, ctx))).join("");
}

function replaceImportTokens(text: string, containingFileDir: string, depth: number, ctx: ExpandCtx): string {
  return text.replace(importTokenPattern(), (full: string, leading: string, rawToken: string) => {
    const token = importTokenPath(rawToken);
    if (token === undefined) return full; // not an import: literal text stays

    const resolvedPath = resolveImportPath(token, containingFileDir);

    if (ctx.tier !== "user") {
      if (ctx.projectRoot === null || !isInsideRoot(resolvedPath, ctx.projectRoot)) {
        ctx.dropped.push(resolvedPath);
        return full; // out of scope: literal text stays, never expanded
      }
    }

    if (depth >= ctx.maxDepth) return full; // depth cap reached: literal text stays
    if (ctx.visited.has(resolvedPath)) return full; // a cycle -- never expand back into an ancestor

    let raw: string;
    try {
      if (!statSync(resolvedPath).isFile()) return full;
      raw = readFileSync(resolvedPath, "utf8");
    } catch {
      return full; // missing/unreadable: unresolved, literal text stays
    }

    const nested = expandOnce(raw, dirname(resolvedPath), depth + 1, { ...ctx, visited: new Set(ctx.visited).add(resolvedPath) });
    return `${leading}${nested}`;
  });
}

/**
 * Expand every `@import` token in `input.content`, recursively, up to `maxDepth` levels. Returns
 * the expanded content plus the absolute paths of every import DROPPED for being out of a
 * project/local file's scope (never the depth-capped or missing ones -- see the module header).
 */
export function expandImports(input: ExpandImportsInput): ExpandImportsResult {
  const dropped: string[] = [];
  const ctx: ExpandCtx = {
    tier: input.tier,
    projectRoot: input.projectRoot,
    maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
    dropped,
    visited: new Set([resolve(input.filePath)]),
  };
  const content = expandOnce(input.content, dirname(input.filePath), 1, ctx);
  return { content, dropped };
}

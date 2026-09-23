// WS-21 §6.3 item 4 (F17): `@import` expansion, claude's tier rule.
//
// TOKEN GRAMMAR ported from the pinned reference's `extractIncludePathsFromTokens` (leaked source,
// `src/utils/claudemd.ts`): `@path`, `@./path`, `@~/path` or `@/path`, a run of non-whitespace
// characters with `\ ` as an escaped space, a trailing `#fragment` stripped before resolution. A
// BARE `@path` (no `./` prefix) is relative, identically to `@./path` -- the reference's own
// doc comment says so verbatim. NOT REBUILT FROM MEMORY: the regex and the path-shape validity
// check below are the reference's, adapted (Winter has no `marked`/YAML dependency anywhere in this
// workspace -- subagents/definitions.ts's header states the same "no new dependency" constraint --
// so code-span/code-block skipping is done with a small hand-rolled scanner instead of a markdown
// lexer, never by guessing the token grammar itself).
//
// WHAT DIFFERS FROM THE REFERENCE, deliberately: claude's own importer adds each included file as a
// SEPARATE context entry ahead of the including file and never touches the `@path` text in place.
// This function does an INLINE EXPANSION instead (the brief's own interface: one `content` string
// out), because winter-md.ts's `WinterMdBlock`/rules.ts's `LoadedRule` are both already "one string
// per file" shapes with no second-entry channel to grow one into. The net effect the model sees is
// the same: the referenced content is present, once, reachable from the importing file.
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
import { readFileSync, statSync } from "node:fs";
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

// (leading whitespace-or-start, the raw "@token" text after the "@"). A run of non-whitespace,
// non-backslash characters, or an escaped space (`\ `) -- ported verbatim from the reference.
const IMPORT_TOKEN_RE = /(^|\s)@((?:[^\s\\]|\\ )+)/g;

/** claude's own path-shape gate, ported verbatim: `@path`, `@./path`, `@~/path`, `@/path` (never bare `@/`), or a bare relative path that doesn't start with punctuation. */
function isValidImportPath(path: string): boolean {
  if (path.startsWith("./") || path.startsWith("~/")) return true;
  if (path.startsWith("/") && path !== "/") return true;
  return !path.startsWith("@") && !/^[#%^&*()]/.test(path) && /^[a-zA-Z0-9._-]/.test(path);
}

function resolveImportPath(token: string, containingFileDir: string): string {
  if (token.startsWith("~/")) return resolve(homedir(), token.slice(2));
  if (token.startsWith("/")) return resolve(token);
  return resolve(containingFileDir, token); // "./x" or a bare relative "x" -- claude treats them alike
}

function isInsideRoot(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
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
  return text.replace(IMPORT_TOKEN_RE, (full: string, leading: string, rawToken: string) => {
    let token = rawToken;
    const hashIndex = token.indexOf("#");
    if (hashIndex !== -1) token = token.slice(0, hashIndex);
    if (token.length === 0) return full; // "@#fragment" alone -- nothing to import
    token = token.replace(/\\ /g, " ");
    if (!isValidImportPath(token)) return full;

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

// WS-06 §3.1 "Read" -- the real executor (Phase 3, Lane A / Task 4). Registers over the stub
// descriptors/read.ts already put in the registry (see registry.ts's own header: "every later
// lane's REAL executor lives in a SIBLING tools/impl/*.ts file that imports replaceExecutor").
//
// *** RESULT SHAPE (code-mode images, 2026-09-29) ***
// WS-06 §3.1 pins Read's INPUT shape verbatim (`{file_path, offset?, limit?, pages?}`) and describes the
// RESULT in prose (the descriptor, descriptors/read.ts, now says what the result below is).
//   1. A text read returns bare text in `output`, exactly as before.
//   2. An IMAGE read returns real content blocks in `ToolResultPayload.blocks` (registry.ts): one
//      `{type:"image", source:{type:"base64", media_type, data}}` block, claude's own Read shape. The
//      engine writes them as the `tool_result`'s content array, so the model SEES the image on every
//      provider adapter (each adapter carries a tool-result image natively where its API allows it and
//      otherwise right after the tool results -- provider-runtime). `output` holds a one-line text
//      rendering for hooks and logs. The interim `{winterReadBlocks}` JSON envelope this file used to
//      put in `output` (which reached the model as base64 TEXT) is gone. The image is made ready by
//      tools/image-prep.ts (shared with MCP image results): shrunk to 1568 px on its long edge, BMP/TIFF/
//      HEIC converted, re-encoded as JPEG when still over the byte limit -- all with macOS's `sips` on
//      copies in the session temp dir, never the user's file.
//   3. A model whose catalog row reads no images gets a short text refusal instead
//      (`MODEL_DOES_NOT_SUPPORT_IMAGES` + the path), never base64 (`ctx.modelReadsImages`).
//   4. Notebooks render as text blocks with their `image/png` outputs as image blocks (plain text when
//      the notebook has no image output).
//   5. PDF content: full content-stream text extraction (inflating FlateDecode streams and tokenizing
//      Tj/TJ operators) is deliberately NOT attempted, and no adapter carries a document block, so a
//      PDF read returns honest METADATA TEXT (byte size, best-effort page count, the pages asked for)
//      and says the content is not shown -- never the raw base64 bytes, which a model cannot read.
//
// Other unpinned choices made here (all flagged, all reasonable "minimal honest shape" picks):
//   - DEFAULT_LINE_LIMIT=2000 / LINE_TRUNCATE_LENGTH=2000: mirrors Claude Code's own real,
//     observable Read tool behavior ("reads up to 2000 lines... lines longer than 2000 characters
//     will be truncated").
//   - MAX_RESULT_CHARS=100_000: an invented hard cap so an EXPLICIT offset/limit that still can't
//     fit errors instead of silently over-running (WS-06: "an explicitly bounded range that still
//     cannot fit errors"). No spec value exists for this; deliberately generous.
//   - `complete` (ctx.readState) is FALSE whenever the caller supplied offset/limit/pages AT ALL,
//     even if that window happened to cover the whole file -- the task-4 brief's own words
//     ("complete: true ONLY for whole-file reads -- a windowed/offset/limit/pages read records
//     complete: false") are read literally/conservatively here: Lane B's edit ladder is safety
//     -relevant, so under-claiming completeness (forcing a re-read) beats over-claiming it.
//   - PDF_RANGE_MAX_PAGES=20, NB_OUTPUT_CAP=4000 (per-notebook-output-block character cap, mirrors
//     Norma's own fs-read.ts precedent): invented, documented thresholds. READ_IMAGE_MAX_BYTES and
//     READ_IMAGE_MAX_DIMENSION are the providers' own documented limits (see their comments).
//   - Dimension parsing is hand-rolled (no library, per R3-5) for PNG/GIF/BMP/JPEG/WebP; `sips` answers
//     for the rest. Resizing and conversion shell out to `/usr/bin/sips` (argv, no shell) -- the runtime
//     ships for darwin-arm64 only. Without it, an image already within every limit is sent as it is and
//     anything else is refused with a text that says why; nothing is sent that a provider would reject.
//
// ctx.permissions.probeReadAccess is deliberately UNUSED here: the standing P2 evaluator gates the
// call before this executor ever runs (task-4 brief: "your executor does NOT re-evaluate
// permissions; it does the content work").
//
// N1 (fix wave, P3 close-out): STALE as of T8 -- corrected, not deleted, so a future reader who
// only skims history sees why the wiring changed. `tools/impl/index.ts` now exists and
// engine.ts force-imports it (T8, "Settings threading"/production-wiring MUST) alongside
// descriptors/index.ts -- this file's own module-load side effect below reaches every real session,
// not merely test files that import it directly.
import { readFileSync, statSync, type Stats } from "node:fs";
import { basename, extname, resolve } from "node:path";
// Self-sufficiency: guarantees the "Read" stub exists before replaceExecutor (bottom of this file)
// runs, regardless of whatever ELSE imported this module or in what order -- this file is not yet
// wired into engine.ts's own import graph (advisor-confirmed: that wiring is T8/controller's job),
// so it cannot rely on engine.ts's own `import "./tools/descriptors/index.ts"` having already run.
// Side-effect-only and idempotent (descriptors/index.ts's own header); importing it here and again
// from a test file is safe -- ES modules evaluate a given module's body exactly once.
import "../descriptors/index.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultBlock, type ToolResultPayload } from "../registry.ts";
import {
  IMAGE_MAX_INPUT_BYTES,
  MODEL_DOES_NOT_SUPPORT_IMAGES,
  describePreparedImage,
  imagePrepWorkRoot,
  prepareImageForModel,
  resultBlocksForModel,
  type PreparedImage,
  type RawResultPart,
} from "../image-prep.ts";
// Re-exported: the image facts live in tools/image-prep.ts (shared with MCP image results).
export {
  IMAGE_MAX_LONG_EDGE,
  MODEL_DOES_NOT_SUPPORT_IMAGES,
  READ_IMAGE_MAX_BYTES,
  READ_IMAGE_MAX_DIMENSION,
  parseBmpDimensions,
  parseGifDimensions,
  parseJpegDimensions,
  parsePngDimensions,
  parseWebpDimensions,
  sniffImageType,
} from "../image-prep.ts";
import { emptyPathSet, type ExtractedPaths } from "../paths-seam.ts";

// --- Input (WS-06 §3.1, verbatim) -----------------------------------------------------------------

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}

function parseInput(raw: unknown): ReadInput {
  if (typeof raw !== "object" || raw === null) throw new Error("input must be an object");
  const o = raw as Record<string, unknown>;
  const filePath = o["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) throw new Error("file_path must be a non-empty string");
  const offset = o["offset"];
  const limit = o["limit"];
  const pages = o["pages"];
  if (offset !== undefined && typeof offset !== "number") throw new Error("offset must be a number");
  if (limit !== undefined && typeof limit !== "number") throw new Error("limit must be a number");
  if (pages !== undefined && typeof pages !== "string") throw new Error("pages must be a string");
  return {
    file_path: filePath,
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(pages !== undefined ? { pages } : {}),
  };
}

// --- Multimodal results (see RESULT SHAPE above) --------------------------------------------------------

/** The model-facing block for a prepared image. */
function imageBlockOf(image: PreparedImage): ToolResultBlock {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.bytes.toString("base64") } };
}

// --- Plain text (line windowing) --------------------------------------------------------------------

const DEFAULT_LINE_LIMIT = 2000;
const LINE_TRUNCATE_LENGTH = 2000;
const MAX_RESULT_CHARS = 100_000;

function readPlainText(target: string, st: Stats, input: ReadInput, usedWindow: boolean, ctx: ToolExecutionContext): ToolResultPayload {
  const content = readFileSync(target, "utf8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  const offset = input.offset ?? 1;
  if (offset < 1) return { output: `Error: offset must be >= 1 (got ${offset})`, isError: true };
  const startIdx = offset - 1;
  if (startIdx > totalLines) {
    return { output: `Error: offset ${offset} is beyond ${basename(target)}'s ${totalLines} line${totalLines === 1 ? "" : "s"}`, isError: true };
  }

  const hasExplicitLimit = input.limit !== undefined;
  const effectiveLimit = input.limit ?? DEFAULT_LINE_LIMIT;
  if (hasExplicitLimit && effectiveLimit < 1) {
    return { output: `Error: limit must be >= 1 (got ${effectiveLimit})`, isError: true };
  }
  const endIdx = Math.min(startIdx + effectiveLimit, totalLines);

  let anyLineTruncated = false;
  const windowed: string[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i] ?? "";
    if (line.length > LINE_TRUNCATE_LENGTH) {
      windowed.push(line.slice(0, LINE_TRUNCATE_LENGTH) + "…[line truncated]");
      anyLineTruncated = true;
    } else {
      windowed.push(line);
    }
  }
  let body = windowed.join("\n");

  if (hasExplicitLimit && body.length > MAX_RESULT_CHARS) {
    return {
      output: `Error: the requested range (offset ${offset}, limit ${effectiveLimit}) is ${body.length} characters, exceeding the ${MAX_RESULT_CHARS}-character limit per read -- reduce limit and retry`,
      isError: true,
    };
  }
  if (!hasExplicitLimit && body.length > MAX_RESULT_CHARS) {
    // Implicit default window still overflowed the char budget (pathologically long lines) --
    // clip further rather than error (never explicitly requested, so we're free to truncate more).
    body = body.slice(0, MAX_RESULT_CHARS);
  }

  // Two DIFFERENT questions, deliberately kept separate (a bug caught by hand-tracing an
  // offset=2001-continuation call before this file's own tests were written): "is there more
  // content after this window" (reachedEnd -- drives the human-facing PARTIAL/continuation footer)
  // vs. "did this call capture the file from the very start" (coveredWholeFile, additionally
  // requires startIdx===0 -- drives ONLY the readState `complete` flag below). Conflating them
  // would show a spurious "[PARTIAL...]" footer on a continuation call that lands exactly on EOF
  // (offset=2001 on a 2500-line file: reachedEnd is true, but startIdx!==0).
  const reachedEnd = endIdx >= totalLines;
  const isPartial = !hasExplicitLimit && !reachedEnd;
  if (isPartial) {
    const nextOffset = endIdx + 1;
    body += `\n\n[PARTIAL: showing lines ${offset}-${endIdx} of ${totalLines} total lines in ${basename(target)}. Call again with offset=${nextOffset} to continue.]`;
  }
  if (anyLineTruncated) {
    body += `\n[one or more lines exceeded ${LINE_TRUNCATE_LENGTH} characters and were truncated]`;
  }

  const coveredWholeFile = startIdx === 0 && reachedEnd;
  const complete = !usedWindow && coveredWholeFile;
  ctx.readState.recordRead(target, { complete, mtimeMs: st.mtimeMs });
  return { output: body };
}

// --- Images ------------------------------------------------------------------------------------------

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
};

function imageRefusal(text: string): ToolResultPayload {
  return { output: text, isError: true };
}

async function readImage(target: string, st: Stats, usedWindow: boolean, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  // The gate comes first: a text-only model gets the same answer whatever the file holds.
  if (ctx.modelReadsImages === false) return imageRefusal(`${MODEL_DOES_NOT_SUPPORT_IMAGES}: ${target}`);
  if (st.size > IMAGE_MAX_INPUT_BYTES) {
    return imageRefusal(`Error: image ${target} cannot be shown to the model: it is ${st.size} bytes, over the ${IMAGE_MAX_INPUT_BYTES}-byte limit for an image to prepare. Make a smaller copy first (for example on macOS: sips -Z 1568 "${target}" --out <smaller.png>) and read that.`);
  }
  // Shrunk, converted or re-encoded as needed -- on a COPY in the session temp dir, never the user's
  // file (tools/image-prep.ts, shared with MCP image results).
  const prepared = await prepareImageForModel(readFileSync(target), { workRoot: () => imagePrepWorkRoot(ctx), ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) });
  if (!prepared.ok) return imageRefusal(`Error: image ${target} cannot be shown to the model: ${prepared.reason}.`);
  // A whole image is always attached in full -- there is no partial-image concept -- but the
  // brief's own rule is literal and carve-out-free ("a windowed/offset/limit/pages read records
  // complete: false"): a caller that passed offset/limit/pages on an image read (nonsensical, but
  // not rejected -- WS-06 doesn't scope those fields per file type) must not be told it was a
  // trustworthy whole-file read either. Same reasoning applies to notebooks and PDFs below.
  ctx.readState.recordRead(target, { complete: !usedWindow, mtimeMs: st.mtimeMs });
  return { output: `[image: ${target} (${describePreparedImage(prepared)})]`, blocks: [imageBlockOf(prepared)] };
}

// --- Notebooks (.ipynb) ------------------------------------------------------------------------------

interface NbOutput {
  output_type?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
interface NbCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: NbOutput[];
}
interface NbNotebook {
  cells?: NbCell[];
}

const NB_OUTPUT_CAP = 4000;

function nbText(source: string | string[] | undefined): string {
  if (source === undefined) return "";
  return Array.isArray(source) ? source.join("") : source;
}
function nbCap(s: string): string {
  return s.length <= NB_OUTPUT_CAP ? s : s.slice(0, NB_OUTPUT_CAP) + `\n[output truncated at ${NB_OUTPUT_CAP} chars]`;
}

// Renders one notebook into text and image parts: text is grouped per run of consecutive non-image
// output; a `display_data`/`execute_result` cell carrying an `image/png` output splits the run
// into its own image part (so a notebook mixing prose and plot output produces exactly the
// interleaved text/image blocks a real multi-part tool_result carries). `notebookResult` makes the
// images model-ready through the shared `resultBlocksForModel` (image-prep.ts): shrunk like any image
// Read, and a note in place of any the model cannot be shown. Returns `undefined` on
// malformed JSON / no `cells` array -- the caller falls through to the plain-text path, matching
// Norma's own fs-read.ts precedent (a malformed notebook is just read as text, offset/limit and
// all, not force-fitted into notebook rendering).
function renderNotebookParts(raw: string): RawResultPart[] | undefined {
  let nb: NbNotebook;
  try {
    nb = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(nb.cells)) return undefined;

  const blocks: RawResultPart[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length > 0) {
      blocks.push({ type: "text", text: pending.join("\n") });
      pending = [];
    }
  };

  nb.cells.forEach((cell, i) => {
    const idx = i + 1;
    const type = cell.cell_type ?? "code";
    const header = [`[cell ${idx} -- ${type}]`, nbText(cell.source)].filter((p) => p.length > 0).join("\n");
    if (header.length > 0) pending.push(header);

    if (type === "code" && Array.isArray(cell.outputs)) {
      for (const out of cell.outputs) {
        if (out.output_type === "stream") {
          pending.push(nbCap(nbText(out.text)));
        } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
          const data = out.data ?? {};
          // Fix round 1 (disclosed narrowness): only `image/png` is recognized here. A notebook
          // output dict carrying `image/jpeg` (or any other image mime) with NO `text/plain`
          // sibling key produces NO block at all for that output -- neither an image block (not
          // parsed) nor a text fallback (nothing to fall back to) -- it is silently dropped. Scoped
          // this way because `image/png` is by far Matplotlib/Jupyter's default plot-output mime
          // and `parsePngDimensions` already exists for it; a second hand-rolled JPEG-in-base64
          // path was judged not worth it for this phase. Flagged here rather than left implicit.
          const rawPng = data["image/png"];
          const png = typeof rawPng === "string" || Array.isArray(rawPng) ? nbText(rawPng as string | string[]) : undefined;
          if (png !== undefined) {
            flush();
            blocks.push({ type: "image", bytes: Buffer.from(png, "base64") });
          } else {
            const text = data["text/plain"];
            if (typeof text === "string" || Array.isArray(text)) pending.push(nbCap(nbText(text as string | string[])));
          }
        } else if (out.output_type === "error") {
          const tb = Array.isArray(out.traceback) ? out.traceback.join("\n") : "";
          pending.push(nbCap(`${out.ename ?? "Error"}: ${out.evalue ?? ""}${tb ? "\n" + tb : ""}`));
        }
      }
    }
  });
  flush();
  return blocks;
}

/** A rendered notebook as a result: plain text when it holds no image, else the blocks plus a text rendering. */
async function notebookResult(parts: RawResultPart[], ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const result = await resultBlocksForModel(parts, { readsImages: ctx.modelReadsImages !== false, workRoot: () => imagePrepWorkRoot(ctx), ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) });
  return result.hasImage ? { output: result.text, blocks: result.blocks } : { output: result.text };
}

// --- PDFs ----------------------------------------------------------------------------------------
//
// See the RESULT SHAPE note at the top of this file: this is a METADATA-and-contract-surface
// implementation, not a content-stream text extractor, and it returns TEXT.

const PDF_RANGE_MAX_PAGES = 20;

// Best-effort page count: counts `/Type /Page` dictionary markers, excluding `/Type /Pages` (the
// page-TREE node, not a leaf page) via the trailing `\b` -- "Page" immediately followed by the "s"
// of "Pages" is still one word, so `\b` never matches between them (verified). Zero matches means
// "unknown," not "zero pages" -- this regex finds nothing on PDFs whose page objects live inside
// compressed object streams (PDF 1.5+ xref streams; common output of Chrome/LibreOffice/modern
// LaTeX toolchains) since their `/Type /Page` bytes are themselves Flate-compressed and invisible
// to a raw byte scan. Callers MUST treat `undefined` as "can't validate against a real page count,"
// never as zero.
export function countPdfPages(bytes: Buffer): number | undefined {
  const text = bytes.toString("latin1"); // 1:1 byte decode -- safe for scanning raw PDF syntax
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches && matches.length > 0 ? matches.length : undefined;
}

function parsePageRangeArg(pagesStr: string, totalPages: number | undefined): { start: number; end: number } | { error: string } {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(pagesStr);
  if (!m) return { error: `invalid pages "${pagesStr}" -- expected a page number or range like "1-5"` };
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (start < 1 || end < start) return { error: `invalid pages "${pagesStr}" -- expected a page number or range like "1-5"` };
  if (totalPages !== undefined && end > totalPages) {
    return { error: `pages "${pagesStr}" is out of range -- this PDF has ${totalPages} page${totalPages === 1 ? "" : "s"}` };
  }
  if (end - start + 1 > PDF_RANGE_MAX_PAGES) {
    return { error: `pages "${pagesStr}" spans ${end - start + 1} pages -- max ${PDF_RANGE_MAX_PAGES} pages per request` };
  }
  return { start, end };
}

function readPdf(target: string, st: Stats, pagesStr: string | undefined, usedWindow: boolean, ctx: ToolExecutionContext): ToolResultPayload {
  const bytes = readFileSync(target);
  const totalPages = countPdfPages(bytes);

  let requestedPages: { start: number; end: number } | undefined;
  if (pagesStr !== undefined) {
    const parsed = parsePageRangeArg(pagesStr, totalPages);
    if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };
    requestedPages = parsed;
  }

  // `complete` is true only for a genuine whole-document read -- `pages` was never given AND no
  // other windowing field (offset/limit, nonsensical for a PDF but not schema-rejected) was either.
  ctx.readState.recordRead(target, { complete: !usedWindow && requestedPages === undefined, mtimeMs: st.mtimeMs });
  const pageNote = totalPages !== undefined ? `${totalPages} page${totalPages === 1 ? "" : "s"}` : "page count unknown";
  const asked = requestedPages !== undefined ? `; pages ${requestedPages.start}-${requestedPages.end} requested` : "";
  return {
    output:
      `[PDF: ${target} (${st.size} bytes, ${pageNote}${asked})]\n` +
      "The Read tool does not extract a PDF's text or render its pages, so the document's content is not shown here. " +
      "To read it, extract the text with a shell command, for example `pdftotext -layout <file> -` (poppler) if it is installed.",
  };
}

// --- Dispatch ------------------------------------------------------------------------------------

const IMAGE_EXTS = new Set(Object.keys(IMAGE_MIME));

async function execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: ReadInput;
  try {
    input = parseInput(rawInput);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  // Fix round 10, item B: trim FIRST, matching claude's own `ht` -- see write.ts's identical comment.
  const target = resolve(ctx.cwd, input.file_path.trim());
  let st: Stats;
  try {
    st = statSync(target);
  } catch {
    return { output: `Error: file not found: ${input.file_path}`, isError: true };
  }
  if (st.isDirectory()) {
    return { output: `Error: ${input.file_path} is a directory -- Read cannot read a directory`, isError: true };
  }

  const usedWindow = input.offset !== undefined || input.limit !== undefined || input.pages !== undefined;
  const ext = extname(target).toLowerCase();

  try {
    if (IMAGE_EXTS.has(ext)) return await readImage(target, st, usedWindow, ctx);
    if (ext === ".pdf") return readPdf(target, st, input.pages, usedWindow, ctx);
    if (ext === ".ipynb") {
      const rendered = renderNotebookParts(readFileSync(target, "utf8"));
      if (rendered !== undefined) {
        // Same literal, carve-out-free rule as images/PDFs above -- see readImage's own comment.
        ctx.readState.recordRead(target, { complete: !usedWindow, mtimeMs: st.mtimeMs });
        return await notebookResult(rendered, ctx);
      }
      // malformed JSON / no `cells` array -- fall through to plain text below.
    }
    return readPlainText(target, st, input, usedWindow, ctx);
  } catch (e) {
    return { output: `Error reading ${input.file_path}: ${(e as Error).message}`, isError: true };
  }
}

const readExecutor: ToolExecutor = { execute };

// RULING P3-F (fix round 1): extractPaths returns the RAW input-derived string, UNRESOLVED -- no
// process.cwd() baked in here anymore (retiring this file's own original placeholder, flagged in
// task-4-report.md and confirmed by the controller as a fix-round item). This seam's signature
// (registry.ts's RegisteredTool.extractPaths -- the T11-carry approvals-paths axis; unconsumed
// anywhere yet, verified before writing this) is `(input) => {reads, writes}` with NO ctx/cwd
// parameter, so a relative `file_path` cannot be resolved against the real per-session cwd from
// inside this function at all -- the eventual CONSUMER resolves each candidate against its own
// session ctx.cwd (the seam-level contract itself lands at T8).
function extractReadPaths(input: unknown): ExtractedPaths {
  if (typeof input !== "object" || input === null) return emptyPathSet();
  const filePath = (input as Record<string, unknown>)["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) return emptyPathSet();
  return { reads: [filePath], writes: [] };
}

replaceExecutor("Read", readExecutor, extractReadPaths);

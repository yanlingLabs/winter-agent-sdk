// WS-06 §3.1 "Read" -- the real executor (Phase 3, Lane A / Task 4). Registers over the stub
// descriptors/read.ts already put in the registry (see registry.ts's own header: "every later
// lane's REAL executor lives in a SIBLING tools/impl/*.ts file that imports replaceExecutor").
//
// *** T8 SCHEMA-SWEEP NOTE (flag in task-4-report.md) ***
// WS-06 §3.1 pins Read's INPUT shape verbatim (`{file_path, offset?, limit?, pages?}`) but only
// describes the RESULT in prose ("text with line windowing; images/notebooks/PDFs render as
// type-specific blocks"). Two things are NOT pinned by any spec or seam at this phase:
//   1. `ToolResultPayload.output` (registry.ts, frozen -- Lane A may not touch it) is a bare
//      STRING. There is no image/document wire channel anywhere in the P3 engine (engine.ts's own
//      `ContentBlock` union has no image/document variant yet -- confirmed by inspection). A
//      non-text result is therefore carried as a JSON-encoded envelope inside that string:
//        { "winterReadBlocks": ReadBlock[] }
//      A plain-text read NEVER uses this envelope -- it returns bare text, so a text file whose
//      own content happens to be JSON is never confused with the envelope (the envelope has a
//      distinctive top-level key no ordinary text read would produce). This is a genuinely new,
//      Winter-invented shape -- a future phase (T8, or whichever task wires a real multi-part
//      tool_result) is expected to parse this envelope and splice real content blocks onto the
//      wire; until then it is honest, inspectable text.
//   2. PDF content: full content-stream text extraction (inflating FlateDecode streams and
//      tokenizing Tj/TJ operators) was deliberately NOT attempted -- advisor-reviewed judgment
//      call. It is a large, high-risk, library-shaped problem ("lightweight parsing you write
//      yourself" in the task brief blesses METADATA extraction, not a PDF content-stream
//      tokenizer). What ships instead: the full contract surface (pages parsing/validation,
//      the 20-page span cap, a whole-vs-paged size threshold, correct errors) plus a `pdf`-typed
//      block carrying real metadata (byte size, best-effort page count) and, when the document is
//      small enough to attach in full, the raw base64 bytes for native provider handling -- with
//      an honest `note` field admitting text is not extracted. This mirrors how Anthropic's own
//      Messages API models a PDF (a base64 document block the model reads natively), rather than
//      Norma's own `unpdf`-based approach (packages/core/src/agent/tools/fs-read.ts), which is an
//      npm dependency Lane A cannot add (package.json is shared -- R3-5).
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
//   - IMAGE_MAX_BYTES=5MB, PDF_WHOLE_MAX_PAGES=10, PDF_WHOLE_MAX_BYTES_WHEN_UNKNOWN=2MB,
//     NB_OUTPUT_CAP=4000 (per-notebook-output-block character cap, mirrors Norma's own fs-read.ts
//     precedent): invented, documented thresholds -- no pinned values exist anywhere in scope.
//   - Dimension parsing is hand-rolled (no library, per R3-5) for PNG/GIF/BMP/JPEG only; webp/tiff
//     /heic get mime-by-extension with dimensions omitted (not worth a bespoke parser for formats
//     this brittle to hand-roll correctly).
//   - No `sips`/ImageMagick/etc. shell-out (unlike Norma's fs-read.ts): spawning a subprocess for
//     dimensions makes tests nondeterministic/host-dependent, and downscaling is nowhere in the
//     pinned contract -- advisor-reviewed.
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
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
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

// --- The result envelope (see T8 SCHEMA-SWEEP NOTE above) ------------------------------------------

export type ReadBlock =
  | { type: "text"; text: string }
  // I6 (fix wave, P3 close-out): `data` is now OPTIONAL -- see `capOversizedEnvelope` below. A
  // normal (under-cap) image read still always carries `data`; only the interim size-guard path
  // omits it, adding `note` in its place. `note` is otherwise absent on an image block (PDF's own
  // `note` field, by contrast, is unconditional -- a pre-existing, unrelated fact about PDFs, not
  // introduced by this fix).
  | { type: "image"; media_type: string; bytes: number; width?: number; height?: number; data?: string; note?: string }
  | {
      type: "pdf";
      media_type: "application/pdf";
      bytes: number;
      totalPages?: number;
      requestedPages?: { start: number; end: number };
      data?: string;
      note: string;
    };

export interface ReadBlocksEnvelope {
  winterReadBlocks: ReadBlock[];
}

// I6 (fix wave, P3 close-out): the multimodal Read envelope hands the model base64 image/PDF bytes
// as JSON TEXT (up to ~6.7 MB per read for a 5 MB image) -- there is no image/document content-block
// variant anywhere in the P3 engine wire (engine.ts's own ContentBlock union), so `winterReadBlocks`
// is spliced into the provider transcript as a plain tool_result TEXT block. Read.ts's own header
// already defers the REAL fix (a wire content-block variant + engine.ts unwrapping it) to whichever
// later phase grows that (P4 engine/wire, or P5/WS-03's own result content-block types) -- this is
// ONLY the interim guard the review asks for now: when the envelope would exceed MAX_RESULT_CHARS
// (already this file's own text-read cap, reused here rather than inventing a second, unrelated
// threshold), strip `data` from every block that carries one and add a `note` explaining why --
// `bytes`/`width`/`height`/`totalPages`/`requestedPages` stay populated (nothing about the block's
// own METADATA is lost, only the payload). The contract surface (which block TYPES/fields exist)
// stays identical either way -- a consumer that already handles "no data" (a PDF whose own
// `PDF_WHOLE_MAX_BYTES_WHEN_UNKNOWN`/paged-cap branches already produce blocks with no `data` today)
// needs no new code path for an image block that takes the same shape.
function capOversizedEnvelope(blocks: ReadBlock[]): ReadBlock[] {
  const envelopeSize = JSON.stringify({ winterReadBlocks: blocks } satisfies ReadBlocksEnvelope).length;
  if (envelopeSize <= MAX_RESULT_CHARS) return blocks;
  return blocks.map((b) => {
    if (b.type === "text" || b.data === undefined) return b;
    if (b.type === "image") {
      const { data: _data, ...rest } = b;
      return { ...rest, note: "image data omitted: the read envelope exceeded the per-call size cap; re-read with a narrower scope if the raw bytes are needed" };
    }
    // pdf: already carries a `note` field unconditionally -- only strip data, don't clobber a more
    // specific pre-existing note (e.g. "text is not extracted") with this guard's own generic one.
    const { data: _data, ...rest } = b;
    return { ...rest, note: `${b.note} (data additionally omitted here: the read envelope exceeded the per-call size cap)` };
  });
}

function blocksResult(blocks: ReadBlock[]): ToolResultPayload {
  return { output: JSON.stringify({ winterReadBlocks: capOversizedEnvelope(blocks) } satisfies ReadBlocksEnvelope) };
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
  ".heic": "image/heic",
};
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

function u16be(buf: Uint8Array, o: number): number {
  return (buf[o]! << 8) | buf[o + 1]!;
}
function u32be(buf: Uint8Array, o: number): number {
  return ((buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!) >>> 0;
}
function u16le(buf: Uint8Array, o: number): number {
  return buf[o]! | (buf[o + 1]! << 8);
}
function i32le(buf: Uint8Array, o: number): number {
  return buf[o]! | (buf[o + 1]! << 8) | (buf[o + 2]! << 16) | (buf[o + 3]! << 24);
}

export function parsePngDimensions(buf: Uint8Array): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return undefined;
  if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) return undefined; // "IHDR"
  return { width: u32be(buf, 16), height: u32be(buf, 20) };
}

export function parseGifDimensions(buf: Uint8Array): { width: number; height: number } | undefined {
  if (buf.length < 10) return undefined;
  if (buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) return undefined; // "GIF"
  return { width: u16le(buf, 6), height: u16le(buf, 8) };
}

export function parseBmpDimensions(buf: Uint8Array): { width: number; height: number } | undefined {
  if (buf.length < 26) return undefined;
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return undefined; // "BM"
  return { width: i32le(buf, 18), height: Math.abs(i32le(buf, 22)) };
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function parseJpegDimensions(buf: Uint8Array): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined; // SOI
  let pos = 2;
  while (pos + 3 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    let markerPos = pos + 1;
    while (buf[markerPos] === 0xff && markerPos + 1 < buf.length) markerPos++; // skip 0xFF fill bytes
    const marker = buf[markerPos]!;
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI / SOS reached, no SOF seen
    if (marker >= 0xd0 && marker <= 0xd7) {
      pos = markerPos + 1; // RST markers carry no length field
      continue;
    }
    const lenPos = markerPos + 1;
    if (lenPos + 1 >= buf.length) return undefined;
    const segLen = u16be(buf, lenPos);
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (lenPos + 7 > buf.length) return undefined;
      return { height: u16be(buf, lenPos + 3), width: u16be(buf, lenPos + 5) };
    }
    pos = lenPos + segLen; // segLen counts its own 2 bytes -- next marker starts right after
  }
  return undefined;
}

function parseImageDimensions(ext: string, bytes: Uint8Array): { width: number; height: number } | undefined {
  if (ext === ".png") return parsePngDimensions(bytes);
  if (ext === ".gif") return parseGifDimensions(bytes);
  if (ext === ".bmp") return parseBmpDimensions(bytes);
  if (ext === ".jpg" || ext === ".jpeg") return parseJpegDimensions(bytes);
  return undefined; // webp/tiff/heic: mime-by-extension only, dimensions intentionally omitted
}

function buildImageBlock(bytes: Buffer, mediaType: string, dims: { width: number; height: number } | undefined): ReadBlock {
  return {
    type: "image",
    media_type: mediaType,
    bytes: bytes.length,
    ...(dims !== undefined ? { width: dims.width, height: dims.height } : {}),
    data: bytes.toString("base64"),
  };
}

function readImage(target: string, ext: string, st: Stats, usedWindow: boolean, ctx: ToolExecutionContext): ToolResultPayload {
  if (st.size > IMAGE_MAX_BYTES) {
    return { output: `Error: image ${basename(target)} is ${st.size} bytes, exceeding the ${IMAGE_MAX_BYTES}-byte read limit`, isError: true };
  }
  const bytes = readFileSync(target);
  const mediaType = IMAGE_MIME[ext]!;
  const dims = parseImageDimensions(ext, bytes);
  // A whole image is always attached in full -- there is no partial-image concept -- but the
  // brief's own rule is literal and carve-out-free ("a windowed/offset/limit/pages read records
  // complete: false"): a caller that passed offset/limit/pages on an image read (nonsensical, but
  // not rejected -- WS-06 doesn't scope those fields per file type) must not be told it was a
  // trustworthy whole-file read either. Same reasoning applies to notebooks and PDFs below.
  ctx.readState.recordRead(target, { complete: !usedWindow, mtimeMs: st.mtimeMs });
  return blocksResult([buildImageBlock(bytes, mediaType, dims)]);
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

// Renders one notebook into a ReadBlock[]: text is grouped per run of consecutive non-image
// output; a `display_data`/`execute_result` cell carrying an `image/png` output splits the run
// into its own typed image block (so a notebook mixing prose and plot output produces exactly the
// interleaved text/image blocks a real multi-part tool_result would carry). Returns `undefined` on
// malformed JSON / no `cells` array -- the caller falls through to the plain-text path, matching
// Norma's own fs-read.ts precedent (a malformed notebook is just read as text, offset/limit and
// all, not force-fitted into notebook rendering).
function renderNotebookBlocks(raw: string): ReadBlock[] | undefined {
  let nb: NbNotebook;
  try {
    nb = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(nb.cells)) return undefined;

  const blocks: ReadBlock[] = [];
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
          const png = data["image/png"];
          if (typeof png === "string") {
            flush();
            const bytes = Buffer.from(png, "base64");
            blocks.push(buildImageBlock(bytes, "image/png", parsePngDimensions(bytes)));
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

// --- PDFs ----------------------------------------------------------------------------------------
//
// See the T8 SCHEMA-SWEEP NOTE at the top of this file: this is a METADATA-and-contract-surface
// implementation, not a content-stream text extractor.

const PDF_WHOLE_MAX_PAGES = 10;
const PDF_WHOLE_MAX_BYTES_WHEN_UNKNOWN = 2_000_000;
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

function pdfFitsWholeFileBudget(totalPages: number | undefined, byteSize: number): boolean {
  if (totalPages !== undefined) return totalPages <= PDF_WHOLE_MAX_PAGES;
  return byteSize <= PDF_WHOLE_MAX_BYTES_WHEN_UNKNOWN;
}

const PDF_NO_EXTRACTION_NOTE =
  "text content is not extracted at this phase (WS-06 Phase-3 Lane-A schema-sweep) -- raw document bytes are provided for native handling where supported";

function readPdf(target: string, st: Stats, pagesStr: string | undefined, usedWindow: boolean, ctx: ToolExecutionContext): ToolResultPayload {
  const bytes = readFileSync(target);
  const totalPages = countPdfPages(bytes);
  const fits = pdfFitsWholeFileBudget(totalPages, st.size);

  let requestedPages: { start: number; end: number } | undefined;
  if (pagesStr !== undefined) {
    const parsed = parsePageRangeArg(pagesStr, totalPages);
    if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };
    requestedPages = parsed;
  } else if (!fits) {
    const sizeNote = totalPages !== undefined ? `${totalPages} pages` : `${st.size} bytes`;
    return {
      output: `Error: ${basename(target)} is too large to read whole (${sizeNote}) -- pass \`pages\` (e.g. "1-10") to read up to ${PDF_RANGE_MAX_PAGES} pages at a time`,
      isError: true,
    };
  }

  const block: ReadBlock =
    requestedPages !== undefined && !fits
      ? {
          type: "pdf",
          media_type: "application/pdf",
          bytes: st.size,
          ...(totalPages !== undefined ? { totalPages } : {}),
          requestedPages,
          note: `document too large to attach in full -- page-scoped extraction is not implemented in this phase; ${PDF_NO_EXTRACTION_NOTE}`,
        }
      : {
          type: "pdf",
          media_type: "application/pdf",
          bytes: st.size,
          ...(totalPages !== undefined ? { totalPages } : {}),
          ...(requestedPages !== undefined ? { requestedPages } : {}),
          data: bytes.toString("base64"),
          note: PDF_NO_EXTRACTION_NOTE,
        };

  // `complete` is true only for a genuine whole-document read -- `pages` was never given AND no
  // other windowing field (offset/limit, nonsensical for a PDF but not schema-rejected) was either.
  ctx.readState.recordRead(target, { complete: !usedWindow && requestedPages === undefined, mtimeMs: st.mtimeMs });
  return blocksResult([block]);
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

  const target = resolve(ctx.cwd, input.file_path);
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
    if (IMAGE_EXTS.has(ext)) return readImage(target, ext, st, usedWindow, ctx);
    if (ext === ".pdf") return readPdf(target, st, input.pages, usedWindow, ctx);
    if (ext === ".ipynb") {
      const rendered = renderNotebookBlocks(readFileSync(target, "utf8"));
      if (rendered !== undefined) {
        // Same literal, carve-out-free rule as images/PDFs above -- see readImage's own comment.
        ctx.readState.recordRead(target, { complete: !usedWindow, mtimeMs: st.mtimeMs });
        return blocksResult(rendered);
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

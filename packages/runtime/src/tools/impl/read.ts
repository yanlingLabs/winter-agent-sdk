// WS-06 §3.1 "Read" -- the real executor (Phase 3, Lane A / Task 4). Registers over the stub
// descriptors/read.ts already put in the registry (see registry.ts's own header: "every later
// lane's REAL executor lives in a SIBLING tools/impl/*.ts file that imports replaceExecutor").
//
// *** RESULT SHAPE (code-mode images, 2026-09-29) ***
// WS-06 §3.1 pins Read's INPUT shape verbatim (`{file_path, offset?, limit?, pages?}`) and describes the
// RESULT in prose ("text with line windowing; images/notebooks/PDFs render as type-specific blocks").
//   1. A text read returns bare text in `output`, exactly as before.
//   2. An IMAGE read returns real content blocks in `ToolResultPayload.blocks` (registry.ts): one
//      `{type:"image", source:{type:"base64", media_type, data}}` block, claude's own Read shape. The
//      engine writes them as the `tool_result`'s content array, so the model SEES the image on every
//      provider adapter (each adapter carries a tool-result image natively where its API allows it and
//      otherwise right after the tool results -- provider-runtime). `output` holds a one-line text
//      rendering for hooks and logs. The interim `{winterReadBlocks}` JSON envelope this file used to
//      put in `output` (which reached the model as base64 TEXT) is gone.
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
//   - Dimension parsing is hand-rolled (no library, per R3-5) for PNG/GIF/BMP/JPEG/WebP.
//   - No `sips`/ImageMagick/etc. shell-out (unlike Norma's fs-read.ts): spawning a subprocess for
//     conversion or downscaling makes tests nondeterministic/host-dependent. So BMP/TIFF/HEIC -- which
//     no provider accepts as an image -- and an over-size image are REFUSED with a text that says how
//     to convert or shrink it, never sent as something the provider would reject.
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

type ImageBlock = Extract<ToolResultBlock, { type: "image" }>;

/**
 * The exact refusal a model with no image input gets (the host's composer shows the same words). Exported
 * so a host or a test matches it rather than retyping it.
 */
export const MODEL_DOES_NOT_SUPPORT_IMAGES = "The selected model doesn't support images";

function imageBlockOf(bytes: Buffer, mediaType: string): ImageBlock {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } };
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

/** The image types every provider adapter can carry (Anthropic, Bedrock, Gemini and OpenAI all accept exactly these four). */
const DELIVERABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The largest image Read hands a model, in raw bytes: 3.75 MiB, whose base64 is exactly 5 MiB.
 *
 * The strictest per-image limit among the providers Winter drives: "5 MB (base64-encoded) on Amazon
 * Bedrock and Google Cloud" for Claude (https://platform.claude.com/docs/en/build-with-claude/vision,
 * "Request limits"; the Claude API itself takes 10 MB). An image over a provider's limit stays in the
 * conversation and fails EVERY later request, so the cap lives here, before the image enters history,
 * not in an adapter. A host that stages images for Read (code-mode image input) must cap them at this
 * same number, or a staged image would be refused.
 */
export const READ_IMAGE_MAX_BYTES = 3_932_160;

/** The largest width or height any provider accepts: "The maximum dimensions per image are 8000x8000 px" (same page). */
export const READ_IMAGE_MAX_DIMENSION = 8000;

/** What the bytes actually are, from their magic numbers -- never trusting the extension. `undefined` when none matches. */
export function sniffImageType(buf: Uint8Array): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "image/gif";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))) return "image/tiff";
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8]!, buf[9]!, buf[10]!, buf[11]!);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  return undefined;
}

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

/** WebP's canvas size from its VP8 (lossy), VP8L (lossless) or VP8X (extended) header. */
export function parseWebpDimensions(buf: Uint8Array): { width: number; height: number } | undefined {
  if (buf.length < 30 || sniffImageType(buf) !== "image/webp") return undefined;
  const chunk = String.fromCharCode(buf[12]!, buf[13]!, buf[14]!, buf[15]!);
  if (chunk === "VP8 ") {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined; // key-frame start code
    return { width: u16le(buf, 26) & 0x3fff, height: u16le(buf, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return undefined; // lossless signature
    const bits = (buf[21]! | (buf[22]! << 8) | (buf[23]! << 16) | (buf[24]! << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)), height: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) };
  }
  return undefined;
}

function parseImageDimensions(mediaType: string, bytes: Uint8Array): { width: number; height: number } | undefined {
  if (mediaType === "image/png") return parsePngDimensions(bytes);
  if (mediaType === "image/gif") return parseGifDimensions(bytes);
  if (mediaType === "image/bmp") return parseBmpDimensions(bytes);
  if (mediaType === "image/jpeg") return parseJpegDimensions(bytes);
  if (mediaType === "image/webp") return parseWebpDimensions(bytes);
  return undefined;
}

const FORMAT_NAMES: Record<string, string> = { "image/bmp": "BMP", "image/tiff": "TIFF", "image/heic": "HEIC" };

function imageRefusal(text: string): ToolResultPayload {
  return { output: text, isError: true };
}

function readImage(target: string, st: Stats, usedWindow: boolean, ctx: ToolExecutionContext): ToolResultPayload {
  // The gate comes first: a text-only model gets the same answer whatever the file holds.
  if (ctx.modelReadsImages === false) return imageRefusal(`${MODEL_DOES_NOT_SUPPORT_IMAGES}: ${target}`);
  if (st.size > READ_IMAGE_MAX_BYTES) {
    return imageRefusal(
      `Error: image ${target} is ${st.size} bytes, over the ${READ_IMAGE_MAX_BYTES}-byte limit for showing an image to the model. Make a smaller copy first (for example on macOS: sips -Z 2000 "${target}" --out <smaller.png>) and read that.`,
    );
  }
  const bytes = readFileSync(target);
  const mediaType = sniffImageType(bytes);
  if (mediaType === undefined) {
    return imageRefusal(`Error: ${target} does not contain PNG, JPEG, GIF or WebP image data, so it cannot be shown to the model.`);
  }
  if (!DELIVERABLE_IMAGE_TYPES.has(mediaType)) {
    return imageRefusal(
      `Error: ${target} is a ${FORMAT_NAMES[mediaType] ?? mediaType} image, which models cannot read; they accept PNG, JPEG, GIF and WebP. Convert it first (for example on macOS: sips -s format png "${target}" --out <converted.png>) and read the converted file.`,
    );
  }
  const dims = parseImageDimensions(mediaType, bytes);
  if (dims !== undefined && (dims.width > READ_IMAGE_MAX_DIMENSION || dims.height > READ_IMAGE_MAX_DIMENSION)) {
    return imageRefusal(
      `Error: image ${target} is ${dims.width}x${dims.height} px, over the ${READ_IMAGE_MAX_DIMENSION} px limit on either side. Make a smaller copy first (for example on macOS: sips -Z 2000 "${target}" --out <smaller.png>) and read that.`,
    );
  }
  // A whole image is always attached in full -- there is no partial-image concept -- but the
  // brief's own rule is literal and carve-out-free ("a windowed/offset/limit/pages read records
  // complete: false"): a caller that passed offset/limit/pages on an image read (nonsensical, but
  // not rejected -- WS-06 doesn't scope those fields per file type) must not be told it was a
  // trustworthy whole-file read either. Same reasoning applies to notebooks and PDFs below.
  ctx.readState.recordRead(target, { complete: !usedWindow, mtimeMs: st.mtimeMs });
  const size = dims !== undefined ? `, ${dims.width}x${dims.height}` : "";
  return { output: `[image: ${target} (${mediaType}, ${bytes.length} bytes${size})]`, blocks: [imageBlockOf(bytes, mediaType)] };
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

// Renders one notebook into text and image blocks: text is grouped per run of consecutive non-image
// output; a `display_data`/`execute_result` cell carrying an `image/png` output splits the run
// into its own image block (so a notebook mixing prose and plot output produces exactly the
// interleaved text/image blocks a real multi-part tool_result carries). An image the model cannot be
// shown -- a text-only model, a plot over the per-image limits, or plots past the per-read total of
// `READ_IMAGE_MAX_BYTES` -- becomes a one-line text note in its place, never dropped and never base64
// text. Returns `undefined` on
// malformed JSON / no `cells` array -- the caller falls through to the plain-text path, matching
// Norma's own fs-read.ts precedent (a malformed notebook is just read as text, offset/limit and
// all, not force-fitted into notebook rendering).
function renderNotebookBlocks(raw: string, readsImages: boolean): ToolResultBlock[] | undefined {
  let nb: NbNotebook;
  try {
    nb = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(nb.cells)) return undefined;

  const blocks: ToolResultBlock[] = [];
  let imageBytesLeft = READ_IMAGE_MAX_BYTES;
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
            const bytes = Buffer.from(png, "base64");
            const dims = parsePngDimensions(bytes);
            if (!readsImages) {
              pending.push(`[image output omitted: ${MODEL_DOES_NOT_SUPPORT_IMAGES}]`);
            } else if (sniffImageType(bytes) !== "image/png") {
              pending.push("[image output omitted: its image/png data is not a PNG image]");
            } else if (bytes.length > imageBytesLeft || (dims !== undefined && (dims.width > READ_IMAGE_MAX_DIMENSION || dims.height > READ_IMAGE_MAX_DIMENSION))) {
              pending.push(`[image output omitted: over the per-read image limit (${READ_IMAGE_MAX_BYTES} bytes in total, ${READ_IMAGE_MAX_DIMENSION} px per side)]`);
            } else {
              flush();
              imageBytesLeft -= bytes.length;
              blocks.push(imageBlockOf(bytes, "image/png"));
            }
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
function notebookResult(blocks: ToolResultBlock[]): ToolResultPayload {
  const text = blocks.map((b) => (b.type === "text" ? b.text : `[image: ${b.source.media_type}]`)).join("\n");
  return blocks.some((b) => b.type === "image") ? { output: text, blocks } : { output: text };
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
    if (IMAGE_EXTS.has(ext)) return readImage(target, st, usedWindow, ctx);
    if (ext === ".pdf") return readPdf(target, st, input.pages, usedWindow, ctx);
    if (ext === ".ipynb") {
      const rendered = renderNotebookBlocks(readFileSync(target, "utf8"), ctx.modelReadsImages !== false);
      if (rendered !== undefined) {
        // Same literal, carve-out-free rule as images/PDFs above -- see readImage's own comment.
        ctx.readState.recordRead(target, { complete: !usedWindow, mtimeMs: st.mtimeMs });
        return notebookResult(rendered);
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

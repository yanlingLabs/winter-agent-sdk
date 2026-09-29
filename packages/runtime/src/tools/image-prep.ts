// Code-mode images: the ONE place an image is made ready for a model -- the Read tool (an image file, a
// notebook's plot outputs) and an MCP tool's `image` content items both come through here, so the two
// answer the same questions the same way: what the bytes are (sniffed, never the name), whether they
// must be shrunk or converted, and when to refuse.
//
// Side-effect free (no registration): `mcp/lifecycle.ts` imports it as well as `impl/read.ts`, and an
// `impl/*` executor module registers tools at load (`impl-isolation.test.ts`).
//
// Resizing uses macOS's own `/usr/bin/sips` -- the runtime ships for darwin-arm64 only -- spawned as an
// argv (never a shell), reading and writing COPIES in the session temp dir, never the user's file. With
// no `sips` (another platform, a failed run) an image that is already within every limit is sent as it
// is, and anything else is refused with a text that says why.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolResultBlock } from "./registry.ts";

/**
 * The exact refusal a model with no image input gets (the host's composer shows the same words). Exported
 * so a host or a test matches it rather than retyping it.
 */
export const MODEL_DOES_NOT_SUPPORT_IMAGES = "The selected model doesn't support images";

/** The image types every provider adapter can carry (Anthropic, Bedrock, Gemini and OpenAI all accept exactly these four). */
export const DELIVERABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The largest image handed to a model, in raw bytes: 3.75 MiB, whose base64 is exactly 5 MiB.
 *
 * The strictest per-image limit among the providers Winter drives: "5 MB (base64-encoded) on Amazon
 * Bedrock and Google Cloud" for Claude (https://platform.claude.com/docs/en/build-with-claude/vision,
 * "Request limits"; the Claude API itself takes 10 MB). An image over a provider's limit stays in the
 * conversation and fails EVERY later request, so the limit is applied here, before the image enters
 * history, not in an adapter. A SOURCE file may be larger (up to `IMAGE_MAX_INPUT_BYTES`): it is shrunk
 * and, if it must be, re-encoded as JPEG to fit (`prepareImageForModel`).
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

export function parseImageDimensions(mediaType: string, bytes: Uint8Array): { width: number; height: number } | undefined {
  if (mediaType === "image/png") return parsePngDimensions(bytes);
  if (mediaType === "image/gif") return parseGifDimensions(bytes);
  if (mediaType === "image/bmp") return parseBmpDimensions(bytes);
  if (mediaType === "image/jpeg") return parseJpegDimensions(bytes);
  if (mediaType === "image/webp") return parseWebpDimensions(bytes);
  return undefined;
}


/**
 * The long edge an image is shrunk to before a model sees it: 1568 px, the size above which Claude's
 * standard tier downsizes an image anyway ("Resolution and token cost",
 * https://platform.claude.com/docs/en/build-with-claude/vision). Sending more only costs request bytes:
 * the per-request limits (32 MB on the Claude API, 20 MB of inline data on Gemini) fill up after a few
 * full-size screenshots, and past 20 images Anthropic refuses any image over 2000 px. At 1568 none of
 * that is reached by an ordinary session.
 */
export const IMAGE_MAX_LONG_EDGE = 1568;

/** The largest file Read or an MCP result may hand the resizer at all (a guard against absurd inputs, not a provider limit). */
export const IMAGE_MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** The JPEG qualities tried, in order, when an image is still over `READ_IMAGE_MAX_BYTES` after resizing. */
const JPEG_QUALITY_STEPS = [85, 70, 55, 40] as const;

const SIPS_PATH = "/usr/bin/sips";
const SIPS_TIMEOUT_MS = 30_000;

const FORMAT_NAMES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/bmp": "BMP",
  "image/tiff": "TIFF",
  "image/heic": "HEIC",
};

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
};

/** An image ready for a model: the bytes to send, and what happened to them on the way. */
export interface PreparedImage {
  ok: true;
  mediaType: string;
  bytes: Buffer;
  width?: number;
  height?: number;
  /** The source as found. */
  original: { mediaType: string; bytes: number; width?: number; height?: number };
  /** True when the pixels were scaled down. */
  resized: boolean;
  /** Set when the format changed (a conversion, or a JPEG re-encode to fit the byte limit): the quality used for a JPEG. */
  jpegQuality?: number;
}

export type ImagePreparation = PreparedImage | { ok: false; reason: string };

export interface PrepareImageOptions {
  /**
   * Where the working copies go -- the session's own temp dir (a subfolder is made under it). A getter,
   * read only when `sips` actually runs: the session temp root is created lazily (D18), and an image
   * that needs no work must not materialize it.
   */
  tempDir: () => string;
  /** Test seam: the `sips` binary (a missing path simulates a platform without it). Default `/usr/bin/sips`. */
  sipsPath?: string;
  /** Test seam: the byte limit. Default `READ_IMAGE_MAX_BYTES`. */
  maxBytes?: number;
}

/** A short, model-facing description of what happened, e.g. `image/png, 25856 bytes, 1568x1018, resized from 3024x1964`. */
export function describePreparedImage(image: PreparedImage): string {
  const size = image.width !== undefined && image.height !== undefined ? `, ${image.width}x${image.height}` : "";
  const notes: string[] = [];
  if (image.resized && image.original.width !== undefined && image.original.height !== undefined) notes.push(`resized from ${image.original.width}x${image.original.height}`);
  if (image.mediaType !== image.original.mediaType) notes.push(`converted from ${FORMAT_NAMES[image.original.mediaType] ?? image.original.mediaType}`);
  if (image.jpegQuality !== undefined) notes.push(`JPEG quality ${image.jpegQuality}`);
  return `${image.mediaType}, ${image.bytes.length} bytes${size}${notes.length > 0 ? `, ${notes.join(", ")}` : ""}`;
}

function runSips(sips: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(sips, args, { timeout: SIPS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve({ ok: err === null, stdout: String(stdout ?? "") }));
  });
}

/** `sips -g pixelWidth -g pixelHeight` for a format this file cannot parse (TIFF, HEIC, an odd WebP). */
async function sipsDimensions(sips: string, path: string): Promise<{ width: number; height: number } | undefined> {
  const out = await runSips(sips, ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  if (!out.ok) return undefined;
  const width = /pixelWidth:\s*(\d+)/.exec(out.stdout)?.[1];
  const height = /pixelHeight:\s*(\d+)/.exec(out.stdout)?.[1];
  return width !== undefined && height !== undefined ? { width: Number(width), height: Number(height) } : undefined;
}

/**
 * Makes `source` ready for a model, or says why it cannot be.
 *
 * - The type is SNIFFED from the bytes; something that is none of PNG/JPEG/GIF/WebP/BMP/TIFF/HEIC is refused.
 * - An image whose long edge is over `IMAGE_MAX_LONG_EDGE` is scaled down to it (aspect kept).
 * - The format is kept where a provider takes it: PNG stays PNG and JPEG stays JPEG (quality 85 when
 *   re-encoded). `sips` cannot WRITE WebP, and Gemini does not read GIF, so a WebP or GIF that has to be
 *   rewritten becomes PNG (a GIF's first frame). BMP and TIFF, which no provider takes, become PNG; HEIC
 *   (a camera photo) becomes JPEG. A WebP or GIF that needs no rewrite is sent as it is.
 * - Still over `READ_IMAGE_MAX_BYTES`? Re-encoded as JPEG at quality 85, 70, 55, then 40; still over,
 *   refused. Never truncated.
 * - Without `sips`, or when it fails: the image as it is if it is already a deliverable type within the
 *   byte limit and `READ_IMAGE_MAX_DIMENSION`, else a refusal naming the reason.
 */
export async function prepareImageForModel(source: Buffer, opts: PrepareImageOptions): Promise<ImagePreparation> {
  const maxBytes = opts.maxBytes ?? READ_IMAGE_MAX_BYTES;
  const sips = opts.sipsPath ?? SIPS_PATH;
  const mediaType = sniffImageType(source);
  if (mediaType === undefined) return { ok: false, reason: "it does not contain PNG, JPEG, GIF, WebP, BMP, TIFF or HEIC image data" };
  if (source.length > IMAGE_MAX_INPUT_BYTES) return { ok: false, reason: `it is ${source.length} bytes, over the ${IMAGE_MAX_INPUT_BYTES}-byte limit for an image to prepare` };

  let dims = parseImageDimensions(mediaType, source);
  const deliverable = DELIVERABLE_IMAGE_TYPES.has(mediaType);
  const asIs = (): ImagePreparation => ({
    ok: true,
    mediaType,
    bytes: source,
    ...(dims !== undefined ? { width: dims.width, height: dims.height } : {}),
    original: { mediaType, bytes: source.length, ...(dims !== undefined ? { width: dims.width, height: dims.height } : {}) },
    resized: false,
  });
  const withinLimitsAsIs = (): boolean => deliverable && source.length <= maxBytes && (dims === undefined || (dims.width <= READ_IMAGE_MAX_DIMENSION && dims.height <= READ_IMAGE_MAX_DIMENSION));
  const tooLong = (d: { width: number; height: number } | undefined): boolean => d !== undefined && Math.max(d.width, d.height) > IMAGE_MAX_LONG_EDGE;

  // Nothing to do: the common case costs no process.
  if (deliverable && source.length <= maxBytes && dims !== undefined && !tooLong(dims)) return asIs();

  const sipsAvailable = existsSync(sips);
  const unavailable = (why: string): ImagePreparation => {
    if (withinLimitsAsIs()) return asIs();
    if (!deliverable) return { ok: false, reason: `it is a ${FORMAT_NAMES[mediaType] ?? mediaType} image, which models cannot read (they take PNG, JPEG, GIF and WebP), and it could not be converted (${why}); convert it to PNG first` };
    if (source.length > maxBytes) return { ok: false, reason: `it is ${source.length} bytes, over the ${maxBytes}-byte limit for showing an image to the model, and it could not be made smaller (${why}); make a smaller copy first` };
    return { ok: false, reason: `it is ${dims!.width}x${dims!.height} px, over the ${READ_IMAGE_MAX_DIMENSION} px limit on either side, and it could not be made smaller (${why}); make a smaller copy first` };
  };
  if (!sipsAvailable) return unavailable(`${sips} is not available`);

  const work = join(opts.tempDir(), "image-prep");
  const id = randomUUID();
  const input = join(work, `${id}-in.${EXTENSIONS[mediaType] ?? "img"}`);
  const made: string[] = [];
  try {
    mkdirSync(work, { recursive: true, mode: 0o700 });
    writeFileSync(input, source, { mode: 0o600 });
    made.push(input);
    if (dims === undefined) dims = await sipsDimensions(sips, input);

    const resize = tooLong(dims);
    // The format written: kept where a provider takes it and sips can write it (see the doc comment).
    const target: "png" | "jpeg" = mediaType === "image/jpeg" || mediaType === "image/heic" ? "jpeg" : "png";
    const encode = async (format: "png" | "jpeg", quality: number | undefined, from: string): Promise<Buffer | undefined> => {
      const out = join(work, `${id}-${format}${quality ?? ""}.${format === "jpeg" ? "jpg" : "png"}`);
      made.push(out);
      const args = ["-s", "format", format, ...(quality !== undefined ? ["-s", "formatOptions", String(quality)] : []), ...(resize ? ["-Z", String(IMAGE_MAX_LONG_EDGE)] : []), from, "--out", out];
      const run = await runSips(sips, args);
      if (!run.ok || !existsSync(out)) return undefined;
      return readFileSync(out);
    };

    let quality: number | undefined = target === "jpeg" ? JPEG_QUALITY_STEPS[0] : undefined;
    let bytes: Buffer | undefined;
    let outType = target === "jpeg" ? "image/jpeg" : "image/png";
    // Rewrite only when something needs it: a resize, a conversion, or too many bytes.
    if (resize || !deliverable || source.length > maxBytes) {
      bytes = await encode(target, quality, input);
      if (bytes === undefined) return unavailable("sips could not process it");
      if (bytes.length > maxBytes) {
        for (const step of JPEG_QUALITY_STEPS) {
          if (target === "jpeg" && step === JPEG_QUALITY_STEPS[0]) continue; // already tried just above
          const jpeg = await encode("jpeg", step, input);
          if (jpeg === undefined) return unavailable("sips could not process it");
          bytes = jpeg;
          quality = step;
          outType = "image/jpeg";
          if (jpeg.length <= maxBytes) break;
        }
        if (bytes.length > maxBytes) {
          return { ok: false, reason: `even re-encoded as JPEG at quality ${JPEG_QUALITY_STEPS[JPEG_QUALITY_STEPS.length - 1]} it is ${bytes.length} bytes, over the ${maxBytes}-byte limit for showing an image to the model` };
        }
      }
    } else {
      // A deliverable type within the byte limit whose size sips reported as fine.
      return asIs();
    }
    const finalType = sniffImageType(bytes) ?? outType;
    const finalDims = parseImageDimensions(finalType, bytes);
    return {
      ok: true,
      mediaType: finalType,
      bytes,
      ...(finalDims !== undefined ? { width: finalDims.width, height: finalDims.height } : {}),
      original: { mediaType, bytes: source.length, ...(dims !== undefined ? { width: dims.width, height: dims.height } : {}) },
      resized: resize,
      ...(finalType === "image/jpeg" && quality !== undefined ? { jpegQuality: quality } : {}),
    };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : String(err));
  } finally {
    for (const path of made) rmSync(path, { force: true });
  }
}

// --- Multi-part results (a notebook's outputs, an MCP tool's content items) ------------------------------

/** One part of a result before it is made model-ready: text, or an image's raw bytes. */
export type RawResultPart = { type: "text"; text: string } | { type: "image"; bytes: Buffer };

export interface ModelResult {
  /** The model-facing blocks, in order (adjacent text merged). */
  blocks: ToolResultBlock[];
  /** A text rendering of the same result (each image as `[image: …]`) -- for hooks, logs and a text-only reader. */
  text: string;
  /** True when at least one image block survived. */
  hasImage: boolean;
}

/**
 * Makes a mixed text/image result model-ready: every image goes through `prepareImageForModel`, and an
 * image that cannot be shown -- a text-only model (`readsImages: false`), a refusal, or images past the
 * result's total of `maxBytes` -- becomes a one-line `[image omitted: …]` note IN ITS PLACE, never
 * dropped and never base64 text.
 */
export async function resultBlocksForModel(parts: readonly RawResultPart[], opts: PrepareImageOptions & { readsImages: boolean }): Promise<ModelResult> {
  const budget = opts.maxBytes ?? READ_IMAGE_MAX_BYTES;
  let left = budget;
  const blocks: ToolResultBlock[] = [];
  const text: string[] = [];
  const pushText = (value: string): void => {
    text.push(value);
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.type === "text") blocks[blocks.length - 1] = { type: "text", text: `${last.text}\n${value}` };
    else blocks.push({ type: "text", text: value });
  };
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text.length > 0) pushText(part.text);
      continue;
    }
    if (!opts.readsImages) {
      pushText(`[image omitted: ${MODEL_DOES_NOT_SUPPORT_IMAGES}]`);
      continue;
    }
    const prepared = await prepareImageForModel(part.bytes, opts);
    if (!prepared.ok) {
      pushText(`[image omitted: ${prepared.reason}]`);
      continue;
    }
    if (prepared.bytes.length > left) {
      pushText(`[image omitted: the images in this one result are over ${budget} bytes in total]`);
      continue;
    }
    left -= prepared.bytes.length;
    blocks.push({ type: "image", source: { type: "base64", media_type: prepared.mediaType, data: prepared.bytes.toString("base64") } });
    text.push(`[image: ${describePreparedImage(prepared)}]`);
  }
  return { blocks, text: text.join("\n"), hasImage: blocks.some((b) => b.type === "image") };
}

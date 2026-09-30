// Code-mode images: `prepareImageForModel` / `resultBlocksForModel` on REAL images with the REAL
// `/usr/bin/sips` (macOS -- the runtime ships for darwin-arm64 only; skipped elsewhere). Every image is
// generated here: a PNG from raw scanlines (image-test-fixtures.ts), the other formats made from it by
// sips itself.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_MAX_LONG_EDGE,
  IMAGE_MAX_PIXELS,
  gifFrameCount,
  MODEL_DOES_NOT_SUPPORT_IMAGES,
  READ_IMAGE_MAX_BYTES,
  describePreparedImage,
  parseImageDimensions,
  prepareImageForModel,
  resultBlocksForModel,
  sniffImageType,
  type PreparedImage,
} from "./image-prep.ts";
import { realPng } from "./image-test-fixtures.ts";

const HAS_SIPS = existsSync("/usr/bin/sips");

let dir: string;
let tempReads = 0;
const tempDir = (): string => {
  tempReads++;
  return join(dir, "session-tmp");
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "winter-image-prep-"));
  tempReads = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Converts a PNG to another format with sips, for a real source file of that format. */
function convert(png: Buffer, format: "jpeg" | "gif" | "bmp" | "tiff" | "heic", ext: string): Buffer {
  const src = join(dir, `src-${format}.png`);
  const out = join(dir, `src.${ext}`);
  writeFileSync(src, png);
  execFileSync("/usr/bin/sips", ["-s", "format", format, src, "--out", out], { stdio: "ignore" });
  return readFileSync(out);
}

function ok(result: Awaited<ReturnType<typeof prepareImageForModel>>): PreparedImage {
  if (!result.ok) throw new Error(`expected an image, got a refusal: ${result.reason}`);
  return result;
}

function dimsOf(image: PreparedImage): { width: number; height: number } | undefined {
  return parseImageDimensions(image.mediaType, image.bytes);
}

describe("an image that needs no work", () => {
  test("is sent as it is, and sips is never run (the session temp dir is never asked for)", async () => {
    const png = realPng(800, 600);
    const image = ok(await prepareImageForModel(png, { tempDir }));
    expect(image.bytes.equals(png)).toBe(true);
    expect(image.resized).toBe(false);
    expect(describePreparedImage(image)).toBe(`image/png, ${png.length} bytes, 800x600`);
    expect(tempReads).toBe(0);
  });
});

describe.skipIf(!HAS_SIPS)("resizing with the real sips", () => {
  test("a 3024x1964 PNG becomes a 1568x1018 PNG, and the text says so", async () => {
    const image = ok(await prepareImageForModel(realPng(3024, 1964), { tempDir }));
    expect(image.mediaType).toBe("image/png");
    expect(dimsOf(image)).toEqual({ width: 1568, height: 1018 });
    expect(image.resized).toBe(true);
    expect(image.original).toMatchObject({ mediaType: "image/png", width: 3024, height: 1964 });
    expect(describePreparedImage(image)).toBe(`image/png, ${image.bytes.length} bytes, 1568x1018, resized from 3024x1964`);
    // Working copies are removed: no per-call directory is left behind.
    expect(readdirSync(join(dir, "session-tmp"))).toEqual([]);
  });

  test("a portrait image is limited on its long edge (height)", async () => {
    const image = ok(await prepareImageForModel(realPng(1000, 4000), { tempDir }));
    expect(dimsOf(image)).toEqual({ width: 392, height: IMAGE_MAX_LONG_EDGE });
  });

  test("a JPEG stays JPEG (quality 85)", async () => {
    const jpeg = convert(realPng(2400, 1600), "jpeg", "jpg");
    expect(sniffImageType(jpeg)).toBe("image/jpeg");
    const image = ok(await prepareImageForModel(jpeg, { tempDir }));
    expect(image.mediaType).toBe("image/jpeg");
    expect(dimsOf(image)).toEqual({ width: 1568, height: 1045 });
    expect(describePreparedImage(image)).toContain("resized from 2400x1600, JPEG quality 85");
  });

  test("a GIF that must be resized becomes a PNG (first frame; Gemini reads no GIF)", async () => {
    const gif = convert(realPng(2000, 500), "gif", "gif");
    const image = ok(await prepareImageForModel(gif, { tempDir }));
    expect(image.mediaType).toBe("image/png");
    expect(dimsOf(image)).toEqual({ width: 1568, height: 392 });
    expect(describePreparedImage(image)).toContain("resized from 2000x500, converted from GIF");
  });

  test("BMP and TIFF, which no provider takes, are converted to PNG; HEIC to JPEG", async () => {
    const small = realPng(300, 200);
    for (const [format, ext, expected, name] of [
      ["bmp", "bmp", "image/png", "BMP"],
      ["tiff", "tiff", "image/png", "TIFF"],
      ["heic", "heic", "image/jpeg", "HEIC"],
    ] as const) {
      const source = convert(small, format, ext);
      const image = ok(await prepareImageForModel(source, { tempDir }));
      expect(image.mediaType).toBe(expected);
      expect(image.resized).toBe(false);
      expect(dimsOf(image)).toEqual({ width: 300, height: 200 });
      expect(describePreparedImage(image)).toContain(`converted from ${name}`);
    }
  });

  test("still over the byte limit after resizing: re-encoded as JPEG, stepping quality down", async () => {
    // Random pixels do not compress: at 1568x1568 the PNG is ~7.4 MB, over READ_IMAGE_MAX_BYTES.
    const image = ok(await prepareImageForModel(realPng(2000, 2000, { noise: true }), { tempDir }));
    expect(image.mediaType).toBe("image/jpeg");
    expect(image.bytes.length).toBeLessThanOrEqual(READ_IMAGE_MAX_BYTES);
    expect(dimsOf(image)).toEqual({ width: 1568, height: 1568 });
    expect(describePreparedImage(image)).toMatch(/resized from 2000x2000, converted from PNG, JPEG quality (85|70|55|40)$/);
  });

  test("still too big at the lowest JPEG quality: refused with a clear text, never truncated", async () => {
    const result = await prepareImageForModel(realPng(600, 600, { noise: true }), { tempDir, maxBytes: 2000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^even re-encoded as JPEG at quality 40 it is \d+ bytes, over the 2000-byte limit/);
  });

  test("the source buffer's file is never written: sips works on copies in the session temp dir", async () => {
    const userFile = join(dir, "user.png");
    const png = realPng(3000, 3000);
    writeFileSync(userFile, png);
    ok(await prepareImageForModel(readFileSync(userFile), { tempDir }));
    expect(readFileSync(userFile).equals(png)).toBe(true);
  });
});

describe("without sips (another platform, or a failed run)", () => {
  const noSips = { tempDir, sipsPath: join("/nonexistent", "sips") };

  test("an image already within every limit is sent unresized", async () => {
    const png = realPng(3024, 1964);
    const image = ok(await prepareImageForModel(png, noSips));
    expect(image.bytes.equals(png)).toBe(true);
    expect(image.resized).toBe(false);
  });

  test("anything else is refused, saying why", async () => {
    const tooBig = await prepareImageForModel(realPng(10, 10), { ...noSips, maxBytes: 50 });
    expect(tooBig).toEqual({ ok: false, reason: expect.stringContaining("could not be made smaller (/nonexistent/sips is not available)") });
    const bmp = Buffer.concat([Buffer.from("BM", "ascii"), Buffer.alloc(40)]);
    const unconvertible = await prepareImageForModel(bmp, noSips);
    expect(unconvertible).toEqual({ ok: false, reason: expect.stringContaining("it is a BMP image, which models cannot read") });
  });

  test("bytes that are no image at all are refused before anything runs", async () => {
    expect(await prepareImageForModel(Buffer.from("not an image"), { tempDir })).toEqual({ ok: false, reason: "it does not contain PNG, JPEG, GIF, WebP, BMP, TIFF or HEIC image data" });
  });
});

describe("resultBlocksForModel: a mixed text/image result", () => {
  test("text stays text, images become blocks in order, and the text rendering names each image", async () => {
    const png = realPng(40, 30);
    const result = await resultBlocksForModel([{ type: "text", text: "before" }, { type: "image", bytes: png }, { type: "text", text: "after" }], { tempDir, readsImages: true });
    expect(result.hasImage).toBe(true);
    expect(result.blocks).toEqual([
      { type: "text", text: "before" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
      { type: "text", text: "after" },
    ]);
    expect(result.text).toBe(`before\n[image: image/png, ${png.length} bytes, 40x30]\nafter`);
  });

  test("the text-only gate: every image becomes the refusal note, no image block", async () => {
    const result = await resultBlocksForModel([{ type: "image", bytes: realPng(40, 30) }], { tempDir, readsImages: false });
    expect(result.hasImage).toBe(false);
    expect(result.blocks).toEqual([{ type: "text", text: `[image omitted: ${MODEL_DOES_NOT_SUPPORT_IMAGES}]` }]);
  });

  test("images past the result's byte total become a note in place", async () => {
    const png = realPng(40, 30);
    const result = await resultBlocksForModel([{ type: "image", bytes: png }, { type: "image", bytes: png }], { tempDir, readsImages: true, maxBytes: png.length + 10 });
    expect(result.blocks.map((b) => b.type)).toEqual(["image", "text"]);
    expect(result.text).toContain(`[image omitted: the images in this one result are over ${png.length + 10} bytes in total]`);
  });
});

// --- review fixes: decompression bombs, interrupts, planted links, animated GIFs --------------------------

/** A PNG signature + IHDR declaring `width` x `height` -- a few dozen bytes, no pixel data at all. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  return buf;
}

/** A little-endian TIFF header whose first IFD declares `width` x `height` (LONG tags). */
function tiffHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(8 + 2 + 2 * 12 + 4);
  buf.write("II", 0, "ascii");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(2, 8);
  buf.writeUInt16LE(256, 10);
  buf.writeUInt16LE(4, 12);
  buf.writeUInt32LE(1, 14);
  buf.writeUInt32LE(width, 18);
  buf.writeUInt16LE(257, 22);
  buf.writeUInt16LE(4, 24);
  buf.writeUInt32LE(1, 26);
  buf.writeUInt32LE(height, 30);
  return buf;
}

/** A HEIC-branded file carrying one `ispe` box that declares `width` x `height`. */
function heicHeader(width: number, height: number): Buffer {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "ascii"), Buffer.alloc(12)]);
  const ispe = Buffer.alloc(20);
  ispe.writeUInt32BE(20, 0);
  ispe.write("ispe", 4, "ascii");
  ispe.writeUInt32BE(width, 12);
  ispe.writeUInt32BE(height, 16);
  return Buffer.concat([ftyp, ispe]);
}

/** A real GIF89a of `frames` 1x1 frames (a Netscape loop block when animated). */
function gif(frames: number): Buffer {
  const header = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.from([0, 0, 0, 0xff, 0xff, 0xff])]);
  const loop = frames > 1 ? Buffer.concat([Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "ascii"), Buffer.from([3, 1, 0, 0, 0])]) : Buffer.alloc(0);
  const frame = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00]);
  return Buffer.concat([header, loop, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

describe("decompression bombs are refused on the header, before anything decodes them", () => {
  test("a PNG, TIFF and HEIC declaring 40000x40000 px (1600 MP) are refused without running sips", async () => {
    for (const bomb of [pngHeader(40_000, 40_000), tiffHeader(40_000, 40_000), heicHeader(40_000, 40_000)]) {
      const result = await prepareImageForModel(bomb, { tempDir });
      expect(result).toEqual({ ok: false, reason: `it declares 40000x40000 px (1600 megapixels), over the ${IMAGE_MAX_PIXELS / 1_000_000}-megapixel limit for an image to prepare` });
    }
    // The session temp dir -- where sips would work -- was never even asked for.
    expect(tempReads).toBe(0);
  });

  test("a header just under the limit is not a bomb (it goes on to be resized or refused normally)", async () => {
    const result = await prepareImageForModel(pngHeader(10_000, 9_999), { tempDir, sipsPath: "/nonexistent/sips" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("megapixel");
  });

  test.skipIf(!HAS_SIPS)("a TIFF/HEIC whose size cannot be read at all is never decoded", async () => {
    const unreadable = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(64)]);
    const result = await prepareImageForModel(unreadable, { tempDir });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("its pixel size could not be read, so it was not decoded") });
  });
});

describe.skipIf(!HAS_SIPS)("an interrupt stops sips", () => {
  test("with the turn's signal aborted, sips does not run and the refusal says the turn was interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await prepareImageForModel(realPng(2000, 2000, { noise: true }), { tempDir, signal: controller.signal, maxBytes: 1_000_000 });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("the turn was interrupted") });
  });

  test("an abort DURING a run kills it: the call settles promptly, long before sips would finish", async () => {
    const controller = new AbortController();
    // 4000x4000 random pixels: a ~48 MB PNG sips needs a while to decode, scale and re-encode.
    const source = realPng(4000, 4000, { noise: true });
    const uninterrupted = Date.now();
    ok(await prepareImageForModel(source, { tempDir }));
    const fullRunMs = Date.now() - uninterrupted;
    const started = Date.now();
    const pending = prepareImageForModel(source, { tempDir, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("the turn was interrupted") });
    expect(Date.now() - started).toBeLessThan(fullRunMs);
  }, 30_000);
});

describe.skipIf(!HAS_SIPS)("a planted link in the session temp dir is never followed", () => {
  test("links named like the working directory (old and new spellings) are left untouched, and the image is still prepared", async () => {
    const victim = join(dir, "victim");
    mkdirSync(victim);
    mkdirSync(join(dir, "session-tmp"), { recursive: true });
    symlinkSync(victim, join(dir, "session-tmp", "image-prep"));
    symlinkSync(victim, join(dir, "session-tmp", "image-prep-AAAAAA"));
    const image = ok(await prepareImageForModel(realPng(3000, 2000), { tempDir }));
    expect(dimsOf(image)).toEqual({ width: 1568, height: 1045 });
    expect(readdirSync(victim)).toEqual([]);
    // Only the two planted links remain: the call's own fresh directory is gone.
    expect(readdirSync(join(dir, "session-tmp")).sort()).toEqual(["image-prep", "image-prep-AAAAAA"]);
  });
});

describe("GIFs", () => {
  test("gifFrameCount walks the block structure", () => {
    expect(gifFrameCount(gif(1))).toBe(1);
    expect(gifFrameCount(gif(3))).toBe(3);
    expect(gifFrameCount(Buffer.from("GIF89a"))).toBeUndefined();
  });

  test.skipIf(!HAS_SIPS)("EVERY GIF becomes a PNG of its first frame (OpenAI takes no animated GIF, Gemini no GIF at all)", async () => {
    for (const frames of [1, 2]) {
      const image = ok(await prepareImageForModel(gif(frames), { tempDir }));
      expect(image.mediaType).toBe("image/png");
      expect(dimsOf(image)).toEqual({ width: 1, height: 1 });
      expect(describePreparedImage(image)).toContain("converted from GIF");
    }
  });

  test("without sips: a still GIF within the limits goes as it is; an animated one is refused", async () => {
    const still = ok(await prepareImageForModel(gif(1), { tempDir, sipsPath: "/nonexistent/sips" }));
    expect(still.mediaType).toBe("image/gif");
    const animated = await prepareImageForModel(gif(2), { tempDir, sipsPath: "/nonexistent/sips" });
    expect(animated).toEqual({ ok: false, reason: expect.stringContaining("it is an animated GIF (2 frames)") });
  });
});

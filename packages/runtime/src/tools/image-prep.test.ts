// Code-mode images: `prepareImageForModel` / `resultBlocksForModel` on REAL images with the REAL
// `/usr/bin/sips` (macOS -- the runtime ships for darwin-arm64 only; skipped elsewhere). Every image is
// generated here: a PNG from raw scanlines (image-test-fixtures.ts), the other formats made from it by
// sips itself.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_MAX_LONG_EDGE,
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
    // Working copies are removed.
    expect(readdirSync(join(dir, "session-tmp", "image-prep"))).toEqual([]);
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

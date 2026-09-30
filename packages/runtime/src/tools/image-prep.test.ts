// Code-mode images: `prepareImageForModel` / `resultBlocksForModel` on REAL images with the REAL
// `/usr/bin/sips` (macOS -- the runtime ships for darwin-arm64 only; skipped elsewhere). Every image is
// generated here: a PNG from raw scanlines (image-test-fixtures.ts), the other formats made from it by
// sips itself.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_MAX_LONG_EDGE,
  IMAGE_MAX_PIXELS,
  gifFrameCount,
  gifFrameSizes,
  parseGifExtent,
  parseHeicDimensions,
  parseTiffDimensions,
  imagePrepWorkRoot,
  readRegularFileNoFollow,
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
    const image = ok(await prepareImageForModel(png, { workRoot: tempDir }));
    expect(image.bytes.equals(png)).toBe(true);
    expect(image.resized).toBe(false);
    expect(describePreparedImage(image)).toBe(`image/png, ${png.length} bytes, 800x600`);
    expect(tempReads).toBe(0);
  });
});

describe.skipIf(!HAS_SIPS)("resizing with the real sips", () => {
  test("a 3024x1964 PNG becomes a 1568x1018 PNG, and the text says so", async () => {
    const image = ok(await prepareImageForModel(realPng(3024, 1964), { workRoot: tempDir }));
    expect(image.mediaType).toBe("image/png");
    expect(dimsOf(image)).toEqual({ width: 1568, height: 1018 });
    expect(image.resized).toBe(true);
    expect(image.original).toMatchObject({ mediaType: "image/png", width: 3024, height: 1964 });
    expect(describePreparedImage(image)).toBe(`image/png, ${image.bytes.length} bytes, 1568x1018, resized from 3024x1964`);
    // Working copies are removed: no per-call directory is left behind.
    expect(readdirSync(join(dir, "session-tmp"))).toEqual([]);
  });

  test("a portrait image is limited on its long edge (height)", async () => {
    const image = ok(await prepareImageForModel(realPng(1000, 4000), { workRoot: tempDir }));
    expect(dimsOf(image)).toEqual({ width: 392, height: IMAGE_MAX_LONG_EDGE });
  });

  test("a JPEG stays JPEG (quality 85)", async () => {
    const jpeg = convert(realPng(2400, 1600), "jpeg", "jpg");
    expect(sniffImageType(jpeg)).toBe("image/jpeg");
    const image = ok(await prepareImageForModel(jpeg, { workRoot: tempDir }));
    expect(image.mediaType).toBe("image/jpeg");
    expect(dimsOf(image)).toEqual({ width: 1568, height: 1045 });
    expect(describePreparedImage(image)).toContain("resized from 2400x1600, JPEG quality 85");
  });

  test("a GIF that must be resized becomes a PNG (first frame; Gemini reads no GIF)", async () => {
    const gif = convert(realPng(2000, 500), "gif", "gif");
    const image = ok(await prepareImageForModel(gif, { workRoot: tempDir }));
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
      const image = ok(await prepareImageForModel(source, { workRoot: tempDir }));
      expect(image.mediaType).toBe(expected);
      expect(image.resized).toBe(false);
      expect(dimsOf(image)).toEqual({ width: 300, height: 200 });
      expect(describePreparedImage(image)).toContain(`converted from ${name}`);
    }
  });

  test("still over the byte limit after resizing: re-encoded as JPEG, stepping quality down", async () => {
    // Random pixels do not compress: at 1568x1568 the PNG is ~7.4 MB, over READ_IMAGE_MAX_BYTES.
    const image = ok(await prepareImageForModel(realPng(2000, 2000, { noise: true }), { workRoot: tempDir }));
    expect(image.mediaType).toBe("image/jpeg");
    expect(image.bytes.length).toBeLessThanOrEqual(READ_IMAGE_MAX_BYTES);
    expect(dimsOf(image)).toEqual({ width: 1568, height: 1568 });
    expect(describePreparedImage(image)).toMatch(/resized from 2000x2000, converted from PNG, JPEG quality (85|70|55|40)$/);
  });

  test("still too big at the lowest JPEG quality: refused with a clear text, never truncated", async () => {
    const result = await prepareImageForModel(realPng(600, 600, { noise: true }), { workRoot: tempDir, maxBytes: 2000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^even re-encoded as JPEG at quality 40 it is \d+ bytes, over the 2000-byte limit/);
  });

  test("the source buffer's file is never written: sips works on copies in the session temp dir", async () => {
    const userFile = join(dir, "user.png");
    const png = realPng(3000, 3000);
    writeFileSync(userFile, png);
    ok(await prepareImageForModel(readFileSync(userFile), { workRoot: tempDir }));
    expect(readFileSync(userFile).equals(png)).toBe(true);
  });
});

describe("without sips (another platform, or a failed run)", () => {
  const noSips = { workRoot: tempDir, sipsPath: join("/nonexistent", "sips") };

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
    expect(await prepareImageForModel(Buffer.from("not an image"), { workRoot: tempDir })).toEqual({ ok: false, reason: "it does not contain PNG, JPEG, GIF, WebP, BMP, TIFF or HEIC image data" });
  });
});

describe("resultBlocksForModel: a mixed text/image result", () => {
  test("text stays text, images become blocks in order, and the text rendering names each image", async () => {
    const png = realPng(40, 30);
    const result = await resultBlocksForModel([{ type: "text", text: "before" }, { type: "image", bytes: png }, { type: "text", text: "after" }], { workRoot: tempDir, readsImages: true });
    expect(result.hasImage).toBe(true);
    expect(result.blocks).toEqual([
      { type: "text", text: "before" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
      { type: "text", text: "after" },
    ]);
    expect(result.text).toBe(`before\n[image: image/png, ${png.length} bytes, 40x30]\nafter`);
  });

  test("the text-only gate: every image becomes the refusal note, no image block", async () => {
    const result = await resultBlocksForModel([{ type: "image", bytes: realPng(40, 30) }], { workRoot: tempDir, readsImages: false });
    expect(result.hasImage).toBe(false);
    expect(result.blocks).toEqual([{ type: "text", text: `[image omitted: ${MODEL_DOES_NOT_SUPPORT_IMAGES}]` }]);
  });

  test("images past the result's byte total become a note in place", async () => {
    const png = realPng(40, 30);
    const result = await resultBlocksForModel([{ type: "image", bytes: png }, { type: "image", bytes: png }], { workRoot: tempDir, readsImages: true, maxBytes: png.length + 10 });
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
      const result = await prepareImageForModel(bomb, { workRoot: tempDir });
      expect(result).toEqual({ ok: false, reason: `it declares 40000x40000 px (1600 megapixels), over the ${IMAGE_MAX_PIXELS / 1_000_000}-megapixel limit for an image to prepare` });
    }
    // The session temp dir -- where sips would work -- was never even asked for.
    expect(tempReads).toBe(0);
  });

  test("a header just under the limit is not a bomb (it goes on to be resized or refused normally)", async () => {
    const result = await prepareImageForModel(pngHeader(10_000, 9_999), { workRoot: tempDir, sipsPath: "/nonexistent/sips" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("megapixel");
  });

  test.skipIf(!HAS_SIPS)("a TIFF/HEIC whose size cannot be read at all is never decoded", async () => {
    const unreadable = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(64)]);
    const result = await prepareImageForModel(unreadable, { workRoot: tempDir });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("its pixel size could not be read, so it was not decoded") });
  });
});

describe("the pixel check reads every size a decoder would use (second review)", () => {
  test("a GIF whose tiny logical screen fronts a 60000x60000 frame is refused on the FRAME's size", async () => {
    const header = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([1, 0, 1, 0, 0, 0, 0])]);
    const descriptor = Buffer.from([0x2c, 0, 0, 0, 0, 0x60, 0xea, 0x60, 0xea, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]); // 60000x60000 frame
    const bomb = Buffer.concat([header, descriptor]);
    expect(gifFrameSizes(bomb)).toEqual([{ width: 60_000, height: 60_000 }]);
    expect(await prepareImageForModel(bomb, { workRoot: tempDir })).toEqual({ ok: false, reason: expect.stringContaining("declares 60000x60000 px") });
    expect(tempReads).toBe(0);
  });

  test("a TRUNCATED GIF whose huge frame comes before the cut is still refused on that frame (fail closed on what was seen)", async () => {
    const header = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([1, 0, 1, 0, 0, 0, 0])]);
    // A 60000x60000 frame whose data sub-block claims 200 bytes and then the file simply ends.
    const truncated = Buffer.concat([header, Buffer.from([0x2c, 0, 0, 0, 0, 0x60, 0xea, 0x60, 0xea, 0x00, 0x02, 200, 1, 2, 3])]);
    expect(gifFrameSizes(truncated)).toBeUndefined(); // the walk never reached the trailer...
    expect(parseGifExtent(truncated)).toEqual({ width: 60_000, height: 60_000 }); // ...but the frame it saw counts
    expect(await prepareImageForModel(truncated, { workRoot: tempDir })).toEqual({ ok: false, reason: expect.stringContaining("declares 60000x60000 px") });
  });

  test("TIFF: the magic number must be 42, and the FIRST width/height tag wins (libtiff's reading)", () => {
    expect(parseTiffDimensions(tiffHeader(300, 200))).toEqual({ width: 300, height: 200 });
    const wrongMagic = tiffHeader(300, 200);
    wrongMagic.writeUInt16LE(43, 2);
    expect(parseTiffDimensions(wrongMagic)).toBeUndefined();
    // A second, smaller ImageWidth after the first cannot shrink the size the check sees.
    const dup = Buffer.alloc(8 + 2 + 3 * 12 + 4);
    dup.write("II", 0, "ascii");
    dup.writeUInt16LE(42, 2);
    dup.writeUInt32LE(8, 4);
    dup.writeUInt16LE(3, 8);
    const entry = (i: number, tag: number, value: number) => {
      const o = 10 + i * 12;
      dup.writeUInt16LE(tag, o);
      dup.writeUInt16LE(4, o + 2);
      dup.writeUInt32LE(1, o + 4);
      dup.writeUInt32LE(value, o + 8);
    };
    entry(0, 256, 40_000);
    entry(1, 256, 10);
    entry(2, 257, 40_000);
    expect(parseTiffDimensions(dup)).toEqual({ width: 40_000, height: 40_000 });
  });

  test("HEIC: only a well-formed `ispe` box counts -- the four letters inside compressed data do not", () => {
    expect(parseHeicDimensions(heicHeader(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    const noise = Buffer.alloc(64, 7);
    noise.write("ispe", 20, "ascii"); // no size-20 field before it, no zero version/flags after it
    noise.writeUInt32BE(90_000, 28);
    noise.writeUInt32BE(90_000, 32);
    const fake = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "ascii"), Buffer.alloc(12), noise]);
    expect(parseHeicDimensions(fake)).toBeUndefined();
  });

  test("TIFF/HEIC: `sips -g`'s answer counts too, and the LARGER one is the authority", async () => {
    // A stand-in `sips` that reports 40000x40000 for any file (a header parse would say 300x200).
    const fakeSips = join(dir, "fake-sips");
    writeFileSync(fakeSips, "#!/bin/sh\necho '  pixelWidth: 40000'\necho '  pixelHeight: 40000'\n", { mode: 0o755 });
    const result = await prepareImageForModel(tiffHeader(300, 200), { workRoot: tempDir, sipsPath: fakeSips });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("declares 40000x40000 px") });
  });
});

describe.skipIf(!HAS_SIPS)("an interrupt stops sips", () => {
  test("with the turn's signal aborted, sips does not run and the refusal says the turn was interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await prepareImageForModel(realPng(2000, 2000, { noise: true }), { workRoot: tempDir, signal: controller.signal, maxBytes: 1_000_000 });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("the turn was interrupted") });
  });

  test("an abort DURING a run kills it: the call settles promptly, long before sips would finish", async () => {
    const controller = new AbortController();
    // 4000x4000 random pixels: a ~48 MB PNG sips needs a while to decode, scale and re-encode.
    const source = realPng(4000, 4000, { noise: true });
    const uninterrupted = Date.now();
    ok(await prepareImageForModel(source, { workRoot: tempDir }));
    const fullRunMs = Date.now() - uninterrupted;
    const started = Date.now();
    const pending = prepareImageForModel(source, { workRoot: tempDir, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("the turn was interrupted") });
    expect(Date.now() - started).toBeLessThan(fullRunMs);
  }, 30_000);
});

describe("links are never followed", () => {
  test("readRegularFileNoFollow reads a regular file and refuses a symlink -- to a file or to a directory", () => {
    const real = join(dir, "real.png");
    writeFileSync(real, realPng(4, 4));
    expect(readRegularFileNoFollow(real)?.equals(realPng(4, 4))).toBe(true);
    const toFile = join(dir, "out-png.png");
    symlinkSync(real, toFile);
    expect(readRegularFileNoFollow(toFile)).toBeUndefined();
    const toDir = join(dir, "out-dir.png");
    symlinkSync(dir, toDir);
    expect(readRegularFileNoFollow(toDir)).toBeUndefined();
    expect(readRegularFileNoFollow(join(dir, "missing.png"))).toBeUndefined();
  });

  test.skipIf(!HAS_SIPS)("the work happens in a fresh directory under the given root, which is left empty afterwards", async () => {
    const image = ok(await prepareImageForModel(realPng(3000, 2000), { workRoot: tempDir }));
    expect(dimsOf(image)).toEqual({ width: 1568, height: 1045 });
    expect(readdirSync(join(dir, "session-tmp"))).toEqual([]);
  });

  test("imagePrepWorkRoot: the store home, else the winter home -- and NOTHING else: never a guess under the OS home, never the session temp dir", () => {
    expect(imagePrepWorkRoot({ storeHome: "/s", winterHome: "/w" })).toBe("/s/image-prep");
    expect(imagePrepWorkRoot({ winterHome: "/w" })).toBe("/w/image-prep");
    // A context with only the OS home, a brand and a temp dir (what a bare ToolExecutionContext carries):
    // no working directory at all, so nothing can ever land under the real ~/.winter.
    expect(imagePrepWorkRoot({ home: homedir(), brand: { homeDirName: ".winter" }, tempDir: "/tmp/x" } as never)).toBeUndefined();
    expect(imagePrepWorkRoot({})).toBeUndefined();
  });

  test("with no private working directory, nothing is converted: an image within the limits goes as it is, anything else is refused", async () => {
    const png = realPng(3024, 1964);
    expect(ok(await prepareImageForModel(png, { workRoot: () => undefined })).bytes.equals(png)).toBe(true);
    const bmp = Buffer.concat([Buffer.from("BM", "ascii"), Buffer.alloc(40)]);
    const refused = await prepareImageForModel(bmp, { workRoot: () => undefined });
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining("could not be converted") });
    // WHICH reason depends on the platform: `sips` is checked first, so where it exists (macOS) the refusal
    // names the missing working directory; where it does not (the Linux CI runner) it names `sips`.
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining(HAS_SIPS ? "there is no private working directory" : "/usr/bin/sips is not available") });
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
      const image = ok(await prepareImageForModel(gif(frames), { workRoot: tempDir }));
      expect(image.mediaType).toBe("image/png");
      expect(dimsOf(image)).toEqual({ width: 1, height: 1 });
      expect(describePreparedImage(image)).toContain("converted from GIF");
    }
  });

  test("without sips: a still GIF within the limits goes as it is; an animated one is refused", async () => {
    const still = ok(await prepareImageForModel(gif(1), { workRoot: tempDir, sipsPath: "/nonexistent/sips" }));
    expect(still.mediaType).toBe("image/gif");
    const animated = await prepareImageForModel(gif(2), { workRoot: tempDir, sipsPath: "/nonexistent/sips" });
    expect(animated).toEqual({ ok: false, reason: expect.stringContaining("it is an animated GIF (2 frames)") });
  });
});

describe("no test can reach the real winter home (test-home-guard.ts)", () => {
  test("the preload gave this run a temp WINTER_HOME, and the default winter home resolves there -- never under the real ~/.winter", async () => {
    const { resolveWinterHome } = await import("@yanlinglabs/winter-agent-sdk");
    const home = process.env["WINTER_HOME"];
    expect(home).toBeDefined();
    const real = join(homedir(), ".winter");
    expect(home!.startsWith(real)).toBe(false);
    expect(resolveWinterHome().startsWith(real)).toBe(false);
    // And the image working directory, anchored on whatever a session is handed, stays with it.
    expect(imagePrepWorkRoot({ winterHome: resolveWinterHome() })!.startsWith(real)).toBe(false);
  });
});

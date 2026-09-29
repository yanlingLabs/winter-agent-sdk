// Phase 3, Lane A, Task 4 -- Read executor tests. Fixtures live under a fresh mkdtemp tree per test
// (never ~/.winter/~/.norma/~/.claude) so nothing here can collide with, or depend on, real user
// state. `import "./read.ts"` triggers the module's own `replaceExecutor("Read", ...)` side effect,
// permanently upgrading the shared, process-wide registry singleton's "Read" entry for the rest of
// this `bun test` invocation -- exactly the scenario registry.test.ts's own "Fix round 1" comment
// anticipated (its own not-yet-executable assertions deliberately use throwaway names, never "Read").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./read.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { MODEL_DOES_NOT_SUPPORT_IMAGES, READ_IMAGE_MAX_BYTES, countPdfPages, parseWebpDimensions, sniffImageType } from "./read.ts";

function makeCtx(cwd: string): ToolExecutionContext {
  return {
    cwd,
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState({ cwd: process.cwd() }),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: join(cwd, ".tmp"),
    sandboxSettings: {},
    session: {
      setCwd() {},
      addBoundedRoot() {}, removeBoundedRoot() {},
      setPermissionMode() {},
      getBoundedRoots: () => [],
      getPermissionMode: () => "default",
      getSessionRoot: () => cwd,
      setSessionRoot() {},
    },
  };
}

async function runRead(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("Read");
  if (!tool?.executor) throw new Error("Read executor is not registered");
  return tool.executor.execute(input, ctx);
}

/** The one image block an image Read returns (claude's own `tool_result` image shape). */
function soleImage(result: ToolResultPayload): { media_type: string; data: string } {
  expect(result.blocks).toHaveLength(1);
  const block = result.blocks![0]!;
  if (block.type !== "image") throw new Error(`expected an image block, got ${block.type}`);
  expect(block.source.type).toBe("base64");
  return { media_type: block.source.media_type, data: block.source.data };
}

// --- Fixture builders for the hand-rolled image parsers ---------------------------------------------

function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const iendLen = Buffer.alloc(4);
  return Buffer.concat([sig, ihdrLen, Buffer.from("IHDR"), ihdrData, Buffer.alloc(4), iendLen, Buffer.from("IEND"), Buffer.alloc(4)]);
}

function makeGif(width: number, height: number): Buffer {
  const header = Buffer.from("GIF89a", "ascii");
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(width, 0);
  dims.writeUInt16LE(height, 2);
  return Buffer.concat([header, dims, Buffer.from([0, 0, 0])]);
}

function makeBmp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(26);
  buf.write("BM", 0, "ascii");
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

function makeWebp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

function makeJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0Payload = Buffer.alloc(14);
  const app0Len = Buffer.alloc(2);
  app0Len.writeUInt16BE(2 + app0Payload.length, 0);
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), app0Len, app0Payload]);
  const sofPayload = Buffer.alloc(6);
  sofPayload[0] = 8;
  sofPayload.writeUInt16BE(height, 1);
  sofPayload.writeUInt16BE(width, 3);
  sofPayload[5] = 1;
  const sofLen = Buffer.alloc(2);
  sofLen.writeUInt16BE(2 + sofPayload.length, 0);
  const sof0 = Buffer.concat([Buffer.from([0xff, 0xc0]), sofLen, sofPayload]);
  return Buffer.concat([soi, app0, sof0]);
}

function makePdfBytes(opts: { pageCount?: number; paddingBytes?: number }): Buffer {
  const header = "%PDF-1.4\n";
  let body = "";
  if (opts.pageCount !== undefined) {
    body += "1 0 obj\n<< /Type /Pages /Count " + opts.pageCount + " >>\nendobj\n";
    for (let i = 0; i < opts.pageCount; i++) {
      body += `${i + 2} 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n`;
    }
  }
  body += "trailer\n<< /Root 1 0 R >>\n%%EOF\n";
  let bytes = header + body;
  if (opts.paddingBytes !== undefined && opts.paddingBytes > bytes.length) {
    bytes += "A".repeat(opts.paddingBytes - bytes.length);
  }
  return Buffer.from(bytes, "latin1");
}

describe("Read (Phase 3, Lane A, Task 4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winter-read-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("plain text", () => {
    test("reads a whole small file verbatim and records a COMPLETE read", async () => {
      const p = join(dir, "a.txt");
      writeFileSync(p, "line1\nline2\nline3");
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.output).toBe("line1\nline2\nline3");
      expect(ctx.readState.lookup(p)).toEqual({ complete: true, mtimeMs: expect.any(Number) as unknown as number });
    });

    test("a relative file_path resolves against ctx.cwd, and readState is keyed by the resolved absolute path", async () => {
      writeFileSync(join(dir, "rel.txt"), "hello");
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: "rel.txt" }, ctx);
      expect(result.output).toBe("hello");
      expect(ctx.readState.lookup(join(dir, "rel.txt"))?.complete).toBe(true);
    });

    // Fix round 10, item B: claude's own `ht` trims a path argument before resolving it -- "the
    // check and the write must never disagree" (permissions/paths.ts's `resolveTargetPath` gets the
    // identical fix). A model-supplied `file_path` with surrounding whitespace reads the TRIMMED
    // path, and readState is keyed by that same trimmed, resolved path.
    test("fix round 10, item B: a file_path with surrounding whitespace is trimmed before resolution", async () => {
      writeFileSync(join(dir, "rel.txt"), "hello");
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: "  rel.txt  " }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.output).toBe("hello");
      expect(ctx.readState.lookup(join(dir, "rel.txt"))?.complete).toBe(true);
    });

    test("oversized whole-file read returns a PARTIAL view continuable with offset, and records complete:false", async () => {
      const p = join(dir, "big.txt");
      const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`);
      writeFileSync(p, lines.join("\n"));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.output).toContain("line1\n");
      expect(result.output).toContain("line2000");
      expect(result.output).not.toContain("line2001\n");
      expect(result.output).toContain("PARTIAL");
      expect(result.output).toContain("offset=2001");
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });

    test("continuing with the returned offset reads the remainder and does NOT re-flag PARTIAL once EOF is reached", async () => {
      const p = join(dir, "big2.txt");
      const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`);
      writeFileSync(p, lines.join("\n"));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, offset: 2001 }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.output).toContain("line2001");
      expect(result.output).toContain("line2500");
      expect(result.output).not.toContain("PARTIAL");
      // windowed (offset given) -> complete is false per the brief's literal, conservative rule,
      // even though this particular window happened to reach EOF.
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });

    test("an explicitly bounded range that still cannot fit errors instead of silently truncating", async () => {
      const p = join(dir, "wide.txt");
      const wideLines = Array.from({ length: 200 }, () => "x".repeat(2000)); // 200 * 2000 = 400,000 chars
      writeFileSync(p, wideLines.join("\n"));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, offset: 1, limit: 100 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("exceeding");
      expect(ctx.readState.lookup(p)).toBeUndefined(); // an error path never records a read
    });

    test("limit narrower than the default window returns exactly that many lines and records complete:false", async () => {
      const p = join(dir, "small.txt");
      writeFileSync(p, "a\nb\nc\nd\ne");
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, limit: 2 }, ctx);
      expect(result.output).toBe("a\nb");
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });

    test("a line longer than the truncate length is cut with a marker", async () => {
      const p = join(dir, "longline.txt");
      writeFileSync(p, "y".repeat(2500));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.output).toContain("…[line truncated]");
      expect(result.output).toContain("truncated]");
    });

    test("offset beyond the file's line count errors", async () => {
      const p = join(dir, "short.txt");
      writeFileSync(p, "only one line");
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, offset: 50 }, ctx);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("beyond");
    });

    test("a nonexistent file errors and never throws", async () => {
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: join(dir, "nope.txt") }, ctx);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });

    test("reading a directory is an error", async () => {
      mkdirSync(join(dir, "subdir"));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: join(dir, "subdir") }, ctx);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("directory");
    });

    test("input validation: missing file_path errors without throwing", async () => {
      const ctx = makeCtx(dir);
      const result = await runRead({}, ctx);
      expect(result.isError).toBe(true);
    });
  });

  describe("images", () => {
    test("a PNG comes back as a real image block (not text), with a text rendering in `output`, and records complete:true", async () => {
      const p = join(dir, "pic.png");
      writeFileSync(p, makePng(64, 48));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.isError).toBeUndefined();
      const image = soleImage(result);
      expect(image.media_type).toBe("image/png");
      expect(Buffer.from(image.data, "base64").equals(makePng(64, 48))).toBe(true);
      // `output` is the text channel (hooks, logs): it names the file and never carries base64.
      expect(result.output).toBe(`[image: ${p} (image/png, ${makePng(64, 48).length} bytes, 64x48)]`);
      expect(result.output).not.toContain(image.data);
      expect(result.output).not.toContain("winterReadBlocks");
      expect(ctx.readState.lookup(p)?.complete).toBe(true);
    });

    test("a 1 MB image is attached whole -- there is no envelope size guard any more", async () => {
      const p = join(dir, "big.png");
      const oneMbPng = Buffer.concat([makePng(64, 48), Buffer.alloc(1_000_000)]);
      writeFileSync(p, oneMbPng);
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
      expect(Buffer.from(soleImage(result).data, "base64").length).toBe(oneMbPng.length);
    });

    test("GIF, JPEG and WebP each ride with the media type their BYTES say", async () => {
      const cases: Array<[string, Buffer, string, string]> = [
        ["pic.gif", makeGif(10, 20), "image/gif", "10x20"],
        ["pic.jpg", makeJpeg(800, 600), "image/jpeg", "800x600"],
        ["pic.jpeg", makeJpeg(8, 6), "image/jpeg", "8x6"],
        ["pic.webp", makeWebp(300, 200), "image/webp", "300x200"],
      ];
      for (const [name, bytes, type, dims] of cases) {
        const p = join(dir, name);
        writeFileSync(p, bytes);
        const result = await runRead({ file_path: p }, makeCtx(dir));
        expect(result.isError).toBeUndefined();
        expect(soleImage(result).media_type).toBe(type);
        expect(result.output).toContain(dims);
      }
    });

    test("a misnamed image is sent as what it IS (a JPEG saved as .png is image/jpeg)", async () => {
      const p = join(dir, "actually-jpeg.png");
      writeFileSync(p, makeJpeg(4, 4));
      expect(soleImage(await runRead({ file_path: p }, makeCtx(dir))).media_type).toBe("image/jpeg");
    });

    test("BMP, TIFF and HEIC are refused with a text saying how to convert -- no provider takes them as images", async () => {
      const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0]);
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "ascii"), Buffer.alloc(16)]);
      for (const [name, bytes, format] of [["pic.bmp", makeBmp(33, 77), "BMP"], ["pic.tiff", tiff, "TIFF"], ["pic.heic", heic, "HEIC"]] as const) {
        const p = join(dir, name);
        writeFileSync(p, bytes);
        const result = await runRead({ file_path: p }, makeCtx(dir));
        expect(result.isError).toBe(true);
        expect(result.blocks).toBeUndefined();
        expect(result.output).toContain(`is a ${format} image`);
        expect(result.output).toContain("PNG, JPEG, GIF and WebP");
        expect(result.output).toContain("sips -s format png");
      }
    });

    test("an image-named file with no image data is refused, never sent as garbage", async () => {
      const p = join(dir, "junk.webp");
      writeFileSync(p, Buffer.from([0, 1, 2, 3, 4]));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.blocks).toBeUndefined();
      expect(result.output).toContain("does not contain PNG, JPEG, GIF or WebP image data");
    });

    test("an image over READ_IMAGE_MAX_BYTES (3.75 MiB, base64 5 MiB) is refused; one exactly at it is attached", async () => {
      expect(READ_IMAGE_MAX_BYTES).toBe(3_932_160);
      expect(Buffer.alloc(READ_IMAGE_MAX_BYTES).toString("base64").length).toBe(5 * 1024 * 1024);
      const over = join(dir, "huge.png");
      writeFileSync(over, Buffer.concat([makePng(10, 10), Buffer.alloc(READ_IMAGE_MAX_BYTES)]));
      const refused = await runRead({ file_path: over }, makeCtx(dir));
      expect(refused.isError).toBe(true);
      expect(refused.blocks).toBeUndefined();
      expect(refused.output).toContain(`over the ${READ_IMAGE_MAX_BYTES}-byte limit`);
      const at = join(dir, "at-cap.png");
      const atBytes = Buffer.concat([makePng(10, 10), Buffer.alloc(READ_IMAGE_MAX_BYTES - makePng(10, 10).length)]);
      writeFileSync(at, atBytes);
      expect(Buffer.from(soleImage(await runRead({ file_path: at }, makeCtx(dir))).data, "base64").length).toBe(READ_IMAGE_MAX_BYTES);
    });

    test("an image wider or taller than 8000 px is refused", async () => {
      const p = join(dir, "wide.png");
      writeFileSync(p, makePng(8001, 10));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("8001x10 px, over the 8000 px limit");
    });

    test("a stray offset on an image read still records complete:false (no per-type carve-out)", async () => {
      const p = join(dir, "pic2.png");
      writeFileSync(p, makePng(1, 1));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, offset: 3 }, ctx);
      expect(result.isError).toBeUndefined();
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });

    test("THE GATE: on a model that reads no images, an image Read is a short text refusal naming the path -- never base64", async () => {
      const p = join(dir, "gated.png");
      writeFileSync(p, makePng(64, 48));
      const ctx = { ...makeCtx(dir), modelReadsImages: false };
      const result = await runRead({ file_path: p }, ctx);
      expect(result.isError).toBe(true);
      expect(result.blocks).toBeUndefined();
      expect(result.output).toBe(`${MODEL_DOES_NOT_SUPPORT_IMAGES}: ${p}`);
      expect(MODEL_DOES_NOT_SUPPORT_IMAGES).toBe("The selected model doesn't support images");
      expect(result.output).not.toContain(makePng(64, 48).toString("base64"));
      // An explicit `true` (and an absent value, above) delivers the image.
      expect(soleImage(await runRead({ file_path: p }, { ...makeCtx(dir), modelReadsImages: true })).media_type).toBe("image/png");
    });

    test("sniffImageType and parseWebpDimensions read the magic numbers, not the name", () => {
      expect(sniffImageType(makePng(1, 1))).toBe("image/png");
      expect(sniffImageType(makeJpeg(1, 1))).toBe("image/jpeg");
      expect(sniffImageType(makeGif(1, 1))).toBe("image/gif");
      expect(sniffImageType(makeWebp(1, 1))).toBe("image/webp");
      expect(sniffImageType(makeBmp(1, 1))).toBe("image/bmp");
      expect(sniffImageType(Buffer.from("hello world!"))).toBeUndefined();
      expect(parseWebpDimensions(makeWebp(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    });
  });

  describe("notebooks", () => {
    test("a notebook with no image output is plain text (no blocks)", async () => {
      const p = join(dir, "nb.ipynb");
      const nb = { cells: [{ cell_type: "markdown", source: ["# Title"] }, { cell_type: "code", source: "print(1)", outputs: [{ output_type: "stream", text: "1\n" }] }] };
      writeFileSync(p, JSON.stringify(nb));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.blocks).toBeUndefined();
      expect(result.output).toContain("# Title");
      expect(result.output).toContain("print(1)");
      expect(result.output).toContain("1");
      expect(ctx.readState.lookup(p)?.complete).toBe(true);
    });

    test("an image/png output becomes a real image block between the text blocks", async () => {
      const p = join(dir, "nb-img.ipynb");
      const png = makePng(5, 5);
      const nb = {
        cells: [
          { cell_type: "code", source: "plot()", outputs: [{ output_type: "display_data", data: { "image/png": png.toString("base64") } }] },
          { cell_type: "markdown", source: "after" },
        ],
      };
      writeFileSync(p, JSON.stringify(nb));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.blocks?.map((b) => b.type)).toEqual(["text", "image", "text"]);
      const image = result.blocks![1]!;
      if (image.type !== "image") throw new Error("expected image");
      expect(image.source.media_type).toBe("image/png");
      expect(Buffer.from(image.source.data, "base64").equals(png)).toBe(true);
      expect(result.output).toContain("[image: image/png]");
      expect(result.output).not.toContain(png.toString("base64"));
    });

    test("on a model that reads no images, a plot output becomes a note -- the notebook's text still reads", async () => {
      const p = join(dir, "nb-gated.ipynb");
      const nb = { cells: [{ cell_type: "code", source: "plot()", outputs: [{ output_type: "display_data", data: { "image/png": makePng(5, 5).toString("base64") } }] }] };
      writeFileSync(p, JSON.stringify(nb));
      const result = await runRead({ file_path: p }, { ...makeCtx(dir), modelReadsImages: false });
      expect(result.isError).toBeUndefined();
      expect(result.blocks).toBeUndefined();
      expect(result.output).toContain("plot()");
      expect(result.output).toContain(`[image output omitted: ${MODEL_DOES_NOT_SUPPORT_IMAGES}]`);
    });

    test("a stray offset on a notebook read still records complete:false (no per-type carve-out)", async () => {
      const p = join(dir, "nb2.ipynb");
      writeFileSync(p, JSON.stringify({ cells: [{ cell_type: "code", source: "x" }] }));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, offset: 2 }, ctx);
      expect(result.isError).toBeUndefined();
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });

    test("a malformed notebook falls through to the plain-text path", async () => {
      const p = join(dir, "bad.ipynb");
      writeFileSync(p, "{not valid json");
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
      expect(result.output).toBe("{not valid json");
    });
  });

  describe("PDFs", () => {
    test("a PDF read is honest METADATA TEXT -- never the raw bytes as base64 -- and records complete:true", async () => {
      const p = join(dir, "small.pdf");
      const bytes = makePdfBytes({ pageCount: 3 });
      writeFileSync(p, bytes);
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.blocks).toBeUndefined();
      expect(result.output).toContain(`[PDF: ${p} (${bytes.length} bytes, 3 pages)]`);
      expect(result.output).toContain("content is not shown here");
      expect(result.output).not.toContain(bytes.toString("base64"));
      expect(ctx.readState.lookup(p)?.complete).toBe(true);
    });

    test("page-count heuristic excludes /Type /Pages (the tree node), counting only leaf /Type /Page", () => {
      const bytes = makePdfBytes({ pageCount: 7 });
      expect(countPdfPages(bytes)).toBe(7);
    });

    test("a PDF with no recognizable /Type /Page bytes reports an unknown (undefined) page count", () => {
      const bytes = Buffer.from("%PDF-1.4\n<compressed object stream, unreadable to a raw byte scan>\n%%EOF", "latin1");
      expect(countPdfPages(bytes)).toBeUndefined();
    });

    test("a valid `pages` range is named in the metadata and records complete:false", async () => {
      const p = join(dir, "big2.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 15 }));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, pages: "10-15" }, ctx);
      expect(result.isError).toBeUndefined();
      expect(result.output).toContain("15 pages; pages 10-15 requested");
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });

    test("`pages` naming an out-of-range page errors, naming the real total", async () => {
      const p = join(dir, "big4.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 15 }));
      const result = await runRead({ file_path: p, pages: "5-30" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("out of range");
      expect(result.output).toContain("15 page");
    });

    test("`pages` spanning more than 20 pages errors even when the total page count is unknown", async () => {
      const p = join(dir, "unknown-huge.pdf");
      writeFileSync(p, Buffer.from("%PDF-1.4\n" + "A".repeat(3_000_000), "latin1"));
      const result = await runRead({ file_path: p, pages: "1-25" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("max 20 pages");
    });

    test("an invalid `pages` string errors", async () => {
      const p = join(dir, "small2.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 2 }));
      const result = await runRead({ file_path: p, pages: "abc" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid pages");
    });

    test("unknown page count says so", async () => {
      const p = join(dir, "unknown-small.pdf");
      writeFileSync(p, Buffer.from("%PDF-1.4\n" + "A".repeat(1000), "latin1"));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
      expect(result.output).toContain("page count unknown");
    });

    test("a stray offset on a whole-document PDF read still records complete:false (no per-type carve-out)", async () => {
      const p = join(dir, "small3.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 2 }));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, offset: 1 }, ctx);
      expect(result.isError).toBeUndefined();
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });
  });

  describe("extractPaths seam (RULING P3-F, fix round 1: raw passthrough, no cwd resolution)", () => {
    test("is registered and reports the RAW file_path as a read", () => {
      const tool = getRegisteredTool("Read");
      expect(tool?.extractPaths).toBeDefined();
      const extracted = tool!.extractPaths!({ file_path: "/some/file.txt" });
      expect(extracted.reads).toEqual(["/some/file.txt"]);
      expect(extracted.writes).toEqual([]);
    });

    test("a RELATIVE file_path is returned unresolved -- never joined against process.cwd() or anything else", () => {
      const tool = getRegisteredTool("Read");
      const extracted = tool!.extractPaths!({ file_path: "relative/file.txt" });
      expect(extracted.reads).toEqual(["relative/file.txt"]);
    });

    test("never throws on a shapeless input, and reports no candidates", () => {
      const tool = getRegisteredTool("Read");
      expect(() => tool!.extractPaths!({})).not.toThrow();
      expect(() => tool!.extractPaths!(null)).not.toThrow();
      expect(tool!.extractPaths!({})).toEqual({ reads: [], writes: [] });
    });
  });
});

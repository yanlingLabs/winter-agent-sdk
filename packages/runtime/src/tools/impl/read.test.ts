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
import { countPdfPages, type ReadBlock, type ReadBlocksEnvelope } from "./read.ts";

function makeCtx(cwd: string): ToolExecutionContext {
  return {
    cwd,
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: join(cwd, ".tmp"),
    sandboxSettings: {},
    session: {
      setCwd() {},
      addBoundedRoot() {},
      setPermissionMode() {},
      getBoundedRoots: () => [],
    },
  };
}

async function runRead(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("Read");
  if (!tool?.executor) throw new Error("Read executor is not registered");
  return tool.executor.execute(input, ctx);
}

function envelope(result: ToolResultPayload): ReadBlocksEnvelope {
  return JSON.parse(result.output) as ReadBlocksEnvelope;
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
    test("a PNG renders as a typed image block with parsed dimensions and records complete:true", async () => {
      const p = join(dir, "pic.png");
      writeFileSync(p, makePng(64, 48));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.isError).toBeUndefined();
      const env = envelope(result);
      expect(env.winterReadBlocks).toHaveLength(1);
      const block = env.winterReadBlocks[0] as Extract<ReadBlock, { type: "image" }>;
      expect(block.type).toBe("image");
      expect(block.media_type).toBe("image/png");
      expect(block.width).toBe(64);
      expect(block.height).toBe(48);
      expect(typeof block.data).toBe("string");
      expect(Buffer.from(block.data, "base64").equals(makePng(64, 48))).toBe(true);
      expect(ctx.readState.lookup(p)?.complete).toBe(true);
    });

    test("a GIF's dimensions parse correctly", async () => {
      const p = join(dir, "pic.gif");
      writeFileSync(p, makeGif(10, 20));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      const block = envelope(result).winterReadBlocks[0] as Extract<ReadBlock, { type: "image" }>;
      expect(block.media_type).toBe("image/gif");
      expect(block.width).toBe(10);
      expect(block.height).toBe(20);
    });

    test("a BMP's dimensions parse correctly", async () => {
      const p = join(dir, "pic.bmp");
      writeFileSync(p, makeBmp(33, 77));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      const block = envelope(result).winterReadBlocks[0] as Extract<ReadBlock, { type: "image" }>;
      expect(block.media_type).toBe("image/bmp");
      expect(block.width).toBe(33);
      expect(block.height).toBe(77);
    });

    test("a JPEG's dimensions parse correctly via the SOF0 marker walk", async () => {
      const p = join(dir, "pic.jpg");
      writeFileSync(p, makeJpeg(800, 600));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      const block = envelope(result).winterReadBlocks[0] as Extract<ReadBlock, { type: "image" }>;
      expect(block.media_type).toBe("image/jpeg");
      expect(block.width).toBe(800);
      expect(block.height).toBe(600);
    });

    test("webp gets mime-by-extension with dimensions intentionally omitted", async () => {
      const p = join(dir, "pic.webp");
      writeFileSync(p, Buffer.from([0, 1, 2, 3, 4]));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      const block = envelope(result).winterReadBlocks[0] as Extract<ReadBlock, { type: "image" }>;
      expect(block.media_type).toBe("image/webp");
      expect(block.width).toBeUndefined();
      expect(block.height).toBeUndefined();
    });

    test("an oversized image errors instead of attaching", async () => {
      const p = join(dir, "huge.png");
      writeFileSync(p, Buffer.alloc(6 * 1024 * 1024));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("exceeding");
    });

    test("a stray offset on an image read still records complete:false (no per-type carve-out)", async () => {
      const p = join(dir, "pic2.png");
      writeFileSync(p, makePng(1, 1));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, offset: 3 }, ctx);
      expect(result.isError).toBeUndefined();
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });
  });

  describe("notebooks", () => {
    test("renders cells as text blocks", async () => {
      const p = join(dir, "nb.ipynb");
      const nb = { cells: [{ cell_type: "markdown", source: ["# Title"] }, { cell_type: "code", source: "print(1)", outputs: [{ output_type: "stream", text: "1\n" }] }] };
      writeFileSync(p, JSON.stringify(nb));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      const env = envelope(result);
      const allText = env.winterReadBlocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      expect(allText).toContain("# Title");
      expect(allText).toContain("print(1)");
      expect(allText).toContain("1");
      expect(ctx.readState.lookup(p)?.complete).toBe(true);
    });

    test("an image/png output splits into its own typed image block", async () => {
      const p = join(dir, "nb-img.ipynb");
      const pngB64 = makePng(5, 5).toString("base64");
      const nb = {
        cells: [{ cell_type: "code", source: "plot()", outputs: [{ output_type: "display_data", data: { "image/png": pngB64 } }] }],
      };
      writeFileSync(p, JSON.stringify(nb));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      const env = envelope(result);
      const imageBlocks = env.winterReadBlocks.filter((b): b is Extract<ReadBlock, { type: "image" }> => b.type === "image");
      expect(imageBlocks).toHaveLength(1);
      expect(imageBlocks[0]?.media_type).toBe("image/png");
      expect(imageBlocks[0]?.width).toBe(5);
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
    test("a small PDF (<=10 pages) with no `pages` embeds full data and records complete:true", async () => {
      const p = join(dir, "small.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 3 }));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.isError).toBeUndefined();
      const block = envelope(result).winterReadBlocks[0] as Extract<ReadBlock, { type: "pdf" }>;
      expect(block.type).toBe("pdf");
      expect(block.totalPages).toBe(3);
      expect(typeof block.data).toBe("string");
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

    test("an oversized PDF (page count known, over budget) with no `pages` errors, naming the real total", async () => {
      const p = join(dir, "big.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 15 }));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("15 pages");
      expect(result.output).toContain("pages");
    });

    test("the same oversized PDF with a valid `pages` range returns a metadata-only block (no `data`), complete:false", async () => {
      const p = join(dir, "big2.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 15 }));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, pages: "1-5" }, ctx);
      expect(result.isError).toBeUndefined();
      const block = envelope(result).winterReadBlocks[0] as Extract<ReadBlock, { type: "pdf" }>;
      expect(block.requestedPages).toEqual({ start: 1, end: 5 });
      expect(block.data).toBeUndefined();
      expect(block.note).toContain("too large to attach in full");
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });

    // Fix round 1 (MINOR): this test's title previously said "errors" while its body asserts the
    // opposite (a legal range) -- corrected to describe what it actually proves: a `pages` range
    // whose END lands EXACTLY on the real total is a legal boundary case, not an off-by-one error,
    // distinguishing it from the very next test ("naming an out-of-range page errors"), which pushes
    // one page past that same boundary.
    test("`pages` reaching exactly the last page is legal (boundary case, not an off-by-one error)", async () => {
      const p = join(dir, "big3.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 15 }));
      const result = await runRead({ file_path: p, pages: "10-15" }, makeCtx(dir));
      expect(result.isError).toBeUndefined(); // 10-15 is within 15 total AND within the 20-span cap
      const block = envelope(result).winterReadBlocks[0] as Extract<ReadBlock, { type: "pdf" }>;
      expect(block.requestedPages).toEqual({ start: 10, end: 15 });
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

    test("unknown page count, small file, no `pages`: falls back to the byte-size budget and embeds data", async () => {
      const p = join(dir, "unknown-small.pdf");
      writeFileSync(p, Buffer.from("%PDF-1.4\n" + "A".repeat(1000), "latin1"));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p }, ctx);
      expect(result.isError).toBeUndefined();
      const block = envelope(result).winterReadBlocks[0] as Extract<ReadBlock, { type: "pdf" }>;
      expect(block.totalPages).toBeUndefined();
      expect(typeof block.data).toBe("string");
      expect(ctx.readState.lookup(p)?.complete).toBe(true);
    });

    test("a stray offset on a whole-document PDF read still records complete:false (no per-type carve-out)", async () => {
      const p = join(dir, "small3.pdf");
      writeFileSync(p, makePdfBytes({ pageCount: 2 }));
      const ctx = makeCtx(dir);
      const result = await runRead({ file_path: p, offset: 1 }, ctx);
      expect(result.isError).toBeUndefined();
      expect(ctx.readState.lookup(p)?.complete).toBe(false);
    });

    test("unknown page count, large file, no `pages`: errors naming the byte size", async () => {
      const p = join(dir, "unknown-large.pdf");
      writeFileSync(p, Buffer.from("%PDF-1.4\n" + "A".repeat(2_100_000), "latin1"));
      const result = await runRead({ file_path: p }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("bytes");
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

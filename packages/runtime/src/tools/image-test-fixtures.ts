// Test fixtures for code-mode images: REAL image files, generated in-process (no binary fixtures in
// the repo). A PNG is built from raw RGB scanlines with zlib; the other formats are made from it with
// macOS's own `sips` by the tests that need them. Test-only -- nothing in the runtime imports this.
import { deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * A real, decodable 8-bit RGB PNG of `width` x `height`. `noise: true` fills it with random pixels (it
 * does not compress, so it is large); otherwise a repeating gradient (tiny once compressed).
 */
export function realPng(width: number, height: number, opts: { noise?: boolean } = {}): Buffer {
  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  const gradient = Buffer.alloc(rowBytes);
  for (let i = 0; i < rowBytes; i++) gradient[i] = (i * 7) % 256;
  for (let y = 0; y < height; y++) {
    const offset = y * (rowBytes + 1);
    raw[offset] = 0; // filter: none
    (opts.noise === true ? randomBytes(rowBytes) : gradient).copy(raw, offset + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

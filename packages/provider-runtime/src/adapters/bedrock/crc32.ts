// CRC-32/ISO-HDLC, hand-rolled. Lane N (Task 9, R6-16).
//
// WHY A HAND-ROLLED ONE. Global Constraints: zero new runtime dependencies. AWS's event-stream
// framing checks the frame prelude and the whole message with this exact CRC, and Bun exposes no
// CRC-32 primitive (`Bun.hash` is a different family entirely), so the choice is between fifteen
// lines here and a dependency this phase has already refused to take on.
//
// WHICH CRC-32, stated precisely, because "CRC32" names about a dozen incompatible functions: the
// reflected IEEE 802.3 polynomial `0xEDB88320`, initial value `0xFFFFFFFF`, final XOR `0xFFFFFFFF`,
// input and output reflected. That is the one `zlib.crc32` computes and the one AWS's event-stream
// spec names. The check value for `"123456789"` is `0xCBF43926` — the standard's own published
// constant — and `crc32.test.ts` pins it alongside four more vectors taken from Python's `zlib`,
// which is a DIFFERENT implementation and therefore a real oracle rather than a restatement of this
// file.
//
// The table is built ONCE, lazily. Eagerly building it would run 256 x 8 iterations at module load
// for a process that may never speak to Bedrock at all; building it per call would run them per
// FRAME, and a streaming turn is thousands of frames.

const POLYNOMIAL = 0xedb88320;

let table: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (table !== undefined) return table;
  const built = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      // `>>> 1` and not `>> 1`: the value is a 32-bit UNSIGNED accumulator, and an arithmetic shift
      // would sign-extend every entry whose high bit is set — half of them.
      c = (c & 1) !== 0 ? POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    built[n] = c >>> 0;
  }
  table = built;
  return built;
}

/**
 * The CRC-32 of `bytes`, as an unsigned 32-bit number.
 *
 * `seed` carries a running CRC so a message can be checksummed across the buffers it arrived in
 * without concatenating them first — which matters here because an event-stream frame's message CRC
 * covers everything before it, and that span is routinely megabytes for an image-bearing turn.
 * Passing a previous result back in continues the same computation exactly.
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  const t = crcTable();
  // The seed arrives POST-final-XOR (it is a previous `crc32` result), so it is un-XORed back into
  // the running form here and re-XORed on the way out. Without that round trip a chained call would
  // silently compute something that is not a CRC of anything.
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Fixture helpers shared by Lane N's two packages. Task 9 (R6-16).
//
// TEST-ONLY, and structurally so: nothing in the shipped runtime imports this module. It lives in
// `provider-runtime` rather than in a `.test.ts` because BOTH packages need it — the adapter's own
// fixtures and the conformance fake build the same frames — and the dependency runs
// conformance -> provider-runtime, never the reverse (Lane A took the same shape for the same
// reason).
//
// THE ENCODER HERE IS NOT THE DECODER'S MIRROR IMAGE FOR TEST PURPOSES. A round-trip through one
// author's encoder and the same author's decoder proves consistency and nothing else — a wrong CRC
// polynomial, a wrong endianness, or a wrong prelude span would all round-trip perfectly. So
// `eventstream.test.ts` pins the BYTES this encoder produces against a reference frame built by
// Python's `struct` + `zlib.crc32` (a genuinely different implementation), and only then uses the
// encoder for the scenarios where writing 148 hex bytes by hand would obscure what is being tested.

import { crc32 } from "./crc32.ts";
import { buildCanonicalRequest, buildStringToSign, computeSignature, parseAuthorization, sha256Hex } from "./sigv4.ts";

/** One header to encode. Only the string type is offered: it is the only type Bedrock's own frames use, and a fixture that needed another would be testing the decoder rather than the adapter. */
export interface EventStreamHeaderInput {
  name: string;
  value: string;
}

/** Encodes one header: `1-byte name length | name | type 7 | 2-byte value length | value`. */
function encodeHeader(header: EventStreamHeaderInput): Uint8Array {
  const encoder = new TextEncoder();
  const name = encoder.encode(header.name);
  const value = encoder.encode(header.value);
  const out = new Uint8Array(1 + name.length + 1 + 2 + value.length);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint8(offset, name.length);
  offset += 1;
  out.set(name, offset);
  offset += name.length;
  view.setUint8(offset, 7);
  offset += 1;
  view.setUint16(offset, value.length);
  offset += 2;
  out.set(value, offset);
  return out;
}

/** Encodes one complete event-stream frame: prelude + prelude CRC + headers + payload + message CRC. */
export function encodeEventStreamMessage(headers: EventStreamHeaderInput[], payload: Uint8Array): Uint8Array {
  const encodedHeaders = headers.map(encodeHeader);
  const headersLength = encodedHeaders.reduce((sum, h) => sum + h.length, 0);
  const totalLength = 16 + headersLength + payload.length;

  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalLength);
  view.setUint32(4, headersLength);
  // The prelude CRC covers the two LENGTH fields only — the first eight bytes, not the twelve-byte
  // prelude that contains this very field.
  view.setUint32(8, crc32(out.subarray(0, 8)));

  let offset = 16 - 4;
  for (const header of encodedHeaders) {
    out.set(header, offset);
    offset += header.length;
  }
  out.set(payload, offset);
  view.setUint32(totalLength - 4, crc32(out.subarray(0, totalLength - 4)));
  return out;
}

/** A ConverseStream `event` frame carrying a JSON payload — the shape every happy-path frame takes. */
export function converseStreamEvent(eventType: string, payload: unknown): Uint8Array {
  return encodeEventStreamMessage(
    [
      { name: ":message-type", value: "event" },
      { name: ":event-type", value: eventType },
      { name: ":content-type", value: "application/json" },
    ],
    new TextEncoder().encode(JSON.stringify(payload)),
  );
}

/** A ConverseStream `exception` frame — how Bedrock reports a failure that begins AFTER the 200 (`ThrottlingException`, `ModelStreamErrorException`, …). */
export function converseStreamException(exceptionType: string, payload: unknown = {}): Uint8Array {
  return encodeEventStreamMessage(
    [
      { name: ":message-type", value: "exception" },
      { name: ":exception-type", value: exceptionType },
      { name: ":content-type", value: "application/json" },
    ],
    new TextEncoder().encode(JSON.stringify(payload)),
  );
}

/** Concatenates frames into one response body. */
export function concatFrames(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

// --- SigV4 verification, for the conformance fake ---------------------------------------------------

/** What the fake's signature check is given: the LIVE request, plus the secret it should verify against. */
export interface VerifySigV4Input {
  method: string;
  /** The absolute request URL, exactly as the server received it. */
  url: string;
  /** The live request headers. MUST come from the `Request`, never from the fake base's recorded copy — that copy redacts `authorization` before a route ever runs. */
  headers: Headers;
  /** The exact request body bytes the server received. */
  body: Uint8Array;
  secretAccessKey: string;
  expectedAccessKeyId?: string;
}

export type SigV4Verdict = { ok: true; accessKeyId: string } | { ok: false; reason: string };

/**
 * Recomputes a request's signature and compares it with the one the client sent.
 *
 * THE CANONICAL REQUEST IS REBUILT FROM THE WIRE, not from any notion of what the adapter meant to
 * send: the header set comes from the `SignedHeaders=` list in the Authorization header, each value
 * is read off the live request, and the payload hash is taken over the bytes the server actually
 * received. That is what makes the check independent of `signRequest` in the way that matters — a
 * signer that forgot a header, signed a stale body, or signed the wrong host produces a signature
 * this function will not reproduce.
 *
 * `x-amz-content-sha256` is additionally checked AGAINST THE BODY, so a client cannot sign a hash of
 * one payload and send another.
 */
export async function verifySigV4(input: VerifySigV4Input): Promise<SigV4Verdict> {
  const parsed = parseAuthorization(input.headers.get("authorization"));
  if (parsed === undefined) return { ok: false, reason: "the request carried no parseable AWS4-HMAC-SHA256 Authorization header" };
  if (input.expectedAccessKeyId !== undefined && parsed.accessKeyId !== input.expectedAccessKeyId) {
    return { ok: false, reason: `the credential names access key "${parsed.accessKeyId}", which this fake does not know` };
  }

  const url = new URL(input.url);
  const headers: Record<string, string> = {};
  for (const name of parsed.signedHeaders) {
    // `host` is never a header `fetch` lets a client set, so it is reconstructed from the URL the
    // server was reached at -- which is exactly the value a correct signer used.
    const value = name === "host" ? url.host : input.headers.get(name);
    if (value === null || value === undefined) return { ok: false, reason: `the signature covers header "${name}", which the request does not carry` };
    headers[name] = value;
  }

  const payloadHash = await sha256Hex(input.body);
  const declaredHash = input.headers.get("x-amz-content-sha256");
  if (declaredHash !== null && declaredHash !== payloadHash) {
    return { ok: false, reason: "x-amz-content-sha256 does not match the body the server received" };
  }

  const stamp = input.headers.get("x-amz-date");
  if (stamp === null) return { ok: false, reason: "the request carried no x-amz-date" };

  const { canonicalRequest } = buildCanonicalRequest({ method: input.method, pathname: url.pathname, search: url.search, headers, payloadHash });
  const scope = `${parsed.datestamp}/${parsed.region}/${parsed.service}/aws4_request`;
  const stringToSign = await buildStringToSign(canonicalRequest, stamp, scope);
  const expected = await computeSignature(input.secretAccessKey, parsed.datestamp, parsed.region, parsed.service, stringToSign);
  if (expected !== parsed.signature) return { ok: false, reason: "the request signature does not match the one this fake computes for it" };
  return { ok: true, accessKeyId: parsed.accessKeyId };
}

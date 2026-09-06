// The Bedrock loopback fake. Lane N (Task 9, R6-16).
//
// ADDED beside `server.ts`, never editing it (R6-12). Everything hermetic about the base applies
// here: `127.0.0.1` on port 0, closed in a `finally` with a deadline, every request recorded before
// a route runs.
//
// THIS FAKE VERIFIES THE SIGNATURE. That is what makes it different from the other families' fakes
// and it is the brief's own requirement: a request whose SigV4 signature does not recompute against
// the test credentials gets a 403 `InvalidSignatureException`, exactly as AWS would. The
// verification rebuilds the canonical request FROM THE WIRE — the header set comes from the
// `SignedHeaders=` list the client sent, each value is read off the live request, and the payload
// hash is taken over the bytes the server received — so a signer that forgot a header, signed a
// stale body or signed the wrong host cannot satisfy it.
//
// TWO TRAPS THIS FILE EXISTS TO AVOID, both of which would make every signature assertion vacuous:
//
//   THE LIVE HEADERS, NOT THE RECORDED ONES. `server.ts` REDACTS `authorization` to its scheme plus
//     `***` as it records a request, which is correct for a request log and useless for verification.
//     Every route here reads `req.headers`, and `recorded.headers` is only ever used for assertions
//     that are about the log.
//
//   THE FAKE ALSO REFUSES. A verifier that only ever said "ok" would pass any signer at all, so
//     `bedrock.test.ts` includes a guard-on-the-guard: a deliberately mis-signed request must come
//     back 403, and the corpus's own signature assertions are only meaningful because it does.
//
// The fake ALSO enforces the two request-shape rules the real service enforces and Winter's message
// union does not — strict user/assistant alternation, and no empty text block — as
// `ValidationException`s. Without them, the adapter's merging and empty-block dropping would be
// asserted against a server that accepts anything.

import {
  concatFrames,
  converseStreamEvent,
  converseStreamException,
  verifySigV4,
} from "../../../provider-runtime/src/adapters/bedrock/testing.ts";
import { parseAuthorization } from "../../../provider-runtime/src/adapters/bedrock/sigv4.ts";
import { jsonResponse, scenarioTable, startFake, type FakeServer, type RecordedRequest, type ScenarioResponder } from "./server.ts";

/** AWS's own published example credentials. They authenticate nothing; the fake knows the secret so it can recompute. */
export const FAKE_ACCESS_KEY_ID = "AKIDEXAMPLE";
export const FAKE_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
export const FAKE_REGION = "us-east-1";

/** The model id a request addressed, read out of the PATH — Bedrock's own placement, unlike the OpenAI and Anthropic families' bodies. */
export function bedrockModelOf(recorded: RecordedRequest): string | undefined {
  const match = /^\/model\/([^/]+)\/converse(?:-stream)?$/.exec(recorded.path);
  if (match === null) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

/** True when the request asked for the STREAMING operation. */
export function isStreamingPath(recorded: RecordedRequest): boolean {
  return recorded.path.endsWith("/converse-stream");
}

export interface EventStreamResponseOptions {
  status?: number;
  /** Milliseconds to wait before writing each frame after the first — the slow-stream primitive. */
  delayMs?: number;
  /** END the stream after this many frames, WITHOUT the terminating `messageStop`: a truncated upstream. */
  dropAfter?: number;
  /**
   * After every frame has been written, HOLD the stream open without closing it — the mid-turn
   * stall. Bounded so it cannot outlive its test, and the timer is cleared on cancel: an
   * unconditional `close()` against a controller the consumer already tore down throws from a bare
   * timer callback, which Bun attributes to whichever test happens to be running (the spine hit
   * exactly this in `stalledResponse` and fixed it the same way).
   */
  holdOpenMs?: number;
  /**
   * Split the whole body into chunks of this many bytes.
   *
   * The only way to prove ON THE WIRE that the decoder survives a frame boundary falling anywhere:
   * a unit test can feed it byte by byte, but only a real socket proves the adapter's read loop
   * feeds it correctly.
   */
  chunkSize?: number;
}

/**
 * An `application/vnd.amazon.eventstream` response built from encoded frames.
 *
 * WRITES ONE FRAME PER PULL, and that is the fix for a defect this file shipped with for one test
 * run: pacing was applied per CHUNK while `chunkSize` defaulted to the whole body, so `delayMs` was
 * dead code and the "slow stream" wrote everything at once. `cancel-mid-stream` passed for the wrong
 * reason — there was no mid-stream to cancel in. Frames are the unit a Bedrock consumer sees, so
 * they are the unit this paces; `chunkSize` splits WITHIN a frame, which is the separate question of
 * whether a decoder survives a frame spanning socket reads.
 */
export function eventStreamResponse(frames: Uint8Array[], opts: EventStreamResponseOptions = {}): Response {
  const kept = opts.dropAfter !== undefined ? frames.slice(0, opts.dropAfter) : frames;
  // Pre-split into the pieces the socket will carry, in order: one entry per frame, or per chunk
  // when a frame is being deliberately fragmented.
  const pieces: Array<{ bytes: Uint8Array; startsFrame: boolean }> = [];
  for (const frame of kept) {
    if (opts.chunkSize === undefined) {
      pieces.push({ bytes: frame, startsFrame: true });
      continue;
    }
    for (let offset = 0; offset < frame.length; offset += opts.chunkSize) {
      pieces.push({ bytes: frame.slice(offset, Math.min(offset + opts.chunkSize, frame.length)), startsFrame: offset === 0 });
    }
  }

  let index = 0;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseHold: (() => void) | undefined;
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      if (index >= pieces.length) {
        if (opts.holdOpenMs !== undefined) {
          // HELD, not closed: the consumer's stall watchdog is expected to fire long before the
          // bound does. One promise, resolved by the bound OR by a cancel -- never a spin of pulls.
          await new Promise<void>((resolve) => {
            releaseHold = resolve;
            holdTimer = setTimeout(resolve, opts.holdOpenMs);
          });
          if (closed) return;
        }
        closed = true;
        controller.close();
        return;
      }
      const piece = pieces[index]!;
      index++;
      if (index > 1 && piece.startsFrame && opts.delayMs !== undefined && opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (closed) return;
      controller.enqueue(piece.bytes);
    },
    cancel() {
      closed = true;
      if (holdTimer !== undefined) clearTimeout(holdTimer);
      releaseHold?.();
    },
  });

  return new Response(body, {
    status: opts.status ?? 200,
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

/** Bedrock's REST-JSON error shape: a bare `{"message"}` body with the code on `x-amzn-errortype`. */
export function bedrockError(status: number, errorType: string, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ message }, status, { "x-amzn-errortype": `${errorType}:http://internal.amazon.com/coral/com.amazon.bedrock/`, ...headers });
}

/** A happy-path ConverseStream body: start, text, stop, metadata. */
export function textTurnFrames(text: string, usage: { inputTokens: number; outputTokens: number } = { inputTokens: 7, outputTokens: 3 }): Uint8Array[] {
  return [
    converseStreamEvent("messageStart", { role: "assistant" }),
    converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text } }),
    converseStreamEvent("contentBlockStop", { contentBlockIndex: 0 }),
    converseStreamEvent("messageStop", { stopReason: "end_turn" }),
    converseStreamEvent("metadata", { usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens }, metrics: { latencyMs: 12 } }),
  ];
}

/** What the fake observed about one request's SIGNATURE. */
export interface RecordedSignature {
  path: string;
  /** The header names the client SIGNED, from the Authorization header's own `SignedHeaders=` list. */
  signedHeaders: string[];
  accessKeyId: string;
  region: string;
  service: string;
  verified: boolean;
}

/**
 * The fake, plus what it saw of each signature.
 *
 * `signatures` exists because `server.ts` REDACTS `authorization` as it records a request — correct
 * for a request log, and it makes "was this header actually signed?" unaskable from `fake.requests`.
 * A test that only checked the header was PRESENT would pass for an adapter that attached it after
 * signing, which real AWS rejects with a 403 naming nothing useful.
 */
export interface BedrockFakeServer extends FakeServer {
  signatures: RecordedSignature[];
}

export interface BedrockFakeOptions {
  /** modelId -> the scripted answer for `/model/<id>/converse[-stream]`. */
  scenarios: Record<string, ScenarioResponder | Response[]>;
  /** The answer to `GET /foundation-models`. Defaults to a two-row inventory. */
  discovery?: ScenarioResponder;
  /** Skips signature verification. ONLY the guard-on-the-guard test sets it, to prove the check is load-bearing. */
  skipSignatureCheck?: boolean;
  /** Skips the request-SHAPE checks (alternation, empty text). Used by the fixture that proves those checks are themselves load-bearing. */
  skipShapeCheck?: boolean;
  secretAccessKey?: string;
}

/** The two shape rules Bedrock enforces that Winter's message union does not. Returns a refusal message, or `undefined` when the body is acceptable. */
function shapeRefusal(bodyText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return "the request body is not valid JSON";
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "messages is required";
  let previous: string | undefined;
  for (const message of messages) {
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") return `a message declares role ${JSON.stringify(role)}; only "user" and "assistant" are accepted`;
    if (role === previous) return `messages must alternate between user and assistant; two consecutive "${role}" messages were sent`;
    previous = role;
    if (!Array.isArray(content) || content.length === 0) return "a message carries no content blocks";
    for (const block of content) {
      if (typeof (block as { text?: unknown }).text === "string" && (block as { text: string }).text.length === 0) return "a text content block is empty";
    }
  }
  return undefined;
}

/**
 * Starts the Bedrock fake.
 *
 * ALWAYS close it in a `finally` — `withFake` from the base does that for you.
 */
export async function startBedrockFake(opts: BedrockFakeOptions): Promise<BedrockFakeServer> {
  const secret = opts.secretAccessKey ?? FAKE_SECRET_ACCESS_KEY;
  const table = scenarioTable({ modelOf: bedrockModelOf, scenarios: opts.scenarios });

  const signatures: RecordedSignature[] = [];

  const checkSignature = async (req: Request, recorded: RecordedRequest): Promise<Response | undefined> => {
    if (opts.skipSignatureCheck === true) return undefined;
    const verdict = await verifySigV4({
      method: recorded.method,
      url: req.url,
      // THE LIVE HEADERS. `recorded.headers` has already had `authorization` redacted.
      headers: req.headers,
      body: new TextEncoder().encode(recorded.body),
      secretAccessKey: secret,
      expectedAccessKeyId: FAKE_ACCESS_KEY_ID,
    });
    const parsed = parseAuthorization(req.headers.get("authorization"));
    if (parsed !== undefined) {
      signatures.push({ path: recorded.path, signedHeaders: parsed.signedHeaders, accessKeyId: parsed.accessKeyId, region: parsed.region, service: parsed.service, verified: verdict.ok });
    }
    if (verdict.ok) return undefined;
    return bedrockError(403, "InvalidSignatureException", `the request signature is invalid: ${verdict.reason}`);
  };

  const fake = await startFake({
    routes: [
      {
        path: "/model/*",
        method: "POST",
        handler: async (req, recorded) => {
          const refusedSignature = await checkSignature(req, recorded);
          if (refusedSignature !== undefined) return refusedSignature;
          if (opts.skipShapeCheck !== true) {
            const refusal = shapeRefusal(recorded.body);
            if (refusal !== undefined) return bedrockError(400, "ValidationException", refusal);
          }
          return await table(req, recorded);
        },
      },
      {
        path: "/foundation-models",
        method: "GET",
        handler: async (req, recorded) => {
          const refusedSignature = await checkSignature(req, recorded);
          if (refusedSignature !== undefined) return refusedSignature;
          if (opts.discovery !== undefined) return await opts.discovery(recorded, 1);
          return jsonResponse({
            modelSummaries: [
              { modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0", modelName: "Claude 3.5 Sonnet v2", inputModalities: ["TEXT", "IMAGE"], responseStreamingSupported: true },
              { modelId: "amazon.titan-text-express-v1", modelName: "Titan Text Express", inputModalities: ["TEXT"], responseStreamingSupported: false },
            ],
          });
        },
      },
    ],
  });
  return Object.assign(fake, { signatures });
}

export { converseStreamEvent, converseStreamException, concatFrames };

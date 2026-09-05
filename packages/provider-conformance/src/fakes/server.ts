// Phase 6 Task 3: the loopback fake-server BASE every adapter lane builds its family fake on.
//
// FROZEN on T3's merge (R6-12). Lanes ADD `fakes/<family>.ts` beside this file and never edit it.
//
// THE GROUND TRUTH FOR WHAT A PROVIDER WAS ASKED IS THE LIVE REQUEST THIS SERVER RECEIVED -- never
// what an adapter believed it sent. That is why `requests` is a first-class part of the return value
// and why every request is logged before a route can decide anything: an assertion written against
// the log is an assertion about the wire.
//
// HERMETICITY IS STRUCTURAL, not a convention a test has to remember:
//   - binds `127.0.0.1` on port 0, so it is unreachable from another machine and cannot collide;
//   - `close()` has an explicit deadline, so a fake that will not stop fails the test rather than
//     hanging the whole runner (Task 2's own finding: an infinitely-pulling loopback fake hangs the
//     RUNNER, not the test -- its event loop keeps pumping into a torn-down connection);
//   - every logged request is REDACTED as it is recorded: credential headers are replaced with their
//     scheme plus `***`, so a request log printed by a failing assertion can never leak a key even
//     when a fixture is careless with one.
import { serve } from "bun";

/** One request the fake received, recorded BEFORE any route ran. */
export interface RecordedRequest {
  method: string;
  /** Path only -- the host is always `127.0.0.1:<ephemeral>` and would make an assertion port-dependent. */
  path: string;
  /** The full URL search string, so a test can assert on query parameters (`api-version`, `key`, …) without re-parsing. */
  search: string;
  /** REDACTED: an `authorization`/`x-api-key`/`api-key` value is replaced with its scheme plus `***`. */
  headers: Record<string, string>;
  /** The raw body text, or `""`. Bodies are NOT redacted: an adapter's own request body is what a serialization assertion is about, and it never carries a credential (every credential rides a header). */
  body: string;
}

export interface FakeRoute {
  /** Matched against the request PATH exactly, or as a prefix when it ends in `*`. */
  path: string;
  method?: string;
  handler: (req: Request, recorded: RecordedRequest) => Response | Promise<Response>;
}

export interface FakeServer {
  /** `http://127.0.0.1:<port>` -- what a `ConnectionProfile.baseUrl` points at. */
  url: string;
  /** Every request received, in order. The ground truth. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export interface StartFakeOptions {
  routes: FakeRoute[];
  /**
   * Answers any path no route matched. Defaults to a 404 whose body names the path -- an explicit
   * failure a test can assert on, rather than a hang or a confusing connection reset.
   */
  fallback?: (req: Request, recorded: RecordedRequest) => Response | Promise<Response>;
  /** How long `close()` waits before reporting the server would not stop. Default 2000 ms. */
  closeDeadlineMs?: number;
}

const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key", "proxy-authorization"]);

/** Renders a header value for the log. A credential header keeps its SCHEME (which is diagnostic) and loses its material. */
function redactHeaderValue(name: string, value: string): string {
  if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) return value;
  const space = value.indexOf(" ");
  return space > 0 ? `${value.slice(0, space)} ***` : "***";
}

/**
 * Starts a loopback fake.
 *
 * ALWAYS close it in a `finally`. A leaked fake keeps a port and an event loop alive for the rest of
 * the process, which is how one careless test makes an unrelated one flaky.
 */
export async function startFake(opts: StartFakeOptions): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const closeDeadlineMs = opts.closeDeadlineMs ?? 2000;

  // Deliberately un-annotated: bun-types generics `Server` over its WebSocket data type, and naming
  // it here would either pin a type this fake never uses or drift with bun-types.
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = redactHeaderValue(name, value);
      });
      // The body is read ONCE, here, and handed to the route on the recorded request: a route that
      // read `req.body` itself would race this recording and one of the two would get nothing.
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      const recorded: RecordedRequest = { method: req.method, path: url.pathname, search: url.search, headers, body };
      requests.push(recorded);

      for (const route of opts.routes) {
        if (route.method !== undefined && route.method !== req.method) continue;
        const matches = route.path.endsWith("*") ? url.pathname.startsWith(route.path.slice(0, -1)) : url.pathname === route.path;
        if (matches) return route.handler(req, recorded);
      }
      if (opts.fallback !== undefined) return opts.fallback(req, recorded);
      return new Response(`no fake route for ${req.method} ${url.pathname}`, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    async close() {
      // `closeActiveConnections: true` is what makes the deadline meaningful: without it a server
      // with an open streaming response waits for the client, and a test that abandoned the stream
      // never gets its port back.
      const stopped = Promise.resolve(server.stop(true));
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), closeDeadlineMs));
      const result = await Promise.race([stopped.then(() => "stopped" as const), timeout]);
      if (result === "timeout") throw new Error(`fake server on port ${server.port} did not stop within ${closeDeadlineMs}ms`);
    },
  };
}

/** Runs `fn` against a fake and ALWAYS closes it. The shape every lane's fixture should use, so a leaked fake is not something anyone has to remember. */
export async function withFake<T>(opts: StartFakeOptions, fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  const fake = await startFake(opts);
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

// --- SSE ------------------------------------------------------------------------------------------

/** One server-sent event as a family fake scripts it. `event` is omitted for a data-only frame. */
export interface SseFrame {
  event?: string;
  data: string;
  /** Milliseconds to wait BEFORE writing this frame -- the primitive behind the slow-stream scenario. */
  delayMs?: number;
}

export interface SseResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  /**
   * END the stream after `dropAfter` frames, WITHOUT the family's terminating event.
   *
   * The mid-stream-drop primitive, and its exact meaning is worth stating because a weaker reading
   * would make it useless. What an SSE adapter can actually observe is "the byte stream ended before
   * the terminator arrived" -- that is the failure a dropped upstream connection produces, and it is
   * what this reproduces. What it deliberately does NOT do is call `controller.error()`: measured
   * against Bun's own client, an errored server-side stream is indistinguishable from a truncated one
   * (`res.text()` returns the frames written so far and does not throw) while ALSO surfacing an
   * unhandled error that fails the runner for the wrong reason. So the primitive gives the honest,
   * observable half, and a scenario asserts on the absent terminator rather than on an exception.
   */
  dropAfter?: number;
}

/**
 * An SSE response from a scripted frame list.
 *
 * FINITE BY CONSTRUCTION, and Task 2 recorded why that matters: an infinitely-pulling loopback fake
 * hangs the RUNNER rather than failing the test, because its own event loop keeps pumping into a
 * torn-down connection. Every stream this helper produces ends -- by running out of frames, or by
 * the deliberate drop.
 */
export function sseResponse(frames: SseFrame[], opts: SseResponseOptions = {}): Response {
  const encoder = new TextEncoder();
  let written = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // NO cancel-guard here, deliberately, and the reasoning is recorded because the obvious
      // symmetry with `stalledResponse` below is WRONG. A guard was added in P6 T3's round 2 by
      // analogy and removed in the re-review after being measured: a `pull` that rejects (or enqueues
      // into a torn-down controller) ERRORS THE STREAM rather than escaping, and for a stream the
      // consumer has already cancelled nothing observes that error -- so the guard changed no
      // outcome, and no test could distinguish its presence from its absence. The `try/catch` that
      // came with it was worse than inert: it would have swallowed a genuine enqueue failure on a
      // LIVE stream.
      //
      // `stalledResponse`'s guard is different in kind and is real: its throw comes from a bare
      // `setTimeout` callback, which has no stream to error into and escapes as an uncaught exception
      // attributed to whichever test happens to be running.
      if (written >= frames.length) {
        controller.close();
        return;
      }
      if (opts.dropAfter !== undefined && written >= opts.dropAfter) {
        // Ends WITHOUT the terminator -- see `dropAfter`'s own doc for why this is a close rather
        // than a `controller.error()`.
        controller.close();
        return;
      }
      const frame = frames[written]!;
      written++;
      if (frame.delayMs !== undefined && frame.delayMs > 0) await new Promise((r) => setTimeout(r, frame.delayMs));
      const prefix = frame.event !== undefined ? `event: ${frame.event}\n` : "";
      controller.enqueue(encoder.encode(`${prefix}data: ${frame.data}\n\n`));
    },
  });
  return new Response(body, {
    status: opts.status ?? 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...(opts.headers ?? {}) },
  });
}

// --- response primitives --------------------------------------------------------------------------

/** A JSON response. */
export function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

/** An error status WITH headers -- the shape a `Retry-After` / `anthropic-ratelimit-*` / `x-ratelimit-*` scenario needs. */
export function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return jsonResponse(body, status, headers);
}

/**
 * A redirect, for the endpoint-policy scenarios.
 *
 * `absolute` is what makes a CROSS-ORIGIN redirect expressible: the policy's own rule is that
 * credentials are never forwarded across an origin change and a redirect carrying a request BODY is
 * refused outright, and neither can be exercised with a same-origin relative `Location`.
 */
export function redirectResponse(location: string, status: 301 | 302 | 307 | 308 = 307): Response {
  return new Response(null, { status, headers: { location } });
}

/**
 * A response that never finishes writing, for the STALL scenario.
 *
 * Bounded by `holdMs` so it cannot outlive the test that started it, whatever the client does. The
 * stall watchdog under test fires long before this does; the bound exists so a BROKEN watchdog fails
 * the test on a timeout it can explain rather than hanging the runner.
 *
 * THE TIMER IS CANCELLED WHEN THE CONSUMER TEARS THE STREAM DOWN, and the reason is worth stating
 * because getting it wrong was a cross-lane defect rather than a local one. A stall scenario ONLY
 * ever ends by the consumer cancelling -- the watchdog fires long before `holdMs` by construction --
 * so the "consumer cancelled first" path is the NORMAL path here, not an edge case. An unconditional
 * `setTimeout(() => controller.close())` then fired against an already-closed controller and threw
 * `TypeError: Invalid state: Controller is already closed` from a bare timer callback, which Bun
 * attributes to WHICHEVER TEST HAPPENS TO BE RUNNING when it lands. It took down this package's own
 * `corpus/runner.test.ts` and unrelated adapter cases in two separate lanes, purely by timing.
 *
 * Belt AND braces, deliberately: `cancel()` clears the timer, and the flag guards the close anyway --
 * a stream can also be errored or closed by a path that never calls `cancel()`, and this helper is
 * frozen spine that six lanes build on.
 */
export function stalledResponse(holdMs = 10_000): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": open\n\n"));
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          controller.close();
        } catch {
          /* the consumer got there first -- nothing to close, and nothing to report */
        }
      }, holdMs);
    },
    cancel() {
      done = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// --- the scripted scenario table --------------------------------------------------------------------

/** One scripted answer, keyed by the MODEL ID the request asked for. */
export type ScenarioResponder = (recorded: RecordedRequest, attempt: number) => Response | Promise<Response>;

export interface ScenarioTableOptions {
  /**
   * Reads the model id out of a request. Family-specific -- OpenAI Responses and Anthropic Messages
   * both put it in the JSON body, Gemini puts it in the PATH -- so each lane supplies its own rather
   * than this base guessing.
   */
  modelOf: (recorded: RecordedRequest) => string | undefined;
  /** modelId -> the scripted answer. A responder receives the 1-based ATTEMPT count for that model, so a retry scenario is a single entry rather than a stateful closure per test. */
  scenarios: Record<string, ScenarioResponder | Response[]>;
  /** Answers a model id with no entry. Defaults to a 400 naming the id -- a loud, assertable failure. */
  unknownModel?: ScenarioResponder;
}

/**
 * Builds a route handler from a MODEL-KEYED table.
 *
 * Keying on the model id is what lets one fake serve a whole corpus: a scenario picks its behaviour
 * by asking for `"stall-model"` or `"retry-then-200"` instead of every case needing its own server,
 * its own port and its own teardown. The ATTEMPT counter is per model, so "529 then 200" is one
 * two-element array rather than a closure a test has to reset.
 */
export function scenarioTable(opts: ScenarioTableOptions): (req: Request, recorded: RecordedRequest) => Response | Promise<Response> {
  const attempts = new Map<string, number>();
  return async (_req, recorded) => {
    const model = opts.modelOf(recorded);
    const attempt = (attempts.get(model ?? "") ?? 0) + 1;
    attempts.set(model ?? "", attempt);
    const entry = model !== undefined ? opts.scenarios[model] : undefined;
    if (entry === undefined) {
      if (opts.unknownModel !== undefined) return opts.unknownModel(recorded, attempt);
      return jsonResponse({ error: { message: `fake: no scenario for model ${JSON.stringify(model)}` } }, 400);
    }
    if (Array.isArray(entry)) {
      // A response is single-use (its body stream is consumed), so a list is indexed by attempt and
      // the LAST entry repeats -- which is what "529 then 200 forever" means.
      const index = Math.min(attempt - 1, entry.length - 1);
      return entry[index]!;
    }
    return entry(recorded, attempt);
  };
}

// --- assertion helpers -------------------------------------------------------------------------------

/** The requests whose path matches, for an assertion that does not want to count a health probe. */
export function requestsTo(fake: FakeServer, path: string): RecordedRequest[] {
  return fake.requests.filter((r) => r.path === path);
}

/**
 * True when NO request the fake received carries `needle` anywhere -- headers or body.
 *
 * The negative every hermeticity and opacity assertion needs: "the marker appeared in no request
 * body" is exactly how capture (H) proved the sidecar was never sent to a model, and the same shape
 * proves an adapter never replayed opaque state across a domain.
 */
export function noRequestContains(fake: FakeServer, needle: string): boolean {
  return !fake.requests.some((r) => r.body.includes(needle) || Object.values(r.headers).some((v) => v.includes(needle)));
}

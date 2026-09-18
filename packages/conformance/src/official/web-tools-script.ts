// Shared plumbing for the WEB-TOOLS differential family (`web-search-differential.test.ts`,
// `web-tool-descriptions-differential.test.ts`, `web-fetch-differential.test.ts`). Same division of
// labour as `task-frames-script.ts` beside it: `differential-harness.ts` owns what is identical across
// EVERY scenario family (binary resolution, mkdtemp roots, the minimal env, the capturing loopback);
// this file owns what only the web tools need -- a one-shot headless driver that returns BOTH the
// loopback's captured requests and the binary's own stdout frames, the SSE builder for an inner
// `web_search_20250305` response (`server_tool_use` / `web_search_tool_result` blocks, which the
// harness's text/tool_use builders do not cover), and the hermeticity guard described below. Each
// test file keeps its own ROUTING and its own assertions.
//
// HERMETICITY. The pinned binary's WebFetch does a preflight GET against a HARDCODED Anthropic host
// (it does not follow `ANTHROPIC_BASE_URL`), so the loopback alone cannot contain it. Two layers:
//   1. the `skipWebFetchPreflight` setting (passed with `--settings`, which `--setting-sources ""`
//      does not switch off) -- the binary reads it immediately before the preflight and skips the
//      call entirely;
//   2. a PROXY TRAP: `HTTPS_PROXY`/`HTTP_PROXY` point at a loopback listener that answers every
//      request `502` and RECORDS its first line, with `NO_PROXY` exempting loopback. Anything the
//      binary tries to send off-box lands in the trap instead of on the network, and every test in
//      this family asserts the trap saw NOTHING. (Measured once while building this: without layer 1
//      the trap records `CONNECT api.anthropic.com:443` and the tool answers "Unable to verify if
//      domain ... is safe to fetch" -- so the trap demonstrably catches what it is there to catch.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeOfficialRoots, cleanupRoots, minimalOfficialEnv, startCapturingLoopback, OFFICIAL_MODEL, type OfficialRoots, type RawFrame, type SseEvent } from "./differential-harness.ts";

// --- the scripted inner-search block sequence, and its mapping onto Winter's event shape -----------

/** One scripted search hit. `extra` rides along on the WIRE only (page_age, encrypted_content, ...) to prove it never survives. */
export interface ScriptedHit {
  title: string;
  url: string;
  extra?: Record<string, unknown>;
}

/**
 * The claude-side block sequence an inner `web_search_20250305` response carries. A `search` is a
 * `server_tool_use` block immediately followed by its `web_search_tool_result` block (hits, or a
 * result-block error).
 */
export type ScriptedSearchBlock = { kind: "text"; text: string } | { kind: "search"; query: string; hits: ScriptedHit[] } | { kind: "search_error"; query: string; errorCode: string };

/** Structurally identical to the runtime's own `WebSearchStreamEvent` (declared here rather than imported so this module stays free of cross-package imports; each test file passes the result straight to the real assembler, so a drift in that type is a compile error THERE). */
export type WinterSearchEvent = { type: "text"; text: string } | { type: "search_result"; hits: Array<{ title: string; url: string }> } | { type: "search_error"; code: string };

/**
 * The SAME scripted sequence in Winter's event shape. Deliberately passes every `extra` field
 * through on the hit objects (as untyped excess properties), so "only title and url survive" is
 * proven on Winter's side by the assembler dropping them, not by this mapper never offering them.
 */
export function toWinterEvents(blocks: readonly ScriptedSearchBlock[]): WinterSearchEvent[] {
  return blocks.map((b): WinterSearchEvent => {
    if (b.kind === "text") return { type: "text", text: b.text };
    if (b.kind === "search_error") return { type: "search_error", code: b.errorCode };
    return { type: "search_result", hits: b.hits.map((h) => ({ ...(h.extra ?? {}), title: h.title, url: h.url })) };
  });
}

/** The inner response as an SSE stream: one content block per text, two per search. */
export function sseInnerSearchTurn(blocks: readonly ScriptedSearchBlock[], model: string = OFFICIAL_MODEL): SseEvent[] {
  const events: SseEvent[] = [
    { event: "message_start", data: { type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } } },
  ];
  let index = 0;
  let searches = 0;
  const open = (content_block: unknown): void => void events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block } });
  const close = (): void => {
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    index++;
  };
  for (const block of blocks) {
    if (block.kind === "text") {
      open({ type: "text", text: "" });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } });
      close();
      continue;
    }
    const id = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    searches++;
    open({ type: "server_tool_use", id, name: "web_search", input: {} });
    events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: block.query }) } } });
    close();
    const content = block.kind === "search_error" ? { type: "web_search_tool_result_error", error_code: block.errorCode } : block.hits.map((h) => ({ type: "web_search_result", title: h.title, url: h.url, ...(h.extra ?? {}) }));
    open({ type: "web_search_tool_result", tool_use_id: id, content });
    close();
  }
  events.push(
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6, server_tool_use: { web_search_requests: searches } } } },
    { event: "message_stop", data: { type: "message_stop" } },
  );
  return events;
}

// --- request classification (shared: every file in this family routes on these) --------------------

export const INNER_SEARCH_USER_PREFIX = "Perform a web search for the query: ";
export const INNER_FETCH_USER_PREFIX = "\nWeb page content:\n";

export function toolsOf(body: RawFrame): RawFrame[] {
  return Array.isArray(body.tools) ? (body.tools as RawFrame[]) : [];
}

/** The inner search call: recognised by the server tool in its tool list, never by position. */
export function isInnerSearchRequest(body: RawFrame): boolean {
  return toolsOf(body).some((t) => t.type === "web_search_20250305");
}

/** The first user message's text, whether the wire carries it as a string or as a one-block array. */
export function firstUserText(body: RawFrame): string {
  const first = (Array.isArray(body.messages) ? (body.messages as RawFrame[]) : [])[0];
  const content = first?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as RawFrame[]).map((b) => (typeof b.text === "string" ? b.text : "")).join("");
  return "";
}

/** The inner digest call: no tools at all, and the page-content template opening the user text. */
export function isInnerFetchRequest(body: RawFrame): boolean {
  return toolsOf(body).length === 0 && firstUserText(body).startsWith(INNER_FETCH_USER_PREFIX);
}

export function hasToolResult(messages: readonly RawFrame[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && (m.content as RawFrame[]).some((b) => b.type === "tool_result"));
}

// --- reading what the binary built ------------------------------------------------------------------

export interface OfficialToolResult {
  /** The tool_result `content` as the binary's own stdout `user` frame carries it -- the tool's PURE output. */
  content: string;
  isError: boolean;
  /** The binary's structured result for the call (`tool_use_result` on the same frame), when it has one. */
  structured: unknown;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as RawFrame[]).map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b))).join("");
  return JSON.stringify(content);
}

/** Every tool_result the binary emitted on stdout, keyed by `tool_use_id` (never by position -- batched calls finish in any order). */
export function toolResultsFromFrames(frames: readonly RawFrame[]): Map<string, OfficialToolResult> {
  const out = new Map<string, OfficialToolResult>();
  for (const frame of frames) {
    if (frame.type !== "user") continue;
    const content = (frame.message as RawFrame | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as RawFrame[]) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      out.set(block.tool_use_id, { content: contentToString(block.content), isError: block.is_error === true, structured: frame.tool_use_result });
    }
  }
  return out;
}

/** Every tool_result in a captured main-loop REQUEST, keyed by `tool_use_id` -- what actually went back to the API. */
export function toolResultsFromRequest(body: RawFrame): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of Array.isArray(body.messages) ? (body.messages as RawFrame[]) : []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as RawFrame[]) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") out.set(block.tool_use_id, contentToString(block.content));
    }
  }
  return out;
}

/**
 * The binary's MAIN LOOP appends a token-budget note to a tool_result on the wire (observed on the
 * last tool_result of a request). It is loop decoration, not part of any tool's own output -- the
 * stdout frame for the same call does not carry it -- so the wire comparison allows exactly this
 * suffix and nothing else.
 */
export const MAIN_LOOP_WIRE_SUFFIX = /^\n\n<system-reminder>\n<total_tokens>\d+ tokens left<\/total_tokens>\n<\/system-reminder>$/;

/** True when `wire` is `pure` exactly, or `pure` plus the one known main-loop suffix. */
export function wireMatchesPure(wire: string, pure: string): boolean {
  if (wire === pure) return true;
  return wire.startsWith(pure) && MAIN_LOOP_WIRE_SUFFIX.test(wire.slice(pure.length));
}

// --- the proxy trap ----------------------------------------------------------------------------------

export interface ProxyTrap {
  url: string;
  /** The first line of every request that reached the trap -- must stay EMPTY for a hermetic run. */
  hits: string[];
  stop(): void;
}

export function startProxyTrap(): ProxyTrap {
  const hits: string[] = [];
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        hits.push(data.toString().split("\r\n")[0] ?? "");
        socket.write("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        socket.end();
      },
    },
  });
  return { url: `http://127.0.0.1:${listener.port}`, hits, stop: () => listener.stop(true) };
}

// --- a throwaway TLS identity for the loopback page server (WebFetch upgrades http -> https) --------

export interface LoopbackTls {
  key: string;
  cert: string;
  certPath: string;
}

/** A self-signed cert for 127.0.0.1, written under `dir` (a mkdtemp root the caller owns). Returns `{reason}` when openssl is unavailable, so the caller can skip plainly rather than fail obscurely. */
export function makeLoopbackTls(dir: string): LoopbackTls | { reason: string } {
  const keyPath = join(dir, "loopback-key.pem");
  const certPath = join(dir, "loopback-cert.pem");
  try {
    const gen = Bun.spawnSync(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdout: "pipe", stderr: "pipe" });
    if (gen.exitCode !== 0) return { reason: `openssl could not mint a loopback certificate: ${gen.stderr.toString().slice(0, 400)}` };
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), certPath };
  } catch (err) {
    return { reason: `openssl could not be run: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- the one-shot headless driver --------------------------------------------------------------------

export interface OfficialRun {
  /** Every POST body the loopback received, in arrival order. */
  requests: RawFrame[];
  /** Every stdout frame the binary emitted. */
  frames: RawFrame[];
  /** First lines of anything that tried to leave the box (see the header) -- asserted empty by every caller. */
  trapHits: string[];
}

export interface OfficialRunOptions {
  binaryPath: string;
  model?: string;
  prompt: string;
  route: (messages: RawFrame[], body: RawFrame, count: number) => Response;
  logPrefix: string;
  /** Extra `--settings` JSON (always merged over `skipWebFetchPreflight: true`). */
  settings?: Record<string, unknown>;
  extraEnv?: Record<string, string>;
  /** Called with the roots before the spawn -- for a caller that needs files under them (a TLS cert). */
  roots?: OfficialRoots;
}

/**
 * One headless `-p` invocation of the pinned binary against a scripted loopback, permission mode
 * `bypassPermissions` -- the SAME way every other file in this family lets a tool run (WebSearch and
 * WebFetch both prompt otherwise); no allow rule, no hook, nothing more invasive than that.
 */
export async function runOfficialOnce(opts: OfficialRunOptions): Promise<OfficialRun> {
  const roots = opts.roots ?? makeOfficialRoots("winter-webtools-official-");
  const loop = startCapturingLoopback(opts.route, opts.logPrefix);
  const trap = startProxyTrap();
  try {
    const env = minimalOfficialEnv({
      home: roots.home,
      cfg: roots.cfg,
      baseUrl: loop.url,
      extra: { HTTPS_PROXY: trap.url, HTTP_PROXY: trap.url, https_proxy: trap.url, http_proxy: trap.url, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...(opts.extraEnv ?? {}) },
    });
    const settings = JSON.stringify({ skipWebFetchPreflight: true, ...(opts.settings ?? {}) });
    const proc = Bun.spawn(
      [opts.binaryPath, "-p", opts.prompt, "--model", opts.model ?? OFFICIAL_MODEL, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--setting-sources", "", "--settings", settings],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, cwd: roots.cwd },
    );
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    console.error(`[${opts.logPrefix}] exit=${exitCode}; ${loop.requests.length} loopback request(s); ${trap.hits.length} trap hit(s)`);
    if (exitCode !== 0) throw new Error(`the pinned claude binary exited ${exitCode}\n${stderr.slice(-1500)}`);
    const frames: RawFrame[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line) as RawFrame);
      } catch {
        /* a non-JSON stdout line surfaces as a missing expected frame in the caller's own assertions */
      }
    }
    return { requests: [...loop.requests], frames, trapHits: [...trap.hits] };
  } finally {
    loop.stop();
    trap.stop();
    if (opts.roots === undefined) cleanupRoots(roots);
  }
}

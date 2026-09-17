// 2026-09-17 sdk-taskframes-parity, Lane D2: shared plumbing for the differential-scenario family
// (request layout, agent-listing persistence, Agent(type) deny, fork request bytes, unsolicited
// notification turns). Each scenario drives the pinned `claude` 0.3.250 binary and Winter's own
// in-process engine through a SCRIPTED conversation and compares structure -- this module owns only
// the parts that are IDENTICAL across every scenario (binary resolution, env/root construction, SSE
// wire helpers, the capturing loopback, and an open-stdin stream-json driver for the official
// binary). The routing DECISION and the normalization/projection for a given scenario stay in that
// scenario's own test file, exactly as `task-frames-script.ts` keeps routing local to its own family
// -- centralizing THAT would blur which scenario is asserting what. This file exists because five
// new call sites (plus the pre-existing `task-frames-differential.test.ts` and
// `resume-conformance.test.ts`) would otherwise each hand-copy the ~30-line binary resolver and the
// ~15-line minimal-env builder; at that multiplicity the shared module is the smaller risk of drift,
// which is why `task-frames-differential.test.ts` now imports `resolvePinnedClaudeBinary` from here
// rather than keeping its own copy.
//
// GATED like every file in this family (`RUN_OFFICIAL_CAPTURE=1`). Every HOME/CLAUDE_CONFIG_DIR/cwd
// this module hands out is a fresh mkdtemp; the loopback fake never sees a real key; the env passed
// to the child is an EXPLICIT, minimal object -- never a `process.env` spread.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBunRuntime } from "../bun-required.ts";
import { fetchAndVerifyUpstream } from "./fetch.ts";

export const CLAUDE_VERSION = "0.3.250";
export const OFFICIAL_MODEL = "claude-haiku-4-5";

export type RawFrame = Record<string, unknown>;

// --- binary resolution (moved here from task-frames-differential.test.ts / resume-conformance.test.ts) --

export type ResolvedBinary = { binaryPath: string } | { reason: string };

/**
 * Resolves (fetching + installing on first use, into a CACHED prefix reused across runs) the pinned
 * claude binary. Returns `{reason}` -- never throws -- for every reason it might be unavailable, so
 * every caller's `describe.skipIf` can report the reason plainly.
 */
export async function resolvePinnedClaudeBinary(): Promise<ResolvedBinary> {
  if (process.env.RUN_OFFICIAL_CAPTURE !== "1") {
    return { reason: 'RUN_OFFICIAL_CAPTURE is not set to "1" -- this suite never fetches the pinned binary or touches the network by default' };
  }
  if (!hasBunRuntime()) {
    return { reason: "this suite needs Bun.spawn/Bun.serve to drive the pinned binary" };
  }
  try {
    const cacheRoot = join(tmpdir(), "winter-conformance-cache", `claude-${CLAUDE_VERSION}`);
    mkdirSync(cacheRoot, { recursive: true });
    const { tarballPath } = await fetchAndVerifyUpstream({ cacheDir: join(cacheRoot, "tarball") });
    const npmPrefix = join(cacheRoot, "npm-prefix");
    mkdirSync(npmPrefix, { recursive: true });
    const binaryPath = join(npmPrefix, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude");
    if (!(await Bun.file(binaryPath).exists())) {
      const install = Bun.spawn(["npm", "install", "--no-save", "--ignore-scripts", "--prefix", npmPrefix, tarballPath], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(install.stdout).text()) + (await new Response(install.stderr).text());
      if ((await install.exited) !== 0) return { reason: `npm install into the cached prefix failed:\n${out.slice(0, 2000)}` };
    }
    if (!(await Bun.file(binaryPath).exists())) {
      return { reason: `installed the wrapper but found no darwin-arm64 binary at ${binaryPath} -- wrong platform, most likely` };
    }
    return { binaryPath };
  } catch (err) {
    return { reason: `could not fetch/install the pinned binary: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- roots + env ------------------------------------------------------------------------------------

export interface OfficialRoots {
  root: string;
  home: string;
  cfg: string;
  cwd: string;
}

/** Fresh mkdtemp HOME/CLAUDE_CONFIG_DIR/cwd under one owned root -- never the real `~/.claude`. */
export function makeOfficialRoots(prefix: string): OfficialRoots {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const cfg = join(root, "cfg");
  const cwd = join(root, "cwd");
  for (const dir of [home, cfg, cwd]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });
  return { root, home, cfg, cwd };
}

export function cleanupRoots(r: OfficialRoots): void {
  rmSync(r.root, { recursive: true, force: true });
}

/**
 * The explicit, minimal env every spawn in this family uses -- never a `process.env` spread. `extra`
 * merges last (an env var a specific scenario needs, e.g. `CLAUDE_CODE_FORK_SUBAGENT`).
 */
export function minimalOfficialEnv(opts: { home: string; cfg: string; baseUrl: string; extra?: Record<string, string> }): Record<string, string> {
  return {
    HOME: opts.home,
    USER: process.env.USER ?? "winter-conformance",
    LOGNAME: process.env.USER ?? "winter-conformance",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TMPDIR: `${join(opts.home, "tmp")}/`,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CLAUDE_CONFIG_DIR: opts.cfg,
    ANTHROPIC_BASE_URL: opts.baseUrl,
    ANTHROPIC_API_KEY: "sk-ant-fake-differential-0000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    ...(opts.extra ?? {}),
  };
}

// --- SSE wire helpers (generalized: N content blocks per turn, for sibling-fork tool_use batches) --

export interface SseEvent {
  event: string;
  data: unknown;
}

export function sseResponse(events: SseEvent[]): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** One assistant turn carrying N `tool_use` blocks (batched, as a model that calls several tools at
 *  once does -- scenario 4's two sibling forks are one assistant message with two blocks). */
export function sseToolUseTurn(blocks: Array<{ id: string; name: string; input: unknown }>, opts?: { msgId?: string }): SseEvent[] {
  const msgId = opts?.msgId ?? crypto.randomUUID();
  const events: SseEvent[] = [
    { event: "message_start", data: { type: "message_start", message: { id: `msg_${msgId}`, type: "message", role: "assistant", model: OFFICIAL_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } } },
  ];
  blocks.forEach((block, index) => {
    events.push(
      { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index } },
    );
  });
  events.push(
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  );
  return events;
}

export function sseTextTurn(text: string, opts?: { msgId?: string }): SseEvent[] {
  const msgId = opts?.msgId ?? crypto.randomUUID();
  return [
    { event: "message_start", data: { type: "message_start", message: { id: `msg_${msgId}`, type: "message", role: "assistant", model: OFFICIAL_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

// --- the capturing loopback ------------------------------------------------------------------------

/**
 * A `Bun.serve` fake of the Anthropic Messages API that keeps the RAW request body (never just
 * `.messages`, unlike `task-frames-differential.test.ts`'s own inline server -- request-layout
 * scenarios need `system`/`tools`/every top-level key too) and routes every POST by content through
 * the caller's `route` callback. Every request is logged to stderr (structural facts only -- request
 * count, path, message count/roles -- never the system/tools prose, matching this whole file
 * family's own logging discipline). Non-POST hits (health-check pings) get a benign ack.
 */
export function startCapturingLoopback(route: (messages: RawFrame[], body: RawFrame, count: number) => Response, logPrefix = "official loopback"): { url: string; requests: RawFrame[]; stop: () => void } {
  const requests: RawFrame[] = [];
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST") {
        console.error(`[${logPrefix}] non-POST ping: ${req.method} ${url.pathname} (benign ack)`);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      count++;
      let body: RawFrame = {};
      try {
        body = (await req.json()) as RawFrame;
      } catch {
        /* non-JSON body -- falls through with an empty body, same as every other file in this family */
      }
      requests.push(body);
      const messages = Array.isArray(body.messages) ? (body.messages as RawFrame[]) : [];
      console.error(`[${logPrefix}] #${count} POST ${url.pathname} messages=${messages.length} roles=${messages.map((m) => String(m.role)).join(",")}`);
      return route(messages, body, count);
    },
  });
  return { url: server.url.href.replace(/\/$/, ""), requests, stop: () => server.stop(true) };
}

// --- open-stdin stream-json driver (P16-3's "streaming-input host": input stays open across turns) -

export interface OfficialStreamSession {
  /** Writes one NDJSON `type:"user"` frame to stdin and flushes -- the exact shape the pinned binary's `--input-format stream-json` accepts, verified against a real spawn (spike, 2026-09-17). */
  send(text: string): void;
  /** Reads (and buffers) stdout frames until `pred` matches one (inclusive); returns every frame seen so far, from the start of the stream. Throws with the stderr tail on timeout. */
  readUntil(pred: (frame: RawFrame) => boolean, timeoutMs?: number): Promise<RawFrame[]>;
  /** Waits `graceMs`, returning whatever NEW frames (since the last `readUntil`/`drainQuiet` call) arrived in that window -- used to prove nothing MORE arrives unprompted (P16-3's held-vs-immediate `result` claim). */
  drainQuiet(graceMs: number): Promise<RawFrame[]>;
  /** Every frame seen so far, in order (same backing array `readUntil`/`drainQuiet` read from). */
  allFrames: RawFrame[];
  /** Ends stdin -- the binary's own `--input-format stream-json` exits once it sees EOF and no task is holding it open. */
  close(): void;
  exited: Promise<number | null>;
  stderrTail(n?: number): string;
}

/**
 * Spawns the pinned binary with stdin held open (`-p --input-format stream-json --output-format
 * stream-json --verbose`), the shape scenarios 1/2/5 need (a two-turn or open-ended conversation in
 * ONE process, matching R3a's "streaming-input hosts... never get a held result" claim and R4's
 * "index-0 stable across turns" claim -- both need turns inside a single live session, not two
 * separate `--resume` invocations). `opts.args` are extra flags appended after the fixed base set.
 */
export function spawnOfficialStreamJson(opts: { binaryPath: string; env: Record<string, string>; cwd: string; args?: string[] }): OfficialStreamSession {
  const p = Bun.spawn([opts.binaryPath, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...(opts.args ?? [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: opts.env,
    cwd: opts.cwd,
  });

  const allFrames: RawFrame[] = [];
  let stdoutBuf = "";
  let stderrBuf = "";
  let waiters: Array<() => void> = [];
  function wake(): void {
    const ws = waiters;
    waiters = [];
    for (const w of ws) w();
  }
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of p.stdout) {
      stdoutBuf += decoder.decode(chunk as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.trim()) {
          try {
            allFrames.push(JSON.parse(line) as RawFrame);
          } catch {
            /* a non-JSON stdout line would be a harness bug on this leg -- never swallowed silently: it surfaces as a missing expected frame in the caller's own readUntil timeout diagnostic */
          }
        }
      }
      wake();
    }
  })();
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of p.stderr) stderrBuf += decoder.decode(chunk as Uint8Array, { stream: true });
  })();

  function send(text: string): void {
    const line = JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" }) + "\n";
    p.stdin.write(line);
    p.stdin.flush();
  }

  let cursor = 0;
  async function readUntil(pred: (frame: RawFrame) => boolean, timeoutMs = 30_000): Promise<RawFrame[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (cursor < allFrames.length) {
        const frame = allFrames[cursor++]!;
        if (pred(frame)) return allFrames.slice(0, cursor);
      }
      const remain = deadline - Date.now();
      if (remain <= 0) {
        throw new Error(`readUntil timed out after ${timeoutMs}ms (${allFrames.length} frame(s) seen); stderr tail:\n${stderrBuf.slice(-1500)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remain, 250));
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async function drainQuiet(graceMs: number): Promise<RawFrame[]> {
    const before = cursor;
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    const got = allFrames.slice(before);
    cursor = allFrames.length;
    return got;
  }

  return {
    send,
    readUntil,
    drainQuiet,
    allFrames,
    close: () => p.stdin.end(),
    exited: p.exited,
    stderrTail: (n = 1500) => stderrBuf.slice(-n),
  };
}

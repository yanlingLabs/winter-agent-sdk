// WS-23 — the compiled-binary MCP gate: `bun run verify:mcp-compiled`.
//
// WHY A SEPARATE GATE. `verify:compiled` (verify-protocol-compiled.ts) proves the compiled `winter`
// binary against the transport-equivalence suite, and its one MCP scenario ("mcpsdk") is the
// `type: "sdk"` host bridge (`sdk_mcp_call`) — which never loads the MCP client library at all. So
// nothing proved that the MCP TS SDK v2 (`@modelcontextprotocol/client`) survives `bun build
// --compile`: its conditional exports, its runtime-selected JSON-schema validator, its lazily
// imported pieces are exactly the "works under `bun src/main.ts`, breaks only in `$bunfs`" class the
// compiled gates exist for. This gate compiles the runtime, then drives ONE real session per
// negotiation mode through the compiled binary against a real stdio MCP server, and requires the
// model's tool call to come back with the server's answer.
//
// WHAT RUNS, all hermetic (loopback only, a temp WINTER_HOME, no credential, no paid API):
//   - the stdio server is `packages/runtime/src/mcp/transports/__fixtures__/ping-server.mjs`, the
//     dependency-free legacy fixture (`gate_ping` -> `PONG-<label>`), under `node` when one is on
//     PATH and under this bun otherwise;
//   - the "model" is a ~40-line Anthropic Messages fake in this file: turn 1 streams a `tool_use` of
//     `mcp__ping__gate_ping`, turn 2 (once a `tool_result` is in the request) streams the final text.
//     `provider/scenario-fake.ts` is not reused because its scripted tool is hard-coded to `Glob`,
//     and it backs the differential goldens, so it is not widened for this gate.
//
// Fix round 1 adds an HTTP leg (web search rides Streamable HTTP): a raw legacy HTTP MCP server in
// this file, reached on the http default (`auto`), that answers the `server/discover` probe with a
// 500 -- an answer the v2 client refuses on its own, so the leg also proves Winter's one-shot legacy
// retry (mcp/client.ts) survives compilation.
//
// WHAT IS ASSERTED, per leg (`legacy`, the stdio default; `auto` on stdio, whose in-place
// `server/discover` probe the fixture answers `-32601`, so it must fall back; `http`):
//   1. `system/init.mcp_servers` lists `ping` as `connected` at protocol revision 2025-11-25 — the v2
//      client's handshake ran inside the binary and the negotiated version reached the status;
//   2. `system/init.tools` offers `mcp__ping__gate_ping` — `tools/list` ran and registration worked;
//   3. the model's SECOND request carries a `tool_result` containing `PONG-compiled-<leg>` — a real
//      `tools/call` went out through the compiled client and its answer came back to the model.
//
// Usage: `bun run verify:mcp-compiled` (compiles to a temp path, ~a minute; the binary is deleted).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./build-runtime.ts";
import { encodeFrame, splitFrames, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PING_FIXTURE = fileURLToPath(new URL("../packages/runtime/src/mcp/transports/__fixtures__/ping-server.mjs", import.meta.url));
const MCP_TOOL = "mcp__ping__gate_ping";
const FINAL_TEXT = "the compiled mcp gate is done";
/** A real catalog row with native tool calling, so the session can run a tool round at all. */
const MODEL = "anthropic/claude-sonnet-5";

interface FakeModel {
  url: string;
  bodies: string[];
  close(): void;
}

function sse(events: Array<[string, unknown]>): Response {
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function startFakeModel(): FakeModel {
  const bodies: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
      const body = await req.text();
      bodies.push(body);
      const start: [string, unknown] = ["message_start", { type: "message_start", message: { id: "msg_ws23", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 5, output_tokens: 1 } } }];
      if (!body.includes("tool_result")) {
        return sse([
          start,
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ws23", name: MCP_TOOL, input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
      }
      return sse([
        start,
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: FINAL_TEXT } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bodies, close: () => server.stop(true) };
}

/** A raw 2025-era Streamable HTTP MCP server: one tool, `gate_ping`; the probe is answered 500. */
function startLegacyHttpMcp(label: string): { url: string; methods: string[]; close(): void } {
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const body = (await req.json()) as { id?: unknown; method?: string };
      methods.push(String(body.method));
      const json = (obj: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json", ...headers } });
      switch (body.method) {
        case "initialize":
          return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "raw-http", version: "1" } } }, { "mcp-session-id": "verify-session" });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "gate_ping", inputSchema: { type: "object", properties: {} } }] } });
        case "tools/call":
          return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `PONG-${label}` }] } });
        default:
          return new Response("Internal Server Error", { status: 500 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, methods, close: () => server.stop(true) };
}

async function runLeg(binPath: string, leg: "legacy" | "auto" | "http"): Promise<void> {
  const winterHome = mkdtempSync(join(tmpdir(), `winter-verify-mcp-${leg}-`));
  const fake = startFakeModel();
  const label = `compiled-${leg}`;
  const http = leg === "http" ? startLegacyHttpMcp(label) : undefined;
  try {
    const config = {
      sessionId: `verify-mcp-compiled-${leg}`,
      cwd: REPO_ROOT,
      model: MODEL,
      provider: { providerId: "anthropic", authRef: { kind: "inline", value: "test" }, connection: { baseUrl: fake.url, local: true } },
      allowedTools: [MCP_TOOL],
      // The MCP tool must be offered directly on turn 1, not behind Tool Search's deferral.
      toolSearchEnabled: false,
      // No ambient settings: the one server is the one declared here.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {
        // `alwaysLoad`: startup waits for it, so it is `connected` in `system/init` by construction.
        ping:
          http !== undefined
            ? { type: "http", url: http.url, alwaysLoad: true }
            : {
                command: Bun.which("node") ?? process.execPath,
                args: [PING_FIXTURE, "--label", label],
                alwaysLoad: true,
                ...(leg === "auto" ? { versionNegotiation: "auto" } : {}),
              },
      },
    };
    const proc = Bun.spawn([binPath, "--run", "--config-json", JSON.stringify(config)], {
      cwd: REPO_ROOT,
      env: { ...process.env, WINTER_HOME: winterHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(encodeFrame({ type: "user", text: "call the ping tool" }));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined }));
    proc.stdin.flush();
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    await proc.stdin.end();
    const frames: WinterFrame[] = splitFrames(stdout, "").frames;
    const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: { type?: string; subtype?: string } }).message);
    const init = messages.find((m) => m.type === "system" && m.subtype === "init") as { tools?: string[]; mcp_servers?: Array<{ name: string; status: string; protocolVersion?: string }> } | undefined;
    const fail = (why: string): never => {
      throw new Error(`verify:mcp-compiled [${leg}]: ${why} (exit ${exitCode})\n--- stderr ---\n${stderr}`);
    };
    if (init === undefined) fail("the compiled binary emitted no system/init");
    const ping = init!.mcp_servers?.find((s) => s.name === "ping");
    if (ping?.status !== "connected") fail(`the stdio MCP server is not connected in system/init: ${JSON.stringify(init!.mcp_servers)}`);
    if (ping!.protocolVersion !== "2025-11-25") fail(`expected the legacy fixture to negotiate 2025-11-25, got ${JSON.stringify(ping!.protocolVersion)}`);
    if (!(init!.tools ?? []).includes(MCP_TOOL)) fail(`system/init.tools does not offer ${MCP_TOOL}`);
    if (fake.bodies.length < 2) fail(`the model was asked ${fake.bodies.length} time(s); the tool round never completed`);
    if (!fake.bodies[1]!.includes(`PONG-${label}`)) fail(`the model's second request carries no tool_result with PONG-${label} -- the tools/call never came back`);
    if (!JSON.stringify(messages).includes(FINAL_TEXT)) fail("the session never produced the final answer");
    if (exitCode !== 0) fail("the compiled binary exited non-zero");
    if (http !== undefined && (http.methods[0] !== "server/discover" || !http.methods.includes("initialize"))) fail(`the http leg did not probe then fall back: ${JSON.stringify(http.methods)}`);
    console.log(`verify:mcp-compiled [${leg}] OK — connected at ${ping!.protocolVersion}, ${MCP_TOOL} offered, tools/call answered PONG-${label}`);
  } finally {
    fake.close();
    http?.close();
    rmSync(winterHome, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const workDir = mkdtempSync(join(tmpdir(), "winter-verify-mcp-compiled-"));
  const binPath = join(workDir, "winter");
  try {
    console.log("verify:mcp-compiled — compiling the winter runtime to a temp path...");
    await buildRuntime({ out: binPath });
    await runLeg(binPath, "legacy");
    await runLeg(binPath, "auto");
    await runLeg(binPath, "http");
    console.log("verify:mcp-compiled OK — the compiled binary speaks MCP over stdio and Streamable HTTP through @modelcontextprotocol/client v2");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    // process.exitCode, never process.exit(): the `finally` must still delete the ~60 MB binary
    // (verify-protocol-compiled.ts's own Finding A).
    process.exitCode = 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

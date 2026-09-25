// TEST-ONLY: a one-tool stdio MCP server, `gate_ping`, the shape of the WS-21 live gate's own fixture
// (fix round 19). Reached through mcp/test-fixtures.ts's `pingFixtureCommand()`, never imported.
//
// PLAIN JAVASCRIPT (`.mjs`), fix round 20: it runs under the `node` on PATH, and the release runner's
// Node 18 (and ubuntu-latest's preinstalled node) cannot strip TypeScript annotations -- a `.ts`
// fixture died there with ERR_UNKNOWN_FILE_EXTENSION. Bun runs it too.
//
// DEPENDENCY-FREE, WS-23: it used to be built on the v1 SDK's low-level `Server`. The v2 server
// package declares `engines.node >= 20`, and this file's whole reason to exist as `.mjs` is to run
// under that Node 18 -- so rather than bet the release runner on an engines range the package does
// not promise, it now speaks the stdio binding directly: newline-delimited JSON-RPC 2.0 on
// stdin/stdout, the 2025 handshake, `tools/list`, `tools/call`, `ping`. That is also the most honest
// possible LEGACY server: anything else before or after `initialize` (a 2026-07-28 `server/discover`
// probe included) is answered `-32601 Method not found`, the way pre-2026 SDK servers answer it.
//
// `--delay-ms <n>` postpones the MCP handshake by n milliseconds (stdin is not read, so the client's
// `initialize` waits in the pipe): a slow-starting server, for the first-turn wait and the
// late-connection tests. `--label <s>` is echoed in the tool's answer.
import { createInterface } from "node:readline";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const delayMs = Number(argValue("--delay-ms") ?? "0");
const label = argValue("--label") ?? "fixture";

// The newest 2025-era revision this fixture speaks; a client offering an older one gets it echoed
// back (the handshake's own version-selection rule).
const LATEST = "2025-11-25";
const SUPPORTED = new Set([LATEST, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]);

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}
function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  if (message === null || typeof message !== "object" || message.jsonrpc !== "2.0") return;
  // A notification (no id) never gets an answer; `notifications/initialized` included.
  if (!("id" in message) || typeof message.method !== "string") return;
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      result(id, {
        protocolVersion: SUPPORTED.has(requested) ? requested : LATEST,
        capabilities: { tools: {} },
        serverInfo: { name: `ping-${label}`, version: "1.0.0" },
      });
      return;
    }
    case "ping":
      result(id, {});
      return;
    case "tools/list":
      result(id, { tools: [{ name: "gate_ping", description: `Answers a ping for ${label}.`, inputSchema: { type: "object", properties: {} } }] });
      return;
    case "tools/call":
      if (params?.name === "gate_ping") result(id, { content: [{ type: "text", text: `PONG-${label}` }] });
      else error(id, -32602, `ping fixture: unknown tool "${String(params?.name)}"`);
      return;
    default:
      error(id, -32601, "Method not found");
  }
}

if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  try {
    handle(JSON.parse(line));
  } catch {
    // An unparsable line is the client's bug; the stdio binding has no id to answer it on.
  }
});
// The stdio binding: a server exits when its stdin closes.
lines.on("close", () => process.exit(0));

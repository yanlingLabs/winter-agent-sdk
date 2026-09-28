// WS-25 -- the compiled-binary MCP OAuth gate: `bun run verify:mcp-oauth`.
//
// WHY A COMPILED GATE. MCP OAuth rides the MCP client package's `auth()` family (discovery, registration,
// PKCE, token requests) and the runtime's own `mcp-auth` module -- lazily-reached code that `bun test`
// runs from source. `verify:mcp-compiled`'s own header names the class this catches: "works under `bun
// src/main.ts`, breaks only in `$bunfs`". So both halves run as COMPILED binaries here: the host's sign-in
// door (a tiny entry over `/mcp-auth`, `verify-mcp-oauth-login-entry.ts`) and the `winter` runtime a
// session is.
//
// HERMETIC: loopback only, a temp WINTER_HOME, no paid API, and NO KEYCHAIN -- the fixture's throwaway
// tokens live in a temp file named by `WINTER_TEST_MCP_OAUTH_STORE_FILE`, the runtime's one named test
// seam for this (mcp-auth/store.ts), honoured because the session names a throwaway Keychain service. A Keychain item written by this bun process would prompt when the
// compiled binary (another signing identity) read it.
//
// THE LEGS, in order, against ONE fixture authorization server + protected MCP server
// (packages/runtime/src/mcp-auth/test-fixture-as.ts):
//   1. login      -- the compiled login entry signs in (DCR, PKCE, the loopback callback the gate's
//                    "browser" follows); the file store then holds a v1 token and a v1 client record.
//   2. connect    -- a compiled `winter` session connects with the stored token: `mcp_servers` says
//                    `connected`, the model's call to `mcp__oauthfx__whoami` comes back `PONG-ok-read`,
//                    and NOTHING refreshed (no `mcp_oauth_refresh` ask, no refresh grant) -- spec §1.2.
//   3. refresh    -- the stored token is made expired; the session asks its HOST (`mcp_oauth_refresh`,
//                    names only), the gate answers as a daemon would (`refreshMcpOAuthToken` on the same
//                    store), and the call succeeds on the rotated token.
//   4. needs-auth -- expired with NO refresh token: `needs-auth` at once -- no ask, no refresh grant, no
//                    request to the MCP server -- the model is told which server needs sign-in, and its
//                    stale call answers with the door (`winter mcp login oauthfx`).
//   5. brokered   -- WS-25 §7: `hostCredentials: true`. The session resolves its provider key AND its MCP
//                    token through the gate (`credential_resolve`), refreshes through it, and the key is
//                    seen only by the model endpoint -- never in a frame or on stderr.
//   6. brokered-alwaysload -- the same, with the OAuth server `alwaysLoad` (startup WAITS for it) and an
//                    expired sign-in, so its connect needs BOTH host doors before `system/init`. The connect
//                    deadline is set far above the leg's wall-clock bound: a startup wait that sits ahead of
//                    the handshake or the input pump (the only thing that routes the host's answers back)
//                    fails the leg instead of quietly waiting the deadline out. `system/init` must say
//                    `connected`.
//
// EVERY leg asserts the runtime's first frame is the `type:"init"` handshake. This gate's raw reader used
// to accept frames in any order, which is how a host-brokered session's `credential_resolve` written
// AHEAD of the handshake passed here and died in a real daemon's `query()` ("expected 'init' as the first
// frame, got 'control_request'") -- the WS-25 live gate's init-order bug.
//
// Usage: `bun run verify:mcp-oauth` (compiles two binaries to a temp dir, deleted after).
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./build-runtime.ts";
import { encodeFrame, splitFrames, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { startFixtureAs, type FixtureAs } from "../packages/runtime/src/mcp-auth/test-fixture-as.ts";
import { createTestFileMcpOAuthStore, readTokenRecord, readClientRecord, toSessionMcpTokenRecord, writeTokenRecord } from "../packages/runtime/src/mcp-auth/store.ts";
import { mcpOAuthClientAccount, mcpOAuthTokenAccount } from "../packages/runtime/src/mcp-auth/account.ts";
import { refreshMcpOAuthToken } from "../packages/runtime/src/mcp-auth/refresh.ts";
import { isolateKeychain, keychainIsolatedEnv } from "./test-keychain-env.ts";
// Never the real Keychain: set before any session or child starts (see ./test-keychain-env.ts).
isolateKeychain();

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOGIN_ENTRY = fileURLToPath(new URL("./verify-mcp-oauth-login-entry.ts", import.meta.url));
const SERVER = "oauthfx";
const MCP_TOOL = `mcp__${SERVER}__whoami`;
const FINAL_TEXT = "the compiled mcp oauth gate is done";
const MODEL = "anthropic/claude-sonnet-5";

// --- A ~30-line Anthropic Messages fake: turn 1 calls the MCP tool, turn 2 answers. ----------------
interface FakeModel {
  url: string;
  bodies: string[];
  apiKeys: string[];
  close(): void;
}
function sse(events: Array<[string, unknown]>): Response {
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
function startFakeModel(): FakeModel {
  const bodies: string[] = [];
  const apiKeys: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 });
      const body = await req.text();
      bodies.push(body);
      apiKeys.push(req.headers.get("x-api-key") ?? "");
      const start: [string, unknown] = ["message_start", { type: "message_start", message: { id: "msg_ws25", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 5, output_tokens: 1 } } }];
      const block = !body.includes("tool_result")
        ? { type: "tool_use", id: "toolu_ws25", name: MCP_TOOL, input: {} }
        : { type: "text", text: "" };
      const delta = block.type === "tool_use" ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: FINAL_TEXT };
      return sse([
        start,
        ["content_block_start", { type: "content_block_start", index: 0, content_block: block }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bodies, apiKeys, close: () => server.stop(true) };
}

/** Reads a child's stdout as NDJSON lines, handing each to `onLine` as it arrives. */
async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void | Promise<void>): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== "") await onLine(line);
    }
  }
  if (buffer.trim() !== "") await onLine(buffer);
}

function compileLoginEntry(out: string): void {
  const scratch = mkdtempSync(join(tmpdir(), "winter-verify-mcp-oauth-build-"));
  try {
    const result = spawnSync(process.execPath, ["build", "--compile", LOGIN_ENTRY, "--outfile", out], { cwd: scratch, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`verify:mcp-oauth: compiling the login entry failed:\n${result.stderr}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function legLogin(loginBin: string, fx: FixtureAs, storeFile: string): Promise<void> {
  const proc = Bun.spawn([loginBin, "--server", fx.mcpUrl, "--store", storeFile], { env: keychainIsolatedEnv(), stdout: "pipe", stderr: "pipe" });
  let done: unknown;
  await readLines(proc.stdout, async (line) => {
    const msg = JSON.parse(line) as { authUrl?: string; issuerOrigin?: string; done?: unknown };
    if (msg.authUrl !== undefined) {
      if (msg.issuerOrigin !== fx.origin) throw new Error(`verify:mcp-oauth [login]: issuerOrigin ${msg.issuerOrigin} is not the fixture's ${fx.origin}`);
      const { callbackStatus } = await fx.approve(msg.authUrl);
      if (callbackStatus !== 200) throw new Error(`verify:mcp-oauth [login]: the loopback callback answered ${callbackStatus}`);
    }
    if (msg.done !== undefined) done = msg.done;
  });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  if (code !== 0 || JSON.stringify(done) !== JSON.stringify({ ok: true })) throw new Error(`verify:mcp-oauth [login]: the compiled sign-in did not finish ok (${JSON.stringify(done)}, exit ${code})\n${stderr}`);
  const store = createTestFileMcpOAuthStore(storeFile);
  const token = await readTokenRecord(store, mcpOAuthTokenAccount(fx.mcpUrl));
  const client = await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl));
  if (token === null || token.generation < 1 || token.refreshToken === undefined || client?.registeredVia !== "dcr") throw new Error("verify:mcp-oauth [login]: the store does not hold a sign-in with a refresh token and a DCR registration");
  console.log(`verify:mcp-oauth [login] OK -- compiled sign-in: DCR ${client.clientId}, redirect ${client.redirectUri}, token generation ${token.generation}`);
}

type SessionLeg = "connect" | "refresh" | "needs-auth" | "brokered" | "brokered-alwaysload";
/** Leg 6's connect deadline (far above its wall-clock bound) and that bound. */
const ALWAYS_LOAD_CONNECT_DEADLINE_MS = 120_000;
const ALWAYS_LOAD_LEG_BOUND_MS = 30_000;
/** The brokered leg's provider key: it may appear ONLY in the model request's header. */
const BROKERED_KEY = "sk-verify-brokered-4242";

async function legSession(winterBin: string, fx: FixtureAs, storeFile: string, leg: SessionLeg): Promise<void> {
  const winterHome = mkdtempSync(join(tmpdir(), `winter-verify-mcp-oauth-${leg}-`));
  const model = startFakeModel();
  const store = createTestFileMcpOAuthStore(storeFile);
  const account = mcpOAuthTokenAccount(fx.mcpUrl);
  const postsBefore = fx.tokenPosts.length;
  const mcpBefore = fx.mcpRequests;
  const asks: unknown[] = [];
  const resolves: string[] = [];
  try {
    const brokeredLeg = leg === "brokered" || leg === "brokered-alwaysload";
    const alwaysLoadLeg = leg === "brokered-alwaysload";
    const startedAt = Date.now();
    const config = {
      sessionId: `verify-mcp-oauth-${leg}`,
      // The test store is honoured only for an explicit, non-default Keychain service (mcp-auth/store.ts).
      keychainService: "ws25.verify-mcp-oauth.test",
      // WS-25 §7: the brokered leg's session asks THIS script for every Keychain credential.
      ...(brokeredLeg ? { hostCredentials: true } : {}),
      cwd: REPO_ROOT,
      model: MODEL,
      provider: { providerId: "anthropic", authRef: brokeredLeg ? { kind: "keychain", account: "anthropic:default" } : { kind: "inline", value: "test" }, connection: { baseUrl: model.url, local: true } },
      allowedTools: [MCP_TOOL],
      toolSearchEnabled: false,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { [SERVER]: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy", ...(alwaysLoadLeg ? { alwaysLoad: true } : {}) } },
    };
    const proc = Bun.spawn([winterBin, "--run", "--config-json", JSON.stringify(config)], {
      cwd: REPO_ROOT,
      env: keychainIsolatedEnv({ ...process.env, WINTER_HOME: winterHome, WINTER_TEST_MCP_OAUTH_STORE_FILE: storeFile, ...(alwaysLoadLeg ? { MCP_CONNECT_TIMEOUT_MS: String(ALWAYS_LOAD_CONNECT_DEADLINE_MS) } : {}) }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(encodeFrame({ type: "user", text: "call the whoami tool" }));
    proc.stdin.flush();
    const frames: WinterFrame[] = [];
    let ended = false;
    const stderrText = new Response(proc.stderr).text();
    await readLines(proc.stdout, async (line) => {
      const frame = splitFrames(`${line}\n`, "").frames[0];
      if (frame === undefined) return;
      frames.push(frame);
      if (frame.type === "control_request" && (frame as { subtype?: string }).subtype === "credential_resolve") {
        // THE FAKE HOST's credential door (§7): the provider key and the MCP token record (refresh token
        // masked by `toSessionMcpTokenRecord`), nothing else.
        const req = frame as { requestId: string; payload: { ref: { account: string } } };
        resolves.push(req.payload.ref.account);
        const accountName = req.payload.ref.account;
        const raw = accountName === account ? await store.read(account) : null;
        const answer =
          accountName === "anthropic:default"
            ? { ok: true, material: JSON.stringify({ kind: "api-key", key: BROKERED_KEY }), generation: 1 }
            : raw !== null
              ? { ok: true, material: toSessionMcpTokenRecord(raw), generation: 1 }
              : { ok: false, reason: "not_allowed" };
        proc.stdin.write(encodeFrame({ type: "control_response", requestId: req.requestId, ok: true, payload: answer }));
        proc.stdin.flush();
      }
      if (frame.type === "control_request" && (frame as { subtype?: string }).subtype === "mcp_oauth_refresh") {
        // THE FAKE HOST: a daemon's answer, through the same door a daemon runs.
        const req = frame as { requestId: string; payload: { account: string; generation: number } };
        asks.push(req.payload);
        const result = await refreshMcpOAuthToken({ account: req.payload.account, store, generation: req.payload.generation });
        proc.stdin.write(encodeFrame({ type: "control_response", requestId: req.requestId, ok: true, payload: result.ok ? { ok: true } : result }));
        proc.stdin.flush();
      }
      if (!ended && frame.type === "data" && (frame as { message: { type?: string } }).message.type === "result") {
        ended = true;
        proc.stdin.write(encodeFrame({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined }));
        proc.stdin.flush();
      }
    });
    const exitCode = await proc.exited;
    await proc.stdin.end();
    const stderr = await stderrText;
    const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: { type?: string; subtype?: string } }).message);
    const init = messages.find((m) => m.type === "system" && m.subtype === "init") as { mcp_servers?: Array<{ name: string; status: string }> } | undefined;
    const fail = (why: string): never => {
      throw new Error(`verify:mcp-oauth [${leg}]: ${why} (exit ${exitCode})\n--- stderr ---\n${stderr}`);
    };
    const status = init?.mcp_servers?.find((s) => s.name === SERVER)?.status;
    const posts = fx.tokenPosts.slice(postsBefore);
    if (exitCode !== 0) fail("the compiled binary exited non-zero");
    if (frames[0]?.type !== "init") fail(`the first frame was '${frames[0]?.type}'${frames[0]?.type === "control_request" ? ` (${(frames[0] as { subtype?: string }).subtype})` : ""}, not the init handshake -- a host's query() refuses that session`);
    if (alwaysLoadLeg) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > ALWAYS_LOAD_LEG_BOUND_MS) fail(`the alwaysLoad session took ${elapsed} ms -- startup waited on a host answer nothing could route back`);
      if (status !== "connected") fail(`the alwaysLoad server was not connected in system/init (status ${status})`);
    }
    if (brokeredLeg) {
      if (!model.apiKeys.includes(BROKERED_KEY)) fail("the provider request did not carry the host-resolved key");
      if (!resolves.includes("anthropic:default") || !resolves.includes(account)) fail(`the session did not resolve its credentials through the host: ${JSON.stringify(resolves)}`);
      if (asks.length !== 1 || JSON.stringify(posts) !== JSON.stringify(["refresh_token"])) fail(`expected one host refresh (asks ${JSON.stringify(asks)}, posts ${JSON.stringify(posts)})`);
      if (model.bodies.length < 2 || !model.bodies[1]!.includes("PONG-ok-read")) fail("the authenticated tools/call never came back");
      if (JSON.stringify(frames).includes(BROKERED_KEY) || stderr.includes(BROKERED_KEY)) fail("the brokered key leaked into a frame or stderr");
    } else if (leg === "connect" || leg === "refresh") {
      if (model.bodies.length < 2 || !model.bodies[1]!.includes("PONG-ok-read")) fail(`the model's second request carries no PONG-ok-read -- the authenticated tools/call never came back (init status ${status})`);
      if (leg === "connect" && (asks.length !== 0 || posts.length !== 0)) fail(`a USABLE token was refreshed at connect (asks ${JSON.stringify(asks)}, token posts ${JSON.stringify(posts)}) -- spec §1.2`);
      if (leg === "refresh") {
        if (asks.length !== 1 || JSON.stringify(asks[0]) !== JSON.stringify({ server: SERVER, account, generation: 1 })) fail(`expected exactly one host ask naming the account at generation 1, got ${JSON.stringify(asks)}`);
        if (JSON.stringify(posts) !== JSON.stringify(["refresh_token"])) fail(`expected exactly one refresh grant, got ${JSON.stringify(posts)}`);
      }
    } else {
      if (status !== "needs-auth" && !JSON.stringify(messages).includes("needs sign-in")) fail(`the server did not end needs-auth (init status ${status})`);
      if (asks.length !== 0 || posts.length !== 0) fail(`an expired token with NO refresh token was refreshed (asks ${JSON.stringify(asks)}, posts ${JSON.stringify(posts)}) -- spec §1.2`);
      if (fx.mcpRequests !== mcpBefore) fail(`the MCP server was contacted ${fx.mcpRequests - mcpBefore} time(s) for a sign-in known to be dead`);
      if (!model.bodies.some((b) => b.includes(`winter mcp login ${SERVER}`))) fail("the model was never told the sign-in door (winter mcp login <server>)");
    }
    if (!JSON.stringify(messages).includes(FINAL_TEXT)) fail("the session never produced the final answer");
    console.log(`verify:mcp-oauth [${leg}] OK -- init status ${status}, host asks ${asks.length}, credential resolves ${resolves.length}, token posts ${JSON.stringify(posts)}`);
  } finally {
    model.close();
    rmSync(winterHome, { recursive: true, force: true });
  }
}

async function expireStored(storeFile: string, fx: FixtureAs, dropRefresh: boolean): Promise<void> {
  const store = createTestFileMcpOAuthStore(storeFile);
  const account = mcpOAuthTokenAccount(fx.mcpUrl);
  const { refreshToken, ...rest } = (await readTokenRecord(store, account))!;
  await writeTokenRecord(store, account, { ...rest, ...(!dropRefresh && refreshToken !== undefined ? { refreshToken } : {}), expiresAt: Date.now() - 1000 });
}

if (import.meta.main) {
  const workDir = mkdtempSync(join(tmpdir(), "winter-verify-mcp-oauth-"));
  const winterBin = join(workDir, "winter");
  const loginBin = join(workDir, "mcp-oauth-login");
  const storeFile = join(workDir, "mcp-oauth-store.json");
  const fx = startFixtureAs();
  try {
    console.log("verify:mcp-oauth -- compiling the winter runtime and the sign-in entry to a temp path...");
    await buildRuntime({ out: winterBin });
    compileLoginEntry(loginBin);
    await legLogin(loginBin, fx, storeFile);
    await legSession(winterBin, fx, storeFile, "connect");
    await expireStored(storeFile, fx, false);
    await legSession(winterBin, fx, storeFile, "refresh");
    await expireStored(storeFile, fx, true);
    await legSession(winterBin, fx, storeFile, "needs-auth");
    // §7: a fresh sign-in, made expired, served to a HOST-BROKERED session (no Keychain, no test store).
    await legLogin(loginBin, fx, storeFile);
    await expireStored(storeFile, fx, false);
    await legSession(winterBin, fx, storeFile, "brokered");
    // The same host-brokered session with the server `alwaysLoad` and the sign-in expired again: startup
    // waits for a connect that needs `credential_resolve` AND `mcp_oauth_refresh` answered.
    await expireStored(storeFile, fx, false);
    await legSession(winterBin, fx, storeFile, "brokered-alwaysload");
    console.log("verify:mcp-oauth OK -- a compiled host signs in, a compiled session connects on the stored token, refreshes through its host, and is needs-auth without a refresh token");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1; // never process.exit(): the finally must delete the binaries
  } finally {
    fx.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

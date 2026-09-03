import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { BackgroundTaskMessage } from "@yanlinglabs/winter-agent-sdk";
import "./monitor.ts";
import { getRegisteredTool } from "../registry.ts";
import type { ToolExecutionContext } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { configureBackgroundTaskRoot, resetBackgroundTaskRootForTest } from "../background-tasks.ts";
import { resetBackgroundTaskRuntimeForTest, getTask } from "./background-task-runtime.ts";
import { parseMonitorInput, isDisallowedAddress, validateWsEndpoint, connectMonitorWs, buildMonitorRunCommandOptions } from "./monitor.ts";
import type { SessionTempDirPaths } from "../../paths/temp.ts";

function proj(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-monitor-test-")));
}

function fakeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: proj(),
    home: "/home/test",
    sessionId: "s1",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: proj(),
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
    ...overrides,
  };
}

function monitor() {
  const executor = getRegisteredTool("Monitor")!.executor!;
  return (input: unknown, ctx: ToolExecutionContext) => executor.execute(input, ctx);
}

// createWriteStream opens its fd asynchronously -- a predicate that reads the output file may run
// before the file exists at all. Never let that race surface as an uncaught ENOENT from inside a
// polling predicate; treat "not there yet" as "keep waiting," identically to any other not-yet-true
// predicate result.
function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function waitFor(predicate: () => boolean, maxMs = 3000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// test.skipIf, matching deny.darwin.test.ts's own pinned shape (not `const d = darwin ? describe :
// describe.skip`) -- a non-darwin CI run then ENUMERATES every test below as visibly skipped,
// rather than describe.skip hiding the whole block from the report.
const t = test.skipIf(process.platform !== "darwin");

// C1 (fix wave, P3 close-out): Monitor's command half shares bash.ts's own sandbox mechanism, and
// shared the SAME gap -- `ctx.sandboxSettings.filesystem` was never read anywhere in this file
// either. Options-level assertion, same rationale as bash.test.ts's own "buildRunCommandOptions"
// describe block (RunCommandResult.profile never leaves runMonitorCommand).
describe("buildMonitorRunCommandOptions (C1 -- filesystem deny/allow layers actually reach runCommand)", () => {
  test("denyWritePaths/denyReadPaths are read off ctx.sandboxSettings.filesystem and passed through", () => {
    const ctx = fakeCtx({
      sandboxSettings: {
        filesystem: {
          denyWrite: ["/proj/secrets"],
          denyRead: ["/proj/.env"],
          allowWrite: ["/extra/allowed"],
        },
      },
    });
    const options = buildMonitorRunCommandOptions(ctx);
    expect(options.denyWritePaths).toEqual(["/proj/secrets"]);
    expect(options.denyReadPaths).toEqual(["/proj/.env"]);
    expect(options.writableRoots).toContain("/extra/allowed");
  });

  test("no filesystem settings configured -> no denyWritePaths/denyReadPaths keys at all", () => {
    const ctx = fakeCtx();
    const options = buildMonitorRunCommandOptions(ctx);
    expect("denyWritePaths" in options).toBe(false);
    expect("denyReadPaths" in options).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Input validation -- platform-free.
// ---------------------------------------------------------------------------------------------
describe("parseMonitorInput", () => {
  test("accepts a valid command-half input", () => {
    const r = parseMonitorInput({ description: "watch", timeout_ms: 5000, persistent: false, command: "echo hi" });
    expect("error" in r).toBe(false);
  });

  test("accepts a valid ws-half input", () => {
    const r = parseMonitorInput({ description: "watch", timeout_ms: 5000, persistent: false, ws: { url: "wss://example.com" } });
    expect("error" in r).toBe(false);
  });

  test("rejects neither command nor ws", () => {
    const r = parseMonitorInput({ description: "watch", timeout_ms: 5000, persistent: false });
    expect("error" in r).toBe(true);
  });

  test("rejects BOTH command and ws", () => {
    const r = parseMonitorInput({ description: "watch", timeout_ms: 5000, persistent: false, command: "ls", ws: { url: "wss://example.com" } });
    expect("error" in r).toBe(true);
  });

  test("rejects a missing/empty description", () => {
    expect("error" in parseMonitorInput({ timeout_ms: 5000, persistent: false, command: "ls" })).toBe(true);
    expect("error" in parseMonitorInput({ description: "", timeout_ms: 5000, persistent: false, command: "ls" })).toBe(true);
  });

  test("rejects timeout_ms outside [1000, 3600000]", () => {
    expect("error" in parseMonitorInput({ description: "d", timeout_ms: 999, persistent: false, command: "ls" })).toBe(true);
    expect("error" in parseMonitorInput({ description: "d", timeout_ms: 3_600_001, persistent: false, command: "ls" })).toBe(true);
    expect("error" in parseMonitorInput({ description: "d", timeout_ms: 1000, persistent: false, command: "ls" })).toBe(false);
    expect("error" in parseMonitorInput({ description: "d", timeout_ms: 3_600_000, persistent: false, command: "ls" })).toBe(false);
  });

  test("rejects a missing persistent", () => {
    expect("error" in parseMonitorInput({ description: "d", timeout_ms: 5000, command: "ls" })).toBe(true);
  });

  test("rejects ws.url missing", () => {
    expect("error" in parseMonitorInput({ description: "d", timeout_ms: 5000, persistent: false, ws: {} })).toBe(true);
  });

  test("rejects ws.protocols with a non-string element", () => {
    const r = parseMonitorInput({ description: "d", timeout_ms: 5000, persistent: false, ws: { url: "ws://x", protocols: ["a", 5] } });
    expect("error" in r).toBe(true);
  });

  test("accepts ws.protocols as a string array", () => {
    const r = parseMonitorInput({ description: "d", timeout_ms: 5000, persistent: false, ws: { url: "ws://x", protocols: ["a", "b"] } });
    expect(r).toEqual({ description: "d", timeout_ms: 5000, persistent: false, ws: { url: "ws://x", protocols: ["a", "b"] } });
  });

  test("rejects non-object input", () => {
    expect("error" in parseMonitorInput(null)).toBe(true);
    expect("error" in parseMonitorInput("x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Address classification -- pure, no DNS/network needed.
// ---------------------------------------------------------------------------------------------
describe("isDisallowedAddress", () => {
  test("IPv4 loopback is disallowed", () => {
    expect(isDisallowedAddress("127.0.0.1", 4)).toBe(true);
  });
  test("IPv4 private ranges (10/8, 172.16-31/12, 192.168/16) are disallowed", () => {
    expect(isDisallowedAddress("10.1.2.3", 4)).toBe(true);
    expect(isDisallowedAddress("172.16.0.1", 4)).toBe(true);
    expect(isDisallowedAddress("172.31.255.255", 4)).toBe(true);
    expect(isDisallowedAddress("172.32.0.1", 4)).toBe(false); // just outside 172.16.0.0/12
    expect(isDisallowedAddress("192.168.1.1", 4)).toBe(true);
  });
  test("IPv4 link-local, INCLUDING the cloud metadata address, is disallowed", () => {
    expect(isDisallowedAddress("169.254.0.1", 4)).toBe(true);
    expect(isDisallowedAddress("169.254.169.254", 4)).toBe(true);
  });
  test("a public-looking IPv4 address is allowed", () => {
    expect(isDisallowedAddress("8.8.8.8", 4)).toBe(false);
    expect(isDisallowedAddress("93.184.216.34", 4)).toBe(false);
  });
  // N5 (fix wave, nit, P3 close-out): two previously-unclassified ranges (defense-in-depth only --
  // WS-07 is the primary gate).
  test("IPv4 Carrier-Grade NAT (100.64.0.0/10, RFC 6598) is disallowed", () => {
    expect(isDisallowedAddress("100.64.0.1", 4)).toBe(true);
    expect(isDisallowedAddress("100.127.255.255", 4)).toBe(true);
    expect(isDisallowedAddress("100.63.255.255", 4)).toBe(false); // just outside the range
    expect(isDisallowedAddress("100.128.0.0", 4)).toBe(false); // just outside the range
  });
  test("IPv4 multicast (224.0.0.0/4) is disallowed", () => {
    expect(isDisallowedAddress("224.0.0.1", 4)).toBe(true);
    expect(isDisallowedAddress("239.255.255.255", 4)).toBe(true);
    expect(isDisallowedAddress("223.255.255.255", 4)).toBe(false); // just outside the range
    expect(isDisallowedAddress("240.0.0.0", 4)).toBe(false); // just outside the range
  });
  test("IPv6 loopback and unspecified are disallowed", () => {
    expect(isDisallowedAddress("::1", 6)).toBe(true);
    expect(isDisallowedAddress("::", 6)).toBe(true);
  });
  test("IPv6 link-local (fe80::/10) and unique-local (fc00::/7) are disallowed", () => {
    expect(isDisallowedAddress("fe80::1", 6)).toBe(true);
    expect(isDisallowedAddress("febf::1", 6)).toBe(true);
    expect(isDisallowedAddress("fec0::1", 6)).toBe(false); // just outside fe80::/10
    expect(isDisallowedAddress("fc00::1", 6)).toBe(true);
    expect(isDisallowedAddress("fd12::1", 6)).toBe(true);
  });
  test("an IPv4-mapped IPv6 address is checked against the embedded IPv4 rules", () => {
    expect(isDisallowedAddress("::ffff:169.254.169.254", 6)).toBe(true);
    expect(isDisallowedAddress("::ffff:8.8.8.8", 6)).toBe(false);
  });
  test("an IPv4-mapped IPv6 address in HEX-GROUP form (not dotted-quad) is ALSO checked against the embedded IPv4 rules", () => {
    // "::ffff:a9fe:a9fe" is the identical address to "::ffff:169.254.169.254" (cloud metadata) --
    // just with each 16-bit trailing group written in hex instead of a dotted-quad tail. A resolver
    // can hand back either shape; only the dotted-quad form was previously recognized.
    expect(isDisallowedAddress("::ffff:a9fe:a9fe", 6)).toBe(true); // 169.254.169.254
    expect(isDisallowedAddress("::ffff:7f00:1", 6)).toBe(true); // 127.0.0.1
    expect(isDisallowedAddress("::ffff:c0a8:0101", 6)).toBe(true); // 192.168.1.1
    expect(isDisallowedAddress("::ffff:808:808", 6)).toBe(false); // 8.8.8.8, public
  });
  test("a public-looking IPv6 address is allowed", () => {
    expect(isDisallowedAddress("2001:4860:4860::8888", 6)).toBe(false);
  });
});

describe("validateWsEndpoint", () => {
  test("rejects a non-ws scheme", () => {
    return validateWsEndpoint("http://example.com").then((v) => expect(v.ok).toBe(false));
  });
  test("rejects an invalid URL", () => {
    return validateWsEndpoint("not a url").then((v) => expect(v.ok).toBe(false));
  });
  test("accepts ws:// and wss:// as schemes (address permitting)", async () => {
    const ws = await validateWsEndpoint("ws://8.8.8.8:1234/path");
    expect(ws.ok).toBe(true);
    const wss = await validateWsEndpoint("wss://8.8.8.8:1234/path");
    expect(wss.ok).toBe(true);
  });
  test("rejects a loopback IP literal directly, with no DNS lookup needed", async () => {
    const v = await validateWsEndpoint("ws://127.0.0.1:9999/");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("disallowed");
  });
  test("rejects the cloud metadata IP literal directly", async () => {
    const v = await validateWsEndpoint("ws://169.254.169.254/latest/meta-data/");
    expect(v.ok).toBe(false);
  });
  test("fails closed on a DNS resolution failure (bogus TLD)", async () => {
    const v = await validateWsEndpoint("ws://this-host-definitely-does-not-exist.invalid/");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/DNS resolution failed|failing closed/);
  });
  test("accepts a public-looking IP literal without any DNS lookup", async () => {
    const v = await validateWsEndpoint("ws://8.8.8.8/");
    expect(v.ok).toBe(true);
  });

  // RULING P3-I (Task 8, P3 close-out): the DNS-rebinding TOCTOU fix -- validateWsEndpoint now pins
  // the connection to the validated address itself, never leaving the caller to re-resolve the
  // original hostname independently at connect time.
  describe("RULING P3-I: pins the connection to the validated address", () => {
    test("ws:// to an IP literal: connectUrl is keyed by that SAME literal, hostHeader preserves the original host[:port]", async () => {
      const v = await validateWsEndpoint("ws://8.8.8.8:1234/path");
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.connectUrl.hostname).toBe("8.8.8.8");
        expect(v.connectUrl.toString()).toBe("ws://8.8.8.8:1234/path");
        expect(v.hostHeader).toBe("8.8.8.8:1234");
      }
    });

    test("wss:// to a DNS name is rejected outright (RULING P3-I: not yet pinnable against a rebinding resolver)", async () => {
      const v = await validateWsEndpoint("wss://example.com/socket");
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.reason).toContain("RULING P3-I");
        expect(v.reason).toContain("example.com");
      }
    });

    test("wss:// to an already-literal IP is NOT rejected -- nothing to rebind (no second, independent resolution of a literal)", async () => {
      const v = await validateWsEndpoint("wss://8.8.8.8/socket");
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.connectUrl.hostname).toBe("8.8.8.8");
        expect(v.hostHeader).toBe("8.8.8.8");
      }
    });

    test("a bracketed IPv6 literal round-trips through the pin correctly (the bare-hostname-assignment silent-no-op trap this ruling's own comment warns against)", async () => {
      // A real, publicly-routable IPv6 literal (Google public DNS) -- exercises the family:6 branch
      // of hostnameForUrl/isDisallowedIPv6 end to end, not just the IPv4 path every other fixture
      // here exercises.
      const v = await validateWsEndpoint("ws://[2001:4860:4860::8888]:1234/path");
      expect(v.ok).toBe(true);
      if (v.ok) {
        // If bracketing were dropped (the exact trap the comment names), `connectUrl.hostname`
        // would silently still read the URL's ORIGINAL host string as a no-op assignment -- the
        // fact this equals the address itself (bracketed) is the proof the assignment actually took.
        expect(v.connectUrl.hostname).toBe("[2001:4860:4860::8888]");
        expect(v.hostHeader).toBe("[2001:4860:4860::8888]:1234");
      }
    });

    // A genuine PRE-EXISTING bug found while writing the fixture above (not introduced by this
    // ruling, but fixed alongside it -- see stripBrackets' own header for the full account):
    // `URL.hostname` for a bracketed IPv6 host includes the brackets, which made `dns.lookup()`
    // reject EVERY IPv6 URL outright (ENOTFOUND) before this fix, regardless of whether the address
    // was disallowed or not -- a functional bug (IPv6 monitor targets were simply unusable), not by
    // itself a security fail-open. This fixture proves the DISALLOW check still fires correctly now
    // that resolution itself works: a link-local IPv6 literal is rejected, not merely "unresolvable".
    test("a disallowed (link-local) IPv6 literal is correctly rejected end to end, now that resolution itself works", async () => {
      const v = await validateWsEndpoint("ws://[fe80::1]/");
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("disallowed");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// ws half: connection/streaming mechanics against a REAL local Bun.serve websocket server.
// connectMonitorWs bypasses validateWsEndpoint on purpose -- see monitor.ts's own header comment
// on that split (a local test server is necessarily loopback, which validateWsEndpoint correctly
// rejects by design; that rejection is proven separately above).
// ---------------------------------------------------------------------------------------------
describe("connectMonitorWs (real local server)", () => {
  let server: Server<undefined>;
  let wsBgTaskDir: string;

  beforeEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
    wsBgTaskDir = mkdtempSync(join(tmpdir(), "winter-monitor-ws-bgtask-"));
    configureBackgroundTaskRoot(() => ({ root: wsBgTaskDir, scratchpad: join(wsBgTaskDir, "scratchpad"), tasks: join(wsBgTaskDir, "tasks") }));
  });

  afterEach(() => {
    server?.stop(true);
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
  });

  function startServer(handlers: { message?: (ws: ServerWebSocket<undefined>, msg: string | Buffer) => void; open?: (ws: ServerWebSocket<undefined>) => void }): number {
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("expected websocket", { status: 400 });
      },
      websocket: {
        open: handlers.open ?? (() => {}),
        message: handlers.message ?? (() => {}),
      },
    });
    return server.port!;
  }

  // M9 (fix wave, lens 4, "frame exists, contents not"): every ws-half test in this describe block
  // checked output-file CONTENT but never that task_started.description echoes the real input
  // description, or that task_notification.output_file names the SAME path the task was actually
  // created with -- both were previously unasserted (a swapped/hardcoded field would have passed).
  test("task_started.description and task_notification.output_file match the real input/created values", async () => {
    const port = startServer({
      open: (ws) => {
        ws.send("hello");
        ws.close(1000);
      },
    });
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    const res = await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "a very specific description", 5000, false, ctx);
    const { taskId } = JSON.parse(res.output);
    const outputPath = getTask(taskId)!.outputPath;
    await waitFor(() => frames.some((f) => f.subtype === "task_notification"));

    const started = frames.find((f) => f.subtype === "task_started") as { description: string };
    expect(started.description).toBe("a very specific description");

    const notif = frames.find((f) => f.subtype === "task_notification") as { output_file: string };
    expect(notif.output_file).toBe(outputPath);
  });

  test("appends text messages to the output file, in order", async () => {
    const port = startServer({
      open: (ws) => {
        ws.send("line one");
        ws.send("line two");
      },
    });
    const ctx = fakeCtx();
    const res = await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 5000, false, ctx);
    const { taskId } = JSON.parse(res.output);
    const outputPath = getTask(taskId)!.outputPath;
    await waitFor(() => readIfExists(outputPath).includes("line two"));
    const content = readFileSync(outputPath, "utf8");
    expect(content.indexOf("line one")).toBeLessThan(content.indexOf("line two"));
  });

  test("a binary frame is recorded as a size placeholder, never raw bytes", async () => {
    const port = startServer({
      open: (ws) => {
        ws.send(new Uint8Array(4096));
      },
    });
    const ctx = fakeCtx();
    const res = await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 5000, false, ctx);
    const { taskId } = JSON.parse(res.output);
    const outputPath = getTask(taskId)!.outputPath;
    await waitFor(() => readIfExists(outputPath).includes("binary frame"));
    expect(readFileSync(outputPath, "utf8")).toContain("[binary frame, 4096 bytes]");
  });

  test("a message exceeding 1 MiB kills the connection and reports a failed task_notification", async () => {
    const port = startServer({
      open: (ws) => {
        ws.send("x".repeat(2 * 1024 * 1024));
      },
    });
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 5000, false, ctx);
    await waitFor(() => frames.some((f) => f.subtype === "task_notification"));
    const notif = frames.find((f) => f.subtype === "task_notification") as { status: string; summary: string };
    expect(notif.status).toBe("failed");
    expect(notif.summary).toContain("1 MiB");
  });

  test("a non-persistent connection is finalized as failed once timeout_ms elapses", async () => {
    const port = startServer({}); // server accepts but never sends/closes
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    const started = Date.now();
    await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 300, false, ctx);
    await waitFor(() => frames.some((f) => f.subtype === "task_notification"), 2000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    const notif = frames.find((f) => f.subtype === "task_notification") as { status: string };
    expect(notif.status).toBe("failed");
  });

  test("persistent: true never auto-times-out (still running well past timeout_ms)", async () => {
    const port = startServer({});
    const ctx = fakeCtx();
    const res = await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 300, true, ctx);
    const { taskId } = JSON.parse(res.output);
    await new Promise((r) => setTimeout(r, 500)); // well past the 300ms timeout_ms
    expect(getTask(taskId)?.status).toBe("running");
  });

  test("a clean server-initiated close is reported as completed", async () => {
    const port = startServer({
      open: (ws) => ws.close(1000, "done"),
    });
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 5000, false, ctx);
    await waitFor(() => frames.some((f) => f.subtype === "task_notification"));
    const notif = frames.find((f) => f.subtype === "task_notification") as { status: string };
    expect(notif.status).toBe("completed");
  });

  test("the result is {taskId, timeoutMs} without a persistent key when persistent is false", async () => {
    const port = startServer({});
    const res = await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 1234, false, fakeCtx());
    const parsed = JSON.parse(res.output);
    expect(parsed.timeoutMs).toBe(1234);
    expect("persistent" in parsed).toBe(false);
  });

  test("the result includes persistent: true when persistent is true", async () => {
    const port = startServer({});
    const res = await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 1234, true, fakeCtx());
    const parsed = JSON.parse(res.output);
    expect(parsed.persistent).toBe(true);
  });

  test("TaskStop's stopTask() closes the socket, which finalizes the task", async () => {
    const port = startServer({});
    const ctx = fakeCtx();
    const res = await connectMonitorWs(`ws://127.0.0.1:${port}`, undefined, "watch", 30000, true, ctx);
    const { taskId } = JSON.parse(res.output);
    const { stopTask } = await import("./background-task-runtime.ts");
    expect(stopTask(taskId)).toBe(true);
    await waitFor(() => getTask(taskId)?.status !== "running");
    expect(getTask(taskId)?.status).not.toBe("running");
  });

  // RULING P3-I (Task 8, P3 close-out): proves the production path end to end -- runMonitorWs
  // passes validateWsEndpoint's own pinned `connectUrl`/`hostHeader` straight through to
  // connectMonitorWs's new optional 7th parameter, which this test exercises directly (the
  // IP-literal `url` here stands in for what validateWsEndpoint's own pin would have produced; this
  // describe block's own header explains why a real local server can't go through validateWsEndpoint
  // itself). A real Bun.serve server observing the ACTUAL Host header it received is the only way to
  // prove the header genuinely reaches the wire, not just that this file's own code compiles it.
  test("RULING P3-I: an explicit hostHeader is sent as the WS upgrade request's own Host header (virtual-hosting preservation)", async () => {
    const captured: { host: string | null } = { host: null };
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        captured.host = req.headers.get("host");
        if (srv.upgrade(req)) return;
        return new Response("expected websocket", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          ws.send("hello");
        },
        message: () => {},
      },
    });
    const ctx = fakeCtx();
    await connectMonitorWs(`ws://127.0.0.1:${server.port}`, undefined, "watch", 5000, false, ctx, "pinned-test-host.example:9999");
    await waitFor(() => captured.host !== null);
    expect(captured.host).toBe("pinned-test-host.example:9999");
  });

  test("RULING P3-I: omitting hostHeader (every pre-existing call site) behaves exactly as before -- the server sees the connection's own literal host", async () => {
    const captured: { host: string | null } = { host: null };
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        captured.host = req.headers.get("host");
        if (srv.upgrade(req)) return;
        return new Response("expected websocket", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          ws.send("hello");
        },
        message: () => {},
      },
    });
    const ctx = fakeCtx();
    await connectMonitorWs(`ws://127.0.0.1:${server.port}`, undefined, "watch", 5000, false, ctx);
    await waitFor(() => captured.host !== null);
    expect(captured.host).toBe(`127.0.0.1:${server.port}`);
  });
});

// ---------------------------------------------------------------------------------------------
// Command half through the real registered executor (darwin-gated -- reuses Bash's own sandbox).
// ---------------------------------------------------------------------------------------------
describe("Monitor executor: command half", () => {
  let paths: SessionTempDirPaths;
  let cleanupDir: string;

  beforeEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
    cleanupDir = mkdtempSync(join(tmpdir(), "winter-monitor-bgtask-"));
    paths = { root: cleanupDir, scratchpad: join(cleanupDir, "scratchpad"), tasks: join(cleanupDir, "tasks") };
    configureBackgroundTaskRoot(() => paths);
  });
  afterEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
  });

  t("returns immediately with {taskId, timeoutMs}, and streams stdout to the output file", async () => {
    const ctx = fakeCtx();
    const started = Date.now();
    const res = await monitor()({ description: "watch a build", timeout_ms: 5000, persistent: false, command: "sleep 1 && echo from-monitor" }, ctx);
    expect(Date.now() - started).toBeLessThan(1000);
    const parsed = JSON.parse(res.output);
    expect(typeof parsed.taskId).toBe("string");
    expect(parsed.timeoutMs).toBe(5000);
    const outputPath = getTask(parsed.taskId)!.outputPath;
    await waitFor(() => existsSync(outputPath) && readFileSync(outputPath, "utf8").includes("from-monitor"), 3000);
  });

  t("emits task_started/background_tasks_changed synchronously, and task_notification on completion", async () => {
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    await monitor()({ description: "quick", timeout_ms: 5000, persistent: false, command: "echo hi" }, ctx);
    expect(frames.some((f) => f.subtype === "task_started")).toBe(true);
    expect(frames.some((f) => f.subtype === "background_tasks_changed")).toBe(true);
    await waitFor(() => frames.some((f) => f.subtype === "task_notification"));
    const notif = frames.find((f) => f.subtype === "task_notification") as { status: string };
    expect(notif.status).toBe("completed");
    // M9 (fix wave, lens 4, "frame exists, contents not"): monitor.ts's own completion handler
    // emits a SECOND background_tasks_changed frame right after task_notification -- never
    // previously asserted at all (neither existence as a distinct later frame, nor content). The
    // just-completed task must be genuinely absent from that later frame's own tasks list.
    const started = frames.find((f) => f.subtype === "task_started") as { task_id: string };
    const changedFrames = frames.filter((f) => f.subtype === "background_tasks_changed") as Array<{ tasks: Array<{ task_id: string }> }>;
    expect(changedFrames.length).toBeGreaterThanOrEqual(2); // one at start, one at completion
    const completionChanged = changedFrames[changedFrames.length - 1]!;
    expect(completionChanged.tasks.map((t) => t.task_id)).not.toContain(started.task_id);
  });

  // M2 (fix wave, P3 close-out): WS-12 §8 requires every surface to record sandbox posture; the
  // command half's task_notification.summary never carried it (Lane C's own fix added the
  // annotation to Bash's three background surfaces only).
  t("task_notification summary carries [sandbox: config-disabled] when enabled:false", async () => {
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f), sandboxSettings: { enabled: false } });
    await monitor()({ description: "quick", timeout_ms: 5000, persistent: false, command: "echo hi" }, ctx);
    await waitFor(() => frames.some((f) => f.subtype === "task_notification"));
    const notif = frames.find((f) => f.subtype === "task_notification") as { summary: string };
    expect(notif.summary).toContain("[sandbox: config-disabled]");
  });

  t("a sandboxed command's task_notification summary carries [sandbox: sandboxed]", async () => {
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    await monitor()({ description: "quick", timeout_ms: 5000, persistent: false, command: "echo hi" }, ctx);
    await waitFor(() => frames.some((f) => f.subtype === "task_notification"));
    const notif = frames.find((f) => f.subtype === "task_notification") as { summary: string };
    expect(notif.summary).toContain("[sandbox: sandboxed]");
  });

  // Task 8 (the SAME ordering bug bash.ts's own equivalent test found): runCommand's spawn is
  // asynchronous, so without registering the task synchronously up front, this frame's own `tasks`
  // list was always empty at the exact moment it announced the task that had just started.
  t("background_tasks_changed's own tasks list already contains the just-started task, not an empty list", async () => {
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    await monitor()({ description: "quick", timeout_ms: 5000, persistent: false, command: "echo hi" }, ctx);
    const started = frames.find((f) => f.subtype === "task_started") as { task_id: string };
    const changed = frames.find((f) => f.subtype === "background_tasks_changed") as { tasks: Array<{ task_id: string }> };
    expect(changed.tasks.map((t) => t.task_id)).toContain(started.task_id);
  });

  t("a failing command is reported as a failed task_notification", async () => {
    const frames: BackgroundTaskMessage[] = [];
    const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
    await monitor()({ description: "will fail", timeout_ms: 5000, persistent: false, command: "exit 1" }, ctx);
    await waitFor(() => frames.some((f) => f.subtype === "task_notification"));
    const notif = frames.find((f) => f.subtype === "task_notification") as { status: string };
    expect(notif.status).toBe("failed");
  });

  t("the command half is sandboxed by default -- cannot write outside cwd", async () => {
    const ctx = fakeCtx();
    const sibling = proj();
    const target = join(sibling, "escaped.txt");
    await monitor()({ description: "escape probe", timeout_ms: 5000, persistent: false, command: `echo pwned > ${target}` }, ctx);
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(target)).toBe(false);
  });

  t("the real TaskStop tool kills a running monitor command task via the process group", async () => {
    // Uses the REAL TaskStop executor (not the lower-level stopTask primitive directly): TaskStop's
    // own executor is what actually sets status "stopped" BEFORE killing (see task-stop.ts's own
    // comment on that ordering) -- calling stopTask alone, as bash.test.ts/task-stop.test.ts's own
    // unit tests do, would leave status "running" until the killed process's OWN async completion
    // handler eventually observes the kill and derives "failed" from it, which is a real but
    // different code path than the one this integration test means to prove.
    await import("./task-stop.ts");
    const { getRegisteredTool: getTool } = await import("../registry.ts");
    const ctx = fakeCtx();
    const res = await monitor()({ description: "long", timeout_ms: 30000, persistent: false, command: "sleep 20" }, ctx);
    const { taskId } = JSON.parse(res.output);
    await waitFor(() => getTask(taskId)?.pid !== undefined);
    const stopExecutor = getTool("TaskStop")!.executor!;
    const stopRes = await stopExecutor.execute({ task_id: taskId }, ctx);
    expect(stopRes.isError).toBeFalsy();
    expect(getTask(taskId)?.status).toBe("stopped");
  });

  t("bad args are a tool error, never a throw", async () => {
    const res = await monitor()({}, fakeCtx());
    expect(res.isError).toBe(true);
  });
});

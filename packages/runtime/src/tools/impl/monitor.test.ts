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
import { parseMonitorInput, isDisallowedAddress, validateWsEndpoint, connectMonitorWs } from "./monitor.ts";
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
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {} },
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

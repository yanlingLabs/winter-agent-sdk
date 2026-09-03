// Task 3 (Lane C): Monitor (WS-06 §3.2). Exactly one of `command`/`ws`; ALWAYS returns immediately
// with `{taskId, timeoutMs, persistent?}` -- unlike Bash, Monitor has no non-backgrounded shape at
// all (no `run_in_background` field on its schema; the tool IS the background primitive). The
// command half reuses the exact same sandbox mechanism Bash does (../../sandbox/spawn.ts); the ws
// half is this file's own network-layer defense-in-depth (WS-07's permission/approval layer is the
// PRIMARY gate, per WS-06 §3.2's own "WS half has its own approval + network checks" -- this is the
// ADDITIONAL check, not a replacement for it).
//
// Documented v1 scope note (flagged rather than invented): "Stdout lines or WS frames re-enter the
// conversation as events" (WS-06 §3.2) is approximated here as output-file-append (execution order,
// same D18 `.output` file Bash background tasks use) plus the SAME task_started/task_notification
// frame pair Bash emits -- the pinned BackgroundTaskMessage union (frames.ts) has no
// per-line/per-frame event shape at all (T2's own derived-shapes writeup enumerates exactly six
// variants, none of them "one line of process output"), so inventing one here would not be a real
// protocol capability, just a shape nobody downstream could consume. A future phase that grows a
// real per-line event type is expected to upgrade this file, not the other way around.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import "../descriptors/monitor.ts";
import { replaceExecutor, type ToolExecutor, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createBackgroundTask } from "../background-tasks.ts";
import { runCommand, resolveExecutionPath, isSandboxAvailable, SandboxUnavailableError } from "../../sandbox/spawn.ts";
import { DEFAULT_SANDBOX_SETTINGS, SandboxConfigError, resolveNetworkPosture } from "../../sandbox/profile.ts";
import { startTracking, setTaskStatus, getTask, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";

// ---------------------------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------------------------
interface MonitorInput {
  description: string;
  timeout_ms: number;
  persistent: boolean;
  command?: string;
  ws?: { url: string; protocols?: string[] };
}

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 3_600_000;

function parseMonitorInput(input: unknown): MonitorInput | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "Monitor: input must be an object" };
  const obj = input as Record<string, unknown>;
  if (typeof obj.description !== "string" || obj.description.length === 0) {
    return { error: 'Monitor: "description" is required and must be a non-empty string' };
  }
  if (typeof obj.timeout_ms !== "number" || !Number.isFinite(obj.timeout_ms) || obj.timeout_ms < MIN_TIMEOUT_MS || obj.timeout_ms > MAX_TIMEOUT_MS) {
    return { error: `Monitor: "timeout_ms" is required and must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` };
  }
  if (typeof obj.persistent !== "boolean") {
    return { error: 'Monitor: "persistent" is required and must be a boolean' };
  }
  const hasCommand = obj.command !== undefined;
  const hasWs = obj.ws !== undefined;
  if (hasCommand === hasWs) {
    return { error: 'Monitor: exactly one of "command"/"ws" is required' };
  }
  if (hasCommand && typeof obj.command !== "string") {
    return { error: 'Monitor: "command" must be a string' };
  }
  let wsField: { url: string; protocols?: string[] } | undefined;
  if (hasWs) {
    if (typeof obj.ws !== "object" || obj.ws === null) return { error: 'Monitor: "ws" must be an object' };
    const ws = obj.ws as Record<string, unknown>;
    if (typeof ws.url !== "string" || ws.url.length === 0) return { error: 'Monitor: "ws.url" is required and must be a non-empty string' };
    if (ws.protocols !== undefined && (!Array.isArray(ws.protocols) || !ws.protocols.every((p) => typeof p === "string"))) {
      return { error: 'Monitor: "ws.protocols" must be an array of strings' };
    }
    wsField = { url: ws.url, ...(ws.protocols !== undefined ? { protocols: ws.protocols as string[] } : {}) };
  }
  return {
    description: obj.description,
    timeout_ms: obj.timeout_ms,
    persistent: obj.persistent,
    ...(hasCommand ? { command: obj.command as string } : {}),
    ...(wsField !== undefined ? { ws: wsField } : {}),
  };
}

function formatMonitorResult(taskId: string, timeoutMs: number, persistent: boolean): string {
  return JSON.stringify({ taskId, timeoutMs, ...(persistent ? { persistent: true } : {}) });
}

// ---------------------------------------------------------------------------------------------
// Command half -- identical sandbox mechanism to Bash's own background path.
// ---------------------------------------------------------------------------------------------

// `persistent: true` needs a stand-in "effectively forever" value for runCommand's own required
// `timeoutMs` (not optional there) -- max signed 32-bit ms (~24.8 days), the practical Node/Bun
// setTimeout ceiling, rather than an even larger number some timer implementations silently clamp
// to firing near-immediately. No real session runs that long; TaskStop is the actual exit door.
const PERSISTENT_STAND_IN_TIMEOUT_MS = 2_147_483_647;

async function runMonitorCommand(input: MonitorInput & { command: string }, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  // Same pre-flight-before-committing pattern as bash.ts's own runBackground -- see that function's
  // header comment for why (runCommand is `async`, so a pre-spawn throw becomes an unobservable
  // rejected promise by the time this caller could otherwise inspect it).
  const decision = resolveExecutionPath({ settings: DEFAULT_SANDBOX_SETTINGS, command: input.command });
  if (decision.posture === "sandboxed") {
    if (!isSandboxAvailable()) {
      return {
        output: "Error: Monitor: sandbox is required by the effective configuration but /usr/bin/sandbox-exec is unavailable on this host (WS-12 §3)",
        isError: true,
      };
    }
    try {
      resolveNetworkPosture(DEFAULT_SANDBOX_SETTINGS.network);
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  }

  const { taskId, outputPath } = createBackgroundTask("monitor");
  const outStream = createWriteStream(outputPath, { flags: "a" });
  const effectiveTimeout = input.persistent ? PERSISTENT_STAND_IN_TIMEOUT_MS : input.timeout_ms;

  let completion: ReturnType<typeof runCommand>;
  try {
    completion = runCommand({
      command: input.command,
      cwd: ctx.cwd,
      env: { ...process.env, TMPDIR: ctx.tempDir },
      timeoutMs: effectiveTimeout,
      settings: DEFAULT_SANDBOX_SETTINGS,
      writableRoots: [ctx.tempDir],
      onSpawned: ({ pid }) => {
        startTracking({ taskId, kind: "monitor", outputPath, description: input.description, command: input.command, pid });
      },
      onStdout: (c) => outStream.write(c),
      onStderr: (c) => outStream.write(c),
    });
  } catch (err) {
    outStream.end();
    if (err instanceof SandboxUnavailableError || err instanceof SandboxConfigError) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
    throw err;
  }

  ctx.emitFrame({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    description: input.description,
    is_backgrounded: true,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
  ctx.emitFrame({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });

  completion.then(
    (result) => {
      outStream.end();
      if (getTask(taskId)?.status !== "running") return; // TaskStop already recorded a terminal status
      const status = result.exitCode === 0 && !result.timedOut ? "completed" : "failed";
      setTaskStatus(taskId, status);
      try {
        ctx.emitFrame({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status,
          output_file: outputPath,
          summary: `${input.description} (${status})`,
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
        ctx.emitFrame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
      } catch {
        /* a torn-down session's emitFrame may throw; the registry's status and .output file are still correct */
      }
    },
    (err) => {
      outStream.end();
      if (getTask(taskId)?.status !== "running") return;
      setTaskStatus(taskId, "failed");
      try {
        ctx.emitFrame({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status: "failed",
          output_file: outputPath,
          summary: `${input.description} (failed to run: ${(err as Error).message})`,
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
      } catch {
        /* see above */
      }
    },
  );

  return { output: formatMonitorResult(taskId, input.timeout_ms, input.persistent) };
}

// ---------------------------------------------------------------------------------------------
// ws half -- endpoint validation (defense-in-depth beyond WS-07's own approval/network checks).
// ---------------------------------------------------------------------------------------------

function isDisallowedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // unparseable -- fail closed
  const [a, b] = parts as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / unspecified
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local -- covers cloud metadata 169.254.169.254
  return false;
}

function isDisallowedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isDisallowedIPv4(mapped[1]!);
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  const firstGroupText = lower.split(":")[0] ?? "";
  const firstGroup = firstGroupText.length > 0 ? parseInt(firstGroupText, 16) : NaN;
  if (!Number.isNaN(firstGroup)) {
    if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true; // fe80::/10 link-local
    if (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) return true; // fc00::/7 unique-local
  }
  return false;
}

function isDisallowedAddress(address: string, family: number): boolean {
  return family === 6 ? isDisallowedIPv6(address) : isDisallowedIPv4(address);
}

type WsValidation = { ok: true; url: URL } | { ok: false; reason: string };

async function validateWsEndpoint(rawUrl: string): Promise<WsValidation> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `invalid URL: ${rawUrl}` };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { ok: false, reason: `unsupported scheme "${url.protocol}" -- only ws:// and wss:// are allowed` };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(url.hostname, { all: true });
  } catch {
    return { ok: false, reason: `DNS resolution failed for "${url.hostname}" -- failing closed` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `no addresses resolved for "${url.hostname}" -- failing closed` };
  }
  for (const { address, family } of addresses) {
    if (isDisallowedAddress(address, family)) {
      return { ok: false, reason: `"${url.hostname}" resolves to a disallowed private/link-local/metadata address (${address})` };
    }
  }
  return { ok: true, url };
}

const MAX_WS_MESSAGE_BYTES = 1024 * 1024; // WS-06 §3.2: "kills on >1 MiB messages"

async function runMonitorWs(input: MonitorInput & { ws: { url: string; protocols?: string[] } }, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const validation = await validateWsEndpoint(input.ws.url);
  if (!validation.ok) {
    return { output: `Error: Monitor: ${validation.reason}`, isError: true };
  }
  return connectMonitorWs(validation.url.toString(), input.ws.protocols, input.description, input.timeout_ms, input.persistent, ctx);
}

// Split out from runMonitorWs (and exported) so the CONNECTION/STREAMING mechanics -- message
// append, binary-frame placeholders, the 1 MiB kill, timeout/persistent, TaskStop integration --
// are directly testable against a real local WS server without contradicting
// validateWsEndpoint's OWN correct rejection of loopback/private targets (this file's own header:
// that rejection is a deliberate security property, not a test inconvenience to route around).
// validateWsEndpoint's rejection behavior itself is tested separately and directly.
export async function connectMonitorWs(
  url: string,
  protocols: string[] | undefined,
  description: string,
  timeoutMs: number,
  persistent: boolean,
  ctx: ToolExecutionContext,
): Promise<ToolResultPayload> {
  let socket: WebSocket;
  try {
    socket = protocols !== undefined ? new WebSocket(url, protocols) : new WebSocket(url);
  } catch (err) {
    return { output: `Error: Monitor: failed to open websocket: ${(err as Error).message}`, isError: true };
  }
  socket.binaryType = "arraybuffer";

  const { taskId, outputPath } = createBackgroundTask("monitor");
  const outStream = createWriteStream(outputPath, { flags: "a" });

  let timer: ReturnType<typeof setTimeout> | undefined;

  function finalize(status: "completed" | "failed" | "stopped", summary: string): void {
    if (timer) clearTimeout(timer);
    outStream.end();
    if (getTask(taskId)?.status !== "running") return; // TaskStop already recorded a terminal status
    setTaskStatus(taskId, status);
    try {
      ctx.emitFrame({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        status,
        output_file: outputPath,
        summary,
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      ctx.emitFrame({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
    } catch {
      /* a torn-down session's emitFrame may throw; the registry's status and .output file are still correct */
    }
  }

  startTracking({ taskId, kind: "monitor", outputPath, description, stop: () => socket.close() });

  // ORDERING TRAP (found via a real repro, not assumed): Bun's WebSocket.close() fires the socket's
  // OWN onclose handler SYNCHRONOUSLY, before control returns to whatever called .close(). Every
  // call site below therefore calls finalize() FIRST and socket.close() SECOND -- finalize() sets
  // the task's status via setTaskStatus before this function's own emitFrame calls, so by the time
  // the synchronously-triggered onclose handler runs ITS OWN finalize("completed"|"failed", ...)
  // call, the "already terminal, not \"running\"" guard makes that second call a harmless no-op.
  // Reversing this order (close-then-finalize) would let onclose's own generic "clean close ->
  // completed" verdict win the race and silently overwrite the SPECIFIC verdict (timeout / oversized
  // message) this code means to report -- exactly the bug this comment exists to prevent recurring.
  if (!persistent) {
    timer = setTimeout(() => {
      finalize("failed", `${description} (timed out after ${timeoutMs}ms)`);
      socket.close();
    }, timeoutMs);
  }

  socket.onmessage = (event: MessageEvent) => {
    const data = event.data as unknown;
    if (typeof data === "string") {
      const bytes = Buffer.byteLength(data, "utf8");
      if (bytes > MAX_WS_MESSAGE_BYTES) {
        finalize("failed", `${description} (message exceeded 1 MiB, killed)`);
        socket.close();
        return;
      }
      outStream.write(`${data}\n`);
    } else {
      // binaryType "arraybuffer" -- a binary frame arrives as an ArrayBuffer, never a Blob.
      const byteLength = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
      if (byteLength > MAX_WS_MESSAGE_BYTES) {
        finalize("failed", `${description} (message exceeded 1 MiB, killed)`);
        socket.close();
        return;
      }
      outStream.write(`[binary frame, ${byteLength} bytes]\n`);
    }
  };

  socket.onerror = () => {
    finalize("failed", `${description} (connection error)`);
  };

  // `event.wasClean` is NOT the right signal here (found via a real repro, not assumed): Bun's
  // client-side WebSocket reports wasClean=false even for a well-formed SERVER-initiated close with
  // code 1000 (verified against a real Bun.serve websocket) -- only a CLIENT-initiated close comes
  // back wasClean=true in practice, which would make every naturally-ended stream (the server simply
  // finishing and closing normally) misreport as "failed." The close CODE is the portable signal:
  // 1000 (Normal Closure) and 1001 (Going Away, e.g. the server shutting down) both mean the stream
  // ended on purpose, regardless of which side initiated it; anything else is a genuine failure.
  socket.onclose = (event: CloseEvent) => {
    const clean = event.code === 1000 || event.code === 1001;
    finalize(clean ? "completed" : "failed", `${description} (${clean ? "completed" : `connection closed unexpectedly, code ${event.code}`})`);
  };

  ctx.emitFrame({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    description,
    is_backgrounded: true,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
  ctx.emitFrame({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });

  return { output: formatMonitorResult(taskId, timeoutMs, persistent) };
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------
export const monitorExecutor: ToolExecutor = {
  async execute(input, ctx) {
    const parsed = parseMonitorInput(input);
    if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };
    if (parsed.command !== undefined) return runMonitorCommand(parsed as MonitorInput & { command: string }, ctx);
    return runMonitorWs(parsed as MonitorInput & { ws: { url: string; protocols?: string[] } }, ctx);
  },
};

replaceExecutor("Monitor", monitorExecutor);

export { parseMonitorInput, isDisallowedAddress, validateWsEndpoint };

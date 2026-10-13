/** Actual SDK query over fixed owned pipes. This transports bytes; it cannot admit a guest owner. */
import { fstatSync, readFileSync, writeSync, closeSync } from "node:fs";
import { createReadStream } from "node:fs";
import { query, splitFrames, CLIConnectionError, ProcessError, ProtocolDecodeError, ResultError, AbortError, type RuntimeConfig, type PermissionMode, type SpawnedRuntimeProcess } from "@yanlinglabs/winter-agent-sdk";
import { assertLinuxHostQueryConfig } from "../../packages/runtime/src/guest/linux-host-query-profile.ts";
import { createHash } from "node:crypto";
import { fixtureCase, toolScript, terminalText, PROC_WRITE_RESULT, PLAN_BOUNDARY_RESULT, VIEW_RESULT, fixtureProbePaths, type ProbePaths, type Case } from "./cases.ts";

export function fixturePermission(kind: Case, tool: string, input: unknown, paths: ProbePaths): { behavior: "allow" } | { behavior: "deny"; message: string } {
  if (kind === "bypass") throw new Error("bypass callback must never run");
  const intended = toolScript(kind, paths).some(call => call.name === tool && JSON.stringify(call.input) === JSON.stringify(input));
  if (!intended) throw new Error("unbound fixture approval");
  return kind === "ask-allow" || kind === "plan" ? { behavior: "allow" } : { behavior: "deny", message: "fixed fixture denied" };
}
export function hostOptions(config: RuntimeConfig) {
  assertLinuxHostQueryConfig(config);
  // Runtime/store homes come exclusively from the Root producer, not SDK argv or environment.
  return { executionPosture: "confined-guest" as const, sessionId: config.sessionId!, model: config.model!, cwd: config.cwd!, persistSession: true,
    permissionMode: config.permissionMode as PermissionMode, tools: config.tools!, allowedTools: [], settingSources: [] as [], plugins: [] as [], skills: [] as [], mcpServers: {}, strictMcpConfig: true,
    permissions: config.permissions!, allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions === true, env: {}, pathToClaudeCodeExecutable: "winter-confined-guest", includePartialMessages: true, maxBufferSize: 1024 * 1024 };
}
/** The actual wire includes tool_result user messages omitted from the public TS union. */
export function fixtureTranscript(kind: Case, frames: unknown[], paths: ProbePaths) {
  const script = toolScript(kind, paths), calls: { id: string; name: string; input: unknown }[] = [], results: Record<string, any>[] = [];
  for (const message of frames as any[]) {
    if (!message || !Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content) {
      if (message.type === "assistant" && block.type === "tool_use") {
        const index = calls.length, expected = script[index];
        if (!expected || block.id !== `call-${index}` || block.name !== expected.name || JSON.stringify(block.input) !== JSON.stringify(expected.input)) throw new Error("fixture tool call binding");
        calls.push({ id: block.id, name: block.name, input: block.input });
      }
      if (message.type === "user" && block.type === "tool_result") {
        const index = results.length;
        if (block.tool_use_id !== `call-${index}` || index >= calls.length) throw new Error("fixture tool result correlation");
        const denied = kind === "ask-deny" && (index === 1 || index === 2 || index === 3), outside = (kind === "bypass" && index >= 4) || (kind === "plan" && index === 1);
        if (Boolean(block.is_error) !== outside || Boolean(block.denied) !== denied) throw new Error("fixture tool result status");
        if (denied && block.content !== "fixed fixture denied") throw new Error("fixture tool denial content");
        if (index === 0 && block.content !== "hello\n") throw new Error("fixture Read bytes");
        if (kind === "plan" && index === 1 && block.content !== "Error [read_only]: guest file operation refused") throw new Error("fixture native plan Write authority");
        if (kind === "plan" && index === 2 && block.content !== PLAN_BOUNDARY_RESULT) throw new Error("fixture native plan readonly Bash");
        if (index === 2 && !denied && kind !== "plan" && block.content !== VIEW_RESULT) throw new Error("fixture Bash output");
        if (index === 3 && !denied && block.content !== PROC_WRITE_RESULT) throw new Error("fixture readonly proc write");
        results.push(block);
      }
    }
  }
  if (calls.length !== script.length || results.length !== script.length) throw new Error("fixture missing tool results");
  return { toolCalls: calls.length, toolResults: results.length, scriptSha256: createHash("sha256").update(JSON.stringify(script)).digest("hex"), resultErrors: results.map(result => Boolean(result.is_error)), resultDenied: results.map(result => Boolean(result.denied)), exactReadBytes: true, bashBoundaryObserved: kind === "ask-allow" || kind === "bypass" || kind === "plan" };
}

/** Closed fixture diagnostics only. Unknown messages/paths never reach output. */
type HostFailureDiagnostic = { class: string; code: string; errnoCode?: string; processCode?: number | null; signal?: string | null; resultSubtype?: string };
export function hostFailure(error: unknown): HostFailureDiagnostic {
  const codes: Record<string, string> = {
    "fixture case unavailable": "fixture_case", "fixture probe paths unavailable": "probe_paths", "bypass callback must never run": "bypass_callback", "unbound fixture approval": "approval_binding",
    "fixture tool call binding": "tool_call", "fixture tool result correlation": "tool_result", "fixture tool result status": "tool_status", "fixture tool denial content": "denial_content",
    "fixture Read bytes": "read_bytes", "fixture native plan Write authority": "plan_write", "fixture native plan readonly Bash": "plan_bash",
    "fixture Bash output": "bash_output", "fixture readonly proc write": "proc_write", "fixture missing tool results": "missing_results", "fixture pipe bound": "pipe_bound",
    "fixture input closed": "input_closed", "fixture input frame bound": "input_frame", "fixture control correlation": "control_correlation",
    "fixture output frame bound": "output_frame", "fixed fixture observation bound": "observation_bound", "fixture control route": "control_route",
    "fixture permission binding": "permission_binding", "fixture output truncated frame": "output_truncated", "fixture lifecycle bound": "lifecycle_bound",
    "Root lifecycle observer unavailable": "lifecycle_unavailable", "fixture lifecycle code": "lifecycle_code", "fixture callback correlation": "callback_binding",
    "fixture input truncated frame": "input_truncated", "Root teardown observer failed": "teardown_failed", "fixture approval/result oracle": "approval_result",
  };
  const sdkClass = error instanceof ResultError ? "ResultError" : error instanceof ProcessError ? "ProcessError" : error instanceof CLIConnectionError ? "CLIConnectionError" : error instanceof ProtocolDecodeError ? "ProtocolDecodeError" : error instanceof AbortError ? "AbortError" : undefined;
  const name = sdkClass ?? (error instanceof Error ? error.name : "NonError");
  const result: HostFailureDiagnostic = { class: sdkClass ?? (["Error", "TypeError", "RangeError", "SyntaxError", "NonError"].includes(name) ? name : "Error"), code: error instanceof Error ? (Object.hasOwn(codes, error.message) ? codes[error.message]! : "host_failure") : "host_failure" };
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === "string" && ["EBADF", "EPIPE", "EIO", "EINVAL", "ENOENT", "ETIMEDOUT", "EINTR"].includes(errno)) result.errnoCode = errno;
  if (error instanceof ProcessError) {
    if (error.code === null || (typeof error.code === "number" && Number.isInteger(error.code) && error.code >= 0 && error.code <= 255)) result.processCode = error.code;
    const signals = ["SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ"];
    if (error.signal === null || (typeof error.signal === "string" && signals.includes(error.signal))) result.signal = error.signal;
  }
  // frames.ts admits extensions as string: unknown result values are deliberately omitted.
  if (error instanceof ResultError && ["success", "error_max_turns", "error_during_execution", "error_max_budget_usd", "error_max_structured_output_retries"].includes(error.result.subtype)) result.resultSubtype = error.result.subtype;
  return result;
}

function writePipe(fd: number, chunk: string): void {
  const data = Buffer.from(chunk);
  if (data.length > 1024 * 1024) throw new Error("fixture pipe bound");
  let at = 0;
  while (at < data.length) {
    try { const count = writeSync(fd, data, at); if (!count) throw new Error("fixture input closed"); at += count; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EINTR") continue; throw error; }
  }
}
async function* chunks(fd: number): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = createReadStream("", { fd, autoClose: false, highWaterMark: 65536 });
  try { for await (const bytes of stream) { const text = decoder.decode(bytes, { stream: true }); if (text) yield text; } const tail = decoder.decode(); if (tail) yield tail; }
  finally { stream.destroy(); }
}
export async function runClient(metadata: { case: Case; runtimeConfig: RuntimeConfig; probePaths: ProbePaths }, inputFd: number, outputFd: number, errorFd: number, lifecycleFd: number, cancelFd: number) {
  const kind = fixtureCase(metadata.case), paths = fixtureProbePaths(metadata.probePaths); let callbacks = 0, terminal = false, ended = false, killed = false, requests = 0, responses = 0;
  const observedFrames: unknown[] = []; let observedBytes = 0;
  const permissions = new Map<string, { tool: string; input: unknown; toolUseID: string }>();
  const requestIds = new Set<string>(), responseIds = new Set<string>();
  let inputCarry = "", outputCarry = "";
  const process: SpawnedRuntimeProcess = {
    pid: null, // Abstract guest transport; no guessed PID or native-owner authority.
    stdin: {
      write(chunk) {
        const split = splitFrames(chunk, inputCarry); inputCarry = split.carry; if (Buffer.byteLength(inputCarry) > 1024 * 1024) throw new Error("fixture input frame bound");
        for (const frame of split.frames) if (frame.type === "control_response") { responses++; if (typeof frame.requestId !== "string" || !requestIds.has(frame.requestId) || responseIds.has(frame.requestId)) throw new Error("fixture control correlation"); responseIds.add(frame.requestId); }
        writePipe(inputFd, chunk);
      },
      end() { if (!ended) { ended = true; closeSync(inputFd); } },
    },
    stdout: (async function* () { for await (const chunk of chunks(outputFd)) { const split = splitFrames(chunk, outputCarry); outputCarry = split.carry; if (Buffer.byteLength(outputCarry) > 1024 * 1024) throw new Error("fixture output frame bound"); for (const frame of split.frames) {
      if (frame.type === "data") { observedBytes += Buffer.byteLength(JSON.stringify(frame.message)); if (observedFrames.length >= 256 || observedBytes > 2 * 1024 * 1024) throw new Error("fixed fixture observation bound"); observedFrames.push(frame.message); }
      if (frame.type === "control_request") { if (frame.subtype !== "permission" || typeof frame.requestId !== "string" || requestIds.has(frame.requestId)) throw new Error("fixture control route"); const payload = frame.payload as any, script = toolScript(kind, paths), index = Number(String(payload?.toolUseID).replace("call-", ""));
        if (payload?.requestId !== frame.requestId || !Number.isInteger(index) || !script[index] || script[index]!.name !== payload.toolName || JSON.stringify(script[index]!.input) !== JSON.stringify(payload.input)) throw new Error("fixture permission binding");
        permissions.set(frame.requestId, { tool: payload.toolName, input: payload.input, toolUseID: payload.toolUseID });
        requestIds.add(frame.requestId); requests++; }
    } yield chunk; } if (outputCarry) throw new Error("fixture output truncated frame"); })(),
    stderr: chunks(errorFd),
    // Transport EOF is NOT native teardown or store-release proof. Root separately verifies those.
    exited: (async () => {
      let wire = "";
      for await (const chunk of chunks(lifecycleFd)) { wire += chunk; if (Buffer.byteLength(wire) > 64) throw new Error("fixture lifecycle bound"); }
      if (!/^HQX1:[0-9]{1,3}\n$/.test(wire)) throw new Error("Root lifecycle observer unavailable");
      const code = Number(wire.slice(5).trim()); if (code > 255) throw new Error("fixture lifecycle code");
      return { code, signal: null };
    })(),
    kill() { if (!killed) { killed = true; writePipe(cancelFd, "K"); } },
  };
  void process.exited.catch(() => {});
  const q = query({ prompt: "Exercise only the fixed fixture source and report completion.", options: {
    ...hostOptions(metadata.runtimeConfig), spawnClaudeCodeProcess: () => process,
    canUseTool: async (tool, input, options) => {
      const request = permissions.get(options.requestId);
      if (!request || request.tool !== tool || request.toolUseID !== options.toolUseID || JSON.stringify(request.input) !== JSON.stringify(input)) throw new Error("fixture callback correlation");
      callbacks++; return fixturePermission(kind, tool, input, paths);
    },
  } });
  let messages = 0, terminalTextObserved = false;
  try { for await (const message of q) { messages++; if (message.type === "result") { terminal = message.subtype === "success"; } if (message.type === "assistant") terminalTextObserved ||= JSON.stringify(message.message.content).includes(terminalText(kind)); } }
  finally { await q.return(undefined); }
  if (inputCarry) throw new Error("fixture input truncated frame");
  const toolEvidence = fixtureTranscript(kind, observedFrames, paths);
  const lifecycle = await process.exited;
  if (lifecycle.code !== 0 || lifecycle.signal !== null) throw new Error("Root teardown observer failed");
  if (!terminal || !terminalTextObserved || requests !== (kind === "bypass" ? 0 : 3) || responses !== requests || callbacks !== requests) throw new Error("fixture approval/result oracle");
  return { passed: true, case: kind, callbacks, requests, responses, messages, terminal, terminalTextObserved, transportOnly: true, rootTeardownObserved: true, ...toolEvidence };
}
if (import.meta.main) {
  if (process.platform !== "linux" || JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--input-fd", "3", "--output-fd", "4", "--error-fd", "5", "--metadata-fd", "6", "--lifecycle-fd", "7", "--cancel-fd", "8"])) throw new Error("fixed fixture host entry");
  const info = fstatSync(6); if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o222 || info.size > 65536) throw new Error("fixed Root metadata required");
  if (process.getuid?.() !== 40001) throw new Error("fixed fixture host identity");
  for (const fd of [3, 4, 5, 7, 8]) { const pipe = fstatSync(fd); if (!pipe.isFIFO() || pipe.uid !== 0 || pipe.nlink !== 1) throw new Error("Root-owned fixture pipe required"); }
  const metadata = JSON.parse(readFileSync(6, "utf8"));
  try { console.log(JSON.stringify(await runClient(metadata, 3, 4, 5, 7, 8))); }
  catch (error) { console.log(JSON.stringify({ passed: false, class: "host_query_fixture", failure: hostFailure(error) })); process.exitCode = 1; }
}

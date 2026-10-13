/** Direct tool-view fixture client. This is not the actual SDK runtimeEntry or provider loop. */
import { createHash } from "node:crypto";
import { createLinuxSupervisorSession } from "../../packages/runtime/src/guest/supervisor-client.ts";
import smoke from "./smoke.sh" with { type: "text" };
import descendant from "./descendant.py" with { type: "text" };

const source = "/workspace/folders/source", readonly = "/workspace/folders/readonly";
const marker = "tool-device-stdin-fds-ok\ntool-device-inventory-ok\ntool-device-boundaries-ok\ntool-entropy-multiprocessing-ok\ntool-device-smoke-ok\n";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const descendantCommand = (scenario: "foreground" | "cancel") => `python3 -c ${quote(descendant)} ${scenario}`;
const check = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
function processFailureObservation(result: { exitCode: number; termination: string; stdout: string; stderr: string }, invocation: number) {
  const stderr = result.stderr.slice(0, 16384), stdout = result.stdout.slice(0, 65536);
  const knownMarkers = ["tool-device-stdin-fds-ok", "tool-device-inventory-ok", "tool-device-boundaries-ok", "tool-entropy-multiprocessing-ok", "tool-device-smoke-ok"];
  const lines = new Set(stdout.split("\n"));
  const classes = ["ModuleNotFoundError", "ImportError", "AssertionError", "SyntaxError", "PermissionError"];
  const stderrClass = classes.find(value => new RegExp(`\\b${value}\\s*:`).test(stderr) || value === "AssertionError" && /^\s*AssertionError\s*$/m.test(stderr)) ?? "unrecognized";
  const stderrCategory = stderrClass === "ModuleNotFoundError" ? "module_missing" : stderrClass === "ImportError" ? "import_error" : stderrClass === "AssertionError" ? "assertion_failed" : stderrClass === "SyntaxError" ? "syntax_error" : stderrClass === "PermissionError" ? "permission_denied" : stderr.includes("error while loading shared libraries:") ? "shared_library_load" : stderr ? "unknown" : "empty";
  const errnoTokens = ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EAGAIN", "EMFILE", "ENOSPC", "EROFS", "ENXIO"].filter(token => new RegExp(`\\b${token}\\b`).test(stderr));
  const traceback: { source: "stdin" | "string"; line: number }[] = [];
  for (const match of stderr.matchAll(/^\s*File "<(stdin|string)>", line (\d{1,5})(?:,|$)/gm)) {
    const line = Number(match[2]);
    if (Number.isSafeInteger(line) && line >= 1 && line <= 10000) traceback.push({ source: match[1] as "stdin" | "string", line });
    if (traceback.length === 8) break;
  }
  return { kind: "winter-tool-utility-client-failure", version: 1, phase: "smoke", scenario: "ordinary", invocation, process: { exitCode: result.exitCode, termination: result.termination, stdoutMarkers: knownMarkers.filter(value => lines.has(value)), stderrClass, stderrCategory, traceback, errnoTokens } };
}
if (process.platform !== "linux" || process.argv.length !== 4 || !["ordinary", "plan"].includes(process.argv[3]!)) throw new Error("fixed Linux utility client required");
const plan = process.argv[3] === "plan", uid = plan ? 20002 : 20001, toolUid = plan ? 10002 : 10001;
check(process.getuid?.() === uid, "fixed runtime UID required");
const endpoint = process.argv[2]!;
check(new RegExp(`^/tmp/winter-utility-run-[A-Za-z0-9_-]+/control/conversation-${plan ? "plan" : "utility"}/tools\\.sock$`).test(endpoint), "fixed fixture endpoint required");
const authority = { workspaceId: "utility-workspace", sessionId: plan ? "backend-plan" : "backend-utility", incarnationId: "utility-incarnation", leaseEpoch: 1, configRevision: 1, grantRevision: 1, policyRevision: 1 };
const roots = [{ id: "source", guestPath: source, readOnly: false }, { id: "readonly", guestPath: readonly, readOnly: true }];
const guest = createLinuxSupervisorSession({ socketPath: endpoint, authority, roots, toolUid, maxBytes: 1024 * 1024, maxOutputBytes: 65536 });
const execute = (command: string, timeout = 30000, signal?: AbortSignal) => guest.executeProcess!(command, source, timeout, signal);
if (plan) {
  const result = await execute("printf forbidden > plan-write", 5000);
  check(result.exitCode !== 0 && result.termination === "exit", "plan source must remain readonly");
  console.log(JSON.stringify({ kind: "winter-tool-utility-client", scenario: "plan", uid, planReadonly: true, generalToolAvailabilityEnabled: false }));
} else {
  const results = [];
  for (let invocation = 0; invocation < 2; invocation++) {
    const result = await execute(smoke);
    const valid = result.exitCode === 0 && result.termination === "exit" && result.stdout === marker && result.stderr === "";
    if (!valid) console.log(JSON.stringify(processFailureObservation(result, invocation)));
    check(valid, "exact utility smoke result required");
    results.push(result);
  }
  for (const path of ["/run/winter", "/workspace/.winter/conversations", "/protected/runtime"]) {
    let refused = false;
    try { await guest.read(path); } catch { refused = true; }
    check(refused, "file helper trusted path refusal required");
  }
  let escaped = false;
  try { await guest.read(source + "/runtime-escape"); } catch { escaped = true; }
  check(escaped, "file helper source symlink refusal required");
  const readOnly = await execute(`printf forbidden > ${readonly}/write`, 5000);
  check(readOnly.exitCode !== 0 && readOnly.termination === "exit", "readonly source must remain readonly");
  const descendants = await execute(descendantCommand("foreground"), 5000);
  check(descendants.exitCode === 0 && descendants.termination === "exit" && descendants.stdout === "" && descendants.stderr === "", "foreground descendant receipt required");
  const abort = new AbortController();
  const pending = execute(descendantCommand("cancel"), 7000, abort.signal);
  void pending.catch(() => {});
  let ready = false;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { ready = new TextDecoder().decode((await guest.read(source + "/cancel-ready")).bytes) === "ready-after-setsid"; if (ready) break; } catch {}
      await Bun.sleep(10);
    }
    check(ready, "cancel positive control required");
  } finally { abort.abort(); }
  let cancelled = false;
  try { await pending; } catch (error) { cancelled = (error as { effectsUncertain?: boolean }).effectsUncertain === true; }
  check(cancelled, "cancellation must retain effect uncertainty");
  console.log(JSON.stringify({ kind: "winter-tool-utility-client", scenario: "ordinary", uid, smokeSha256: hash(smoke), results, fileRefusals: true, sourceSymlinkRefused: true, readonlyRefused: true, descendantReceipt: true, cancelledEffectsUncertain: true, generalToolAvailabilityEnabled: false }));
}

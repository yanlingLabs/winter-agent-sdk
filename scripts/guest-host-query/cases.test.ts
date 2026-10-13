import type { EvaluationContext } from "../../packages/runtime/src/permissions/evaluator.ts";
import { expect, test } from "bun:test";
import { CASES, fixtureCase, toolScript, boundaryCommand, procWriteCommand, PLAN_BOUNDARY_RESULT, PROC_WRITE_RESULT, VIEW_RESULT, fixtureProbePaths, type ProbePaths } from "./cases.ts";
import { fixturePermission, fixtureTranscript, hostOptions, hostFailure } from "./host-client.ts";
import { assertLinuxHostQueryConfig } from "../../packages/runtime/src/guest/linux-host-query-profile.ts";
// Pure fixture oracle values, never a Root/native admission or actual kernel view.
const PATHS: ProbePaths = { store: "/tmp/winter-host-query-run-fixture/store", home: "/tmp/winter-host-query-run-fixture/home", control: "/tmp/winter-host-query-run-fixture/control", credential: "/tmp/winter-host-query-run-fixture/host-only-credential", canaryStore: "/tmp/winter-host-query-run-fixture/protected-canary-store", stage: "/tmp/winter-host-query-reviewed-fixture" };
function frames(kind: typeof CASES[number]) {
  return toolScript(kind, PATHS).flatMap((call, index) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: `call-${index}`, ...call }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `call-${index}`, is_error: (kind === "bypass" && index >= 4) || (kind === "plan" && index === 1), denied: kind === "ask-deny" && (index === 1 || index === 2 || index === 3), content: kind === "ask-deny" && index >= 1 && index <= 3 ? "fixed fixture denied" : kind === "plan" && index === 1 ? "Error [read_only]: guest file operation refused" : kind === "plan" && index === 2 ? PLAN_BOUNDARY_RESULT : index === 3 ? PROC_WRITE_RESULT : index === 0 ? "hello\n" : index === 2 ? VIEW_RESULT : "fixture" }] } },
  ]);
}
test("closed fixture cases and bypass callback cannot be relaxed", () => {
  expect(() => fixtureCase("other")).toThrow();
  for (const kind of CASES) {
    const write = toolScript(kind, PATHS)[1]!;
    if (kind === "bypass") expect(() => fixturePermission(kind, write.name, write.input, PATHS)).toThrow();
    else expect(fixturePermission(kind, write.name, write.input, PATHS).behavior).toBe(kind === "ask-allow" || kind === "plan" ? "allow" : "deny");
    expect(() => fixturePermission(kind, "Bash", { command: "different" }, PATHS)).toThrow();
    expect(fixtureTranscript(kind, frames(kind), PATHS).toolCalls).toBe(kind === "bypass" ? 7 : 4);
  }
});
test("tool outcome oracle rejects missing/foreign/error results and changed exact Read/Bash", () => {
  for (const mutate of [
    (data: any[]) => data.pop(), (data: any[]) => { data[1].message.content[0].tool_use_id = "other"; },
    (data: any[]) => { data[1].message.content[0].content = "wrong"; },
    (data: any[]) => { data[3].message.content[0].is_error = true; },
    (data: any[]) => { data[5].message.content[0].content = "not actual Bash output"; },
    (data: any[]) => { data[0].message.content[0].input = { file_path: "other" }; },
  ]) { const data = frames("ask-allow"); mutate(data); expect(() => fixtureTranscript("ask-allow", data, PATHS)).toThrow(); }
});
test("host SDK options never derive native config authority from environment or preapproved tools", () => {
  const config: any = { executionPosture: "confined-guest", sessionId: "backend", model: "model", cwd: "/workspace/folders/source", winterHome: "/run/winter/conversations/logical", storeHome: "/workspace/.winter/conversations/logical", persistSession: true, tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], settingSources: [], skills: [], plugins: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "bypassPermissions", permissions: { disableBypassPermissionsMode: false }, allowDangerouslySkipPermissions: true };
  assertLinuxHostQueryConfig(config); const options = hostOptions(config);
  expect(options.env).toEqual({}); expect(options.allowedTools).toEqual([]); expect(options.permissionMode).toBe("bypassPermissions");
});

test("actual local SDK query/engine callback routing matches fixed allow/deny/plan/bypass cases", async () => {
  const { query, splitFrames } = await import("@yanlinglabs/winter-agent-sdk");
  const { inMemoryProcess } = await import("../../packages/runtime/src/testing.ts");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  for (const kind of CASES) {
    const root = mkdtempSync(join(tmpdir(), "winter-host-case-")), home = join(root, "home"), cwd = join(root, "source"), store = join(root, "store"); for (const path of [home, cwd, store]) mkdirSync(path); let at = 0, callbacks = 0, requests = 0, responses = 0; const observed: unknown[] = [], script = toolScript(kind, PATHS);
    const provider: any = { async generate() { const call = script[at]; return call ? { kind: "tool_use", calls: [{ id: `call-${at++}`, ...call }] } : { kind: "text", text: `host-query-${kind}-complete` }; } };
    const tools: any = { async execute(call: any) { const index = Number(call.id.slice(5)); return { isError: (kind === "bypass" && index >= 4) || (kind === "plan" && index === 1), output: kind === "plan" && index === 1 ? "Error [read_only]: guest file operation refused" : kind === "plan" && index === 2 ? PLAN_BOUNDARY_RESULT : index === 3 ? PROC_WRITE_RESULT : index === 0 ? "hello\n" : index === 2 ? VIEW_RESULT : "fixture" }; } };
    const q = query({ prompt: "fixed local test", options: { model: "winter-test/echo", cwd, env: { WINTER_HOME: home, WINTER_STORE_HOME: store, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" }, persistSession: false, settingSources: [], tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], permissionMode: kind === "bypass" ? "bypassPermissions" : kind === "plan" ? "plan" : "default", permissions: { disableBypassPermissionsMode: kind !== "bypass" }, allowDangerouslySkipPermissions: kind === "bypass",
      canUseTool: async (tool, input) => { callbacks++; return fixturePermission(kind, tool, input, PATHS); },
      spawnClaudeCodeProcess(options) {
        // Explicit local testing leg with injected provider/executor, NEVER a native admission.
        const proc = inMemoryProcess(options.args, provider, tools, { WINTER_HOME: home, WINTER_STORE_HOME: store });
        let inputCarry = "";
        return { ...proc, stdin: { ...proc.stdin, write(chunk) { const split = splitFrames(chunk, inputCarry); inputCarry = split.carry; responses += split.frames.filter(frame => frame.type === "control_response").length; proc.stdin.write(chunk); } }, stdout: (async function* () { let carry = ""; for await (const chunk of proc.stdout) { const split = splitFrames(chunk, carry); carry = split.carry; for (const frame of split.frames) { if (frame.type === "data") observed.push(frame.message); if (frame.type === "control_request") requests++; } yield chunk; } })() };
      },
    } });
    try { for await (const _ of q) {} expect(callbacks).toBe(kind === "bypass" ? 0 : 3); expect(requests).toBe(callbacks); expect(responses).toBe(callbacks); expect(fixtureTranscript(kind, observed, PATHS).toolResults).toBe(script.length); }
    finally { await q.return(undefined); rmSync(root, { recursive: true, force: true }); }
  }
});

test("plan oracle requires independent readonly errors after deliberately allowed callbacks", () => {
  const script = toolScript("plan", PATHS);
  expect(fixturePermission("plan", script[1]!.name, script[1]!.input, PATHS).behavior).toBe("allow");
  expect(fixturePermission("plan", script[2]!.name, script[2]!.input, PATHS).behavior).toBe("allow");
  for (const change of ["permission-denied", "missing-EROFS", "unexpected-success", "missing-proc-EROFS"]) {
    const data = frames("plan") as any[];
    if (change === "permission-denied") { data[3].message.content[0].denied = true; data[3].message.content[0].is_error = false; }
    if (change === "missing-EROFS") data[5].message.content[0].content = VIEW_RESULT;
    if (change === "unexpected-success") data[3].message.content[0].is_error = false;
    if (change === "missing-proc-EROFS") data[7].message.content[0].content = "host-query-proc-device-ok\n[Exit code: 0; cwd changes apply to this command only]";
    expect(() => fixtureTranscript("plan", data, PATHS)).toThrow();
  }
});
test("actual readonly helper error code is distinct from a permission denial and never calls its port", async () => {
  const { createGuestFileHelper, GuestFileHelperError } = await import("../../packages/runtime/src/guest/file-helper.ts");
  const { guestFileError } = await import("../../packages/runtime/src/guest/file-session.ts");
  let effects = 0;
  const helper = createGuestFileHelper({ authority: { workspaceId: "workspace", sessionId: "session", incarnationId: "incarnation", leaseEpoch: 1, configRevision: 1, grantRevision: 1, policyRevision: 1 }, roots: [{ id: "source", guestPath: "/workspace/folders/source", readOnly: true }], expectedUid: 10001, port: { async execute() { effects++; throw new Error("must not reach port"); } } });
  try { await helper.write("source", "approved-write", new Uint8Array([1])); throw new Error("missing refusal"); }
  catch (error) { expect(error).toBeInstanceOf(GuestFileHelperError); expect(guestFileError(error)).toEqual({ output: "Error [read_only]: guest file operation refused", isError: true }); }
  expect(effects).toBe(0);
});

test("host failure diagnostics retain only closed classes/reasons and known errno", () => {
  expect(hostFailure(new Error("fixture callback correlation"))).toEqual({ class: "Error", code: "callback_binding" });
  const error = Object.assign(new Error("secret /foreign/path bearer abc"), { code: "EPIPE" });
  expect(hostFailure(error)).toEqual({ class: "Error", code: "host_failure", errnoCode: "EPIPE" });
  expect(hostFailure({ message: "secret", code: "/private/path" })).toEqual({ class: "NonError", code: "host_failure" });
  expect(hostFailure(null)).toEqual({ class: "NonError", code: "host_failure" });
});

test("actual SDK error diagnostics preserve only bounded process facts and closed result subtypes", async () => {
  const { CLIConnectionError, ProcessError, ProtocolDecodeError, ResultError, AbortError } = await import("@yanlinglabs/winter-agent-sdk");
  for (const error of [new CLIConnectionError("secret /path"), new ProtocolDecodeError("foreign frame"), new AbortError("secret abort")]) expect(hostFailure(error)).toEqual({ class: error.name, code: "host_failure" });
  expect(hostFailure(new ProcessError("foreign output", 77, "SIGTRAP"))).toEqual({ class: "ProcessError", code: "host_failure", processCode: 77, signal: "SIGTRAP" });
  expect(hostFailure(new ProcessError("foreign output", null, null))).toEqual({ class: "ProcessError", code: "host_failure", processCode: null, signal: null });
  for (const code of [-1, 256, 1.5, NaN, Infinity]) expect(hostFailure(new ProcessError("secret", code, "/foreign/signal"))).toEqual({ class: "ProcessError", code: "host_failure" });
  expect(hostFailure(new ResultError({ type: "result", subtype: "error_during_execution", permission_denials: [], is_error: true, result: "secret /path" }))).toEqual({ class: "ResultError", code: "host_failure", resultSubtype: "error_during_execution" });
  expect(hostFailure(new ResultError({ type: "result", subtype: "/foreign/subtype", permission_denials: [], result: "secret" }))).toEqual({ class: "ResultError", code: "host_failure" });
  expect(hostFailure(Object.assign(new Error("secret"), { name: "ProcessError", code: 77, signal: "SIGTRAP" }))).toEqual({ class: "Error", code: "host_failure" });
});

test("Phase A commands remain separate, closed and syntax-only parse without executing bodies", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const kind of CASES) {
    const boundary = boundaryCommand(kind, PATHS), write = procWriteCommand();
    expect(boundary.includes("\n")).toBe(true);
    expect(boundary).toContain("test \"$phase_pid_count\" = 2");
    expect(boundary).toContain("phase_worker_fds");
    expect(boundary).toContain("CapInh:|CapPrm:|CapEff:|CapBnd:|CapAmb:");
    expect(boundary).not.toContain("cgroup");
    expect(write).toContain("/proc/self/comm");
    expect(write).not.toContain("/workspace/.winter");
    expect(write).not.toContain("/run/winter");
    expect(write).not.toContain("/proc/sysrq");
    for (const command of [boundary, write]) expect(spawnSync("/bin/bash", ["-n", "-c", command]).status).toBe(0); // Grammar only: no body/proc/device/mount inspection executes.
  }
  for (const change of ["extra-marker", "wrong-errno", "wrong-exit", "permission-denial", "helper-error"]) {
    const data = frames("bypass") as any[];
    const result = data[7].message.content[0];
    if (change === "extra-marker") result.content = PROC_WRITE_RESULT + "host-query-proc-ro-ok";
    if (change === "wrong-errno") result.content = PROC_WRITE_RESULT.replace("Read-only file system", "Permission denied");
    if (change === "wrong-exit") result.content = PROC_WRITE_RESULT.replace("Exit code: 0", "Exit code: 1");
    if (change === "permission-denial") result.denied = true;
    if (change === "helper-error") result.is_error = true;
    expect(() => fixtureTranscript("bypass", data, PATHS)).toThrow();
  }
});

test("mandatory probe roles bind actual fixed paths and reject missing/foreign/extra metadata", () => {
  expect(fixtureProbePaths(PATHS)).toEqual(PATHS);
  for (const invalid of [undefined, {}, { ...PATHS, store: "" }, { ...PATHS, home: "/tmp/winter-host-query-run-other/home" }, { ...PATHS, stage: "/tmp/../private" }, { ...PATHS, extra: "model" }]) expect(() => fixtureProbePaths(invalid)).toThrow();
  const changed = { ...PATHS, stage: "/tmp/winter-host-query-reviewed-other" };
  expect(boundaryCommand("bypass", PATHS)).not.toBe(boundaryCommand("bypass", changed));
  const call = toolScript("bypass", PATHS)[2]!;
  expect(() => fixtureTranscript("bypass", frames("bypass"), changed)).toThrow();
  expect(call.input.command).toContain(PATHS.stage);
  expect(call.input.command).toContain(PATHS.store);
});

test("generated mandatory-check failures exit before counters even in conditional contexts", async () => {
  const { spawnSync } = await import("node:child_process");
  const generated = boundaryCommand("bypass", PATHS), fail = generated.split("\n")[0]!;
  const snippets = [
    generated.match(/Uid:\|Gid:\) ([^\n]*);;/)![1]!,
    generated.match(/Groups:\) ([^\n]*);;/)![1]!,
    generated.match(/esac; (test -p \"\$phase_fd\"[^\n]*?phase_worker_fds=\$\(\(phase_worker_fds\+1\)\))/)![1]!,
    generated.match(/0\) ([^\n]*?phase_self_fds=\$\(\(phase_self_fds\+1\)\));;/)![1]!,
  ];
  for (const snippet of snippets) {
    // The actual generated guard/counter snippet; test is an inert failing stub.
    // No probe, host/proc/dev path, file read, or native/Root role executes here.
    const command = `${fail}\ntest() { return 1; }\nphase_a=10001; phase_b=10001; phase_c=10001; phase_d=10001; phase_rest=; phase_fd=inert; phase_seen=0; phase_worker_fds=0; phase_self_fds=0;\nphase_checks() { ${snippet}; printf counter-advanced; }\nif phase_checks; then printf unexpected-success; fi`;
    const result = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8" });
    expect(result.status).toBe(90);
    expect(result.stdout).toStartWith("phase-a-check-failed:");
    expect(result.stdout).not.toContain("counter-advanced");
    expect(result.stdout).not.toContain("unexpected-success");
  }
  expect(generated).toContain("shopt -s dotglob nullglob");
  expect(generated).not.toContain("$(cat");
  expect(generated).not.toContain(" | ");
});

test("generated view summary emits actual synthetic counters in the fixed order", async () => {
  const { spawnSync } = await import("node:child_process");
  const line = boundaryCommand("bypass", PATHS).split("\n").find(value => value.startsWith('printf "host-query-view-v2-counts:'))!;
  expect(line).toBeDefined();
  for (const values of [[2,5,3,10,1,1,1,5,3,1], [7,8,9,11,12,13,14,15,16,17]]) {
    const names = ["phase_pid_count", "phase_worker_fds", "phase_self_fds", "phase_dev_count", "phase_proc_mount", "phase_shm_mount", "phase_source_mount", "phase_device_mounts", "phase_env_mounts", "phase_rodata_mounts"];
    // Only the generated printf and inert variable assignments execute, never the probe.
    const command = names.map((name, index) => `${name}=${values[index]}`).join(";") + ";" + line;
    const result = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`host-query-view-v2-counts:${values.join(":")}\n`);
  }
});

test("ask-deny requires exact per-call denial text even with otherwise correct flags", () => {
  expect(fixtureTranscript("ask-deny", frames("ask-deny"), PATHS).toolResults).toBe(4);
  for (const index of [1,2,3]) {
    for (const content of [PROC_WRITE_RESULT, "another denial message"]) {
      const data = frames("ask-deny") as any[];
      data[index*2+1].message.content[0].content = content;
      expect(() => fixtureTranscript("ask-deny", data, PATHS)).toThrow("fixture tool denial content");
    }
  }
});

test("generated mount guards reject first propagation tags and exact protected roots without tmp prefix", async () => {
  const { spawnSync } = await import("node:child_process");
  const generated = boundaryCommand("bypass", PATHS), fail = generated.split("\n")[0]!;
  const propagation = generated.match(/case " \$phase_tail" in .*?esac;/)![0]!;
  const protectedRoots = generated.match(/for phase_protected in .*?done;/)![0]!;
  const evaluate = (tail: string, root: string) => spawnSync("/bin/bash", ["-c", `${fail}\nphase_tail='${tail}'; phase_root='${root}'; ${propagation} ${protectedRoots} printf clean`], { encoding: "utf8" });
  for (const tag of ["shared:3", "master:4", "propagate_from:5"]) {
    const result = evaluate(`${tag} - tmpfs tmpfs rw`, "/");
    expect(result.status).toBe(90);
    expect(result.stdout).toBe("phase-a-check-failed:mount_propagation\n");
  }
  for (const path of Object.values(PATHS)) {
    for (const root of [path, path.slice(4)]) {
      const result = evaluate("- tmpfs tmpfs rw", root);
      expect(result.status).toBe(90);
      expect(result.stdout).toBe("phase-a-check-failed:protected_mount_root\n");
    }
  }
  // Shared run ID itself is legitimate: only the exact protected role suffixes deny.
  for (const root of ["/", "/winter-host-query-run-fixture/source", "/winter-host-query-run-fixture/environment"]) {
    const result = evaluate("- tmpfs tmpfs rw", root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("clean");
  }
});

test("generated environment/data mount guards independently reject missing readonly flags", async () => {
  const { spawnSync } = await import("node:child_process");
  const command = boundaryCommand("bypass", PATHS), lines = command.split("\n");
  const fail = lines.find(line => line.startsWith("phase_fail()"))!;
  for (const [label, prefix, flags] of [["environment_flags", "/bin|/lib|/usr)", ["ro", "nosuid", "nodev"]], ["readonly_data_flags", "/workspace/folders/readonly)", ["ro", "nosuid", "nodev", "noexec"]]] as const) {
    const guard = lines.find(line => line.startsWith(prefix))!.slice(prefix.length).split("; phase_")[0]!;
    for (const missing of [null, ...flags]) {
      const options = flags.filter(flag => flag !== missing).join(",");
      const result = spawnSync("/bin/bash", ["-c", fail + `\nphase_options=${options}\n` + guard], { encoding: "utf8" });
      expect(result.status).toBe(missing === null ? 0 : 90);
      expect(result.stdout).toBe(missing === null ? "" : `phase-a-check-failed:${label}\n`);
    }
  }
});

test("real permission evaluator keeps colocated protected-home writes gated and disjoint inline routing clear", async () => {
  const { evaluate, REAL_SPECIAL_CHECKS, NO_OPINION_HOOK_STAGE, NO_OPINION_AUTO_ENGINE } = await import("../../packages/runtime/src/permissions/evaluator.ts");
  const { emptyRuleSet } = await import("../../packages/runtime/src/permissions/ruleset.ts");
  for (const colocated of [false, true]) {
    let prompts = 0;
    const cwd = "/synthetic/phase-b/source", home = colocated ? cwd : "/synthetic/phase-b/home", store = colocated ? cwd : "/synthetic/phase-b/store";
    const context: EvaluationContext = { policy: { mode: "bypassPermissions", version: 0, rules: emptyRuleSet() }, cwd, sessionRoot: cwd, home: "/synthetic/user", winterHome: home, storeHome: store, trustedWorkspace: false, sessionBypassEnabled: true, hookStage: NO_OPINION_HOOK_STAGE, autoEngine: NO_OPINION_AUTO_ENGINE, specialChecks: REAL_SPECIAL_CHECKS, promptStage: { async prompt(_call, _context, meta) { prompts++; expect(meta.decisionReason).toContain("protected path write"); return null; } } };
    const first = await evaluate({ toolName: "Bash", input: { command: procWriteCommand() } }, context);
    expect(first.decision).toBe("allow"); expect(prompts).toBe(0);
    const combined = await evaluate({ toolName: "Bash", input: toolScript("bypass", PATHS)[3]!.input }, context);
    expect(combined.decision).toBe(colocated ? "deny" : "allow"); expect(prompts).toBe(colocated ? 1 : 0);
  }
});

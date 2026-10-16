// The Linux Workflow worker's fence, proved against the REAL kernel: Landlock, seccomp and
// no_new_privs applied by the launcher role (linux-confinement.ts) and then observed from inside the
// worker. The counterpart of `worker.darwin.test.ts`; the portable half of the policy is tested in
// `linux-confinement-policy.test.ts`, which runs everywhere.
//
// Every case is `test.skipIf`, per this codebase's convention (worker.darwin.test.ts): a run on another
// OS -- or on a Linux kernel that cannot confine -- still ENUMERATES the cases as skipped, and says why.
// CI sets WINTER_REQUIRE_LINUX_CONFINEMENT=1, which turns "this kernel cannot confine" from a skip into a
// failure, so a runner that silently lost Landlock cannot turn this whole file green by skipping it.
//
// Observations are made by the worker itself, as `K <name> <json>` lines, and read back here. A probe
// that dies (a missing syscall in the allow set, a wrong table number) leaves its earlier lines behind,
// so a failure names what the probe had reached.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { LINUX_CONFINEMENT_REFUSED_EXIT_CODE, LinuxConfinementUnavailableError, SELF_ONLY_SIGNAL_SYSCALLS, SYSCALL_NUMBERS, deniedSyscallNames, linuxArchOf } from "./linux-confinement-policy.ts";
import { confineAndExec, linuxConfinementProbe, overrideLinuxConfinementProbeForTest, type Kernel, type SyscallResult } from "./linux-confinement.ts";
import { buildLinuxWorkerSpawn } from "./sandbox.ts";
import { WorkflowRuntime, WorkflowRuntimeError, realWorkerSpawner } from "./runtime.ts";
import { fakeWorkflowRunHost } from "./seam.ts";
import { fakeStructuredOutputSeam } from "../structured/seam.ts";
import { createContextAccountant } from "../engine.ts";

const linux = process.platform === "linux";
const probe = linux ? linuxConfinementProbe() : ({ available: false, reason: "not Linux" } as const);
const available = probe.available;
const required = process.env.WINTER_REQUIRE_LINUX_CONFINEMENT === "1";
const t = test.skipIf(!available);

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const whyThisRun = !linux ? `skipped: Linux only (this is ${process.platform})` : available ? "running" : `skipped: ${probe.available ? "" : probe.reason}`;

describe("the kernel can confine a Workflow worker here", () => {
  // The name carries the reason, so a skipped run says why in the report. Required in CI: there, a
  // kernel that cannot confine fails this case instead of quietly skipping the rest.
  test(`Linux Workflow confinement cases ${whyThisRun}`, () => {
    if (linux && required) expect(probe).toMatchObject({ available: true });
    if (linux && !available) console.warn(`worker.linux.test.ts: confinement cases ${whyThisRun}`);
  });
});

// --- The probe the worker runs against itself --------------------------------------------------------------

const PROBE_SOURCE = String.raw`
import fs from "node:fs";
import net from "node:net";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { dlopen, FFIType, ptr, read } from "bun:ffi";

const P = JSON.parse(process.env.PROBE);
const emit = (name, value) => process.stdout.write("K " + name + " " + JSON.stringify(value) + "\n");
const attempt = (name, fn) => {
  try {
    const value = fn();
    emit(name, { ok: true, value: value === undefined ? null : value });
  } catch (e) {
    emit(name, { ok: false, code: e && e.code ? e.code : String(e) });
  }
};

attempt("readSibling", () => fs.readFileSync(P.sibling, "utf8"));
attempt("readSecret", () => fs.readFileSync(P.secret, "utf8"));
attempt("listRunDir", () => fs.readdirSync(P.runDir).length);
attempt("readParentEnviron", () => fs.readFileSync("/proc/" + process.ppid + "/environ").length);
attempt("listPid1", () => fs.readdirSync("/proc/1").length);
attempt("listOwnTasks", () => fs.readdirSync("/proc/self/task").length);
attempt("readOwnStatus", () => fs.readFileSync("/proc/self/status", "utf8").length);

attempt("createFile", () => fs.writeFileSync(P.newFile, "x"));
attempt("overwriteFile", () => fs.writeFileSync(P.existing, "changed"));
attempt("appendFile", () => fs.appendFileSync(P.existing, "more"));
attempt("mkdir", () => fs.mkdirSync(P.newDir));
attempt("unlink", () => fs.unlinkSync(P.existing));
attempt("rename", () => fs.renameSync(P.existing, P.existing + ".moved"));
attempt("chmod", () => fs.chmodSync(P.existing, 0o777));
attempt("utimes", () => fs.utimesSync(P.existing, new Date(0), new Date(0)));
attempt("symlink", () => fs.symlinkSync("/etc/hostname", P.newLink));
attempt("truncate", () => fs.truncateSync(P.existing, 0));
attempt("devNull", () => fs.writeFileSync("/dev/null", "discarded"));

attempt("killSelf", () => process.kill(process.pid, 0));
attempt("killParent", () => process.kill(process.ppid, 0));
attempt("killInit", () => process.kill(1, 0));
attempt("fork", () => {
  const r = spawnSync("/bin/echo", ["hi"]);
  if (r.error) throw r.error;
  if (r.status !== 0) { const e = new Error("status " + r.status); e.code = "STATUS_" + r.status; throw e; }
  return String(r.stdout);
});

const tryConnect = (opts) => new Promise((resolve) => {
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
  try {
    const s = net.connect(opts);
    s.on("connect", () => { finish({ ok: true }); s.destroy(); });
    s.on("error", (e) => finish({ ok: false, code: e && e.code ? e.code : String(e) }));
  } catch (e) {
    finish({ ok: false, code: e && e.code ? e.code : String(e) });
  }
  setTimeout(() => finish({ ok: false, code: "TIMEOUT" }), 8000);
});
emit("tcp", await tryConnect({ port: P.port, host: "127.0.0.1" }));
emit("unix", await tryConnect({ path: P.socketPath }));

emit("worker", await new Promise((resolve) => {
  const body = 'const { parentPort, workerData } = require("node:worker_threads"); const fs = require("node:fs"); let r; try { fs.writeFileSync(workerData.file, "x"); r = "WROTE"; } catch (e) { r = "DENIED:" + e.code; } parentPort.postMessage(r);';
  try {
    const w = new Worker(body, { eval: true, workerData: { file: P.threadFile } });
    w.on("message", resolve);
    w.on("error", (e) => resolve("ERROR:" + e));
  } catch (e) {
    resolve("ERROR:" + e);
  }
  setTimeout(() => resolve("TIMEOUT"), 20000);
}));

attempt("threads", () => fs.readdirSync("/proc/self/task").map((tid) => {
  const s = fs.readFileSync("/proc/self/task/" + tid + "/status", "utf8");
  return { nnp: (/NoNewPrivs:\s+(\d)/.exec(s) || [])[1], seccomp: (/Seccomp:\s+(\d)/.exec(s) || [])[1], capEff: (/CapEff:\s+([0-9a-f]+)/.exec(s) || [])[1], capPrm: (/CapPrm:\s+([0-9a-f]+)/.exec(s) || [])[1] };
}));

const libc = dlopen("libc.so.6", {
  syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i64_fast },
  execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
});
const errno = () => read.i32(libc.symbols.__errno_location());
const answers = {};
for (const [name, nr] of Object.entries(P.syscalls)) {
  const r = Number(libc.symbols.syscall(nr, 0, 0, 0, 0, 0, 0));
  answers[name] = r === -1 ? errno() : "ret" + r;
}
emit("syscalls", answers);

const cstr = (s) => Buffer.from(s + "\0");
const run = (path, args) => {
  const strings = [path, ...args].map(cstr);
  const argv = new BigUint64Array(strings.length + 1);
  strings.forEach((s, i) => { argv[i] = BigInt(ptr(s)); });
  const env = new BigUint64Array([0n]);
  const rc = libc.symbols.execve(strings[0], argv, env);
  return [rc, errno()];
};
emit("execOther", run("/usr/bin/true", []));
// Exec of the worker's own binary is the one exec the profile keeps; the new image must still be confined.
const reexec = 'const fs = require("node:fs"); const s = fs.readFileSync("/proc/self/status", "utf8"); let w; try { fs.writeFileSync(' + JSON.stringify(P.newFile) + ', "x"); w = "WROTE"; } catch (e) { w = "DENIED:" + e.code; } console.log("K reexec " + JSON.stringify({ seccomp: (/Seccomp:\\s+(\\d)/.exec(s) || [])[1], nnp: (/NoNewPrivs:\\s+(\\d)/.exec(s) || [])[1], write: w }));';
emit("execSelf", run(process.execPath, ["-e", reexec]));
`;

interface ProbeRun {
  status: number | null;
  stderr: string;
  stdout: string;
  k: Record<string, any>;
}

function parseK(stdout: string): Record<string, any> {
  const k: Record<string, any> = {};
  for (const line of stdout.split("\n")) {
    const match = /^K (\S+) (.*)$/.exec(line);
    if (match !== null) k[match[1]!] = JSON.parse(match[2]!);
  }
  return k;
}

function runConfined(args: { file: string; args: string[] }, opts: { home?: string; env?: Record<string, string>; cwd: string; minLandlockAbi?: number; timeoutMs?: number }): ProbeRun {
  const spawn = buildLinuxWorkerSpawn({
    command: args,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
    ...(opts.minLandlockAbi !== undefined ? { minLandlockAbi: opts.minLandlockAbi } : {}),
  });
  const res = spawnSync(spawn.file, spawn.args, { encoding: "utf8", timeout: opts.timeoutMs ?? 120_000, cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) } });
  const stdout = res.stdout ?? "";
  return { status: res.status, stderr: res.stderr ?? "", stdout, k: parseK(stdout) };
}

// --- The confined worker -----------------------------------------------------------------------------------------

describe("a confined worker (real Landlock + seccomp + no_new_privs, observed from inside)", () => {
  // Created only where the cases can run, so a skipped run leaves nothing behind.
  const home = available ? scratch("winter-lc-home-") : "";
  const work = available ? scratch("winter-lc-work-") : "";
  const runDir = join(home, ".winter", "run");
  const secret = join(runDir, "core.token");
  const sibling = join(home, ".winter", "memory", "notes.md");
  const existing = join(work, "existing.txt");
  const files = { newFile: join(work, "created.txt"), threadFile: join(work, "from-thread.txt"), newDir: join(work, "newdir"), newLink: join(work, "link"), existing };
  const server = { tcpConnections: 0, unixConnections: 0 };
  let tcp: ReturnType<typeof createTcpServer> | undefined;
  let unixServer: ReturnType<typeof createTcpServer> | undefined;
  let run: ProbeRun | undefined;
  const syscalls: Record<string, number> = {};

  beforeAll(async () => {
    if (!available) return;
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(home, ".winter", "memory"), { recursive: true });
    writeFileSync(secret, "SECRET");
    writeFileSync(sibling, "READABLE");
    writeFileSync(existing, "original");
    tcp = createTcpServer((socket) => {
      server.tcpConnections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => tcp!.listen(0, "127.0.0.1", resolve));
    const socketPath = join(work, "listener.sock");
    unixServer = createTcpServer((socket) => {
      server.unixConnections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => unixServer!.listen(socketPath, resolve));

    const arch = linuxArchOf(process.arch)!;
    for (const name of [...deniedSyscallNames(), "clone", "clone3", "socketpair", ...SELF_ONLY_SIGNAL_SYSCALLS]) {
      const nr = SYSCALL_NUMBERS[arch][name];
      if (nr !== undefined) syscalls[name] = nr;
    }
    const scriptPath = join(work, "probe.mjs");
    writeFileSync(scriptPath, PROBE_SOURCE);
    run = runConfined(
      { file: process.execPath, args: [scriptPath] },
      {
        home,
        cwd: work,
        env: { PROBE: JSON.stringify({ ...files, sibling, secret, runDir, port: (tcp.address() as AddressInfo).port, socketPath, syscalls }) },
      },
    );
  }, 180_000);

  afterAll(() => {
    tcp?.close();
    unixServer?.close();
    if (available) {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  const k = (): Record<string, any> => {
    if (run === undefined) throw new Error("the probe did not run");
    if (Object.keys(run.k).length === 0) throw new Error(`the confined probe produced no observations (status ${run.status}): ${run.stderr.slice(-2000)}`);
    return run.k;
  };
  const denied = (name: string): void => {
    const observation = k()[name];
    expect({ name, observation: observation ?? "missing" }).toMatchObject({ observation: { ok: false } });
    expect(["EACCES", "EPERM"]).toContain(observation.code);
  };

  t("the worker starts: the launcher confined itself and then exec'd it, and it reports its own observations", () => {
    expect(run?.status).toBe(0);
    expect(Object.keys(k()).length).toBeGreaterThan(20);
  });

  t("reads: an allowed path (a sibling of the withheld directory) is readable", () => {
    expect(k().readSibling).toEqual({ ok: true, value: "READABLE" });
    expect(k().readOwnStatus.ok).toBe(true);
  });

  t("reads: the withheld run directory can be neither read nor listed", () => {
    denied("readSecret");
    denied("listRunDir");
  });

  t("reads: another process's /proc entry -- its environment, secrets included -- cannot be read or listed; this process's own can", () => {
    denied("readParentEnviron");
    denied("listPid1");
    expect(k().listOwnTasks.ok).toBe(true);
  });

  t("writes: creating, overwriting, appending, mkdir, unlink, rename, chmod, utimes, symlink and truncate are all denied", () => {
    for (const name of ["createFile", "overwriteFile", "appendFile", "mkdir", "unlink", "rename", "chmod", "utimes", "symlink", "truncate"]) denied(name);
    // And the filesystem agrees with the worker.
    expect(readFileSync(existing, "utf8")).toBe("original");
    expect(existsSync(files.newFile)).toBe(false);
    expect(existsSync(files.newDir)).toBe(false);
    expect(existsSync(files.newLink)).toBe(false);
    expect(existsSync(`${existing}.moved`)).toBe(false);
  });

  t("writes: /dev/null stays writable, as in the macOS profile", () => {
    expect(k().devNull.ok).toBe(true);
  });

  t("network: TCP and unix-domain connections are denied, and the listeners never saw a connection", () => {
    expect(k().tcp.ok).toBe(false);
    expect(k().unix.ok).toBe(false);
    expect(server).toEqual({ tcpConnections: 0, unixConnections: 0 });
  });

  t("processes: it cannot fork, cannot exec another program, and exec of its own binary stays confined", () => {
    expect(k().fork.ok).toBe(false);
    expect(k().execOther[0]).toBe(-1);
    expect(run!.stdout).toContain("K reexec ");
    expect(parseK(run!.stdout).reexec).toEqual({ seccomp: "2", nnp: "1", write: "DENIED:EACCES" });
  });

  t("signals: it may signal itself, never its parent or any other process", () => {
    expect(k().killSelf.ok).toBe(true);
    denied("killParent");
    denied("killInit");
  });

  t("privilege: no_new_privs and the seccomp filter are on EVERY thread, and no thread holds a capability", () => {
    const threads = k().threads.value as Array<{ nnp: string; seccomp: string; capEff: string; capPrm: string }>;
    expect(threads.length).toBeGreaterThan(1);
    for (const thread of threads) expect(thread).toEqual({ nnp: "1", seccomp: "2", capEff: "0000000000000000", capPrm: "0000000000000000" });
  });

  t("threads: a thread created after the confinement is confined too (the filesystem fence is not per-thread)", () => {
    expect(k().worker).toBe("DENIED:EACCES");
    expect(existsSync(files.threadFile)).toBe(false);
  });

  t("the deny list holds on this kernel and architecture: every denied syscall answers EPERM through the raw syscall, clone3 answers ENOSYS", () => {
    const answers = k().syscalls as Record<string, number | string>;
    const expected: Record<string, number | string> = {};
    for (const name of Object.keys(syscalls)) expected[name] = name === "clone3" ? 38 : 1;
    expect(answers).toEqual(expected);
    expect(Object.keys(answers).length).toBeGreaterThan(70);
  });
});

// --- Anonymous-file exec ------------------------------------------------------------------------------------------------
//
// Landlock's EXECUTE right is path-based; a file made with memfd_create has no path in any mounted
// filesystem. The macOS profile allows exec of the worker's own binary and nothing else, so this asks
// the kernel directly whether a copy of another program, written into an anonymous file, can be run.

const MEMFD_PROBE_SOURCE = String.raw`
import fs from "node:fs";
import { dlopen, FFIType, ptr, read } from "bun:ffi";
const P = JSON.parse(process.env.PROBE);
const emit = (name, value) => process.stdout.write("K " + name + " " + JSON.stringify(value) + "\n");
const libc = dlopen("libc.so.6", {
  syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i64_fast },
  execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
});
const errno = () => read.i32(libc.symbols.__errno_location());
const name = Buffer.from("probe\0");
const fd = Number(libc.symbols.syscall(P.memfdCreate, ptr(name), 0, 0, 0, 0, 0));
emit("memfdCreate", fd === -1 ? { ok: false, errno: errno() } : { ok: true });
if (fd >= 0) {
  fs.writeSync(fd, fs.readFileSync("/usr/bin/true"));
  const path = Buffer.from("/proc/self/fd/" + fd + "\0");
  const argv = new BigUint64Array([BigInt(ptr(path)), 0n]);
  const env = new BigUint64Array([0n]);
  const rc = libc.symbols.execve(path, argv, env);
  emit("memfdExec", [rc, errno()]);
}
emit("done", 1);
`;

describe("an anonymous file cannot be used to run another program", () => {
  const work = available ? scratch("winter-lc-memfd-") : "";
  afterAll(() => {
    if (available) rmSync(work, { recursive: true, force: true });
  });

  t("either memfd_create is refused, or the exec of its contents is -- the process is never replaced by the copy", () => {
    const arch = linuxArchOf(process.arch)!;
    const script = join(work, "memfd-probe.mjs");
    writeFileSync(script, MEMFD_PROBE_SOURCE);
    const res = runConfined({ file: process.execPath, args: [script] }, { cwd: work, env: { PROBE: JSON.stringify({ memfdCreate: SYSCALL_NUMBERS[arch].memfd_create }) } });
    // `done` is printed only if the exec did NOT replace the probe with the copy of `true`.
    expect({ done: res.k.done, stderr: res.stderr.slice(-500) }).toMatchObject({ done: 1 });
    if (res.k.memfdCreate.ok) expect(res.k.memfdExec[0]).toBe(-1);
  }, 120_000);
});

// --- Refusals: the worker never runs unconfined --------------------------------------------------------------------------

describe("the launcher refuses, and the worker it names never runs", () => {
  const work = available ? scratch("winter-lc-refuse-") : "";
  const sentinel = join(work, "ran");
  afterAll(() => {
    if (available) rmSync(work, { recursive: true, force: true });
  });
  const witness = (): { file: string; args: string[] } => ({ file: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran")`] });

  t("a kernel older than the requested ABI is refused with 77 and an explanation", () => {
    const res = runConfined(witness(), { cwd: work, minLandlockAbi: 60 });
    expect(res.status).toBe(LINUX_CONFINEMENT_REFUSED_EXIT_CODE);
    expect(res.stderr).toContain("linux workflow confinement is not in effect");
    expect(res.stderr).toContain("older than the ABI 60");
    expect(existsSync(sentinel)).toBe(false);
  });

  t("a worker that is not an ELF executable is refused", () => {
    const script = join(work, "worker.sh");
    writeFileSync(script, "#!/bin/sh\necho ran > " + JSON.stringify(sentinel) + "\n");
    chmodSync(script, 0o755);
    const res = runConfined({ file: script, args: [] }, { cwd: work });
    expect(res.status).toBe(LINUX_CONFINEMENT_REFUSED_EXIT_CODE);
    expect(res.stderr).toContain("not an ELF");
    expect(existsSync(sentinel)).toBe(false);
  });

  t("a worker that does not exist is refused", () => {
    const res = runConfined({ file: join(work, "no-such-worker"), args: [] }, { cwd: work });
    expect(res.status).toBe(LINUX_CONFINEMENT_REFUSED_EXIT_CODE);
    expect(res.stderr).toContain("cannot be read");
  });

  // A fake kernel that ACCEPTS every call and enforces nothing: the launcher must notice from the inside
  // and refuse, rather than trust the return values. Nothing real is applied to this process.
  function pretendKernel(failing?: (name: string, args: unknown[]) => boolean): Kernel & { execs: string[]; calls: string[] } {
    const execs: string[] = [];
    const calls: string[] = [];
    return {
      arch: linuxArchOf(process.arch)!,
      execs,
      calls,
      call(name: string, ...args: any[]): SyscallResult {
        calls.push(name);
        if (failing?.(name, args)) return { ret: -1, errno: 13 };
        if (name === "landlock_create_ruleset") return args[2] === 1 ? { ret: 5, errno: 0 } : { ret: openRealDescriptor(), errno: 0 };
        return { ret: 0, errno: 0 };
      },
      address: () => 0,
      openPath: () => openRealDescriptor(),
      execve(file: string) {
        execs.push(file);
        return 0;
      },
    };
  }
  const openRealDescriptor = (): number => openSync("/dev/null", "r");
  const spec = (): Parameters<typeof confineAndExec>[0] => ({ version: 1, target: { file: process.execPath, args: [] }, readDeny: [], minLandlockAbi: 3 });

  t("a kernel that accepts every call but enforces nothing is caught by the launcher's own checks, and nothing is exec'd", () => {
    const kernel = pretendKernel();
    expect(() => confineAndExec(spec(), kernel)).toThrow(/not enforcing/);
    expect(kernel.execs).toEqual([]);
  });

  t.each([
    ["no_new_privs", (name: string, args: unknown[]) => name === "prctl" && args[0] === 38],
    ["the capability read", (name: string) => name === "capget"],
    ["the core-dump limit", (name: string) => name === "prlimit64"],
    ["the Landlock ruleset", (name: string, args: unknown[]) => name === "landlock_create_ruleset" && args[2] === 0],
    ["a required Landlock rule", (name: string) => name === "landlock_add_rule"],
    ["Landlock enforcement", (name: string) => name === "landlock_restrict_self"],
    ["the seccomp filter", (name: string, args: unknown[]) => name === "seccomp" && args[0] === 1],
  ] as Array<[string, (name: string, args: unknown[]) => boolean]>)("a failure of %s stops the launch before any exec", (_label, failing) => {
    const kernel = pretendKernel(failing);
    expect(() => confineAndExec(spec(), kernel)).toThrow(LinuxConfinementUnavailableError);
    expect(kernel.execs).toEqual([]);
  });
});

// --- Through the Workflow runtime -------------------------------------------------------------------------------------------

describe("the Workflow tool on Linux", () => {
  function rig(): { winterHome: string; sessionTempDir: string; runtime: WorkflowRuntime; host: ReturnType<typeof fakeWorkflowRunHost> } {
    const winterHome = scratch("winter-lc-e2e-home-");
    const sessionTempDir = scratch("winter-lc-e2e-temp-");
    const runtime = new WorkflowRuntime({
      session: { winterHome, projectKey: "-e2e", sessionTempDir, structured: fakeStructuredOutputSeam(), accountant: createContextAccountant({ limit: 100_000 }) },
      spawnWorker: realWorkerSpawner(),
      requireSandbox: true,
    });
    const host = fakeWorkflowRunHost({ structured: fakeStructuredOutputSeam(), accountant: createContextAccountant({ limit: 100_000 }) });
    return { winterHome, sessionTempDir, runtime, host };
  }
  const launchInput = (sessionTempDir: string, source: string, name: string) => ({
    sessionId: `lc-${name}`,
    cwd: sessionTempDir,
    trustedWorkspace: false,
    parentToolUseId: "tooluse-lc",
    source,
    meta: { name, description: "d" },
  });

  test.skipIf(!linux)("an unavailable confinement refuses the launch with the typed error, before anything is created or started", () => {
    const winterHome = scratch("winter-lc-unavail-home-");
    const sessionTempDir = scratch("winter-lc-unavail-temp-");
    const restore = overrideLinuxConfinementProbeForTest({ available: false, reason: "this kernel has no Landlock" });
    try {
      // The DEFAULT spawner and the default availability check: nothing here is injected away.
      const runtime = new WorkflowRuntime({ session: { winterHome, projectKey: "-e2e", sessionTempDir, structured: fakeStructuredOutputSeam(), accountant: createContextAccountant({ limit: 100_000 }) } });
      const host = fakeWorkflowRunHost({ structured: fakeStructuredOutputSeam(), accountant: createContextAccountant({ limit: 100_000 }) });
      let thrown: unknown;
      try {
        runtime.launch(launchInput(sessionTempDir, `export const meta = { name: "x", description: "d" };\nreturn 1;`, "x"), host);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkflowRuntimeError);
      expect((thrown as WorkflowRuntimeError).code).toBe("sandbox-unavailable");
      expect((thrown as WorkflowRuntimeError).message).toContain("this kernel has no Landlock");
      expect((thrown as WorkflowRuntimeError).message).toContain("never run unconfined");
      expect(readdirSync(winterHome)).toEqual([]);
      expect(readdirSync(sessionTempDir)).toEqual([]);
    } finally {
      restore();
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(sessionTempDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!linux)("the production spawner refuses on its own too, so a runtime that skips the launch-time check still cannot start a worker unconfined", () => {
    const restore = overrideLinuxConfinementProbeForTest({ available: false, reason: "seccomp filters with the needed actions are unavailable on this kernel" });
    try {
      let thrown: unknown;
      try {
        realWorkerSpawner()({ file: process.execPath, args: ["-e", "0"] }, { cwd: tmpdir() });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkflowRuntimeError);
      expect((thrown as WorkflowRuntimeError).code).toBe("sandbox-unavailable");
    } finally {
      restore();
    }
  });

  t("a real workflow completes through the real spawner, under the real confinement", async () => {
    const { winterHome, sessionTempDir, runtime, host } = rig();
    const source = `export const meta = { name: "e2e", description: "d" };\nphase("Go"); log("running"); return { sum: 1 + 1 };`;
    const launched = runtime.launch(launchInput(sessionTempDir, source, "e2e"), host);
    try {
      const view = await runtime.await(launched.runId);
      expect({ status: view.status, detail: view.status === "completed" ? view.result : view.error }).toEqual({ status: "completed", detail: JSON.stringify({ sum: 2 }) });
    } finally {
      runtime.killWorkerForTest(launched.runId);
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(sessionTempDir, { recursive: true, force: true });
    }
  }, 120_000);

  t("a script that gets past the JS-level guards (the documented Function-constructor route) is still stopped by the kernel", async () => {
    const { winterHome, sessionTempDir, runtime, host } = rig();
    mkdirSync(join(winterHome, "run"), { recursive: true });
    writeFileSync(join(winterHome, "run", "core.token"), "SECRET");
    const target = join(sessionTempDir, "should-not-exist.txt");
    const source = [
      `export const meta = { name: "escape", description: "d" };`,
      `const kw = "imp" + "ort";`,
      `const load = (function () {}).constructor("return " + kw + "('node:fs')");`,
      `const fs = await load();`,
      `const attempt = (fn) => { try { fn(); return "ALLOWED"; } catch (e) { return "DENIED:" + e.code; } };`,
      `return {`,
      `  write: attempt(() => fs.writeFileSync(${JSON.stringify(target)}, "pwned")),`,
      `  secret: attempt(() => fs.readFileSync(${JSON.stringify(join(winterHome, "run", "core.token"))}, "utf8")),`,
      `  read: attempt(() => fs.readFileSync("/etc/passwd", "utf8")),`,
      `};`,
    ].join("\n");
    const launched = runtime.launch(launchInput(sessionTempDir, source, "escape"), host);
    try {
      const view = await runtime.await(launched.runId);
      expect({ status: view.status, detail: view.status === "completed" ? view.result : view.error }).toEqual({
        status: "completed",
        detail: JSON.stringify({ write: "DENIED:EACCES", secret: "DENIED:EACCES", read: "ALLOWED" }),
      });
      expect(existsSync(target)).toBe(false);
      expect(statSync(sessionTempDir).isDirectory()).toBe(true);
    } finally {
      runtime.killWorkerForTest(launched.runId);
      rmSync(winterHome, { recursive: true, force: true });
      rmSync(sessionTempDir, { recursive: true, force: true });
    }
  }, 120_000);
});

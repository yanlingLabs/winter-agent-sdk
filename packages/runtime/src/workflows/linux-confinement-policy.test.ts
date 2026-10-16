// The portable half of the Linux Workflow confinement: everything here is a pure function of its
// inputs (or of a scratch directory tree), so it runs on every OS -- including the macOS developer
// box, where the kernel-facing half cannot run. The kernel itself is exercised in
// `worker.linux.test.ts`, which only runs on Linux.
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DENIED_SYSCALLS,
  FCNTL_DENIED_COMMANDS,
  IOCTL_DENIED_REQUESTS,
  LANDLOCK_FS,
  LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET,
  LANDLOCK_SCOPE_SIGNAL,
  LINUX_CONFINE_ARGV_FLAG,
  LINUX_CONFINEMENT_REFUSED_EXIT_CODE,
  LINUX_MIN_LANDLOCK_ABI,
  LinuxConfinementUnavailableError,
  SELF_ONLY_SIGNAL_SYSCALLS,
  SELF_OR_ZERO_ARG0_SYSCALLS,
  SELF_OR_ZERO_ARG1_SYSCALLS,
  SYSCALL_NUMBERS,
  buildSeccompProgram,
  canonicalDenyPath,
  decodeConfinementSpec,
  deniedSyscallNames,
  encodeConfinementSpec,
  landlockHandledRights,
  landlockRulesetAttr,
  parseElfHead,
  planReadAllow,
  type LinuxArch,
  type LinuxConfinementSpec,
} from "./linux-confinement-policy.ts";
import { execConfinedWorker, probeKernel, type Kernel, type SyscallResult } from "./linux-confinement.ts";
import { WORKFLOW_SANDBOX_REFUSED_EXIT_CODE } from "./runtime.ts";
import {
  buildLinuxWorkerSpawn,
  linuxLauncherProblem,
  linuxWorkerReadDeny,
  resolveConfinementLauncher,
  setHostLinuxConfinementLauncher,
  setHostWorkflowWorkerCommand,
  workflowSandboxAvailable,
  workflowSandboxUnavailableMessage,
} from "./sandbox.ts";
import { overrideLinuxConfinementProbeForTest } from "./linux-confinement.ts";

const MAIN_PATH = fileURLToPath(new URL("../main.ts", import.meta.url));

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// --- The spec the parent hands the launcher -------------------------------------------------------------

describe("the confinement spec (parent -> launcher)", () => {
  const spec: LinuxConfinementSpec = { version: 1, target: { file: "/opt/winter/bin/winter", args: ["__workflow-worker", "--bridge"] }, readDeny: ["/home/u/.winter/run"], minLandlockAbi: 3 };
  const forge = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

  test("round-trips", () => {
    expect(decodeConfinementSpec(encodeConfinementSpec(spec))).toEqual(spec);
  });

  test("the encoded form never contains the worker flag as an argv element of its own", () => {
    // A host whose main routes any argv containing `__workflow-worker` to its own worker must not
    // see that element on the launcher's command line.
    expect(encodeConfinementSpec(spec)).not.toBe("__workflow-worker");
    expect(encodeConfinementSpec(spec)).not.toContain(" ");
  });

  test("refuses everything that is not exactly a spec", () => {
    const refused = (text: string | undefined): void => {
      expect(() => decodeConfinementSpec(text)).toThrow(LinuxConfinementUnavailableError);
    };
    refused(undefined);
    refused("");
    refused("!!!not base64 json!!!");
    refused(forge("a string"));
    refused(forge([]));
    refused(forge({ ...spec, version: 2 }));
    refused(forge({ ...spec, target: { file: "relative/winter", args: [] } }));
    refused(forge({ ...spec, target: { file: "/bin/x\0y", args: [] } }));
    refused(forge({ ...spec, target: { file: "/bin/x", args: [1] } }));
    refused(forge({ ...spec, target: { file: "/bin/x" } }));
    refused(forge({ ...spec, readDeny: ["relative"] }));
    refused(forge({ ...spec, readDeny: "/abs" }));
    refused(forge({ ...spec, minLandlockAbi: "3" }));
    refused(forge({ ...spec, minLandlockAbi: 3.5 }));
    refused(forge({ ...spec, minLandlockAbi: 99999 }));
  });

  test("the refusal exit code is the one the runtime already reports as 'sandbox not in effect'", () => {
    expect(LINUX_CONFINEMENT_REFUSED_EXIT_CODE).toBe(WORKFLOW_SANDBOX_REFUSED_EXIT_CODE);
  });
});

// --- The parent's spawn builder --------------------------------------------------------------------------------

describe("buildLinuxWorkerSpawn", () => {
  const command = { file: "/opt/winter/bin/winter", args: ["__workflow-worker", "--bridge"] };
  const launcher = { file: "/opt/winter/bin/winter", args: [] };
  const specOf = (spawn: { file: string; args: string[] }): LinuxConfinementSpec => decodeConfinementSpec(spawn.args[spawn.args.indexOf(LINUX_CONFINE_ARGV_FLAG) + 1]);

  test("runs the launcher, not the worker, and carries the worker as data", () => {
    const spawn = buildLinuxWorkerSpawn({ command, launcher, home: "/home/synthetic" });
    expect(spawn.file).toBe("/opt/winter/bin/winter");
    expect(spawn.args).toHaveLength(2);
    expect(spawn.args[0]).toBe(LINUX_CONFINE_ARGV_FLAG);
    expect(spawn.args).not.toContain("__workflow-worker");
    expect(specOf(spawn).target).toEqual(command);
  });

  test("denies the same two run directories the macOS profile does, and only when told the home", () => {
    expect(specOf(buildLinuxWorkerSpawn({ command, launcher, home: "/home/synthetic" })).readDeny).toEqual(["/home/synthetic/.winter/run"]);
    expect(specOf(buildLinuxWorkerSpawn({ command, launcher })).readDeny).toEqual([]);
    expect(specOf(buildLinuxWorkerSpawn({ command, launcher, home: "/home/synthetic", winterHome: "/srv/custom" })).readDeny).toEqual(["/home/synthetic/.winter/run", "/srv/custom/run"]);
    // A resolved root that IS <home>/.winter adds nothing beyond the literal deny.
    expect(specOf(buildLinuxWorkerSpawn({ command, launcher, home: "/home/synthetic", winterHome: "/home/synthetic/.winter" })).readDeny).toEqual(["/home/synthetic/.winter/run"]);
    expect(linuxWorkerReadDeny({ home: "/h", brand: { homeDirName: ".other", projectDirName: ".other-project" } })).toEqual(["/h/.other/run"]);
  });

  test("the ABI floor can be raised but never lowered", () => {
    expect(specOf(buildLinuxWorkerSpawn({ command, launcher })).minLandlockAbi).toBe(LINUX_MIN_LANDLOCK_ABI);
    expect(specOf(buildLinuxWorkerSpawn({ command, launcher, minLandlockAbi: 1 })).minLandlockAbi).toBe(LINUX_MIN_LANDLOCK_ABI);
    expect(specOf(buildLinuxWorkerSpawn({ command, launcher, minLandlockAbi: 7 })).minLandlockAbi).toBe(7);
  });

  test("the launcher is this binary: compiled -> the binary alone; dev -> bun plus main.ts; a host may name its own", () => {
    expect(resolveConfinementLauncher({ compiled: true, execPath: "/usr/local/bin/winter" })).toEqual({ file: "/usr/local/bin/winter", args: [] });
    const dev = resolveConfinementLauncher({ compiled: false, execPath: "/usr/local/bin/bun" });
    expect(dev.file).toBe("/usr/local/bin/bun");
    expect(dev.args).toEqual([MAIN_PATH]);
    const restore = setHostLinuxConfinementLauncher({ file: "/opt/host/winter-core", args: ["--launcher"] });
    try {
      expect(resolveConfinementLauncher()).toEqual({ file: "/opt/host/winter-core", args: ["--launcher"] });
      // Stating either field bypasses the host's launcher, as for the worker command.
      expect(resolveConfinementLauncher({ compiled: true, execPath: "/x/winter" })).toEqual({ file: "/x/winter", args: [] });
    } finally {
      restore();
    }
    expect(resolveConfinementLauncher({ compiled: true, execPath: "/x/winter" }).file).toBe("/x/winter");
  });
});

// --- Availability and the typed refusal ----------------------------------------------------------------------------

describe("availability and the refusal text", () => {
  test("macOS is exactly what it was: sandbox-exec, with the original message", () => {
    if (process.platform !== "darwin") return;
    expect(workflowSandboxAvailable()).toBe(true);
    expect(workflowSandboxUnavailableMessage()).toBe("workflows are unavailable: /usr/bin/sandbox-exec was not found, and a workflow worker is never run unsandboxed (WS-12 §3)");
  });

  test.skipIf(process.platform !== "linux")("on Linux an unavailable kernel makes the Workflow unavailable, with the reason in the message", () => {
    const restore = overrideLinuxConfinementProbeForTest({ available: false, reason: "Landlock ABI 2 is older than the ABI 3 the Workflow requires" });
    try {
      expect(workflowSandboxAvailable()).toBe(false);
      const message = workflowSandboxUnavailableMessage();
      expect(message).toContain("Landlock ABI 2 is older");
      expect(message).toContain("never run unconfined");
    } finally {
      restore();
    }
  });
});

// --- The probe, against a fake kernel -------------------------------------------------------------------------------------

function fakeKernel(behaviour: { landlock?: SyscallResult; seccomp?: SyscallResult; prctl?: SyscallResult } = {}): Kernel & { calls: string[] } {
  const calls: string[] = [];
  return {
    arch: "x64",
    calls,
    call(name: string): SyscallResult {
      calls.push(name);
      if (name === "landlock_create_ruleset") return behaviour.landlock ?? { ret: 4, errno: 0 };
      if (name === "seccomp") return behaviour.seccomp ?? { ret: 0, errno: 0 };
      if (name === "prctl") return behaviour.prctl ?? { ret: 0, errno: 0 };
      return { ret: 0, errno: 0 };
    },
    address: () => 0,
    openPath: () => 3,
    execve: () => 0,
  };
}

describe("probeKernel", () => {
  test("a kernel with Landlock >= 3, seccomp and no_new_privs is available", () => {
    expect(probeKernel(fakeKernel({ landlock: { ret: 3, errno: 0 } }))).toEqual({ available: true, arch: "x64", landlockAbi: 3 });
  });

  test("each missing piece is a distinct, explained refusal", () => {
    const why = (kernel: Kernel): string => {
      const result = probeKernel(kernel);
      expect(result.available).toBe(false);
      return result.available ? "" : result.reason;
    };
    expect(why(fakeKernel({ landlock: { ret: -1, errno: 38 } }))).toContain("no Landlock");
    expect(why(fakeKernel({ landlock: { ret: -1, errno: 95 } }))).toContain("disabled");
    expect(why(fakeKernel({ landlock: { ret: -1, errno: 1 } }))).toContain("refused");
    expect(why(fakeKernel({ landlock: { ret: 2, errno: 0 } }))).toContain("ABI 2 is older than the ABI 3");
    expect(why(fakeKernel({ seccomp: { ret: -1, errno: 22 } }))).toContain("seccomp");
    expect(why(fakeKernel({ prctl: { ret: -1, errno: 22 } }))).toContain("no_new_privs");
  });

  test("a launch can demand a higher ABI than the floor, and the floor cannot be lowered", () => {
    expect(probeKernel(fakeKernel({ landlock: { ret: 4, errno: 0 } }), 99).available).toBe(false);
    expect(probeKernel(fakeKernel({ landlock: { ret: 2, errno: 0 } }), 1).available).toBe(false);
  });
});

// --- The launcher door in main.ts: it fails closed on every OS ------------------------------------------------------------

describe("main.ts's `__linux-confine` door", () => {
  const marker = join(tmpdir(), `winter-confine-door-${process.pid}-ran`);
  const run = (args: string[]): { status: number | null; stderr: string; stdout: string } => {
    const res = spawnSync(process.execPath, [MAIN_PATH, ...args], { encoding: "utf8", timeout: 60_000 });
    return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
  };

  test("a missing or garbled spec exits 77 and starts nothing", () => {
    for (const args of [[LINUX_CONFINE_ARGV_FLAG], [LINUX_CONFINE_ARGV_FLAG, "garbage"]]) {
      const res = run(args);
      expect(res.status).toBe(LINUX_CONFINEMENT_REFUSED_EXIT_CODE);
      expect(res.stderr).toContain("linux workflow confinement is not in effect");
    }
  });

  test.skipIf(process.platform === "linux")("off Linux a perfectly good spec is refused, and the worker it names never runs", () => {
    const spec = encodeConfinementSpec({
      version: 1,
      target: { file: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] },
      readDeny: [],
      minLandlockAbi: LINUX_MIN_LANDLOCK_ABI,
    });
    const res = run([LINUX_CONFINE_ARGV_FLAG, spec]);
    expect(res.status).toBe(LINUX_CONFINEMENT_REFUSED_EXIT_CODE);
    expect(res.stderr).toContain("does not apply");
    expect(existsSync(marker)).toBe(false);
  });
});

// --- The seccomp program, interpreted ------------------------------------------------------------------------------------------

const AUDIT_ARCH: Record<LinuxArch, number> = { x64: 0xc000003e, arm64: 0xc00000b7 };
const RET_ALLOW = 0x7fff0000;
const RET_KILL = 0x80000000;
const RET_EPERM = 0x00050001;
const RET_ENOSYS = 0x00050000 | 38;

/** A classic-BPF interpreter for the instructions the program uses, run against a `seccomp_data`. */
function runProgram(program: Buffer, input: { arch: number; nr: number; args?: Array<number | bigint> }): number {
  const data = Buffer.alloc(64);
  data.writeInt32LE(input.nr, 0);
  data.writeUInt32LE(input.arch, 4);
  (input.args ?? []).forEach((value, index) => data.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)), 16 + 8 * index));
  let a = 0;
  let pc = 0;
  for (let steps = 0; steps < 10_000; steps++) {
    if (pc * 8 >= program.length) throw new Error("fell off the program");
    const code = program.readUInt16LE(pc * 8);
    const jt = program.readUInt8(pc * 8 + 2);
    const jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) {
      a = data.readUInt32LE(k);
      pc += 1;
    } else if (code === 0x15) {
      pc += 1 + (a === k ? jt : jf);
    } else if (code === 0x35) {
      pc += 1 + (a >= k ? jt : jf);
    } else if (code === 0x45) {
      pc += 1 + ((a & k) !== 0 ? jt : jf);
    } else if (code === 0x54) {
      a = (a & k) >>> 0;
      pc += 1;
    } else if (code === 0x06) {
      return k;
    } else {
      throw new Error(`unexpected opcode 0x${code.toString(16)}`);
    }
  }
  throw new Error("program did not terminate");
}

const BASIC_ALLOWED: Record<LinuxArch, Record<string, number>> = {
  x64: { read: 0, write: 1, openat: 257, mmap: 9, futex: 202, epoll_wait: 232, exit_group: 231, mprotect: 10, getrandom: 318, execve: 59 },
  arm64: { read: 63, write: 64, openat: 56, mmap: 222, futex: 98, epoll_pwait: 22, exit_group: 94, mprotect: 226, getrandom: 278, execve: 221 },
};

const CLONE_THREAD_FLAGS = 0x00010000 | 0x00000100 | 0x00000800 | 0x00000200 | 0x00000400 | 0x00040000 | 0x00200000 | 0x00400000;

describe.each(["x64", "arm64"] as const)("the seccomp program (%s)", (arch) => {
  const PID = 4242;
  const program = buildSeccompProgram(arch, PID);
  const decide = (nr: number, args: Array<number | bigint> = []): number => runProgram(program, { arch: AUDIT_ARCH[arch], nr, args });
  const numbers = SYSCALL_NUMBERS[arch];

  test("is a well-formed program: whole instructions, within the kernel's size limit", () => {
    expect(program.length % 8).toBe(0);
    expect(program.length / 8).toBeLessThanOrEqual(4096);
    expect(program.length / 8).toBeGreaterThan(50);
  });

  test("a foreign architecture is killed, never interpreted", () => {
    expect(runProgram(program, { arch: 0x40000003, nr: 1 })).toBe(RET_KILL); // AUDIT_ARCH_I386
    expect(runProgram(program, { arch: arch === "x64" ? AUDIT_ARCH.arm64 : AUDIT_ARCH.x64, nr: 1 })).toBe(RET_KILL);
  });

  test.skipIf(arch !== "x64")("the x32 syscall range is killed", () => {
    expect(decide(0x40000000 + 1)).toBe(RET_KILL);
  });

  test("everything on the deny list answers EPERM", () => {
    const missing: string[] = [];
    for (const name of deniedSyscallNames()) {
      const nr = numbers[name];
      if (nr === undefined) {
        missing.push(name);
        continue;
      }
      expect({ name, result: decide(nr) }).toEqual({ name, result: RET_EPERM });
    }
    // Only calls the architecture does not have may be absent, and arm64 is the only one that lacks any.
    if (arch === "x64") expect(missing).toEqual([]);
    expect(deniedSyscallNames().length - missing.length).toBeGreaterThan(60);
  });

  test("network: socket in every domain, connect and bind are denied; socketpair only for AF_UNIX", () => {
    for (const domain of [0, 1, 2, 10, 16, 17]) expect(decide(numbers.socket!, [domain, 1, 0])).toBe(RET_EPERM);
    expect(decide(numbers.connect!, [3, 0, 16])).toBe(RET_EPERM);
    expect(decide(numbers.bind!, [3, 0, 16])).toBe(RET_EPERM);
    expect(decide(numbers.socketpair!, [1, 1, 0])).toBe(RET_ALLOW);
    expect(decide(numbers.socketpair!, [2, 1, 0])).toBe(RET_EPERM);
    expect(decide(numbers.socketpair!, [0, 1, 0])).toBe(RET_EPERM);
  });

  test("io_uring (which would bypass seccomp for socket/connect) is denied", () => {
    for (const name of DENIED_SYSCALLS.asyncIo!) expect(decide(numbers[name]!)).toBe(RET_EPERM);
  });

  test("clone: a thread is allowed; a new process or any namespace is not; clone3 is ENOSYS so libc falls back to clone", () => {
    const clone = numbers.clone!;
    expect(decide(clone, [CLONE_THREAD_FLAGS])).toBe(RET_ALLOW);
    expect(decide(clone, [17])).toBe(RET_EPERM); // plain fork: SIGCHLD
    expect(decide(clone, [0x00004000 | 0x00000100 | 17])).toBe(RET_EPERM); // vfork-style CLONE_VFORK|CLONE_VM
    expect(decide(clone, [0])).toBe(RET_EPERM);
    for (const namespace of [0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000, 0x80]) {
      expect(decide(clone, [CLONE_THREAD_FLAGS | namespace])).toBe(RET_EPERM);
    }
    expect(decide(numbers.clone3!, [0, 0])).toBe(RET_ENOSYS);
  });

  test("signals: only to this very process; the upper half of the register is not trusted", () => {
    for (const name of SELF_ONLY_SIGNAL_SYSCALLS) {
      const nr = numbers[name]!;
      expect({ name, to: "self", result: decide(nr, [PID, 0, 0]) }).toEqual({ name, to: "self", result: RET_ALLOW });
      expect({ name, to: "self (garbage high bits)", result: decide(nr, [0xdead0000_00000000n | BigInt(PID), 0, 0]) }).toEqual({ name, to: "self (garbage high bits)", result: RET_ALLOW });
      for (const target of [1, PID + 1, 0, -1, -PID]) expect({ name, target, result: decide(nr, [target, 0, 0]) }).toEqual({ name, target, result: RET_EPERM });
    }
    expect(decide(numbers.tkill!, [PID, 9])).toBe(RET_EPERM);
  });

  // --- F1: a signal-like effect on ANOTHER process through a call that is not kill ---------------------
  test("processes named by an argument (prlimit64, sched_*, migrate/move_pages): this process or 0 only -- RLIMIT_CPU on the parent is a SIGKILL", () => {
    for (const name of SELF_OR_ZERO_ARG0_SYSCALLS) {
      const nr = numbers[name]!;
      expect({ name, nr: nr !== undefined }).toEqual({ name, nr: true });
      for (const self of [0, PID, 0xdead0000_00000000n | BigInt(PID)]) expect({ name, self, result: decide(nr, [self, 0, 0, 0]) }).toEqual({ name, self, result: RET_ALLOW });
      for (const other of [1, PID + 1, 1234, -1]) expect({ name, other, result: decide(nr, [other, 0, 0, 0]) }).toEqual({ name, other, result: RET_EPERM });
    }
  });

  test("setpriority / ioprio_set: only a single process, only this one -- the user and group selectors are refused even for 'who = 0'", () => {
    for (const [name, which] of Object.entries(SELF_OR_ZERO_ARG1_SYSCALLS)) {
      const nr = numbers[name]!;
      expect({ name, result: decide(nr, [which, 0, 0]) }).toEqual({ name, result: RET_ALLOW });
      expect({ name, result: decide(nr, [which, PID, 0]) }).toEqual({ name, result: RET_ALLOW });
      expect({ name, result: decide(nr, [which, 1234, 0]) }).toEqual({ name, result: RET_EPERM });
      for (const selector of [0, 1, 2, 3, 4].filter((v) => v !== which)) {
        // PRIO_USER (2) / IOPRIO_WHO_USER (3) with who = 0 means every process of the caller's user.
        expect({ name, selector, result: decide(nr, [selector, 0, 0]) }).toEqual({ name, selector, result: RET_EPERM });
        expect({ name, selector, result: decide(nr, [selector, PID, 0]) }).toEqual({ name, selector, result: RET_EPERM });
      }
    }
  });

  test("fcntl: the owner / signal / lock / lease commands are denied (the upper register half ignored); the ordinary ones pass", () => {
    const nr = numbers.fcntl!;
    for (const [command, value] of Object.entries(FCNTL_DENIED_COMMANDS)) {
      expect({ command, result: decide(nr, [3, value, 1234]) }).toEqual({ command, result: RET_EPERM });
      expect({ command, high: true, result: decide(nr, [3, 0xdead0000_00000000n | BigInt(value), 1234]) }).toEqual({ command, high: true, result: RET_EPERM });
    }
    // F_DUPFD 0, F_GETFD 1, F_SETFD 2, F_GETFL 3, F_SETFL 4, F_GETLK 5, F_DUPFD_CLOEXEC 1030, F_GETOWN 9, F_GETPIPE_SZ 1032
    for (const value of [0, 1, 2, 3, 4, 5, 9, 1030, 1032]) expect({ value, result: decide(nr, [3, value, 0]) }).toEqual({ value, result: RET_ALLOW });
  });

  test("ioctl: ownership (FIOSETOWN, SIOCSPGRP), terminal input injection and the file-attribute setters are denied; FIONREAD, TCGETS, FIOCLEX pass", () => {
    const nr = numbers.ioctl!;
    for (const [request, value] of Object.entries(IOCTL_DENIED_REQUESTS)) {
      expect({ request, result: decide(nr, [3, value, 0]) }).toEqual({ request, result: RET_EPERM });
      expect({ request, high: true, result: decide(nr, [3, 0xdead0000_00000000n | BigInt(value), 0]) }).toEqual({ request, high: true, result: RET_EPERM });
    }
    for (const value of [0x541b, 0x5401, 0x5451, 0x5421, 0x5452, 0x40086601, 0x80086601]) expect({ value, result: decide(nr, [3, value, 0]) }).toEqual({ value, result: RET_ALLOW });
  });

  // --- F2: a datagram socket can sendto() any bound path or abstract name ---------------------------------
  test("socketpair: AF_UNIX STREAM and SEQPACKET only (with or without NONBLOCK|CLOEXEC); DGRAM, RAW, other families and nothing else", () => {
    const nr = numbers.socketpair!;
    const SOCK_NONBLOCK_CLOEXEC = 0x800 | 0x80000;
    expect(decide(nr, [1, 1, 0])).toBe(RET_ALLOW);
    expect(decide(nr, [1, 1 | SOCK_NONBLOCK_CLOEXEC, 0])).toBe(RET_ALLOW);
    expect(decide(nr, [1, 5, 0])).toBe(RET_ALLOW);
    expect(decide(nr, [1, 5 | SOCK_NONBLOCK_CLOEXEC, 0])).toBe(RET_ALLOW);
    expect(decide(nr, [1, 0xdead0000_00000000n | 1n, 0])).toBe(RET_ALLOW); // only the low 32 bits are the type
    for (const type of [2, 2 | SOCK_NONBLOCK_CLOEXEC, 3, 4, 6, 7, 0]) expect({ type, result: decide(nr, [1, type, 0]) }).toEqual({ type, result: RET_EPERM });
    for (const domain of [0, 2, 10, 16, 17]) expect({ domain, result: decide(nr, [domain, 1, 0]) }).toEqual({ domain, result: RET_EPERM });
  });

  // --- F4: families nothing here needs ----------------------------------------------------------------------
  test("SysV and POSIX IPC, flock and the attribute setters are denied outright", () => {
    for (const name of [...DENIED_SYSCALLS.ipc!, ...DENIED_SYSCALLS.locks!, ...DENIED_SYSCALLS.attributes!]) {
      expect({ name, listed: numbers[name] !== undefined }).toEqual({ name, listed: true });
      expect({ name, result: decide(numbers[name]!) }).toEqual({ name, result: RET_EPERM });
    }
  });

  test("the tables carry fcntl and ioctl on this architecture, and (arm64) renameat", () => {
    expect(numbers.fcntl).toBe(arch === "x64" ? 72 : 25);
    expect(numbers.ioctl).toBe(arch === "x64" ? 16 : 29);
    if (arch === "arm64") expect(decide(numbers.renameat!)).toBe(RET_EPERM);
    expect(numbers.renameat).toBe(arch === "x64" ? 264 : 38);
  });

  test("the ordinary syscalls a JS runtime lives on are not touched, and exec stays allowed (Landlock narrows it)", () => {
    for (const [name, nr] of Object.entries(BASIC_ALLOWED[arch])) expect({ name, result: decide(nr) }).toEqual({ name, result: RET_ALLOW });
  });

  test("no number is on the deny list twice under different names, and none collides with an allowed call", () => {
    const seen = new Map<number, string>();
    for (const name of deniedSyscallNames()) {
      const nr = numbers[name];
      if (nr === undefined) continue;
      expect({ name, clashesWith: seen.get(nr) }).toEqual({ name, clashesWith: undefined });
      seen.set(nr, name);
    }
    for (const [name, nr] of Object.entries(BASIC_ALLOWED[arch])) expect({ name, denied: seen.get(nr) }).toEqual({ name, denied: undefined });
  });

  test("the program depends on the pid it is built for", () => {
    expect(buildSeccompProgram(arch, PID + 1).equals(program)).toBe(false);
    expect(() => buildSeccompProgram(arch, 0)).toThrow();
  });
});

describe("the syscall tables against the kernel headers installed here", () => {
  /** `#define __NR_x N` for this host's architecture, resolving the generic table's `__NR3264_` aliases. */
  function installedHeaderNumbers(): Map<string, number> | undefined {
    const files = process.arch === "x64" ? ["/usr/include/x86_64-linux-gnu/asm/unistd_64.h", "/usr/include/asm/unistd_64.h"] : ["/usr/include/asm-generic/unistd.h"];
    const file = files.find((candidate) => existsSync(candidate));
    if (file === undefined) return undefined;
    const text = readFileSync(file, "utf8");
    const numbers = new Map<string, number>();
    const wide = new Map<string, number>();
    for (const match of text.matchAll(/^#define __NR_(\w+)\s+(\d+)\s*$/gm)) numbers.set(match[1]!, Number(match[2]));
    for (const match of text.matchAll(/^#define __NR3264_(\w+)\s+(\d+)\s*$/gm)) wide.set(match[1]!, Number(match[2]));
    for (const match of text.matchAll(/^#define __NR_(\w+)\s+__NR3264_(\w+)\s*$/gm)) if (wide.has(match[2]!)) numbers.set(match[1]!, wide.get(match[2]!)!);
    return numbers;
  }
  const arch = linuxArchOfHost();
  function linuxArchOfHost(): LinuxArch | undefined {
    return process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
  }

  test.skipIf(process.platform !== "linux" || arch === undefined || installedHeaderNumbers() === undefined)("every number in this host's table equals the installed header's", () => {
    const header = installedHeaderNumbers()!;
    const table = SYSCALL_NUMBERS[arch!];
    let compared = 0;
    const wrong: string[] = [];
    for (const [name, number] of Object.entries(table)) {
      const installed = header.get(name);
      if (installed === undefined) continue; // newer than the installed headers
      compared++;
      if (installed !== number) wrong.push(`${name}: table ${number}, header ${installed}`);
    }
    expect(wrong).toEqual([]);
    expect(compared).toBeGreaterThan(Object.keys(table).length * 0.8);
  });

  test.skipIf(process.platform !== "linux" || arch === undefined || installedHeaderNumbers() === undefined)("and the other way: every name this policy handles that the installed header defines IS in the table", () => {
    const header = installedHeaderNumbers()!;
    const handled = [
      ...deniedSyscallNames(),
      ...SELF_ONLY_SIGNAL_SYSCALLS,
      ...SELF_OR_ZERO_ARG0_SYSCALLS,
      ...Object.keys(SELF_OR_ZERO_ARG1_SYSCALLS),
      "clone", "clone3", "socketpair", "fcntl", "ioctl",
    ];
    const absent = handled.filter((name) => header.has(name) && SYSCALL_NUMBERS[arch!][name] === undefined);
    expect(absent).toEqual([]);
    expect(handled.filter((name) => header.has(name)).length).toBeGreaterThan(100);
  });

  test("the tables are internally consistent: every call the launcher itself makes exists on both architectures", () => {
    for (const arch of ["x64", "arm64"] as const) {
      for (const name of ["prctl", "capget", "capset", "prlimit64", "close_range", "seccomp", "landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self", "socket"]) {
        expect({ arch, name, number: SYSCALL_NUMBERS[arch][name] !== undefined }).toEqual({ arch, name, number: true });
      }
    }
    // The three Landlock calls and the pidfd/io_uring family share one number space on both architectures.
    expect(SYSCALL_NUMBERS.x64.landlock_create_ruleset).toBe(SYSCALL_NUMBERS.arm64.landlock_create_ruleset);
    expect(SYSCALL_NUMBERS.x64.io_uring_setup).toBe(SYSCALL_NUMBERS.arm64.io_uring_setup);
  });

  test.skipIf(!existsSync("/usr/include/linux/landlock.h"))("the Landlock right bits equal the installed header's", () => {
    const text = readFileSync("/usr/include/linux/landlock.h", "utf8");
    const names: Array<[string, bigint]> = [
      ["EXECUTE", LANDLOCK_FS.EXECUTE],
      ["WRITE_FILE", LANDLOCK_FS.WRITE_FILE],
      ["READ_FILE", LANDLOCK_FS.READ_FILE],
      ["READ_DIR", LANDLOCK_FS.READ_DIR],
      ["REMOVE_DIR", LANDLOCK_FS.REMOVE_DIR],
      ["REMOVE_FILE", LANDLOCK_FS.REMOVE_FILE],
      ["MAKE_CHAR", LANDLOCK_FS.MAKE_CHAR],
      ["MAKE_DIR", LANDLOCK_FS.MAKE_DIR],
      ["MAKE_REG", LANDLOCK_FS.MAKE_REG],
      ["MAKE_SOCK", LANDLOCK_FS.MAKE_SOCK],
      ["MAKE_FIFO", LANDLOCK_FS.MAKE_FIFO],
      ["MAKE_BLOCK", LANDLOCK_FS.MAKE_BLOCK],
      ["MAKE_SYM", LANDLOCK_FS.MAKE_SYM],
      ["REFER", LANDLOCK_FS.REFER],
      ["TRUNCATE", LANDLOCK_FS.TRUNCATE],
    ];
    for (const [name, bit] of names) {
      const match = new RegExp(`LANDLOCK_ACCESS_FS_${name}\\s+\\(1ULL << (\\d+)\\)`).exec(text);
      // REFER and TRUNCATE arrive with ABI 2 and 3; an older header may not name them.
      if (match === null && (name === "REFER" || name === "TRUNCATE")) continue;
      expect({ name, bit: match === null ? undefined : 1n << BigInt(match[1]!) }).toEqual({ name, bit });
    }
  });

  test("the handled rights grow with the ABI and always include every write-class right at ABI 3", () => {
    expect(landlockHandledRights(1) & LANDLOCK_FS.REFER).toBe(0n);
    expect(landlockHandledRights(2) & LANDLOCK_FS.REFER).toBe(LANDLOCK_FS.REFER);
    expect(landlockHandledRights(2) & LANDLOCK_FS.TRUNCATE).toBe(0n);
    const all = landlockHandledRights(LINUX_MIN_LANDLOCK_ABI);
    for (const right of [LANDLOCK_FS.WRITE_FILE, LANDLOCK_FS.REMOVE_DIR, LANDLOCK_FS.REMOVE_FILE, LANDLOCK_FS.MAKE_CHAR, LANDLOCK_FS.MAKE_DIR, LANDLOCK_FS.MAKE_REG, LANDLOCK_FS.MAKE_SOCK, LANDLOCK_FS.MAKE_FIFO, LANDLOCK_FS.MAKE_BLOCK, LANDLOCK_FS.MAKE_SYM, LANDLOCK_FS.REFER, LANDLOCK_FS.TRUNCATE, LANDLOCK_FS.EXECUTE]) {
      expect(all & right).toBe(right);
    }
  });
});

describe("landlockRulesetAttr", () => {
  test("below ABI 6 it is the 8-byte form with every handled right; from ABI 6 it also scopes signals and abstract unix sockets", () => {
    for (const abi of [3, 4, 5]) {
      const attr = landlockRulesetAttr(abi);
      expect(attr.length).toBe(8);
      expect(attr.readBigUInt64LE(0)).toBe(landlockHandledRights(abi));
    }
    for (const abi of [6, 7, 9]) {
      const attr = landlockRulesetAttr(abi);
      expect(attr.length).toBe(24);
      expect(attr.readBigUInt64LE(0)).toBe(landlockHandledRights(abi));
      expect(attr.readBigUInt64LE(8)).toBe(0n); // no network rights handled
      expect(attr.readBigUInt64LE(16)).toBe(LANDLOCK_SCOPE_SIGNAL | LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET);
    }
    expect(LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET).toBe(1n);
    expect(LANDLOCK_SCOPE_SIGNAL).toBe(2n);
  });
});

// --- The exec stage, against a recording kernel -----------------------------------------------------------------------------------------

describe("execConfinedWorker: the last stage before the worker starts", () => {
  function recordingKernel(failing?: string): Kernel & { calls: Array<[string, unknown[]]>; execs: Array<{ file: string; argv: readonly string[] }> } {
    const calls: Array<[string, unknown[]]> = [];
    const execs: Array<{ file: string; argv: readonly string[] }> = [];
    return {
      arch: "x64",
      calls,
      execs,
      call(name: string, ...args: unknown[]): SyscallResult {
        calls.push([name, args]);
        return name === failing ? { ret: -1, errno: 22 } : { ret: 0, errno: 0 };
      },
      address: () => 0,
      openPath: () => openSync("/dev/null", "r"),
      execve(file: string, argv: readonly string[]) {
        execs.push({ file, argv });
        return 2;
      },
    };
  }
  const spec: LinuxConfinementSpec = { version: 1, target: { file: "/opt/winter/bin/winter", args: ["__workflow-worker", "--bridge"] }, readDeny: [], minLandlockAbi: 3 };

  test("every inherited descriptor is marked close-on-exec first, and the worker is exec'd with its own command", () => {
    const kernel = recordingKernel();
    expect(() => execConfinedWorker(spec, kernel)).toThrow(/execve errno 2/);
    expect(kernel.calls[0]).toEqual(["close_range", [3, 0xffffffff, 4]]);
    expect(kernel.execs).toEqual([{ file: "/opt/winter/bin/winter", argv: ["/opt/winter/bin/winter", "__workflow-worker", "--bridge"] }]);
  });

  test("when the descriptors cannot be marked, the launch is refused and nothing is exec'd", () => {
    const kernel = recordingKernel("close_range");
    expect(() => execConfinedWorker(spec, kernel)).toThrow(LinuxConfinementUnavailableError);
    expect(() => execConfinedWorker(spec, kernel)).toThrow(/close-on-exec/);
    expect(kernel.execs).toEqual([]);
  });
});

// --- A host worker command needs a host launcher ----------------------------------------------------------------------------------------------

describe("a host that installs its own worker command must also name its launcher", () => {
  const command = { file: "/opt/host/winter-core", args: ["__runtime-workflow-worker", "--bridge"] };

  test("buildLinuxWorkerSpawn refuses with the typed error rather than launching a host binary that may not route __linux-confine", () => {
    const restore = setHostWorkflowWorkerCommand(command);
    try {
      expect(linuxLauncherProblem()).toContain("without a host confinement launcher");
      expect(() => buildLinuxWorkerSpawn({ command })).toThrow(LinuxConfinementUnavailableError);
      // Naming the launcher (here or per call) is what lifts it.
      const restoreLauncher = setHostLinuxConfinementLauncher({ file: "/opt/host/winter-core", args: ["--launcher"] });
      try {
        expect(linuxLauncherProblem()).toBeUndefined();
        expect(buildLinuxWorkerSpawn({ command }).file).toBe("/opt/host/winter-core");
      } finally {
        restoreLauncher();
      }
      expect(() => buildLinuxWorkerSpawn({ command })).toThrow(LinuxConfinementUnavailableError);
      expect(buildLinuxWorkerSpawn({ command, launcher: { file: "/opt/host/winter-core", args: [] } }).file).toBe("/opt/host/winter-core");
    } finally {
      restore();
    }
    // With no host worker command installed the default launcher applies, as before.
    expect(linuxLauncherProblem()).toBeUndefined();
    expect(() => buildLinuxWorkerSpawn({ command })).not.toThrow();
  });

  test.skipIf(process.platform !== "linux")("on Linux it also makes the Workflow unavailable up front, with the reason", () => {
    const restoreProbe = overrideLinuxConfinementProbeForTest({ available: true, arch: "x64", landlockAbi: 4 });
    const restore = setHostWorkflowWorkerCommand(command);
    try {
      expect(workflowSandboxAvailable()).toBe(false);
      expect(workflowSandboxUnavailableMessage()).toContain("without a host confinement launcher");
    } finally {
      restore();
      expect(workflowSandboxAvailable()).toBe(true);
      restoreProbe();
    }
  });
});

// --- The read allowance, over a scratch tree ---------------------------------------------------------------------------------------

describe("planReadAllow: Landlock cannot subtract, so the allowance is built around the withheld directories", () => {
  function tree(): { root: string; at: (...parts: string[]) => string } {
    const root = scratch("winter-confine-tree-");
    const at = (...parts: string[]): string => join(root, ...parts);
    for (const dir of ["usr/bin", "etc", "home/u/.winter/run", "home/u/.winter/memory", "home/u/docs", "home/other", "proc/1", "proc/123", "proc/456", "proc/sys", "dev"]) mkdirSync(at(dir), { recursive: true });
    writeFileSync(at("home/u/.winter/run/core.sock.token"), "SECRET");
    writeFileSync(at("home/u/.winter/memory/notes.md"), "READABLE");
    writeFileSync(at("proc/cpuinfo"), "cpu");
    writeFileSync(at("home/u/.bashrc"), "x");
    symlinkSync("usr", at("lib")); // /lib -> usr: a benign link
    symlinkSync(at("home/u/.winter/run"), at("sneaky")); // a link INTO the withheld tree
    symlinkSync(at("home/u"), at("up")); // a link to an ANCESTOR of the withheld tree
    symlinkSync("123", at("proc/self"));
    return { root, at };
  }
  const plan = (root: string, denyPaths: string[], selfPid = 123): string[] => planReadAllow({ denyPaths, selfPid, root }).map((entry) => entry.path).sort();

  test("grants every sibling along the way to the withheld directory, and nothing that would cover it", () => {
    const { root, at } = tree();
    try {
      const granted = plan(root, [at("home/u/.winter/run")]);
      for (const wanted of [at("usr"), at("etc"), at("dev"), at("home/other"), at("home/u/docs"), at("home/u/.bashrc"), at("home/u/.winter/memory")]) expect(granted).toContain(wanted);
      for (const unwanted of [root, at("home"), at("home/u"), at("home/u/.winter"), at("home/u/.winter/run"), at("sneaky"), at("up")]) expect(granted).not.toContain(unwanted);
      // No granted path is, contains or sits inside the withheld directory.
      for (const path of granted) {
        expect(path === at("home/u/.winter/run") || path.startsWith(`${at("home/u/.winter/run")}/`)).toBe(false);
        expect(at("home/u/.winter/run").startsWith(`${path}/`)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a benign symlink is judged by where it lands (and deduplicated)", () => {
    const { root, at } = tree();
    try {
      const granted = plan(root, [at("home/u/.winter/run")]);
      expect(granted.filter((p) => p === at("usr"))).toHaveLength(1); // `lib -> usr` adds nothing new
      expect(granted).not.toContain(at("lib"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("other processes' /proc directories are withheld; this process's, and the non-pid entries, are not", () => {
    const { root, at } = tree();
    try {
      const granted = plan(root, [at("home/u/.winter/run")]);
      expect(granted).toContain(at("proc/123"));
      expect(granted).toContain(at("proc/cpuinfo"));
      expect(granted).toContain(at("proc/sys"));
      for (const other of ["proc", "proc/1", "proc/456", "proc/self"]) expect(granted).not.toContain(at(other));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("with nothing to withhold, the top-level entries are granted (still not /proc whole)", () => {
    const { root, at } = tree();
    try {
      const granted = plan(root, []);
      for (const wanted of [at("usr"), at("etc"), at("home"), at("dev"), at("proc/123")]) expect(granted).toContain(wanted);
      for (const unwanted of [root, at("proc"), at("proc/1")]) expect(granted).not.toContain(unwanted);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a withheld directory that does not exist yet is still withheld: its parent is never granted whole", () => {
    const { root, at } = tree();
    try {
      rmSync(at("home/u/.winter/run"), { recursive: true, force: true });
      const granted = plan(root, [at("home/u/.winter/run")]);
      expect(granted).toContain(at("home/u/.winter/memory"));
      expect(granted).not.toContain(at("home/u/.winter"));
      expect(granted).not.toContain(at("home/u"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a withheld path is canonicalised through symlinks in its existing prefix", () => {
    const { root, at } = tree();
    try {
      mkdirSync(at("real"));
      symlinkSync(at("real"), at("alias"));
      expect(canonicalDenyPath(at("alias/run"))).toBe(at("real/run"));
      expect(canonicalDenyPath(at("alias"))).toBe(at("real"));
      expect(canonicalDenyPath("/definitely/not/there/run")).toBe("/definitely/not/there/run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- ELF -----------------------------------------------------------------------------------------------------------------------------

describe("parseElfHead", () => {
  function elf(opts: { machine: number; interpreter?: string; cls?: number; data?: number }): Buffer {
    const interpreter = opts.interpreter === undefined ? undefined : Buffer.from(`${opts.interpreter}\0`);
    const phnum = interpreter === undefined ? 0 : 1;
    const out = Buffer.alloc(64 + 56 * phnum + (interpreter?.length ?? 0));
    out.writeUInt32BE(0x7f454c46, 0);
    out.writeUInt8(opts.cls ?? 2, 4);
    out.writeUInt8(opts.data ?? 1, 5);
    out.writeUInt16LE(opts.machine, 18);
    out.writeBigUInt64LE(64n, 32); // e_phoff
    out.writeUInt16LE(56, 54); // e_phentsize
    out.writeUInt16LE(phnum, 56); // e_phnum
    if (interpreter !== undefined) {
      out.writeUInt32LE(3, 64); // PT_INTERP
      out.writeBigUInt64LE(BigInt(64 + 56), 64 + 8); // p_offset
      out.writeBigUInt64LE(BigInt(interpreter.length), 64 + 32); // p_filesz
      interpreter.copy(out, 64 + 56);
    }
    return out;
  }

  test("reads the machine and the dynamic loader a binary asks for", () => {
    expect(parseElfHead(elf({ machine: 183, interpreter: "/lib/ld-linux-aarch64.so.1" }))).toEqual({ machine: 183, interpreter: "/lib/ld-linux-aarch64.so.1" });
    expect(parseElfHead(elf({ machine: 62, interpreter: "/lib64/ld-linux-x86-64.so.2" }))).toEqual({ machine: 62, interpreter: "/lib64/ld-linux-x86-64.so.2" });
  });

  test("a static binary has no loader to allow", () => {
    expect(parseElfHead(elf({ machine: 62 }))).toEqual({ machine: 62, interpreter: undefined });
  });

  test("anything that is not a little-endian 64-bit ELF is refused", () => {
    expect(() => parseElfHead(Buffer.from("#!/bin/sh\nexit 0\n".padEnd(80, " ")))).toThrow(LinuxConfinementUnavailableError);
    expect(() => parseElfHead(elf({ machine: 62, cls: 1 }))).toThrow(LinuxConfinementUnavailableError);
    expect(() => parseElfHead(elf({ machine: 62, data: 2 }))).toThrow(LinuxConfinementUnavailableError);
    expect(() => parseElfHead(Buffer.alloc(8))).toThrow(LinuxConfinementUnavailableError);
    // An interpreter path that runs off the end of what was read is a refusal, not a guess.
    const truncated = elf({ machine: 62, interpreter: "/lib64/ld-linux-x86-64.so.2" }).subarray(0, 64 + 56 + 4);
    expect(() => parseElfHead(truncated)).toThrow(LinuxConfinementUnavailableError);
  });
});

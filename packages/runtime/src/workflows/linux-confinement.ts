// Linux confinement for the Workflow worker -- the half that talks to the kernel.
//
// THE SHAPE. macOS wraps the worker in `sandbox-exec -p <profile>`. Linux has no such wrapper, and the
// confining calls (no_new_privs, Landlock, seccomp) bind only the thread that makes them and whatever
// that thread later creates. Applying them inside the already-running worker would leave Bun's other
// threads outside the fence. So the parent launches THIS SAME BINARY in a launcher role first:
//
//   <winter> __linux-confine <spec>   ->   confine this thread  ->  execve(<worker>)
//
// `execve` from a multi-threaded process ends every other thread, so the worker starts as one thread
// that is already confined and every thread it later creates inherits both the Landlock domain and
// the seccomp filter. The pid does not change, so the parent's process-group kill still reaches it.
//
// No native binary is added: the calls are made through `bun:ffi` into libc's `syscall`, the same
// mechanism the guest admission code already uses. The launcher never touches stdin (the bridge's
// init line waits in the pipe) and execs the worker only after every step below has been applied
// AND verified from the inside. Any failure exits 77 without exec: the worker never runs unconfined.
import { closeSync, constants as fsConstants, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import {
  LANDLOCK_CREATE_RULESET_VERSION,
  LANDLOCK_DEV_NULL_RIGHTS,
  LANDLOCK_EXEC_RIGHTS,
  LANDLOCK_READ_DIR_RIGHTS,
  LANDLOCK_READ_FILE_RIGHTS,
  LANDLOCK_RULE_PATH_BENEATH,
  LINUX_CONFINE_ARGV_FLAG,
  LINUX_CONFINEMENT_REFUSED_EXIT_CODE,
  LINUX_MIN_LANDLOCK_ABI,
  LinuxConfinementUnavailableError,
  SECCOMP_RET_ERRNO,
  SECCOMP_RET_KILL_PROCESS,
  buildSeccompProgram,
  decodeConfinementSpec,
  landlockHandledRights,
  linuxArchOf,
  planExec,
  planReadAllow,
  syscallNumber,
  type LinuxArch,
  type LinuxConfinementSpec,
} from "./linux-confinement-policy.ts";

type Ffi = typeof import("bun:ffi");

// --- The kernel handle ----------------------------------------------------------------------------------

export type SysArg = number | bigint;
export interface SyscallResult {
  /** The raw return: -1 on failure. */
  ret: number;
  /** errno as read straight after the call; meaningful only when `ret` is -1. */
  errno: number;
}

/** What the confinement code needs from the OS. A fake of this is how the sequencing is tested off-Linux. */
export interface Kernel {
  readonly arch: LinuxArch;
  call(name: string, ...args: SysArg[]): SyscallResult;
  /** The address of a buffer, valid while the caller holds the buffer. */
  address(view: Uint8Array | BigUint64Array): number;
  openPath(path: string, flags: number): number;
  /** Replaces the process image. Returns only on failure, with errno. */
  execve(file: string, argv: readonly string[], env: readonly string[]): number;
}

const LIBC_CANDIDATES = ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"];

function toU64(value: SysArg): number | bigint {
  if (typeof value === "bigint") return BigInt.asUintN(64, value);
  return value < 0 ? BigInt.asUintN(64, BigInt(value)) : value;
}

let cachedKernel: Kernel | LinuxConfinementUnavailableError | undefined;

/** Loads libc through `bun:ffi`. Throws the typed refusal when this is not Linux/Bun or libc cannot be bound. */
export function openKernel(): Kernel {
  if (cachedKernel instanceof LinuxConfinementUnavailableError) throw cachedKernel;
  if (cachedKernel !== undefined) return cachedKernel;
  try {
    cachedKernel = bindKernel();
    return cachedKernel;
  } catch (error) {
    cachedKernel = error instanceof LinuxConfinementUnavailableError ? error : new LinuxConfinementUnavailableError(`libc could not be bound: ${error instanceof Error ? error.message : String(error)}`);
    throw cachedKernel;
  }
}

function bindKernel(): Kernel {
  if (process.platform !== "linux") throw new LinuxConfinementUnavailableError(`Linux confinement does not apply on ${process.platform}`);
  const arch = linuxArchOf(process.arch);
  if (arch === undefined) throw new LinuxConfinementUnavailableError(`Linux confinement is not implemented for ${process.arch}`);
  let ffi: Ffi;
  try {
    ffi = require("bun:ffi") as Ffi;
  } catch {
    throw new LinuxConfinementUnavailableError("bun:ffi is unavailable in this runtime");
  }
  const { dlopen, FFIType, read } = ffi;
  const symbols = {
    syscall: { args: [FFIType.i64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i64_fast },
    __errno_location: { args: [], returns: FFIType.ptr },
    execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    open: { args: [FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  } as const;
  let libc: ReturnType<typeof dlopen<typeof symbols>> | undefined;
  for (const name of LIBC_CANDIDATES) {
    try {
      libc = dlopen(name, symbols);
      break;
    } catch {
      /* try the next libc name */
    }
  }
  if (libc === undefined) throw new LinuxConfinementUnavailableError("no libc could be loaded through bun:ffi");
  const bound = libc.symbols;
  const errnoNow = (): number => {
    const where = bound.__errno_location();
    return where === null ? 0 : read.i32(where);
  };
  const cString = (text: string): Buffer => Buffer.from(`${text}\0`, "utf8");

  const rawCall = (number: number, args: readonly SysArg[]): SyscallResult => {
    const padded: Array<number | bigint> = [0, 0, 0, 0, 0, 0];
    args.forEach((arg, index) => {
      padded[index] = toU64(arg);
    });
    const ret = Number(bound.syscall(number, padded[0]!, padded[1]!, padded[2]!, padded[3]!, padded[4]!, padded[5]!));
    return ret === -1 ? { ret, errno: errnoNow() } : { ret, errno: 0 };
  };
  return {
    arch,
    call(name, ...args) {
      const number = syscallNumber(arch, name);
      if (number === undefined) throw new LinuxConfinementUnavailableError(`syscall ${name} does not exist on ${arch}`);
      return rawCall(number, args);
    },
    address: (view) => ffi.ptr(view) as unknown as number,
    openPath: (path, flags) => bound.open(cString(path), flags, 0),
    execve(file, argv, env) {
      const keep: Buffer[] = [];
      const table = (items: readonly string[]): BigUint64Array => {
        const out = new BigUint64Array(items.length + 1);
        items.forEach((item, index) => {
          const text = cString(item);
          keep.push(text);
          out[index] = BigInt(ffi.ptr(text));
        });
        return out;
      };
      const argvTable = table(argv);
      const envTable = table(env);
      const path = cString(file);
      bound.execve(path, argvTable, envTable);
      const errno = errnoNow();
      keep.push(path); // held until here so none of the C strings is collected under the call
      return errno;
    },
  };
}

// --- Constants ------------------------------------------------------------------------------------------------

const PR_CAPBSET_DROP = 24;
const PR_SET_NO_NEW_PRIVS = 38;
const PR_GET_NO_NEW_PRIVS = 39;
const PR_CAP_AMBIENT = 47;
const PR_CAP_AMBIENT_CLEAR_ALL = 4;
const SECCOMP_SET_MODE_FILTER = 1;
const SECCOMP_GET_ACTION_AVAIL = 2;
const LINUX_CAPABILITY_VERSION_3 = 0x20080522;
const RLIMIT_CORE = 4;
const CLOSE_RANGE_CLOEXEC = 4;
const O_PATH = 0o10000000;
const O_CLOEXEC = 0o2000000;
const AF_INET = 2;
const SOCK_STREAM = 1;
const EPERM_ERRNO = 1;
const ENOSYS_ERRNO = 38;
const EOPNOTSUPP_ERRNO = 95;

// --- The probe --------------------------------------------------------------------------------------------------

export type LinuxConfinementProbe =
  | { available: true; arch: LinuxArch; landlockAbi: number }
  | { available: false; reason: string };

/** Asks the kernel, without changing anything, whether the confinement can be applied here. */
export function probeKernel(kernel: Kernel, minLandlockAbi: number = LINUX_MIN_LANDLOCK_ABI): LinuxConfinementProbe {
  const required = Math.max(LINUX_MIN_LANDLOCK_ABI, minLandlockAbi);
  const abi = kernel.call("landlock_create_ruleset", 0, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi.ret < 0) {
    const why =
      abi.errno === ENOSYS_ERRNO ? "this kernel has no Landlock" : abi.errno === EOPNOTSUPP_ERRNO ? "Landlock is disabled on this kernel" : abi.errno === EPERM_ERRNO ? "Landlock calls are refused here (a seccomp policy?)" : `the Landlock probe failed (errno ${abi.errno})`;
    return { available: false, reason: why };
  }
  if (abi.ret < required) return { available: false, reason: `Landlock ABI ${abi.ret} is older than the ABI ${required} the Workflow requires` };

  for (const action of [SECCOMP_RET_ERRNO, SECCOMP_RET_KILL_PROCESS]) {
    const word = Buffer.alloc(4);
    word.writeUInt32LE(action >>> 0, 0);
    const answer = kernel.call("seccomp", SECCOMP_GET_ACTION_AVAIL, 0, kernel.address(word));
    if (answer.ret !== 0) return { available: false, reason: "seccomp filters with the needed actions are unavailable on this kernel" };
  }
  const nnp = kernel.call("prctl", PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  if (nnp.ret < 0) return { available: false, reason: "no_new_privs is unavailable on this kernel" };
  return { available: true, arch: kernel.arch, landlockAbi: abi.ret };
}

let probeOverride: LinuxConfinementProbe | undefined;
let cachedProbe: LinuxConfinementProbe | undefined;

/** The process-wide answer (kernel capabilities do not change under a running process). */
export function linuxConfinementProbe(): LinuxConfinementProbe {
  if (probeOverride !== undefined) return probeOverride;
  if (cachedProbe !== undefined) return cachedProbe;
  try {
    cachedProbe = probeKernel(openKernel());
  } catch (error) {
    cachedProbe = { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return cachedProbe;
}

/** TEST SEAM: makes the probe report `result`; returns the restore. Only ever used to force a refusal or a fixed answer. */
export function overrideLinuxConfinementProbeForTest(result: LinuxConfinementProbe | undefined): () => void {
  const previous = probeOverride;
  probeOverride = result;
  return () => {
    probeOverride = previous;
  };
}

// --- Applying it -----------------------------------------------------------------------------------------------------

function need(result: SyscallResult, what: string): number {
  if (result.ret < 0) throw new LinuxConfinementUnavailableError(`${what} failed (errno ${result.errno})`);
  return result.ret;
}

function dropCapabilities(kernel: Kernel): void {
  const header = Buffer.alloc(8);
  const data = Buffer.alloc(24);
  const read = (): boolean => {
    header.writeUInt32LE(LINUX_CAPABILITY_VERSION_3, 0);
    header.writeInt32LE(0, 4);
    need(kernel.call("capget", kernel.address(header), kernel.address(data)), "reading capabilities");
    return data.some((byte) => byte !== 0);
  };
  if (!read()) return;
  let last = 40;
  try {
    last = Number.parseInt(readFileSync("/proc/sys/kernel/cap_last_cap", "utf8").trim(), 10);
  } catch {
    /* the default covers every capability a current kernel defines */
  }
  for (let cap = 0; cap <= last; cap++) kernel.call("prctl", PR_CAPBSET_DROP, cap, 0, 0, 0);
  kernel.call("prctl", PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0);
  data.fill(0);
  header.writeUInt32LE(LINUX_CAPABILITY_VERSION_3, 0);
  header.writeInt32LE(0, 4);
  need(kernel.call("capset", kernel.address(header), kernel.address(data)), "dropping capabilities");
  if (read()) throw new LinuxConfinementUnavailableError("capabilities could not be emptied");
}

function limitCoreDumps(kernel: Kernel): void {
  const limit = Buffer.alloc(16); // rlimit64 { cur = 0, max = 0 }
  need(kernel.call("prlimit64", 0, RLIMIT_CORE, kernel.address(limit), 0), "disabling core dumps");
}

interface DeviceProbe {
  path: string;
}

/** A device the process can write today, so that being refused after Landlock is evidence and not an accident of permissions. */
function pickWriteProbe(): DeviceProbe {
  for (const path of ["/dev/zero", "/dev/full", "/dev/urandom"]) {
    try {
      closeSync(openSync(path, fsConstants.O_WRONLY));
      return { path };
    } catch {
      /* not writable here; try the next */
    }
  }
  throw new LinuxConfinementUnavailableError("no device is writable to verify the filesystem fence against");
}

interface DenyProbe {
  path: string;
}
function readableDenials(readDeny: readonly string[]): DenyProbe[] {
  const probes: DenyProbe[] = [];
  for (const path of readDeny) {
    try {
      readdirSync(path);
      probes.push({ path });
    } catch {
      /* absent or not listable: nothing to verify, nothing to leak */
    }
  }
  return probes;
}

function applyLandlock(kernel: Kernel, abi: number, spec: LinuxConfinementSpec, exec: { target: string; interpreter: string | undefined }): void {
  const handled = landlockHandledRights(abi);
  const attribute = Buffer.alloc(8);
  attribute.writeBigUInt64LE(handled, 0);
  const ruleset = need(kernel.call("landlock_create_ruleset", kernel.address(attribute), attribute.length, 0), "creating the Landlock ruleset");
  try {
    const grant = (path: string, rights: bigint, required: boolean): void => {
      const fd = kernel.openPath(path, O_PATH | O_CLOEXEC);
      if (fd < 0) {
        if (required) throw new LinuxConfinementUnavailableError(`cannot open ${path} for the Landlock ruleset`);
        return;
      }
      try {
        const rule = Buffer.alloc(12); // landlock_path_beneath_attr, packed: { u64 allowed_access; s32 parent_fd }
        rule.writeBigUInt64LE(rights, 0);
        rule.writeInt32LE(fd, 8);
        const added = kernel.call("landlock_add_rule", ruleset, LANDLOCK_RULE_PATH_BENEATH, kernel.address(rule), 0);
        if (added.ret < 0 && required) throw new LinuxConfinementUnavailableError(`Landlock refused the rule for ${path} (errno ${added.errno})`);
      } finally {
        closeSync(fd);
      }
    };
    for (const entry of planReadAllow({ denyPaths: spec.readDeny, selfPid: process.pid })) {
      grant(entry.path, entry.directory ? LANDLOCK_READ_DIR_RIGHTS : LANDLOCK_READ_FILE_RIGHTS, false);
    }
    grant(exec.target, LANDLOCK_EXEC_RIGHTS, true);
    if (exec.interpreter !== undefined) grant(exec.interpreter, LANDLOCK_EXEC_RIGHTS, true);
    grant("/dev/null", LANDLOCK_DEV_NULL_RIGHTS, true);
    need(kernel.call("landlock_restrict_self", ruleset, 0), "applying the Landlock ruleset");
  } finally {
    closeSync(ruleset);
  }
}

function applySeccomp(kernel: Kernel): void {
  const program = buildSeccompProgram(kernel.arch, process.pid);
  const filter = Buffer.alloc(16); // struct sock_fprog { u16 len; struct sock_filter *filter; }
  filter.writeUInt16LE(program.length / 8, 0);
  filter.writeBigUInt64LE(BigInt(kernel.address(program)), 8);
  need(kernel.call("seccomp", SECCOMP_SET_MODE_FILTER, 0, kernel.address(filter)), "installing the seccomp filter");
}

/** Checks, from the inside, that each fence is really up. Anything else is a refusal. */
function verifyConfined(kernel: Kernel, probeDevice: DeviceProbe, denials: readonly DenyProbe[]): void {
  // Each of these succeeded before the restrictions went on, so a failure now is the fence working.
  const stillWorks = (action: () => void): boolean => {
    try {
      action();
      return true;
    } catch {
      return false;
    }
  };
  if (stillWorks(() => closeSync(openSync(probeDevice.path, fsConstants.O_WRONLY)))) {
    throw new LinuxConfinementUnavailableError("Landlock is not enforcing: a write to a device outside the allowance succeeded");
  }
  for (const denial of denials) {
    if (stillWorks(() => void readdirSync(denial.path))) throw new LinuxConfinementUnavailableError("Landlock is not enforcing: a withheld directory is still readable");
  }
  const socket = kernel.call("socket", AF_INET, SOCK_STREAM, 0);
  if (socket.ret >= 0) {
    closeSync(socket.ret);
    throw new LinuxConfinementUnavailableError("seccomp is not enforcing: a network socket was created");
  }
  const status = readFileSync("/proc/self/status", "utf8");
  if (!/^NoNewPrivs:\s+1$/m.test(status)) throw new LinuxConfinementUnavailableError("no_new_privs is not set");
  if (!/^Seccomp:\s+2$/m.test(status)) throw new LinuxConfinementUnavailableError("the seccomp filter is not installed");
}

/**
 * Confines the calling thread and replaces the process with `spec.target`. Does not return on
 * success. Every failure is thrown as `LinuxConfinementUnavailableError` BEFORE the exec, so the
 * target is never started without the full set in force.
 */
export function confineAndExec(spec: LinuxConfinementSpec, kernel: Kernel = openKernel()): never {
  const probe = probeKernel(kernel, spec.minLandlockAbi);
  if (!probe.available) throw new LinuxConfinementUnavailableError(probe.reason);

  // Everything that needs the filesystem as it is today happens before the first restriction.
  const exec = planExec(spec.target.file, kernel.arch);
  const device = pickWriteProbe();
  const denials = readableDenials(spec.readDeny);

  need(kernel.call("prctl", PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "setting no_new_privs");
  dropCapabilities(kernel);
  limitCoreDumps(kernel);
  applyLandlock(kernel, probe.landlockAbi, spec, exec);
  applySeccomp(kernel);
  verifyConfined(kernel, device, denials);

  // Marked rather than closed: Bun's own descriptors stay usable until the exec drops them.
  kernel.call("close_range", 3, 0xffffffff, CLOSE_RANGE_CLOEXEC);
  // The one descriptor that survives the exec: this process's own /proc directory. Landlock's rule for it
  // is tied to that directory object, and procfs may drop and rebuild an unreferenced one under memory
  // pressure, which would silently take the worker's access to /proc/self with it. An open descriptor
  // keeps the object (and so the rule) alive for the worker's whole life. It is an O_PATH handle, so it
  // grants nothing the rule does not.
  kernel.openPath("/proc/self", O_PATH);
  const environment = Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]));
  const errno = kernel.execve(spec.target.file, [spec.target.file, ...spec.target.args], environment);
  throw new LinuxConfinementUnavailableError(`the worker could not be started (execve errno ${errno})`);
}

/**
 * The launcher role's entry (`main.ts` calls it for `__linux-confine <spec>`). Returns only the exit
 * code of a REFUSAL: on success the process has been replaced by the worker.
 */
export function linuxConfineMain(argv: readonly string[]): number {
  const say = (text: string): void => {
    try {
      writeSync(2, `${text}\n`);
    } catch {
      /* nothing left to tell */
    }
  };
  try {
    const at = argv.indexOf(LINUX_CONFINE_ARGV_FLAG);
    const spec = decodeConfinementSpec(at === -1 ? undefined : argv[at + 1]);
    confineAndExec(spec);
  } catch (error) {
    say(`winter: linux workflow confinement is not in effect: ${error instanceof Error ? error.message : String(error)}`);
  }
  return LINUX_CONFINEMENT_REFUSED_EXIT_CODE;
}

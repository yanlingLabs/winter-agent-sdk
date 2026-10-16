// Linux confinement for the Workflow worker -- the PURE half: what is confined, how that is
// expressed to the kernel, and the spec the parent hands the launcher. Nothing here makes a syscall,
// so everything in this file is testable on any OS; `linux-confinement.ts` is the half that talks to
// the kernel.
//
// THE POLICY, stated against the macOS worker profile it mirrors (`buildWorkflowWorkerSeatbeltProfile`):
//
//   macOS (sandbox-exec)                         Linux (Landlock + seccomp + no_new_privs)
//   -------------------------------------------  -----------------------------------------------------
//   (allow file-read*) minus `<home>/run`        Landlock READ on every top-level path except the run
//                                                directories; `/proc/<other pid>` is unreadable too
//   (deny file-write*) but /dev/null             Landlock handles every write-class right and grants
//                                                WRITE only on /dev/null; seccomp also denies the
//                                                metadata calls Landlock does not cover (chmod, utime,
//                                                xattr, ...) and the mutating calls themselves
//   (deny network*)                              seccomp: no socket(), connect, bind, listen, accept;
//                                                io_uring (which would bypass seccomp) is denied too
//   (deny process-fork), exec of self only       seccomp: no fork/vfork, clone only for threads, clone3
//                                                answers ENOSYS; Landlock EXECUTE only on the worker
//                                                binary and its ELF interpreter; memfd_create refused
//   (allow signal (target self))                 seccomp: kill/tgkill/rt_*sigqueueinfo only to our own pid
//   (nothing)                                    NO_NEW_PRIVS, capabilities emptied, ptrace and friends
//                                                denied, core dumps off
//
// Landlock cannot express "everything except this subtree": a rule on a directory covers its whole
// subtree and rights only ever accumulate. So the read allowance is built by walking down from `/`
// along each denied path and granting every SIBLING along the way (`planReadAllow`). A directory
// created after the plan was made is therefore unreadable, which is the safe direction.
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The worker exit code for "the confinement is not in effect, so I did not run" (same value as `WORKFLOW_SANDBOX_REFUSED_EXIT_CODE`). */
export const LINUX_CONFINEMENT_REFUSED_EXIT_CODE = 77;
/** argv marker selecting the launcher role (`<winter> __linux-confine <spec>`). */
export const LINUX_CONFINE_ARGV_FLAG = "__linux-confine";
/**
 * The oldest Landlock ABI the Workflow accepts. ABI 3 is the first that governs every write-class
 * right (ABI 2 added REFER, ABI 3 TRUNCATE); older kernels would leave rename-across-directory and
 * truncate(2) to seccomp alone, and the boundary should not depend on that.
 */
export const LINUX_MIN_LANDLOCK_ABI = 3;

export type LinuxArch = "x64" | "arm64";

/** Typed refusal: the confinement the Workflow requires is not available. Callers never fall back to an unconfined run. */
export class LinuxConfinementUnavailableError extends Error {
  readonly code = "linux-confinement-unavailable";
  constructor(message: string) {
    super(message);
    this.name = "LinuxConfinementUnavailableError";
  }
}

export function linuxArchOf(arch: string): LinuxArch | undefined {
  return arch === "x64" || arch === "arm64" ? arch : undefined;
}

// --- The spec the parent passes to the launcher --------------------------------------------------

export interface LinuxConfinementSpec {
  version: 1;
  /** The worker to exec once confined. `file` is absolute. */
  target: { file: string; args: string[] };
  /** Absolute directories the worker must not read (the Winter run directories). */
  readDeny: string[];
  /** Raises, never lowers, the ABI floor. */
  minLandlockAbi: number;
}

function cleanString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new LinuxConfinementUnavailableError(`confinement spec: ${what} is not a clean string`);
  return value;
}
function absolutePath(value: unknown, what: string): string {
  const text = cleanString(value, what);
  if (!text.startsWith("/")) throw new LinuxConfinementUnavailableError(`confinement spec: ${what} is not an absolute path`);
  return text;
}

export function encodeConfinementSpec(spec: LinuxConfinementSpec): string {
  return Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
}

/** Strict: anything unexpected is a refusal, because the spec is what decides what runs. */
export function decodeConfinementSpec(text: string | undefined): LinuxConfinementSpec {
  if (text === undefined || text === "") throw new LinuxConfinementUnavailableError("confinement spec: missing");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new LinuxConfinementUnavailableError("confinement spec: not decodable");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new LinuxConfinementUnavailableError("confinement spec: not an object");
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) throw new LinuxConfinementUnavailableError("confinement spec: unknown version");
  const target = record.target as Record<string, unknown> | undefined;
  if (typeof target !== "object" || target === null || !Array.isArray(target.args)) throw new LinuxConfinementUnavailableError("confinement spec: target is malformed");
  const file = absolutePath(target.file, "target.file");
  const args = (target.args as unknown[]).map((arg, index) => cleanString(arg, `target.args[${index}]`));
  if (!Array.isArray(record.readDeny)) throw new LinuxConfinementUnavailableError("confinement spec: readDeny is malformed");
  const readDeny = (record.readDeny as unknown[]).map((entry, index) => absolutePath(entry, `readDeny[${index}]`));
  const min = record.minLandlockAbi;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 0 || min > 64) throw new LinuxConfinementUnavailableError("confinement spec: minLandlockAbi is malformed");
  return { version: 1, target: { file, args }, readDeny, minLandlockAbi: min };
}

// --- Syscall numbers -------------------------------------------------------------------------------
//
// Taken from the kernel's own tables (arch/x86/entry/syscalls/syscall_64.tbl for x64,
// include/uapi/asm-generic/unistd.h for arm64) and compared against the installed headers by the
// tests. A name missing for an architecture does not exist there (arm64 has no fork, mkdir, ...).

export const SYSCALL_NUMBERS: Readonly<Record<LinuxArch, Readonly<Record<string, number>>>> = {
  x64: {
    fork: 57, vfork: 58, clone: 56, clone3: 435, execve: 59, execveat: 322,
    unshare: 272, setns: 308, mount: 165, umount2: 166, pivot_root: 155, chroot: 161, open_tree: 428, move_mount: 429,
    mount_setattr: 442, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433,
    ptrace: 101, process_vm_readv: 310, process_vm_writev: 311, kcmp: 312, pidfd_open: 434, pidfd_getfd: 438,
    perf_event_open: 298, bpf: 321, userfaultfd: 323,
    io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
    kexec_load: 246, kexec_file_load: 320, init_module: 175, finit_module: 313, delete_module: 176, reboot: 169,
    swapon: 167, swapoff: 168, acct: 163, settimeofday: 164, sethostname: 170, setdomainname: 171, adjtimex: 159,
    clock_adjtime: 305, clock_settime: 227, quotactl: 179, syslog: 103, iopl: 172, ioperm: 173,
    add_key: 248, request_key: 249, keyctl: 250,
    open_by_handle_at: 304, name_to_handle_at: 303, memfd_secret: 447, memfd_create: 319,
    socket: 41, connect: 42, bind: 49, listen: 50, accept: 43, accept4: 288, socketpair: 53,
    mkdir: 83, mkdirat: 258, rmdir: 84, unlink: 87, unlinkat: 263, rename: 82, renameat: 264, renameat2: 316,
    link: 86, linkat: 265, symlink: 88, symlinkat: 266, mknod: 133, mknodat: 259, creat: 85,
    truncate: 76, ftruncate: 77, fallocate: 285, chmod: 90, fchmod: 91, fchmodat: 268, fchmodat2: 452,
    chown: 92, fchown: 93, lchown: 94, fchownat: 260, utime: 132, utimes: 235, futimesat: 261, utimensat: 280,
    setxattr: 188, lsetxattr: 189, fsetxattr: 190, removexattr: 197, lremovexattr: 198, fremovexattr: 199,
    setxattrat: 463, removexattrat: 466,
    kill: 62, tkill: 200, tgkill: 234, rt_sigqueueinfo: 129, rt_tgsigqueueinfo: 297,
    prctl: 157, capget: 125, capset: 126, prlimit64: 302, close_range: 436, seccomp: 317,
    landlock_create_ruleset: 444, landlock_add_rule: 445, landlock_restrict_self: 446,
  },
  arm64: {
    clone: 220, clone3: 435, execve: 221, execveat: 281,
    unshare: 97, setns: 268, mount: 40, umount2: 39, pivot_root: 41, chroot: 51, open_tree: 428, move_mount: 429,
    mount_setattr: 442, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433,
    ptrace: 117, process_vm_readv: 270, process_vm_writev: 271, kcmp: 272, pidfd_open: 434, pidfd_getfd: 438,
    perf_event_open: 241, bpf: 280, userfaultfd: 282,
    io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
    kexec_load: 104, kexec_file_load: 294, init_module: 105, finit_module: 273, delete_module: 106, reboot: 142,
    swapon: 224, swapoff: 225, acct: 89, settimeofday: 170, sethostname: 161, setdomainname: 162, adjtimex: 171,
    clock_adjtime: 266, clock_settime: 112, quotactl: 60, syslog: 116,
    add_key: 217, request_key: 218, keyctl: 219,
    open_by_handle_at: 265, name_to_handle_at: 264, memfd_secret: 447, memfd_create: 279,
    socket: 198, connect: 203, bind: 200, listen: 201, accept: 202, accept4: 242, socketpair: 199,
    mkdirat: 34, unlinkat: 35, renameat2: 276, linkat: 37, symlinkat: 36, mknodat: 33,
    truncate: 45, ftruncate: 46, fallocate: 47, fchmod: 52, fchmodat: 53, fchmodat2: 452,
    fchown: 55, fchownat: 54, utimensat: 88,
    setxattr: 5, lsetxattr: 6, fsetxattr: 7, removexattr: 14, lremovexattr: 15, fremovexattr: 16,
    setxattrat: 463, removexattrat: 466,
    kill: 129, tkill: 130, tgkill: 131, rt_sigqueueinfo: 138, rt_tgsigqueueinfo: 240,
    prctl: 167, capget: 90, capset: 91, prlimit64: 261, close_range: 436, seccomp: 277,
    landlock_create_ruleset: 444, landlock_add_rule: 445, landlock_restrict_self: 446,
  },
};

export function syscallNumber(arch: LinuxArch, name: string): number | undefined {
  return SYSCALL_NUMBERS[arch][name];
}

/** Answered with EPERM, whole. Grouped by the reason each is denied. */
export const DENIED_SYSCALLS: Readonly<Record<string, readonly string[]>> = {
  // Process creation. `clone` is handled separately: a thread is allowed, a new process is not.
  process: ["fork", "vfork"],
  // Namespace and mount manipulation.
  namespaces: ["unshare", "setns", "mount", "umount2", "pivot_root", "chroot", "open_tree", "move_mount", "mount_setattr", "fsopen", "fsconfig", "fsmount", "fspick"],
  // Reaching into other processes or the kernel's tracing/BPF machinery.
  introspection: ["ptrace", "process_vm_readv", "process_vm_writev", "kcmp", "pidfd_open", "pidfd_getfd", "perf_event_open", "bpf", "userfaultfd"],
  // io_uring performs socket/connect/open on the caller's behalf without consulting seccomp.
  asyncIo: ["io_uring_setup", "io_uring_enter", "io_uring_register"],
  // Host-wide state.
  host: ["kexec_load", "kexec_file_load", "init_module", "finit_module", "delete_module", "reboot", "swapon", "swapoff", "acct", "settimeofday", "sethostname", "setdomainname", "adjtimex", "clock_adjtime", "clock_settime", "quotactl", "syslog", "iopl", "ioperm"],
  keyrings: ["add_key", "request_key", "keyctl"],
  // memfd_create: an anonymous file has no path, so Landlock's path-based EXECUTE cannot see it, and a copy
  // of another program written into one would run (measured on the CI kernels). Refused so that "exec only
  // the worker and its loader" holds.
  handles: ["open_by_handle_at", "name_to_handle_at", "memfd_secret", "memfd_create"],
  // `(deny network*)`. socketpair is allowed for AF_UNIX only (see the program).
  network: ["socket", "connect", "bind", "listen", "accept", "accept4"],
  // `(deny file-write*)`: Landlock covers the data-write rights; these cover the rest.
  filesystem: [
    "mkdir", "mkdirat", "rmdir", "unlink", "unlinkat", "rename", "renameat", "renameat2", "link", "linkat", "symlink", "symlinkat", "mknod", "mknodat", "creat",
    "truncate", "ftruncate", "fallocate", "chmod", "fchmod", "fchmodat", "fchmodat2", "chown", "fchown", "lchown", "fchownat",
    "utime", "utimes", "futimesat", "utimensat", "setxattr", "lsetxattr", "fsetxattr", "removexattr", "lremovexattr", "fremovexattr", "setxattrat", "removexattrat",
  ],
  // tkill names a bare thread id, which is global; tgkill names the process too and can be checked.
  signals: ["tkill"],
};

/** Signal-sending calls whose first argument is the target process: allowed only when it is this process. */
export const SELF_ONLY_SIGNAL_SYSCALLS = ["kill", "tgkill", "rt_sigqueueinfo", "rt_tgsigqueueinfo"] as const;

export function deniedSyscallNames(): string[] {
  return Object.values(DENIED_SYSCALLS).flat();
}

// --- The seccomp program -----------------------------------------------------------------------------

const AUDIT_ARCH: Readonly<Record<LinuxArch, number>> = { x64: 0xc000003e, arm64: 0xc00000b7 };
export const SECCOMP_RET_KILL_PROCESS = 0x80000000;
export const SECCOMP_RET_ALLOW = 0x7fff0000;
export const SECCOMP_RET_ERRNO = 0x00050000;
export const EPERM = 1;
export const ENOSYS = 38;
const X32_SYSCALL_BIT = 0x40000000;

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_JSET_K = 0x45;
const BPF_RET_K = 0x06;

const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const offsetOfArg = (index: number): number => 16 + 8 * index;

const CLONE_THREAD = 0x00010000;
// CLONE_NEWTIME | CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET
const CLONE_NAMESPACE_FLAGS = 0x00000080 | 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;
const AF_UNIX = 1;

interface Instruction {
  code: number;
  k: number;
  jt?: string;
  jf?: string;
}

/** A classic-BPF assembler with labels, so no jump offset is ever computed by hand. */
class BpfProgram {
  private readonly instructions: Instruction[] = [];
  private readonly labels = new Map<string, number>();

  label(name: string): void {
    if (this.labels.has(name)) throw new Error(`bpf: duplicate label ${name}`);
    this.labels.set(name, this.instructions.length);
  }
  load(offset: number): void {
    this.instructions.push({ code: BPF_LD_W_ABS, k: offset });
  }
  jeq(k: number, ifTrue?: string, ifFalse?: string): void {
    this.instructions.push({ code: BPF_JEQ_K, k, ...(ifTrue !== undefined ? { jt: ifTrue } : {}), ...(ifFalse !== undefined ? { jf: ifFalse } : {}) });
  }
  jge(k: number, ifTrue?: string, ifFalse?: string): void {
    this.instructions.push({ code: BPF_JGE_K, k, ...(ifTrue !== undefined ? { jt: ifTrue } : {}), ...(ifFalse !== undefined ? { jf: ifFalse } : {}) });
  }
  jset(k: number, ifTrue?: string, ifFalse?: string): void {
    this.instructions.push({ code: BPF_JSET_K, k, ...(ifTrue !== undefined ? { jt: ifTrue } : {}), ...(ifFalse !== undefined ? { jf: ifFalse } : {}) });
  }
  ret(value: number): void {
    this.instructions.push({ code: BPF_RET_K, k: value });
  }

  build(): Buffer {
    const out = Buffer.alloc(this.instructions.length * 8);
    this.instructions.forEach((instruction, index) => {
      const offsetTo = (label: string | undefined): number => {
        if (label === undefined) return 0;
        const target = this.labels.get(label);
        if (target === undefined) throw new Error(`bpf: unknown label ${label}`);
        const distance = target - (index + 1);
        // A backward or oversized jump cannot be encoded; refuse to build rather than wrap.
        if (distance < 0 || distance > 255) throw new Error(`bpf: jump to ${label} out of range (${distance})`);
        return distance;
      };
      out.writeUInt16LE(instruction.code, index * 8);
      out.writeUInt8(offsetTo(instruction.jt), index * 8 + 2);
      out.writeUInt8(offsetTo(instruction.jf), index * 8 + 3);
      out.writeUInt32LE(instruction.k >>> 0, index * 8 + 4);
    });
    return out;
  }
}

/**
 * The seccomp-BPF program for the worker: a deny list over an allow-by-default base (a worker is a
 * full JS runtime and needs most of the syscall surface), with a kill for any foreign ABI.
 * `selfPid` is the worker's pid: signals may only target it. A pid survives execve, so the launcher
 * knows the final value before it execs.
 */
export function buildSeccompProgram(arch: LinuxArch, selfPid: number): Buffer {
  if (!Number.isInteger(selfPid) || selfPid < 1 || selfPid > 0x7fffffff) throw new Error("seccomp: selfPid out of range");
  const nr = (name: string): number | undefined => syscallNumber(arch, name);
  const program = new BpfProgram();

  program.load(OFFSET_ARCH);
  program.jeq(AUDIT_ARCH[arch], undefined, "kill");
  program.load(OFFSET_NR);
  if (arch === "x64") program.jge(X32_SYSCALL_BIT, "kill"); // the x32 ABI shares the arch value
  const clone3 = nr("clone3");
  if (clone3 !== undefined) program.jeq(clone3, "enosys");
  const clone = nr("clone");
  if (clone !== undefined) program.jeq(clone, "clone");
  const socketpair = nr("socketpair");
  if (socketpair !== undefined) program.jeq(socketpair, "socketpair");
  for (const name of SELF_ONLY_SIGNAL_SYSCALLS) {
    const number = nr(name);
    if (number !== undefined) program.jeq(number, "self-only");
  }
  for (const name of deniedSyscallNames()) {
    const number = nr(name);
    if (number !== undefined) program.jeq(number, "eperm");
  }
  program.ret(SECCOMP_RET_ALLOW);

  // clone: a thread (CLONE_THREAD) with no namespace flag is the only form allowed.
  program.label("clone");
  program.load(offsetOfArg(0));
  program.jset(CLONE_NAMESPACE_FLAGS, "eperm");
  program.jset(CLONE_THREAD, "allow", "eperm");
  // socketpair: local pairs only.
  program.label("socketpair");
  program.load(offsetOfArg(0));
  program.jeq(AF_UNIX, "allow", "eperm");
  // kill-class calls: first argument is the target pid, compared as the 32-bit value it is.
  program.label("self-only");
  program.load(offsetOfArg(0));
  program.jeq(selfPid, "allow", "eperm");

  program.label("eperm");
  program.ret(SECCOMP_RET_ERRNO | EPERM);
  program.label("enosys");
  program.ret(SECCOMP_RET_ERRNO | ENOSYS);
  program.label("allow");
  program.ret(SECCOMP_RET_ALLOW);
  program.label("kill");
  program.ret(SECCOMP_RET_KILL_PROCESS);
  return program.build();
}

// --- Landlock --------------------------------------------------------------------------------------------

export const LANDLOCK_CREATE_RULESET_VERSION = 1;
export const LANDLOCK_RULE_PATH_BENEATH = 1;

export const LANDLOCK_FS = {
  EXECUTE: 1n << 0n,
  WRITE_FILE: 1n << 1n,
  READ_FILE: 1n << 2n,
  READ_DIR: 1n << 3n,
  REMOVE_DIR: 1n << 4n,
  REMOVE_FILE: 1n << 5n,
  MAKE_CHAR: 1n << 6n,
  MAKE_DIR: 1n << 7n,
  MAKE_REG: 1n << 8n,
  MAKE_SOCK: 1n << 9n,
  MAKE_FIFO: 1n << 10n,
  MAKE_BLOCK: 1n << 11n,
  MAKE_SYM: 1n << 12n,
  REFER: 1n << 13n,
  TRUNCATE: 1n << 14n,
} as const;

/** Every filesystem right the given ABI knows (up to ABI 3, the highest this policy reasons about). */
export function landlockHandledRights(abi: number): bigint {
  let rights = (1n << 13n) - 1n; // ABI 1: bits 0..12
  if (abi >= 2) rights |= LANDLOCK_FS.REFER;
  if (abi >= 3) rights |= LANDLOCK_FS.TRUNCATE;
  return rights;
}

export const LANDLOCK_READ_FILE_RIGHTS = LANDLOCK_FS.READ_FILE;
export const LANDLOCK_READ_DIR_RIGHTS = LANDLOCK_FS.READ_FILE | LANDLOCK_FS.READ_DIR;
export const LANDLOCK_EXEC_RIGHTS = LANDLOCK_FS.EXECUTE | LANDLOCK_FS.READ_FILE;
/** /dev/null is the one file the worker may write (the profile's `(allow file-write-data (path "/dev/null"))`). */
export const LANDLOCK_DEV_NULL_RIGHTS = LANDLOCK_FS.WRITE_FILE | LANDLOCK_FS.READ_FILE | LANDLOCK_FS.TRUNCATE;

export interface ReadAllowEntry {
  path: string;
  directory: boolean;
}

/** `path`, resolved through symlinks for the part that exists, with the part that does not exist kept as written. */
export function canonicalDenyPath(path: string): string {
  const absolute = resolve(path);
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.push(basename(head));
      head = parent;
    }
  }
}

interface TrieNode {
  children: Map<string, TrieNode>;
  denied: boolean;
}

const isDecimal = /^[0-9]+$/;

/**
 * The top-level read allowance: every path the worker may read, as the smallest set of Landlock
 * rules that leaves `denyPaths` (and the other processes' /proc directories) uncovered.
 *
 * Walks from `root` (`/`; a test may point it at a scratch tree). At each directory that lies on the
 * way to a denied path, grants every entry except the one that continues toward the denial;
 * elsewhere grants the directory whole. A symlink is followed and judged by where it lands, so a
 * link into a denied tree grants nothing.
 */
export function planReadAllow(opts: { denyPaths: readonly string[]; selfPid: number; root?: string }): ReadAllowEntry[] {
  const root = opts.root ?? "/";
  const joinUnder = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);
  const procDir = joinUnder(root, "proc");
  const denied = opts.denyPaths.map(canonicalDenyPath).filter((path) => path.startsWith(root === "/" ? "/" : `${root}/`));
  const top: TrieNode = { children: new Map(), denied: false };
  const insert = (path: string, mark: boolean): void => {
    let node = top;
    for (const part of path.slice(root === "/" ? 1 : root.length + 1).split("/").filter((p) => p !== "")) {
      let next = node.children.get(part);
      if (next === undefined) {
        next = { children: new Map(), denied: false };
        node.children.set(part, next);
      }
      node = next;
    }
    if (mark) node.denied = true;
  };
  for (const path of denied) insert(path, true);
  insert(procDir, false); // always walked, never granted whole

  const isUnder = (path: string, base: string): boolean => path === base || path.startsWith(base === "/" ? "/" : `${base}/`);
  const selfProc = joinUnder(procDir, String(opts.selfPid));
  // A landing place is unsafe when it is, contains, or sits inside something withheld.
  const unsafe = (landing: string): boolean => {
    for (const deny of denied) if (isUnder(landing, deny) || isUnder(deny, landing)) return true;
    if (isUnder(procDir, landing)) return true; // /proc itself, or something holding it: would grant every pid directory
    if (isUnder(landing, procDir)) {
      const pid = landing.slice(procDir.length + 1).split("/")[0] ?? "";
      if (isDecimal.test(pid) && joinUnder(procDir, pid) !== selfProc) return true;
    }
    return false;
  };

  const out = new Map<string, ReadAllowEntry>();
  const grant = (path: string): void => {
    let landing = path;
    try {
      if (lstatSync(path).isSymbolicLink()) landing = realpathSync(path);
    } catch {
      return;
    }
    if (unsafe(landing)) return;
    try {
      out.set(landing, { path: landing, directory: statSync(landing).isDirectory() });
    } catch {
      /* unreadable or vanished: not granted */
    }
  };

  const walk = (dir: string, node: TrieNode): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const child = joinUnder(dir, name);
      const next = node.children.get(name);
      if (next !== undefined) {
        if (next.denied) continue;
        let isRealDirectory = false;
        try {
          isRealDirectory = lstatSync(child).isDirectory();
        } catch {
          /* gone */
        }
        if (isRealDirectory) walk(child, next);
        continue;
      }
      if (dir === procDir) {
        if (isDecimal.test(name) && name !== String(opts.selfPid)) continue;
        if (name === "self" || name === "thread-self") continue; // symlinks into our own /proc/<pid>
      }
      grant(child);
    }
  };
  walk(root, top);
  return [...out.values()];
}

// --- Exec target ---------------------------------------------------------------------------------------------

const ELF_MACHINE: Readonly<Record<LinuxArch, number>> = { x64: 62, arm64: 183 };
const PT_INTERP = 3;

/** Reads an ELF64 little-endian header: its machine and, if it asks for one, its interpreter path. */
export function parseElfHead(head: Uint8Array): { machine: number; interpreter: string | undefined } {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.byteLength < 64 || view.getUint32(0, false) !== 0x7f454c46) throw new LinuxConfinementUnavailableError("the worker is not an ELF executable");
  if (view.getUint8(4) !== 2 || view.getUint8(5) !== 1) throw new LinuxConfinementUnavailableError("the worker is not a little-endian 64-bit ELF executable");
  const machine = view.getUint16(18, true);
  const phoff = Number(view.getBigUint64(32, true));
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  let interpreter: string | undefined;
  for (let index = 0; index < phnum; index++) {
    const at = phoff + index * phentsize;
    if (at + 56 > head.byteLength) throw new LinuxConfinementUnavailableError("the worker's program headers are out of reach");
    if (view.getUint32(at, true) !== PT_INTERP) continue;
    const offset = Number(view.getBigUint64(at + 8, true));
    const size = Number(view.getBigUint64(at + 32, true));
    if (size < 2 || offset + size > head.byteLength) throw new LinuxConfinementUnavailableError("the worker's interpreter path is out of reach");
    const bytes = head.subarray(offset, offset + size);
    const end = bytes.indexOf(0);
    interpreter = Buffer.from(bytes.subarray(0, end === -1 ? bytes.length : end)).toString("utf8");
  }
  return { machine, interpreter };
}

export interface ExecPlan {
  /** The worker binary, symlinks resolved. */
  target: string;
  /** Its ELF interpreter (the dynamic loader), symlinks resolved; absent for a static binary. */
  interpreter: string | undefined;
}

const ELF_HEAD_BYTES = 65536;

/** The two files the kernel opens with execute intent when it execs `file`. */
export function planExec(file: string, arch: LinuxArch): ExecPlan {
  let target: string;
  let head: Buffer;
  try {
    target = realpathSync(file);
    if (!statSync(target).isFile()) throw new Error("not a regular file");
    const fd = openSync(target, "r");
    try {
      head = Buffer.alloc(ELF_HEAD_BYTES);
      head = head.subarray(0, readSync(fd, head, 0, ELF_HEAD_BYTES, 0));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof LinuxConfinementUnavailableError) throw error;
    throw new LinuxConfinementUnavailableError(`the worker executable cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const elf = parseElfHead(head);
  if (elf.machine !== ELF_MACHINE[arch]) throw new LinuxConfinementUnavailableError("the worker executable is not built for this architecture");
  let interpreter: string | undefined;
  if (elf.interpreter !== undefined) {
    try {
      interpreter = realpathSync(elf.interpreter);
    } catch {
      throw new LinuxConfinementUnavailableError("the worker's dynamic loader is not present");
    }
  }
  return { target, interpreter };
}

# Isolated instruction reader: private source contract

2026-10-13. This adds a **distinct, unwired source prerequisite** based on merged
SDK `182c0c115140c0723aa084e53dbf72b1615a4f18`. It changes no existing launcher,
header, Root producer, query/profile, engine, ownership ABI, build workflow or
consumer pin. It does not admit a native experiment or implement guided Cowork.
The native Mac two-disk, egress and GUI holds remain in force. No native helper,
namespace, mount, VM, device or proc fixture was executed for this change.

## Exact Root-only launch envelope

```
linux-instruction-reader-compartment instruction-reader-v1 \
  executableFD privateViewPath receiptSocketFD readerUID workspaceGID \
  sourceDirectoryFD sourceGuestPath sourceCwd sharedGuidanceDirectoryFD \
  dependencyCount (dependencyFD dependencyGuestPath)*
```

The count is exact: `argc == 12 + 2 * dependencyCount`, including argv0. IDs and
FD numbers are canonical decimal without signs or leading zeroes. FDs are
distinct, 3–65535; reader UID/workspace GID are 1000–65535. The Root launch
configuration, not reader JSON or a guest request, supplies all descriptor and
mount fields. This is not an extension of `file` or `process` tool requests.

| Field | Closed contract |
| --- | --- |
| privateViewPath | `/run/winter/instruction-reader-views/<id>`; Root-owned 0700 final directory, all ancestors Root-owned and not writable by other identities; empty and exclusively held by Root for this lifetime |
| sourceGuestPath | Exactly `/workspace/folders/<id>` or `/workspace/repos/<id>`; one selected source per reader |
| sourceCwd | Canonical absolute lexical descendant of the selected source, or that source itself; at most 4096 ASCII printable bytes, no empty/`.`/`..` component; only a validated lookup hint, never executable cwd |
| shared guidance | Fixed mount `/run/winter/shared-instructions`; Root supplies the dedicated canonical directory descriptor, independent of tool roots |
| executableFD | Root-measured actual compiled loader executable; O_RDONLY, Root-owned, regular, single-link, no writable mode bits, executable mode present |
| dependencies | 0–32 exact immutable file descriptors; same immutable-file checks; canonical file targets beneath `/lib/`, `/lib64/` or `/usr/lib/`, at most 1024 bytes; no duplicate or ancestor/descendant targets and no environment directory mounts |
| receiptSocketFD | Root-peer SOCK_SEQPACKET socket; SO_PEERCRED UID0 and PID equal to launcher's direct Root parent |
| fds0/1/2 | Explicit pipe-only O_RDONLY stdin and O_WRONLY stdout/stderr; no inherited terminal, file, socket or directory in the loader envelope |

`<id>` is `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. A legitimate `grant..id` or
`repo..id` is accepted; exact `.`/`..` path components are refused. Paths do not
accept whitespace/control bytes. Dependency targets contain no symlink-created
skeleton; Root materializes only explicit regular-file mountpoints.

Root must reserve `readerUID` independently from UID0, the runtime UID and tool
UID. The primary GID equals readerUID; supplementary membership is exactly the
Root-selected workspaceGID, required to read selected sources such as
`2770 TOOL_UID:WORKSPACE_GROUP`. Root must ensure this group confers no protected
store/home/config write authority. Read-only mounts enforce source/guidance
writes even when the workspace group ordinarily has write permission. The
launcher cannot validate absent runtime/tool IDs or protected directory FDs;
these are mandatory prelaunch Root admission checks, not claims of this parser.

Before launching, Root must compare held descriptor identities and ancestry,
rejecting equality/overlap in either direction between source, dedicated guidance
and protected stores/run homes/config/control/peer/credential objects, including
the actual recursive nested-mount inventory. Every nested data mount must already
be readable under the selected tool grants; recursive clone must not add a new
private-state/data mount omitted from the corresponding tool view. The C role
also refuses source/guidance equality by `(st_dev, st_ino)`; that check is not
ancestry enforcement. Root must bind the complete measured executable and
recursive ELF interpreter/dependency closure to the owner, canonical workspace,
source grants, generation and pending parent context request. Immutable-file mode
checks are corroboration, not hash admission. No object-shaped JSON registration
or matching nonce creates this authority.

## Reader view, identity and exec

The Root-created launcher clones admitted source/guidance directories before unsharing, using
`open_tree(CLONE|CLOEXEC|AT_EMPTY_PATH|AT_RECURSIVE)` and recursive mount attributes.
Exact executable/dependency files use nonrecursive clones. Each detached clone is
made private before attachment. Source and guidance are
recursively read-only/nosuid/nodev/noexec. Exact executable/dependency mounts are
read-only/nosuid/nodev; Root must admit executable-compatible mount flags. There
is no broad `/usr`, `/bin`, `/lib` environment tree. Private mount, PID, IPC, UTS
and network namespaces precede the namespace-init fork. Root propagation is
recursively private.

The skeleton is a 16 MiB tmpfs, remounted read-only/nosuid/nodev/noexec. It has an
empty Root-owned read-only `/run/winter/instruction-reader` and a private 8 MiB
tmpfs `/tmp` with nosuid/nodev/noexec. There is no proc, device tree/entropy
device, conversation/store/run home, owner library, bootstrap FD, control socket,
credential, peer handle or canonical `.winter` alias in this first reader view.
The actual loader begins shared guidance at
`/run/winter/shared-instructions/WINTER.md`; the canonical tool-readable alias is
a separate native view/read-route obligation, not implemented by this role.

The child arms `PDEATHSIG(SIGKILL)` and checks its held monitor pidfd **before**
privileged mount/setup. After changing credentials it re-arms and checks again.
It drops all bounding/effective/permitted/inheritable capabilities, sets
no_new_privs, applies CPU 3s/NOFILE 64/NPROC 32/CORE 0/FSIZE 0 hard/soft limits and
closes every FD at or above 3 before exec. FSIZE 0 forbids regular-file growth, while pipe output
remains subject to Root's separate byte limits; honest Bun compatibility with
that ceiling is unproven. Explicit close is required: source/guidance
descriptors still name the original parent's mount, so CLOEXEC alone is not the
desired pre-exec disposal. Only pipe fds 0/1/2 survive into the loader.

The exact exec is:

```
cwd: /run/winter/instruction-reader
argv: /instruction-reader --instruction-reader-v1
env: LANG=C LC_ALL=C TZ=UTC HOME=/run/winter/instruction-reader TMPDIR=/tmp PATH=/usr/bin:/bin
```

There is no inherited environment. Source cwd is passed through the separately
bounded Root-generated JSON loader request and validated by the actual loader
wrapper; it is not the process cwd. The entry must be compiled with Bun autoload
disabled for bunfig, dotenv, tsconfig and package.json. The exact compiled entry,
these flags, all source/dependency closure and planted configuration/preload/env
negative oracles are still owed; this C source does not build or attest them.

The independent reader seccomp filter refuses all socket creation/connect/bind/
listen/accept and socket message operations, namespace/mount changes, ptrace,
process_vm, file-handle lookup, BPF/perf, pidfd access and io_uring setup. It denies
fork/vfork and permits legacy clone only with zero high 32 flag bits and a closed
pthread flag mask containing VM/SIGHAND/THREAD; clone3 returns ENOSYS for libc's
filtered fallback. Unsupported architecture/x86 x32 numbers kill the process.
This is an allow-by-default filter for other ordinary Bun operations, not a
claimed minimal syscall allowlist. No socket FD survives exec regardless of
filter behavior.

No RLIMIT_AS is applied: compiled Bun reserves large virtual address space.
Physical RSS accounting/ceiling remains **UNPROVEN**, requiring future Root
cgroup/resource integration. Wall time, tmpfs size and loader byte budgets do
not establish an RSS limit. Honest compiled Bun compatibility with no proc/dev,
the empty cwd, thread mask and resource ceilings is also **UNPROVEN**. If native
admission later finds required facilities, stop for review; do not widen them
automatically.

## Native lifecycle versus outstanding reader debt

The Root service launches this compiled role directly, never by forking a
protected SDK runtime. The outer launcher obtains the Root service pidfd, arms
PDEATHSIG and corroborates liveness. After forking the PID-namespace init it
retains only the receipt socket and init pidfd: all original descriptors,
detached mounts and fds 0/1/2 are explicitly closed in the monitor before the `I`
message. Copies avoid fd-remap alias collisions. No monitor filesystem FD is
passed to the loader.

On the separate Root-only socket, the immutable monitor sends one-byte `I` plus
SCM_RIGHTS namespace-init pidfd. Any later Root packet, socket hangup/error or
expiration of the absolute 4000 ms monotonic budget triggers SIGKILL through that
pidfd. Only **after actual waitpid** does it send `R` followed by the four-byte
native wait status, using the existing native receipt discipline on this distinct
role/service. Namespace-init completion is the namespace-descendant teardown
receipt, not a loader JSON success, pipe EOF, timeout or successful kill call.

This timeout is an attempted monitor kill deadline, **not a bounded termination
guarantee**. This 4s reader budget is below the host Core resolver's 5s budget to
leave cleanup/render margin; that margin is not a cleanup guarantee. Descriptor
cloning/setup, native kernel operations or waitpid can
block; missing/uncertain receipt must remain unresolved ownership debt. Root
must independently supervise the total launch lifetime, revoke on owner loss/
cancellation/stale generation, kill the init through its received pidfd, await
the real monitor receipt and exit, drain stdout/stderr and retain debt on every
uncertain state. No future producer/pending-context/dispatch/release plumbing is
implemented here. Cancellation-before-I and monitor/service loss require explicit
Root handling and cannot be inferred from these source tests.

The separately reviewed Root producer/wrapper must cap exactly one stdin request
at 16 KiB, stdout at 320 KiB and stderr at 16 KiB. Overrun must kill, reap and drain
before resolving `context_unavailable`; duplicate occurrence growth can exceed
the stdout ceiling and must fail closed rather than silently truncate. Root
retains one outstanding reader and blocks provider dispatch and normal owner
release until cleanup is proved. These output/request caps and debt policy are
**future producer obligations**, not limits implemented by this native monitor.

The actual RuntimeSDK PR5 structured loader must require Root-selected maxima of
128 KiB/file, 256 KiB raw reads, 256 occurrences and 128 KiB expansion before
reading/expanding, without falling back to legacy unbounded defaults. It reads
selected source/shared guidance only and returns bounded structured data. The
host retains Core planning/mapping/final policy checks and immutable facts,
publication obligations and grants. The known pathname race cannot reveal absent
protected state in the intended view, but may select admitted shared/dependency
bytes under a source label: **strict atomic tier/root attribution is not proved**.
No authority may be derived from guidance provenance. A stronger root-aware
descriptor filesystem adapter remains necessary if exact attribution is required.

## Source validation and remaining native gate

Run the portable regression from this SDK worktree:

```
python3 -I -S scripts/guest-engine/test_instruction_reader_source.py
```

The four portable tests compile extracted pure/parser/mount/filter functions with existing
portable `cc`. Mount syscalls and seccomp install are inert stand-ins; an inert
BPF interpreter checks both architecture branches and all 64 clone flag bits.
They check malformed/surplus arguments, descriptor aliases, source/cwd/dependency
grammar, maximum dependency count, double-dot IDs, recursive RO/private clone
flags, failure paths, socket/process denial and source lifecycle ordering.
Source substring checks are structural regression evidence, not kernel or Bun
proof. No new native launcher or compiled reader is executed.

A fifth Linux-only test compiles the entire new role to an object with existing
`cc`, `-std=c11 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2
-fstack-protector-strong -fPIE -c`. It never links or executes that output. On this
Mac it is explicitly skipped; complete Linux role compilation remains unverified
until the separately reviewed source CI actually passes. The new narrowly scoped
`cowork-isolated-reader-source.yml` runs those checks on ubuntu-24.04-arm only for
this feature branch's push/PR, with read-only repository permission and no sudo,
native-helper execution, namespace/mount/VM/proc fixture. All existing workflows
and native admission inventories stay unchanged. No push precedes source review.

Before any separately admitted Linux run, Root+reviewer45+Astra must review fresh
compiled closure, distinct fourth-role receipts and native view inventory.
Required actual oracles include held Root pidfd-bound post-exec FD inventory
exactly 0/1/2; distinct UID/group/zero caps; no protected mounts or original FDs;
positive actual-loader guidance read; source/ancestor replacement toward store/
config canaries, outside paths and proc magic links; FIFO/device/growing files;
input/output overrun and owner/cancel/deadline handling; real reap/drain debt;
planted Bun autoload/env/config negatives and fresh shared-directory rename;
revocation with zero later provider requests. The guest need not gain proc to
observe its FDs: the Root-side oracle must bind observations to the received
namespace-init pidfd/actual exec identity. Ordinary source tests cannot satisfy
these gates. Existing B admission and the native Mac/egress holds remain unchanged.

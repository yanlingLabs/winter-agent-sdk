# Isolated instruction reader: private source contract

2026-10-13. This adds a **distinct, unwired source prerequisite** based on merged
SDK `182c0c115140c0723aa084e53dbf72b1615a4f18`. It changes no existing launcher,
header, Root producer, query/profile, engine, ownership ABI, build workflow or
consumer pin. It does not admit a native experiment or implement guided Cowork.
The native Mac two-disk, egress and GUI holds remain in force. No native helper,
namespace, mount, VM, device or proc fixture was executed for this change.

2026-10-14 amendment (branch `cowork/reader-runtime-compatibility`): the sealed view
gains exactly two runtime-compatibility additions and fail-closed pre-exec invariants,
described in "Runtime-compatibility view" below. The role stays unwired and nothing
else about the launch envelope changes. No Linux code was executed for this change
either; every statement about kernel behavior below is source-derived and unverified.

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
| sourceCwd | Canonical absolute lexical descendant of the selected source, or that source itself; at most 4096 bytes, no C0/DEL/backslash or empty/`.`/`..` component; spaces and UTF-8 path bytes allowed; only a validated lookup hint, never executable cwd |
| shared guidance | Fixed mount `/run/winter/shared-instructions`; Root supplies the dedicated canonical directory descriptor, independent of tool roots |
| executableFD | Root-measured actual compiled loader executable; O_RDONLY, Root-owned, regular, single-link, no writable mode bits, executable mode present |
| dependencies | 0–32 exact immutable file descriptors; same immutable-file checks; canonical file targets beneath `/lib/`, `/lib64/` or `/usr/lib/`, at most 1024 bytes; no duplicate or ancestor/descendant targets and no environment directory mounts |
| receiptSocketFD | Root-peer SOCK_SEQPACKET socket; SO_PEERCRED UID0 and PID equal to launcher's direct Root parent |
| fds0/1/2 | Explicit pipe-only O_RDONLY stdin and O_WRONLY stdout/stderr; no inherited terminal, file, socket or directory in the loader envelope |

`<id>` is `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`. A legitimate `grant..id` or
`repo..id` is accepted; exact `.`/`..` path components are refused. Paths do not
accept control bytes or backslashes. Source cwd supports ordinary spaces and
Unicode names; Root must supply a canonically validated UTF-8 spelling because
the C component parser treats non-ASCII bytes as opaque. Dependency targets keep
the narrower printable ASCII grammar without whitespace and contain no
symlink-created skeleton; Root materializes only explicit regular-file mountpoints.

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
tmpfs `/tmp` with nosuid/nodev/noexec, plus the two additions below (an
otherwise-empty `/dev` holding one read-only entropy node, and a subset procfs).
There is no host proc, sysfs, other device node, conversation/store/run home,
owner library, bootstrap FD, control socket, credential, peer handle or canonical
`.winter` alias in this reader view.
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
wrapper; it is not the process cwd. Root must require the launch envelope's
source root/cwd to equal the request's `views.sourceRoot`/`views.sourceCwd` before
launch, and bind both to the same canonical registration. The currently unwired
C role does not parse stdin or establish that equality. The entry must be compiled with Bun autoload
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
not establish an RSS limit. Honest compiled Bun compatibility with this view (one
entropy node, a subset procfs), the empty cwd, thread mask and resource ceilings is
also **UNPROVEN**. If native admission later finds required facilities, stop for
review; do not widen them automatically.

## Runtime-compatibility view

**Why.** Two dependencies of the pinned Bun 1.3.14 runtime are source requirements,
not observations: WebKit's `WTF/RandomDevice.cpp` (pinned `5488984d`) unconditionally
opens `/dev/urandom` and crashes if that fails, and `WTF/StackBounds.cpp` calls glibc's
`pthread_getattr_np` on the initial thread, which reads `/proc/self/maps`. The previous
view had neither. This is the narrow view that satisfies them. It is **not** a
diagnosis of any recorded run, and nothing here claims to explain one.

**Exactly two additions** (everything else in the view is unchanged; no seccomp, rlimit,
credential or environment change, and no JIT or randomness workaround):

| Addition | Construction | Flags |
| --- | --- | --- |
| `/dev` holding only `urandom` | `/dev` is a plain directory on the skeleton tmpfs (no mount of its own). `/dev/urandom` is a read-only bind of the host character device, cloned from the opened descriptor with `open_tree` **before** `unshare` (mirrors the runtime and tool compartments), then attached with `move_mount`. | mount `ro,nosuid,noexec`, `nodev` cleared on this one mount only; kernel identity char 1:9 proven by `fstat` on the host descriptor, again on the attached node (`O_PATH`), and again in the final view |
| `/proc` | `mount("proc", ..., "subset=pid,hidepid=invisible")`, called by the forked namespace init, i.e. PID 1 of the new PID namespace, so the instance belongs to that namespace. | `MS_RDONLY\|MS_NOSUID\|MS_NODEV\|MS_NOEXEC` |

Order: entropy clone (host side, in the original mount namespace) → `unshare` of the mount,
PID, IPC, UTS and network namespaces → recursive-private `/` → `fork` → namespace init arms death/pidfd → skeleton tmpfs →
source, guidance, executable, dependency attaches → `/tmp` tmpfs → **entropy attach and
identity re-check** → **procfs mount** → read-only skeleton remount → `chroot`/`chdir`
→ rlimits → no_new_privs/capability drop/credential change → `close_range(3, ~0)` →
seccomp filter → `umask` → **final-view invariants** → `execve`. Both mounts need a
writable skeleton and CAP_SYS_ADMIN, so both precede the remount and the capability drop.
A procfs mounted before the PID-namespace `fork` would belong to the parent namespace.

**Pre-exec invariants** (checked as the reader identity, under the final filter,
immediately before `execve`; each failure sets a fixed `errno`, prints one
`perror` label and exits 77 like every other setup failure; labels are distinct):

| Id | Check | Label |
| --- | --- | --- |
| B1 | getdents of the `/proc` root yields only `.`, `..`, `self`, `thread-self` (each at most once) and exactly one numeric entry, `1`. Because of `hidepid=invisible` this proves the instance is this namespace's own view, not the absence of other users' processes; that guarantee comes from the fresh PID namespace plus the unchanged clone filter, which still forbids child processes (threads only). Whether `.`/`..` are emitted under `subset=pid` is unverified; the classifier accepts both. | `reader proc root inventory` |
| B2 | process is PID 1; `stat("/proc/1/root")` and `stat("/")` have equal dev/ino; `stat("/proc/1/cwd")` and `stat(".")` have equal dev/ino. | `reader init process id`, `reader proc root identity`, `reader proc cwd identity` |
| B3 | An outside canary stays invisible. **Harness obligation, not implemented in C**: the harness must plant a canary process/file outside the namespace (a host PID the probe's `proc_numeric` must not count, a host device node that must not appear) and bind observations to the received namespace-init pidfd. | (harness) |
| B4 | `/proc/self/mountinfo` lists exactly the expected table and nothing else: `/` tmpfs `ro,nosuid,nodev,noexec`; source and shared guidance (and mounts nested beneath them by the recursive clone) `ro,nosuid,nodev,noexec`; `/instruction-reader` and every dependency path `ro,nosuid,nodev`; `/tmp` tmpfs `rw,nosuid,nodev,noexec`; `/dev/urandom` `ro,nosuid,noexec` without `nodev`; `/proc` type `proc` `ro,nosuid,nodev,noexec` with superblock options containing `subset=pid` and `hidepid=invisible`. Each exactly once. Unreachable host mounts are not listed by the kernel after `chroot`. | `reader mount inventory` |
| B5 | the open-descriptor table (`/proc/self/fd`, the enumerating handle excluded) is exactly 0, 1, 2, each still the verified FIFO with the right direction and no close-on-exec flag. | `reader descriptor inventory`, `reader descriptor kind` |
| - | the entropy node is char 1:9 again in the final view (`O_PATH` + `fstat`). | `reader final entropy identity` |

The in-guest checks run inside the process being constrained: they fail closed on a
mistaken view but are defense in depth, not a replacement for the Root-side pidfd-bound
post-exec oracle in the remaining native gate.

**Dependency probe.** `linux-instruction-reader-dependency-probe.c` (same directory) is
exec'd by a separately admitted harness *in place of* `/instruction-reader`, under the
identical view, identity, limits, filter and pipe envelope. It prints exactly one line
and nothing else; the strict grammar is the doc comment at the top of that file:

```
probe=reader-v1 stack_rc=N stack_bounds=B stack_contains=B urandom_open=N urandom_read=B getrandom=N proc_list=N proc_numeric=N proc_root=B
```

(`N` canonical unsigned decimal, `B` is `0`/`1`, fixed key order, one LF.) It measures the
initial-thread `pthread_getattr_np` result, whether the reported bounds are nonzero and
contain a local in the probe's current stack frame, the `/dev/urandom` open errno and a 16-byte read (bytes zeroed,
never printed), a non-blocking `getrandom` errno, the proc-listing errno and count of
all-digit entries (`proc_list` is the one field beyond the minimum so a zero count is
unambiguous), and whether `/proc/1/root` equals `/`. It never prints an address, mapping
text, random byte or path, and its success is not Bun's. It is unwired like the role;
there is no build list to extend, so the harness builds it (reference: statically, like
the other guest helpers, with the compile-only flags below).

**Unverified assumptions** (none were executed): `subset=pid`/`hidepid=invisible`
spelling in superblock options and the `/proc` root listing being exactly `1`, `self`,
`thread-self` follow the 5.8+ kernel source and must be confirmed on the 6.8 guest;
procfs mounting needs CAP_SYS_ADMIN over the PID namespace's owning user namespace
(held here; a future user-namespace change would alter this); the checks assume access
to the process's own `/proc/self` entries as a non-dumpable reader identity with zero
capabilities, which follows the same-thread-group exemptions in the kernel; `MS_RDONLY`
on the char-device bind protects mount metadata, **not** device writes (the node stays
mode 0666 as on the host, so the reader may write entropy input, which grants no credit).
Static versus dynamic probe linking does not change glibc's `/proc/self/maps` dependency
but is unmeasured.

The design also leans on these kernel facts, none exercised here: since 5.8 every
`mount("proc")` gets its own superblock, which is why `subset=pid,hidepid=invisible` are
honored independently of any other proc instance; procfs mount admission and the
`mount_too_revealing` exemption hold only because the mount namespace is owned by the
initial user namespace (any `CLONE_NEWUSER` change alters both); the superblock option
string is expected to begin `ro` but B4 checks token presence only, and the rows in the
portable tests are illustrative, not kernel-captured; mount attributes are set
explicitly on the entropy clone (`ro,nosuid,noexec`, `nodev` cleared), so the expected
flags do not depend on the host `/dev` flags; the `getdents64` record layout (reclen at
byte 16, name at byte 19) is stable ABI but unverified on target; an LSM such as
AppArmor could deny the procfs mount if the launcher were ever confined (it is assumed
unconfined and root); and `RLIMIT_FSIZE 0` does not limit pipe writes, which the probe's
single `write` to descriptor 1 depends on.

## Native lifecycle versus outstanding reader debt

The Root service launches this compiled role directly, never by forking a
protected SDK runtime. The outer launcher captures the original parent PID once,
compares the socket peer to that PID, opens that exact PID's pidfd, arms
PDEATHSIG, then requires unchanged parent PID and held-pidfd liveness. Reparenting
cannot cause a later `getppid()` lookup to admit a different owner. Peer PID
comparison runs before unshare/fork, in the receiver's original PID namespace.
Root must launch from a creating thread that remains alive until the reader is
reaped: Linux PDEATHSIG tracks that thread, not just the parent's process. The
held process pidfd is the liveness identity check; PDEATHSIG is a death backstop.
After forking the PID-namespace init it
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

The five portable tests compile extracted pure/parser/mount/filter/owner functions with existing
portable `cc`. Mount syscalls and seccomp install are inert stand-ins; an inert
BPF interpreter checks both architecture branches and all 64 clone flag bits.
They check malformed/surplus arguments, descriptor aliases, source/cwd/dependency
grammar, maximum dependency count, double-dot IDs, recursive RO/private clone
flags, failure paths, socket/process denial, original-parent death/reparenting
schedules and source lifecycle ordering.
Six further portable tests cover the runtime-compatibility view: exact source gates
(the complete `mount(2)` inventory, `move_mount`/`open_tree`/`mount_setattr` counts,
the single `/dev` and `/proc` literals, the unchanged seccomp filter by hash, rlimits
and environment, and statement order against `unshare`, `fork`, the read-only remount,
`chroot`, credential drop, filter and `execve`); distinct invariant labels with no
reuse or prefix collision against the pre-existing labels; a mountinfo validator
exercised over positive, mutated, duplicated, missing, weakened-flag and malformed
tables; the `/proc` and descriptor name classifiers; the real extracted helpers
(entropy clone and both identity checks, getdents walking, B1/B2/B4/B5 and their
composed order) run against an injected kernel world that returns every fault, with
exit status 77, a single audited label and the expected `errno` text asserted and
every injected descriptor shown closed; and the dependency probe's line formatter
against a strict grammar plus exposure gates. The portable tests do not run any
`/proc`, device or mount operation.
Source substring checks are structural regression evidence, not kernel or Bun
proof. No new native launcher or compiled reader is executed.

A twelfth Linux-only test compiles the entire role and the dependency probe to
objects with existing `cc`, `-std=c11 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=2
-fstack-protector-strong -fPIE -c`. It never links or executes that output. On this
Mac it is explicitly skipped; complete Linux role compilation remains unverified
until the separately reviewed source CI actually passes. The new narrowly scoped
`cowork-isolated-reader-source.yml` runs those checks on ubuntu-24.04-arm only for
the feature branches' push/PR, with read-only repository permission and no sudo,
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
revocation with zero later provider requests; the B3 outside-canary check; and
a measured run of the dependency probe against the unchanged reader view. The
guest now has a subset proc and checks its own descriptor table before exec, but
that in-guest check is not an oracle: the Root-side oracle must still bind
observations to the received namespace-init pidfd/actual exec identity. Ordinary
source tests cannot satisfy these gates. Existing B admission and the native Mac/egress holds remain unchanged.

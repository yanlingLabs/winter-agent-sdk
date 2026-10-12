# Linux supervisor-side tool service implementation

Leaf work is based on SDK `c4227c45` in a separate `cowork/linux-supervisor` worktree. Its ancestry is not to be merged into the privacy-rewritten branch; root will cherry-pick the leaf source after review. No package version, publication, release or pin changed.

## Connected implementation

`packages/runtime/src/guest/linux-supervisor.py` is a real Linux root-owned service, not a fake port. Its startup accepts only an inherited bounded root-owned regular config FD, under isolated Python `-I -S` and clean environment. Config fixes actual guest boot ID, one workspace, logical conversation→SDK backend mapping, distinct numeric runtime/tool roles, shared workspace group, admitted roots/mount policy and immutable native helper SHA-256 pins. Socket directories/admin tracking use logical IDs; tool authority and actual registry bindings use backend IDs. It never provisions SDK stores; their accepted path remains `/workspace/.winter/conversations/<logical-id>`.

Private per-conversation Unix sockets authenticate kernel SO_PEERCRED UID before reading tool requests. Requests cannot select authority, another scope/UID, roots, policy, argv or env. The native helpers/launcher are opened without symlinks, checked for root ownership/read-only regular identity and pinned hash, retained as descriptors and rehashed before each exec with pread. Source directories are pinned as FDs. Protected control, image/helper/environment and declared store overlaps refuse. The service supplies each invocation's native argv from its own config plus bounded file-relative arguments or command bytes.

`linux-compartment.h` extracts the existing fixture's namespace/mount/seccomp primitives without replacing their policy. Both the old fixture launcher and new `linux-tool-compartment.c` consume that code. The latter creates a private mount/PID/network/IPC/UTS view, read-only directory skeleton, admitted source binds, non-root tool identity, zero capabilities, no-new-privileges and the existing syscall filter. Only immutable helpers and required readonly shell environment enter the view. Private runtime/control/store descriptors close before helper exec. Plans get readonly source binds, and existing noexec data/scratch restrictions remain.

`supervisor-client.ts` actually implements GuestFileHelperPort and GuestProcessPort and returns the existing protected GuestFileSession. The existing registry Read/Write/Edit/foreground Bash paths therefore reach the Linux service and native helpers. It uses bounded length-prefixed private messages with cancellation/deadline handling, actual helper receipt validation and no retries. No env/RuntimeConfig/settings flag creates this trusted binding.

## Ownership and cleanup

Each native invocation runs the helper as private PID-namespace init. Its immutable privileged parent transfers an exact init pidfd over a private socketpair, closes that control FD in the tool child, and emits terminal status only after actual waitpid. Cancellation/revocation/disconnect target the pidfd, not a guessed/reused PID or process group. Parent-death signals and retained parent pidfd checks close launcher/init admission when their actual owner dies.

The Linux kernel's namespace-init teardown waits for remaining namespace tasks before allowing init to be reaped; this is the reason the native terminal wait receipt is needed rather than kill/EOF alone. [Kernel PID-namespace teardown](https://github.com/torvalds/linux/blob/v6.18/kernel/pid_namespace.c#L180), [Linux PID namespace documentation](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).

The outer service independently bounds stdin delivery and post-kill cleanup at two seconds, captures bounded separate streams and requires native terminal status plus parent reap before success. Missing/malformed control receipts, capture failures or unproved namespace cleanup retain conversation debt and block new effects. Confirmed cleanup after cancellation still reports uncertain file effects. Admitted request IDs cannot replay, and exhaustion refuses instead of evicting replay protection. Admin revocation closes admission and cancels affected work. All callbacks compare their own admission tuple before removing active state.

## Verification and precise limits

Local macOS verification is framing and SDK integration evidence: client tests use real private socket bytes/registry validators, including backend-ID versus logical-ID distinction, cancellation and uncertain mutation responses. Existing guest/helper/startup/store tests remain beside them. Python protocol tests exercise bounded framing, authority copies and refusal off Linux. Local focused validation: **134 pass, zero failures, 956 expectations across eight suites**, plus **three Python protocol tests**. Both SDK typecheck projects and Python py_compile pass. The new and refactored C launchers cross-compile for aarch64-linux-musl with the existing Zig 0.14.1 cache and `-Wall -Wextra -Werror`; neither resulting binary was executed. This is compile evidence only.

The updated existing Linux `guest-file-boundary` CI job first runs the prior kernel fixture, builds a disposable actual SDK registry client, then runs `scripts/guest-supervisor/verify.py` with sudo on an isolated Linux runner. It uses actual runtime UIDs 20001/20002, tool UIDs 10001/10002, different logical/backend IDs, real service/kernel credentials, helper mounts/PID namespaces and byte checks. It exercises actual Read/Edit/Write/Bash, plan/readonly denial, absent runtime/proc/environment surfaces, forged scope, unsupported routes and descendant cancellation/revocation after positive start markers. There is no Docker, VM, provider, real home/credential, global installation or unconfined fallback.

**This exact Linux fixture has not yet run.** Root review/cherry-pick/push must precede that CI execution. No local/macOS test or cross-build is claimed as Linux enforcement, kernel-reclaim or production proof. No VM/worker/real guest runtime was launched in this task.

The service's numeric roles/authentication and native tool lifetime are implemented; automatic UID allocation and old-runtime reconciliation, launching/restoring actual SDK conversation processes, immutable Python/shell/library image packaging, protected SDK-store native ownership, provider/approval/context/extension routes and actual full confined startup remain open. The verified private-volume pair/readiness envelope is an external mandatory bootstrap prerequisite; config bytes, allocated files or ext4 signatures never grant production availability. No formatter/volume descriptor is exposed on the tool channel. The filesystem bootstrap protocol-2 feature set and provenance-bound noinit_itable mount rule must be enforced by the future immutable mount adapter before service construction; the directory-based CI fixture proves none of that raw-volume mount readiness.

`supportsConfinedGuestExecution` remains false and every actual engine/embedded confined startup entry still refuses. No Code outer floor, encryption requirement, host execution override or guest mode availability was introduced.

## Independent-review correction

The original `30bb3f18` source had four reproduced blockers: the shared eight-slot
connection pool starved admin revocation, per-recv timeout accepted endless
trickle, source resolve/check followed by leaf-only O_NOFOLLOW allowed an ancestor
swap, and malformed initial SCM_RIGHTS leaked installed descriptors. This leaf
correction reserves a separate bounded two-slot admin pool, enforces one
monotonic three-second header/body deadline, walks every source component with
O_NOFOLLOW and compares the held inode/device to the checked identity, and owns
all received descriptors before envelope validation (including truncation).
Bootstrap source aliases now refuse; ordinary in-root file-tool symlink behavior
is unchanged. No native launcher, helper, workload or confinement policy changed.

Correction evidence: **10 platform-neutral Python tests** exercise actual Unix
listener saturation with eight held tool connections plus status/revoke, absolute
trickle timeout and allowed fragments, real ancestor-symlink/rename races, and
actual malformed/multiple/truncated SCM_RIGHTS transfers with descriptor closure.
Only peer identity/chown are mocked in the local listener test; it does not prove
Linux UID enforcement. **67 SDK tests, zero failures, 398 expectations across six
suites**, plus both typecheck projects pass. The protocol regression runs in the
existing Linux CI job as well. Linux privileged fixture execution remains pending
review/push; no VM, native worker, privileged service or provider was launched.

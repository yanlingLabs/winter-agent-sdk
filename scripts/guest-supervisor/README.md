# Linux tool supervisor service slice

This connects the existing confined Read/Write/Edit/foreground Bash implementations
through a real Linux privileged service and private per-conversation Unix socket.
It does not enable the guest engine or assert native Mac/VM admission. The service
must be installed with an immutable Python interpreter/standard library and its
own immutable source, started as `python -I -S` with a clean environment. Its
root-owned bounded config FD is a trusted bootstrap input, not RuntimeConfig,
settings, tool JSON or environment authority.

The bootstrap fixes guest boot identity, workspace/session/incarnation/revisions,
an explicit logical conversation→SDK backend mapping, distinct runtime/tool UIDs, workspace group, admitted directory descriptors and
helper hashes. Socket/control directories use the logical conversation ID; request authority and ToolExecutionContext use only the SDK backend ID. The store path remains `/workspace/.winter/conversations/<logical-id>`, separate from that backend ID. Each socket admits exactly its runtime UID via SO_PEERCRED. Tool
requests cannot pick a different identity, UID, root, policy, command argv or env.
Source root entries are compared exactly with the captured admitted mappings;
control, artifact/environment and declared protected-store overlaps refuse. Bootstrap
source directory spellings must be canonical: every component is opened without
following symlinks and the held descriptor must match its checked identity.
The private root-controlled admin socket can revoke a session and inspect
invocation cleanup status; runtime/tool UIDs cannot use it.

The native launcher reuses the reviewed fixture's mount/filter primitives. Each
invocation gets a private mount/PID/network/IPC/UTS view and non-root tool UID,
read-only skeleton, zero capabilities, no-new-privileges and seccomp. It binds
only admitted roots and immutable helper/environment files. Stdio is the only
helper data channel; private control/artifact/source descriptors close before
execution. Plans receive read-only source mounts. Current source/scratch views
retain the foundation's noexec restriction, and this is still foreground-only
Bash: cwd carry, background tasks, pids cgroups and complete Code parity are open.

The immutable native parent sends a pidfd for the namespace init through a private
socketpair. Cancellation/revocation/channel loss targets that pidfd, not a PID or
process group guess. A terminal receipt follows actual waitpid of namespace init.
Only terminal receipt + parent reaping + bounded pipe capture can confirm cleanup.
Uninterruptible I/O, missing/invalid control receipts or bounded wait failures
retain debt and block new effects for that conversation. Killing alone, EOF or
elapsed time never proves cleanup. Confirmed cleanup can coexist with uncertain
file effects after cancellation; such commands/writes are never replayed.

The service bounds request/response frames at 2 MiB, file/combined process output
at 1 MiB, command input at 64 KiB, stderr diagnostics at 16 KiB, active connections
and invocations at eight, a separate reserved admin connection pool at two,
roots at sixteen per conversation and conversations at
sixteen. Stdin delivery and post-kill cleanup have separate two-second deadlines.
Request IDs are never replayed; exhausted duplicate tracking refuses new effects
rather than evicting replay protection. The entire request header and body share
one three-second monotonic deadline; trickled bytes cannot renew it. Ancillary
descriptors are owned before native admission parsing and closed on refusal.
Socket/input/capture loops are bounded.

## Linux CI

The existing `guest-file-boundary` job first runs the previous fixture, compiles a
small actual SDK registry client with its existing Bun toolchain, then runs:

```sh
sudo -n python3 -I -S scripts/guest-supervisor/verify.py --runtime-client /tmp/winter-supervisor-ci-client
```

The new fixture compiles the real static C helpers/launcher with an existing
compiler, copies immutable test artifacts into a disposable root-owned tree,
starts the real isolated Python service, and executes clients as two real runtime
UIDs. Those clients use the existing registry Read/Edit/Write/Bash routes over the
new port. It checks bytes, plan/readonly denials, absent runtime/proc/env surfaces,
forged scope rejection, unsupported routes, native descendant cancellation and
revocation after a positive child-start marker. No VM, providers, real home,
credentials, Docker or global installation is involved. Missing Linux kernel
prerequisites fail; there is no unconfined fallback.

This Linux CI fixture has not been executed on the macOS development host. Local
Bun client tests and Python protocol checks establish framing/validator behavior,
not Linux namespace/UID/mount enforcement. Independent source review and Linux CI
must pass on the published exact leaf commit before accepting the adapter.

## Remaining bootstrap/production work

The admitted private disk pair must be formatted/probed and independently ready
under its exact current native owner before production constructs this service.
Config bytes, allocated files or a raw ext4 signature cannot establish readiness.
No formatter API or backing-disk descriptor is exposed on the tool channel.
Signed worker admission, immutable Python/shell/library image pins, automatic UID
allocation/old-runtime lifetime reconciliation, native protected SDK-store owner,
provider/approval/context/extension routing and actual durable runtime/subagent
startup remain open. This service assigns/authenticates the configured numeric
roles and owns tool invocations; it does not yet launch or restore a full SDK
conversation runtime. `supportsConfinedGuestExecution` stays false, and all actual
confined engine/embedded startup entries continue to refuse.

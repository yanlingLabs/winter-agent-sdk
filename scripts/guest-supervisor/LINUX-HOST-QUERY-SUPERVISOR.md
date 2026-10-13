# Host-query producer and duplex relay (source slice)

Stacked base: accepted SDK entry `84dc16c9498b827fc02187caa0e43e11f73fb01c`.
The original entry branch, native launchers/owner library, immutable first-SDK
fixture, artifact receipts and capability flags are unchanged. This is an internal
guest-side source adapter, not Core daemon registration, native admission or a
passed guest approval exercise. No native/helper/service/VM or privileged process
was executed. No network, credentials, held Mac/egress lane, release or pin changes.

## Trusted producer

`ToolService(config, host_query_ports={logicalId: RuntimeDuplexPorts(...)})` accepts
an explicit `hostQueryRuntime` root bootstrap route. Its top-level immutable
artifact selection has the same launcher/executable/ownerLibrary roles as the
old `freshRuntime`, and the two profiles are mutually exclusive per service.
Conversations supply `hostQueryRuntime` with the existing store/runhome/provider/
model/optional timeout fields plus a captured `toolClasses` list containing only
read/write/execute. There is no argv, environment, settings, resume or runtime
config override. The admin launch request remains only operation + session ID.
The root constructor still requires Linux, Root, isolated Python and the current
kernel boot. The default CLI has no transport adapter and cannot activate this
route from JSON alone; missing/JSON/stale/closed adapters refuse.

`host_query_config` derives the SDK config from root-owned conversation policy,
source roots and captured tool classes. Auto/ask map to SDK default; plan,
accept-edits, dont-ask and bypass map to their admitted SDK equivalents. The four
tools are the ceiling, `allowedTools` is empty, and the bypass/clamp pair is exact.
The root record carries `profile: host-query-v1`, protocol 1 and freshOnly true.
The existing four inherited owner-proof descriptors still pass through unchanged
native peer/UID/pidfd/executable/store/kernel-boot admission; the transport object,
record JSON, exit code and runtime callback never confer that authority.

For this profile only, `runtime_root_metadata` derives effective readOnly true
for every plan root before installing ToolService's descriptor map. The same
metadata goes to file-client root comparisons, the native launcher root argv and
the SDK record. The native plan policy override remains. Original fresh root
metadata/config/input behavior stays unchanged. This profile intentionally keeps
the accepted first-slice restrictions: <=16 roots, cwd exactly the first root,
no /workspace/.winter roots, four tool families, fresh empty stores, and the
existing root-selected runtime deadline (at most 600 seconds). It does not admit
the full shared guidance/memory/scratch layout or durable resume contract.

## Descriptor ownership and flow

`RuntimeDuplexPorts` is I/O transport only. It duplicates input/stdout/stderr with
F_DUPFD_CLOEXEC before validating FIFO type, effective-owner UID, link count,
access mode, already-nonblocking status and distinct device/inode identities.
It binds once to exact logical session + all authority revisions. Intake refusal
closes every duplicate; originals and their flags stay with the caller. Held
identities/flags are rechecked at claim, before spawn and during relay. The service
owns accepted duplicates until terminal/startup-failed closure. A closed input
refuses before Popen; later physical EOF requests cancellation, never cleanup.

`_run_runtime` uses stdin PIPE only for host-query and integrates all relay I/O
into its existing selector/control loop. Logical end_input is ordinary NDJSON;
stdin stays open for pending permission replies. Actual input EOF closes stdin
and requests termination. Partial writes preserve the remainder; EINTR/EAGAIN
return to polling. Root callbacks cannot block the loop. Queue bounds are 2 MiB
input, 2 MiB stdout and 64 KiB stderr, with at most 256 KiB initial prefetch,
64 KiB I/O steps and 1 MiB input/stdout frames. Full queues disable their producer
read interest. Two seconds without progress on a queued direction fails/retains;
the native control loop still polls every 50 ms and its existing termination/
cleanup deadlines remain. These are bounded allocations, not a measured RSS or
active-memory-return claim. Diagnostic capture retains only the existing bounded
stdout/stderr prefixes; live output is forwarded without accumulating a complete
conversation in Root memory.

`linux-host-query-main.ts` is a distinct immutable executable entry using exactly
the existing native FD argv ABI, then `admitHostQueryLinuxSession` and the reusable
`runAdmittedLinuxSession`. UTF-8 input is incremental and strict. Fixed stdout/
stderr writes are synchronous and bounded, handling partial writes/EINTR, so the
runtime cannot accumulate a JS output queue when its pipe stalls. Blocking that
runtime pipe does not block the independent Root receipt/cancellation loop. The
old hardcoded fixture entry remains untouched. This new entry has only been
bundled; no compiled native artifact is admitted or silently substituted.

Transport cancellation/loss/stall/native-receipt mismatch preserves native debt
and store holds. Normal completion still requires actual namespace-init terminal
receipt + matching parent reap + tool revocation/drain + no native debt + durable
diagnostic. OwnershipReleased remains false in runtime observations. EOF, kill
delivery, model success and the transport class never acknowledge native teardown
or release protected SDK stores. Root service closure still refuses pending
threads/debt instead of forgetting their descriptors/tenancy.

## Source evidence and remaining gates

Selected Python checks: 52 tests, 51 passed and one Linux-only ancillary skip.
The real listener/socket-service saturation test was deliberately excluded; no
service starts. New tests use disposable named FIFOs with real descriptor flags,
UIDs/inodes and selectors, plus injected Popen/control receipts/signals. They cover
partial intake cleanup/original preservation, stale scopes/closed input, partial
and interrupted writes, both-direction backpressure, frame bounds/truncation,
stalled/closed output consumers, logical end_input then permission reply, native
terminal stale-event handling, startup failure, plan metadata/argv agreement and
receipt/reap mismatch retaining store/debt. Injected receipts are never reported as
native owner proof. The existing fresh and lifecycle diagnostic tests also pass.

Bun: 43 selected tests / 306 assertions. The new pure producer contract runs the
actual Python producer without constructing a service and validates its six
configs/root records with the SDK validators. Existing actual SDK query/engine/
RpcBridge local testing-leg checks pass; they prove no native guest approval.
Both repository TypeScript configurations pass. The host-query main bundles
690 modules (8.70 MB), without execution. Logs and bundle are retained under
`out/linux-host-query-supervisor-check/`; temporary dependency links are removed.

Independent review, exact immutable build/source/compiler provenance, protected
staging/admission and a separately reviewed Linux run are still required. A later
host transport slice must own the actual callback/control/projector connection;
there is no Core port registration, production capability enablement or native
VM/worker launch in this commit. Source composition with later SDK main changes
is separate; this branch does not silently merge or relabel another artifact base.

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
source roots and captured tool classes. Plan maps to SDK plan and every other policy
(auto, ask, accept-edits, dont-ask, bypass) maps to SDK default, so the host matrix behind `canUseTool` stays the policy
authority. The received policy is recorded unchanged. The four tools are the ceiling, `allowedTools` is empty, and the clamp
pair is always `disableBypassPermissionsMode: true`, `allowDangerouslySkipPermissions: false`.
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
refuses before Popen if it contains no queued input. A clean later physical EOF
stops new input, drains queued bytes and closes child stdin, never claiming cleanup.

`_run_runtime` uses stdin PIPE only for host-query and integrates all relay I/O
into its existing selector/control loop. Logical end_input is ordinary NDJSON;
stdin stays open for pending permission replies. Clean physical input EOF drains queued input before closing stdin; the SDK
finishes the current turn/transcript and denies unanswerable permission requests.
Malformed/truncated input, output loss, explicit cancel and owner loss still fail
or hard-stop. Partial writes preserve the remainder; EINTR/EAGAIN
return to polling. Root callbacks cannot block the loop. Queue bounds are 2 MiB
input, 2 MiB stdout and 64 KiB stderr, with at most 256 KiB initial prefetch,
64 KiB I/O steps and 1 MiB input/stdout frames. Full queues disable their producer
read interest. Ordinary bounded backpressure has no short age timeout: paused
consumers may resume without killing a healthy runtime. The native control loop
still polls every 50 ms, including cancellation and the existing absolute runtime
deadline; post-kill cleanup deadlines remain unchanged. These are bounded allocations, not a measured RSS or
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

Transport errors/cancellation/native-receipt mismatch preserve native debt
and store holds. Normal completion still requires actual namespace-init terminal
receipt + matching parent reap + tool revocation/drain + no native debt + durable
diagnostic. OwnershipReleased remains false in runtime observations. EOF, kill
delivery, model success and the transport class never acknowledge native teardown
or release protected SDK stores. Root service closure still refuses pending
threads/debt instead of forgetting their descriptors/tenancy.

## Source evidence and remaining gates

Original `36b40107` source checks: 52 Python tests, 51 passed and one Linux-only
ancillary skip. The follow-up evidence below supersedes EOF/backpressure semantics,
not that original validation history.
The real listener/socket-service saturation test was deliberately excluded; no
service starts. New tests use disposable named FIFOs with real descriptor flags,
UIDs/inodes and selectors, plus injected Popen/control receipts/signals. They cover
partial intake cleanup/original preservation, stale scopes/closed input, partial
and interrupted writes, both-direction backpressure, frame bounds/truncation,
paused/closed output consumers, logical end_input then permission reply, native
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


## EOF/backpressure correction and pre-GA lifecycle limits

The original `84dc16c9` entry passed `cancelOnEOF = profile !== fresh`, so host-query
EOF aborted; `36b40107` consistently set runtime cancel and discarded queued input
on physical EOF, and imposed a two-second queue-age failure. Those behaviors were
implemented and tested as such; the correction is a compatibility change, not an
assertion that EOF used to be graceful. The published entry branch is unchanged;
this correction is on the stacked producer branch and requires separate review/
backport. Its bounded input helper now cancels only errors/abandoned consumption,
not clean EOF. The immutable main destroys its stdin reader after the embedded
lifecycle returns so a pending read after logical end_input cannot keep a returned
runtime alive; that close never supplies native stop proof.

The two-second queue-age policy is removed. Queues stay bounded and producer reads
pause when full, while native receipts/cancellation/absolute deadlines are polled.
Explicit cancel remains immediate even with full output queues; closed/erroring
output remains uncertain, with no byte drop/retry or native release claim. The
separate bounded prelaunch nonblocking-input retry window remains two seconds;
this does not time out an ordinary live consumer pause.

These are pre-GA bounds, not product behavior: fresh-only empty store/home,
no cold resume, and a Root-selected absolute runtime lifetime capped at ten
minutes. Full Cowork still requires durable logical conversation/subagent history
across cold restarts and an explicitly reviewed runtime/per-turn lifetime design
for long conversations and pending approvals. Neither this deadline nor fresh-only
refusal may silently become the product contract. General capabilities/registration
remain false.

Follow-up checks: 56 Python tests (55 passed, one Linux-only skip); 46 Bun tests /
322 assertions; both repository TypeScript configurations pass; the immutable main
bundles without execution. Regression evidence includes terminal-result → stdin EOF through the
actual local SDK query + bounded input helper, queued-user → EOF + real persisted
transcript/code0, already-pending permission → EOF denying the effect/code0,
queued partial FIFO writes draining before close, malformed tails, >2 second
consumer pauses followed by resume, explicit cancellation under full backpressure,
and no SIGKILL on clean EOF in the injected supervisor loop. Local engine results
and injected native statuses still do not prove real guest approval/owner/teardown.
Retained follow-up logs and unexecuted bundle live separately under
`out/linux-host-query-supervisor-eof-check/`.


### Late-input reader closure race

The immutable main can close stdin after returning before the native terminal
receipt reaches Root. EPIPE only on the child-input write now marks that input
reader closed, clears unsent queued input, closes its write end and stops host
intake. It does not mark native terminal, cleanup or ownership release; output and
native-control draining/reap checks continue. Unsent late bytes are discarded:
no delivery/effects acknowledgement is made and they are never automatically
replayed. EPIPE on either output, other read/write errors and missing native proof
still fail/retain. The native owner/admission code is unchanged.

Three added Python regressions cover actual FIFO reader closure with stale events,
late-input EPIPE followed by stdout/result plus injected native receipt/reap, and
other child-input errors retaining uncertainty. Existing output-EPIPE regression
still fails without dropping its queued bytes. Current selected Python result:
59 tests (58 passes, one Linux-only skip). Earlier 89b validation/logs are retained;
Bun/TypeScript/compiled-main sources are unchanged by this narrow race correction.

### Runtime launcher policy correction

The separately admitted host-query diagnostic run `38427242630` failed before
SDK exchange: native-startup/init_admission_lost, parent exit64, no native receipt,
cleanup false and retained debt. Its cleanup remains unconfirmed. Source review
found `_run_runtime` passing full policy `ask` as argv13, while the unchanged C
launcher accepts only `auto|plan`. The same mismatch affected accept-edits,
dont-ask and bypass. All other actual native guards are still unproven here.

Both tool and runtime argv assembly now use one `native_mount_policy`: plan iff
the Root-admitted full policy is plan, otherwise auto. This selects the existing
native readonly/writable view; it does not select SDK approval mode. Item policy,
effect grants, roots/readonly metadata, bootstrap and `host_query_config` remain
unchanged, except that the SDK mode is plan for plan and default otherwise, with the bypass clamp always on. Native C/helpers,
owner proof, filters, deadlines, capability flags and fixture oracles are unchanged.

The original first-SDK `scripts/guest-engine/verify.py` fixed policy to auto.
Its passes never established actual ask/bypass host-query runtime launches; the
producer's earlier local SDK/injected tests likewise did not establish them.
Separate native utility tool-process plan/bypass evidence is unaffected.

An injected regression traverses the actual `_run_runtime` to assembled Popen
argv for all six admitted policies, then deliberately refuses Popen before any
child/native effect. It compares complete item/SDK/bootstrap snapshots, both
writable and explicitly readonly roots, native argument positions/counts and
unchanged bypass clamps. Before the fix it fails the four unsupported spellings;
afterward all six pass. Disposable STREAM socketpairs are only portable FD
stand-ins, never peer/pidfd/owner proof. No protected service is constructed.

Focused Python results: 64 tests, 63 passed and one Linux ancillary skip, excluding
native-parser and listener-saturation execution. A broader discovery invocation
also ran the existing unprivileged C JSON-parser prefix executable and mocked
AF_UNIX listener saturation test (66 tests, 65 passed/one skip); its separate log
is retained as a test-selection mistake, not native launch evidence. Neither ran
the native launcher/helper ABI, Root, a protected service, mount, VM or GUI.
No TypeScript source changed; typechecks were not repeated. Source review,
composition, fresh immutable build/full-chain audit and separate run admission
are still required. No push or CI run was performed from this correction lane.

## Transport from Root's init (Winter N2 slice S5, source only)

The line above that says the default CLI has no transport adapter is superseded for one case. Root's init (the guest's PID 1, a
separate Winter change) starts the supervisor as

    linux-supervisor.py --trusted-config-fd N [--runtime-ports-fds IN,OUT,ERR]

in that order and no other. `IN` is a FIFO it reads, `OUT` and `ERR` are FIFOs it writes; the relay process that alone owns the
virtio-console port is the far end of all three, so the supervisor never sees the port and the tool compartments never inherit these
descriptors (the originals are closed before the service is constructed; `RuntimeDuplexPorts` keeps its own CLOEXEC duplicates above fd
64). Numbers are canonical decimals, at least 3, distinct from each other and from the config descriptor; anything else exits 64.

* **One host-query conversation** (`hostQueryRuntime` or `hostQueryGuidedRuntime`): `RuntimeDuplexPorts(logicalSessionId, authority, IN,
  OUT, ERR)` is built from the three descriptors and injected as `host_query_ports`. Every existing check is unchanged and still runs: the
  FIFO type, effective owner, link count, access mode, non-blocking, distinct inodes and the exact scope binding.
* **No host-query conversation**: the descriptors are closed and the service starts without ports. A config that does ask for a transport
  but arrives without `--runtime-ports-fds` is still refused by the constructor (`host_query_transport`).
* **More than one host-query conversation** exits 64: the runtime class of the mux carries one stream with no stream id, so a second
  conversation could not be served. This is a limit of the current wire contract, not a decision about the supervisor.
* Closing is done once, in `main`, on every path: success, a refused set, an unreadable config, a service that refuses to construct (its
  injected ports are closed too, because the constructor only closes them after its own `try` begins).

The trusted-config file admission (regular file, root owned, no group or other write bit, at most 64 KiB, descriptor 3 or above) and the
live-boot-id check are unchanged; the file check moved into `read_trusted_config`. PID 1 writes the config with the boot id and the
conversation set in front of its static base (artifact paths and digests, control directory, environment, no protected stores);
`test_runtime_port_arguments.py` builds that exact layout and drives the real constructor with it (patched only where it needs Root,
Linux and real files, as the existing constructor tests do).

### `previousBootTermination` stays null

The native owner adapter keeps answering "no evidence" (`previousBootTermination: () => null` in `linux-session-admission.ts`) and PID 1
provides none, so a cold resume stays refused. Evidence has to be established independently of the guest that is being judged: only the
host can say that the previous boot ended. A marker on the guest's own disk would be written by that guest, and the one thing the guest
can observe, a set `needs_recovery` flag in the ext4 superblock, is evidence against an orderly stop. `test_runtime_port_arguments.py`
pins that the supervisor source has no such path, so adding one has to be a deliberate change. Cold resume is out of scope: the first Mac worker covers boot, disks, the supervisor and a safe stop, while host shares, the provider bridge and cold resume come later.

Not run: no service, native process, Root, mount or VM. The Winter side (PID 1 and the relay) was not run against this supervisor either;
the first end-to-end exercise of the two together is a later gate.

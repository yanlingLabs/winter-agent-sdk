# Guided reader service: Root serves the fifth-descriptor stream

Status: **source and CI only.** Nothing here admits a native owner, activates the guided profile, lifts the
SDK host guard, builds a packet or runs a VM. A frame, a receipt or a green test in this slice is DATA about
Root's service. The service answers a guest's instruction-read requests by launching the isolated instruction
reader through its existing launcher and compartment, and reports the reader's lifetime evidence honestly.

`packages/runtime/src/guest/linux-supervisor.py` is the only source file this slice changes. The reader
launcher (`linux-instruction-reader-compartment.c`), `linux-compartment.h`, the reader and runtime
launchers, the owner, `linux-session-admission.ts` and `linux-guided-reader-protocol.ts` are byte-identical to
`main`; tests pin their hashes. The delta to the supervisor is recorded as
`docs/research/guided-reader-service-supervisor.patch` (from the bytes the guidance-view patch left, hash
`51259b0f...`, to the tracked bytes), the same way `guided-guidance-view-DATA.patch` records the view patch.

## What it does

| Part | Behaviour |
| --- | --- |
| Handoff | One `AF_UNIX`/`SOCK_STREAM` pair per incarnation. The guest end travels once, as the fifth `SCM_RIGHTS` descriptor of the bootstrap envelope; Root closes its copy after the send. Root's end goes to exactly one `GuidedReaderService`, bound to the run's registration and to the runtime's namespace-init pidfd. `start()` claims it once; a second claim, or a claim after `stop()`, refuses (`guided_reader_claimed`), and `_guided_reader_service` refuses a second service for the same runtime state. Root never shuts down or closes its end while serving: the native owner reads that as the owner being lost. |
| Frames | A 4-byte big-endian length and a compact literal-UTF-8 JSON body, exactly what `linux-guided-reader-channel.ts` writes and `decodeLinuxGuidedReaderFrame` accepts. Guest requests (`reader_start`, `reader_cancel`, at most 4096 bytes) are accepted only when their bytes equal the canonical encoding Root derives from its own registration: key order, whitespace, escapes, duplicate keys and number spellings cannot differ. Root's frames (`reader_result`, `reader_terminal`, up to 1 MiB + 4 KiB) are built from the registration and re-checked by a Python mirror of the guest decoder before they are sent. |
| Reader launch | `ReaderLauncher` runs the **unchanged** launcher with the exact `instruction-reader-v1` envelope (`reader_argv`; `argc == 12 + 2 * dependencies`), one stdin request (the registration minus `workspaceId`, canonical JSON, at most 16 KiB), stdout capped at 320 KiB and stderr at 16 KiB. Every launcher, loader and dependency descriptor is re-measured against its pin before every launch. The view directory is made 0700 per read under `/run/winter/instruction-reader-views`. Reads run **one at a time** on one worker thread (PDEATHSIG tracks the creating thread, which stays alive until the reader is reaped). |
| Evidence | A `reader_terminal` is sent only from real evidence: the namespace init reaped (the launcher's `R` receipt), the monitor reaped (Root's own wait), both pipes at EOF and the capture drained. Anything unproven (a missing `I` receipt, an unreaped monitor, a pipe still open, an unexpected packet, a hard deadline) leaves the read **unaccounted for**: no frame is sent, the service stops serving, the child is retained, and `stop()` reports debt so `_run_runtime` raises `guided_reader_debt`, retains the conversation and blocks release. | The descriptors the service waits on are polled with `select.poll`, not `select.select`, which raises for descriptors numbered 1024 and above. A spawn `OSError` that is not the launcher's own failed exec (CPython names the executable in that one) may come after the exec succeeded, with a live monitor and no handle: it is treated as unaccounted-for, never as the vacuous pre-fork receipt.
| Bounds and refusals | At most 16 outstanding reads (queued, running or unaccounted for) and 4096 read ids per lifetime (the same figures the guest's channel enforces). An unknown kind, a malformed or non-canonical frame, a wrong registration, owner or binding, a replayed read id, a 17th outstanding read, an oversize frame and a cancel for a read never started are protocol violations: the service stops serving, cancels what runs and launches nothing more. A cancel that crossed its own terminal is ignored. |
| No service elsewhere | v1 and fresh runs never build a service, a stream or a launcher; their records and descriptors are the same bytes as on `main` (the goldens in `test_guided_host_query.py` and `linux-guided-producer.test.ts`). |

### Receipts for reads that never launched

The terminal frame's types require every reap flag to be `true` and both statuses in 0..65535. For a queued
read that was cancelled, a read refused before any process existed (a changed artifact, a spawn that never
ran), or a launcher that exited 64 (its own refusal of its envelope, which happens strictly before the namespace
fork), no namespace init or monitor ever existed, so there is nothing unreaped. Root sends those flags `true`
with statuses 0 and records `launched: false` in its own evidence. This is a **choice the reviewer must judge**
(see "Open design choices").

## Configuration (trusted config FD, guided profile only)

* every guided conversation that carries `hostQueryGuidedRuntime` now **requires** `guidanceDirectory`
  (`guided_guidance_required`). The view patch left it optional; the service must not serve a view that is not
  mounted. It is refused in `_configure_runtime` before any store opens and again in the constructor's post-pass.
* `config.hostQueryGuidedRuntime` carries a second closed key next to `artifacts`:
  `reader: {artifacts: {launcher, executable}, dependencies: [{path, sha256, guestPath}], uid}`. The launcher and
  loader are pinned like every other artifact; `dependencies` are 0..32 immutable files with the launcher's guest
  path grammar (`/lib/`, `/lib64/`, `/usr/lib/`, printable ASCII, no duplicate or ancestor/descendant pair); `uid` is
  1000..65535 and must differ from every runtime UID, tool UID and workspace GID. The reader's primary GID is that
  UID and its only supplementary group is the conversation's workspace GID, as the launcher does.
* `/run/winter/instruction-reader-views` is created if missing and every ancestor must be Root-owned and neither
  group- nor other-writable.

Nothing in a tool request, an admin request or `RuntimeConfig` can select any of this.

## Tests

* `scripts/guest-supervisor/test_guided_reader_service.py` (CI: `guest-file-boundary`, both architectures):
  codec and parser tables, the outbound mirror, the service's protocol with a fake launcher over a real socket pair,
  `ReaderLauncher` with an injected process and receipt socket, the reader's real argument parser compiled with `cc`,
  the **differential**, static boundary pins, and `LinuxNativeTests`.
* The **differential** runs `guided_reader_differential.ts` under bun against `linux-guided-reader-protocol.ts`. In the
  Root-to-guest direction every frame Root could send (valid and many hundreds of mutants: dropped, added, retyped and
  reordered keys, owner/limits/views/readId mismatches, number spellings, escapes, BOMs, invalid UTF-8, bad lengths)
  is decided by both and must agree. In the guest-to-Root direction the guest's own builders produce frames that Root
  must accept, and a frame is valid exactly when it equals what those builders emit. Soundness is absolute (Root
  never accepts what TypeScript refuses); Root is deliberately stricter in one place: a JSON number JavaScript prints
  in a form Python's `repr` spells differently (an exponent, or a plain decimal below 1e-4 or above 1e16, or an
  integer above 2^53) is refused, listed in the test.
* `LinuxNativeTests` (Linux root only; **required, never skipped, in CI** through `WINTER_REQUIRE_NATIVE_READER=1`
  on a `sudo` step) compiles the unchanged launcher, builds a tiny static stand-in for the compiled loader, and runs the real
  `ReaderLauncher` and the whole service in real private mount, PID, IPC, UTS and network namespaces: a read of the
  guidance file through the mounted view, the launcher's own deadline kill, cancellation, an output flood, garbage,
  a non-zero exit, a stderr flood and a tampered loader. The stand-in is not Bun: honest compiled-Bun compatibility
  with the view stays unproven (`linux-isolated-instruction-reader-source.md`).
* Existing fixtures were updated for the now-required `guidanceDirectory` and `reader` block:
  `test_guided_host_query.py`, `test_guided_guidance_view.py`, `test_runtime_port_arguments.py` and
  `linux-guided-producer.test.ts`. `test_guided_guidance_view.py` now reverses the recorded supervisor delta before it
  reverses the view patch, and no longer scans the later service's lines for network tokens (the service has its
  own scan: only the launcher's `AF_UNIX`/`SOCK_SEQPACKET` receipt pair, no inet, vsock, netlink or ioctl).

## Network and egress

The service gives the guest nothing: no NIC, vsock or listener is created. Its only new sockets are the
`AF_UNIX` receipt pair with the launcher; the reader runs in a fresh network namespace under the launcher's
unchanged seccomp filter.

## What stays owed

The native owner admitting the five-descriptor record on a real kernel; the guided compile packet; the hosted
guided run; Bun-compatible loader proof; the host adapter that supplies `requiredRuntimeContext` and `generation`
to Root; a production generation expiry and replay policy; PID 1's `wg_build_trusted_config` writing the new
`reader` block and `guidanceDirectory` (it does not today); and the SDK host guard, which this slice does not
touch.

## Open design choices for the reviewer and the owner

1. **Vacuous receipts** for reads that never launched (above): `true` flags and zero statuses. The alternative is a
   guest-side change to let `reader_terminal` say `launched: false`, which this slice may not make.
2. **The reader's stdin request is defined by RuntimeSDK, not here.** `src/guest/instruction-reader.ts`
   (`InstructionReaderInvocation` and `invocation()`) and `src/guest/instruction-reader-transport.ts` on
   runtime-sdk main define it; Root only emits it (the registration minus `workspaceId`, canonical JSON). The reviewed
   files are pinned by SHA-256 at an exact runtime-sdk commit in `scripts/guest-supervisor/runtime-sdk-reader-request.pin.json`,
   together with the key set Root emits; a test compares the emitted keys to the pin, and an optional check
   (`WINTER_RUNTIME_SDK_CHECKOUT`) re-verifies the blobs. A change upstream must be re-reviewed against `reader_invocation`.
3. **Serial reads.** One reader at a time; the 16-outstanding bound counts queued reads. A guest that queues
   several will see later reads wait for earlier ones' 4 s budgets, and the guest's own 15 s context timeout
   may cancel them.
4. **A violation stops the service, not the runtime.** Root keeps its end open so the native owner stays valid;
   the guest's channel fails closed on the same events. The alternative is closing the stream, which kills the
   runtime.
5. **Holder authentication of the guest end is creator-only.** Whether the native owner's descriptor is close-on-exec was not checked here; that owner-side check is owed later. **Creator identity alone does not authenticate the eventual holder** of the guest end. Root binds the stream to
   the runtime's namespace-init pidfd and sends the end exactly once, but does not inspect `/proc/<pid>/fd` for the
   socket inode. That check, and a native proof, remain owed.
6. **Cancellation is the init pidfd's SIGKILL, and Root sends the launcher no packet.** The launcher's source
   treats any Root packet as cancellation, but its monitor never reads one, and closing a unix socket that holds an
   unread packet resets the peer: the first CI run on real `SOCK_SEQPACKET` lost the monitor's `R` receipt behind an
   `ECONNRESET` exactly that way. A cancel before the launcher's `I` receipt waits for the pidfd rather than killing the
   monitor, so the init is reaped by its monitor and the evidence is complete; only past Root's 4.5 s supervision does it
   fall back to killing the monitor, which leaves the init unproven (debt).
7. **Exit 64 means "no init existed".** It is derived from the launcher source (every `_exit(64)` precedes the
   namespace fork), not observed.
8. **Number strictness** in the mirror (above) and its Python-only reach: a reader that emitted an exponent float
   would see its read become `unavailable`.
9. **Required config shape.** `guidanceDirectory` and `reader` are now required for guided; PID 1's config writer
   must be extended before any guided activation (it writes neither today).

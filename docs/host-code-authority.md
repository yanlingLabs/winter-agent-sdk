# Host Code authority helpers

These APIs are host capabilities. A serialized runtime config, tool input or guest execution snapshot must not supply their definitions, registrations, policy state or recovery proof.

`resolveHostCodeDescendantPolicy` reconstructs one descendant from a host-validated Agent invocation. It merges SDK builtins with host-prepared definitions, resolves the SDK's normalized agent type, computes the actual forced-mode inheritance, resolves registered/legacy tool identities, intersects the parent pool, and applies the normal subagent pool. The caller validates ancestry and preserves every ancestor's ask/deny rules. The returned definition denies must be added to the descendant's permission config, alongside complement denies for tools outside its returned pool. The helper reads no guest store or filesystem definitions.

Descendant construction requires the parent to retain Agent or its legacy Task capability after bare deny rules are applied. A definition's own bare denies also remove tools from its returned pool; `Agent(*)` therefore cannot be reinstated by a grandchild's declaration. Scoped `Agent(type)` denials keep their normal SDK interpretation.

`createHostCodeHookStage` uses the SDK's registry, interpreter, input validator, runner and reducer. Its host invoker must await and return a completed reviewer result. Callback launch or progress acknowledgements are not reviewer verdicts. Prepared wire groups can use `buildHookEntriesFromConfig`; prepared settings tiers can use `buildHookEntriesFromSettings`. Project/local registrations retain the normal workspace trust gate.

Broker output retention uses per-process and aggregate high/low watermarks (defaults: 1 MiB per process, 4 MiB and 4096 events aggregate, 64 process slots): stdout and stderr pause at the high watermark and resume when acknowledgements reduce retained bytes and event count below half. Normal output no longer kills another row or a producer merely for exceeding the retention watermark; the commands' independent streamed-byte execution limit still applies. Workflow lifecycle/limit gaps remain separate review work. The existing release operation accepts `{ abandon: true, afterSequence: 0 }` for error cleanup, kills the owned process, discards unread bytes and removes its output row. Generation teardown also discards output and disposes the transport. Its unconfirmed close continues reserving a process slot, and teardown can re-signal it. Admissions reserve slots before asynchronous authorization; retained final rows also reserve slots. A release acknowledgement frees output; only the separate drain evidence reports confirmed close. Cleanup release/signal operations remain authenticated and admitted after cancellation; new start/write operations do not.

Execution requires an injected host-only `createOutputTransport` factory; absent transport fails closed. The factory must supply protected native POSIX pipes with CLOEXEC parent endpoints and bounded nonblocking reads.

Bun 1.3.14's child-process and native ReadableStream output paths eagerly drain into memory despite pause/lazy settings, so they cannot implement this capability. A fixed-arity C wrapper is required for variadic fcntl on arm64. The development adapter at `packages/runtime/src/sandbox/fixtures/host-output.ts` compiles a temporary static C fixture and uses one shared 10 ms poll(0) readiness timer; it is deliberately development/test evidence, excluded from production entry points. Production needs a protected packaged native adapter before activation. Native tests cover real producer blocking, unrelated host file-I/O responsiveness during 12 idle processes, prompt wakeup and only fd 0-2 inherited by the child. Aggregate watermarks can overshoot by each already-pending 64 KiB read (at most two per active process); unread bytes remain in native pipe buffers, with all process slots capped. This does not extend process-close evidence to detached descendants.

Linux writer leases now treat a different kernel boot as unresolved ownership. A local PID's absence cannot establish that a foreign-kernel writer ended. `WinterCompatibilitySessionStore` accepts a host-only `leaseIdentity.confirmPreviousBootTerminated` callback for exclusive-store recovery after the previous kernel is proven terminated. Without that proof, recovery across VM cold boots is refused; ordinary same-kernel parent process restarts and reused PID checks retain their existing behavior. Linux also refuses leases with no kernel identity unless the host-only `confirmLegacyLeaseTerminated` callback proves exclusive migration authority and writer termination. Ordinary macOS legacy behavior is preserved. No runtime wire or model option enables recovery. macOS callers without Linux identity evidence cannot claim or steal Linux-stamped leases. Missing locks during a normal release/acquire race are retried through atomic creation, while malformed Linux lease records still require explicit recovery.

Brokered command `onSpawned` callbacks carry `stopOwnedProcess`, bound to that exact host handle. Background Bash, slow foreground Bash and command Monitor retain this capability. TaskStop, session/process teardown and stop-before-spawn cleanup use it instead of the display PID, with no raw-PID fallback when a broker request fails. A successful stop callback submits a stop request; confirmed close still requires the separate registered-process evidence. A released command's retained callback cannot submit another signal.

Query abort and actual runtime process exit dispose the captured host registration once, independently of consumer iteration. Pending admission observes the query abort signal, and ordinary iterator cleanup uses the same disposal latch. Workflow enforces a positive host-supplied deadline, clears that timer at actual OS close, and preserves `timedOut` while output completion is pending. Zero remains the host's explicit no-deadline policy; the SDK adds no new default.

The persistent host floor is defense in depth for enrolled processes. It constrains
their direct filesystem operations and inherited subprocesses, including approved
Code shell escapes; it does not establish confidentiality against other processes
running as the same macOS user. Delegation to an unfloored service, authenticated
Winter API access to guest plaintext, and arbitrary same-user deletion/corruption
are outside that claim. The selected protection for private Cowork disks is
encryption at rest, with keys held by the hardened native storage helper. Shared
Mac folders, instructions, memory and outputs remain plaintext. An unrelated
approved Code escape does not have to be disabled merely because Cowork exists.

The native floor also denies flags and extended-attribute changes on literal
ancestors of protected storage, alongside rename, unlink, mode and owner changes.
Disposable macOS tests use positive controls for case-variant writes and real
ancestor renames on a case-insensitive filesystem, APFS clone copies (`cp -c`),
`chflags` and `xattr`. Ordinary sibling operations remain usable. These tests cover
direct operations by the enrolled process; they do not establish protection from
delegation or another process running as the same user.

`createMandatoryFloorSpawn({ spawn, floor, requireHostFloor: true })` is a trusted
host launch requirement. Missing/empty registration refuses before spawn. The
wrapper snapshots host floor paths, validates its profile and sets the host-only
`SpawnRuntimeOptions.requireHostFloor` marker on the native launch. Custom
transports must preserve the actual `sandbox-exec` command and arguments or refuse;
the SDK cannot validate an arbitrary custom spawner's kernel behavior. Existing
unfloored generations and child servers must be drained/recreated before the host
marks a floor registration usable. Neither configuration text nor environment
variables install this authority.

`spawnEmbeddedWorker({ requireHostFloor: true, ... })` refuses before constructing
the Worker. It also refuses the required marker or a native `sandbox-exec` launch
passed through a custom Worker adapter, which previously discarded that native
wrapper. `runEmbeddedSession({ requireHostFloor: true, ... })` refuses before
parsing config or starting stores, hooks, MCP or tools. Ordinary embedded modes
remain supported. This is an explicit unsupported-mode gate, not implemented
embedded floor coverage: Bun Workers share Core's OS process and cannot establish
a per-session Seatbelt floor.

The host-only `brokerRequired` option on the embedded spawn/session lifecycle
enrolls Bash, Monitor and Workflow launches independently of the RPC client's presence.
The trusted Worker `start` message carries that requirement; `RuntimeConfig`, SDK
`Options`, model inputs and environment do not. Engine client removal does not
remove enrollment, and a missing/refused broker produces no local execution
fallback. Workflow refuses before creating its script, transcript or task, and
checks again at its real process-spawn door. Enrollment ends only after the session has returned and its terminal
cleanup has completed. The trusted parent broker's `runCommandLocally` entry is
separate: it requires the canonical host floor at admission and native spawn.
This command-only requirement does not floor other embedded consumers.

Every engine generation carrying a host process broker now retains an independent
broker requirement from entry through facet teardown. This applies to native,
embedded and descendant engines. Removing a client during a turn cannot enable
local command execution. The registration marker only narrows execution; an
authenticated host handler still supplies actual admission authority.

For embedded subprocess coverage, Core can supply
`spawnEmbeddedWorker({ hostChildFloor, ... })` (or the trusted direct session
equivalent). The host floor is snapshotted before a held Worker start and crosses
only the internal lifecycle channel, not `RuntimeConfig`, SDK `Options`, model
inputs or environment. The Worker renders and retains the immutable floor before
startup through terminal cleanup. `prepareHostChildLaunch` resolves the actual
executable using the child's environment/session cwd and wraps its command/argv
in native `sandbox-exec`. Hook shells, MCP stdio servers, git worktree/root/context
commands and image conversion use this shared boundary. Bash/Monitor and Workflow
compose the same denies into their existing sandbox profile, including permitted
unsandboxed Code postures. Missing native sandbox support and unresolved binaries
refuse rather than launching an unfloored child. An absent host registration
preserves ordinary SDK execution.

This is subprocess coverage, not full required embedded support. Core must keep
the floor registration trusted, pass it to every session generation, drain
existing/retired child processes before a protection transition, and consume
existing process-group/lifecycle evidence. Runtime-owned filesystem consumers
still need the separate protected file-operation boundary below. In particular,
`hostChildFloor` does not allow `requireHostFloor: true` to start an embedded
Worker; that full-mode requirement continues to refuse.

Full H2 embedded support remains open. Direct in-process file consumers include
`tools/impl/read.ts`, `write.ts`, `edit.ts`, `glob.ts`, `grep.ts`, their
`tools/safe-glob-scan.ts` walker and read-state/image/notebook helpers. Existing
permission path checks alone are not descriptor-bound protection against path
replacement races. The shared launch boundary covers these subprocess families:
`hooks/command-invoker.ts` (hook shell), `mcp/transports/stdio.ts` (stdio servers),
`tools/image-prep.ts` (sips), `tools/impl/enter-worktree.ts` (git),
`context/git-status.ts`, `context/winter-md.ts` and `subagents/git-root.ts`.
LSP is a host capability (`winter.lsp-server`); its Core adapter needs its own
read/launch coverage. Bash/Monitor use `sandbox/spawn.ts`; Workflow uses its
existing host broker. The reviewed SDK command seam recognizes `/compact` only;
no `!` shell route was found in that seam.
Production embedded support needs protected descriptor/path access and native
floor-preserving transports for those launch families, plus transition drain
evidence. Refusing required embedding does not implement those mechanisms.

These changes do not prove ownership of escaped setsid grandchildren or implement
VM isolation, active memory return, publication policy or Cowork production
integration. The guest file-helper experiment remains unactivated.

All trusted writers of one store must use the same PID namespace and exclusive
host-established store tenancy. A boot ID is shared by container PID namespaces;
boot ID plus PID/start ticks cannot prove ownership across those namespaces.
The selected separate-VM design keeps trusted runtime writers in the guest's
common namespace and denies tool compartments access to SDK stores. Any future
shared-outer-VM design must preserve that invariant or add namespace-bound host
recovery evidence before allowing cross-namespace store access.

Process closure and output completion have separate lifetimes. Once the OS
child closes, timeout/abort/error paths lose permission to signal its former
PID/group, even while output is still draining. Output transport failure is a
visible failed result for commands and Workflows, disposes both streams, and
cannot refill a released row through a late callback.

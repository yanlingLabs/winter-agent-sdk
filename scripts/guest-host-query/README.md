# SDK host-query Linux fixture source

Source base: accepted SDK11/12 composition `fe385afdabd908dab1b46be19fe40abe3bb259c8`.
This is a distinct source-only disposable Linux fixture. No protected service,
Root/native/helper/client artifact, mount, VM, GUI or CI execution has occurred.
No production capability, daemon registration, native device/backend, SDK version
or release pin changes. The first-SDK fixture/native helpers and held Mac two-disk/
egress lanes remain untouched.

## Concrete route and cases

`runtime.ts` imports the accepted immutable SDK host-query main. Runtime config,
files, provider and protected stores still derive only from the unchanged native
inherited-FD owner admission. Neither SDK argv/env nor the pipe adapter can admit
an owner. `host-client.ts` uses the real SDK query, its permission callback/parser
and fixed pipe transport. `provider.ts` is a distinct scripted provider using the
unchanged native peer/pidfd transport; a fixed fake credential remains only there.

The Root runner constructs the accepted ToolService/RuntimeDuplexPorts with
root-owned configured sources/policy. It creates host/provider processes before
starting service threads, retaining the existing native launcher/owner ABI.
Owned lifecycle FD7 is an observer: Root writes a bounded code record only after
native receipt + matching launcher reap + tool drain/no debt + actual service FD
closure and independently re-acquired store flock. The host client explicitly
awaits it after terminal result; stdout EOF or a hardcoded code0 never suffices.
Fixed FD8 carries only one idempotent `K` cancellation signal for this exact scope;
it invokes Root revoke/current native pidfd cancellation, never raw PIDs/commands.
Ordinary stdin.end remains graceful and separate from kill. The FD8 K cancellation
path is **UNEXECUTED**: only source/portable checks cover it here; no actual kernel
cancellation or native stop has been demonstrated by this fixture.

Four fresh conversations run sequentially:

- ask-allow: exact Write/Bash callbacks allow; Read seed and allowed source bytes
  must match; actual Bash boundary marker must be returned.
- ask-deny: those exact callbacks deny; sentinel/source tree remain unchanged.
- plan: fixture callbacks deliberately allow its exact Write/Bash requests,
  unlike the product approval bridge. Write must return the existing file-helper
  `read_only` authority refusal with is_error (not permission denied); actual Bash
  must attempt a source write, report the exact C-locale `Read-only file system`
  (Linux EROFS/errno30), then finish the boundary probe with no
  source effect. Write exercises the in-runtime file-helper gate using Root's
  read-only flag. Only Bash EROFS would demonstrate native read-only mount
  enforcement; local injected outcomes do not prove it.
- bypass: the callback throws if invoked; callback/request counts must be zero.
  Positive allowed Write succeeds and a readonly Bash probe checks actual tool
  view, followed by outside/store/credential file-helper denials with no callback.

The current native tool skeleton has **absent /proc and /dev**, not the later
utility-device profile. The probe requires those exact absences plus unavailable
private runhome/store/runtime/outside paths and host credential environment.
It also checks visible source symlinks to real parent-side store/credential
canaries do not resolve in the tool view; Root asserts their backing targets exist
and remain unchanged. The credential is 0444, and the separate protected canary
store has a 0755 directory/0444 file under traversable fixture ancestors. This
removes DAC as the reason for negative visibility. Before service threads start,
a fixed fixture child self-checks tool UID/primary GID10001 and supplementary
workspace GID10000 before writing `dac-control` in the
same backing source and be reaped; its bytes remain unchanged after plan probing.
Thus plan EROFS is checked against an actual writable backing control, not any
error or a DAC refusal. This source branch has not executed that Root-side control.
The actual protected SDK store and runhome remain 0700/fresh-empty; their real
invariants are never relaxed. Positive source Write is separate from readonly Bash, so
existing Code protected-path integrity checks are not bypassed or relaxed. This
is not complete Code parity, internet/utility support or a production VM test.

Host wire oracles bind exact tool call IDs/names/inputs, permission request ID and
toolUseID, corresponding callback/response IDs, result order/status, exact Read
bytes and actual Bash stdout. Fixed fixture capture is bounded at 256 messages /
2 MiB, with 1 MiB protocol lines. Root independently checks actual source bytes,
persisted tool/result history, exact opaque native-state content anchored to the
proper assistant UUID and scoped ancillary provider-state rows. Permission
`denied:true` is distinct from helper `is_error:true`. Root/kernel mount oracles
reuse exact accepted first-fixture function definitions from the measured source;
its old entry/import guard is not invoked or weakened. All definitions execute
only after the complete new staged source/dependency/artifact closure is admitted.
Normal rmtree remains mandatory; no unmount/ignore-EROFS fallback.

Failure retains disposable data and reports only bounded classes/counts. Signals,
EOF, result JSON, observer tags and model completion never prove cleanup. Root
requires actual source-held native/reap/drain/close evidence; unsuccessful close
stays a failure. Fresh empty stores, no cold resume and finite fixture runtime
are explicit pre-GA limits, not the product lifetime/continuity contract.

## Distinct measured build and staging

The new adapters transplant the accepted measured fixture mechanisms with closed
three-entry bindings: runtimeEntry, providerWorker, hostClient plus the same five
native artifacts. They reuse canonical copyCheckout/no-autoload compilation and
exact native recipes; old two-entry receipts/artifacts cannot be relabeled.
Receipts bind compiler/base hashes, measured checkout/dependency inventories,
metafiles, source before/after staging/compiling and artifact bytes. Unsigned
measurements require independent trusted build provenance, never self-authorize.

Limits: each ELF <=128 MiB; three-entry/native aggregate <=384 MiB (the pinned
base alone is 91,801,560 bytes * 3); source/dependency closure <=256 MiB; compressed
source archive independently <=256 MiB; JSON metadata <=16 MiB. These are build/
staging bounds, not guest RSS/RAM-return claims. The old 256 MiB two-entry artifact
aggregate is insufficient for three copies and is deliberately not reused.

`cowork-host-query-build.yml` is ordinary ARM64 Linux build-only: exact PR-head
checkout, pinned Bun/base, frozen dependencies without lifecycle scripts, new
output directories, unexecuted native compilation, portable tests and retained
source/archive/compiler/receipt identity. No sudo/native/service fixture runs in
that workflow. No workflow was dispatched from this lane.

A future independently reviewed execution must admit the exact new parent and
receipt hashes before importing repository modules. `stage.py` is stdlib-only;
it validates full source/dependency/ELF/metafile closure before staging under
fixed root-owned non-user-renamable `/tmp` ancestry. Isolated -I-S-B bootstrap
rechecks the staged parent/closure before importing the runner. Direct privileged
checkout invocation refuses before project imports. The parent takes **source /
artifacts / receipt directories**, not the utility lane's archive CLI. Archive
inspection/rehydration must happen unprivileged and independently before capture;
the separate data adapter is described below.

For a future approved parent only, the external wrapper must first open the
parent with O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC, require a bounded regular single-link
file, read bounded bytes and compare an independently approved SHA256, then exec
those exact bytes under system Python -I-S-B. Parent/receipt hash arguments must
come from trusted independent review, never the unsigned receipt itself. No
privileged command or launch approval is provided by this source report.

## Local source evidence

18 Python portable checks pass: three-entry complete inert closure, missing/extra/
old outputs, wrong recipe/kind/path, changed ELF/dependency/metafile, aggregate
refusal without stress allocation, canonical provider scope, real pipe final-writer
EOF and sidecar golden negatives for schema/items/anchor/order/input/result.
Synthetic ELF bytes are never executed and no Root ownership is simulated as
native authority. Six Bun tests / 46 assertions include actual local SDK query/
engine callback routes with injected testing provider/executor; those do not
prove guest/native approvals, boundary enforcement or Root observer release.
Both repository TypeScript checks pass. Three Bun bundles compile without
execution; exact logs/bundles are retained in `out/host-query-source-check/`.

Source review, fresh ordinary Linux build, complete independent artifact/source/
compiler/stager audit and a separately approved disposable execution workflow
remain required. The intended Linux cases have not run; no native or production
acceptance follows from these portable source checks.


Source correction after `7543057e`: plan approvals are intentionally adversarial
fixture-only allows so the independent readonly helper/mount result must carry the
failure. The existing helper's exact refusal is `Error [read_only]: guest file
operation refused` / is_error=true / denied=false, not a fabricated
`authority_denied` string. A pure actual-helper test checks that code before any
port invocation; local injected EROFS/readonly outcomes remain schema/control
checks only. Actual Linux execution must produce the helper refusal and Bash
EROFS itself. Readable canaries remove the earlier DAC ambiguity without changing
actual store/runhome ownership, permissions or fresh admission. Plan requires
exactly two callbacks, requests and responses. The helper rejects before its Root
port, so this SDK Write case does not exercise the later supervisor Write guard;
the real Bash EROFS probe is the independent readonly-mount requirement. FD8 remains
unexecuted and is not kernel-cancellation evidence.

## Unprivileged source rehydration

`rehydrate.py` imports only Python stdlib. Its caller must provide externally
reviewed SHA256 pins for `source.tar.gz` and the three-entry compile receipt;
neither a receipt nor a successful copy grants privileged staging or execution.
Root/effective-Root invocation refuses before opening inputs. Run using Python
`-I -S -B`, with explicit archive, compile-receipt, destination and both hashes.
The destination must not exist and its parent must be owned by the caller and
not writable by others. Every path ancestor and input FD is opened nofollow;
FIFO inputs are nonblocking and refuse before waiting for a writer.

The adapter checks the closed compile inventory/digest, safe source roots,
bounded bytes and internal symlink graph, then streams and verifies the entire
archive before creating a private 0700 destination. Its small fixed-header tar
reader admits only regular files, ordered internal hardlinks to already verified
equal bytes, and declared symlinks. Local PAX metadata is capped at 16 KiB;
unknown types, duplicate/extra/missing leaves, traversal, ancestor collisions,
link cycles/escape and trailing data refuse. Limits remain 20,000 leaves,
16 MiB per file/receipt and 256 MiB source/compressed archive, plus bounded tar
header overhead. No `tar.extract`, repository imports or copied code executes.

Every regular/hardlink entry becomes an independent exclusive 0600 regular file
with nlink1; only declared internal symlinks are created, last. Directory/leaf
writes use held descriptors. The complete current destination inventory, bytes,
ownership, modes, nlink and destination ancestry are revalidated before success;
the held archive and receipt are hashed again. Failure leaves partial data for
inspection and never repairs permissions, reuses a destination or copies as Root.
The existing externally admitted stager must still independently validate its
full native/compiler/recipe/artifact closure before any privilege or imports.

Local evidence: 13 synthetic portable tests cover independent hardlink copies,
symlink ordering, wrong hashes/source bytes, malformed inventory/old two-entry
receipts, missing/extra/duplicate/FIFO members and inputs, bounded metadata,
link traversal/order/targets/ancestor hazards, destination alias/reuse, final
bytes/nlink checks and retained partial writes. The data-only adapter also copied
the reviewed historical build `38412365562` / source `08306c78`: 3,689 independent
regular files plus 71 symlinks, exact 3,760-leaf closure. Archive SHA256:
`b4afe5ef49a5f3e6bd38972724de7f1340420821d1a36fde9394b80243f1896f`;
compile-receipt SHA256:
`f548050e2f0cf6fbc3780e372bd469ce8116f930a516f53eae36244aeb7352b8`.
During that data-only copy, no copied bytes were imported or executed. This does not relabel that old build
as containing this new adapter: source review and a fresh build/archive remain
required. No TypeScript, native helper, stager, build or workflow changed here.

## Host-query failure diagnostics

The independently admitted run `38423093803` failed its first ask-allow case
after staging, with only a generic failure line. Its cause and failed-fixture
cleanup remain unconfirmed. Timing alone does not establish a runtime cause.
This diagnostic source change does not retry it or reuse its admission/pins.

The runner now records closed phases spanning setup, DAC control, service/native
owner handoff, mount proof, completion, receipt/history/source oracles and normal
rmtree. It prints an exception class plus only known assertion reason,
supervisor refusal/mount code or numeric errno; unknown messages are omitted.
The fixed DAC control's observed child exit code is retained without changing
its success requirements. Host-client failures similarly emit only closed
internal reason/class and allowlisted errno codes, never raw exception messages.

Before and after failure unwind, the runner observes the existing native runtime
state/exit/cleanup flag, logical debt/active state, host/provider process exits,
bounded capture metadata, normalized stderr and whitelisted receipt fields.
It reuses the exact accepted fixed-control runtime-diagnostic reader and validator
after staged admission; missing diagnostics do not imply a cause. Failure-path
service.close results are observed separately from native receipt/reap/drain/store
release. No observer, EOF, kill/wait or close result establishes ownership release.

A compact failure record is retained using a fixed exclusive nofollow/nonblocking
0600 regular file and printed before main's unchanged `SystemExit(78) from None`.
Record output is bounded at 32 KiB; oversized snapshots are explicitly omitted,
preserving the original phase/reason. `retained:true` expresses failure retention
intent; `retentionDirectoryObserved` separately records true/false/unknown and
does not prove the whole tree or native cleanup. `ownershipReleased` remains
false on every failure. Success, approval, history, EROFS/DAC, mount and normal
rmtree oracles and their deadlines remain unchanged. No unmount/ignore-EROFS
fallback, stager/native-helper, workflow, capability or privilege change occurs.

Portable evidence: 40 Python tests (9 new diagnostic tests), 7 directly selected
Bun tests / 50 assertions, both TypeScript configurations and an unexecuted host
Bun bundle pass. An earlier Bun invocation omitted the `./` path prefix and
selected 19 tests / 142 assertions across the intended file and two retained
rehydrated source copies; their ordinary local/inMemory test legs were imported
and executed. This test-selection mistake is retained separately and is not
native evidence. The authoritative rerun used
`bun test ./scripts/guest-host-query/cases.test.ts` (exactly one file).
No Root, service, native/helper/ELF, mount, VM, GUI, credentials or CI execution
was performed in this diagnostic lane. Fresh source review, build, full artifact
chain audit and separately reviewed run admission are still required.

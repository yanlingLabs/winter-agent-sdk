# Fresh Linux SDK engine fixture

This implements a reusable, private fresh-session admission into the actual `runEmbeddedSession` → `buildProductionWiring` → `runEngine` lifecycle. General confined startup still reports `supportsConfinedGuestExecution: false`. A config, environment flag, copied object, fake store adapter, or NDJSON message cannot supply the private capability.

The Root Linux service owns the configured runtime/tool UIDs, admitted sources, artifact hashes, empty canonical store and run-home directory descriptors. Its native launcher creates the runtime mount/PID/network view and transfers the actual init pidfd, service pidfd, store directory and immutable executable descriptors over the inherited Root-authenticated socket. The inherited Root-owned readonly owner library checks those kernel objects, actual UID/PID and current boot before SDK startup and subsequent operations. Logical conversation identity and SDK backend identity are distinct; the actual fixture uses different values. Store path is `/workspace/.winter/conversations/<logical-id>`; the SDK's transcript and tool binding use the backend ID.

Only Read, Edit, Write and foreground Bash reach the existing registry executors and existing enforced tool compartments. The runtime has its own AF_UNIX-only IPC profile. Tool network remains offline. Sources/settings/skills/plugins/agents/hooks/MCP/workflows cannot widen this invocation: source tiers are empty, bundled skills/workflows and ambient MCP/agent loading are disabled, dispatch accepts only the four tools, and input accepts plain user text without slash commands or control mutations. Caller-replaced providers and tool executors are refused. The provider uses the private guest proxy with its exact admitted model/account/boot/incarnation scope.

The SDK cannot certify its own death while it is running. Its terminal store outcome therefore retains ownership with unconfirmed teardown; that outcome is not rewritten into release proof. The Root service releases its fresh directory hold only after the native namespace-init wait receipt, actual parent reap and tool drain all confirm cleanup. Uncertainty is retained. Nonempty stores and repeat launches are refused: cold restart and subagent continuation are not implemented by this slice.

## Runnable Linux fixture

`compile.ts` builds two fixed immutable entries with the pinned Linux ARM64 Bun base, path-neutral source staging, and Bun config/dotenv autoload disabled. It does not execute Linux code. Use new output directories; preserve prior artifacts and evidence.

```sh
bun scripts/guest-engine/compile.ts --guest-base /reviewed/bun-linux-arm64 --out out/fresh-engine-entries
python3 -I -S scripts/guest-engine/build.py --output out/fresh-engine-artifacts --runtime-entry out/fresh-engine-entries/runtimeEntry --provider-worker out/fresh-engine-entries/providerWorker --compile-receipt out/fresh-engine-entries/compile-receipt.json
```

Build on a disposable Linux ARM64 runner with an existing C compiler/static libc and Python standard library. The build records hashes of the complete SDK/provider/runtime source inventory and all seven artifacts. Before any privileged execution, independently review the exact source, build inputs and receipt. `verify.py` validates the supplied receipt and staged copies; it does not treat a matching receipt as product-native bootstrap authority.

Privileged invocation remains gated. The repository verifier imports project modules
before its in-function receipt check, so direct elevated execution is not an admitted
bootstrap path. A separate trusted stdlib-only, externally hash-admitted parent must
validate and stage the complete source/dependency/artifact closure under protected,
root-owned ancestry before any privileged repository import. That launcher is not
implemented by the compile/evidence correction; no privileged runner command is
recommended here.

The fixture uses disposable directories, runtime UID 20001, tool UID 10001 and provider UID 30001. It runs the real Root service and real compiled SDK entry, not a replacement agent loop. The provider is deliberately scripted: five normal model iterations produce Read, Edit, Write, Bash, then final text through the actual guest provider fold. It owns only a fake fixture credential, and authenticates every runtime connection using actual peer UID/PID versus the transferred init pidfd. Bun 1.3.14 cannot listen on inherited FDs; the immutable owner library therefore supplies bounded AF_UNIX frame accept/read/write on the Root-created listener, without pathname reopening. Requests are single-use, scoped, sequenced, and bounded; no blind retry occurs.

Failed/uncertain fixture runs retain their exact disposable files and emit only a normalized retention identifier. Python unwinding, EOF and kill delivery never delete the directories. Removal occurs only after the exact native cleanup status, successful service reap and validated provider receipt. Provider socket destruction settles the pending exchange promptly; the outer exchange deadline remains in place.

Success requires actual edited/written/shell-created source bytes, four successful matching tool-result records in the actual SDK transcript, final assistant text, and provider native-state sidecar records anchored to real assistant UUIDs under the correct backend session. It checks runtime-owned 0700/0600 store permissions and independently confirmed native cleanup. Text markers alone, tool errors, cross-session state and unbound anchors fail the oracle. The fake credential never appears in provider packets or SDK durable records.

## Evidence and limits

Local checks: both TypeScript configurations pass; 86 guest/embedded tests (411 assertions) passed after supervisor ticket composition. The cleanup correction adds an actual Unix socket close regression (five fresh-admission tests pass) and two no-process retention tests; all twelve fresh-engine Python tests pass. The fresh/legacy Python protocol tests and framing/evidence/receipt tests exercise real local sockets and malformed/replayed messages. The portable native frame/deadline harness explicitly substitutes kernel authority; it is not positive Linux admission evidence. Runtime and provider compile to ARM64 ELF using pinned Bun 1.3.14; native launch/owner code cross-compiles with warnings as errors.

No privileged Linux engine fixture, VM, live app/home, credential store or real provider was launched locally. Linux execution remains pending exact source/artifact review and CI. The fixture host-provider script is not the production Core provider broker or native host packet bridge. Production filesystem bootstrap/mount receipts, native worker ownership/channel integration, provider egress and full tool/delegation/context routes remain separate gates. This offline fresh invocation must not be advertised as complete Cowork, cold continuity, Internet availability or general confined startup.

## Composed invocation lifecycle candidate

Runtime source through `baf8dc7c` also includes invocation-scoped provider
cancellation, monotonically numbered invocations, and cancellation of an individual
Unix exchange without closing the provider route. The scripted fixture provider
still tests only its five sequential happy-path turns; concurrent model work is
covered by separate SDK/Core transport tests and is not Linux execution evidence.

Root validation of this composition passed 114 guest/embedded regressions (592
assertions) and both typecheck projects. Fresh entries compiled without executing
Linux programs into `out/fresh-engine-entry-invocations`:

- runtimeEntry: `e97df26ff3decf5d285c64998541f83ee0f00967208f53a63900d43aa83fe0e6`
- providerWorker: `efbe2dcd850155512c99b335866dd3f63bd0ad09cdabc41d81ddf421d5cefd08`

Both files were inspected as ARM64 Linux ELF. The earlier candidates remain
retained under their original paths. This is still not a native artifact-admission
receipt, privileged Linux startup, VM execution or permission to enable Cowork.

## Measured compilation and corrected evidence

The fresh-build provenance correction now emits `compile-receipt.json` and both
normalized Bun metafiles beside the compiled entries. It measures the bounded
checkout/config/installed dependency tree before and after staging and compilation,
checks actual bundled inputs against that tree, records host compiler and pinned
Linux base identities and the exact path-neutral recipe, and binds both resulting
ARM64 ELF hashes. Dependency package `dist` files are included. The native builder
requires `--compile-receipt <entries>/compile-receipt.json`, validates current
inputs and supplied entries before starting its compiler, copies and revalidates
that receipt/metafiles, then emits native receipt format2 binding its digest.

An unsigned JSON measurement is not build approval or native authority. A trusted,
reviewed build environment and independent source/artifact/run admission remain
required. Changing sources/dependencies, supplying stale/foreign entry bytes, or
substituting the compile receipt/metafiles refuses. Existing entries without a
compile receipt cannot be relabeled with the current source inventory. The native
build must use the same installed dependency snapshot as compilation.

The transcript oracle now requires exact Read seed bytes, exact four tool inputs
and results in order, five distinct assistant anchors, and typed native-state
payload/provider/model/family/item binding to those anchors. Marker strings do not
satisfy either check. Failure artifacts now preserve bounded normalized stderr,
phase and fixed failure metadata, provider receipt observations, native wait
receipt, parent reap and tool drain observations. They remain fixture diagnostics
outside canonical SDK stores and never upgrade uncertainty to ownership release.

Local portable evidence and actual compilation hashes are recorded in
`guest/FRESH-BUILD-PROVENANCE.md`. No privileged Linux service, guest ELF, VM,
held Mac lane or native egress retry was launched as part of this correction.

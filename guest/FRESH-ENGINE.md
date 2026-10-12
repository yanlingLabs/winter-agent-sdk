# Fresh Linux SDK engine fixture

This implements a reusable, private fresh-session admission into the actual `runEmbeddedSession` → `buildProductionWiring` → `runEngine` lifecycle. General confined startup still reports `supportsConfinedGuestExecution: false`. A config, environment flag, copied object, fake store adapter, or NDJSON message cannot supply the private capability.

The Root Linux service owns the configured runtime/tool UIDs, admitted sources, artifact hashes, empty canonical store and run-home directory descriptors. Its native launcher creates the runtime mount/PID/network view and transfers the actual init pidfd, service pidfd, store directory and immutable executable descriptors over the inherited Root-authenticated socket. The inherited Root-owned readonly owner library checks those kernel objects, actual UID/PID and current boot before SDK startup and subsequent operations. Logical conversation identity and SDK backend identity are distinct; the actual fixture uses different values. Store path is `/workspace/.winter/conversations/<logical-id>`; the SDK's transcript and tool binding use the backend ID.

Only Read, Edit, Write and foreground Bash reach the existing registry executors and existing enforced tool compartments. The runtime has its own AF_UNIX-only IPC profile. Tool network remains offline. Sources/settings/skills/plugins/agents/hooks/MCP/workflows cannot widen this invocation: source tiers are empty, bundled skills/workflows and ambient MCP/agent loading are disabled, dispatch accepts only the four tools, and input accepts plain user text without slash commands or control mutations. Caller-replaced providers and tool executors are refused. The provider uses the private guest proxy with its exact admitted model/account/boot/incarnation scope.

The SDK cannot certify its own death while it is running. Its terminal store outcome therefore retains ownership with unconfirmed teardown; that outcome is not rewritten into release proof. The Root service releases its fresh directory hold only after the native namespace-init wait receipt, actual parent reap and tool drain all confirm cleanup. Uncertainty is retained. Nonempty stores and repeat launches are refused: cold restart and subagent continuation are not implemented by this slice.

## Runnable Linux fixture

`compile.ts` builds two fixed immutable entries with the pinned Linux ARM64 Bun base, path-neutral source staging, and Bun config/dotenv autoload disabled. It does not execute Linux code. Use new output directories; preserve prior artifacts and evidence.

```sh
bun scripts/guest-engine/compile.ts --guest-base /reviewed/bun-linux-arm64 --out out/fresh-engine-entries
python3 -I -S scripts/guest-engine/build.py --output out/fresh-engine-artifacts --runtime-entry out/fresh-engine-entries/runtimeEntry --provider-worker out/fresh-engine-entries/providerWorker
```

Build on a disposable Linux ARM64 runner with an existing C compiler/static libc and Python standard library. The build records hashes of the complete SDK/provider/runtime source inventory and all seven artifacts. Before any privileged execution, independently review the exact source, build inputs and receipt. `verify.py` validates the supplied receipt and staged copies; it does not treat a matching receipt as product-native bootstrap authority.

After that explicit source/artifact admission, the isolated runner command is:

```sh
sudo python3 -I -S scripts/guest-engine/verify.py --artifacts out/fresh-engine-artifacts --reviewed-receipt out/fresh-engine-artifacts/receipt.json
```

The fixture uses disposable directories, runtime UID 20001, tool UID 10001 and provider UID 30001. It runs the real Root service and real compiled SDK entry, not a replacement agent loop. The provider is deliberately scripted: five normal model iterations produce Read, Edit, Write, Bash, then final text through the actual guest provider fold. It owns only a fake fixture credential, and authenticates every runtime connection using actual peer UID/PID versus the transferred init pidfd. Bun 1.3.14 cannot listen on inherited FDs; the immutable owner library therefore supplies bounded AF_UNIX frame accept/read/write on the Root-created listener, without pathname reopening. Requests are single-use, scoped, sequenced, and bounded; no blind retry occurs.

Failed/uncertain fixture runs retain their exact disposable files and emit only a normalized retention identifier. Python unwinding, EOF and kill delivery never delete the directories. Removal occurs only after the exact native cleanup status, successful service reap and validated provider receipt. Provider socket destruction settles the pending exchange promptly; the outer exchange deadline remains in place.

Success requires actual edited/written/shell-created source bytes, four successful matching tool-result records in the actual SDK transcript, final assistant text, and provider native-state sidecar records anchored to real assistant UUIDs under the correct backend session. It checks runtime-owned 0700/0600 store permissions and independently confirmed native cleanup. Text markers alone, tool errors, cross-session state and unbound anchors fail the oracle. The fake credential never appears in provider packets or SDK durable records.

## Evidence and limits

Local checks: both TypeScript configurations pass; 86 guest/embedded tests (411 assertions) passed after supervisor ticket composition. The cleanup correction adds an actual Unix socket close regression (five fresh-admission tests pass) and two no-process retention tests; all twelve fresh-engine Python tests pass. The fresh/legacy Python protocol tests and framing/evidence/receipt tests exercise real local sockets and malformed/replayed messages. The portable native frame/deadline harness explicitly substitutes kernel authority; it is not positive Linux admission evidence. Runtime and provider compile to ARM64 ELF using pinned Bun 1.3.14; native launch/owner code cross-compiles with warnings as errors.

No privileged Linux engine fixture, VM, live app/home, credential store or real provider was launched locally. Linux execution remains pending exact source/artifact review and CI. The fixture host-provider script is not the production Core provider broker or native host packet bridge. Production filesystem bootstrap/mount receipts, native worker ownership/channel integration, provider egress and full tool/delegation/context routes remain separate gates. This offline fresh invocation must not be advertised as complete Cowork, cold continuity, Internet availability or general confined startup.

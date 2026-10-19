# Guided hosted run: the one-run workflow (authored, unarmed, never triggered)

Status: **source and CI only.** `.github/workflows/guided-hosted-run-reviewed.yml` is a reviewed shell for ONE
hosted guided run. It refuses to run anything while it is unarmed, nothing here has been run on a runner, and this
document is the review brief. It does not admit a native owner, activate the guided profile, lift any guard, or
change a pin.

## What the run would do

On a throwaway `ubuntu-24.04-arm` runner, as root in one `sudo` step, a pinned runner file would drive the first
guided query: Root, the real native owner (five-descriptor record), the Root reader service, the isolated reader, the
host client and a request-counting stub provider. The verdict is `scripts/guest-hosted-guided/oracle.py`, a pure
function of Root-side evidence with bounded failure classes and no free text:

| Case | Passes when |
| --- | --- |
| `reader_exit64` | the reader launcher, given a refused envelope, exits 64 and no init receipt or pidfd existed (independent of the query chain) |
| `dispatch1` | the stub counted exactly one begin, accepted and completed, and the host saw the script's first answer |
| `shared_edit` | the shared guidance file's digest changed between the dispatches |
| `dispatch2` | the stub counted exactly two accepted, completed begins, and the host saw the second answer |
| `ticket_reuse` | presenting the spent ticket again, while the generation is still live, is refused as `required_context_unavailable` and the stub's counters do not move |
| `revocation` | after the issuer revokes, presenting a fresh, unspent ticket is refused and the stub's counters do not move: zero further provider requests |

Requests are counted by the STUB's own receipt counters (`receivedFrames`, `receivedBegins`, `acceptedBegins`,
`completed`), never by the host client. Reuse is tested before revocation, and revocation uses an unspent ticket, so
neither refusal can be explained by the other. A failed case turns the rest of its chain into `not_run`; it never
passes silently. `scripts/guest-hosted-guided/test_oracle.py` (CI, both architectures) holds the injected cases.

### The exit-64 observation fits the same run

It is an independent case in the same root step, run before the query. The launcher is dynamic and needs the packet's
loader, so it is exercised through the packet's own `instructionReaderLauncher` and the same `ReaderLauncher` path the
service uses, with a deliberately refused envelope. The result records the exit status, whether an init receipt or a
pidfd arrived, and the NAME of the `_exit(64)` site that was exercised (`argv_parse` is the planned one). Observing one
site does not prove `guided-reader-service.md` item 7 (every refusal precedes the namespace fork); the result says which
site it saw, and the doc must not claim more. A separate run is not needed.

## The trigger, the arming and the owner approval

* Trigger: ONLY a `push` that creates the never-used branch `cowork/guided-hosted-run`, with `github.event.created ==
  true`, the exact ref, this repository and `run_attempt == '1'`. No `pull_request`, `pull_request_target`,
  `workflow_dispatch`, `schedule` or `workflow_run` trigger exists, so no ordinary PR (including the one that adds this
  file) can run it. A re-run has `run_attempt` 2 and is refused.
* Unarmed: only `HOSTED_HEAD` is zero. Step 2 refuses a zero `HOSTED_HEAD`; step 3 would refuse a run id of `0` and any zero
  digest. The packet is bound (next section) and the gate test fails on any drift of those values. It also refuses binding the first
  packet's run id (39165162201): its `providerWorker` and `hostClient` are placeholders. The three digests are set in an ordinary reviewed commit
  (the packet digests from the verified compile artifact, the runner digest from the reviewed runner file; the gate test
  fails if the runner digest does not match the file). The owner-approved ARMING commit then changes exactly one line,
  `HOSTED_HEAD`, to the reviewed commit: the guard demands that commit be an ancestor of the pushed one, that the whole
  diff be that one file, `--numstat` `1 1`, and the exact one-line diff.
* Owner approval needed: one push of the armed head to `cowork/guided-hosted-run`, by the controller only after the owner
  approves that exact head. The branch is frozen after that one run: never push to it again, and **never delete and
  recreate it**, because creating it again is another first-creation push and would fire the workflow again.

## Safety shape

`permissions: contents: read` plus `actions: read` (the cross-run download needs it); no secrets; every action pinned to
a full SHA (`checkout`, `download-artifact`, `upload-artifact`); `github.token` appears once, as the download's own input.
The download is the first network step and runs before anything privileged. The verification step then re-checks the
packet archive, the inventory and the runner file against their pins with `sha256sum --check --strict`. The one `sudo`
step is justified because the run needs Root-created peers, pidfds and private mount/PID/IPC/UTS/network namespaces, as
the owner-matrix run did; it is gated the same way: a single `sudo -n env WINTER_GUIDED_HOSTED_ADMISSION=... python3 -I
-S -B -` whose launcher hashes the runner file (no symlink, link count 1, bounded size) and executes exactly the bytes it
hashed. The gate test runs that launcher for real, minus its uid line, against throwaway files. Uploads: the result JSON on
success, and on failure only the bounded result and diagnostics records; 7 days each.

## Prerequisites, audited (exists, this slice builds, or blocked)

| Prerequisite | State |
| --- | --- |
| Packet roles `hostClient` and `providerWorker` | **Real, in compile run 2** (runtime-sdk intake #23, merged at `04f82b13`): run 39227365159, artifact 12174387240 (`guided-packet-compile-39227365159`, 195,477,535 bytes, zip sha256 `a4d731f6...0296`, expires 2026-10-26). The workflow is bound to it (below); run 1's placeholder packet (39165162201) is refused by the gate test. |
| The root runner `run.py`, `session.py`, `roles_adapter.py` | **Written, never run as root on Linux.** Packet verification, metafile preflight, staging, the exit-64 case, the session (driving the existing Root entry points), the query chain, teardown and the result record are implemented and unit-tested with fakes. `RUNNER_SHA256` is the real hash of `run.py`, which embeds the hashes of its three siblings and of `fixture-inputs.json`; the gate test fails on any disagreement. `RealPlatform.exit64_case` and `open_session` drive `session.exit64_case` and `GuidedSession.open` (tested here with injected fakes only). |
| F2 ticket minting on the host side | Issuer exists (`claimGuidedGuestIssuer`, `guided-guest-attestation.md`); no host code claims it yet. The real host client claims it. |
| SDK host guard | Already lifted for a guided query that presents a valid one-shot ticket (`guided-guest-attestation.md`); nothing here changes it. |
| Trusted config | PID 1's `wg_build_trusted_config` writes neither `reader` nor `guidanceDirectory`. The supervisor takes its trusted config on a descriptor handed by the process that starts it (`linux-supervisor.py`, the argv grammar near its end), so a hosted runner can supply the guided block directly, as the supervisor's own tests do; this is not a blocker for the run. It stays owed before any activation. |
| Host adapter supplying `requiredRuntimeContext` and `generation` to Root | Built into `session.py`: the binding id and generation 1 are written into the supervisor's trusted config; the registration the supervisor derives is handed to the host client in its metadata (C-H3). |
| How the guest reaches the stub | Not the provider bridge: the stub implements `GuestProviderPort` over the native peer/pidfd transport, as the host-query fixture's scripted provider does. No NIC, vsock or listener. |
| The stub allows exactly two begins | A third begin is refused by the stub but still counted in `receivedBegins`; the oracle reads those counters, so a request that reached the stub after revocation fails the case even though the stub refused it. |
| Bun FD adapter, holder authentication of the guest stream | Unproven by design; this run is their first real exercise. |

## The run-2 binding

| Pin | Value |
| --- | --- |
| compile run / artifact | 39227365159 / 12174387240, `guided-packet-compile-39227365159` |
| `guided-packet.tar.gz` | `1bea0da978ac7ef731bb3b1dc89158f0efd29deeb551ec6df1b7fdc8279b98d1` |
| `packet-inventory.json` | `18f5fa5b84b041a6982cf07ae3a203f42d095418b5d1991004d49301d80dce62` |
| runtime-sdk head (verifier and pin) | `04f82b13a2af965a487d16b15ccfee8afc99fc09` |
| `verify_packet.py` / `compile-39227365159.pin.json` there | `2ac6b1af...01f3` / `220acd96...77a2` |
| roles (in the pin, not constants here) | providerWorker `4331d732...`, hostClient `37a2cf65...`, runtimeEntry `ce3f5c38...`, instructionReader `4d0702b2...`, ownerLibrary `4fe5304a...` |
| origins | runtime `ce730190`, agent-sdk `9c980c32`, Winter Core `8b52ef83`, builder `2cb3ecf0` |

The verification step, the runner and the root step all call `verify_packet.py <tar.gz> <inventory.json> --pin origins/runtime/scripts/guest-guided-intake/compile-39227365159.pin.json`:
with two pins side by side the verifier's default lookup exits 2, and CI cannot catch a well-formed wrong hash, so this call is the guard. A named
gate test pins the `--pin` argument and the absence of any `|| true`. The same packet was downloaded and checked locally with these exact calls:
the real verifier reported all 19 checks true and no placeholder; the runner's staging, metafile preflight (every SDK module exactly once) and tree
preparation passed against it; the workspace `linux-supervisor.py` equals the packet's captured copy (one member, `source/sdk/...`); the six
libraries satisfy the launcher's dependency grammar with no overlap. That check is an optional test (`WINTER_GUIDED_REAL_PACKET`, off in CI).

## The runner, in order

`run.py` is executed by the root launcher as the exact bytes it hashed, with the packet directory, the output directory,
runtime-sdk's `verify_packet.py` and its SHA-256, and the run-2 pin file and its SHA-256. It then:

1. checks admission (root and the one opt-in variable);
2. **verifies the packet first, before anything else**: it hashes the verifier and the pin, then runs the verifier as the
   packet's own unprivileged owner (it refuses root) with `--pin` passed EXPLICITLY (with two pins side by side the verifier's
   default lookup exits 2), and refuses unless it exits 0, `allChecksHold` is true, every check is true, the report lists no
   placeholder role and the pin marks none. CI cannot catch a well-formed wrong hash in a pin; this check can. The workflow's
   unprivileged verify step runs the same verifier before `sudo`;
3. loads `oracle.py`, `roles_adapter.py` and `session.py`, and reads `fixture-inputs.json`, only by the SHA-256 embedded in `run.py`
   (the gate test checks each embedded hash against the committed file, that no other sibling is named, that `run.py` executes code in
   exactly one place, `load_sibling`, after `read_pinned`, and runs exactly one subprocess, the hashed verifier with an explicit `--pin`; it
   checks the same for `session.py`'s one `exec`, which runs the supervisor only after its bytes matched the verified packet);
4. stages the archive into a fresh root-owned tree (files 0400; roles, natives, libraries and the Bun base 0555; links
   recreated; any escaping name or link refused);
5. **preflight, executing nothing**: every SDK module appears exactly once in the hostClient metafile (two copies of
   `guided-query-reader.ts` would make the reader lookup refuse everything and waste the run);
6. runs the independent exit-64 case, opens the session, runs the query chain, finishes (in the pinned order below), settles and tears
   down, and writes one bounded `result.json` (`O_EXCL`). Role text never enters the record. The run passes only if the verdict passes, the host
   client's own `host-result.passed` is true, the runtime settled, and both roles exited 0.

Failure classes of the runner itself: `admission`, `arguments`, `packet_verify`, `metafile`, `sibling_pin`,
`platform_incomplete`, `stage_packet`, `exit64_case`, `session`, `provider_start`, `dispatch1`, `shared_edit`, `dispatch2`,
`ticket_reuse`, `revocation`, `finish_order`, `host_result`, `settle`, `teardown`, `verdict`, `result_write`. The record also carries
`lifecycle`: `written` or `reader_gone` (see the finish order).

## The Root entry points `session.py` drives (all exist on main; nothing is invented)

The pattern is `scripts/guest-host-query/verify.py`, the v1 hosted Root runner (same uids, descriptor layouts and owner hand-off).

| Needed | Existing entry point called |
| --- | --- |
| Guided bootstrap, the five-descriptor registration, the immutable guidance view, the #35 reader service | `linux-supervisor.py` `ToolService(config, host_query_ports=...)` with the `hostQueryGuidedRuntime` profile: all of it is inside the service. Root supplies only the trusted config. |
| Runtime transport | `RuntimeDuplexPorts(sid, authority, input, stdout, stderr)` over three pipes |
| Start and run the guided `runtimeEntry` | `service.start()` then `service.launch_runtime(sid)`; the runtime launcher and native owner are the supervisor's own launch of the pinned artifacts |
| Owner hand-off to the provider | the v1 harness's `I` + `SCM_RIGHTS` on the admission socket, with the runtime's `initPidfd` |
| Registration and `requiredRuntimeContext` handed to the host client | `service._runtime_record(...)` and `service.runtimes[sid]['readerRegistration']` (the same private accessors the v1 runner uses) |
| Settle and teardown | `service.runtimes[sid]` state, `exitCode`, `cleanupConfirmed`, `service.active`, `service.debt`, `service.close()`, `service.revoke(sid)` |
| Exit-64 observation | the packet's own `instructionReaderLauncher`, run with a wrong argument count (the `argv_parse` site), a receipt socket inherited |
| The Root supervisor itself | its bytes must equal the copy captured in the verified packet, exactly one such member, or the session refuses |
| The native owner | the `ownerLibrary` hash comes from the run-2 pin, never a constant: the #37 holder patch will change it |

The owner binding, the reader dependencies (the packet's six libraries at their packet-relative guest paths) and every
artifact are re-hashed against the pin as they are copied into the run tree.

## What the entry contract asks of Root, and how it is met

From runtime-sdk draft PR 20 (C-P1..C-P11, C-H1..C-H12), as `roles_adapter.CONTRACT` lists them: Root writes `receipt <tag>` to the
provider (C-P11) and takes the counters from that reply and from the provider's final summary (C-P9), never from the host client;
the host client takes the stdin lines `dispatch 1`, `dispatch 2`, `premint`, `reuse`, `revoke`, `present-premint`, `finish` and its
`host-result.passed` decides its exit (C-H9, C-H12); Root starts the guided runtimeEntry, not the host client; **both roles are
launched with no network interface** (`os.unshare(CLONE_NEWNET)` before any identity change, then `/proc/<pid>/net/dev` must show
nothing but `lo`, or the role is killed and the session refuses), because the host-client bundle carries SDK fetch and spawn code the
entry never calls; stderr of both roles is discarded (the contract says it is never written). The oracle now compares the
provider's `requests` (every native arrival, readable or not) and the other receipt counters, at five barriers plus the final
summary, so a third begin that the stub refused (begins 3, accepted 2, refused 1) or an unreadable arrival after revocation still fails.

### Reconciled against the real entries (runtime-sdk `04f82b13`)

The adapter matches the merged `host-client-core.ts` and `provider-worker-core.ts`: the command words, the reply kinds and fields
(`host-dispatch` n/ok/answer/ended, `host-presented` which/refused/errorClass/processStarted, `host-premint` minted, `host-result` passed,
`provider-receipt` tag + counters, `provider-summary`), the ordering rules (reuse after dispatch 1, one premint before the revoke,
present-premint only after both, dispatch refused after the revoke) and the exit rules. Differences found, none blocking: the real host
client adds `version: 1` to every line and `minted: true` to `host-premint` (ignored); a presentation the SDK wrongly accepted is reported
`refused:false, processStarted:true` and the run cannot pass (the oracle fails it as `reuse_not_refused`/`revocation_not_refused`);
`host-result.passed` also needs `contextCalls >= 2` and no result after the revoke, which the host client judges itself.

### The finish order (pinned, derived from the code that emits it)

`finish` (Root to the host client's stdin), then the host client's `host-result` (its stdout), then Root's `HQX1:0` lifecycle record on fd 7.
The runner reads the result BEFORE it settles the runtime and writes the record, and refuses the other order by name:

* `runtime-sdk scripts/guest-guided-build/entries/host-client-core.ts` (04f82b13): `finish` sets `finished = true; break;` out of the command
  loop (line 229), the host then `await pump;` (line 234) and only then `ports.emit(result)` (line 240). Nothing between `finish` and the result
  reads the lifecycle reader.
* `scripts/guest-guided-build/entries/host-client.ts`: the lifecycle reader (`HOST_FDS.lifecycle`, fd 7) feeds `process.exited`, and the only
  consumer is `void process.exited.catch(() => {})` (line 57). `runGuidedHost` never awaits it. The v1 host client
  (`scripts/guest-host-query/host-client.ts` line 144, `await process.exited`) is the contrast: only that one waits for the record.
* `packages/sdk/src/query.ts` ends the read loop on the runtime's stdout end, not on `exited`; its only `await proc.exited` (line 1733) is the
  path with no terminal result and no abort, which a finished run does not take.
* Root writes the record last: `scripts/guest-host-query/verify.py` `phase='observer'` follows the independent native/reap/drain, close and
  flock checks, and `session.py` `settle` does the same.

Refused: `settle(host_result_seen)` raises `finish_order` unless the caller has read the result, and writes nothing; a host-result that has not
arrived when the reply deadline passes is the class `finish_order` (the result never comes before the record could be written); a `host-result`
before `finish` was sent is the adapter kind `premature_result` and never a pass. Because the host client returns right after its result,
fd 7 may have no reader left when Root writes the record; that is not a failure (nothing awaits the record, and the checks just made are the
evidence) and the result says which happened: `lifecycle: "written"` or `"reader_gone"`.

### Remaining differences (unsettled, listed in `roles_adapter.REMAINING_DIFFERENCES`)

D1 whether `host-spawn` is printed at startup or at the first dispatch (tolerated anywhere before a reply); D2 the errorClass for a
presentation that threw for another reason is `other`; D3 `provider-request` and `provider-outcome` lines are bounded noise, never evidence;
D4 a `host-query-ended` line is recorded and does not fail a command.

### `fixture-inputs.json`: derived, pinned, and where each field comes from

`scripts/guest-hosted-guided/fixture-inputs.json` (sha256 pinned in `run.py` as `FIXTURE_INPUTS_SHA256`) is produced by
`docs/guided-hosted-run/derive-fixture-inputs.ts` (kept under `docs/` on purpose: it dynamically imports from two other checkouts and spells no brand literal, which the repository's `scripts/**` scans would flag; it is a derivation record, not a build input), run over Winter at the run-2 pin's winter head (`8b52ef83`, the packet's own
`source/winter` bytes) and the host client core from the packet's builder origin:

```sh
bun docs/guided-hosted-run/derive-fixture-inputs.ts <winter checkout at 8b52ef83> <packet source/builder/scripts/guest-guided-build/entries> <out>
```

It is not run by CI or by the workflow; the committed file is pinned instead, and two runs produce the same bytes. Core's own classes create
the records (`CoworkRepository` with a folder source granted as `source`, `RuntimeSessionRecords`, `CoworkGuestRuntimeSupervisor.prepareQuery`,
`captureCoworkGuestOwner`, `CoworkGuestContextOwners`), the way Core's `guided-reader-adapter.test.ts` fixture does, and are dumped as data. The
tool then runs the host client's own `buildFixtureRecords` and Core's real `createCoworkGuidedRuntimeContextHandler` over the dumped data
(JSON round trip) for the old and the edited guidance, and reads the stub's marker lines from what Core produced. Any step that does not hold
throws and writes nothing.

| Field | Source |
| --- | --- |
| `hostFixture.registration`, `capture` | Core: the owner registry's `registrationPort` and `captureCoworkGuestOwner`, over the Root identities `session.py` also gives the guest (workspace `workspace`, logical session `guided-hosted`, backend session id, incarnation, lease 1, generation 1, source root `/workspace/folders/source`); `session.validate_inputs` refuses a fixture that disagrees with them |
| `hostFixture.runtimeRow`, `workspace`, `binding`, `policy`, `sources`, `grants` | Core's repository and runtime-session rows for that conversation (policy `ask`, like the guest's trusted config), plus the one folder grant |
| `hostFixture.bootId`, `capture.bootId`, `registration.bootId` | the kernel's boot id: the file carries a placeholder in exactly these three places and `session.bind_boot` replaces exactly those with `/proc/sys/kernel/random/boot_id` |
| `capture.launchId` | Core mints a random uuid; nothing on the host path reads it, so it is fixed to a constant to keep the file reproducible |
| `capture.readerRegistrationId` | presence-checked only (the frame carries no such field); a constant |
| `steps[].system` | lines of the host FACTS Core produced: the engine renders them under `# Current workspace context` in `system` (`packages/runtime/src/context/required-context.ts` `applyRequiredContext`); the header, the source line (`admitted at /workspace/folders/source; read-write.`) and the `Completion default:` line, in Core's order |
| `steps[].user` / `absentUser` | lines of the INSTRUCTIONS Core produced for the old and the edited guidance; the engine renders them under `# claudeMd` in message 0 (`requiredContextEntries`, `renderUserContext`); the block boundary lines carry a random render token and are not used |
| `guidance.old`, `guidance.edited`, `prompts`, `steps[].response` | Root's own choices: two distinct two-line guidance texts, two neutral dispatch prompts and the scripted answers the oracle compares; none depends on Core |

### NEEDS FROM OTHER LANE

1. **Engine confirmation** (agent-sdk runtime lane, `packages/runtime/src/context/required-context.ts`): the marker placement above is read from
   that source; the first run is the first time the compiled engine renders it. A `ordered_marker` refusal in the provider receipts would
   point at the placement, not at Core.
2. **`interrupt {scope:"turn"}`** (agent-sdk lane, routed separately by the coordinator): DOOR found that the guest host-query profile accepts only an
   empty `interrupt` payload while the host SDK sends `{scope:"turn"}`. This lane does not touch that profile and does not fix it.
3. Confirmation that the verified packet inventory carries the agent-sdk supervisor under exactly one `.../packages/runtime/src/guest/linux-supervisor.py`
   member (the session refuses otherwise; checked against the run-2 inventory: one member).

### What is unverified until the run

Nothing in `session.py` has run as root on Linux. The pure builders are checked against the real supervisor's own validators
(`guided_host_query_config`, `guided_reader_registration`, and a real `ToolService` constructed with the supervisor's patches), and the sequence
against a fake supervisor module; the descriptor layouts are copied from the v1 harness. The unshare, the `/proc` interface check, the owner
hand-off and the real `settle()` are exercised for the first time by the approved run. `exit64_case` and `open_session` no longer refuse: with
the inputs pinned they drive `session.exit64_case` and `GuidedSession.open`, tested here only against injected fakes (the whole chain runs over
an injected session module, and the inputs are refused if one byte differs). Nothing in `session.py` runs as root off the runner.

## Cross-repository download

The packet artifact lives in the runtime-sdk repository; this workflow runs in agent-sdk, with only its own
`github.token` (`contents: read`, `actions: read`). A throwaway probe in ordinary pull-request CI ran exactly this call
(`actions/download-artifact` with `repository`, `run-id` and `github-token: ${{ github.token }}`) against a small public
runtime-sdk artifact, and it succeeded (PR #36, commit `a9ec2efd`, since removed). Limits of that evidence: it was a
`pull_request` run, not a `push` run, and an artifact still inside its retention window; the packet is about 195 MB.
Download is the first network step and runs before anything privileged, so a failure there spends the run before any
`sudo`, but it would still spend the approved push. The fallback, if it is ever refused, is to host the run in
runtime-sdk (as the earlier reader-only hosted workflow was), checking out this repository's Root at a pinned head.

## Failure classes

`evidence_shape`, `stub_counters`, `reader_exit_status`, `reader_receipt`, `reader_site`, `dispatch_count`,
`dispatch_refused`, `dispatch_answer`, `edit_unchanged`, `revocation_not_refused`, `revocation_provider_request`,
`reuse_not_refused`, `reuse_provider_request`, `not_run`. Nothing here says anything about C59.

if an automated safety flag fires on follow-on work, that work stops and is surfaced to the owner, never reworded or rerouted.

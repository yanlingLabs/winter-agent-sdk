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
* Unarmed: `HOSTED_HEAD`, `PACKET_ARCHIVE_SHA256`, `PACKET_INVENTORY_SHA256` and `RUNNER_SHA256` are all zeros and
  `PACKET_RUN_ID` is `0`. Step 2 refuses a zero `HOSTED_HEAD`; step 3 refuses a run id of `0` and any zero digest. The gate
  test also refuses binding the first packet's run id (39165162201): its `providerWorker` and `hostClient` are placeholders. The three digests are set in an ordinary reviewed commit
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
| Packet roles `hostClient` and `providerWorker` | **Real sources exist in runtime-sdk draft PR 20; no packet carries them yet.** Run 39165162201 carries placeholders (they refuse if started), so this workflow binds a SECOND compile run, made after PR 20 merges: `PACKET_RUN_ID` is `0` and refused until then. |
| The root runner `run.py`, `session.py`, `roles_adapter.py` | **Written, never run as root on Linux.** Packet verification, metafile preflight, staging, the exit-64 case, the session (driving the existing Root entry points), the query chain, teardown and the result record are implemented and unit-tested with fakes. `RUNNER_SHA256` is the real hash of `run.py`, which embeds the hashes of its three siblings; the gate test fails on any disagreement. It cannot start a run without `fixture-inputs.json` (below). |
| F2 ticket minting on the host side | Issuer exists (`claimGuidedGuestIssuer`, `guided-guest-attestation.md`); no host code claims it yet. The real host client claims it. |
| SDK host guard | Already lifted for a guided query that presents a valid one-shot ticket (`guided-guest-attestation.md`); nothing here changes it. |
| Trusted config | PID 1's `wg_build_trusted_config` writes neither `reader` nor `guidanceDirectory`. The supervisor takes its trusted config on a descriptor handed by the process that starts it (`linux-supervisor.py`, the argv grammar near its end), so a hosted runner can supply the guided block directly, as the supervisor's own tests do; this is not a blocker for the run. It stays owed before any activation. |
| Host adapter supplying `requiredRuntimeContext` and `generation` to Root | Built into `session.py`: the binding id and generation 1 are written into the supervisor's trusted config; the registration the supervisor derives is handed to the host client in its metadata (C-H3). |
| How the guest reaches the stub | Not the provider bridge: the stub implements `GuestProviderPort` over the native peer/pidfd transport, as the host-query fixture's scripted provider does. No NIC, vsock or listener. |
| The stub allows exactly two begins | A third begin is refused by the stub but still counted in `receivedBegins`; the oracle reads those counters, so a request that reached the stub after revocation fails the case even though the stub refused it. |
| Bun FD adapter, holder authentication of the guest stream | Unproven by design; this run is their first real exercise. |

## The runner, in order

`run.py` is executed by the root launcher as the exact bytes it hashed, with the packet directory, the output directory,
runtime-sdk's `verify_packet.py` and its SHA-256, and the run-2 pin file and its SHA-256. It then:

1. checks admission (root and the one opt-in variable);
2. **verifies the packet first, before anything else**: it hashes the verifier and the pin, then runs the verifier as the
   packet's own unprivileged owner (it refuses root) with `--pin` passed EXPLICITLY (with two pins side by side the verifier's
   default lookup exits 2), and refuses unless it exits 0, `allChecksHold` is true, every check is true, the report lists no
   placeholder role and the pin marks none. CI cannot catch a well-formed wrong hash in a pin; this check can. The workflow's
   unprivileged verify step runs the same verifier before `sudo`;
3. loads `oracle.py`, `roles_adapter.py` and `session.py` only by the SHA-256 embedded in `run.py`;
4. stages the archive into a fresh root-owned tree (files 0400; roles, natives, libraries and the Bun base 0555; links
   recreated; any escaping name or link refused);
5. **preflight, executing nothing**: every SDK module appears exactly once in the hostClient metafile (two copies of
   `guided-query-reader.ts` would make the reader lookup refuse everything and waste the run);
6. runs the independent exit-64 case, opens the session, runs the query chain, finishes, settles and tears down, and writes
   one bounded `result.json` (`O_EXCL`). Role text never enters the record. The run passes only if the verdict passes, the host
   client's own `host-result.passed` is true, the runtime settled, and both roles exited 0.

Failure classes of the runner itself: `admission`, `arguments`, `packet_verify`, `metafile`, `sibling_pin`,
`platform_incomplete`, `stage_packet`, `exit64_case`, `session`, `provider_start`, `dispatch1`, `shared_edit`, `dispatch2`,
`ticket_reuse`, `revocation`, `host_result`, `teardown`, `verdict`, `result_write`.

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

### Remaining differences (unsettled, listed in `roles_adapter.REMAINING_DIFFERENCES`)

D1 the order of `finish`, the lifecycle record (fd 7) and `host-result` (the runner sends finish, settles and writes the record, then reads
the result, which works for either order); D2 whether `host-spawn` is printed at startup or at the first dispatch (tolerated anywhere
before a reply); D3 the errorClass for a presentation that threw for another reason is `other`; D4 `provider-request` and
`provider-outcome` lines are bounded noise, never evidence; D5 a `host-query-ended` line is recorded and does not fail a command.

### NEEDS FROM OTHER LANE (not built here)

1. **`fixture-inputs.json`** (runtime-sdk entries lane, which owns `FIXTURE_KEYS` and Winter Core's planner): the Core-dependent DATA. Its
   closed shape is `{version: 1, prompts: [2], guidance: {old, edited}, steps: [2 stub steps], hostFixture: {registration, capture,
   runtimeRow, workspace, binding, policy, sources, grants, bootId}}` (validated by `session.validate_inputs`). The `hostFixture`
   records must satisfy exactly the two raw statements Core's planner issues; the stub steps' marker lines are what Core's mapper emits for
   the old and the edited guidance. Neither can be invented here. It is pinned in `run.py` as `FIXTURE_INPUTS_SHA256`, zero until supplied.
2. A decision on D1 (the finish/lifecycle order) and on whether the host client waits for the lifecycle record.
3. Confirmation that the verified packet inventory carries the agent-sdk supervisor under exactly one `.../packages/runtime/src/guest/linux-supervisor.py`
   member (the session refuses otherwise).

### What is unverified until the run

Nothing in `session.py` has run as root on Linux. The pure builders are checked against the real supervisor's own validators
(`guided_host_query_config`, `guided_reader_registration`, and a real `ToolService` constructed with the supervisor's patches), and the sequence
against a fake supervisor module; the descriptor layouts are copied from the v1 harness. The unshare, the `/proc` interface check, the owner
hand-off and the real `settle()` are exercised for the first time by the approved run.

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

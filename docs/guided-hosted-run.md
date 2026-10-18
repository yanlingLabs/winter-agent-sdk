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
| Packet roles `hostClient` and `providerWorker` | **BLOCKED: placeholder.** The compile-only adapters in runtime-sdk `scripts/guest-guided-build/entries/` refuse if started, and that builder's README says the hosted-run slice must not bind to them. The run needs a packet whose real host client and provider runner exist: replace the adapters (a runtime-sdk change), then a second owner-approved guided compile run on a new branch, then bind this workflow to that run id and digest. Compiling them on the hosted runner instead would put Bun download, compilation and root execution in one run and break the packet's provenance chain. |
| The root runner `scripts/guest-hosted-guided/run.py` | **Written, but its Root-side platform is not.** Verification, sibling loading, the query chain through the adapter, teardown and the result record are implemented and tested with fake role processes. `exit64_case` and `open_session` (the supervisor config, the native owner, the mounts, the reader launcher) refuse with `platform_incomplete`, so as committed it cannot spend the run. `RUNNER_SHA256` is the real hash of the committed file; the gate test fails if they differ. |
| F2 ticket minting on the host side | Issuer exists (`claimGuidedGuestIssuer`, `guided-guest-attestation.md`); no host code claims it yet. The real host client claims it. |
| SDK host guard | Already lifted for a guided query that presents a valid one-shot ticket (`guided-guest-attestation.md`); nothing here changes it. |
| Trusted config | PID 1's `wg_build_trusted_config` writes neither `reader` nor `guidanceDirectory`. The supervisor takes its trusted config on a descriptor handed by the process that starts it (`linux-supervisor.py`, the argv grammar near its end), so a hosted runner can supply the guided block directly, as the supervisor's own tests do; this is not a blocker for the run. It stays owed before any activation. |
| Host adapter supplying `requiredRuntimeContext` and `generation` to Root | Not built; part of the runner. |
| How the guest reaches the stub | Not the provider bridge: the stub implements `GuestProviderPort` over the native peer/pidfd transport, as the host-query fixture's scripted provider does. No NIC, vsock or listener. |
| The stub allows exactly two begins | A third begin is refused by the stub but still counted in `receivedBegins`; the oracle reads those counters, so a request that reached the stub after revocation fails the case even though the stub refused it. |
| Bun FD adapter, holder authentication of the guest stream | Unproven by design; this run is their first real exercise. |

## The runner, in order

`run.py` is executed by the root launcher as the exact bytes it hashed, with the packet directory, the output directory,
runtime-sdk's `verify_packet.py` and its SHA-256, and the run-2 pin file and its SHA-256. It then:

1. checks admission (root and the one opt-in variable);
2. **verifies the packet first, before anything else**: it hashes the verifier and the pin, then runs the verifier as the
   packet's own unprivileged owner (it refuses root) and refuses unless it exits 0, `allChecksHold` is true, every check
   is true, the report lists no placeholder role and the pin marks none. CI cannot catch a well-formed wrong hash in a
   pin; this check can. The workflow's unprivileged verify step runs the same verifier before `sudo`, so a bad packet
   normally never reaches root at all;
3. loads `oracle.py` and `roles_adapter.py` only by the SHA-256 embedded in `run.py`;
4. stages the archive into a fresh root-owned tree (files 0400; roles, natives, libraries and the Bun base 0555; links
   recreated; any escaping name or link refused);
5. runs the independent exit-64 case, then the query chain through the adapter, then tears down both roles and the
   session, and writes one bounded `result.json` (`O_EXCL`) holding the stage reached, a bounded failure class and the
   oracle's verdict. Role text never enters the record.

Failure classes of the runner itself: `admission`, `arguments`, `packet_verify`, `sibling_pin`, `platform_incomplete`,
`stage_packet`, `exit64_case`, `session`, `provider_start`, `dispatch1`, `shared_edit`, `dispatch2`, `ticket_reuse`,
`revocation`, `teardown`, `verdict`, `result_write`.

**What is NOT written (owed, and why the run cannot be armed):** the platform's `exit64_case` and `open_session`.
They need the supervisor's guided config (including the `reader` block and `guidanceDirectory`), the native owner's
five-descriptor admission, the mounts and the reader launcher's receipt socket, none of which can be exercised off Linux
and none of which should be written against the final role hashes before the real roles exist. Until they are, the
default `RealPlatform` refuses, and a test pins that it does.

## Assumptions about the two real roles (to reconcile with the runtime-sdk lane)

Every call into the two roles is in ONE module, `scripts/guest-hosted-guided/roles_adapter.py`; its `ASSUMPTIONS` tuple
(A1 to A7, below) is the list. Reconciling with the real interfaces changes that file, the `ADAPTER_SHA256` embedded in
`run.py`, and therefore `RUNNER_SHA256`; a test fails if any of the three disagree. The transport assumed for both roles
is line-delimited JSON on stdin/stdout, one request and one reply per line, replies at most 64 KiB, 60 s per call.

Nothing below is in a merged contract; each line is what this slice assumed and what its oracle needs.

The adapter's assumptions, verbatim from `roles_adapter.ASSUMPTIONS`:

* A1 providerWorker takes the Root-supplied script bytes with their independent SHA-256 as {"op":"script","sha256","b64"} and replies {"ok":true}
* A2 providerWorker answers {"op":"receipt"} with {"ok":true,"receipt":{receivedFrames,receivedBegins,acceptedBegins,completed}} from the stub itself
* A3 hostClient answers {"op":"dispatch","n":1|2} with {"ok":true,"text":...} or {"ok":false,"errorClass":...}
* A4 hostClient answers {"op":"present_spent"} with {"ok":false,"errorClass":...} when the spent ticket is refused, {"ok":true} when it is not
* A5 hostClient answers {"op":"premint"} with {"ok":true} after minting one more unspent ticket, and {"op":"revoke"} with {"ok":true}
* A6 hostClient answers {"op":"present_premint"} like present_spent; after revoke it must refuse as required_context_unavailable
* A7 a role exits when its stdin closes; a role that does not is killed by the platform that spawned it

And the earlier statement of what the oracle needs:

1. `providerWorker` is the stub provider runner: it holds the Root-supplied script (bytes plus independent SHA-256) and
   serves `begin`/`next`/`cancel` over the native peer/pidfd transport, exactly two serial invocations.
2. Its stub receipt counters (`receivedFrames`, `receivedBegins`, `acceptedBegins`, `completed`) are readable by the
   Root-side runner at five points (after dispatch 1, after dispatch 2, after the reuse attempt, immediately before and
   immediately after revocation), from the provider process, not relayed by the host client.
3. `hostClient` runs the SDK `query` with a guided preparation and a ticket minted by the issuer it claims, and exposes:
   the answer text of each dispatch; the error class of a refused presentation (`required_context_unavailable`); a way to
   attempt a second presentation of a spent ticket; a way to pre-mint a second, unspent ticket and present it after a
   revoke; and a revoke command. It never reports provider-call counts as evidence.
4. Exit status: each role exits 0 on success and non-zero on any refusal; argv/stdin/stdout framing is whatever the
   runtime-sdk contract states, and the runner pins it by the role's SHA-256 in the new packet.
5. The shared guidance file is edited by Root between the dispatches, not by a guest process.

NEEDS FROM OTHER LANE (runtime-sdk): the counter read-out of assumption 2 (for example a `receipt` request on the
provider worker's control channel), the pre-minted-ticket and revoke commands of assumption 3, and the final role hashes
from the second compile run. If the real roles cannot offer them, the cases `ticket_reuse` and `revocation` cannot be
counted by the stub and the run must not claim them.

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

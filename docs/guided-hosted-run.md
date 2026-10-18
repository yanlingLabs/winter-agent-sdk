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
* Unarmed: `HOSTED_HEAD`, `PACKET_ARCHIVE_SHA256`, `PACKET_INVENTORY_SHA256` and `RUNNER_SHA256` are all zeros. Step 2
  refuses a zero `HOSTED_HEAD`; step 3 refuses any zero digest. The three digests are set in an ordinary reviewed commit
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
| The root runner `scripts/guest-hosted-guided/run.py` | **Not written; blocked behind the roles above.** The workflow names it by SHA-256; `RUNNER_SHA256` stays zero until it exists. |
| F2 ticket minting on the host side | Issuer exists (`claimGuidedGuestIssuer`, `guided-guest-attestation.md`); no host code claims it yet. The real host client claims it. |
| SDK host guard | Already lifted for a guided query that presents a valid one-shot ticket (`guided-guest-attestation.md`); nothing here changes it. |
| Trusted config | PID 1's `wg_build_trusted_config` writes neither `reader` nor `guidanceDirectory`. The supervisor takes its trusted config on a descriptor handed by the process that starts it (`linux-supervisor.py`, the argv grammar near its end), so a hosted runner can supply the guided block directly, as the supervisor's own tests do; this is not a blocker for the run. It stays owed before any activation. |
| Host adapter supplying `requiredRuntimeContext` and `generation` to Root | Not built; part of the runner. |
| How the guest reaches the stub | Not the provider bridge: the stub implements `GuestProviderPort` over the native peer/pidfd transport, as the host-query fixture's scripted provider does. No NIC, vsock or listener. |
| The stub allows exactly two begins | A third begin is refused by the stub but still counted in `receivedBegins`; the oracle reads those counters, so a request that reached the stub after revocation fails the case even though the stub refused it. |
| Bun FD adapter, holder authentication of the guest stream | Unproven by design; this run is their first real exercise. |

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

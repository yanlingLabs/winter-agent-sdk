# Guided owner matrix: the one-run workflow

`.github/workflows/guided-owner-matrix-reviewed.yml` runs the 12-entry guided owner matrix
(`scripts/guest-supervisor/test_guided_owner.py`, fixture `guided_owner_native_fixture.c`) once, as
root, on a disposable `ubuntu-24.04-arm` runner. This document is the review brief. The workflow is
authored here and has not run.

## What runs

- The CURRENT merged owner code (`packages/runtime/src/guest/linux-session-owner.c`) through the
  existing fixture. It does not depend on the unapplied compartment patch (compartment C) and does
  not test it.
- Steps: checkout of the pushed commit; a refusal unless the fixture and the matrix match their
  pinned SHA-256 (in the workflow's `env`); a `cc -Werror` compile as the ordinary runner user; then
  one `sudo -n env WINTER_GUIDED_OWNER_NATIVE_ADMISSION=... python3` step that re-checks the pinned
  bytes, runs only the 12 native cases, and writes a small JSON. The opt-in variable exists only on
  that command line.
- No secrets, `permissions: contents: read`, pinned action SHAs, and no network except the checkout.

## What it proves, and what it does not

It proves the owner's real kernel behaviour on one arm64 Linux kernel: pidfs and `SO_PEERPIDFD`
identity, the four descriptor-alias refusals, claim-twice, reader shutdown, bootstrap close and
stream half-close, each against the unchanged production owner.

It does not prove: the compartment C view or alias, the Root reader service, the compiled guided
packet, a hosted guided run, or the older-kernel refusal (below). It is a single sample on one
runner image.

## Expected result: 11 pass + 1 skip

The success cases need Linux 6.9 or later. `test_actual_pidfs_absent_before_69`
(`test_guided_owner.py:178-182`) needs a kernel older than 6.9, so on one 6.9-or-later runner the
matrix gives 11 pass + 1 skip, never 12 passes. The JSON records `matchesExpected11Plus1`; the job
fails if the kernel is older than 6.9, any case fails, or the skip is any other case. A second
older-kernel target would be a separate approval.

The artifact `guided-owner-matrix-result` (7-day retention, nothing else uploaded) holds: `uname -r`
as `kernelRelease`, the machine, the head SHA, both fixture hashes, the pass/skip/fail counts and
every test id with its outcome. The public log carries one summary line.

## Trigger and owner approval

- Trigger: a `push` that CREATES the never-used branch `cowork/guided-owner-matrix-run`
  (`github.event.created == true`, exact ref, this repository, `run_attempt == '1'`). There is no
  `pull_request`, `pull_request_target`, `workflow_dispatch` or `schedule` trigger, so no ordinary PR
  can fire it, including the PR that adds it.
- Owner approval needed: one push of the reviewed head to that branch, performed by the controller
  only after the owner approves that exact head. Never re-run it; a re-run has `run_attempt` 2 and
  is refused by the gate.
- The branch is frozen after that one run: never push to it again, never delete and recreate it.
  Any further run needs a new reviewed workflow with a new branch name.

`scripts/guided-owner-matrix-gates.test.ts` (part of the ordinary `bun test`) parses the workflow
and asserts all of the above, including that each gate removal is caught.

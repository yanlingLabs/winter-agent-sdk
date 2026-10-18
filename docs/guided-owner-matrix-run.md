# Guided owner matrix: the one-run workflow

`.github/workflows/guided-owner-matrix-reviewed.yml` runs the 12-entry guided owner matrix
(`scripts/guest-supervisor/test_guided_owner.py`, fixture `guided_owner_native_fixture.c`) once, as
root, on a disposable `ubuntu-24.04-arm` runner. This document is the review brief. The workflow is
authored here and has not run.

## What runs

- The CURRENT merged owner code (`packages/runtime/src/guest/linux-session-owner.c`) through the
  existing fixture. It does not depend on the (now applied) compartment C guidance patch and does
  not test it.
- Steps: checkout of the pushed commit; a refusal unless every pinned file matches its SHA-256 (in
  the workflow's `env`); a `cc -Werror` compile as the ordinary runner user; then one
  `sudo -n env WINTER_GUIDED_OWNER_NATIVE_ADMISSION=... python3 -I -S -B -` step that hashes every
  pinned file itself, runs only the 12 native cases, and writes a small JSON. The opt-in variable
  exists only on that command line.
- Pins (SHA-256), covering the matrix and the whole local include closure of the fixture:
  - `scripts/guest-supervisor/guided_owner_native_fixture.c`: `ef1a3e45...f2d39`
  - `scripts/guest-supervisor/test_guided_owner.py`: `b9ea9804...bedbf`
  - `packages/runtime/src/guest/linux-session-owner.c` (the fixture's only quoted `#include`):
    `c149d451...51fd8`

  The full values are in the workflow. The gate test computes the include closure statically and
  fails if a closure member is unpinned or a pin differs from the file.
- What the pins do and do not cover: the root step hashes each pinned file immediately before it
  runs the matrix, and the matrix then recompiles the fixture (and the included owner) from disk.
  The pin is a check at that moment, not a lock on the bytes the compiler later reads; the
  disposable runner has no other actor that could change them in between. The system `cc`, libc and
  kernel are not pinned.
- No secrets, `permissions: contents: read`, pinned action SHAs, and no network except the checkout.

## What it proves, and what it does not

It proves the owner's real kernel behaviour on one arm64 Linux kernel: pidfs and `SO_PEERPIDFD`
identity, the four descriptor-alias refusals, claim-twice, reader shutdown, bootstrap close and
stream half-close, each against the unchanged production owner.

It does not prove: the compartment C view or alias, the Root reader service, the compiled guided
packet, a hosted guided run, or the older-kernel refusal (below). It is a single sample on one
runner image.

## Compile risk, checked in ordinary CI

The one run must not be spent on a compiler refusal. Ordinary CI (`guest-file-boundary`, on
`ubuntu-24.04` and `ubuntu-24.04-arm`, gcc 13.3) therefore compiles the fixture with the exact flags
the workflow uses (`cc -std=c11 -O2 -Wall -Wextra -Werror`), compile only and never executed, and
runs `test_guided_owner.py` unprivileged (the 12 native cases skip there). The gate test requires
those flags to equal the workflow's and the matrix's own root compile flags.

gcc 13.3 did refuse the portable harness inside `test_guided_owner.py`
(`-Werror=misleading-indentation` on one line of the extracted-validation harness, a different
compile from the native fixture). That line was split with no behaviour change, which is why the
matrix pin differs from the earlier draft. The native fixture and the production owner compiled
cleanly under the same flags.

## Expected result: 11 pass + 1 skip

The success cases need Linux 6.9 or later. `test_actual_pidfs_absent_before_69`
(`test_guided_owner.py:178-182`) needs a kernel older than 6.9, so on one 6.9-or-later runner the
matrix gives 11 pass + 1 skip, never 12 passes. The JSON records `matchesExpected11Plus1`; the job
fails if the kernel is older than 6.9, any case fails, or the skip is any other case. A second
older-kernel target would be a separate approval.

The artifact `guided-owner-matrix-result` (7-day retention, nothing else uploaded) holds: `uname -r`
as `kernelRelease`, the machine, the head SHA, both fixture hashes, the pass/skip/fail counts and
every test id with its outcome. A failed case also carries a bounded `failureClass`
(`compile-error`, `missing-kernel-feature`, `assertion` or `timeout`), never runner text. The
public log carries one summary line.

## Expected kernel

`ubuntu-24.04-arm` runner images are described in `actions/partner-runner-images`. Its
`Ubuntu2404-Readme.md` (last changed 2026-02-03) lists kernel `6.14.0-1017-azure`, and the x64
`actions/runner-images` Ubuntu 24.04 readme lists `6.17.0-1022-azure`. Neither is verified for this
exact runner at run time, so treat a kernel of 6.9 or later as expected, not proven. If the runner
reports a kernel older than 6.9, the success cases skip, `matchesExpected11Plus1` is false and the
job fails. That run is then spent: nothing fires again, and a new reviewed workflow with a new
branch name would be needed.

## Trigger and owner approval

- Trigger: a `push` that CREATES the never-used branch `cowork/guided-owner-matrix-run`
  (`github.event.created == true`, exact ref, this repository, `run_attempt == '1'`). There is no
  `pull_request`, `pull_request_target`, `workflow_dispatch` or `schedule` trigger, so no ordinary PR
  can fire it, including the PR that adds it.
- Owner approval needed: one push of the reviewed head to that branch, performed by the controller
  only after the owner approves that exact head. Never re-run it; a re-run has `run_attempt` 2 and
  is refused by the gate.
- The branch is frozen after that one run: never push to it again.
- **Never delete and recreate the branch.** Creating it again is another first-creation push and
  would fire the workflow again. Any further run needs a new reviewed workflow with a new branch
  name.

`scripts/guided-owner-matrix-gates.test.ts` (part of the ordinary `bun test`) parses the workflow
and asserts all of the above, including that each gate removal is caught.

# Guided owner matrix 2: the successor one-run workflow

`.github/workflows/guided-owner-matrix-holder-reviewed.yml` runs the 16-entry guided owner matrix once,
as root, on a disposable `ubuntu-24.04-arm` runner. It is the successor to the spent first run
(`docs/guided-owner-matrix-run.md`, run 39133771464, 11 pass + 1 skip on the earlier bytes). It adds the
four holder cases that the applied DATA patches introduced (`docs/guided-owner-holder.md`):
`holder-census`, `holder-clear-cloexec`, `holder-stray-dup` and `holder-bootstrap-cloexec`. This
document is the review brief. The workflow is authored here and has not run, and the author never creates
its trigger branch.

## Pinned bytes

- `scripts/guest-supervisor/guided_owner_native_fixture.c`: `a0c4929d...`
- `scripts/guest-supervisor/test_guided_owner.py`: `8f93e9f8...`
- `packages/runtime/src/guest/linux-session-owner.c` (the fixture `#include`s it): `95457d8f...`

The first workflow stays in the tree unchanged as the record of the first run; its gate pins its bytes.

## Expected result: 15 pass + 1 skip

16 native entries: the original 12 plus the four holder cases. On one 6.9-or-later runner
`test_actual_pidfs_absent_before_69` skips, so the matrix gives 15 pass + 1 skip, never 16 passes. The JSON
records `matchesExpected15Plus1`; the job fails if the kernel is older than 6.9, any case fails, or the skip is
any other case. Result schema `winter-guided-owner-matrix-result/3` adds `armingSha` (the pushed arming commit);
`headSha` is the armed head whose bytes ran.

## Trigger and the arming step

- Trigger: a `push` that CREATES the never-used branch `cowork/guided-owner-matrix-run-2`
  (`github.event.created == true`, exact ref, this repository, `run_attempt == '1'`). No `pull_request`,
  `pull_request_target`, `workflow_dispatch` or `schedule` trigger exists, so no ordinary PR can fire it.
- The committed workflow is UNARMED: `ARMED_HEAD` is all zeros, and an unarmed push fails closed.
- Arming (an owner action, not done here): after this change merges, the owner makes one commit that changes
  only the `ARMED_HEAD` line to the merged commit, and creates the branch from that commit. The first step refuses
  unless `ARMED_HEAD` is an ancestor of the pushed commit, the difference is exactly that one line of this one file
  (name list, `numstat` 1/1 and the exact diff text), and then checks `ARMED_HEAD` out, so the bytes hashed and run
  are exactly the reviewed ones. The gate test runs this guard against throwaway Git repositories.
- The branch is frozen after one run. If it fails, the run is spent; another run needs a new reviewed workflow
  with a new branch name.

## What it proves, and what it cannot

Real-kernel behaviour of the close-on-exec re-proof on every check, the single close-on-exec transfer with its
own-process census, and the unchecked-to-checked bootstrap `F_SETFD`. It cannot prove who holds the reader end
in other processes; see "What holder authentication can honestly claim" in `docs/guided-owner-holder.md`.

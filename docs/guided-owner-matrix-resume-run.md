# Guided owner matrix 3: the cold-resume owner, one run

`.github/workflows/guided-owner-matrix-resume-reviewed.yml` runs the 16-entry guided owner matrix once, as root, on a
disposable `ubuntu-24.04-arm` runner, over the owner as patched for cold resume
(`docs/research/guided-owner-cold-resume-DATA.patch`, applied in this change). The first two runs are spent
(`docs/guided-owner-matrix-run.md`, `docs/guided-owner-matrix-run-2.md`) and their workflows are retired: deleted, so they cannot be re-armed. This
workflow is a fresh reviewed one with its own gate (`scripts/guided-owner-matrix-resume-gates.test.ts`) and a place on the retired-workflows allow-list
(`scripts/retired-workflows.test.ts`). This document is the review brief. The workflow is authored here and has not run, and the author never creates its
trigger branch.

## What changed in the owner

Before: the owner's record parser required `freshOnly: true`, so a resume record (cold resume, `docs/guided-cold-resume.md`) was refused and resume failed closed.
After: `continuation_ok` admits exactly two shapes, and `winter_owner_open` asks it instead of testing `freshOnly` itself.

| Record | Admitted |
|---|---|
| `freshOnly: true` | yes (the legacy fresh form, byte for byte as before) |
| `freshOnly: true`, `continuation: "fresh"` | yes |
| `continuation: "resume"`, no `freshOnly` | yes |
| `freshOnly: true`, `continuation: "resume"` | no |
| `freshOnly: false`, or any other `freshOnly` value or type | no |
| `continuation: "fresh"` alone, `continuation: "either"`, neither key | no |
| a repeated `freshOnly` or `continuation` key (`field()` reads a repeated key as absent, so `continuation_ok` refuses it first via `key_count`) | no, a hard refusal |

The supervisor resolves `either` before it writes the record, so the owner never sees it. Everything else in the owner is unchanged.

## Pinned bytes

- `scripts/guest-supervisor/guided_owner_native_fixture.c`: `a0c4929d...` (unchanged)
- `scripts/guest-supervisor/test_guided_owner.py`: `8f93e9f8...` (unchanged)
- `packages/runtime/src/guest/linux-session-owner.c` (the fixture `#include`s it): `7630cb1f...` (was `95457d8f...`)

The owner pin chain: `c149d451...` (first run) -> holder patch -> `95457d8f...` (second run) -> cold-resume patch -> `7630cb1f...`. `scripts/guest-supervisor/test_guided_owner_holder.py`
reverses and re-applies all three patches byte-exactly. The same owner sha is pinned in `test_guided_guidance_view.py` and `test_guided_reader_service.py` (frozen sources).

## Expected result: 15 pass + 1 skip

The matrix is the same 16 native entries as run 2: on one 6.9-or-later runner `test_actual_pidfs_absent_before_69` skips, so it gives 15 pass + 1 skip, never 16 passes.
The JSON records `matchesExpected15Plus1`; the job fails if the kernel is older than 6.9, any case fails, or the skip is any other case. The matrix does not add a
resume-record case: the resume shapes are proven by the native parser test (`test_native_parser.py`, compiled with the owner's own parser) and the owner source
guards (`ColdResumeOwnerTests`). What this run adds is the patched owner passing the unchanged native holder matrix on a real kernel. Result schema
`winter-guided-owner-matrix-result/3`: `armingSha` is the pushed arming commit, `headSha` the hosted head whose bytes ran.

## Trigger and the arming step

- Trigger: a `push` that CREATES the never-used branch `cowork/guided-owner-matrix-resume-run` (`github.event.created == true`, exact ref, this repository,
  `run_attempt == '1'`). No `pull_request`, `pull_request_target`, `workflow_dispatch` or `schedule` trigger exists, so no ordinary PR can fire it.
- The committed workflow is UNARMED: `HOSTED_HEAD` is all zeros, and an unarmed push fails closed.
- Arming (an owner action, not done here): after this change merges, the owner makes one commit that changes only the `HOSTED_HEAD` line to the merged commit, and
  creates the branch from that commit. The first step refuses unless `HOSTED_HEAD` is an ancestor of the pushed commit, the difference is exactly that one line of
  this one file (name list, `numstat` 1/1 and the exact diff text), and then checks `HOSTED_HEAD` out, so the bytes hashed and run are exactly the reviewed ones. The
  gate test runs this guard against throwaway Git repositories.
- The branch is frozen after one run. If it fails, the run is spent; another run needs a new reviewed workflow with a new branch name, its own gate, and a place on the allow-list.

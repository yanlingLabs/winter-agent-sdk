# Guest-side cold resume (CR2)

Design: N2 extensions design, section 3 (the winter repo's `docs/research/2026-10-18-n2-extensions-design.md`). This slice is the SDK half only.
It is stacked on guest messaging (`cowork/guest-messaging`) because both edit the same admission, profile and supervisor files.

## What changed

| Where | Before | Now |
| --- | --- | --- |
| `linux-host-query-profile.ts` | `resume` refused | `resume` admitted only when equal to `sessionId`; `continue`, `forkSession`, `resumeSessionAt`, `resumeDropsTurn` still refused. The guided profile inherits it. |
| `linux-session-admission.ts` (rules in `linux-cold-resume.ts`) | `freshOnly: true` required; `previousBootTermination: () => null` | a host-query record carries `continuation: "fresh" \| "resume"` and `endedGuestBoots`; previous-boot evidence exists only for a listed boot that is not this one |
| `linux-supervisor.py` | one fresh-store rule; 600 s cap | `continuation` of `fresh`, `resume` or `either`, resolved under the store flock; host-query cap 86,400,000 ms |

## Supervisor rules (`hostQueryRuntime` and `hostQueryGuidedRuntime`)

| `continuation` | Store | Run home | Result |
| --- | --- | --- | --- |
| absent or `fresh` | empty | empty | fresh, else `runtime_fresh_store_required` |
| `resume` | non-empty | empty | resume, else `runtime_resume_store_missing` (run home not empty: `runtime_fresh_store_required`) |
| `either` | empty or not | empty | the store picks `fresh` or `resume`; run home not empty: `runtime_fresh_store_required` |

- The store directory is already required to be owned by `runtimeUid` with mode 0700 (`runtime_directory_identity`).
- The same predicate runs again at launch with the RESOLVED value, so a store that changed between configure and launch refuses.
- The resolved value is in the status reply as `runtime.continuation`.
- `endedGuestBoots`: 0 to 4 distinct canonical boot ids, never this boot (`runtime_ended_boots`). Any other `continuation` is `runtime_continuation`.
- A launch is always a new run. `launch_runtime` still refuses a second launch of one configured runtime.
- The fixture `fresh` profile takes neither key and keeps its ten-minute cap.

## The record

- A request with neither key produces today's record byte for byte (the v1 golden pin holds).
- Naming either key adds `continuation` and `endedGuestBoots`. A fresh record also keeps `freshOnly: true`, because the unmodified native owner requires it.
- A resume record has no `freshOnly` and sets `runtimeConfig.resume` to the backend session id. The admission refuses a config whose `resume` differs from the record's.
- A record with no `continuation` is the legacy fresh form and is accepted as fresh.

## Image pins that move

- Supervisor sha: `a1ac484b...` (was `53b507bb...`). Re-pin once.
- Engine bundle: moves (admission and profile change).
- The native owner library does NOT move here. A resume record is refused by the unmodified owner (it requires `freshOnly`), failing closed. `docs/research/guided-owner-cold-resume-DATA.patch` is the proposed owner patch (not applied): it admits `continuation: "resume"` without `freshOnly`. Applying it moves `OWNER_SHA256` in the reviewed owner-matrix workflow, which is the owner's step.
- `docs/research/guided-supervisor-cold-resume-DATA.patch` records the supervisor delta for the pin chain.

## Belongs to other lanes

- CR1 contract: `continuation`, `endedGuestBoots`, the two bootstrap faults, vectors.
- CR3 guest PID 1: passes both keys through untouched; `expectedFilesystemUUID` handling.
- CR4 host: the four-state `store_state`, recording the guest boot id before the set is sent, stable never-reused uids, passing `resume` to `query()` only when the echoed continuation is `resume`.
- FC4 (browse) may touch the supervisor's uid-distinctness rule; this slice does not.

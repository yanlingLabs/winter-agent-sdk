# Guided owner: CLOEXEC proof, single transfer, and what "holder" can claim

Status: **proposed, not applied.** Nothing here changes the tracked
`packages/runtime/src/guest/linux-session-owner.c`, the owner fixture or the
owner matrix. The change is a pair of DATA patches under `docs/research/`,
authored and tested against scratch copies, following the #25/#34 precedent.
Applying them is an owner decision (below) because they move pinned hashes.

Tests: `scripts/guest-supervisor/test_guided_owner_holder.py` (portable, runs on
this Mac and in ordinary CI; the Linux compile class is compile-only and is never
executed). No Linux run, no workflow run and no new trigger was made for this slice.

## Recorded hashes

| Artifact | SHA-256 |
|---|---|
| tracked `linux-session-owner.c` (unchanged) | `c149d451eaa79442dfd41e9375c891ae8c9a06135d2cfc85851bcc8b5ce51fd8` |
| owner DATA patch `2026-10-18-guided-owner-holder-DATA.patch` | `6f44da8cc9345f944ac805a3ca635b732b425e284b00765eb55d40cdaa7097b6` |
| owner after the patch is applied | `95457d8f6ff256257b3b211e0201c64a4ed0b575aac6a9f933b3178b823b0d76` |
| fixture DATA patch `2026-10-18-guided-owner-holder-fixture-DATA.patch` | `efa9fa9f2fc84308df7a6a238fd7e0267239cf6dbb5d8689d0f68139120c46d4` |

## Audit of the tracked owner

Already proven (matrix run `39133771464`, 11 passed, 1 skipped, kernel
6.17.0-1022-azure): every received descriptor is admitted close-on-exec
(`MSG_CMSG_CLOEXEC`), the claim dup is close-on-exec, a second claim is refused,
and a number reused by the caller is never closed by native.

Gaps found by reading the source:

1. `winter_owner_check` never re-proved that the retained descriptors are still
   close-on-exec. Anything in the process that cleared the flag later (a library,
   a stray `fcntl`) would go unnoticed, and the next exec would leak the guest end.
2. The bootstrap socket `o->socket` had an unchecked `F_SETFD` after the fact
   (`fcntl(socketfd,F_SETFD,FD_CLOEXEC);`), so a failure was ignored. This is the
   `o->socket` finding: it was the one retained descriptor with no proof at all.
3. The claim transferred `fcntl(fd4,F_DUPFD_CLOEXEC,...)` with no check that the
   original was close-on-exec, that no other descriptor in the process already
   referred to the same socket, or that the dup is a distinct, close-on-exec
   descriptor referring to the same object.

Close audit: the only `close()` of a number in the transfer path is the
`close(copy)` of the dup native itself just made and is not returning. Native never
calls `close` on the returned descriptor or on a caller-owned duplicate. A
`fcntl` failure in the dup path closes nothing.

## What the patch adds (each guard has a test and a mutation)

- `cloexec(fd)`: `F_GETFD` and `FD_CLOEXEC`.
- `retained_cloexec(o)`: every retained `fd[0..count)` (negatives skipped) and
  `o->socket` are close-on-exec. `winter_owner_check` begins with it, so every
  later check re-proves the flag.
- Open time: `fcntl(socketfd,F_SETFD,FD_CLOEXEC)<0 || !cloexec(socketfd)` fails
  the open, before `o->socket` is assigned.
- `census(fd)`: counts descriptors in this process (`/proc/self/fd`) that have the
  same `st_dev`/`st_ino` as `fd`; -1 for a non-socket or an unreadable table;
  its own directory descriptor is skipped.
- `transfer_reader(original)`: refuses `original<3`, a non-CLOEXEC original, or a
  census other than 1 (a stray holder in this process). It then makes exactly one
  `F_DUPFD_CLOEXEC` dup and refuses unless the dup is not the original, is
  close-on-exec, refers to the same object, and the census is exactly 2. On any
  refusal it closes only its own dup.
- `winter_owner_claim_reader` marks `reader_claimed=1` before the transfer. A
  refused transfer still spends the claim; a claim refused by `winter_owner_check`
  (for example CLOEXEC cleared) does not.

CLOEXEC blocks inheritance across `exec`, not across `fork` or an `SCM_RIGHTS`
re-pass. The census is the own-process view only; it cannot see other processes.

## What "holder" authentication can honestly claim

Root authenticates the guest end by creator identity: `SO_PEERCRED` and
`SO_PEERPIDFD` on a socket reflect the process that created the socketpair or
connected, fixed at that time. They do not follow the descriptor to whoever holds
it now. (Kernel source for this was not re-verified in this slice; the statement is
the documented behaviour of these options and should be re-checked against the
kernel before anything depends on its exact wording.)

After this patch a native owner can honestly claim, about its **own process only**:
its retained descriptor and bootstrap socket are close-on-exec, exactly one
distinct close-on-exec dup of the reader end exists beyond the retained one at the
moment of transfer, and no other descriptor in the process referred to the object
before the claim. It cannot claim anything about other processes: a forked child,
a process that received the descriptor over a socket, or a privileged observer.

It cannot be made to claim "the eventual holder is the runtime" without a
privileged or kernel-side view. The peer inode of a unix socket is exposed only
through sock_diag netlink, or through a privileged `/proc` and `kcmp` walk across
processes. The patch deliberately uses neither (a test scans the patch for netlink
and network tokens). A later slice that needs a true holder claim needs one of:
a per-incarnation exclusive handoff that Root performs and attests (already the
reader-service design), a privileged census run by Root across the runtime's
process tree, or a sock_diag query. Each is a separate owner decision.

## Owner decisions

The patched owner, fixture and matrix have only been tested portably here (the
fixture compiles on Linux in CI as compile-only). Proving the new cases on a real
kernel needs the native owner matrix run.

- **Option A (recommended).** Author a successor one-run reviewed workflow, on a
  new never-used branch, that carries the patched owner, the patched fixture and
  the four new native cases (`holder-census`, `holder-clear-cloexec`,
  `holder-stray-dup`, `holder-bootstrap-cloexec`), copying the existing
  `guided-owner-matrix-reviewed.yml` structure. This keeps the one-run rule
  (`run_attempt == '1'`) and does not reuse the spent branch.
- **Option B.** Add a privileged step to ordinary CI. This contradicts the
  documented rule that ordinary CI never runs the native owner and is not
  recommended.

Applying either option's patches is separate and moves pins (below). No trigger
was authored here.

## Pins that move if the patches are applied

- `OWNER_SHA256`, `FIXTURE_SHA256`, `MATRIX_SHA256` in
  `.github/workflows/guided-owner-matrix-reviewed.yml` and in
  `scripts/guided-owner-matrix-gates.test.ts`.
- `FROZEN` in `scripts/guest-supervisor/test_guided_guidance_view.py`.
- The owner hash check in `scripts/guest-supervisor/test_guided_reader_service.py`.
- The v1 packet `ownerLibrary` hashes.
- Winter's `expectedArtifact` for the owner library.
- The matrix count. The fixture patch adds 4 cases: 12 -> 16 total, 11 -> 15 pass,
  1 skip. This moves the reviewed workflow root runner's
  `len(tests) == 12 and count('pass') == 11` and its skip list, and the gate test's
  12-case / "11 pass + 1 skip" expectations. The successor workflow (Option A)
  carries its own count expectations (16 / 15 / 1) rather than editing the spent one.
- The constants hard-coded in `scripts/guest-supervisor/test_guided_owner_holder.py`
  (`TRACKED_OWNER_SHA256`, `PATCHED_OWNER_SHA256`, `FIXTURE_SHA256`, `MATRIX_SHA256`),
  and this document's own hash table (the tracked hashes become the applied hashes).

None of these were changed.

## Low-severity note

`winter_owner_open` now sets and verifies `FD_CLOEXEC` on the caller-owned bootstrap
socket before the later checks, so a failed open can still leave that socket
close-on-exec. This is harmless: the flag only blocks inheritance across `exec`, the
caller still owns and closes the descriptor, and native never closes it by number.

## Mutation check

35 mutants of the patched owner were substituted through
`WINTER_OWNER_HOLDER_SOURCES` and run against
`scripts/guest-supervisor/test_guided_owner_holder.py`: 34 killed. The one survivor
(`census`: dropping the `*e->d_name<'0'||>'9'` pre-filter) is an equivalent mutant,
because the `strtol` end-pointer check on the next line already skips `.`, `..` and
any non-numeric name. Covered: the `retained_cloexec` loops and socket term, the
`winter_owner_check` wiring, the open-time `F_SETFD` guard (unchecked, unverified,
unset, removed), every `transfer_reader` condition and the lone `close(copy)`, the
`census` pieces (socket type, unreadable table, directory handle, device, inode) and
the claim ordering and check. The mutation runner itself lives in the author's
scratch space and is not committed.

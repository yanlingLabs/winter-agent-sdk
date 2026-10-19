# Guided owner: CLOEXEC proof, single transfer, and what "holder" can claim

Status: **applied, not yet run on a kernel.** Both DATA patches under
`docs/research/` were applied byte-exactly (zero fuzz, no offset) to
`packages/runtime/src/guest/linux-session-owner.c`,
`scripts/guest-supervisor/guided_owner_native_fixture.c` and
`scripts/guest-supervisor/test_guided_owner.py`. The patches stay in the tree as the
record: a test reverses them to the previously pinned bytes and re-applies them.
Option A was chosen: a successor one-run reviewed workflow
(`.github/workflows/guided-owner-matrix-holder-reviewed.yml`, `docs/guided-owner-matrix-run-2.md`)
carries the new cases. It is authored, never triggered here.

Tests: `scripts/guest-supervisor/test_guided_owner_holder.py` (portable, runs on
this Mac and in ordinary CI; the Linux compile class is compile-only and is never
executed). The four new native cases are skipped off a root Linux runner like the
other twelve; they have not run on a kernel.

## Recorded hashes

| Artifact | Before (spent run `39133771464`) | Now (tracked) |
|---|---|---|
| `linux-session-owner.c` | `c149d451eaa79442dfd41e9375c891ae8c9a06135d2cfc85851bcc8b5ce51fd8` | `95457d8f6ff256257b3b211e0201c64a4ed0b575aac6a9f933b3178b823b0d76` |
| `guided_owner_native_fixture.c` | `ef1a3e4554551a47e5857ec90618cb968be2e3a1a653817df5bcac5d269f2d39` | `a0c4929d88ae9dc66fc2201a2ff65c047e4c9ea0e85807d181080835539587d1` |
| `test_guided_owner.py` (the matrix) | `b9ea9804d57806f3ecfa765d65c2eb92c93ce1171b08cef72c3c81e8e5bbedbf` | `8f93e9f8327e7da20241f52bdd2a2fdb556134456b64f037ab9a046811406cb4` |
| owner DATA patch `2026-10-18-guided-owner-holder-DATA.patch` | | `6f44da8cc9345f944ac805a3ca635b732b425e284b00765eb55d40cdaa7097b6` |
| fixture DATA patch `2026-10-18-guided-owner-holder-fixture-DATA.patch` | | `efa9fa9f2fc84308df7a6a238fd7e0267239cf6dbb5d8689d0f68139120c46d4` |

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

## Owner decision (taken)

Option A: a successor one-run reviewed workflow on a new never-used branch,
carrying the patched owner and fixture and the four cases. Option B (a privileged
step in ordinary CI) was rejected because it contradicts the documented rule that
ordinary CI never runs the native owner. The old workflow
`guided-owner-matrix-reviewed.yml` is left byte-for-byte as the record of the first
run (its branch is spent; its gate test now pins its bytes).

## Pins that moved when the patches were applied

- `FROZEN` in `scripts/guest-supervisor/test_guided_guidance_view.py` and the hash
  check in `scripts/guest-supervisor/test_guided_reader_service.py`: the owner is
  `95457d8f...`.
- The constants and the hash table in this document and in
  `scripts/guest-supervisor/test_guided_owner_holder.py`.
- The successor workflow carries its own pins and its own count expectations:
  16 total, 15 pass, 1 skip (`test_actual_pidfs_absent_before_69`), against 12 / 11 / 1
  for the spent one.
- Not pins in this repo (checked by search): no source file here, and no compile-input
  pin in the runtime-sdk, carries the owner's hash. The compiled `ownerLibrary` hash
  in the v1 packet changes at the next compile run, and Winter's `expectedArtifact`
  must follow it. Both belong to other lanes.

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

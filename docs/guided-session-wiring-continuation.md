# Guided session wiring source checkpoint — 2026-10-14

Root requested this checkpoint before restarting its session. Work is preserved,
not completed or activated.

- Worktree: `.worktrees/sdk-guided-session-wiring`, relative to the Cowork workspace.
- Branch: `cowork/guided-session-wiring`; no push or Claude message was sent.
- Exact base: `4ab941a33cfb291446c1e44e5b7f52cf58f4ec0d` (accepted channel identity prerequisite).
- Validator checkpoint: `52a3bcf4a4e1ca1d21164ecdfb2dcabc439aa6b5`.
- Source wiring commit: `2deeaf9169617433a746647acce6a3c65b27f009`.
- Source wiring tree: `880fa2403173917a49926373496f2bd837e85313`.

## Saved source behavior

Closed guided profile/registration validators bind parent identity, immutable
views, exact budgets and required-context correlation. Only the actual native
admission WeakMap can construct the production bridge. The prospective guided
factory requires new native claim/shutdown symbols; current native source cannot
provide them, and no current entry or Root producer calls this factory. There is
no injected/test production admission capability.

The embedded parent creates one native-owned reader port and one exact output/
context channel. Production wiring selects that channel, and the engine verifies
its identity with the assembler and output before startup. Guided engine traffic
permits only permission/runtime-context requests; reader handling dispatches
asynchronously so its pending read does not block the input pump. Unknown child
responses never reach ordinary child routing. Legacy instruction/memory discovery
is suppressed by the guided assembler's internal dependency flag. Ordinary Code,
v1 and SDK host query behavior are unchanged.

The injected transport registers operations before sending, multiplexes bounded
4-byte BE frames, tracks consumed IDs and 16 outstanding reads, validates inner
RuntimeSDK owner/views/limits echoes and keeps result separate from terminal
reap/EOF/drain receipts. Loss retains uncertain debt. Snapshot semantics remain
the actual RuntimeSDK loader/Core mapper. Source tests never run a native channel,
Root service, Socket or provider outside deterministic in-memory stubs.

## Actual checks

Latest review-fix source check: 92 tests passed, zero failures, 986 assertions across ten files:

- guest: guided reader construction, channel, socket effects, protocol, parent bridge and v1 profile;
- context: ordinary channel, required-context unit/engine behavior and guided assembler.

`tsconfig.typecheck.json`, `tsconfig.sdk-fence.json` and `git diff --check` passed.
Cached dependencies are linked through ignored `node_modules` symlinks; no install,
pin, version bump or release occurred. Native C was neither changed nor executed.

## Review fixes after restart

W1/W6 and missing-reader-symbol refusal are isolated in
`b766e7bc13505aa481ae8e22332856e69dde47cd`. Channel construction failure after a
wire claim now closes that wire and the native owner independently; cleanup
exceptions are sanitized. Retry checks both existing reader and existing channel.
No injected native admission factory was introduced.

W2/W3 use the fixed inherited-FD `Bun.connect` branch instead of Node Socket
construction/adoption. Before any transfer, a failed first descriptor observation
closes the fresh caller-owned duplicate. After a transfer attempt, all failures,
including explicit `connectError`, retain uncertainty and never numerically close
the duplicate while actual pinned-Bun descriptor/reuse proof remains pending.
There is no caller or test DTO that enables this disposal path. `open` first records adoption/socket,
including after prior loss; adopted sockets close through `terminate`, never a
saved descriptor number. These choices follow the pinned Bun source second opinion;
injected tests do not prove actual runtime FD behavior.

Outbound writes copy bytes into a FIFO capped at 16 including its active partial
write, and at 4100 total bytes each. Short/zero writes retain the suffix and wait
for `drain`; invalid counts/throws/reentrant closure reject every outstanding write.
W4 keeps each read registered through the last owner check before drain settlement,
so late owner loss rejects rather than hanging its promise. W5 limits each decoded
frame, allowing a larger coalesced callback without retaining its complete chunk.

## Reviewed native delta remains DATA

The exact corrected patch is preserved at `docs/research/guided-owner-envelope-DATA.patch`
and `/tmp/winter-linux-guided-owner-DATA.patch`.

- Patch SHA256: `22e69ddc41ba7ef2bbf2e00ab65bd5f0705af81983920c4bf0522ce99c7b51b1`.
- Reconstructed `/tmp/winter-linux-guided-owner-DATA.c` SHA256: `c149d451eaa79442dfd41e9375c891ae8c9a06135d2cfc85851bcc8b5ce51fd8`.
- Existing roles, in order: fd0 runtime namespace-init pidfd; fd1 Root service pidfd;
  fd2 store directory; fd3 immutable runtime executable. Guided adds fd4 reader
  channel; bootstrap transport socket remains separate.
- Guided-only peer identity requires SO_PEERPIDFD and PID_FS_MAGIC with same dev/ino
  as held service pidfd, distinct runtime pidfd, Root creator UID and repeated
  liveness checks. Ancestor PID0 is valid; missing features refuse.
- Native retains original fd4 and transfers one CLOEXEC dup. It never closes the
  transferred dup by number. Native shutdown is terminal owner loss, not normal
  read completion. Actual Root exclusive per-incarnation handoff remains required.
- Reviewer45 accepted the earlier delta conditionally. M1 is corrected: bootstrap
  authentication occurs only in owner_open, not later owner checks. L3 unused stat
  is removed. M2's persistent stream/no normal half-close is implemented and tested
  through inert socket effects. Root has the corrected hash for final delta review.
- Root's latest checkpoint instruction explicitly forbids applying C now. The
  tracked `linux-session-owner.c` is unchanged.

## Unfinished work after restart

1. Independently inspect this source diff before PR/review. Add a focused positive
   routing test through `dispatchGuidedParentControl` and the real RpcBridge/bridge;
   never mint a test native admission. Existing injected bridge/port tests are not
   positive native-guided engine proof.
2. Finish source/inert C-envelope matrix tests, final corrected C review and any
   authorized tracked source application. No native run is authorized by this file.
3. Implement Root's exclusive channel/registration delivery and framed reader
   service, binding actual runtime pidfd/incarnation, immutable views and native
   reap/drain evidence. Creator identity alone cannot establish eventual holder.
   *Source done in `guided-reader-service.md` (exclusive per-incarnation handoff, framed service,
   isolated reader launch, reap/drain/debt evidence); native admission and holder authentication remain owed.*
4. Finish host SDK scoped reader plumbing: current SDK query has no host-to-runtime
   instruction-read handle and its confined preparation refusal remains intact.
   The Root host adapter must use exact preparation/correlation and canonical Core
   ownership; no generic control/filesystem API.
5. Independently review and eventually validate the fixed direct-Bun FD adapter
   and the pinned source ownership assumptions. Inert close-order/failure/write
   tests are not actual Bun FD adoption/teardown proof.
6. Decide production generation expiry/replay policy. This source channel fails
   closed after 4096 consumed IDs per registration; it is not a production ledger.
7. Obtain exact Ubuntu24.04 base/libc DATA and kernel feature identity (separate
   requirements), fresh full multi-origin packet and execution admissions. Actual
   owner/channel/view/teardown/guided two-dispatch and revocation proof remain owed.

Mac two-disk/native-egress holds, no live Winter/home/Keychain, no consumer pins,
no SDK exports/releases and no activation remain binding.

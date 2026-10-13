# Admitted Linux SDK entry (source slice)

Historical entry behavior at `84dc16c9` is recorded below. The reviewed entry-only
backport `aa11dc0e` now shares graceful clean EOF with this supervisor slice; see
[`LINUX-HOST-QUERY-SUPERVISOR.md`](../guest-supervisor/LINUX-HOST-QUERY-SUPERVISOR.md).
Previously frozen artifacts are not relabeled as the corrected source.

Base: SDK main `79cdeb082eaa5cf57940d80541baf279529a2d8b`. This adds a reusable
SDK entry and a distinct fresh-store host-query profile. It does not launch a
supervisor, expose a stream port, resume a store, or claim real guest approvals.

`packages/runtime/src/guest/linux-session-entry.ts` exports
`runAdmittedLinuxSession({ admission, input, write, writeErr, signal,
onProtectedStoreOwnershipOutcome })`. Configuration, private provider/file ports
and store bootstrap derive only from the opaque native admission. There is no
caller argv, environment, settings, credential or replacement-tool option.
Input is pull-based NDJSON, with 256 KiB chunks and 1 MiB frames; output frames
use the same bound and split into bounded Unicode-safe chunks. Physical host-query
transport EOF lets the engine finish queued work and deny unanswerable approvals;
malformed input, transport errors and abandoned consumption cancel the run. Logical `end_input` leaves the permission
reply route open. Fresh fixture EOF semantics remain unchanged.

`admitHostQueryLinuxSession(bootstrapFd, ownerLibraryFd)` uses the existing
native peer/UID/pidfd/executable/store/boot proof and requires `profile:
"host-query-v1"` in the root-sent record, with `protocolVersion: 1` and
`freshOnly: true`. `admitFreshLinuxSession` rejects that discriminator and retains
its original fixed fixture policy. No pure validator, JSON or process-local fake
owner object can mint either admission. The native C helper is unchanged.

The host-query config is closed: visible tools are a unique subset of
Read/Write/Edit/Bash (Edit requires Read and Write), `allowedTools` is empty,
settings/skills/plugins/MCP are empty, and only default/acceptEdits/dontAsk/plan/
bypassPermissions are accepted. Bypass requires `allowDangerouslySkipPermissions: true` and
`permissions.disableBypassPermissionsMode: false`; other modes require the
opposite pair. Captured config remains fixed except bounded provider-derived
context sizing. Tool execution also checks the admitted subset. The record must
bind cwd exactly to a source root, admit at most 16 roots, exclude every
`/workspace/.winter` root, and mark every plan root read-only. These are narrow
first-slice restrictions: nested cwd and the full shared guidance/memory/scratch
layout are not yet admitted by this profile. Root metadata corroborates intent; the native supervisor must enforce
read-only mounts and current source authority independently.

The engine permits text, end_input/interrupt, and correlated *pending permission*
responses only. Attachments, slash commands, settings/config changes, delegation
and resume controls are refused. Foreign/duplicate/late replies are dropped.
Permission replies cannot install updatedPermissions. The engine derives a
permission-only outbound RpcBridge allowlist from the genuine native admission
profile, never from config/JSON/env. Unsupported credential/hook/MCP/other RPCs
reject immediately before IDs, signal listeners, timers, frames or pending entries
are created; they cannot park waiting for a reply this input route would drop.
Ordinary and fresh-fixture bridges retain their original unrestricted behavior.
Malformed confined input
uses the existing hard-stop path, cancelling pending approvals/in-flight work.
Closing the entry/native owner handle or returning a numeric code never proves
native teardown or releases the protected store hold.

The current supervisor producer and immutable fixture entry remain unchanged.
A later source slice must derive this profile from authenticated host authority,
produce the root-owned record, derive effective read-only plan roots matching
ToolService descriptors (not merely override the mount while retaining writable
root metadata), enforce those mounts, and implement bounded
live stdin/stdout relay. Production capability flags remain false. Actual native
owner/profile acceptance, live guest ask/plan/bypass callbacks, revocation and
native teardown need separately reviewed execution. No native/privileged/VM,
credentials, network or CI execution was performed for this source slice.

Original source validation (`952f1bbb`): Bun 1.3.14, 39 focused tests / 205 assertions
across the two new files,
existing linux-session-admission tests and RpcBridge tests; both repository
TypeScript configurations pass. The actual SDK query → testing inMemoryProcess →
runEngine → RpcBridge tests use a disposable local home and injected test executor,
never a forged native admission. They cover allow after end_input exactly once,
deny/throw without execution, interrupt cancelling a pending callback with a late
allow having no effect, denied plan write, and bypass without a callback.
Pure tests cover clamps/tool bounds, closed controls, real bridge correlation,
frame/chunk/truncation/Unicode bounds, and refusal before touching input/writes/
store callbacks. A Bun bundle of the reusable entry compiles but is not executed.

Focused commands:

```
bun test packages/runtime/src/guest/linux-host-query-profile.test.ts packages/runtime/src/guest/linux-host-query-engine.test.ts packages/runtime/src/guest/linux-session-admission.test.ts packages/runtime/src/rpc/bridge.test.ts
bun run typecheck
bun build --target=bun packages/runtime/src/guest/linux-session-entry.ts --outfile out/linux-host-query-entry-check/entry.mjs
```

Retained validation logs/bundle are in `out/linux-host-query-entry-check/`.
Temporary dependency links use the existing frozen local pnpm dependency store;
workspace imports resolve to this worktree, and the links are removed before
freeze. No package versions, release pins or frozen first-SDK artifacts change.


MED follow-up validation: 42 focused tests / 290 assertions, both repository
TypeScript checks, and an unexecuted entry bundle compile. Outbound RPC restriction
regression covers held/open bridges,
no option callbacks/listeners/timers/frames/pending entries, immediate rejection,
allowlist capture and still-working permission correlation. Config tests cover all
five modes and both clamp mismatch directions; the local actual SDK/engine tests
also prove acceptEdits ordinary-write allowance plus unmatched-Bash prompting, and
dontAsk unmatched-write denial plus normal-read allowance. The source cwd and
runtime home are separate disposable roots so the ordinary-write case does not
accidentally exercise the protected-path override. These remain local testing-leg
observations, not actual guest approval or native owner/mount acceptance.
Follow-up logs and the unexecuted bundle are retained separately in
`out/linux-host-query-entry-med-check/`.


## Reviewed clean-EOF backport

This entry-only correction is backported from reviewed stacked supervisor source
`89b6cad7320a2d34a2fb52040e9ecabfd4b83481`. The original `84dc16c9` entry explicitly
passed `cancelOnEOF = profile !== fresh`, so host-query EOF aborted. That history
remains recorded; the correction changes clean EOF to graceful completion. The
bounded helper now cancels only malformed/errors/abandoned consumption. Explicit
caller signals and genuine owner loss still hard-stop; pending permission RPCs
become unanswerable on physical EOF and are denied by the actual engine bridge.
Logical end_input continues to leave the transport open for replies.

The backport includes only reusable-entry code, its profile test, the new local
EOF test and this report. It includes no producer, supervisor, immutable host-query
main, pipe adapter or native source. Source authority/admission and capabilities
remain unchanged. Those dependent parts stay on their separate producer branch;
no implementation or artifact receipt is silently relabeled.

Current entry validation: 45 focused Bun tests / 306 assertions across five files;
both repository TypeScript checks pass; the reusable entry bundles without
execution. EOF tests use the actual SDK query/local engine/RpcBridge and real
SDK storage in disposable directories. They prove terminal-result → stdin EOF →
post-result completion, fragmented queued-user → EOF → code0/persisted transcript,
and pending permission → EOF → denied effect/code0/transcript. They never create
a native admission or prove real guest approvals/teardown. Logs and the unexecuted
bundle are retained separately under `out/linux-host-query-entry-eof-check/`.

Entry-only focused command:

```
bun test packages/runtime/src/guest/linux-host-query-eof.test.ts packages/runtime/src/guest/linux-host-query-profile.test.ts packages/runtime/src/guest/linux-host-query-engine.test.ts packages/runtime/src/guest/linux-session-admission.test.ts packages/runtime/src/rpc/bridge.test.ts
```

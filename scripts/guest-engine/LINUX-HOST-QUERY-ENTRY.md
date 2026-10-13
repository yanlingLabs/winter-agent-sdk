# Admitted Linux SDK entry (source slice)

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
transport EOF/errors cancel the run. Logical `end_input` leaves the permission
reply route open. Fresh fixture EOF semantics remain unchanged.

`admitHostQueryLinuxSession(bootstrapFd, ownerLibraryFd)` uses the existing
native peer/UID/pidfd/executable/store/boot proof and requires `profile:
"host-query-v1"` in the root-sent record, with `protocolVersion: 1` and
`freshOnly: true`. `admitFreshLinuxSession` rejects that discriminator and retains
its original fixed fixture policy. No pure validator, JSON or process-local fake
owner object can mint either admission. The native C helper is unchanged.

The host-query config is closed: visible tools are a unique subset of
Read/Write/Edit/Bash (Edit requires Read and Write), `allowedTools` is empty,
settings/skills/plugins/MCP are empty, and only default/plan/bypassPermissions
are accepted. Bypass requires `allowDangerouslySkipPermissions: true` and
`permissions.disableBypassPermissionsMode: false`; other modes require the
opposite pair. Captured config remains fixed except bounded provider-derived
context sizing. Tool execution also checks the admitted subset. The record must
bind cwd to a source root, exclude the protected store, and mark every plan root
read-only. Root metadata corroborates intent; the native supervisor must enforce
read-only mounts and current source authority independently.

The engine permits text, end_input/interrupt, and correlated *pending permission*
responses only. Attachments, slash commands, settings/config changes, delegation
and resume controls are refused. Foreign/duplicate/late replies are dropped.
Permission replies cannot install updatedPermissions. Malformed confined input
uses the existing hard-stop path, cancelling pending approvals/in-flight work.
Closing the entry/native owner handle or returning a numeric code never proves
native teardown or releases the protected store hold.

The current supervisor producer and immutable fixture entry remain unchanged.
A later source slice must derive this profile from authenticated host authority,
produce the root-owned record, enforce read-only plan roots, and implement bounded
live stdin/stdout relay. Production capability flags remain false. Actual native
owner/profile acceptance, live guest ask/plan/bypass callbacks, revocation and
native teardown need separately reviewed execution. No native/privileged/VM,
credentials, network or CI execution was performed for this source slice.

Validation: Bun 1.3.14, 39 focused tests / 205 assertions across the two new files,
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

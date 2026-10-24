# Guest plan view (contract revision 3, 12.5)

`/workspace/plan/<logicalSessionId>/<epoch>` is the conversation's own planning scratch. It lies outside `.winter`, on the guest data disk. The host names it in the
conversation set; PID 1 makes the directory (root-side, no symlink, idempotent). This change is the SDK and guest half that admits and mounts it.

## What is admitted

| Rule | Where it is enforced |
|---|---|
| Host-query and guided host-query conversations only; the fresh profile never | supervisor admission loop (`plan_view`) |
| Policy `plan` only; every other policy refuses | supervisor admission loop; profile check (`permissionMode`) |
| The conversation's own id, exactly `/workspace/plan/<id>/<epoch>`, epoch a canonical decimal of at most nine digits, nothing deeper | `PLAN_VIEW` in the supervisor; `LINUX_PLAN_VIEW` in the profile |
| Writable (a read-only plan view refuses); at most one per conversation | supervisor admission loop; profile check |
| An epoch below one that already exists beside it is stale and is never mounted | `plan_view_stale`: the supervisor lists `/workspace/plan/<id>` (opened without following a symlink) and refuses any canonical sibling above the requested epoch; an unreadable or missing parent refuses |

The guest does not take the epoch from `policyRevision`: the host's epoch is a separate counter, so the data disk is the record of which epochs were ever made.

## What the plan view can do

- The file worker may write it (`Write`, `Edit`): the tool launcher receives root flag `2` for it, which is valid only for policy `plan` and the file worker (`_exit(64)` otherwise) and mounts that one root writable.
- The process worker never writes it: flag `0` under plan mounts every root read-only, as before.
- The runtime launcher still mounts every root read-only under plan; the runtime writes only through the tool service.
- Every other root is read-only under plan, as before. `file_write_denied` refuses a write-class file operation on a read-only root, and under plan on every root but the plan view.
- The runtime's root metadata reports the plan view as writable under plan and every other root as read-only; the profile check in `linux-host-query-profile.ts` corroborates the shape (not the mount).

## Not done here

- Creating the directory (PID 1, a native-side change).
- The host's `planViewMounted` stays false until the native owner sends the epoch.
- No native process starts in the unit tests; the Linux CI fixture (`scripts/guest-supervisor/verify.py`) has no plan-view case yet.

The supervisor and tool-launcher change is recorded as `docs/research/guest-plan-view-DATA.patch` (the sixth delta in the `test_guided_guidance_view.py` chain).

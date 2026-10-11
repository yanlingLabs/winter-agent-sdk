# Confined guest file-tool slice

The actual Read, Write and Edit executors dispatch confined contexts through a
protected `GuestFileSession` object and `GuestFileHelperPort`. Registry callers
must provide both `executionPosture: "confined-guest"` and a session created by
`createGuestFileSession`; an object copied from JSON is rejected. Direct calls to
these executors additionally require `bindGuestFileSession`. A posture string
alone never selects local filesystem execution. Ordinary local contexts retain
their existing executors and read state.

The port is supplied by the protected guest supervisor. It must authenticate the
current workspace/session/incarnation and all authority revisions, verify the
immutable worker artifact and admitted roots, and execute the C worker in the
same confined tool UID/mount/PID view as Bash. The TypeScript object checks do
not establish these OS properties. No production port or supervisor is supplied
by this slice.

## Implemented routes

| Surface | Confined behavior |
| --- | --- |
| Read | Bounded UTF-8 text through rooted worker read; normal line windowing, continuation and completeness rules |
| Write | Bounded UTF-8 content; existing-file read ladder; absent-file creation uses O_EXCL; parent directories must already exist |
| Edit | Literal single/replace-all edits; complete-read requirement and permitted unique-match drift rescue |
| Read state | Session-scoped lexical paths plus descriptor device/inode alias identity; no runtime filesystem canonicalization |
| File freshness | Descriptor device/inode/size/mtime/ctime version; same-mtime replacement cannot pass as fresh |

Reads compare descriptor metadata before/after materialization. Conditional
writes reopen through `openat2` and compare the expected version on that opened
regular file before truncating it. Missing files use an absence condition. The
worker returns a new descriptor snapshot after a confirmed write. Lost or invalid
write acknowledgments retain uncertainty and are never automatically replayed.

These checks do not make shared workspace edits transactional. Another process
can modify an admitted file after the pre-write check; normal shared-filesystem
behavior applies. No file locks, Git locks or conversation locks are added.
In-root links remain allowed by rooted resolution; out-of-root/absolute/magic
links fail. The supervisor's mounts and policy remain the authority boundary.
Guest diff computation is capped at one million line pairs and 8,192 lines; larger changes
return an explicit `diffTruncated` result instead of an unbounded LCS allocation.

## Explicitly unsupported

Confined registry execution supports only Read, Write and Edit in this slice.
Every other tool, including custom/fallback tools, returns
`guest_tool_unsupported` before entering its executor. This includes Glob, Grep,
NotebookEdit, shell/Monitor/Workflow, worktrees, tasks/cron, skills, MCP resources,
LSP and host diagnostics. Direct Glob/Grep/NotebookEdit/Bash/Workflow/TaskOutput
and dynamic MCP consumers also have explicit posture guards.

Image/PDF/notebook reads and the `pages` option return
`guest_file_type_unsupported` before helper access. MCP image preparation and
runtime image conversion refuse confined contexts. New files with missing parent
directories return `guest_parent_creation_unsupported`; the runtime never runs
mkdir on their behalf. Existing oversized files refuse through the worker's byte
bound. Notebook text authored wholly through Write is ordinary UTF-8 file data;
structural notebook/image rendering is not implemented.

Permission evaluation, settings/instruction discovery, stores, hooks, bootstrap,
MCP connection setup and LSP lifecycle are not made guest-safe by these routes.
`assertRuntimeExecutionPosture`, direct engine entry and embedded entry continue
to reject confined execution before those consumers initialize. The negotiated
runtime still reports `supportsConfinedGuestExecution: false`. A production
runtime may not enable that flag until every prerequisite is independently wired
and verified.

## Verification

SDK fake-port tests exercise actual registry/direct executors, with runtime
read-state, permission-probe and temp-directory consumers set to throw if used.
Normal host tool suites run beside them. The Linux fixture is extended to test
conditional write success, stale snapshot refusal with unchanged bytes,
absence-conditioned creation/collision, and plan denial.

On an isolated Linux CI runner with existing compiler:

```sh
sudo -n python3 scripts/guest-files/verify.py
```

That fixture uses private namespaces, non-root tool UIDs, read-only/source binds,
zero capabilities, no-new-privileges and seccomp. It is not a VM or a production
supervisor. The macOS SDK test pass does not prove the changed C worker until the
Linux fixture passes on the exact reviewed commit.

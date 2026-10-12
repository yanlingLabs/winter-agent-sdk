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
not establish these OS properties. A reusable Linux service/client now connects these ports for the bounded
Read/Write/Edit/foreground Bash slice; see `scripts/guest-supervisor/README.md`.
Its exact Linux CI fixture and immutable-image/bootstrap integration still require
acceptance, and full engine/embedded startup remains refused.

## Implemented routes

| Surface | Confined behavior |
| --- | --- |
| Read | Bounded UTF-8 text through rooted worker read; normal line windowing, continuation and completeness rules |
| Write | Bounded UTF-8 content; existing-file read ladder; absent-file creation uses O_EXCL; parent directories must already exist |
| Edit | Literal single/replace-all edits; complete-read requirement and permitted unique-match drift rescue |
| Read state | Session-scoped lexical paths plus descriptor device/inode alias identity; no runtime filesystem canonicalization |
| File freshness | Descriptor device/inode/size/mtime/ctime version; same-mtime replacement cannot pass as fresh |
| Bash | Foreground command through an optional protected process port on the same file-session capability; admitted initial cwd and bounded separate streams |

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

Confined registry execution supports Read, Write, Edit and foreground Bash in this slice.
Every other tool, including custom/fallback tools, returns
`guest_tool_unsupported` before entering its executor. This includes Glob, Grep,
NotebookEdit, Monitor/Workflow, worktrees, tasks/cron, skills, MCP resources,
LSP and host diagnostics. Direct Glob/Grep/NotebookEdit/Bash/Workflow/TaskOutput
and dynamic MCP consumers also have explicit posture guards.

Image/PDF/notebook reads and the `pages` option return
`guest_file_type_unsupported` before helper access. MCP image preparation and
runtime image conversion refuse confined contexts. New files with missing parent
directories return `guest_parent_creation_unsupported`; the runtime never runs
mkdir on their behalf. Existing oversized files refuse through the worker's byte
bound. Notebook text authored wholly through Write is ordinary UTF-8 file data;
structural notebook/image rendering is not implemented.

## Foreground process slice

`createGuestFileSession` accepts an optional protected `GuestProcessPort`. Bash
uses that same session object, authority, admitted roots and non-root UID. A
missing process port refuses before the local executor; copied capabilities,
background execution and `dangerouslyDisableSandbox` also refuse. Session cwd is
the initial cwd only. Every confirmed result explicitly states that cwd changes
apply to this command only. Protected cwd carry, background task/TaskStop/TaskOutput
lifecycle and durable overflow files remain unimplemented. This is not complete
Code-equivalent Bash behavior.

`process-worker.c` resolves the initial cwd with descriptor-rooted `openat2`
before forking the shell. It requires PID 1, no-new-privileges, seccomp and empty
capability sets/bounding/ambient sets under the expected non-root tool UID. It
clears inherited descriptors, forks immutable `/bin/bash --noprofile --norc`,
provides a fixed environment without runtime credentials or shell startup hooks,
and bounds combined stdout/stderr. Bash receives the admitted source mounts and
private scratch. Timeout, output overflow and normal shell completion kill all
descendants in that invocation's private PID namespace and reap them, including
children that create new process groups or sessions. Supervisor cancellation must
destroy that namespace and await cleanup before settling its port call.
The protected outer supervisor must independently bound command-stdin delivery
and kill/drain/reap waits. A guest task stuck in uninterruptible kernel I/O can
delay SIGKILL and reaping beyond the command timer. This worker alone cannot
promise bounded cleanup; unresolved cleanup must remain uncertain and cannot
produce a confirmed success. Unexpected pipe/poll failures return a post-launch
uncertain failure instead of treating lost output as clean EOF.

The protected supervisor must validate current authority revisions and artifact,
UID, root and mount identities before launch, and destroy affected running
invocations when grants or policy are revoked. Receipts and TypeScript object
identity are not OS enforcement. The fixture constructs equivalent admitted
file/process mount and UID views per invocation, with a separate private PID
namespace for owned process cleanup. The new Linux supervisor/client implements these port calls with private socket UID authentication, immutable helper descriptors and independently bounded outer cleanup; source acceptance and the exact Linux CI run remain pending.

Responses bind the request UUID and every authority revision. Missing, stale,
malformed or oversized post-admission responses report uncertain effects and
never replay a command. Only typed known pre-launch worker/authority denials
report a certain refusal. Successful receipts preserve actual shell exit status
and distinguish normal exit, timeout and output overflow. Inline text is capped
without touching the protected runtime's output directories.

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
The same Linux fixture also compiles the process worker and exercises real Bash
cwd/streams/write effects, absent protected-runtime/proc/env surfaces, plan and
read-only mount denial, cwd symlink escapes, nonzero exit, combined output bound,
and descendant destruction on timeout, normal exit and external cancellation.
Compile-time fixture-only read/poll fault variants verify that unexpected native
I/O errors never emit a successful receipt. They are not production artifacts
and are never selectable through command input or environment.

On an isolated Linux CI runner with existing compiler:

```sh
sudo -n python3 scripts/guest-files/verify.py
```

That fixture uses private namespaces, non-root tool UIDs, read-only/source binds,
zero capabilities, no-new-privileges and seccomp. It is not a VM or a production
supervisor. The macOS SDK test pass does not prove the changed C worker until the
Linux fixture passes on the exact reviewed commit.

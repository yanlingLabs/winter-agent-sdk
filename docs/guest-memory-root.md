# Guest memory root and /etc/gitconfig (SH6b)

## The memory share as a tool root

`/workspace/.winter/memory` is the host-backed Project (or workspace) memory share, a read-write virtio-fs share (contract revision 3, design 2.3). Before this change both
host-query root checks refused every path under `/workspace/.winter`. Now they admit exactly that one path, together:

| Rule | Where |
|---|---|
| The exact path only: not the parent, a child, a sibling or a case variant | `host_query_protected` (supervisor `host_query_config`); `LINUX_MEMORY_ROOT` in `assertLinuxHostQueryRoots` (guided conversations take the same checks) |
| Read-write like any other root, except under plan, where it is read-only and a writable one is refused | the existing plan clamp (`runtime_root_metadata`, `file_write_denied`, the profile's plan rule) |
| Never the conversation's working directory; a conversation with only the memory share is refused | supervisor `cwd` is the first non-memory root; profile `config.cwd` check |
| Never a browse root: the guest file channel refuses it by path (`file_binding`), on top of the root-device and ownership checks a share cannot pass | supervisor `file_binding` |
| Mounted noexec, like every tool root | tool launcher `clone_descriptor` |

The admission loop already listed the path as an admitted tool root; only the host-query checks refused it.

## /etc/gitconfig, read-only

Git in the process worker's view needs the system configuration, or a clone into a read-write folder fails. The tool launcher mounts exactly one file of the environment's `/etc`:
the environment disk's `etc/gitconfig`, at `/etc/gitconfig`, read-only, nosuid, nodev, noexec. It is opened without following a symlink at either component and must be a regular,
single-link, root-owned file nobody else can write, at most 64 KiB; a file that fails that refuses the launch. A missing file is skipped. Only the process worker is given it (the
file worker, the runtime launcher and browse never are), and after the root change the launcher proves the mount sealed. Nothing else of `/etc` exists in the view.

Not done here: the environment image carrying `etc/gitconfig` (with an empty `init.templateDir`) is the guest image's work, and the Linux native tests do not yet run a case that clones with it.

The supervisor and tool-launcher change is `docs/research/guest-memory-gitconfig-DATA.patch` (the seventh delta in the `test_guided_guidance_view.py` chain). Image pins that move: `linux-supervisor.py` and `linux-tool-compartment.c`.

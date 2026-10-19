# Guest file channel service (FC4): Root's file service and the browse compartment

**Date:** 2026-10-19 · **Status:** source and tests only; reachable only when Root's init passes the file channel FIFOs, which no init does yet · **Design:** winter `docs/research/2026-10-18-n2-extensions-design.md` §4b.3 (FC4), owner ruling O14 (zero-capability browser)

Mac readers can't see guest-only files today: repositories cloned into the VM, conversation scratch, and anything else on `data.ext4`. winter's host side already exists: the grammar in `packages/core/src/cowork/guest-file-channel.ts` (merged), and the port and transport note in winter PR #91. This slice is the guest end: the service that answers `stat`, `read` and `readRange` on the FILE_IN/FILE_OUT streams. Its reads run in a confined, read-only compartment with no capability.

## 1. What runs where

| Piece | File | Role |
| --- | --- | --- |
| File service | `linux-supervisor.py` (one new block, `GuestFileService`) | Reads request lines from the FILE_IN FIFO and writes response lines to the FILE_OUT FIFO. |
| Browse launcher | `linux-tool-compartment.c`, `browse` mode | Mounts one root read-only and runs as the browse uid in the workspace group, with no capability, `no_new_privs` and the shared seccomp filter. |
| Browse worker | `file-worker.c`, `stat` and `browse-read` | Walks the path, checks the opened object, seals itself, then reads. |

How the pieces connect:

- Root's init (FC3, winter) owns the virtio port and the relay, and creates the two FIFOs.
- It passes them as `--file-channel-fds IN,OUT`, appended after every other supervisor argument.
- It puts `fileChannel: {browseUid, dataDevice}` in the trusted config.
  - `browseUid` is the per-workspace browse uid.
  - `dataDevice` is the `st_dev` of init's own `/workspace` mount.
- The supervisor accepts the FIFOs only together with that config key; otherwise it exits 64.
- It starts the service after its ready line.
- With neither the argument nor the key, nothing changes. No init sends either one yet.

## 2. The request path

1. **Parse.** A strict Python port of `parseCoworkGuestFileRequest`: the same closed key tables, bounds, id, UUID v4 and digest grammars, and path rules.
   - The re-serialization compare is exact: `JSON.stringify` spelling, which refuses duplicate keys, whitespace, alternate escapes and non-integer numbers.
   - A drift test runs every case through winter's own parser under bun, using a hash-pinned verbatim copy. It also compares the literal tables and the regular expressions, and feeds every line the service writes to winter's response parser.
2. **Malformed lines.**
   - A refused line that still has a UUID v4 `requestId` and a known `op` answers `invalid_request`.
   - Anything more broken ends the channel: not one JSON object, no `requestId`, or over 16 KiB.
3. **Binding.** The request is checked against the delivered conversations.

   | Condition | Answer |
   | --- | --- |
   | `workspaceId` + `sessionId` must match a conversation's `authority` (the backend session id, not the logical id); no match | `file_unavailable` |
   | That conversation is revoked | `file_unavailable` |
   | Another `incarnationId` | `stale_file` |
   | `locationId` is not exactly one of that conversation's root ids | `file_unavailable` |

   `sourceRevision` is echoed and never checked.
4. **Root check.** Root checks the held root descriptor. It must be:
   - a directory on `dataDevice`;
   - owned by `root:workspaceGid`;
   - exactly mode `2770`.

   Anything else, a share root included, is `file_unavailable` and never reaches the compartment.
5. **Launch.** Inside the browse compartment the worker does the following:
   - `openat2` of the root path, with no `RESOLVE_NO_XDEV` (the root is itself a mount point).
   - The root-device check: `fstatfs` reports ext4, and `st_dev` equals the admitted descriptor's device, which the launcher reports from the held descriptor.
   - `openat2(root, relative)` with `O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_NOCTTY` and `RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS|NO_XDEV`.
   - `fstat`: the object must be `S_ISREG`, have `nlink == 1` and sit on the root's device.
   - The **seal**, a second seccomp filter stacked on the shared one. From here on there is no open, no exec, no file or metadata change and no socket, and `write`/`writev` are allowed only on stdout. It also denies `pidfd_getfd`, `pidfd_open`, `memfd_create`, `userfaultfd`, the `keyctl` family (`keyctl`, `add_key`, `request_key`) and `process_madvise`, so an open file buys no descriptor from another process, no anonymous memory file and no kernel keyring. It is a denylist on top of the shared filter, not an allowlist.
   - `pread` of `min(maxBytes, size - offset)`, then `fstat` again.
   - It prints the raw identity before and after (`dev, ino, size, mtime ns, ctime ns, mode, nlink, uid`) and the bytes. It never prints a path.
6. **Answer.** Root turns the worker's result into one canonical line.
   - **Generation:** `sha256("v1|incarnationId|dev|ino|size|mtime_ns|ctime_ns|mode|nlink|uid")`.
   - **Order of judgment for reads:**
     1. A short or long read is `file_incomplete`.
     2. A mismatch with the caller's `expectedGeneration` is `stale_file`.
     3. A changed generation after the read is `stale_file`.
   - The bytes are discarded on every refusal.

**Kernel dependency (ext4 fine-grained ctime).** The generation includes `ctime_ns`. It detects two changes made close together only when ext4 gives each its own ctime, which needs the multigrain (fine-grained) timestamps of kernel 6.13 or newer. On an older kernel the ctime is coarse (one timer tick), so a second change inside the same tick can leave the generation unchanged. The guest image's kernel must therefore be 6.13 or newer for this claim. The `open_by_handle_at` mutant test needs kernel 6.10 or newer and asserts it.

Error codes are only the channel's six:

| Worker or Root condition | Code |
| --- | --- |
| `ENOENT`/`ENOTDIR` on a component | `file_missing` |
| An offset past the end; a malformed but echoable line | `invalid_request` |
| Symlink (`ELOOP`), escape or mount crossing (`EXDEV`), `EACCES`, not a regular file, a hard link, another device, a share root, an unknown location, an undelivered or revoked conversation, the compartment unavailable, any unexpected worker output | `file_unavailable` |
| Another incarnation, generation mismatch, changed during the read | `stale_file` |
| The file shrank under the read | `file_incomplete` |
| A response line over 384 KiB (unreachable; kept as a guard) | `response_too_large` |

## 3. Flow control, drain and faults

- **Outstanding requests.** At most four are unanswered. FILE_IN is not read while four are.
- **Writing.** One writer thread writes each line whole, in pieces of at most 256 KiB, so lines never interleave.
- **One owner per end.** Each FIFO end has exactly one owner thread, which alone uses it and alone closes it. A descriptor number is never reused under the thread that holds it.
- **FILE_IN's end is the drain.**
  - Queued work is dropped and running launches are cancelled.
  - The line being written finishes, and nothing more is written.
  - FILE_OUT then closes; that close is what the relay frames as the stream's end.
- **Faults end the channel the same way.** The faults are:
  - an unechoable line;
  - a line over 16 KiB;
  - a FIFO whose identity changed;
  - a write that fails, or stalls for 3 s;
  - a browse child whose reap is unproven, or a launch that raised.

  The last of these is **retained debt**: the child is kept, `stop()` returns False, and `ToolService.close()` refuses release.
- **Reads observe the end.** The non-blocking read itself observes FILE_IN's end; `poll` is only a bounded wait. On Linux `poll` reports the hang-up, but macOS does not report a FIFO writer's close, and the portable tests run there.

## 4. Where this differs from the design text

| Design | Built | Why |
| --- | --- | --- |
| "The file worker gains `stat` and `browse-read`; the existing compartment launcher gains a `browse` mode" | As written, in the same two tracked files. | Both are already pinned artifacts of every image, so no new artifact or staging entry is needed. Only their source hashes move. |
| The worker computes `generation` | The worker reports the raw identity; Root computes the hash. | No SHA-256 in C. The token is the same bytes. |
| "A read compares `expectedGeneration` first, then `pread`" | Root compares after the worker returns, discarding the bytes. | The worker doesn't know the incarnation. The observable answer is the same, and no byte leaves on a mismatch. |
| "A private mount view of only that conversation's admitted roots" | Only the ONE requested root. | Least privilege. The launcher refuses `roots != 1`. |
| `RESOLVE_NO_XDEV` refuses a mount crossing below the root | Still in the worker. In the launched view the root is cloned without its submounts, so a crossing shows as the bare mount point (`file_missing`). | The native tests prove the `EXDEV` refusal by running the worker alone on the host tree (a test harness). |
| A share root fails the worker's root-device check | It also fails earlier, at Root's check on the held descriptor (`st_dev != dataDevice`). | Two independent checks. |
| No write or exec syscalls | The tool compartment's shared filter, plus the worker's own stacked seal after the file is open. | The shared header is unchanged. |

## 5. Not enforceable in this repo (owned elsewhere)

- **Streams 4/5 on conversation 0 only, the direction rule, and the end flags.** These belong to the guest relay (FC3) and the contract (FC1). The supervisor never sees the mux.
- **Creating the setgid `root:workspaceGid` 2770 data-volume roots and `fs.protected_hardlinks=1`.** These are Root's init skeleton (FC3). This slice refuses a root that isn't 2770; it doesn't create one.
- **The set-level browse uid in the conversation set and its distinctness rule** (`native/protocol.ts:489-490`). This is the contract owner's (text v3). Here the uid must differ from every runtime, tool, group and reader id, or the supervisor refuses to start (`browse_identity_collision`).

## 6. Tests

`scripts/guest-supervisor/test_file_browse.py` has two parts.

**Portable** (macOS and Linux):
- the parser;
- the differential against winter's grammar, under bun;
- binding, root, config, worker-result and response rules;
- the FIFO checks;
- the service over real named FIFOs with an injected launch: the in-flight bound, drain, faults, write pieces and interleaving;
- the launcher with an injected process: receipts, retained debt, cancel, overrun, a launcher refusal;
- the `ToolService` hooks;
- the C sources' structure, and the worker's portable contract compiled with `cc`;
- the pin chain.

**`LinuxNativeTests`** (CI with sudo; required there):
- the real launcher and worker, run as root in private mount and PID namespaces on an ext4 temp tree;
- reads, ranges, the group-only identity, every walk refusal, a share root, and a mount below the root;
- the launcher's refusal of other browse envelopes;
- the compartment seen from inside by a probe;
- the seal, seen by a probe build of the worker;
- Root's service end to end over real FIFOs;
- built-in mutants: the shared header without its two handle-syscall denies, and the worker without its seal.

The pin chain gains `docs/research/guest-file-browse-DATA.patch`, the supervisor and tool-launcher change since the source-check patch. `test_guided_guidance_view.py` reverses it first.

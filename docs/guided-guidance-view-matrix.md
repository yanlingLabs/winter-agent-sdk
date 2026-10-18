# Guided guidance view and WINTER.md alias (compartment C): DATA patch and matrix

**Status: APPLIED.** The owner (2026-10-18) approved applying exactly the patch below
(`DATA patch SHA256` line) and nothing else. The tracked `linux-tool-compartment.c` and
`linux-supervisor.py` are now the pre-patch bytes plus that exact patch, and the tests run
against the tracked files (`test_tracked_sources_equal_main_plus_this_exact_patch` reverses the
patch to the pinned main bytes and re-applies it to reproduce the tracked bytes). The patch file
stays in `docs/research/` as the record of what was approved. Applying admits no native target,
builds no packet, publishes no release, changes no consumer pin in this repository, launches no
VM and enables nothing. The precedent is the owner envelope change in
`docs/guided-owner-c-matrix.md` (agent-sdk #25).

Applied bytes (SHA-256): `linux-tool-compartment.c`
`621f2ceb579c5b3832d4887f1d02dc8342a90e914bc44a3a6b204ce235b6d449`, `linux-supervisor.py`
`51259b0ff1651dfd05663b3796fe6a187120884fbf68f75977d05af454aa4359`.

The accepted-for-review delta is `docs/research/guided-guidance-view-DATA.patch`.

`DATA patch SHA256: 1dbdd4282d9213990b611fd88cc2be5e879928d38f208cdba67f95ac7224b063`

Pre-patch bytes (main `439b2f4d`): `linux-tool-compartment.c`
`799cd0b4c2ed713e1409fe87a037bb66575ee3a088fbbc1ea238581182fa33b7`, `linux-supervisor.py`
`2c5be1e8b2cf30956ae14f3ca02224db52aeb4387c2eac22ceceb49a875ceaa8`.

## What it does

`docs/guided-root-producer.md` says `/run/winter/shared-instructions` "is not mounted or
populated", and `docs/linux-isolated-instruction-reader-source.md` calls the tool-readable
alias "a separate native view/read-route obligation". For a **guided** session only, the patch
makes Root hand the **tool** launcher one extra descriptor and the launcher mount:

| Guest path | What | Flags |
| --- | --- | --- |
| `/run/winter/shared-instructions` | the dedicated guidance directory, cloned once and **not recursively** | `ro,nosuid,nodev,noexec` |
| `/workspace/.winter/WINTER.md` | the tool-readable alias: ONE regular file cloned from `WINTER.md` in that directory | `ro,nosuid,nodev,noexec` |

The enclosing `/workspace/.winter` is never mounted: it stays a plain directory of the
launcher's tmpfs skeleton that holds only the alias file (and any Root-admitted
`/workspace/.winter/memory` root, which was already allowed).

**Interface.** After the unchanged root triples, a guided launch appends exactly two
arguments: `--guidance <fd>`. The launcher accepts either the existing length
(`15 + 3*roots`) or that plus two. Every v1 and fresh launch is byte-for-byte what `main`
builds today. The guest paths are compile-time constants; no path is ever taken from argv.

**Root side (`linux-supervisor.py`).** A guided conversation entry may carry
`guidanceDirectory` (a Root-config path, accepted for the guided profile only).
After all conversations are admitted, the constructor opens it with the same no-symlink,
identity-checked walk as every source root and refuses it when it equals, contains or sits inside
any protected store, run home, control or artifact path, or any admitted tool root of any
conversation, by path in either direction and by inode. `_run` then appends the trailer and the
descriptor to the launcher arguments and `pass_fds` for that conversation only.

## Does `linux-compartment.h` change? No.

The patch touched exactly two files and removes exactly two existing lines. The shared header
is **unchanged** (the patch's new helpers live in `linux-tool-compartment.c`; the only new system
headers, `sys/statvfs.h` and `sys/vfs.h`, are included there). Therefore:

* `linux-instruction-reader-compartment.c` and its launcher bytes are unchanged, so the
  runtime-sdk overlay pins at `53082a74` and the reader packet are **not** invalidated;
* `linux-runtime-compartment.c` (the runtime launcher), `linux-session-owner.c` and
  `linux-session-admission.ts` (a v1 compile input, `docs/guided-root-producer.md:60`) are
  untouched; `PatchIntegrityTests` pin their SHA-256 values.

**Pins that DO change on apply** (none is hard-coded in this repository, so none moved in this change; each is computed by the
packet builders from the sources): the `toolLauncher` native artifact built from
`linux-tool-compartment.c`, and the staged source of `linux-supervisor.py`, in the guest-engine,
guest-host-query and guest-utilities stage/build manifests; and any downstream
(runtime-sdk or Winter) pin that records either file's hash or either artifact's hash. The
reader-only packet, the owner library and the runtime launcher artifacts keep their hashes.
Any such pin must be re-recorded after apply; that is part of the "apply" approval below.

## Invariants and the test that pins each

Test names are in `scripts/guest-supervisor/test_guided_guidance_view.py`. "Native" rows run the
tracked launcher in real mount and PID namespaces (CI, root, Linux only); every other row runs on
any machine with `cc` and Python.

| Invariant | Enforced by | Pinned by |
| --- | --- | --- |
| Read-only, nosuid, nodev, noexec directory | `clone_descriptor(guidance,1,0)`; in-view `statvfs` flag check after chroot | `test_directory_is_cloned_non_recursively_and_sealed_readonly_noexec`, `test_attachment_precedes_the_readonly_skeleton_and_the_seal_check_follows_chroot`; native: EROFS on every write, flags `15`, exec of a file in the view fails EACCES, mountinfo options |
| Same flags for the alias file | `clone_descriptor(file,1,0)`; seal check on the alias | same two tests; native mountinfo row for the alias |
| No nested mount reaches the view | clone without the recursive flag | `..._non_recursively...` (source); native: a tmpfs is mounted under the guidance directory on the host side and must be ABSENT from the view (`ls_nested` is empty), plus no mountinfo row under the view |
| Alias is a file, never the enclosing `.winter` | fixed constant `GUIDANCE_ALIAS`; `guidance_file_point` creates a FILE mountpoint | `test_guest_paths_are_constants_never_argv` (the only `.winter` literal), native `ls /workspace/.winter` is exactly `WINTER.md` and no row mounts `/workspace/.winter` |
| Source roots are never widened to `.winter` | Root refuses a guidance directory that contains or sits inside any protected store, run home or admitted root; the C launcher refuses the guidance descriptor equal (number or inode) to any root, worker, control or environment descriptor | `test_guidance_that_would_widen_to_the_enclosing_winter_store_is_refused`, `test_guidance_inside_or_above_a_writable_root_is_refused`, `test_guidance_equal_to_a_root_is_refused_in_both_roles`, `test_the_same_inode_under_another_spelling_is_refused`, `test_guidance_equal_to_another_conversations_writable_root_is_refused`, `test_guidance_must_differ_from_every_other_descriptor_by_number_and_inode`, `test_every_other_held_descriptor_is_compared`; native `test_the_source_root_cannot_be_presented_as_guidance` |
| No descriptor leak | the Python side refuses without leaking; the C side closes the guidance and file descriptors and all trees are close-on-exec; `close_range(3, ~0)` precedes the exec | `test_a_dedicated_directory_is_admitted_as_a_held_directory_descriptor`, `test_files_missing_paths_and_malformed_values_are_refused`, `test_constructor_failure_releases_the_guidance_descriptor`, `test_no_descriptor_survives_to_exec`; native `leaked_fds 0` inside the tool |
| FIFO or character device named `WINTER.md` | `O_NONBLOCK\|O_NOCTTY` open, then the `S_ISREG` refusal | `test_alias_is_one_regular_unlinked_same_superblock_data_file` (source, includes `O_NOCTTY`); native `test_a_fifo_or_a_character_device_named_winter_md_is_refused_without_hanging` (exit 64, no hang). The absence of a controlling terminal is structural (`O_NOCTTY`), not observed: the launcher has exited by the time it could be read |
| No symlink route out | `openat(..., O_NOFOLLOW)` for `WINTER.md`; the view is chrooted so an in-directory symlink resolves only inside the tool's own view | `test_alias_is_one_regular_unlinked_same_superblock_data_file`; native symlink `WINTER.md` refuses (77), `symlink_out` resolves to ENOENT |
| No hardlink route | alias file must have `st_nlink == 1` | same source test; native hardlinked `WINTER.md` refuses (64) |
| No `..` route | constants only; `guidance_file_point` and `point` refuse `..`; chroot clamps | `..._constants_never_argv`, `..._mountpoint_is_a_file_with_tolerant_parents...`; native `dotdot_file` and `dotdot_etc` are ENOENT |
| Over-mounted `WINTER.md` is refused | alias must share the directory's superblock (`st_dev`) and be on an allowed filesystem | `..._same_superblock_data_file` (source only: an over-mount needs privileges the tests do not take) |
| Pseudo-filesystem refusal consistent with the reader | statfs magic must be ext4, tmpfs or the guest host-share type: the reader's `ext4`/`tmpfs`/`virtiofs` allowlist | `test_only_ext4_tmpfs_and_virtiofs_are_data_filesystems` (32 refused magics), `test_every_data_filesystem_equals_the_instruction_reader_allowlist`; native `test_pseudo_filesystems_are_refused_as_guidance` (`/proc`, `/sys`, a regular file) |
| Malformed trailer refused | `guidance_parse` accepts only `--guidance <canonical decimal fd 3..65535>` after the triples | `test_trailer_parse_accepts_only_the_exact_two_argument_shape`; native `test_a_malformed_trailer_is_refused` |
| v1 and fresh argument shapes unchanged | Root appends nothing without a guidance descriptor; the C length check only gains the two-argument option | `test_v1_and_fresh_arguments_are_byte_identical_to_main` (6 policies x 2 kinds, against the tracked pre-patch module), `test_a_literal_golden_for_the_v1_shape`, `test_guided_adds_exactly_the_trailer_and_the_descriptor`, `test_v1_and_fresh_constructor_results_are_unchanged`, `test_patch_removes_exactly_two_existing_lines_so_every_other_byte_is_unchanged`, `test_existing_code_between_the_patched_lines_is_unchanged`; native `test_without_a_trailer_the_view_is_exactly_what_v1_and_fresh_get` |
| Existing suites still pass once applied | none | `PostApplyRegressionTests` runs 11 existing guest-supervisor and guest-engine suites unchanged against the tracked (applied) sources (this found one real conflict, fixed: `test_tool_devices` forbids the substring `virtio` anywhere in the tool launcher). `test_guided_owner.py` is included again: its gcc `-Werror` compile problem was fixed in #32 |
| No guest network, NIC or vsock egress | the patch adds no socket, netlink, ioctl, vsock or namespace call; the launcher still unshares `CLONE_NEWNET`; the seccomp filter and the shared header are untouched | `test_the_patch_adds_no_network_nic_or_vsock_surface` |
| Header, reader, runtime launcher, owner and admission untouched | patch file list | `test_patch_touches_exactly_the_tool_launcher_and_the_root_service`, `test_shared_header_reader_runtime_and_admission_sources_never_change`, `test_patched_header_is_byte_identical_to_the_tracked_header` |
| Tracked sources are main plus exactly this patch | n/a | `test_tracked_sources_equal_main_plus_this_exact_patch` (pins both applied hashes and both pre-patch hashes) |
| Patch is the recorded one | n/a | `test_patch_hash_is_recorded_in_the_matrix` |

## What the owner approved ("apply", 2026-10-18)

Applying `guided-guidance-view-DATA.patch` (hash above) to `linux-tool-compartment.c` and
`linux-supervisor.py`, unchanged, on the tracked branch; accepting that the `toolLauncher`
artifact and the supervisor source hashes change and every pin recording them is re-recorded;
and accepting the open choices below as written. It is **not** approval to admit a native target,
serve the reader, run the guided path, change the host guard, build a packet or release.
`linux-compartment.h` and the reader and runtime launchers stay out of it.

## Open design choices for the reviewer and the owner

1. **Alias path.** `/workspace/.winter/WINTER.md` is my reading of "the canonical `.winter`
   alias": it sits in the reserved `.winter` namespace Root already refuses for admitted roots,
   so no host root can collide with it. If the model should be told another path, it is the
   one constant `GUIDANCE_ALIAS` (and the test that pins it).
2. **Tool compartment only.** The runtime launcher gets no view. The SDK reads guidance through
   the isolated reader and the reader service (S2), not from its own mount namespace. If the
   runtime also must read the directory, that is a second patch to a different launcher.
3. **`guidanceDirectory` is optional** (*made required by the reader service, `guided-reader-service.md`*). A guided conversation without it keeps today's behaviour
   (nothing mounted). Making it mandatory would change `test_guided_host_query.py` fixtures and is
   better done together with the reader service, which must refuse to serve a view that is not
   mounted. Recommended: require it in S2.
4. **No owner or mode requirement on the directory.** Root does not insist the directory be
   root-owned: on the guest it is a host share whose owner is not under the guest's control, and the
   read-only mount (not file permissions) is what stops a tool from editing it. The host side can
   still change the content; that is the shared-guidance design.
5. **`f_type` cannot tell devtmpfs from tmpfs.** `devtmpfs` reports the tmpfs magic, so the
   allowlist cannot refuse `/dev` by type. Root supplies a dedicated directory and refuses anything
   overlapping its protected paths; a Root that handed over `/dev` would be a Root bug.
6. **ext4 magic is shared by ext2 and ext3.** Harmless here; the reader's mountinfo allowlist is
   stricter by name and still applies to the reader.
7. **Missing `WINTER.md`** mounts the directory with no alias (the tool reads ENOENT). A guided
   session without guidance is a policy question for the reader service, not this mount.

## Later slices that depend on this

* **S2, the Root reader service**: serves the fifth-descriptor stream and launches the isolated
  reader; it should require `guidanceDirectory` and reuse the same descriptor Root now holds.
* **The 12-entry owner matrix run and the guided compile packet**: the packet must be built from
  the sources as applied; the tool launcher and supervisor hashes in it change, the reader and runtime
  launcher hashes do not.
* **The hosted guided run** needs the view mounted to see the registered `sharedPath`.

## Evidence

Run on macOS (Darwin, appleclang, Python 3.14): `python3 -I -S -B
scripts/guest-supervisor/test_guided_guidance_view.py`: 45 tests ran, 44 passed, 1 skipped (the native Linux-root class, 8 tests, skipped as a unit off Linux). Mutation runs set `WINTER_GUIDANCE_VIEW_SOURCES` to a directory of mutated copies of the two targets.
The native class is skipped off Linux/root; in the CI sudo step `WINTER_REQUIRE_NATIVE_GUIDANCE=1` makes a missing precondition (including a temporary directory on a non-allowlisted filesystem) FAIL instead of skip (`NativeGateTests`). It runs in ordinary PR CI (`ci.yml`, job
`guest-file-boundary`, two steps) on both architectures. No Linux, root, namespace, VM or
Docker run occurred locally. Mutation results (guards killed / total, survivors with reasons) are
in the pull request description; the runner is not committed.

# Linux process-tool device source slice

This source slice extends `packages/runtime/src/guest/linux-tool-compartment.c`.
It has portable extracted-helper tests and compile evidence. No Linux namespace,
native helper, guest executable or VM was executed for this slice. Production
tool compatibility and enforcement remain unverified.

## Implemented source behavior

Process tools get only five character devices: `/dev/null` (1:3), `/dev/zero`
(1:5), `/dev/full` (1:7), `/dev/random` (1:8), `/dev/urandom` (1:9). Before namespace
creation, each fixed pathname is opened once with readonly, nofollow, nonblocking
and close-on-exec flags. Its held descriptor must have the exact character-device
identity and readonly access mode. `open_tree(AT_EMPTY_PATH)` clones that
descriptor; subsequent pathname replacement cannot change the admitted object.
Missing, symlink, wrong-type or wrong-number devices fail admission.

Each node mount gets readonly, nosuid and noexec attributes, with nodev cleared on
that node alone. Readonly mounts do not generally prohibit character-device
writes: null must accept/discard writes and full must report ENOSPC. Linux's
[permission implementation](https://github.com/torvalds/linux/blob/v6.18/fs/namei.c#L512-L520)
distinguishes regular files, directories and symlinks from special files for
readonly filesystem write checks. The exact mounted behavior remains a native
validation requirement. In particular, this is not a generic device-write fence.

The child mounts a new readonly/nosuid/nodev/noexec procfs after entering the
already private PID namespace. `/dev/fd`, stdin, stdout and stderr are fixed
symlinks into `/proc/self/fd`. The [Linux PID namespace manual](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)
documents that a procfs mount shows processes visible to the mounting process's
PID namespace. Ancestor runtime/supervisor processes are outside this process
view. This is ordinary private procfs, including readonly kernel information;
it does not use `subset=pid` or promise to hide all guest-wide statistics.

`/dev/shm` is a private tmpfs capped at 8 MiB, mode 1777, nosuid/nodev/noexec. The
surrounding skeleton becomes readonly after its mounts and symlinks are created.
File-only tools get no new devices, procfs or shared memory. Admitted roots and
environment mounts keep their existing nodev rules; scratch and source mounts
keep existing noexec rules. Capabilities, seccomp, parent-death checks, native
wait receipt, inherited-FD closure and source/storage fences are unchanged.

Tools are pipe-only. There is no `/dev/tty`, ptmx, pts or devpts mount; opening
`/dev/tty` fails because the node is absent. This slice does not provide a PTY,
terminal dimensions, terminal input or a controlling terminal. No block devices,
kmsg, mem, port, vsock, virtio-ports or whole guest `/dev` tree are admitted.
Each held device descriptor closes after its detached mount clone, and all
private inherited descriptors close before exec. The launcher adds no fixed FD
remaps. The process worker consumes the supervisor-owned command pipe before
forking, then gives only the shell child EOF stdin from the admitted `/dev/null`.
The tool UID opens the node once with readonly/nofollow/nonblocking/close-on-exec
flags and checks its held descriptor is character 1:3 with readonly access before
remapping it to fd0. It explicitly clears close-on-exec even when open returns
fd0, and preserves that alias. This avoids retaining a root-owned pipe whose
permissions could prevent reopening `/dev/stdin`. No interactive input or PTY is
added; command ingestion, output pipes, parent checks and wait/cleanup remain
unchanged.

## Local evidence

Run from the SDK repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts/guest-engine/test_shell_stdin.py scripts/guest-engine/test_tool_devices.py scripts/guest-engine/test_runtime_entropy.py scripts/guest-engine/test_parent_remap.py -v
```

Eight unittest methods pass. Device/view helpers cover 94 portable cases: all five exact
inventory entries against thirteen refusal/failure modes and success, plus held
FD positions 3, 4, 64 and 97; the exact view's successful inventory/flags/links
and three construction failures. Existing entropy and parent-remap tests add
20 executable stand-in cases. These execute portable C harnesses with substituted
metadata and syscall/filesystem functions, never actual Linux confinement. The
shell-stdin follow-up adds 36 portable cases using ordinary pipes with injected
device metadata: existing live command fd0, fd0 alias and close-on-exec behavior,
wrong regular/block/major/minor identities, non-readonly or invalid access-mode
lookup, missing input, failed identity lookup, remap failure and close-on-exec
clearing failure at descriptor positions 3, 4 and 64. No real device is opened.

Zig 0.14.1 cross-compiles the complete tool launcher, runtime launcher, file
worker and process worker with `-target aarch64-linux-musl -std=c11 -O2 -Wall
-Wextra -Werror -static`. The unchanged owner library's musl build fails on
signedness inside bundled `CMSG_NXTHDR` at `linux-session-owner.c:95,135`; this
source slice does not alter that library. It passes a separate strict
`-target aarch64-linux-gnu -shared -fPIC` build with the same warning flags.
Thus all five native sources cross-compile, but the complete musl artifact set
does not pass strict compilation. Cross-compilation never establishes
enforcement or native utility availability.

## Pending disposable Linux smoke recipe (not executed)

An independent reviewer must admit the matching changed source/artifact closure
before later native execution. Rebuild all receipts: prior hashes cannot admit
this changed launcher. Keep the existing isolated system-Python staging entry,
real runtime/provider admission, root-owned immutable helpers and fixture-only
source/store/home boundaries. Do not run this recipe directly on the host or
from an unreviewed privileged checkout. It does not authorize either held Mac
two-disk or native egress lane.

The current minimal `scripts/guest-engine/verify.py` environment copies Bash,
sleep, cat and setsid; it does **not** establish Git, Python, OpenSSL or mktemp
availability. A later reviewed fixture must explicitly inventory and stage
those existing utilities, their dynamic libraries, Git support resources and
Python standard library into its immutable environment closure. Use fixture
identity and no real credentials, configuration, user home, network or push.
Missing utilities are a failed/incomplete prerequisite, never a passing device
smoke. Add the following as one bounded Bash tool request through the real SDK
and admitted supervisor, with its cwd the writable disposable source root.
Update the deterministic fixture provider and exact transcript/result validator
together; do not weaken the existing receipt or result assertions.

```bash
set -euo pipefail
python3 -c 'import os,stat; s=os.fstat(0); assert stat.S_ISCHR(s.st_mode) and (os.major(s.st_rdev),os.minor(s.st_rdev))==(1,3); assert os.read(0,1)==b""'
test -z "$(cat /dev/stdin)"
if IFS= read -r unexpected_input; then
    exit 1
fi
python3 - <<'PY'
import errno, os, stat
nodes = {'null':3, 'zero':5, 'full':7, 'random':8, 'urandom':9}
links = {'fd':'/proc/self/fd', 'stdin':'/proc/self/fd/0',
         'stdout':'/proc/self/fd/1', 'stderr':'/proc/self/fd/2'}
assert set(os.listdir('/dev')) == set(nodes) | set(links) | {'shm'}
for name, minor in nodes.items():
    info = os.stat('/dev/' + name, follow_symlinks=False)
    assert stat.S_ISCHR(info.st_mode)
    assert (os.major(info.st_rdev), os.minor(info.st_rdev)) == (1, minor)
for name, target in links.items():
    assert os.readlink('/dev/' + name) == target
assert os.readlink('/proc/self') == str(os.getpid())
assert not any(os.isatty(fd) for fd in (0, 1, 2))
mounts = {}
with open('/proc/self/mountinfo') as stream:
    for line in stream:
        head, tail = line.rstrip().split(' - ', 1)
        fields = head.split()
        mounts[fields[4]] = (set(fields[5].split(',')), tail.split()[0])
for name in nodes:
    flags, _ = mounts['/dev/' + name]
    assert {'ro','nosuid','noexec'} <= flags and 'nodev' not in flags
assert {'ro','nosuid','nodev','noexec'} <= mounts['/proc'][0]
assert mounts['/proc'][1] == 'proc'
assert {'rw','nosuid','nodev','noexec'} <= mounts['/dev/shm'][0]
assert mounts['/dev/shm'][1] == 'tmpfs'
assert stat.S_IMODE(os.stat('/dev/shm').st_mode) == 0o1777
fs = os.statvfs('/dev/shm')
assert fs.f_blocks * fs.f_frsize <= 8 * 1024 * 1024
with open('/dev/zero','rb',buffering=0) as stream:
    assert stream.read(4) == b'\0' * 4
with open('/dev/null','rb',buffering=0) as stream:
    assert stream.read(1) == b''
fd = os.open('/dev/full', os.O_WRONLY)
try:
    try:
        os.write(fd, b'x')
    except OSError as error:
        assert error.errno == errno.ENOSPC
    else:
        raise AssertionError('/dev/full accepted a write')
finally:
    os.close(fd)
assert len(os.urandom(32)) == 32
print('tool-device-inventory-ok')
PY
echo device-write >/dev/null
test "$(cat <(printf process-substitution-ok))" = process-substitution-ok
openssl rand -out /tmp/tool-device-random.bin 32
python3 - <<'PY'
import multiprocessing as mp, os
from multiprocessing import shared_memory
assert os.stat('/tmp/tool-device-random.bin').st_size == 32
def child(name, gate):
    view = shared_memory.SharedMemory(name=name)
    try:
        assert bytes(view.buf[:4]) == b'seed'
        view.buf[:4] = b'done'
        gate.release()
    finally:
        view.close()
if __name__ == '__main__':
    context = mp.get_context('fork')
    gate = context.Semaphore(0)
    view = shared_memory.SharedMemory(create=True, size=4096)
    try:
        view.buf[:4] = b'seed'
        process = context.Process(target=child, args=(view.name, gate))
        process.start()
        assert gate.acquire(timeout=5)
        process.join(timeout=5)
        if process.is_alive():
            process.terminate(); process.join(timeout=2)
        assert process.exitcode == 0 and bytes(view.buf[:4]) == b'done'
    finally:
        view.close(); view.unlink()
print('tool-entropy-multiprocessing-ok')
PY
fixture_repo=$(mktemp -d "$PWD/.winter-tool-device-smoke.XXXXXX")
mkdir "$fixture_repo/templates"
git -c init.templateDir="$fixture_repo/templates" init --initial-branch=fixture-tool-smoke "$fixture_repo/repo" >/dev/null
printf fixture-only >"$fixture_repo/repo/fixture.txt"
git -C "$fixture_repo/repo" add fixture.txt
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  git -C "$fixture_repo/repo" -c user.name=Fixture -c user.email=fixture@example.invalid \
  commit -m fixture-tool-device-smoke >/dev/null
test -n "$(git -C "$fixture_repo/repo" rev-parse HEAD)"
printf 'tool-device-smoke-ok\n'
```

Require the actual tool receipt to report worker success, shell exit zero and
normal termination, and bind the exact output to the persisted SDK transcript.
Inspect native mount inventory and utility identities independently. Preserve
file-helper denials for runtime/store/control paths, readonly source behavior,
plan-mode readonly sources, socket/network/namespace/seccomp denials, no inherited
runtime FDs, descriptor-collision regressions, cancellation and descendant
teardown with the immutable parent wait receipt. Confirm a second process-tool
invocation starts with empty private shm/tmp, and that file-only tools still
lack this device view. A native pass would establish only this reviewed disposable
Linux fixture, not VM integration, cold continuity, resource reclamation or
Cowork production readiness.

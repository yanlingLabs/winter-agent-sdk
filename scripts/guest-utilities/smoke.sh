#!/bin/bash
# Reviewed source payload only; submit through the admitted Linux process port.
set -euo pipefail
python3 -c 'import os; assert os.listdir("/tmp")==[] and os.listdir("/dev/shm")==[]'
python3 -c 'import errno,os,stat; s=os.fstat(0); assert stat.S_ISCHR(s.st_mode) and (os.major(s.st_rdev),os.minor(s.st_rdev))==(1,3); assert os.read(0,1)==b""; extra=[]
for name in os.listdir("/proc/self/fd"):
    if int(name)<3: continue
    try: os.readlink("/proc/self/fd/"+name)
    except FileNotFoundError: continue
    extra.append(name)
assert not extra
print("tool-device-stdin-fds-ok")'
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
assert {'rw','nosuid','nodev','noexec'} <= mounts['/workspace/folders/source'][0]
assert {'ro','nosuid','nodev','noexec'} <= mounts['/workspace/folders/readonly'][0]
workspace_group = 10000
assert os.getuid() == 10001 and os.getgid() == 10001
assert workspace_group in os.getgroups()
for name in ('/workspace/folders/source','/workspace/folders/readonly'):
    info = os.stat(name)
    assert info.st_uid == os.getuid() and info.st_gid == workspace_group
    assert stat.S_IMODE(info.st_mode) == 0o2770
with open('/workspace/folders/source/writable-control','w') as stream:
    stream.write('writable-source-positive')
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
for name in ('/run/winter', '/workspace/.winter/conversations', '/protected/runtime'):
    try:
        os.open(name, os.O_RDONLY)
    except OSError as error:
        assert error.errno in (errno.ENOENT, errno.EACCES, errno.ENOTDIR)
    else:
        raise AssertionError('trusted runtime/control/store path was exposed')
with open('/proc/1/status') as stream:
    status = dict(line.rstrip().split(':', 1) for line in stream if ':' in line)
assert status['PPid'].strip() == '0'
assert set(map(int, status['Uid'].split())) == {os.getuid()}
for name in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'):
    assert int(status[name].strip(), 16) == 0
assert status['NoNewPrivs'].strip() == '1' and status['Seccomp'].strip() == '2'
for pid in os.listdir('/proc'):
    if not pid.isdecimal():
        continue
    try:
        with open('/proc/' + pid + '/status') as stream:
            status = dict(line.rstrip().split(':', 1) for line in stream if ':' in line)
        assert set(map(int, status['Uid'].split())) == {os.getuid()}
        with open('/proc/' + pid + '/cmdline','rb') as stream:
            assert b'winter-runtime' not in stream.read(65536)
        for descriptor in os.listdir('/proc/' + pid + '/fd'):
            fd_path = '/proc/' + pid + '/fd/' + descriptor
            try:
                info = os.stat(fd_path)
            except FileNotFoundError:
                continue
            assert not stat.S_ISSOCK(info.st_mode), 'receipt/bootstrap socket leaked'
    except FileNotFoundError:
        continue
print('tool-device-boundaries-ok')
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
with open('/dev/shm/winter-utility-private-canary','wb') as stream:
    stream.write(b'private-first-view-marker')
PY
fixture_repo=$(mktemp -d "$PWD/.winter-tool-device-smoke.XXXXXX")
python3 -c 'import os,sys; os.mkdir(sys.argv[1])' "$fixture_repo/templates"
git -c init.templateDir="$fixture_repo/templates" init --initial-branch=fixture-tool-smoke "$fixture_repo/repo" >/dev/null
printf fixture-only >"$fixture_repo/repo/fixture.txt"
git -C "$fixture_repo/repo" add fixture.txt
GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
  git -C "$fixture_repo/repo" -c user.name=Fixture -c user.email=fixture@example.invalid \
  commit -m fixture-tool-device-smoke >/dev/null
test -n "$(git -C "$fixture_repo/repo" rev-parse HEAD)"
printf 'tool-device-smoke-ok\n'

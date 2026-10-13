# Fixed positive utility payload; appended after the unchanged Phase A prefix.
phase_b_fail() { printf 'phase-b-failed:%s\n' "$1"; exit 91; }
export HOME=/dev/shm/winter-daily-home TMPDIR=/dev/shm/winter-daily-home
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export PYTHONOPTIMIZE=0 PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 PYTHONHASHSEED=0
export PYTHONPATH=
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_AUTHOR_DATE='2000-01-01T00:00:00+0000' GIT_COMMITTER_DATE='2000-01-01T00:00:00+0000'
python3 - <<'PY'
import errno,json,multiprocessing as mp,os,stat
from multiprocessing import shared_memory
os.mkdir('/dev/shm/winter-daily-home',0o700)
assert os.listdir('/dev/shm/winter-daily-home')==[]
seed='/workspace/folders/source/seed'
seed_identity=os.stat(seed,follow_symlinks=False)
assert stat.S_ISREG(seed_identity.st_mode) and seed_identity.st_uid==10001 and stat.S_IMODE(seed_identity.st_mode)==0o660
assert open(seed,'rb').read(16)==b'hello\n'
assert open('/workspace/folders/readonly/marker','rb').read(64)==b'readonly utility marker\n'
canary='/workspace/folders/readonly/dac-canary'
observed=os.stat(canary,follow_symlinks=False)
assert stat.S_ISREG(observed.st_mode) and observed.st_uid==10001 and observed.st_gid==10000 and stat.S_IMODE(observed.st_mode)==0o660
assert open(canary,'rb').read(64)==b'DAC-positive\n'
for action in (lambda:os.open(canary,os.O_WRONLY|os.O_NOFOLLOW),lambda:os.chmod('/workspace/folders/readonly/dac-canary',0o600)):
    try: result=action()
    except OSError as error: assert error.errno==errno.EROFS
    else:
        if type(result) is int:os.close(result)
        raise AssertionError('readonly data root accepted mutation')
view=shared_memory.SharedMemory(create=True,size=4096)
def child(name):
    child_view=shared_memory.SharedMemory(name=name)
    try: child_view.buf[:4]=b'done'
    finally:child_view.close()
try:
    view.buf[:4]=b'seed';process=mp.get_context('fork').Process(target=child,args=(view.name,));process.start();process.join(timeout=2)
    if process.is_alive():process.terminate();process.join(timeout=1)
    assert process.exitcode==0 and bytes(view.buf[:4])==b'done'
finally:view.close();view.unlink()
assert json.loads(json.dumps({'fixed':'ok'}))=={'fixed':'ok'}
print('sdk-daily-python-ok')
PY
phase_code=$?; test "$phase_code" -eq 0 || phase_b_fail python
phase_cat=$(cat seed) || phase_b_fail cat
test "$phase_cat" = hello || phase_b_fail cat
printf 'sdk-daily-cat-ok\n'
phase_tmp=$(mktemp -d "$TMPDIR/work.XXXXXX") || phase_b_fail temp
[[ "$phase_tmp" =~ ^/dev/shm/winter-daily-home/work\.[[:alnum:]]{6}$ ]] || phase_b_fail temp
test -d "$phase_tmp" && test ! -L "$phase_tmp" || phase_b_fail temp
printf 'sdk-daily-temp-ok\n'
openssl rand -out "$phase_tmp/random.bin" 32 || phase_b_fail openssl
python3 -c 'import os,sys; assert os.stat(sys.argv[1]).st_size==32' "$phase_tmp/random.bin" || phase_b_fail openssl
printf 'sdk-daily-openssl-ok\n'
python3 -c 'import os,sys; os.mkdir(sys.argv[1])' "$phase_tmp/templates" || phase_b_fail git
git -c init.templateDir="$phase_tmp/templates" init --initial-branch=fixture-tool-smoke "$phase_tmp/repo" >/dev/null || phase_b_fail git
printf fixture-only > "$phase_tmp/repo/fixture.txt" || phase_b_fail git
git -C "$phase_tmp/repo" add fixture.txt || phase_b_fail git
git -C "$phase_tmp/repo" commit -m fixture-tool-device-smoke >/dev/null || phase_b_fail git
phase_commit=$(git -C "$phase_tmp/repo" rev-parse HEAD) || phase_b_fail git
test "$phase_commit" = a0efbdcdb3273daa7d3659f3e230c4c75e4dedbb || phase_b_fail git
phase_clean=$(git -C "$phase_tmp/repo" status --porcelain=v1) || phase_b_fail git
test -z "$phase_clean" || phase_b_fail git
printf 'sdk-daily-git-ok\n'
python3 -c 'import os,shutil; shutil.rmtree("/dev/shm/winter-daily-home"); assert not os.path.lexists("/dev/shm/winter-daily-home"); assert os.listdir("/dev/shm")==[]' || phase_b_fail cleanup
printf sdk-daily-tools-end

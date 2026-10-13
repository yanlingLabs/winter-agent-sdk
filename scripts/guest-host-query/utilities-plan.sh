# Fixed plan utility payload; no source or readonly-root mutation may succeed.
phase_b_fail() { printf 'phase-b-failed:%s\n' "$1"; exit 91; }
printf '\n' || phase_b_fail separator
export HOME=/dev/shm/winter-daily-home TMPDIR=/dev/shm/winter-daily-home
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export PYTHONOPTIMIZE=0 PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1 PYTHONHASHSEED=0
export PYTHONPATH=
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_AUTHOR_DATE='2000-01-01T00:00:00+0000' GIT_COMMITTER_DATE='2000-01-01T00:00:00+0000'
python3 - <<'PY'
if not __debug__: raise SystemExit(92)
import errno,json,os,stat
os.mkdir('/dev/shm/winter-daily-home',0o700)
seed='/workspace/folders/source/seed'
seed_identity=os.stat(seed,follow_symlinks=False)
assert stat.S_ISREG(seed_identity.st_mode) and seed_identity.st_uid==10001 and stat.S_IMODE(seed_identity.st_mode)==0o660
assert open(seed,'rb').read(16)==b'hello\n'
assert open('/workspace/folders/readonly/marker','rb').read(64)==b'readonly utility marker\n'
canary='/workspace/folders/readonly/dac-canary'
observed=os.stat(canary,follow_symlinks=False)
assert stat.S_ISREG(observed.st_mode) and observed.st_uid==10001 and observed.st_gid==10000 and stat.S_IMODE(observed.st_mode)==0o660
assert open(canary,'rb').read(64)==b'DAC-positive\n'
for path in ('/workspace/folders/source/seed','/workspace/folders/readonly/dac-canary'):
    for action in (lambda:os.open(path,os.O_WRONLY|os.O_NOFOLLOW),lambda:os.chmod(path,0o600)):
        try:result=action()
        except OSError as error:assert error.errno==errno.EROFS
        else:
            if type(result) is int:os.close(result)
            raise AssertionError('plan root accepted mutation')
assert json.loads(json.dumps({'fixed':'ok'}))=={'fixed':'ok'}
print('sdk-daily-python-ok')
PY
phase_code=$?; test "$phase_code" -eq 0 || phase_b_fail python
phase_cat=$(cat seed) || phase_b_fail cat
test "$phase_cat" = hello || phase_b_fail cat
printf 'sdk-daily-cat-ok\n'
# mktemp's RO form reports its bounded template without creating a source/data file.
phase_tmp=$(mktemp -u /dev/shm/winter-daily-home/read.XXXXXX) || phase_b_fail temp
[[ "$phase_tmp" =~ ^/dev/shm/winter-daily-home/read\.[[:alnum:]]{6}$ ]] || phase_b_fail temp
test ! -e "$phase_tmp" || phase_b_fail temp
printf 'sdk-daily-temp-ok\n'
phase_digest=$(openssl dgst -sha256 /workspace/folders/readonly/marker) || phase_b_fail openssl
test "$phase_digest" = "SHA2-256(/workspace/folders/readonly/marker)= 9a8e44040a8321d01b87a02f5a99bea9dca38469912037f4d64c2b1e81ca1ee6" || phase_b_fail openssl
printf 'sdk-daily-openssl-ok\n'
phase_commit=$(git -c safe.directory=/workspace/folders/readonly/repo --git-dir=/workspace/folders/readonly/repo rev-parse HEAD) || phase_b_fail git
test "$phase_commit" = a0efbdcdb3273daa7d3659f3e230c4c75e4dedbb || phase_b_fail git
phase_git=$(git -c safe.directory=/workspace/folders/readonly/repo --git-dir=/workspace/folders/readonly/repo show HEAD:fixture.txt) || phase_b_fail git
test "$phase_git" = fixture-only || phase_b_fail git
printf 'sdk-daily-git-ok\n'
python3 -c 'import os; os.rmdir("/dev/shm/winter-daily-home"); assert not os.path.lexists("/dev/shm/winter-daily-home"); assert os.listdir("/dev/shm")==[]' || phase_b_fail cleanup
printf sdk-daily-tools-end

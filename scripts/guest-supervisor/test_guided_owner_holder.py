"""Holder hygiene for the guided owner: a DATA patch, proven portably. Nothing here is applied or admitted.

`docs/research/2026-10-18-guided-owner-holder-DATA.patch` changes `linux-session-owner.c` (a v1 compile input,
pinned by the reviewed owner-matrix workflow). It is NOT applied: the tracked file stays at its pinned bytes and
this suite applies the patch to a scratch copy, extracts the new functions and runs them with `cc` on any host
(`/dev/fd` stands in for `/proc/self/fd`). The Linux-only compile checks run in CI where real headers exist and fail,
not skip, there (WINTER_REQUIRE_OWNER_HOLDER_COMPILE=1). WINTER_OWNER_HOLDER_SOURCES points at a directory holding a
mutated patched owner for mutation runs.
"""
import hashlib
import os
import re
import resource
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_guided_owner import function  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
GUEST = 'packages/runtime/src/guest'
OWNER = GUEST + '/linux-session-owner.c'
PATCH = ROOT / 'docs/research/2026-10-18-guided-owner-holder-DATA.patch'
FIXTURE_PATCH = ROOT / 'docs/research/2026-10-18-guided-owner-holder-fixture-DATA.patch'
DOC = ROOT / 'docs/guided-owner-holder.md'
OVERRIDE = os.environ.get('WINTER_OWNER_HOLDER_SOURCES')
REQUIRE_COMPILE = os.environ.get('WINTER_REQUIRE_OWNER_HOLDER_COMPILE') == '1'
TRACKED_OWNER_SHA256 = 'c149d451eaa79442dfd41e9375c891ae8c9a06135d2cfc85851bcc8b5ce51fd8'
PATCHED_OWNER_SHA256 = '95457d8f6ff256257b3b211e0201c64a4ed0b575aac6a9f933b3178b823b0d76'
FIXTURE_SHA256 = 'ef1a3e4554551a47e5857ec90618cb968be2e3a1a653817df5bcac5d269f2d39'
MATRIX_SHA256 = 'b9ea9804d57806f3ecfa765d65c2eb92c93ce1171b08cef72c3c81e8e5bbedbf'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


_scratch = {}


def scratch():
    """A scratch tree: the tracked owner, fixture and matrix with the DATA patches applied (or the mutated owner)."""
    if 'root' not in _scratch:
        directory = Path(tempfile.mkdtemp(prefix='winter-owner-holder-'))
        for name in (OWNER, 'scripts/guest-supervisor/guided_owner_native_fixture.c', 'scripts/guest-supervisor/test_guided_owner.py'):
            (directory / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, directory / name)
        applied = subprocess.run(['patch', '-p1', '-s', '-d', str(directory), '-i', str(PATCH)], capture_output=True, text=True, timeout=30)
        assert applied.returncode == 0, applied.stderr
        if FIXTURE_PATCH.exists():
            applied = subprocess.run(['patch', '-p1', '-s', '-d', str(directory), '-i', str(FIXTURE_PATCH)], capture_output=True, text=True, timeout=30)
            assert applied.returncode == 0, applied.stderr
        if OVERRIDE:
            shutil.copyfile(Path(OVERRIDE) / 'linux-session-owner.c', directory / OWNER)
        _scratch['root'] = directory
    return _scratch['root']


def patched():
    return (scratch() / OWNER).read_text()


class PatchIntegrityTests(unittest.TestCase):
    def setUp(self):
        if OVERRIDE:
            self.skipTest('mutation run: the recorded hashes belong to the real patched bytes')

    def test_the_tracked_owner_fixture_and_matrix_are_untouched(self):
        self.assertEqual(sha(ROOT / OWNER), TRACKED_OWNER_SHA256)
        self.assertEqual(sha(ROOT / 'scripts/guest-supervisor/guided_owner_native_fixture.c'), FIXTURE_SHA256)
        self.assertEqual(sha(ROOT / 'scripts/guest-supervisor/test_guided_owner.py'), MATRIX_SHA256)

    def test_the_patch_touches_exactly_the_owner_and_applies_to_the_pinned_bytes(self):
        self.assertEqual(re.findall(r'^--- a/(.+)$', PATCH.read_text(), re.M), [OWNER])
        self.assertEqual(re.findall(r'^\+\+\+ b/(.+)$', PATCH.read_text(), re.M), [OWNER])
        self.assertEqual(hashlib.sha256(patched().encode()).hexdigest(), PATCHED_OWNER_SHA256)

    def test_the_patch_removes_only_what_it_replaces(self):
        removed = [line[1:] for line in PATCH.read_text().splitlines() if line.startswith('-') and not line.startswith('---')]
        self.assertEqual(len(removed), 4, removed)
        self.assertEqual(sum('F_DUPFD_CLOEXEC' in line for line in removed), 1)
        self.assertEqual(sum('fcntl(socketfd,F_SETFD,FD_CLOEXEC);error="none"' in line for line in removed), 1)
        self.assertEqual(sum('int ok=(!o->guided||' in line for line in removed), 1)

    def test_the_fixture_patch_touches_only_the_fixture_and_the_matrix_test(self):
        self.assertEqual(sorted(re.findall(r'^--- a/(.+)$', FIXTURE_PATCH.read_text(), re.M)),
                         ['scripts/guest-supervisor/guided_owner_native_fixture.c', 'scripts/guest-supervisor/test_guided_owner.py'])

    def test_the_hashes_are_recorded_in_the_doc(self):
        text = DOC.read_text()
        for digest in (sha(PATCH), sha(FIXTURE_PATCH), PATCHED_OWNER_SHA256, TRACKED_OWNER_SHA256):
            self.assertIn(digest, text)


class StaticGuardTests(unittest.TestCase):
    """Source-structure pins on the patched owner. Mutation runs substitute the owner, so each guard is killed by name."""

    def test_check_reproves_close_on_exec_for_every_retained_descriptor_and_the_bootstrap_socket(self):
        source = patched()
        check = function(source, 'winter_owner_check')
        self.assertIn('retained_cloexec(o)&&', check)
        body = function(source, 'retained_cloexec')
        self.assertIn('for(int i=0;i<o->count;i++)if(o->fd[i]>=0&&!cloexec(o->fd[i]))return 0;', body)
        self.assertIn('o->socket<0||cloexec(o->socket)', body)
        self.assertEqual(source.count('retained_cloexec('), 2)   # definition + the one use in check

    def test_the_bootstrap_socket_is_made_close_on_exec_and_proven_before_it_is_relied_on(self):
        opened = function(patched(), 'winter_owner_open')
        guard = 'if(fcntl(socketfd,F_SETFD,FD_CLOEXEC)<0||!cloexec(socketfd))goto fail;'
        self.assertIn(guard, opened)
        self.assertLess(opened.index(guard), opened.index('o->socket=socketfd;'))
        self.assertLess(opened.index(guard), opened.index('winter_owner_check(o->serial)'))
        self.assertEqual(opened.count('F_SETFD'), 1, 'the old unchecked post-hoc F_SETFD is gone')

    def test_the_transfer_is_one_proven_close_on_exec_dup_and_the_only_close_is_of_the_unreturned_dup(self):
        source = patched()
        transfer = function(source, 'transfer_reader')
        claim = function(source, 'winter_owner_claim_reader')
        self.assertIn('if(original<3||!cloexec(original)||census(original)!=1)return -1;', transfer)
        self.assertIn('int copy=fcntl(original,F_DUPFD_CLOEXEC,3);if(copy<0)return -1;', transfer)
        self.assertIn('if(copy==original||!cloexec(copy)||!identity(copy,original)||census(original)!=2){close(copy);return -1;}', transfer)
        self.assertEqual(transfer.count('close('), 1)
        self.assertLess(transfer.index('F_DUPFD_CLOEXEC'), transfer.index('close(copy)'))
        self.assertNotIn('close(original', transfer)
        self.assertNotIn('close(', claim, 'the claim path never closes a descriptor by number')
        self.assertLess(claim.index('o->reader_claimed=1'), claim.index('transfer_reader('))
        self.assertIn('return transfer_reader(o->fd[4]);', claim)
        self.assertIn('if(!o||!o->guided||o->reader_claimed||winter_owner_check(h))return -1;', claim)

    def test_a_dup_without_the_close_on_exec_form_is_not_used(self):
        source = patched()
        self.assertNotIn('F_DUPFD,', source)
        self.assertNotIn('dup(', function(source, 'transfer_reader'))
        self.assertEqual(function(source, 'transfer_reader').count('F_DUPFD_CLOEXEC'), 1)

    def test_census_counts_only_this_process_and_skips_its_own_directory_handle(self):
        census = function(patched(), 'census')
        self.assertIn('S_ISSOCK(want.st_mode)', census)
        self.assertIn('int skip=dirfd(d)', census)
        self.assertIn('(int)n==skip', census)
        self.assertIn('s.st_dev==want.st_dev&&s.st_ino==want.st_ino', census)
        self.assertIn('#define WINTER_FD_DIRECTORY "/proc/self/fd"', patched())
        self.assertNotIn('/proc/', function(patched(), 'census'))

    def test_the_patch_adds_no_network_netlink_or_new_socket_surface(self):
        added = '\n'.join(line[1:] for line in PATCH.read_text().splitlines() if line.startswith('+') and not line.startswith('+++'))
        for token in ('socket(', 'socketpair', 'connect(', 'bind(', 'listen(', 'accept', 'AF_NETLINK', 'NETLINK', 'AF_INET', 'AF_VSOCK', 'sock_diag', 'ioctl', 'sendmsg', 'recvmsg', 'unshare', 'setns'):
            self.assertNotIn(token, added, token)


HEADER = r'''
#define _GNU_SOURCE
#include <assert.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#ifndef WINTER_FD_DIRECTORY
#define WINTER_FD_DIRECTORY "/dev/fd"
#endif
#define LIMIT 65536
'''

MAIN = r'''
static int pair[2];
static int open_files(void){int n=0;for(int fd=3;fd<256;fd++)if(fcntl(fd,F_GETFD)>=0)n++;return n;}
static void make_pair(void){assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);assert(fcntl(pair[0],F_SETFD,FD_CLOEXEC)==0);assert(fcntl(pair[1],F_SETFD,FD_CLOEXEC)==0);}
int main(int argc,char **argv){
    const char *name=argc>1?argv[1]:"";make_pair();int original=pair[0];
    if(!strcmp(name,"transfer")){
        int before=open_files();assert(census(original)==1);
        int copy=transfer_reader(original);assert(copy>=3&&copy!=original&&cloexec(copy)&&cloexec(original)&&identity(copy,original));
        assert(census(original)==2&&open_files()==before+1);
        /* The copy is a working endpoint of the same stream and outlives the original. */
        assert(send(pair[1],"p",1,0)==1);char c;close(original);assert(recv(copy,&c,1,0)==1&&c=='p');close(copy);return 0;
    }
    if(!strcmp(name,"original-not-cloexec")){
        assert(fcntl(original,F_SETFD,0)==0);int before=open_files();
        assert(transfer_reader(original)==-1);assert(open_files()==before);assert(fcntl(original,F_GETFD)>=0);return 0;
    }
    if(!strcmp(name,"stray-holder")){
        int stray=dup(original);assert(stray>=0);int before=open_files();
        assert(census(original)==2);assert(transfer_reader(original)==-1);assert(open_files()==before&&fcntl(original,F_GETFD)>=0&&fcntl(stray,F_GETFD)>=0);
        close(stray);assert(census(original)==1);return 0;
    }
    if(!strcmp(name,"stray-holder-even-cloexec-off")){
        int stray=dup(original);assert(stray>=0&&fcntl(stray,F_SETFD,0)==0);assert(transfer_reader(original)==-1);return 0;
    }
    if(!strcmp(name,"dup-fails")){
        int top=0;for(int fd=3;fd<256;fd++)if(fcntl(fd,F_GETFD)>=0)top=fd;
        struct rlimit limit={(rlim_t)top+1,(rlim_t)top+1};assert(setrlimit(RLIMIT_NOFILE,&limit)==0);
        int before=open_files();assert(transfer_reader(original)==-1);assert(open_files()==before&&fcntl(original,F_GETFD)>=0);return 0;
    }
    if(!strcmp(name,"small-numbers")){assert(transfer_reader(2)==-1);assert(transfer_reader(-1)==-1);assert(transfer_reader(0)==-1);return 0;}
    if(!strcmp(name,"not-a-socket")){
        int file=open("/dev/null",O_RDONLY|O_CLOEXEC);assert(file>=3&&census(file)==-1&&transfer_reader(file)==-1);return 0;
    }
    if(!strcmp(name,"census-sees-only-the-same-object")){
        int other[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,other)==0);assert(census(original)==1&&census(pair[1])==1&&census(other[0])==1);
        int d=dup(original);assert(census(original)==2&&census(d)==2&&census(pair[1])==1);return 0;
    }
    if(!strcmp(name,"retained")){
        struct owner o;memset(&o,0,sizeof o);for(int i=0;i<5;i++)o.fd[i]=-1;o.socket=-1;o.count=5;
        int fds[6][2];for(int i=0;i<6;i++){assert(socketpair(AF_UNIX,SOCK_STREAM,0,fds[i])==0);assert(fcntl(fds[i][0],F_SETFD,FD_CLOEXEC)==0);}
        for(int i=0;i<5;i++)o.fd[i]=fds[i][0];o.socket=fds[5][0];assert(retained_cloexec(&o));
        for(int i=0;i<5;i++){assert(fcntl(o.fd[i],F_SETFD,0)==0);assert(!retained_cloexec(&o));assert(fcntl(o.fd[i],F_SETFD,FD_CLOEXEC)==0);assert(retained_cloexec(&o));}
        assert(fcntl(o.socket,F_SETFD,0)==0);assert(!retained_cloexec(&o));assert(fcntl(o.socket,F_SETFD,FD_CLOEXEC)==0);
        o.fd[4]=-1;assert(retained_cloexec(&o));   /* a shut-down reader slot is skipped, not an error */
        o.socket=-1;assert(retained_cloexec(&o));return 0;
    }
    if(!strcmp(name,"unreadable-table")){int before=open_files();assert(census(original)==-1&&transfer_reader(original)==-1&&open_files()==before);return 0;}
    if(!strcmp(name,"cloexec")){assert(cloexec(original));assert(fcntl(original,F_SETFD,0)==0&&!cloexec(original));assert(!cloexec(-1)&&!cloexec(999));return 0;}
    return 2;
}
'''

CASES = ('transfer', 'original-not-cloexec', 'stray-holder', 'stray-holder-even-cloexec-off', 'dup-fails', 'small-numbers', 'not-a-socket', 'census-sees-only-the-same-object', 'retained', 'cloexec', 'unreadable-table')


class ExtractedFunctionTests(unittest.TestCase):
    """The patched functions, extracted verbatim and executed against real sockets (a dup, a stray holder, EMFILE, flags)."""

    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('cc')
        if not compiler:
            raise unittest.SkipTest('no C compiler')
        source = patched()
        struct = re.search(r'^struct owner \{.*\};$', source, re.M).group(0)
        pieces = '\n'.join([function(source, 'cloexec'), function(source, 'census'), function(source, 'identity'), struct, function(source, 'retained_cloexec'), function(source, 'transfer_reader')])
        cls.directory = tempfile.TemporaryDirectory(prefix='winter-owner-holder-harness-')
        code = Path(cls.directory.name) / 'holder.c'
        code.write_text(HEADER + pieces + MAIN)
        cls.binary = Path(cls.directory.name) / 'holder'
        built = subprocess.run([compiler, '-std=c11', '-D_DARWIN_C_SOURCE', '-O1', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', str(code), '-o', str(cls.binary)], capture_output=True, text=True, timeout=60)
        if built.returncode:
            raise AssertionError('the extracted holder functions do not compile: ' + built.stderr)
        cls.blind = Path(cls.directory.name) / 'holder-blind'
        built = subprocess.run([compiler, '-std=c11', '-D_DARWIN_C_SOURCE', '-O1', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-DWINTER_FD_DIRECTORY="/nonexistent-winter-fd-table"', str(code), '-o', str(cls.blind)], capture_output=True, text=True, timeout=60)
        if built.returncode:
            raise AssertionError('the blind-table harness does not compile: ' + built.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def run_case(self, name):
        run = subprocess.run([str(self.blind if name == 'unreadable-table' else self.binary), name], capture_output=True, text=True, timeout=20)
        self.assertEqual(run.returncode, 0, name + ': ' + run.stderr[-400:])

    def test_one_close_on_exec_dup_of_the_same_stream_is_transferred_and_nothing_else_is_opened(self): self.run_case('transfer')
    def test_an_original_that_is_not_close_on_exec_is_refused_without_a_leak(self): self.run_case('original-not-cloexec')
    def test_a_second_holder_of_the_stream_inside_the_process_refuses_the_transfer(self): self.run_case('stray-holder')
    def test_a_stray_holder_refuses_even_when_it_is_the_one_that_is_inheritable(self): self.run_case('stray-holder-even-cloexec-off')
    def test_a_failed_dup_is_refused_without_closing_anything(self): self.run_case('dup-fails')
    def test_standard_and_negative_descriptors_are_never_the_reader(self): self.run_case('small-numbers')
    def test_a_non_socket_is_refused(self): self.run_case('not-a-socket')
    def test_the_census_counts_one_socket_object_and_no_other(self): self.run_case('census-sees-only-the-same-object')
    def test_every_retained_slot_and_the_bootstrap_socket_must_stay_close_on_exec(self): self.run_case('retained')
    def test_the_close_on_exec_predicate(self): self.run_case('cloexec')
    def test_an_unreadable_descriptor_table_refuses_the_transfer_without_a_leak(self): self.run_case('unreadable-table')

    def test_every_case_is_driven(self):
        driven = {name for name in re.findall(r'self\.run_case\(\'([a-z-]+)\'\)', Path(__file__).read_text())}
        self.assertEqual(driven, set(CASES))


class FixtureProposalTests(unittest.TestCase):
    """The proposed real-kernel cases (DATA only: never compiled here, never run). They are pinned to the matrix by name."""

    def test_the_proposed_cases_exist_in_the_patched_fixture_and_matrix(self):
        root = scratch()
        fixture = (root / 'scripts/guest-supervisor/guided_owner_native_fixture.c').read_text()
        matrix = (root / 'scripts/guest-supervisor/test_guided_owner.py').read_text()
        for name in ('holder-census', 'holder-clear-cloexec', 'holder-stray-dup', 'holder-bootstrap-cloexec'):
            self.assertIn(f'"{name}"', fixture, name)
            self.assertIn(f"self.case('{name}')", matrix, name)
        self.assertIn('census(', fixture)
        self.assertIn('F_SETFD,0', fixture)
        self.assertIn('winter_owner_claim_reader(owner)==-1', fixture)

    def test_the_patched_matrix_passes_its_own_portable_tests(self):
        root = scratch()
        env = {k: v for k, v in os.environ.items() if not k.startswith('WINTER_')}
        ran = subprocess.run([sys.executable, '-I', '-S', '-B', str(root / 'scripts/guest-supervisor/test_guided_owner.py')],
                             capture_output=True, text=True, timeout=300, cwd=root, env=env)
        self.assertEqual(ran.returncode, 0, ran.stderr[-2000:])

    def test_the_patched_fixture_still_includes_the_owner_unchanged_and_keeps_every_existing_case(self):
        root = scratch()
        fixture = (root / 'scripts/guest-supervisor/guided_owner_native_fixture.c').read_text()
        self.assertIn('#include "../../packages/runtime/src/guest/linux-session-owner.c"', fixture)
        for name in ('claim-twice', 'reader-shutdown', 'bootstrap-close', 'half-close', 'pidfs-absent', 'alias-bootstrap', 'non-socket'):
            self.assertIn(name, fixture)

    def test_the_proposal_never_adds_the_opt_in_to_ordinary_ci(self):
        self.assertNotIn('WINTER_GUIDED_OWNER_NATIVE_ADMISSION', (ROOT / '.github/workflows/ci.yml').read_text())


def linux_headers():
    return sys.platform == 'linux' and shutil.which('cc') is not None


class LinuxCompileTests(unittest.TestCase):
    """Compile only, never executed: the patched owner and patched fixture under the flags ordinary CI already uses."""

    @classmethod
    def setUpClass(cls):
        if not linux_headers():
            if REQUIRE_COMPILE:
                raise AssertionError('Linux compile evidence is required here and this host is not Linux with cc')
            raise unittest.SkipTest('needs Linux headers (CI runs this)')

    def compile(self, relative):
        out = Path(tempfile.mkdtemp(prefix='winter-owner-holder-cc-')) / 'out'
        built = subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(scratch() / relative), '-o', str(out)], capture_output=True, text=True, timeout=120)
        self.assertEqual(built.returncode, 0, built.stderr)
        # Compile only: the output is never executed.

    def test_the_patched_owner_compiles_as_a_library_translation_unit(self):
        source = scratch() / OWNER
        out = Path(tempfile.mkdtemp(prefix='winter-owner-holder-cc-')) / 'owner.o'
        built = subprocess.run(['cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-c', str(source), '-o', str(out)], capture_output=True, text=True, timeout=120)
        self.assertEqual(built.returncode, 0, built.stderr)

    def test_the_patched_fixture_compiles_with_the_patched_owner(self):
        self.compile('scripts/guest-supervisor/guided_owner_native_fixture.c')


if __name__ == '__main__':
    unittest.main()

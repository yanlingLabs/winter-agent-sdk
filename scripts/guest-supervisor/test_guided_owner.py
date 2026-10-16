"""Guided owner source checks and separately gated actual Linux native cases.

Portable checks execute extracted validation only, never native admission. Native
cases use the unchanged production owner and actual kernel evidence; they require
a separately admitted disposable Linux target. Merely being root is not admission.
"""
import os
import platform
import re
import signal
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'packages/runtime/src/guest/linux-session-owner.c'
FIXTURE = Path(__file__).with_name('guided_owner_native_fixture.c')
ADMISSION = 'disposable-linux-guided-owner-matrix'


def function(source, name):
    """Return an exact source function, including its signature and body."""
    match = re.search(r'^(?:static )?(?:int|void|uint64_t) ' + name + r'\(', source, re.M)
    if not match:
        raise AssertionError('missing source function: ' + name)
    start = source.index('{', match.start())
    depth = 0
    tokens = re.finditer(r'/\*[\s\S]*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[{}]', source[start:])
    for token in tokens:
        if token.group() not in ('{', '}'):
            continue
        depth += 1 if token.group() == '{' else -1
        if depth == 0:
            return source[match.start():start + token.end()]
    raise AssertionError('unclosed source function: ' + name)


class GuidedOwnerSourceTests(unittest.TestCase):
    def test_exact_portable_envelope_and_descriptor_validation(self):
        compiler = shutil.which('cc')
        if not compiler:
            self.skipTest('existing local C compiler unavailable; portable validation not executed')
        source = SOURCE.read_text()
        parser = source[source.index('#define LIMIT'):source.index('static int live(')]
        envelope = source[source.index('    int profile=field('):source.index('    if(o->guided){')]
        # Take the actual file/type/alias prefix. Peer authority is deliberately
        # outside this pure predicate; no successful result means owner admission.
        descriptor = source[source.index('        struct stat channel;'):source.index('        if(!guided_peer(socketfd,')]
        header = '#include <errno.h>\n#include <fcntl.h>\n#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <sys/socket.h>\n#include <sys/stat.h>\n#include <unistd.h>\n#include <assert.h>\n'
        harness = r'''
struct validation { int guided,fd[5]; };
static int envelope(const char *json,int used){
    struct parser p={.s=json,.n=(int)strlen(json)};struct validation value={0},*o=&value;
    if(parse(&p,0)!=0)return 0;space(&p);if(p.pos!=p.n||p.t[0].type!='{')return 0;
ENVELOPE
    return 1;
fail:return 0;
}
static int descriptors(struct validation *o,int socketfd){
DESCRIPTOR
    return 1;
fail:return 0;
}
int main(void){
    /* Eight v1/guided crossed cases plus four profile-absent fresh cases. */
    const char *documents[]={
        "{\"profile\":\"host-query-v1\"}",
        "{\"profile\":\"host-query-v1\",\"readerRegistration\":{}}",
        "{\"profile\":\"host-query-guided-v1\"}",
        "{\"profile\":\"host-query-guided-v1\",\"readerRegistration\":{}}",
        "{}", "{\"readerRegistration\":{}}"};
    for(int i=0;i<6;i++)for(int count=4;count<=5;count++)
        assert(envelope(documents[i],count)==(((i==0||i==4)&&count==4)||(i==3&&count==5)));
    assert(!envelope("{\"profile\":\"host-query-guided-v1\",\"readerRegistration\":null}",5));
    assert(!envelope("{\"profile\":\"host-query-guided-v1\",\"readerRegistration\":[]}",5));
    int held[5][2],bootstrap[2];struct validation owner={0};
    for(int i=0;i<5;i++){assert(socketpair(AF_UNIX,SOCK_STREAM,0,held[i])==0);owner.fd[i]=held[i][0];}
    assert(socketpair(AF_UNIX,SOCK_STREAM,0,bootstrap)==0);
    assert(descriptors(&owner,bootstrap[0]));
    int original=owner.fd[4];
    for(int i=0;i<4;i++){owner.fd[4]=dup(owner.fd[i]);assert(owner.fd[4]>=0);assert(!descriptors(&owner,bootstrap[0]));close(owner.fd[4]);}
    owner.fd[4]=dup(bootstrap[0]);assert(!descriptors(&owner,bootstrap[0]));close(owner.fd[4]);
    char filename[]="/tmp/winter-guided-source-XXXXXX";owner.fd[4]=mkstemp(filename);assert(owner.fd[4]>=0);unlink(filename);assert(!descriptors(&owner,bootstrap[0]));close(owner.fd[4]);
    owner.fd[4]=original;for(int i=0;i<5;i++){close(held[i][0]);close(held[i][1]);}close(bootstrap[0]);close(bootstrap[1]);
    return 0;
}
'''.replace('ENVELOPE', envelope).replace('DESCRIPTOR', descriptor)
        with tempfile.TemporaryDirectory(prefix='winter-guided-validation-') as directory:
            code, binary = Path(directory)/'validation.c', Path(directory)/'validation'
            code.write_text(header + parser + function(source, 'identity') + harness)
            built = subprocess.run([compiler, '-std=c11', '-D_DARWIN_C_SOURCE', '-D_DEFAULT_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', str(code), '-o', str(binary)], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            run = subprocess.run([str(binary)], capture_output=True, text=True, timeout=3)
            self.assertEqual(run.returncode, 0, run.stderr)

    def test_native_ownership_source_contract(self):
        source = SOURCE.read_text()
        check = function(source, 'winter_owner_check')
        opened = function(source, 'winter_owner_open')
        claim = function(source, 'winter_owner_claim_reader')
        shutdown = function(source, 'winter_owner_reader_shutdown')
        closed = function(source, 'winter_owner_close')
        peer = function(source, 'guided_peer')
        self.assertNotIn('guided_peer(socketfd', check)
        self.assertIn('guided_peer(socketfd,SOCK_SEQPACKET', opened)
        self.assertIn('guided_peer(o->fd[4],SOCK_STREAM', check)
        self.assertIn('SO_PEERPIDFD', peer)
        self.assertIn('pidfs(peerfd)&&identity(peerfd,service)&&!identity(peerfd,runtime)', peer)
        self.assertIn('o->reader_claimed', claim)
        self.assertLess(claim.index('o->reader_claimed=1'), claim.index('F_DUPFD_CLOEXEC'))
        self.assertNotIn('close(', claim)
        self.assertIn('o->fd[4]=-1;shutdown(fd,SHUT_RDWR);close(fd)', shutdown)
        self.assertIn('shutdown(o->fd[4],SHUT_RDWR)', closed)
        self.assertNotIn('reader_claimed', closed)
        self.assertIn('POLLERR|POLLHUP|POLLRDHUP|POLLNVAL', function(source, 'guided_stream_live'))

    def test_target_fixture_requires_own_opt_in_and_retains_actual_oracles(self):
        fixture = FIXTURE.read_text()
        main = function(fixture, 'main')
        self.assertLess(main.index('getenv("WINTER_GUIDED_OWNER_NATIVE_ADMISSION")'), main.index('prepare(argv[2])'))
        self.assertIn(ADMISSION, main)
        self.assertIn('#include "../../packages/runtime/src/guest/linux-session-owner.c"', fixture)
        self.assertIn('run("ordinary-baseline",argv[2],4,0,0,1)', main)
        self.assertIn('recv(duplicate,&probe,1,MSG_DONTWAIT)==0', fixture)
        self.assertIn('send(duplicate,"x",1,MSG_NOSIGNAL|MSG_DONTWAIT)==-1&&errno==EPIPE', fixture)
        self.assertIn('run(argv[1],argv[2],count,2,registration,count==4&&!registration)', main)

    def test_each_native_case_has_fresh_root_supervisor_and_owned_waits(self):
        fixture = FIXTURE.read_text()
        wrapper = function(fixture, 'run')
        case = function(fixture, 'run_case')
        self.assertLess(wrapper.index('supervisor=fork()'), wrapper.index('run_case('))
        self.assertIn('if(supervisor==0){run_case(', wrapper)
        self.assertIn('waitpid(supervisor,&status,0)==supervisor', wrapper)
        self.assertIn('WIFEXITED(status)&&WEXITSTATUS(status)==0', wrapper)
        self.assertNotIn('unshare(', wrapper)
        self.assertNotIn('socketpair(', wrapper)
        self.assertEqual(case.count('unshare(CLONE_NEWPID)'), 1)
        self.assertLess(case.index('socketpair('), case.index('unshare(CLONE_NEWPID)'))
        self.assertLess(case.index('SYS_pidfd_open,getpid()'), case.index('unshare(CLONE_NEWPID)'))
        self.assertIn('waitpid(pid,&status,0)==pid', case)
        self.assertIn('WIFEXITED(status)&&WEXITSTATUS(status)==0', case)

    def test_ndebug_is_rejected_before_target_headers_or_setup(self):
        compiler = shutil.which('cc')
        if not compiler:
            self.skipTest('existing local C preprocessor unavailable; NDEBUG guard not checked')
        fixture = FIXTURE.read_text()
        # Exact test-guard prefix only: no Linux headers, binary or native setup.
        prefix = fixture[:fixture.index('#include <assert.h>')]
        result = subprocess.run([compiler, '-E', '-DNDEBUG', '-x', 'c', '-'], input=prefix, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('NDEBUG forbidden', result.stderr)


class GuidedOwnerNativeTargetTests(unittest.TestCase):
    """No authority doubles. Every successful case invokes real owner_open/check."""
    @classmethod
    def setUpClass(cls):
        reasons = []
        if platform.system() != 'Linux':
            reasons.append('requires Linux SO_PEERPIDFD/pidfs/PID and mount namespaces; local platform is ' + platform.system())
        if os.geteuid() != 0:
            reasons.append('requires Root-created peers and disposable UID20001/PID1 fixture; local process is not root')
        if os.environ.get('WINTER_GUIDED_OWNER_NATIVE_ADMISSION') != ADMISSION:
            reasons.append('no separately reviewed disposable-target execution admission (WINTER_GUIDED_OWNER_NATIVE_ADMISSION)')
        cls.unavailable = '; '.join(reasons)
        cls.directory = None
        if reasons:
            return
        cls.kernel = tuple(int(n) for n in platform.release().split('-')[0].split('.')[:2])
        compiler = shutil.which('cc')
        if not compiler:
            cls.unavailable = 'target C compiler unavailable; native matrix not executed'
            return
        cls.directory = tempfile.TemporaryDirectory(prefix='winter-guided-native-')
        cls.binary = Path(cls.directory.name)/'fixture'
        built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(FIXTURE), '-o', str(cls.binary)], capture_output=True, text=True, timeout=30)
        if built.returncode:
            cls.directory.cleanup()
            raise AssertionError(built.stderr)
        cls.binary.chmod(0o555)

    @classmethod
    def tearDownClass(cls):
        if cls.directory is not None:
            cls.directory.cleanup()

    def case(self, name, older=False):
        if self.unavailable:
            self.skipTest(self.unavailable)
        if older and self.kernel >= (6, 9):
            self.skipTest('actual absent-pidfs refusal requires a separately admitted Linux kernel before 6.9; target is ' + platform.release())
        if not older and self.kernel < (6, 9):
            self.skipTest('actual guided success/lifetime matrix requires Linux >=6.9 pidfs/SO_PEERPIDFD; target is ' + platform.release())
        with tempfile.TemporaryDirectory(prefix='winter-guided-target-home-') as fixture_home:
            process = subprocess.Popen([str(self.binary), name, fixture_home], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True, cwd=fixture_home, env={'PATH': os.defpath, 'LANG': 'C', 'WINTER_GUIDED_OWNER_NATIVE_ADMISSION': ADMISSION})
            signal_requested = False
            try:
                stdout, stderr = process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                signal_requested = True
                process.communicate()
                self.fail('actual native fixture timed out; process-group SIGKILL requested and parent reaped; namespace-child cleanup unconfirmed')
            finally:
                # Best-effort signal only. This is NOT a child reap/cleanup receipt.
                if process.returncode != 0 and not signal_requested:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            self.assertEqual(process.returncode, 0, stderr + '; abnormal target namespace-child cleanup unconfirmed')
            self.assertEqual(stdout.strip(), name + ': actual kernel case passed')

    def test_crossed_four_five_guided_registration(self): self.case('crossed')
    def test_reader_alias_runtime_pidfd(self): self.case('alias0')
    def test_reader_alias_service_pidfd(self): self.case('alias1')
    def test_reader_alias_store_directory(self): self.case('alias2')
    def test_reader_alias_executable(self): self.case('alias3')
    def test_reader_alias_bootstrap(self): self.case('alias-bootstrap')
    def test_reader_non_socket(self): self.case('non-socket')
    def test_actual_pidfs_absent_before_69(self): self.case('pidfs-absent', older=True)
    def test_claim_twice_and_no_numeric_double_close(self): self.case('claim-twice')
    def test_reader_shutdown_loses_owner(self): self.case('reader-shutdown')
    def test_closed_bootstrap_peer_preserves_owner(self): self.case('bootstrap-close')
    def test_stream_half_close_loses_owner(self): self.case('half-close')


if __name__ == '__main__':
    unittest.main()

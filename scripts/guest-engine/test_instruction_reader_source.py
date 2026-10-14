"""Portable extracted-C contract tests only; no native launcher/helper executes.

All syscall/filter/mount stand-ins are inert. These tests do not establish Linux
confinement, a measured reader artifact, honest Bun compatibility or cleanup.
"""
import errno
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'packages/runtime/src/guest/linux-instruction-reader-compartment.c'
PROBE = ROOT / 'packages/runtime/src/guest/linux-instruction-reader-dependency-probe.c'
HEADER = ROOT / 'packages/runtime/src/guest/linux-compartment.h'
# reader_filter text is byte-identical to the reviewed base f6d88d9a: the
# runtime-compatibility view adds no seccomp change.
BASE_FILTER_SHA256 = 'a526940cfb0c3604e17ced12c14b81c7ae33e6d8aec6fcb7dca00b322bc7d5a6'

# Every audited perror label present at the reviewed base f6d88d9a.
EXISTING_LABELS = (
    'reader Root peer',
    'reader admitted clone',
    'reader bounding capabilities',
    'reader close-on-exec',
    'reader directory mountpoint',
    'reader empty readonly cwd',
    'reader explicit pipe',
    'reader explicit pipe-only envelope',
    'reader file mountpoint',
    'reader immutable exec',
    'reader immutable file',
    'reader independent primary gid',
    'reader independent uid',
    'reader inherited descriptor',
    'reader monitor control',
    'reader monitor control copy',
    'reader monitor death',
    'reader monitor init',
    'reader monitor init copy',
    'reader monitor originals',
    'reader monotonic deadline',
    'reader mount attach',
    'reader namespace init',
    'reader namespace kill',
    'reader namespace pidfd',
    'reader namespaces',
    'reader no new privileges',
    'reader parent pidfd',
    'reader pipe descriptor',
    'reader pipe flags',
    'reader private propagation',
    'reader private temporary files',
    'reader readonly skeleton',
    'reader receipt type',
    'reader recursive mount flags',
    'reader resource ceiling',
    'reader root',
    'reader seccomp',
    'reader selected directory',
    'reader selected workspace group',
    'reader service death',
    'reader service pidfd',
    'reader setup monitor death',
    'reader shared identity',
    'reader skeleton',
    'reader skeleton ancestor',
    'reader source identity',
    'reader surviving pipe',
    'reader view ancestor',
    'reader view cwd',
    'reader view ownership',
    'reader view root',
    'reader zero capabilities',
)

SOURCE_PATH = '/workspace/folders/source'
SHARED_PATH = '/run/winter/shared-instructions'
DEPENDENCIES = ['/lib/ld-linux-aarch64.so.1', '/usr/lib/aarch64-linux-gnu/libc.so.6']
SEALED = 'ro,nosuid,nodev,noexec,relatime'
PLAN_C = r'''
    char *plan_arguments[]={"reader","instruction-reader-v1","3","/run/winter/instruction-reader-views/read-1","4","20003","20002","5",
        "/workspace/folders/source","/workspace/folders/source/sub","6","2","7","/lib/ld-linux-aarch64.so.1","8","/usr/lib/aarch64-linux-gnu/libc.so.6"};
    struct reader_plan plan;
    assert(reader_parse(16,plan_arguments,&plan));
'''


class ReaderSourceTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'complete Linux role compilation requires existing Linux headers/compiler; Mac portable tests are not full-role compilation')
    def test_full_linux_role_compile_only_never_execute(self):
        compiler = shutil.which('cc')
        self.assertIsNotNone(compiler, 'existing Linux C compiler required')
        with tempfile.TemporaryDirectory(prefix='winter-reader-compile-only-') as directory:
            # The compartment and its separate dependency probe: objects only, never linked or run.
            for source in (SOURCE, PROBE):
                output = Path(directory) / (source.stem + '.o')
                built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-fPIE', '-c', str(source), '-o', str(output)], capture_output=True, text=True, timeout=30)
                self.assertEqual(built.returncode, 0, source.name + ': ' + built.stderr)
                self.assertGreater(output.stat().st_size, 0)
            # No linking, admission or execution of this output, on any platform.

    def run_c(self, text, cases=((),)):
        compiler = shutil.which('cc')
        self.assertIsNotNone(compiler, 'portable source validation requires existing cc')
        with tempfile.TemporaryDirectory(prefix='winter-reader-source-') as directory:
            code = Path(directory) / 'inert.c'
            binary = Path(directory) / 'inert'
            code.write_text(text)
            built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(code), '-o', str(binary)], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            for arguments, expected in cases:
                with self.subTest(arguments=arguments):
                    run = subprocess.run([str(binary), *arguments], capture_output=True, text=True, timeout=3)
                    self.assertEqual(run.returncode, expected, run.stderr)

    def test_exact_pure_launch_parser_closed_paths_descriptors_and_bounds(self):
        source = SOURCE.read_text()
        pure = source.split('/* BEGIN PORTABLE CONTRACT')[1].split('*/', 1)[1].split('/* END PORTABLE CONTRACT */')[0]
        harness = r'''
#include <assert.h>
#include <stdio.h>
#include <string.h>
#define READER_DEPENDENCIES 32
PURE
int main(int argc,char **argv) {
    struct reader_plan plan;
    int accepted=reader_parse(argc,argv,&plan);
    if(accepted)assert(plan.uid>=1000&&plan.dependencies<=32);
    return accepted?0:64;
}
'''.replace('PURE', pure)
        base = ['instruction-reader-v1', '3', '/run/winter/instruction-reader-views/read-1', '4', '20003', '20002', '5', '/workspace/folders/source', '/workspace/folders/source/sub', '6', '0']
        cases = [(base, 0)]
        for at, replacements in {
            0: ['file', 'process', 'instruction-reader-v2', ''],
            1: ['2', '+3', '03', '65536', '99999999999999999999999'],
            2: ['/tmp/view', '/run/winter/instruction-reader-views/../x', '/run/winter/instruction-reader-views/a/b'],
            3: ['3', '5', '6'],
            4: ['0', '999', '-1', '65536'],
            5: ['0', '999', '65536'],
            6: ['3', '4', '6'],
            7: ['/workspace', '/workspace/.winter', '/workspace/folders/x/..', '/workspace/repos/.hidden', '/workspace/repos/-x', '/workspace/repos/x/y'],
            8: ['/workspace/folders/source-foreign', '/workspace/folders/source/../hidden', '/workspace/folders/source//x', '/workspace/folders/source/./x', '/workspace/folders/source/', '/workspace/folders/source/a\nb', '/workspace/folders/source/a\tb', '/workspace/folders/source/a\\b', '/workspace/folders/source/a\x7fb'],
            9: ['3', '4', '5'],
            10: ['1', '-1', '33', '00'],
        }.items():
            for replacement in replacements:
                bad = list(base); bad[at] = replacement; cases.append((bad, 64))
        for root in ('/workspace/repos/repo-id', '/workspace/folders/grant..id'):
            good = list(base); good[7] = root; good[8] = root + '/lib..dir'; cases.append((good, 0))
        for suffix in ('My Folder', 'café/日本語', 'nested folder/with spaces'):
            good = list(base); good[8] = good[7] + '/' + suffix; cases.append((good, 0))
        good = list(base); good[10] = '2'
        good += ['7', '/lib/ld-linux-aarch64.so.1', '8', '/usr/lib/aarch64-linux-gnu/libc.so.6']
        cases.append((good, 0))
        for at, replacements in {
            11: ['3', '4', '5', '6', '8'],
            12: ['/usr/bin/bun', '/lib/../etc/passwd', '/lib//libc.so', '/lib/./libc.so', '/lib/libc.so/', '/lib/My Library.so', '/lib/café.so'],
            14: ['/lib/ld-linux-aarch64.so.1', '/lib/ld-linux-aarch64.so.1/nested'],
        }.items():
            for replacement in replacements:
                bad = list(good); bad[at] = replacement; cases.append((bad, 64))
        cases += [(base + ['extra'], 64), ([], 64), (good[:-1], 64)]
        # Exact maximum dependency count and nested-file mountpoint collision.
        maximum = list(base); maximum[10] = '32'
        for index in range(32):
            maximum += [str(index + 7), f'/lib/dep{index}.so']
        cases.append((maximum, 0))
        ancestor = list(good); ancestor[12] = '/lib/one'; ancestor[14] = '/lib/one/child'
        cases.append((ancestor, 64))
        self.run_c(harness, cases)

    def test_original_service_parent_is_bound_across_reparenting_schedules(self):
        source = SOURCE.read_text()
        helper = source[source.index('static int reader_service_owner('):source.index('int main(')]
        harness = r'''
#include <assert.h>
#include <stdarg.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>
#define SOL_SOCKET 1
#define SO_TYPE 2
#define SO_PEERCRED 3
#define SOCK_SEQPACKET 4
#define SYS_pidfd_open 5
#define PR_SET_PDEATHSIG 6
#define SIGKILL 9
#define POLLIN 1
typedef unsigned int socklen_t;
struct ucred { pid_t pid; unsigned int uid,gid; };
struct pollfd { int fd;short events,revents; };
static int schedule,parent=400,parent_calls,peer_calls,opens,armed,polled;
static void require(int value,const char *label) {(void)label;if(value<0)_exit(77);}
static pid_t fake_getppid(void) {
    parent_calls++;
    if(schedule==5&&parent_calls==1)parent=1;
    return parent;
}
static int fake_getsockopt(int fd,int level,int kind,void *value,socklen_t *size) {
    assert(fd==17&&level==SOL_SOCKET);
    if(kind==SO_TYPE){assert(*size==sizeof(int));*(int *)value=SOCK_SEQPACKET;return 0;}
    assert(kind==SO_PEERCRED&&*size==sizeof(struct ucred));peer_calls++;
    struct ucred peer={400,schedule==7?1U:0U,0};*(struct ucred *)value=peer;
    if(schedule==1)parent=1; /* death after peer comparison, before pidfd open */
    return 0;
}
static long fake_syscall(long kind,...) {
    assert(kind==SYS_pidfd_open&&!opens++&&peer_calls==1);
    va_list arguments;va_start(arguments,kind);
    assert(va_arg(arguments,int)==400);assert(va_arg(arguments,int)==0);va_end(arguments);
    if(schedule==2)parent=1; /* death after opening the exact old parent */
    return schedule==6?-1:91;
}
static int fake_prctl(int kind,int signal) {
    assert(kind==PR_SET_PDEATHSIG&&signal==SIGKILL&&opens==1&&!armed++);
    if(schedule==3)parent=1; /* death while arming */
    return 0;
}
static int fake_poll(struct pollfd *fds,unsigned long count,int timeout) {
    assert(count==1&&timeout==0&&fds[0].fd==91&&fds[0].events==POLLIN&&!polled++);
    assert(armed==1&&parent_calls==2);
    return schedule==4?1:0; /* exact parent's pidfd reports death after equality */
}
#define getppid fake_getppid
#define getsockopt fake_getsockopt
#define syscall fake_syscall
#define prctl fake_prctl
#define poll fake_poll
HELPER
int main(int argc,char **argv) {
    assert(argc==2);schedule=atoi(argv[1]);
    assert(reader_service_owner(17)==91&&schedule==0&&parent_calls==2&&opens==1&&armed==1&&polled==1);
    return 0;
}
'''.replace('HELPER', helper)
        self.run_c(harness, [([str(schedule)], 0 if schedule == 0 else 64 if schedule in (5, 7) else 77) for schedule in range(8)])

    def test_exact_clone_applies_recursive_flags_and_private_propagation(self):
        source = SOURCE.read_text()
        helper = source[source.index('static int reader_clone('):source.index('static void reader_attach(')]
        harness = r'''
#include <assert.h>
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#define SYS_open_tree 428
#define SYS_mount_setattr 442
#define OPEN_TREE_CLONE 1
#define OPEN_TREE_CLOEXEC 2
#define AT_EMPTY_PATH 4096
#define AT_RECURSIVE 32768
#define MOUNT_ATTR_RDONLY 1
#define MOUNT_ATTR_NOSUID 2
#define MOUNT_ATTR_NODEV 4
#define MOUNT_ATTR_NOEXEC 8
#define MS_PRIVATE (1UL<<18)
struct mount_attr { uint64_t attr_set,attr_clr,propagation,userns_fd; };
static int fault,executable,cloned,configured;
static void require(int value,const char *label) {(void)label;if(value<0)_exit(77);}
static long fake_syscall(long call,...) {
    va_list arguments;va_start(arguments,call);
    if(call==SYS_open_tree) {
        assert(!cloned++&&!configured);assert(va_arg(arguments,int)==17);
        assert(!*va_arg(arguments,const char *));
        assert(va_arg(arguments,int)==(OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH|(executable?0:AT_RECURSIVE)));
        va_end(arguments);return fault==1?-1:91;
    }
    assert(call==SYS_mount_setattr&&cloned==1&&!configured++);
    assert(va_arg(arguments,int)==91);assert(!*va_arg(arguments,const char *));
    assert(va_arg(arguments,int)==(AT_EMPTY_PATH|(executable?0:AT_RECURSIVE)));
    struct mount_attr *attr=va_arg(arguments,struct mount_attr *);
    assert(va_arg(arguments,size_t)==sizeof *attr);
    assert(attr->attr_set==(uint64_t)(MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV|(executable?0:MOUNT_ATTR_NOEXEC)));
    assert(!attr->attr_clr&&!attr->userns_fd&&attr->propagation==MS_PRIVATE);
    va_end(arguments);return fault==2?-1:0;
}
#define syscall fake_syscall
HELPER
int main(int argc,char **argv) {
    assert(argc==3);fault=atoi(argv[1]);executable=atoi(argv[2]);
    assert(reader_clone(17,executable)==91&&cloned==1&&configured==1&&!fault);return 0;
}
'''.replace('HELPER', helper)
        self.run_c(harness, [([str(fault), str(executable)], 0 if not fault else 77) for executable in (0, 1) for fault in (0, 1, 2)])

    def test_exact_filter_inert_interpreter_denies_sockets_and_process_clone(self):
        source = SOURCE.read_text()
        function = source[source.index('static void reader_filter('):source.index('static void reader_limit(')]
        denied = ['mount', 'umount2', 'chroot', 'pivot_root', 'setns', 'unshare', 'open_tree', 'move_mount', 'mount_setattr', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'socket', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'accept4', 'sendto', 'sendmsg', 'sendmmsg', 'recvmsg', 'recvmmsg', 'open_by_handle_at', 'name_to_handle_at', 'bpf', 'perf_event_open', 'pidfd_open', 'pidfd_getfd', 'pidfd_send_signal', 'io_uring_setup', 'fork', 'vfork']
        numbers = '\n'.join(f'#define __NR_{name} {number}' for number, name in enumerate([*denied, 'clone', 'clone3'], 1))
        harness = r'''
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#define ARCH 0xc00000b7
#define BPF_LD 0x00
#define BPF_W 0x00
#define BPF_ABS 0x20
#define BPF_JMP 0x05
#define BPF_JEQ 0x10
#define BPF_JGE 0x30
#define BPF_K 0x00
#define BPF_RET 0x06
#define BPF_ALU 0x04
#define BPF_AND 0x50
#define BPF_STMT(code,value) {code,0,0,value}
#define BPF_JUMP(code,value,yes,no) {code,yes,no,value}
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#define SECCOMP_RET_ERRNO 0x00050000U
#define SECCOMP_RET_ALLOW 0x7fff0000U
#define SECCOMP_MODE_FILTER 2
#define PR_SET_SECCOMP 22
#define CLONE_VM 0x100
#define CLONE_FS 0x200
#define CLONE_FILES 0x400
#define CLONE_SIGHAND 0x800
#define CLONE_THREAD 0x10000
#define CLONE_SYSVSEM 0x40000
#define CLONE_SETTLS 0x80000
#define CLONE_PARENT_SETTID 0x100000
#define CLONE_CHILD_CLEARTID 0x200000
#define CLONE_CHILD_SETTID 0x1000000
struct seccomp_data { int nr;unsigned int arch;uint64_t instruction_pointer,args[6]; };
struct sock_filter { unsigned short code;unsigned char jt,jf;unsigned int k; };
struct sock_fprog { unsigned short len;struct sock_filter *filter; };
static struct sock_filter captured[256];static unsigned int length;
static void require(int value,const char *label) {(void)label;assert(!value);}
static int prctl(int kind,int mode,const struct sock_fprog *program) {
    assert(kind==PR_SET_SECCOMP&&mode==SECCOMP_MODE_FILTER&&program->len<256);
    length=program->len;memcpy(captured,program->filter,length*sizeof *captured);return 0;
}
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
NUMBERS
FUNCTION
static unsigned int evaluate(unsigned int arch,int nr,uint64_t flags) {
    struct seccomp_data data={.arch=arch,.nr=nr,.args={flags,0,0,0,0,0}};
    unsigned int accumulator=0;
    for(unsigned int pc=0;pc<length;pc++) {
        struct sock_filter step=captured[pc];
        switch(step.code) {
            case BPF_LD|BPF_W|BPF_ABS:assert(step.k+4<=sizeof data);memcpy(&accumulator,(char *)&data+step.k,4);break;
            case BPF_ALU|BPF_AND|BPF_K:accumulator&=step.k;break;
            case BPF_JMP|BPF_JEQ|BPF_K:pc+=accumulator==step.k?step.jt:step.jf;break;
            case BPF_JMP|BPF_JGE|BPF_K:pc+=accumulator>=step.k?step.jt:step.jf;break;
            case BPF_RET|BPF_K:return step.k;
            default:assert(0);
        }
    }
    assert(0);return 0;
}
int main(void) {
    reader_filter();
    for(int nr=1;nr<=34;nr++)assert(evaluate(ARCH,nr,0)==(SECCOMP_RET_ERRNO|EPERM));
    assert(evaluate(ARCH,__NR_clone3,0)==(SECCOMP_RET_ERRNO|ENOSYS));
    const uint64_t required=CLONE_VM|CLONE_SIGHAND|CLONE_THREAD;
    const uint64_t allowed=required|CLONE_FS|CLONE_FILES|CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_SETTID|CLONE_CHILD_CLEARTID;
    assert(evaluate(ARCH,__NR_clone,required)==SECCOMP_RET_ALLOW);
    assert(evaluate(ARCH,__NR_clone,allowed)==SECCOMP_RET_ALLOW);
    assert(evaluate(ARCH,__NR_clone,0)==(SECCOMP_RET_ERRNO|EPERM));
    for(unsigned int bit=0;bit<64;bit++) {
        uint64_t flag=UINT64_C(1)<<bit;
        if(!(allowed&flag))assert(evaluate(ARCH,__NR_clone,required|flag)==(SECCOMP_RET_ERRNO|EPERM));
        if(required&flag)assert(evaluate(ARCH,__NR_clone,required&~flag)==(SECCOMP_RET_ERRNO|EPERM));
    }
    assert(evaluate(0,__NR_socket,0)==SECCOMP_RET_KILL_PROCESS);
    assert(evaluate(ARCH,999,0)==SECCOMP_RET_ALLOW);
#if X86_TEST
    assert(evaluate(ARCH,0x40000000,0)==SECCOMP_RET_KILL_PROCESS);
#endif
    return 0;
}
'''.replace('NUMBERS', numbers)
        for x86 in (0, 1):
            exact_function = function.replace('#if defined(__x86_64__)', f'#if {x86}')
            self.run_c(f'#define X86_TEST {x86}\n' + harness.replace('FUNCTION', exact_function), [((), 0)])

    def test_source_lifetime_and_view_inventory_are_distinct_and_unwired(self):
        source = SOURCE.read_text()
        self.assertNotIn('install_filter(', source)
        self.assertNotIn('RLIMIT_AS,', source)
        self.assertIn('#define READER_WALL_MS 4000', source)
        self.assertIn('reader_limit(RLIMIT_FSIZE,0)', source)
        # The sealed view is no longer proc/dev-free: exactly the two reviewed additions
        # exist, gated in detail by test_runtime_view_adds_exactly_two_things_in_order.
        self.assertEqual(source.count('mount("proc"'), 1)
        self.assertEqual(source.count('"/dev/'), 1)
        self.assertNotIn('"/workspace/.winter', source)
        self.assertIn('require(chdir(READER_HOME),"reader empty readonly cwd")', source)
        self.assertIn('"HOME=" READER_HOME', source)
        self.assertIn('require(setresgid(plan.uid,plan.uid,plan.uid)', source)
        self.assertIn('require(setgroups(1,&group)', source)
        self.assertIn('require((int)syscall(SYS_close_range,3U,~0U,0U)', source)
        monitor = source[source.index('static int reader_monitor('):source.index('int main(')]
        self.assertLess(monitor.index('SYS_close_range'), monitor.index('sendmsg(control'))
        self.assertLess(monitor.index('waitpid(child'), monitor.index("receipt[5]={'R'"))
        self.assertIn('deadline-reader_milliseconds()', monitor)
        self.assertIn('reader_kill(init)', monitor)
        self.assertLess(source.index('MS_REC|MS_PRIVATE'), source.index('reader_attach(source_tree'))
        main = source[source.index('int main('):]
        self.assertLess(main.index('reader_service_owner(plan.receipt)'), main.index('unshare('))
        self.assertLess(source.index('"reader setup monitor death"'), source.index('mount("tmpfs",plan.view'))
        self.assertLess(source.index('poll(&setup_alive'), source.index('mount("tmpfs",plan.view'))
        self.assertLess(source.index('setresuid(plan.uid'), source.index('"reader monitor death"'))


    # ---- runtime-compatibility view: source gates, extracted-C behavior, probe grammar ----

    def parts(self):
        """Shared extraction of the compartment's portable blocks and view helpers."""
        source = SOURCE.read_text()
        defines = source[source.index('#define READER_DEPENDENCIES'):source.index('/* BEGIN PORTABLE CONTRACT')]
        contract = source.split('/* BEGIN PORTABLE CONTRACT')[1].split('*/', 1)[1].split('/* END PORTABLE CONTRACT */')[0]
        view = source.split('/* BEGIN PORTABLE VIEW CONTRACT')[1].split('*/', 1)[1].split('/* END PORTABLE VIEW CONTRACT */')[0]
        header = HEADER.read_text()
        start = header.index('static inline void require(')
        require = header[start:header.index('static inline void path(', start)]
        helpers = source[source.index('static void reader_expect('):source.index('/* Separate filter')]
        return source, defines, contract, view, require, helpers

    def test_runtime_view_adds_exactly_two_things_in_order(self):
        source = SOURCE.read_text()
        # (A) exactly two additions, each defined once.
        self.assertIn('#define READER_ENTROPY "/dev/urandom"', source)
        self.assertIn('#define READER_PROC "/proc"', source)
        self.assertIn('#define READER_PROC_OPTIONS "subset=pid,hidepid=invisible"', source)
        self.assertEqual(source.count('"/dev'), 1)
        for forbidden in ('"/dev/null"', '"/dev/zero"', '"/dev/random"', '"/dev/tty', '"/dev/shm', '"/sys', 'MS_BIND', 'devtmpfs', 'devpts', 'sysfs'):
            self.assertNotIn(forbidden, source)
        self.assertEqual(re.findall(r'"/proc[^"]*"', source), ['"/proc"'])
        self.assertEqual(sorted(re.findall(r'(?<!define )READER_PROC "([^"]*)"', source)), ['/1/cwd', '/1/root', '/self/fd', '/self/mountinfo'])
        # The complete mount(2) inventory: nothing is added beyond the one procfs.
        mounts = re.findall(r'(?<![A-Za-z_])mount\((.*?)\),"reader', source)
        self.assertEqual(mounts, [
            'NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL',
            '"tmpfs",plan.view,"tmpfs",MS_NOSUID|MS_NODEV|MS_NOEXEC,"mode=0755,size=16m"',
            '"tmpfs",target,"tmpfs",MS_NOSUID|MS_NODEV|MS_NOEXEC,"mode=1777,size=8m"',
            '"proc",target,"proc",MS_RDONLY|MS_NOSUID|MS_NODEV|MS_NOEXEC,READER_PROC_OPTIONS',
            'NULL,plan.view,NULL,MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV|MS_NOEXEC,NULL',
        ])
        self.assertEqual(re.findall(r'reader_attach\((\w+(?:\[i\])?),target\)', source), ['source_tree', 'shared_tree', 'executable_tree', 'dependencies[i]', 'entropy_tree'])
        self.assertEqual(source.count('SYS_move_mount'), 1)
        self.assertEqual(source.count('SYS_open_tree'), 2)
        self.assertEqual(source.count('SYS_mount_setattr'), 2)
        # The one device bind is the only mount that clears NODEV, and is read-only/nosuid/noexec.
        entropy = source[source.index('static int reader_entropy('):source.index('/* Same kernel identity')]
        self.assertEqual(source.count('MOUNT_ATTR_NODEV'), 2)  # the general clone's set, and the one entropy clear
        self.assertIn('.attr_set=MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NOEXEC,.attr_clr=MOUNT_ATTR_NODEV,.propagation=MS_PRIVATE', entropy)
        self.assertIn('S_ISCHR(info.st_mode)&&major(info.st_rdev)==1&&minor(info.st_rdev)==9', entropy)
        # No seccomp, rlimit, credential or environment change.
        function = source[source.index('static void reader_filter('):source.index('static void reader_limit(')]
        self.assertEqual(hashlib.sha256(function.encode()).hexdigest(), BASE_FILTER_SHA256)
        self.assertEqual(re.findall(r'reader_limit\(RLIMIT_\w+,\d+\);', source), ['reader_limit(RLIMIT_CPU,3);', 'reader_limit(RLIMIT_NOFILE,64);', 'reader_limit(RLIMIT_NPROC,32);', 'reader_limit(RLIMIT_CORE,0);', 'reader_limit(RLIMIT_FSIZE,0);'])
        self.assertIn('char *environment[]={"LANG=C","LC_ALL=C","TZ=UTC","HOME=" READER_HOME,"TMPDIR=/tmp","PATH=/usr/bin:/bin",NULL};', source)
        self.assertEqual(source.count('prctl(PR_SET_SECCOMP'), 1)
        self.assertNotIn('RLIMIT_AS', source.replace('NO RLIMIT_AS', ''))
        for workaround in ('getrandom', 'PR_SET_DUMPABLE', 'personality', 'setenv', 'putenv', 'BUN_', 'JSC_'):
            self.assertNotIn(workaround, source)
        # Ordering. Entropy is cloned from the host BEFORE unshare; the procfs is mounted by
        # the forked namespace init, after the setup death-arming and before the read-only
        # remount, chroot, credential drop and filter.
        main = source[source.index('int main('):]
        self.assertLess(main.index('int entropy_tree=reader_entropy();'), main.index('unshare('))
        self.assertLess(main.index('MS_REC|MS_PRIVATE'), main.index('reader_attach(source_tree'))
        self.assertLess(main.index('pid_t child=fork()'), main.index('"reader setup monitor death"'))
        self.assertLess(main.index('"reader setup monitor death"'), main.index('mount("tmpfs",plan.view'))
        self.assertLess(main.index('"reader private temporary files"'), main.index('reader_point(plan.view,READER_ENTROPY,target,1);reader_attach(entropy_tree,target);'))
        self.assertLess(main.index('reader_attach(entropy_tree,target);'), main.index('reader_entropy_identity(target,"reader attached entropy identity");'))
        self.assertLess(main.index('"reader attached entropy identity"'), main.index('mount("proc"'))
        self.assertLess(main.index('"reader private proc"'), main.index('MS_REMOUNT|MS_RDONLY'))
        self.assertLess(main.index('MS_REMOUNT|MS_RDONLY'), main.index('chroot(".")'))
        self.assertLess(main.index('if(child)return reader_monitor'), main.index('mount("proc"'))
        # (B) invariants are checked in the final view, after every other setup step, under the final filter.
        for earlier in ('chroot(".")', 'setresuid(plan.uid', '"reader zero capabilities"', 'SYS_close_range,3U', 'reader_filter();umask(0077);'):
            self.assertLess(main.index(earlier), main.index('reader_verify_view(&plan);'), earlier)
        self.assertLess(main.index('reader_verify_view(&plan);'), main.index('execve(args[0]'))
        self.assertEqual(source.count('reader_verify_view(&plan);'), 1)
        verify = source[source.index('static void reader_verify_view('):source.index('/* Separate filter')]
        order = ['reader_proc_inventory();', 'reader_proc_identity();', 'reader_entropy_identity(READER_ENTROPY,"reader final entropy identity");', 'reader_mount_inventory(plan);', 'reader_descriptor_inventory();']
        self.assertEqual([verify.index(step) for step in order], sorted(verify.index(step) for step in order))
        self.assertEqual(re.findall(r'\w+\([^;]*\);', verify[verify.index('{'):]), order)
        # Existing checks are all kept.
        for kept in ('require(chdir(READER_HOME),"reader empty readonly cwd")', 'require(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)', 'require(setgroups(1,&group)', 'require(setresgid(plan.uid,plan.uid,plan.uid)', 'require(setresuid(plan.uid,plan.uid,plan.uid)', 'require((int)syscall(SYS_close_range,3U,~0U,0U)', 'reader_pipes();reader_view(plan.view);'):
            self.assertIn(kept, source)

    def test_new_invariant_labels_are_distinct_and_owned_by_one_function(self):
        source = SOURCE.read_text()
        groups = {
            'reader_proc_inventory': {'reader proc root inventory'},
            'reader_proc_identity': {'reader init process id', 'reader proc root identity', 'reader proc cwd identity'},
            'reader_mount_inventory': {'reader mount inventory'},
            'reader_descriptor_inventory': {'reader descriptor inventory', 'reader descriptor kind'},
            'reader_entropy': {'reader entropy device', 'reader entropy identity', 'reader entropy clone', 'reader entropy mount flags'},
            'main': {'reader attached entropy identity', 'reader private proc'},
            'reader_verify_view': {'reader final entropy identity'},
        }
        labels = [label for group in groups.values() for label in group]
        self.assertEqual(len(labels), len(set(labels)))
        starts = [(match.start(), match.group(1)) for match in re.finditer(r'^(?:static [^\n]*?|int )\b(\w+)\(', source, re.MULTILINE)]
        for owner, expected in groups.items():
            for label in expected:
                hits = [match.start() for match in re.finditer('"' + re.escape(label) + '"', source)]
                self.assertTrue(hits, label)
                self.assertEqual({[name for start, name in starts if start <= hit][-1] for hit in hits}, {owner}, label)
        # No new label reuses, or is a prefix of (or extended from), a label that already existed at f6d88d9a.
        for label in labels:
            for existing in EXISTING_LABELS:
                self.assertFalse(label.startswith(existing) or existing.startswith(label), (label, existing))
            self.assertNotIn(label, EXISTING_LABELS)
        for existing in EXISTING_LABELS:
            self.assertIn('"' + existing + '"', source)

    def test_final_view_mount_inventory_accepts_only_the_expected_table(self):
        _, defines, contract, view, _, _ = self.parts()
        harness = r'''
#include <assert.h>
#include <stdio.h>
#include <string.h>
#pragma GCC diagnostic ignored "-Wunused-function"
@@DEFINES@@
@@CONTRACT@@
@@VIEW@@
int main(int argc,char **argv) {
    assert(argc==2);
@@PLAN@@
    static char text[1<<20];
    FILE *file=fopen(argv[1],"rb");assert(file);
    size_t length=fread(text,1,sizeof text,file);fclose(file);
    return reader_mountinfo_ok(text,length,&plan)?0:64;
}
'''.replace('@@DEFINES@@', defines).replace('@@CONTRACT@@', contract).replace('@@VIEW@@', view).replace('@@PLAN@@', PLAN_C)

        def rows():
            return [
                ['/', SEALED, 'tmpfs', 'tmpfs', 'rw,size=16384k,mode=755'],
                [SOURCE_PATH, SEALED, 'ext4', '/dev/vda1', 'rw'],
                [SHARED_PATH, SEALED, 'ext4', '/dev/vda2', 'rw'],
                ['/instruction-reader', 'ro,nosuid,nodev,relatime', 'ext4', '/dev/vda3', 'rw'],
                [DEPENDENCIES[0], 'ro,nosuid,nodev,relatime', 'ext4', '/dev/vda3', 'rw'],
                [DEPENDENCIES[1], 'ro,nosuid,nodev,relatime', 'ext4', '/dev/vda3', 'rw'],
                ['/tmp', 'rw,nosuid,nodev,noexec,relatime', 'tmpfs', 'tmpfs', 'rw,size=8192k,mode=1777'],
                ['/dev/urandom', 'ro,nosuid,noexec,relatime', 'devtmpfs', 'devtmpfs', 'rw,size=4k,mode=755'],
                ['/proc', SEALED, 'proc', 'proc', 'rw,hidepid=invisible,subset=pid'],
            ]

        def render(table, optional=''):
            return ''.join(f'{100 + i} 99 0:{50 + i} / {r[0]} {r[1]} {optional}- {r[2]} {r[3]} {r[4]}\n' for i, r in enumerate(table))

        names = ['root', 'source', 'shared', 'executable', 'dep0', 'dep1', 'tmp', 'urandom', 'proc']
        cases = [('baseline', render(rows()), 0)]
        shuffled = rows(); shuffled.reverse()
        cases.append(('order does not matter', render(shuffled), 0))
        cases.append(('propagation fields', render(rows(), 'shared:5 master:2 propagate_from:3 '), 0))
        nested = rows() + [[SOURCE_PATH + '/nested\\040dir', SEALED, 'ext4', '/dev/vda9', 'rw'], [SHARED_PATH + '/nested', SEALED, 'ext4', '/dev/vda9', 'rw']]
        cases.append(('recursive source and guidance clones may nest', render(nested), 0))
        for index, name in enumerate(names):
            missing = rows(); del missing[index]
            cases.append((f'missing {name}', render(missing), 64))
            doubled = rows(); doubled.insert(index, list(doubled[index]))
            cases.append((f'duplicate {name}', render(doubled), 64))
        for point in ('/sys', '/dev', '/dev/null', '/dev/random', '/dev/urandomx', '/dev/urandom/x', '/proc/sys', '/proc/1', '/run', '/workspace', '/workspace/folders', SOURCE_PATH + '-two', SOURCE_PATH[:-1], '/instruction-reader/x', '/tmpx', '/tmp/x', '/lib', '/usr/lib', '/etc', '/home', '/run/winter', '/run/winter/instruction-reader', DEPENDENCIES[0] + '/x'):
            cases.append((f'unexpected mount {point}', render(rows() + [[point, SEALED, 'tmpfs', 'tmpfs', 'rw']]), 64))

        def changed(point, column, value):
            return render([r[:column] + [value] + r[column + 1:] if r[0] == point else r for r in rows()])

        for option in ('ro', 'nosuid', 'nodev', 'noexec'):
            weaker = SEALED.replace(option, 'rw' if option == 'ro' else 'x' + option)
            for point in ('/', SOURCE_PATH, SHARED_PATH, '/proc'):
                cases.append((f'{point} loses {option}', changed(point, 1, weaker), 64))
            cases.append((f'nested clone loses {option}', render(rows() + [[SOURCE_PATH + '/n', weaker, 'ext4', 'x', 'rw']]), 64))
        for point in ('/instruction-reader', DEPENDENCIES[0], DEPENDENCIES[1]):
            for weaker in ('rw,nosuid,nodev,relatime', 'ro,nodev,relatime', 'ro,nosuid,relatime', 'ro,nosuid,nodevx,relatime'):
                cases.append((f'{point} with {weaker}', changed(point, 1, weaker), 64))
            cases.append((f'{point} may also be noexec-free or noexec', changed(point, 1, 'ro,nosuid,nodev,noexec,relatime'), 0))
        for weaker in ('ro,nosuid,nodev,noexec,relatime', 'rw,nodev,noexec,relatime', 'rw,nosuid,noexec,relatime', 'rw,nosuid,nodev,relatime'):
            cases.append((f'/tmp with {weaker}', changed('/tmp', 1, weaker), 64))
        cases.append(('/tmp is not tmpfs', changed('/tmp', 2, 'ext4'), 64))
        cases.append(('/ is not tmpfs', changed('/', 2, 'ext4'), 64))
        for weaker in ('rw,nosuid,noexec,relatime', 'ro,nosuid,nodev,noexec,relatime', 'ro,noexec,relatime', 'ro,nosuid,relatime', 'ro,nosuid,noexec,nodev'):
            cases.append((f'/dev/urandom with {weaker}', changed('/dev/urandom', 1, weaker), 64))
        for weaker in ('rw,subset=pid', 'rw,hidepid=invisible', 'rw,hidepid=noaccess,subset=pid', 'rw,hidepid=ptraceable,subset=pid', 'rw,hidepid=off,subset=pid', 'rw,hidepid=2,subset=pid', 'rw,hidepid=invisibles,subset=pid', 'rw,hidepid=invisible,subset=pids', 'rw', 'rw,hidepid=invisible,subset=pid'.replace('subset', 'xsubset')):
            cases.append((f'/proc super options {weaker}', changed('/proc', 4, weaker), 64))
        cases.append(('/proc with extra gid option still passes', changed('/proc', 4, 'rw,gid=0,hidepid=invisible,subset=pid'), 0))
        cases.append(('/proc is tmpfs', changed('/proc', 2, 'tmpfs'), 64))
        # Malformed text fails closed.
        good = render(rows())
        for name, text in {
            'empty': '', 'no trailing newline': good[:-1], 'blank line': good + '\n', 'truncated line': good[:-12],
            'no separator': good.replace(' - ', ' '), 'surplus field': good.replace('pid\n', 'pid extra\n', 1),
            'missing super options': good.replace(' rw,hidepid=invisible,subset=pid', ''),
            'nine optional fields': render(rows(), 'a:1 b:2 c:3 d:4 e:5 f:6 g:7 h:8 i:9 '),
            'short head': '1 2 3\n' + good, 'double space': good.replace(' ro,nosuid', '  ro,nosuid', 1),
        }.items():
            cases.append((name, text, 64))
        with tempfile.TemporaryDirectory(prefix='winter-reader-mountinfo-') as directory:
            root = Path(directory)
            compiler = shutil.which('cc')
            self.assertIsNotNone(compiler)
            (root / 'mountinfo.c').write_text(harness)
            built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(root / 'mountinfo.c'), '-o', str(root / 'mountinfo')], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            for number, (name, text, expected) in enumerate(cases):
                with self.subTest(case=name):
                    (root / f'case-{number}.txt').write_text(text)
                    run = subprocess.run([str(root / 'mountinfo'), str(root / f'case-{number}.txt')], capture_output=True, text=True, timeout=3)
                    self.assertEqual(run.returncode, expected, name)

    def test_proc_and_descriptor_classifiers_are_exact(self):
        _, defines, contract, view, _, _ = self.parts()
        harness = r'''
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#pragma GCC diagnostic ignored "-Wunused-function"
@@DEFINES@@
@@CONTRACT@@
@@VIEW@@
int main(int argc,char **argv) {
    assert(argc>=2);
    if(!strcmp(argv[1],"proc")) {
        struct reader_proc_names seen={0,0,0};
        for(int i=2;i<argc;i++)if(!reader_proc_name(&seen,argv[i]))return 64;
        return seen.init==1?0:64;
    }
    unsigned int seen=0;int listing=atoi(argv[2]);
    for(int i=3;i<argc;i++)if(!reader_descriptor_name(&seen,listing,argv[i]))return 64;
    return seen==7U?0:64;
}
'''.replace('@@DEFINES@@', defines).replace('@@CONTRACT@@', contract).replace('@@VIEW@@', view)
        names = lambda text: text.split(',')
        proc = [('.,..,1,self,thread-self', 0), ('1', 0), ('self,1', 0), ('thread-self,self,1,.,..', 0),
                ('self,thread-self', 64), ('', 64), ('1,1', 64), ('1,self,self', 64), ('1,thread-self,thread-self', 64),
                ('1,2', 64), ('1,self,thread-self,2', 64), ('01', 64), ('10', 64), ('0', 64), ('1,sys', 64), ('1,cpuinfo', 64),
                ('1,self,thread-self,net', 64), ('1,Self', 64), ('1,self ', 64), ('1,1x', 64), ('1,-1', 64), ('1,18446744073709551617', 64), ('1,..,..,.', 0)]
        descriptors = [('3', '0,1,2,3', 0), ('3', '3,0,1,2,.,..', 0), ('3', '0,1,2', 0), ('4', '0,1,2,4', 0), ('3', '0,1,2,4', 64),
                       ('3', '0,1,3', 64), ('3', '0,1,2,3,5', 64), ('3', '1,2,3', 64), ('3', '0,0,1,2,3', 64), ('3', '0,1,2,64,3', 64),
                       ('3', '0,1,2,3,x', 64), ('3', '0,1,2,3,03', 64), ('3', '0,1,2,3,-1', 64), ('3', '0,1,2,3,65536', 64), ('3', '', 64), ('3', '0,1', 64),
                       ('3', '0,1,2,7,3', 64), ('3', '0,1,2,3,3.', 64)]
        with tempfile.TemporaryDirectory(prefix='winter-reader-names-') as directory:
            root = Path(directory); compiler = shutil.which('cc'); self.assertIsNotNone(compiler)
            (root / 'names.c').write_text(harness)
            built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(root / 'names.c'), '-o', str(root / 'names')], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            for text, expected in proc:
                with self.subTest(proc=text):
                    run = subprocess.run([str(root / 'names'), 'proc', *([] if text == '' else names(text))], capture_output=True, text=True, timeout=3)
                    self.assertEqual(run.returncode, expected)
            for listing, text, expected in descriptors:
                with self.subTest(listing=listing, descriptors=text):
                    run = subprocess.run([str(root / 'names'), 'fd', listing, *([] if text == '' else names(text))], capture_output=True, text=True, timeout=3)
                    self.assertEqual(run.returncode, expected)

    def test_final_view_checks_pass_and_fail_closed_with_distinct_labels(self):
        """The real extracted helpers run against an injected kernel world: no real /proc, device or mount."""
        _, defines, contract, view, require, helpers = self.parts()
        world = r'''
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#ifndef __APPLE__
#include <sys/sysmacros.h>
#endif
#pragma GCC diagnostic ignored "-Wunused-function"
#ifndef O_PATH
#define O_PATH 010000000
#endif
#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif
#ifndef OPEN_TREE_CLONE
#define OPEN_TREE_CLONE 1
#endif
#ifndef OPEN_TREE_CLOEXEC
#define OPEN_TREE_CLOEXEC O_CLOEXEC
#endif
#ifndef MOUNT_ATTR_RDONLY
#define MOUNT_ATTR_RDONLY 0x1
#define MOUNT_ATTR_NOSUID 0x2
#define MOUNT_ATTR_NODEV 0x4
#define MOUNT_ATTR_NOEXEC 0x8
#endif
#ifndef MS_PRIVATE
#define MS_PRIVATE (1UL<<18)
#endif
#define SYS_open_tree 428
#define SYS_mount_setattr 442
#define SYS_getdents64 217
struct mount_attr { uint64_t attr_set,attr_clr,propagation,userns_fd; };
@@DEFINES@@
@@REQUIRE@@
@@CONTRACT@@
@@VIEW@@

/* ---- injected world; every field is chosen by a key=value argument ---- */
static int world_pid=1,chunk=1000,open_fds[64];
static const char *proc_listing="1,self,thread-self",*fd_listing="0,1,2,@",*mountinfo_file="";
static const char *root_match="ok",*cwd_match="ok",*host_device="ok",*bound_device="ok",*kinds="ok",*corrupt="",*fault="";
static char mount_text[1<<20];static size_t mount_length,mount_offset;
static int faulted(const char *prefix,const char *what) {
    char want[160];snprintf(want,sizeof want,"%s:%s",prefix,what);return !strcmp(fault,want);
}
static void track(int fd){assert(fd>0&&fd<64&&!open_fds[fd]);open_fds[fd]=1;}
static int fake_open(const char *path,int flags,...) {
    int fd;
    if(faulted("open",path)){errno=ENOENT;return -1;}
    if(!strcmp(path,"/dev/urandom")&&flags==(O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC))fd=17;
    else if((!strcmp(path,"/dev/urandom")||!strcmp(path,"/view/dev/urandom"))&&flags==(O_PATH|O_NOFOLLOW|O_CLOEXEC))fd=18;
    else if(!strcmp(path,"/proc")&&flags==(O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC))fd=20;
    else if(!strcmp(path,"/proc/self/fd")&&flags==(O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC))fd=21;
    else if(!strcmp(path,"/proc/self/mountinfo")&&flags==(O_RDONLY|O_CLOEXEC))fd=22;
    else {fprintf(stderr,"unexpected open %s %d\n",path,flags);abort();}
    track(fd);return fd;
}
static int fake_close(int fd){assert(fd>0&&fd<64&&open_fds[fd]);open_fds[fd]=0;return 0;}
static int fake_fstat(int fd,struct stat *out) {
    memset(out,0,sizeof *out);
    char number[16];snprintf(number,sizeof number,"%d",fd);
    if(faulted("fstat",number)){errno=EBADF;return -1;}
    if(fd==17||fd==18) {
        const char *device=fd==17?host_device:bound_device;
        mode_t type=S_IFCHR;unsigned int major_number=1,minor_number=9;
        if(!strcmp(device,"file"))type=S_IFREG;
        if(!strcmp(device,"block"))type=S_IFBLK;
        if(!strcmp(device,"fifo"))type=S_IFIFO;
        if(!strcmp(device,"major2"))major_number=2;
        if(!strcmp(device,"minor8"))minor_number=8;
        out->st_mode=type|0666;out->st_rdev=makedev(major_number,minor_number);return 0;
    }
    assert(fd>=0&&fd<=2);
    out->st_mode=(!strcmp(kinds,"not-fifo")&&fd==1?S_IFREG:S_IFIFO)|0600;return 0;
}
static int fake_fcntl(int fd,int command,...) {
    if(command==F_GETFL) {
        if(fd==17)return !strcmp(host_device,"rdwr")?O_RDWR:O_RDONLY;
        if(!strcmp(kinds,"getfl-error")&&fd==1){errno=EBADF;return -1;}
        if(fd==0)return O_RDONLY;
        if(fd==1)return !strcmp(kinds,"wrong-mode")?O_RDONLY:O_WRONLY;
        if(fd==2)return O_WRONLY;
    }
    if(command==F_GETFD)return !strcmp(kinds,"cloexec")&&fd==2?FD_CLOEXEC:0;
    abort();
}
static int fake_stat(const char *path,struct stat *out) {
    if(faulted("stat",path)){errno=EACCES;return -1;}
    memset(out,0,sizeof *out);out->st_dev=7;
    if(!strcmp(path,"/"))out->st_ino=2;
    else if(!strcmp(path,"/proc/1/root")){out->st_ino=!strcmp(root_match,"ino")?3:2;if(!strcmp(root_match,"dev"))out->st_dev=8;}
    else if(!strcmp(path,"."))out->st_ino=5;
    else if(!strcmp(path,"/proc/1/cwd")){out->st_ino=!strcmp(cwd_match,"ino")?6:5;if(!strcmp(cwd_match,"dev"))out->st_dev=8;}
    else abort();
    return 0;
}
static pid_t fake_getpid(void){return world_pid;}
static ssize_t fake_read(int fd,void *buffer,size_t size) {
    assert(fd==22);
    if(!strcmp(fault,"read")){errno=EIO;return -1;}
    if(!strcmp(fault,"huge")){memset(buffer,'x',size);return (ssize_t)size;}
    size_t count=mount_length-mount_offset<size?mount_length-mount_offset:size;
    memcpy(buffer,mount_text+mount_offset,count);mount_offset+=count;return (ssize_t)count;
}
static size_t record(char *out,const char *name) {
    size_t length=(19+strlen(name)+1+7)&~(size_t)7;
    memset(out,0,length);
    uint64_t inode=1;int64_t offset=1;uint16_t reclen=(uint16_t)length;
    memcpy(out,&inode,8);memcpy(out+8,&offset,8);memcpy(out+16,&reclen,2);out[18]=4;strcpy(out+19,name);
    if(!strcmp(corrupt,"reclen-big")){reclen=4000;memcpy(out+16,&reclen,2);}
    if(!strcmp(corrupt,"reclen-small")){reclen=8;memcpy(out+16,&reclen,2);}
    if(!strcmp(corrupt,"no-nul"))memset(out+19,'x',length-19);
    return length;
}
static long fake_getdents(int fd,char *buffer,size_t size) {
    static int served[64];static int next[64];
    assert(fd==20||fd==21);assert(size==8192);
    if(faulted("getdents",fd==20?"proc":"fd")){errno=EIO;return -1;}
    if(!strcmp(fault,fd==20?"getdents-late:proc":"getdents-late:fd")&&served[fd]){errno=EIO;return -1;}
    served[fd]++;
    char names[1024];snprintf(names,sizeof names,".,..,%s",fd==20?proc_listing:fd_listing);
    char *save=NULL;size_t used=0;int index=0,emitted=0;
    for(char *name=strtok_r(names,",",&save);name;name=strtok_r(NULL,",",&save),index++) {
        if(index<next[fd])continue;
        char text[32];if(!strcmp(name,"@")){snprintf(text,sizeof text,"%d",fd);name=text;}
        if(emitted==chunk)break;
        used+=record(buffer+used,name);emitted++;next[fd]=index+1;
    }
    return (long)used;
}
static long fake_syscall(long call,...) {
    va_list args;va_start(args,call);
    if(call==SYS_getdents64) {
        int fd=va_arg(args,int);char *buffer=va_arg(args,char *);size_t size=va_arg(args,size_t);
        va_end(args);return fake_getdents(fd,buffer,size);
    }
    if(call==SYS_open_tree) {
        assert(va_arg(args,int)==17);assert(!strcmp(va_arg(args,const char *),""));
        assert(va_arg(args,int)==(OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH));va_end(args);
        if(!strcmp(fault,"open_tree")){errno=EPERM;return -1;}
        return 91;
    }
    assert(call==SYS_mount_setattr);
    assert(va_arg(args,int)==91);assert(!strcmp(va_arg(args,const char *),""));assert(va_arg(args,int)==AT_EMPTY_PATH);
    struct mount_attr *attr=va_arg(args,struct mount_attr *);assert(va_arg(args,size_t)==sizeof *attr);va_end(args);
    assert(attr->attr_set==(uint64_t)(MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NOEXEC));
    assert(attr->attr_clr==(uint64_t)MOUNT_ATTR_NODEV&&attr->propagation==MS_PRIVATE&&!attr->userns_fd);
    if(!strcmp(fault,"mount_setattr")){errno=EPERM;return -1;}
    return 0;
}
#define open fake_open
#define close fake_close
#define fstat fake_fstat
#define fcntl fake_fcntl
#define read fake_read
#define getpid fake_getpid
#define syscall fake_syscall
#define stat(path,out) fake_stat(path,out)

@@HELPERS@@

int main(int argc,char **argv) {
    assert(argc>=2);
@@PLAN@@
    for(int i=2;i<argc;i++) {
        char *equals=strchr(argv[i],'=');assert(equals);*equals=0;const char *value=equals+1,*key=argv[i];
        if(!strcmp(key,"pid"))world_pid=atoi(value);
        else if(!strcmp(key,"chunk"))chunk=atoi(value);
        else if(!strcmp(key,"proc"))proc_listing=value;
        else if(!strcmp(key,"fds"))fd_listing=value;
        else if(!strcmp(key,"mountinfo"))mountinfo_file=value;
        else if(!strcmp(key,"root"))root_match=value;
        else if(!strcmp(key,"cwd"))cwd_match=value;
        else if(!strcmp(key,"host"))host_device=value;
        else if(!strcmp(key,"bound"))bound_device=value;
        else if(!strcmp(key,"kinds"))kinds=value;
        else if(!strcmp(key,"corrupt"))corrupt=value;
        else if(!strcmp(key,"fault"))fault=value;
        else abort();
    }
    if(*mountinfo_file) {
        FILE *file=fopen(mountinfo_file,"rb");assert(file);
        mount_length=fread(mount_text,1,sizeof mount_text,file);fclose(file);
    }
    const char *function=argv[1];
    if(!strcmp(function,"entropy")){int tree=reader_entropy();assert(tree==91);}
    else if(!strcmp(function,"attached"))reader_entropy_identity("/view/dev/urandom","reader attached entropy identity");
    else if(!strcmp(function,"proc"))reader_proc_inventory();
    else if(!strcmp(function,"identity"))reader_proc_identity();
    else if(!strcmp(function,"mounts"))reader_mount_inventory(&plan);
    else if(!strcmp(function,"descriptors"))reader_descriptor_inventory();
    else if(!strcmp(function,"verify"))reader_verify_view(&plan);
    else abort();
    for(int fd=0;fd<64;fd++)assert(!open_fds[fd]); /* every injected descriptor was closed */
    return 0;
}
'''.replace('@@DEFINES@@', defines).replace('@@REQUIRE@@', require).replace('@@CONTRACT@@', contract).replace('@@VIEW@@', view).replace('@@HELPERS@@', helpers).replace('@@PLAN@@', PLAN_C)
        # The helper slice must be exactly the invariant code (no other native routine).
        self.assertTrue(helpers.startswith('static void reader_expect('))
        self.assertTrue(helpers.rstrip().endswith('}'))
        good_mountinfo = ''.join(f'{100 + i} 99 0:{50 + i} / {r[0]} {r[1]} - {r[2]} {r[3]} {r[4]}\n' for i, r in enumerate([
            ['/', SEALED, 'tmpfs', 'tmpfs', 'rw'], [SOURCE_PATH, SEALED, 'ext4', 'a', 'rw'], [SHARED_PATH, SEALED, 'ext4', 'a', 'rw'],
            ['/instruction-reader', 'ro,nosuid,nodev', 'ext4', 'a', 'rw'], [DEPENDENCIES[0], 'ro,nosuid,nodev', 'ext4', 'a', 'rw'], [DEPENDENCIES[1], 'ro,nosuid,nodev', 'ext4', 'a', 'rw'],
            ['/tmp', 'rw,nosuid,nodev,noexec', 'tmpfs', 'tmpfs', 'rw'], ['/dev/urandom', 'ro,nosuid,noexec', 'devtmpfs', 'devtmpfs', 'rw'],
            ['/proc', SEALED, 'proc', 'proc', 'rw,hidepid=invisible,subset=pid']]))
        compiler = shutil.which('cc')
        self.assertIsNotNone(compiler)
        with tempfile.TemporaryDirectory(prefix='winter-reader-world-') as directory:
            root = Path(directory)
            (root / 'world.c').write_text(world)
            (root / 'good.txt').write_text(good_mountinfo)
            (root / 'extra.txt').write_text(good_mountinfo + '200 99 0:70 / /sys ro,nosuid,nodev,noexec - sysfs sysfs rw\n')
            (root / 'noprocopts.txt').write_text(good_mountinfo.replace('hidepid=invisible,subset=pid', 'subset=pid'))
            (root / 'urandom-nodev.txt').write_text(good_mountinfo.replace('ro,nosuid,noexec', 'ro,nosuid,nodev,noexec'))
            built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(root / 'world.c'), '-o', str(root / 'world')], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            good = f'mountinfo={root / "good.txt"}'

            def check(function, expected_label, *arguments, error=None):
                run = subprocess.run([str(root / 'world'), function, *arguments], capture_output=True, text=True, timeout=5)
                if expected_label is None:
                    self.assertEqual((run.returncode, run.stderr), (0, ''), (function, arguments))
                else:
                    # exit 77 like every setup failure, exactly one audited perror line, the label first
                    self.assertEqual(run.returncode, 77, (function, arguments, run.stderr))
                    self.assertEqual(len(run.stderr.splitlines()), 1, run.stderr)
                    self.assertTrue(run.stderr.startswith(expected_label + ': '), (expected_label, run.stderr))
                    if error is not None:
                        self.assertEqual(run.stderr, f'{expected_label}: {os.strerror(getattr(errno, error))}\n', (function, arguments))

            # (A) entropy: identity before binding, clone and mount attributes.
            check('entropy', None)
            for device in ('file', 'block', 'fifo', 'major2', 'minor8', 'rdwr'):
                check('entropy', 'reader entropy identity', f'host={device}', error='ENODEV')
            check('entropy', 'reader entropy device', 'fault=open:/dev/urandom', error='ENOENT')
            check('entropy', 'reader entropy identity', 'fault=fstat:17', error='EBADF')
            check('entropy', 'reader entropy clone', 'fault=open_tree', error='EPERM')
            check('entropy', 'reader entropy mount flags', 'fault=mount_setattr', error='EPERM')
            # (A) entropy: identity after binding.
            check('attached', None)
            for device in ('file', 'block', 'fifo', 'major2', 'minor8'):
                check('attached', 'reader attached entropy identity', f'bound={device}', error='ENODEV')
            check('attached', 'reader attached entropy identity', 'fault=fstat:18', error='EBADF')
            check('attached', 'reader attached entropy identity', 'fault=open:/view/dev/urandom', error='ENOENT')
            # B1: only PID 1, plus self and thread-self; splits across getdents calls are fine.
            for listing in ('1,self,thread-self', 'self,thread-self,1', '1', 'thread-self,1'):
                for chunk in (1, 2, 1000):
                    check('proc', None, f'proc={listing}', f'chunk={chunk}')
            for listing in ('1,self,thread-self,2', '1,self,thread-self,10', '2', 'self,thread-self', '1,1', '1,self,self', '1,self,thread-self,sys', '1,self,thread-self,cpuinfo', '1,self,thread-self,net', '01', '1,self,thread-self,99999', ''):
                for chunk in (1, 1000):
                    check('proc', 'reader proc root inventory', f'proc={listing}', f'chunk={chunk}', error='ECHILD')
            for fault, error in (('getdents:proc', 'EIO'), ('getdents-late:proc', 'EIO'), ('open:/proc', 'ENOENT')):
                check('proc', 'reader proc root inventory', f'fault={fault}', 'chunk=1', error=error)
            for corrupt in ('reclen-big', 'reclen-small', 'no-nul'):
                check('proc', 'reader proc root inventory', f'corrupt={corrupt}', error='EBADMSG')
            # B2: this process is the namespace init, and /proc/1 names the sealed root and cwd.
            check('identity', None)
            check('identity', 'reader init process id', 'pid=2', error='ECHILD')
            check('identity', 'reader init process id', 'pid=0')
            for field in ('ino', 'dev'):
                check('identity', 'reader proc root identity', f'root={field}', error='EXDEV')
                check('identity', 'reader proc cwd identity', f'cwd={field}', error='EXDEV')
            for path in ('/', '/proc/1/root'):
                check('identity', 'reader proc root identity', f'fault=stat:{path}', error='EACCES')
            for path in ('.', '/proc/1/cwd'):
                check('identity', 'reader proc cwd identity', f'fault=stat:{path}', error='EACCES')
            # B4: the whole reachable mount list.
            check('mounts', None, good)
            check('mounts', 'reader mount inventory', f'mountinfo={root / "extra.txt"}', error='EBUSY')
            check('mounts', 'reader mount inventory', f'mountinfo={root / "noprocopts.txt"}')
            check('mounts', 'reader mount inventory', f'mountinfo={root / "urandom-nodev.txt"}')
            check('mounts', 'reader mount inventory', 'fault=open:/proc/self/mountinfo', error='ENOENT')
            check('mounts', 'reader mount inventory', 'fault=read', good, error='EIO')
            check('mounts', 'reader mount inventory', 'fault=huge', error='EFBIG')
            check('mounts', 'reader mount inventory', error='EBUSY')  # empty text
            # B5: the exec descriptor table is exactly 0, 1, 2 (the enumerating handle itself excluded).
            for listing in ('0,1,2,@', '@,0,1,2', '2,1,0,@', '0,1,2'):
                for chunk in (1, 1000):
                    check('descriptors', None, f'fds={listing}', f'chunk={chunk}')
            for listing in ('0,1,2,3,@', '0,1,2,5,@', '0,1,@', '0,2,@', '1,2,@', '0,0,1,2,@', '0,1,2,63,@', '0,1,2,x,@', '0,1,2,03,@', '@', ''):
                check('descriptors', 'reader descriptor inventory', f'fds={listing}', error='EBADF')
            check('descriptors', 'reader descriptor inventory', 'fault=getdents:fd', error='EIO')
            check('descriptors', 'reader descriptor inventory', 'fault=getdents-late:fd', 'chunk=1')
            check('descriptors', 'reader descriptor inventory', 'fault=open:/proc/self/fd', error='ENOENT')
            for kind in ('not-fifo', 'wrong-mode', 'getfl-error', 'cloexec'):
                check('descriptors', 'reader descriptor kind', f'kinds={kind}', error='EBADF')
            check('descriptors', 'reader descriptor kind', 'fault=fstat:0')
            # The composed final-view proof, and its stage order (first failing invariant wins).
            check('verify', None, good)
            check('verify', 'reader proc root inventory', good, 'proc=1,2')
            check('verify', 'reader init process id', good, 'pid=9')
            check('verify', 'reader proc root identity', good, 'root=ino')
            check('verify', 'reader final entropy identity', good, 'bound=minor8')
            check('verify', 'reader mount inventory', f'mountinfo={root / "extra.txt"}')
            check('verify', 'reader descriptor inventory', good, 'fds=0,1,2,3,@')
            check('verify', 'reader descriptor kind', good, 'kinds=wrong-mode')
            check('verify', 'reader proc root inventory', good, 'proc=1,2', 'pid=9', 'root=ino', 'bound=minor8', 'fds=0,1,2,3,@')
            check('verify', 'reader init process id', good, 'pid=9', 'root=ino', 'bound=minor8', 'fds=0,1,2,3,@')
            check('verify', 'reader proc root identity', good, 'root=ino', 'cwd=ino', 'bound=minor8', 'fds=0,1,2,3,@')
            check('verify', 'reader proc cwd identity', good, 'cwd=ino', 'bound=minor8', 'fds=0,1,2,3,@')
            check('verify', 'reader final entropy identity', f'mountinfo={root / "extra.txt"}', 'bound=minor8', 'fds=0,1,2,3,@')
            check('verify', 'reader mount inventory', f'mountinfo={root / "extra.txt"}', 'fds=0,1,2,3,@')

    def test_dependency_probe_prints_one_strict_line_and_nothing_else(self):
        probe = PROBE.read_text()
        block = probe.split('/* BEGIN PORTABLE PROBE LINE')[1].split('*/', 1)[1].split('/* END PORTABLE PROBE LINE */')[0]
        harness = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
@@BLOCK@@
int main(int argc,char **argv) {
    if(argc!=11)return 2;
    struct probe_report report;
    unsigned int *fields[]={&report.stack_rc,&report.stack_bounds,&report.stack_contains,&report.urandom_open,&report.urandom_read,
                            &report.getrandom_errno,&report.proc_list,&report.proc_numeric,&report.proc_root};
    for(int i=0;i<9;i++)*fields[i]=(unsigned int)strtoul(argv[i+1],NULL,10);
    char line[512];
    int length=probe_line(line,(size_t)atoi(argv[10]),&report);
    if(length<0)return 3;
    fwrite(line,1,(size_t)length,stdout);
    return 0;
}
'''.replace('@@BLOCK@@', block)
        grammar = re.compile(r'probe=reader-v1 stack_rc=(0|[1-9]\d{0,9}) stack_bounds=[01] stack_contains=[01] urandom_open=(0|[1-9]\d{0,9}) urandom_read=[01] '
                             r'getrandom=(0|[1-9]\d{0,9}) proc_list=(0|[1-9]\d{0,9}) proc_numeric=(0|[1-9]\d{0,9}) proc_root=[01]\n')
        compiler = shutil.which('cc')
        self.assertIsNotNone(compiler)
        with tempfile.TemporaryDirectory(prefix='winter-reader-probe-') as directory:
            root = Path(directory)
            (root / 'probe.c').write_text(harness)
            built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(root / 'probe.c'), '-o', str(root / 'probe')], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)

            def line(*values, size=512):
                run = subprocess.run([str(root / 'probe'), *map(str, values), str(size)], capture_output=True, text=True, timeout=3)
                return run.returncode, run.stdout

            healthy = line(0, 1, 1, 0, 1, 0, 0, 1, 1)
            self.assertEqual(healthy, (0, 'probe=reader-v1 stack_rc=0 stack_bounds=1 stack_contains=1 urandom_open=0 urandom_read=1 getrandom=0 proc_list=0 proc_numeric=1 proc_root=1\n'))
            unhealthy = line(2, 0, 0, 2, 0, 38, 2, 0, 0)
            self.assertEqual(unhealthy, (0, 'probe=reader-v1 stack_rc=2 stack_bounds=0 stack_contains=0 urandom_open=2 urandom_read=0 getrandom=38 proc_list=2 proc_numeric=0 proc_root=0\n'))
            maximum = line(*([4294967295] * 9))
            self.assertEqual(maximum[0], 0)
            self.assertEqual(maximum[1], 'probe=reader-v1 stack_rc=4294967295 stack_bounds=1 stack_contains=1 urandom_open=4294967295 urandom_read=1 getrandom=4294967295 proc_list=4294967295 proc_numeric=4294967295 proc_root=1\n')
            for values in [(0,) * 9, (13, 7, 9, 4095, 3, 99, 5, 65535, 2)]:
                code, text = line(*values)
                self.assertEqual(code, 0)
                self.assertTrue(grammar.fullmatch(text), text)
                self.assertEqual(text.count('\n'), 1)
            zero = line(*([0] * 9))
            self.assertTrue(grammar.fullmatch(zero[1]), zero)
            self.assertEqual(line(*([0] * 9), size=10)[0], 3)  # never a truncated line
            self.assertEqual(line(*([0] * 9), size=len(zero[1]))[0], 3)
            self.assertEqual(line(*([0] * 9), size=len(zero[1]) + 1), zero)
            # The documented grammar and the real format name the same keys in the same order.
            documented = re.findall(r'^ \*\s+"?\s*([a-z_]+)="', probe[:probe.index('#include')], re.MULTILINE)
            formatted = re.findall(r'([a-z_]+)=%u', probe[probe.index('snprintf'):probe.index('/* END PORTABLE PROBE LINE')])
            self.assertEqual(formatted, ['stack_rc', 'stack_bounds', 'stack_contains', 'urandom_open', 'urandom_read', 'getrandom', 'proc_list', 'proc_numeric', 'proc_root'])
            self.assertEqual(documented, formatted)
        # Source-level exposure gates: one fixed format, numbers only, nothing else printed.
        template = probe[probe.index('snprintf('):probe.index('/* END PORTABLE PROBE LINE')]
        self.assertEqual(sorted(set(re.findall(r'%[^ a-z]*[a-z]', template))), ['%u'])
        self.assertTrue(template.count('\\n"') == 1)
        executable = re.sub(r'/\*.*?\*/', '', probe, flags=re.DOTALL).replace('snprintf', '')
        for forbidden in ('printf', 'puts', 'perror', 'stderr', 'fwrite', 'fputs', 'putchar', '%p', '%s', '%x', '%c', 'maps', 'smaps', 'argv', 'environ', 'getenv', 'dlopen', 'fork', 'socket', 'execve', 'readlink', 'realpath'):
            self.assertNotIn(forbidden, executable, forbidden)
        self.assertEqual(probe.count('write('), 1)
        self.assertEqual(len(re.findall(r'write\(1,', probe)), 1)
        self.assertEqual(probe.count('explicit_bzero('), 2)  # after the device read and after getrandom
        self.assertIn('pthread_getattr_np(pthread_self()', probe)
        self.assertIn('#define PROBE_ENTROPY "/dev/urandom"', probe)
        code = re.sub(r'/\*.*?\*/', '', probe, flags=re.DOTALL)
        self.assertEqual(re.findall(r'"/[^"]*"', code.replace('PROBE_PROC "/1/root"', '')), ['"/dev/urandom"', '"/proc"', '"/"'])
        # The probe is standalone and unwired: not part of the compartment, nor named by it.
        self.assertNotIn('dependency-probe', SOURCE.read_text())
        self.assertNotIn('#include "linux-compartment.h"', probe)


if __name__ == '__main__':
    unittest.main()

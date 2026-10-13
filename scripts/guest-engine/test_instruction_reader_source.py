"""Portable extracted-C contract tests only; no native launcher/helper executes.

All syscall/filter/mount stand-ins are inert. These tests do not establish Linux
confinement, a measured reader artifact, honest Bun compatibility or cleanup.
"""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'packages/runtime/src/guest/linux-instruction-reader-compartment.c'


class ReaderSourceTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'complete Linux role compilation requires existing Linux headers/compiler; Mac portable tests are not full-role compilation')
    def test_full_linux_role_compile_only_never_execute(self):
        compiler = shutil.which('cc')
        self.assertIsNotNone(compiler, 'existing Linux C compiler required')
        with tempfile.TemporaryDirectory(prefix='winter-reader-compile-only-') as directory:
            output = Path(directory) / 'reader.o'
            built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-fPIE', '-c', str(SOURCE), '-o', str(output)], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
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
        self.assertNotIn('mount("proc"', source)
        self.assertNotIn('"/dev/', source)
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


if __name__ == '__main__':
    unittest.main()

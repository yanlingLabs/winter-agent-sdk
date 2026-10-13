"""Fault-injected fixture helper; no device, namespace or mount is opened."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class FixtureStdinDeviceTests(unittest.TestCase):
    def test_identity_and_mount_failures_refuse_before_tool_start(self):
        compiler = shutil.which('cc')
        if not compiler:
            self.skipTest('existing portable C compiler unavailable')
        source = (ROOT / 'scripts/guest-files/compartment.c').read_text()
        helper = source[source.index('static int null_mount(void)'):source.index('int main(')]
        header = (ROOT / 'packages/runtime/src/guest/linux-compartment.h').read_text()
        require = header[header.index('static inline void require('):header.index('static inline void path(')]
        standin = r'''
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
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
#define SYS_open_tree 428
#define SYS_mount_setattr 442
#define AT_EMPTY_PATH 0x1000
#define OPEN_TREE_CLONE 1
#define OPEN_TREE_CLOEXEC O_CLOEXEC
#define MOUNT_ATTR_RDONLY 1
#define MOUNT_ATTR_NOSUID 2
#define MOUNT_ATTR_NODEV 4
#define MOUNT_ATTR_NOEXEC 8
#define MS_PRIVATE (1UL << 18)
struct mount_attr { uint64_t attr_set,attr_clr,propagation,userns_fd; };
static int fault,opened,cloned,flags_set,closed;
static int fake_open(const char *name,int flags,...){
 assert(!strcmp(name,"/dev/null"));assert(flags==(O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));opened++;
 if(fault==1){errno=ENOENT;return -1;}return 17;
}
static int fake_fstat(int fd,struct stat *out){
 assert(fd==17&&opened==1);memset(out,0,sizeof *out);
 if(fault==2){errno=EBADF;return -1;}
 out->st_mode=fault==3?S_IFREG:fault==4?S_IFBLK:S_IFCHR;
 out->st_rdev=makedev(fault==5?2:1,fault==6?9:3);return 0;
}
static int fake_fcntl(int fd,int cmd,...){assert(fd==17&&cmd==F_GETFL);return fault==7?O_WRONLY:fault==8?-1:O_RDONLY;}
static long fake_syscall(long call,...){
 assert(fault==0||fault==9||fault==10);va_list args;va_start(args,call);
 if(call==SYS_open_tree){
  assert(va_arg(args,int)==17&&!strcmp(va_arg(args,const char *),""));
  assert(va_arg(args,int)==(OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH));cloned++;
  va_end(args);if(fault==9){errno=EINVAL;return -1;}return 91;
 }
 assert(call==SYS_mount_setattr&&cloned==1);assert(va_arg(args,int)==91&&!strcmp(va_arg(args,const char *),""));
 assert(va_arg(args,int)==AT_EMPTY_PATH);struct mount_attr *a=va_arg(args,struct mount_attr *);
 assert(va_arg(args,size_t)==sizeof *a);assert(a->attr_set==(MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NOEXEC));
 assert(a->attr_clr==MOUNT_ATTR_NODEV&&a->propagation==MS_PRIVATE&&a->userns_fd==0);flags_set++;
 va_end(args);if(fault==10){errno=EPERM;return -1;}return 0;
}
static int fake_close(int fd){assert(fd==17&&cloned==1&&flags_set==1);closed++;return 0;}
#define open fake_open
#define fstat fake_fstat
#define fcntl fake_fcntl
#define syscall fake_syscall
#define close fake_close
'''
        harness = r'''
int main(int argc,char **argv){assert(argc==2);fault=atoi(argv[1]);int tree=null_mount();
 assert(fault==0&&tree==91&&opened==1&&cloned==1&&flags_set==1&&closed==1);return 0;}
'''
        with tempfile.TemporaryDirectory(prefix='winter-fixture-stdin-') as temp:
            code, binary = Path(temp) / 'test.c', Path(temp) / 'test'
            code.write_text(standin + require + helper + harness)
            built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(code), '-o', str(binary)], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            for fault in range(11):
                with self.subTest(fault=fault):
                    result = subprocess.run([str(binary), str(fault)], capture_output=True, text=True, timeout=3)
                    expected = 0 if fault == 0 else 64 if 3 <= fault <= 8 else 77
                    self.assertEqual(result.returncode, expected, result.stderr)


if __name__ == '__main__':
    unittest.main()

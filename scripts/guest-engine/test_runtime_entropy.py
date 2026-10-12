"""Exact runtime entropy identity/mount helper with injected metadata/syscalls.
No real device open, root, mount, namespace, native-helper or guest ELF executes.
"""
import shutil,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
class RuntimeEntropyTests(unittest.TestCase):
    def test_exact_helper_requires_kernel_device_and_descriptor_mount_flags(self):
        compiler=shutil.which('cc')
        if not compiler:self.skipTest('existing portable C compiler unavailable')
        source=(ROOT/'packages/runtime/src/guest/linux-runtime-compartment.c').read_text()
        start=source.index('static int urandom_mount(void)')
        helper=source[start:source.index('static void attach(',start)]
        header=(ROOT/'packages/runtime/src/guest/linux-compartment.h').read_text();at=header.index('static inline void require(')
        require=header[at:header.index('static inline void path(',at)]
        prelude=r'''
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
#define MOUNT_ATTR_RDONLY 0x1
#define MOUNT_ATTR_NOSUID 0x2
#define MOUNT_ATTR_NODEV 0x4
#define MOUNT_ATTR_NOEXEC 0x8
#define MS_PRIVATE (1UL << 18)
struct mount_attr { uint64_t attr_set,attr_clr,propagation,userns_fd; };
static int mode,opened,stat_calls,trees,attributes,closed;
static int fake_open(const char *name,int flags,...){
 assert(!strcmp(name,"/dev/urandom"));assert(flags==(O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));assert(!opened++);
 if(mode==8){errno=ENOENT;return -1;}return 17;
}
static int fake_fstat(int fd,struct stat *out){
 assert(fd==17);stat_calls++;memset(out,0,sizeof *out);
 if(mode==7){errno=EBADF;return -1;}
 out->st_mode=(mode==1?S_IFREG:mode==2?S_IFBLK:S_IFCHR)|0444;
 out->st_rdev=makedev(mode==3?2:1,mode==4?8:9);return 0;
}
static int fake_fcntl(int fd,int command,...){assert(fd==17&&command==F_GETFL);return mode==5?O_RDWR:mode==6?O_WRONLY:O_RDONLY;}
static long fake_syscall(long call,...){
 assert(mode==0||mode==9||mode==10); /* identity refusals precede all mount effects */
 va_list args;va_start(args,call);
 if(call==SYS_open_tree){
  assert(va_arg(args,int)==17);assert(!strcmp(va_arg(args,const char *),""));
  assert(va_arg(args,int)==(OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH));
  trees++;if(mode==9){errno=EINVAL;va_end(args);return -1;}va_end(args);return 91;
 }
 assert(call==SYS_mount_setattr);assert(va_arg(args,int)==91);assert(!strcmp(va_arg(args,const char *),""));assert(va_arg(args,int)==AT_EMPTY_PATH);
 struct mount_attr *attr=va_arg(args,struct mount_attr *);assert(va_arg(args,size_t)==sizeof *attr);
 assert(attr->attr_set==(MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NOEXEC));assert(!(attr->attr_set&MOUNT_ATTR_NODEV));assert(attr->attr_clr==MOUNT_ATTR_NODEV);assert(attr->propagation==MS_PRIVATE&&!attr->userns_fd);
 attributes++;va_end(args);if(mode==10){errno=EPERM;return -1;}return 0;
}
static int fake_close(int fd){assert(fd==17);closed++;return 0;}
#define open fake_open
#define fstat fake_fstat
#define fcntl fake_fcntl
#define syscall fake_syscall
#define close fake_close
'''
        harness=r'''
int main(int argc,char **argv){assert(argc==2);mode=atoi(argv[1]);int tree=urandom_mount();
 assert(!mode);assert(tree==91&&opened==1&&stat_calls==1&&trees==1&&attributes==1&&closed==1);return 0;}
'''
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);code=root/'exact-entropy.c';binary=root/'exact-entropy';code.write_text(prelude+require+helper+harness)
            result=subprocess.run([compiler,'-std=c11','-O2','-Wall','-Wextra','-Werror',str(code),'-o',str(binary)],capture_output=True,text=True,timeout=30);self.assertEqual(result.returncode,0,result.stderr)
            for mode in range(11):
                with self.subTest(case=mode):
                    result=subprocess.run([str(binary),str(mode)],capture_output=True,text=True,timeout=3)
                    expected=0 if mode==0 else 64 if mode in range(1,7) else 77
                    self.assertEqual(result.returncode,expected,result.stderr)
    def test_runtime_only_attachment_keeps_general_nodev_and_existing_checks(self):
        source=(ROOT/'packages/runtime/src/guest/linux-runtime-compartment.c').read_text()
        self.assertEqual(source.count('int entropytree=urandom_mount();'),1)
        self.assertEqual(source.count('point(root,"/dev/urandom",target,1);attach(entropytree,target);'),1)
        self.assertLess(source.index('int entropytree=urandom_mount();'),source.index('require(unshare('))
        self.assertIn('.attr_set=MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV|(ro?MOUNT_ATTR_RDONLY:0)',source)
        self.assertIn('MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV',source)
        tool=(ROOT/'packages/runtime/src/guest/linux-tool-compartment.c').read_text();self.assertNotIn('/dev/urandom',tool)
if __name__=='__main__':unittest.main()

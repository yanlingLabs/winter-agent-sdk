"""Exact detached-clone helpers with portable syscall stand-ins only.
No real mount, namespace, device, native launcher or guest ELF executes.
"""
import shutil, subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class MountPropagationTests(unittest.TestCase):
    def test_both_exact_clone_helpers_privatize_before_return_and_fail_closed(self):
        compiler = shutil.which('cc')
        if not compiler:
            self.skipTest('existing portable C compiler unavailable')
        header = (ROOT / 'packages/runtime/src/guest/linux-compartment.h').read_text()
        start = header.index('static inline void require(')
        require = header[start:header.index('static inline void path(', start)]
        prelude = r'''
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
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
static int fault,readonly,executable,cloned,configured;
static long fake_syscall(long call,...) {
    va_list args;va_start(args,call);
    if(call==SYS_open_tree) {
        assert(!cloned++&&!configured);
        assert(va_arg(args,int)==17);assert(!strcmp(va_arg(args,const char *),""));
        assert(va_arg(args,int)==(OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH));
        va_end(args);if(fault==1){errno=EINVAL;return -1;}return 91;
    }
    assert(call==SYS_mount_setattr&&cloned==1&&!configured++);
    assert(va_arg(args,int)==91);assert(!strcmp(va_arg(args,const char *),""));
    assert(va_arg(args,int)==AT_EMPTY_PATH);
    struct mount_attr *attr=va_arg(args,struct mount_attr *);
    assert(va_arg(args,size_t)==sizeof *attr);
    assert(attr->attr_set==(uint64_t)(MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV|(readonly?MOUNT_ATTR_RDONLY:0)|(executable?0:MOUNT_ATTR_NOEXEC)));
    assert(!attr->attr_clr&&!attr->userns_fd&&attr->propagation==MS_PRIVATE);
    va_end(args);if(fault==2){errno=EPERM;return -1;}return 0;
}
#define syscall fake_syscall
'''
        for filename, function, end in (
            ('linux-runtime-compartment.c', 'clone_mount', '/* Only the trusted runtime'),
            ('linux-tool-compartment.c', 'clone_descriptor', 'static void attach_descriptor('),
        ):
            source = (ROOT / 'packages/runtime/src/guest' / filename).read_text()
            start = source.index('static int ' + function + '(')
            helper = source[start:source.index(end, start)]
            harness = r'''
int main(int argc,char **argv) {
    assert(argc==4);fault=atoi(argv[1]);readonly=atoi(argv[2]);executable=atoi(argv[3]);
    int tree=HELPER(17,readonly,executable);
    assert(!fault&&tree==91&&cloned==1&&configured==1);return 0;
}
'''.replace('HELPER', function)
            with tempfile.TemporaryDirectory(prefix='winter-mount-propagation-') as directory:
                code = Path(directory) / 'stand-in.c'; binary = Path(directory) / 'stand-in'
                code.write_text(prelude + require + helper + harness)
                build = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(code), '-o', str(binary)], capture_output=True, text=True, timeout=30)
                self.assertEqual(build.returncode, 0, build.stderr)
                for readonly in (0, 1):
                    for executable in (0, 1):
                        for fault in (0, 1, 2):
                            with self.subTest(helper=function, readonly=readonly, executable=executable, fault=fault):
                                run = subprocess.run([str(binary), str(fault), str(readonly), str(executable)], capture_output=True, text=True, timeout=3)
                                self.assertEqual(run.returncode, 0 if fault == 0 else 77, run.stderr)

    def test_namespace_root_stays_recursively_private_before_attachment(self):
        for filename, attach in (('linux-runtime-compartment.c', 'attach(trees[i],target)'), ('linux-tool-compartment.c', 'attach_descriptor(root_trees[i],target)')):
            source = (ROOT / 'packages/runtime/src/guest' / filename).read_text()
            self.assertLess(source.index('mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL)'), source.index(attach))


if __name__ == '__main__':
    unittest.main()

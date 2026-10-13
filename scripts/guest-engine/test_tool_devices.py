"""Exact tool-device helpers with portable metadata/filesystem/syscall stand-ins.
No real devices, root, namespace, mount, helper, guest ELF or VM executes.
"""
import shutil, subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'packages/runtime/src/guest/linux-tool-compartment.c'
HEADER = ROOT / 'packages/runtime/src/guest/linux-compartment.h'
PRELUDE = r'''
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
'''


class ToolDeviceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compiler = shutil.which('cc')
        if not cls.compiler:
            raise unittest.SkipTest('existing portable C compiler unavailable')
        cls.source = SOURCE.read_text()
        header = HEADER.read_text()
        start = header.index('static inline void require(')
        cls.require = header[start:header.index('static inline void path(', start)]
        start = header.index('static inline void path(')
        cls.path = header[start:header.index('static inline void guest_bind(', start)]

    def compile_harness(self, root, text):
        code, binary = root / 'stand-in.c', root / 'stand-in'
        code.write_text(text)
        result = subprocess.run([self.compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(code), '-o', str(binary)], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return binary

    def test_exact_inventory_pins_each_character_identity_and_mounts_only_held_fd(self):
        start = self.source.index('struct tool_device {')
        helper = self.source[start:self.source.index('struct tool_fd_link {', start)]
        standins = r'''
static const char *expected_names[]={"/dev/null","/dev/zero","/dev/full","/dev/random","/dev/urandom"};
static const unsigned expected_minors[]={3,5,7,8,9};
static int mode,index_device,slot,opened,stated,checked,cloned,flags_set,closed;
static int fake_open(const char *name,int flags,...){
 assert(!strcmp(name,expected_names[index_device]));assert(flags==(O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));assert(!opened++);
 if(mode==8||mode==13){errno=mode==8?ENOENT:ELOOP;return -1;}return slot;
}
static int fake_fstat(int fd,struct stat *out){
 assert(fd==slot&&!closed&&opened==1);stated++;memset(out,0,sizeof *out);
 if(mode==7){errno=EBADF;return -1;}
 out->st_mode=(mode==1?S_IFREG:mode==2?S_IFBLK:mode==12?S_IFIFO:S_IFCHR)|0666;
 out->st_rdev=makedev(mode==3?2:1,mode==4?expected_minors[index_device]+1:expected_minors[index_device]);return 0;
}
static int fake_fcntl(int fd,int command,...){
 assert(fd==slot&&!closed&&command==F_GETFL);checked++;
 return mode==5?O_WRONLY:mode==6?O_RDWR:mode==11?-1:O_RDONLY;
}
static long fake_syscall(long call,...){
 assert(mode==0||mode==9||mode==10);assert(!closed&&opened==1&&stated==1&&checked==1);
 va_list args;va_start(args,call);
 if(call==SYS_open_tree){
  assert(va_arg(args,int)==slot);assert(!strcmp(va_arg(args,const char *),""));
  assert(va_arg(args,int)==(OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH));assert(!cloned++);
  va_end(args);if(mode==9){errno=EINVAL;return -1;}return 1000+index_device;
 }
 assert(call==SYS_mount_setattr&&cloned==1);assert(va_arg(args,int)==1000+index_device);
 assert(!strcmp(va_arg(args,const char *),""));assert(va_arg(args,int)==AT_EMPTY_PATH);
 struct mount_attr *attr=va_arg(args,struct mount_attr *);assert(va_arg(args,size_t)==sizeof *attr);
 assert(attr->attr_set==(MOUNT_ATTR_RDONLY|MOUNT_ATTR_NOSUID|MOUNT_ATTR_NOEXEC));assert(attr->attr_clr==MOUNT_ATTR_NODEV);
 assert(attr->propagation==MS_PRIVATE&&!attr->userns_fd);assert(!flags_set++);va_end(args);
 if(mode==10){errno=EPERM;return -1;}return 0;
}
static int fake_close(int fd){assert(fd==slot&&flags_set==1);assert(!closed++);return 0;}
#define open fake_open
#define fstat fake_fstat
#define fcntl fake_fcntl
#define syscall fake_syscall
#define close fake_close
'''
        harness = r'''
int main(int argc,char **argv){
 assert(argc==4);mode=atoi(argv[1]);index_device=atoi(argv[2]);slot=atoi(argv[3]);
 assert(TOOL_DEVICE_COUNT==5&&index_device>=0&&index_device<5);
 for(size_t i=0;i<TOOL_DEVICE_COUNT;i++){assert(!strcmp(tool_devices[i].name,expected_names[i]));assert(tool_devices[i].minor==expected_minors[i]);}
 int tree=tool_device_mount(&tool_devices[index_device]);assert(!mode&&tree==1000+index_device);
 assert(opened==1&&stated==1&&checked==1&&cloned==1&&flags_set==1&&closed==1);return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix='winter-tool-device-source-') as temp:
            binary = self.compile_harness(Path(temp), PRELUDE + self.require + standins + helper + harness)
            for device in range(5):
                for mode in range(14):
                    with self.subTest(device=device, fault=mode):
                        result = subprocess.run([str(binary), str(mode), str(device), '17'], capture_output=True, text=True, timeout=3)
                        expected = 0 if mode == 0 else 77 if mode in (7, 8, 9, 10, 13) else 64
                        self.assertEqual(result.returncode, expected, result.stderr)
                # No remap to fd3/fd4 is added: the held device FD may occupy either
                # slot or a higher slot, is cloned directly, then closed.
                for slot in (3, 4, 64, 97):
                    with self.subTest(device=device, descriptor_slot=slot):
                        result = subprocess.run([str(binary), '0', str(device), str(slot)], capture_output=True, text=True, timeout=3)
                        self.assertEqual(result.returncode, 0, result.stderr)

    def test_exact_view_has_only_fixed_nodes_proc_links_and_capped_private_shm(self):
        start = self.source.index('struct tool_device {')
        inventory = self.source[start:self.source.index('static int tool_device_mount(', start)]
        start = self.source.index('struct tool_fd_link {')
        links = self.source[start:self.source.index('static void point(', start)]
        start = self.source.index('static void tool_device_view(')
        view = self.source[start:self.source.index('int main(', start)]
        standins = r'''
#define MS_RDONLY 1
#define MS_NOSUID 2
#define MS_NODEV 4
#define MS_NOEXEC 8
static int mode,points,opened,closed,attached,mounted,linked;
static const char *expected_dirs[]={"/dev","/proc","/dev/shm"};
static const char *expected_nodes[]={"null","zero","full","random","urandom"};
static const char *expected_links[]={"fd","stdin","stdout","stderr"};
static const char *expected_targets[]={"/proc/self/fd","/proc/self/fd/0","/proc/self/fd/1","/proc/self/fd/2"};
static void point(const char *root,const char *guest,char *out,size_t size){
 assert(!strcmp(root,"/fixture-view"));assert(points<3&&!strcmp(guest,expected_dirs[points++]));
 path(out,size,root,guest+1);
}
static int fake_open(const char *name,int flags,...){
 char expected[128];assert(opened<5);snprintf(expected,sizeof expected,"/fixture-view/dev/%s",expected_nodes[opened]);
 assert(!strcmp(name,expected));assert(flags==(O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC));
 va_list args;va_start(args,flags);assert(va_arg(args,int)==0666);va_end(args);opened++;
 if(mode==1){errno=EEXIST;return -1;}return 200+opened;
}
static int fake_close(int fd){
 if(fd<0){errno=EBADF;return -1;}assert(fd==201+closed++);return 0;
}
static void attach_descriptor(int tree,const char *target){
 char expected[128];assert(attached<5&&closed==attached+1&&opened==attached+1);
 snprintf(expected,sizeof expected,"/fixture-view/dev/%s",expected_nodes[attached]);assert(!strcmp(target,expected));
 assert(tree==1000+attached++);
}
static int fake_mount(const char *source,const char *target,const char *type,unsigned long flags,const void *data){
 assert(attached==5);assert(mounted<2);
 if(!mounted){assert(points==2&&!strcmp(source,"proc")&&!strcmp(type,"proc")&&!strcmp(target,"/fixture-view/proc"));assert(flags==(MS_RDONLY|MS_NOSUID|MS_NODEV|MS_NOEXEC)&&!data);}
 else{assert(points==3&&linked==4&&!strcmp(source,"tmpfs")&&!strcmp(type,"tmpfs")&&!strcmp(target,"/fixture-view/dev/shm"));assert(flags==(MS_NOSUID|MS_NODEV|MS_NOEXEC));assert(data&&!strcmp(data,"mode=1777,size=8m"));}
 mounted++;if(mode==2){errno=EPERM;return -1;}return 0;
}
static int fake_symlink(const char *source,const char *target){
 char expected[128];assert(mounted==1&&linked<4);assert(!strcmp(source,expected_targets[linked]));
 snprintf(expected,sizeof expected,"/fixture-view/dev/%s",expected_links[linked]);assert(!strcmp(target,expected));linked++;
 if(mode==3){errno=EEXIST;return -1;}return 0;
}
#define open fake_open
#define close fake_close
#define mount fake_mount
#define symlink fake_symlink
'''
        harness = r'''
int main(int argc,char **argv){assert(argc==2);mode=atoi(argv[1]);int trees[]={1000,1001,1002,1003,1004};
 tool_device_view("/fixture-view",trees);assert(!mode&&points==3&&opened==5&&closed==5&&attached==5&&mounted==2&&linked==4);return 0;}
'''
        with tempfile.TemporaryDirectory(prefix='winter-tool-view-source-') as temp:
            binary = self.compile_harness(Path(temp), PRELUDE + self.require + self.path + inventory + links + standins + view + harness)
            for mode in range(4):
                with self.subTest(fault=mode):
                    result = subprocess.run([str(binary), str(mode)], capture_output=True, text=True, timeout=3)
                    self.assertEqual(result.returncode, 0 if mode == 0 else 77, result.stderr)

    def test_process_only_devices_keep_existing_descriptor_cleanup_and_fences(self):
        self.assertEqual(self.source.count('if(process)for(size_t i=0;i<TOOL_DEVICE_COUNT;i++)device_trees[i]=tool_device_mount(&tool_devices[i]);'), 1)
        self.assertLess(self.source.index('device_trees[i]=tool_device_mount('), self.source.index('require(unshare('))
        process_view = self.source.index('    if(process){')
        self.assertLess(self.source.index('pid_t child=fork();'), self.source.index('tool_device_view(root,device_trees);'))
        self.assertIn('tool_device_view(root,device_trees);', self.source[process_view:self.source.index('    path(target,sizeof target,root,"file-worker")')])
        self.assertLess(self.source.index('tool_device_view(root,device_trees);'), self.source.index('"protected skeleton"'))
        self.assertIn('MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV', self.source)
        self.assertIn('.attr_set=MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV|(readonly?MOUNT_ATTR_RDONLY:0)', self.source)
        self.assertIn('CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWNET|CLONE_NEWPID', self.source)
        self.assertIn('require(syscall(SYS_close_range,3U,~0U,0U),"close private inherited descriptors");install_filter(process)', self.source)
        self.assertNotIn('dup2(', self.source)
        self.assertNotIn('mknod(', self.source)
        self.assertNotIn('"devpts"', self.source)
        self.assertNotIn('mount("/dev"', self.source)
        self.assertNotIn('mount("/proc"', self.source)
        self.assertIn('while(waitpid(child,&status,0)<0)', self.source)
        self.assertIn('syscall(SYS_capset,&header,caps)', self.source)

    def test_exact_general_detached_mount_is_private_and_refuses_flag_failure(self):
        start = self.source.index('static int clone_descriptor(')
        helper = self.source[start:self.source.index('static void attach_descriptor(', start)]
        standins = r'''
static int fault,readonly,executable,cloned,attributes;
static long fake_syscall(long call,...){
 va_list args;va_start(args,call);
 if(call==SYS_open_tree){assert(va_arg(args,int)==17);assert(!strcmp(va_arg(args,const char *),""));assert(va_arg(args,int)==(OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH));cloned++;va_end(args);if(fault==1){errno=EINVAL;return -1;}return 91;}
 assert(call==SYS_mount_setattr&&cloned==1);assert(va_arg(args,int)==91);assert(!strcmp(va_arg(args,const char *),""));assert(va_arg(args,int)==AT_EMPTY_PATH);
 struct mount_attr *attr=va_arg(args,struct mount_attr *);assert(va_arg(args,size_t)==sizeof *attr);va_end(args);
 assert(attr->attr_set==(uint64_t)(MOUNT_ATTR_NOSUID|MOUNT_ATTR_NODEV|(readonly?MOUNT_ATTR_RDONLY:0)|(executable?0:MOUNT_ATTR_NOEXEC)));
 assert(!attr->attr_clr&&attr->propagation==MS_PRIVATE&&!attr->userns_fd);attributes++;if(fault==2){errno=EPERM;return -1;}return 0;
}
#define syscall fake_syscall
'''
        harness = r'''
int main(int argc,char **argv){assert(argc==4);fault=atoi(argv[1]);readonly=atoi(argv[2]);executable=atoi(argv[3]);assert(clone_descriptor(17,readonly,executable)==91);assert(!fault&&cloned==1&&attributes==1);return 0;}
'''
        with tempfile.TemporaryDirectory(prefix='winter-tool-private-clone-') as temp:
            binary = self.compile_harness(Path(temp), PRELUDE + self.require + standins + helper + harness)
            for fault in range(3):
                for readonly in range(2):
                    for executable in range(2):
                        with self.subTest(fault=fault, readonly=readonly, executable=executable):
                            result = subprocess.run([str(binary), str(fault), str(readonly), str(executable)], capture_output=True, text=True, timeout=3)
                            self.assertEqual(result.returncode, 0 if fault == 0 else 77, result.stderr)


if __name__ == '__main__':
    unittest.main()

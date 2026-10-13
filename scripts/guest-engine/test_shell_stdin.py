"""Exact child stdin helper with ordinary pipes and injected device metadata.
No device, root, namespace, native helper, guest ELF or VM executes.
"""
import shutil, subprocess, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'packages/runtime/src/guest/process-worker.c'


class ShellStdinTests(unittest.TestCase):
    def test_exact_helper_replaces_live_command_fd0_and_preserves_fd0_alias(self):
        compiler = shutil.which('cc')
        if not compiler:
            self.skipTest('existing portable C compiler unavailable')
        source = SOURCE.read_text()
        start = source.index('static void shell_stdin(void)')
        helper = source[start:source.index('int main(', start)]
        prelude = r'''
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#ifndef __APPLE__
#include <sys/sysmacros.h>
#endif
static int mode,input,opened,stated,checked,remapped,cleared,closed;
static int fake_open(const char *name,int flags,...){
 assert(!strcmp(name,"/dev/null"));assert(flags==(O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));assert(!opened++);
 if(mode==5){errno=ENOENT;return -1;}return input;
}
static int fake_fstat(int fd,struct stat *out){
 assert(fd==input&&opened==1&&!closed);stated++;memset(out,0,sizeof *out);
 if(mode==6){errno=EBADF;return -1;}
 out->st_mode=(mode==2?S_IFREG:mode==10?S_IFBLK:S_IFCHR)|0666;
 out->st_rdev=makedev(mode==3?2:1,mode==4?9:3);return 0;
}
static int fake_fcntl(int fd,int command,...){
 if(command==F_GETFL){assert(fd==input&&!closed);checked++;return mode==7?O_WRONLY:mode==11?-1:fcntl(fd,command);}
 assert(command==F_SETFD&&fd==0&&remapped==1);va_list args;va_start(args,command);int flags=va_arg(args,int);va_end(args);
 assert(flags==0);cleared++;if(mode==9){errno=EPERM;return -1;}return fcntl(fd,command,flags);
}
static int fake_dup2(int source,int target){
 assert(source==input&&target==0&&stated==1&&checked==1&&!closed);assert(mode==0||mode==1||mode==8||mode==9);remapped++;
 if(mode==8){errno=EBADF;return -1;}return dup2(source,target);
}
static int fake_close(int fd){assert(fd==input&&input!=0&&cleared==1);closed++;return close(fd);}
#define open fake_open
#define fstat fake_fstat
#define fcntl fake_fcntl
#define dup2 fake_dup2
#define close fake_close
'''
        harness = r'''
#undef open
#undef fstat
#undef fcntl
#undef dup2
#undef close
int main(int argc,char **argv){
 assert(argc==3);mode=atoi(argv[1]);int slot=atoi(argv[2]);
 int command[2];assert(pipe(command)==0);assert(write(command[1],"not-shell-input",15)==15);close(command[1]);
 assert(dup2(command[0],0)==0);close(command[0]);
 int eof[2];assert(pipe(eof)==0);close(eof[1]);
 input=mode==1?0:slot;
 if(eof[0]!=input){assert(dup2(eof[0],input)==input);close(eof[0]);}
 assert(fcntl(input,F_SETFD,FD_CLOEXEC)==0);
 /* Success must replace this readable original fd0 rather than inherit its
  * remaining command payload. Alias mode models fd0 already closed at open. */
 shell_stdin();assert(mode==0||mode==1);
 assert(opened==1&&stated==1&&checked==1&&remapped==1&&cleared==1&&closed==(input!=0));
 assert(fcntl(0,F_GETFD)==0);char byte;assert(read(0,&byte,1)==0);
 if(input!=0){assert(fcntl(input,F_GETFD)==-1&&errno==EBADF);}
 close(0);return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix='winter-shell-stdin-source-') as temp:
            root = Path(temp)
            code, binary = root / 'stand-in.c', root / 'stand-in'
            code.write_text(prelude + helper + harness)
            result = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(code), '-o', str(binary)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            for mode in range(12):
                for slot in (3, 4, 64):
                    with self.subTest(fault=mode, descriptor_slot=slot):
                        result = subprocess.run([str(binary), str(mode), str(slot)], capture_output=True, text=True, timeout=3)
                        self.assertEqual(result.returncode, 0 if mode in (0, 1) else 126, result.stderr)

    def test_only_shell_child_changes_after_existing_command_ingestion(self):
        source = SOURCE.read_text()
        start = source.index('int main(')
        main = source[start:]
        self.assertEqual(main.count('shell_stdin();'), 1)
        self.assertLess(main.index('ssize_t count=read(0,command+length,'), main.index('pid_t child=fork();'))
        self.assertIn('if(child==0){\n        shell_stdin();\n        if(dup2(pipes[0][1],1)<0 || dup2(pipes[1][1],2)<0 || syscall(SYS_close_range,3U,~0U,0U))_exit(126);', main)
        self.assertIn('char *args[]={"/bin/bash","--noprofile","--norc","-c",command,NULL};', main)
        self.assertIn('close(pipes[0][1]);close(pipes[1][1]);', main)
        self.assertIn('while(waitpid(-1,NULL,0)>=0 || errno==EINTR){}', main)
        self.assertNotIn('/dev/tty', source)


if __name__ == '__main__':
    unittest.main()

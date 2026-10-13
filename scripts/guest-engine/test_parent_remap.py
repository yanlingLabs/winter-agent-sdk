"""Exact launcher remap/poll statements using pipe stand-ins, never pidfd/native authority.
No root, namespace, mount, capability or native-helper operation is performed.
"""
import shutil,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
class ParentRemapTests(unittest.TestCase):
    def test_exact_remap_keeps_parent_monitor_distinct_from_readable_fd3_fd4(self):
        compiler=shutil.which('cc')
        if not compiler:self.skipTest('existing portable C compiler unavailable')
        source=(ROOT/'packages/runtime/src/guest/linux-runtime-compartment.c').read_text()
        start=source.index('    int parentcopy=')
        remap=source[start:source.index('    require(prctl(PR_SET_NO_NEW_PRIVS',start)]
        poll_start=source.index('struct pollfd alive=')
        check=source[poll_start:source.index('\n    struct __user_cap_header_struct',poll_start)]
        header=(ROOT/'packages/runtime/src/guest/linux-compartment.h').read_text()
        require_start=header.index('static inline void require(')
        require=header[require_start:header.index('static inline void path(',require_start)]
        prelude=r'''
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
'''
        setup=r'''
static int high(int original){int copy=fcntl(original,F_DUPFD_CLOEXEC,128);assert(copy>=128);close(original);return copy;}
int main(int argc,char **argv){
 assert(argc==4);int slot=atoi(argv[1]),dead=atoi(argv[2]),invalid=atoi(argv[3]);
 int parentpipe[2],bootpipe[2];assert(pipe(parentpipe)==0);
 int parent_read=high(parentpipe[0]),parent_write=high(parentpipe[1]);
 assert(dup2(parent_read,slot)==slot);close(parent_read);int parent=slot;
 assert(pipe(bootpipe)==0);int bootstrap=high(bootpipe[0]),bootwriter=high(bootpipe[1]);
 assert(write(bootwriter,"pending-bootstrap",17)==17);close(bootwriter);
 FILE *regular=tmpfile();assert(regular);assert(fputs("readable-owner",regular)>=0);assert(fflush(regular)==0);
 int owner=fcntl(fileno(regular),F_DUPFD_CLOEXEC,128);assert(owner>=128);fclose(regular);
 if(invalid){close(parent);parent=-1;}
'''
        assertions=r'''
 assert(parentcopy>=64);assert(fcntl(parentcopy,F_GETFD)&FD_CLOEXEC);
 struct pollfd replacements[2]={{3,POLLIN,0},{4,POLLIN,0}};
 assert(poll(replacements,2,0)==2);
 assert(replacements[0].revents&POLLIN);assert(replacements[1].revents&POLLIN);
 struct pollfd before={parentcopy,POLLIN,0};assert(poll(&before,1,0)==0);
 if(dead){close(parent_write);parent_write=-1;}
'''
        finish=r'''
 /* Reaching this point means the exact production alive check did not refuse. */
 assert(!dead);close(parent_write);close(parentcopy);close(bootcopy);close(ownercopy);
 close(bootstrap);close(owner);close(3);close(4);return 0;
}
'''
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);code=root/'exact-remap.c';binary=root/'exact-remap'
            code.write_text(prelude+require+setup+remap+assertions+check+finish)
            compiled=subprocess.run([compiler,'-std=c11','-O2','-Wall','-Wextra','-Werror',str(code),'-o',str(binary)],capture_output=True,text=True,timeout=30)
            self.assertEqual(compiled.returncode,0,compiled.stderr)
            for slot in (3,4,64,97):
                for dead in (0,1):
                    with self.subTest(parent_slot=slot,death=dead):
                        result=subprocess.run([str(binary),str(slot),str(dead),'0'],capture_output=True,text=True,timeout=3)
                        self.assertEqual(result.returncode,77 if dead else 0,result.stderr)
            failed=subprocess.run([str(binary),'3','0','1'],capture_output=True,text=True,timeout=3)
            self.assertEqual(failed.returncode,77)
            self.assertIn('runtime parent copy',failed.stderr)
if __name__=='__main__':unittest.main()

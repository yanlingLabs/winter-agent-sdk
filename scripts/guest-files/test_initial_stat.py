#!/usr/bin/env python3
"""Portable initial file-stat diagnostics; ordinary C shim, no guest or launcher."""
import errno
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class InitialStatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('cc')
        if not compiler:
            raise unittest.SkipTest('existing portable C compiler unavailable')
        source = (ROOT / 'packages/runtime/src/guest/file-worker.c').read_text()
        receipt = source[source.index('static int error_result('):source.index('static int value(')]
        validation = source[source.index('    struct stat st;'):source.index('    char before_version[')]
        standin = r'''
#define _DEFAULT_SOURCE
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static int fault,stats,closes,frees;
static unsigned char buffer[1];
static int fake_fstat(int fd,struct stat *out) {
 assert(fd==17);stats++;
 /* Failed stat deliberately leaves the output untouched. */
 if(fault<=3){errno=fault==1?EIO:fault==2?EBADF:EINTR;return -1;}
 memset(out,0,sizeof *out);
 out->st_mode=fault==4?S_IFREG:fault==5?S_IFDIR:S_IFIFO;
 return 0;
}
static int fake_close(int fd){assert(fd==17);closes++;errno=EBADF;return -1;}
static void fake_free(void *data){assert(data==buffer);frees++;errno=ENOMEM;}
#define fstat fake_fstat
#define close fake_close
#define free fake_free
'''
        entry = r'''
static int validate(void) {
 int file=17;
 unsigned char *data=buffer;
'''
        harness = r'''
 return 0;
}
int main(int argc,char **argv) {
 assert(argc==2);fault=atoi(argv[1]);assert(fault>=1&&fault<=6);
 int result=validate();assert(stats==1);
 assert(closes==(fault==4?0:1));assert(frees==(fault==4?0:1));
 return result;
}
'''
        cls.temp = tempfile.TemporaryDirectory(prefix='winter-initial-stat-')
        cls.addClassCleanup(cls.temp.cleanup)
        code = Path(cls.temp.name) / 'test.c'
        cls.binary = Path(cls.temp.name) / 'test'
        code.write_text(standin + receipt + entry + validation + harness)
        built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', str(code), '-o', str(cls.binary)], capture_output=True, text=True, timeout=30)
        if built.returncode:
            raise AssertionError(built.stderr)

    def result(self, fault):
        result = subprocess.run([str(self.binary), str(fault)], capture_output=True, text=True, timeout=3)
        self.assertEqual(result.stderr, '')
        return result

    def test_stat_failure_retains_original_errno_after_cleanup(self):
        for fault, expected in ((1, errno.EIO), (2, errno.EBADF), (3, errno.EINTR)):
            with self.subTest(errno=expected):
                result = self.result(fault)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout), {'version': 1, 'ok': False, 'code': 'stat_failed', 'errno': expected})

    def test_regular_file_continues_without_rejection_or_cleanup(self):
        result = self.result(4)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')

    def test_directory_and_fifo_refuse_with_einval_after_cleanup(self):
        for fault in (5, 6):
            with self.subTest(kind='directory' if fault == 5 else 'FIFO'):
                result = self.result(fault)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout), {'version': 1, 'ok': False, 'code': 'regular_file_required', 'errno': errno.EINVAL})


if __name__ == '__main__':
    unittest.main()

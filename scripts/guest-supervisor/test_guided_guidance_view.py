"""Compartment C guidance view and WINTER.md alias: tests of the UNAPPLIED DATA patch.

The patch (docs/research/guided-guidance-view-DATA.patch) is applied here only to a scratch
copy of the tracked sources. The tracked native and Root sources stay byte-identical to main until
the owner approves applying the exact patch hash recorded in docs/guided-guidance-view-matrix.md.

Portable tests run anywhere with `cc`: they extract the patch's pure contract, execute its Root
(Python) admission and argument assembly against temporary directories, and pin source structure.
LinuxNativeTests build the PATCHED tool launcher and run it as root in real private mount and PID
namespaces; they are skipped unless the host is Linux and root, and CI runs them with sudo.
Nothing here opens a socket to a network, a NIC or a vsock, starts a VM, or enables Cowork.
"""
import contextlib
import hashlib
import importlib.util
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
GUEST = 'packages/runtime/src/guest'
OVERRIDE = os.environ.get('WINTER_GUIDANCE_VIEW_PATCH')
PATCH = Path(OVERRIDE) if OVERRIDE else ROOT / 'docs/research/guided-guidance-view-DATA.patch'
MATRIX = ROOT / 'docs/guided-guidance-view-matrix.md'
PROBE = Path(__file__).with_name('guidance_view_probe.c')
TOOL, SUPERVISOR = GUEST + '/linux-tool-compartment.c', GUEST + '/linux-supervisor.py'

# SHA-256 of the tracked sources on main (439b2f4d). The two patch targets may be in either state
# (unapplied = MAIN, applied = the patched bytes); everything else must never change in this lane.
MAIN_TARGETS = {
    TOOL: '799cd0b4c2ed713e1409fe87a037bb66575ee3a088fbbc1ea238581182fa33b7',
    SUPERVISOR: '2c5be1e8b2cf30956ae14f3ca02224db52aeb4387c2eac22ceceb49a875ceaa8',
}
FROZEN = {
    GUEST + '/linux-compartment.h': '92fef7c0708a23b1e930c5b2560dae6bef27294dfd682346e69d35c0484b967d',
    GUEST + '/linux-runtime-compartment.c': 'fcb90dba8cf9552b9c10cde4012603ac9471b03f31a09bc408667257f65842fa',
    GUEST + '/linux-instruction-reader-compartment.c': '28aa279d6ecb560424fe24bf8ccc0893ffc61cfbb9ba6ba72d38c66b7b655893',
    GUEST + '/linux-instruction-reader-dependency-probe.c': '77ce6f1cdc02cef122eb2806e9df06514fdc7a2f9191d107a897df62d045b20a',
    GUEST + '/linux-session-owner.c': 'c149d451eaa79442dfd41e9375c891ae8c9a06135d2cfc85851bcc8b5ce51fd8',
    GUEST + '/linux-session-admission.ts': '18e619c164dc49dd5eae3bf40873fadc6905eb5c8ef935a36f71206f2bf40ff3',
    GUEST + '/file-worker.c': 'fcb6b489e7b7c22b484cf5aad4d8f157614bf6b8c6a28d59be90651c286abcef',
    GUEST + '/process-worker.c': '2c4514e2a267c1634cb90abe97a2471dd36057d9d2ba050fb3540703d11bed11',
}
CC_FLAGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


_patched = {}


def patched_tree():
    """Scratch copy of the tracked tool launcher, Root service and shared header with the patch applied."""
    if 'root' not in _patched:
        directory = Path(tempfile.mkdtemp(prefix='winter-guidance-view-patched-'))
        for name in (TOOL, SUPERVISOR, GUEST + '/linux-compartment.h'):
            (directory / name).parent.mkdir(parents=True, exist_ok=True)
            if name in MAIN_TARGETS:
                (directory / name).write_text(tracked_main_text(name))
            else:
                shutil.copyfile(ROOT / name, directory / name)
        applied = subprocess.run(['patch', '-p1', '-s', '-d', str(directory), '-i', str(PATCH)], capture_output=True, text=True, timeout=30)
        if applied.returncode:
            raise AssertionError('DATA patch does not apply to the tracked sources: ' + applied.stdout + applied.stderr)
        _patched['root'] = directory
    return _patched['root']


def patched_text(name):
    return (patched_tree() / name).read_text()


def tracked_main_text(name):
    """The pre-patch bytes: the tracked file when unapplied, else the patch reversed on a scratch copy."""
    if sha(ROOT / name) == MAIN_TARGETS[name]:
        return (ROOT / name).read_text()
    directory = Path(tempfile.mkdtemp(prefix='winter-guidance-view-main-'))
    try:
        (directory / name).parent.mkdir(parents=True)
        shutil.copyfile(ROOT / name, directory / name)
        reverse = subprocess.run(['patch', '-p1', '-R', '-s', '-d', str(directory), '-i', str(PATCH)], capture_output=True, text=True, timeout=30)
        assert reverse.returncode == 0, reverse.stderr
        return (directory / name).read_text()
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def load_supervisor(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_modules = {}


def patched_service():
    if 'patched' not in _modules:
        _modules['patched'] = load_supervisor(patched_tree() / SUPERVISOR, 'guided_view_patched_supervisor')
    return _modules['patched']


def main_service():
    if 'main' not in _modules:
        directory = Path(tempfile.mkdtemp(prefix='winter-guidance-view-main-py-'))
        target = directory / 'main_supervisor.py'
        target.write_text(tracked_main_text(SUPERVISOR))
        _modules['main'] = load_supervisor(target, 'guided_view_main_supervisor')
    return _modules['main']


def code_only(source):
    """The C source with its comments removed, so structure pins cannot be satisfied by prose."""
    return re.sub(r'/\*.*?\*/', '', source, flags=re.S)


def added_lines(patch_text):
    return [line[1:] for line in patch_text.splitlines() if line.startswith('+') and not line.startswith('+++')]


def removed_lines(patch_text):
    return [line[1:] for line in patch_text.splitlines() if line.startswith('-') and not line.startswith('---')]


class PatchIntegrityTests(unittest.TestCase):
    def test_patch_hash_is_recorded_in_the_matrix(self):
        if OVERRIDE:
            self.skipTest('mutation runs substitute the patch; the recorded hash belongs to the real one')
        recorded = re.search(r'`DATA patch SHA256: ([0-9a-f]{64})`', MATRIX.read_text())
        self.assertIsNotNone(recorded)
        self.assertEqual(sha(PATCH), recorded.group(1))

    def test_patch_touches_exactly_the_tool_launcher_and_the_root_service(self):
        files = re.findall(r'^--- a/(.+)$', PATCH.read_text(), re.M)
        self.assertEqual(sorted(files), sorted([TOOL, SUPERVISOR]))
        self.assertEqual(sorted(re.findall(r'^\+\+\+ b/(.+)$', PATCH.read_text(), re.M)), sorted([TOOL, SUPERVISOR]))

    def test_patch_removes_exactly_two_existing_lines_so_every_other_byte_is_unchanged(self):
        removed = removed_lines(PATCH.read_text())
        self.assertEqual(len(removed), 2, removed)
        self.assertEqual(sum('argc!=15+3*roots' in line for line in removed), 1)
        self.assertEqual(sum("allowed.update(('requiredRuntimeContext','generation'))" in line for line in removed), 1)

    def test_tracked_sources_are_unapplied_or_exactly_the_patched_bytes(self):
        for name, main in MAIN_TARGETS.items():
            actual = sha(ROOT / name)
            self.assertIn(actual, (main, hashlib.sha256((patched_tree() / name).read_bytes()).hexdigest()), name)

    def test_shared_header_reader_runtime_and_admission_sources_never_change(self):
        for name, digest in FROZEN.items():
            self.assertEqual(sha(ROOT / name), digest, name)
        # The patch cannot reach them either, by construction of its file list.
        for name in FROZEN:
            self.assertNotIn(name, PATCH.read_text())

    def test_patched_header_is_byte_identical_to_the_tracked_header(self):
        self.assertEqual(sha(patched_tree() / (GUEST + '/linux-compartment.h')), FROZEN[GUEST + '/linux-compartment.h'])

    def test_the_patch_adds_no_network_nic_or_vsock_surface(self):
        added = '\n'.join(added_lines(PATCH.read_text()))
        for token in ('socket(', 'socketpair', 'AF_INET', 'AF_INET6', 'AF_VSOCK', 'vsock', 'AF_NETLINK', 'NETLINK', 'SIOC', 'ioctl', 'connect(', 'bind(', 'listen(', 'accept(', 'sendto', 'sendmsg', 'recvmsg', 'CLONE_NEWNET', 'setns', 'unshare'):
            self.assertNotIn(token, added, token)
        patched = patched_text(TOOL)
        self.assertIn('CLONE_NEWNS|CLONE_NEWIPC|CLONE_NEWUTS|CLONE_NEWNET|CLONE_NEWPID', patched)
        self.assertEqual(patched.count('install_filter(process)'), 1)

    def test_the_runtime_launcher_argument_contract_is_not_touched(self):
        self.assertNotIn('linux-runtime-compartment', PATCH.read_text())
        self.assertNotIn('_run_runtime', '\n'.join(added_lines(PATCH.read_text())))


class PortableContractTests(unittest.TestCase):
    """Compiles and executes the patched C's own pure contract (between its BEGIN/END markers)."""

    def contract(self):
        source = patched_text(TOOL)
        begin = source.index('/* BEGIN PORTABLE GUIDANCE CONTRACT')
        end = source.index('/* END PORTABLE GUIDANCE CONTRACT */')
        return source[begin:end]

    def run_harness(self, harness, contract=None):
        compiler = shutil.which('cc')
        if not compiler:
            self.skipTest('existing local C compiler unavailable; portable contract not executed')
        header = '#include <assert.h>\n#include <errno.h>\n#include <fcntl.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <sys/stat.h>\n#include <unistd.h>\n'
        with tempfile.TemporaryDirectory(prefix='winter-guidance-contract-') as directory:
            code, binary = Path(directory) / 'contract.c', Path(directory) / 'contract'
            code.write_text(header + (contract or self.contract()) + harness)
            built = subprocess.run([compiler, *CC_FLAGS, '-D_DEFAULT_SOURCE', '-Wno-unused-function', str(code), '-o', str(binary)], capture_output=True, text=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr)
            run = subprocess.run([str(binary)], capture_output=True, text=True, timeout=5, cwd=directory)
            self.assertEqual(run.returncode, 0, run.stderr + run.stdout)

    def test_trailer_parse_accepts_only_the_exact_two_argument_shape(self):
        self.run_harness(r'''
static int parse(int argc,const char **argv,int *fd){return guidance_parse(argc,(char **)argv,5,fd);}
int main(void){
    int fd=-7;
    const char *none[]={"a","b","c","d","e"};
    assert(parse(5,none,&fd)==0&&fd==-7);                       /* no trailer: v1 and fresh shape */
    const char *ok[]={"a","b","c","d","e","--guidance","9"};
    assert(parse(7,ok,&fd)==1&&fd==9);
    const char *low[]={"a","b","c","d","e","--guidance","3"};assert(parse(7,low,&fd)==1&&fd==3);
    const char *high[]={"a","b","c","d","e","--guidance","65535"};assert(parse(7,high,&fd)==1&&fd==65535);
    const char *bad[][2]={{"--guidance","2"},{"--guidance","0"},{"--guidance","1"},{"--guidance","65536"},{"--guidance","99999999999999999999"},
        {"--guidance","03"},{"--guidance","+9"},{"--guidance","-9"},{"--guidance"," 9"},{"--guidance","9 "},{"--guidance","0x9"},{"--guidance","9a"},
        {"--guidance",""},{"--guidance",NULL},{"--Guidance","9"},{"--guidance=9","9"},{"guidance","9"},{"-guidance","9"},{"--other","9"},{"","9"}};
    for(unsigned i=0;i<sizeof bad/sizeof bad[0];i++){
        const char *vector[]={"a","b","c","d","e",bad[i][0],bad[i][1]};
        fd=-7;
        assert(parse(7,vector,&fd)==-1&&fd==-7);
    }
    const char *extra[]={"a","b","c","d","e","--guidance","9","10"};assert(parse(8,extra,&fd)==-1);
    const char *single[]={"a","b","c","d","e","--guidance"};assert(parse(6,single,&fd)==-1);
    const char *short_[]={"a","b","c","d"};assert(parse(4,short_,&fd)==-1);   /* fewer than the base shape */
    return 0;
}
''')

    def test_only_ext4_tmpfs_and_virtiofs_are_data_filesystems(self):
        self.run_harness(r'''
int main(void){
    assert(guidance_type_allowed(0xEF53UL));assert(guidance_type_allowed(0x01021994UL));assert(guidance_type_allowed(0x6a656a63UL));
    /* proc, sysfs, devpts, cgroup, cgroup2, debugfs, tracefs, securityfs, pidfs, nsfs, bpf, mqueue, hugetlbfs,
       ramfs, overlayfs, fuse, nfs, 9p, smb2, xfs, btrfs, squashfs, iso9660, vfat, msdos, ntfs, aufs, binfmt_misc. */
    unsigned long refused[]={0x9fa0UL,0x62656572UL,0x1cd1UL,0x27e0eb,0x63677270UL,0x64626720UL,0x74726163UL,0x73636673UL,0x50494446UL,0x6e736673UL,0xcafe4a11UL,0x19800202UL,0x958458f6UL,0x858458f6UL,
        0x794c7630UL,0x65735546UL,0x6969UL,0x01021997UL,0xfe534d42UL,0x58465342UL,0x9123683eUL,0x73717368UL,0x9660UL,0x4d44UL,0x5346544eUL,0x61756673UL,0x42494e4dUL,0UL,0xFFFFFFFFUL,0xEF54UL,0x01021995UL,0x6a656a64UL};
    for(unsigned i=0;i<sizeof refused/sizeof refused[0];i++)assert(!guidance_type_allowed(refused[i]));
    return 0;
}
''')

    def test_guidance_must_differ_from_every_other_descriptor_by_number_and_inode(self):
        self.run_harness(r'''
int main(void){
    char first[]="/tmp/winter-guidance-a-XXXXXX",second[]="/tmp/winter-guidance-b-XXXXXX";
    int a=mkstemp(first),b=mkstemp(second);assert(a>=0&&b>=0);unlink(first);unlink(second);
    int alias=dup(a);assert(alias>=0);
    int others[]={b};
    assert(guidance_distinct(a,others,1));                       /* two distinct inodes */
    int same_number[]={b,a};assert(!guidance_distinct(a,same_number,2));
    int same_inode[]={b,alias};assert(!guidance_distinct(a,same_inode,2));
    int empty[1]={0};assert(guidance_distinct(a,empty,0));
    int closed[]={999};assert(!guidance_distinct(a,closed,1));    /* an unreadable peer is refused, never skipped */
    assert(!guidance_distinct(998,others,1));
    return 0;
}
''')

    def test_fixed_constants(self):
        contract = self.contract()
        self.assertIn('#define GUIDANCE_ROOT "/run/winter/shared-instructions"', contract)
        self.assertIn('#define GUIDANCE_FILE "WINTER.md"', contract)
        self.assertIn('#define GUIDANCE_ALIAS "/workspace/.winter/WINTER.md"', contract)
        self.assertIn('#define GUIDANCE_FLAG "--guidance"', contract)
        self.assertIn('#define GUIDANCE_VIRTIOFS_MAGIC 0x6a656a63UL', contract)
        self.assertIn('#define GUIDANCE_EXT4_MAGIC 0xEF53UL', contract)
        self.assertIn('#define GUIDANCE_TMPFS_MAGIC 0x01021994UL', contract)
        self.assertEqual(len(re.findall(r'guidance_type_allowed\(unsigned long type\) \{\s*return type==GUIDANCE_EXT4_MAGIC\|\|type==GUIDANCE_TMPFS_MAGIC\|\|type==GUIDANCE_VIRTIOFS_MAGIC;', contract)), 1)

    def test_every_data_filesystem_equals_the_instruction_reader_allowlist(self):
        reader = (ROOT / GUEST / 'linux-instruction-reader-compartment.c').read_text()
        self.assertIn('static const char *const reader_data[]={"ext4","tmpfs","virtiofs"};', reader)


class PatchedCSourceTests(unittest.TestCase):
    """Source-structure pins on the patched launcher. Behaviour is in LinuxNativeTests."""

    @classmethod
    def setUpClass(cls):
        cls.source = patched_text(TOOL)
        cls.main = None

    def body(self, name):
        start = self.source.index('static ' + name)
        return self.source[start:self.source.index('\n}\n', start) + 3]

    def test_directory_is_cloned_non_recursively_and_sealed_readonly_noexec(self):
        self.assertNotIn('AT_RECURSIVE', self.source)
        self.assertNotIn('RECURSIVE', code_only(self.source))
        self.assertIn('guidance_tree=clone_descriptor(guidance,1,0)', self.source)
        self.assertIn('int tree=clone_descriptor(file,1,0);close(file);return tree;', self.source)
        # No guidance clone may ask for write or exec.
        code = code_only(self.source)
        for call in re.findall(r'clone_descriptor\((?:guidance|file),(\d),(\d)\)', code):
            self.assertEqual(call, ('1', '0'))
        self.assertEqual(len(re.findall(r'clone_descriptor\((?:guidance|file),', code)), 2)

    def test_alias_is_one_regular_unlinked_same_superblock_data_file(self):
        body = self.body('int guidance_alias_clone')
        for needle in ('openat(guidance,GUIDANCE_FILE,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)', 'S_ISREG(st.st_mode)', 'st.st_nlink!=1', 'st.st_dev!=directory.st_dev', 'fstatfs(file,&fs)', 'guidance_type_allowed((unsigned long)fs.f_type)'):
            self.assertIn(needle, body)
        self.assertIn('if(errno==ENOENT)return -1;', body)

    def test_directory_must_be_a_distinct_allowlisted_directory(self):
        body = self.body('void guidance_directory')
        for needle in ('S_ISDIR(st.st_mode)', 'guidance_distinct(fd,others,count)', 'fstatfs(fd,&fs)', 'guidance_type_allowed((unsigned long)fs.f_type)'):
            self.assertIn(needle, body)

    def test_every_other_held_descriptor_is_compared(self):
        self.assertIn('held[held_count++]=worker;held[held_count++]=control;held[held_count++]=environment;', self.source)
        self.assertIn('held[held_count++]=descriptor(argv[15+3*i])', self.source)
        self.assertIn('guidance_directory(guidance,held,held_count);', self.source)

    def test_guest_paths_are_constants_never_argv(self):
        self.assertIn('point(root,GUIDANCE_ROOT,target,sizeof target);attach_descriptor(guidance_tree,target);', self.source)
        self.assertIn('guidance_file_point(root,GUIDANCE_ALIAS,target,sizeof target);attach_descriptor(alias_tree,target);', self.source)
        literals = re.findall(r'"([^"\\\n]*\.winter[^"\\\n]*)"', self.source)
        self.assertEqual(literals, ['/workspace/.winter/WINTER.md'])  # the enclosing .winter is never named as a mount
        self.assertEqual(len(re.findall(r'/run/winter/shared-instructions', self.source)), 1)

    def test_attachment_precedes_the_readonly_skeleton_and_the_seal_check_follows_chroot(self):
        s = self.source
        self.assertIn('    if(guided) {\n        point(root,GUIDANCE_ROOT', s)   # v1 and fresh never attach
        self.assertIn('    if(guided) {\n        int held[', s)
        self.assertLess(s.index('point(root,GUIDANCE_ROOT'), s.index('"protected skeleton"'))
        self.assertLess(s.index('guidance_file_point(root,GUIDANCE_ALIAS'), s.index('"protected skeleton"'))
        self.assertLess(s.index('require(chroot("."),"view root")'), s.index('guidance_sealed(GUIDANCE_ROOT)'))
        self.assertLess(s.index('guidance_sealed(GUIDANCE_ROOT)'), s.index('PR_SET_NO_NEW_PRIVS'))
        self.assertLess(s.index('guidance_sealed(GUIDANCE_ROOT)'), s.index('SYS_close_range'))
        self.assertLess(s.index('guidance_sealed(GUIDANCE_ROOT)'), s.index('install_filter(process)'))
        sealed = self.body('void guidance_sealed')
        self.assertIn('ST_RDONLY|ST_NOSUID|ST_NODEV|ST_NOEXEC', sealed)
        self.assertIn('(v.f_flag&need)!=need)_exit(77)', sealed)
        self.assertIn('if(alias_tree>=0)guidance_sealed(GUIDANCE_ALIAS);', s)

    def test_no_descriptor_survives_to_exec(self):
        s = self.source
        self.assertIn('close(guidance);', s)
        self.assertIn('close(file)', s)
        self.assertIn('SYS_close_range,3U,~0U,0U', s)
        self.assertLess(s.index('SYS_close_range,3U,~0U,0U'), s.index('execve(args[0]'))
        self.assertIn('OPEN_TREE_CLOEXEC', self.body('int clone_descriptor'))

    def test_trailer_is_parsed_once_and_the_old_fixed_length_check_is_gone(self):
        self.assertNotIn('argc!=15+3*roots', self.source)
        self.assertEqual(self.source.count('guidance_parse(argc,argv,15+3*roots,&guidance)'), 1)
        self.assertIn('if(guided<0 || (strcmp(argv[7],"auto")&&strcmp(argv[7],"plan")))_exit(64);', self.source)

    def test_alias_mountpoint_is_a_file_with_tolerant_parents_and_exclusive_create(self):
        body = self.body('void guidance_file_point')
        self.assertIn('errno!=EEXIST', body)
        self.assertIn('O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0444', body)
        self.assertIn('strstr(guest,"..")', body)

    def test_existing_code_between_the_patched_lines_is_unchanged(self):
        before = tracked_main_text(TOOL)
        for line in before.splitlines():
            if 'argc!=15+3*roots' in line:
                continue
            self.assertIn(line, self.source.splitlines(), line)


class GuidanceDirectoryTests(unittest.TestCase):
    """Root's admission of the dedicated guidance directory (the patched Python)."""

    def setUp(self):
        self.service = patched_service()
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        for name in ('guidance', 'source', 'other-source', 'store', 'workspace-winter'):
            (self.base / name).mkdir()
        self.roots = [(self.base / 'source').resolve(), (self.base / 'other-source').resolve()]
        self.protected = [self.base / 'store']

    def tearDown(self):
        self.temp.cleanup()

    def open_fds(self):
        return len(os.listdir('/dev/fd'))

    def admit(self, source, protected=None, roots=None):
        return self.service.guidance_directory(str(source), self.protected if protected is None else protected, self.roots if roots is None else roots)

    def refuses(self, source, code, **kwargs):
        before = self.open_fds()
        with self.assertRaisesRegex(self.service.Refusal, code):
            self.admit(source, **kwargs)
        self.assertEqual(self.open_fds(), before, 'a refusal must not leak the held descriptor')

    def test_a_dedicated_directory_is_admitted_as_a_held_directory_descriptor(self):
        fd = self.admit(self.base / 'guidance')
        try:
            self.assertTrue(stat.S_ISDIR(os.fstat(fd).st_mode))
            self.assertFalse(os.get_inheritable(fd))
        finally:
            os.close(fd)

    def test_guidance_equal_to_a_root_is_refused_in_both_roles(self):
        self.refuses(self.base / 'source', 'guided_guidance_overlap')
        self.refuses(self.base / 'other-source', 'guided_guidance_overlap')

    def test_guidance_inside_or_above_a_writable_root_is_refused(self):
        (self.base / 'source' / 'nested').mkdir()
        self.refuses(self.base / 'source' / 'nested', 'guided_guidance_overlap')
        self.refuses(self.base, 'guided_guidance_overlap', protected=[])

    def test_guidance_that_would_widen_to_the_enclosing_winter_store_is_refused(self):
        # The enclosing directory of a protected store/run home would expose every conversation.
        winter = self.base / 'dot-winter'
        (winter / 'conversations' / 's1').mkdir(parents=True)
        self.refuses(winter, 'protected_source_overlap', protected=[winter / 'conversations' / 's1'])
        self.refuses(winter / 'conversations', 'protected_source_overlap', protected=[winter / 'conversations' / 's1'])
        self.refuses(winter / 'conversations' / 's1', 'protected_source_overlap', protected=[winter / 'conversations' / 's1'])
        self.refuses(winter / 'conversations' / 's1', 'protected_source_overlap', protected=[winter / 'conversations'])

    def test_a_symlink_spelling_or_dotdot_or_relative_path_is_refused(self):
        (self.base / 'link').symlink_to(self.base / 'guidance')
        self.refuses(self.base / 'link', 'source_alias')
        self.refuses(str(self.base / 'guidance' / '..' / 'guidance'), 'source_path')
        self.refuses('guidance', 'source_path')
        self.refuses('./guidance', 'source_path')

    def test_files_missing_paths_and_malformed_values_are_refused(self):
        (self.base / 'plain-file').write_text('x')
        before = self.open_fds()
        with self.assertRaises(Exception):
            self.admit(self.base / 'plain-file')
        with self.assertRaises(Exception):
            self.admit(self.base / 'missing')
        for value in (None, 5, b'/x', ['/x'], '', '/' + 'a' * 4096, str(self.base / 'guidance') + '\0'):
            with self.assertRaisesRegex(self.service.Refusal, 'guided_guidance'):
                self.service.guidance_directory(value, self.protected, self.roots)
        self.assertEqual(self.open_fds(), before)

    def test_the_same_inode_under_another_spelling_is_refused(self):
        # A root that is the same directory by inode but a different admitted path (bind-mount shaped)
        # is refused even when the spellings share no ancestry; model it with an injected stat.
        other = (self.base / 'other-source').resolve()
        real_stat = Path.stat
        guidance = os.stat(self.base / 'guidance')

        def fake_stat(self_, *args, **kwargs):
            if self_ == other:
                return guidance
            return real_stat(self_, *args, **kwargs)
        with patch.object(Path, 'stat', fake_stat):
            self.refuses(self.base / 'guidance', 'guided_guidance_overlap')


class LauncherArgumentGoldenTests(unittest.TestCase):
    """The tool launcher argv Root builds: v1 and fresh are byte-identical to main; guided gains one trailer."""

    GOLDEN_FILE_V1 = lambda self, fds: [str(fds['launcher']), str(fds['worker']), '<view>', '<parent>', str(fds['environment']), '10001', '10000', 'auto', 'file', 'read', '/workspace/folders/source', 'seed', '1024', '-', '2',
                                        str(fds['writable']), '/workspace/folders/source', '0', str(fds['readonly']), '/workspace/folders/ro', '1']

    def build(self, module, policy, guidance, kind, fds, tmp):
        item = {'logicalSessionId': 'logical', 'toolUid': 10001, 'workspaceGid': 10000, 'policy': policy, 'revoked': False,
                'roots': {'source': {'root': {'id': 'source', 'guestPath': '/workspace/folders/source', 'readOnly': False}, 'fd': fds['writable']},
                          'ro': {'root': {'id': 'ro', 'guestPath': '/workspace/folders/ro', 'readOnly': True}, 'fd': fds['readonly']}}}
        if guidance is not None:
            item['guidance'] = guidance
        fake = SimpleNamespace(artifacts={'launcher': fds['launcher'], 'fileWorker': fds['worker'], 'processWorker': fds['worker']},
                               artifact_pins={'launcher': 'inert', 'fileWorker': 'inert', 'processWorker': 'inert'}, environment=fds['environment'], directory=Path(tmp), stop_event=threading.Event())
        captured = []

        def refuse(args, **options):
            captured.append((list(args), options))
            raise OSError(5, 'portable Popen refusal')
        real = module.socket.socketpair
        with patch.object(module.socket, 'socketpair', side_effect=lambda *a: real(module.socket.AF_UNIX, module.socket.SOCK_STREAM)), \
                patch.object(module, 'verify_held_artifact'), patch.object(module.subprocess, 'Popen', side_effect=refuse):
            with self.assertRaises(OSError):
                module.ToolService._run(fake, item, kind, 'read', item['roots']['source'], 'seed', 1024, '-', b'', 5, threading.Event(), None)
        self.assertEqual(len(captured), 1)
        args, options = captured[0]
        args[2] = '<view>'
        args[3] = '<parent>'
        options = dict(options, pass_fds=[fd if index != 2 else '<parent>' for index, fd in enumerate(options['pass_fds'])])
        return args, options

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.stack = contextlib.ExitStack()
        self.fds = {}
        for name in ('launcher', 'worker', 'environment', 'writable', 'readonly', 'guidance'):
            path = Path(self.temp.name) / name
            path.mkdir() if name in ('environment', 'writable', 'readonly', 'guidance') else path.write_bytes(b'inert')
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
            self.stack.callback(os.close, fd)
            self.fds[name] = fd

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def test_v1_and_fresh_arguments_are_byte_identical_to_main(self):
        for policy in ('auto', 'plan', 'ask', 'accept-edits', 'dont-ask', 'bypass'):
            for kind in ('file', 'process'):
                with self.subTest(policy=policy, kind=kind):
                    expected, expected_options = self.build(main_service(), policy, None, kind, self.fds, self.temp.name)
                    actual, options = self.build(patched_service(), policy, None, kind, self.fds, self.temp.name)
                    self.assertEqual(actual, expected)
                    self.assertEqual(options['pass_fds'], expected_options['pass_fds'])
                    self.assertEqual(options['env'], {'LANG': 'C', 'LC_ALL': 'C'})
                    self.assertNotIn('--guidance', actual)
                    self.assertEqual(len(actual), 15 + 3 * 2)

    def test_a_literal_golden_for_the_v1_shape(self):
        actual, _ = self.build(patched_service(), 'auto', None, 'file', self.fds, self.temp.name)
        self.assertEqual(actual, self.GOLDEN_FILE_V1(self.fds))

    def test_guided_adds_exactly_the_trailer_and_the_descriptor(self):
        for kind in ('file', 'process'):
            base, base_options = self.build(patched_service(), 'auto', None, kind, self.fds, self.temp.name)
            guided, options = self.build(patched_service(), 'auto', self.fds['guidance'], kind, self.fds, self.temp.name)
            self.assertEqual(guided[:len(base)], base)
            self.assertEqual(guided[len(base):], ['--guidance', str(self.fds['guidance'])])
            self.assertEqual(options['pass_fds'], base_options['pass_fds'] + [self.fds['guidance']])
            self.assertEqual(options['env'], {'LANG': 'C', 'LC_ALL': 'C'})
            self.assertTrue(options['close_fds'])

    def test_the_guidance_key_is_only_ever_looked_up_not_required(self):
        item = {'roots': {}}
        self.assertIsNone(item.get('guidance'))
        self.assertIn("item.get('guidance') is not None", patched_text(SUPERVISOR))


class ConfigureAndConstructTests(unittest.TestCase):
    """_configure_runtime key admission and the constructor's guidance post-pass."""

    def setUp(self):
        self.service = patched_service()
        self.main = main_service()
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        for name in ('control', 'environment', 'source', 'artifacts', 'store', 'home', 'guidance', 'store2', 'home2'):
            (self.base / name).mkdir()
        for name in ('launcher', 'fileWorker', 'processWorker', 'executable', 'ownerLibrary'):
            (self.base / 'artifacts' / name).write_bytes(b'x')
        self.built = []
        self.cleanups = []

    def tearDown(self):
        for built in self.built:
            built.close()
        for cleanup in reversed(self.cleanups):
            cleanup()
        self.temp.cleanup()

    @contextlib.contextmanager
    def linux_root(self, module):
        boot = '00000000-0000-0000-0000-000000000000'
        with patch.object(module.sys, 'platform', 'linux'), patch.object(module.os, 'geteuid', return_value=0), \
                patch.object(module.sys, 'flags', SimpleNamespace(isolated=1, no_site=1)), patch.object(module.Path, 'read_text', return_value=boot + '\n'):
            yield boot

    def config(self, module, profile, guidance=None, extra_root=None, second=None):
        key = dict(module.RUNTIME_KEYS)[profile]
        pin = lambda name: {'path': str(self.base / 'artifacts' / name), 'sha256': '0' * 64}
        roots = [{'id': 'source', 'guestPath': '/workspace/folders/source', 'readOnly': False, 'source': str(self.base / 'source')}]
        if extra_root:
            roots.append(extra_root)
        entry = {'logicalSessionId': 'logical', 'authority': {'workspaceId': 'workspace', 'sessionId': 'backend', 'incarnationId': 'incarnation', 'leaseEpoch': 1, 'configRevision': 1, 'grantRevision': 1, 'policyRevision': 1},
                 'runtimeUid': 20001, 'toolUid': 10001, 'workspaceGid': 10000, 'policy': 'ask', 'roots': roots}
        config = {'guestBootId': '00000000-0000-0000-0000-000000000000', 'environment': str(self.base / 'environment'), 'controlDirectory': str(self.base / 'control'),
                  'protectedStoreDirectories': [str(self.base / 'store')], 'artifacts': {name: pin(name) for name in ('launcher', 'fileWorker', 'processWorker')}, 'conversations': [entry]}
        if second is not None:
            other = dict(entry, logicalSessionId='logical2', runtimeUid=20002, toolUid=10002, authority=dict(entry['authority'], sessionId='backend2'),
                         roots=[{'id': 'source', 'guestPath': '/workspace/folders/source2', 'readOnly': False, 'source': second}])
            config['conversations'].append(other)
        if profile != 'fresh':
            config[key] = {'artifacts': {name: pin(name) for name in ('launcher', 'executable', 'ownerLibrary')}}
            for each in config['conversations'][1:]:
                each[key] = {'storeDirectory': str(self.base / 'store2'), 'runhomeDirectory': str(self.base / 'home2')}
            entry[key] = {'storeDirectory': str(self.base / 'store'), 'runhomeDirectory': str(self.base / 'home')}
            if guidance is not None:
                entry[key]['guidanceDirectory'] = guidance
        return config

    def make_ports(self, module, sid='logical', backend='backend'):
        directory = tempfile.TemporaryDirectory()
        self.cleanups.append(directory.cleanup)
        ends = []
        for index in range(3):
            fifo = Path(directory.name) / str(index)
            os.mkfifo(fifo, 0o600)
            ends.append((os.open(fifo, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC), os.open(fifo, os.O_WRONLY | os.O_NONBLOCK | os.O_CLOEXEC)))
        for pair in ends:
            self.cleanups.append(lambda pair=pair: [os.close(fd) for fd in pair if self.fd_open(fd)])
        authority = {'workspaceId': 'workspace', 'sessionId': backend, 'incarnationId': 'incarnation', 'leaseEpoch': 1, 'configRevision': 1, 'grantRevision': 1, 'policyRevision': 1}
        return module.RuntimeDuplexPorts(sid, authority, ends[0][0], ends[1][1], ends[2][1])

    @staticmethod
    def fd_open(fd):
        try:
            os.fstat(fd)
            return True
        except OSError:
            return False

    def construct(self, module, profile, guidance=None, extra_root=None, second=None):
        for sid in ('logical', 'logical2'):
            private = self.base / 'control' / sid
            if private.exists():
                private.rmdir()
        ports = {} if profile == 'fresh' else {'logical': self.make_ports(module)}
        if second is not None:
            ports['logical2'] = self.make_ports(module, 'logical2', 'backend2')
        control = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with self.linux_root(module), patch.object(module, 'pinned_artifact', side_effect=lambda value: os.open(os.devnull, os.O_RDONLY | os.O_CLOEXEC)), \
                patch.object(module.Path, 'lstat', return_value=control), patch.object(module.os, 'chown'), \
                patch.object(module.ToolService, '_configure_runtime', autospec=True) as configure:
            built = module.ToolService(self.config(module, profile, guidance, extra_root, second), host_query_ports=ports)
        self.built.append(built)
        return built, configure

    def test_guided_constructor_holds_the_guidance_descriptor_on_the_conversation(self):
        built, configure = self.construct(self.service, 'host-query-guided-v1', str(self.base / 'guidance'))
        fd = built.conversations['logical']['guidance']
        self.assertTrue(stat.S_ISDIR(os.fstat(fd).st_mode))
        self.assertIn(fd, built.owned)
        self.assertEqual(configure.call_args.kwargs, {'profile': 'host-query-guided-v1'})

    def test_guided_without_a_guidance_directory_has_no_guidance_key_and_unchanged_roots(self):
        built, _ = self.construct(self.service, 'host-query-guided-v1')
        self.assertNotIn('guidance', built.conversations['logical'])

    def test_the_constructor_refuses_a_guidance_directory_overlapping_a_root_a_store_or_the_winter_parent(self):
        (self.base / 'source' / 'g').mkdir()
        with self.assertRaisesRegex(self.service.Refusal, 'guided_guidance_overlap'):
            self.construct(self.service, 'host-query-guided-v1', str(self.base / 'source'))
        with self.assertRaisesRegex(self.service.Refusal, 'guided_guidance_overlap'):
            self.construct(self.service, 'host-query-guided-v1', str(self.base / 'source' / 'g'))
        with self.assertRaisesRegex(self.service.Refusal, 'protected_source_overlap'):
            self.construct(self.service, 'host-query-guided-v1', str(self.base / 'store'))
        with self.assertRaisesRegex(self.service.Refusal, 'protected_source_overlap'):
            self.construct(self.service, 'host-query-guided-v1', str(self.base))

    def test_guidance_equal_to_another_conversations_writable_root_is_refused(self):
        (self.base / 'source2').mkdir()
        with self.assertRaisesRegex(self.service.Refusal, 'guided_guidance_overlap'):
            self.construct(self.service, 'host-query-guided-v1', str(self.base / 'source2'), second=str(self.base / 'source2'))
        built, _ = self.construct(self.service, 'host-query-guided-v1', str(self.base / 'guidance'), second=str(self.base / 'source2'))
        self.assertIn('guidance', built.conversations['logical'])
        self.assertNotIn('guidance', built.conversations['logical2'])

    def test_constructor_failure_releases_the_guidance_descriptor(self):
        def holders(path):
            target = os.stat(path)
            count = 0
            for name in os.listdir('/dev/fd'):
                try:
                    held = os.fstat(int(name))
                except OSError:
                    continue
                count += (held.st_dev, held.st_ino) == (target.st_dev, target.st_ino)
            return count
        guidance = self.base / 'guidance'
        before = holders(guidance)
        (self.base / 'guidance' / 'x').mkdir()
        with self.assertRaises(self.service.Refusal):
            self.construct(self.service, 'host-query-guided-v1', str(self.base / 'store'))   # refused after the source roots opened
        self.assertEqual(holders(guidance), before)
        self.assertEqual(holders(self.base / 'source'), 0, 'the constructor closes every admitted root when it refuses')

    def test_v1_and_fresh_constructor_results_are_unchanged(self):
        for profile in ('host-query-v1', 'fresh'):
            patched, _ = self.construct(self.service, profile)
            baseline, _ = self.construct(self.main, profile)
            self.assertEqual(sorted(patched.conversations['logical']), sorted(baseline.conversations['logical']))
            self.assertNotIn('guidance', patched.conversations['logical'])

    def test_the_post_pass_runs_only_for_the_guided_profile_inside_the_constructor_try(self):
        source = patched_text(SUPERVISOR)
        start = source.index("            if self.runtime_profile==GUIDED_PROFILE:\n                root_sources=")
        self.assertLess(start, source.index('        except BaseException:\n            self.close();raise', start))
        self.assertIn('self.owned.append(fd);self.conversations[entry[\'logicalSessionId\']][\'guidance\']=fd', source)
        self.assertIn("guidance_directory(entry[runtime_key]['guidanceDirectory'],protected,root_sources)", source)

    def test_the_guidance_key_is_added_to_the_guided_allow_list_only(self):
        source = patched_text(SUPERVISOR)
        self.assertIn("if profile==GUIDED_PROFILE:allowed.update(('requiredRuntimeContext','generation','guidanceDirectory'))", source)
        self.assertEqual(source.count('guidanceDirectory'), 3)
        self.assertIn("if profile in ('host-query-v1',GUIDED_PROFILE):allowed.add('toolClasses')", source)


class PostApplyRegressionTests(unittest.TestCase):
    """The existing source suites, unchanged, against a scratch tree with the patch applied."""

    SUITES = (
        ('scripts/guest-supervisor', 'test_guided_host_query.py'), ('scripts/guest-supervisor', 'test_fresh_protocol.py'),
        ('scripts/guest-supervisor', 'test_runtime_launcher_policy.py'), ('scripts/guest-supervisor', 'test_runtime_port_arguments.py'),
        ('scripts/guest-supervisor', 'test_host_query.py'), ('scripts/guest-supervisor', 'test_runtime_diagnostics.py'),
        ('scripts/guest-supervisor', 'test_native_parser.py'),
        ('scripts/guest-engine', 'test_mount_propagation.py'), ('scripts/guest-engine', 'test_tool_devices.py'), ('scripts/guest-engine', 'test_runtime_entropy.py'),
    )

    @classmethod
    def setUpClass(cls):
        cls.tree = Path(tempfile.mkdtemp(prefix='winter-guidance-view-suites-'))
        for directory in (GUEST, 'scripts/guest-supervisor', 'scripts/guest-engine'):
            shutil.copytree(ROOT / directory, cls.tree / directory, ignore=shutil.ignore_patterns('__pycache__', 'node_modules', 'test_guided_guidance_view.py'))
        for name in MAIN_TARGETS:
            (cls.tree / name).write_text(patched_text(name))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tree, ignore_errors=True)

    def test_every_existing_suite_passes_against_the_patched_sources(self):
        for directory, name in self.SUITES:
            with self.subTest(suite=name):
                run = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', directory, '-p', name], cwd=self.tree, capture_output=True, text=True, timeout=300,
                                     env={'PATH': os.environ.get('PATH', ''), 'PYTHONDONTWRITEBYTECODE': '1'})
                self.assertEqual(run.returncode, 0, name + '\n' + run.stderr[-3000:])
                self.assertNotIn('NO TESTS RAN', run.stderr)


def native_available():
    return sys.platform == 'linux' and os.geteuid() == 0 and shutil.which('cc') is not None


@unittest.skipUnless(native_available(), 'needs Linux, root and a C compiler (CI runs this with sudo; never on macOS)')
class LinuxNativeTests(unittest.TestCase):
    """The PATCHED tool launcher in real private mount and PID namespaces, observed from inside the view."""

    UID, GID = 10001, 10000
    SENTINEL = 'GUIDANCE-SENTINEL'

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='winter-guidance-native-')
        base = Path(cls.temp.name)
        base.chmod(0o755)
        cls.base = base
        compiler = shutil.which('cc')
        cls.launcher = base / 'launcher'
        source = base / 'launcher.c'
        shutil.copyfile(patched_tree() / TOOL, source)
        shutil.copyfile(patched_tree() / (GUEST + '/linux-compartment.h'), base / 'linux-compartment.h')
        built = subprocess.run([compiler, *CC_FLAGS, '-static', str(source), '-o', str(cls.launcher)], capture_output=True, text=True, timeout=120)
        if built.returncode:
            raise AssertionError('patched launcher does not compile on Linux: ' + built.stderr)
        cls.launcher.chmod(0o555)
        cls.probe = base / 'probe'
        built = subprocess.run([compiler, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-static', str(PROBE), '-o', str(cls.probe)], capture_output=True, text=True, timeout=120)
        if built.returncode:
            raise AssertionError('probe does not compile: ' + built.stderr)
        shutil.copyfile(cls.probe, base / 'probe-exe')
        cls.probe.chmod(0o555)
        cls.environment = base / 'environment'
        cls.environment.mkdir()
        mount = subprocess.run(['stat', '-f', '-c', '%t', str(base)], capture_output=True, text=True)
        cls.data_fs = mount.stdout.strip().lower() in ('ef53', '1021994', '6a656a63')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def fixture(self, name, with_alias=True, alias_mode='file'):
        base = Path(tempfile.mkdtemp(prefix=name + '-', dir=self.base))
        base.chmod(0o755)
        guidance = base / 'guidance'
        guidance.mkdir()
        os.chown(guidance, self.UID, self.GID)
        guidance.chmod(0o777)
        file = guidance / 'WINTER.md'
        if with_alias and alias_mode == 'file':
            file.write_text(self.SENTINEL + '\n')
            os.chown(file, self.UID, self.GID)
            file.chmod(0o666)
        elif alias_mode == 'symlink':
            file.symlink_to('elsewhere')
        elif alias_mode == 'directory':
            file.mkdir()
        shutil.copyfile(self.base / 'probe-exe', guidance / 'exe')
        (guidance / 'exe').chmod(0o755)
        (guidance / 'escape-link').symlink_to('/outside-sentinel')
        source = base / 'source'
        source.mkdir()
        os.chown(source, self.UID, self.GID)
        source.chmod(0o755)
        return base, guidance, source

    def launch(self, source, guidance=None, trailer=None, kind='process'):
        """Run the patched launcher once. `guidance` is a path opened and passed as the trailer's descriptor."""
        view = Path(tempfile.mkdtemp(prefix='view-', dir=self.base))
        control_root, control_launcher = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        held = []

        def open_path(path, directory=True):
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | (os.O_DIRECTORY if directory else 0))
            held.append(fd)
            return fd
        worker = open_path(self.probe, directory=False)
        environment = open_path(self.environment)
        source_fd = open_path(source)
        arguments = [str(self.launcher), str(worker), str(view), str(control_launcher.fileno()), str(environment), str(self.UID), str(self.GID), 'auto', kind, 'read', '/workspace/folders/source', 'seed', '1024', '-', '1',
                     str(source_fd), '/workspace/folders/source', '0']
        pass_fds = [worker, control_launcher.fileno(), environment, source_fd]
        if guidance is not None:
            descriptor = open_path(guidance, directory=False)
            arguments.extend(['--guidance', str(descriptor)])
            pass_fds.append(descriptor)
        if trailer is not None:
            arguments.extend(trailer)
        try:
            child = subprocess.Popen(arguments, executable=str(self.launcher), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     pass_fds=pass_fds, close_fds=True, env={'LANG': 'C', 'LC_ALL': 'C'}, start_new_session=True)
            control_launcher.close()
            out, err = child.communicate(timeout=60)
            return child.returncode, out.decode(errors='replace'), err.decode(errors='replace')
        finally:
            for fd in held:
                with contextlib.suppress(OSError):
                    os.close(fd)
            control_root.close()
            with contextlib.suppress(OSError):
                control_launcher.close()
            shutil.rmtree(view, ignore_errors=True)

    def observations(self, out):
        values = {}
        mounts = []
        for line in out.splitlines():
            if line.startswith('mount '):
                mounts.append(line[len('mount '):])
            else:
                key, _, rest = line.partition(' ')
                values[key] = rest
        return values, mounts

    def launch_guided(self, name, **kwargs):
        base, guidance, source = self.fixture(name, **kwargs)
        code, out, err = self.launch(source, guidance=str(guidance))
        return base, guidance, source, code, out, err

    def mount_row(self, mounts, point):
        rows = [row.split() for row in mounts]
        match = [row for row in rows if row[4] == point]
        self.assertEqual(len(match), 1, (point, mounts))
        return match[0]

    def test_the_view_and_alias_are_mounted_sealed_and_readable(self):
        if not self.data_fs:
            self.skipTest('the CI temporary directory is not on an allowlisted data filesystem; the refusal tests cover that case')
        base, guidance, source, code, out, err = self.launch_guided('positive')
        self.assertEqual(code, 0, out + err)
        values, mounts = self.observations(out)
        self.assertEqual(values['alias_read'], 'ok ' + self.SENTINEL)
        self.assertEqual(values['view_read'], 'ok ' + self.SENTINEL)
        for key in ('alias_write', 'view_file_write', 'view_create'):
            self.assertEqual(values[key], 'errno=30', key)             # EROFS: read-only by mount, not by permission
        self.assertEqual(values['view_unlink'], 'EROFS')
        for key in ('alias_flags', 'view_flags'):
            self.assertEqual(int(values[key]) & 15, 15, key)           # ST_RDONLY|ST_NOSUID|ST_NODEV|ST_NOEXEC
        self.assertEqual(values['exec_view'], '13')                    # EACCES: noexec
        self.assertEqual(values['leaked_fds'], '0')
        self.assertEqual(values['ls_workspace_winter'], 'WINTER.md')   # one file, never the enclosing .winter
        self.assertEqual(values['ls_run_winter'], 'shared-instructions')
        self.assertEqual(values['ls_run'], 'winter')
        self.assertEqual(values['ls_view'], 'WINTER.md,escape-link,exe')
        self.assertEqual(values['dotdot_file'], 'errno=2')
        self.assertEqual(values['dotdot_etc'], 'errno=2')
        self.assertEqual(values['symlink_out'], 'errno=2')
        view = self.mount_row(mounts, '/run/winter/shared-instructions')
        alias = self.mount_row(mounts, '/workspace/.winter/WINTER.md')
        for row in (view, alias):
            options = row[5].split(',')
            for needed in ('ro', 'nosuid', 'nodev', 'noexec'):
                self.assertIn(needed, options, row)
            self.assertEqual(row[row.index('-') + 1] in ('ext4', 'tmpfs', 'virtiofs'), True, row)
        self.assertFalse([row for row in mounts if '/run/winter/shared-instructions/' in row.split()[4]], 'no mount nested under the view')
        self.assertFalse([row for row in mounts if row.split()[4] == '/workspace/.winter'], 'the enclosing .winter is never a mount')
        self.assertEqual(sorted(path.name for path in guidance.iterdir()), ['WINTER.md', 'escape-link', 'exe'])
        self.assertEqual((guidance / 'WINTER.md').read_text(), self.SENTINEL + '\n')

    def test_without_a_trailer_the_view_is_exactly_what_v1_and_fresh_get(self):
        base, guidance, source = self.fixture('v1')
        code, out, err = self.launch(source)
        self.assertEqual(code, 0, out + err)
        values, mounts = self.observations(out)
        self.assertEqual(values['ls_root_run'], 'errno=2')
        self.assertEqual(values['alias_read'], 'errno=2')
        self.assertEqual(values['leaked_fds'], '0')
        self.assertEqual(mounts, [])

    def test_a_missing_winter_md_mounts_the_directory_without_an_alias(self):
        if not self.data_fs:
            self.skipTest('the CI temporary directory is not on an allowlisted data filesystem')
        base, guidance, source, code, out, err = self.launch_guided('absent', with_alias=False, alias_mode='none')
        self.assertEqual(code, 0, out + err)
        values, mounts = self.observations(out)
        self.assertEqual(values['alias_read'], 'errno=2')
        self.assertEqual(values['ls_workspace_winter'], 'errno=2')
        self.mount_row(mounts, '/run/winter/shared-instructions')
        self.assertFalse([row for row in mounts if 'WINTER.md' in row.split()[3] or row.split()[4].endswith('WINTER.md')])

    def test_a_symlink_a_hardlink_or_a_directory_named_winter_md_refuses_before_any_mount(self):
        if not self.data_fs:
            self.skipTest('the CI temporary directory is not on an allowlisted data filesystem')
        base, guidance, source = self.fixture('symlink', alias_mode='symlink')
        code, out, err = self.launch(source, guidance=str(guidance))
        self.assertEqual(code, 77, out + err)
        self.assertIn('guidance file', err)
        self.assertEqual(out, '')
        base, guidance, source = self.fixture('directory', alias_mode='directory')
        code, out, err = self.launch(source, guidance=str(guidance))
        self.assertEqual(code, 64, out + err)
        base, guidance, source = self.fixture('hardlink')
        os.link(guidance / 'WINTER.md', base / 'second-name')
        code, out, err = self.launch(source, guidance=str(guidance))
        self.assertEqual(code, 64, out + err)
        self.assertEqual(out, '')

    def test_pseudo_filesystems_are_refused_as_guidance(self):
        base, _, source = self.fixture('pseudo')
        for path in ('/proc', '/sys', '/proc/self/fdinfo'):
            if not os.path.isdir(path):
                continue
            code, out, err = self.launch(source, guidance=path)
            self.assertEqual(code, 64, (path, out, err))
            self.assertEqual(out, '')
        # A regular file is not a directory.
        regular = base / 'regular'
        regular.write_text('x')
        code, out, err = self.launch(source, guidance=str(regular))
        self.assertEqual(code, 64, out + err)

    def test_the_source_root_cannot_be_presented_as_guidance(self):
        base, guidance, source = self.fixture('same-root')
        code, out, err = self.launch(source, guidance=str(source))
        self.assertEqual(code, 64, out + err)
        self.assertEqual(out, '')

    def test_a_malformed_trailer_is_refused(self):
        base, guidance, source = self.fixture('malformed')
        for trailer in (['--guidance'], ['--guidance', '05'], ['--other', '9'], ['--guidance', '9', 'extra'], ['--guidance', '2']):
            code, out, err = self.launch(source, trailer=trailer)
            self.assertEqual(code, 64, (trailer, out, err))
            self.assertEqual(out, '')


if __name__ == '__main__':
    unittest.main()

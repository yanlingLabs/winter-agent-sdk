"""The tool launcher's /etc/gitconfig in a real private mount and PID namespace (docs/guest-memory-root.md).

CI runs this as root on Linux (`sudo -n env WINTER_REQUIRE_NATIVE_GITCONFIG=1 python3 -I -S -B scripts/guest-supervisor/test_gitconfig_native.py`); anywhere else it skips.
The tracked tool launcher is compiled and run for the PROCESS worker with a FIXTURE environment image (the real image's etc/gitconfig belongs to the image lane): the host's git,
its libraries and a shell, plus a fixture etc/gitconfig whose url.insteadOf entry is the only thing that turns `winter-fixture:fixture` into a local path.

 - With the file mounted read-only a git clone of a small local repo into a read-write folder succeeds, and /etc holds that one file and nothing else.
 - Without the file the launch goes ahead but /etc does not exist and the same clone fails.
 - With an unsafe file (writable by others, not root-owned, a symlink, a hard link, oversized, or behind a symlinked etc) the launch is refused before anything runs.
"""
import contextlib
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / 'packages/runtime/src/guest/linux-tool-compartment.c'
HEADER = ROOT / 'packages/runtime/src/guest/linux-compartment.h'
REQUIRE_NATIVE = os.environ.get('WINTER_REQUIRE_NATIVE_GITCONFIG') == '1'
UID, GID = 10001, 10000
CC_FLAGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror']
GITCONFIG = '[safe]\n\tdirectory = *\n[init]\n\ttemplateDir =\n[url "/workspace/folders/data/"]\n\tinsteadOf = winter-fixture:\n'

GIT_RUNNER = r'''
#include <unistd.h>
int main(void) {
    char *args[] = {"git", "clone", "-q", "winter-fixture:fixture", "/workspace/folders/source/clone", NULL};
    char *env[] = {"HOME=/tmp", "PATH=/usr/bin:/usr/lib/git-core", "LANG=C", "LC_ALL=C", "GIT_TERMINAL_PROMPT=0", NULL};
    execve("/usr/bin/git", args, env);
    return 126;
}
'''
ETC_PROBE = r'''
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/statvfs.h>
#include <unistd.h>
int main(void) {
    DIR *etc = opendir("/etc");
    if (!etc) { printf("etc absent %d\n", errno); return 0; }
    struct dirent *entry;
    while ((entry = readdir(etc)))
        if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) printf("entry %s\n", entry->d_name);
    closedir(etc);
    int fd = open("/etc/gitconfig", O_RDONLY);
    char buffer[16] = "";
    ssize_t n = fd >= 0 ? read(fd, buffer, sizeof buffer - 1) : -1;
    printf("read %d %.8s\n", (int)n, n > 0 ? buffer : "");
    int w = open("/etc/gitconfig", O_WRONLY);
    printf("write %d %d\n", w, w < 0 ? errno : 0);
    struct statvfs v;
    if (!statvfs("/etc/gitconfig", &v)) printf("flags %d %d %d %d\n", !!(v.f_flag & ST_RDONLY), !!(v.f_flag & ST_NOSUID), !!(v.f_flag & ST_NODEV), !!(v.f_flag & ST_NOEXEC));
    return 0;
}
'''


def native_ok():
    return sys.platform == 'linux' and os.geteuid() == 0 and shutil.which('cc') is not None and shutil.which('git') is not None


class GitconfigNativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not native_ok():
            if REQUIRE_NATIVE:
                raise AssertionError('native gitconfig evidence is required here but this host is not Linux root with cc and git')
            raise unittest.SkipTest('needs Linux, root, a C compiler and git (CI runs this with sudo; never on macOS)')
        cls.temp = tempfile.TemporaryDirectory(prefix='winter-gitconfig-native-')
        cls.base = Path(cls.temp.name)
        cls.base.chmod(0o755)
        shutil.copyfile(TOOL, cls.base / 'launcher.c')
        shutil.copyfile(HEADER, cls.base / 'linux-compartment.h')
        cls.launcher = cls.compile(cls.base / 'launcher.c', 'launcher')
        for name, source in (('git-runner', GIT_RUNNER), ('etc-probe', ETC_PROBE)):
            (cls.base / f'{name}.c').write_text(source)
            setattr(cls, name.replace('-', '_'), cls.compile(cls.base / f'{name}.c', name, flags=['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror']))
        # The repo the clone reads: a root-owned, read-only root of its own.
        cls.data = cls.base / 'data'
        (cls.data / 'fixture').mkdir(parents=True)
        cls.data.chmod(0o755)
        git_env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(cls.base), 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null', 'LANG': 'C'}
        identity = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'safe.directory=*']
        repo = str(cls.data / 'fixture')
        (cls.data / 'fixture' / 'README').write_text('fixture\n')
        for command in (['init', '-q', repo], ['-C', repo, 'add', 'README'], ['-C', repo, *identity, 'commit', '-q', '-m', 'fixture']):
            done = subprocess.run(['git', *identity, *command], capture_output=True, text=True, env=git_env, timeout=60)
            if done.returncode:
                raise AssertionError('cannot build the fixture repo: ' + done.stderr)
        cls.image = cls.base / 'image'
        cls.build_image()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @classmethod
    def compile(cls, source, name, flags=CC_FLAGS):
        target = cls.base / name
        built = subprocess.run([shutil.which('cc'), *flags, '-static', str(source), '-o', str(target)], capture_output=True, text=True, timeout=180)
        if built.returncode:
            raise AssertionError(f'{name} does not compile on Linux: {built.stderr}')
        target.chmod(0o555)
        return target

    @classmethod
    def copy_with_libraries(cls, image, executable, target):
        destination = image / target.lstrip('/')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(executable, destination)
        destination.chmod(0o555)
        listing = subprocess.run(['ldd', str(executable)], capture_output=True, text=True, timeout=30).stdout
        for library in set(re.findall(r'(/[^\s()]+)', listing)):
            path = image / library.lstrip('/')
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(library, path)
                path.chmod(0o555)

    @classmethod
    def build_image(cls):
        """The fixture environment image (without any etc): git as git and as its own upload-pack, a shell for the local transport, and their libraries."""
        image = cls.image
        image.mkdir()
        git = os.path.realpath(shutil.which('git'))
        cls.copy_with_libraries(image, git, '/usr/bin/git')
        cls.copy_with_libraries(image, git, '/usr/lib/git-core/git-upload-pack')
        cls.copy_with_libraries(image, os.path.realpath('/bin/sh'), '/bin/sh')

    def etc(self, image, content=GITCONFIG, mode=0o644, uid=0, kind='file'):
        """Writes etc/gitconfig into a copy of the image; `kind` makes it a symlink, a hard link or a symlinked etc instead."""
        copy = Path(tempfile.mkdtemp(prefix='image-', dir=self.base))
        copy.chmod(0o755)
        for entry in image.iterdir():
            if entry.is_dir():
                shutil.copytree(entry, copy / entry.name, symlinks=True, copy_function=os.link)
            else:
                os.link(entry, copy / entry.name)
        etc = copy / 'etc'
        if kind == 'missing':
            return copy
        if kind == 'etc-symlink':
            (copy / 'real-etc').mkdir()
            (copy / 'real-etc' / 'gitconfig').write_text(content)
            etc.symlink_to('real-etc')
            return copy
        etc.mkdir()
        target = etc / 'gitconfig'
        if kind == 'symlink':
            (etc / 'real').write_text(content)
            target.symlink_to('real')
            return copy
        target.write_text(content)
        os.chown(target, uid, 0)
        target.chmod(mode)
        if kind == 'hardlink':
            os.link(target, etc / 'second-name')
        return copy

    def launch(self, image, worker, timeout=120):
        """The tracked launcher for the process worker with a writable source root and the repo's read-only root; returns (exit code, stdout, stderr, source directory)."""
        view = Path(tempfile.mkdtemp(prefix='view-', dir=self.base))
        source = Path(tempfile.mkdtemp(prefix='source-', dir=self.base))
        source.chmod(0o755)
        os.chown(source, UID, GID)
        control_root, control_launcher = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        held = []

        def opened(path, directory=True):
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | (os.O_DIRECTORY if directory else 0))
            held.append(fd)
            return fd
        worker_fd, environment, source_fd, data_fd = opened(worker, False), opened(image), opened(source), opened(self.data)
        arguments = [str(self.launcher), str(worker_fd), str(view), str(control_launcher.fileno()), str(environment), str(UID), str(GID), 'auto', 'process', 'read', '/workspace/folders/source',
                     'seed', '1024', '-', '2', str(source_fd), '/workspace/folders/source', '0', str(data_fd), '/workspace/folders/data', '1']
        try:
            child = subprocess.Popen(arguments, executable=str(self.launcher), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     pass_fds=[worker_fd, control_launcher.fileno(), environment, source_fd, data_fd], close_fds=True, env={'LANG': 'C', 'LC_ALL': 'C'}, start_new_session=True)
            control_launcher.close()
            out, err = child.communicate(timeout=timeout)
            return child.returncode, out.decode(errors='replace'), err.decode(errors='replace'), source
        finally:
            for fd in held:
                with contextlib.suppress(OSError):
                    os.close(fd)
            control_root.close()
            with contextlib.suppress(OSError):
                control_launcher.close()
            shutil.rmtree(view, ignore_errors=True)

    def test_the_clone_succeeds_with_the_read_only_gitconfig(self):
        image = self.etc(self.image)
        code, out, err, source = self.launch(image, self.git_runner)
        self.assertEqual(code, 0, out + err)
        self.assertEqual((source / 'clone' / 'README').read_text(), 'fixture\n')
        self.assertTrue((source / 'clone' / '.git').is_dir())
        self.assertEqual(os.stat(source / 'clone').st_uid, UID)

    def test_etc_holds_that_one_file_read_only_and_nothing_else(self):
        # Other entries in the image's etc must never reach the view.
        image = self.etc(self.image)
        (image / 'etc' / 'passwd').write_text('root:x:0:0::/root:/bin/sh\n')
        (image / 'etc' / 'hosts').write_text('127.0.0.1 localhost\n')
        code, out, err, _ = self.launch(image, self.etc_probe)
        self.assertEqual(code, 0, out + err)
        lines = out.splitlines()
        self.assertEqual([line for line in lines if line.startswith('entry ')], ['entry gitconfig'], out)
        self.assertRegex(out, r'(?m)^read 15 ')
        self.assertRegex(out, r'(?m)^write -1 (13|30)$')  # refused: EROFS, or EACCES for a non-owner on a read-only mount
        self.assertIn('flags 1 1 1 1', out)

    def test_without_the_file_the_launch_goes_ahead_but_there_is_no_etc_and_the_clone_fails(self):
        image = self.etc(self.image, kind='missing')
        code, out, err, _ = self.launch(image, self.etc_probe)
        self.assertEqual(code, 0, out + err)
        self.assertTrue(out.startswith('etc absent'), out)
        code, out, err, source = self.launch(image, self.git_runner)
        self.assertNotEqual(code, 0, out + err)
        self.assertFalse((source / 'clone' / 'README').exists())

    def test_an_unsafe_file_refuses_the_launch_before_anything_runs(self):
        cases = {
            'group and other writable': dict(mode=0o666),
            'group writable': dict(mode=0o664),
            'other writable': dict(mode=0o646),
            'not root-owned': dict(uid=UID),
            'a symlink': dict(kind='symlink'),
            'a second hard link': dict(kind='hardlink'),
            'a symlinked etc': dict(kind='etc-symlink'),
            'oversized': dict(content=GITCONFIG + '# ' + 'x' * 70000 + '\n'),
        }
        for name, options in cases.items():
            with self.subTest(name):
                image = self.etc(self.image, **options)
                code, out, err, source = self.launch(image, self.git_runner)
                self.assertIn(code, (64, 77), (name, code, out, err))
                self.assertFalse((source / 'clone').exists(), name)
                self.assertEqual(out, '', name)


if __name__ == '__main__':
    unittest.main()

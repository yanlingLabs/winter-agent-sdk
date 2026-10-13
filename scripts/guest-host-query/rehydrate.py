"""Unprivileged, data-only rehydration of the closed host-query source archive.

External reviewed hashes are required; unsigned receipts do not grant authority.
No repository imports, extraction API, permission repair, or code execution.
"""
import argparse
import gzip
import hashlib
import json
import os
import posixpath
import stat
import tarfile
from pathlib import PurePosixPath

MAX_JSON = 16 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_SOURCE = 256 * 1024 * 1024
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_ENTRIES = 20000
MAX_PAX = 16 * 1024
MAX_TAR = MAX_SOURCE + MAX_ENTRIES * (MAX_PAX + 2048)
ROOT_FILES = {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
              'tsconfig.base.json', 'tsconfig.typecheck.json', 'tsconfig.sdk-fence.json', 'bunfig.toml'}
COMPILE_KEYS = {'formatVersion', 'kind', 'inputs', 'inputInventorySha256',
                'compiler', 'base', 'recipe', 'outputs', 'linuxExecutionVerified', 'vmExecutionVerified'}


def unprivileged():
    if os.getuid() == 0 or os.geteuid() == 0:
        raise ValueError('unprivileged rehydration only')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def valid_hash(value):
    return type(value) is str and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def relative(value):
    if type(value) is not str or not value or len(value) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in value) or '\\' in value:
        raise ValueError('source path')
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(p in ('.', '..') for p in path.parts):
        raise ValueError('source path')
    return value


def directory(path):
    """Pin every ancestor without following symlinks."""
    parts = os.path.abspath(path).split('/')[1:]
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for part in parts:
            if not part:
                continue
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_input(path):
    parent = directory(os.path.dirname(os.path.abspath(path)))
    try:
        fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise ValueError('owned regular unique input required')
            return fd
        except BaseException:
            os.close(fd)
            raise
    finally:
        os.close(parent)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink, info.st_uid)


def measure(fd, limit, expected=None, retain=False):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_size > limit:
        raise ValueError('input identity/size')
    result = hashlib.sha256()
    chunks = []
    count = 0
    while count < before.st_size:
        data = os.pread(fd, min(65536, before.st_size - count), count)
        if not data:
            raise ValueError('input truncated')
        result.update(data)
        count += len(data)
        if retain:
            chunks.append(data)
    if identity(before) != identity(os.fstat(fd)) or os.pread(fd, 1, count):
        raise ValueError('input changed')
    if expected is not None and (not valid_hash(expected) or result.hexdigest() != expected):
        raise ValueError('external input hash mismatch')
    return b''.join(chunks) if retain else {'bytes': count, 'sha256': result.hexdigest()}


def unique_json(wire):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate receipt field')
            result[key] = value
        return result
    return json.loads(wire, object_pairs_hook=pairs)


def resolve_link(name, inputs, dirs):
    target = name
    seen = set()
    for _ in range(40):
        parts = target.split('/')
        for count in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:count])
            item = inputs.get(prefix, {})
            if item.get('kind') != 'symlink':
                continue
            if prefix in seen:
                raise ValueError('symlink cycle')
            seen.add(prefix)
            tail = '/'.join(parts[count:])
            target = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), item['target'], tail))
            relative(target)
            break
        else:
            if target not in inputs and target not in dirs:
                raise ValueError('symlink target outside closure')
            return
    raise ValueError('symlink depth')


def validate_inventory(compiled):
    if type(compiled) is not dict or set(compiled) != COMPILE_KEYS or type(compiled['formatVersion']) is not int or compiled['formatVersion'] != 1 or compiled['kind'] != 'winter-host-query-compile':
        raise ValueError('closed compile receipt required')
    if compiled['linuxExecutionVerified'] is not False or compiled['vmExecutionVerified'] is not False or type(compiled['outputs']) is not dict or set(compiled['outputs']) != {'runtimeEntry', 'providerWorker', 'hostClient'}:
        raise ValueError('compile profile/authority')
    inputs = compiled['inputs']
    if type(inputs) is not dict or not 1 <= len(inputs) <= MAX_ENTRIES or hashlib.sha256(canonical(inputs)).hexdigest() != compiled['inputInventorySha256']:
        raise ValueError('compile inventory digest/count')
    dirs = set()
    total = 0
    for name, item in inputs.items():
        relative(name)
        if name not in ROOT_FILES and name.split('/')[0] not in ('packages', 'scripts', 'node_modules'):
            raise ValueError('source root')
        dirs.update(str(p) for p in PurePosixPath(name).parents if str(p) != '.')
        if type(item) is not dict:
            raise ValueError('inventory record')
        if item.get('kind') == 'file':
            if set(item) != {'kind', 'bytes', 'sha256'} or type(item['bytes']) is not int or not 0 <= item['bytes'] <= MAX_FILE or not valid_hash(item['sha256']):
                raise ValueError('inventory file limit/shape')
            total += item['bytes']
        elif item.get('kind') == 'symlink':
            target = item.get('target')
            if set(item) != {'kind', 'target'} or type(target) is not str or not target or len(target) > 4096 or '\0' in target or '\\' in target or PurePosixPath(target).is_absolute():
                raise ValueError('inventory symlink')
        else:
            raise ValueError('inventory kind')
    if total > MAX_SOURCE or not ROOT_FILES <= inputs.keys() or dirs & inputs.keys():
        raise ValueError('source bytes/ancestor collision')
    for name, item in inputs.items():
        if item['kind'] == 'symlink':
            resolve_link(name, inputs, dirs)
    return inputs, dirs


class BoundedTar:
    """Read fixed headers and capped local PAX only; never call tar extraction."""
    def __init__(self, stream):
        self.stream = stream
        self.count = 0

    def read(self, size):
        if size > 65536 or self.count + size > MAX_TAR:
            raise ValueError('uncompressed archive limit')
        chunks = []
        left = size
        while left:
            chunk = self.stream.read(left)
            if not chunk:
                raise ValueError('truncated archive')
            chunks.append(chunk)
            left -= len(chunk)
        self.count += size
        return b''.join(chunks)

    def padding(self, size):
        pad = (-size) % 512
        if pad and any(self.read(pad)):
            raise ValueError('nonzero archive padding')


def pax_fields(wire):
    result = {}
    while wire:
        boundary = wire.find(b' ')
        if not 1 <= boundary <= 6 or not wire[:boundary].isdigit():
            raise ValueError('PAX length')
        length = int(wire[:boundary])
        if not boundary + 3 <= length <= len(wire) or wire[length-1:length] != b'\n':
            raise ValueError('PAX record')
        key, separator, value = wire[boundary+1:length-1].partition(b'=')
        if not separator or key not in (b'path', b'linkpath', b'mtime') or key in result or b'\0' in value or len(value) > 4096:
            raise ValueError('PAX field')
        result[key] = value.decode('utf-8', 'strict')
        wire = wire[length:]
    return result


def archive_pass(fd, inputs, sink=None):
    os.lseek(fd, 0, os.SEEK_SET)
    seen = set()
    links = []
    headers = 0
    fields = None
    # The duplicate keeps the caller's held FD alive. Gzip reads are always bounded.
    with os.fdopen(os.dup(fd), 'rb') as raw, gzip.GzipFile(fileobj=raw, mode='rb') as stream:
        reader = BoundedTar(stream)
        while True:
            block = reader.read(512)
            if block == bytes(512):
                if fields is not None or reader.read(512) != bytes(512):
                    raise ValueError('archive end marker')
                while True:
                    tail = stream.read(65536)
                    if not tail:
                        break
                    reader.count += len(tail)
                    if reader.count > MAX_TAR or any(tail):
                        raise ValueError('archive trailing data/limit')
                break
            headers += 1
            if headers > MAX_ENTRIES * 2:
                raise ValueError('archive header count')
            member = tarfile.TarInfo.frombuf(block, 'utf-8', 'strict')
            if member.type == tarfile.XHDTYPE:
                if fields is not None or not 1 <= member.size <= MAX_PAX:
                    raise ValueError('PAX metadata limit/order')
                fields = pax_fields(reader.read(member.size))
                reader.padding(member.size)
                continue
            if member.type not in (tarfile.REGTYPE, tarfile.LNKTYPE, tarfile.SYMTYPE):
                raise ValueError('archive member type')
            if fields:
                member.name = fields.get(b'path', member.name)
                member.linkname = fields.get(b'linkpath', member.linkname)
            fields = None
            if not member.name.startswith('source/'):
                raise ValueError('archive source prefix')
            name = relative(member.name[7:])
            item = inputs.get(name)
            if item is None or name in seen:
                raise ValueError('extra/duplicate source leaf')
            if member.type == tarfile.SYMTYPE:
                if member.size != 0 or item != {'kind': 'symlink', 'target': member.linkname}:
                    raise ValueError('source symlink mismatch')
                links.append(name)
            elif member.type == tarfile.LNKTYPE:
                if member.size != 0 or not member.linkname.startswith('source/'):
                    raise ValueError('hardlink source prefix/size')
                target = relative(member.linkname[7:])
                if target not in seen or inputs[target].get('kind') != 'file' or item != inputs[target]:
                    raise ValueError('hardlink order/target bytes')
                if sink:
                    sink.copy(name, target, item)
            else:
                if item.get('kind') != 'file' or member.size != item['bytes'] or member.linkname:
                    raise ValueError('source file shape/bytes')
                digest = hashlib.sha256()
                left = member.size
                output = sink.create(name) if sink else None
                try:
                    while left:
                        data = reader.read(min(left, 65536))
                        left -= len(data)
                        digest.update(data)
                        if output is not None:
                            write_all(output, data)
                    if digest.hexdigest() != item['sha256']:
                        raise ValueError('source file hash')
                finally:
                    if output is not None:
                        os.close(output)
                reader.padding(member.size)
            seen.add(name)
        if seen != inputs.keys():
            raise ValueError('missing source leaves')
    if sink:
        for name in links:
            sink.symlink(name, inputs[name]['target'])


def write_all(fd, data):
    while data:
        try:
            count = os.write(fd, data)
        except InterruptedError:
            continue
        if count <= 0:
            raise ValueError('source write stalled')
        data = data[count:]


class Destination:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.parent = directory(os.path.dirname(os.path.abspath(path)))
        self.name = os.path.basename(path)
        self.root = None
        try:
            relative(self.name)
            parent = os.fstat(self.parent)
            if parent.st_uid != os.getuid() or parent.st_mode & 0o022:
                raise ValueError('owned nonwritable-by-others destination parent required')
            os.mkdir(self.name, 0o700, dir_fd=self.parent)
            self.root = os.open(self.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.parent)
            self.check_binding()
        except BaseException:
            self.close()
            raise

    def check_binding(self):
        actual = os.fstat(self.root)
        named = os.stat(self.name, dir_fd=self.parent, follow_symlinks=False)
        if not stat.S_ISDIR(actual.st_mode) or actual.st_uid != os.getuid() or stat.S_IMODE(actual.st_mode) != 0o700 or (named.st_dev, named.st_ino) != (actual.st_dev, actual.st_ino):
            raise ValueError('destination changed')
        current = directory(self.path)
        try:
            info = os.fstat(current)
            if (info.st_dev, info.st_ino) != (actual.st_dev, actual.st_ino):
                raise ValueError('destination ancestry changed')
        finally:
            os.close(current)

    def folder(self, name, create=False):
        fd = os.dup(self.root)
        try:
            for part in relative(name).split('/')[:-1]:
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                info = os.fstat(child)
                if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                    os.close(child)
                    raise ValueError('destination ancestor')
                os.close(fd)
                fd = child
            return fd
        except BaseException:
            os.close(fd)
            raise

    def create(self, name):
        parent = self.folder(name, True)
        try:
            fd = os.open(name.split('/')[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=parent)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                os.close(fd)
                raise ValueError('destination leaf')
            return fd
        finally:
            os.close(parent)

    def copy(self, name, target, item):
        parent = self.folder(target)
        try:
            source = os.open(target.split('/')[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        finally:
            os.close(parent)
        try:
            if measure(source, MAX_FILE) != {'bytes': item['bytes'], 'sha256': item['sha256']}:
                raise ValueError('hardlink target changed')
            output = self.create(name)
            try:
                offset = 0
                while offset < item['bytes']:
                    data = os.pread(source, min(65536, item['bytes'] - offset), offset)
                    if not data:
                        raise ValueError('hardlink target truncated')
                    write_all(output, data)
                    offset += len(data)
            finally:
                os.close(output)
        finally:
            os.close(source)

    def symlink(self, name, target):
        parent = self.folder(name, True)
        try:
            os.symlink(target, name.split('/')[-1], dir_fd=parent)
        finally:
            os.close(parent)

    def verify(self, inputs, dirs):
        result = {}
        actual_dirs = set()
        def walk(fd, prefix):
            with os.scandir(fd) as entries:
                for entry in entries:
                    name = relative(prefix + entry.name)
                    info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        if name not in dirs or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                            raise ValueError('unexpected destination directory')
                        actual_dirs.add(name)
                        child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                        try:
                            walk(child, name + '/')
                        finally:
                            os.close(child)
                    elif stat.S_ISLNK(info.st_mode):
                        if name not in inputs or info.st_uid != os.getuid():
                            raise ValueError('unexpected destination link')
                        result[name] = {'kind': 'symlink', 'target': os.readlink(entry.name, dir_fd=fd)}
                    else:
                        if name not in inputs or stat.S_IMODE(info.st_mode) != 0o600:
                            raise ValueError('unexpected destination file')
                        leaf = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
                        try:
                            result[name] = {'kind': 'file', **measure(leaf, MAX_FILE)}
                        finally:
                            os.close(leaf)
        walk(self.root, '')
        self.check_binding()
        if result != inputs or actual_dirs != dirs:
            raise ValueError('rehydrated closure mismatch')

    def close(self):
        for name in ('root', 'parent'):
            fd = getattr(self, name, None)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)


def rehydrate(archive, compile_receipt, destination, archive_sha256, compile_sha256):
    unprivileged()
    if not valid_hash(archive_sha256) or not valid_hash(compile_sha256):
        raise ValueError('external reviewed hashes required')
    archive_fd = receipt_fd = None
    try:
        archive_fd = open_input(archive)
        receipt_fd = open_input(compile_receipt)
        measure(archive_fd, MAX_ARCHIVE, archive_sha256)
        wire = measure(receipt_fd, MAX_JSON, compile_sha256, retain=True)
        inputs, dirs = validate_inventory(unique_json(wire))
        archive_pass(archive_fd, inputs)
        measure(archive_fd, MAX_ARCHIVE, archive_sha256)
        # No destination exists until the complete closure and all bytes were validated.
        sink = Destination(destination)
        try:
            archive_pass(archive_fd, inputs, sink)
            measure(archive_fd, MAX_ARCHIVE, archive_sha256)
            measure(receipt_fd, MAX_JSON, compile_sha256)
            sink.verify(inputs, dirs)
        finally:
            sink.close()
        return {'rehydrated': True, 'files': sum(i['kind'] == 'file' for i in inputs.values()),
                'symlinks': sum(i['kind'] == 'symlink' for i in inputs.values()),
                'archiveSha256': archive_sha256, 'compileReceiptSha256': compile_sha256,
                'executionAdmitted': False}
    finally:
        for fd in (archive_fd, receipt_fd):
            if fd is not None:
                os.close(fd)


def main():
    try:
        unprivileged()
    except ValueError:
        print('{"rehydrated":false,"class":"unprivileged_only"}')
        return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--compile-receipt', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--compile-sha256', required=True)
    args = parser.parse_args()
    try:
        result = rehydrate(args.archive, args.compile_receipt, args.destination, args.archive_sha256, args.compile_sha256)
    except (OSError, ValueError, EOFError, tarfile.TarError, UnicodeError, RecursionError):
        print('{"rehydrated":false,"class":"source_rehydration_refused"}')
        return 1
    print(canonical(result).decode())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

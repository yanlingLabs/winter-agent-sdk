"""Unprivileged, explicit measured utility closure capture. Never launches a utility.
Unsigned capture receipts require independent build provenance and sealed admission.
"""
import os, sys
if __name__ == '__main__' and os.geteuid() == 0:
    raise SystemExit('unprivileged source capture only; root entry refused')
import argparse, hashlib, json, platform, re, stat
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
EXECUTABLES = frozenset(('/bin/bash', '/bin/cat', '/usr/bin/git', '/usr/bin/python3', '/usr/bin/openssl', '/usr/bin/mktemp'))
ELF_LOADERS = frozenset(('/lib/ld-linux-aarch64.so.1', '/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1'))
EXECUTABLE_SOURCES = {'/bin/bash': {'bin/bash', 'usr/bin/bash'}, '/bin/cat': {'bin/cat', 'usr/bin/cat'}, '/usr/bin/git': {'usr/bin/git'}, '/usr/bin/python3': {'usr/bin/python3.12'}, '/usr/bin/openssl': {'usr/bin/openssl'}, '/usr/bin/mktemp': {'bin/mktemp', 'usr/bin/mktemp'}}
SOURCES = ('scripts/guest-utilities/closure.py', 'scripts/guest-utilities/oracle.py', 'scripts/guest-utilities/smoke.sh')
MAX_FILE = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_ENTRIES = 2048
MAX_MANIFEST = 2 * 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def relative(value):
    if not isinstance(value, str) or not value or len(value) > 1024 or '\\' in value or '\0' in value:
        raise ValueError('closure path')
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in ('.', '..') for part in path.parts):
        raise ValueError('closure path')
    return value


def validate_manifest(value):
    if type(value) is not dict or set(value) != {'formatVersion', 'kind', 'target', 'files'} or type(value['formatVersion']) is not int or value['formatVersion'] != 1 or value['kind'] != 'winter-tool-utility-inputs' or value['target'] != 'linux-arm64-gnu':
        raise ValueError('closure manifest shape')
    files = value['files']
    if type(files) is not dict or not 1 <= len(files) <= MAX_ENTRIES:
        raise ValueError('closure inventory limit')
    executable = set(); total = 0
    for guest, item in files.items():
        if not isinstance(guest, str) or not guest.startswith('/'):
            raise ValueError('guest closure path')
        relative(guest[1:])
        if type(item) is not dict or set(item) != {'role', 'source', 'sha256', 'bytes', 'executable'}:
            raise ValueError('closure leaf shape')
        relative(item['source'])
        if not isinstance(item['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', item['sha256']) or type(item['bytes']) is not int or not 1 <= item['bytes'] <= MAX_FILE:
            raise ValueError('closure leaf measurement')
        total += item['bytes']; role = item['role']
        expected_execution = role == 'executable' or role == 'library' and guest in ELF_LOADERS
        if type(item['executable']) is not bool or item['executable'] is not expected_execution:
            raise ValueError('fixed execution-mode intent required')
        if role == 'executable':
            if guest not in EXECUTABLES or item['source'] not in EXECUTABLE_SOURCES[guest]:
                raise ValueError('unadmitted executable')
            executable.add(guest)
        elif role == 'library':
            if not (guest == '/lib/ld-linux-aarch64.so.1' or re.fullmatch(r'/(?:usr/)?lib/aarch64-linux-gnu/[A-Za-z0-9_.+-]+\.so(?:\.[0-9.]+)?', guest)):
                raise ValueError('unadmitted library')
            if not re.fullmatch(r'(?:usr/)?lib/(?:aarch64-linux-gnu/)?[A-Za-z0-9_.+-]+\.so(?:\.[0-9.]+)?', item['source']):
                raise ValueError('unadmitted library source')
        elif role in ('stdlib', 'extension'):
            if not guest.startswith('/usr/lib/python3.12/') or any(part in ('site-packages', 'dist-packages', '__pycache__', 'test', 'tests', 'ensurepip') for part in PurePosixPath(guest).parts):
                raise ValueError('unadmitted Python closure')
            if item['source'] != guest[1:]:
                raise ValueError('unadmitted Python source')
            if role == 'stdlib' and not guest.endswith('.py') or role == 'extension' and not re.fullmatch(r'/usr/lib/python3\.12/lib-dynload/[A-Za-z0-9_.+-]+\.so', guest):
                raise ValueError('Python closure role')
        else:
            raise ValueError('closure role')
    if executable != EXECUTABLES or not ELF_LOADERS <= set(files) or total > MAX_TOTAL:
        raise ValueError('required utility closure/limit')
    for guest in files:
        if any(str(parent) in files for parent in PurePosixPath(guest).parents):
            raise ValueError('closure prefix collision')
    required = ('encodings/__init__.py', 'encodings/utf_8.py', 'multiprocessing/__init__.py', 'multiprocessing/shared_memory.py', 'multiprocessing/synchronize.py', 'multiprocessing/resource_tracker.py')
    if any('/usr/lib/python3.12/' + name not in files for name in required):
        raise ValueError('required Python closure')
    for name in ('_multiprocessing.', '_posixshmem.'):
        if not any(item['role'] == 'extension' and PurePosixPath(guest).name.startswith(name) for guest, item in files.items()):
            raise ValueError('required Python extension')
    return value


def open_root(path):
    path = Path(os.path.abspath(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd); raise


def leaf(root, name):
    parts = relative(name).split('/'); folder = os.dup(root)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
            os.close(folder); folder = child
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=folder)
    finally:
        os.close(folder)


def identity(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def measure(fd, output=None, limit=MAX_FILE):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or not 1 <= before.st_size <= limit:
        raise ValueError('closure regular leaf/limit')
    hasher = hashlib.sha256(); count = 0; header = bytearray()
    while True:
        data = os.read(fd, min(65536, limit - count + 1))
        if not data:
            break
        count += len(data)
        if count > limit:
            raise ValueError('closure read limit')
        hasher.update(data); header.extend(data[:max(0, 20 - len(header))])
        if output is not None:
            at = 0
            while at < len(data):
                written = os.write(output, data[at:])
                if written <= 0:
                    raise ValueError('closure copy write')
                at += written
    if count != before.st_size or identity(before) != identity(os.fstat(fd)):
        raise ValueError('closure input changed during held-FD read')
    return {'sha256': hasher.hexdigest(), 'bytes': count}, bytes(header)


def measured_path(path, limit=MAX_FILE):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        return measure(fd, limit=limit)[0]
    finally:
        os.close(fd)


def capture(source, manifest, output):
    if os.geteuid() == 0:
        raise ValueError('unprivileged capture required')
    manifest = validate_manifest(json.loads(canonical(manifest)))
    sources = {name: measured_path(ROOT / name) for name in SOURCES}
    builder_path = Path(sys.executable).resolve()
    builder = {**measured_path(builder_path, 128 * 1024 * 1024), 'version': platform.python_version(), 'platform': sys.platform, 'architecture': platform.machine()}
    root = open_root(source); output = Path(output); copied = {}
    try:
        output.mkdir(mode=0o700)
        environment = output / 'environment'; environment.mkdir(mode=0o700)
        for guest, item in sorted(manifest['files'].items()):
            target = environment / guest[1:]; target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            fd = leaf(root, item['source']); destination = None
            try:
                destination = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                measured, header = measure(fd, destination)
                if measured != {key: item[key] for key in ('sha256', 'bytes')}:
                    raise ValueError('manifest input measurement changed')
                if item['role'] in ('executable', 'library', 'extension') and (len(header) != 20 or header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 183):
                    raise ValueError('ARM64 ELF utility/library required')
                os.fsync(destination); os.fchmod(destination, 0o555 if item['executable'] else 0o444)
                copied[guest] = {'role': item['role'], 'executable': item['executable'], **measured}
            finally:
                os.close(fd)
                if destination is not None:
                    os.close(destination)
        if {name: measured_path(ROOT / name) for name in SOURCES} != sources or measured_path(builder_path, 128 * 1024 * 1024) != {key: builder[key] for key in ('sha256', 'bytes')}:
            raise ValueError('capture builder/source changed')
        receipt = {'formatVersion': 1, 'kind': 'winter-tool-utility-capture', 'target': manifest['target'], 'inputs': manifest['files'], 'inputManifestSha256': digest(canonical(manifest).encode()), 'sources': sources, 'builder': builder, 'recipe': {'operation': 'held-fd-byte-copy', 'implicitDiscovery': False, 'utilityExecution': False}, 'outputs': copied, 'outputInventorySha256': digest(canonical(copied).encode()), 'dependencyCompletenessVerified': False, 'linuxExecutionVerified': False, 'vmExecutionVerified': False, 'generalToolAvailabilityEnabled': False}
        fd = os.open(output / 'utility-receipt.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o444)
        try:
            wire = (canonical(receipt) + '\n').encode(); at = 0
            while at < len(wire):
                written = os.write(fd, wire[at:])
                if written <= 0:
                    raise ValueError('closure receipt write')
                at += written
            os.fsync(fd)
        finally:
            os.close(fd)
        return receipt
    finally:
        os.close(root)


def validate_capture(receipt, environment, sealed=False):
    if type(sealed) is not bool:
        raise ValueError('explicit capture validation context required')
    keys = {'formatVersion', 'kind', 'target', 'inputs', 'inputManifestSha256', 'sources', 'builder', 'recipe', 'outputs', 'outputInventorySha256', 'dependencyCompletenessVerified', 'linuxExecutionVerified', 'vmExecutionVerified', 'generalToolAvailabilityEnabled'}
    if type(receipt) is not dict or set(receipt) != keys or type(receipt['formatVersion']) is not int or receipt['formatVersion'] != 1 or receipt['kind'] != 'winter-tool-utility-capture':
        raise ValueError('capture receipt shape')
    manifest = validate_manifest({'formatVersion': 1, 'kind': 'winter-tool-utility-inputs', 'target': receipt['target'], 'files': receipt['inputs']})
    expected = {guest: {key: item[key] for key in ('role', 'executable', 'sha256', 'bytes')} for guest, item in manifest['files'].items()}
    if receipt['inputManifestSha256'] != digest(canonical(manifest).encode()) or receipt['outputs'] != expected or receipt['outputInventorySha256'] != digest(canonical(expected).encode()):
        raise ValueError('capture measurement binding')
    if type(receipt['recipe']) is not dict or receipt['recipe'] != {'operation': 'held-fd-byte-copy', 'implicitDiscovery': False, 'utilityExecution': False} or any(receipt['recipe'][key] is not False for key in ('implicitDiscovery', 'utilityExecution')) or any(receipt[key] is not False for key in ('dependencyCompletenessVerified', 'linuxExecutionVerified', 'vmExecutionVerified', 'generalToolAvailabilityEnabled')):
        raise ValueError('capture cannot establish execution/availability')
    if receipt['sources'] != {name: measured_path(ROOT / name) for name in SOURCES}:
        raise ValueError('capture source changed')
    builder = receipt['builder']
    if type(builder) is not dict or set(builder) != {'sha256', 'bytes', 'version', 'platform', 'architecture'} or not isinstance(builder['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', builder['sha256']) or type(builder['bytes']) is not int or not 1 <= builder['bytes'] <= MAX_TOTAL or not all(isinstance(builder[key], str) and 1 <= len(builder[key]) <= 128 for key in ('version', 'platform', 'architecture')):
        raise ValueError('capture builder identity')
    names = set(); directories = set()
    for guest in expected:
        directories.update(str(parent)[1:] for parent in PurePosixPath(guest).parents if str(parent) != '/')
    environment = Path(environment)
    for directory, folders, files in os.walk(environment, followlinks=False):
        for name in folders:
            path = Path(directory) / name
            if path.is_symlink() or path.relative_to(environment).as_posix() not in directories:
                raise ValueError('unmeasured closure directory/link')
        for name in files:
            guest = '/' + (Path(directory) / name).relative_to(environment).as_posix()
            if guest not in expected:
                raise ValueError('unmeasured closure leaf')
            names.add(guest)
    if names != set(expected):
        raise ValueError('unmeasured or missing closure leaf')
    root = open_root(environment)
    try:
        for guest, item in expected.items():
            fd = leaf(root, guest[1:])
            try:
                if os.fstat(fd).st_nlink != 1:
                    raise ValueError('captured utility multiply linked')
                measured, header = measure(fd)
                after = os.fstat(fd)
                if after.st_nlink != 1:
                    raise ValueError('captured utility multiply linked')
                expected_mode = (0o500 if item['executable'] else 0o400) if sealed else (0o555 if item['executable'] else 0o444)
                if sealed and after.st_uid != 0:
                    raise ValueError('sealed captured utility root owner required')
                if measured != {key: item[key] for key in ('sha256', 'bytes')} or stat.S_IMODE(after.st_mode) != expected_mode:
                    raise ValueError('captured utility changed/execution-mode mismatch')
                if item['role'] != 'stdlib' and (len(header) != 20 or header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 183):
                    raise ValueError('captured utility target')
            finally:
                os.close(fd)
    finally:
        os.close(root)
    return receipt


def main():
    if not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
        raise SystemExit('capture requires isolated system Python -I -S -B')
    parser = argparse.ArgumentParser(); parser.add_argument('--utility-root', required=True); parser.add_argument('--manifest', required=True); parser.add_argument('--out', required=True); args = parser.parse_args()
    fd = os.open(args.manifest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        measured, _ = measure(fd, limit=MAX_MANIFEST); os.lseek(fd, 0, os.SEEK_SET); wire = os.read(fd, MAX_MANIFEST + 1)
        if digest(wire) != measured['sha256']:
            raise ValueError('capture manifest changed')
    finally:
        os.close(fd)
    def unique(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError('duplicate input manifest field')
            result[key] = item
        return result
    receipt = capture(args.utility_root, json.loads(wire, object_pairs_hook=unique), args.out)
    print(canonical({'captured': True, 'receiptSha256': measured_path(Path(args.out) / 'utility-receipt.json')['sha256'], 'generalToolAvailabilityEnabled': False, 'linuxExecutionVerified': False}))


if __name__ == '__main__':
    main()

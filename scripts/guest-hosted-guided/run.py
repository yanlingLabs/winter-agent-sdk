"""The root runner of the one-run guided hosted fixture. Source only: never started by its author.

The workflow's root launcher hashes THIS file and executes exactly the hashed bytes with
    run.py <packet-dir> <out-dir> <verifier.py> <verifier-sha256> <pin.json> <pin-sha256>
It then loads its two siblings, `oracle.py` and `roles_adapter.py`, only by the SHA-256 embedded below, so every byte that
runs as root is covered by RUNNER_SHA256 through this file. Order, and why:

  1. admission: root, and the one opt-in variable;
  2. the packet is verified FIRST, before any other work, by runtime-sdk's `verify_packet.py` run as the packet's own
     unprivileged owner (it refuses root) against the run-2 pin: it must exit 0 with allChecksHold true, every check
     true, and no placeholder role left in the pin. CI cannot catch a well-formed wrong hash in a pin; this can;
  3. the siblings are loaded by hash;
  4. the packet is staged into a root-owned tree;
  5. the exit-64 case (independent), then the guided query chain through the roles adapter, then teardown;
  6. the verdict is `oracle.evaluate` over Root-side evidence; the result is one bounded JSON written with O_EXCL.

PLATFORM: the Root-side primitives that need the supervisor, the native owner, the mounts and the reader launcher
(`exit64_case`, `open_session`) are NOT written yet; `RealPlatform` refuses them with the class `platform_incomplete`.
So this file, as committed, can never spend the approved run on a half-built fixture. Writing them is owed.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform as host_platform
import posixpath
import stat
import subprocess
import sys
import re
import tarfile
import types
from collections import namedtuple

SCHEMA = 'winter-guided-hosted-run/1'
OPT_IN = 'WINTER_GUIDED_HOSTED_ADMISSION'
OPT_IN_VALUE = 'disposable-linux-guided-hosted-run'
# SHA-256 of the two siblings this file may load. Changing either sibling changes these and therefore this file's hash.
ORACLE_SHA256 = '295075e74776a4b40a7e5d4f11912d52f47bb8f03e112e6f48d687de6fa3323e'
ADAPTER_SHA256 = '777afafbfcc3b326e6c7f839af8fe57d06440ac21bda47f4598a82cd529d5bbe'
SESSION_SHA256 = '61ccfb2e0635074cd47f8292bf65a0856d9286fdc67cb0e8f4726bf70ef4d772'
# The Core-dependent inputs (the host fixture records, the provider script's marker lines, the two prompts, the guidance
# texts) are DATA this lane cannot invent; they live in a closed JSON file next to this one, pinned here. Zero = not supplied.
FIXTURE_INPUTS_SHA256 = '0' * 64
CLASSES = (
    'admission', 'arguments', 'packet_verify', 'metafile', 'sibling_pin', 'platform_incomplete', 'stage_packet', 'exit64_case', 'session',
    'provider_start', 'dispatch1', 'shared_edit', 'dispatch2', 'ticket_reuse', 'revocation', 'host_result', 'teardown', 'verdict',
    'result_write',
)
MAX_SMALL = 16 * 1024 * 1024
VERIFY_TIMEOUT = 600


class RunnerError(Exception):
    def __init__(self, failure_class):
        assert failure_class in CLASSES
        super().__init__(failure_class)
        self.failure_class = failure_class


class PlatformIncomplete(Exception):
    pass


# What `stage_packet` returns: the staged root-owned tree, the verified pin, and the packet inventory (hash per member).
Staged = namedtuple('Staged', 'root pin inventory')
MODULE_TAIL = re.compile(r'(?:packages/sdk/src|winter-agent-sdk/(?:src|dist))/(.+?)(?:\.d)?\.(?:ts|js|mjs)$')


def check_host_metafile(path):
    """Preflight, executes nothing: every SDK module appears exactly once among the hostClient bundle's inputs. Two copies of
    `guided-query-reader.ts` would make the reader lookup refuse everything and waste the run (it would fail closed)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_SMALL:
                raise ValueError('identity')
            data = os.pread(fd, MAX_SMALL + 1, 0)
        finally:
            os.close(fd)
        inputs = json.loads(data)['inputs']
        tails = {}
        for key in inputs:
            match = MODULE_TAIL.search(key)
            if match:
                tails[match.group(1)] = tails.get(match.group(1), 0) + 1
        if not tails or tails.get('guided-query-reader') != 1 or any(count != 1 for count in tails.values()):
            raise ValueError('duplicate')
    except (OSError, ValueError, KeyError, TypeError):
        raise RunnerError('metafile') from None


def read_pinned(path, expected_sha256, limit=MAX_SMALL):
    """Bounded no-follow read of a regular single-link file whose SHA-256 must equal `expected_sha256`."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError('identity')
        data = os.pread(fd, limit + 1, 0)
    finally:
        os.close(fd)
    if len(data) != before.st_size or hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError('digest')
    return data


def verify_packet(packet_dir, verifier, verifier_sha256, pin, pin_sha256):
    """Run runtime-sdk's verifier as the packet's own unprivileged owner. Returns the parsed pin, or raises packet_verify."""
    try:
        read_pinned(verifier, verifier_sha256)
        pin_bytes = read_pinned(pin, pin_sha256)
        pin_data = json.loads(pin_bytes)
        info = os.stat(packet_dir)
        if info.st_uid == 0 or info.st_gid == 0:
            raise ValueError('owner')
        archive = os.path.join(packet_dir, 'guided-packet.tar.gz')
        inventory = os.path.join(packet_dir, 'packet-inventory.json')
        # As root the verifier runs as the packet's own owner with no supplementary groups (it refuses root); the drop is
        # not applied when this file is exercised unprivileged by its tests, where there is nothing to drop.
        drop = {'user': info.st_uid, 'group': info.st_gid, 'extra_groups': []} if os.geteuid() == 0 else {}
        result = subprocess.run(
            [sys.executable, '-I', '-B', verifier, archive, inventory, '--pin', pin], **drop,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, cwd='/', stdin=subprocess.DEVNULL, capture_output=True, timeout=VERIFY_TIMEOUT, check=False)
        if result.returncode != 0 or len(result.stdout) > MAX_SMALL:
            raise ValueError('verifier')
        report = json.loads(result.stdout)
        checks = report.get('checks')
        if (report.get('kind') != 'winter-guided-packet-verification' or report.get('allChecksHold') is not True or report.get('outputsExecuted') is not False
                or type(checks) is not dict or not checks or any(value is not True for value in checks.values()) or report.get('placeholders') != []):
            raise ValueError('report')
        roles = pin_data['artifacts']['roles']
        if any(item.get('placeholder') for item in roles.values()):
            raise ValueError('placeholder')
        return pin_data
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        raise RunnerError('packet_verify') from None


def load_sibling(directory, name, expected_sha256, module_name):
    try:
        data = read_pinned(os.path.join(directory, name), expected_sha256)
        module = types.ModuleType(module_name)
        module.__file__ = os.path.join(directory, name)
        exec(compile(data, module.__file__, 'exec'), module.__dict__)
        return module
    except (OSError, ValueError, SyntaxError):
        raise RunnerError('sibling_pin') from None


class Platform:
    """Root-side primitives. Everything here needs the supervisor, the native owner or the reader launcher."""

    def bind(self, session_module, directory):
        """Hands the pinned `session.py` module to the platform before any primitive is used."""

    def stage_packet(self, packet_dir, pin):
        raise PlatformIncomplete('stage_packet')

    def exit64_case(self, staged):
        """Return {'site', 'exitStatus', 'initReceipt', 'pidfdReceived'} for a launcher given a refused envelope."""
        raise PlatformIncomplete('exit64_case')

    def open_session(self, staged):
        """Return a started session: spawn(role) -> process, shared_sha256(), edit_shared(), settle(), reap(), close()."""
        raise PlatformIncomplete('open_session')


class RealPlatform(Platform):
    EXECUTABLE_PREFIXES = ('artifacts/', 'environment/')

    def __init__(self, parent='/run'):
        self.parent = parent
        self.session_module = None
        self.directory = None

    def bind(self, session_module, directory):
        self.session_module, self.directory = session_module, directory

    def stage_packet(self, packet_dir, pin):
        """Extract the verified archive into a fresh root-owned tree: files 0400, role/native/library/Bun-base files 0555,
        links recreated. Modes in the archive are not build evidence (the archiver forces 0400/0777)."""
        import tempfile
        root = tempfile.mkdtemp(prefix='winter-guided-hosted-', dir=self.parent)
        os.chmod(root, 0o700)
        base = pin['bun']['stageBase']['path']
        with open(os.path.join(packet_dir, 'guided-packet.tar.gz'), 'rb') as raw:
            archive = tarfile.open(fileobj=raw, mode='r|gz')
            for member in archive:
                name = member.name
                if name.startswith('/') or '\\' in name or posixpath.normpath(name) != name or '..' in name.split('/'):
                    raise ValueError('path')
                target = os.path.join(root, name)
                os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
                if member.issym():
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                    if member.linkname.startswith('/') or resolved == '..' or resolved.startswith('../'):
                        raise ValueError('link')
                    os.symlink(member.linkname, target)
                elif member.isreg():
                    executable = (name.startswith(self.EXECUTABLE_PREFIXES) and not name.endswith('.metafile.json')) or name == base
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    try:
                        stream = archive.extractfile(member)
                        while True:
                            chunk = stream.read(1 << 20)
                            if not chunk:
                                break
                            view = memoryview(chunk)
                            while view:
                                view = view[os.write(fd, view):]
                        os.fchmod(fd, 0o555 if executable else 0o400)
                    finally:
                        os.close(fd)
                else:
                    raise ValueError('type')
        try:
            with open(os.path.join(packet_dir, 'packet-inventory.json'), 'rb') as raw_inventory:
                inventory = json.loads(raw_inventory.read(MAX_SMALL + 1))['files']
        except (OSError, ValueError, KeyError):
            raise ValueError('inventory') from None
        return Staged(root, pin, inventory)

    def exit64_case(self, staged):
        if self.session_module is None:
            raise PlatformIncomplete('exit64_case')
        return self.session_module.exit64_case(staged)

    def open_session(self, staged):
        if self.session_module is None or FIXTURE_INPUTS_SHA256 == '0' * 64:
            raise PlatformIncomplete('fixture_inputs')
        inputs = json.loads(read_pinned(os.path.join(self.directory, 'fixture-inputs.json'), FIXTURE_INPUTS_SHA256))
        return self.session_module.GuidedSession.open(staged, inputs, self.directory)


def write_result(out_dir, record):
    path = os.path.join(out_dir, 'result.json')
    payload = json.dumps(record, sort_keys=True, indent=1).encode() + b'\n'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError('short write')
            view = view[written:]
    finally:
        os.close(fd)


def run(argv, platform, env, directory, euid=os.geteuid):
    """Returns (record, exit_status). Never raises: every failure becomes a bounded class in the record."""
    record = {'schema': SCHEMA, 'kernelRelease': host_platform.release(), 'machine': host_platform.machine(), 'stage': 'start', 'failureClass': None,
              'passed': False, 'hostPassed': None, 'settled': None, 'exits': None, 'verdict': None}
    session = roles = None
    try:
        record['stage'] = 'admission'
        if euid() != 0 or env.get(OPT_IN) != OPT_IN_VALUE:
            raise RunnerError('admission')
        if len(argv) != 7:
            raise RunnerError('arguments')
        source, packet_dir, out_dir, verifier, verifier_sha256, pin, pin_sha256 = argv
        packet_dir, out_dir, verifier, pin = (os.path.abspath(item) for item in (packet_dir, out_dir, verifier, pin))
        record['stage'] = 'packet_verify'
        pin_data = verify_packet(packet_dir, verifier, verifier_sha256, pin, pin_sha256)
        record['stage'] = 'sibling_pin'
        oracle = load_sibling(directory, 'oracle.py', ORACLE_SHA256, 'guided_hosted_oracle')
        adapter = load_sibling(directory, 'roles_adapter.py', ADAPTER_SHA256, 'guided_hosted_roles')
        session_module = load_sibling(directory, 'session.py', SESSION_SHA256, 'guided_hosted_session')
        platform.bind(session_module, directory)
        try:
            record['stage'] = 'stage_packet'
            staged = platform.stage_packet(packet_dir, pin_data)
            record['stage'] = 'metafile'
            check_host_metafile(os.path.join(staged.root, 'artifacts', 'hostClient.metafile.json'))
            record['stage'] = 'exit64_case'
            exit64 = platform.exit64_case(staged)
            record['stage'] = 'session'
            session = platform.open_session(staged)
        except PlatformIncomplete:
            raise RunnerError('platform_incomplete') from None
        except (OSError, ValueError):
            raise RunnerError(record['stage']) from None
        stub, host = {}, {}
        record['stage'] = 'provider_start'
        try:
            roles = adapter.GuidedRoles(session.spawn('providerWorker'), session.spawn('hostClient'))
            roles.await_provider_ready()
            record['stage'] = 'dispatch1'
            host['dispatch1Text'] = roles.dispatch(1)
            stub['afterDispatch1'] = roles.stub_receipt('after-dispatch1')
            record['stage'] = 'shared_edit'
            shared = {'beforeSha256': session.shared_sha256()}
            session.edit_shared()
            shared['afterSha256'] = session.shared_sha256()
            record['stage'] = 'dispatch2'
            host['dispatch2Text'] = roles.dispatch(2)
            stub['afterDispatch2'] = roles.stub_receipt('after-dispatch2')
            record['stage'] = 'ticket_reuse'
            host['reuseError'] = roles.present_spent()
            stub['afterReuse'] = roles.stub_receipt('after-reuse')
            record['stage'] = 'revocation'
            roles.premint()
            stub['beforeRevocation'] = roles.stub_receipt('before-revoke')
            roles.revoke()
            host['revocationError'] = roles.present_premint()
            stub['afterRevocation'] = roles.stub_receipt('after-present')
            record['stage'] = 'host_result'
            roles.finish_send()
            record['settled'] = session.settle() is True
            record['hostPassed'] = roles.finish_result() is True
            record['stage'] = 'teardown'
            final = roles.stop()
            if final is None:
                raise RunnerError('teardown')
            stub['final'] = final
            record['exits'] = session.reap()
        except adapter.AdapterError:
            raise RunnerError(record['stage']) from None
        record['stage'] = 'verdict'
        verdict = oracle.evaluate({'exit64': exit64, 'stub': stub, 'host': host, 'sharedFile': shared})
        record['verdict'] = verdict
        if verdict['passed'] is not True:
            record['failureClass'] = 'verdict'
        elif record['hostPassed'] is not True:
            record['failureClass'] = 'host_result'
        elif record['settled'] is not True or record['exits'] != {'host': 0, 'provider': 0}:
            record['failureClass'] = 'teardown'
        record['passed'] = record['failureClass'] is None
    except RunnerError as error:
        record['failureClass'] = error.failure_class
    except Exception:  # noqa: BLE001 -- the record keeps the stage and a bounded class, never the exception text
        record['failureClass'] = record['stage'] if record['stage'] in CLASSES else 'verdict'
    finally:
        for closer in (getattr(roles, 'stop', None), getattr(session, 'close', None)):
            try:
                if closer:
                    closer()
            except Exception:  # noqa: BLE001
                if record['failureClass'] is None:
                    record['failureClass'] = 'teardown'
                    record['passed'] = False
    return record, (0 if record['passed'] else (1 if record['failureClass'] in ('verdict', 'host_result') else 78))


def main(argv, platform=None, env=None, directory=None, euid=os.geteuid):
    record, status = run(argv, platform or RealPlatform(), os.environ if env is None else env, directory or os.path.dirname(os.path.abspath(argv[0])), euid)
    out_dir = argv[2] if len(argv) > 2 else None
    try:
        if out_dir is None:
            raise OSError('no output directory')
        write_result(out_dir, record)
    except OSError:
        status = 78
    print(json.dumps({'schema': SCHEMA, 'passed': record['passed'], 'stage': record['stage'], 'failureClass': record['failureClass']}, sort_keys=True))
    return status


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))

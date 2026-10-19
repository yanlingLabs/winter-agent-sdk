"""Root-side session of the guided hosted fixture: it DRIVES the existing Root entry points and invents no Linux plumbing.

What it calls, all of which exist on agent-sdk main:
  * `linux-supervisor.py` (loaded by path, its bytes compared with the copy captured in the verified packet): `RuntimeDuplexPorts`,
    `ToolService(config, host_query_ports=...)` with the guided profile (`hostQueryGuidedRuntime`: the guided bootstrap, the
    five-descriptor registration, the immutable guidance view and the #35 reader service are all inside `ToolService`),
    `service.start()`, `service.launch_runtime(sid)`, `service.runtimes[sid]`, `service.revoke(sid)`, `service.close()`;
  * the native owner through the supervisor's own runtime launch (the ownerLibrary artifact named by the run-2 pin, never a constant);
  * the packet's `instructionReaderLauncher` for the independent exit-64 case.
The pattern is `scripts/guest-host-query/verify.py` (the v1 hosted Root runner): descriptor layouts, uids and the owner hand-off to the
provider are the same. It adds only what the runtime-sdk entry contract (C-P*, C-H*) asks of Root: stdin pipes for both roles, no network
interface for either, metadata files built here, and the lifecycle record.

Its Core-dependent DATA is `fixture-inputs.json` (derived by docs/guided-hosted-run/derive-fixture-inputs.ts from Winter Core at the run-2 pin's winter head and pinned
by hash in run.py): the host fixture records, the stub's marker lines, the prompts and the guidance texts. The one value only the kernel knows,
the boot id, is bound at open (`bind_boot`).
Never started by its author; nothing here has run as root on Linux.
"""
from __future__ import annotations

import array
import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import types
import uuid
from pathlib import Path

RUNTIME_UID, TOOL_UID, GROUP, PROVIDER_UID, HOST_UID, READER_UID = 20001, 10001, 10000, 30001, 40001, 50001
LOGICAL = 'guided-hosted'
BACKEND = '01234567-89ab-4cde-8fab-0123456789a0'
SOURCE_GUEST = '/workspace/folders/source'
MODEL = 'openai/gpt-5.6'
SELECTION = {'providerId': 'openai', 'modelKey': MODEL, 'providerModelId': 'gpt-5.6', 'family': 'openai', 'protocol': 'openai-responses',
             'continuationDomain': MODEL, 'capabilities': {'toolCalling': 'native', 'readableState': 'summary'}}
SUPERVISOR_SUFFIX = 'packages/runtime/src/guest/linux-supervisor.py'
GUIDED_PROFILE = 'host-query-guided-v1'
INPUT_KEYS = ('version', 'prompts', 'guidance', 'steps', 'hostFixture')
FIXTURE_KEYS = ('registration', 'capture', 'runtimeRow', 'workspace', 'binding', 'policy', 'sources', 'grants', 'bootId')
WORKSPACE, INCARNATION = 'workspace', 'incarnation'
# The boot id is the kernel's, so it is the ONE value fixture-inputs.json cannot carry: docs/guided-hosted-run/derive-fixture-inputs.ts writes this placeholder
# in exactly three places and `bind_boot` replaces exactly those three with the run's /proc boot id.
BOOT_PLACEHOLDER = '00000000-0000-4000-8000-000000000000'
BOOT_PATHS = (('bootId',), ('capture', 'bootId'), ('registration', 'bootId'))
HOST_ARGV = ['--input-fd', '3', '--output-fd', '4', '--error-fd', '5', '--metadata-fd', '6', '--lifecycle-fd', '7', '--cancel-fd', '8']
PROVIDER_ARGV = ['--listener-fd', '3', '--admission-fd', '4', '--owner-library-fd', '5', '--metadata-fd', '6']
SETTLE_SECONDS = 30
EXIT64_SITE = 'argv_parse'
SEQPACKET = socket.SOCK_SEQPACKET  # a module constant so an off-Linux test can substitute a datagram pair; Linux uses SEQPACKET


def make_pipe():
    if hasattr(os, 'pipe2'):
        return os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    read, write = os.pipe()
    for fd in (read, write):
        fcntl.fcntl(fd, fcntl.F_SETFD, fcntl.FD_CLOEXEC)
        os.set_blocking(fd, False)
    return read, write


class SessionError(Exception):
    """A bounded refusal; never carries role or runner text."""


def canonical(value):
    """JSON.stringify-compatible bytes: insertion order, no whitespace, no ASCII escaping (the roles re-stringify and compare)."""
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def validate_inputs(inputs):
    """The closed shape of fixture-inputs.json. Content is judged by Core and the SDK; this refuses what it would have to guess, and any
    fixture record that disagrees with the identities THIS session gives the guest (so a fixture made for another run cannot be used)."""
    if type(inputs) is not dict or set(inputs) != set(INPUT_KEYS) or inputs['version'] != 1:
        raise SessionError('inputs')
    prompts, guidance = inputs['prompts'], inputs['guidance']
    if type(prompts) is not list or len(prompts) != 2 or any(type(p) is not str or not 1 <= len(p.encode()) <= 1024 for p in prompts):
        raise SessionError('inputs')
    if type(guidance) is not dict or set(guidance) != {'old', 'edited'} or any(type(v) is not str or not 1 <= len(v.encode()) <= 65536 for v in guidance.values()) or guidance['old'] == guidance['edited']:
        raise SessionError('inputs')
    if type(inputs['steps']) is not list or len(inputs['steps']) != 2 or any(type(step) is not dict for step in inputs['steps']) or type(inputs['hostFixture']) is not dict:
        raise SessionError('inputs')
    fixture = inputs['hostFixture']
    if set(fixture) != set(FIXTURE_KEYS):
        raise SessionError('inputs')
    capture, registration = fixture['capture'], fixture['registration']
    if type(capture) is not dict or type(registration) is not dict or type(capture.get('source')) is not dict:
        raise SessionError('inputs')
    expected = {'workspaceId': WORKSPACE, 'sessionId': LOGICAL, 'backendSessionId': BACKEND, 'trustedQuerySessionId': BACKEND, 'incarnationId': INCARNATION,
                'leaseEpoch': 1, 'backendGeneration': 1, 'cwd': SOURCE_GUEST}
    if any(capture.get(key) != value or type(capture.get(key)) is not type(value) for key, value in expected.items()) or capture['source'].get('root') != SOURCE_GUEST:
        raise SessionError('inputs')
    if any(registration.get(key) != capture.get(key) for key in ('trustedQuerySessionId', 'sessionId', 'workspaceId', 'backendSessionId', 'backendGeneration', 'incarnationId', 'leaseEpoch')):
        raise SessionError('inputs')
    if any(_at(inputs['hostFixture'], path) != BOOT_PLACEHOLDER for path in BOOT_PATHS):
        raise SessionError('inputs')
    return inputs


def _at(value, path):
    for key in path:
        if type(value) is not dict or key not in value:
            return None
        value = value[key]
    return value


def bind_boot(inputs, boot):
    """A copy of the inputs with the run's boot id in exactly the three places that carry the placeholder, and nowhere else."""
    if type(boot) is not str or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', boot) or boot == BOOT_PLACEHOLDER:
        raise SessionError('inputs')
    bound = json.loads(json.dumps(inputs))
    for path in BOOT_PATHS:
        parent = bound['hostFixture']
        for key in path[:-1]:
            parent = parent[key]
        if parent.get(path[-1]) != BOOT_PLACEHOLDER:
            raise SessionError('inputs')
        parent[path[-1]] = boot
    if BOOT_PLACEHOLDER in json.dumps(bound):
        raise SessionError('inputs')
    return bound


def role_hashes(pin):
    roles, natives = pin['artifacts']['roles'], pin['artifacts']['natives']
    if any(item.get('placeholder') for item in roles.values()):
        raise SessionError('placeholder')
    return {**{name: item['sha256'] for name, item in roles.items()}, **{name: item['sha256'] for name, item in natives.items()}}


def authority():
    return {'workspaceId': WORKSPACE, 'sessionId': BACKEND, 'incarnationId': INCARNATION, 'leaseEpoch': 1, 'configRevision': 1, 'grantRevision': 1, 'policyRevision': 1}


def provider_route(boot):
    scope = {'homeId': 'fixture-home', 'workspaceId': 'workspace', 'sessionId': LOGICAL, 'backendSessionId': BACKEND, 'taskId': 'task', 'incarnationId': 'incarnation',
             'bootId': boot, 'leaseEpoch': 1, 'grantRevision': 1, 'accountRevision': 1, 'modelRevision': 1}
    return {'scope': scope, 'selection': dict(SELECTION)}


def provider_metadata(inputs, route):
    script = {'version': 1, 'scope': route['scope'], 'selection': route['selection'], 'steps': inputs['steps']}
    return canonical({'version': 1, 'runtimeUid': RUNTIME_UID, 'scriptSha256': sha256_hex(canonical(script)), 'script': script})


def host_metadata(inputs, runtime_config, reader_registration):
    config = {key: value for key, value in runtime_config.items() if key != 'requiredRuntimeContext'}
    value = {'version': 1, 'workspaceKey': 'workspace', 'incarnationId': 'incarnation', 'leaseEpoch': 1, 'prompts': inputs['prompts'], 'runtimeConfig': config,
             'readerRegistration': reader_registration, 'fixture': inputs['hostFixture']}
    data = canonical(value)
    if len(data) > 65536:
        raise SessionError('inputs')
    return data


def reader_dependencies(pin, environment_dir):
    """The packet's pinned libraries at their packet-relative guest paths (/lib/..., /usr/lib/...), as the launcher's grammar wants."""
    result = []
    for name, item in sorted(pin['environment'].items()):
        rest = name.split('/', 1)[1]
        result.append({'path': str(Path(environment_dir) / rest), 'sha256': item['sha256'], 'guestPath': '/' + rest})
    return result


def trusted_config(layout, hashes, boot, pin, binding_id):
    def art(name):
        return {'path': str(layout['bin'] / name), 'sha256': hashes[name]}
    route = provider_route(boot)
    return {
        'guestBootId': boot, 'protectedStoreDirectories': [str(layout['store']), str(layout['home'])],
        'artifacts': {'launcher': art('toolLauncher'), 'fileWorker': art('fileWorker'), 'processWorker': art('processWorker')},
        'hostQueryGuidedRuntime': {'artifacts': {'launcher': art('runtimeLauncher'), 'executable': art('runtimeEntry'), 'ownerLibrary': art('ownerLibrary')},
                                   'reader': {'artifacts': {'launcher': art('instructionReaderLauncher'), 'executable': art('instructionReader')},
                                              'dependencies': reader_dependencies(pin, layout['environment']), 'uid': READER_UID}},
        'environment': str(layout['environment']), 'controlDirectory': str(layout['control']),
        'conversations': [{
            'authority': authority(), 'logicalSessionId': LOGICAL, 'runtimeUid': RUNTIME_UID, 'toolUid': TOOL_UID, 'workspaceGid': GROUP, 'policy': 'ask',
            'roots': [{'id': 'source', 'guestPath': SOURCE_GUEST, 'readOnly': False, 'source': str(layout['source'])}],
            'hostQueryGuidedRuntime': {
                'storeDirectory': str(layout['store']), 'runhomeDirectory': str(layout['home']), 'provider': route, 'model': MODEL,
                'toolClasses': ['read', 'write', 'execute'], 'timeoutMs': 120000, 'requiredRuntimeContext': {'version': 1, 'bindingId': binding_id},
                'generation': 1, 'guidanceDirectory': str(layout['guidance'])}}]}


def copy_exact(source, target, expected_sha256, mode):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise SessionError('artifact')
        data = os.pread(fd, info.st_size + 1, 0)
    finally:
        os.close(fd)
    if sha256_hex(data) != expected_sha256:
        raise SessionError('artifact')
    out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(out, view):]
        os.fchmod(out, mode)
    finally:
        os.close(out)


def prepare_tree(root, staged, inputs, hashes, chown=None):
    """Fresh run tree under `root`: pinned artifact copies (0555), the packet's libraries, the writable tool source, the guidance directory
    (Root-owned, outside every tool root), the runtime's store and home. Every copied file is re-hashed against the run-2 pin."""
    chown = chown or os.chown
    root = Path(root)
    layout = {name: root / name for name in ('bin', 'control', 'environment', 'source', 'guidance', 'store', 'home')}
    for name, mode in (('bin', 0o755), ('control', 0o711), ('environment', 0o755), ('guidance', 0o755)):
        layout[name].mkdir(mode=mode)
    layout['source'].mkdir(mode=0o2770)
    chown(layout['source'], TOOL_UID, GROUP)
    os.chmod(layout['source'], 0o2770)
    for name in ('store', 'home'):
        layout[name].mkdir(mode=0o700)
        chown(layout[name], RUNTIME_UID, RUNTIME_UID)
    for name in ('runtimeEntry', 'providerWorker', 'hostClient', 'instructionReader', 'toolLauncher', 'runtimeLauncher', 'fileWorker', 'processWorker', 'ownerLibrary', 'instructionReaderLauncher'):
        copy_exact(Path(staged.root) / 'artifacts' / name, layout['bin'] / name, hashes[name], 0o555)
    for name, item in staged.pin['environment'].items():
        rest = name.split('/', 1)[1]
        target = layout['environment'] / rest
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        copy_exact(Path(staged.root) / name, target, item['sha256'], 0o555)
    for folder in sorted((p for p in layout['environment'].rglob('*') if p.is_dir()), reverse=True):
        folder.chmod(0o555)
    layout['environment'].chmod(0o555)
    write_guidance(layout['guidance'], inputs['guidance']['old'])
    return layout


def write_guidance(directory, text):
    """Replace WINTER.md atomically as a Root-owned 0444 file (the reader and tool views are made fresh per use)."""
    temporary = Path(directory) / '.winter.md.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, text.encode())
        os.fchmod(fd, 0o444)
    finally:
        os.close(fd)
    os.replace(temporary, Path(directory) / 'WINTER.md')


def supervisor_matches_packet(source_sha256, inventory):
    """The Root supervisor that runs is byte-for-byte the copy captured in the verified packet, exactly one such member."""
    found = [item.get('sha256') for name, item in inventory.items() if name.endswith('/' + SUPERVISOR_SUFFIX) and type(item) is dict]
    return len(found) == 1 and found[0] == source_sha256


def load_supervisor(path, staged):
    data = Path(path).read_bytes()
    if not supervisor_matches_packet(sha256_hex(data), staged.inventory):
        raise SessionError('supervisor')
    module = types.ModuleType('guided_hosted_supervisor')
    module.__file__ = str(path)
    sys.modules[module.__name__] = module
    exec(compile(data, str(path), 'exec'), module.__dict__)
    return module


def network_interfaces(pid, read=lambda p: Path(p).read_text()):
    """Interface names in the process's own network namespace (from /proc/<pid>/net/dev)."""
    lines = read(f'/proc/{pid}/net/dev').splitlines()[2:]
    return sorted(line.split(':', 1)[0].strip() for line in lines if ':' in line)


def spawn_role(binary, args, descriptors, uid, *, popen=subprocess.Popen, unshare=None, read_net=network_interfaces):
    """The v1 harness `spawn_fixed`, plus the two things the entry contract adds: a stdin pipe for Root's commands and NO network interface.
    Called before any service or listener thread exists (no preexec from a threaded Root)."""
    unshare = unshare or (lambda: os.unshare(os.CLONE_NEWNET))
    copies = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 64) for fd in descriptors]
    fillers = []
    try:
        for target in range(3, 3 + len(copies)):
            try:
                os.fstat(target)
            except OSError:
                fd = os.open('/dev/null', os.O_RDONLY | os.O_CLOEXEC)
                fillers.append(fd)
                if fd != target:
                    raise SessionError('descriptor layout')

        def identity():
            unshare()
            for source, target in zip(copies, range(3, 3 + len(copies))):
                os.dup2(source, target, inheritable=True)
            if uid == HOST_UID:
                for fd in (3, 4, 5, 7, 8):
                    os.set_blocking(fd, True)
            for fd in copies:
                os.close(fd)
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
        process = popen([str(binary), *args], preexec_fn=identity, pass_fds=tuple([*copies, *range(3, 3 + len(copies))]), stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True, env={'LANG': 'C', 'LC_ALL': 'C', 'HOME': '/nonexistent'}, start_new_session=True)
    finally:
        for fd in (*copies, *fillers):
            os.close(fd)
    interfaces = read_net(process.pid)
    if any(name != 'lo' for name in interfaces):
        process.kill()
        process.wait()
        raise SessionError('network interface')
    return process


def exit64_case(staged, *, run=subprocess.run, timeout=20):
    """The reader launcher, given an envelope with the wrong argument count, must exit 64 at its FIRST refusal (argv parse) with no init
    receipt and no pidfd on its receipt socket. This names the ONE `_exit(64)` site it exercises; it does not prove the claim for every
    site (docs/guided-reader-service.md item 7)."""
    launcher = Path(staged.root) / 'artifacts' / 'instructionReaderLauncher'
    control, remote = socket.socketpair(socket.AF_UNIX, SEQPACKET)
    try:
        result = run([str(launcher)], pass_fds=(remote.fileno(),), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout,
                     env={'LANG': 'C', 'LC_ALL': 'C'}, cwd='/', check=False)
        remote.close()
        control.setblocking(False)
        init_receipt = pidfd = False
        try:
            data, ancillary, _, _ = control.recvmsg(16, socket.CMSG_LEN(4))
            init_receipt = bool(data)
            pidfd = bool(ancillary)
        except (BlockingIOError, ConnectionResetError):
            pass  # nothing arrived: an empty or reset receipt socket is no init receipt and no pidfd
        return {'site': EXIT64_SITE, 'exitStatus': result.returncode & 0xFF if result.returncode >= 0 else 255, 'initReceipt': init_receipt, 'pidfdReceived': pidfd}
    finally:
        control.close()
        try:
            remote.close()
        except OSError:
            pass


def require_root_linux():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise SessionError('root linux')


def remove_tree(root):
    """Remove a run tree whose directories were made read-only (0555) on purpose."""
    for directory, names, _ in os.walk(root):
        try:
            os.chmod(directory, 0o700)
        except OSError:
            pass
    shutil.rmtree(root, ignore_errors=True)


class GuidedSession:
    """One started guided run: service running, runtime launched, owner handed to the provider, both roles spawned and waiting."""

    def __init__(self):
        self.root = self.service = self.supervisor = None
        self.processes = {}
        self.fds = []
        self.channels = []
        self.owner = None
        self.layout = None
        self.lifecycle = None
        self.lifecycle_record = None
        self.closed = False
        self.edited = ''

    @classmethod
    def open(cls, staged, inputs, directory, *, supervisor_path=None, parent='/tmp', spawn=spawn_role, boot=None, uuid4=uuid.uuid4, load=None):
        validate_inputs(inputs)
        require_root_linux()
        hashes = role_hashes(staged.pin)
        self = cls()
        try:
            self.root = Path(tempfile.mkdtemp(prefix='winter-guided-hosted-run-', dir=parent))
            self.root.chmod(0o711)
            self.edited = inputs['guidance']['edited']
            self.layout = prepare_tree(self.root, staged, inputs, hashes)
            supervisor_path = supervisor_path or Path(directory).resolve().parents[1] / SUPERVISOR_SUFFIX
            self.supervisor = module = (load or load_supervisor)(supervisor_path, staged)
            boot = boot or Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            inputs = bind_boot(inputs, boot)
            config = trusted_config(self.layout, hashes, boot, staged.pin, str(uuid4()))
            route = config['conversations'][0]['hostQueryGuidedRuntime']['provider']
            pipes = [make_pipe() for _ in range(5)]
            self.fds.extend(fd for pair in pipes for fd in pair)
            ports = module.RuntimeDuplexPorts(LOGICAL, config['conversations'][0]['authority'], pipes[0][0], pipes[1][1], pipes[2][1])
            self.service = module.ToolService(config, host_query_ports={LOGICAL: ports})
            for fd in (pipes[0][0], pipes[1][1], pipes[2][1]):
                os.close(fd)
                self.fds.remove(fd)
            sid = LOGICAL
            runtime = self.service.runtimes[sid]
            record = self.service._runtime_record(self.service.conversations[sid], runtime)
            host_meta = self._metadata('host-metadata.json', host_metadata(inputs, record['runtimeConfig'], runtime['readerRegistration']))
            provider_meta = self._metadata('provider-metadata.json', provider_metadata(inputs, route))
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.channels.append(listener)
            socket_path = self.layout['control'] / sid / 'provider.sock'
            listener.bind(str(socket_path))
            os.chmod(socket_path, 0o660)
            os.chown(socket_path, 0, RUNTIME_UID)
            listener.listen(4)
            admission, worker = socket.socketpair(socket.AF_UNIX, SEQPACKET)
            self.channels.extend((admission, worker))
            library = os.open(self.layout['bin'] / 'ownerLibrary', os.O_RDONLY | os.O_CLOEXEC)
            self.fds.append(library)
            self.processes['providerWorker'] = spawn(self.layout['bin'] / 'providerWorker', PROVIDER_ARGV, [listener.fileno(), worker.fileno(), library, provider_meta], PROVIDER_UID)
            self.processes['hostClient'] = spawn(self.layout['bin'] / 'hostClient', HOST_ARGV, [pipes[0][1], pipes[1][0], pipes[2][0], host_meta, pipes[3][0], pipes[4][1]], HOST_UID)
            self.lifecycle = pipes[3][1]
            for fd in (pipes[0][1], pipes[1][0], pipes[2][0], pipes[3][0], pipes[4][1]):
                os.close(fd)
                self.fds.remove(fd)
            self.service.start()
            self.service.launch_runtime(sid)
            self._hand_over_owner(admission, sid)
            return self
        except BaseException:
            self.close()
            raise

    def _metadata(self, name, data):
        path = self.root / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, data)
            os.fchmod(fd, 0o444)
        finally:
            os.close(fd)
        held = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        self.fds.append(held)
        return held

    def _hand_over_owner(self, admission, sid):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with self.service.lock:
                runtime = self.service.runtimes[sid]
                if runtime['state'] == 'running':
                    self.owner = os.dup(runtime['initPidfd'])
                    break
                if runtime['state'] in ('stopped', 'retained'):
                    raise SessionError('runtime owner unavailable')
            time.sleep(0.01)
        if self.owner is None:
            raise SessionError('runtime owner handoff deadline')
        if admission.sendmsg([b'I'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [self.owner]))]) != 1:
            raise SessionError('provider owner handoff')

    def spawn(self, role):
        process = self.processes.get(role)
        if process is None:
            raise SessionError('role')
        return process

    def shared_sha256(self):
        return sha256_hex((self.layout['guidance'] / 'WINTER.md').read_bytes())

    def edit_shared(self):
        write_guidance(self.layout['guidance'], self.edited)

    def settle(self, host_result_seen):
        """After the host client's `host-result` has been READ: wait for the runtime to stop, require the native/reap/drain conjunction, close the
        service, check the store lock was released, then write the lifecycle record. True only if every step held.

        The order is derived, not tolerated: `finish` (Root to host stdin), then `host-result` (host stdout), then the fd 7 lifecycle record.
        The guided host client never waits for fd 7 (host-client-core.ts: `finished = true; break`, `await pump`, `ports.emit(result)`; its
        `process.exited` is `void`ed in host-client.ts and only the v1 host awaits it), so its result cannot depend on the record, and Root
        writes the record last. A caller that has not read the result may not write the record: that is the refused order."""
        if host_result_seen is not True:
            raise SessionError('finish_order')
        sid = LOGICAL
        try:
            deadline = time.monotonic() + SETTLE_SECONDS
            while time.monotonic() < deadline:
                with self.service.lock:
                    state = self.service.runtimes[sid]['state']
                    if state == 'retained' or sid in self.service.debt:
                        return False
                    if state == 'stopped':
                        break
                time.sleep(0.01)
            else:
                return False
            with self.service.lock:
                runtime = self.service.runtimes[sid]
                if runtime['exitCode'] != 0 or not runtime['cleanupConfirmed'] or self.service.active or self.service.debt:
                    return False
            if not self.service.close():
                return False
            self.service = None
            flock_fd = os.open(self.layout['store'], os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                fcntl.flock(flock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(flock_fd)
            try:
                os.write(self.lifecycle, b'HQX1:0\n')
                self.lifecycle_record = 'written'
            except BrokenPipeError:
                # The host client has already returned its result and exited, so no reader of fd 7 remains. Nothing in the host awaits the record
                # (see above); the independent checks just made are the evidence, and the record says which of the two happened.
                self.lifecycle_record = 'reader_gone'
            os.close(self.lifecycle)
            self.lifecycle = None
            return True
        except (OSError, KeyError, SessionError):
            return False

    def reap(self):
        result = {}
        for label, role in (('host', 'hostClient'), ('provider', 'providerWorker')):
            process = self.processes[role]
            try:
                result[label] = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                result[label] = -9
        return result

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.service is not None:
            try:
                self.service.revoke(LOGICAL)
            except Exception:  # noqa: BLE001
                pass
        for process in self.processes.values():
            try:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
        if self.service is not None:
            try:
                self.service.close()
            except Exception:  # noqa: BLE001
                pass
        for channel in self.channels:
            try:
                channel.close()
            except OSError:
                pass
        for fd in [*self.fds, *([self.owner] if self.owner is not None else []), *([self.lifecycle] if self.lifecycle is not None else [])]:
            try:
                os.close(fd)
            except OSError:
                pass
        if self.root is not None:
            remove_tree(self.root)

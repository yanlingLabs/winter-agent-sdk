"""Tests for the Root-side session: the pure builders against the REAL supervisor's own validators, the tree preparation, the launch
primitives with injected process/namespace functions, the exit-64 case, and the whole `GuidedSession` sequence against a fake supervisor
module. Nothing here needs root or Linux; nothing real is started. The Linux-only primitives (`SEQPACKET`, `os.unshare`, `/proc`) are
substituted where the sandbox lacks them, and the one thing that can only be proven on the runner is said so in docs/guided-hosted-run.md."""
import array
import hashlib
import io
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import types
import unittest
import uuid
import warnings
from pathlib import Path
from unittest import mock

warnings.simplefilter('ignore', ResourceWarning)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'guest-supervisor'))
import session  # noqa: E402
import test_guided_host_query as hq_guided  # noqa: E402
import test_host_query as hq  # noqa: E402

REAL_REQUIRE = session.require_root_linux
BOOT = '00000000-0000-0000-0000-000000000000'
BINDING = '5f6e7d8c-0000-4000-a000-00000000000b'
ARTIFACTS = ('runtimeEntry', 'providerWorker', 'hostClient', 'instructionReader', 'toolLauncher', 'runtimeLauncher', 'fileWorker', 'processWorker', 'ownerLibrary', 'instructionReaderLauncher')
LIBS = ('environment/lib/aarch64-linux-gnu/libc.so.6', 'environment/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1', 'environment/usr/lib/aarch64-linux-gnu/libm.so.6')
HASH = lambda data: hashlib.sha256(data).hexdigest()
# The REAL derived inputs (docs/guided-hosted-run/derive-fixture-inputs.ts over Winter Core at the run-2 pin's winter head), not a stand-in.
INPUTS = json.loads(Path(HERE, 'fixture-inputs.json').read_bytes())


def real_root():
    return Path(os.path.realpath(tempfile.mkdtemp(prefix='gst-', dir='/tmp')))


def make_staged(root):
    """A fake extracted packet: ten artifacts and three libraries with their real hashes in a pin of the run-2 shape."""
    staged_root = Path(root) / 'staged'
    (staged_root / 'artifacts').mkdir(parents=True)
    roles = {name: {'sha256': None} for name in ARTIFACTS[:4]}
    natives = {name: {'sha256': None} for name in ARTIFACTS[4:]}
    for name in ARTIFACTS:
        data = ('bytes of ' + name).encode()
        (staged_root / 'artifacts' / name).write_bytes(data)
        (roles if name in roles else natives)[name]['sha256'] = HASH(data)
    environment = {}
    for name in LIBS:
        target = staged_root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(('lib ' + name).encode())
        environment[name] = {'sha256': HASH(('lib ' + name).encode())}
    pin = {'artifacts': {'roles': roles, 'natives': natives}, 'environment': environment, 'bun': {'stageBase': {'path': 'bun/bun'}}}
    return types.SimpleNamespace(root=str(staged_root), pin=pin, inventory={})


class Builders(unittest.TestCase):
    def test_canonical_is_compact_ordered_and_not_escaped(self):
        self.assertEqual(session.canonical({'b': 1, 'a': [1, 'é']}), '{"b":1,"a":[1,"é"]}'.encode())

    def test_inputs_are_a_closed_shape(self):
        self.assertIs(session.validate_inputs(INPUTS), INPUTS)
        for bad in (None, [], {**INPUTS, 'extra': 1}, {k: v for k, v in INPUTS.items() if k != 'steps'}, {**INPUTS, 'version': 2}, {**INPUTS, 'prompts': ['a']},
                    {**INPUTS, 'prompts': ['a', '']}, {**INPUTS, 'prompts': ['a', 'b' * 1025]}, {**INPUTS, 'guidance': {'old': 'x', 'edited': 'x'}},
                    {**INPUTS, 'guidance': {'old': 'x'}}, {**INPUTS, 'steps': [{}]}, {**INPUTS, 'hostFixture': []}):
            with self.assertRaises(session.SessionError):
                session.validate_inputs(bad)

    def mutated(self, *path_value):
        copy = json.loads(json.dumps(INPUTS))
        *path, value = path_value
        parent = copy
        for key in path[:-1]:
            parent = parent[key]
        parent[path[-1]] = value
        return copy

    def test_the_fixture_must_agree_with_the_identities_this_session_gives_the_guest(self):
        for name, bad in {
            'logical session': self.mutated('hostFixture', 'capture', 'sessionId', 'other'),
            'backend session': self.mutated('hostFixture', 'capture', 'backendSessionId', 'other'),
            'trusted query id': self.mutated('hostFixture', 'capture', 'trustedQuerySessionId', 'other'),
            'workspace': self.mutated('hostFixture', 'capture', 'workspaceId', 'other'),
            'incarnation': self.mutated('hostFixture', 'capture', 'incarnationId', 'other'),
            'lease epoch': self.mutated('hostFixture', 'capture', 'leaseEpoch', 2),
            'generation': self.mutated('hostFixture', 'capture', 'backendGeneration', 2),
            'cwd': self.mutated('hostFixture', 'capture', 'cwd', '/workspace/folders/other'),
            'source root': self.mutated('hostFixture', 'capture', 'source', 'root', '/workspace/folders/other'),
            'registration disagrees with the capture': self.mutated('hostFixture', 'registration', 'sessionId', 'other'),
            'registration lease epoch': self.mutated('hostFixture', 'registration', 'leaseEpoch', 2),
            'a boot id already bound': self.mutated('hostFixture', 'bootId', BOOT),
            'capture boot id already bound': self.mutated('hostFixture', 'capture', 'bootId', BOOT),
            'registration boot id already bound': self.mutated('hostFixture', 'registration', 'bootId', BOOT),
            'an extra fixture key': self.mutated('hostFixture', 'extra', 1),
            'a missing fixture key': {**INPUTS, 'hostFixture': {k: v for k, v in INPUTS['hostFixture'].items() if k != 'policy'}},
        }.items():
            with self.assertRaises(session.SessionError, msg=name):
                session.validate_inputs(bad)

    def test_a_wrong_identity_is_refused_even_when_capture_and_registration_agree_with_each_other(self):
        # The registration-agreement check alone would pass these: the Root identities themselves are what is pinned.
        for key, value in (('workspaceId', 'other'), ('sessionId', 'other'), ('backendSessionId', 'other'), ('trustedQuerySessionId', 'other'), ('incarnationId', 'other'),
                           ('leaseEpoch', 2), ('backendGeneration', 2), ('leaseEpoch', True), ('backendGeneration', True)):
            both = json.loads(json.dumps(INPUTS))
            both['hostFixture']['capture'][key] = value
            both['hostFixture']['registration'][key] = value
            with self.assertRaises(session.SessionError, msg=key + repr(value)):
                session.validate_inputs(both)

    def test_bind_boot_replaces_exactly_the_three_placeholders_on_a_copy(self):
        bound = session.bind_boot(INPUTS, BOOT)
        fixture = bound['hostFixture']
        self.assertEqual((fixture['bootId'], fixture['capture']['bootId'], fixture['registration']['bootId']), (BOOT, BOOT, BOOT))
        self.assertNotIn(session.BOOT_PLACEHOLDER, json.dumps(bound))
        self.assertEqual(INPUTS['hostFixture']['bootId'], session.BOOT_PLACEHOLDER)
        stripped = json.loads(json.dumps(bound).replace(BOOT, session.BOOT_PLACEHOLDER))
        self.assertEqual(stripped, INPUTS)  # nothing else moved
        for bad in (session.BOOT_PLACEHOLDER, 'not-a-uuid', '', None, 'ABCDEF01-0000-0000-0000-000000000000'):
            with self.assertRaises(session.SessionError, msg=repr(bad)):
                session.bind_boot(INPUTS, bad)
        with self.assertRaises(session.SessionError):
            session.bind_boot(self.mutated('hostFixture', 'bootId', BOOT), BOOT)

    def test_a_placeholder_left_anywhere_else_is_refused(self):
        leaked = self.mutated('hostFixture', 'workspace', 'note', session.BOOT_PLACEHOLDER)
        with self.assertRaises(session.SessionError):
            session.bind_boot(leaked, BOOT)

    def test_the_home_id_is_one_value_in_the_fixture_and_in_the_provider_scope(self):
        self.assertEqual(INPUTS['hostFixture']['capture']['homeId'], session.HOME_ID)
        self.assertEqual(session.provider_route(BOOT)['scope']['homeId'], session.HOME_ID)
        with self.assertRaises(session.SessionError):
            session.validate_inputs(self.mutated('hostFixture', 'capture', 'homeId', 'fixture-home'))

    def test_provider_metadata_is_the_exact_C_P3_shape(self):
        route = session.provider_route(BOOT)
        meta = json.loads(session.provider_metadata(INPUTS, route))
        self.assertEqual(list(meta), ['version', 'runtimeUid', 'scriptSha256', 'script'])
        self.assertEqual((meta['version'], meta['runtimeUid']), (1, session.RUNTIME_UID))
        self.assertEqual(meta['scriptSha256'], HASH(session.canonical(meta['script'])))
        self.assertEqual(list(meta['script']), ['version', 'scope', 'selection', 'steps'])
        self.assertEqual(session.provider_metadata(INPUTS, route), session.canonical(json.loads(session.provider_metadata(INPUTS, route))))
        self.assertEqual(len(meta['scriptSha256']), 64)
        self.assertEqual(set(meta['script']['scope']), {'homeId', 'workspaceId', 'sessionId', 'backendSessionId', 'taskId', 'incarnationId', 'bootId', 'leaseEpoch', 'grantRevision', 'accountRevision', 'modelRevision'})

    def test_host_metadata_is_the_exact_C_H3_shape_and_drops_the_required_context(self):
        runtime_config = {'model': 'm', 'requiredRuntimeContext': {'version': 1, 'bindingId': BINDING}}
        data = session.host_metadata(INPUTS, runtime_config, {'registrationId': 'r'})
        meta = json.loads(data)
        self.assertEqual(','.join(sorted(meta)), 'fixture,incarnationId,leaseEpoch,prompts,readerRegistration,runtimeConfig,version,workspaceKey')
        self.assertNotIn('requiredRuntimeContext', meta['runtimeConfig'])
        self.assertEqual(data, session.canonical(meta))
        self.assertLessEqual(len(data), 65536)
        with self.assertRaises(session.SessionError):
            session.host_metadata({**INPUTS, 'hostFixture': {**INPUTS['hostFixture'], 'sources': ['x' * 70000]}}, runtime_config, {})

    def test_role_hashes_come_from_the_pin_and_refuse_a_placeholder(self):
        staged = make_staged(real_root())
        hashes = session.role_hashes(staged.pin)
        self.assertEqual(set(hashes), set(ARTIFACTS))
        self.assertEqual(hashes['ownerLibrary'], staged.pin['artifacts']['natives']['ownerLibrary']['sha256'])
        staged.pin['artifacts']['roles']['hostClient']['placeholder'] = True
        with self.assertRaises(session.SessionError):
            session.role_hashes(staged.pin)

    def test_reader_dependencies_use_the_packet_guest_paths(self):
        staged = make_staged(real_root())
        deps = session.reader_dependencies(staged.pin, '/env')
        self.assertEqual([d['guestPath'] for d in deps], ['/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1', '/lib/aarch64-linux-gnu/libc.so.6', '/usr/lib/aarch64-linux-gnu/libm.so.6'])
        self.assertTrue(all(d['path'].startswith('/env/') and len(d['sha256']) == 64 for d in deps))
        service = hq_guided.service
        self.assertTrue(all(service.reader_dependency_path(d['guestPath']) for d in deps))


class TreeAndConfig(unittest.TestCase):
    def setUp(self):
        self.root = real_root()
        self.addCleanup(__import__('shutil').rmtree, self.root, True)
        self.staged = make_staged(self.root)
        self.hashes = session.role_hashes(self.staged.pin)
        self.run_root = self.root / 'run'
        self.run_root.mkdir(mode=0o711)

    def prepare(self, chown=None):
        return session.prepare_tree(self.run_root, self.staged, INPUTS, self.hashes, chown=chown or (lambda *a: None))

    def test_prepare_tree_modes_and_contents(self):
        layout = self.prepare()
        mode = lambda p: oct(stat.S_IMODE(os.lstat(p).st_mode))
        self.assertEqual(mode(layout['bin'] / 'hostClient'), '0o555')
        self.assertEqual(mode(layout['bin']), '0o755')
        self.assertEqual(mode(layout['environment']), '0o555')
        self.assertEqual(mode(layout['environment'] / 'lib/aarch64-linux-gnu/libc.so.6'), '0o555')
        self.assertEqual(mode(layout['control']), '0o711')
        self.assertIn(mode(layout['source']), ('0o2770', '0o770'))  # the setgid bit needs the real group; a non-root test cannot set it
        self.assertEqual(mode(layout['store']), '0o700')
        self.assertEqual((layout['guidance'] / 'WINTER.md').read_bytes(), INPUTS['guidance']['old'].encode())
        self.assertEqual(mode(layout['guidance'] / 'WINTER.md'), '0o444')
        self.assertEqual(sorted(os.listdir(layout['guidance'])), ['WINTER.md'])

    def test_prepare_tree_chowns_the_tool_source_and_the_runtime_dirs(self):
        calls = []
        self.prepare(chown=lambda path, uid, gid: calls.append((Path(path).name, uid, gid)))
        self.assertEqual(sorted(calls), sorted([('source', session.TOOL_UID, session.GROUP), ('store', session.RUNTIME_UID, session.RUNTIME_UID), ('home', session.RUNTIME_UID, session.RUNTIME_UID)]))

    def test_a_tampered_artifact_or_library_is_refused(self):
        (Path(self.staged.root) / 'artifacts' / 'ownerLibrary').write_bytes(b'tampered')
        with self.assertRaises(session.SessionError):
            self.prepare()

    def test_a_tampered_library_is_refused(self):
        (Path(self.staged.root) / LIBS[0]).write_bytes(b'tampered')
        with self.assertRaises(session.SessionError):
            self.prepare()

    def test_a_symlinked_or_hardlinked_artifact_is_refused(self):
        target = Path(self.staged.root) / 'artifacts' / 'fileWorker'
        data = target.read_bytes()
        target.unlink()
        real = Path(self.staged.root) / 'real'
        real.write_bytes(data)
        target.symlink_to(real)
        with self.assertRaises(OSError):
            self.prepare()

    def test_the_owner_comes_from_the_pin_not_from_a_constant(self):
        self.staged.pin['artifacts']['natives']['ownerLibrary']['sha256'] = HASH(b'a different owner after the holder patch')
        (Path(self.staged.root) / 'artifacts' / 'ownerLibrary').write_bytes(b'a different owner after the holder patch')
        hashes = session.role_hashes(self.staged.pin)
        layout = session.prepare_tree(self.run_root, self.staged, INPUTS, hashes, chown=lambda *a: None)
        self.assertEqual(HASH((layout['bin'] / 'ownerLibrary').read_bytes()), hashes['ownerLibrary'])
        self.assertNotIn(hashes['ownerLibrary'], open(os.path.join(HERE, 'session.py')).read())

    def test_the_guidance_edit_is_atomic_and_changes_the_digest(self):
        layout = self.prepare()
        before = HASH((layout['guidance'] / 'WINTER.md').read_bytes())
        session.write_guidance(layout['guidance'], INPUTS['guidance']['edited'])
        after = HASH((layout['guidance'] / 'WINTER.md').read_bytes())
        self.assertNotEqual(before, after)
        self.assertEqual(oct(stat.S_IMODE(os.lstat(layout['guidance'] / 'WINTER.md').st_mode)), '0o444')
        self.assertEqual(sorted(os.listdir(layout['guidance'])), ['WINTER.md'])

    def test_the_config_has_the_shape_the_real_supervisor_requires(self):
        layout = self.prepare()
        config = session.trusted_config(layout, self.hashes, BOOT, self.staged.pin, BINDING)
        service = hq_guided.service
        self.assertEqual(service.select_runtime_profile(config), session.GUIDED_PROFILE)
        runtime = config['hostQueryGuidedRuntime']
        self.assertEqual(set(runtime), {'artifacts', 'reader'})
        self.assertEqual(set(runtime['artifacts']), {'launcher', 'executable', 'ownerLibrary'})
        self.assertEqual(set(runtime['reader']), {'artifacts', 'dependencies', 'uid'})
        self.assertEqual(set(runtime['reader']['artifacts']), {'launcher', 'executable'})
        self.assertNotIn(runtime['reader']['uid'], {session.RUNTIME_UID, session.TOOL_UID, session.GROUP, session.PROVIDER_UID, session.HOST_UID, 0})
        entry = config['conversations'][0]
        self.assertEqual(set(entry['hostQueryGuidedRuntime']) - {'storeDirectory', 'runhomeDirectory', 'provider', 'model', 'timeoutMs', 'toolClasses', 'requiredRuntimeContext', 'generation', 'guidanceDirectory'}, set())
        self.assertEqual(entry['hostQueryGuidedRuntime']['requiredRuntimeContext'], {'version': 1, 'bindingId': BINDING})
        self.assertEqual(config['artifacts']['launcher']['sha256'], self.hashes['toolLauncher'])
        self.assertEqual(runtime['artifacts']['ownerLibrary']['sha256'], self.hashes['ownerLibrary'])

    def test_the_supervisors_pure_guided_builders_accept_the_values(self):
        layout = self.prepare()
        config = session.trusted_config(layout, self.hashes, BOOT, self.staged.pin, BINDING)
        service = hq_guided.service
        entry = config['conversations'][0]
        root = service.runtime_root_metadata(entry['roots'][0], entry['policy'], True)
        item = {'logicalSessionId': entry['logicalSessionId'], 'runtimeUid': entry['runtimeUid'], 'toolUid': entry['toolUid'], 'workspaceGid': entry['workspaceGid'],
                'authority': entry['authority'], 'policy': entry['policy'], 'revoked': False, 'roots': {'source': {'root': root}}}
        value = entry['hostQueryGuidedRuntime']
        host_config = service.guided_host_query_config(item, value['toolClasses'], value['model'], value['requiredRuntimeContext'])
        registration = service.guided_reader_registration(item, host_config, BOOT, str(uuid.uuid4()), value['generation'])
        self.assertEqual(registration['views']['sourceRoot'], session.SOURCE_GUEST)
        self.assertEqual(registration['owner']['logicalSessionId'], session.LOGICAL)
        self.assertEqual(registration['requiredRuntimeContext'], value['requiredRuntimeContext'])

    def test_the_real_tool_service_accepts_the_top_level_config(self):
        layout = self.prepare()
        config = session.trusted_config(layout, self.hashes, BOOT, self.staged.pin, BINDING)
        pipes = hq.Pipes()
        self.addCleanup(pipes.close)
        service = hq_guided.service
        control = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with hq_guided.linux_root_constructor(), mock.patch.object(service, 'pinned_artifact', side_effect=lambda value: os.open(os.devnull, os.O_RDONLY | os.O_CLOEXEC)), \
                mock.patch.object(service.Path, 'lstat', return_value=control), mock.patch.object(service.os, 'chown'), \
                mock.patch.object(service, 'READER_VIEWS_ROOT', str(self.root / 'views')), mock.patch.object(service.ToolService, '_configure_runtime', autospec=True) as configure:
            built = service.ToolService(config, host_query_ports={session.LOGICAL: pipes.ports})
        self.addCleanup(built.close)
        self.assertEqual(built.runtime_profile, session.GUIDED_PROFILE)
        configure.assert_called_once()
        self.assertEqual(configure.call_args.kwargs, {'profile': session.GUIDED_PROFILE})
        self.assertIn('guidance', built.conversations[session.LOGICAL])
        self.assertIsNotNone(built.reader)


class Supervisor(unittest.TestCase):
    def test_the_supervisor_must_equal_the_packets_captured_copy_exactly_once(self):
        digest = HASH(b'supervisor')
        member = lambda h: {'sha256': h}
        self.assertTrue(session.supervisor_matches_packet(digest, {'origins/sdk/' + session.SUPERVISOR_SUFFIX: member(digest), 'other': member('x')}))
        for inventory in ({}, {'a/' + session.SUPERVISOR_SUFFIX: member('0' * 64)}, {'a/' + session.SUPERVISOR_SUFFIX: member(digest), 'b/' + session.SUPERVISOR_SUFFIX: member(digest)},
                          {'a/' + session.SUPERVISOR_SUFFIX: 'x'}, {'notthe' + session.SUPERVISOR_SUFFIX: member(digest)}):
            self.assertFalse(session.supervisor_matches_packet(digest, inventory), inventory)

    def test_load_supervisor_refuses_a_different_file(self):
        root = real_root()
        self.addCleanup(__import__('shutil').rmtree, root, True)
        path = root / 'linux-supervisor.py'
        path.write_text('VALUE = 7\n')
        staged = types.SimpleNamespace(inventory={'x/' + session.SUPERVISOR_SUFFIX: {'sha256': HASH(b'VALUE = 7\n')}})
        self.assertEqual(session.load_supervisor(path, staged).VALUE, 7)
        path.write_text('VALUE = 8\n')
        with self.assertRaises(session.SessionError):
            session.load_supervisor(path, staged)


class Spawn(unittest.TestCase):
    def test_net_dev_is_parsed(self):
        text = 'Inter-|   Receive\n face |bytes\n    lo: 0 0\n  eth0: 1 2\n'
        self.assertEqual(session.network_interfaces(1, read=lambda p: text), ['eth0', 'lo'])

    def spawn(self, interfaces, uid=session.HOST_UID):
        recorded = {}

        def popen(argv, **kw):
            recorded.update(argv=argv, **kw)
            return types.SimpleNamespace(pid=4242, kill=lambda: recorded.setdefault('killed', True), wait=lambda: 0)
        fds = [os.open(os.devnull, os.O_RDONLY | os.O_CLOEXEC) for _ in range(2)]
        for fd in (3, 4):
            pass
        try:
            with mock.patch.object(session.os, 'fstat', return_value=None), mock.patch.object(session.fcntl, 'fcntl', side_effect=lambda fd, op, arg: os.dup(fd)):
                process = session.spawn_role('/bin/x', ['--a', '1'], fds, uid, popen=popen, unshare=lambda: None, read_net=lambda pid: interfaces)
        finally:
            for fd in fds:
                os.close(fd)
        return recorded, process

    def test_the_role_gets_a_stdin_pipe_a_minimal_environment_and_a_private_session(self):
        recorded, process = self.spawn(['lo'])
        self.assertEqual(recorded['argv'], ['/bin/x', '--a', '1'])
        self.assertEqual((recorded['stdin'], recorded['stdout'], recorded['stderr']), (session.subprocess.PIPE, session.subprocess.PIPE, session.subprocess.DEVNULL))
        self.assertEqual(recorded['env'], {'LANG': 'C', 'LC_ALL': 'C', 'HOME': '/nonexistent'})
        self.assertTrue(recorded['close_fds'] and recorded['start_new_session'])
        self.assertTrue(callable(recorded['preexec_fn']))
        self.assertNotIn('killed', recorded)

    def test_a_role_with_a_network_interface_is_killed_and_refused(self):
        for interfaces in (['eth0'], ['lo', 'eth0'], ['wlan0']):
            with self.assertRaises(session.SessionError):
                self.spawn(interfaces)

    def test_unshare_of_the_network_namespace_precedes_every_identity_change(self):
        source = open(os.path.join(HERE, 'session.py')).read()
        identity = source[source.index('def identity():'):source.index('process = popen(')]
        self.assertLess(identity.index('unshare()'), identity.index('os.setgroups([])'))
        self.assertLess(identity.index('unshare()'), identity.index('os.setuid(uid)'))
        self.assertIn('os.CLONE_NEWNET', source)

    def test_the_role_argv_matches_the_contract(self):
        self.assertEqual(session.HOST_ARGV, ['--input-fd', '3', '--output-fd', '4', '--error-fd', '5', '--metadata-fd', '6', '--lifecycle-fd', '7', '--cancel-fd', '8'])
        self.assertEqual(session.PROVIDER_ARGV, ['--listener-fd', '3', '--admission-fd', '4', '--owner-library-fd', '5', '--metadata-fd', '6'])
        self.assertEqual((session.HOST_UID, session.PROVIDER_UID), (40001, 30001))


class Exit64(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(session, 'SEQPACKET', socket.SOCK_DGRAM)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.base = real_root()
        self.addCleanup(session.remove_tree, self.base)
        self.staged = make_staged(self.base)
        self.launcher = Path(self.staged.root) / 'artifacts' / 'instructionReaderLauncher'
        self.calls = []

    def case(self, returncode, send=None, **kw):
        def run(argv, pass_fds, **options):
            self.calls.append((argv, options))
            # The program that runs is a root-owned private copy of the pinned bytes, in a directory that exists only for this call.
            self.assertNotEqual(argv[0], str(self.launcher))
            self.assertEqual(Path(argv[0]).read_bytes(), self.launcher.read_bytes())
            self.assertEqual(oct(stat.S_IMODE(os.stat(argv[0]).st_mode)), '0o500')
            self.assertEqual(oct(stat.S_IMODE(os.stat(os.path.dirname(argv[0])).st_mode)), '0o700')
            self.assertEqual(len(pass_fds), 1)
            if send:
                peer = socket.socket(fileno=os.dup(pass_fds[0]))
                send(peer)
                peer.close()
            return types.SimpleNamespace(returncode=returncode)
        return session.exit64_case(self.staged, run=run, parent=str(self.base), **kw)

    def test_a_clean_exit_64_with_nothing_on_the_receipt_socket(self):
        self.assertEqual(self.case(64), {'site': 'argv_parse', 'exitStatus': 64, 'initReceipt': False, 'pidfdReceived': False})

    def test_an_init_receipt_is_reported(self):
        self.assertTrue(self.case(64, lambda peer: peer.send(b'I'))['initReceipt'])

    def test_a_pidfd_on_the_socket_is_reported(self):
        def send(peer):
            fd = os.open(os.devnull, os.O_RDONLY)
            peer.sendmsg([b'x'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))])
            os.close(fd)
        self.assertTrue(self.case(64, send)['pidfdReceived'])

    def test_other_exit_statuses_are_reported_as_is_and_signals_as_255(self):
        self.assertEqual(self.case(0)['exitStatus'], 0)
        self.assertEqual(self.case(1)['exitStatus'], 1)
        self.assertEqual(self.case(-9)['exitStatus'], 255)

    def test_the_case_names_the_one_site_it_exercises(self):
        self.assertEqual(session.EXIT64_SITE, 'argv_parse')
        source = open(os.path.join(HERE, 'oracle.py')).read()
        self.assertIn("'argv_parse'", source)
        self.assertIn('CONSTANT on purpose', session.exit64_case.__doc__)

    def test_a_launcher_that_does_not_match_the_pin_is_never_run(self):
        self.launcher.chmod(0o644)
        self.launcher.write_bytes(b'swapped after the packet was verified')
        with self.assertRaises(session.SessionError):
            self.case(64)
        self.assertEqual(self.calls, [])
        self.assertEqual([p for p in os.listdir(self.base) if p.startswith('winter-guided-exit64-')], [])

    def test_a_symlinked_or_hard_linked_launcher_is_never_run(self):
        self.launcher.unlink()
        target = Path(self.base) / 'elsewhere'
        target.write_bytes(b'bytes of instructionReaderLauncher')
        os.symlink(target, self.launcher)
        with self.assertRaises((session.SessionError, OSError)):
            self.case(64)
        self.launcher.unlink()
        os.link(target, self.launcher)
        with self.assertRaises(session.SessionError):
            self.case(64)
        self.assertEqual(self.calls, [])

    def test_a_placeholder_pin_never_runs_it(self):
        self.staged.pin['artifacts']['roles']['hostClient']['placeholder'] = True
        with self.assertRaises(session.SessionError):
            self.case(64)
        self.assertEqual(self.calls, [])

    def test_the_launcher_runs_in_its_own_network_namespace_before_it_executes(self):
        unshared = []
        self.case(64, unshare=lambda: unshared.append(True))
        preexec = self.calls[0][1]['preexec_fn']
        self.assertEqual(unshared, [])
        preexec()
        self.assertEqual(unshared, [True])
        self.assertIn('os.CLONE_NEWNET', open(os.path.join(HERE, 'session.py')).read().split('def exit64_case')[1].split('def require_root_linux')[0])

    def test_the_private_copy_is_removed_even_when_the_run_raises(self):
        def boom(argv, pass_fds, **options):
            raise OSError('exec')
        with self.assertRaises(OSError):
            session.exit64_case(self.staged, run=boom, parent=str(self.base))
        self.assertEqual([p for p in os.listdir(self.base) if p.startswith('winter-guided-exit64-')], [])


class FakeProcess:
    def __init__(self, name):
        self.name, self.killed, self.returncode = name, False, None
        self.stdin = self.stdout = None

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed, self.returncode = True, -9

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class FakeService:
    def __init__(self, config, host_query_ports):
        self.config, self.ports = config, host_query_ports
        self.lock = threading.RLock()
        self.active, self.debt = set(), set()
        sid = session.LOGICAL
        self.conversations = {sid: {}}
        self.runtimes = {sid: {'state': 'configured', 'readerRegistration': {'registrationId': 'r', 'requiredRuntimeContext': {'version': 1, 'bindingId': BINDING}}, 'exitCode': 0, 'cleanupConfirmed': True}}
        os.makedirs(os.path.join(config['controlDirectory'], sid))
        self.events, self.closed_result = [], True

    def _runtime_record(self, item, runtime):
        return {'runtimeConfig': {'model': session.MODEL, 'requiredRuntimeContext': {'version': 1, 'bindingId': BINDING}}}

    def start(self):
        self.events.append('start')

    def launch_runtime(self, sid):
        self.events.append('launch')
        self.runtimes[sid].update(state='running', initPidfd=os.open(os.devnull, os.O_RDONLY | os.O_CLOEXEC))

    def revoke(self, sid):
        self.events.append('revoke')

    def close(self):
        self.events.append('close')
        return self.closed_result


class Sequence(unittest.TestCase):
    def setUp(self):
        for name, value in (('SEQPACKET', socket.SOCK_DGRAM),):
            patcher = mock.patch.object(session, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for target in ('chown',):
            patcher = mock.patch.object(session.os, target)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(session, 'require_root_linux', lambda: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.base = real_root()
        self.addCleanup(__import__('shutil').rmtree, self.base, True)
        self.staged = make_staged(self.base)
        self.spawned = []
        self.services = []

    def spawn(self, binary, args, descriptors, uid):
        # The descriptors are the caller's own at this point; keep dups so the test can read them after the caller closes its copies.
        record = {'binary': Path(binary).name, 'args': args, 'fds': [os.dup(fd) for fd in descriptors], 'uid': uid}
        self.spawned.append(record)
        return FakeProcess(record['binary'])

    def load(self, path, staged):
        module = types.SimpleNamespace()
        module.RuntimeDuplexPorts = lambda *a: ('ports', a)

        def make(config, host_query_ports):
            service = FakeService(config, host_query_ports)
            self.services.append(service)
            return service
        module.ToolService = make
        return module

    def open(self, **kw):
        sess = session.GuidedSession.open(self.staged, INPUTS, HERE, parent=str(self.base), spawn=self.spawn, boot=BOOT, uuid4=lambda: uuid.UUID(BINDING), load=self.load, **kw)
        self.addCleanup(sess.close)
        return sess

    def test_the_sequence_and_the_descriptor_layouts_follow_the_v1_harness(self):
        sess = self.open()
        service = self.services[0]
        self.assertEqual(service.events, ['start', 'launch'])
        provider, host = self.spawned
        self.assertEqual((provider['binary'], provider['args'], provider['uid'], len(provider['fds'])), ('providerWorker', session.PROVIDER_ARGV, session.PROVIDER_UID, 4))
        self.assertEqual((host['binary'], host['args'], host['uid'], len(host['fds'])), ('hostClient', session.HOST_ARGV, session.HOST_UID, 6))
        self.assertIs(sess.spawn('providerWorker').name == 'providerWorker', True)
        with self.assertRaises(session.SessionError):
            sess.spawn('somethingElse')

    def test_both_metadata_files_are_root_immutable_and_exactly_the_built_bytes(self):
        sess = self.open()
        provider, host = self.spawned
        for record, name, index in ((provider, 'provider-metadata.json', 3), (host, 'host-metadata.json', 3)):
            path = sess.root / name
            self.assertEqual(oct(stat.S_IMODE(os.lstat(path).st_mode)), '0o444')
            self.assertEqual(os.read(record['fds'][index], 1 << 20), path.read_bytes())
            self.assertEqual(path.read_bytes(), session.canonical(json.loads(path.read_bytes())))
        host_meta = json.loads((sess.root / 'host-metadata.json').read_bytes())
        self.assertNotIn('requiredRuntimeContext', host_meta['runtimeConfig'])
        self.assertEqual(host_meta['readerRegistration']['registrationId'], 'r')
        self.assertEqual(host_meta['prompts'], INPUTS['prompts'])
        fixture = host_meta['fixture']
        self.assertEqual((fixture['bootId'], fixture['capture']['bootId'], fixture['registration']['bootId']), (BOOT, BOOT, BOOT))
        self.assertNotIn(session.BOOT_PLACEHOLDER, json.dumps(host_meta))
        self.assertEqual(INPUTS['hostFixture']['bootId'], session.BOOT_PLACEHOLDER)  # the shared inputs are never mutated

    def test_the_owner_pidfd_is_handed_to_the_provider_once(self):
        self.open()
        admission = socket.socket(fileno=self.spawned[0]['fds'][1])
        data, ancillary, _, _ = admission.recvmsg(4, socket.CMSG_LEN(4))
        self.assertEqual(data, b'I')
        self.assertEqual(len(ancillary), 1)

    def test_the_trusted_config_is_what_the_service_got(self):
        sess = self.open()
        config = self.services[0].config
        self.assertEqual(config['hostQueryGuidedRuntime']['artifacts']['ownerLibrary']['sha256'], self.staged.pin['artifacts']['natives']['ownerLibrary']['sha256'])
        self.assertEqual(config['conversations'][0]['hostQueryGuidedRuntime']['guidanceDirectory'], str(sess.layout['guidance']))
        self.assertEqual(self.services[0].ports[session.LOGICAL][0], 'ports')

    def test_shared_file_digest_and_edit(self):
        sess = self.open()
        before = sess.shared_sha256()
        sess.edit_shared()
        self.assertNotEqual(before, sess.shared_sha256())
        self.assertEqual((sess.layout['guidance'] / 'WINTER.md').read_bytes(), INPUTS['guidance']['edited'].encode())

    def settle(self, mutate=None, close=True):
        sess = self.open()
        service = self.services[-1]
        service.closed_result = close
        runtime = service.runtimes[session.LOGICAL]
        runtime['state'] = 'stopped'
        if mutate:
            mutate(service, runtime)
        lifecycle = self.spawned[-1]['fds'][4]
        result = sess.settle(True)
        return result, lifecycle, service

    def test_settle_writes_the_lifecycle_record_only_after_every_check(self):
        result, lifecycle, service = self.settle()
        self.assertIs(result, True)
        self.assertEqual(os.read(lifecycle, 64), b'HQX1:0\n')
        self.assertIn('close', service.events)

    def test_settle_refuses_and_writes_nothing_when_any_check_fails(self):
        cases = {
            'retained': lambda s, r: r.update(state='retained'),
            'debt': lambda s, r: s.debt.add(session.LOGICAL),
            'exit code': lambda s, r: r.update(exitCode=1),
            'cleanup unconfirmed': lambda s, r: r.update(cleanupConfirmed=False),
            'active tools': lambda s, r: s.active.add('x'),
        }
        for name, mutate in cases.items():
            result, lifecycle, _ = self.settle(mutate)
            self.assertIs(result, False, name)
            os.set_blocking(lifecycle, False)
            with self.assertRaises(BlockingIOError):
                os.read(lifecycle, 64)

    def test_settle_refuses_the_other_finish_order_and_writes_nothing(self):
        # The lifecycle record before the host-result has been read is the refused order: named, raised, nothing written.
        for seen in (False, None, 1, 'yes'):
            sess = self.open()
            service = self.services[-1]
            service.runtimes[session.LOGICAL]['state'] = 'stopped'
            lifecycle = self.spawned[-1]['fds'][4]
            with self.assertRaises(session.SessionError) as caught:
                sess.settle(seen)
            self.assertEqual(str(caught.exception), 'finish_order')
            self.assertNotIn('close', service.events)
            os.set_blocking(lifecycle, False)
            with self.assertRaises(BlockingIOError):
                os.read(lifecycle, 64)

    def test_the_lifecycle_record_is_written_after_the_result_and_says_so(self):
        sess = self.open()
        self.services[-1].runtimes[session.LOGICAL]['state'] = 'stopped'
        self.assertIs(sess.settle(True), True)
        self.assertEqual(sess.lifecycle_record, 'written')

    def test_only_a_broken_pipe_means_the_reader_is_gone_any_other_write_error_fails_the_settle(self):
        import errno
        for error in (OSError(errno.EIO, 'io'), OSError(errno.EBADF, 'bad fd'), OSError(errno.ENOSPC, 'full')):
            sess = self.open()
            self.services[-1].runtimes[session.LOGICAL]['state'] = 'stopped'
            lifecycle, real = sess.lifecycle, os.write
            def write(fd, data, lifecycle=lifecycle, error=error):
                if fd == lifecycle:
                    raise error
                return real(fd, data)
            with mock.patch.object(session.os, 'write', write):
                self.assertIs(sess.settle(True), False, error)
            self.assertNotEqual(sess.lifecycle_record, 'reader_gone')

    def test_a_host_that_already_exited_is_not_a_failed_settle_but_is_recorded(self):
        sess = self.open()
        self.services[-1].runtimes[session.LOGICAL]['state'] = 'stopped'
        os.close(self.spawned[-1]['fds'][4])  # the host's read end of fd 7 is gone
        self.assertIs(sess.settle(True), True)
        self.assertEqual(sess.lifecycle_record, 'reader_gone')

    def test_settle_refuses_on_debt_of_any_conversation_not_just_its_own(self):
        result, lifecycle, _ = self.settle(lambda s, r: s.debt.add('another-conversation'))
        self.assertIs(result, False)

    def test_a_retained_runtime_fails_fast_not_at_the_deadline(self):
        import time as clock
        with mock.patch.object(session, 'SETTLE_SECONDS', 20):
            started = clock.monotonic()
            result, _, _ = self.settle(lambda s, r: r.update(state='retained'))
        self.assertIs(result, False)
        self.assertLess(clock.monotonic() - started, 5)

    def test_settle_refuses_when_the_service_does_not_close_cleanly(self):
        result, lifecycle, _ = self.settle(close=False)
        self.assertIs(result, False)

    def test_settle_gives_up_at_its_deadline(self):
        with mock.patch.object(session, 'SETTLE_SECONDS', 0.05):
            sess = self.open()
            self.assertIs(sess.settle(True), False)

    def test_close_is_idempotent_kills_the_roles_revokes_and_removes_the_tree(self):
        sess = self.open()
        root = sess.root
        sess.close()
        sess.close()
        self.assertFalse(root.exists())
        self.assertTrue(all(p.killed for p in sess.processes.values()))
        self.assertEqual(self.services[0].events.count('revoke'), 1)

    def test_a_failure_during_open_cleans_up_and_leaves_no_tree(self):
        def boom(binary, args, descriptors, uid):
            raise session.SessionError('network interface')
        with self.assertRaises(session.SessionError):
            session.GuidedSession.open(self.staged, INPUTS, HERE, parent=str(self.base), spawn=boom, boot=BOOT, uuid4=lambda: uuid.UUID(BINDING), load=self.load)
        self.assertEqual([p for p in os.listdir(self.base) if p.startswith('winter-guided-hosted-run-')], [])

    def test_a_placeholder_role_is_refused_before_anything_is_created(self):
        self.staged.pin['artifacts']['roles']['hostClient']['placeholder'] = True
        with self.assertRaises(session.SessionError):
            self.open()
        self.assertEqual([p for p in os.listdir(self.base) if p.startswith('winter-guided-hosted-run-')], [])

    def test_open_refuses_off_root_linux(self):
        def refuse():
            raise session.SessionError('root linux')
        with mock.patch.object(session, 'require_root_linux', refuse):
            with self.assertRaises(session.SessionError):
                self.open()
        self.assertEqual(self.services, [])

    def test_require_root_linux_checks_the_platform_and_uid(self):
        with mock.patch.object(session.sys, 'platform', 'darwin'):
            with self.assertRaises(session.SessionError):
                REAL_REQUIRE()
        with mock.patch.object(session.sys, 'platform', 'linux'), mock.patch.object(session.os, 'geteuid', return_value=1000):
            with self.assertRaises(session.SessionError):
                REAL_REQUIRE()


if __name__ == '__main__':
    unittest.main(warnings='ignore')

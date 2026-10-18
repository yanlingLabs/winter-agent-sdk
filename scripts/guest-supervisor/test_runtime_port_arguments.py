"""Source-only tests of how Root's init hands the supervisor its runtime transport: argv, three FIFO descriptors, one conversation.

Nothing here starts a service, a native process or a VM, and nothing is root. Disposable named FIFOs stand in for the pipes the guest's
relay presents (named FIFOs give the same uid / link-count / inode facts on macOS and Linux). The trusted config is built the way Root's
PID 1 builds it: a static base object with the boot id and the conversation set spliced in front.
"""
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_fresh_protocol as fresh  # noqa: E402
import test_guided_host_query as guided  # noqa: E402
import test_host_query as hq  # noqa: E402

service = fresh.service
AUTH = hq.AUTH
BOOT = guided.BOOT
SUPERVISOR = Path(__file__).resolve().parents[2] / 'packages/runtime/src/guest/linux-supervisor.py'


def argv(*arguments):
    return ['linux-supervisor.py', *arguments]


class ArgumentTests(unittest.TestCase):
    def test_the_original_single_form_is_unchanged(self):
        self.assertEqual(service.parse_arguments(argv('--trusted-config-fd', '3')), (3, None))
        self.assertEqual(service.parse_arguments(argv('--trusted-config-fd', '17')), (17, None))

    def test_the_runtime_ports_form_names_input_then_stdout_then_stderr(self):
        self.assertEqual(service.parse_arguments(argv('--trusted-config-fd', '3', '--runtime-ports-fds', '4,5,6')), (3, (4, 5, 6)))
        self.assertEqual(service.parse_arguments(argv('--trusted-config-fd', '9', '--runtime-ports-fds', '6,4,5')), (9, (6, 4, 5)))

    def test_every_other_command_line_is_a_usage_error(self):
        refused = [
            [],
            ['--trusted-config-fd'],
            ['3'],
            ['--trusted-config-fd', '3', '4,5,6'],
            ['--runtime-ports-fds', '4,5,6'],
            ['--runtime-ports-fds', '4,5,6', '--trusted-config-fd', '3'],                    # fixed order
            ['--trusted-config-fd', '3', '--runtime-ports-fds'],
            ['--trusted-config-fd', '3', '--runtime-ports-fds', '4,5,6', '--runtime-ports-fds', '7,8,9'],
            ['--trusted-config-fd', '3', '--runtime-ports-fds', '4,5,6', 'extra'],
            ['--trusted-config-fd', '3', 'extra'],
            ['--trusted-config-fd', '3', '--other', '4,5,6'],
            ['--trusted-config-fd=3'],
            ['--trusted-config-fd', '3', '--runtime-ports-fds=4,5,6'],
            ['--other', '3'],                                                                 # right length, wrong flag
            ['-trusted-config-fd', '3'],
            ['3', '--trusted-config-fd'],
            ['--other', '3', '--runtime-ports-fds', '4,5,6'],
            ['--trusted-config-fd', '3', '--other-ports', '4,5,6'],
        ]
        for arguments in refused:
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit) as caught:
                service.parse_arguments(argv(*arguments))
            self.assertEqual(caught.exception.code, 64)

    def test_descriptor_numbers_are_plain_canonical_decimals(self):
        for bad in ('', '-1', '+4', ' 4', '4 ', 'a', '4.0', '04', '0x4', '٤', '²', '1' * 10, '٣'):
            with self.subTest(config=bad), self.assertRaises(SystemExit) as caught:
                service.parse_arguments(argv('--trusted-config-fd', bad))
            self.assertEqual(caught.exception.code, 64)
            with self.subTest(port=bad), self.assertRaises(SystemExit) as caught:
                service.parse_arguments(argv('--trusted-config-fd', '3', '--runtime-ports-fds', f'4,{bad},6'))
            self.assertEqual(caught.exception.code, 64)

    def test_the_three_port_descriptors_are_three_distinct_non_standard_numbers_apart_from_the_config(self):
        for ports in ('4,5', '4,5,6,7', '4,5,6,6', '4,5,5,6', '4,4,5,6', '4,5,', ',4,5', '4,,6', '4, 5,6', '4,4,5', '5,5,5', '3,4,5', '4,3,5', '4,5,3', '0,4,5', '4,1,5', '4,5,2', ''):
            with self.subTest(ports=ports), self.assertRaises(SystemExit) as caught:
                service.parse_arguments(argv('--trusted-config-fd', '3', '--runtime-ports-fds', ports))
            self.assertEqual(caught.exception.code, 64)
        # the config descriptor may sit among them numerically but never be one of them
        self.assertEqual(service.parse_arguments(argv('--trusted-config-fd', '5', '--runtime-ports-fds', '3,4,6')), (5, (3, 4, 6)))


class Fixture(unittest.TestCase):
    """A PID 1 shaped config, FIFO descriptors the way the relay presents them, and a recording service in place of ToolService."""

    def setUp(self):
        self.pipes = hq.Pipes()
        self.duplicates = []

    def tearDown(self):
        for fd in self.duplicates:
            try:
                os.close(fd)
            except OSError:
                pass
        self.pipes.close()

    def descriptors(self):
        """Fresh numbers for the three ends the supervisor is handed, so the test can see them closed."""
        made = tuple(os.dup(fd) for fd in (self.pipes.input, self.pipes.output, self.pipes.error))
        self.duplicates.extend(made)
        return made

    @staticmethod
    def conversation(sid='logical', runtime_key=None, authority=None):
        item = {'logicalSessionId': sid, 'authority': dict(AUTH) if authority is None else authority, 'runtimeUid': 20001, 'toolUid': 10001,
                'workspaceGid': 10000, 'policy': 'ask',
                'roots': [{'id': 'source', 'guestPath': '/workspace/folders/source', 'readOnly': False, 'source': '/source'}]}
        if runtime_key:
            item[runtime_key] = {'storeDirectory': '/store', 'runhomeDirectory': '/home'}
            if runtime_key == 'hostQueryGuidedRuntime':
                item[runtime_key]['guidanceDirectory'] = '/guidance'
        return item

    @staticmethod
    def pid1_config(conversations, boot_id=BOOT, runtime_key=None):
        """Byte for byte the layout PID 1's wg_build_trusted_config writes: boot id, conversation set, then the base members."""
        digest = '0' * 64
        helpers = {'launcher': 'linux-tool-compartment', 'fileWorker': 'file-worker', 'processWorker': 'process-worker'}
        base = {'artifacts': {role: {'path': '/opt/winter/helpers/' + name, 'sha256': digest} for role, name in helpers.items()},
                'controlDirectory': '/run/winter/control', 'environment': '/opt/winter/environment/base', 'protectedStoreDirectories': []}
        if runtime_key:
            base[runtime_key] = {'artifacts': {name: {'path': '/opt/winter/runtime/' + name, 'sha256': digest} for name in ('launcher', 'executable', 'ownerLibrary')}}
            if runtime_key == 'hostQueryGuidedRuntime':
                # The guided profile also names the isolated reader (launcher, loader, dependency closure, identity); the other profiles carry no such key.
                base[runtime_key]['reader'] = {'artifacts': {name: {'path': '/opt/winter/runtime/reader-' + name, 'sha256': digest} for name in ('launcher', 'executable')}, 'dependencies': [], 'uid': 30001}
        members = json.dumps(base, sort_keys=True, separators=(',', ':'))[1:-1]
        text = '{"guestBootId":"%s","conversations":%s,%s}' % (boot_id, json.dumps(conversations, separators=(',', ':')), members)
        return text, json.loads(text)


class PortConstructionTests(Fixture):
    def test_one_host_query_conversation_gets_ports_built_from_the_three_descriptors(self):
        for key in ('hostQueryRuntime', 'hostQueryGuidedRuntime'):
            with self.subTest(key=key):
                _, config = self.pid1_config([self.conversation(runtime_key=key)])
                ports = service.runtime_ports_from_descriptors(config, self.descriptors())
                try:
                    self.assertEqual(list(ports), ['logical'])
                    self.assertIs(type(ports['logical']), service.RuntimeDuplexPorts)
                    self.assertEqual(ports['logical'].scope, AUTH)
                    self.assertEqual(ports['logical'].phase, 'new')
                    ports['logical'].bind(hq.item())      # the same binding rules as every other transport
                finally:
                    ports['logical'].close()

    def test_the_descriptor_roles_are_input_read_stdout_write_stderr_write(self):
        _, config = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')])
        swapped = (self.pipes.output, self.pipes.input, self.pipes.error)            # input given a write end: refused by the existing access check
        with self.assertRaisesRegex(service.Refusal, 'runtime_duplex_descriptor'):
            service.runtime_ports_from_descriptors(config, swapped)

    def test_no_descriptors_or_no_host_query_conversation_means_no_ports(self):
        _, with_conversation = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')])
        self.assertEqual(service.runtime_ports_from_descriptors(with_conversation, None), {})
        for key in (None, 'freshRuntime'):
            _, tools_only = self.pid1_config([self.conversation(runtime_key=key)])
            self.assertEqual(service.runtime_ports_from_descriptors(tools_only, self.descriptors()), {})
        for odd in ({}, {'conversations': None}, {'conversations': 'x'}, {'conversations': [None, 3, 'x']}, [], None, 'text'):
            self.assertEqual(service.runtime_ports_from_descriptors(odd, self.descriptors()), {})

    def test_more_than_one_host_query_conversation_is_refused_because_the_mux_has_one_runtime_stream(self):
        two = [self.conversation('one', 'hostQueryRuntime'), self.conversation('two', 'hostQueryGuidedRuntime')]
        _, config = self.pid1_config(two)
        with self.assertRaises(SystemExit) as caught:
            service.runtime_ports_from_descriptors(config, self.descriptors())
        self.assertEqual(caught.exception.code, 64)
        _, config = self.pid1_config([self.conversation('one', 'hostQueryRuntime'), self.conversation('two')])
        self.assertEqual(list(service.runtime_ports_from_descriptors(config, self.descriptors())), ['one'])   # a tools-only neighbour is not a second stream

    def test_a_conversation_that_cannot_be_bound_is_refused_by_the_existing_checks(self):
        for sid, authority, reason in (('bad id!', None, 'runtime_duplex_scope'), (None, None, 'runtime_duplex_scope'),
                                       ('logical', {'workspaceId': 'x'}, 'invalid_authority'), ('logical', 'text', 'invalid_authority')):
            with self.subTest(sid=sid, authority=authority):
                item = self.conversation(runtime_key='hostQueryRuntime')
                item['logicalSessionId'], item['authority'] = sid, (item['authority'] if authority is None else authority)
                if sid is None:
                    del item['logicalSessionId']
                _, config = self.pid1_config([item])
                with self.assertRaisesRegex(service.Refusal, reason):
                    service.runtime_ports_from_descriptors(config, self.descriptors())

    def test_descriptor_shape_refusals_come_from_the_existing_fifo_checks(self):
        _, config = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')])
        with tempfile.TemporaryDirectory() as folder:
            regular = os.open(os.path.join(folder, 'file'), os.O_RDWR | os.O_CREAT | os.O_NONBLOCK, 0o600)
            self.duplicates.append(regular)
            with self.assertRaisesRegex(service.Refusal, 'runtime_duplex_descriptor'):
                service.runtime_ports_from_descriptors(config, (regular, self.pipes.output, self.pipes.error))
        input_path = os.path.join(self.pipes.temp.name, '0')                                   # the input FIFO the fixture made
        blocking_reader = os.open(input_path, os.O_RDONLY)                                     # a writer exists, so this opens at once, without O_NONBLOCK
        self.duplicates.append(blocking_reader)
        with self.assertRaisesRegex(service.Refusal, 'runtime_duplex_descriptor'):
            service.runtime_ports_from_descriptors(config, (blocking_reader, self.pipes.output, self.pipes.error))
        os.link(input_path, input_path + '-second-name')                                       # link count 2 on the very FIFO the others accept
        with self.assertRaisesRegex(service.Refusal, 'runtime_duplex_descriptor'):
            service.runtime_ports_from_descriptors(config, (self.pipes.input, self.pipes.output, self.pipes.error))
        os.unlink(input_path + '-second-name')
        blocking = os.dup(self.pipes.input)
        self.duplicates.append(blocking)
        os.set_blocking(blocking, False)                                                       # the dup shares the description: this is the input FIFO again
        alias_a, alias_b = os.dup(self.pipes.output), os.dup(self.pipes.output)
        self.duplicates.extend((alias_a, alias_b))
        with self.assertRaisesRegex(service.Refusal, 'runtime_duplex_alias'):                  # two of the three are the same FIFO
            service.runtime_ports_from_descriptors(config, (blocking, alias_a, alias_b))

    def test_a_refused_construction_leaves_no_duplicate_of_its_own_behind(self):
        _, config = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')])
        before = sorted(int(name) for name in os.listdir('/dev/fd')) if os.path.isdir('/dev/fd') else None
        with self.assertRaises(service.Refusal):
            service.runtime_ports_from_descriptors(config, (self.pipes.output, self.pipes.input, self.pipes.error))
        if before is not None:
            after = sorted(int(name) for name in os.listdir('/dev/fd'))
            self.assertEqual([fd for fd in after if fd not in before and fd >= 64], [])


class ConfigFileTests(unittest.TestCase):
    """The trusted-config file admission is the existing one, moved into a function; these are its refusals."""

    def read(self, mode, uid=0, size=10, fd_number=None):
        read_fd, write_fd = os.pipe()
        try:
            info = SimpleNamespace(st_mode=mode, st_uid=uid, st_size=size)
            with patch.object(service.os, 'fstat', return_value=info):
                os.write(write_fd, b'{"a":1}')       # readable to the end, so a missing refusal shows as a returned config, never a hang
                os.close(write_fd)
                write_fd = -1
                return service.read_trusted_config(read_fd if fd_number is None else fd_number)
        finally:
            for fd in (read_fd, write_fd):
                try:
                    os.close(fd)
                except OSError:
                    pass

    def test_a_regular_root_owned_file_not_writable_by_others_of_modest_size_is_read(self):
        self.assertEqual(self.read(stat.S_IFREG | 0o400), {'a': 1})
        self.assertEqual(self.read(stat.S_IFREG | 0o644, size=65536), {'a': 1})

    def test_everything_else_is_refused_with_64(self):
        cases = {
            'not a regular file': dict(mode=stat.S_IFIFO | 0o400),
            'not root': dict(mode=stat.S_IFREG | 0o400, uid=1000),
            'group writable': dict(mode=stat.S_IFREG | 0o420),
            'other writable': dict(mode=stat.S_IFREG | 0o402),
            'too large': dict(mode=stat.S_IFREG | 0o400, size=65537),
            'a standard stream number': dict(mode=stat.S_IFREG | 0o400, fd_number=2),
        }
        for name, kwargs in cases.items():
            with self.subTest(name), self.assertRaises(SystemExit) as caught:
                self.read(**kwargs)
            self.assertEqual(caught.exception.code, 64)


class FakeToolService:
    """Records what main hands the real service class; start/close are inert."""
    built = []

    def __init__(self, config, *, host_query_ports=None):
        self.config, self.host_query_ports = config, host_query_ports
        self.closed = False
        FakeToolService.built.append(self)

    def start(self):
        pass

    def close(self):
        self.closed = True
        return True


class MainTests(Fixture):
    def run_main(self, config, command_line, expect=None):
        FakeToolService.built = []
        out = io.StringIO()
        with patch.object(service, 'read_trusted_config', return_value=config) as read, patch.object(service, 'ToolService', FakeToolService), \
                patch.object(service.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(b''))), patch.object(service.sys, 'stdout', out):
            if expect:
                with self.assertRaises(expect) as caught:
                    service.main(command_line)
                return read, caught.exception
            service.main(command_line)
        return read, out.getvalue()

    def closed(self, fd):
        try:
            os.fstat(fd)
        except OSError:
            return True
        return False

    def test_the_original_form_still_serves_with_no_ports_and_prints_ready(self):
        _, config = self.pid1_config([self.conversation()])
        read, out = self.run_main(config, argv('--trusted-config-fd', '3'))
        read.assert_called_once_with(3)
        self.assertEqual(len(FakeToolService.built), 1)
        self.assertEqual(FakeToolService.built[0].host_query_ports, {})
        self.assertTrue(FakeToolService.built[0].closed)
        self.assertEqual(json.loads(out), {'ready': True, 'fullGuestExecutionEnabled': False})

    def test_the_three_descriptors_become_the_service_transport_and_the_originals_are_closed(self):
        _, config = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')], runtime_key='hostQueryRuntime')
        fds = self.descriptors()
        self.run_main(config, argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, fds))))
        built = FakeToolService.built[0]
        try:
            self.assertEqual(list(built.host_query_ports), ['logical'])
            self.assertIs(type(built.host_query_ports['logical']), service.RuntimeDuplexPorts)
            self.assertTrue(all(self.closed(fd) for fd in fds), 'the originals must be closed once the ports hold their own duplicates')
            held = list(built.host_query_ports['logical'].fds.values())
            self.assertTrue(all(fd >= 64 for fd in held))
            self.assertTrue(all(os.fstat(fd) for fd in held))
        finally:
            for port in built.host_query_ports.values():
                port.close()

    def test_with_no_host_query_conversation_the_descriptors_are_closed_and_the_service_starts_without_ports(self):
        _, config = self.pid1_config([self.conversation()])
        fds = self.descriptors()
        self.run_main(config, argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, fds))))
        self.assertEqual(FakeToolService.built[0].host_query_ports, {})
        self.assertTrue(all(self.closed(fd) for fd in fds))

    def test_more_than_one_host_query_conversation_exits_64_with_the_descriptors_closed_and_no_service(self):
        _, config = self.pid1_config([self.conversation('one', 'hostQueryRuntime'), self.conversation('two', 'hostQueryRuntime')])
        fds = self.descriptors()
        _, error = self.run_main(config, argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, fds))), expect=SystemExit)
        self.assertEqual(error.code, 64)
        self.assertEqual(FakeToolService.built, [])
        self.assertTrue(all(self.closed(fd) for fd in fds))

    def test_a_refused_descriptor_set_closes_the_originals_and_never_reaches_the_service(self):
        _, config = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')])
        fds = self.descriptors()
        swapped = (fds[1], fds[0], fds[2])
        self.run_main(config, argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, swapped))), expect=service.Refusal)
        self.assertEqual(FakeToolService.built, [])
        self.assertTrue(all(self.closed(fd) for fd in fds))

    def test_an_unreadable_config_still_closes_the_descriptors(self):
        fds = self.descriptors()
        FakeToolService.built = []
        with patch.object(service, 'read_trusted_config', side_effect=SystemExit(64)), patch.object(service, 'ToolService', FakeToolService), \
                patch.object(service.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(b''))), patch.object(service.sys, 'stdout', io.StringIO()):
            with self.assertRaises(SystemExit):
                service.main(argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, fds))))
        self.assertEqual(FakeToolService.built, [])
        self.assertTrue(all(self.closed(fd) for fd in fds))

    def test_the_guided_host_query_conversation_gets_the_ports_through_main(self):
        _, config = self.pid1_config([self.conversation(runtime_key='hostQueryGuidedRuntime')], runtime_key='hostQueryGuidedRuntime')
        fds = self.descriptors()
        self.run_main(config, argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, fds))))
        built = FakeToolService.built[0]
        try:
            self.assertEqual(list(built.host_query_ports), ['logical'])
        finally:
            for port in built.host_query_ports.values():
                port.close()

    def closes_of(self, config, fds, expect=None, reader=None):
        """Every os.close the run makes on one of the original descriptors, in order."""
        real, seen = os.close, []

        def counting(fd):
            if fd in fds:
                seen.append(fd)
            return real(fd)
        with patch.object(service.os, 'close', counting):
            if reader:
                FakeToolService.built = []
                with patch.object(service, 'read_trusted_config', side_effect=reader), patch.object(service, 'ToolService', FakeToolService), \
                        patch.object(service.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(b''))), patch.object(service.sys, 'stdout', io.StringIO()):
                    with self.assertRaises(SystemExit):
                        service.main(argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, fds))))
            else:
                self.run_main(config, argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, fds))), expect=expect)
        return seen

    def test_each_original_descriptor_is_closed_exactly_once_on_every_path(self):
        _, host_query = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')], runtime_key='hostQueryRuntime')
        _, tools_only = self.pid1_config([self.conversation()])
        _, two = self.pid1_config([self.conversation('one', 'hostQueryRuntime'), self.conversation('two', 'hostQueryRuntime')])
        cases = (('success', host_query, None, None), ('no host-query conversation', tools_only, None, None),
                 ('refused set', host_query, service.Refusal, 'swap'), ('more than one', two, SystemExit, None), ('unreadable config', None, None, 'reader'))
        for name, config, expect, special in cases:
            with self.subTest(path=name):
                fds = self.descriptors()
                if special == 'swap':
                    sent = (fds[1], fds[0], fds[2])
                    real, seen = os.close, []

                    def counting(fd, real=real, seen=seen, fds=fds):
                        if fd in fds:
                            seen.append(fd)
                        return real(fd)
                    with patch.object(service.os, 'close', counting):
                        self.run_main(config, argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, sent))), expect=expect)
                    closes = seen
                else:
                    closes = self.closes_of(config, fds, expect=expect, reader=SystemExit(64) if special == 'reader' else None)
                self.assertEqual(sorted(closes), sorted(fds))
                for port in (FakeToolService.built[0].host_query_ports.values() if FakeToolService.built else ()):
                    port.close()

    def test_closing_a_descriptor_that_is_already_gone_is_not_an_error(self):
        _, config = self.pid1_config([self.conversation()])
        gone = [os.dup(self.pipes.input) for _ in range(3)]
        for fd in gone:
            os.close(fd)
        self.run_main(config, argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, gone))))
        self.assertEqual(FakeToolService.built[0].host_query_ports, {})

    def test_a_usage_error_never_reads_the_config(self):
        for arguments in ([], ['--trusted-config-fd', '3', '--runtime-ports-fds', '4,4,5'], ['--trusted-config-fd', '03']):
            with patch.object(service, 'read_trusted_config') as read, self.assertRaises(SystemExit) as caught:
                service.main(argv(*arguments))
            read.assert_not_called()
            self.assertEqual(caught.exception.code, 64)

    def test_a_service_that_refuses_to_construct_has_its_ports_closed_by_main(self):
        _, config = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')])
        fds = self.descriptors()
        seen = []

        def refuse(config, *, host_query_ports=None):
            seen.extend(host_query_ports.values())
            raise service.Refusal('protected_linux_root_required')      # raised before the constructor's own try, so it would not close them
        with patch.object(service, 'read_trusted_config', return_value=config), patch.object(service, 'ToolService', side_effect=refuse):
            with self.assertRaisesRegex(service.Refusal, 'protected_linux_root_required'):
                service.main(argv('--trusted-config-fd', '3', '--runtime-ports-fds', ','.join(map(str, fds))))
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].phase, 'closed')
        self.assertEqual(seen[0].fds, {})

    def test_the_service_close_failure_still_exits_78(self):
        class Stuck(FakeToolService):
            def close(self):
                return False
        _, config = self.pid1_config([self.conversation()])
        with patch.object(service, 'read_trusted_config', return_value=config), patch.object(service, 'ToolService', Stuck), \
                patch.object(service.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(b''))), patch.object(service.sys, 'stdout', io.StringIO()):
            with self.assertRaises(SystemExit) as caught:
                service.main(argv('--trusted-config-fd', '3'))
        self.assertEqual(caught.exception.code, 78)


class Pid1ShapedConfigAdmissionTests(Fixture):
    """The real ToolService constructor, patched only where it needs Root, Linux and real artifacts (the existing pattern)."""

    def setUp(self):
        super().setUp()
        self.temp = tempfile.TemporaryDirectory()
        self.services = []

    def tearDown(self):
        for built in self.services:
            built.close()
        self.temp.cleanup()
        super().tearDown()

    def construct(self, text, ports):
        base = Path(self.temp.name).resolve()
        for name in ('control', 'environment', 'source', 'store', 'home', 'artifacts', 'guidance'):
            (base / name).mkdir(exist_ok=True)
        for name in ('linux-tool-compartment', 'file-worker', 'process-worker', 'launcher', 'executable', 'ownerLibrary', 'reader-launcher', 'reader-executable'):
            (base / 'artifacts' / name).write_bytes(b'x')
        private = base / 'control' / 'logical'
        if private.exists():
            private.rmdir()
        config = json.loads(text.replace('/run/winter/control', str(base / 'control')).replace('/opt/winter/environment/base', str(base / 'environment'))
                            .replace('/opt/winter/helpers/', str(base / 'artifacts') + '/').replace('/opt/winter/runtime/', str(base / 'artifacts') + '/')
                            .replace('"/source"', json.dumps(str(base / 'source'))).replace('"/store"', json.dumps(str(base / 'store')))
                            .replace('"/home"', json.dumps(str(base / 'home'))).replace('"/guidance"', json.dumps(str(base / 'guidance'))))
        control = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with guided.linux_root_constructor(), patch.object(service, 'pinned_artifact', side_effect=lambda value: os.open(os.devnull, os.O_RDONLY | os.O_CLOEXEC)), \
                patch.object(service.Path, 'lstat', return_value=control), patch.object(service.os, 'chown'), patch.object(service, 'READER_VIEWS_ROOT', str(base / 'views')), \
                patch.object(service.ToolService, '_configure_runtime', autospec=True):
            built = service.ToolService(config, host_query_ports=ports)
        self.services.append(built)
        return built

    def test_a_tools_only_config_in_the_layout_pid_1_writes_is_admitted_with_no_ports(self):
        text, _ = self.pid1_config([self.conversation()])
        built = self.construct(text, {})
        self.assertEqual(built.runtime_profile, 'fresh')
        self.assertEqual(built.host_query_ports, {})
        self.assertEqual(list(built.conversations), ['logical'])
        self.assertEqual(built.guest_boot, BOOT)

    def test_a_host_query_config_is_admitted_exactly_when_the_ports_built_from_the_descriptors_are_injected(self):
        for key in ('hostQueryRuntime', 'hostQueryGuidedRuntime'):
            with self.subTest(key=key):
                text, config = self.pid1_config([self.conversation(runtime_key=key)], runtime_key=key)
                ports = service.runtime_ports_from_descriptors(config, self.descriptors())
                built = self.construct(text, ports)
                self.assertEqual(built.runtime_profile, 'host-query-v1' if key == 'hostQueryRuntime' else guided.GUIDED)
                self.assertIs(built.host_query_ports['logical'], ports['logical'])
                built.close()
                self.services.remove(built)
                self.assertEqual(ports['logical'].phase, 'closed')

    def test_a_host_query_config_without_the_transport_is_still_refused_before_serving(self):
        text, _ = self.pid1_config([self.conversation(runtime_key='hostQueryRuntime')], runtime_key='hostQueryRuntime')
        with self.assertRaisesRegex(service.Refusal, 'host_query_transport'):
            self.construct(text, {})

    def test_a_config_for_another_boot_is_refused_as_before(self):
        text, _ = self.pid1_config([self.conversation()], boot_id='11111111-1111-4111-8111-111111111111')
        with self.assertRaisesRegex(service.Refusal, 'stale_guest_boot'):
            self.construct(text, {})

    def test_an_empty_conversation_set_is_still_refused(self):
        text, _ = self.pid1_config([])
        with self.assertRaisesRegex(service.Refusal, 'conversation_limit'):
            self.construct(text, {})


class NoPreviousBootEvidenceTests(unittest.TestCase):
    """Root's init cannot honestly establish how the previous boot ended, so the supervisor neither reads nor forwards such evidence.

    Only the host can independently establish that a previous guest has terminated; a marker on the guest's own disk would be written by the
    party being judged, and a set `needs_recovery` flag in the superblock is evidence AGAINST an orderly stop. The native owner keeps
    answering "no evidence" and a cold resume stays refused. If an honest source is ever added, this pin must change deliberately."""

    def test_the_supervisor_source_has_no_previous_boot_evidence_path(self):
        """Structural: no config key (subscript or .get) named like previous-boot evidence is read by the entry path."""
        import ast
        import re
        tree = ast.parse(SUPERVISOR.read_text())
        pattern = re.compile('previous|terminat|last_boot', re.I)
        entry = {'main', 'read_trusted_config', 'runtime_ports_from_descriptors', 'host_query_conversations', 'parse_arguments'}
        seen = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name in entry:
                seen.add(node.name)
                for inner in ast.walk(node):
                    key = None
                    if isinstance(inner, ast.Subscript):
                        key = inner.slice
                    elif isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute) and inner.func.attr == 'get' and inner.args:
                        key = inner.args[0]
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        self.assertIsNone(pattern.search(key.value), (node.name, key.value))
        self.assertEqual(seen, entry)
        text = SUPERVISOR.read_text()
        for needle in ('needs_recovery', 'previousBootTermination'):
            self.assertNotIn(needle, text)

    def test_the_native_owner_adapter_still_answers_no_evidence(self):
        source = (SUPERVISOR.parent / 'linux-session-admission.ts').read_text()
        self.assertIn('previousBootTermination: () => null', source)


if __name__ == '__main__':
    unittest.main()

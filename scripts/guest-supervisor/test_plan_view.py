"""The plan view (contract revision 3, 12.5): the supervisor's admission and the tool launcher's arguments. Source only; never starts a service or a native process.

/workspace/plan/<logicalSessionId>/<epoch> is admitted as a root of that conversation only, under plan only, once, writable, and never for an epoch below one that
already exists beside it. It is the one writable root under plan: the file worker may write it, the process worker never, and every other root stays read-only.
"""
import contextlib
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_fresh_protocol as fresh  # noqa: E402
import test_guided_host_query as gq  # noqa: E402

service = fresh.service
GUIDED = gq.GUIDED
SID = 'logical'
VIEW = f'/workspace/plan/{SID}/4'
SOURCE = '/workspace/folders/source'


class PureRuleTests(unittest.TestCase):
    def test_the_path_class_is_exactly_the_contract_shape(self):
        for path in (f'/workspace/plan/{SID}/0', f'/workspace/plan/{SID}/4', f'/workspace/plan/{SID}/123456789', '/workspace/plan/a.b-c_d/7'):
            self.assertTrue(service.is_plan_view(path), path)
        for path in (f'/workspace/plan/{SID}/04', f'/workspace/plan/{SID}/1234567890', f'/workspace/plan/{SID}/-1', f'/workspace/plan/{SID}/4/', f'/workspace/plan/{SID}/4/x',
                     f'/workspace/plan/{SID}', '/workspace/plan', '/workspace/plan/', f'/workspace/plan//4', '/workspace/plan/../4', '/workspace/.winter/plan/logical/4',
                     f'/workspace/Plan/{SID}/4', f'/workspace/plan/{SID}/4 ', None, 4, b'/workspace/plan/logical/4'):
            self.assertFalse(service.is_plan_view(path), repr(path))

    def test_the_epoch_is_read_only_for_the_conversations_own_id(self):
        self.assertEqual(service.plan_view_epoch(VIEW, SID), 4)
        self.assertEqual(service.plan_view_epoch(f'/workspace/plan/{SID}/0', SID), 0)
        self.assertIsNone(service.plan_view_epoch(VIEW, 'other'))
        self.assertIsNone(service.plan_view_epoch(f'/workspace/plan/other/4', SID))
        self.assertIsNone(service.plan_view_epoch(SOURCE, SID))

    def test_only_the_plan_view_is_writable_under_plan(self):
        view = {'id': 'plan', 'guestPath': VIEW, 'readOnly': False}
        source = {'id': 'source', 'guestPath': SOURCE, 'readOnly': False}
        self.assertFalse(service.file_write_denied('plan', view))
        self.assertTrue(service.file_write_denied('plan', source))
        self.assertTrue(service.file_write_denied('plan', {**view, 'readOnly': True}))
        for policy in ('auto', 'ask', 'accept-edits', 'dont-ask', 'bypass'):
            self.assertFalse(service.file_write_denied(policy, source), policy)
            self.assertTrue(service.file_write_denied(policy, {**source, 'readOnly': True}), policy)

    def test_effective_metadata_keeps_the_view_writable_under_plan_and_every_other_root_read_only(self):
        view = {'id': 'plan', 'guestPath': VIEW, 'readOnly': False}
        source = {'id': 'source', 'guestPath': SOURCE, 'readOnly': False}
        self.assertIs(service.runtime_root_metadata(view, 'plan', True)['readOnly'], False)
        self.assertIs(service.runtime_root_metadata(source, 'plan', True)['readOnly'], True)
        self.assertIs(service.runtime_root_metadata({**view, 'readOnly': True}, 'plan', True)['readOnly'], True)
        self.assertIs(service.runtime_root_metadata(view, 'ask', True)['readOnly'], False)

    def test_host_query_config_accepts_a_writable_plan_view_only_under_plan(self):
        current = gq.pure_item('plan')
        current['roots']['plan'] = {'root': service.runtime_root_metadata({'id': 'plan', 'guestPath': VIEW, 'readOnly': False}, 'plan', True)}
        self.assertEqual(service.host_query_config(current, ['read', 'write'], 'model')['permissionMode'], 'plan')
        for guest in (f'/workspace/plan/{SID}/04', '/workspace/other'):
            current['roots']['plan']['root']['guestPath'] = guest
            with self.assertRaisesRegex(service.Refusal, 'host_query_roots'):
                service.host_query_config(current, ['read', 'write'], 'model')
        writable = gq.pure_item('plan')
        writable['roots']['source']['root']['readOnly'] = False
        with self.assertRaisesRegex(service.Refusal, 'host_query_roots'):
            service.host_query_config(writable, ['read', 'write'], 'model')


class StaleEpochTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        (self.root / SID).mkdir()
        self.patch = patch.object(service, 'PLAN_ROOT', str(self.root))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def make(self, *epochs):
        for epoch in epochs:
            (self.root / SID / str(epoch)).mkdir()

    def test_the_highest_epoch_and_a_restart_of_it_are_not_stale(self):
        self.make(2, 4)
        self.assertFalse(service.plan_view_stale(SID, 4))
        self.assertFalse(service.plan_view_stale(SID, 5))

    def test_an_epoch_below_one_that_exists_is_stale(self):
        self.make(1, 2, 4)
        for epoch in (0, 1, 2, 3):
            self.assertTrue(service.plan_view_stale(SID, epoch), epoch)

    def test_the_comparison_is_numeric_not_lexical_and_ignores_non_epoch_names(self):
        self.make(9, 10)
        self.assertTrue(service.plan_view_stale(SID, 9))
        self.assertFalse(service.plan_view_stale(SID, 10))
        (self.root / SID / '99x').mkdir()
        (self.root / SID / '099').mkdir()
        (self.root / SID / 'latest').write_text('')
        self.assertFalse(service.plan_view_stale(SID, 10))

    def test_an_unreadable_symlinked_or_missing_parent_fails_closed(self):
        self.assertTrue(service.plan_view_stale('missing', 4))
        (self.root / 'real').mkdir()
        os.symlink(self.root / 'real', self.root / 'linked')
        self.assertTrue(service.plan_view_stale('linked', 4))
        (self.root / 'file').write_text('')
        self.assertTrue(service.plan_view_stale('file', 4))


class AdmissionTests(unittest.TestCase):
    """The real ToolService constructor, with the filesystem and native pieces replaced the way the guided constructor tests do."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        for name in ('control', 'environment', 'source', 'artifacts', 'store', 'home', 'guidance', 'planview', 'planroot'):
            (self.base / name).mkdir()
        (self.base / 'planroot' / SID).mkdir()
        (self.base / 'planroot' / SID / '4').mkdir()
        for name in ('launcher', 'fileWorker', 'processWorker', 'executable', 'ownerLibrary'):
            (self.base / 'artifacts' / name).write_bytes(b'x')
        self.pipes = gq.hq.Pipes()
        self.services = []

    def tearDown(self):
        for built in self.services:
            built.close()
        self.pipes.close()
        self.temp.cleanup()

    def config(self, profile, policy, roots):
        key = dict(service.RUNTIME_KEYS)[profile]
        pin = lambda name: {'path': str(self.base / 'artifacts' / name), 'sha256': '0' * 64}
        entry = {'logicalSessionId': SID, 'authority': dict(gq.AUTH), 'runtimeUid': 20001, 'toolUid': 10001, 'workspaceGid': 10000, 'policy': policy, 'roots': roots}
        config = {'guestBootId': gq.BOOT, 'environment': str(self.base / 'environment'), 'controlDirectory': str(self.base / 'control'), 'protectedStoreDirectories': [],
                  'artifacts': {name: pin(name) for name in ('launcher', 'fileWorker', 'processWorker')}, 'conversations': [entry]}
        if profile != 'fresh':
            config[key] = {'artifacts': {name: pin(name) for name in ('launcher', 'executable', 'ownerLibrary')}}
            entry[key] = {'storeDirectory': str(self.base / 'store'), 'runhomeDirectory': str(self.base / 'home')}
            if profile == GUIDED:
                config[key]['reader'] = {'artifacts': {'launcher': pin('launcher'), 'executable': pin('executable')}, 'dependencies': [], 'uid': 30001}
                entry[key]['guidanceDirectory'] = str(self.base / 'guidance')
        return config

    def roots(self, *views, source=True):
        roots = [{'id': 'source', 'guestPath': SOURCE, 'readOnly': False, 'source': SOURCE}] if source else []
        for index, (guest, read_only) in enumerate(views):
            roots.append({'id': f'view{index}', 'guestPath': guest, 'readOnly': read_only, 'source': guest})
        return roots

    def construct(self, profile, policy, roots):
        private = self.base / 'control' / SID
        if private.exists():
            private.rmdir()
        ports = {} if profile == 'fresh' else {SID: self.pipes.ports}
        control = SimpleNamespace(st_mode=gq.stat.S_IFDIR | 0o700, st_uid=0)
        served = {SOURCE: self.base / 'source'}
        served.update({root['guestPath']: self.base / 'planview' for root in roots if root['guestPath'].startswith('/workspace/plan/') or root['guestPath'] == '/workspace/.winter/memory'})

        def source_directory(source, protected, real=service.source_directory):
            target = served.get(source)
            return os.open(str(target), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC) if target is not None else real(source, protected)

        with gq.linux_root_constructor(), patch.object(service, 'pinned_artifact', side_effect=lambda value: os.open(os.devnull, os.O_RDONLY | os.O_CLOEXEC)), \
                patch.object(service.Path, 'lstat', return_value=control), patch.object(service.os, 'chown'), patch.object(service, 'READER_VIEWS_ROOT', str(self.base / 'views')), \
                patch.object(service, 'PLAN_ROOT', str(self.base / 'planroot')), patch.object(service, 'source_directory', side_effect=source_directory), \
                patch.object(service.Path, 'resolve', autospec=True, side_effect=lambda path, strict=False, real=service.Path.resolve: real(served[str(path)] if str(path) in served else path, strict=strict)), \
                patch.object(service.ToolService, '_configure_runtime', autospec=True):
            built = service.ToolService(self.config(profile, policy, roots), host_query_ports=ports)
        self.services.append(built)
        return built

    def refuse(self, profile, policy, roots, code='plan_view'):
        with self.assertRaisesRegex(service.Refusal, code):
            self.construct(profile, policy, roots)

    def test_the_current_epoch_is_admitted_writable_under_plan_and_everything_else_stays_read_only(self):
        for profile in ('host-query-v1', GUIDED):
            with self.subTest(profile=profile):
                built = self.construct(profile, 'plan', self.roots((VIEW, False)))
                admitted = built.conversations[SID]['roots']
                self.assertIs(admitted['view0']['root']['readOnly'], False)
                self.assertEqual(admitted['view0']['root']['guestPath'], VIEW)
                self.assertIs(admitted['source']['root']['readOnly'], True)
                built.close()
                self.services.remove(built)

    def test_a_plan_view_outside_plan_is_refused_for_every_other_policy(self):
        for policy in ('auto', 'ask', 'accept-edits', 'dont-ask', 'bypass'):
            for profile in ('host-query-v1', GUIDED):
                with self.subTest(policy=policy, profile=profile):
                    self.refuse(profile, policy, self.roots((VIEW, False)))

    def test_the_fresh_profile_never_admits_a_plan_view(self):
        self.refuse('fresh', 'plan', self.roots((VIEW, False)))

    def test_an_epoch_below_one_already_made_is_refused(self):
        (self.base / 'planroot' / SID / '5').mkdir()
        for profile in ('host-query-v1', GUIDED):
            with self.subTest(profile=profile):
                self.refuse(profile, 'plan', self.roots((VIEW, False)))
        # The later epoch itself is the current one, and the policy revision does not decide which epoch that is.
        built = self.construct('host-query-v1', 'plan', self.roots((f'/workspace/plan/{SID}/5', False)))
        self.assertEqual(built.conversations[SID]['roots']['view0']['root']['guestPath'], f'/workspace/plan/{SID}/5')

    def test_an_unreadable_epoch_parent_refuses(self):
        (self.base / 'planroot' / SID / '4').rmdir()
        (self.base / 'planroot' / SID).rmdir()
        self.refuse('host-query-v1', 'plan', self.roots((VIEW, False)))

    def test_another_conversations_view_and_a_malformed_path_are_refused(self):
        for guest in ('/workspace/plan/other/4', f'/workspace/plan/{SID}/04', f'/workspace/plan/{SID}/4/x', f'/workspace/plan/{SID}', '/workspace/plan', f'/workspace/plan/{SID}/1234567890'):
            with self.subTest(guest=guest):
                self.refuse('host-query-v1', 'plan', self.roots((guest, False)))

    def test_a_read_only_plan_view_is_refused(self):
        self.refuse('host-query-v1', 'plan', self.roots((VIEW, True)))

    def test_a_second_plan_view_is_refused_even_at_the_same_path(self):
        self.refuse('host-query-v1', 'plan', self.roots((VIEW, False), (VIEW, False)))
        (self.base / 'planroot' / SID / '3').mkdir()
        self.refuse('host-query-v1', 'plan', self.roots((VIEW, False), (f'/workspace/plan/{SID}/3', False)))

    def test_the_view_must_be_served_from_its_own_guest_path(self):
        roots = self.roots((VIEW, False))
        roots[-1]['source'] = '/workspace/plan/logical/3'
        self.refuse('host-query-v1', 'plan', roots, 'admitted_root')


class LauncherArgumentTests(unittest.TestCase):
    """The per-root flag the tool launcher receives: 1 read-only, 2 the writable plan view (file worker, plan), 0 writable otherwise."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.stack = contextlib.ExitStack()
        self.fds = {}
        for name in ('launcher', 'worker', 'environment', 'source', 'view'):
            path = Path(self.temp.name) / name
            path.mkdir() if name in ('environment', 'source', 'view') else path.write_bytes(b'inert')
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
            self.stack.callback(os.close, fd)
            self.fds[name] = fd

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def flags(self, policy, kind, view_read_only=False):
        item = {'logicalSessionId': SID, 'toolUid': 10001, 'workspaceGid': 10000, 'policy': policy, 'revoked': False,
                'roots': {'source': {'root': {'id': 'source', 'guestPath': SOURCE, 'readOnly': policy == 'plan'}, 'fd': self.fds['source']},
                          'plan': {'root': {'id': 'plan', 'guestPath': VIEW, 'readOnly': view_read_only}, 'fd': self.fds['view']}}}
        fake = SimpleNamespace(artifacts={'launcher': self.fds['launcher'], 'fileWorker': self.fds['worker'], 'processWorker': self.fds['worker']},
                               artifact_pins={'launcher': 'inert', 'fileWorker': 'inert', 'processWorker': 'inert'}, environment=self.fds['environment'], directory=Path(self.temp.name), stop_event=threading.Event())
        captured = []

        def refuse(args, **options):
            captured.append(list(args))
            raise OSError(5, 'portable Popen refusal')
        real = service.socket.socketpair
        with patch.object(service.socket, 'socketpair', side_effect=lambda *a: real(service.socket.AF_UNIX, service.socket.SOCK_STREAM)), \
                patch.object(service, 'verify_held_artifact'), patch.object(service.subprocess, 'Popen', side_effect=refuse):
            with self.assertRaises(OSError):
                service.ToolService._run(fake, item, kind, 'read', item['roots']['source'], 'seed', 1024, '-', b'', 5, threading.Event(), None)
        args = captured[0]
        self.assertEqual(args[14], '2')
        return args[17::3], args[16::3]

    def test_the_file_worker_gets_the_writable_view_flag_only_under_plan(self):
        flags, paths = self.flags('plan', 'file')
        self.assertEqual((paths, flags), ([SOURCE, VIEW], ['1', '2']))

    def test_the_process_worker_never_gets_it(self):
        flags, _ = self.flags('plan', 'process')
        self.assertEqual(flags, ['1', '0'])

    def test_a_read_only_view_is_read_only_whatever_the_policy(self):
        flags, _ = self.flags('plan', 'file', view_read_only=True)
        self.assertEqual(flags, ['1', '1'])

    def test_no_other_policy_gets_it(self):
        for policy in ('auto', 'ask', 'accept-edits', 'dont-ask', 'bypass'):
            flags, _ = self.flags(policy, 'file')
            self.assertEqual(flags, ['0', '0'], policy)


class LinuxFixtureRunnerTests(unittest.TestCase):
    """plan_view_cases.py is what verify.py runs as root on Linux CI. Here the same runner runs off Linux with the constructor's platform checks and the root-owned artifact check stood in for."""

    def test_the_runner_passes_and_verify_py_runs_it(self):
        import plan_view_cases
        real = os.geteuid

        def euid():
            frame = sys._getframe(1)
            while frame:
                if frame.f_code.co_name == '__init__' and type(frame.f_locals.get('self')).__name__ == 'ToolService':
                    return 0
                frame = frame.f_back
            return real()
        control = SimpleNamespace(st_mode=gq.stat.S_IFDIR | 0o700, st_uid=0)
        with tempfile.TemporaryDirectory() as work, patch.object(service.sys, 'platform', 'linux'), patch.object(service.os, 'geteuid', side_effect=euid), \
                patch.object(service.sys, 'flags', SimpleNamespace(isolated=1, no_site=1)), patch.object(service.Path, 'read_text', return_value=gq.BOOT + '\n'), \
                patch.object(service, 'pinned_artifact', side_effect=lambda value: os.open(os.devnull, os.O_RDONLY | os.O_CLOEXEC)), \
                patch.object(service.Path, 'lstat', return_value=control), patch.object(service.os, 'chown'), patch.object(service, 'PLAN_ROOT', service.PLAN_ROOT):
            cases = plan_view_cases.run(service, work)
        self.assertEqual(cases, ['admitted-under-plan', 'refused-outside-plan', 'refused-foreign-malformed-read-only', 'refused-stale-epoch', 'stale-check-fails-closed'])
        verify = (Path(__file__).resolve().parent / 'verify.py').read_text()
        self.assertIn('plan_view_cases.py', verify)
        for case in cases:
            self.assertIn(f"'{case}'", verify)


class LauncherSourceTests(unittest.TestCase):
    """The native launcher refuses the writable-view flag anywhere but plan + file, and mounts it writable only then. Source-level, since no native process starts here."""

    def setUp(self):
        self.text = (Path(__file__).resolve().parents[2] / 'packages/runtime/src/guest/linux-tool-compartment.c').read_text()

    def test_the_flag_range_and_its_refusal(self):
        self.assertIn('if(number(argv[17+3*i],0,2)==2&&(strcmp(argv[7],"plan")||strcmp(argv[8],"file")))_exit(64);', self.text)

    def test_only_flag_two_under_plan_is_mounted_writable(self):
        self.assertIn('number(argv[17+3*i],0,2)==1||(!strcmp(argv[7],"plan")&&number(argv[17+3*i],0,2)!=2)||browse', self.text)

    def test_the_runtime_launcher_still_mounts_every_plan_root_read_only(self):
        runtime = (Path(__file__).resolve().parents[2] / 'packages/runtime/src/guest/linux-runtime-compartment.c').read_text()
        self.assertIn('number(argv[17+3*i],0,1)||!strcmp(argv[13],"plan")', runtime)


if __name__ == '__main__':
    unittest.main()

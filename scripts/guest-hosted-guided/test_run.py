"""Unit tests for the root runner, with fake role PROCESSES (fake_role.py, real subprocesses speaking the assumed
line-JSON contract), a fake platform, a fake verifier and a throwaway packet directory. Nothing here needs root, Linux,
the network or a real packet: the root checks are exercised through the runner's `euid` parameter."""
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import warnings

warnings.simplefilter('ignore', ResourceWarning)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oracle  # noqa: E402
import roles_adapter  # noqa: E402
import run  # noqa: E402

FAKE = os.path.join(HERE, 'fake_role.py')
ENV = {run.OPT_IN: run.OPT_IN_VALUE}


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


GOOD_REPORT = {'kind': 'winter-guided-packet-verification', 'allChecksHold': True, 'checks': {'one': True, 'two': True}, 'placeholders': [], 'outputsExecuted': False}
GOOD_PIN = {'artifacts': {'roles': {'hostClient': {'sha256': 'a' * 64}, 'providerWorker': {'sha256': 'b' * 64}}}, 'bun': {'stageBase': {'path': 'bun/bun'}}}


class FakeSession:
    def __init__(self, state, modes, timeout=5.0):
        self.state, self.modes, self.processes = state, modes, []
        self.shared = 'old guidance'
        self.closed = False

    def spawn(self, role):
        name = 'provider' if role == 'providerWorker' else 'host'
        process = subprocess.Popen([sys.executable, '-I', '-B', FAKE, name, self.state, self.modes.get(name, '')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        return process

    def provider_script(self):
        return b'{"version":1}'

    def shared_sha256(self):
        return sha(self.shared)

    def edit_shared(self):
        self.shared = 'edited guidance'

    def close(self):
        self.closed = True
        for process in self.processes:
            process.kill()
            process.wait()


class FakePlatform(run.Platform):
    def __init__(self, state, modes=None, exit64=None):
        self.state, self.modes, self.calls = state, modes or {}, []
        self.exit64 = exit64 or {'site': 'argv_parse', 'exitStatus': 64, 'initReceipt': False, 'pidfdReceived': False}
        self.session = None

    def stage_packet(self, packet_dir, pin):
        self.calls.append('stage')
        return 'staged'

    def exit64_case(self, staged):
        self.calls.append('exit64')
        return self.exit64

    def open_session(self, staged):
        self.calls.append('session')
        self.session = FakeSession(self.state, self.modes)
        return self.session


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='guided-run-test-')
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.packet = os.path.join(self.dir, 'packet')
        self.out = os.path.join(self.dir, 'out')
        self.state = os.path.join(self.dir, 'state')
        for d in (self.packet, self.out, self.state):
            os.mkdir(d)
        open(os.path.join(self.packet, 'guided-packet.tar.gz'), 'wb').write(b'x')
        open(os.path.join(self.packet, 'packet-inventory.json'), 'wb').write(b'{}')
        self.write_verifier(GOOD_REPORT)
        self.write_pin(GOOD_PIN)

    def tarball(self, members):
        path = os.path.join(self.packet, 'guided-packet.tar.gz')
        with tarfile.open(path, 'w:gz') as tar:
            for name, kind, payload in members:
                info = tarfile.TarInfo(name)
                if kind == 'file':
                    info.size = len(payload)
                    tar.addfile(info, io.BytesIO(payload))
                else:
                    info.type = tarfile.SYMTYPE
                    info.linkname = payload
                    tar.addfile(info)

    def write_verifier(self, report, code=0, body=None):
        text = body if body is not None else f"import json,sys\nopen(sys.argv[1],'rb').close()\nprint(json.dumps({report!r}))\nsys.exit({code})\n"
        self.verifier = os.path.join(self.dir, 'verify_packet.py')
        open(self.verifier, 'w').write(text)
        self.verifier_sha = sha(text)

    def write_pin(self, pin):
        text = json.dumps(pin)
        self.pin = os.path.join(self.dir, 'compile.pin.json')
        open(self.pin, 'w').write(text)
        self.pin_sha = sha(text)

    def argv(self, **override):
        values = dict(packet=self.packet, out=self.out, verifier=self.verifier, vsha=self.verifier_sha, pin=self.pin, psha=self.pin_sha)
        values.update(override)
        return [os.path.join(HERE, 'run.py'), values['packet'], values['out'], values['verifier'], values['vsha'], values['pin'], values['psha']]

    def go(self, platform=None, env=None, euid=lambda: 0, argv=None, directory=HERE):
        platform = platform or FakePlatform(self.state)
        with contextlib.redirect_stdout(io.StringIO()):
            status = run.main(argv or self.argv(), platform, ENV if env is None else env, directory, euid)
        path = os.path.join(self.out, 'result.json')
        return status, (json.load(open(path)) if os.path.exists(path) else None), platform


class HappyPath(Base):
    def test_a_full_run_passes_and_writes_one_bounded_record(self):
        status, result, platform = self.go()
        self.assertEqual(status, 0)
        self.assertEqual(result['failureClass'], None)
        self.assertTrue(result['passed'])
        self.assertEqual(result['schema'], 'winter-guided-hosted-run/1')
        self.assertTrue(result['verdict']['passed'])
        self.assertEqual(platform.calls, ['stage', 'exit64', 'session'])
        self.assertTrue(platform.session.closed)
        self.assertEqual(sorted(result), ['failureClass', 'kernelRelease', 'machine', 'passed', 'schema', 'stage', 'verdict'])

    def test_relative_paths_are_resolved_before_the_verifier_runs_elsewhere(self):
        cwd = os.getcwd()
        os.chdir(self.dir)
        try:
            rel = lambda p: os.path.relpath(p, self.dir)
            argv = self.argv(packet=rel(self.packet), out=rel(self.out), verifier=rel(self.verifier), pin=rel(self.pin))
            status, result, _ = self.go(argv=argv)
        finally:
            os.chdir(cwd)
        self.assertEqual((status, result['failureClass']), (0, None))

    def test_result_is_written_exclusively(self):
        open(os.path.join(self.out, 'result.json'), 'w').write('{}')
        status, _, _ = self.go()
        self.assertEqual(status, 78)

    def test_the_embedded_sibling_pins_match_the_files(self):
        self.assertEqual(run.ORACLE_SHA256, sha(open(os.path.join(HERE, 'oracle.py'), 'rb').read()))
        self.assertEqual(run.ADAPTER_SHA256, sha(open(os.path.join(HERE, 'roles_adapter.py'), 'rb').read()))


class Admission(Base):
    def test_not_root_is_refused_before_anything(self):
        status, result, platform = self.go(euid=lambda: 1000)
        self.assertEqual((status, result['failureClass'], platform.calls), (78, 'admission', []))

    def test_missing_or_wrong_opt_in_is_refused(self):
        for env in ({}, {run.OPT_IN: 'yes'}, {run.OPT_IN: run.OPT_IN_VALUE + 'x'}):
            os.remove(os.path.join(self.out, 'result.json')) if os.path.exists(os.path.join(self.out, 'result.json')) else None
            status, result, platform = self.go(env=env)
            self.assertEqual((status, result['failureClass'], platform.calls), (78, 'admission', []), env)

    def test_wrong_argument_count_is_refused(self):
        status, result, _ = self.go(argv=self.argv()[:-1])
        self.assertEqual((status, result['failureClass']), (78, 'arguments'))


class PacketVerification(Base):
    """The packet is verified FIRST: any refusal here means no platform call and no role was ever started."""

    def refused(self, **kw):
        status, result, platform = self.go(**kw)
        self.assertEqual((status, result['failureClass'], result['stage']), (78, 'packet_verify', 'packet_verify'))
        self.assertEqual(platform.calls, [])
        self.assertIsNone(result['verdict'])

    def test_all_checks_hold_false(self):
        self.write_verifier({**GOOD_REPORT, 'allChecksHold': False})
        self.refused(argv=self.argv(vsha=self.verifier_sha))

    def test_a_single_false_check_even_with_all_checks_hold_true(self):
        self.write_verifier({**GOOD_REPORT, 'checks': {'one': True, 'two': False}})
        self.refused()

    def test_verifier_exits_nonzero(self):
        self.write_verifier(GOOD_REPORT, code=1)
        self.refused()

    def test_a_placeholder_role_in_the_report(self):
        self.write_verifier({**GOOD_REPORT, 'placeholders': ['hostClient']})
        self.refused()

    def test_a_placeholder_role_in_the_pin(self):
        self.write_pin({**GOOD_PIN, 'artifacts': {'roles': {'hostClient': {'sha256': 'a' * 64, 'placeholder': True}}}})
        self.refused()

    def test_empty_or_missing_checks(self):
        for report in ({**GOOD_REPORT, 'checks': {}}, {k: v for k, v in GOOD_REPORT.items() if k != 'checks'}, {**GOOD_REPORT, 'kind': 'other'}, {**GOOD_REPORT, 'outputsExecuted': True}):
            self.write_verifier(report)
            self.refused()

    def test_garbage_or_oversized_output(self):
        self.write_verifier(None, body="print('not json')\n")
        self.refused()
        self.write_verifier(None, body="print('x' * (17 * 1024 * 1024))\n")
        self.refused()

    def test_verifier_bytes_must_match_their_pin(self):
        self.refused(argv=self.argv(vsha='0' * 64))

    def test_pin_bytes_must_match_their_pin(self):
        self.refused(argv=self.argv(psha='0' * 64))

    def test_a_symlinked_verifier_or_pin_is_refused(self):
        link = os.path.join(self.dir, 'link.py')
        os.symlink(self.verifier, link)
        self.refused(argv=self.argv(verifier=link))

    def test_a_missing_archive_is_refused(self):
        os.remove(os.path.join(self.packet, 'guided-packet.tar.gz'))
        status, result, _ = self.go()
        self.assertEqual((status, result['failureClass']), (78, 'packet_verify'))

    def test_the_verifier_is_dropped_to_the_packet_owner_when_root(self):
        source = open(os.path.join(HERE, 'run.py')).read()
        self.assertIn("{'user': info.st_uid, 'group': info.st_gid, 'extra_groups': []} if os.geteuid() == 0 else {}", source)
        self.assertIn('if info.st_uid == 0 or info.st_gid == 0:', source)


class Siblings(Base):
    def test_a_tampered_oracle_or_adapter_never_loads(self):
        for name in ('oracle.py', 'roles_adapter.py'):
            copy = os.path.join(self.dir, 'sib')
            shutil.rmtree(copy, True)
            shutil.copytree(HERE, copy, ignore=shutil.ignore_patterns('__pycache__'))
            open(os.path.join(copy, name), 'a').write('# tampered\n')
            status, result, platform = self.go(directory=copy)
            self.assertEqual((status, result['failureClass'], platform.calls), (78, 'sibling_pin', []), name)
            os.remove(os.path.join(self.out, 'result.json'))


class QueryChain(Base):
    def chain(self, **modes):
        return self.go(platform=FakePlatform(self.state, modes))

    def test_revocation_that_reaches_the_stub_fails_the_verdict_even_though_the_host_refused(self):
        status, result, _ = self.chain(host='revoke_leaks')
        self.assertEqual(status, 1)
        self.assertEqual(result['failureClass'], 'verdict')
        self.assertEqual(result['verdict']['cases']['revocation']['failureClass'], 'revocation_provider_request')

    def test_a_spent_ticket_accepted_fails_the_reuse_case(self):
        status, result, _ = self.chain(host='reuse_accepted')
        self.assertEqual(status, 1)
        self.assertEqual(result['verdict']['cases']['ticket_reuse']['failureClass'], 'reuse_not_refused')
        self.assertEqual(result['verdict']['cases']['revocation']['failureClass'], 'not_run')

    def test_a_reuse_that_reaches_the_stub_fails_even_though_the_host_refused(self):
        status, result, _ = self.chain(host='reuse_leaks')
        self.assertEqual(result['verdict']['cases']['ticket_reuse']['failureClass'], 'reuse_provider_request')

    def test_revoke_is_really_sent(self):
        # The fake host accepts the pre-minted ticket unless revoke arrived first, so a skipped revoke fails the case.
        status, result, _ = self.chain()
        self.assertEqual(result['verdict']['cases']['revocation'], {'passed': True, 'failureClass': None})

    def test_both_role_channels_are_closed_at_the_end(self):
        status, result, platform = self.chain()
        self.assertTrue(all(process.stdin.closed for process in platform.session.processes))

    def test_a_wrong_revocation_class_fails(self):
        status, result, _ = self.chain(host='revoke_wrong_class')
        self.assertEqual(result['verdict']['cases']['revocation']['failureClass'], 'revocation_not_refused')

    def test_a_wrong_first_answer_fails_dispatch1_and_stops_the_chain(self):
        status, result, _ = self.chain(host='wrong_answer')
        self.assertEqual(result['verdict']['cases']['dispatch1']['failureClass'], 'dispatch_answer')
        self.assertEqual(result['verdict']['cases']['dispatch2']['failureClass'], 'not_run')

    def test_the_exit64_case_is_independent_of_the_chain(self):
        platform = FakePlatform(self.state, exit64={'site': 'argv_parse', 'exitStatus': 1, 'initReceipt': False, 'pidfdReceived': False})
        status, result, _ = self.go(platform=platform)
        self.assertEqual(status, 1)
        cases = result['verdict']['cases']
        self.assertEqual(cases['reader_exit64']['failureClass'], 'reader_exit_status')
        self.assertTrue(all(cases[name]['passed'] for name in oracle.CHAIN))

    def test_a_role_refusal_is_a_stage_class_and_the_session_is_closed(self):
        status, result, platform = self.chain(host='dispatch1_refused')
        self.assertEqual((status, result['failureClass']), (78, 'dispatch1'))
        self.assertTrue(platform.session.closed)
        self.assertIsNone(result['verdict'])

    def test_the_provider_refusing_its_script_is_provider_start(self):
        status, result, _ = self.chain(provider='script_refused')
        self.assertEqual((status, result['failureClass']), (78, 'provider_start'))

    def test_a_role_that_exits_or_speaks_garbage_is_a_bounded_class(self):
        for mode in ('exit', 'garbage', 'huge'):
            status, result, platform = self.chain(host=mode)
            self.assertEqual((status, result['failureClass']), (78, 'dispatch1'), mode)
            os.remove(os.path.join(self.out, 'result.json'))
            open(os.path.join(self.state, 'counters.json'), 'w').close() if False else None

    def test_no_role_text_reaches_the_result(self):
        status, result, _ = self.chain(host='garbage')
        self.assertNotIn('not json', json.dumps(result))


class Platform(Base):
    def test_the_real_platform_refuses_what_is_not_written_and_does_not_start_roles(self):
        self.tarball([('receipt.json', 'file', b'{}')])
        status, result, _ = self.go(platform=run.RealPlatform(parent=self.dir))
        self.assertEqual((status, result['failureClass']), (78, 'platform_incomplete'))
        self.assertIsNone(result['verdict'])

    def test_stage_packet_assigns_modes_and_recreates_links(self):
        self.tarball([('artifacts/runtimeEntry', 'file', b'elf'), ('artifacts/runtimeEntry.metafile.json', 'file', b'{}'), ('receipt.json', 'file', b'{}'),
                      ('environment/libc.so', 'file', b'lib'), ('bun/bun', 'file', b'bun'), ('alias', 'link', 'receipt.json')])
        root = run.RealPlatform(parent=self.dir).stage_packet(self.packet, GOOD_PIN)
        mode = lambda n: oct(os.lstat(os.path.join(root, n)).st_mode & 0o777)
        self.assertEqual((mode('artifacts/runtimeEntry'), mode('artifacts/runtimeEntry.metafile.json'), mode('receipt.json'), mode('environment/libc.so'), mode('bun/bun')), ('0o555', '0o400', '0o400', '0o555', '0o555'))
        self.assertEqual(os.readlink(os.path.join(root, 'alias')), 'receipt.json')
        self.assertEqual(oct(os.stat(root).st_mode & 0o777), '0o700')

    def test_stage_packet_refuses_escapes_and_special_members(self):
        for members in ([('../x', 'file', b'')], [('/abs', 'file', b'')], [('a', 'link', '../../etc/passwd')], [('a', 'link', '/etc/passwd')], [('a\\b', 'file', b'')]):
            self.tarball(members)
            with self.assertRaises(ValueError):
                run.RealPlatform(parent=self.dir).stage_packet(self.packet, GOOD_PIN)


class Adapter(unittest.TestCase):
    def roles(self, **modes):
        state = tempfile.mkdtemp(prefix='guided-adapter-')
        self.addCleanup(shutil.rmtree, state, True)
        procs = [subprocess.Popen([sys.executable, '-I', '-B', FAKE, name, state, modes.get(name, '')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) for name in ('provider', 'host')]
        self.addCleanup(lambda: [(p.kill(), p.wait()) for p in procs])
        return roles_adapter.GuidedRoles(procs[0], procs[1], timeout=1.0)

    def test_counters_come_only_from_the_provider_receipt(self):
        roles = self.roles()
        roles.start_provider(b'{}')
        self.assertEqual(roles.stub_receipt(), {'receivedFrames': 0, 'receivedBegins': 0, 'acceptedBegins': 0, 'completed': 0})
        self.assertEqual(roles.dispatch(1), 'first deterministic answer')
        self.assertEqual(roles.stub_receipt()['receivedBegins'], 1)

    def test_timeout_garbage_and_oversize_are_bounded_kinds(self):
        for mode, kind in (('silent', 'timeout'), ('garbage', 'protocol'), ('huge', 'protocol'), ('nonewline', 'protocol'), ('ok_int', 'protocol'), ('exit', 'closed')):
            roles = self.roles(host=mode)
            with self.assertRaises(roles_adapter.AdapterError) as raised:
                roles.dispatch(1)
            self.assertEqual(raised.exception.kind, kind, mode)

    def test_error_classes_are_bounded_text(self):
        for value in ('Bad Class', '', 'x' * 65, 5):
            with self.assertRaises(roles_adapter.AdapterError):
                roles_adapter._refusal({'ok': False, 'errorClass': value})
        self.assertEqual(roles_adapter._refusal({'ok': False, 'errorClass': 'required_context_unavailable'}), 'required_context_unavailable')
        self.assertEqual(roles_adapter._refusal({'ok': True}), '')

    def test_receipt_shape_is_closed_to_integers(self):
        for receipt in (None, [], {'receivedFrames': 1}, {'receivedFrames': True, 'receivedBegins': 1, 'acceptedBegins': 1, 'completed': 1}, {'receivedFrames': '1', 'receivedBegins': 1, 'acceptedBegins': 1, 'completed': 1}):
            with self.assertRaises(roles_adapter.AdapterError):
                roles_adapter._counters(receipt)

    def test_every_assumption_is_listed_once_and_numbered(self):
        names = [a.split()[0] for a in roles_adapter.ASSUMPTIONS]
        self.assertEqual(names, ['A%d' % n for n in range(1, len(names) + 1)])

    def test_the_adapter_is_the_only_module_that_names_a_role_operation(self):
        source = open(os.path.join(HERE, 'run.py')).read()
        for operation in ('"op"', "'op'", 'receivedFrames', 'errorClass', 'b64', 'sha256":'):
            self.assertNotIn(operation, source, operation)


if __name__ == '__main__':
    unittest.main()

"""Unit tests for the root runner, with fake role PROCESSES (fake_role.py, real subprocesses speaking the assumed
line-JSON contract), a fake platform, a fake verifier and a throwaway packet directory. Nothing here needs root, Linux,
the network or a real packet: the root checks are exercised through the runner's `euid` parameter."""
import contextlib
import hashlib
import io
import re
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import types
import warnings
from unittest import mock

warnings.simplefilter('ignore', ResourceWarning)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import oracle  # noqa: E402
import roles_adapter  # noqa: E402
import run  # noqa: E402
import session  # noqa: E402

FAKE = os.path.join(HERE, 'fake_role.py')
ENV = {run.OPT_IN: run.OPT_IN_VALUE}


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


GOOD_REPORT = {'kind': 'winter-guided-packet-verification', 'allChecksHold': True, 'checks': {'one': True, 'two': True}, 'placeholders': [], 'outputsExecuted': False}
GOOD_PIN = {'artifacts': {'roles': {'hostClient': {'sha256': 'a' * 64}, 'providerWorker': {'sha256': 'b' * 64}}}, 'bun': {'stageBase': {'path': 'bun/bun'}}}
GOOD_METAFILE = {'inputs': {'x/packages/sdk/src/query.ts': {}, 'x/packages/sdk/src/guided-query-reader.ts': {}, 'x/other/thing.ts': {}}}


class FakeSession:
    def __init__(self, state, modes, settle=True, exits=None):
        self.state, self.modes, self.processes = state, modes, []
        self.shared = 'old guidance'
        self.closed = False
        self.settle_result, self.exit_result = settle, exits
        self.settle_calls = []
        self.lifecycle_record = 'written'

    def spawn(self, role):
        name = 'provider' if role == 'providerWorker' else 'host'
        process = subprocess.Popen([sys.executable, '-I', '-B', FAKE, name, self.state, self.modes.get(name, '')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        return process

    def shared_sha256(self):
        return sha(self.shared)

    def edit_shared(self):
        self.shared = 'edited guidance'

    def settle(self, host_result_seen):
        self.settle_calls.append(host_result_seen)
        return self.settle_result

    def reap(self):
        if self.exit_result is not None:
            return self.exit_result
        result = {}
        for label, process in zip(('provider', 'host'), self.processes):
            try:
                result[label] = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                result[label] = process.wait()
        return result

    def close(self):
        self.closed = True
        for process in self.processes:
            process.kill()
            process.wait()


class FakePlatform(run.Platform):
    def __init__(self, state, modes=None, exit64=None, metafile=GOOD_METAFILE, settle=True, exits=None):
        self.state, self.modes, self.calls = state, modes or {}, []
        self.exit64 = exit64 or {'site': 'argv_parse', 'exitStatus': 64, 'initReceipt': False, 'pidfdReceived': False}
        self.session = None
        self.metafile, self.settle, self.exits = metafile, settle, exits

    role_timeout = 3.0

    def bind(self, session_module, directory):
        self.calls.append('bind')

    def stage_packet(self, packet_dir, pin):
        self.calls.append('stage')
        root = os.path.join(self.state, 'staged')
        os.makedirs(os.path.join(root, 'artifacts'), exist_ok=True)
        if self.metafile is not None:
            open(os.path.join(root, 'artifacts', 'hostClient.metafile.json'), 'w').write(json.dumps(self.metafile))
        return run.Staged(root, pin, {})

    def exit64_case(self, staged):
        self.calls.append('exit64')
        return self.exit64

    def open_session(self, staged):
        self.calls.append('session')
        self.session = FakeSession(self.state, self.modes, self.settle, self.exits)
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
        open(os.path.join(self.packet, 'packet-inventory.json'), 'w').write(json.dumps({'files': {}}))
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
        self.assertEqual(platform.calls, ['bind', 'stage', 'exit64', 'session'])
        self.assertTrue(platform.session.closed)
        self.assertEqual(sorted(result), ['exits', 'failureClass', 'hostPassed', 'kernelRelease', 'lifecycle', 'machine', 'passed', 'schema', 'settled', 'stage', 'verdict'])
        self.assertEqual((result['hostPassed'], result['settled'], result['exits']), (True, True, {'host': 0, 'provider': 0}))

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
        self.assertEqual(run.SESSION_SHA256, sha(open(os.path.join(HERE, 'session.py'), 'rb').read()))


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

    def test_a_request_after_the_last_barrier_is_seen_in_the_provider_summary(self):
        status, result, _ = self.chain(provider='summary_late')
        self.assertEqual((status, result['failureClass']), (1, 'verdict'))
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
        host, provider = platform.session.processes[1], platform.session.processes[0]
        self.assertTrue(host.stdin.closed)
        self.assertIsNotNone(provider.poll() if provider.wait(timeout=5) is not None else None)

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

    def test_a_command_the_host_refuses_is_a_stage_class(self):
        status, result, _ = self.chain(host='command_refused')
        self.assertEqual((status, result['failureClass']), (78, 'dispatch1'))

    def test_a_role_that_exits_or_speaks_garbage_is_a_bounded_class(self):
        for mode in ('exit', 'garbage', 'huge', 'bad_kind'):
            status, result, platform = self.chain(host=mode)
            self.assertEqual((status, result['failureClass']), (78, 'dispatch1'), mode)
            os.remove(os.path.join(self.out, 'result.json'))
            shutil.rmtree(self.state)
            os.mkdir(self.state)

    def test_no_role_text_reaches_the_result(self):
        status, result, _ = self.chain(host='garbage')
        self.assertNotIn('not json', json.dumps(result))

    def test_the_host_client_not_passing_fails_even_when_every_case_passes(self):
        status, result, _ = self.chain(host='not_passed')
        self.assertEqual((status, result['failureClass'], result['hostPassed']), (1, 'host_result', False))
        self.assertTrue(result['verdict']['passed'])
        self.assertFalse(result['passed'])

    def test_the_finish_order_is_finish_then_result_then_settle(self):
        # Pinned from the code that emits it (roles_adapter.FINISH_ORDER): the result is READ before the runtime is settled and the record written.
        status, result, platform = self.go()
        self.assertEqual(status, 0)
        self.assertEqual(platform.session.settle_calls, [True])
        self.assertEqual(result['lifecycle'], 'written')  # the session says whether the record was written or its reader was already gone

    def test_a_result_that_only_comes_after_the_record_is_the_refused_order(self):
        # A host that waits for the lifecycle record before printing its result can never be read before the record: refused, named, and the
        # record is never written (settle is not even called).
        status, result, platform = self.go(platform=FakePlatform(self.state, modes={'host': 'no_result'}))
        self.assertEqual((status, result['failureClass'], result['stage']), (78, 'finish_order', 'host_result'))
        self.assertEqual(platform.session.settle_calls, [])
        self.assertIsNone(result['settled'])

    def test_a_host_that_exits_at_finish_without_a_result_is_host_result_not_finish_order(self):
        status, result, platform = self.go(platform=FakePlatform(self.state, modes={'host': 'exit_without_result'}))
        self.assertEqual((status, result['failureClass'], result['stage']), (1, 'host_result', 'host_result'))
        self.assertEqual(platform.session.settle_calls, [])

    def test_a_platform_that_is_incomplete_is_named_as_such(self):
        class Incomplete(FakePlatform):
            def open_session(self, staged):
                raise run.PlatformIncomplete('open_session')
        status, result, _ = self.go(platform=Incomplete(self.state))
        self.assertEqual((status, result['failureClass']), (78, 'platform_incomplete'))
        self.assertIsNone(result['verdict'])

    def test_a_host_that_exits_without_a_result_is_host_result_not_finish_order(self):
        status, result, platform = self.go(platform=FakePlatform(self.state, modes={'host': 'exit'}))
        self.assertEqual(result['failureClass'], 'dispatch1')  # it never got as far as finish
        status, result, platform = self.go(platform=FakePlatform(self.state, modes={'host': 'garbage'}))
        self.assertNotEqual(result['failureClass'], 'finish_order')

    def test_a_result_before_finish_is_never_a_pass(self):
        status, result, platform = self.go(platform=FakePlatform(self.state, modes={'host': 'early_result'}))
        self.assertEqual((status, result['failureClass']), (78, 'dispatch1'))
        self.assertEqual(platform.session.settle_calls, [])

    def test_a_runtime_that_did_not_settle_fails_the_run(self):
        status, result, _ = self.go(platform=FakePlatform(self.state, settle=False))
        self.assertEqual((status, result['failureClass'], result['settled']), (78, 'teardown', False))

    def test_a_nonzero_role_exit_fails_the_run(self):
        for exits in ({'host': 1, 'provider': 0}, {'host': 0, 'provider': 3}, {'host': 0}):
            status, result, _ = self.go(platform=FakePlatform(self.state, exits=exits))
            self.assertEqual((status, result['failureClass']), (78, 'teardown'), exits)
            os.remove(os.path.join(self.out, 'result.json'))
            shutil.rmtree(self.state)
            os.mkdir(self.state)

    def test_a_provider_summary_whose_counters_disagree_is_a_teardown_failure(self):
        status, result, _ = self.chain(provider='summary_disagree')
        self.assertEqual((status, result['failureClass']), (78, 'teardown'))

    def test_the_provider_exiting_nonzero_on_stop_fails_the_run(self):
        status, result, _ = self.chain(provider='summary_exit')
        self.assertEqual((status, result['failureClass']), (78, 'teardown'))

    def test_a_receipt_with_the_wrong_tag_or_disagreeing_counters_is_a_stage_class(self):
        for mode in ('wrong_tag', 'agree_false'):
            status, result, _ = self.chain(provider=mode)
            self.assertEqual((status, result['failureClass']), (78, 'dispatch1'), mode)
            os.remove(os.path.join(self.out, 'result.json'))
            shutil.rmtree(self.state)
            os.mkdir(self.state)

    def test_tolerated_noise_does_not_change_the_verdict(self):
        status, result, _ = self.chain(host='noise', provider='noise')
        self.assertEqual(status, 0)


class Metafile(Base):
    def go_meta(self, metafile):
        return self.go(platform=FakePlatform(self.state, metafile=metafile))

    def test_a_duplicate_sdk_module_is_refused_before_anything_starts(self):
        platform = FakePlatform(self.state, metafile={'inputs': {'a/packages/sdk/src/guided-query-reader.ts': {}, 'b/winter-agent-sdk/src/guided-query-reader.ts': {}}})
        status, result, _ = self.go(platform=platform)
        self.assertEqual((status, result['failureClass']), (78, 'metafile'))
        self.assertEqual(platform.calls, ['bind', 'stage'])

    def test_any_duplicated_sdk_module_is_refused(self):
        status, result, _ = self.go_meta({'inputs': {'a/packages/sdk/src/guided-query-reader.ts': {}, 'a/packages/sdk/src/query.ts': {}, 'b/winter-agent-sdk/dist/query.js': {}}})
        self.assertEqual((status, result['failureClass']), (78, 'metafile'))

    def test_a_missing_reader_module_or_missing_metafile_is_refused(self):
        for meta in ({'inputs': {'a/packages/sdk/src/query.ts': {}}}, {'inputs': {}}, {'nothing': 1}, None):
            status, result, _ = self.go_meta(meta)
            self.assertEqual((status, result['failureClass']), (78, 'metafile'), meta)
            os.remove(os.path.join(self.out, 'result.json'))
            shutil.rmtree(self.state)
            os.mkdir(self.state)

    def test_one_copy_of_each_module_passes(self):
        status, result, _ = self.go_meta(GOOD_METAFILE)
        self.assertEqual(status, 0)


class Platform(Base):
    def tarball(self, members):
        path = os.path.join(self.packet, 'guided-packet.tar.gz')
        open(os.path.join(self.packet, 'packet-inventory.json'), 'w').write(json.dumps({'files': {'x': {'sha256': 'a' * 64}}}))
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

    def inputs_directory(self, data=None):
        """A directory holding fixture-inputs.json: the committed bytes, or `data`."""
        directory = os.path.join(self.dir, 'siblings')
        os.makedirs(directory, exist_ok=True)
        shutil.copy(os.path.join(HERE, 'fixture-inputs.json'), os.path.join(directory, 'fixture-inputs.json'))
        if data is not None:
            open(os.path.join(directory, 'fixture-inputs.json'), 'wb').write(data)
        return directory

    def fake_module(self, calls):
        class GuidedSession:
            @staticmethod
            def open(staged, inputs, directory):
                calls.append(('open', staged, inputs, directory))
                return FakeSession(self.state, {})
        return types.SimpleNamespace(GuidedSession=GuidedSession, exit64_case=lambda staged: calls.append(('exit64', staged)) or {'site': 'argv_parse', 'exitStatus': 64, 'initReceipt': False, 'pidfdReceived': False})

    def test_the_committed_fixture_inputs_are_pinned_closed_and_what_the_session_accepts(self):
        data = open(os.path.join(HERE, 'fixture-inputs.json'), 'rb').read()
        self.assertEqual(hashlib.sha256(data).hexdigest(), run.FIXTURE_INPUTS_SHA256)
        self.assertNotEqual(run.FIXTURE_INPUTS_SHA256, '0' * 64)
        inputs = json.loads(data)
        self.assertIs(session.validate_inputs(inputs), inputs)
        self.assertEqual(json.dumps(inputs, separators=(',', ':'), ensure_ascii=False).encode() + b'\n', data)  # compact, in the generator's order

    def test_open_session_hands_the_verified_tree_and_the_pinned_inputs_to_the_session_module(self):
        calls, staged = [], run.Staged('/staged', GOOD_PIN, {})
        directory = self.inputs_directory()
        platform = run.RealPlatform(parent=self.dir)
        platform.bind(self.fake_module(calls), directory)
        opened = platform.open_session(staged)
        self.assertIsInstance(opened, FakeSession)
        (kind, got_staged, inputs, got_directory), = calls
        self.assertEqual((kind, got_staged, got_directory), ('open', staged, directory))
        self.assertEqual(inputs, json.loads(open(os.path.join(HERE, 'fixture-inputs.json'), 'rb').read()))

    def test_exit64_case_drives_the_session_modules_entry_point(self):
        calls, staged = [], run.Staged('/staged', GOOD_PIN, {})
        platform = run.RealPlatform(parent=self.dir)
        platform.bind(self.fake_module(calls), self.inputs_directory())
        self.assertEqual(platform.exit64_case(staged)['exitStatus'], 64)
        self.assertEqual(calls, [('exit64', staged)])

    def test_open_session_refuses_changed_inputs_before_anything_starts(self):
        calls = []
        data = open(os.path.join(HERE, 'fixture-inputs.json'), 'rb').read()
        for changed in (data + b' ', data.replace(b'ALPHA', b'alpha'), b'{}', b''):
            platform = run.RealPlatform(parent=self.dir)
            platform.bind(self.fake_module(calls), self.inputs_directory(changed))
            with self.assertRaises((OSError, ValueError)):
                platform.open_session(run.Staged('/staged', GOOD_PIN, {}))
        self.assertEqual(calls, [])

    def test_a_missing_inputs_file_or_symlink_is_refused(self):
        calls, directory = [], self.inputs_directory()
        os.remove(os.path.join(directory, 'fixture-inputs.json'))
        platform = run.RealPlatform(parent=self.dir)
        platform.bind(self.fake_module(calls), directory)
        with self.assertRaises((OSError, ValueError)):
            platform.open_session(run.Staged('/staged', GOOD_PIN, {}))
        os.symlink(os.path.join(HERE, 'fixture-inputs.json'), os.path.join(directory, 'fixture-inputs.json'))
        with self.assertRaises((OSError, ValueError)):
            platform.open_session(run.Staged('/staged', GOOD_PIN, {}))
        self.assertEqual(calls, [])

    def test_an_unpinned_inputs_hash_or_an_unbound_platform_still_refuses_as_incomplete(self):
        staged = run.Staged('/staged', GOOD_PIN, {})
        with self.assertRaises(run.PlatformIncomplete):
            run.RealPlatform(parent=self.dir).open_session(staged)
        with self.assertRaises(run.PlatformIncomplete):
            run.RealPlatform(parent=self.dir).exit64_case(staged)
        platform = run.RealPlatform(parent=self.dir)
        platform.bind(self.fake_module([]), self.inputs_directory())
        with mock.patch.object(run, 'FIXTURE_INPUTS_SHA256', '0' * 64), self.assertRaises(run.PlatformIncomplete):
            platform.open_session(staged)

    def test_the_real_platform_runs_the_whole_chain_over_an_injected_session_module(self):
        """RealPlatform's own glue end to end: verified packet, staging, metafile preflight, exit-64, open, the chain, settle in the pinned order."""
        calls = []
        self.tarball([('artifacts/hostClient.metafile.json', 'file', json.dumps(GOOD_METAFILE).encode())])
        module = self.fake_module(calls)

        class Injected(run.RealPlatform):
            role_timeout = 3.0

            def bind(self_, session_module, directory):
                super().bind(module, directory)  # the real session.py is loaded and pinned by run(); the injected fake replaces its entry points
        status, result, _ = self.go(platform=Injected(parent=self.dir), directory=HERE)
        self.assertEqual((status, result['failureClass'], result['passed']), (0, None, True))
        self.assertEqual([c[0] for c in calls], ['exit64', 'open'])
        self.assertEqual(calls[0][1], calls[1][1])  # the same staged tree
        self.assertTrue(result['verdict']['passed'])

    def test_stage_packet_assigns_modes_recreates_links_and_returns_the_inventory(self):
        self.tarball([('artifacts/runtimeEntry', 'file', b'elf'), ('artifacts/runtimeEntry.metafile.json', 'file', b'{}'), ('receipt.json', 'file', b'{}'),
                      ('environment/libc.so', 'file', b'lib'), ('bun/bun', 'file', b'bun'), ('alias', 'link', 'receipt.json')])
        staged = run.RealPlatform(parent=self.dir).stage_packet(self.packet, GOOD_PIN)
        mode = lambda n: oct(os.lstat(os.path.join(staged.root, n)).st_mode & 0o777)
        self.assertEqual((mode('artifacts/runtimeEntry'), mode('artifacts/runtimeEntry.metafile.json'), mode('receipt.json'), mode('environment/libc.so'), mode('bun/bun')), ('0o555', '0o400', '0o400', '0o555', '0o555'))
        self.assertEqual(os.readlink(os.path.join(staged.root, 'alias')), 'receipt.json')
        self.assertEqual(oct(os.stat(staged.root).st_mode & 0o777), '0o700')
        self.assertEqual((staged.pin, staged.inventory), (GOOD_PIN, {'x': {'sha256': 'a' * 64}}))

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
        roles.await_provider_ready()
        self.assertEqual(roles.stub_receipt('first'), {key: 0 for key in roles_adapter.COUNTERS})
        self.assertEqual(roles.dispatch(1), 'first deterministic answer')
        self.assertEqual(roles.stub_receipt('second')['receivedBegins'], 1)

    def test_the_provider_summary_is_the_final_figure(self):
        roles = self.roles()
        roles.await_provider_ready()
        roles.dispatch(1)
        self.assertEqual(roles.stop()['acceptedBegins'], 1)

    def test_host_commands_and_results(self):
        roles = self.roles()
        roles.await_provider_ready()
        roles.dispatch(1)
        roles.dispatch(2)
        self.assertEqual(roles.present_spent(), 'required_context_unavailable')
        roles.premint()
        roles.revoke()
        self.assertEqual(roles.present_premint(), 'required_context_unavailable')
        roles.finish_send()
        self.assertIs(roles.finish_result(), True)

    def test_a_host_result_before_finish_is_its_own_kind(self):
        roles = self.roles(host='early_result')
        with self.assertRaises(roles_adapter.AdapterError) as raised:
            roles.dispatch(1)
        self.assertEqual(raised.exception.kind, 'premature_result')

    def test_the_finish_order_is_pinned_in_the_adapter(self):
        self.assertEqual(roles_adapter.FINISH_ORDER, ('finish', 'host-result', 'lifecycle-record'))
        self.assertFalse([line for line in roles_adapter.REMAINING_DIFFERENCES if 'lifecycle' in line])

    def test_an_accepted_presentation_is_the_empty_class(self):
        roles = self.roles(host='reuse_accepted')
        self.assertEqual(roles.present_spent(), '')

    def test_timeout_garbage_and_oversize_are_bounded_kinds(self):
        for mode, kind in (('silent', 'timeout'), ('garbage', 'protocol'), ('huge', 'protocol'), ('nonewline', 'protocol'), ('exit', 'closed')):
            roles = self.roles(host=mode)
            with self.assertRaises(roles_adapter.AdapterError) as raised:
                roles.dispatch(1)
            self.assertEqual(raised.exception.kind, kind, mode)

    def test_dispatch_replies_are_checked_for_number_size_and_type(self):
        for mode in ('wrong_n', 'long_answer'):
            roles = self.roles(host=mode)
            with self.assertRaises(roles_adapter.AdapterError) as raised:
                roles.dispatch(1)
            self.assertEqual(raised.exception.kind, 'protocol', mode)

    def test_the_host_result_must_carry_a_real_boolean(self):
        roles = self.roles(host='passed_string')
        roles.finish_send()
        with self.assertRaises(roles_adapter.AdapterError) as raised:
            roles.finish_result()
        self.assertEqual(raised.exception.kind, 'protocol')

    def test_unbounded_tolerated_noise_is_a_protocol_error(self):
        roles = self.roles(host='spam')
        with self.assertRaises(roles_adapter.AdapterError) as raised:
            roles.dispatch(1)
        self.assertEqual(raised.exception.kind, 'protocol')

    def test_provider_garbage_silence_and_a_missing_ready_line(self):
        for mode, kind in (('silent', 'timeout'), ('garbage', 'protocol')):
            roles = self.roles(provider=mode)
            roles.await_provider_ready()
            with self.assertRaises(roles_adapter.AdapterError) as raised:
                roles.stub_receipt('tag')
            self.assertEqual(raised.exception.kind, kind, mode)
        roles = self.roles(provider='not_ready')
        with self.assertRaises(roles_adapter.AdapterError) as raised:
            roles.await_provider_ready()
        self.assertEqual(raised.exception.kind, 'timeout')

    def test_tags_and_commands_are_closed_text(self):
        roles = self.roles()
        for tag in ('', 'Upper', 'a b', 'x' * 33, '-lead', 'a;b'):
            with self.assertRaises(roles_adapter.AdapterError):
                roles.stub_receipt(tag)
        with self.assertRaises(roles_adapter.AdapterError):
            roles.host.send('dispatch 1; rm')

    def test_presentation_shapes_are_checked(self):
        good = {'kind': 'host-presented', 'which': 'spent', 'refused': True, 'errorClass': 'required_context_unavailable', 'processStarted': False}
        self.assertEqual(roles_adapter._presented(good, 'spent'), 'required_context_unavailable')
        for change in ({'which': 'premint'}, {'errorClass': 'none'}, {'errorClass': 'weird'}, {'processStarted': True}, {'refused': 1}):
            with self.assertRaises(roles_adapter.AdapterError):
                roles_adapter._presented({**good, **change}, 'spent')
        with self.assertRaises(roles_adapter.AdapterError):
            roles_adapter._presented({**good, 'refused': False}, 'spent')

    def test_counters_need_agreement_and_plain_integers(self):
        base = {'kind': 'provider-receipt', 'countersAgree': True, **{key: 0 for key in roles_adapter.COUNTERS}}
        self.assertEqual(roles_adapter.counters(base), {key: 0 for key in roles_adapter.COUNTERS})
        for bad in ({'countersAgree': False}, {'countersAgree': 1}, {'requests': True}, {'requests': -1}, {'requests': '1'}, {'completed': 1 << 40}):
            with self.assertRaises(roles_adapter.AdapterError):
                roles_adapter.counters({**base, **bad})
        with self.assertRaises(roles_adapter.AdapterError):
            roles_adapter.counters(None)

    def test_every_contract_line_is_numbered_by_its_id(self):
        ids = [line.split()[0] for line in roles_adapter.CONTRACT]
        self.assertTrue(all(re.fullmatch(r'C-[PH]\d+', i) for i in ids))
        self.assertEqual(len(set(ids)), len(ids))
        self.assertEqual([line.split()[0] for line in roles_adapter.REMAINING_DIFFERENCES], ['D%d' % n for n in range(1, len(roles_adapter.REMAINING_DIFFERENCES) + 1)])

    def test_the_adapter_is_the_only_module_that_names_a_role_wire_word(self):
        for name in ('run.py', 'session.py'):
            source = open(os.path.join(HERE, name)).read()
            for operation in ('provider-receipt', 'host-dispatch', 'host-presented', 'present-premint', 'provider-summary', 'errorClass', 'processStarted'):
                self.assertNotIn(operation, source, name + ' ' + operation)


REAL_PACKET = os.environ.get('WINTER_GUIDED_REAL_PACKET')  # a directory holding the downloaded run-2 guided-packet.tar.gz and packet-inventory.json
REAL_RUNTIME = os.environ.get('WINTER_GUIDED_REAL_RUNTIME')  # runtime-sdk files: verify_packet.py and the run-2 pin, side by side


@unittest.skipUnless(REAL_PACKET and REAL_RUNTIME, 'set WINTER_GUIDED_REAL_PACKET and WINTER_GUIDED_REAL_RUNTIME to check the real run-2 packet')
class RealPacket(unittest.TestCase):
    """Optional, off in CI (the artifact is 195 MB): the runner's own packet code against the REAL run-2 artifact."""

    def setUp(self):
        self.pin = os.path.join(REAL_RUNTIME, 'compile-39227365159.pin.json')
        self.verifier = os.path.join(REAL_RUNTIME, 'verify_packet.py')
        self.pin_data = json.load(open(self.pin))

    def test_the_real_verifier_accepts_the_real_packet_with_an_explicit_pin(self):
        digest = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
        real_stat = os.stat

        def stat_nonzero_gid(path, *args, **kw):
            info = real_stat(path, *args, **kw)
            if os.fspath(path) == REAL_PACKET and info.st_gid == 0:  # macOS gives files the wheel group; the Linux runner user's gid is nonzero
                return types.SimpleNamespace(st_uid=info.st_uid, st_gid=20)
            return info
        with mock.patch.object(run.os, 'stat', stat_nonzero_gid):
            data = run.verify_packet(REAL_PACKET, self.verifier, digest(self.verifier), self.pin, digest(self.pin))
        self.assertEqual(data['artifacts']['roles']['hostClient']['sha256'], self.pin_data['artifacts']['roles']['hostClient']['sha256'])

    def test_staging_the_real_packet_passes_the_metafile_preflight_and_the_tree_preparation(self):
        parent = tempfile.mkdtemp(prefix='real-', dir='/tmp')
        self.addCleanup(session.remove_tree, parent)
        staged = run.RealPlatform(parent=parent).stage_packet(REAL_PACKET, self.pin_data)
        run.check_host_metafile(os.path.join(staged.root, 'artifacts', 'hostClient.metafile.json'))
        hashes = session.role_hashes(self.pin_data)
        root = os.path.join(parent, 'run')
        os.mkdir(root, 0o711)
        layout = session.prepare_tree(root, staged, {'guidance': {'old': 'o', 'edited': 'e'}}, hashes, chown=lambda *a: None)
        self.assertEqual(len(os.listdir(layout['bin'])), 10)


if __name__ == '__main__':
    unittest.main(warnings='ignore')

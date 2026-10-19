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
        self.named, self.launches, self.launch_error = {}, [], None

    def start(self, name):
        process = subprocess.Popen([sys.executable, '-I', '-B', FAKE, name, self.state, self.modes.get(name, '')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        self.named[name] = process
        return process

    def spawn(self, role):
        if role != 'hostClient':
            raise RuntimeError('only the host client exists before launch')
        return self.named['host'] if 'host' in self.named else self.start('host')

    def launch(self, binding_id):
        self.launches.append(binding_id)
        if len(self.launches) > 1:
            raise RuntimeError('launched twice')
        if self.launch_error:
            raise self.launch_error
        return self.start('provider')

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
        for label, process in (('provider', self.named.get('provider')), ('host', self.named.get('host'))):
            if process is None:
                continue
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
        self.write_pin(self.pin_with_hashes())

    def pin_with_hashes(self):
        """GOOD_PIN plus the sha256 of the archive and the inventory now in the packet directory, as a real pin records them."""
        digest = lambda name: hashlib.sha256(open(os.path.join(self.packet, name), 'rb').read()).hexdigest()
        return {**GOOD_PIN, 'archive': {'sha256': digest('guided-packet.tar.gz')}, 'inventory': {'sha256': digest('packet-inventory.json')}}

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
        self.write_pin(self.pin_with_hashes())

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
        self.assertEqual(sorted(result), ['diagnostic', 'exits', 'failureClass', 'hostPassed', 'kernelRelease', 'lifecycle', 'machine', 'passed', 'schema', 'settled', 'stage', 'verdict'])
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

    def test_a_hard_linked_or_oversize_input_is_refused_by_the_identity_check(self):
        # the st_nlink and size identity checks of read_pinned, each on its own
        data = b'abc'
        path = os.path.join(self.dir, 'one')
        open(path, 'wb').write(data)
        self.assertEqual(run.read_pinned(path, hashlib.sha256(data).hexdigest()), data)
        os.link(path, path + '.two')
        with self.assertRaises(ValueError):
            run.read_pinned(path, hashlib.sha256(data).hexdigest())
        os.unlink(path + '.two')
        with self.assertRaises(ValueError):
            run.read_pinned(path, hashlib.sha256(data).hexdigest(), limit=2)
        self.assertEqual(run.read_pinned(path, hashlib.sha256(data).hexdigest(), limit=3), data)
        os.mkdir(path + '.dir')
        with self.assertRaises((ValueError, OSError)):
            run.read_pinned(path + '.dir', hashlib.sha256(data).hexdigest())
        with self.assertRaises(ValueError):
            run.read_pinned(path, '0' * 64)

    def test_a_hard_linked_verifier_is_refused(self):
        os.link(self.verifier, self.verifier + '.alias')
        self.refused()

    def test_a_symlinked_verifier_or_pin_is_refused(self):
        link = os.path.join(self.dir, 'link.py')
        os.symlink(self.verifier, link)
        self.refused(argv=self.argv(verifier=link))

    def test_a_missing_archive_is_refused(self):
        os.remove(os.path.join(self.packet, 'guided-packet.tar.gz'))
        status, result, _ = self.go()
        self.assertEqual((status, result['failureClass']), (78, 'packet_verify'))

    def probing_verifier(self):
        record = os.path.join(self.dir, 'probe.json')
        body = ("import json,os,sys,stat\n"
                "me = os.path.abspath(sys.argv[0]); pin = sys.argv[sys.argv.index('--pin') + 1]\n"
                "info = {'me': me, 'pin': pin, 'meMode': stat.S_IMODE(os.stat(me).st_mode), 'pinMode': stat.S_IMODE(os.stat(pin).st_mode), 'meBytes': open(me).read(), 'pinBytes': open(pin).read(), 'dirMode': stat.S_IMODE(os.stat(os.path.dirname(me)).st_mode)}\n"
                f"open({record!r}, 'w').write(json.dumps(info))\n"
                f"print(json.dumps({GOOD_REPORT!r}))\n")
        self.write_verifier(None, body=body)
        return record

    def test_the_verifier_and_the_pin_run_from_root_owned_copies_of_the_hashed_bytes(self):
        record = self.probing_verifier()
        status, result, _ = self.go()
        self.assertEqual(status, 0)
        seen = json.load(open(record))
        for key, original in (('me', self.verifier), ('pin', self.pin)):
            self.assertNotEqual(seen[key], original)
            self.assertIn('winter-guided-verify-', seen[key])
            self.assertEqual(os.path.basename(seen[key]), os.path.basename(original))
        self.assertEqual((seen['meMode'], seen['pinMode'], seen['dirMode']), (0o444, 0o444, 0o755))
        self.assertEqual(seen['meBytes'], open(self.verifier).read())
        self.assertEqual(seen['pinBytes'], open(self.pin).read())
        self.assertFalse(os.path.exists(os.path.dirname(seen['me'])))  # the copies are removed afterwards

    def test_a_verifier_or_pin_rewritten_after_hashing_is_not_what_runs(self):
        record = self.probing_verifier()
        real = run.read_pinned
        original = open(self.verifier).read()
        pin_text = open(self.pin).read()
        def swap(path, digest, limit=run.MAX_SMALL):
            data = real(path, digest, limit)
            if path == self.verifier:
                open(path, 'w').write("raise SystemExit(0)  # replaced after the hash\n")
            if path == self.pin:
                open(path, 'w').write('{"replaced": true}')
            return data
        with mock.patch.object(run, 'read_pinned', swap):
            status, result, _ = self.go()
        self.assertEqual(status, 0)
        seen = json.load(open(record))
        self.assertEqual(seen['meBytes'], original)
        self.assertEqual(seen['pinBytes'], pin_text)

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

    def test_the_provider_is_started_only_after_the_binding_id_and_with_exactly_that_id(self):
        status, result, platform = self.chain()
        self.assertEqual(status, 0)
        self.assertEqual(platform.session.launches, ['5f6e7d8c-0000-4000-a000-00000000000b'])
        self.assertEqual([p for p in platform.session.named], ['host', 'provider'])  # the host first, the provider only from launch
        self.assertIsNone(result['diagnostic'])

    def test_no_host_spawn_line_means_nothing_is_launched(self):
        for mode in ('spawn_extra_key', 'spawn_bad_id', 'spawn_v1_id', 'spawn_no_version', 'spawn_v2', 'spawn_int_id', 'refuse_before_spawn', 'host_refused', 'ended_weird'):
            status, result, platform = self.chain(host=mode)
            self.assertEqual((status, result['failureClass']), (78, 'host_spawn'), mode)
            self.assertEqual(platform.session.launches, [], mode)
            self.assertNotIn('provider', platform.session.named, mode)
            os.remove(os.path.join(self.out, 'result.json'))
            shutil.rmtree(self.state)
            os.mkdir(self.state)

    def test_a_silent_host_before_the_spawn_line_times_out_without_a_launch(self):
        status, result, platform = self.chain(host='no_spawn')
        self.assertEqual((status, result['failureClass'], platform.session.launches), (78, 'host_spawn', []))
        self.assertEqual(result['diagnostic'], {'kind': 'timeout', 'detail': None})

    def test_a_second_host_spawn_line_fails_the_first_dispatch(self):
        status, result, platform = self.chain(host='second_spawn')
        self.assertEqual((status, result['failureClass']), (78, 'dispatch1'))
        self.assertEqual(result['diagnostic'], {'kind': 'protocol', 'detail': 'second_host_spawn'})
        self.assertEqual(len(platform.session.launches), 1)

    def test_a_failed_launch_is_the_class_launch_with_its_fixed_reason_and_starts_no_provider(self):
        class Failing(FakePlatform):
            def open_session(self, staged):
                super().open_session(staged)
                self.session.launch_error = session.SessionError('host config mismatch')
                return self.session
        status, result, platform = self.go(platform=Failing(self.state))
        self.assertEqual((status, result['failureClass']), (78, 'launch'))
        self.assertEqual(result['diagnostic'], {'kind': 'exception', 'detail': 'SessionError:host config mismatch'})
        self.assertNotIn('provider', platform.session.named)

    def test_a_failure_names_its_cause_from_a_closed_vocabulary_and_never_carries_role_text(self):
        cases = {
            'refuse_before_spawn': ('host_spawn', {'kind': 'refused', 'detail': 'failed:config'}),
            'ended_weird': ('host_spawn', {'kind': 'refused', 'detail': 'other'}),
            'host_refused': ('host_spawn', {'kind': 'host_refused', 'detail': 'metadata'}),
            'host_refused_weird': ('host_spawn', {'kind': 'host_refused', 'detail': 'other'}),
            'spawn_int_id': ('host_spawn', {'kind': 'protocol', 'detail': 'host_spawn_shape'}),
            'spawn_v2': ('host_spawn', {'kind': 'protocol', 'detail': 'host_spawn_shape'}),
            'spawn_bad_id': ('host_spawn', {'kind': 'protocol', 'detail': 'host_spawn_shape'}),
            'exit': ('host_spawn', {'kind': 'closed', 'detail': 'exit:3'}),
            'dispatch1_refused': ('dispatch1', {'kind': 'refused', 'detail': 'none'}),
        }
        for mode, (failure_class, diagnostic) in cases.items():
            status, result, _ = self.chain(host=mode)
            self.assertEqual((result['failureClass'], result['diagnostic']), (failure_class, diagnostic), mode)
            self.assertNotIn('secret', json.dumps(result))
            os.remove(os.path.join(self.out, 'result.json'))
            shutil.rmtree(self.state)
            os.mkdir(self.state)

    def test_an_unexpected_exception_is_recorded_by_class_name_only(self):
        class Boom(FakePlatform):
            def open_session(self, staged):
                raise KeyError('/secret/path with spaces')
        status, result, _ = self.go(platform=Boom(self.state))
        self.assertEqual(result['diagnostic'], {'kind': 'exception', 'detail': 'KeyError'})
        self.assertNotIn('secret', json.dumps(result))

    def test_a_revocation_that_leaks_still_fails_the_verdict_and_records_no_diagnostic(self):
        status, result, _ = self.chain(host='revoke_leaks')
        self.assertIsNone(result['diagnostic'])

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
        host, provider = platform.session.named['host'], platform.session.named['provider']
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
        self.assertEqual((status, result['failureClass']), (78, 'host_spawn'))
        self.assertEqual(result['diagnostic'], {'kind': 'refused', 'detail': 'command:order'})

    def test_a_role_that_exits_or_speaks_garbage_is_a_bounded_class(self):
        for mode in ('exit', 'garbage', 'huge', 'bad_kind'):
            status, result, platform = self.chain(host=mode)
            self.assertEqual((status, result['failureClass']), (78, 'host_spawn'), mode)
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
        self.assertEqual(result['failureClass'], 'host_spawn')  # it never got as far as finish
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
        self.write_pin(self.pin_with_hashes())

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
        staged = run.RealPlatform(parent=self.dir).stage_packet(self.packet, self.pin_with_hashes())
        mode = lambda n: oct(os.lstat(os.path.join(staged.root, n)).st_mode & 0o777)
        self.assertEqual((mode('artifacts/runtimeEntry'), mode('artifacts/runtimeEntry.metafile.json'), mode('receipt.json'), mode('environment/libc.so'), mode('bun/bun')), ('0o555', '0o400', '0o400', '0o555', '0o555'))
        self.assertEqual(os.readlink(os.path.join(staged.root, 'alias')), 'receipt.json')
        self.assertEqual(oct(os.stat(staged.root).st_mode & 0o777), '0o700')
        self.assertEqual((staged.pin, staged.inventory), (self.pin_with_hashes(), {'x': {'sha256': 'a' * 64}}))

    def test_stage_packet_refuses_escapes_and_special_members(self):
        for members in ([('../x', 'file', b'')], [('/abs', 'file', b'')], [('a', 'link', '../../etc/passwd')], [('a', 'link', '/etc/passwd')], [('a\\b', 'file', b'')]):
            self.tarball(members)
            with self.assertRaises(ValueError):
                run.RealPlatform(parent=self.dir).stage_packet(self.packet, self.pin_with_hashes())

    def test_stage_packet_reads_the_archive_and_the_inventory_through_the_pin_hashes(self):
        self.tarball([('receipt.json', 'file', b'{}')])
        pin = self.pin_with_hashes()
        for name, key in (('guided-packet.tar.gz', 'archive'), ('packet-inventory.json', 'inventory')):
            wrong = {**pin, key: {'sha256': '0' * 64}}
            with self.assertRaises(ValueError, msg=name + ' digest'):
                run.RealPlatform(parent=self.dir).stage_packet(self.packet, wrong)
        # a file rewritten after the pin was recorded is refused, not staged
        path = os.path.join(self.packet, 'packet-inventory.json')
        open(path, 'a').write(' ')
        with self.assertRaises(ValueError):
            run.RealPlatform(parent=self.dir).stage_packet(self.packet, pin)
        self.tarball([('receipt.json', 'file', b'{}')])
        pin = self.pin_with_hashes()
        archive = os.path.join(self.packet, 'guided-packet.tar.gz')
        os.link(archive, archive + '.again')
        with self.assertRaises(ValueError, msg='a hard-linked archive'):
            run.RealPlatform(parent=self.dir).stage_packet(self.packet, pin)
        os.unlink(archive + '.again')
        os.rename(archive, archive + '.real')
        os.symlink(archive + '.real', archive)
        with self.assertRaises(OSError, msg='a symlinked archive'):
            run.RealPlatform(parent=self.dir).stage_packet(self.packet, pin)

    def test_the_staged_bytes_are_the_bytes_that_were_hashed_even_if_the_file_changes_after(self):
        self.tarball([('receipt.json', 'file', b'{}')])
        pin = self.pin_with_hashes()
        platform = run.RealPlatform(parent=self.dir)
        real = run.read_pinned
        def swap_after_hashing(path, digest, limit=run.MAX_SMALL):
            data = real(path, digest, limit)
            if path.endswith('guided-packet.tar.gz'):
                open(path, 'wb').write(b'not the archive any more')
            return data
        with mock.patch.object(run, 'read_pinned', swap_after_hashing):
            staged = platform.stage_packet(self.packet, pin)
        self.assertEqual(open(os.path.join(staged.root, 'receipt.json'), 'rb').read(), b'{}')

    def staged_members(self, members):
        self.tarball(members)
        return run.RealPlatform(parent=self.dir).stage_packet(self.packet, self.pin_with_hashes())

    def test_a_link_chain_that_is_lexically_inside_and_really_outside_is_refused(self):
        # `a -> .` then `b -> a/..`: each name passes the lexical test, and b really resolves to the parent of the staging root.
        with self.assertRaises(ValueError):
            self.staged_members([('a', 'link', '.'), ('b', 'link', 'a/..')])
        with self.assertRaises(ValueError):
            self.staged_members([('d/a', 'link', '.'), ('d/b', 'link', 'a/../..'), ('e', 'file', b'')])
        with self.assertRaises(ValueError):
            self.staged_members([('a', 'link', '.'), ('b', 'link', 'a/a/a/../../../..')])

    def staging_dirs(self):
        return sorted(name for name in os.listdir(self.dir) if name.startswith('winter-guided-hosted-'))

    def test_a_bad_link_is_refused_where_it_is_met_and_nothing_after_it_is_extracted(self):
        with self.assertRaises(ValueError):
            self.staged_members([('a', 'link', '.'), ('b', 'link', 'a/..'), ('after.txt', 'file', b'x')])
        root = os.path.join(self.dir, self.staging_dirs()[-1])
        self.assertEqual(sorted(os.listdir(root)), ['a'])

    def test_a_link_that_only_becomes_an_escape_when_a_later_link_arrives_is_refused_at_the_end(self):
        # f -> g/.. is inside while g does not exist; g -> . then makes it the parent of the staging root. Each link passes when it is met.
        with self.assertRaises(ValueError):
            self.staged_members([('f', 'link', 'g/..'), ('g', 'link', '.')])

    def test_a_path_that_merely_starts_with_the_staging_root_name_is_outside(self):
        root_name = os.path.join(self.dir, 'stage-root')
        sibling = root_name + 'evil'
        os.mkdir(sibling)
        self.tarball([('a', 'link', '.'), ('b', 'link', 'a/../stage-rootevil')])
        with mock.patch.object(run.tempfile, 'mkdtemp', lambda prefix, dir: (os.mkdir(root_name), root_name)[1]):
            with self.assertRaises(ValueError):
                run.RealPlatform(parent=self.dir).stage_packet(self.packet, self.pin_with_hashes())

    def test_an_oversize_archive_is_refused(self):
        self.tarball([('receipt.json', 'file', b'x' * 5000)])
        platform = run.RealPlatform(parent=self.dir)
        self.assertGreater(os.path.getsize(os.path.join(self.packet, 'guided-packet.tar.gz')), 100)
        with mock.patch.object(run.RealPlatform, 'ARCHIVE_LIMIT', 100):
            with self.assertRaises(ValueError):
                platform.stage_packet(self.packet, self.pin_with_hashes())
        self.assertEqual(platform.stage_packet(self.packet, self.pin_with_hashes()).pin['archive']['sha256'], self.pin_with_hashes()['archive']['sha256'])

    def test_a_private_copy_never_replaces_an_existing_file(self):
        directory = os.path.join(self.dir, 'copies')
        os.mkdir(directory)
        run.private_copy(directory, 'x.py', b'one')
        with self.assertRaises(FileExistsError):
            run.private_copy(directory, 'x.py', b'two')
        self.assertEqual(open(os.path.join(directory, 'x.py'), 'rb').read(), b'one')

    def test_a_link_to_a_link_that_stays_inside_is_allowed_and_a_link_through_a_link_to_outside_is_not(self):
        staged = self.staged_members([('real.txt', 'file', b'x'), ('one', 'link', 'real.txt'), ('two', 'link', 'one'), ('sub/three', 'link', '../two')])
        self.assertEqual(os.path.realpath(os.path.join(staged.root, 'sub/three')), os.path.realpath(os.path.join(staged.root, 'real.txt')))
        with self.assertRaises(ValueError):
            self.staged_members([('up', 'link', 'sub/..'), ('sub/x', 'file', b''), ('out', 'link', 'up/..')])

    def test_no_member_is_ever_written_through_a_link(self):
        outside = os.path.join(self.dir, 'outside')
        os.mkdir(outside)
        with self.assertRaises(ValueError):
            self.staged_members([('d', 'link', '.'), ('d/file', 'file', b'x')])
        with self.assertRaises(ValueError):
            self.staged_members([('lnk', 'link', 'sub'), ('lnk/file', 'file', b'x')])
        self.assertEqual(os.listdir(outside), [])

    def test_a_link_that_is_outside_only_once_the_tree_is_complete_is_refused_at_the_end(self):
        # a dangling forward link whose target later becomes a link to the parent
        with self.assertRaises(ValueError):
            self.staged_members([('f', 'link', 'g/h'), ('g', 'link', '..')])


class Adapter(unittest.TestCase):
    def roles(self, **modes):
        state = tempfile.mkdtemp(prefix='guided-adapter-')
        self.addCleanup(shutil.rmtree, state, True)
        procs = [subprocess.Popen([sys.executable, '-I', '-B', FAKE, name, state, modes.get(name, '')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) for name in ('provider', 'host')]
        self.addCleanup(lambda: [(p.kill(), p.wait()) for p in procs])
        return roles_adapter.GuidedRoles(procs[0], procs[1], timeout=1.0)

    def first_dispatch(self, roles):
        roles.begin_dispatch(1)
        return roles.finish_dispatch(1)

    def test_counters_come_only_from_the_provider_receipt(self):
        roles = self.roles()
        roles.await_provider_ready()
        self.assertEqual(roles.stub_receipt('first'), {key: 0 for key in roles_adapter.COUNTERS})
        self.assertEqual(self.first_dispatch(roles), 'first deterministic answer')
        self.assertEqual(roles.stub_receipt('second')['receivedBegins'], 1)

    def test_the_provider_summary_is_the_final_figure(self):
        roles = self.roles()
        roles.await_provider_ready()
        self.first_dispatch(roles)
        self.assertEqual(roles.stop()['acceptedBegins'], 1)

    def test_host_commands_and_results(self):
        roles = self.roles()
        roles.await_provider_ready()
        self.first_dispatch(roles)
        roles.dispatch(2)
        self.assertEqual(roles.present_spent(), 'required_context_unavailable')
        roles.premint()
        roles.revoke()
        self.assertEqual(roles.present_premint(), 'required_context_unavailable')
        roles.finish_send()
        self.assertIs(roles.finish_result(), True)

    def test_attaching_a_second_provider_is_refused(self):
        roles = self.roles()
        with self.assertRaises(roles_adapter.AdapterError) as raised:
            roles.attach_provider(object())
        self.assertEqual((raised.exception.kind, raised.exception.detail), ('protocol', 'second_provider'))

    def test_a_host_result_before_finish_is_its_own_kind(self):
        roles = self.roles(host='early_result')
        self.assertEqual(roles.begin_dispatch(1), '5f6e7d8c-0000-4000-a000-00000000000b')
        with self.assertRaises(roles_adapter.AdapterError) as raised:
            roles.finish_dispatch(1)
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
        self.pin = os.path.join(REAL_RUNTIME, 'compile-39327386044.pin.json')
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

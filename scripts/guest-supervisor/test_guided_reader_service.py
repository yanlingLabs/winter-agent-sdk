"""Root's guided reader service: portable, injected-process, differential and (Linux root, CI only) native tests.

The service is Root's end of the fifth descriptor of a guided runtime. Nothing here starts a real VM, provider, Bun or network; the portable
classes inject the process, selector clock and sockets, the differential class runs the TypeScript source of truth under bun, and
LinuxNativeTests (skipped unless Linux root; REQUIRED, never skipped, where WINTER_REQUIRE_NATIVE_READER=1) runs the unchanged reader
launcher with a tiny static stand-in for the loader. A passing test is DATA about Root's service, never an admission of a native owner.
"""
import contextlib
import hashlib
import json
import os
import random
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_fresh_protocol as fresh  # noqa: E402
import test_guided_host_query as guided  # noqa: E402

service = fresh.service
ROOT = Path(__file__).resolve().parents[2]
GUEST = ROOT / 'packages/runtime/src/guest'
DRIVER = Path(__file__).with_name('guided_reader_differential.ts')
BOOT = guided.BOOT
REGISTRATION_ID = guided.REGISTRATION
REQUIREMENT = guided.REQUIREMENT
LETTERED = 'abcdef01-0000-4000-8000-0000000000ab'
UUIDS = ['%08x-0000-4000-8000-%012x' % (n, n) for n in range(1, 400)]
REQUIRE_DIFFERENTIAL = os.environ.get('WINTER_REQUIRE_READER_DIFFERENTIAL') == '1'
REQUIRE_NATIVE = os.environ.get('WINTER_REQUIRE_NATIVE_READER') == '1'


def registration(generation=7, policy='ask'):
    item = guided.pure_item(policy)
    config = service.guided_host_query_config(item, ['read'], 'model', REQUIREMENT)
    return service.guided_reader_registration(item, config, BOOT, REGISTRATION_ID, generation)


def sorted_registration(value):
    """The registration as the guest receives it: Root's record is serialised with sort_keys, so nested keys arrive sorted."""
    return json.loads(service.canonical(value))


def guest_frame(value):
    """What the guest's channel writes: the 4-byte length and JSON.stringify of the object, in the object's own key order."""
    body = service.wire_json(value).encode()
    return struct.pack('!I', len(body)) + body


def start_message(reg, read_id, context_id, binding=None):
    owner = sorted_registration(reg)['owner']
    return {'version': 1, 'kind': 'reader_start', 'registrationId': reg['registrationId'], 'owner': owner, 'readId': read_id,
            'contextRequestId': context_id, 'bindingId': binding or reg['requiredRuntimeContext']['bindingId']}


def cancel_message(reg, read_id):
    return {'version': 1, 'kind': 'reader_cancel', 'registrationId': reg['registrationId'], 'readId': read_id, 'owner': sorted_registration(reg)['owner']}


def inner_frame(reg, read_id, **override):
    owner = reg['owner']
    value = {'version': 1, 'readId': read_id, 'owner': {key: owner[key] for key in ('logicalSessionId', 'backendSessionId', 'generation', 'bootId', 'incarnationId', 'leaseEpoch')},
             'views': dict(reg['views']), 'limits': dict(reg['limits']),
             'snapshot': {'blocks': [], 'digest': 'x', 'droppedImports': [], 'files': [], 'provenance': [], 'skippedLinks': [], 'text': 'café   \U0001F600', 'tiers': []}}
    value.update(override)
    return service.wire_json(value) + '\n'


def evidence(outcome='ok', frame=None, **over):
    base = {'launched': True, 'outcome': outcome, 'frame': frame, 'namespaceInitReaped': True, 'monitorReaped': True, 'namespaceWaitStatus': 0, 'monitorWaitStatus': 0,
            'stdoutEof': True, 'stderrEof': True, 'captureDrained': True}
    base.update(over)
    return base


# ------------------------------------------------------------------------------------------------------------------------------
class CodecTests(unittest.TestCase):
    def test_wire_json_is_compact_literal_utf8_and_refuses_non_json_numbers(self):
        self.assertEqual(service.wire_json({'a': [1, True, None, 'café   \U0001F600'], 'b': {}}), '{"a":[1,true,null,"café   \U0001F600"],"b":{}}')
        for bad in (float('nan'), float('inf'), {'x': float('-inf')}):
            with self.assertRaises(ValueError):
                service.wire_json(bad)

    def test_frames_are_four_byte_big_endian_length_then_body_and_bounded(self):
        frame = service.reader_wire_frame({'a': 1})
        self.assertEqual(frame, b'\x00\x00\x00\x07{"a":1}')
        self.assertEqual(len(service.reader_wire_frame({'a': 'x' * (service.GUIDED_READER_BODY_BYTES - 8)})), service.GUIDED_READER_BODY_BYTES + 4)
        with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame'):
            service.reader_wire_frame({'a': 'x' * service.GUIDED_READER_BODY_BYTES})
        with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame'):
            service.reader_wire_frame({'a': '\ud800'})

    def test_decoder_reassembles_split_and_coalesced_frames(self):
        decoder = service.ReaderFrameDecoder()
        first, second = guest_frame({'a': 1}), guest_frame({'b': [2]})
        stream = first + second
        out = []
        for index in range(len(stream)):
            out.extend(decoder.feed(stream[index:index + 1]))
        self.assertEqual(out, [b'{"a":1}', b'{"b":[2]}'])
        self.assertEqual(service.ReaderFrameDecoder().feed(stream), [b'{"a":1}', b'{"b":[2]}'])
        self.assertEqual(service.ReaderFrameDecoder().feed(first[:3]), [])
        self.assertEqual(len(decoder.buffer), 0)

    def test_decoder_refuses_empty_and_oversize_bodies_from_the_header_alone(self):
        for header in (struct.pack('!I', 0), struct.pack('!I', service.GUIDED_READER_REQUEST_BYTES + 1), struct.pack('!I', 0xFFFFFFFF)):
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame'):
                service.ReaderFrameDecoder().feed(header)
        decoder = service.ReaderFrameDecoder()
        self.assertEqual(decoder.feed(struct.pack('!I', service.GUIDED_READER_REQUEST_BYTES)), [])

    def test_the_stdin_request_is_the_registration_minus_workspace_id_in_canonical_form(self):
        reg = registration()
        body = service.reader_invocation(reg, UUIDS[0])
        value = json.loads(body)
        self.assertEqual(sorted(value), ['limits', 'owner', 'readId', 'version', 'views'])
        # Key set of RuntimeSDK's InstructionReaderInvocation; the cross-repo pin is runtime-sdk-reader-request.pin.json.
        self.assertEqual(sorted(value['owner']), sorted(['logicalSessionId', 'backendSessionId', 'generation', 'bootId', 'incarnationId', 'leaseEpoch']))
        self.assertNotIn('workspaceId', value['owner'])
        self.assertEqual(value['views'], reg['views'])
        self.assertEqual(value['limits'], reg['limits'])
        self.assertEqual(body.decode(), service.wire_json(value))
        self.assertLessEqual(len(body), service.GUIDED_READER_INPUT_BYTES)
        self.assertNotIn(b'\n', body)

    def test_the_stdin_request_is_capped_at_16_kib(self):
        reg = registration()
        reg['views'] = dict(reg['views'], sourceRoot='/workspace/folders/' + 'x' * 6000, sourceCwd='/workspace/folders/' + 'y' * 6000, sharedPath='/' + 'z' * 6000)
        with self.assertRaisesRegex(service.Refusal, 'guided_reader_input'):
            service.reader_invocation(reg, UUIDS[0])

    def test_argv_is_the_exact_launch_envelope(self):
        argv = service.reader_argv(9, 10, '/run/winter/instruction-reader-views/v', 11, 20002, 10000, 12, '/workspace/folders/s', '/workspace/folders/s', 13, [(14, '/lib/a'), (15, '/usr/lib/b')])
        self.assertEqual(argv, ['9', 'instruction-reader-v1', '10', '/run/winter/instruction-reader-views/v', '11', '20002', '10000', '12', '/workspace/folders/s', '/workspace/folders/s',
                                '13', '2', '14', '/lib/a', '15', '/usr/lib/b'])
        self.assertEqual(len(argv), 12 + 2 * 2)

    def test_dependency_paths_follow_the_launcher_grammar(self):
        for good in ('/lib/x', '/lib64/ld-linux-x86-64.so.2', '/usr/lib/aarch64-linux-gnu/libc.so.6'):
            self.assertTrue(service.reader_dependency_path(good), good)
        for bad in ('', '/', '/lib', '/lib/', '/etc/x', '/lib/a b', '/lib/a\n', '/lib//x', '/lib/./x', '/lib/../x', '/lib/é', '/lib/' + 'a' * 1020, None, 5, '/usr/lib64/x', 'lib/x'):
            self.assertFalse(service.reader_dependency_path(bad), repr(bad))


# ------------------------------------------------------------------------------------------------------------------------------
class RequestParserTests(unittest.TestCase):
    def setUp(self):
        self.reg = registration()
        self.read, self.context = UUIDS[0], UUIDS[1]

    def body(self, value):
        return service.wire_json(value).encode()

    def good_start(self):
        return start_message(self.reg, self.read, self.context)

    def test_valid_start_and_cancel_are_accepted(self):
        self.assertEqual(service.reader_request(self.body(self.good_start()), self.reg), ('start', self.read, self.context))
        self.assertEqual(service.reader_request(self.body(cancel_message(self.reg, self.read)), self.reg), ('cancel', self.read, None))

    def test_owner_key_order_follows_the_guest_but_values_are_roots(self):
        message = self.good_start()
        message['owner'] = {key: message['owner'][key] for key in service.GUIDED_OWNER_KEYS}
        self.assertEqual(service.reader_request(self.body(message), self.reg)[0], 'start')
        for key in service.GUIDED_OWNER_KEYS:
            for value in (None, True, 0, 1.5, 'other', [], {}):
                changed = self.good_start()
                changed['owner'] = dict(changed['owner'], **{key: value})
                if changed['owner'][key] == self.reg['owner'][key] and type(changed['owner'][key]) is type(self.reg['owner'][key]):
                    continue
                with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame', msg=(key, value)):
                    service.reader_request(self.body(changed), self.reg)
        for mutate in (lambda o: o.pop('bootId'), lambda o: o.update(extra=1), lambda o: o.clear()):
            changed = self.good_start()
            mutate(changed['owner'])
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame'):
                service.reader_request(self.body(changed), self.reg)

    def test_every_top_level_field_is_pinned(self):
        for message_for in (lambda: self.good_start(), lambda: cancel_message(self.reg, self.read)):
            base = message_for()
            for key in list(base):
                missing = dict(base)
                del missing[key]
                with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame', msg=('missing', key)):
                    service.reader_request(self.body(missing), self.reg)
                for value in (None, True, False, 0, 2, 1.0, '', 'x', [], {}, self.read.upper()):
                    if key != 'owner' and value == base[key] and type(value) is type(base[key]):
                        continue
                    changed = dict(base, **{key: value})
                    with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame', msg=('value', key, value)):
                        service.reader_request(self.body(changed), self.reg)
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame'):
                service.reader_request(self.body(dict(base, extra=1)), self.reg)

    def test_ids_must_be_lowercase_uuid_v4_and_distinct(self):
        for bad in ('x', LETTERED.upper(), UUIDS[0] + '\n', '00000001-0000-1000-8000-000000000001', '00000001-0000-4000-c000-000000000001', ''):
            with self.assertRaises(service.Refusal, msg=bad):
                service.reader_request(self.body(start_message(self.reg, bad, self.context)), self.reg)
            with self.assertRaises(service.Refusal, msg=bad):
                service.reader_request(self.body(start_message(self.reg, self.read, bad)), self.reg)
            with self.assertRaises(service.Refusal, msg=bad):
                service.reader_request(self.body(cancel_message(self.reg, bad)), self.reg)
        with self.assertRaises(service.Refusal):
            service.reader_request(self.body(start_message(self.reg, self.read, self.read)), self.reg)
        with self.assertRaises(service.Refusal):
            service.reader_request(self.body(start_message(self.reg, self.read, self.context, binding=UUIDS[5])), self.reg)

    def test_only_the_exact_encoder_bytes_are_accepted(self):
        text = service.wire_json(self.good_start())
        variants = {
            'space after colon': text.replace('":', '": ', 1), 'newline': text + '\n', 'leading space': ' ' + text, 'bom': '﻿' + text,
            'escaped letter': text.replace('reader_start', 'reader_\\u0073tart'), 'duplicate key': text[:-1] + ',"readId":"' + self.read + '"}',
            'reordered': service.wire_json({k: self.good_start()[k] for k in reversed(list(self.good_start()))}),
            'float version': text.replace('"version":1', '"version":1.0'), 'exponent version': text.replace('"version":1', '"version":1e0'),
            'negative zero epoch': text.replace('"leaseEpoch":1', '"leaseEpoch":-0'), 'array': '[' + text + ']', 'null': 'null', 'number': '1', 'string': '"x"',
            'nan': text.replace('"version":1', '"version":NaN'), 'infinity': text.replace('"version":1', '"version":Infinity'), 'empty': '', 'truncated': text[:-1],
            'trailing junk': text + 'x', 'deep': '[' * 5000 + ']' * 5000,
        }
        for name, variant in variants.items():
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame', msg=name):
                service.reader_request(variant.encode(), self.reg)
        for name, raw in (('invalid utf8', b'{"a":"\xff"}'), ('lone continuation', b'\x80'), ('overlong', b'\xc0\xaf')):
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame', msg=name):
                service.reader_request(raw, self.reg)

    def test_unknown_kinds_and_other_registrations_are_refused(self):
        for kind in ('reader_result', 'reader_terminal', 'reader_start ', 'READER_START', '', None, 5, ['reader_start'], {'a': 1}):
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_frame', msg=kind):
                service.reader_request(self.body(dict(self.good_start(), kind=kind)), self.reg)
        other = registration()
        other['registrationId'] = UUIDS[9]
        with self.assertRaises(service.Refusal):
            service.reader_request(self.body(self.good_start()), other)


# ------------------------------------------------------------------------------------------------------------------------------
class OutboundMirrorTests(unittest.TestCase):
    """check_reader_message is the Python mirror of decodeLinuxGuidedReaderFrame; the differential class compares it to the real one."""

    def setUp(self):
        self.reg = registration()
        self.read = UUIDS[0]

    def result(self, **override):
        return service.reader_wire_frame(service.reader_result_message(self.reg, self.read, inner_frame(self.reg, self.read, **override)))

    def terminal(self, outcome='ok', namespace=0, monitor=0):
        return service.reader_wire_frame(service.reader_terminal_message(self.reg, self.read, outcome, namespace, monitor))

    def test_what_root_builds_is_accepted(self):
        self.assertEqual(service.check_reader_message(self.result(), self.reg, self.read)['kind'], 'reader_result')
        for outcome in ('ok', 'unavailable', 'cancelled'):
            for status in (0, 9, 256, 65535):
                self.assertEqual(service.check_reader_message(self.terminal(outcome, status, status), self.reg, self.read)['outcome'], outcome)

    def test_frames_for_another_read_registration_or_owner_are_refused(self):
        with self.assertRaises(service.Refusal):
            service.check_reader_message(self.result(), self.reg, UUIDS[2])
        with self.assertRaises(service.Refusal):
            service.check_reader_message(self.result(), self.reg, 'not-a-uuid')
        other = registration(generation=8)
        with self.assertRaises(service.Refusal):
            service.check_reader_message(self.result(), other, self.read)

    def test_statuses_and_flags_are_closed(self):
        for bad in (-1, 65536, 1.5, True, None, '0'):
            with self.assertRaises(service.Refusal, msg=bad):
                service.check_reader_message(service.reader_wire_frame(dict(service.reader_terminal_message(self.reg, self.read, 'ok', 0, 0), namespaceWaitStatus=bad)), self.reg, self.read)
        for flag in service.GUIDED_TERMINAL_FLAGS:
            for bad in (False, 1, None, 'true'):
                with self.assertRaises(service.Refusal, msg=(flag, bad)):
                    service.check_reader_message(service.reader_wire_frame(dict(service.reader_terminal_message(self.reg, self.read, 'ok', 0, 0), **{flag: bad})), self.reg, self.read)
        with self.assertRaises(service.Refusal):
            service.check_reader_message(self.terminal('weird'), self.reg, self.read)

    def test_inner_frame_must_echo_the_registration(self):
        for override in ({'readId': UUIDS[3]}, {'version': 2}, {'views': dict(self.reg['views'], sourceCwd='/workspace/folders/other')},
                         {'limits': dict(self.reg['limits'], maxFileBytes=1)}, {'owner': dict(inner_owner(self.reg), generation=99)},
                         {'owner': dict(inner_owner(self.reg), workspaceId='workspace')}, {'snapshot': {}}, {'snapshot': 5}):
            with self.assertRaises(service.Refusal, msg=override):
                service.check_reader_message(self.result(**override), self.reg, self.read)

    def test_inner_frame_text_rules(self):
        base = inner_frame(self.reg, self.read)
        for name, frame in (('no newline', base[:-1]), ('two lines', base[:-1] + '\n\n'), ('embedded newline', base[:5] + '\n' + base[5:]), ('space', base.replace('":', '": ', 1)),
                            ('not json', 'x\n'), ('array', '[]\n'), ('oversize', inner_frame(self.reg, self.read, snapshot={'blocks': [], 'digest': 'x', 'droppedImports': [], 'files': [], 'provenance': [], 'skippedLinks': [],
                                                                                                                              'text': 'x' * service.GUIDED_READER_FRAME_BYTES, 'tiers': []}))):
            message = service.reader_result_message(self.reg, self.read, frame)
            with self.assertRaises(service.Refusal, msg=name):
                service.check_reader_message(service.reader_wire_frame(message), self.reg, self.read)

    def test_length_prefix_and_text_rules_of_the_outer_frame(self):
        good = self.terminal()
        for name, raw in (('short', good[:4]), ('extra byte', good + b' '), ('length too small', struct.pack('!I', len(good) - 5) + good[4:]), ('bom', struct.pack('!I', len(good)) + b'\xef\xbb\xbf' + good[4:]),
                          ('invalid utf8', struct.pack('!I', 3) + b'\xff\xfe\xfd'), ('huge', struct.pack('!I', service.GUIDED_READER_BODY_BYTES + 1) + b'x' * (service.GUIDED_READER_BODY_BYTES + 1))):
            with self.assertRaises(service.Refusal, msg=name):
                service.check_reader_message(raw, self.reg, self.read)


def inner_owner(reg):
    return {key: reg['owner'][key] for key in ('logicalSessionId', 'backendSessionId', 'generation', 'bootId', 'incarnationId', 'leaseEpoch')}


# ------------------------------------------------------------------------------------------------------------------------------
def roundtrips(text):
    try:
        _, value = service._wire_parse(text.encode())
        return service.wire_json(value) == text
    except (ValueError, service.Refusal):
        return False


STRICTER_THAN_TYPESCRIPT = ('roundtrip tiny float', 'decode inner number 1.5e+300', 'decode inner number 9007199254740994', 'decode inner number 10000000000000000', 'decode inner number 1e+21')


class DifferentialTests(unittest.TestCase):
    """Python against linux-guided-reader-protocol.ts, the source of truth, over the same frames: valid and invalid, both directions."""
    results = None
    cases = []
    labels = []

    @classmethod
    def setUpClass(cls):
        bun = shutil.which('bun')
        if bun is None:
            if REQUIRE_DIFFERENTIAL:
                raise AssertionError('bun is required here (WINTER_REQUIRE_READER_DIFFERENTIAL=1) and was not found')
            raise unittest.SkipTest('bun is not installed')
        cls.reg = registration()
        cls.sorted = json.dumps(sorted_registration(cls.reg), separators=(',', ':'))
        declared = dict(cls.reg, owner={key: cls.reg['owner'][key] for key in service.GUIDED_OWNER_KEYS})
        cls.declared = json.dumps(sorted_registration(declared), separators=(',', ':'))
        # Re-serialise the declared-order registration WITHOUT sorting so the TS side really sees the SDK's own owner order.
        cls.declared = json.dumps(declared, separators=(',', ':'))
        cls.cases, cls.labels, cls.expect = [], [], []
        cls.build_cases()
        payload = json.dumps({'registrations': [cls.sorted, cls.declared], 'cases': cls.cases})
        run = subprocess.run([bun, str(DRIVER)], input=payload, capture_output=True, text=True, timeout=300, cwd=str(ROOT / 'packages/runtime'))
        if run.returncode:
            raise AssertionError('differential driver failed: ' + run.stderr[-2000:])
        cls.results = json.loads(run.stdout)
        if len(cls.results) != len(cls.cases):
            raise AssertionError('driver answered %d of %d cases' % (len(cls.results), len(cls.cases)))

    @classmethod
    def add(cls, label, case, python):
        cls.labels.append(label)
        cls.cases.append(case)
        cls.expect.append(python)

    @classmethod
    def build_cases(cls):
        reg = cls.reg
        rng = random.Random(20261018)
        # ---- Root -> guest: the guest's decoder is the oracle for every frame Root could send.
        read = UUIDS[0]
        bases = {
            'result': service.reader_result_message(reg, read, inner_frame(reg, read)),
            'terminal-ok': service.reader_terminal_message(reg, read, 'ok', 0, 0),
            'terminal-unavailable': service.reader_terminal_message(reg, read, 'unavailable', 9, 35072),
            'terminal-cancelled': service.reader_terminal_message(reg, read, 'cancelled', 0, 0),
        }
        frames = []
        for name, message in bases.items():
            frames.append((name, service.reader_wire_frame(message)))
        def decode(label, frame, read_id=read, registration_index=0):
            def python():
                try:
                    service.check_reader_message(frame, reg, read_id)
                    return True
                except service.Refusal:
                    return False
            cls.add('decode ' + label, {'op': 'decode', 'hex': bytes(frame).hex(), 'readId': read_id, 'registration': registration_index}, python)
        for name, frame in frames:
            decode(name, frame)
            decode(name + ' (declared-order registration)', frame, registration_index=1)
            decode(name + ' wrong readId', frame, read_id=UUIDS[1])
            decode(name + ' truncated', frame[:-1])
            decode(name + ' extra byte', frame + b'\n')
            decode(name + ' length-1', struct.pack('!I', len(frame) - 5) + frame[4:])
            decode(name + ' length+1', struct.pack('!I', len(frame) - 3) + frame[4:])
            decode(name + ' bom', struct.pack('!I', len(frame) - 4 + 3) + b'\xef\xbb\xbf' + frame[4:])
            decode(name + ' invalid utf8', frame[:-3] + b'\xff' + frame[-2:])
        def mutated(name, message):
            # Structural mutations of one message, each serialised the way the driver and decoder compare them.
            paths = [()]
            def walk(node, path):
                if isinstance(node, dict):
                    for key, value in node.items():
                        paths.append(path + (key,))
                        walk(value, path + (key,))
            walk(message, ())
            for path in paths[1:]:
                def clone():
                    return json.loads(json.dumps(message))
                def at(root):
                    node = root
                    for step in path[:-1]:
                        node = node[step]
                    return node
                removed = clone()
                del at(removed)[path[-1]]
                decode('%s drop %s' % (name, '.'.join(path)), service.reader_wire_frame(removed))
                added = clone()
                at(added)[path[-1] + 'X'] = 1
                decode('%s add beside %s' % (name, '.'.join(path)), service.reader_wire_frame(added))
                for value in (None, True, False, 0, 1, 2, -1, 65535, 65536, 1.5, '', 'x', [], {}, 'ok', 'cancelled', UUIDS[2], '0' * 36):
                    changed = clone()
                    if at(changed)[path[-1]] == value and type(at(changed)[path[-1]]) is type(value):
                        continue
                    at(changed)[path[-1]] = value
                    try:
                        decode('%s set %s=%r' % (name, '.'.join(path), value), service.reader_wire_frame(changed))
                    except service.Refusal:
                        pass
            keys = list(message)
            reordered = {key: message[key] for key in reversed(keys)}
            decode(name + ' reversed key order', service.reader_wire_frame(reordered))
            text = service.wire_json(message)
            for label, replaced in (('space after colon', text.replace('":', '": ', 1)), ('space after comma', text.replace(',', ', ', 1)), ('float 1.0', text.replace(':1,', ':1.0,', 1)),
                                    ('exponent', text.replace(':1,', ':1e0,', 1)), ('unicode escape', text.replace('"kind"', '"k\\u0069nd"', 1)), ('trailing newline', text + '\n'),
                                    ('duplicate version', text[:-1] + ',"version":1}'), ('negative zero', text.replace(':0', ':-0', 1)), ('large int', text.replace(':0', ':100000000000000000000', 1))):
                body = replaced.encode()
                decode('%s text %s' % (name, label), struct.pack('!I', len(body)) + body)
        for name, message in bases.items():
            mutated(name, message)
        # Inner-frame mutations (the reader's own line inside a result).
        inner = json.loads(inner_frame(reg, read))
        for label, change in (('wrong readId', {'readId': UUIDS[4]}), ('version 2', {'version': 2}), ('no snapshot', {'snapshot': None}), ('limits', {'limits': dict(reg['limits'], maxReadBytes=1)}),
                              ('views', {'views': dict(reg['views'], sharedPath='/x')}), ('owner workspace', {'owner': dict(inner['owner'], workspaceId='workspace')}),
                              ('owner generation', {'owner': dict(inner['owner'], generation=2)}), ('extra key', {'extra': 1}), ('snapshot key', {'snapshot': dict(inner['snapshot'], extra=1)}),
                              ('snapshot missing', {'snapshot': {k: v for k, v in inner['snapshot'].items() if k != 'text'}})):
            value = dict(inner, **{k: v for k, v in change.items() if v is not None})
            if change.get('snapshot', 1) is None:
                del value['snapshot']
            frame = service.wire_json(value) + '\n'
            try:
                decode('inner ' + label, service.reader_wire_frame(service.reader_result_message(reg, read, frame)))
            except service.Refusal:
                pass
        for label, frame in (('no newline', inner_frame(reg, read)[:-1]), ('double newline', inner_frame(reg, read) + '\n'), ('leading space', ' ' + inner_frame(reg, read)),
                             ('space inside', inner_frame(reg, read).replace('":', '": ', 1)), ('escaped', inner_frame(reg, read).replace('"version"', '"v\\u0065rsion"')),
                             ('big text', inner_frame(reg, read, snapshot=dict(inner['snapshot'], text='x' * (service.GUIDED_READER_FRAME_BYTES - 700)))),
                             ('too big text', inner_frame(reg, read, snapshot=dict(inner['snapshot'], text='x' * service.GUIDED_READER_FRAME_BYTES))),
                             ('astral', inner_frame(reg, read, snapshot=dict(inner['snapshot'], text='\U0001F600  \x7f\x1fé')))):
            try:
                decode('inner text ' + label, service.reader_wire_frame(service.reader_result_message(reg, read, frame)))
            except service.Refusal:
                pass
        for number in (0, 1, -1, 0.5, -2.5, 0.1, 123.456, 0.0001, 0.00001, 1e-7, 100000, 1.5e300, 12345678.9, 2 ** 53, 2 ** 53 + 2, 10 ** 16, 10 ** 21, 1e21, 2.0, -0.0):
            try:
                decode('inner number %r' % (number,), service.reader_wire_frame(service.reader_result_message(reg, read, inner_frame(reg, read, snapshot=dict(inner['snapshot'], blocks=[number])))))
            except service.Refusal:
                pass
        # ---- guest -> Root: TS builds the frames; Python must accept the very bytes, and agree with the TS oracle on mutants.
        for index in range(60):
            read_id, context_id = UUIDS[(index * 2) % 300], UUIDS[(index * 2 + 1) % 300]
            for registration_index in (0, 1):
                cls.add_build('build_start', reg, read_id, context_id, registration_index)
                cls.add_build('build_cancel', reg, read_id, None, registration_index)
        def request(label, body, registration_index=0):
            def python():
                try:
                    service.reader_request(body, reg)
                    return True
                except service.Refusal:
                    return False
            cls.add('request ' + label, {'op': 'request', 'hex': bytes(body).hex(), 'registration': registration_index}, python)
        start = start_message(reg, UUIDS[0], UUIDS[1])
        cancel = cancel_message(reg, UUIDS[0])
        for name, base in (('start', start), ('cancel', cancel)):
            request(name, service.wire_json(base).encode())
            for key in list(base):
                dropped = {k: v for k, v in base.items() if k != key}
                request('%s drop %s' % (name, key), service.wire_json(dropped).encode())
                request('%s extra after %s' % (name, key), service.wire_json(dict(base, **{key + 'X': 1})).encode())
                for value in (None, True, 0, 1, 2, 1.0, '', 'x', [], {}, UUIDS[7], UUIDS[0].upper(), UUIDS[0] + ' ', 'reader_cancel', 'reader_start'):
                    if base[key] == value and type(base[key]) is type(value):
                        continue
                    request('%s set %s=%r' % (name, key, value), service.wire_json(dict(base, **{key: value})).encode())
            for key in list(base['owner']):
                request('%s owner drop %s' % (name, key), service.wire_json(dict(base, owner={k: v for k, v in base['owner'].items() if k != key})).encode())
                for value in (None, True, 0, 2, 1.0, '', 'x', UUIDS[0]):
                    if base['owner'][key] == value and type(base['owner'][key]) is type(value):
                        continue
                    request('%s owner %s=%r' % (name, key, value), service.wire_json(dict(base, owner=dict(base['owner'], **{key: value}))).encode())
            request(name + ' owner declared order', service.wire_json(dict(base, owner={k: reg['owner'][k] for k in service.GUIDED_OWNER_KEYS})).encode())
            request(name + ' owner reversed order', service.wire_json(dict(base, owner={k: base['owner'][k] for k in reversed(list(base['owner']))})).encode())
            request(name + ' top reversed', service.wire_json({k: base[k] for k in reversed(list(base))}).encode())
            text = service.wire_json(base)
            for label, replaced in (('space', text.replace('":', '": ', 1)), ('newline', text + '\n'), ('bom', '﻿' + text), ('float', text.replace('"version":1', '"version":1.0')),
                                    ('exponent', text.replace('"version":1', '"version":1e0')), ('escape', text.replace('"kind"', '"k\\u0069nd"')), ('dup', text[:-1] + ',"kind":"x"}'),
                                    ('array', '[' + text + ']'), ('null', 'null'), ('empty', ''), ('big epoch', text.replace('"leaseEpoch":1', '"leaseEpoch":1e400')),
                                    ('nan', text.replace('"leaseEpoch":1', '"leaseEpoch":NaN'))):
                request('%s text %s' % (name, label), replaced.encode())
            request(name + ' bad utf8', text.encode()[:-3] + b'\xff' + text.encode()[-2:])
        # ---- the stdin request's canonical-JSON rule (RuntimeSDK compares JSON.stringify(JSON.parse(text)) with text).
        for index in range(20):
            body = service.reader_invocation(reg, UUIDS[index]).decode()
            cls.add('roundtrip invocation %d' % index, {'op': 'roundtrip', 'text': body}, lambda body=body: json.loads(body) is not None and service.wire_json(json.loads(body)) == body)
        for label, text in (('space', '{"a": 1}'), ('half', '{"a":0.5}'), ('tenth', '{"a":0.1}'), ('long float', '{"a":123.456}'), ('small float', '{"a":0.0001}'), ('tiny float', '{"a":0.00001}'), ('big float', '{"a":1234567890123456.7}'),
                            ('huge float', '{"a":12345678901234567.5}'), ('neg float', '{"a":-2.5}'), ('neg zero float', '{"a":-0.0}'), ('exp', '{"a":1e5}'), ('big int', '{"a":9007199254740991}'), ('unsafe int', '{"a":9007199254740993}'),
                            ('2^53', '{"a":9007199254740992}'), ('neg int', '{"a":-5}'), ('nan', '{"a":NaN}'), ('escape', '{"a":"\\u0061"}'), ('float', '{"a":1.0}'), ('unicode', '{"a":"café \U0001F600"}'), ('control', '{"a":"\\u0001\\n\\t"}'), ('dup', '{"a":1,"a":2}')):
            cls.add('roundtrip ' + label, {'op': 'roundtrip', 'text': text}, lambda text=text: roundtrips(text))

    @classmethod
    def add_build(cls, op, reg, read_id, context_id, registration_index):
        def python():
            body_hex = DifferentialTests.results[DifferentialTests.cases.index(case)]['hex']
            try:
                service.reader_request(bytes.fromhex(body_hex)[4:], reg)
                return True
            except service.Refusal:
                return False
        case = {'op': op, 'readId': read_id, 'registration': registration_index}
        if context_id is not None:
            case.update(contextRequestId=context_id, bindingId=reg['requiredRuntimeContext']['bindingId'])
        cls.add('%s %s %s' % (op, read_id, registration_index), case, python)

    def test_every_case_agrees(self):
        disagreements, unsound = [], []
        for label, case, python, result in zip(self.labels, self.cases, self.expect, self.results):
            if case['op'] in ('build_start', 'build_cancel'):
                continue
            if bool(python()) != bool(result['ok']):
                disagreements.append((label, python(), result['ok']))
            if python() and not result['ok']:
                unsound.append(label)
        # Soundness is absolute: Root never accepts or sends what the TypeScript decides to refuse.
        self.assertEqual(unsound, [])
        # Exactness holds everywhere except where Root is DELIBERATELY stricter: a decimal JavaScript prints in plain notation but Python's
        # repr spells with an exponent (1e-5) is refused rather than re-implementing JavaScript's number printer.
        self.assertEqual([item for item in disagreements if item[0] not in STRICTER_THAN_TYPESCRIPT], [])
        self.assertEqual(sorted(item[0] for item in disagreements), sorted(STRICTER_THAN_TYPESCRIPT))

    def test_every_frame_the_guest_builds_is_accepted_by_root(self):
        built = [(label, result) for label, case, result in zip(self.labels, self.cases, self.results) if case['op'] in ('build_start', 'build_cancel')]
        self.assertEqual(len(built), 240)
        for label, result in built:
            self.assertTrue(result['ok'], label)
            body = bytes.fromhex(result['hex'])
            self.assertEqual(struct.unpack('!I', body[:4])[0], len(body) - 4)
            kind, read_id, context = service.reader_request(body[4:], self.reg)
            self.assertIn(kind, ('start', 'cancel'))

    def test_coverage_is_not_vacuous(self):
        count = lambda op, ok: sum(1 for case, result in zip(self.cases, self.results) if case['op'] == op and bool(result['ok']) is ok)
        # Both verdicts on both sides of each direction, in volume.
        self.assertGreaterEqual(count('decode', True), 8)
        self.assertGreaterEqual(count('decode', False), 600)
        self.assertGreaterEqual(count('request', True), 4)
        self.assertGreaterEqual(count('request', False), 250)
        self.assertGreaterEqual(count('roundtrip', True), 20)
        self.assertGreaterEqual(count('roundtrip', False), 3)
        self.assertEqual(count('build_start', True) + count('build_cancel', True), 240)
        type(self).summary = {op: (count(op, True), count(op, False)) for op in ('decode', 'request', 'roundtrip')}


# ------------------------------------------------------------------------------------------------------------------------------
class GuestEnd:
    """A test standing in for the guest's channel on the other end of the stream."""

    def __init__(self, reg):
        self.reg = reg
        self.service_end, self.guest = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        self.guest.settimeout(5)
        self.buffer = b''

    def send(self, message):
        self.guest.sendall(guest_frame(message))

    def send_raw(self, raw):
        self.guest.sendall(raw)

    def frame(self):
        while True:
            if len(self.buffer) >= 4:
                size = struct.unpack('!I', self.buffer[:4])[0]
                if len(self.buffer) >= 4 + size:
                    body, self.buffer = self.buffer[4:4 + size], self.buffer[4 + size:]
                    return json.loads(body)
            chunk = self.guest.recv(65536)
            if not chunk:
                raise EOFError
            self.buffer += chunk

    def nothing_within(self, seconds=.3):
        self.guest.settimeout(seconds)
        try:
            return self.guest.recv(1) == b''
        except (socket.timeout, BlockingIOError):
            return None
        finally:
            self.guest.settimeout(5)

    def close(self):
        for end in (self.service_end, self.guest):
            end.close()


class FakeLaunch:
    """The injected launcher: records calls, runs serially or not, blocks on a gate, and returns the configured evidence."""

    def __init__(self, reg):
        self.reg = reg
        self.calls, self.gates, self.script = [], {}, {}
        self.active = self.max_active = 0
        self.lock = threading.Lock()
        self.started = threading.Event()

    def __call__(self, read_id, request, cancel):
        with self.lock:
            self.calls.append((read_id, request, cancel))
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        self.started.set()
        try:
            gate = self.gates.get(read_id)
            if gate is not None:
                while not gate.is_set() and not cancel.is_set():
                    time.sleep(.01)
            action = self.script.get(read_id)
            if callable(action):
                return action(cancel)
            if action is not None:
                return action
            if cancel.is_set():
                return evidence('cancelled', namespaceWaitStatus=9, monitorWaitStatus=35072)
            return evidence('ok', frame=inner_frame(self.reg, read_id))
        finally:
            with self.lock:
                self.active -= 1


class ServiceFixture(unittest.TestCase):
    def setUp(self):
        self.reg = registration()
        self.guest = GuestEnd(self.reg)
        self.launch = FakeLaunch(self.reg)
        self.halt = threading.Event()
        self.owner_read, self.owner_write = os.pipe()
        self.service = service.GuidedReaderService(registration=self.reg, stream=self.guest.service_end, owner_pidfd=self.owner_read, halt=self.halt, launch=self.launch)

    def tearDown(self):
        self.halt.set()
        self.service.stop()
        for fd in (self.owner_read, self.owner_write):
            with contextlib.suppress(OSError):
                os.close(fd)
        self.guest.close()

    def start(self):
        self.service.start()

    def begin(self, index):
        self.guest.send(start_message(self.reg, UUIDS[2 * index], UUIDS[2 * index + 1]))

    def wait_until(self, predicate, seconds=5):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(.01)
        return predicate()


class ServiceProtocolTests(ServiceFixture):
    def test_a_read_is_launched_with_the_canonical_request_and_answered_with_result_then_terminal(self):
        self.start()
        self.begin(0)
        result, terminal = self.guest.frame(), self.guest.frame()
        self.assertEqual((result['kind'], terminal['kind']), ('reader_result', 'reader_terminal'))
        self.assertEqual(terminal['outcome'], 'ok')
        self.assertEqual(result['readId'], UUIDS[0])
        read_id, request, _ = self.launch.calls[0]
        self.assertEqual((read_id, request), (UUIDS[0], service.reader_invocation(self.reg, UUIDS[0])))
        # What Root sent is exactly what the guest's decoder takes (the differential class proves that against TypeScript).
        service.check_reader_message(guest_frame(result)[4:].join([b'', b'']) and service.reader_wire_frame(result), self.reg, UUIDS[0])
        self.assertTrue(self.wait_until(lambda: self.service.observations()['ok'] == 1))
        self.assertEqual(self.service.observations()['outstanding'], 0)

    def test_the_stream_is_never_shut_down_or_closed_by_the_service(self):
        self.start()
        self.begin(0)
        self.guest.frame(), self.guest.frame()
        self.service.stop()
        self.assertNotEqual(self.guest.service_end.fileno(), -1, 'closing Root\'s end would make the native owner report the owner lost')
        self.assertIsNone(self.guest.nothing_within(), 'no EOF may reach the guest from the service')

    def test_handoff_is_exclusive_and_single_use(self):
        self.start()
        with self.assertRaisesRegex(service.Refusal, 'guided_reader_claimed'):
            self.service.start()
        self.service.stop()
        with self.assertRaisesRegex(service.Refusal, 'guided_reader_claimed'):
            self.service.start()
        other = service.GuidedReaderService(registration=self.reg, stream=self.guest.service_end, owner_pidfd=None, halt=self.halt, launch=self.launch)
        self.assertTrue(other.stop())
        with self.assertRaisesRegex(service.Refusal, 'guided_reader_claimed'):
            other.start()

    def test_reads_are_launched_one_at_a_time_in_order(self):
        for index in range(4):
            self.launch.gates[UUIDS[2 * index]] = threading.Event()
        self.start()
        for index in range(4):
            self.begin(index)
        self.assertTrue(self.wait_until(lambda: self.launch.calls))
        time.sleep(.1)
        self.assertEqual([call[0] for call in self.launch.calls], [UUIDS[0]])
        for index in range(4):
            self.launch.gates[UUIDS[2 * index]].set()
        kinds = [self.guest.frame()['readId'] for _ in range(8)]
        self.assertEqual(kinds, [UUIDS[0], UUIDS[0], UUIDS[2], UUIDS[2], UUIDS[4], UUIDS[4], UUIDS[6], UUIDS[6]])
        self.assertEqual(self.launch.max_active, 1)

    def test_sixteen_outstanding_are_served_and_the_seventeenth_stops_the_service(self):
        for index in range(17):
            self.launch.gates[UUIDS[2 * index]] = threading.Event()
        hold = threading.Event()
        self.launch.script[UUIDS[0]] = lambda cancel: (hold.wait(10), evidence('cancelled'))[1]
        self.start()
        for index in range(16):
            self.begin(index)
        self.assertTrue(self.wait_until(lambda: self.service.observations()['outstanding'] == 16))
        self.assertEqual(self.service.observations()['state'], 'serving')
        self.begin(16)
        self.assertTrue(self.wait_until(lambda: self.service.observations()['state'] == 'failed'))
        self.assertEqual(self.service.observations()['failure'], 'guided_reader_bound')
        # The running read was told to cancel; the queued ones were dropped and never launched.
        self.assertTrue(self.wait_until(lambda: self.launch.calls[0][2].is_set()))
        self.assertEqual(len(self.launch.calls), 1)
        self.assertEqual(self.service.observations()['outstanding'], 1, 'the 15 queued reads were dropped; only the one still running remains')
        hold.set()

    def test_a_replayed_read_id_is_a_violation(self):
        self.start()
        self.begin(0)
        self.guest.frame(), self.guest.frame()
        self.begin(0)
        self.assertTrue(self.wait_until(lambda: self.service.observations()['failure'] == 'guided_reader_bound'))
        self.assertEqual(len(self.launch.calls), 1)

    def test_the_lifetime_read_id_ledger_fails_closed_at_4096(self):
        self.service.consumed.update(range(service.GUIDED_READER_CONSUMED))
        self.start()
        self.begin(0)
        self.assertTrue(self.wait_until(lambda: self.service.observations()['failure'] == 'guided_reader_bound'))
        self.assertEqual(self.launch.calls, [])

    def test_unknown_malformed_and_oversize_input_stops_serving_and_launches_nothing(self):
        for name, raw in (('unknown kind', guest_frame(dict(start_message(self.reg, UUIDS[0], UUIDS[1]), kind='reader_result'))), ('garbage', guest_frame({'x': 1})),
                          ('not json', struct.pack('!I', 3) + b'abc'), ('zero length', struct.pack('!I', 0)), ('oversize', struct.pack('!I', 4097)),
                          ('wrong registration', guest_frame(dict(start_message(self.reg, UUIDS[0], UUIDS[1]), registrationId=UUIDS[9]))),
                          ('wrong binding', guest_frame(start_message(self.reg, UUIDS[0], UUIDS[1], binding=UUIDS[9])))):
            with self.subTest(name):
                fixture = service.GuidedReaderService(registration=self.reg, stream=(pair := GuestEnd(self.reg)).service_end, owner_pidfd=None, halt=threading.Event(), launch=self.launch)
                fixture.start()
                pair.send_raw(raw)
                self.assertTrue(self.wait_until(lambda: fixture.observations()['state'] == 'failed'), name)
                self.assertEqual(fixture.observations()['failure'], 'guided_reader_frame', name)
                self.assertEqual(self.launch.calls, [], name)
                fixture.stop()
                pair.close()

    def test_a_cancel_for_a_queued_read_answers_cancelled_without_launching_it(self):
        self.launch.gates[UUIDS[0]] = threading.Event()
        self.start()
        self.begin(0)
        self.begin(1)
        self.assertTrue(self.wait_until(lambda: self.launch.calls))
        self.guest.send(cancel_message(self.reg, UUIDS[2]))
        terminal = self.guest.frame()
        self.assertEqual((terminal['kind'], terminal['readId'], terminal['outcome']), ('reader_terminal', UUIDS[2], 'cancelled'))
        # Nothing was launched for it, so its receipt is vacuous: zero statuses, and the call list proves it.
        self.assertEqual((terminal['namespaceWaitStatus'], terminal['monitorWaitStatus']), (0, 0))
        self.launch.gates[UUIDS[0]].set()
        self.guest.frame(), self.guest.frame()
        self.assertEqual([call[0] for call in self.launch.calls], [UUIDS[0]])

    def test_a_cancel_for_a_running_read_reaches_the_launcher_and_ends_cancelled_without_a_result(self):
        self.launch.gates[UUIDS[0]] = threading.Event()
        self.start()
        self.begin(0)
        self.assertTrue(self.wait_until(lambda: self.launch.calls))
        self.guest.send(cancel_message(self.reg, UUIDS[0]))
        terminal = self.guest.frame()
        self.assertEqual((terminal['kind'], terminal['outcome'], terminal['namespaceWaitStatus']), ('reader_terminal', 'cancelled', 9))
        self.assertTrue(self.launch.calls[0][2].is_set())

    def test_a_cancel_that_crossed_its_own_terminal_is_ignored_but_an_unknown_one_is_a_violation(self):
        self.start()
        self.begin(0)
        self.guest.frame(), self.guest.frame()
        self.guest.send(cancel_message(self.reg, UUIDS[0]))
        self.assertTrue(self.wait_until(lambda: self.service.observations()['ignoredCancels'] == 1))
        self.assertEqual(self.service.observations()['state'], 'serving')
        self.guest.send(cancel_message(self.reg, UUIDS[40]))
        self.assertTrue(self.wait_until(lambda: self.service.observations()['failure'] == 'guided_reader_unknown'))

    def test_a_cancel_flag_wins_even_if_the_reader_finished(self):
        gate = threading.Event()
        self.launch.script[UUIDS[0]] = lambda cancel: (gate.wait(5), evidence('ok', frame=inner_frame(self.reg, UUIDS[0])))[1]
        self.start()
        self.begin(0)
        self.assertTrue(self.wait_until(lambda: self.launch.calls))
        self.guest.send(cancel_message(self.reg, UUIDS[0]))
        self.assertTrue(self.wait_until(lambda: self.launch.calls[0][2].is_set()))
        gate.set()
        terminal = self.guest.frame()
        self.assertEqual((terminal['kind'], terminal['outcome']), ('reader_terminal', 'cancelled'))

    def test_a_reader_frame_that_does_not_echo_the_registration_becomes_unavailable_with_no_result(self):
        self.launch.script[UUIDS[0]] = evidence('ok', frame=inner_frame(self.reg, UUIDS[0], version=2))
        self.start()
        self.begin(0)
        terminal = self.guest.frame()
        self.assertEqual((terminal['kind'], terminal['outcome']), ('reader_terminal', 'unavailable'))
        self.assertIsNone(self.guest.nothing_within())

    def test_unavailable_and_unknown_outcomes_never_carry_a_result(self):
        self.launch.script[UUIDS[0]] = evidence('unavailable', frame=inner_frame(self.reg, UUIDS[0]), namespaceWaitStatus=9, monitorWaitStatus=35072)
        self.launch.script[UUIDS[2]] = evidence('mystery', frame=inner_frame(self.reg, UUIDS[2]))
        self.start()
        self.begin(0)
        self.begin(1)
        first, second = self.guest.frame(), self.guest.frame()
        self.assertEqual((first['outcome'], first['namespaceWaitStatus'], first['monitorWaitStatus']), ('unavailable', 9, 35072))
        self.assertEqual((second['readId'], second['outcome']), (UUIDS[2], 'unavailable'))

    def test_missing_or_partial_evidence_is_retained_debt_and_sends_no_receipt(self):
        cases = {'namespace not reaped': {'namespaceInitReaped': False}, 'monitor not reaped': {'monitorReaped': False}, 'stdout not at eof': {'stdoutEof': False},
                 'stderr not at eof': {'stderrEof': False}, 'capture not drained': {'captureDrained': False}, 'no namespace status': {'namespaceWaitStatus': None},
                 'no monitor status': {'monitorWaitStatus': None}, 'status out of range': {'namespaceWaitStatus': 65536}, 'status is bool': {'monitorWaitStatus': True},
                 'truthy flag': {'stdoutEof': 1}}
        for name, override in cases.items():
            with self.subTest(name):
                pair = GuestEnd(self.reg)
                launch = FakeLaunch(self.reg)
                launch.script[UUIDS[0]] = evidence('ok', frame=inner_frame(self.reg, UUIDS[0]), **override)
                fixture = service.GuidedReaderService(registration=self.reg, stream=pair.service_end, owner_pidfd=None, halt=threading.Event(), launch=launch)
                fixture.start()
                pair.send(start_message(self.reg, UUIDS[0], UUIDS[1]))
                self.assertTrue(self.wait_until(lambda: fixture.debt), name)
                self.assertIsNone(pair.nothing_within(), name)
                self.assertEqual(fixture.observations()['failure'], 'reader_evidence_missing')
                self.assertFalse(fixture.stop())
                pair.close()

    def test_a_launcher_that_raises_is_unknown_state_and_therefore_debt(self):
        def boom(cancel):
            raise OSError('exec')
        self.launch.script[UUIDS[0]] = boom
        self.start()
        self.begin(0)
        self.assertTrue(self.wait_until(lambda: self.service.debt))
        self.assertFalse(self.service.stop())
        self.assertEqual(self.service.observations()['uncertainReads'], 1)

    def test_the_runtime_pidfd_ending_stops_the_service_before_the_next_launch(self):
        self.launch.gates[UUIDS[0]] = threading.Event()
        self.start()
        self.begin(0)
        self.begin(1)
        self.assertTrue(self.wait_until(lambda: self.launch.calls))
        os.close(self.owner_write)
        self.assertTrue(self.wait_until(lambda: self.service.observations()['failure'] == 'owner_ended'))
        self.assertTrue(self.wait_until(lambda: self.launch.calls[0][2].is_set()))
        self.launch.gates[UUIDS[0]].set()
        self.assertTrue(self.service.stop())
        self.assertEqual([call[0] for call in self.launch.calls], [UUIDS[0]])

    def test_revocation_or_shutdown_stops_the_service_and_cancels_the_running_read(self):
        self.launch.gates[UUIDS[0]] = threading.Event()
        self.start()
        self.begin(0)
        self.assertTrue(self.wait_until(lambda: self.launch.calls))
        self.halt.set()
        self.assertTrue(self.wait_until(lambda: self.launch.calls[0][2].is_set()))
        self.assertEqual(self.wait_until(lambda: self.service.observations()['state'] == 'failed'), True)
        self.assertTrue(self.service.stop())

    def test_a_read_taken_from_the_queue_after_a_halt_is_not_launched(self):
        # The window between taking a read and launching it: the worker re-checks the halt itself, whatever the serving thread has noticed.
        self.halt.set()
        read = {'readId': UUIDS[0], 'contextRequestId': UUIDS[1], 'state': 'running', 'cancel': threading.Event()}
        self.service.state = 'serving'
        self.service._run_one(read)
        self.assertEqual(self.launch.calls, [])
        self.assertEqual(self.service.observations()['failure'], 'owner_ended')

    def test_the_service_refuses_to_send_what_the_guest_would_refuse(self):
        self.start()
        good = service.reader_terminal_message(self.reg, UUIDS[0], 'ok', 0, 0)
        for bad in (dict(good, namespaceWaitStatus=70000), dict(good, readId=UUIDS[1], owner=dict(good['owner'], generation=99)), dict(good, outcome='weird'), dict(good, namespaceInitReaped=False)):
            with self.assertRaises(service.Refusal):
                self.service._send(bad)
        self.assertIsNone(self.guest.nothing_within(), 'nothing may have been written')

    def test_a_halted_service_launches_nothing_new(self):
        self.halt.set()
        self.start()
        self.begin(0)
        self.assertTrue(self.wait_until(lambda: self.service.observations()['state'] == 'failed'))
        self.assertEqual(self.launch.calls, [])

    def test_guest_eof_ends_service(self):
        self.start()
        self.guest.guest.shutdown(socket.SHUT_WR)
        self.assertTrue(self.wait_until(lambda: self.service.observations()['failure'] == 'stream_closed'))

    def test_stop_before_start_is_clean_and_stop_is_idempotent(self):
        self.assertTrue(self.service.stop())
        self.assertTrue(self.service.stop())
        self.assertEqual(self.service.observations()['state'], 'closed')

    def test_stop_waits_for_a_running_read_to_report_and_then_has_no_debt(self):
        self.launch.gates[UUIDS[0]] = threading.Event()
        self.start()
        self.begin(0)
        self.assertTrue(self.wait_until(lambda: self.launch.calls))
        self.assertTrue(self.service.stop())
        self.assertFalse(self.service.debt)
        self.assertTrue(all(not thread.is_alive() for thread in self.service.threads))

    def test_a_worker_that_will_not_finish_is_debt_after_the_deadline(self):
        release = threading.Event()
        self.launch.script[UUIDS[0]] = lambda cancel: (release.wait(10), evidence('cancelled'))[1]
        times = iter([0, 0, 0, 0, 0, 100, 100, 100, 100])
        patched = service.GuidedReaderService(registration=self.reg, stream=self.guest.service_end, owner_pidfd=None, halt=self.halt, launch=self.launch, clock=lambda: next(times, 100))
        patched.start()
        self.guest.send(start_message(self.reg, UUIDS[0], UUIDS[1]))
        self.assertTrue(self.wait_until(lambda: self.launch.calls))
        self.assertFalse(patched.stop())
        self.assertIn('worker', patched.uncertain)
        release.set()
        self.service.stop()

    def test_a_failed_send_stops_the_service_without_claiming_debt(self):
        self.start()
        self.guest.guest.close()
        self.guest.service_end.close()
        self.begin_raw = None
        fixture = self.service
        self.assertTrue(self.wait_until(lambda: fixture.observations()['state'] == 'failed'))
        self.assertFalse(fixture.debt)


class HighDescriptorTests(unittest.TestCase):
    """select.select raises ValueError for descriptors numbered 1024 or more; a busy Root must still serve."""

    def test_poll_readable_handles_descriptors_above_1024(self):
        read, write = os.pipe()
        high_read = os.dup2(read, 1500)
        try:
            self.assertEqual(service.poll_readable([high_read], 0), [])
            os.write(write, b'x')
            self.assertEqual(service.poll_readable([high_read], 0), [1500])
            with self.assertRaises(OSError):
                service.poll_readable([1999], 0)
        finally:
            for fd in (read, write, high_read):
                with contextlib.suppress(OSError):
                    os.close(fd)

    def test_an_idle_poll_waits_for_its_timeout_instead_of_spinning(self):
        read, write = os.pipe()
        try:
            started = time.monotonic()
            self.assertEqual(service.poll_readable([read], 0.05), [])
            self.assertGreaterEqual(time.monotonic() - started, 0.04, 'the timeout is seconds, converted to milliseconds, not truncated to a zero-wait poll')
            started = time.monotonic()
            service.poll_readable([read], 0)
            self.assertLess(time.monotonic() - started, 0.04)
        finally:
            os.close(read)
            os.close(write)

    def test_the_serve_loop_idles_in_a_nonzero_wait(self):
        reg = registration()
        pair = GuestEnd(reg)
        waits = []
        real = service.poll_readable

        def spy(fds, timeout):
            started = time.monotonic()
            result = real(fds, timeout)
            waits.append((timeout, time.monotonic() - started))
            return result
        running = service.GuidedReaderService(registration=reg, stream=pair.service_end, owner_pidfd=None, halt=threading.Event(), launch=FakeLaunch(reg))
        try:
            with patch.object(service, 'poll_readable', spy):
                running.start()
                time.sleep(.5)
            serve = [item for item in waits if item[0] > 0]
            self.assertTrue(serve and all(item[0] == .05 for item in serve))
            self.assertLess(len(waits), 40, 'an idle service must not spin (a zero wait would make thousands of calls)')
            self.assertTrue(any(elapsed >= .04 for _, elapsed in serve))
        finally:
            running.stop()
            pair.close()

    def test_the_service_serves_and_watches_the_owner_on_descriptors_above_1024(self):
        reg = registration()
        pair = GuestEnd(reg)
        stream = socket.socket(fileno=os.dup2(pair.service_end.fileno(), 1600))
        pair.service_end.close()
        owner_read, owner_write = os.pipe()
        high_owner = os.dup2(owner_read, 1700)
        launch = FakeLaunch(reg)
        running = service.GuidedReaderService(registration=reg, stream=stream, owner_pidfd=high_owner, halt=threading.Event(), launch=launch)
        try:
            self.assertGreaterEqual(stream.fileno(), 1024)
            running.start()
            pair.send(start_message(reg, UUIDS[0], UUIDS[1]))
            self.assertEqual((pair.frame()['kind'], pair.frame()['kind']), ('reader_result', 'reader_terminal'))
            self.assertEqual(running.observations()['state'], 'serving')
            os.close(owner_write)
            deadline = time.monotonic() + 5
            while running.observations()['failure'] is None and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(running.observations()['failure'], 'owner_ended')
        finally:
            running.stop()
            for fd in (owner_read, high_owner):
                with contextlib.suppress(OSError):
                    os.close(fd)
            stream.close()
            pair.close()


class RuntimeSdkPinTests(unittest.TestCase):
    """RuntimeSDK owns the reader's stdin request; Root only emits it. The pin records what was reviewed."""

    PIN = json.loads(Path(__file__).with_name('runtime-sdk-reader-request.pin.json').read_text())

    def test_the_pin_is_well_formed(self):
        self.assertEqual(self.PIN['repository'], 'yanlingLabs/winter-runtime-sdk')
        self.assertRegex(self.PIN['commit'], r'^[0-9a-f]{40}$')
        self.assertEqual(sorted(self.PIN['files']), ['src/guest/instruction-reader-transport.ts', 'src/guest/instruction-reader.ts'])
        for digest in self.PIN['files'].values():
            self.assertRegex(digest, r'^[0-9a-f]{64}$')
        self.assertEqual(self.PIN['inputBytes'], service.GUIDED_READER_INPUT_BYTES)

    def test_the_key_set_root_emits_is_the_pinned_one(self):
        reg = registration()
        value = json.loads(service.reader_invocation(reg, UUIDS[0]))
        self.assertEqual(list(value), self.PIN['requestKeys'])
        self.assertEqual(sorted(value['owner']), sorted(self.PIN['ownerKeys']))
        self.assertEqual(sorted(value['views']), sorted(self.PIN['viewsKeys']))
        self.assertEqual(sorted(value['limits']), sorted(self.PIN['limitsKeys']))
        self.assertEqual(value['limits'], service.GUIDED_READER_LIMITS)

    def test_a_local_runtime_sdk_checkout_still_matches_the_pin_when_one_is_given(self):
        checkout = os.environ.get('WINTER_RUNTIME_SDK_CHECKOUT')
        if not checkout:
            self.skipTest('set WINTER_RUNTIME_SDK_CHECKOUT to a runtime-sdk clone to verify the pinned blobs')
        for name, digest in self.PIN['files'].items():
            shown = subprocess.run(['git', '-C', checkout, 'show', f"{self.PIN['commit']}:{name}"], capture_output=True)
            self.assertEqual(shown.returncode, 0, shown.stderr)
            self.assertEqual(hashlib.sha256(shown.stdout).hexdigest(), digest, name)


class ServiceBoundaryTests(unittest.TestCase):
    def test_no_service_exists_for_v1_or_fresh_runs(self):
        source = (GUEST / 'linux-supervisor.py').read_text()
        start = source.index('    def _run_runtime(self,item,runtime):')
        body = source[start:source.index('    def close(self):', start)]
        # The only place a service is built, and it is guarded by the guided profile test that also makes the fifth descriptor.
        self.assertEqual(body.count('_guided_reader_service('), 1)
        self.assertIn("if guided:reader_service=self._guided_reader_service(item,runtime,reader_root,pidfd)", body)
        self.assertIn("guided=runtime.get('profile')==GUIDED_PROFILE", body)
        self.assertEqual(source.count('GuidedReaderService('), 1)
        self.assertEqual(source.count('ReaderLauncher('), 1)

    def test_the_service_builder_needs_the_reader_config_a_source_root_and_the_guidance_descriptor(self):
        obj = service.ToolService.__new__(service.ToolService)
        obj.retained_children = []
        reg = registration()
        runtime = {'readerRegistration': reg, 'cancel': threading.Event()}
        item = {'workspaceGid': 10000, 'roots': {'source': {'root': {'guestPath': reg['views']['sourceRoot']}, 'fd': 41}}, 'guidance': 42}
        stream = MagicMock()
        for reader, changed, expected in ((None, item, 'guided_reader_service'), ({'artifacts': {}, 'pins': {}, 'dependencies': [], 'uid': 30001}, dict(item, guidance=None), 'guided_reader_service'),
                                          ({'artifacts': {}, 'pins': {}, 'dependencies': [], 'uid': 30001}, dict(item, roots={}), 'guided_reader_service')):
            obj.reader = reader
            with self.assertRaisesRegex(service.Refusal, expected):
                obj._guided_reader_service(changed, runtime, stream, 7)
        obj.reader = {'artifacts': {'launcher': 1, 'executable': 2}, 'pins': {'launcher': 'a', 'executable': 'b'}, 'dependencies': [(3, '/lib/x', 'c')], 'uid': 30001}
        built = obj._guided_reader_service(item, runtime, stream, 7)
        self.assertIsInstance(built, service.GuidedReaderService)
        self.assertEqual((built.owner_pidfd, built.halt, built.registration), (7, runtime['cancel'], reg))
        launcher = built.launch.__self__
        self.assertEqual((launcher.source, launcher.guidance, launcher.uid, launcher.gid, launcher.source_path, launcher.source_cwd), (41, 42, 30001, 10000, reg['views']['sourceRoot'], reg['views']['sourceCwd']))
        self.assertIs(launcher.retained, obj.retained_children)
        self.assertIs(runtime['readerService'], built)
        with self.assertRaisesRegex(service.Refusal, 'guided_reader_claimed'):
            obj._guided_reader_service(item, runtime, stream, 7)

    def test_the_services_own_additions_open_no_network_and_use_only_unix_sockets(self):
        patch_text = (ROOT / 'docs/research/guided-reader-service-supervisor.patch').read_text()
        added = '\n'.join(line[1:] for line in patch_text.splitlines() if line.startswith('+') and not line.startswith('+++'))
        for token in ('AF_INET', 'AF_INET6', 'AF_VSOCK', 'AF_NETLINK', 'AF_PACKET', 'vsock', 'ioctl', 'connect(', 'bind(', 'listen(', 'accept(', 'sendto', 'recvfrom', 'setns', 'unshare',
                      'CLONE_NEW', 'SOCK_RAW', 'SOCK_DGRAM', 'getaddrinfo', 'urllib', 'http', 'ssl', 'create_connection', 'socket.socket('):
            self.assertNotIn(token, added, token)
        families = set(re.findall(r'socket\.socketpair\(([^)]*)\)', added))
        self.assertEqual(families, {'socket.AF_UNIX,socket.SOCK_SEQPACKET'}, 'the only socket the service creates is the launcher receipt pair')

    def test_the_tool_clients_reader_launcher_header_and_the_ts_protocol_are_byte_identical_to_main(self):
        pinned = {
            'linux-guided-reader-protocol.ts': None, 'linux-instruction-reader-compartment.c': '28aa279d6ecb560424fe24bf8ccc0893ffc61cfbb9ba6ba72d38c66b7b655893',
            'linux-compartment.h': 'e666d010aab902c84ae86d3eea1fca6baaf75a7d94f55d936e020b30584a7e6b', 'linux-session-admission.ts': '18e619c164dc49dd5eae3bf40873fadc6905eb5c8ef935a36f71206f2bf40ff3',
            'linux-runtime-compartment.c': 'fcb90dba8cf9552b9c10cde4012603ac9471b03f31a09bc408667257f65842fa', 'linux-session-owner.c': '95457d8f6ff256257b3b211e0201c64a4ed0b575aac6a9f933b3178b823b0d76',
            'linux-tool-compartment.c': '0e87774b7adbe4fe5f4d13adcb44ea2068425c7889e367f6368aff3f1efcfac8',
        }
        for name, digest in pinned.items():
            if digest is not None:
                self.assertEqual(hashlib.sha256((GUEST / name).read_bytes()).hexdigest(), digest, name)
        # The TS protocol is the source of truth and is never edited here: its blob is the one main carries.
        main_blob = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'origin/main:packages/runtime/src/guest/linux-guided-reader-protocol.ts'], capture_output=True, text=True)
        if main_blob.returncode == 0:
            here = subprocess.run(['git', '-C', str(ROOT), 'hash-object', str(GUEST / 'linux-guided-reader-protocol.ts')], capture_output=True, text=True)
            self.assertEqual(here.stdout.strip(), main_blob.stdout.strip())


class ReaderConfigTests(unittest.TestCase):
    """_open_reader: Root's trusted config alone names the reader's launcher, loader, dependency closure and identity."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        for name in ('launcher', 'executable'):
            (self.base / name).write_bytes(b'x')
        self.obj = service.ToolService.__new__(service.ToolService)
        self.obj.owned = []
        self.conversations = [{'runtimeUid': 20001, 'toolUid': 10001, 'workspaceGid': 10000}, {'runtimeUid': 20002, 'toolUid': 10002, 'workspaceGid': 10001}]
        self.pins = lambda: {'launcher': {'path': str(self.base / 'launcher'), 'sha256': '0' * 64}, 'executable': {'path': str(self.base / 'executable'), 'sha256': '1' * 64}}

    def tearDown(self):
        for fd in self.obj.owned:
            with contextlib.suppress(OSError):
                os.close(fd)
        self.temp.cleanup()

    def value(self, **over):
        value = {'artifacts': self.pins(), 'dependencies': [], 'uid': 30001}
        value.update(over)
        return value

    def open(self, value):
        with patch.object(service, 'pinned_artifact', side_effect=lambda pin: os.open(os.devnull, os.O_RDONLY | os.O_CLOEXEC)), patch.object(service, 'READER_VIEWS_ROOT', str(self.base / 'views')), \
                patch.object(service.Path, 'lstat', return_value=MagicMock(st_mode=stat.S_IFDIR | 0o755, st_uid=0)):
            return self.obj._open_reader(value, self.conversations)

    def test_a_good_config_opens_pinned_artifacts_and_dependencies(self):
        deps = [{'path': '/opt/a', 'sha256': '2' * 64, 'guestPath': '/lib/ld.so'}, {'path': '/opt/b', 'sha256': '3' * 64, 'guestPath': '/usr/lib/libc.so.6'}]
        reader = self.open(self.value(dependencies=deps))
        self.assertEqual(sorted(reader), ['artifacts', 'dependencies', 'pins', 'uid'])
        self.assertEqual(reader['pins'], {'launcher': '0' * 64, 'executable': '1' * 64})
        self.assertEqual([(path, pin) for _, path, pin in reader['dependencies']], [('/lib/ld.so', '2' * 64), ('/usr/lib/libc.so.6', '3' * 64)])
        self.assertEqual(len(self.obj.owned), 4)
        self.assertTrue((self.base / 'views').is_dir())

    def test_closed_shapes_identity_and_dependency_rules(self):
        deps = lambda *paths: [{'path': '/opt/x', 'sha256': '2' * 64, 'guestPath': path} for path in paths]
        bad = [('not a dict', None, 'guided_reader_config'), ('extra key', self.value(extra=1), 'guided_reader_config'), ('missing uid', {k: v for k, v in self.value().items() if k != 'uid'}, 'guided_reader_config'),
               ('artifact set', self.value(artifacts={'launcher': self.pins()['launcher']}), 'guided_reader_config'),
               ('artifact not dict', self.value(artifacts={'launcher': 'x', 'executable': 'y'}), 'guided_reader_config'),
               ('deps not list', self.value(dependencies='x'), 'guided_reader_config'), ('33 deps', self.value(dependencies=deps(*['/lib/d%d' % n for n in range(33)])), 'guided_reader_config'),
               ('dep extra key', self.value(dependencies=[{'path': 'a', 'sha256': 'b', 'guestPath': '/lib/x', 'extra': 1}]), 'guided_reader_config'),
               ('dep path grammar', self.value(dependencies=deps('/etc/passwd')), 'guided_reader_config'), ('duplicate dep', self.value(dependencies=deps('/lib/x', '/lib/x')), 'guided_reader_config'),
               ('ancestor dep', self.value(dependencies=deps('/lib/x', '/lib/x/y')), 'guided_reader_config'), ('descendant dep', self.value(dependencies=deps('/lib/x/y', '/lib/x')), 'guided_reader_config')]
        for uid in (0, 999, 65536, True, '30001', None, 20001, 10001, 20002, 10002, 10000, 10001):
            bad.append(('uid %r' % (uid,), self.value(uid=uid), 'guided_reader_identity'))
        for name, value, code in bad:
            with self.subTest(name):
                self.obj.owned = []
                with self.assertRaisesRegex(service.Refusal, code):
                    self.open(value)
                self.assertEqual(self.obj.owned, [], 'a refused config must not leave descriptors behind')
        self.assertEqual(len(self.open(self.value(dependencies=deps(*['/lib/d%d' % n for n in range(32)])))['dependencies']), 32)

    def test_the_views_parent_must_be_root_owned_and_not_group_or_other_writable(self):
        for mode, uid in ((0o775, 0), (0o757, 0), (0o755, 1000)):
            with self.subTest(mode=mode, uid=uid):
                self.obj.owned = []
                with patch.object(service, 'pinned_artifact', side_effect=lambda pin: os.open(os.devnull, os.O_RDONLY)), patch.object(service, 'READER_VIEWS_ROOT', str(self.base / 'views')), \
                        patch.object(service.Path, 'lstat', return_value=MagicMock(st_mode=stat.S_IFDIR | mode, st_uid=uid)):
                    with self.assertRaisesRegex(service.Refusal, 'guided_reader_views'):
                        self.obj._open_reader(self.value(), self.conversations)
        with patch.object(service, 'READER_VIEWS_ROOT', str(self.base / 'views')), patch.object(service.Path, 'lstat', return_value=MagicMock(st_mode=stat.S_IFREG | 0o755, st_uid=0)):
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_views'):
                self.obj._reader_views_root()

    def test_a_guided_constructor_requires_the_reader_block_and_a_launch_for_every_runtime_conversation(self):
        source = (GUEST / 'linux-supervisor.py').read_text()
        self.assertIn("({'artifacts','reader'} if self.runtime_profile==GUIDED_PROFILE else {'artifacts'})", source)
        self.assertIn("if any(runtime_key in entry for entry in config['conversations']):self.reader=self._open_reader(config[runtime_key]['reader'],config['conversations'])", source)


# ------------------------------------------------------------------------------------------------------------------------------
class FakeChild:
    """A stand-in for Popen: real pipes for stdin/stdout/stderr, scripted wait and kill."""

    def __init__(self):
        self.stdin_read, stdin_write = os.pipe()
        stdout_read, self.stdout_write = os.pipe()
        stderr_read, self.stderr_write = os.pipe()
        self.stdin, self.stdout, self.stderr = os.fdopen(stdin_write, 'wb', buffering=0), os.fdopen(stdout_read, 'rb', buffering=0), os.fdopen(stderr_read, 'rb', buffering=0)
        self.exit_code, self.waits, self.killed = 0, [], 0
        self.wait_raises = False

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.wait_raises:
            raise subprocess.TimeoutExpired('child', timeout)
        return self.exit_code

    def kill(self):
        self.killed += 1

    def finish_output(self, stdout=b'', stderr=b''):
        os.write(self.stdout_write, stdout) if stdout else None
        os.close(self.stdout_write)
        os.write(self.stderr_write, stderr) if stderr else None
        os.close(self.stderr_write)

    def request(self):
        os.set_blocking(self.stdin_read, False)
        try:
            return os.read(self.stdin_read, 65536)
        except BlockingIOError:
            return b''
        finally:
            os.close(self.stdin_read)


class FakeClock:
    """The launcher reads its start time first and then only the value a test sets, so a test cannot move the start by moving the clock early."""

    def __init__(self):
        self.value, self.first = 0.0, True

    def __call__(self):
        if self.first:
            self.first = False
            return 0.0
        return self.value


class LauncherFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.views = Path(self.temp.name) / 'views'
        self.views.mkdir()
        self.reg = registration()
        self.cancel = threading.Event()
        self.killed_init = []
        self.pidfd_seen = threading.Event()
        self.pidfd_read, self.pidfd_write = os.pipe()
        self.child = FakeChild()
        self.spawned = []
        self.retained = []
        self.clock = FakeClock()
        self.patches = [patch.object(service, 'verify_held_artifact'), patch.object(service.os, 'chown', create=True)]
        real_pair = socket.socketpair
        try:
            real_pair(socket.AF_UNIX, socket.SOCK_SEQPACKET)[0].close()
            seqpacket = True
        except (OSError, AttributeError):
            seqpacket = False
        if not seqpacket:
            self.patches.append(patch.object(service.socket, 'socketpair', side_effect=lambda family=socket.AF_UNIX, kind=socket.SOCK_SEQPACKET: real_pair(socket.AF_UNIX, socket.SOCK_DGRAM)))
        self.verify = self.patches[0].start()
        for patcher in self.patches[1:]:
            patcher.start()
        self.launcher = service.ReaderLauncher(artifacts={'launcher': 5091, 'executable': 5092}, pins={'launcher': 'a' * 64, 'executable': 'b' * 64}, dependencies=[(5093, '/lib/ld.so', 'c' * 64)],
                                               uid=30001, gid=10000, source=5094, source_path=self.reg['views']['sourceRoot'], source_cwd=self.reg['views']['sourceCwd'], guidance=5095,
                                               views_root=str(self.views), retained=self.retained, spawn=self.spawn, clock=self.clock, kill_init=self.killed_init.append,
                                               pidfd_check=lambda fd: self.pidfd_seen.set(), root_uid=os.getuid())
        self.script = lambda control, child: None
        self.thread_errors = []

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()
        if getattr(self, 'control', None) is not None:
            with contextlib.suppress(OSError):
                self.control.close()
        for fd in (self.pidfd_read, self.pidfd_write):
            with contextlib.suppress(OSError):
                os.close(fd)
        for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
            with contextlib.suppress(OSError):
                stream.close()
        self.temp.cleanup()

    def spawn(self, argv, **options):
        self.spawned.append((argv, options))
        # The launcher's end of the receipt socket is the descriptor number in argv; keep a duplicate for the scripted launcher.
        self.control = socket.socket(fileno=os.dup(int(argv[4])))
        threading.Thread(target=self.run_script, daemon=True).start()
        return self.child

    def run_script(self):
        try:
            self.script(self.control, self.child)
        except Exception as error:  # surfaced by the test
            self.thread_errors.append(error)

    def hangup(self, control):
        # Closing a SEQPACKET end shows the peer a zero-length read. macOS has no AF_UNIX SEQPACKET, so the portable stand-in is a datagram pair where a
        # zero-length datagram is the same observation; on Linux the zero-length message and the close are both real.
        with contextlib.suppress(OSError):
            control.send(b'')
        control.close()

    def send_init(self, control, fd=None):
        fd = self.pidfd_write if fd is None else fd
        control.sendmsg([b'I'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, __import__('array').array('i', [fd]))])

    def send_receipt(self, control, status=0):
        control.send(b'R' + struct.pack('=I', status))

    def go(self, request=None):
        request = service.reader_invocation(self.reg, UUIDS[0]) if request is None else request
        return self.launcher.run(UUIDS[0], request, self.cancel)

    def happy(self, control, child, frame=None):
        self.send_init(control)
        self.send_receipt(control, 0)
        self.hangup(control)
        child.finish_output(stdout=(inner_frame(self.reg, UUIDS[0]) if frame is None else frame).encode())


class ReaderLauncherTests(LauncherFixture):
    def test_a_clean_run_reports_every_piece_of_evidence_and_removes_the_view(self):
        self.script = self.happy
        result = self.go()
        self.assertEqual(self.thread_errors, [])
        self.assertTrue(result['launched'])
        self.assertEqual(result['outcome'], 'ok')
        self.assertEqual(result['frame'], inner_frame(self.reg, UUIDS[0]))
        for key in service.GUIDED_TERMINAL_FLAGS:
            self.assertIs(result[key], True, key)
        self.assertEqual((result['namespaceWaitStatus'], result['monitorWaitStatus']), (0, 0))
        self.assertEqual(list(self.views.iterdir()), [], 'the per-read view directory is removed once the monitor is reaped')
        self.assertEqual(self.killed_init, [])

    def test_the_launch_envelope_descriptors_environment_and_request(self):
        seen = {}

        def script(control, child):
            seen['view'] = os.stat(self.spawned[0][0][3])
            seen['view_mode'] = stat.S_IMODE(seen['view'].st_mode)
            self.happy(control, child)
        self.script = script
        self.go()
        argv, options = self.spawned[0]
        view = f'{self.views}/{UUIDS[0]}'
        self.assertEqual(argv[:4], ['5091', 'instruction-reader-v1', '5092', view])
        self.assertEqual(argv[5:], ['30001', '10000', '5094', '/workspace/folders/source', '/workspace/folders/source', '5095', '1', '5093', '/lib/ld.so'])
        self.assertEqual(options['executable'], '/proc/self/fd/5091')
        self.assertEqual(sorted(options['pass_fds']), sorted([5091, 5092, int(argv[4]), 5094, 5095, 5093]))
        self.assertEqual(len(set(options['pass_fds'])), 6)
        self.assertTrue(options['close_fds'])
        self.assertEqual(options['env'], {'LANG': 'C', 'LC_ALL': 'C'})
        self.assertEqual((options['stdin'], options['stdout'], options['stderr']), (subprocess.PIPE,) * 3)
        self.assertEqual(seen['view_mode'], 0o700, 'the final view directory is exactly 0700 while the launcher holds it')
        self.assertEqual(self.child.request(), service.reader_invocation(self.reg, UUIDS[0]))
        self.assertEqual(self.verify.call_count, 3, 'launcher, loader and each dependency are re-measured before every launch')

    def test_an_unverifiable_artifact_refuses_before_anything_is_created_or_launched(self):
        self.verify.side_effect = service.Refusal('artifact_changed')
        result = self.go()
        self.assertEqual(self.spawned, [])
        self.assertFalse(result['launched'])
        self.assertEqual(result['outcome'], 'unavailable')
        self.assertEqual(list(self.views.iterdir()), [])
        self.assertTrue(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS), 'nothing launched: the receipt is vacuous')

    def test_oversize_or_nonbytes_request_refuses_before_launch(self):
        for request in (b'', b'x' * (service.GUIDED_READER_INPUT_BYTES + 1), 'text', 5):
            result = self.go(request)
            self.assertFalse(result['launched'])
        self.assertEqual(self.spawned, [])

    def test_a_view_directory_that_already_exists_refuses(self):
        (self.views / UUIDS[0]).mkdir()
        result = self.go()
        self.assertFalse(result['launched'])
        self.assertEqual(self.spawned, [])
        self.assertTrue((self.views / UUIDS[0]).exists(), 'a directory Root did not make is never removed')

    def test_a_spawn_failure_means_no_process_and_a_vacuous_receipt(self):
        def spawn(argv, **options):
            raise OSError(2, 'No such file or directory', options['executable'])   # CPython names the executable when its exec failed
        self.launcher.spawn = spawn
        result = self.go()
        self.assertFalse(result['launched'])
        self.assertEqual(result['outcome'], 'unavailable')
        self.assertEqual(list(self.views.iterdir()), [])

    def test_a_spawn_error_after_the_exec_succeeded_is_debt_not_a_vacuous_receipt(self):
        for error in (OSError(24, 'Too many open files'), OSError(12, 'Cannot allocate memory', '/some/pipe'), OSError(2, 'No such file or directory', '/not/the/launcher')):
            with self.subTest(error=str(error)):
                self.tearDown()
                self.setUp()

                def spawn(argv, error=error, **options):
                    # A fake exec has succeeded (a live monitor would exist); the parent then fails while setting up its own objects.
                    raise error
                self.launcher.spawn = spawn
                result = self.go()
                self.assertTrue(result['launched'], 'a monitor may exist, so the launch is not "nothing happened"')
                self.assertFalse(any(result[key] is True for key in ('namespaceInitReaped', 'monitorReaped', 'stdoutEof', 'stderrEof', 'captureDrained')))
                self.assertEqual(result['outcome'], 'unavailable')
                self.assertEqual(len(list(self.views.iterdir())), 1, 'the view of a possibly live monitor is kept')

    def test_that_debt_reaches_the_service_which_sends_no_receipt(self):
        def spawn(argv, **options):
            raise OSError(24, 'Too many open files')
        self.launcher.spawn = spawn
        pair = GuestEnd(self.reg)
        running = service.GuidedReaderService(registration=self.reg, stream=pair.service_end, owner_pidfd=None, halt=threading.Event(), launch=self.launcher.run)
        running.start()
        try:
            pair.send(start_message(self.reg, UUIDS[0], UUIDS[1]))
            deadline = time.monotonic() + 5
            while not running.debt and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(running.debt)
            self.assertIsNone(pair.nothing_within())
            self.assertFalse(running.stop())
        finally:
            pair.close()

    def test_stdout_overrun_kills_the_init_and_is_unavailable_with_complete_evidence(self):
        def script(control, child):
            self.send_init(control)
            os.write(child.stdout_write, b'x' * (service.GUIDED_READER_FRAME_BYTES + 1))
            deadline = time.monotonic() + 5
            while not self.killed_init and time.monotonic() < deadline:
                time.sleep(.01)
            self.send_receipt(control, 9)
            self.hangup(control)
            child.finish_output()
        self.script = script
        self.child.exit_code = 137
        result = self.go()
        self.assertEqual(self.killed_init, [self.pidfd_read] if False else self.killed_init)
        self.assertEqual(len(self.killed_init), 1)
        self.assertEqual((result['outcome'], result['namespaceWaitStatus'], result['monitorWaitStatus']), ('unavailable', 9, 137 << 8))
        self.assertTrue(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS))

    def test_stderr_overrun_also_kills(self):
        def script(control, child):
            self.send_init(control)
            os.write(child.stderr_write, b'e' * (service.GUIDED_READER_STDERR_BYTES + 1))
            deadline = time.monotonic() + 5
            while not self.killed_init and time.monotonic() < deadline:
                time.sleep(.01)
            self.send_receipt(control, 9)
            self.hangup(control)
            child.finish_output()
        self.script = script
        self.child.exit_code = 137
        self.assertEqual(self.go()['outcome'], 'unavailable')
        self.assertEqual(len(self.killed_init), 1)

    def test_the_supervision_deadline_kills_through_the_pidfd(self):
        def script(control, child):
            self.send_init(control)
            self.pidfd_seen.wait(5)
            deadline = time.monotonic() + 5
            self.clock.value = service.GUIDED_READER_SUPERVISE_SECONDS + .1
            while not self.killed_init and time.monotonic() < deadline:
                time.sleep(.01)
            self.send_receipt(control, 9)
            self.hangup(control)
            child.finish_output()
        self.script = script
        self.child.exit_code = 137
        result = self.go()
        self.assertEqual(len(self.killed_init), 1)
        self.assertEqual(result['outcome'], 'unavailable')
        self.assertTrue(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS))

    def test_a_reader_that_ignores_its_kill_is_unconfirmed_after_the_hard_deadline(self):
        def script(control, child):
            self.send_init(control)
            self.pidfd_seen.wait(5)
            self.clock.value = service.GUIDED_READER_SUPERVISE_SECONDS + service.GUIDED_READER_REAP_SECONDS + 1
            time.sleep(.5)
        self.script = script
        result = self.go()
        self.assertFalse(result['monitorReaped'])
        self.assertFalse(result['namespaceInitReaped'])
        self.assertGreaterEqual(self.child.killed, 1)
        self.assertEqual(self.retained, [self.child], 'an unreaped child is retained, never forgotten')

    def test_cancel_before_the_init_receipt_waits_for_the_pidfd_then_kills_it_cleanly(self):
        proceed = threading.Event()

        def script(control, child):
            proceed.wait(5)
            self.send_init(control)
            deadline = time.monotonic() + 5
            while not self.killed_init and time.monotonic() < deadline:
                time.sleep(.01)
            self.send_receipt(control, 9)
            self.hangup(control)
            child.finish_output()
        self.script = script
        self.child.exit_code = 137
        self.cancel.set()
        threading.Timer(.3, proceed.set).start()
        result = self.go()
        self.assertEqual(self.child.killed, 0, 'before the receipt nothing may kill the monitor: the init must be reaped by it')
        self.assertEqual(len(self.killed_init), 1)
        self.assertEqual(result['outcome'], 'cancelled')
        self.assertTrue(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS))

    def test_cancel_kills_the_init_through_the_pidfd_and_sends_the_launcher_no_packet(self):
        got = []

        def script(control, child):
            self.send_init(control)
            deadline = time.monotonic() + 5
            while not self.killed_init and time.monotonic() < deadline:
                time.sleep(.01)
            control.settimeout(.3)
            try:
                got.append(control.recv(16))
            except (BlockingIOError, socket.timeout):
                got.append(None)
            self.send_receipt(control, 9)
            self.hangup(control)
            child.finish_output()
        self.script = script
        self.child.exit_code = 137
        self.cancel.set()
        result = self.go()
        self.assertEqual(got, [None], 'an unread packet in the monitor would reset Root\'s end when the monitor closes it, hiding the receipt')
        self.assertEqual(len(self.killed_init), 1)
        self.assertEqual(result['outcome'], 'cancelled')

    def test_cancel_before_the_receipt_that_never_comes_ends_in_debt_not_a_receipt(self):
        def script(control, child):
            time.sleep(.2)
            self.clock.value = service.GUIDED_READER_SUPERVISE_SECONDS + .1
            time.sleep(.5)
            self.hangup(control)
            child.finish_output()
        self.script = script
        self.child.exit_code = -9
        self.cancel.set()
        result = self.go()
        self.assertEqual(self.child.killed, 1, 'only past the deadline is the monitor itself the last resort')
        self.assertFalse(result['namespaceInitReaped'], 'the init was never named, so nothing proves it was reaped')
        self.assertIsNone(result['namespaceWaitStatus'])
        self.assertTrue(result['monitorReaped'])
        self.assertEqual(result['monitorWaitStatus'], 9)

    def test_exit_64_before_any_receipt_is_the_launchers_own_refusal_and_no_init_ever_existed(self):
        def script(control, child):
            self.hangup(control)
            child.finish_output(stderr=b'reader parse')
        self.script = script
        self.child.exit_code = 64
        result = self.go()
        self.assertEqual(result['outcome'], 'unavailable')
        self.assertTrue(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS))
        self.assertEqual((result['namespaceWaitStatus'], result['monitorWaitStatus']), (0, 64 << 8))

    def test_any_other_exit_without_a_receipt_leaves_the_init_unproven(self):
        for code in (0, 1, 77, 78, 255, -9):
            with self.subTest(code=code):
                self.tearDown()
                self.setUp()
                self.script = lambda control, child: (self.hangup(control), child.finish_output())
                self.child.exit_code = code
                result = self.go()
                self.assertFalse(result['namespaceInitReaped'], code)
                self.assertTrue(result['monitorReaped'])

    def test_nonzero_init_status_or_monitor_exit_is_unavailable_but_fully_evidenced(self):
        for status, code in ((256, 0), (0, 3), (9, 137), (0, -9)):
            with self.subTest(status=status, code=code):
                self.tearDown()
                self.setUp()

                def script(control, child, status=status):
                    self.send_init(control)
                    self.send_receipt(control, status)
                    self.hangup(control)
                    child.finish_output(stdout=inner_frame(self.reg, UUIDS[0]).encode())
                self.script = script
                self.child.exit_code = code
                result = self.go()
                self.assertEqual(result['outcome'], 'unavailable')
                self.assertTrue(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS))
                self.assertEqual(result['monitorWaitStatus'], service.reader_raw_status(code))

    def test_invalid_utf8_output_is_unavailable(self):
        self.script = lambda control, child: self.happy(control, child, frame=None) if False else (self.send_init(control), self.send_receipt(control, 0), self.hangup(control), child.finish_output(stdout=b'\xff\xfe\n'))
        result = self.go()
        self.assertEqual((result['outcome'], result['frame']), ('unavailable', None))
        self.assertTrue(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS))

    def test_receipt_anomalies_leave_the_evidence_incomplete(self):
        def init_twice(control, child):
            self.send_init(control)
            self.send_init(control)
            time.sleep(.3)

        def receipt_before_init(control, child):
            self.send_receipt(control, 0)
            time.sleep(.3)

        def receipt_twice(control, child):
            self.send_init(control)
            self.send_receipt(control, 0)
            self.send_receipt(control, 0)
            time.sleep(.3)

        def bad_marker(control, child):
            control.send(b'X')
            time.sleep(.3)

        def short_receipt(control, child):
            self.send_init(control)
            control.send(b'R\x00')
            time.sleep(.3)

        def init_with_two_fds(control, child):
            control.sendmsg([b'I'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, __import__('array').array('i', [self.pidfd_write, self.pidfd_read]))])
            time.sleep(.3)

        def init_without_fd(control, child):
            control.send(b'I')
            time.sleep(.3)

        def receipt_with_fd(control, child):
            self.send_init(control)
            control.sendmsg([b'R\x00\x00\x00\x00'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, __import__('array').array('i', [os.dup(self.pidfd_write)]))])
            time.sleep(.3)
        for name, script in (('init twice', init_twice), ('receipt before init', receipt_before_init), ('receipt twice', receipt_twice), ('bad marker', bad_marker), ('short receipt', short_receipt),
                             ('two fds', init_with_two_fds), ('no fd', init_without_fd), ('fd on receipt', receipt_with_fd)):
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                self.script = script
                result = self.go()
                self.assertTrue(result['launched'])
                self.assertFalse(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS), name)
                self.assertGreaterEqual(self.child.killed, 1, name)
                self.assertEqual(self.retained, [self.child], name)

    def test_a_monitor_that_will_not_be_reaped_is_unconfirmed_and_retained(self):
        self.child.wait_raises = True
        self.script = self.happy
        result = self.go()
        self.assertFalse(result['monitorReaped'])
        self.assertEqual(self.retained, [self.child])
        self.assertGreaterEqual(self.child.killed, 1)
        self.assertEqual(len(list(self.views.iterdir())), 1, 'the view of an unreaped monitor is kept, not removed under it')

    def test_pipes_that_never_reach_eof_leave_the_drain_unproven(self):
        def script(control, child):
            self.send_init(control)
            self.send_receipt(control, 0)
            self.hangup(control)
            os.close(child.stdout_write)
            time.sleep(.2)
            self.clock.value = 1000
            time.sleep(.5)
        self.script = script
        result = self.go()
        self.assertFalse(result['stderrEof'])
        self.assertFalse(result['captureDrained'])

    def test_a_wrong_marker_is_refused_even_with_a_descriptor_attached(self):
        def script(control, child):
            control.sendmsg([b'X'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, __import__('array').array('i', [self.pidfd_write]))])
            time.sleep(.3)
        self.script = script
        result = self.go()
        self.assertFalse(all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS))
        self.assertFalse(self.pidfd_seen.is_set(), 'a packet that is not the init receipt must never be treated as one')

    def test_every_delivered_descriptor_is_owned_and_close_on_exec_before_the_packet_is_judged(self):
        import array
        seen = []
        for marker, expected in ((b'I', 'init'), (b'X', 'refused')):
            fd = os.dup(self.pidfd_read)
            os.set_inheritable(fd, True)
            fake = MagicMock()
            fake.recvmsg.return_value = (marker, [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]).tobytes())], 0, None)
            if expected == 'init':
                kind, value = service.reader_control_message(fake, True)
                self.assertEqual(kind, 'init')
                self.assertFalse(os.get_inheritable(value))
                os.close(value)
            else:
                with self.assertRaises(service.Uncertain):
                    service.reader_control_message(fake, True)
                with self.assertRaises(OSError):
                    os.fstat(fd)   # a refused packet's descriptor is closed, not leaked
        fd = os.dup(self.pidfd_read)
        os.set_inheritable(fd, True)
        fake = MagicMock()
        fake.recvmsg.return_value = (b'R\x00\x00\x00\x00', [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]).tobytes())], 0, None)
        with self.assertRaises(service.Uncertain):
            service.reader_control_message(fake, False)
        with self.assertRaises(OSError):
            os.fstat(fd)

    def test_the_view_directory_must_be_exactly_a_fresh_empty_0700_directory_of_roots_identity(self):
        real = os.lstat
        for name, changed in (('wrong mode', lambda st: os.stat_result((stat.S_IFDIR | 0o755,) + tuple(st)[1:])), ('wrong owner', lambda st: os.stat_result(tuple(st)[:4] + (st.st_uid + 1,) + tuple(st)[5:])),
                              ('not a directory', lambda st: os.stat_result((stat.S_IFREG | 0o700,) + tuple(st)[1:]))):
            with self.subTest(name):
                with patch.object(service.os, 'lstat', side_effect=lambda path, changed=changed: changed(real(path))):
                    with self.assertRaisesRegex(service.Refusal, 'guided_reader_view'):
                        self.launcher._view(UUIDS[5])
                self.assertFalse((self.views / UUIDS[5]).exists(), 'a refused view is removed')
        with patch.object(service.os, 'listdir', return_value=['planted']):
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_view'):
                self.launcher._view(UUIDS[6])
        self.assertFalse((self.views / UUIDS[6]).exists())
        self.assertEqual(self.launcher._view(UUIDS[7]), f'{self.views}/{UUIDS[7]}')

    def test_the_pidfd_must_be_a_pidfd(self):
        def refuse(fd):
            raise service.Uncertain('guided_reader_receipt')
        self.launcher.pidfd_check = refuse
        self.script = self.happy
        result = self.go()
        self.assertFalse(result['monitorReaped'])
        self.assertEqual(self.retained, [self.child])


class ReaderArgumentContractTests(unittest.TestCase):
    """Root's argv against the REAL parser of the reader launcher (its portable contract section, compiled and run with cc)."""

    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('cc')
        if compiler is None:
            raise unittest.SkipTest('no C compiler')
        source = (GUEST / 'linux-instruction-reader-compartment.c').read_text()
        begin = source.index('/* BEGIN PORTABLE CONTRACT')
        end = source.index('/* END PORTABLE CONTRACT */')
        harness = '#define _GNU_SOURCE\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdint.h>\n#define READER_DEPENDENCIES 32\n' + source[begin:end] + \
            'int main(int argc, char **argv) { struct reader_plan plan; return reader_parse(argc, argv, &plan) ? 0 : 1; }\n'
        cls.temp = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.temp.name) / 'parse'
        (Path(cls.temp.name) / 'parse.c').write_text(harness)
        built = subprocess.run([compiler, '-std=gnu11', '-O1', '-Wall', '-Wno-unused-function', str(Path(cls.temp.name) / 'parse.c'), '-o', str(cls.binary)], capture_output=True, text=True)
        if built.returncode:
            raise AssertionError('the extracted parser does not compile: ' + built.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def parses(self, argv):
        return subprocess.run([str(self.binary), *argv[1:]], capture_output=True, timeout=30).returncode == 0

    def argv(self, dependencies=(), source='/workspace/folders/source', cwd=None, uid=30001, gid=10000):
        return service.reader_argv(9, 10, '/run/winter/instruction-reader-views/' + UUIDS[0], 11, uid, gid, 12, source, cwd or source, 13, list(dependencies))

    def test_what_root_builds_is_what_the_launcher_parses(self):
        self.assertTrue(self.parses(self.argv()))
        self.assertTrue(self.parses(self.argv([(20, '/lib/ld-linux-aarch64.so.1')])))
        self.assertTrue(self.parses(self.argv([(20 + n, '/usr/lib/lib%d.so' % n) for n in range(32)])))
        self.assertTrue(self.parses(self.argv(source='/workspace/repos/project-1')))
        self.assertTrue(self.parses(self.argv(cwd='/workspace/folders/source/sub dir/é')))
        for uid, gid in ((1000, 1000), (65535, 65535)):
            self.assertTrue(self.parses(self.argv(uid=uid, gid=gid)))

    def test_shapes_root_never_builds_are_refused_by_the_launcher(self):
        self.assertFalse(self.parses(self.argv([(20 + n, '/usr/lib/lib%d.so' % n) for n in range(33)])))
        self.assertFalse(self.parses(self.argv(uid=999)))
        self.assertFalse(self.parses(self.argv(source='/workspace/other/source')))
        self.assertFalse(self.parses(self.argv() + ['extra']))
        self.assertFalse(self.parses(self.argv()[:-1]))
        self.assertFalse(self.parses(self.argv([(10, '/lib/x')])), 'a dependency descriptor aliasing the loader')
        self.assertFalse(self.parses(self.argv([(20, '/lib/x'), (21, '/lib/x/y')])))
        self.assertFalse(self.parses(self.argv([(20, '/etc/x')])))

    def test_root_validates_the_dependency_grammar_the_launcher_enforces(self):
        for path in ('/etc/x', '/lib/a b', '/lib/../x', '/lib/' + 'a' * 1021):
            self.assertFalse(service.reader_dependency_path(path))
            self.assertFalse(self.parses(self.argv([(20, path)])), path)
        for path in ('/lib/x', '/lib64/y', '/usr/lib/z/w'):
            self.assertTrue(service.reader_dependency_path(path))
            self.assertTrue(self.parses(self.argv([(20, path)])), path)


# ------------------------------------------------------------------------------------------------------------------------------
def native_available():
    return sys.platform == 'linux' and os.geteuid() == 0 and shutil.which('cc') is not None


def gate_outcome(ok, required):
    return 'run' if ok else ('fail' if required else 'skip')


STUB = r'''
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
/* A stand-in for the compiled loader. It reads the one stdin request, then behaves as the first word of the guidance file says. */
int main(void) {
    static char request[20000], guidance[256];
    ssize_t total = 0, got;
    while ((got = read(0, request + total, sizeof request - 1 - total)) > 0) total += got;
    request[total] = 0;
    int fd = open("/run/winter/shared-instructions/WINTER.md", O_RDONLY);
    ssize_t seen = fd >= 0 ? read(fd, guidance, sizeof guidance - 1) : -1;
    if (seen < 0) seen = 0;
    guidance[seen] = 0;
    char *end = strpbrk(guidance, " \r\n");
    if (end) *end = 0;
    if (!strcmp(guidance, "sleep")) { struct timespec t = {30, 0}; nanosleep(&t, 0); return 0; }
    if (!strcmp(guidance, "flood")) { static char chunk[65536]; memset(chunk, 'x', sizeof chunk); for (int i = 0; i < 8; i++) if (write(1, chunk, sizeof chunk) < 0) return 3; return 0; }
    if (!strcmp(guidance, "garbage")) { write(1, "not json\n", 9); return 0; }
    if (!strcmp(guidance, "exit3")) return 3;
    if (!strcmp(guidance, "stderr")) { static char chunk[20000]; memset(chunk, 'e', sizeof chunk); write(2, chunk, sizeof chunk); return 0; }
    /* ok: echo the request minus its closing brace, then a closed snapshot. */
    size_t length = strlen(request);
    if (length < 2 || request[length - 1] != '}') return 4;
    request[length - 1] = 0;
    printf("%s,\"snapshot\":{\"blocks\":[],\"digest\":\"d\",\"droppedImports\":[],\"files\":[],\"provenance\":[],\"skippedLinks\":[],\"text\":\"%.6s\",\"tiers\":[]}}\n", request, guidance);
    return 0;
}
'''


class LinuxNativeTests(unittest.TestCase):
    """The UNCHANGED reader launcher, built from the tracked source, launched by the real ReaderLauncher in real private mount, PID, IPC, UTS and
    network namespaces with a static stand-in as the loader. Needs Linux root and cc; CI runs it with sudo and WINTER_REQUIRE_NATIVE_READER=1."""

    UID, GID = 30001, 10000

    @classmethod
    def setUpClass(cls):
        outcome = gate_outcome(native_available(), REQUIRE_NATIVE)
        if outcome == 'fail':
            raise AssertionError('native reader evidence is required here but this host is not Linux root with a C compiler')
        if outcome == 'skip':
            raise unittest.SkipTest('needs Linux, root and a C compiler (CI runs this with sudo; never on macOS)')
        # The default temporary directory: /run is usually mounted noexec, and the loader is exec'd from a clone of its own mount.
        cls.temp = tempfile.TemporaryDirectory(prefix='winter-reader-service-')
        base = Path(cls.temp.name)
        base.chmod(0o755)
        cls.base = base
        compiler = shutil.which('cc')
        cls.launcher = base / 'launcher'
        # No -Werror: the reader source's own CI owns warning-clean compilation; this harness only needs a launcher binary.
        built = subprocess.run([compiler, '-O2', '-std=gnu11', '-Wall', '-Wextra', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-fPIE', '-pie', '-Wl,-z,relro,-z,now,-z,noexecstack',
                                f'-I{GUEST}', str(GUEST / 'linux-instruction-reader-compartment.c'), '-o', str(cls.launcher)], capture_output=True, text=True, timeout=180)
        if built.returncode:
            raise AssertionError('the reader launcher does not compile here: ' + built.stderr)
        cls.launcher.chmod(0o555)
        (base / 'stub.c').write_text(STUB)
        cls.loader = base / 'loader'
        built = subprocess.run([compiler, '-O2', '-static', '-std=gnu11', str(base / 'stub.c'), '-o', str(cls.loader)], capture_output=True, text=True, timeout=120)
        if built.returncode:
            raise AssertionError('the static loader stand-in does not compile here: ' + built.stderr)
        cls.loader.chmod(0o555)
        mount = subprocess.run(['stat', '-f', '-c', '%T', str(base)], capture_output=True, text=True).stdout.strip().lower()
        cls.filesystem = mount
        views = Path(service.READER_VIEWS_ROOT)
        views.mkdir(parents=True, exist_ok=True)
        for made in (views, views.parent):
            if made.stat().st_mode & 0o022:
                made.chmod(made.stat().st_mode & ~0o022)
        for parent in (views, *views.parents):
            if parent != Path('/') and (parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022):
                raise AssertionError('the launcher requires every ancestor of the view to be Root-owned and not group/other writable: ' + str(parent))
        cls.reg = registration()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def pins(self, path):
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()

    def fixture(self, word):
        root = Path(tempfile.mkdtemp(prefix='case-', dir=self.base))
        root.chmod(0o755)
        source, guidance = root / 'source', root / 'guidance'
        for directory in (source, guidance):
            directory.mkdir()
            directory.chmod(0o755)
        (guidance / 'WINTER.md').write_text(word + '\n')
        (guidance / 'WINTER.md').chmod(0o644)
        (source / 'file.txt').write_text('source\n')
        return source, guidance

    def run_reader(self, word, cancel=None):
        source, guidance = self.fixture(word)
        retained = []
        descriptors = [os.open(path, os.O_RDONLY | os.O_CLOEXEC) for path in (self.launcher, self.loader)]
        directories = [os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC) for path in (source, guidance)]
        try:
            launcher = service.ReaderLauncher(artifacts={'launcher': descriptors[0], 'executable': descriptors[1]}, pins={'launcher': self.pins(self.launcher), 'executable': self.pins(self.loader)},
                                              dependencies=[], uid=self.UID, gid=self.GID, source=directories[0], source_path=self.reg['views']['sourceRoot'],
                                              source_cwd=self.reg['views']['sourceCwd'], guidance=directories[1], retained=retained)
            result = launcher.run(UUIDS[0], service.reader_invocation(self.reg, UUIDS[0]), cancel or threading.Event())
            return result, retained
        finally:
            for fd in descriptors + directories:
                os.close(fd)

    def complete(self, result):
        return all(result[key] is True for key in service.GUIDED_TERMINAL_FLAGS) and all(type(result[key]) is int for key in ('namespaceWaitStatus', 'monitorWaitStatus'))

    def test_a_real_read_returns_a_valid_frame_with_complete_reap_and_drain_evidence(self):
        result, retained = self.run_reader('hello')
        self.assertEqual(retained, [])
        self.assertTrue(result['launched'])
        self.assertEqual(result['outcome'], 'ok', result)
        self.assertTrue(self.complete(result), result)
        self.assertEqual((result['namespaceWaitStatus'], result['monitorWaitStatus']), (0, 0))
        message = service.reader_result_message(self.reg, UUIDS[0], result['frame'])
        service.check_reader_message(service.reader_wire_frame(message), self.reg, UUIDS[0])
        self.assertIn('"text":"hello"', result['frame'], 'the guidance file was read through the mounted shared-instructions view')
        self.assertEqual([entry for entry in Path(service.READER_VIEWS_ROOT).iterdir() if entry.name == UUIDS[0]], [])

    def test_a_reader_that_sleeps_is_killed_by_the_launcher_and_reaped(self):
        started = time.monotonic()
        result, retained = self.run_reader('sleep')
        self.assertEqual(retained, [])
        self.assertTrue(self.complete(result), result)
        self.assertEqual(result['outcome'], 'unavailable')
        self.assertEqual(result['namespaceWaitStatus'] & 0x7f, 9, 'the namespace init ended by SIGKILL')
        self.assertLess(time.monotonic() - started, 9)

    def test_cancel_kills_the_running_reader_and_reports_cancelled_with_evidence(self):
        cancel = threading.Event()
        threading.Timer(1.0, cancel.set).start()
        started = time.monotonic()
        result, retained = self.run_reader('sleep', cancel)
        self.assertEqual(retained, [])
        self.assertEqual(result['outcome'], 'cancelled')
        self.assertTrue(self.complete(result), result)
        self.assertEqual(result['namespaceWaitStatus'] & 0x7f, 9)
        self.assertLess(time.monotonic() - started, 4, 'cancellation must not wait for the launcher\'s own deadline')

    def test_output_flood_is_cut_off_at_the_cap_and_is_unavailable(self):
        result, retained = self.run_reader('flood')
        self.assertEqual(retained, [])
        self.assertEqual(result['outcome'], 'unavailable')
        self.assertTrue(self.complete(result), result)

    def test_garbage_nonzero_exit_and_stderr_flood(self):
        for word, outcome in (('garbage', 'ok'), ('exit3', 'unavailable'), ('stderr', 'unavailable')):
            with self.subTest(word):
                result, retained = self.run_reader(word)
                self.assertEqual(retained, [])
                self.assertTrue(self.complete(result), result)
                self.assertEqual(result['outcome'], outcome)
        # 'garbage' exits cleanly: Root's transport layer (not the launcher) is what rejects a frame that does not echo the registration.
        with self.assertRaises(service.Refusal):
            service.check_reader_message(service.reader_wire_frame(service.reader_result_message(self.reg, UUIDS[0], 'not json\n')), self.reg, UUIDS[0])

    def test_a_tampered_loader_is_refused_before_anything_is_created(self):
        source, guidance = self.fixture('hello')
        descriptors = [os.open(path, os.O_RDONLY | os.O_CLOEXEC) for path in (self.launcher, self.loader)]
        directories = [os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC) for path in (source, guidance)]
        try:
            launcher = service.ReaderLauncher(artifacts={'launcher': descriptors[0], 'executable': descriptors[1]}, pins={'launcher': self.pins(self.launcher), 'executable': '0' * 64}, dependencies=[],
                                              uid=self.UID, gid=self.GID, source=directories[0], source_path=self.reg['views']['sourceRoot'], source_cwd=self.reg['views']['sourceCwd'], guidance=directories[1])
            result = launcher.run(UUIDS[1], service.reader_invocation(self.reg, UUIDS[1]), threading.Event())
        finally:
            for fd in descriptors + directories:
                os.close(fd)
        self.assertFalse(result['launched'])
        self.assertEqual([entry for entry in Path(service.READER_VIEWS_ROOT).iterdir() if entry.name == UUIDS[1]], [])

    def test_the_whole_service_over_a_real_stream_with_the_real_launcher(self):
        source, guidance = self.fixture('hello')
        descriptors = [os.open(path, os.O_RDONLY | os.O_CLOEXEC) for path in (self.launcher, self.loader)]
        directories = [os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC) for path in (source, guidance)]
        pair = GuestEnd(self.reg)
        try:
            launcher = service.ReaderLauncher(artifacts={'launcher': descriptors[0], 'executable': descriptors[1]}, pins={'launcher': self.pins(self.launcher), 'executable': self.pins(self.loader)},
                                              dependencies=[], uid=self.UID, gid=self.GID, source=directories[0], source_path=self.reg['views']['sourceRoot'],
                                              source_cwd=self.reg['views']['sourceCwd'], guidance=directories[1])
            running = service.GuidedReaderService(registration=self.reg, stream=pair.service_end, owner_pidfd=None, halt=threading.Event(), launch=launcher.run)
            running.start()
            pair.send(start_message(self.reg, UUIDS[0], UUIDS[1]))
            result, terminal = pair.frame(), pair.frame()
            self.assertEqual((result['kind'], terminal['kind'], terminal['outcome']), ('reader_result', 'reader_terminal', 'ok'))
            self.assertTrue(running.stop())
        finally:
            pair.close()
            for fd in descriptors + directories:
                os.close(fd)


if __name__ == '__main__':
    unittest.main()

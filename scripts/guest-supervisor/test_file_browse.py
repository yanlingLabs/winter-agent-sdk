"""The guest file channel's service (FC4): Root's FILE_IN/FILE_OUT service, the tool launcher's browse mode and the file worker's browse operations.

Portable classes run anywhere: the request parser against winter's own grammar (the hash-pinned copy under file-channel/, run under bun; REQUIRED
where WINTER_REQUIRE_FILE_CHANNEL_DIFFERENTIAL=1), the binding, root, response and worker-result rules, the FIFO checks, the service over real
pipes with an injected launch, the launcher with an injected process, the argv contract, the C sources' portable contract (compiled with `cc`)
and the byte pins. LinuxNativeTests build the tracked launcher and worker and run them as root in real private mount and PID namespaces; they are
skipped unless the host is Linux and root, and CI runs them with sudo (REQUIRED there via WINTER_REQUIRE_NATIVE_BROWSE=1), including built-in
mutants of the browse guards. Nothing here opens a network socket, a NIC or a vsock, starts a VM or enables Cowork.
"""
import array
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
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
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
GUEST = ROOT / 'packages/runtime/src/guest'
SUPERVISOR = GUEST / 'linux-supervisor.py'
TOOL = GUEST / 'linux-tool-compartment.c'
WORKER = GUEST / 'file-worker.c'
HEADER = GUEST / 'linux-compartment.h'
CHANNEL = Path(__file__).with_name('file-channel')
DRIVER = CHANNEL / 'differential.ts'
BROWSE_PATCH = ROOT / 'docs/research/guest-file-browse-DATA.patch'
HARNESS = CHANNEL / 'browse_harness.c'
PROBE = CHANNEL / 'browse_probe.c'
REQUIRE_DIFFERENTIAL = os.environ.get('WINTER_REQUIRE_FILE_CHANNEL_DIFFERENTIAL') == '1'
REQUIRE_NATIVE = os.environ.get('WINTER_REQUIRE_NATIVE_BROWSE') == '1'
CC_FLAGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror']

# winter's merged grammar (packages/core/src/cowork/guest-file-channel.ts, git blob 85fc4875d609904b5601ae12cf5a7b3ad64e2122, last changed in
# winter c340dfab5 on cowork/output-integration). The copy is byte for byte; refreshing it is a deliberate re-pin of this hash.
WINTER_CHANNEL_SHA256 = '18800bcb971e5edabd7856fecd4fc76936213dec02e8612d94047a4fb9448f07'
WINTER_CHANNEL_BLOB = '85fc4875d609904b5601ae12cf5a7b3ad64e2122'

spec = importlib.util.spec_from_file_location('file_browse_service', SUPERVISOR)
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

WORKSPACE, SESSION, LOCATION, INCARNATION = 'workspace_1', 'backend:1', 'location_7f3e', 'incarnation-1'
REQUEST_ID = '0b5e9a1c-2d4f-4a6b-8c7d-9e0f1a2b3c4d'
GENERATION = 'a' * 64


def request(op='stat', /, **changes):
    value = {'version': 1, 'requestId': REQUEST_ID, 'op': op, 'workspaceId': WORKSPACE, 'sessionId': SESSION, 'locationId': LOCATION,
             'relativePath': 'notes/today.md', 'incarnationId': INCARNATION, 'sourceRevision': 3}
    if op != 'stat':
        value['expectedGeneration'] = GENERATION
    if op == 'readRange':
        value['offset'] = 0
    if op != 'stat':
        value['maxBytes'] = 65536
    for key, item in changes.items():
        if item is DROP:
            value.pop(key)
        else:
            value[key] = item
    return value


DROP = object()


def line(value):
    """What winter's client sends: JSON.stringify of the candidate, then a newline (ensure_ascii off, compact)."""
    return (json.dumps(value, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8')


def identity(size=10, ino=12, mtime=1_700_000_000_123_456_789, nlink=1, dev=2049):
    return (dev, ino, size, mtime, mtime, 0o100664, nlink, 10001)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def code_only(source):
    return re.sub(r'/\*.*?\*/', '', source, flags=re.S)


# ---------------------------------------------------------------------------------------------------------------------------------------------
class RequestParserTests(unittest.TestCase):
    """The Python port on its own: what it accepts and the exact spelling it requires."""

    def accept(self, value):
        return service.file_request(line(value))

    def refuse(self, raw):
        with self.assertRaises(service.FileRefusal) as caught:
            service.file_request(raw)
        self.assertEqual(str(caught.exception), 'invalid_request')

    def test_each_operation_parses_to_its_closed_keys(self):
        for op in service.FILE_OPERATIONS:
            parsed = self.accept(request(op))
            self.assertEqual(list(parsed), list(service.FILE_REQUEST_KEYS[op]))

    def test_any_key_order_is_one_request(self):
        value = request('read')
        reordered = dict(reversed(list(value.items())))
        self.assertEqual(self.accept(reordered), self.accept(value))

    def test_non_canonical_spellings_are_refused(self):
        body = line(request())[:-1].decode()
        for raw in (body.replace(':', ': ', 1), ' ' + body, body + ' ', body.replace('"stat"', '"\\u0073tat"'), body.replace('3}', '3.0}'),
                    body.replace('3}', '3e0}'), body.replace('"sourceRevision":3', '"sourceRevision":03'), body.replace('{', '{"op":"stat",', 1)):
            self.refuse((raw + '\n').encode())

    def test_framing_is_one_bounded_utf8_line(self):
        good = line(request())
        self.refuse(good[:-1])
        self.refuse(good + b'\n')
        self.refuse(good[:-1] + b'\r\n')
        self.refuse(b'\xef\xbb\xbf' + good)
        self.refuse(good.replace(b'today', b'tod\xffy'))
        self.refuse(good.replace(b'today', b'tod\xed\xa0\x80y'))  # an encoded surrogate is not UTF-8
        self.refuse('not bytes')

    def test_the_16_kib_bound_includes_the_newline(self):
        base = len(line(request(relativePath='x')))
        path = ('a' * 255 + '/') * 16
        fitted = request(relativePath=path[:16384 - base + 1].strip('/'))
        raw = line(fitted)
        while len(raw) < 16384:
            fitted['workspaceId'] = fitted['workspaceId'] + 'w' if len(fitted['workspaceId']) < 200 else fitted['workspaceId']
            fitted['relativePath'] += 'b' if not fitted['relativePath'].endswith('/') and len(fitted['relativePath'].split('/')[-1]) < 255 else ''
            raw = line(fitted)
            if len(fitted['workspaceId']) >= 200 and len(fitted['relativePath'].split('/')[-1]) >= 255:
                fitted['relativePath'] += '/c'
                raw = line(fitted)
        self.assertGreaterEqual(len(raw), 16384)
        self.refuse(b' ' * 16385)
        with patch.dict(service.FILE_LIMITS, requestFrameBytes=len(line(request())) - 1):
            self.refuse(line(request()))
        with patch.dict(service.FILE_LIMITS, requestFrameBytes=len(line(request()))):
            self.accept(request())

    def test_nesting_duplicates_constants_and_prototype_keys_are_refused(self):
        for raw in (b'[1]\n', b'null\n', b'"x"\n', b'{"a":{"b":1}}\n', b'{"a":[1]}\n', b'{"version":NaN}\n', b'{"version":Infinity}\n'):
            self.refuse(raw)
        body = line(request())[:-1].decode()
        self.refuse((body[:-1] + ',"version":1}\n').encode())
        for key in ('__proto__', 'constructor', 'prototype'):
            self.refuse((body[:-1] + ',"%s":1}\n' % key).encode())

    def test_field_grammars(self):
        bad = {
            'version': (2, '1', True, 1.5, 0),
            'requestId': (REQUEST_ID.upper(), '0b5e9a1c-2d4f-1a6b-8c7d-9e0f1a2b3c4d', '0b5e9a1c-2d4f-4a6b-7c7d-9e0f1a2b3c4d', 7, ''),
            'workspaceId': ('', '.lead', 'a' * 201, 'sp ace', 'é', 5, None),
            'sessionId': ('', '-x', 'a/b'),
            'locationId': ('', ':x', 'a' * 201),
            'incarnationId': ('', '_x'),
            'sourceRevision': (0, -1, 2 ** 53, True, '3', None),
        }
        for key, values in bad.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.refuse(line(request(**{key: value})))
        for key in ('workspaceId', 'sessionId', 'locationId', 'incarnationId'):
            self.accept(request(**{key: 'A' + 'a._:-' * 39 + 'abcd'}))
        self.accept(request(sourceRevision=2 ** 53 - 1))
        for value in ('A' * 64, 'a' * 63, 'g' * 64, 7):
            self.refuse(line(request('read', expectedGeneration=value)))
        for value in (0, 262145, -1, True, '1', 1.5):
            self.refuse(line(request('read', maxBytes=value)))
        for value in (1, 262144):
            self.accept(request('read', maxBytes=value))
        for value in (-1, 2 ** 53, True, 1.5):
            self.refuse(line(request('readRange', offset=value)))
        self.accept(request('readRange', offset=2 ** 53 - 1))
        for op in ('list', 'write', '', None):
            self.refuse(line(request(op=op)))

    def test_closed_key_sets(self):
        for op in service.FILE_OPERATIONS:
            for key in service.FILE_REQUEST_KEYS[op]:
                with self.subTest(op=op, key=key):
                    self.refuse(line(request(op, **{key: DROP})))
            self.refuse(line(request(op, extra=1)))
        self.refuse(line(request('stat', maxBytes=1)))
        self.refuse(line(request('read', offset=0)))

    def test_relative_paths(self):
        for value in ('', '/a', 'a/', 'a//b', '.', 'a/./b', '..', 'a/../b', 'a\x00b', 'a\x1fb', 'a\x7fb', 'a\x85b', 'a\x9fb', '/'.join(['p'] * 33),
                      'x' * 256, 'é' * 128, 'a\ud800b', 7, None):
            with self.subTest(value=value):
                with self.assertRaises(service.FileRefusal):
                    service.file_relative_path(value)
        for value in ('a', '/'.join(['p'] * 32), 'x' * 255, 'é' * 127, 'a b', 'a\xa0b', '.hidden', '...', 'a b', ('d' * 255 + '/') * 15 + 'e' * 255):
            with self.subTest(value=value):
                self.assertEqual(service.file_relative_path(value), value)
        self.assertRaises(service.FileRefusal, service.file_relative_path, ('d' * 255 + '/') * 16 + 'e')

    def test_echo_is_requestId_and_op_or_nothing(self):
        self.assertEqual(service.file_echo(line(request('read', maxBytes=0))), (REQUEST_ID, 'read'))
        self.assertEqual(service.file_echo(line(request(workspaceId='bad id'))), (REQUEST_ID, 'stat'))
        for raw in (b'garbage\n', b'[1]\n', line(request(requestId='nope')), line(request(op='list')), line(request())[:-1], b'{"requestId":"%s","op":"stat","op":"read"}\n' % REQUEST_ID.encode(),
                    b'x' * 16385 + b'\n', b'\xff\n', line(request(requestId=REQUEST_ID.upper()))):
            with self.subTest(raw=raw[:40]):
                self.assertIsNone(service.file_echo(raw))

    def test_js_string_spelling(self):
        self.assertEqual(service._js_string('a"\\\b\f\n\r\t\x01\x1f\x7f\x85 /é\ud800'), '"a\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\x7f\x85 /é\\ud800"')
        with self.assertRaises(service.FileRefusal):
            service.file_wire({'a': 1.5})
        with self.assertRaises(service.FileRefusal):
            service.file_wire([1])


# ---------------------------------------------------------------------------------------------------------------------------------------------
def conversations(**changes):
    item = {'logicalSessionId': 'logical', 'authority': {'workspaceId': WORKSPACE, 'sessionId': SESSION, 'incarnationId': INCARNATION}, 'revoked': False,
            'workspaceGid': 10000, 'roots': {LOCATION: {'root': {'id': LOCATION, 'guestPath': '/workspace/repos/r1', 'readOnly': False}, 'fd': 41},
                                              'other': {'root': {'id': 'other', 'guestPath': '/workspace/folders/f1', 'readOnly': True}, 'fd': 42}}}
    item.update(changes)
    other = {'logicalSessionId': 'second', 'authority': {'workspaceId': WORKSPACE, 'sessionId': 'backend:2', 'incarnationId': INCARNATION}, 'revoked': False,
             'workspaceGid': 10000, 'roots': {'second-root': {'root': {'id': 'second-root', 'guestPath': '/workspace/repos/r2', 'readOnly': False}, 'fd': 43}}}
    return {'logical': item, 'second': other}


class BindingTests(unittest.TestCase):
    def binding(self, values, **changes):
        return service.file_binding(values, service.file_request(line(request(**changes))))

    def code(self, values, **changes):
        with self.assertRaises(service.FileRefusal) as caught:
            self.binding(values, **changes)
        return str(caught.exception)

    def test_a_delivered_conversation_and_its_exact_root(self):
        item, root = self.binding(conversations())
        self.assertEqual((item['logicalSessionId'], root['fd']), ('logical', 41))
        item, root = self.binding(conversations(), sessionId='backend:2', locationId='second-root')
        self.assertEqual((item['logicalSessionId'], root['fd']), ('second', 43))

    def test_refusals(self):
        self.assertEqual(self.code(conversations(), workspaceId='workspace_2'), 'file_unavailable')
        self.assertEqual(self.code(conversations(), sessionId='logical'), 'file_unavailable')  # the logical id is not the channel's session id
        self.assertEqual(self.code(conversations(), sessionId='backend:3'), 'file_unavailable')
        self.assertEqual(self.code(conversations(revoked=True)), 'file_unavailable')
        self.assertEqual(self.code(conversations(), incarnationId='incarnation-2'), 'stale_file')
        self.assertEqual(self.code(conversations(), locationId='Location_7f3e'), 'file_unavailable')
        self.assertEqual(self.code(conversations(), locationId='second-root'), 'file_unavailable')  # another conversation's root
        values = conversations()
        values['logical']['roots'][LOCATION]['root']['id'] = 'renamed'
        self.assertEqual(self.code(values), 'file_unavailable')

    def test_source_revision_is_echoed_never_checked(self):
        self.binding(conversations(), sourceRevision=999)


class RootAdmissionTests(unittest.TestCase):
    def admitted(self, **fields):
        values = dict(st_mode=stat.S_IFDIR | 0o2770, st_dev=2049, st_uid=0, st_gid=10000)
        values.update(fields)
        with patch.object(service.os, 'fstat', return_value=SimpleNamespace(**values)):
            return service.file_root_admitted(41, 2049, 10000)

    def test_only_a_setgid_root_workspace_directory_on_the_data_volume(self):
        self.assertTrue(self.admitted())
        for fields in ({'st_dev': 2050}, {'st_uid': 10001}, {'st_gid': 10001}, {'st_mode': stat.S_IFDIR | 0o770}, {'st_mode': stat.S_IFDIR | 0o2775},
                       {'st_mode': stat.S_IFDIR | 0o2771}, {'st_mode': stat.S_IFDIR | 0o6770}, {'st_mode': stat.S_IFREG | 0o2770}):
            with self.subTest(fields=fields):
                self.assertFalse(self.admitted(**fields))


class ConfigTests(unittest.TestCase):
    ITEMS = [{'runtimeUid': 20001, 'toolUid': 10001, 'workspaceGid': 10000}, {'runtimeUid': 20002, 'toolUid': 10002, 'workspaceGid': 10000}]

    def test_accepts_the_closed_shape(self):
        self.assertEqual(service.file_channel_config({'browseUid': 10003, 'dataDevice': 2049}, self.ITEMS), {'browseUid': 10003, 'dataDevice': 2049})
        self.assertEqual(service.file_channel_config({'browseUid': 10003, 'dataDevice': 2 ** 64 - 1}, self.ITEMS)['dataDevice'], 2 ** 64 - 1)

    def test_refuses_shape_and_ranges(self):
        for value in (None, [], {'browseUid': 10003}, {'browseUid': 10003, 'dataDevice': 1, 'x': 1}, {'browseUid': 999, 'dataDevice': 1},
                      {'browseUid': 65536, 'dataDevice': 1}, {'browseUid': True, 'dataDevice': 1}, {'browseUid': '10003', 'dataDevice': 1},
                      {'browseUid': 10003, 'dataDevice': -1}, {'browseUid': 10003, 'dataDevice': 2 ** 64}, {'browseUid': 10003, 'dataDevice': True},
                      {'browseUid': 10003, 'dataDevice': 1.0}):
            with self.subTest(value=value):
                with self.assertRaisesRegex(service.Refusal, 'file_channel_config'):
                    service.file_channel_config(value, self.ITEMS)

    def test_the_browse_uid_is_distinct_from_every_other_identity(self):
        for uid in (20001, 20002, 10001, 10002, 10000):
            with self.subTest(uid=uid):
                with self.assertRaisesRegex(service.Refusal, 'browse_identity_collision'):
                    service.file_channel_config({'browseUid': uid, 'dataDevice': 1}, self.ITEMS)
        with self.assertRaisesRegex(service.Refusal, 'browse_identity_collision'):
            service.file_channel_config({'browseUid': 30001, 'dataDevice': 1}, self.ITEMS, reader_uid=30001)
        service.file_channel_config({'browseUid': 30002, 'dataDevice': 1}, self.ITEMS, reader_uid=30001)


class WorkerResultTests(unittest.TestCase):
    STAT = request()

    def read(self, **changes):
        return service.file_request(line(request('read', **changes)))

    def stat_line(self, before=None):
        return (json.dumps({'version': 1, 'ok': True, 'before': list(before or identity())}, separators=(',', ':')) + '\n').encode()

    def read_line(self, data=b'0123456789', before=None, after=None, count=None, encoded=None):
        value = {'version': 1, 'ok': True, 'before': list(before or identity()), 'after': list(after or identity()),
                 'bytes': len(data) if count is None else count, 'dataBase64': base64.b64encode(data).decode() if encoded is None else encoded}
        return (json.dumps(value, separators=(',', ':')) + '\n').encode()

    def error_line(self, code, error=2):
        return ('{"version":1,"ok":false,"code":"%s","errno":%d}\n' % (code, error)).encode()

    def code(self, stdout, exit_code, req):
        with self.assertRaises(service.FileRefusal) as caught:
            service.file_worker_result(stdout, exit_code, req)
        return str(caught.exception)

    def test_shapes(self):
        self.assertEqual(service.file_worker_result(self.stat_line(), 0, self.STAT), (identity(), None, None))
        before, after, data = service.file_worker_result(self.read_line(), 0, self.read())
        self.assertEqual((before, after, data), (identity(), identity(), b'0123456789'))

    def test_worker_codes_map_to_the_channel_six(self):
        self.assertEqual(self.code(self.error_line('path_missing'), 1, self.STAT), 'file_missing')
        self.assertEqual(self.code(self.error_line('offset_beyond'), 1, self.read()), 'invalid_request')
        for name in ('root_unavailable', 'root_not_data', 'path_denied', 'not_regular', 'linked', 'device_mismatch', 'stat_failed', 'read_failed', 'seal_unavailable',
                     'openat2_unavailable', 'compartment_required', 'invalid_request', 'fd_cleanup_unavailable', 'resource_unavailable', 'stale_file', 'anything'):
            with self.subTest(name=name):
                self.assertEqual(self.code(self.error_line(name), 1, self.STAT), 'file_unavailable')

    def test_anything_else_is_file_unavailable(self):
        cases = [(self.stat_line(), 1), (self.error_line('path_missing'), 0), (self.stat_line() * 2, 0), (self.stat_line()[:-1], 0), (b'', 0), (b'\xff\n', 0),
                 (b'{"version":1,"ok":true,"before":[1,2,3,4,5,6,7,8],"x":1}\n', 0), (b'{"version":2,"ok":true,"before":[1,2,3,4,5,6,7,8]}\n', 0),
                 (b'{"version":true,"ok":true,"before":[1,2,3,4,5,6,7,8]}\n', 0), (b'{"version":1,"ok":true,"before":[1,2,3,4,5,6,7]}\n', 0),
                 (b'{"version":1,"ok":true,"before":[1,2,3,4,5,6,7,8.5]}\n', 0), (b'{"version":1,"ok":true,"before":[1,2,-3,4,5,6,7,8]}\n', 0),
                 (b'{"version":1,"ok":true,"before":[1,2,9007199254740992,4,5,6,7,8]}\n', 0), (b'{"version":1,"ok":true,"before":[1,2,3,4,5,6,7,true]}\n', 0),
                 (b'{"version":1,"ok":"yes","before":[1,2,3,4,5,6,7,8]}\n', 0), (b'{"version":1,"ok":false,"code":"x","errno":1,"y":1}\n', 1)]
        for stdout, exit_code in cases:
            with self.subTest(stdout=stdout[:60]):
                self.assertEqual(self.code(stdout, exit_code, self.STAT), 'file_unavailable')
        self.assertEqual(self.code(self.stat_line(), 0, self.read()), 'file_unavailable')
        self.assertEqual(self.code(self.read_line(), 0, self.STAT), 'file_unavailable')
        self.assertEqual(self.code(self.read_line(count=9), 0, self.read()), 'file_unavailable')
        self.assertEqual(self.code(self.read_line(encoded='MDEy MzQ1Njc4OQ=='), 0, self.read()), 'file_unavailable')
        self.assertEqual(self.code(self.read_line(data=b'ab', encoded='YWI'), 0, self.read()), 'file_unavailable')
        self.assertEqual(self.code(self.read_line(data=b'ab', encoded='YWJ='), 0, self.read()), 'file_unavailable')
        self.assertEqual(self.code(self.read_line(data=b'x' * 11), 0, self.read(maxBytes=10)), 'file_unavailable')


class ResponseTests(unittest.TestCase):
    def read(self, op='read', **changes):
        return service.file_request(line(request(op, **changes)))

    def parse(self, raw):
        self.assertTrue(raw.endswith(b'\n') and raw.count(b'\n') == 1)
        return json.loads(raw)

    def code(self, req, before, after, data):
        with self.assertRaises(service.FileRefusal) as caught:
            service.file_response_line(req, before, after, data)
        return str(caught.exception)

    def test_the_generation_token(self):
        token = service.file_generation(INCARNATION, identity())
        expected = hashlib.sha256(('v1|%s|2049|12|10|%d|%d|%d|1|10001' % (INCARNATION, 1_700_000_000_123_456_789, 1_700_000_000_123_456_789, 0o100664)).encode()).hexdigest()
        self.assertEqual(token, expected)
        self.assertRegex(token, '^[0-9a-f]{64}$')
        self.assertNotEqual(token, service.file_generation('incarnation-2', identity()))
        for index in range(8):
            changed = list(identity())
            changed[index] += 1
            self.assertNotEqual(token, service.file_generation(INCARNATION, tuple(changed)), index)

    def test_stat_line(self):
        value = self.parse(service.file_response_line(service.file_request(line(request())), identity(), None, None))
        self.assertEqual(list(value), list(service.FILE_RESPONSE_KEYS['stat']))
        self.assertEqual((value['ok'], value['kind'], value['bytes'], value['generation']), (True, 'file', 10, service.file_generation(INCARNATION, identity())))
        for key in service.FILE_BINDING:
            self.assertEqual(value[key], request()[key])

    def test_chunks(self):
        token = service.file_generation(INCARNATION, identity())
        value = self.parse(service.file_response_line(self.read(expectedGeneration=token, maxBytes=4), identity(), identity(), b'0123'))
        self.assertEqual(list(value), list(service.FILE_RESPONSE_KEYS['chunk']))
        self.assertEqual((value['offset'], value['nextOffset'], value['eof'], value['contentBase64'], value['encoding']), (0, 4, False, 'MDEyMw==', 'base64'))
        value = self.parse(service.file_response_line(self.read('readRange', expectedGeneration=token, offset=6, maxBytes=100), identity(), identity(), b'6789'))
        self.assertEqual((value['offset'], value['nextOffset'], value['eof']), (6, 10, True))
        value = self.parse(service.file_response_line(self.read('readRange', expectedGeneration=token, offset=10, maxBytes=5), identity(), identity(), b''))
        self.assertEqual((value['offset'], value['nextOffset'], value['eof'], value['contentBase64']), (10, 10, True, ''))
        empty = identity(size=0)
        value = self.parse(service.file_response_line(self.read(expectedGeneration=service.file_generation(INCARNATION, empty)), empty, empty, b''))
        self.assertEqual((value['bytes'], value['eof']), (0, True))

    def test_read_refusals_in_order(self):
        token = service.file_generation(INCARNATION, identity())
        self.assertEqual(self.code(self.read('readRange', expectedGeneration=token, offset=11), identity(), identity(), b''), 'invalid_request')
        self.assertEqual(self.code(self.read(expectedGeneration=token, maxBytes=4), identity(), identity(), b'012'), 'file_incomplete')
        self.assertEqual(self.code(self.read(expectedGeneration=token, maxBytes=4), identity(), identity(), b'01234'), 'file_incomplete')
        self.assertEqual(self.code(self.read(expectedGeneration='b' * 64, maxBytes=4), identity(), identity(), b'0123'), 'stale_file')
        self.assertEqual(self.code(self.read(expectedGeneration=token, maxBytes=4), identity(), identity(mtime=5), b'0123'), 'stale_file')
        # A shrink is file_incomplete even though it also changes the generation.
        self.assertEqual(self.code(self.read(expectedGeneration=token, maxBytes=20), identity(), identity(size=4), b'0123'), 'file_incomplete')

    def test_the_response_bound_is_a_guard(self):
        token = service.file_generation(INCARNATION, identity())
        raw = service.file_response_line(self.read(expectedGeneration=token, maxBytes=4), identity(), identity(), b'0123')
        with patch.dict(service.FILE_LIMITS, responseFrameBytes=len(raw) - 1):
            self.assertEqual(self.code(self.read(expectedGeneration=token, maxBytes=4), identity(), identity(), b'0123'), 'response_too_large')
        with patch.dict(service.FILE_LIMITS, responseFrameBytes=len(raw)):
            service.file_response_line(self.read(expectedGeneration=token, maxBytes=4), identity(), identity(), b'0123')
        big = identity(size=262144)
        line_ = service.file_response_line(self.read(expectedGeneration=service.file_generation(INCARNATION, big), maxBytes=262144, relativePath='p' * 255), big, big, b'\xff' * 262144)
        self.assertLess(len(line_), service.FILE_LIMITS['responseFrameBytes'])

    def test_error_lines(self):
        for code in service.FILE_ERROR_CODES:
            self.assertEqual(json.loads(service.file_error_line(REQUEST_ID, 'read', code)), {'version': 1, 'requestId': REQUEST_ID, 'op': 'read', 'ok': False, 'code': code})
        self.assertEqual(json.loads(service.file_error_line(REQUEST_ID, 'stat', 'authority_denied'))['code'], 'file_unavailable')


# ---------------------------------------------------------------------------------------------------------------------------------------------
class DifferentialTests(unittest.TestCase):
    """The Python port and winter's own parser (the pinned copy) agree on every case, and winter's parser accepts every line the service writes."""

    @classmethod
    def setUpClass(cls):
        bun = shutil.which('bun')
        if bun is None:
            if REQUIRE_DIFFERENTIAL:
                raise AssertionError('bun is required here (WINTER_REQUIRE_FILE_CHANNEL_DIFFERENTIAL=1) and was not found')
            raise unittest.SkipTest('bun is not installed')
        cls.requests = cls.request_corpus()
        cls.responses = cls.response_corpus()
        cases = [{'kind': 'request', 'line': raw.decode('utf-8')} for raw in cls.requests]
        cases += [{'kind': 'response', 'line': raw.decode('utf-8'), 'request': req.decode('utf-8')} for raw, req, _ in cls.responses]
        run = subprocess.run([bun, str(DRIVER)], input=json.dumps({'cases': cases}), capture_output=True, text=True, timeout=300, cwd=str(ROOT))
        if run.returncode:
            raise AssertionError('differential driver failed: ' + run.stderr[-2000:])
        answer = json.loads(run.stdout)
        cls.literals = answer['literals']
        cls.results = answer['results']
        if len(cls.results) != len(cases):
            raise AssertionError('driver answered %d of %d cases' % (len(cls.results), len(cases)))

    @staticmethod
    def request_corpus():
        out = []
        for op in service.FILE_OPERATIONS:
            out.append(line(request(op)))
            for key in service.FILE_REQUEST_KEYS[op]:
                out.append(line(request(op, **{key: DROP})))
            out.append(line(request(op, extra=1)))
            out.append(line(dict(reversed(list(request(op).items())))))
        values = {'version': (1, 2, '1', True, 0, None), 'requestId': (REQUEST_ID, REQUEST_ID.upper(), 'x', 1),
                  'workspaceId': ('w', 'A' * 200, 'A' * 201, 'a:b', 'a.b', '_a', '', 'é', 'a b', 7),
                  'sessionId': ('backend:1', ':', 'a/b'), 'locationId': ('location_1', '-x', 'a' * 200),
                  'incarnationId': ('i', '.i'), 'sourceRevision': (1, 0, -1, 2 ** 53 - 1, 2 ** 53, 2 ** 53 + 1, 10 ** 21, True, '1', None),
                  'relativePath': ('a', '', '/a', 'a/', 'a//b', '.', '..', 'a/../b', 'a/./b', '.hidden', '...', 'a\x01b', 'a\x7fb', 'a\x85b', 'a\x9fb', 'a\xa0b',
                                   'a b', 'é' * 127, 'é' * 128, 'x' * 255, 'x' * 256, '/'.join(['p'] * 32), '/'.join(['p'] * 33),
                                   ('d' * 255 + '/') * 15 + 'e' * 255, ('d' * 255 + '/') * 16 + 'e', 'emoji\U0001f600', 7, None)}
        for key, items in values.items():
            for item in items:
                out.append(line(request('stat', **{key: item})))
        for item in (GENERATION, 'A' * 64, 'a' * 63, 'a' * 65, 7):
            out.append(line(request('read', expectedGeneration=item)))
        for item in (1, 0, 262144, 262145, -5, True, '1'):
            out.append(line(request('read', maxBytes=item)))
        for item in (0, 1, 2 ** 53 - 1, 2 ** 53, -1, True, None):
            out.append(line(request('readRange', offset=item)))
        body = line(request('read'))[:-1].decode()
        for raw in (body.replace(':', ': ', 1), ' ' + body, body + ' ', body.replace('"read"', '"\\u0072ead"'), body.replace('65536', '65536.0'),
                    body.replace('65536', '6.5536e4'), body.replace('"sourceRevision":3', '"sourceRevision":-0'), body.replace('{', '{"op":"read",', 1),
                    body[:-1] + ',"__proto__":1}', body[:-1] + ',"constructor":1}', body.replace('"notes/today.md"', '"notes\\/today.md"'),
                    body.replace('"notes/today.md"', '"notes/\\ud800.md"'), body.replace('"notes/today.md"', '"notes/to\\u00e9.md"'),
                    body.replace('65536', '{"x":1}'), body.replace('65536', '[1]'), '[' + body + ']', 'null', '"x"', '{}', body + '\n'):
            out.append((raw + '\n').encode('utf-8'))
        out.append(line(request('read'))[:-1])
        # The 16 KiB bound, one byte either side.
        fill = len(line(request(relativePath='x')))
        for target in (16383, 16384, 16385):
            parts, remaining = [], target - fill + 1
            while remaining > 0:
                take = min(255, remaining)
                parts.append('q' * take)
                remaining -= take + 1
            path = '/'.join(parts)
            raw = line(request(relativePath=path[:len(path) - max(0, len(line(request(relativePath=path))) - target)].rstrip('/')))
            out.append(raw)
        return out

    @staticmethod
    def response_corpus():
        out = []
        data = bytes(range(256)) * 3

        def add(op, before, after, payload, **changes):
            req = service.file_request(line(request(op, **changes)))
            try:
                raw = service.file_response_line(req, before, after, payload)
                expected = None
            except service.FileRefusal as refusal:
                raw = service.file_error_line(req['requestId'], req['op'], str(refusal))
                expected = str(refusal)
            out.append((raw, line(request(op, **changes)), expected))
        whole = identity(size=len(data))
        token = service.file_generation(INCARNATION, whole)
        for path in ('notes/today.md', 'dossier/é—ü   \U0001f600.txt', 'q"uote\\back'):
            add('stat', whole, None, None, relativePath=path)
            add('read', whole, whole, data[:65536], expectedGeneration=token, relativePath=path)
        add('read', whole, whole, data[:5], expectedGeneration=token, maxBytes=5)
        for offset, size in ((0, 7), (700, 68), (767, 1), (768, 5), (100, 262144)):
            add('readRange', whole, whole, data[offset:offset + size], expectedGeneration=token, offset=offset, maxBytes=size)
        empty = identity(size=0)
        add('read', empty, empty, b'', expectedGeneration=service.file_generation(INCARNATION, empty))
        add('read', whole, whole, data[:10], expectedGeneration='b' * 64, maxBytes=10)
        add('read', whole, whole, data[:9], expectedGeneration=token, maxBytes=10)
        add('readRange', whole, whole, b'', expectedGeneration=token, offset=769, maxBytes=10)
        for code in service.FILE_ERROR_CODES:
            for op in service.FILE_OPERATIONS:
                req = request(op)
                out.append((service.file_error_line(REQUEST_ID, op, code), line(req), code))
        return out

    def test_the_copy_is_winters_merged_grammar(self):
        self.assertEqual(sha(CHANNEL / 'guest-file-channel.ts'), WINTER_CHANNEL_SHA256)
        blob = subprocess.run(['git', 'hash-object', str(CHANNEL / 'guest-file-channel.ts')], capture_output=True, text=True)
        if blob.returncode == 0:
            self.assertEqual(blob.stdout.strip(), WINTER_CHANNEL_BLOB)

    def test_the_literal_tables_are_winters(self):
        literals = self.literals
        self.assertEqual(literals['version'], service.FILE_CHANNEL_VERSION)
        self.assertEqual(tuple(literals['operations']), service.FILE_OPERATIONS)
        self.assertEqual(tuple(literals['errorCodes']), service.FILE_ERROR_CODES)
        self.assertEqual({key: tuple(value) for key, value in literals['requestKeys'].items()}, service.FILE_REQUEST_KEYS)
        self.assertEqual({key: tuple(value) for key, value in literals['responseKeys'].items()}, service.FILE_RESPONSE_KEYS)
        self.assertEqual(literals['limits'], service.FILE_LIMITS)

    def test_the_regular_expressions_are_winters(self):
        text = (CHANNEL / 'guest-file-channel.ts').read_text()
        for name, compiled in (('ID', service.FILE_ID), ('UUID_V4', service.FILE_UUID4), ('DIGEST', service.FILE_DIGEST)):
            found = re.search(r'^const %s = /\^(.+)\$/;$' % name, text, re.M)
            self.assertIsNotNone(found, name)
            self.assertEqual(found.group(1), compiled.pattern, name)
        self.assertIn('const CONTROL = /[\\u0000-\\u001f\\u007f-\\u009f]/;', text)
        self.assertEqual(service.FILE_CONTROL.pattern, '[\x00-\x1f\x7f-\x9f]')
        self.assertIn('const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];', text)

    def test_every_request_has_the_same_verdict(self):
        self.assertGreater(len(self.requests), 140)
        accepted = 0
        for raw, result in zip(self.requests, self.results[:len(self.requests)]):
            with self.subTest(raw=raw[:120]):
                try:
                    mine = {'ok': True, 'value': service.file_request(raw)}
                except service.FileRefusal as refusal:
                    mine = {'ok': False, 'code': str(refusal)}
                self.assertEqual(mine, result)
                accepted += mine['ok']
        self.assertGreater(accepted, 30)

    def test_winters_parser_accepts_every_line_the_service_writes(self):
        results = self.results[len(self.requests):]
        for (raw, req, expected), result in zip(self.responses, results):
            with self.subTest(raw=raw[:120]):
                if expected is not None:
                    self.assertEqual(result, {'ok': False, 'code': expected})
                    continue
                self.assertTrue(result['ok'], result)
                sent = json.loads(raw)
                for key in ('generation', 'bytes', 'kind', *service.FILE_BINDING):
                    self.assertEqual(result['value'][key], sent[key], key)
                if 'contentBase64' in sent:
                    self.assertEqual(result['value']['content'], sent['contentBase64'])
                    self.assertEqual((result['value']['offset'], result['value']['nextOffset'], result['value']['eof']), (sent['offset'], sent['nextOffset'], sent['eof']))
        self.assertEqual(sum(1 for _, _, expected in self.responses if expected is None), 13)


# ---------------------------------------------------------------------------------------------------------------------------------------------
FIFO_DIRECTORY = tempfile.TemporaryDirectory(prefix='winter-file-channel-fifos-')
_fifo_count = [0]


def fifo_pair(name=None):
    """A named FIFO (one link, as Root's init's pipes have on Linux; an anonymous pipe reports none on macOS), both ends non-blocking."""
    _fifo_count[0] += 1
    path = os.path.join(FIFO_DIRECTORY.name, name or 'fifo-%d' % _fifo_count[0])
    os.mkfifo(path, 0o600)
    read_end = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    write_end = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
    return read_end, write_end


class PortsTests(unittest.TestCase):
    def setUp(self):
        self.opened = []

    def tearDown(self):
        for fd in self.opened:
            with contextlib.suppress(OSError):
                os.close(fd)

    def pair(self):
        a, b = fifo_pair()
        self.opened += [a, b]
        return a, b

    def test_two_distinct_nonblocking_fifos(self):
        inbound, _ = self.pair()
        _, outbound = self.pair()
        ports = service.FileChannelPorts(inbound, outbound)
        self.assertTrue(all(fd >= 64 for fd in ports.fds.values()))
        self.assertTrue(all(fcntl_cloexec(fd) for fd in ports.fds.values()))
        ports.verify()
        ports.close()
        with self.assertRaises(service.FileChannelFatal):
            ports.verify()

    def test_refusals(self):
        inbound, inbound_write = self.pair()
        outbound_read, outbound = self.pair()
        with self.assertRaisesRegex(service.Refusal, 'file_channel_descriptor'):
            service.FileChannelPorts(outbound, inbound)  # access modes swapped
        with self.assertRaisesRegex(service.Refusal, 'file_channel_alias'):
            service.FileChannelPorts(inbound, inbound_write)  # both ends of one pipe
        with self.assertRaisesRegex(service.Refusal, 'file_channel_alias'):
            service.FileChannelPorts(inbound, outbound, others=(outbound_read,))
        linked_read, _ = self.pair()
        path = os.path.join(FIFO_DIRECTORY.name, 'fifo-%d' % _fifo_count[0])
        os.link(path, path + '-second-name')
        with self.assertRaisesRegex(service.Refusal, 'file_channel_descriptor'):
            service.FileChannelPorts(linked_read, outbound)
        os.unlink(path + '-second-name')
        named_read, named_write = fifo_pair('blocking-%d' % id(self))
        self.opened += [named_read, named_write]
        blocking_read = os.open(os.path.join(FIFO_DIRECTORY.name, 'blocking-%d' % id(self)), os.O_RDONLY)  # a writer exists, so this opens at once
        self.opened.append(blocking_read)
        with self.assertRaisesRegex(service.Refusal, 'file_channel_descriptor'):
            service.FileChannelPorts(blocking_read, outbound)
        with tempfile.TemporaryFile() as handle:
            with self.assertRaisesRegex(service.Refusal, 'file_channel_descriptor'):
                service.FileChannelPorts(handle.fileno(), outbound)
        with self.assertRaisesRegex(service.Refusal, 'file_channel_descriptor'):
            service.FileChannelPorts(-1, outbound)
        with self.assertRaisesRegex(service.Refusal, 'file_channel_descriptor'):
            service.FileChannelPorts('3', outbound)
        with patch.object(service.os, 'geteuid', return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(service.Refusal, 'file_channel_descriptor'):
                service.FileChannelPorts(inbound, outbound)

    def test_verify_notices_a_changed_descriptor(self):
        inbound, _ = self.pair()
        _, outbound = self.pair()
        ports = service.FileChannelPorts(inbound, outbound)
        other, _ = self.pair()
        os.dup2(other, ports.fds['input'])
        with self.assertRaises(service.FileChannelFatal):
            ports.verify()
        with self.assertRaises(service.FileChannelFatal):
            ports.descriptor('input')
        ports.descriptor('output')
        ports.close_end('output')
        with self.assertRaises(service.FileChannelFatal):
            ports.descriptor('output')
        ports.close()
        ports2 = service.FileChannelPorts(inbound, outbound)
        os.set_blocking(ports2.fds['output'], True)
        with self.assertRaises(service.FileChannelFatal):
            ports2.verify()
        ports2.close()


def fcntl_cloexec(fd):
    import fcntl
    return bool(fcntl.fcntl(fd, fcntl.F_GETFD) & fcntl.FD_CLOEXEC)


class ArgumentTests(unittest.TestCase):
    def test_the_trailing_pair(self):
        self.assertEqual(service.file_channel_arguments(['s', '--trusted-config-fd', '3']), (['s', '--trusted-config-fd', '3'], None))
        self.assertEqual(service.file_channel_arguments(['s', '--trusted-config-fd', '3', '--file-channel-fds', '7,8']), (['s', '--trusted-config-fd', '3'], (7, 8)))
        self.assertEqual(service.file_channel_arguments(['s', '--trusted-config-fd', '3', '--runtime-ports-fds', '4,5,6', '--file-channel-fds', '8,7'])[1], (8, 7))

    def test_refusals(self):
        for argv in (['s', '--trusted-config-fd', '3', '--file-channel-fds', '7'], ['s', '--trusted-config-fd', '3', '--file-channel-fds', '7,7'],
                     ['s', '--trusted-config-fd', '3', '--file-channel-fds', '7,8,9'], ['s', '--trusted-config-fd', '3', '--file-channel-fds', '2,8'],
                     ['s', '--trusted-config-fd', '3', '--file-channel-fds', '07,8'], ['s', '--trusted-config-fd', '3', '--file-channel-fds', '7,+8'],
                     ['s', '--file-channel-fds', '7,8', '--trusted-config-fd', '3'], ['s', '--trusted-config-fd', '3', '--file-channel-fds']):
            with self.subTest(argv=argv):
                with self.assertRaises(SystemExit) as caught:
                    service.file_channel_arguments(argv)
                self.assertEqual(caught.exception.code, 64)

    def test_main_refuses_overlap_and_a_channel_without_config(self):
        for argv in (['s', '--trusted-config-fd', '7', '--file-channel-fds', '7,8'], ['s', '--trusted-config-fd', '3', '--runtime-ports-fds', '4,5,6', '--file-channel-fds', '6,8']):
            with self.subTest(argv=argv):
                with self.assertRaises(SystemExit) as caught:
                    service.main(argv)
                self.assertEqual(caught.exception.code, 64)
        with self.assertRaises(SystemExit) as caught:
            service.file_channel_ports({'conversations': []}, (7, 8), None)
        self.assertEqual(caught.exception.code, 64)
        self.assertIsNone(service.file_channel_ports({'conversations': []}, None, None))

    def test_the_browse_envelope(self):
        argv = service.browse_argv(5, 6, '/c/browse-x', 9, 7, 10003, 10000, 'read', '/workspace/repos/r1', 'a/b', 100, 0, 41)
        self.assertEqual(argv, ['5', '6', '/c/browse-x', '9', '7', '10003', '10000', 'plan', 'browse', 'browse-read', '/workspace/repos/r1', 'a/b', '100', '0', '1', '41', '/workspace/repos/r1', '1'])
        self.assertEqual(service.browse_argv(5, 6, 'v', 9, 7, 10003, 10000, 'stat', '/g', 'a', 1, 0, 41)[9], 'stat')
        self.assertEqual(service.browse_argv(5, 6, 'v', 9, 7, 10003, 10000, 'readRange', '/g', 'a', 1, 4, 41)[9:14], ['browse-read', '/g', 'a', '1', '4'])


# ---------------------------------------------------------------------------------------------------------------------------------------------
class FakeLaunch:
    """Stands in for BrowseLauncher.run: answers from a table, can block until released, and records every call."""

    def __init__(self, answer=None):
        self.calls = []
        self.answer = answer or self.default
        self.gate = None
        self.started = threading.Semaphore(0)
        self.lock = threading.Lock()

    @staticmethod
    def default(call):
        if call['op'] == 'stat':
            return {'reaped': True, 'outcome': 'ok', 'code': 0, 'stdout': b'{"version":1,"ok":true,"before":%s}\n' % json.dumps(list(identity())).replace(' ', '').encode()}
        data = (b'0123456789')[call['offset']:call['offset'] + call['limit']]
        value = {'version': 1, 'ok': True, 'before': list(identity()), 'after': list(identity()), 'bytes': len(data), 'dataBase64': base64.b64encode(data).decode()}
        return {'reaped': True, 'outcome': 'ok', 'code': 0, 'stdout': (json.dumps(value, separators=(',', ':')) + '\n').encode()}

    def __call__(self, **call):
        with self.lock:
            self.calls.append(call)
        self.started.release()
        if self.gate is not None:
            self.gate.wait(10)
        return self.answer(call)


class ServiceFixture(unittest.TestCase):
    def setUp(self):
        self.host_write = None
        inbound, self.host_write = fifo_pair()
        self.host_read, outbound = fifo_pair()
        self.ports = service.FileChannelPorts(inbound, outbound)
        for fd in (inbound, outbound):
            os.close(fd)
        os.set_blocking(self.host_write, True)
        self.launch = FakeLaunch()
        self.resolved = []
        self.service = service.GuestFileService(ports=self.ports, resolve=self.resolve, launch=self.launch)
        self.buffer = b''

    def tearDown(self):
        if self.launch.gate is not None:
            self.launch.gate.set()
        self.service.stop()
        for fd in (self.host_write, self.host_read):
            if fd is not None:
                with contextlib.suppress(OSError):
                    os.close(fd)

    def resolve(self, req):
        self.resolved.append(req)
        if req['locationId'] == 'raise':
            raise OSError('gone')
        if req['locationId'] == 'refuse':
            raise service.FileRefusal('stale_file')
        return {'guestPath': '/workspace/repos/r1', 'gid': 10000, 'fd': 41}

    def send(self, *values):
        for value in values:
            os.write(self.host_write, value if isinstance(value, bytes) else line(value))

    def lines(self, count, timeout=5):
        deadline = time.monotonic() + timeout
        while self.buffer.count(b'\n') < count and time.monotonic() < deadline:
            try:
                data = os.read(self.host_read, 1 << 20)
            except BlockingIOError:
                time.sleep(.01)
                continue
            if not data:
                break
            self.buffer += data
        parts = self.buffer.split(b'\n')
        found = [json.loads(part) for part in parts[:count]]
        self.assertEqual(len(found), count, self.buffer[-200:])
        self.buffer = b'\n'.join(parts[count:])
        return found

    def eof(self, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data = os.read(self.host_read, 1 << 20)
            except BlockingIOError:
                time.sleep(.01)
                continue
            if not data:
                return True
            self.buffer += data
        return False

    def uuid(self, n):
        return '%08x-0000-4000-8000-%012x' % (n, n)


class ServiceTests(ServiceFixture):
    def test_one_line_per_request(self):
        self.service.start()
        token = service.file_generation(INCARNATION, identity())
        self.send(request(), request('read', requestId=self.uuid(2), expectedGeneration=token, maxBytes=4),
                  request('readRange', requestId=self.uuid(3), expectedGeneration=token, offset=8, maxBytes=4))
        answers = {value['requestId']: value for value in self.lines(3)}
        self.assertEqual(answers[REQUEST_ID]['kind'], 'file')
        self.assertEqual(base64.b64decode(answers[self.uuid(2)]['contentBase64']), b'0123')
        self.assertEqual((answers[self.uuid(3)]['contentBase64'], answers[self.uuid(3)]['eof']), (base64.b64encode(b'89').decode(), True))
        self.assertEqual(sorted(call['op'] for call in self.launch.calls), ['read', 'readRange', 'stat'])
        call = next(call for call in self.launch.calls if call['op'] == 'readRange')
        self.assertEqual((call['guest_path'], call['relative'], call['limit'], call['offset'], call['gid'], call['root_fd']), ('/workspace/repos/r1', 'notes/today.md', 4, 8, 10000, 41))
        stat_call = next(call for call in self.launch.calls if call['op'] == 'stat')
        self.assertEqual((stat_call['limit'], stat_call['offset']), (1, 0))
        self.assertEqual(self.service.observations()['answered'], 3)

    def test_a_request_split_across_writes_and_two_in_one_write(self):
        self.service.start()
        raw = line(request()) + line(request(requestId=self.uuid(2)))
        self.send(raw[:10])
        time.sleep(.1)
        self.send(raw[10:])
        self.assertEqual({value['requestId'] for value in self.lines(2)}, {REQUEST_ID, self.uuid(2)})

    def test_at_most_four_unanswered_and_FILE_IN_is_not_read_meanwhile(self):
        self.launch.gate = threading.Event()
        self.service.start()
        for n in range(1, 7):
            self.send(request(requestId=self.uuid(n)))
        for _ in range(4):
            self.assertTrue(self.launch.started.acquire(timeout=5))
        time.sleep(.3)
        self.assertEqual(len(self.launch.calls), 4)
        self.assertEqual(self.service.observations()['requests'], 4)
        self.assertEqual(self.service.observations()['outstanding'], 4)
        self.launch.gate.set()
        self.assertEqual({value['requestId'] for value in self.lines(6)}, {self.uuid(n) for n in range(1, 7)})
        self.assertEqual(self.service.observations()['outstanding'], 0)

    def test_invalid_but_echoable_lines_answer_invalid_request(self):
        self.service.start()
        self.send(request('read', maxBytes=0), request(requestId=self.uuid(2), workspaceId='no spaces'))
        self.assertEqual([(value['requestId'], value['op'], value['code']) for value in self.lines(2)],
                         [(REQUEST_ID, 'read', 'invalid_request'), (self.uuid(2), 'stat', 'invalid_request')])
        self.assertEqual(self.launch.calls, [])
        self.send(request(requestId=self.uuid(3)))
        self.assertEqual(self.lines(1)[0]['ok'], True)

    def test_refusals_from_resolve_answer_and_service_continues(self):
        self.service.start()
        self.send(request(locationId='raise'), request(requestId=self.uuid(2), locationId='refuse'))
        self.assertEqual(sorted(value['code'] for value in self.lines(2)), ['file_unavailable', 'stale_file'])
        self.assertEqual(self.launch.calls, [])
        self.assertFalse(self.service.debt)

    def test_launch_outcomes(self):
        outcomes = iter([{'reaped': True, 'outcome': 'unavailable', 'code': None, 'stdout': b''},
                         {'reaped': True, 'outcome': 'ok', 'code': 1, 'stdout': b'{"version":1,"ok":false,"code":"path_missing","errno":2}\n'},
                         {'reaped': True, 'outcome': 'ok', 'code': 0, 'stdout': b'junk\n'}])
        self.launch.answer = lambda call: next(outcomes)
        self.service.start()
        for n in range(1, 4):
            self.send(request(requestId=self.uuid(n)))
            self.assertEqual(self.lines(1)[0]['code'], ['file_unavailable', 'file_missing', 'file_unavailable'][n - 1])
        self.assertFalse(self.service.debt)

    def assert_ended(self, failure):
        self.assertTrue(self.eof(), 'FILE_OUT must close')
        deadline = time.monotonic() + 5
        while self.service.observations()['state'] != 'closed' and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.service.observations()['state'], 'closed')
        self.assertEqual(self.service.observations()['failure'], failure)

    def test_an_unechoable_line_ends_the_channel_without_a_reply(self):
        self.service.start()
        self.send(b'not json\n', request(requestId=self.uuid(2)))
        self.assert_ended('request_unechoable')
        self.assertEqual(self.buffer, b'')

    def test_an_overlong_line_ends_the_channel(self):
        self.service.start()
        self.send(b'{' + b'x' * 16384)
        self.assert_ended('request_too_large')

    def test_a_line_of_exactly_16_kib_is_read_and_one_byte_more_is_not(self):
        for size, failure in ((16384, 'request_unechoable'), (16385, 'request_too_large')):
            with self.subTest(size=size):
                self.tearDown()
                self.setUp()
                self.service.start()
                self.send(b'x' * (size - 1) + b'\n')
                self.assert_ended(failure)

    def test_an_unreaped_launch_is_debt_and_ends_the_channel(self):
        for answer, failure in ((lambda call: {'reaped': False, 'outcome': 'unavailable'}, 'browse_debt'), (lambda call: (_ for _ in ()).throw(RuntimeError('x')), 'browse_debt'),
                                (lambda call: None, 'browse_debt')):
            with self.subTest(failure=failure):
                self.tearDown()
                self.setUp()
                self.launch.answer = answer
                self.service.start()
                self.send(request())
                self.assert_ended(failure)
                self.assertEqual(self.buffer, b'')
                self.assertTrue(self.service.debt)
                self.assertFalse(self.service.stop())

    def test_FILE_IN_end_is_the_drain(self):
        self.launch.gate = threading.Event()
        self.service.start()
        self.send(request())
        self.assertTrue(self.launch.started.acquire(timeout=5))
        os.close(self.host_write)
        self.host_write = None
        self.assert_ended('drained')
        self.launch.gate.set()
        time.sleep(.2)
        self.assertEqual(self.buffer, b'')  # nothing is answered after the drain
        self.assertTrue(self.service.stop())

    def test_a_partial_line_at_drain_is_discarded(self):
        self.service.start()
        self.send(line(request())[:20])
        os.close(self.host_write)
        self.host_write = None
        self.assert_ended('drained')
        self.assertEqual(self.launch.calls, [])

    def test_the_line_in_progress_finishes(self):
        written = []
        real_write = os.write

        def slow_write(fd, data):
            if fd == self.ports.fds.get('output'):
                written.append(len(data))
                time.sleep(.05)
                if len(written) == 1:
                    self.service._end('stopped')
            return real_write(fd, data)
        big = identity(size=262144)
        token = service.file_generation(INCARNATION, big)
        payload = b'\xa5' * 262144
        value = {'version': 1, 'ok': True, 'before': list(big), 'after': list(big), 'bytes': len(payload), 'dataBase64': base64.b64encode(payload).decode()}
        self.launch.answer = lambda call: {'reaped': True, 'outcome': 'ok', 'code': 0, 'stdout': (json.dumps(value, separators=(',', ':')) + '\n').encode()}
        reader = threading.Thread(target=lambda: self.eof(10))
        with patch.object(service.os, 'write', side_effect=slow_write):
            self.service.start()
            self.send(request('read', expectedGeneration=token, maxBytes=262144))
            reader.start()
            reader.join(10)
        self.assertGreater(len(written), 1)
        self.assertTrue(all(size <= 256 * 1024 for size in written))
        self.assertEqual(self.buffer.count(b'\n'), 1)
        self.assertEqual(base64.b64decode(json.loads(self.buffer)['contentBase64']), payload)

    def test_lines_never_interleave(self):
        sizes = [262144, 1, 200000, 70000]
        big = {size: identity(size=size, ino=size) for size in sizes}

        def answer(call):
            size = int(call['relative'].split('-')[1])
            payload = bytes([size % 251]) * size
            value = {'version': 1, 'ok': True, 'before': list(big[size]), 'after': list(big[size]), 'bytes': size, 'dataBase64': base64.b64encode(payload).decode()}
            return {'reaped': True, 'outcome': 'ok', 'code': 0, 'stdout': (json.dumps(value, separators=(',', ':')) + '\n').encode()}
        self.launch.answer = answer
        self.service.start()
        for n, size in enumerate(sizes, 1):
            self.send(request('read', requestId=self.uuid(n), relativePath='f-%d' % size, expectedGeneration=service.file_generation(INCARNATION, big[size]), maxBytes=size))
        for value in self.lines(4, timeout=10):
            size = int(value['relativePath'].split('-')[1])
            self.assertEqual(base64.b64decode(value['contentBase64']), bytes([size % 251]) * size)

    def test_a_closed_FILE_OUT_ends_the_channel(self):
        self.service.start()
        os.close(self.host_read)
        self.host_read = None
        self.send(request())
        deadline = time.monotonic() + 5
        while self.service.observations()['state'] != 'closed' and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.service.observations()['failure'], 'file_out_lost')

    def test_start_is_once_and_stop_before_start_closes_the_ports(self):
        self.service.start()
        with self.assertRaisesRegex(service.Refusal, 'file_channel_claimed'):
            self.service.start()
        fresh = service.GuestFileService(ports=SimpleNamespace(close=lambda: closed.append(True)), resolve=None, launch=None)
        closed = []
        self.assertTrue(fresh.stop())
        self.assertEqual(closed, [True])
        with self.assertRaisesRegex(service.Refusal, 'file_channel_claimed'):
            fresh.start()


# ---------------------------------------------------------------------------------------------------------------------------------------------
class FakeChild:
    def __init__(self, code=0):
        stdout_read, self.stdout_write = os.pipe()
        stderr_read, self.stderr_write = os.pipe()
        self.stdout, self.stderr, self.stdin = os.fdopen(stdout_read, 'rb', buffering=0), os.fdopen(stderr_read, 'rb', buffering=0), None
        self.code, self.killed, self.wait_raises = code, 0, False

    def wait(self, timeout=None):
        if self.wait_raises:
            raise subprocess.TimeoutExpired('child', timeout)
        return self.code

    def kill(self):
        self.killed += 1

    def finish(self, stdout=b''):
        if stdout:
            os.write(self.stdout_write, stdout)
        os.close(self.stdout_write)
        os.close(self.stderr_write)


class LauncherTests(unittest.TestCase):
    STAT_OUT = b'{"version":1,"ok":true,"before":[1,2,3,4,5,6,1,8]}\n'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.child = FakeChild()
        self.spawned = []
        self.retained = []
        self.killed = []
        self.pidfd_read, self.pidfd_write = os.pipe()
        self.patches = [patch.object(service, 'verify_held_artifact')]
        real_pair = socket.socketpair
        try:
            real_pair(socket.AF_UNIX, socket.SOCK_SEQPACKET)[0].close()
        except (OSError, AttributeError):
            self.patches.append(patch.object(service.socket, 'socketpair', side_effect=lambda family=socket.AF_UNIX, kind=socket.SOCK_SEQPACKET: real_pair(socket.AF_UNIX, socket.SOCK_DGRAM)))
        self.verify = self.patches[0].start()
        for patcher in self.patches[1:]:
            patcher.start()
        self.launcher = service.BrowseLauncher(artifacts={'launcher': 5091, 'fileWorker': 5092}, pins={'launcher': 'a' * 64, 'fileWorker': 'b' * 64}, environment=5093,
                                               directory=self.directory, uid=10003, retained=self.retained, spawn=self.spawn, kill_init=self.killed.append,
                                               pidfd_check=lambda fd: None, root_uid=os.getuid())
        self.script = self.happy
        self.cancel = threading.Event()
        self.errors = []

    def tearDown(self):
        for patcher in self.patches:
            patcher.stop()
        for fd in (self.pidfd_read, self.pidfd_write):
            with contextlib.suppress(OSError):
                os.close(fd)
        for stream in (self.child.stdout, self.child.stderr):
            with contextlib.suppress(OSError):
                stream.close()
        self.temp.cleanup()

    def spawn(self, argv, **options):
        self.spawned.append((argv, options))
        self.control = socket.socket(fileno=os.dup(int(argv[3])))
        threading.Thread(target=self.run_script, daemon=True).start()
        return self.child

    def run_script(self):
        try:
            self.script(self.control, self.child)
        except Exception as error:
            self.errors.append(error)

    def init(self, control):
        control.sendmsg([b'I'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [self.pidfd_write]))])

    def receipt(self, control, status=0):
        control.send(b'R' + struct.pack('=I', status))

    def hangup(self, control):
        with contextlib.suppress(OSError):
            control.send(b'')
        control.close()

    def happy(self, control, child, stdout=None, status=0):
        self.init(control)
        self.receipt(control, status)
        self.hangup(control)
        child.finish(self.STAT_OUT if stdout is None else stdout)

    def go(self, **changes):
        call = dict(op='stat', guest_path='/workspace/repos/r1', relative='a/b', limit=1, offset=0, gid=10000, root_fd=41, cancel=self.cancel)
        call.update(changes)
        return self.launcher.run(**call)

    def test_a_reaped_run_returns_its_stdout(self):
        result = self.go()
        self.assertEqual((result['launched'], result['reaped'], result['outcome'], result['code'], result['stdout']), (True, True, 'ok', 0, self.STAT_OUT))
        argv, options = self.spawned[0]
        self.assertEqual(argv[:3] + argv[4:], ['5091', '5092', argv[2], '5093', '10003', '10000', 'plan', 'browse', 'stat', '/workspace/repos/r1', 'a/b', '1', '0', '1', '41', '/workspace/repos/r1', '1'])
        self.assertEqual(options['executable'], '/proc/self/fd/5091')
        self.assertEqual(sorted(options['pass_fds']), sorted([5091, 5092, int(argv[3]), 5093, 41]))
        self.assertEqual((options['env'], options['start_new_session'], options['close_fds'], options['stdin']), ({'LANG': 'C', 'LC_ALL': 'C'}, True, True, subprocess.DEVNULL))
        self.assertEqual(os.listdir(self.directory), [])
        self.assertEqual([call.args[0] for call in self.verify.call_args_list], [5091, 5092])

    def test_the_worker_error_exit_is_still_an_ok_launch(self):
        self.child.code = 1
        self.script = lambda control, child: self.happy(control, child, b'{"version":1,"ok":false,"code":"path_missing","errno":2}\n', status=1 << 8)
        result = self.go()
        self.assertEqual((result['outcome'], result['code']), ('ok', 1))

    def test_unavailable_outcomes(self):
        cases = [
            ('launcher refusal', 64, lambda control, child: (self.hangup(control), child.finish())),
            ('receipt disagrees', 0, lambda control, child: self.happy(control, child, status=1 << 8)),
            ('signal', 137, lambda control, child: self.happy(control, child, status=9)),
            ('exit 2', 2, lambda control, child: self.happy(control, child, status=2 << 8)),
            ('overrun', 0, lambda control, child: self.happy(control, child, stdout=b'x' * (service.FILE_STDOUT_BYTES + 1))),
        ]
        for name, code, script in cases:
            with self.subTest(name=name):
                self.tearDown()
                self.setUp()
                self.child.code = code
                self.script = script
                result = self.go()
                self.assertEqual(result['outcome'], 'unavailable')
                self.assertTrue(result['reaped'])
                self.assertEqual(self.retained, [])

    def test_missing_evidence_is_retained(self):
        cases = [
            ('no receipt after init', lambda control, child: (self.init(control), self.hangup(control), child.finish())),
            ('exit 77 without init', lambda control, child: (self.hangup(control), child.finish())),
            ('two receipts', lambda control, child: (self.init(control), self.receipt(control), self.receipt(control), self.hangup(control), child.finish())),
            ('bad marker', lambda control, child: (control.send(b'X'), self.hangup(control), child.finish())),
        ]
        for name, script in cases:
            with self.subTest(name=name):
                self.tearDown()
                self.setUp()
                self.child.code = 77
                self.script = script
                result = self.go()
                self.assertEqual((result['reaped'], result['outcome']), (False, 'unavailable'))
                self.assertEqual(self.retained, [self.child])
                self.assertEqual(len(os.listdir(self.directory)), 1)  # the view stays with the unaccounted child

    def test_a_wait_timeout_is_retained(self):
        self.child.wait_raises = True
        result = self.go()
        self.assertFalse(result['reaped'])
        self.assertEqual(self.retained, [self.child])

    def test_cancel_kills_the_namespace_init(self):
        def script(control, child):
            self.init(control)
            self.cancel.set()
            time.sleep(.3)
            self.receipt(control, 9)
            self.hangup(control)
            child.finish()
        self.child.code = 137
        self.script = script
        result = self.go()
        self.assertEqual(len(self.killed), 1)
        self.assertEqual((result['reaped'], result['outcome']), (True, 'unavailable'))

    def test_nothing_launched(self):
        self.verify.side_effect = service.Refusal('artifact_changed')
        result = self.go()
        self.assertEqual((result['launched'], result['reaped'], result['outcome']), (False, True, 'unavailable'))
        self.assertEqual(self.spawned, [])
        self.assertEqual(os.listdir(self.directory), [])

    def test_a_failed_launcher_exec_is_not_debt_but_any_other_spawn_error_is(self):
        def failing(argv, **options):
            raise FileNotFoundError(2, 'missing', options['executable'])
        self.launcher.spawn = failing
        result = self.go()
        self.assertEqual((result['launched'], result['reaped']), (False, True))

        def other(argv, **options):
            raise OSError(5, 'io')
        self.launcher.spawn = other
        result = self.go()
        self.assertEqual((result['launched'], result['reaped']), (True, False))


class ToolServiceHookTests(unittest.TestCase):
    def service_object(self):
        obj = service.ToolService.__new__(service.ToolService)
        obj.lock = threading.RLock()
        obj.stop_event = threading.Event()
        obj.conversations = conversations()
        obj.file_channel = {'browseUid': 10003, 'dataDevice': 2049}
        obj.file_service = None
        obj.artifacts = {'launcher': 5, 'fileWorker': 6, 'processWorker': 7}
        obj.artifact_pins = {'launcher': 'a' * 64, 'fileWorker': 'b' * 64, 'processWorker': 'c' * 64}
        obj.environment = 8
        obj.directory = Path('/nonexistent')
        obj.retained_children = []
        return obj

    def test_file_target(self):
        obj = self.service_object()
        req = service.file_request(line(request()))
        with patch.object(service, 'file_root_admitted', return_value=True) as admitted:
            self.assertEqual(obj._file_target(req), {'guestPath': '/workspace/repos/r1', 'gid': 10000, 'fd': 41})
            admitted.assert_called_once_with(41, 2049, 10000)
        with patch.object(service, 'file_root_admitted', return_value=False):
            with self.assertRaisesRegex(service.FileRefusal, 'file_unavailable'):
                obj._file_target(req)
        obj.stop_event.set()
        with patch.object(service, 'file_root_admitted', return_value=True):
            with self.assertRaisesRegex(service.FileRefusal, 'file_unavailable'):
                obj._file_target(req)

    def test_start_file_channel(self):
        inbound, inbound_write = fifo_pair()
        outbound_read, outbound = fifo_pair()
        ports = service.FileChannelPorts(inbound, outbound)
        try:
            for change in ({'file_channel': None}, {'file_service': object()}):
                obj = self.service_object()
                for key, value in change.items():
                    setattr(obj, key, value)
                with self.assertRaisesRegex(service.Refusal, 'file_channel_unavailable'):
                    obj.start_file_channel(ports)
            obj = self.service_object()
            with self.assertRaisesRegex(service.Refusal, 'file_channel_unavailable'):
                obj.start_file_channel(SimpleNamespace())
            obj.stop_event.set()
            with self.assertRaisesRegex(service.Refusal, 'file_channel_unavailable'):
                obj.start_file_channel(ports)
            obj = self.service_object()
            obj.start_file_channel(ports)
            launcher = obj.file_service.launch.__self__
            self.assertEqual((launcher.uid, launcher.environment, launcher.artifacts, launcher.pins), (10003, 8, {'launcher': 5, 'fileWorker': 6}, {'launcher': 'a' * 64, 'fileWorker': 'b' * 64}))
            self.assertIs(launcher.retained, obj.retained_children)
            self.assertEqual(obj.file_service.resolve, obj._file_target)
            self.assertTrue(obj.file_service.stop())
        finally:
            for fd in (inbound, inbound_write, outbound_read, outbound):
                with contextlib.suppress(OSError):
                    os.close(fd)

    def test_close_refuses_release_while_a_browse_child_is_debt(self):
        source = SUPERVISOR.read_text()
        close = source[source.index('    def close(self):\n        self.stop_event.set()'):]
        close = close[:close.index('\n# Root')]
        self.assertLess(close.index('self.file_service.stop()'), close.index('if self.debt:return False'))
        self.assertIn("if getattr(self,'file_service',None) is not None and not self.file_service.stop():return False", close)

    def test_the_constructor_reads_the_channel_after_the_reader(self):
        source = SUPERVISOR.read_text()
        init = source[source.index('class ToolService:'):source.index('    def _listener(')]
        self.assertIn('self.file_channel=None;self.file_service=None', init)
        hook = "if 'fileChannel' in config:self.file_channel=file_channel_config(config['fileChannel'],config['conversations'],self.reader['uid'] if self.reader else None)"
        self.assertIn(hook, init)
        self.assertLess(init.index('self.reader=self._open_reader('), init.index(hook))
        self.assertLess(init.index(hook), init.index('except BaseException:\n            self.close();raise'))


# ---------------------------------------------------------------------------------------------------------------------------------------------
class SourceTests(unittest.TestCase):
    """The C halves' structure, their portable contract compiled with cc, and the byte pins."""

    def test_the_browse_patch_is_exactly_the_tracked_change(self):
        text = BROWSE_PATCH.read_text()
        self.assertEqual(sorted(re.findall(r'^\+\+\+ b/(.+)$', text, re.M)), ['packages/runtime/src/guest/linux-supervisor.py', 'packages/runtime/src/guest/linux-tool-compartment.c'])
        removed = [entry[1:] for entry in text.splitlines() if entry.startswith('-') and not entry.startswith('---')]
        self.assertEqual(len(removed), 5, removed)
        self.assertEqual(sum('int process=!strcmp(argv[8],"process");' in entry for entry in removed), 1)
        self.assertEqual(sum('root_trees[i]=clone_descriptor(' in entry for entry in removed), 1)
        self.assertEqual(sum('execve(args[0],process?shell:args,env)' in entry for entry in removed), 1)
        self.assertEqual(sum('config_fd,descriptors=parse_arguments(sys.argv if argv is None else argv)' in entry for entry in removed), 1)
        self.assertEqual(sum('finally:close_descriptors(descriptors)  # exactly once, success or failure' in entry for entry in removed), 1)
        main_blob = subprocess.run(['git', '-C', str(ROOT), 'diff', '--no-color', '--no-ext-diff', 'origin/main', '--', 'packages/runtime/src/guest/linux-tool-compartment.c',
                                    'packages/runtime/src/guest/linux-supervisor.py'], capture_output=True, text=True)
        if main_blob.returncode == 0 and subprocess.run(['git', '-C', str(ROOT), 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'], capture_output=True).returncode == 0 \
                and subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'origin/main'], capture_output=True, text=True).stdout.strip() == PATCH_BASE:
            self.assertEqual(main_blob.stdout, text)

    def test_the_patch_adds_no_network_surface(self):
        added = '\n'.join(entry[1:] for entry in BROWSE_PATCH.read_text().splitlines() if entry.startswith('+') and not entry.startswith('+++'))
        added += '\n' + WORKER.read_text()
        for token in ('AF_INET', 'AF_INET6', 'AF_VSOCK', 'AF_NETLINK', 'AF_PACKET', 'vsock', 'virtio', 'ioctl(', 'bind(', 'listen(', 'accept(', 'sendto', 'recvfrom', 'setns(', 'unshare(',
                      'CLONE_NEW', 'SOCK_RAW', 'SOCK_DGRAM', 'getaddrinfo', 'urllib', 'http', 'ssl', 'create_connection', 'socket.socket(', 'provider'):
            self.assertNotIn(token, added, token)
        families = set(re.findall(r'socket\.socketpair\(([^)]*)\)', added))
        self.assertEqual(families, {'socket.AF_UNIX,socket.SOCK_SEQPACKET'})

    def test_the_launcher_browse_mode(self):
        source = code_only(TOOL.read_text())
        self.assertIn('browse=!strcmp(argv[8],"browse");if(!process&&!browse&&strcmp(argv[8],"file"))_exit(64);', source)
        self.assertIn('if(browse&&(roots!=1||guided||strcmp(argv[10],argv[16])||(strcmp(argv[9],"stat")&&strcmp(argv[9],"browse-read"))))_exit(64);', source)
        self.assertIn('number(argv[17+3*i],0,1)||!strcmp(argv[7],"plan")||browse,0);', source)
        self.assertIn('char *browse_args[]={"/file-worker",argv[9],argv[10],argv[11],argv[5],argv[12],argv[13],root_device,NULL};', source)
        self.assertIn('execve(args[0],process?shell:browse?browse_args:args,env);', source)
        # Browse is never `process`: no devices, environment, scratch or procfs; the shared filter runs with clone fully denied.
        self.assertEqual(source.count('install_filter(process)'), 1)
        for needle in ('if(process)for(size_t i=0;i<TOOL_DEVICE_COUNT;i++)', 'if(process)for(int i=0;i<4;i++){', '    if(process){\n'):
            self.assertIn(needle, source)
        # The capability clear, group, uid order and umask are the tool compartment's, unchanged.
        tail = source[source.index('require(prctl(PR_SET_NO_NEW_PRIVS'):]
        for needle in ('PR_CAPBSET_DROP', 'setgroups(1,&group)', 'setresgid(uid,uid,uid)', 'setresuid(uid,uid,uid)', 'SYS_capset,&header,caps', 'install_filter(process);umask(0002);'):
            self.assertIn(needle, tail)

    def test_the_shared_filter_denies_handle_syscalls(self):
        header = code_only(HEADER.read_text())
        self.assertIn('DENY(open_by_handle_at),DENY(name_to_handle_at)', header)
        self.assertEqual(sha(HEADER), '92fef7c0708a23b1e930c5b2560dae6bef27294dfd682346e69d35c0484b967d')

    def test_the_worker_browse_walk(self):
        source = code_only(WORKER.read_text())
        main = source[source.index('static int browse_main('):source.index('int main(')]
        self.assertIn('.flags = O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS', main)
        self.assertIn('.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV', main)
        self.assertIn('.flags = O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_NOCTTY | O_CLOEXEC', main)
        self.assertIn('(unsigned long)fs.f_type != BROWSE_EXT4_MAGIC || (unsigned long long)root_st.st_dev != root_device', main)
        self.assertIn('browse_object_code(before.st_mode, before.st_nlink, before.st_dev, root_st.st_dev)', main)
        self.assertEqual(main.count('syscall(SYS_openat2'), 2)
        self.assertNotIn('O_WRONLY', main)
        self.assertNotIn('O_RDWR', main)
        self.assertNotIn('O_CREAT', main)
        for forbidden in ('write(', 'ftruncate', 'fsync', 'unlink', 'rename', 'chmod', 'chown', 'exec'):
            self.assertNotIn(forbidden, main.replace('browse_seal_probe', ''), forbidden)
        # The seal comes after the file is open and before any byte is read or printed.
        self.assertLess(main.index('int file = (int)syscall(SYS_openat2'), main.index('browse_seal()'))
        self.assertLess(main.index('browse_seal()'), main.index('pread('))
        self.assertLess(main.index('browse_seal()'), main.index('printf('))
        self.assertIn('if (browse) return browse_main(argv);', source)
        entry = source[source.index('int main('):]
        self.assertLess(entry.index('PR_GET_NO_NEW_PRIVS'), entry.index('if (browse) return browse_main(argv);'))
        self.assertLess(entry.index('PR_CAP_AMBIENT_IS_SET'), entry.index('if (browse) return browse_main(argv);'))

    def test_the_seal_denies_every_write_and_exec_syscall(self):
        source = code_only(WORKER.read_text())
        seal = source[source.index('static int browse_seal(void)'):source.index('#ifdef WINTER_BROWSE_SEAL_PROBE')]
        for name in ('execve', 'execveat', 'openat', 'openat2', 'pwrite64', 'pwritev', 'pwritev2', 'truncate', 'ftruncate', 'fallocate', 'renameat', 'renameat2', 'unlinkat', 'mkdirat',
                     'mknodat', 'linkat', 'symlinkat', 'fchmod', 'fchmodat', 'fchown', 'fchownat', 'setxattr', 'lsetxattr', 'fsetxattr', 'removexattr', 'lremovexattr', 'fremovexattr',
                     'utimensat', 'sendfile', 'copy_file_range', 'splice', 'tee', 'vmsplice', 'socket', 'socketpair', 'connect', 'open_by_handle_at', 'name_to_handle_at'):
            self.assertIn('BROWSE_DENY(%s)' % name, seal, name)
        self.assertIn('BROWSE_STDOUT_ONLY(write), BROWSE_STDOUT_ONLY(writev)', seal)
        self.assertIn('SECCOMP_RET_KILL_PROCESS', seal)
        self.assertTrue(seal.rstrip().endswith('}'))

    def test_the_probe_hook_is_absent_from_every_image_compile_command(self):
        for path in [*ROOT.joinpath('scripts').glob('guest-*/build.py'), *ROOT.joinpath('scripts').glob('guest-*/stage.py'), ROOT / '.github/workflows/ci.yml']:
            self.assertNotIn('WINTER_BROWSE_SEAL_PROBE', path.read_text(), path)

    def contract(self):
        source = WORKER.read_text()
        return source[source.index('/* BEGIN PORTABLE BROWSE CONTRACT'):source.index('/* END PORTABLE BROWSE CONTRACT */')]

    def test_the_portable_contract(self):
        compiler = shutil.which('cc')
        if compiler is None:
            self.skipTest('needs a C compiler')
        harness = r'''
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
%s
static int failures = 0;
#define CHECK(x) do { if (!(x)) { printf("FAIL %%d %%s\n", __LINE__, #x); failures++; } } while (0)
int main(void) {
    unsigned long long v = 0;
    CHECK(browse_decimal("0", 10, &v) && v == 0);
    CHECK(browse_decimal("262144", 262144, &v) && v == 262144);
    CHECK(!browse_decimal("262145", 262144, &v));
    CHECK(!browse_decimal("", 9, &v)); CHECK(!browse_decimal("01", 9, &v)); CHECK(!browse_decimal("-1", 9, &v)); CHECK(!browse_decimal("+1", 9, &v));
    CHECK(!browse_decimal("1a", 9, &v)); CHECK(!browse_decimal(" 1", 9, &v)); CHECK(!browse_decimal(NULL, 9, &v));
    CHECK(browse_decimal("18446744073709551615", ~0ULL, &v) && v == ~0ULL); CHECK(!browse_decimal("18446744073709551616", ~0ULL, &v));
    CHECK(browse_decimal("9007199254740991", 9007199254740991ULL, &v)); CHECK(!browse_decimal("9007199254740992", 9007199254740991ULL, &v));
    CHECK(!strcmp(browse_open_code(ENOENT), "path_missing")); CHECK(!strcmp(browse_open_code(ENOTDIR), "path_missing"));
    CHECK(!strcmp(browse_open_code(ENOSYS), "openat2_unavailable"));
    int refused[] = {ELOOP, EXDEV, EACCES, EPERM, EAGAIN, ENXIO, EISDIR, EIO, 0};
    for (int i = 0; i < (int)(sizeof refused / sizeof refused[0]); i++) CHECK(!strcmp(browse_open_code(refused[i]), "path_denied"));
    CHECK(browse_object_code(S_IFREG | 0644, 1, 5, 5) == NULL);
    CHECK(!strcmp(browse_object_code(S_IFDIR | 0755, 1, 5, 5), "not_regular")); CHECK(!strcmp(browse_object_code(S_IFIFO | 0644, 1, 5, 5), "not_regular"));
    CHECK(!strcmp(browse_object_code(S_IFLNK | 0777, 1, 5, 5), "not_regular")); CHECK(!strcmp(browse_object_code(S_IFCHR | 0666, 1, 5, 5), "not_regular"));
    CHECK(!strcmp(browse_object_code(S_IFREG | 0644, 2, 5, 5), "linked")); CHECK(!strcmp(browse_object_code(S_IFREG | 0644, 0, 5, 5), "linked"));
    CHECK(!strcmp(browse_object_code(S_IFREG | 0644, 1, 5, 6), "device_mismatch"));
    unsigned long long span = 99;
    CHECK(browse_span(10, 0, 4, &span) && span == 4); CHECK(browse_span(10, 8, 4, &span) && span == 2); CHECK(browse_span(10, 10, 4, &span) && span == 0);
    CHECK(!browse_span(10, 11, 4, &span)); CHECK(browse_span(0, 0, 1, &span) && span == 0);
    printf("%%s\n", failures ? "FAILED" : "PASSED");
    return failures != 0;
}
''' % self.contract()
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / 'c.c').write_text(harness)
            built = subprocess.run([compiler, *CC_FLAGS, '-o', str(Path(temp) / 'c'), str(Path(temp) / 'c.c')], capture_output=True, text=True, timeout=120)
            self.assertEqual(built.returncode, 0, built.stderr)
            run = subprocess.run([str(Path(temp) / 'c')], capture_output=True, text=True, timeout=30)
            self.assertEqual(run.returncode, 0, run.stdout)
            self.assertIn('PASSED', run.stdout)


# The origin/main commit the browse patch was cut from. The byte-equality check above runs only while origin/main is still that commit.
PATCH_BASE = 'b1ea8cf33b3cec7aad12a51dcef4f58905176de2'


# ---------------------------------------------------------------------------------------------------------------------------------------------
def native_available():
    return sys.platform == 'linux' and os.geteuid() == 0 and shutil.which('cc') is not None


class LinuxNativeTests(unittest.TestCase):
    """The tracked launcher's browse mode and the tracked worker's browse operations, as root in real private mount and PID namespaces."""

    UID, GID, BROWSE, OTHER = 10001, 10000, 10003, 10002

    @classmethod
    def setUpClass(cls):
        if not native_available():
            if REQUIRE_NATIVE:
                raise AssertionError('native browse evidence is required here but this host is not Linux root with a C compiler')
            raise unittest.SkipTest('needs Linux, root and a C compiler (CI runs this with sudo; never on macOS)')
        cls.mounts = []
        cls.temp = tempfile.TemporaryDirectory(prefix='winter-browse-native-')
        cls.base = Path(cls.temp.name)
        cls.base.chmod(0o755)
        fs = subprocess.run(['stat', '-f', '-c', '%t', str(cls.base)], capture_output=True, text=True).stdout.strip().lower()
        if fs != 'ef53':
            raise AssertionError('the native browse tests need an ext4 temporary directory; got filesystem type ' + fs)
        cls.build_dir = cls.base / 'build'
        cls.build_dir.mkdir()
        cls.launcher = cls.build(TOOL, 'launcher')
        cls.worker = cls.build(WORKER, 'file-worker')
        cls.seal_probe = cls.build(WORKER, 'seal-probe', ['-DWINTER_BROWSE_SEAL_PROBE'])
        cls.probe = cls.build(PROBE, 'probe')
        cls.harness = cls.build(HARNESS, 'harness')
        cls.environment = cls.base / 'environment'
        cls.environment.mkdir()
        cls.views = cls.base / 'views'
        cls.views.mkdir(mode=0o700)
        cls.views.chmod(0o700)

    @classmethod
    def build(cls, source, name, extra=(), header=None):
        directory = cls.build_dir / (name + '-src')
        directory.mkdir(exist_ok=True)
        shutil.copyfile(source, directory / source.name)
        shutil.copyfile(header or HEADER, directory / 'linux-compartment.h')
        target = cls.build_dir / name
        built = subprocess.run(['cc', *CC_FLAGS, '-static', *extra, str(directory / source.name), '-o', str(target)], capture_output=True, text=True, timeout=120)
        if built.returncode:
            raise AssertionError('%s does not compile: %s' % (name, built.stderr))
        target.chmod(0o555)
        return target

    @classmethod
    def tearDownClass(cls):
        for mount in reversed(getattr(cls, 'mounts', [])):
            subprocess.run(['umount', '-l', str(mount)], capture_output=True)
        if hasattr(cls, 'temp'):
            cls.temp.cleanup()

    def root(self, name='root'):
        """A data-volume root as Root's init makes it: root:workspaceGid 2770, files written by a tool with umask 0002."""
        base = Path(tempfile.mkdtemp(prefix=name + '-', dir=self.base))
        base.chmod(0o755)
        root = base / 'r'
        root.mkdir()
        os.chown(root, 0, self.GID)
        root.chmod(0o2770)
        self.write(root / 'seed.txt', b'0123456789')
        (root / 'dir').mkdir()
        os.chown(root / 'dir', self.UID, self.GID)
        (root / 'dir').chmod(0o2775)
        self.write(root / 'dir' / 'inner.txt', b'inner')
        self.write(root / 'private.txt', b'private', mode=0o600)
        self.write(root / 'other-group.txt', b'other', mode=0o660, gid=self.OTHER)
        self.write(root / 'world.txt', b'world', mode=0o604, gid=self.OTHER)
        self.write(root / 'linked.txt', b'linked')
        os.link(root / 'linked.txt', root / 'linked-alias.txt')
        (root / 'link.txt').symlink_to('seed.txt')
        (root / 'dirlink').symlink_to('dir')
        (root / 'escape.txt').symlink_to('/etc/hostname')
        os.mkfifo(root / 'fifo')
        os.chown(root / 'fifo', self.UID, self.GID)
        (root / 'fifo').chmod(0o664)
        return root

    def write(self, path, data, mode=0o664, uid=None, gid=None):
        path.write_bytes(data)
        os.chown(path, self.UID if uid is None else uid, self.GID if gid is None else gid)
        path.chmod(mode)

    def launch(self, root, op, relative, limit=1024, offset=0, uid=None, gid=None, worker=None, guest='/workspace/repos/r1', extra=None, mutate=None, launcher=None):
        view = tempfile.mkdtemp(prefix='view-', dir=self.views)
        control_root, control_launcher = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        held = []
        try:
            worker_fd = os.open(worker or self.worker, os.O_RDONLY | os.O_CLOEXEC)
            held.append(worker_fd)
            environment = os.open(self.environment, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            held.append(environment)
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            held.append(root_fd)
            argv = service.browse_argv(launcher or self.launcher, worker_fd, view, control_launcher.fileno(), environment, uid or self.BROWSE, gid or self.GID, op, guest, relative, limit, offset, root_fd)
            if mutate:
                argv = mutate(argv)
            if extra:
                argv += extra
            child = subprocess.Popen(argv, executable=str(launcher or self.launcher), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     pass_fds=[worker_fd, control_launcher.fileno(), environment, root_fd], close_fds=True, env={'LANG': 'C', 'LC_ALL': 'C'}, start_new_session=True)
            control_launcher.close()
            out, err = child.communicate(timeout=60)
            return child.returncode, out, err.decode(errors='replace')
        finally:
            for fd in held:
                with contextlib.suppress(OSError):
                    os.close(fd)
            control_root.close()
            with contextlib.suppress(OSError):
                control_launcher.close()

    def result(self, root, op, relative, **options):
        code, out, err = self.launch(root, op, relative, **options)
        self.assertIn(code, (0, 1), (code, out, err))
        value = json.loads(out)
        self.assertEqual(code == 0, value['ok'], (code, value, err))
        return value

    def refused(self, root, relative, code, op='stat', **options):
        value = self.result(root, op, relative, **options)
        self.assertEqual((value['ok'], value['code']), (False, code), value)
        return value

    def test_stat_and_reads(self):
        root = self.root()
        value = self.result(root, 'stat', 'seed.txt')
        st = os.stat(root / 'seed.txt')
        self.assertEqual(value['before'], [st.st_dev, st.st_ino, 10, st.st_mtime_ns, st.st_ctime_ns, st.st_mode, 1, self.UID])
        value = self.result(root, 'read', 'seed.txt', limit=4)
        self.assertEqual((base64.b64decode(value['dataBase64']), value['bytes'], value['before'], value['after']), (b'0123', 4, value['before'], value['before']))
        value = self.result(root, 'readRange', 'seed.txt', limit=100, offset=7)
        self.assertEqual(base64.b64decode(value['dataBase64']), b'789')
        value = self.result(root, 'readRange', 'seed.txt', limit=100, offset=10)
        self.assertEqual(value['bytes'], 0)
        self.refused(root, 'seed.txt', 'offset_beyond', op='readRange', offset=11)
        self.assertEqual(base64.b64decode(self.result(root, 'read', 'dir/inner.txt')['dataBase64']), b'inner')
        self.assertEqual(base64.b64decode(self.result(root, 'read', 'other-group.txt', uid=self.UID)['dataBase64']), b'other')

    def test_the_browse_uid_reads_by_group_only(self):
        root = self.root()
        self.assertEqual(base64.b64decode(self.result(root, 'read', 'seed.txt')['dataBase64']), b'0123456789')
        self.refused(root, 'private.txt', 'path_denied')
        self.refused(root, 'other-group.txt', 'path_denied')
        # Permission bits, not privilege: a world-readable file is readable, as for any unprivileged process.
        self.assertEqual(base64.b64decode(self.result(root, 'read', 'world.txt')['dataBase64']), b'world')

    def test_walk_refusals(self):
        root = self.root()
        self.refused(root, 'missing.txt', 'path_missing')
        self.refused(root, 'missing/x.txt', 'path_missing')
        self.refused(root, 'seed.txt/x', 'path_missing')
        self.refused(root, 'link.txt', 'path_denied')
        self.refused(root, 'dirlink/inner.txt', 'path_denied')
        self.refused(root, 'escape.txt', 'path_denied')
        self.refused(root, '../r/seed.txt', 'path_denied')
        self.refused(root, 'linked.txt', 'linked')
        self.refused(root, 'dir', 'not_regular')
        started = time.monotonic()
        self.refused(root, 'fifo', 'not_regular')
        self.assertLess(time.monotonic() - started, 10)

    def test_a_share_root_and_a_mount_below_the_root(self):
        root = self.root()
        share = root.parent / 'share'
        share.mkdir()
        subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=2770,gid=%d' % self.GID, 'tmpfs', str(share)], check=True)
        type(self).mounts.append(share)
        self.write(share / 'shared.txt', b'shared')
        self.refused(share, 'shared.txt', 'root_not_data')
        nested = root / 'nested'
        nested.mkdir()
        subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=2770,gid=%d' % self.GID, 'tmpfs', str(nested)], check=True)
        type(self).mounts.append(nested)
        self.write(nested / 'below.txt', b'below')
        # The launcher clones the root without its submounts, so the view shows the bare mount point; the worker on the host tree refuses the crossing.
        self.refused(root, 'nested/below.txt', 'path_missing')
        self.assertEqual(self.harness_run(root, 'stat', 'nested/below.txt')['code'], 'path_denied')
        self.assertEqual(self.harness_run(root, 'stat', 'nested/below.txt')['errno'], 18)
        self.assertEqual(self.harness_run(share, 'stat', 'shared.txt')['code'], 'root_not_data')
        self.assertEqual(self.harness_run(root, 'stat', 'seed.txt', device=os.stat(root).st_dev + 1)['code'], 'root_not_data')
        self.assertTrue(self.harness_run(root, 'stat', 'seed.txt')['ok'])

    def harness_run(self, root, op, relative, device=None, worker=None):
        """The worker alone, on the host tree, in the browse identity (the harness sets no_new_privs, the shared filter and zero capabilities)."""
        argv = [str(self.harness), str(worker or self.worker), str(self.BROWSE), str(self.GID), op, str(root), relative, '1024', '0', str(os.stat(root).st_dev if device is None else device)]
        run = subprocess.run(argv, capture_output=True, timeout=60)
        self.assertIn(run.returncode, (0, 1), run.stderr)
        return json.loads(run.stdout)

    def test_the_launcher_refuses_other_browse_envelopes(self):
        root = self.root()
        for mutate in (lambda argv: argv[:9] + ['read'] + argv[10:], lambda argv: argv[:9] + ['write'] + argv[10:], lambda argv: argv[:10] + ['/workspace/repos/other'] + argv[11:],
                       lambda argv: argv[:14] + ['2'] + argv[15:] + [argv[15], '/workspace/repos/r2', '1']):
            code, _, _ = self.launch(root, 'stat', 'seed.txt', mutate=mutate)
            self.assertEqual(code, 64)
        code, _, _ = self.launch(root, 'stat', 'seed.txt', extra=['--guidance', '3'])
        self.assertEqual(code, 64)

    def probe_run(self, root, launcher=None):
        code, out, err = self.launch(root, 'stat', 'seed.txt', worker=self.probe, launcher=launcher)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_the_browse_compartment_from_inside(self):
        root = self.root()
        value = self.probe_run(root)
        self.assertEqual((value['uid'], value['euid'], value['gid'], value['groups']), (self.BROWSE, self.BROWSE, self.BROWSE, [self.GID]))
        self.assertEqual((value['capEffective'], value['capPermitted'], value['capInheritable'], value['boundingSet']), (0, 0, 0, 0))
        self.assertEqual((value['noNewPrivs'], value['seccomp']), (1, 2))
        self.assertEqual(value['rootMountReadOnly'], 1)
        self.assertEqual(value['writeOpen'], 30)  # EROFS: the one root is read only whatever the tool policy
        self.assertEqual(value['nameToHandle'], 1)  # EPERM from the shared filter
        self.assertEqual(value['openByHandle'], 1)
        self.assertEqual(value['clone'], 1)
        self.assertEqual(value['umask'], 0o002)
        self.assertEqual(value['entries'], ['file-worker', 'workspace'])

    def test_the_handle_syscall_denies_are_load_bearing(self):
        """Mutant: the shared header without its two handle DENY entries. name_to_handle_at must then reach the kernel; open_by_handle_at may
        still answer EPERM from the kernel's own capability check (the browser has none), which the report names when it happens."""
        root = self.root()
        header = self.build_dir / 'mutant-header.h'
        text = HEADER.read_text()
        self.assertIn('DENY(open_by_handle_at),DENY(name_to_handle_at),', text)
        header.write_text(text.replace('DENY(open_by_handle_at),DENY(name_to_handle_at),', ''))
        mutant = self.build(TOOL, 'launcher-without-handle-denies', header=header)
        value = self.probe_run(root, launcher=mutant)
        self.assertNotEqual(value['nameToHandle'], 1, 'the mutant launcher still denies name_to_handle_at: the probe does not observe the filter')
        # With a bad mount descriptor the kernel answers EBADF before any capability check (both CI kernels); only the filter answers EPERM.
        self.assertNotEqual(value['openByHandle'], 1, 'the mutant launcher still denies open_by_handle_at: the probe does not observe the filter')

    def test_the_seal(self):
        root = self.root()
        value = self.result(root, 'stat', 'seed.txt', worker=self.seal_probe)
        self.assertEqual(value['probe'], [1, 1, 1, 1, 1, 1, 1])
        self.assertEqual((root / 'seed.txt').read_bytes(), b'0123456789')
        # Mutant: the probe build without the seal must observe the kernel, not the filter.
        unsealed = self.build_dir / 'unsealed-src'
        unsealed.mkdir(exist_ok=True)
        (unsealed / 'file-worker.c').write_text(WORKER.read_text().replace('if (browse_seal()) {', 'if (0 && browse_seal()) {'))
        mutant = self.build(unsealed / 'file-worker.c', 'unsealed-probe', ['-DWINTER_BROWSE_SEAL_PROBE'])
        value = self.result(root, 'stat', 'seed.txt', worker=mutant)
        self.assertNotEqual(value['probe'][1], 1)  # openat of "/" succeeds in the view without the seal
        self.assertNotEqual(value['probe'][2], 1)  # stderr is writable without the seal
        self.assertNotEqual(value['probe'][3], 1)  # pwrite reaches the kernel (EBADF on the read-only descriptor)
        self.assertEqual((root / 'seed.txt').read_bytes(), b'0123456789')

    def test_browse_stays_read_only_whatever_the_policy_argument(self):
        root = self.root()
        code, out, err = self.launch(root, 'stat', 'seed.txt', worker=self.probe, mutate=lambda argv: argv[:7] + ['auto'] + argv[8:])
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)['writeOpen'], 30)

    # Built-in mutants of the C guards: each is built from the tracked source with one guard removed and must change an observable outcome.
    TOOL_MUTANTS = [
        ('read-only whatever the policy', '||!strcmp(argv[7],"plan")||browse,0);', '||!strcmp(argv[7],"plan"),0);'),
        ('one root only', 'if(browse&&(roots!=1||guided||', 'if(browse&&(guided||'),
        ('never guided', 'if(browse&&(roots!=1||guided||', 'if(browse&&(roots!=1||'),
        ('root shown at the requested path', '||strcmp(argv[10],argv[16])||', '||'),
        ('stat or browse-read only', '||(strcmp(argv[9],"stat")&&strcmp(argv[9],"browse-read"))))_exit(64);', '))_exit(64);'),
        ('the admitted device reaches the worker', 'snprintf(root_device,sizeof root_device,"%ju",(uintmax_t)admitted.st_dev);', 'snprintf(root_device,sizeof root_device,"%ju",(uintmax_t)admitted.st_dev+1);'),
    ]
    WORKER_MUTANTS = [
        ('no symlinks', '.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV', '.resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV'),
        ('beneath', '.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV', '.resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV'),
        ('no mount crossing', '.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV', '.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS'),
        ('non-blocking open', '.flags = O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_NOCTTY | O_CLOEXEC,', '.flags = O_RDONLY | O_NOFOLLOW | O_NOCTTY | O_CLOEXEC,'),
        ('regular file only', '    if (!S_ISREG(mode)) return "not_regular";', '    if (!S_ISREG(mode) && 0) return "not_regular";'),
        ('one link only', '    if (links != 1) return "linked";', '    if (links != 1 && 0) return "linked";'),
        ('ext4 root', '(unsigned long)fs.f_type != BROWSE_EXT4_MAGIC || ', ''),
        ('root on the admitted device', ' || (unsigned long long)root_st.st_dev != root_device', ''),
        ('root without symlinks', 'O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };\n    int root = (int)syscall(SYS_openat2, AT_FDCWD, argv[2], &browse_root_how', 'O_PATH | O_DIRECTORY | O_CLOEXEC, .resolve = RESOLVE_NO_MAGICLINKS };\n    int root = (int)syscall(SYS_openat2, AT_FDCWD, argv[2], &browse_root_how'),
        ('the seal', 'if (browse_seal()) {', 'if (0 && browse_seal()) {'),
    ]

    def mutant_build(self, source, name, old, new, extra=()):
        text = source.read_text()
        self.assertEqual(text.count(old), 1, name)
        directory = self.build_dir / ('mutant-' + re.sub('[^a-z0-9]+', '-', name))
        directory.mkdir(exist_ok=True)
        (directory / source.name).write_text(text.replace(old, new))
        return self.build(directory / source.name, 'mutant-' + re.sub('[^a-z0-9]+', '-', name) + '-bin', extra)

    def worker_outcomes(self, worker, root, share):
        """What one worker build answers in every browse scenario, through the launcher and through the host-tree harness."""
        def outcome(runner):
            try:
                return runner()
            except (subprocess.TimeoutExpired, AssertionError, ValueError) as error:
                return 'error:' + type(error).__name__
        def via_launcher(relative):
            code, out, _ = self.launch(root, 'stat', relative, worker=worker)
            value = json.loads(out)
            return (code, value.get('code'), value.get('ok'))
        def via_harness(relative, target=root, device=None):
            argv = [str(self.harness), str(worker), str(self.BROWSE), str(self.GID), 'stat', str(target), relative, '1024', '0', str(os.stat(target).st_dev if device is None else device)]
            run = subprocess.run(argv, capture_output=True, timeout=5)
            value = json.loads(run.stdout)
            return (run.returncode, value.get('code'), value.get('ok'))
        link = root.parent / 'root-link'
        if not link.is_symlink():
            link.symlink_to('r')
        return [outcome(lambda: via_launcher('seed.txt')), outcome(lambda: via_launcher('link.txt')), outcome(lambda: via_launcher('dir')), outcome(lambda: via_launcher('linked.txt')),
                outcome(lambda: via_harness('../r/seed.txt')), outcome(lambda: via_harness('nested/below.txt')), outcome(lambda: via_harness('fifo')),
                outcome(lambda: via_harness('shared.txt', target=share)), outcome(lambda: via_harness('seed.txt', device=os.stat(root).st_dev + 1)),
                outcome(lambda: via_harness('seed.txt', target=link))]

    def test_built_in_mutants_of_the_browse_guards(self):
        root = self.root('mutants')
        share = root.parent / 'share'
        share.mkdir()
        subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=2770,gid=%d' % self.GID, 'tmpfs', str(share)], check=True)
        type(self).mounts.append(share)
        self.write(share / 'shared.txt', b'shared')
        nested = root / 'nested'
        nested.mkdir()
        subprocess.run(['mount', '-t', 'tmpfs', '-o', 'mode=2770,gid=%d' % self.GID, 'tmpfs', str(nested)], check=True)
        type(self).mounts.append(nested)
        self.write(nested / 'below.txt', b'below')
        survivors, total = [], 0
        expected = self.worker_outcomes(self.worker, root, share)
        self.assertEqual([item[1] if isinstance(item, tuple) else item for item in expected],
                         [None, 'path_denied', 'not_regular', 'linked', 'path_denied', 'path_denied', 'not_regular', 'root_not_data', 'root_not_data', 'root_unavailable'])
        for name, old, new in self.TOOL_MUTANTS:
            total += 1
            launcher = self.mutant_build(TOOL, name, old, new)
            def probe(mutate=None):
                code, out, _ = self.launch(root, 'stat', 'seed.txt', worker=self.probe, launcher=launcher, mutate=mutate)
                return code, (json.loads(out)['writeOpen'] if code == 0 else None)
            two_roots = lambda argv: argv[:14] + ['2'] + argv[15:] + [argv[15], '/workspace/repos/r2', '1']
            outcomes = [probe(lambda argv: argv[:7] + ['auto'] + argv[8:]), probe(two_roots), probe(lambda argv: argv[:10] + ['/workspace/repos/other'] + argv[11:]),
                        probe(lambda argv: argv[:9] + ['read'] + argv[10:])]
            code, out, _ = self.launch(root, 'stat', 'seed.txt', launcher=launcher, extra=['--guidance', '3'])
            outcomes.append((code, None))
            code, out, _ = self.launch(root, 'stat', 'seed.txt', launcher=launcher)
            outcomes.append((code, json.loads(out).get('ok') if out else None))
            if outcomes == [(0, 30), (64, None), (64, None), (64, None), (64, None), (0, True)]:
                survivors.append(name)
        for name, old, new in self.WORKER_MUTANTS:
            total += 1
            mutant = self.mutant_build(WORKER, name, old, new, ['-DWINTER_BROWSE_SEAL_PROBE'] if name == 'the seal' else [])
            if name == 'the seal':
                value = self.result(root, 'stat', 'seed.txt', worker=mutant)
                if value.get('probe') == [1, 1, 1, 1, 1, 1, 1]:
                    survivors.append(name)
                continue
            if self.worker_outcomes(mutant, root, share) == expected:
                survivors.append(name)
        print('\nbrowse C mutants: %d/%d killed; survivors: %s' % (total - len(survivors), total, survivors), file=sys.stderr)
        self.assertEqual(survivors, [])

    def test_root_service_end_to_end(self):
        """Root's BrowseLauncher and GuestFileService over real FIFOs, with the real launcher and worker."""
        root = self.root()
        os.chown(self.launcher, 0, 0)
        os.chown(self.worker, 0, 0)
        artifacts = {'launcher': os.open(self.launcher, os.O_RDONLY | os.O_CLOEXEC), 'fileWorker': os.open(self.worker, os.O_RDONLY | os.O_CLOEXEC)}
        pins = {name: sha(path) for name, path in (('launcher', self.launcher), ('fileWorker', self.worker))}
        environment = os.open(self.environment, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        retained = []
        views = self.base / 'service-views'
        views.mkdir(mode=0o700)
        views.chmod(0o700)
        launcher = service.BrowseLauncher(artifacts=artifacts, pins=pins, environment=environment, directory=views, uid=self.BROWSE, retained=retained)
        held = conversations()
        held['logical']['roots'][LOCATION]['fd'] = root_fd
        held['logical']['workspaceGid'] = self.GID
        device = os.stat(root).st_dev

        def resolve(req):
            item, binding = service.file_binding(held, req)
            if not service.file_root_admitted(binding['fd'], device, item['workspaceGid']):
                raise service.FileRefusal('file_unavailable')
            return {'guestPath': binding['root']['guestPath'], 'gid': item['workspaceGid'], 'fd': binding['fd']}
        inbound, host_write = fifo_pair()
        host_read, outbound = fifo_pair()
        ports = service.FileChannelPorts(inbound, outbound)
        os.close(inbound)
        os.close(outbound)
        os.set_blocking(host_write, True)
        file_service = service.GuestFileService(ports=ports, resolve=resolve, launch=launcher.run)
        try:
            file_service.start()
            st = os.stat(root / 'seed.txt')
            token = service.file_generation(INCARNATION, (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode, st.st_nlink, st.st_uid))
            for value in (request(relativePath='seed.txt'), request('readRange', requestId='%08x-0000-4000-8000-%012x' % (2, 2), relativePath='seed.txt', expectedGeneration=token, offset=2, maxBytes=3),
                          request(requestId='%08x-0000-4000-8000-%012x' % (3, 3), relativePath='private.txt'), request(requestId='%08x-0000-4000-8000-%012x' % (4, 4), relativePath='nope'),
                          request(requestId='%08x-0000-4000-8000-%012x' % (5, 5), relativePath='seed.txt', incarnationId='incarnation-9')):
                os.write(host_write, line(value))
            buffer = b''
            deadline = time.monotonic() + 30
            while buffer.count(b'\n') < 5 and time.monotonic() < deadline:
                try:
                    buffer += os.read(host_read, 1 << 20)
                except BlockingIOError:
                    time.sleep(.02)
            answers = {value['requestId']: value for value in map(json.loads, buffer.splitlines())}
            self.assertEqual(answers[REQUEST_ID]['generation'], token)
            self.assertEqual(base64.b64decode(answers['%08x-0000-4000-8000-%012x' % (2, 2)]['contentBase64']), b'234')
            self.assertEqual([answers['%08x-0000-4000-8000-%012x' % (n, n)]['code'] for n in (3, 4, 5)], ['file_unavailable', 'file_missing', 'stale_file'])
            os.close(host_write)
            host_write = None
            self.assertTrue(file_service.stop())
            self.assertEqual(retained, [])
            self.assertEqual(os.listdir(views), [])
        finally:
            for fd in (host_write, host_read, environment, root_fd, *artifacts.values()):
                if fd is not None:
                    with contextlib.suppress(OSError):
                        os.close(fd)


if __name__ == '__main__':
    unittest.main()

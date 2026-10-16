"""Source-only guided Root producer tests. Never start a service or a native process.

Covers the pure guided builders, the record Root would send, the fifth descriptor and the
profile-selection rules. A successful record or descriptor count is DATA: nothing here
admits a native owner, serves a reader or enables Cowork.
"""
import hashlib
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_fresh_protocol as fresh  # noqa: E402
import test_host_query as hq  # noqa: E402

service = fresh.service
AUTH = hq.AUTH
GUIDED = 'host-query-guided-v1'
BOOT = '00000000-0000-0000-0000-000000000000'
BINDING = '5f6e7d8c-0000-4000-a000-00000000000b'
REGISTRATION = '1b2c3d4e-0000-4000-8000-00000000000a'
REQUIREMENT = {'version': 1, 'bindingId': BINDING}
EXACT_LIMITS = {'maxFileBytes': 131072, 'maxReadBytes': 262144, 'maxReadOccurrences': 256, 'maxExpandedBytes': 131072}

# Canonical records the UNCHANGED v1 and fresh profiles produced on origin/main (6a6425a1), for
# the fixed inputs of GoldenRecordTests. Any byte change here is a v1/fresh contract change.
GOLDEN_V1 = '{"authority":{"configRevision":2,"grantRevision":3,"incarnationId":"incarnation","leaseEpoch":1,"policyRevision":4,"sessionId":"backend","workspaceId":"workspace"},"freshOnly":true,"logicalSessionId":"logical","ownerToken":"abababababababababababababababababababababababababababababababab","profile":"host-query-v1","protocolVersion":1,"provider":{"scope":{"accountRevision":1,"backendSessionId":"backend","bootId":"00000000-0000-0000-0000-000000000000","grantRevision":3,"homeId":"home","incarnationId":"incarnation","leaseEpoch":1,"modelRevision":1,"sessionId":"logical","taskId":"task","workspaceId":"workspace"},"selection":{"capabilities":{"toolCalling":"native"},"family":"openai","modelKey":"openai/fixture","protocol":"openai-responses","providerId":"openai","providerModelId":"fixture"}},"roots":[{"guestPath":"/workspace/folders/source","id":"source","readOnly":false}],"runtimeConfig":{"allowDangerouslySkipPermissions":false,"allowedTools":[],"cwd":"/workspace/folders/source","executionPosture":"confined-guest","mcpServers":{},"model":"openai/fixture","permissionMode":"default","permissions":{"disableBypassPermissionsMode":true},"persistSession":true,"plugins":[],"sessionId":"backend","settingSources":[],"skills":[],"storeHome":"/workspace/.winter/conversations/logical","strictMcpConfig":true,"tools":["Read","Edit","Write","Bash"],"winterHome":"/run/winter/conversations/logical"},"runtimeUid":20001,"scope":{"currentBootId":"00000000-0000-0000-0000-000000000000","incarnationId":"incarnation","leaseEpoch":1,"sessionId":"backend","storeHome":"/workspace/.winter/conversations/logical","workspaceId":"workspace"},"toolSocketPath":"/run/winter/conversations/logical/.control/tools.sock","toolUid":10001,"workspaceGid":10000}'
GOLDEN_FRESH_SHA256 = '0f8eb6f1bd58eafd978a2d5b6673e9f52a41425483a0a1a920cafafebed8d048'


def pure_item(policy='ask', guest_path='/workspace/folders/source'):
    root = service.runtime_root_metadata({'id': 'source', 'guestPath': guest_path, 'readOnly': False}, policy, True)
    return {'logicalSessionId': 'logical', 'runtimeUid': 20001, 'toolUid': 10001, 'workspaceGid': 10000, 'authority': dict(AUTH),
            'policy': policy, 'revoked': False, 'roots': {'source': {'root': root}}}


class GoldenRecordTests(unittest.TestCase):
    """The v1 and fresh records stay byte-identical; guided is additive."""

    def setUp(self):
        self.obj = service.ToolService.__new__(service.ToolService)
        self.obj.guest_boot = BOOT
        self.item = pure_item()
        self.provider = {'scope': {'homeId': 'home', 'workspaceId': 'workspace', 'sessionId': 'logical', 'backendSessionId': 'backend', 'taskId': 'task',
                                   'incarnationId': 'incarnation', 'bootId': BOOT, 'leaseEpoch': 1, 'grantRevision': 3, 'accountRevision': 1, 'modelRevision': 1},
                         'selection': {'providerId': 'openai', 'modelKey': 'openai/fixture', 'providerModelId': 'fixture', 'family': 'openai',
                                       'protocol': 'openai-responses', 'capabilities': {'toolCalling': 'native'}}}
        self.base = {'ownerToken': 'ab' * 32, 'provider': self.provider, 'model': 'openai/fixture', 'state': 'configured'}

    def test_v1_record_bytes_are_unchanged(self):
        config = service.host_query_config(self.item, ['read', 'write', 'execute'], 'openai/fixture')
        runtime = dict(self.base, profile='host-query-v1', hostConfig=config)
        self.assertEqual(service.canonical(self.obj._runtime_record(self.item, runtime)), GOLDEN_V1)

    def test_fresh_record_is_unchanged_and_carries_no_guided_surface(self):
        record = self.obj._runtime_record(self.item, dict(self.base))
        self.assertEqual(hashlib.sha256(service.canonical(record).encode()).hexdigest(), GOLDEN_FRESH_SHA256)
        for key in ('profile', 'readerRegistration'):
            self.assertNotIn(key, record)
        self.assertNotIn('requiredRuntimeContext', record['runtimeConfig'])

    def test_v1_record_never_gains_the_guided_fields_even_if_runtime_state_carries_them(self):
        config = service.host_query_config(self.item, ['read'], 'openai/fixture')
        registration = service.guided_reader_registration(self.item, dict(config, requiredRuntimeContext=REQUIREMENT), BOOT, REGISTRATION, 1)
        record = self.obj._runtime_record(self.item, dict(self.base, profile='host-query-v1', hostConfig=config, readerRegistration=registration))
        self.assertNotIn('readerRegistration', record)
        self.assertEqual(record['profile'], 'host-query-v1')
        self.assertNotIn('requiredRuntimeContext', record['runtimeConfig'])


class GuidedBuilderTests(unittest.TestCase):
    def test_guided_config_is_the_v1_config_plus_only_the_required_context(self):
        for policy in ('auto', 'ask', 'plan', 'accept-edits', 'dont-ask', 'bypass'):
            item = pure_item(policy)
            v1 = service.host_query_config(item, ['read', 'write', 'execute'], 'openai/fixture')
            guided = service.guided_host_query_config(item, ['read', 'write', 'execute'], 'openai/fixture', REQUIREMENT)
            self.assertEqual({key: value for key, value in guided.items() if key != 'requiredRuntimeContext'}, v1)
            self.assertEqual(guided['requiredRuntimeContext'], REQUIREMENT)
            self.assertEqual(guided['allowedTools'], [])

    def test_guided_config_copies_the_correlation(self):
        requirement = dict(REQUIREMENT)
        config = service.guided_host_query_config(pure_item(), ['read'], 'model', requirement)
        requirement['bindingId'] = 'mutated'
        self.assertEqual(config['requiredRuntimeContext'], REQUIREMENT)

    def test_registration_binds_scope_views_exact_limits_and_correlation(self):
        item = pure_item()
        config = service.guided_host_query_config(item, ['read'], 'model', REQUIREMENT)
        registration = service.guided_reader_registration(item, config, BOOT, REGISTRATION, 7)
        self.assertEqual(set(registration), {'version', 'registrationId', 'owner', 'views', 'limits', 'requiredRuntimeContext'})
        self.assertEqual(registration['version'], 1)
        self.assertEqual(registration['registrationId'], REGISTRATION)
        self.assertEqual(registration['owner'], {'workspaceId': 'workspace', 'logicalSessionId': 'logical', 'backendSessionId': 'backend',
                                                 'incarnationId': 'incarnation', 'leaseEpoch': 1, 'bootId': BOOT, 'generation': 7})
        self.assertEqual(registration['views'], {'sourceRoot': '/workspace/folders/source', 'sourceCwd': '/workspace/folders/source',
                                                 'sharedRoot': '/run/winter/shared-instructions', 'sharedPath': '/run/winter/shared-instructions/WINTER.md'})
        self.assertEqual(registration['limits'], EXACT_LIMITS)
        self.assertIsNot(registration['limits'], service.GUIDED_READER_LIMITS)
        self.assertEqual(registration['requiredRuntimeContext'], REQUIREMENT)
        self.assertEqual(config['cwd'], registration['views']['sourceCwd'])
        self.assertEqual(config['sessionId'], registration['owner']['backendSessionId'])
        self.assertEqual(config['requiredRuntimeContext']['bindingId'], registration['requiredRuntimeContext']['bindingId'])

    def test_limit_constants_are_exact(self):
        self.assertEqual(service.GUIDED_READER_LIMITS, EXACT_LIMITS)
        self.assertEqual(service.GUIDED_SHARED_PATH, '/run/winter/shared-instructions/WINTER.md')

    def test_repos_source_roots_are_accepted(self):
        item = pure_item(guest_path='/workspace/repos/project-1')
        config = service.guided_host_query_config(item, ['read'], 'model', REQUIREMENT)
        registration = service.guided_reader_registration(item, config, BOOT, REGISTRATION, 1)
        self.assertEqual(registration['views']['sourceRoot'], '/workspace/repos/project-1')

    def test_correlation_must_be_the_closed_uuid4_shape(self):
        for value in (None, [], 'x', {}, {'version': 1}, {'bindingId': BINDING}, {'version': 1, 'bindingId': BINDING, 'extra': 1},
                      {'version': True, 'bindingId': BINDING}, {'version': 2, 'bindingId': BINDING}, {'version': '1', 'bindingId': BINDING},
                      {'version': 1, 'bindingId': BINDING.upper()}, {'version': 1, 'bindingId': BINDING + '\n'}, {'version': 1, 'bindingId': 7},
                      {'version': 1, 'bindingId': '5f6e7d8c-0000-1000-a000-00000000000b'}, {'version': 1, 'bindingId': '5f6e7d8c-0000-4000-c000-00000000000b'},
                      {'version': 1, 'bindingId': 'not-a-uuid'}, {'version': 1.0, 'bindingId': BINDING}):
            with self.assertRaisesRegex(service.Refusal, 'guided_context', msg=repr(value)):
                service.guided_requirement(value)

    def test_generation_must_be_a_positive_safe_integer(self):
        for value in (None, 0, -1, True, False, 1.0, '1', [], 2 ** 53):
            with self.assertRaisesRegex(service.Refusal, 'guided_generation', msg=repr(value)):
                service.guided_generation(value)
        for value in (1, 2 ** 53 - 1):
            self.assertEqual(service.guided_generation(value), value)

    def test_scope_and_roots_the_guest_validators_would_refuse_are_refused_by_root_first(self):
        item = pure_item()
        config = service.guided_host_query_config(item, ['read'], 'model', REQUIREMENT)
        zero_lease = pure_item()
        zero_lease['authority']['leaseEpoch'] = 0
        with self.assertRaisesRegex(service.Refusal, 'guided_scope'):
            service.guided_reader_registration(zero_lease, config, BOOT, REGISTRATION, 1)
        for boot in (None, '', 'boot', '0000000A-0000-0000-0000-000000000000', BOOT + '\n', 'z' * 36):
            with self.assertRaisesRegex(service.Refusal, 'guided_scope', msg=repr(boot)):
                service.guided_reader_registration(item, config, boot, REGISTRATION, 1)
        for registration_id in (None, '', BOOT, REGISTRATION.upper(), '1b2c3d4e-0000-1000-8000-00000000000a'):
            with self.assertRaisesRegex(service.Refusal, 'guided_registration', msg=repr(registration_id)):
                service.guided_reader_registration(item, config, BOOT, registration_id, 1)
        with self.assertRaisesRegex(service.Refusal, 'guided_generation'):
            service.guided_reader_registration(item, config, BOOT, REGISTRATION, 0)
        with self.assertRaisesRegex(service.Refusal, 'guided_context'):
            service.guided_reader_registration(item, {k: v for k, v in config.items() if k != 'requiredRuntimeContext'}, BOOT, REGISTRATION, 1)
        for path in ('/workspace/folders/a/b', '/workspace/outputs/logical', '/workspace/folders', '/workspace/other/source', '/workspace/folders/bad name'):
            wrong = pure_item(guest_path=path)
            wrong_config = dict(service.host_query_config(wrong, ['read'], 'model'), requiredRuntimeContext=REQUIREMENT)
            with self.assertRaisesRegex(service.Refusal, 'guided_roots', msg=path):
                service.guided_reader_registration(wrong, wrong_config, BOOT, REGISTRATION, 1)

    def test_bootstrap_rights_are_four_descriptors_for_v1_and_fresh_and_five_for_guided(self):
        for profile in (None, 'fresh', 'host-query-v1'):
            self.assertEqual(list(service.bootstrap_rights(profile, 10, 11, 12, 13)), [10, 11, 12, 13])
            with self.assertRaisesRegex(service.Refusal, 'runtime_profile_conflict'):
                service.bootstrap_rights(profile, 10, 11, 12, 13, 14)
        self.assertEqual(list(service.bootstrap_rights(GUIDED, 10, 11, 12, 13, 14)), [10, 11, 12, 13, 14])
        for reader in (None, -1, True, '14', 1.5):
            with self.assertRaisesRegex(service.Refusal, 'guided_reader_channel', msg=repr(reader)):
                service.bootstrap_rights(GUIDED, 10, 11, 12, 13, reader)

    def test_profile_is_selected_only_by_exactly_one_root_config_key(self):
        self.assertEqual(service.select_runtime_profile({}), 'fresh')
        self.assertEqual(service.select_runtime_profile({'freshRuntime': {}}), 'fresh')
        self.assertEqual(service.select_runtime_profile({'hostQueryRuntime': {}}), 'host-query-v1')
        self.assertEqual(service.select_runtime_profile({'hostQueryGuidedRuntime': {}}), GUIDED)
        for config in ({'hostQueryRuntime': {}, 'hostQueryGuidedRuntime': {}}, {'freshRuntime': {}, 'hostQueryGuidedRuntime': {}},
                       {'freshRuntime': {}, 'hostQueryRuntime': {}}, {'freshRuntime': {}, 'hostQueryRuntime': {}, 'hostQueryGuidedRuntime': {}}):
            with self.assertRaisesRegex(service.Refusal, 'runtime_profile_conflict'):
                service.select_runtime_profile(config)
        # A "profile" string in config is not a selector.
        self.assertEqual(service.select_runtime_profile({'profile': GUIDED, 'runtimeProfile': GUIDED}), 'fresh')

    def test_each_conversation_may_carry_only_the_selected_profile_key(self):
        for runtime_key in ('freshRuntime', 'hostQueryRuntime', 'hostQueryGuidedRuntime'):
            self.assertFalse(service.item_profile_conflict({runtime_key: {}}, runtime_key))
            self.assertFalse(service.item_profile_conflict({}, runtime_key))
        self.assertTrue(service.item_profile_conflict({'hostQueryRuntime': {}}, 'hostQueryGuidedRuntime'))
        self.assertTrue(service.item_profile_conflict({'hostQueryGuidedRuntime': {}}, 'hostQueryRuntime'))
        self.assertTrue(service.item_profile_conflict({'hostQueryGuidedRuntime': {}}, 'freshRuntime'))
        self.assertTrue(service.item_profile_conflict({'hostQueryRuntime': {}, 'hostQueryGuidedRuntime': {}}, 'hostQueryGuidedRuntime'))

    def test_service_constructor_refuses_host_query_with_the_guided_key_before_any_effect(self):
        config = {'guestBootId': BOOT, 'hostQueryRuntime': {}, 'hostQueryGuidedRuntime': {}, 'conversations': []}
        flags = SimpleNamespace(isolated=1, no_site=1)
        with patch.object(service.sys, 'platform', 'linux'), patch.object(service.os, 'geteuid', return_value=0), \
                patch.object(service.sys, 'flags', flags), patch.object(service.Path, 'read_text', return_value=BOOT + '\n'), \
                patch.object(service, 'pinned_artifact') as pin:
            with self.assertRaisesRegex(service.Refusal, 'runtime_profile_conflict'):
                service.ToolService(config)
            pin.assert_not_called()


class GuidedConfiguredRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fresh.FreshProtocolTests()
        self.fixture.setUp()
        self.pipes = hq.Pipes()
        self.obj = self.fixture.obj
        self.obj.directory = self.fixture.root
        (self.obj.directory / 'logical').mkdir()
        self.obj.host_query_ports = {'logical': self.pipes.ports}
        self.obj.runtime_pins = {'fixture': 'test-pin'}
        self.fixture.item['roots']['source']['fd'] = -9
        self.fixture.item.update(policy='ask', authority=dict(AUTH))
        self.fixture.provider['scope']['grantRevision'] = AUTH['grantRevision']
        self.config = {**self.fixture.config, 'toolClasses': ['read', 'write', 'execute'], 'requiredRuntimeContext': dict(REQUIREMENT), 'generation': 1}

    def tearDown(self):
        self.pipes.close()
        self.fixture.tearDown()

    def configure(self, config=None, profile=GUIDED):
        with patch.object(service.uuid, 'uuid4', return_value=uuid.UUID(REGISTRATION)):
            self.obj._configure_runtime(self.fixture.item, self.config if config is None else config, profile=profile)
        return self.obj.runtimes['logical']

    def test_record_carries_profile_registration_and_config_correlation_for_guided_only(self):
        runtime = self.configure()
        record = self.obj._runtime_record(self.fixture.item, runtime)
        self.assertEqual(record['profile'], GUIDED)
        self.assertEqual(record['protocolVersion'], 1)
        self.assertTrue(record['freshOnly'])
        self.assertEqual(record['runtimeConfig']['requiredRuntimeContext'], REQUIREMENT)
        self.assertEqual(record['runtimeConfig']['allowedTools'], [])
        self.assertEqual(record['runtimeConfig']['tools'], ['Read', 'Edit', 'Write', 'Bash'])
        registration = record['readerRegistration']
        self.assertEqual(registration['registrationId'], REGISTRATION)
        self.assertEqual(registration['requiredRuntimeContext'], record['runtimeConfig']['requiredRuntimeContext'])
        self.assertEqual(registration['limits'], EXACT_LIMITS)
        scope, owner = record['scope'], registration['owner']
        self.assertEqual((owner['workspaceId'], owner['backendSessionId'], owner['incarnationId'], owner['leaseEpoch'], owner['bootId']),
                         (scope['workspaceId'], scope['sessionId'], scope['incarnationId'], scope['leaseEpoch'], scope['currentBootId']))
        self.assertEqual(owner['logicalSessionId'], record['logicalSessionId'])
        self.assertEqual(owner['generation'], 1)
        self.assertEqual(registration['views']['sourceRoot'], record['roots'][0]['guestPath'])
        self.assertEqual(record['authority'], AUTH)
        self.assertEqual(record['roots'], [self.fixture.item['roots']['source']['root']])
        # Later edits to Root's input cannot reach stored runtime state.
        self.config['requiredRuntimeContext']['bindingId'] = 'mutated'
        self.assertEqual(runtime['readerRegistration']['requiredRuntimeContext'], REQUIREMENT)
        self.assertEqual(self.obj._runtime_record(self.fixture.item, runtime)['readerRegistration'], registration)

    def test_unpatched_registration_id_is_a_fresh_lowercase_uuid4(self):
        self.obj._configure_runtime(self.fixture.item, self.config, profile=GUIDED)
        registration_id = self.obj.runtimes['logical']['readerRegistration']['registrationId']
        self.assertTrue(service.GUIDED_UUID4.fullmatch(registration_id))
        self.assertNotEqual(registration_id, REGISTRATION)

    def test_record_refuses_if_config_and_registration_correlation_diverge(self):
        runtime = self.configure()
        runtime['readerRegistration']['requiredRuntimeContext']['bindingId'] = '5f6e7d8c-0000-4000-a000-0000000000ff'
        with self.assertRaisesRegex(service.Refusal, 'guided_context'):
            self.obj._runtime_record(self.fixture.item, runtime)

    def test_plan_policy_keeps_the_read_only_root_clamp(self):
        self.fixture.item['policy'] = 'plan'
        self.fixture.item['roots']['source']['root'] = service.runtime_root_metadata(self.fixture.item['roots']['source']['root'], 'plan', True)
        runtime = self.configure()
        record = self.obj._runtime_record(self.fixture.item, runtime)
        self.assertEqual(record['runtimeConfig']['permissionMode'], 'plan')
        self.assertTrue(record['roots'][0]['readOnly'])

    def test_v1_and_fresh_profiles_refuse_every_guided_key(self):
        # Each base is otherwise valid for its profile, so the guided key alone is what must be refused.
        v1 = {k: v for k, v in self.config.items() if k not in ('requiredRuntimeContext', 'generation')}
        for profile, base in (('host-query-v1', v1), ('fresh', self.fixture.config)):
            self.assertEqual(set(base) & {'requiredRuntimeContext', 'generation', 'readerRegistration', 'profile'}, set())
            for key, value in (('requiredRuntimeContext', dict(REQUIREMENT)), ('generation', 1), ('readerRegistration', {}), ('profile', GUIDED)):
                with self.assertRaisesRegex(service.Refusal, 'runtime_config', msg=f'{profile} {key}'):
                    self.obj._configure_runtime(self.fixture.item, {**base, key: value}, profile=profile)
            self.assertEqual(self.obj.owned, [])
            self.assertEqual(self.pipes.ports.phase, 'new')

    def test_json_cannot_choose_authority_profile_or_registration_data(self):
        for key in ('argv', 'env', 'settings', 'profile', 'runtimeProfile', 'runtimeConfig', 'resume', 'readerRegistration', 'registrationId', 'owner',
                    'views', 'limits', 'sharedPath', 'sourceRoot', 'channelFd', 'bootId', 'workspaceId'):
            with self.assertRaisesRegex(service.Refusal, 'runtime_config', msg=key):
                self.obj._configure_runtime(self.fixture.item, {**self.config, key: {}}, profile=GUIDED)
        self.assertEqual(self.obj.owned, [])
        self.assertEqual(self.pipes.ports.phase, 'new')
        # Only the SDK-owned name is accepted as the correlation, and only with its closed shape.
        with self.assertRaisesRegex(service.Refusal, 'guided_context'):
            self.obj._configure_runtime(self.fixture.item, {**self.config, 'requiredRuntimeContext': {**REQUIREMENT, 'profile': GUIDED}}, profile=GUIDED)

    def test_missing_or_invalid_correlation_refuses_before_transport_or_store_open(self):
        without_context = {k: v for k, v in self.config.items() if k != 'requiredRuntimeContext'}
        without_generation = {k: v for k, v in self.config.items() if k != 'generation'}
        for config, code in ((without_context, 'guided_context'), (without_generation, 'guided_generation'), ({**self.config, 'generation': 0}, 'guided_generation'),
                             ({**self.config, 'requiredRuntimeContext': {'version': 1, 'bindingId': 'x'}}, 'guided_context')):
            with self.assertRaisesRegex(service.Refusal, code):
                self.obj._configure_runtime(self.fixture.item, config, profile=GUIDED)
            self.assertEqual(self.obj.owned, [])
            self.assertEqual(self.pipes.ports.phase, 'new')
        self.assertEqual(self.obj.runtimes, {})

    def test_missing_transport_refuses_like_v1(self):
        self.obj.host_query_ports = {'logical': {'inputFd': self.pipes.input, 'profile': GUIDED}}
        with self.assertRaisesRegex(service.Refusal, 'host_query_transport'):
            self.configure()
        self.assertEqual(self.obj.owned, [])

    def test_admin_and_tool_requests_cannot_select_a_profile(self):
        self.obj.runtimes = {}
        for request in ({'operation': 'launch-runtime', 'sessionId': 'logical', 'profile': GUIDED},
                        {'operation': 'launch-runtime', 'sessionId': 'logical', 'readerRegistration': {}},
                        {'operation': 'launch-runtime', 'sessionId': 'logical', 'requiredRuntimeContext': dict(REQUIREMENT)}):
            near, far = socket.socketpair()
            try:
                service.frame_write(near, request)
                with self.assertRaisesRegex(service.Refusal, 'admin_request'):
                    self.obj._admin(far)
            finally:
                near.close()
                far.close()
        envelope = {'kind': 'file', 'request': {}, 'ticket': 'ticket', 'profile': GUIDED}
        near, far = socket.socketpair()
        try:
            service.frame_write(near, envelope)
            with self.assertRaisesRegex(service.Refusal, 'request_shape'):
                self.obj._request('logical', far)
        finally:
            near.close()
            far.close()
        denial_near, denial_far = socket.socketpair()
        try:
            service.frame_write(denial_near, {'kind': 'reserve', 'toolKind': 'file', 'request': {}, 'profile': GUIDED})
            self.obj._request('logical', denial_far)
            reply = service.frame_read(denial_near)
            self.assertEqual(json.loads(reply['stdout'])['code'], 'invalid_request')
        finally:
            denial_near.close()
            denial_far.close()
        self.assertEqual(self.obj.runtimes, {})

    # ----- the real send path, with an injected (non-native) process, selector and sockets -----

    def injected_start(self, guided=True):
        if guided:
            runtime = self.configure()
        else:
            v1 = {k: v for k, v in self.config.items() if k not in ('requiredRuntimeContext', 'generation')}
            runtime = self.configure(v1, profile='host-query-v1')
        self.obj.runtime_artifacts = {'launcher': 10, 'executable': 11, 'ownerLibrary': 12}
        self.obj.runtime_pins = {name: 'test-pin' for name in self.obj.runtime_artifacts}
        self.obj.environment = -1
        control, parent, bootstrap, guest = [MagicMock() for _ in range(4)]
        for fd, channel in enumerate((control, parent, bootstrap, guest), 100):
            channel.fileno.return_value = fd
        pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM) if guided else None
        seen = {}

        def send(buffers, ancillary, *args):
            if pair is not None:
                seen['root_open_at_send'] = pair[0].fileno() != -1
                seen['guest_fd_at_send'] = pair[1].fileno()
                seen['guest_type'] = pair[1].getsockopt(socket.SOL_SOCKET, socket.SO_TYPE)
            return len(buffers[0])

        def receive(count):
            receipt = next(receipts)
            if pair is not None:
                seen['guest_closed_in_loop'] = pair[1].fileno() == -1
                seen['root_open_in_loop'] = pair[0].fileno() != -1
            return receipt
        receipts = iter([b'R' + struct.pack('=I', 0), b''])
        bootstrap.sendmsg.side_effect = send
        control.recv.side_effect = receive
        child = self.pipes.child
        child.wait = MagicMock(return_value=0)
        child.kill = MagicMock()
        stdout_fd, stderr_fd = child.stdout.fileno(), child.stderr.fileno()
        chunks = {stdout_fd: iter([b'{"type":"init"}\n', b'']), stderr_fd: iter([b'bounded stderr\n', b''])}
        original_read, original_close = service.os.read, service.os.close

        def read(fd, count):
            return next(chunks[fd], b'') if fd in chunks else original_read(fd, count)

        def event(fd, route):
            return SimpleNamespace(fd=fd, fileobj=fd, data=('duplex', route))
        selector = MagicMock()
        selector.get_map.side_effect = [True, True, True, False]
        selector.select.side_effect = [
            [(event(stdout_fd, 'child-stdout'), 1), (event(stderr_fd, 'child-stderr'), 1)],
            [(SimpleNamespace(fileobj=control, data=None), 1), (event(self.pipes.ports.fds['stdout'], 'host-stdout'), 2),
             (event(self.pipes.ports.fds['stderr'], 'host-stderr'), 2), (event(stdout_fd, 'child-stdout'), 1), (event(stderr_fd, 'child-stderr'), 1)],
            [(SimpleNamespace(fileobj=control, data=None), 1)]]
        pairs = [(control, parent), (bootstrap, guest)] + ([pair] if guided else [])
        # A third socketpair for v1 (or a fourth for guided) exhausts side_effect and fails the test loudly.
        with patch.object(service, 'verify_held_artifact'), patch.object(service.socket, 'socketpair', side_effect=pairs) as pairing, \
                patch.object(service.subprocess, 'Popen', return_value=child), patch.object(service, 'receive_init_pidfd', return_value=600), \
                patch.object(service.os, 'pidfd_open', return_value=700, create=True), patch.object(service.selectors, 'DefaultSelector', return_value=selector), \
                patch.object(service.os, 'read', side_effect=read), patch.object(service.os, 'close', side_effect=lambda fd: None if fd in (600, 700) else original_close(fd)), \
                patch.object(service.signal, 'pidfd_send_signal', create=True):
            try:
                self.obj._run_runtime(self.fixture.item, runtime)
            finally:
                if pair is not None:
                    seen['final_closed'] = (pair[0].fileno() == -1, pair[1].fileno() == -1)
                    for end in pair:
                        end.close()
        return runtime, bootstrap, seen, pairing

    def test_guided_start_sends_five_descriptors_with_the_reader_channel_last(self):
        runtime, bootstrap, seen, pairing = self.injected_start(guided=True)
        self.assertEqual(runtime['state'], 'stopped')
        self.assertTrue(runtime['cleanupConfirmed'])
        buffers, ancillary = bootstrap.sendmsg.call_args.args[:2]
        self.assertEqual(len(ancillary), 1)
        level, kind, rights = ancillary[0]
        self.assertEqual((level, kind), (socket.SOL_SOCKET, socket.SCM_RIGHTS))
        self.assertEqual(len(rights), 5)
        self.assertEqual(list(rights)[:4], [600, 700, runtime['fds']['storeDirectory'], 11])
        self.assertEqual(rights[4], seen['guest_fd_at_send'])
        self.assertEqual(seen['guest_type'], socket.SOCK_STREAM)
        self.assertEqual(pairing.call_count, 3)
        self.assertEqual(pairing.call_args_list[2].args, (socket.AF_UNIX, socket.SOCK_STREAM))
        sent = json.loads(buffers[0])
        self.assertEqual(sent, self.obj._runtime_record(self.fixture.item, runtime))
        self.assertEqual(sent['profile'], GUIDED)
        self.assertIn('readerRegistration', sent)
        self.assertEqual(sent['runtimeConfig']['requiredRuntimeContext'], sent['readerRegistration']['requiredRuntimeContext'])

    def test_guided_reader_channel_ownership_root_keeps_its_end_until_the_run_is_over(self):
        _, _, seen, _ = self.injected_start(guided=True)
        self.assertTrue(seen['root_open_at_send'])
        self.assertTrue(seen['guest_closed_in_loop'], 'Root must drop its copy of the guest end after the transfer')
        self.assertTrue(seen['root_open_in_loop'], 'closing Root end would end the native owner')
        self.assertEqual(seen['final_closed'], (True, True))

    def test_v1_start_still_sends_exactly_four_descriptors_and_no_reader_channel(self):
        runtime, bootstrap, seen, pairing = self.injected_start(guided=False)
        self.assertEqual(runtime['state'], 'stopped')
        buffers, ancillary = bootstrap.sendmsg.call_args.args[:2]
        rights = ancillary[0][2]
        self.assertEqual(len(rights), 4)
        self.assertEqual(list(rights), [600, 700, runtime['fds']['storeDirectory'], 11])
        self.assertEqual(pairing.call_count, 2)
        sent = json.loads(buffers[0])
        self.assertEqual(sent['profile'], 'host-query-v1')
        self.assertNotIn('readerRegistration', sent)
        self.assertNotIn('requiredRuntimeContext', sent['runtimeConfig'])
        self.assertEqual(seen, {})

    def test_failed_guided_send_closes_both_reader_ends_and_retains_debt(self):
        runtime = self.configure()
        self.obj.runtime_artifacts = {'launcher': 10, 'executable': 11, 'ownerLibrary': 12}
        self.obj.runtime_pins = {name: 'test-pin' for name in self.obj.runtime_artifacts}
        self.obj.environment = -1
        control, parent, bootstrap, guest = [MagicMock() for _ in range(4)]
        for fd, channel in enumerate((control, parent, bootstrap, guest), 100):
            channel.fileno.return_value = fd
        bootstrap.sendmsg.side_effect = OSError(32, 'fixture bootstrap closed')
        pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        child = self.pipes.child
        child.wait = MagicMock(return_value=0)
        child.kill = MagicMock()
        original_close = service.os.close
        try:
            with patch.object(service, 'verify_held_artifact'), patch.object(service.socket, 'socketpair', side_effect=[(control, parent), (bootstrap, guest), pair]), \
                    patch.object(service.subprocess, 'Popen', return_value=child), patch.object(service, 'receive_init_pidfd', return_value=600), \
                    patch.object(service.os, 'pidfd_open', return_value=700, create=True), \
                    patch.object(service.os, 'close', side_effect=lambda fd: None if fd in (600, 700) else original_close(fd)), \
                    patch.object(service.signal, 'pidfd_send_signal', create=True):
                self.obj._run_runtime(self.fixture.item, runtime)
            self.assertEqual((pair[0].fileno(), pair[1].fileno()), (-1, -1))
            self.assertEqual(runtime['state'], 'retained')
            self.assertIn('logical', self.obj.debt)
            self.assertFalse(runtime['cleanupConfirmed'])
        finally:
            for end in pair:
                end.close()


if __name__ == '__main__':
    unittest.main()

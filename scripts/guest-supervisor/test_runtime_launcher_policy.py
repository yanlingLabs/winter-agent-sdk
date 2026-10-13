"""Actual argv assembly with injected Popen refusal; no service/native launch.

Disposable directories/FDs are ordinary test inputs, not native admission proof.
"""
import copy
import errno
import os
from contextlib import ExitStack
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import test_fresh_protocol as fresh

service = fresh.service


class RuntimeLauncherPolicyTests(unittest.TestCase):
    def test_actual_runtime_argv_maps_all_policies_without_changing_sdk_or_roots(self):
        policies = {'auto': 'default', 'ask': 'default', 'plan': 'plan',
                    'accept-edits': 'acceptEdits', 'dont-ask': 'dontAsk', 'bypass': 'bypassPermissions'}
        for policy, sdk_mode in policies.items():
            with self.subTest(policy=policy), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                directory = Path(temp)
                (directory / 'logical').mkdir()
                descriptors = {}
                for name in ('store', 'home', 'environment', 'writable', 'readonly'):
                    (directory / name).mkdir()
                    fd = os.open(directory / name, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
                    stack.callback(os.close, fd)
                    descriptors[name] = fd
                artifact = directory / 'inert-artifact'
                artifact.write_bytes(b'Never executed')
                artifact_fd = os.open(artifact, os.O_RDONLY | os.O_CLOEXEC)
                stack.callback(os.close, artifact_fd)
                item = {'logicalSessionId': 'logical', 'runtimeUid': 20001, 'toolUid': 10001,
                        'workspaceGid': 10000, 'policy': policy, 'revoked': False,
                        'authority': {'workspaceId': 'workspace', 'sessionId': 'backend',
                                      'incarnationId': 'incarnation', 'leaseEpoch': 1,
                                      'configRevision': 2, 'grantRevision': 3, 'policyRevision': 4},
                        'roots': {}}
                for name, readonly in (('writable', False), ('readonly', True)):
                    root = service.runtime_root_metadata({'id': name, 'guestPath': '/workspace/folders/' + name,
                                                          'readOnly': readonly}, policy, True)
                    item['roots'][name] = {'root': root, 'fd': descriptors[name]}
                config = service.host_query_config(item, ['read', 'write', 'execute'], 'fixture/model')
                before_item = copy.deepcopy(item)
                before_config = copy.deepcopy(config)
                port = MagicMock()  # Only injected transport method calls, never an admitted capability.
                runtime = {'state': 'starting', 'duplex': port, 'profile': 'host-query-v1',
                           'fds': {'storeDirectory': descriptors['store'], 'runhomeDirectory': descriptors['home']},
                           'hostConfig': config, 'provider': {}, 'model': 'fixture/model', 'ownerToken': 'inert-test-token'}
                fake = SimpleNamespace(directory=directory, environment=descriptors['environment'],
                                       runtime_artifacts={key: artifact_fd for key in ('launcher', 'executable', 'ownerLibrary')},
                                       runtime_pins={key: 'inert' for key in ('launcher', 'executable', 'ownerLibrary')},
                                       guest_boot="inert-test-boot", lock=threading.RLock(), debt=set(), revoke=MagicMock())
                bootstrap_before = service.ToolService._runtime_record(fake, item, runtime)
                captured = []
                def refuse_spawn(args, **options):
                    captured.append((list(args), options))
                    # Stop before any child/PID/pidfd/native admission or mounted view exists.
                    raise OSError(errno.ECANCELED, 'portable Popen refusal')
                socketpair=service.socket.socketpair
                # macOS lacks Unix SEQPACKET. STREAM is only an unprivileged FD stand-in;
                # no message, peer, pidfd or native owner is admitted in this test.
                with patch.object(service.socket,'socketpair',side_effect=lambda *args:socketpair(service.socket.AF_UNIX,service.socket.SOCK_STREAM)), patch.object(service, 'verify_held_artifact'), patch.object(service.subprocess, 'Popen', side_effect=refuse_spawn):
                    service.ToolService._run_runtime(fake, item, runtime)
                self.assertEqual(len(captured), 1)
                args, options = captured[0]
                self.assertEqual(args[13], 'plan' if policy == 'plan' else 'auto')
                self.assertEqual(args[14], '2')
                self.assertEqual(len(args), 15 + 3 * 2)
                self.assertEqual(args[15:], [str(descriptors['writable']), '/workspace/folders/writable',
                                            '1' if policy == 'plan' else '0', str(descriptors['readonly']),
                                            '/workspace/folders/readonly', '1'])
                self.assertEqual(options['executable'], '/proc/self/fd/' + str(artifact_fd))
                self.assertEqual(options['env'], {'LANG': 'C', 'LC_ALL': 'C'})
                self.assertIs(options['stdin'], service.subprocess.PIPE)
                self.assertTrue(set(descriptors.values()) <= set(options['pass_fds']))
                self.assertEqual(item, before_item)
                self.assertEqual(config, before_config)
                self.assertEqual(config['permissionMode'], sdk_mode)
                self.assertEqual(config['allowedTools'], [])
                self.assertEqual(config['permissions'], {'disableBypassPermissionsMode': policy != 'bypass'})
                self.assertEqual(config['allowDangerouslySkipPermissions'], policy == 'bypass')
                self.assertEqual(service.ToolService._runtime_record(fake, item, runtime), bootstrap_before)
                port.claim.assert_called_once_with(item)
                port.verify.assert_called_once()
                # The injected failure is retained, never fabricated as native success/cleanup.
                self.assertEqual(runtime['state'], 'retained')
                self.assertIn('logical', fake.debt)
                for fd in descriptors.values():
                    os.fstat(fd)  # Parent descriptors remain open.


if __name__ == '__main__':
    unittest.main()

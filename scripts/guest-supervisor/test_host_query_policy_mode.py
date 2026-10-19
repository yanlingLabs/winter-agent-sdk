"""The host-query runtime mode collapses to default/plan; every other consumer of the received policy is unchanged.

In Cowork the host matrix behind canUseTool is the policy authority. Any guest mode other than default or plan lets the SDK
resolve calls without canUseTool. So host_query_config maps plan to plan and every other policy to default, never produces
bypassPermissions, and keeps allowDangerouslySkipPermissions false (the guest validators require the key to be present and
equal to the mode's bypass flag). The received policy is recorded as-is and the plan read-only roots, the plan write
refusal and native_mount_policy still read it directly. Source only; nothing here starts a service or a native process.
"""
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_fresh_protocol as fresh
from test_guided_host_query import REQUIREMENT
from test_host_query import item

service = fresh.service
POLICIES = ('auto', 'ask', 'plan', 'accept-edits', 'dont-ask', 'bypass')
MODE = {'auto': 'default', 'ask': 'default', 'plan': 'plan', 'accept-edits': 'default', 'dont-ask': 'default', 'bypass': 'default'}


def source():
    return Path(service.__file__).read_text()


def function(text, name):
    start = text.index(f'def {name}(')
    end = re.search(r'\n(?=\S)', text[start:])
    return text[start:start + end.start()] if end else text[start:]


class RuntimeModeMappingTests(unittest.TestCase):
    def config(self, policy, guided=False):
        current = item(policy)
        if guided:
            return service.guided_host_query_config(current, ['read', 'write', 'execute'], 'openai/fixture', REQUIREMENT)
        return service.host_query_config(current, ['read', 'write', 'execute'], 'openai/fixture')

    def test_every_policy_maps_to_default_or_plan_only(self):
        for policy in POLICIES:
            with self.subTest(policy=policy):
                self.assertEqual(self.config(policy)['permissionMode'], MODE[policy])
                self.assertEqual(self.config(policy, guided=True)['permissionMode'], MODE[policy])

    def test_bypass_never_appears_in_any_config(self):
        for policy in POLICIES:
            for guided in (False, True):
                with self.subTest(policy=policy, guided=guided):
                    config = self.config(policy, guided)
                    self.assertNotIn('bypassPermissions', json.dumps(config))
                    self.assertNotIn('acceptEdits', json.dumps(config))
                    self.assertNotIn('dontAsk', json.dumps(config))
                    self.assertIs(config['allowDangerouslySkipPermissions'], False)
                    self.assertEqual(config['permissions'], {'disableBypassPermissionsMode': True})

    def test_the_received_policy_is_recorded_as_is_and_never_rewritten(self):
        for policy in POLICIES:
            current = item(policy)
            before = json.dumps(current, sort_keys=True)
            service.host_query_config(current, ['read'], 'model')
            self.assertEqual(current['policy'], policy)
            self.assertEqual(json.dumps(current, sort_keys=True), before)

    def test_the_mapping_is_only_in_the_config_builder_and_cannot_name_a_non_default_mode(self):
        body = function(source(), 'host_query_config')
        self.assertIn("modes={'auto':'default','ask':'default','plan':'plan','accept-edits':'default','dont-ask':'default','bypass':'default'}", body)
        self.assertEqual(re.findall(r"bypassPermissions|acceptEdits|dontAsk", source()), [])
        self.assertNotIn("=='bypass'", body)
        self.assertIn("'allowDangerouslySkipPermissions':False", body)


class OtherPolicyConsumersAreUnchangedTests(unittest.TestCase):
    def test_native_mount_policy_is_plan_only_for_plan(self):
        for policy in POLICIES:
            self.assertEqual(service.native_mount_policy(policy), 'plan' if policy == 'plan' else 'auto')

    def test_plan_makes_host_query_roots_read_only_and_no_other_policy_does(self):
        root = {'id': 'source', 'guestPath': '/workspace/folders/source', 'readOnly': False}
        for policy in POLICIES:
            self.assertIs(service.runtime_root_metadata(root, policy, True)['readOnly'], policy == 'plan')
            self.assertIs(service.runtime_root_metadata(root, policy, False)['readOnly'], False)

    def test_a_writable_root_is_refused_for_plan_and_accepted_for_every_other_policy(self):
        for policy in POLICIES:
            current = item(policy)
            current['roots']['source']['root']['readOnly'] = False
            if policy == 'plan':
                with self.assertRaisesRegex(service.Refusal, 'host_query_roots'):
                    service.host_query_config(current, ['write'], 'model')
            else:
                self.assertEqual(service.host_query_config(current, ['write'], 'model')['tools'], ['Write'])

    def test_an_unknown_policy_is_still_refused(self):
        for policy in ('', 'default', 'acceptEdits', 'bypassPermissions', None):
            current = item('ask')
            current['policy'] = policy
            with self.assertRaisesRegex(service.Refusal, 'host_query_policy'):
                service.host_query_config(current, ['read'], 'model')

    def test_the_admission_list_and_the_plan_write_refusal_still_read_the_raw_policy(self):
        text = source()
        self.assertIn("if item['policy'] not in ('auto','plan','ask','accept-edits','dont-ask','bypass')", text)
        self.assertIn("(root['root']['readOnly'] or item['policy']=='plan'):raise Refusal('authority_denied')", text)
        self.assertIn("'policy':item['policy']", text)
        self.assertIn("native_mount_policy(item['policy'])", text)
        self.assertEqual(function(text, 'native_mount_policy').count("policy=='plan'"), 1)


if __name__ == '__main__':
    unittest.main()

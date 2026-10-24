"""The memory share as a tool root (contract revision 3, SH6b), and the one /etc file a process tool sees. Source only; never starts a service or a native process.

/workspace/.winter/memory is a host share, admitted EXACTLY (no parent, no child, no sibling) as a root of a host-query or guided conversation. It is writable like any
other root except under plan, it is never the conversation's working directory, and it is never a browse root. /etc/gitconfig is the single file of the environment's /etc
the tool launcher mounts, read-only, for the process worker only.
"""
import re
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_fresh_protocol as fresh  # noqa: E402
import test_guided_host_query as gq  # noqa: E402
import test_plan_view as pv  # noqa: E402

service = fresh.service
MEMORY = '/workspace/.winter/memory'
SOURCE = '/workspace/folders/source'
GUEST = Path(__file__).resolve().parents[2] / 'packages/runtime/src/guest'
POLICIES = ('auto', 'ask', 'plan', 'accept-edits', 'dont-ask', 'bypass')


def conversation(policy, *guest_paths):
    current = gq.pure_item(policy)
    for index, guest in enumerate(guest_paths):
        current['roots'][f'extra{index}'] = {'root': service.runtime_root_metadata({'id': f'extra{index}', 'guestPath': guest, 'readOnly': False}, policy, True)}
    return current


class ConfigTests(unittest.TestCase):
    def test_the_exact_memory_path_is_admitted_for_every_policy_in_both_profiles(self):
        for policy in POLICIES:
            current = conversation(policy, MEMORY)
            self.assertIs(current['roots']['extra0']['root']['readOnly'], policy == 'plan', policy)
            self.assertEqual(service.host_query_config(current, ['read', 'write'], 'model')['cwd'], SOURCE)
            self.assertEqual(service.guided_host_query_config(current, ['read', 'write'], 'model', gq.REQUIREMENT)['cwd'], SOURCE)

    def test_nothing_else_under_the_store_is_admitted(self):
        for guest in ('/workspace/.winter', '/workspace/.winter/', f'{MEMORY}/sub', f'{MEMORY}x', '/workspace/.winter/memor', '/workspace/.winter/conversations/logical',
                      '/workspace/.winter/scratch/logical', '/workspace/.winter/WINTER.md', '/workspace/.winter/Memory'):
            with self.subTest(guest=guest), self.assertRaisesRegex(service.Refusal, 'host_query_roots'):
                service.host_query_config(conversation('ask', guest), ['read'], 'model')

    def test_the_memory_share_is_never_the_working_directory(self):
        current = gq.pure_item('ask')
        current['roots'] = {'memory': {'root': {'id': 'memory', 'guestPath': MEMORY, 'readOnly': False}}, **current['roots']}
        self.assertEqual(list(current['roots'])[0], 'memory')
        self.assertEqual(service.host_query_config(current, ['read'], 'model')['cwd'], SOURCE)
        only = gq.pure_item('ask')
        only['roots'] = {'memory': {'root': {'id': 'memory', 'guestPath': MEMORY, 'readOnly': False}}}
        with self.assertRaisesRegex(service.Refusal, 'host_query_roots'):
            service.host_query_config(only, ['read'], 'model')

    def test_under_plan_a_writable_memory_share_is_refused_like_any_other_root(self):
        current = gq.pure_item('plan')
        current['roots']['memory'] = {'root': {'id': 'memory', 'guestPath': MEMORY, 'readOnly': False}}
        with self.assertRaisesRegex(service.Refusal, 'host_query_roots'):
            service.host_query_config(current, ['read'], 'model')

    def test_writes_follow_the_root_flag_and_the_policy(self):
        memory = {'id': 'memory', 'guestPath': MEMORY, 'readOnly': False}
        for policy in POLICIES:
            self.assertIs(service.file_write_denied(policy, memory), policy == 'plan', policy)
        self.assertTrue(service.file_write_denied('ask', {**memory, 'readOnly': True}))


class AdmissionTests(unittest.TestCase):
    """The real ToolService constructor through the plan-view harness."""

    def setUp(self):
        self.harness = pv.AdmissionTests('test_a_read_only_plan_view_is_refused')
        self.harness.setUp()

    def tearDown(self):
        self.harness.tearDown()

    def roots(self, read_only=False):
        return self.harness.roots((MEMORY, read_only))

    def test_admitted_in_both_profiles_writable_unless_plan(self):
        for profile in ('host-query-v1', gq.GUIDED):
            for policy in POLICIES:
                with self.subTest(profile=profile, policy=policy):
                    built = self.harness.construct(profile, policy, self.roots())
                    admitted = built.conversations[pv.SID]['roots']
                    self.assertEqual(admitted['view0']['root']['guestPath'], MEMORY)
                    self.assertIs(admitted['view0']['root']['readOnly'], policy == 'plan')
                    built.close()
                    self.harness.services.remove(built)

    def test_other_paths_under_the_store_still_refuse_at_admission(self):
        for guest in (f'{MEMORY}/sub', '/workspace/.winter', '/workspace/.winter/conversations/logical'):
            with self.subTest(guest=guest), self.assertRaises(service.Refusal):
                self.harness.construct('host-query-v1', 'ask', self.harness.roots((guest, False)))


class BrowseTests(unittest.TestCase):
    def binding(self, guest):
        item = {'authority': {'workspaceId': 'w', 'sessionId': 's', 'incarnationId': 'i'}, 'roots': {'r': {'root': {'id': 'r', 'guestPath': guest, 'readOnly': False}}}}
        request = {'workspaceId': 'w', 'sessionId': 's', 'incarnationId': 'i', 'locationId': 'r'}
        return service.file_binding({'c': item}, request)

    def test_the_memory_share_is_never_a_browse_root(self):
        self.assertEqual(self.binding('/workspace/folders/source')[1]['root']['guestPath'], '/workspace/folders/source')
        with self.assertRaises(service.FileRefusal) as raised:
            self.binding(MEMORY)
        self.assertEqual(str(raised.exception), 'file_unavailable')


class GitconfigSourceTests(unittest.TestCase):
    """Source-level, since no native process starts here; the Linux native tests run the launcher itself."""

    def setUp(self):
        self.text = (GUEST / 'linux-tool-compartment.c').read_text()
        self.code = re.sub(r'/\*[\s\S]*?\*/', '', self.text)

    def test_exactly_one_file_of_etc_is_named_and_it_is_the_gitconfig(self):
        self.assertEqual(sorted(set(re.findall(r'"(/etc[^"]*)"', self.code))), ['/etc/gitconfig'])
        self.assertEqual(re.findall(r'"etc"', self.code), ['"etc"'])
        self.assertEqual(re.findall(r'openat\(etc,("[^"]+")', self.code), ['"gitconfig"'])

    def test_it_is_opened_without_following_a_symlink_and_must_be_a_plain_root_owned_file(self):
        body = re.search(r'static int gitconfig_clone\(int environment\) \{[\s\S]*?\n\}', self.code).group(0)
        self.assertIn('openat(environment,"etc",O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)', body)
        self.assertIn('openat(etc,"gitconfig",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY|O_CLOEXEC)', body)
        self.assertIn('if(!S_ISREG(st.st_mode)||st.st_nlink!=1||st.st_uid!=0||(st.st_mode&0022)||st.st_size>GITCONFIG_LIMIT)_exit(64);', body)
        self.assertIn('clone_descriptor(config,1,0)', body)  # read-only, noexec, nosuid, nodev

    def test_only_the_process_worker_is_given_it_and_the_mount_is_proven_sealed(self):
        self.assertEqual(self.code.count('gitconfig_clone(environment)'), 1)  # the one call site; the definition takes `int environment`
        self.assertIn('int gitconfig_tree=process?gitconfig_clone(environment):-1;', self.code)
        process_block = self.code[self.code.index('    if(process){\n        for(int i=0;i<4;i++){'):]
        self.assertIn('guidance_file_point(root,GITCONFIG_FILE,target,sizeof target);attach_descriptor(gitconfig_tree,target);', process_block)
        self.assertIn('if(gitconfig_tree>=0)guidance_sealed(GITCONFIG_FILE);', self.code)

    def test_the_supervisor_and_the_other_launchers_know_nothing_of_it(self):
        for name in ('linux-runtime-compartment.c', 'linux-instruction-reader-compartment.c', 'file-worker.c', 'linux-supervisor.py'):
            self.assertNotIn('gitconfig', (GUEST / name).read_text(), name)


if __name__ == '__main__':
    unittest.main()

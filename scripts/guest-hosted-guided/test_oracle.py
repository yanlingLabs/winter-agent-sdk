"""Injected tests for the guided hosted verdict: dispatch 1, a shared-file edit, dispatch 2, ticket reuse, revocation,
and the independent exit-64 case. Evidence is data; nothing here starts a process or reads the network."""
import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle  # noqa: E402


def snap(frames, begins, accepted, completed):
    return {'receivedFrames': frames, 'receivedBegins': begins, 'acceptedBegins': accepted, 'completed': completed}


def good():
    return {
        'exit64': {'site': 'argv_parse', 'exitStatus': 64, 'initReceipt': False, 'pidfdReceived': False},
        'stub': {
            'afterDispatch1': snap(3, 1, 1, 1),
            'afterDispatch2': snap(6, 2, 2, 2),
            'afterReuse': snap(6, 2, 2, 2),
            'beforeRevocation': snap(6, 2, 2, 2),
            'afterRevocation': snap(6, 2, 2, 2),
        },
        'host': {'dispatch1Text': 'first deterministic answer', 'dispatch2Text': 'second deterministic answer',
                 'revocationError': 'required_context_unavailable', 'reuseError': 'required_context_unavailable'},
        'sharedFile': {'beforeSha256': 'a' * 64, 'afterSha256': 'b' * 64},
    }


def failing(evidence):
    return {name: case['failureClass'] for name, case in oracle.evaluate(evidence)['cases'].items() if not case['passed']}


class HappyPath(unittest.TestCase):
    def test_all_cases_pass(self):
        result = oracle.evaluate(good())
        self.assertTrue(result['passed'])
        self.assertEqual(list(result['cases']), list(oracle.CASES))
        self.assertTrue(all(case == {'passed': True, 'failureClass': None} for case in result['cases'].values()))
        self.assertEqual(result['schema'], 'winter-guided-hosted-result/1')

    def test_result_has_only_bounded_failure_classes(self):
        for name in oracle.FAILURE_CLASSES:
            self.assertRegex(name, r'^[a-z0-9_]+$')
        self.assertEqual(len(set(oracle.FAILURE_CLASSES)), len(oracle.FAILURE_CLASSES))


class Dispatches(unittest.TestCase):
    def test_dispatch1_needs_exactly_one_accepted_completed_begin(self):
        for snapshot in (snap(3, 0, 0, 0), snap(3, 2, 2, 2), snap(3, 1, 1, 0)):
            evidence = good()
            evidence['stub']['afterDispatch1'] = snapshot
            self.assertEqual(failing(evidence)['dispatch1'], 'dispatch_count', snapshot)

    def test_a_refused_begin_is_a_distinct_class(self):
        evidence = good()
        evidence['stub']['afterDispatch1'] = snap(3, 2, 1, 1)
        self.assertEqual(failing(evidence)['dispatch1'], 'dispatch_refused')

    def test_wrong_answer_text_fails(self):
        evidence = good()
        evidence['host']['dispatch1Text'] = 'second deterministic answer'
        self.assertEqual(failing(evidence)['dispatch1'], 'dispatch_answer')

    def test_dispatch2_after_an_unchanged_shared_file_fails_at_the_edit(self):
        evidence = good()
        evidence['sharedFile']['afterSha256'] = evidence['sharedFile']['beforeSha256']
        self.assertEqual(failing(evidence)['shared_edit'], 'edit_unchanged')
        self.assertEqual(failing(evidence)['dispatch2'], 'not_run')

    def test_empty_digests_are_not_an_edit(self):
        evidence = good()
        evidence['sharedFile'] = {'beforeSha256': '', 'afterSha256': 'b' * 64}
        self.assertEqual(failing(evidence)['shared_edit'], 'edit_unchanged')

    def test_dispatch2_needs_two_accepted_completed_begins(self):
        evidence = good()
        evidence['stub']['afterDispatch2'] = snap(4, 1, 1, 1)
        evidence['stub']['afterReuse'] = snap(4, 1, 1, 1)
        evidence['stub']['beforeRevocation'] = snap(4, 1, 1, 1)
        evidence['stub']['afterRevocation'] = snap(4, 1, 1, 1)
        self.assertEqual(failing(evidence)['dispatch2'], 'dispatch_count')

    def test_a_failure_stops_the_chain_but_not_the_exit64_case(self):
        evidence = good()
        evidence['host']['dispatch1Text'] = 'nope'
        failed = failing(evidence)
        self.assertEqual(failed, {'dispatch1': 'dispatch_answer', 'shared_edit': 'not_run', 'dispatch2': 'not_run', 'ticket_reuse': 'not_run', 'revocation': 'not_run'})
        self.assertNotIn('reader_exit64', failed)


class Revocation(unittest.TestCase):
    def test_zero_further_provider_requests_after_revocation(self):
        evidence = good()
        self.assertEqual(failing(evidence), {})

    def test_one_frame_after_revocation_fails_even_if_the_host_says_zero(self):
        evidence = good()
        evidence['stub']['afterRevocation'] = snap(7, 2, 2, 2)
        evidence['host']['hostClaimedProviderCalls'] = 0
        # an extra host key is not evidence: the shape is closed, so the claim cannot even be offered
        self.assertEqual(set(failing(evidence).values()), {'evidence_shape'})
        del evidence['host']['hostClaimedProviderCalls']
        self.assertEqual(failing(evidence), {'revocation': 'revocation_provider_request'})

    def test_a_third_begin_after_revocation_fails(self):
        evidence = good()
        evidence['stub']['afterRevocation'] = snap(7, 3, 2, 2)
        self.assertEqual(failing(evidence), {'revocation': 'revocation_provider_request'})

    def test_a_frame_between_reuse_and_revocation_fails(self):
        evidence = good()
        evidence['stub']['beforeRevocation'] = snap(7, 2, 2, 2)
        evidence['stub']['afterRevocation'] = snap(7, 2, 2, 2)
        self.assertEqual(failing(evidence), {'revocation': 'revocation_provider_request'})

    def test_revocation_must_be_refused_as_required_context_unavailable(self):
        for value in ('', 'ok', 'timeout', 'Required_context_unavailable'):
            evidence = good()
            evidence['host']['revocationError'] = value
            self.assertEqual(failing(evidence), {'revocation': 'revocation_not_refused'}, value)


class TicketReuse(unittest.TestCase):
    def test_a_spent_ticket_must_be_refused(self):
        evidence = good()
        evidence['host']['reuseError'] = ''
        self.assertEqual(failing(evidence)['ticket_reuse'], 'reuse_not_refused')
        self.assertEqual(failing(evidence)['revocation'], 'not_run')

    def test_reuse_must_not_reach_the_provider(self):
        evidence = good()
        evidence['stub']['afterReuse'] = snap(7, 3, 2, 2)
        evidence['stub']['beforeRevocation'] = snap(7, 3, 2, 2)
        evidence['stub']['afterRevocation'] = snap(7, 3, 2, 2)
        self.assertEqual(failing(evidence)['ticket_reuse'], 'reuse_provider_request')


class Exit64(unittest.TestCase):
    def test_exit64_with_no_init_or_pidfd_passes(self):
        for site in oracle.EXIT64_SITES:
            evidence = good()
            evidence['exit64']['site'] = site
            self.assertEqual(failing(evidence), {}, site)

    def test_other_exit_statuses_fail(self):
        for status in (0, 1, 63, 65, 78, 137):
            evidence = good()
            evidence['exit64']['exitStatus'] = status
            self.assertEqual(failing(evidence), {'reader_exit64': 'reader_exit_status'}, status)

    def test_an_init_receipt_or_pidfd_means_a_namespace_existed(self):
        for key in ('initReceipt', 'pidfdReceived'):
            evidence = good()
            evidence['exit64'][key] = True
            self.assertEqual(failing(evidence), {'reader_exit64': 'reader_receipt'}, key)

    def test_the_site_must_be_named_and_known(self):
        for site in ('', 'everything', 'ARGV_PARSE'):
            evidence = good()
            evidence['exit64']['site'] = site
            self.assertEqual(failing(evidence), {'reader_exit64': 'reader_site'}, site)

    def test_a_failed_exit64_does_not_mask_the_query_chain(self):
        evidence = good()
        evidence['exit64']['exitStatus'] = 1
        evidence['host']['dispatch2Text'] = 'x'
        self.assertEqual(failing(evidence), {'reader_exit64': 'reader_exit_status', 'dispatch2': 'dispatch_answer', 'ticket_reuse': 'not_run', 'revocation': 'not_run'})


class Evidence(unittest.TestCase):
    def test_counters_may_not_go_backwards(self):
        evidence = good()
        evidence['stub']['afterReuse'] = snap(5, 2, 2, 2)
        self.assertEqual({v for k, v in failing(evidence).items() if k != 'reader_exit64'}, {'stub_counters'})

    def test_counters_must_be_plain_non_negative_integers(self):
        for bad in (True, -1, 1.0, '1', None, 1 << 40):
            evidence = good()
            evidence['stub']['afterDispatch1']['completed'] = bad
            self.assertIn('stub_counters', set(failing(evidence).values()), repr(bad))

    def test_unknown_or_missing_keys_fail_closed(self):
        for mutate in (
            lambda e: e.update(extra=1),
            lambda e: e.pop('sharedFile'),
            lambda e: e['exit64'].pop('site'),
            lambda e: e['stub'].pop('afterReuse'),
            lambda e: e['stub']['afterDispatch1'].update(extra=0),
            lambda e: e['host'].update(extra=''),
            lambda e: e.update(host=[]),
        ):
            evidence = copy.deepcopy(good())
            mutate(evidence)
            result = oracle.evaluate(evidence)
            self.assertFalse(result['passed'])
            self.assertEqual({case['failureClass'] for case in result['cases'].values()}, {'evidence_shape'})

    def test_non_dict_evidence_fails_closed(self):
        for value in (None, [], 'x', 1):
            self.assertFalse(oracle.evaluate(value)['passed'])

    def test_every_failure_class_the_oracle_can_emit_is_declared(self):
        seen = set()
        variants = []
        for mutate in (
            lambda e: e['exit64'].update(site='x'), lambda e: e['exit64'].update(exitStatus=0), lambda e: e['exit64'].update(initReceipt=True),
            lambda e: e['stub'].update(afterDispatch1=snap(3, 2, 1, 1)), lambda e: e['stub'].update(afterDispatch1=snap(3, 1, 1, 0)),
            lambda e: e['host'].update(dispatch1Text='x'), lambda e: e['sharedFile'].update(afterSha256=e['sharedFile']['beforeSha256']),
            lambda e: e['host'].update(reuseError='x'), lambda e: e['host'].update(revocationError='x'),
            lambda e: e['stub'].update(afterReuse=snap(7, 3, 2, 2), beforeRevocation=snap(7, 3, 2, 2), afterRevocation=snap(7, 3, 2, 2)),
            lambda e: e['stub'].update(afterRevocation=snap(7, 2, 2, 2)), lambda e: e.update(x=1),
            lambda e: e['stub'].update(afterReuse=snap(1, 1, 1, 1)),
        ):
            evidence = good()
            mutate(evidence)
            variants.append(evidence)
        for evidence in variants:
            seen.update(case['failureClass'] for case in oracle.evaluate(evidence)['cases'].values() if case['failureClass'])
        self.assertTrue(seen <= set(oracle.FAILURE_CLASSES), seen - set(oracle.FAILURE_CLASSES))


if __name__ == '__main__':
    unittest.main()

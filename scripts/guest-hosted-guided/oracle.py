"""Pure verdict logic for the one-run guided hosted fixture. Source only: nothing here runs a process.

The hosted runner (not part of this slice) collects EVIDENCE on the Root side and hands it to ``evaluate``. The
verdict is a function of that evidence alone, with bounded failure classes and no free text from the runner:

* every provider request is counted by the STUB's own receipt counters, never by the host client's claims;
* the exit-64 observation (reader launcher refusing a bad envelope before any namespace exists) is an
  independent case, so its outcome and the query chain's outcome cannot mask each other;
* a failed case turns every later case of the SAME chain into ``not_run``; it never silently passes.
"""
from __future__ import annotations

SCHEMA = 'winter-guided-hosted-result/1'
CASES = ('reader_exit64', 'dispatch1', 'shared_edit', 'dispatch2', 'ticket_reuse', 'revocation')
CHAIN = CASES[1:]
FAILURE_CLASSES = (
    'evidence_shape',      # evidence is not the closed shape
    'stub_counters',       # a stub counter went backwards or is not an integer
    'reader_exit_status',  # the launcher did not exit 64
    'reader_receipt',      # an init receipt or pidfd existed for a refused envelope
    'reader_site',         # the named _exit(64) site is not a known one
    'dispatch_count',      # begins/accepts/completions differ from the expected count
    'dispatch_refused',    # the stub refused a begin it should have accepted
    'dispatch_answer',     # the host saw a different answer than the script's
    'edit_unchanged',      # the shared file did not change between the dispatches
    'revocation_not_refused',  # the host's post-revocation query was not refused as required_context_unavailable
    'revocation_provider_request',  # the stub saw a request after revocation
    'reuse_not_refused',   # a spent ticket was accepted, or refused with a different class
    'reuse_provider_request',  # the stub saw a request for the reused ticket
    'not_run',             # an earlier case of the chain failed
)
# The launcher's own refusal sites that precede the namespace fork (linux-instruction-reader-compartment.c).
# Observing one of them does not prove the claim for every site; the result names the site it exercised.
# Named by the source line group: receipt_socket_peer (L495), argv_parse (L504, including its uid check),
# shared_inode (L510), guest_path (L162), descriptor_identity (L117-129), view_path (L139-145).
EXIT64_SITES = ('receipt_socket_peer', 'argv_parse', 'shared_inode', 'guest_path', 'descriptor_identity', 'view_path')
EXPECTED_ANSWERS = ('first deterministic answer', 'second deterministic answer')
COUNTERS = ('receivedFrames', 'receivedBegins', 'acceptedBegins', 'completed')
REFUSAL_CLASS = 'required_context_unavailable'
_SNAPSHOTS = ('afterDispatch1', 'afterDispatch2', 'afterReuse', 'beforeRevocation', 'afterRevocation')
_TOP = {'exit64', 'stub', 'host', 'sharedFile'}


def _integer(value):
    return type(value) is int and 0 <= value <= 1 << 31


def _closed(value, keys):
    return type(value) is dict and set(value) == set(keys)


def _shape_ok(evidence):
    if not _closed(evidence, _TOP):
        return False
    exit64 = evidence['exit64']
    if not _closed(exit64, ('site', 'exitStatus', 'initReceipt', 'pidfdReceived')):
        return False
    if type(exit64['site']) is not str or not _integer(exit64['exitStatus']) \
            or type(exit64['initReceipt']) is not bool or type(exit64['pidfdReceived']) is not bool:
        return False
    stub = evidence['stub']
    if not _closed(stub, _SNAPSHOTS):
        return False
    if any(not _closed(stub[name], COUNTERS) for name in _SNAPSHOTS):
        return False
    host = evidence['host']
    if not _closed(host, ('dispatch1Text', 'dispatch2Text', 'revocationError', 'reuseError')):
        return False
    if any(type(host[key]) is not str for key in host):
        return False
    shared = evidence['sharedFile']
    return _closed(shared, ('beforeSha256', 'afterSha256')) and all(type(shared[key]) is str for key in shared)


def _counters_ok(stub):
    previous = None
    for name in _SNAPSHOTS:
        snapshot = stub[name]
        if any(not _integer(snapshot[key]) for key in COUNTERS):
            return False
        if previous is not None and any(snapshot[key] < previous[key] for key in COUNTERS):
            return False
        previous = snapshot
    return True


def _case(passed, failure_class=None):
    return {'passed': passed, 'failureClass': None if passed else failure_class}


def _reader(exit64):
    if exit64['site'] not in EXIT64_SITES:
        return _case(False, 'reader_site')
    if exit64['exitStatus'] != 64:
        return _case(False, 'reader_exit_status')
    if exit64['initReceipt'] or exit64['pidfdReceived']:
        return _case(False, 'reader_receipt')
    return _case(True)


def _dispatch(snapshot, count, text, expected):
    if snapshot['receivedBegins'] != snapshot['acceptedBegins']:
        return _case(False, 'dispatch_refused')
    if snapshot['acceptedBegins'] != count or snapshot['completed'] != count or snapshot['receivedBegins'] != count:
        return _case(False, 'dispatch_count')
    if text != expected:
        return _case(False, 'dispatch_answer')
    return _case(True)


def _unchanged(a, b):
    return all(a[key] == b[key] for key in COUNTERS)


def evaluate(evidence):
    """Return the closed result record for the evidence. Never raises on bad evidence: it fails closed."""
    cases = {}
    if not _shape_ok(evidence):
        for name in CASES:
            cases[name] = _case(False, 'evidence_shape')
        return _result(cases)
    stub = evidence['stub']
    cases['reader_exit64'] = _reader(evidence['exit64'])
    if not _counters_ok(stub):
        for name in CHAIN:
            cases[name] = _case(False, 'stub_counters')
        return _result(cases)
    host = evidence['host']
    shared = evidence['sharedFile']
    verdicts = {
        'dispatch1': lambda: _dispatch(stub['afterDispatch1'], 1, host['dispatch1Text'], EXPECTED_ANSWERS[0]),
        'shared_edit': lambda: _case(shared['beforeSha256'] != shared['afterSha256'] and shared['beforeSha256'] != '' and shared['afterSha256'] != '', 'edit_unchanged'),
        'dispatch2': lambda: _dispatch(stub['afterDispatch2'], 2, host['dispatch2Text'], EXPECTED_ANSWERS[1]),
        # Reuse runs while the generation is still LIVE, so a refusal can only be because the ticket is spent. The ticket
        # revocation later presents is a fresh, unspent one minted before the revoke, so only the revoke can refuse it.
        # Both verdicts compare the STUB's own counters; nothing the host client says about its own calls is read.
        'ticket_reuse': lambda: (
            _case(False, 'reuse_not_refused') if host['reuseError'] != REFUSAL_CLASS
            else _case(False, 'reuse_provider_request') if not _unchanged(stub['afterDispatch2'], stub['afterReuse'])
            else _case(True)
        ),
        'revocation': lambda: (
            _case(False, 'revocation_not_refused') if host['revocationError'] != REFUSAL_CLASS
            else _case(False, 'revocation_provider_request') if not (_unchanged(stub['afterReuse'], stub['beforeRevocation']) and _unchanged(stub['beforeRevocation'], stub['afterRevocation']))
            else _case(True)
        ),
    }
    failed = False
    for name in CHAIN:
        if failed:
            cases[name] = _case(False, 'not_run')
            continue
        cases[name] = verdicts[name]()
        failed = not cases[name]['passed']
    return _result(cases)


def _result(cases):
    ordered = {name: cases[name] for name in CASES}
    return {'schema': SCHEMA, 'passed': all(case['passed'] for case in ordered.values()), 'cases': ordered}

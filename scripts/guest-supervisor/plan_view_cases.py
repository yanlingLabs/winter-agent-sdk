#!/usr/bin/env python3
"""Linux CI cases for the plan view (docs/guest-plan-view.md). Run by verify.py as root under `python -I -S`: `plan_view_cases.py <linux-supervisor.py> <work directory>`.

The real supervisor module, the real ToolService constructor (real root, real boot id, real artifact pins, real O_NOFOLLOW directory walks, real FIFO ports) and real
directories under the work directory. Two seams, both the documented ones: the predicate that makes a host-query root be served from its own guest path (the plan
view cannot be a real /workspace path on a CI runner) and the runtime configuration step (no native owner starts here). Admitted under plan, refused outside plan,
refused for a stale epoch, refused for the other profile. Nothing native runs and no service starts.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path
from unittest.mock import patch

SID = 'conversation-plan'
AUTHORITY = {'workspaceId': 'workspace', 'sessionId': 'backend-plan', 'incarnationId': 'boot', 'leaseEpoch': 1, 'configRevision': 1, 'grantRevision': 1, 'policyRevision': 1}


def load(path):
    spec = importlib.util.spec_from_file_location('winter_linux_supervisor', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run(module, work):
    work = Path(work).resolve()
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    artifacts, environment, control = work / 'artifacts', work / 'environment', work / 'control'
    source, view, store, home, plan_root = work / 'src', work / 'planview', work / 'store', work / 'home', work / 'planroot'
    for directory in (artifacts, environment, control, source, view, store, home, plan_root):
        directory.mkdir()
    control.chmod(0o711)
    digests = {}
    for name in ('launcher', 'fileWorker', 'processWorker', 'executable', 'ownerLibrary'):
        (artifacts / name).write_bytes(b'inert')
        (artifacts / name).chmod(0o555)
        digests[name] = hashlib.sha256(b'inert').hexdigest()
    pin = lambda name: {'path': str(artifacts / name), 'sha256': digests[name]}
    key = dict(module.RUNTIME_KEYS)['host-query-v1']
    (plan_root / SID).mkdir()
    (plan_root / SID / '4').mkdir()

    def roots(path, read_only):
        return [{'id': 'source', 'guestPath': '/workspace/folders/source', 'readOnly': False, 'source': str(source)},
                {'id': 'plan', 'guestPath': path, 'readOnly': read_only, 'source': str(view)}]

    def config(policy, host_query, path, read_only):
        entry = {'logicalSessionId': SID, 'authority': dict(AUTHORITY), 'runtimeUid': 20101, 'toolUid': 10101, 'workspaceGid': 10100, 'policy': policy, 'roots': roots(path, read_only)}
        value = {'guestBootId': boot, 'environment': str(environment), 'controlDirectory': str(control), 'protectedStoreDirectories': [],
                 'artifacts': {name: pin(name) for name in ('launcher', 'fileWorker', 'processWorker')}, 'conversations': [entry]}
        if host_query:
            value[key] = {'artifacts': {name: pin(name) for name in ('launcher', 'executable', 'ownerLibrary')}}
            entry[key] = {'storeDirectory': str(store), 'runhomeDirectory': str(home)}
        return value

    counter = [0]

    def ports():
        counter[0] += 1
        directory = work / f'fifo-{counter[0]}'
        directory.mkdir()
        ends = []
        for index in range(3):
            path = directory / str(index)
            os.mkfifo(path, 0o600)
            reader = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            writer = os.open(path, os.O_WRONLY | os.O_NONBLOCK | os.O_CLOEXEC)
            ends.append((reader, writer))
        return module.RuntimeDuplexPorts(SID, AUTHORITY, ends[0][0], ends[1][1], ends[2][1]), [fd for pair in ends for fd in pair]

    def construct(policy, host_query=True, epoch=4, path=None, read_only=False):
        private = control / SID
        if private.exists():
            shutil.rmtree(private)
        held, fds = ports()
        try:
            with patch.object(module, 'host_query_source_is_view', lambda _source, _guest: True), patch.object(module.ToolService, '_configure_runtime', autospec=True):
                return module.ToolService(config(policy, host_query, path or f'/workspace/plan/{SID}/{epoch}', read_only), host_query_ports={SID: held} if host_query else {})
        finally:
            for fd in fds:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def refused(policy, code, **options):
        try:
            built = construct(policy, **options)
        except module.Refusal as failure:
            assert str(failure) == code, (policy, options, str(failure))
            return
        built.close()
        raise AssertionError(('admitted but must refuse', policy, options))

    module.PLAN_ROOT = str(plan_root)
    results = []

    # Admitted: under plan, the conversation's own current epoch, once, writable; every other root read-only.
    built = construct('plan')
    try:
        admitted = built.conversations[SID]['roots']
        assert admitted['plan']['root'] == {'id': 'plan', 'guestPath': f'/workspace/plan/{SID}/4', 'readOnly': False}, admitted['plan']['root']
        assert admitted['source']['root']['readOnly'] is True, admitted['source']['root']
    finally:
        built.close()
    results.append('admitted-under-plan')

    # Refused outside plan, whatever the policy, and refused for the profile that is not host-query.
    for policy in ('auto', 'ask', 'accept-edits', 'dont-ask', 'bypass'):
        refused(policy, 'plan_view')
    refused('plan', 'plan_view', host_query=False)
    results.append('refused-outside-plan')

    # Refused under plan too: another conversation's view, a malformed epoch, a read-only view.
    refused('plan', 'plan_view', path='/workspace/plan/other-conversation/4')
    refused('plan', 'plan_view', path=f'/workspace/plan/{SID}/04')
    refused('plan', 'plan_view', read_only=True)
    results.append('refused-foreign-malformed-read-only')

    # Stale: an epoch below one that already exists beside it is never mounted; the later one itself is the current one.
    (plan_root / SID / '5').mkdir()
    refused('plan', 'plan_view')
    current = construct('plan', epoch=5)
    try:
        assert current.conversations[SID]['roots']['plan']['root']['guestPath'] == f'/workspace/plan/{SID}/5'
    finally:
        current.close()
    results.append('refused-stale-epoch')

    # The epoch parent is read without following a symlink, and fails closed.
    assert module.plan_view_stale(SID, 5) is False and module.plan_view_stale(SID, 4) is True
    real = plan_root / 'real'
    real.mkdir()
    os.symlink(real, plan_root / 'linked')
    assert module.plan_view_stale('linked', 4) is True and module.plan_view_stale('missing', 4) is True
    results.append('stale-check-fails-closed')
    return results


def main():
    module = load(sys.argv[1])
    print(json.dumps({'passed': True, 'cases': run(module, sys.argv[2])}))


if __name__ == '__main__':
    main()

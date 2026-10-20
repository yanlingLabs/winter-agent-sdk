"""A fake role process for the runner's tests: speaks the runtime-sdk entry contract (roles_adapter.CONTRACT).
usage: fake_role.py <provider|host> <state-dir> [mode]. The provider and the host share counters through the state dir, as
the real stub's counters would be moved by the real engine's requests; the host never reports counters itself."""
import json
import os
import signal
import sys
import time

role, state, mode = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else '')
path = os.path.join(state, 'counters.json')
flags = os.path.join(state, 'flags.json')
ZERO = {'requests': 0, 'unreadable': 0, 'unframed': 0, 'refused': 0, 'receivedFrames': 0, 'receivedBegins': 0, 'acceptedBegins': 0, 'completed': 0}


def load(p, default):
    try:
        return json.load(open(p))
    except OSError:
        return dict(default)


def save(c):
    json.dump(c, open(path, 'w'))


def bump(frames=3, begins=1, refused=0):
    c = load(path, ZERO)
    c['requests'] += frames
    c['receivedFrames'] += frames
    c['receivedBegins'] += begins
    c['acceptedBegins'] += begins - refused
    c['completed'] += begins - refused
    c['refused'] += refused
    save(c)


def bump_stray(kind):
    """A frameless arrival (nothing readable, or an empty/NUL body); the provider counts an unframed arrival as refused too."""
    c = load(path, ZERO)
    c['requests'] += 1
    c[kind] += 1
    if kind == 'unframed':
        c['refused'] += 1
    save(c)


def detail_fields():
    """The provider's diagnostic fields; modes 'sites*' send valid or deliberately bad ones, every other mode sends none beyond `outcomes`."""
    good = [{'n': 1, 'site': 'read_null'}, {'n': 2, 'site': 'frame_empty_or_nul'}]
    if mode == 'sites':
        return {'outcomes': ['unreadable', 'refused', 'accepted'], 'refusalSites': good}
    if mode == 'sites_bad_site':
        return {'outcomes': [], 'refusalSites': [{'n': 1, 'site': '/secret/path'}]}
    if mode == 'sites_extra_key':
        return {'outcomes': [], 'refusalSites': [{'n': 1, 'site': 'keys', 'text': 'x'}]}
    if mode == 'sites_too_many':
        return {'outcomes': [], 'refusalSites': [{'n': i + 1, 'site': 'keys'} for i in range(17)]}
    if mode == 'sites_bad_outcome':
        return {'outcomes': ['accepted', 'rejected'], 'refusalSites': []}
    if mode == 'outcomes_too_many':
        return {'outcomes': ['accepted'] * 65, 'refusalSites': []}
    if mode == 'sites_not_list':
        return {'outcomes': [], 'refusalSites': {'n': 1}}
    return {'outcomes': []}


def out(value):
    sys.stdout.write(json.dumps(value) + '\n')
    sys.stdout.flush()


def raw(text):
    sys.stdout.write(text)
    sys.stdout.flush()


answers = {1: 'first deterministic answer', 2: 'second deterministic answer'}
BINDING = '5f6e7d8c-0000-4000-a000-00000000000b'

if role == 'provider':
    def terminate(signum, frame):
        if mode == 'summary_late':
            bump(frames=1, begins=0)
        c = load(path, ZERO)
        out({'kind': 'provider-summary', **c, 'answered': c['completed'], 'portClosed': False, 'scriptSha256': 'a' * 64, 'turnSha256': [], 'countersAgree': mode != 'summary_disagree', **detail_fields()})
        sys.exit(0 if mode != 'summary_exit' else 3)
    signal.signal(signal.SIGTERM, terminate)
    if mode != 'not_ready':
        out({'kind': 'provider-ready'})
    for line in sys.stdin:
        if mode == 'silent':
            time.sleep(30)
        if mode == 'garbage':
            raw('not json\n')
            continue
        if mode == 'huge':
            raw('x' * 20000 + '\n')
            continue
        if mode == 'nonewline':
            raw('x' * 20000)
            time.sleep(30)
        parts = line.split()
        if len(parts) == 2 and parts[0] == 'receipt':
            out({'kind': 'provider-request', 'n': 1, 'readable': True}) if mode == 'noise' else None
            c = load(path, ZERO)
            tag = parts[1] if mode != 'wrong_tag' else 'other-tag'
            out({'kind': 'provider-receipt', 'tag': tag, **c, 'answered': c['completed'], 'portClosed': False, 'countersAgree': mode != 'agree_false', 'controlRefused': 0, **detail_fields()})
        else:
            out({'kind': 'provider-control-refused', 'code': 'line'})
    time.sleep(0)
else:
    revoked = False
    if mode in ('host_refused', 'host_refused_weird'):
        out({'version': 1, 'kind': 'host-refused', 'code': '/secret/code' if mode == 'host_refused_weird' else 'metadata'})
        sys.exit(2)
    if mode == 'noise':
        out({'kind': 'host-query-ended', 'how': 'completed'})
    if mode == 'spam':
        for _ in range(5000):
            out({'kind': 'host-query-ended', 'how': 'completed'})
    for line in sys.stdin:
        if mode == 'silent':
            time.sleep(30)
        if mode == 'garbage':
            raw('not json\n')
            continue
        if mode == 'huge':
            raw('x' * 20000 + '\n')
            continue
        if mode == 'nonewline':
            raw('x' * 20000)
            time.sleep(30)
        if mode == 'exit':
            sys.exit(3)
        if mode == 'bad_kind':
            out({'kind': 'something-else'})
            continue
        if mode == 'command_refused':
            out({'kind': 'host-command-refused', 'code': 'order'})
            continue
        words = line.split()
        command = ' '.join(words)
        flag = load(flags, {})
        if words[:1] == ['dispatch']:
            n = int(words[1])
            if n == 1:
                if mode == 'refuse_before_spawn':
                    out({'kind': 'host-dispatch', 'n': 1, 'ok': False, 'answer': '', 'ended': 'failed:config'})
                    continue
                if mode == 'ended_weird':
                    out({'kind': 'host-dispatch', 'n': 1, 'ok': False, 'answer': '', 'ended': 'failed:/secret/path'})
                    continue
                if mode == 'no_spawn':
                    time.sleep(30)
                spawn_line = {'version': 1, 'kind': 'host-spawn', 'bindingId': BINDING}
                if mode == 'spawn_extra_key':
                    spawn_line['extra'] = 1
                if mode == 'spawn_bad_id':
                    spawn_line['bindingId'] = 'not-a-uuid'
                if mode == 'spawn_v1_id':
                    spawn_line['bindingId'] = '5f6e7d8c-0000-1000-a000-00000000000b'
                if mode == 'spawn_v2':
                    spawn_line['version'] = 2
                if mode == 'spawn_int_id':
                    spawn_line['bindingId'] = 7
                if mode == 'spawn_no_version':
                    del spawn_line['version']
                out(spawn_line)
                if mode == 'second_spawn':
                    out(spawn_line)
            if mode == 'dispatch1_refused' and n == 1:
                out({'kind': 'host-dispatch', 'n': 1, 'ok': False, 'answer': ''})
                continue
            if mode == 'early_result':
                out({'kind': 'host-result', 'passed': True})
                continue
            bump()
            if n == 1 and mode in ('stray_unreadable', 'stray_unframed'):
                bump_stray(mode[len('stray_'):])
            if n == 1 and mode == 'real_refusal':
                c = load(path, ZERO)
                c['refused'] += 1
                save(c)
            text = 'something else' if (mode == 'wrong_answer' and n == 1) else ('x' * 600 if mode == 'long_answer' else answers[n])
            out({'kind': 'host-dispatch', 'n': 3 - n if mode == 'wrong_n' else n, 'ok': True, 'answer': text})
        elif command == 'reuse':
            if mode == 'reuse_accepted':
                bump()
                out({'kind': 'host-presented', 'which': 'spent', 'refused': False, 'errorClass': 'none', 'processStarted': True})
            elif mode == 'reuse_leaks':
                bump(frames=1, begins=0)
                out({'kind': 'host-presented', 'which': 'spent', 'refused': True, 'errorClass': 'required_context_unavailable', 'processStarted': False})
            else:
                out({'kind': 'host-presented', 'which': 'spent', 'refused': True, 'errorClass': 'required_context_unavailable', 'processStarted': False})
        elif command == 'premint':
            out({'kind': 'host-premint'})
        elif command == 'revoke':
            json.dump({'revoked': True}, open(flags, 'w'))
            out({'kind': 'host-revoked'})
        elif command == 'present-premint':
            if not flag.get('revoked'):
                out({'kind': 'host-presented', 'which': 'premint', 'refused': False, 'errorClass': 'none', 'processStarted': True})
                continue
            if mode == 'revoke_leaks':
                bump(frames=1, begins=0)
            out({'kind': 'host-presented', 'which': 'premint', 'refused': True, 'errorClass': 'other' if mode == 'revoke_wrong_class' else 'required_context_unavailable', 'processStarted': False})
        elif command == 'finish':
            if mode == 'no_result':
                time.sleep(30)  # the result only comes after the lifecycle record: the refused order
            if mode == 'exit_without_result':
                sys.exit(4)
            passed = mode != 'not_passed'
            out({'kind': 'host-result', 'passed': 'yes' if mode == 'passed_string' else passed})
            sys.exit(0 if passed else 1)
        else:
            out({'kind': 'host-command-refused', 'code': 'unknown'})

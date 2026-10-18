"""A fake role process for the runner's tests: speaks the assumed line-JSON contract (roles_adapter.ASSUMPTIONS).
usage: fake_role.py <provider|host> <state-dir> [mode]. The provider and the host share counters through the state dir,
as the real stub's counters would be moved by the real engine's requests; the host never reports counters itself."""
import base64
import hashlib
import json
import os
import sys
import time

role, state, mode = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else '')
path = os.path.join(state, 'counters.json')
flags = os.path.join(state, 'flags.json')


def load(p, default):
    try:
        return json.load(open(p))
    except OSError:
        return default


def bump(frames=3, begins=1):
    c = load(path, {'receivedFrames': 0, 'receivedBegins': 0, 'acceptedBegins': 0, 'completed': 0})
    c['receivedFrames'] += frames
    c['receivedBegins'] += begins
    c['acceptedBegins'] += begins
    c['completed'] += begins
    json.dump(c, open(path, 'w'))


def reply(value):
    sys.stdout.write(json.dumps(value) + '\n')
    sys.stdout.flush()


answers = {1: 'first deterministic answer', 2: 'second deterministic answer'}
for raw in sys.stdin:
    request = json.loads(raw)
    op = request['op']
    f = load(flags, {})
    if mode == 'silent':
        time.sleep(30)
    if mode == 'garbage':
        sys.stdout.write('not json\n')
        sys.stdout.flush()
        continue
    if mode == 'huge':
        sys.stdout.write('x' * 200000 + '\n')
        sys.stdout.flush()
        continue
    if mode == 'nonewline':
        sys.stdout.write('x' * 200000)
        sys.stdout.flush()
        time.sleep(30)
    if mode == 'ok_int':
        sys.stdout.write('{"ok": 1, "text": "first deterministic answer"}\n')
        sys.stdout.flush()
        continue
    if mode == 'exit':
        sys.exit(3)
    if role == 'provider':
        if op == 'script':
            data = base64.b64decode(request['b64'])
            ok = hashlib.sha256(data).hexdigest() == request['sha256'] and mode != 'script_refused'
            reply({'ok': ok})
        elif op == 'receipt':
            c = load(path, {'receivedFrames': 0, 'receivedBegins': 0, 'acceptedBegins': 0, 'completed': 0})
            reply({'ok': True, 'receipt': {**c, 'closed': False}})
    else:
        if op == 'dispatch':
            if mode == 'dispatch1_refused' and request['n'] == 1:
                reply({'ok': False, 'errorClass': 'internal'})
                continue
            bump()
            text = answers[request['n']] if not (mode == 'wrong_answer' and request['n'] == 1) else 'something else'
            reply({'ok': True, 'text': text})
        elif op == 'present_spent':
            if mode == 'reuse_accepted':
                bump()
                reply({'ok': True})
            elif mode == 'reuse_leaks':
                bump(frames=1, begins=0)
                reply({'ok': False, 'errorClass': 'required_context_unavailable'})
            else:
                reply({'ok': False, 'errorClass': 'required_context_unavailable'})
        elif op == 'premint':
            reply({'ok': True})
        elif op == 'revoke':
            json.dump({'revoked': True}, open(flags, 'w'))
            reply({'ok': True})
        elif op == 'present_premint':
            if not f.get('revoked'):
                reply({'ok': True})
                continue
            if mode == 'revoke_leaks':
                bump(frames=1, begins=0)
            reply({'ok': False, 'errorClass': 'required_context_unavailable' if mode != 'revoke_wrong_class' else 'internal'})

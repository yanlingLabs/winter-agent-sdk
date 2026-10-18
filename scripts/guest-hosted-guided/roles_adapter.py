"""The ONE module that talks to the two guided roles, `providerWorker` and `hostClient`. Source only.

Everything the hosted runner assumes about those roles is in this file and nowhere else, so reconciling with the real
roles' contracts (runtime-sdk, second compile run) is a change to this file plus the pins that name its bytes. The
assumptions are listed in ASSUMPTIONS and mirrored in docs/guided-hosted-run.md. None of them is a merged contract.

A role is a process with line-delimited JSON on stdin and stdout: one request object per line, one reply object per line,
replies at most MAX_LINE bytes, each answered within TIMEOUT seconds. The adapter never reads a role's stderr and never
trusts a role's own count of provider requests: the only counters it reports are the PROVIDER worker's receipt.
"""
from __future__ import annotations

import base64
import hashlib
import json
import selectors

MAX_LINE = 65536
TIMEOUT = 60.0
COUNTERS = ('receivedFrames', 'receivedBegins', 'acceptedBegins', 'completed')
ASSUMPTIONS = (
    'A1 providerWorker takes the Root-supplied script bytes with their independent SHA-256 as {"op":"script","sha256","b64"} and replies {"ok":true}',
    'A2 providerWorker answers {"op":"receipt"} with {"ok":true,"receipt":{receivedFrames,receivedBegins,acceptedBegins,completed}} from the stub itself',
    'A3 hostClient answers {"op":"dispatch","n":1|2} with {"ok":true,"text":...} or {"ok":false,"errorClass":...}',
    'A4 hostClient answers {"op":"present_spent"} with {"ok":false,"errorClass":...} when the spent ticket is refused, {"ok":true} when it is not',
    'A5 hostClient answers {"op":"premint"} with {"ok":true} after minting one more unspent ticket, and {"op":"revoke"} with {"ok":true}',
    'A6 hostClient answers {"op":"present_premint"} like present_spent; after revoke it must refuse as required_context_unavailable',
    'A7 a role exits when its stdin closes; a role that does not is killed by the platform that spawned it',
)


class AdapterError(Exception):
    """A bounded class, never role text: protocol, timeout, refused, closed."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


class Channel:
    """Line-delimited JSON over a spawned process's stdin/stdout, bounded in size and time."""

    def __init__(self, process, timeout=TIMEOUT):
        self.process = process
        self.timeout = timeout
        self.buffer = b''

    def call(self, request):
        line = json.dumps(request, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        try:
            self.process.stdin.write(line)
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise AdapterError('closed') from None
        reply = self._read_line()
        try:
            value = json.loads(reply)
        except ValueError:
            raise AdapterError('protocol') from None
        if type(value) is not dict or type(value.get('ok')) is not bool:
            raise AdapterError('protocol')
        return value

    def _read_line(self):
        selector = selectors.DefaultSelector()
        selector.register(self.process.stdout, selectors.EVENT_READ)
        try:
            while b'\n' not in self.buffer:
                if len(self.buffer) > MAX_LINE:
                    raise AdapterError('protocol')
                if not selector.select(self.timeout):
                    raise AdapterError('timeout')
                chunk = self.process.stdout.read1(MAX_LINE + 1) if hasattr(self.process.stdout, 'read1') else self.process.stdout.read(1)
                if not chunk:
                    raise AdapterError('closed')
                self.buffer += chunk
        finally:
            selector.close()
        line, _, self.buffer = self.buffer.partition(b'\n')
        if len(line) > MAX_LINE:
            raise AdapterError('protocol')
        return line


def _counters(receipt):
    if type(receipt) is not dict or any(type(receipt.get(key)) is not int for key in COUNTERS):
        raise AdapterError('protocol')
    return {key: receipt[key] for key in COUNTERS}


def _refusal(reply):
    """'' when the role accepted, otherwise its bounded error class (letters, digits, underscore; at most 64)."""
    if reply['ok']:
        return ''
    value = reply.get('errorClass')
    if type(value) is not str or not value or len(value) > 64 or not all(c.islower() or c.isdigit() or c == '_' for c in value):
        raise AdapterError('protocol')
    return value


class GuidedRoles:
    """The production adapter. `provider` and `host` are the two spawned processes (anything with binary stdin/stdout)."""

    def __init__(self, provider, host, timeout=TIMEOUT):
        self.provider = Channel(provider, timeout)
        self.host = Channel(host, timeout)

    def start_provider(self, script_bytes):
        digest = hashlib.sha256(script_bytes).hexdigest()
        reply = self.provider.call({'op': 'script', 'sha256': digest, 'b64': base64.b64encode(script_bytes).decode()})
        if not reply['ok']:
            raise AdapterError('refused')

    def stub_receipt(self):
        reply = self.provider.call({'op': 'receipt'})
        if not reply['ok']:
            raise AdapterError('refused')
        return _counters(reply.get('receipt'))

    def dispatch(self, n):
        reply = self.host.call({'op': 'dispatch', 'n': n})
        if not reply['ok']:
            raise AdapterError('refused')
        text = reply.get('text')
        if type(text) is not str or len(text) > 4096:
            raise AdapterError('protocol')
        return text

    def present_spent(self):
        return _refusal(self.host.call({'op': 'present_spent'}))

    def premint(self):
        if not self.host.call({'op': 'premint'})['ok']:
            raise AdapterError('refused')

    def revoke(self):
        if not self.host.call({'op': 'revoke'})['ok']:
            raise AdapterError('refused')

    def present_premint(self):
        return _refusal(self.host.call({'op': 'present_premint'}))

    def stop(self):
        for channel in (self.host, self.provider):
            try:
                channel.process.stdin.close()
            except (OSError, ValueError):
                pass

"""The ONE module that talks to the two guided roles, `providerWorker` and `hostClient`. Source only.

It speaks the contract the runtime-sdk entries lane states (draft runtime-sdk PR 20, `scripts/guest-guided-build/README.md`,
"Entry contracts" C-P1..C-P11 and C-H1..C-H12). Everything the hosted runner relies on about those roles is here and nowhere
else, so reconciling with the final contract is a change to this file plus the pins that name its bytes. CONTRACT lists the ids
used; REMAINING_DIFFERENCES lists what is still not settled. None of it is a merged contract until PR 20 merges.

Wire shape: Root writes one text command per line to each role's stdin; each role writes JSON lines on stdout, at most MAX_LINE
bytes, each `{"kind": ...}`. The provider also writes unsolicited `provider-ready`, `provider-request` and `provider-outcome` lines,
which are tolerated and counted but never trusted as evidence. The ONLY counters the adapter reports are the provider's own
receipt fields (C-P11) and its final summary (C-P9); the host client never reports provider-call counts and nothing it says about
them is read.
"""
from __future__ import annotations

import json
import re
import selectors

MAX_LINE = 4096
TIMEOUT = 60.0
MAX_NOISE = 4096
TAG = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')
COUNTERS = ('requests', 'unreadable', 'unframed', 'refused', 'receivedFrames', 'receivedBegins', 'acceptedBegins', 'completed')
CLASSES = frozenset(('required_context_unavailable', 'other', 'none'))
CONTRACT = (
    'C-P11 Root writes `receipt <tag>` to the provider stdin; it answers one `provider-receipt` line with the same tag and the counters',
    'C-P9 on SIGTERM the provider writes one `provider-summary` line and exits 0 even if it refused requests',
    'C-P8 provider stdout carries only provider-ready, provider-request, provider-outcome, provider-summary, provider-receipt, provider-control-refused, provider-refused',
    'C-H9 the host client takes the stdin lines `dispatch 1`, `dispatch 2`, `premint`, `reuse`, `revoke`, `present-premint`, `finish`; every command gets exactly one reply line',
    'C-H4 host stdout carries only host-spawn, host-query-ended, host-dispatch, host-premint, host-presented, host-revoked, host-command-refused, host-result, host-refused',
    'C-H10 `host-presented` has which (spent|premint), refused, errorClass (required_context_unavailable|other|none) and processStarted; refused means the first step threw AND no runtime process was created',
    'C-H12 the host client exits 0 only when host-result.passed is true; the last stdout line is host-result or host-refused',
    'C-P10 the provider exits 0 on a normal stop even if it refused requests',
)
# The order is DERIVED from the code that emits it, and pinned (docs/guided-hosted-run.md, "The finish order"):
#   1. `finish` is written by Root to the host stdin;
#   2. the host client leaves its command loop (`finished = true; break`), awaits its query pump and prints `host-result`
#      (runtime-sdk scripts/guest-guided-build/entries/host-client-core.ts, `finished = true; break;` then `await pump;` then `ports.emit(result);`);
#   3. only then does Root, having READ the result, wait for the runtime to stop and write the fd 7 lifecycle record
#      (session.py `GuidedSession.settle`, modelled on scripts/guest-host-query/verify.py `phase='observer'`).
# The host never waits for fd 7: host-client.ts `void process.exited.catch(...)` is the only use of the lifecycle reader, and no await in
# runGuidedHost depends on it (the v1 host-client.ts line 144 `await process.exited` is the contrast). The other order, a record written before
# the result is read, is refused by `settle(host_result_seen)` and a host-result that cannot be read before the record fails as `finish_order`.
FINISH_ORDER = ('finish', 'host-result', 'lifecycle-record')
REMAINING_DIFFERENCES = (
    'D1 whether `host-spawn` is printed at startup or at the first dispatch is not stated; it is tolerated anywhere before a reply',
    'D2 the exact run-time errorClass for a presentation that threw for another reason is `other`; the oracle treats anything but required_context_unavailable as not refused-as-required',
    'D3 the provider-request/provider-outcome lines are tolerated noise (bounded); they are never counted as evidence',
    'D4 a host-query-ended line is recorded and does not fail a command, but host-result.passed must still be true',
)


class AdapterError(Exception):
    """A bounded class, never role text: protocol, timeout, refused, closed."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


class Channel:
    """Text commands out, bounded JSON lines in, with a per-reply deadline."""

    def __init__(self, process, timeout=TIMEOUT):
        self.process = process
        self.timeout = timeout
        self.buffer = b''
        self.noise = 0

    def send(self, line):
        if not re.fullmatch(r'[a-z0-9 -]{1,64}', line):
            raise AdapterError('protocol')
        try:
            self.process.stdin.write(line.encode() + b'\n')
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise AdapterError('closed') from None

    def read(self):
        """One JSON object from one line, at most MAX_LINE bytes, with a string `kind`."""
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
        try:
            value = json.loads(line)
        except ValueError:
            raise AdapterError('protocol') from None
        if type(value) is not dict or type(value.get('kind')) is not str:
            raise AdapterError('protocol')
        return value

    def expect(self, kind, tolerated):
        """Read until a line of `kind`; lines of the tolerated kinds are skipped (bounded), anything else is a protocol error."""
        while True:
            value = self.read()
            if value['kind'] == kind:
                return value
            if value['kind'] in tolerated:
                self.noise += 1
                if self.noise > MAX_NOISE:
                    raise AdapterError('protocol')
                continue
            if value['kind'] == 'host-command-refused':
                raise AdapterError('refused')
            if value['kind'] == 'host-result':
                raise AdapterError('premature_result')  # a result before `finish` was sent: the host ended its own run, which is never a pass
            raise AdapterError('protocol')


def _int(value):
    return type(value) is int and 0 <= value <= 1 << 31


def counters(record):
    """The provider's own counters from a receipt or a summary; countersAgree must be true and every field a plain integer."""
    if type(record) is not dict or record.get('countersAgree') is not True or any(not _int(record.get(key)) for key in COUNTERS):
        raise AdapterError('protocol')
    return {key: record[key] for key in COUNTERS}


def _presented(reply, which):
    if reply.get('which') != which or type(reply.get('refused')) is not bool or reply.get('errorClass') not in CLASSES or type(reply.get('processStarted')) is not bool:
        raise AdapterError('protocol')
    if reply['refused']:
        if reply['processStarted'] or reply['errorClass'] == 'none':
            raise AdapterError('protocol')
        return reply['errorClass']
    if reply['errorClass'] != 'none':
        raise AdapterError('protocol')
    return ''


class GuidedRoles:
    """The production adapter. `provider` and `host` are the two spawned processes (anything with binary stdin/stdout)."""

    HOST_TOLERATED = ('host-spawn', 'host-query-ended')
    PROVIDER_TOLERATED = ('provider-request', 'provider-outcome', 'provider-control-refused')

    def __init__(self, provider, host, timeout=TIMEOUT):
        self.provider_process = provider
        self.host_process = host
        self.provider = Channel(provider, timeout)
        self.host = Channel(host, timeout)
        self.query_ended = []

    def _host(self, command, kind):
        self.host.send(command)
        return self.host.expect(kind, self.HOST_TOLERATED)

    def await_provider_ready(self):
        self.provider.expect('provider-ready', ())

    def stub_receipt(self, tag):
        if not TAG.fullmatch(tag):
            raise AdapterError('protocol')
        self.provider.send('receipt ' + tag)
        reply = self.provider.expect('provider-receipt', self.PROVIDER_TOLERATED)
        if reply.get('tag') != tag:
            raise AdapterError('protocol')
        return counters(reply)

    def dispatch(self, n):
        reply = self._host('dispatch %d' % n, 'host-dispatch')
        answer = reply.get('answer')
        if reply.get('n') != n or type(reply.get('ok')) is not bool or type(answer) is not str or len(answer.encode()) > 512:
            raise AdapterError('protocol')
        if not reply['ok']:
            raise AdapterError('refused')
        return answer

    def premint(self):
        self._host('premint', 'host-premint')

    def present_spent(self):
        return _presented(self._host('reuse', 'host-presented'), 'spent')

    def revoke(self):
        self._host('revoke', 'host-revoked')

    def present_premint(self):
        return _presented(self._host('present-premint', 'host-presented'), 'premint')

    def finish_send(self):
        self.host.send('finish')

    def finish_result(self):
        """True only if the host client's own `host-result.passed` is true."""
        reply = self.host.expect('host-result', self.HOST_TOLERATED)
        if type(reply.get('passed')) is not bool:
            raise AdapterError('protocol')
        return reply['passed']

    def stop(self):
        """Stop the provider (SIGTERM) and return its final summary counters, or None. The host's stdin is closed."""
        summary = None
        try:
            self.provider_process.terminate()
            summary = counters(self.provider.expect('provider-summary', self.PROVIDER_TOLERATED + ('provider-receipt',)))
        except (AdapterError, OSError):
            summary = None
        try:
            self.host_process.stdin.close()
        except (OSError, ValueError):
            pass
        return summary

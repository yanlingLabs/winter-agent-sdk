#!/usr/bin/env python3
"""Default SKIP; target requires fresh exact Root/45 review outside this program.

No automatic binary acquisition, workflow dispatch, privilege or namespace path.
The admission label is bookkeeping, not an authority token.
"""
import argparse
import hashlib
import json
import sys

VERSION = "1.3.14"
REVISION = "0d9b296af33f2b851fcbf4df3e9ec89751734ba4"
PAYLOAD_BYTES = 1024 * 1024


class Refusal(Exception):
    pass


def gate(args, platform, uid):
    if not args.admitted_run:
        return "SKIP"
    if platform != "linux" or uid == 0:
        raise Refusal("unprivileged_linux_required")
    for value in (args.bun_sha256, args.probe_sha256):
        if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise Refusal("exact_sha256_required")
    if not args.admission or not args.bun.startswith("/"):
        raise Refusal("exact_review_and_binary_required")
    return "TARGET"


def validate_receipt(value, peer_bytes, peer_sha256):
    """Pure oracle; no synthetic receipt is treated as native execution."""
    if not isinstance(value, dict) or value.get("status") != "PASS":
        raise Refusal("target_not_passed")
    if value.get("version") != VERSION or value.get("revision") != REVISION:
        raise Refusal("bun_pin")
    observations = value.get("fdObservations")
    if not isinstance(observations, list) or len(observations) > 64 or not all(isinstance(row, dict) for row in observations):
        raise Refusal("missing_f_getfd")
    required = {"adopt_before": True, "adopt_before_terminate": True,
        "adopt_after_terminate": False, "adopt_reuse_after_repeat": True,
        "invalid_before": True, "invalid_in_connect_error": True,
        "invalid_after_connect": True, "invalid_after_raw_close": False,
        "invalid_reuse_after_repeat": True, "baseline_after_rejection": True,
        "original_after_rejection": True}
    for label, opened in required.items():
        matches = [row for row in observations if isinstance(row, dict) and row.get("label") == label]
        if len(matches) != 1:
            raise Refusal("f_getfd_receipt")
        row = matches[0]
        if type(row.get("fd")) is not int or row["fd"] < 3 or type(row.get("flags")) is not int:
            raise Refusal("f_getfd_value")
        if (opened and (row["flags"] < 0 or row.get("errno") != 0)) or (not opened and (row["flags"] != -1 or row.get("errno") != 9)):
            raise Refusal("f_getfd_state")
    for group in (("adopt_before", "adopt_before_terminate", "adopt_after_terminate", "adopt_reuse_after_repeat"),
                  ("invalid_before", "invalid_in_connect_error", "invalid_after_connect", "invalid_after_raw_close", "invalid_reuse_after_repeat")):
        if len({row["fd"] for row in observations if row.get("label") in group}) != 1:
            raise Refusal("f_getfd_number_changed")
    success, terminal, failure = (value.get(k) for k in ("success", "terminate", "failure"))
    if not all(isinstance(row, dict) for row in (success, terminal, failure)):
        raise Refusal("missing_measurements")
    for key in ("before", "openBeforeReturn", "beforeTerminate"):
        if success.get(key) is not True:
            raise Refusal("success_ownership")
    for key in ("partials", "drains"):
        if type(success.get(key)) is not int or success[key] < 1:
            raise Refusal("unmeasured_backpressure")
    if type(success.get("opens")) is not int or success["opens"] != 1 or success.get("accepted") != PAYLOAD_BYTES or success.get("data") != "fixture-data":
        raise Refusal("data_or_open")
    if terminal.get("afterTerminate") is not False:
        raise Refusal("terminate_not_synchronous")
    for key in ("reusedExactNumber", "afterRepeatedTerminate", "originalStillOpen"):
        if terminal.get(key) is not True:
            raise Refusal("terminate_reuse")
    for key in ("invalidBefore", "rawOpenInCallback", "invalidAfter", "callbackBeforeReturn", "reusedExactNumber", "afterDetachedTerminate", "baselineStillOpen", "originalStillOpen"):
        if failure.get(key) is not True:
            raise Refusal("raw_ownership_unmeasured")
    for key in ("failureOpen", "postOpenError", "afterRawClose"):
        if failure.get(key) is not False:
            raise Refusal("wrong_failure_class")
    if type(failure.get("errorCalls")) is not int or failure["errorCalls"] != 1:
        raise Refusal("connect_error_receipt")
    if failure.get("throwClass") not in ("none", "synchronous_throw") or failure.get("rejectionClass") not in ("none", "rejected"):
        raise Refusal("failure_outcome")
    expected = hashlib.sha256(bytes(i % 251 for i in range(PAYLOAD_BYTES))).hexdigest()
    if type(peer_bytes) is not int or peer_bytes != PAYLOAD_BYTES or peer_sha256 != expected:
        raise Refusal("peer_payload")


def target(args):
    # Imports and fixture/native operations are below the default-SKIP boundary.
    import fcntl
    import os
    from pathlib import Path
    import selectors
    import socket
    import subprocess
    import tempfile
    import time

    probe = Path(__file__).with_name("probe.ts")
    binary = Path(args.bun)
    for path, expected in ((binary, args.bun_sha256), (probe, args.probe_sha256)):
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise Refusal("source_or_binary_digest")
    # This executes only the already admitted exact target binary, never downloads it.
    pin_env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}
    observed = subprocess.run([str(binary), "--version"], capture_output=True, env=pin_env, timeout=5, check=True).stdout.decode().strip()
    # Full immutable revision is independently enforced inside Bun before FD IO.
    if observed != VERSION:
        raise Refusal("binary_version")
    with tempfile.TemporaryDirectory(prefix="winter-bun-fd-proof-") as temporary:
        directory = Path(temporary)
        regular = directory / "regular.fixture"
        regular.write_bytes(b"fixture-only\n")
        left, peer = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        left.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        original = left.fileno()
        adopted = fcntl.fcntl(original, fcntl.F_DUPFD_CLOEXEC, 128)
        invalid = os.open(regular, os.O_RDONLY | os.O_CLOEXEC)
        baseline = os.open(regular, os.O_RDONLY | os.O_CLOEXEC)
        child = None
        selector = selectors.DefaultSelector()
        chunks = {"stdout": bytearray(), "stderr": bytearray()}
        parsed_bytes = 0
        receipts = []
        allow_read = False
        peer_count = 0
        peer_hash = hashlib.sha256()
        try:
            child = subprocess.Popen([str(binary), str(probe), "--admitted-fixture",
                str(adopted), str(original), str(invalid), str(baseline), str(regular)],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=temporary, env={**pin_env, "HOME": temporary, "TMPDIR": temporary},
                pass_fds=(adopted, original, invalid, baseline), close_fds=True)
            # Exclusive child ownership of all inherited originals/duplicates now.
            left.close()
            for fd in (adopted, invalid, baseline):
                os.close(fd)
            adopted = invalid = baseline = -1
            peer.sendall(b"fixture-data")
            peer.setblocking(False)
            selector.register(child.stdout, selectors.EVENT_READ, "stdout")
            selector.register(child.stderr, selectors.EVENT_READ, "stderr")
            end = time.monotonic() + 15
            while selector.get_map():
                if time.monotonic() >= end:
                    raise Refusal("runner_deadline")
                for key, _ in selector.select(0.05):
                    if key.data == "peer":
                        data = peer.recv(65536)
                        if not data:
                            selector.unregister(peer)
                        else:
                            peer_count += len(data)
                            if peer_count > PAYLOAD_BYTES:
                                raise Refusal("peer_overflow")
                            peer_hash.update(data)
                    else:
                        data = os.read(key.fd, 4096)
                        if not data:
                            selector.unregister(key.fileobj)
                        else:
                            chunks[key.data].extend(data)
                            if len(chunks[key.data]) > 65536:
                                raise Refusal("bounded_output")
                stdout = chunks["stdout"]
                while b"\n" in stdout[parsed_bytes:]:
                    line_end = stdout.index(b"\n", parsed_bytes)
                    row = json.loads(stdout[parsed_bytes:line_end])
                    parsed_bytes = line_end + 1
                    if not isinstance(row, dict):
                        raise Refusal("malformed_output")
                    if row.get("event") == "backpressure":
                        if not allow_read:
                            allow_read = True
                            selector.register(peer, selectors.EVENT_READ, "peer")
                    elif row.get("status") in ("PASS", "FAIL", "SKIP"):
                        receipts.append(row)
                    else:
                        raise Refusal("unexpected_output")
                if child.poll() is not None and not allow_read:
                    break
            code = child.wait(timeout=1)
            if code != 0 or chunks["stderr"] or parsed_bytes != len(chunks["stdout"]) or len(receipts) != 1:
                return {"status": "FAIL", "reason": "target_exit_or_output", "exitCode": code,
                    "target": receipts, "stderrBytes": len(chunks["stderr"]), "peerBytes": peer_count}
            validate_receipt(receipts[0], peer_count, peer_hash.hexdigest())
            return {"status": "PASS", "scope": "unprivileged_inherited_fd_only", "admission": args.admission,
                "bunSha256": args.bun_sha256, "probeSha256": args.probe_sha256,
                "target": receipts[0], "peerBytes": peer_count, "peerSha256": peer_hash.hexdigest(),
                "childReaped": True, "vmExecutionVerified": False, "productionActivation": False}
        finally:
            if child is not None and child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            selector.close()
            peer.close()
            left.close()
            for fd in (adopted, invalid, baseline):
                if fd >= 0:
                    os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admitted-run", action="store_true")
    parser.add_argument("--admission", default="")
    parser.add_argument("--bun", default="")
    parser.add_argument("--bun-sha256", default="")
    parser.add_argument("--probe-sha256", default="")
    args = parser.parse_args(argv)
    try:
        if not args.admitted_run:
            print(json.dumps({"status": "SKIP", "reason": "fresh_exact_Root_45_admission_required"}))
            return 77
        import os
        gate(args, sys.platform, os.getuid())
        result = target(args)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["status"] == "PASS" else 1
    except (Refusal, OSError, ValueError) as error:
        print(json.dumps({"status": "FAIL", "reason": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())

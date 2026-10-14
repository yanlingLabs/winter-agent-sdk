"""Inert source/gate/oracle tests. Never import probe.ts or run native target."""
import ast
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).parent
spec = importlib.util.spec_from_file_location("bun_fd_fixture", DIRECTORY / "run.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def args(**changes):
    value = dict(admitted_run=False, bun="/fixture/bun", admission="review-only-placeholder",
                 bun_sha256="a" * 64, probe_sha256="b" * 64)
    value.update(changes)
    return SimpleNamespace(**value)


def receipt():
    return dict(status="PASS", version=runner.VERSION, revision=runner.REVISION,
        fdObservations=[dict(label=label, fd=fd, flags=0 if opened else -1, errno=0 if opened else 9)
            for label, fd, opened in (("adopt_before", 128, True), ("adopt_before_terminate", 128, True),
                ("adopt_after_terminate", 128, False), ("adopt_reuse_after_repeat", 128, True),
                ("invalid_before", 5, True), ("invalid_in_connect_error", 5, True),
                ("invalid_after_connect", 5, True), ("invalid_after_raw_close", 5, False),
                ("invalid_reuse_after_repeat", 5, True), ("baseline_after_rejection", 6, True),
                ("original_after_rejection", 3, True))],
        success=dict(before=True, openBeforeReturn=True, beforeTerminate=True, opens=1,
                     partials=2, drains=2, accepted=runner.PAYLOAD_BYTES, data="fixture-data"),
        terminate=dict(afterTerminate=False, reusedExactNumber=True, afterRepeatedTerminate=True,
                       originalStillOpen=True),
        failure=dict(invalidBefore=True, rawOpenInCallback=True, invalidAfter=True,
                     callbackBeforeReturn=True, reusedExactNumber=True, afterDetachedTerminate=True,
                     failureOpen=False, postOpenError=False, afterRawClose=False, errorCalls=1,
                     throwClass="none", rejectionClass="rejected", baselineStillOpen=True, originalStillOpen=True))


class SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.peer_hash = hashlib.sha256(bytes(i % 251 for i in range(runner.PAYLOAD_BYTES))).hexdigest()

    def validate(self, value):
        runner.validate_receipt(value, runner.PAYLOAD_BYTES, self.peer_hash)

    def test_default_gate_never_enters_target(self):
        with patch.object(runner, "target", side_effect=AssertionError("native target entered")):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(runner.main([]), 77)
            self.assertIn('"status": "SKIP"', output.getvalue())
        self.assertEqual(runner.gate(args(), "darwin", 0), "SKIP")

    def test_exact_target_gate(self):
        self.assertEqual(runner.gate(args(admitted_run=True), "linux", 1000), "TARGET")
        for platform, uid in (("darwin", 1000), ("linux", 0)):
            with self.subTest(platform=platform, uid=uid), self.assertRaises(runner.Refusal):
                runner.gate(args(admitted_run=True), platform, uid)
        for change in ({"bun_sha256": "x" * 64}, {"probe_sha256": "a" * 63},
                       {"admission": ""}, {"bun": "bun"}):
            with self.subTest(change=change), self.assertRaises(runner.Refusal):
                runner.gate(args(admitted_run=True, **change), "linux", 1000)

    def test_complete_synthetic_oracle_only(self):
        self.validate(receipt())

    def test_missing_or_wrong_bun_identity(self):
        for change in (dict(status="SKIP"), dict(version="1.3.13"), dict(revision="0d9b296af"), dict(success=None)):
            with self.subTest(change=change), self.assertRaises(runner.Refusal):
                self.validate({**receipt(), **change})

    def test_actual_f_getfd_trace_required(self):
        for mutate in (lambda v: v.pop("fdObservations"),
                       lambda v: v["fdObservations"].pop(),
                       lambda v: v["fdObservations"][2].update(errno=22),
                       lambda v: v["fdObservations"][3].update(fd=129)):
            value = receipt()
            mutate(value)
            with self.assertRaises(runner.Refusal):
                self.validate(value)

    def test_every_ownership_observation_required(self):
        sections = {"success": ("before", "openBeforeReturn", "beforeTerminate"),
            "terminate": ("reusedExactNumber", "afterRepeatedTerminate", "originalStillOpen"),
            "failure": ("invalidBefore", "rawOpenInCallback", "invalidAfter", "callbackBeforeReturn",
                        "reusedExactNumber", "afterDetachedTerminate", "baselineStillOpen", "originalStillOpen")}
        for section, keys in sections.items():
            for key in keys:
                value = receipt()
                value[section][key] = False
                with self.subTest(section=section, key=key), self.assertRaises(runner.Refusal):
                    self.validate(value)

    def test_rejection_or_throw_alone_never_proves_raw_ownership(self):
        for outcome in ("rejected", "none"):
            value = receipt()
            value["failure"].update(errorCalls=0, callbackBeforeReturn=False, rejectionClass=outcome)
            with self.subTest(outcome=outcome), self.assertRaises(runner.Refusal):
                self.validate(value)
        for key in ("failureOpen", "postOpenError", "afterRawClose"):
            value = receipt()
            value["failure"][key] = True
            with self.subTest(key=key), self.assertRaises(runner.Refusal):
                self.validate(value)

    def test_no_backpressure_no_pass(self):
        for key in ("partials", "drains"):
            for count in (0, -1, True, 1.5):
                value = receipt()
                value["success"][key] = count
                with self.subTest(key=key, count=count), self.assertRaises(runner.Refusal):
                    self.validate(value)

    def test_peer_bytes_independently_required(self):
        for count, digest in ((runner.PAYLOAD_BYTES - 1, self.peer_hash), (runner.PAYLOAD_BYTES, "0" * 64)):
            with self.subTest(count=count), self.assertRaises(runner.Refusal):
                runner.validate_receipt(receipt(), count, digest)

    def test_synchronous_close_and_exact_error_count(self):
        value = receipt()
        value["terminate"]["afterTerminate"] = True
        with self.assertRaises(runner.Refusal):
            self.validate(value)
        for count in (0, 2, True):
            value = receipt()
            value["failure"]["errorCalls"] = count
            with self.subTest(count=count), self.assertRaises(runner.Refusal):
                self.validate(value)

    def test_source_has_no_top_level_target_operations(self):
        tree = ast.parse((DIRECTORY / "run.py").read_text())
        imports = [node.names[0].name for node in tree.body if isinstance(node, ast.Import)]
        self.assertEqual(imports, ["argparse", "hashlib", "json", "sys"])
        source = (DIRECTORY / "probe.ts").read_text()
        self.assertLess(source.index('process.exit(77)'), source.index('await import("bun:ffi")'))
        self.assertIn('connect({ fd: adoptFd!, socket:', source)
        self.assertIn('connect({ fd: invalidFd!, socket:', source)


if __name__ == "__main__":
    unittest.main()

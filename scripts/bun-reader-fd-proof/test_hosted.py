"""Source/DATA-only tests; no acquisition, extraction, process or FD target run."""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile
from test_source import receipt, runner

DIRECTORY = Path(__file__).parent
spec = importlib.util.spec_from_file_location("bun_hosted_source", DIRECTORY / "hosted.py")
hosted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosted)


def args(**changes):
    value = dict(admitted_hosted_run=True, repository=hosted.REPOSITORY, ref=hosted.BRANCH,
                 before="0" * 40, head="a" * 40, attempt="1", run_id="12345", result="out/bun-fd-proof/result.json")
    value.update(changes)
    return SimpleNamespace(**value)


def binary():
    data = bytearray(64)
    data[:6] = b"\x7fELF\x02\x01"
    data[18:20] = b"\xb7\x00"
    return bytes(data)


def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as value:
        for name, data in entries:
            value.writestr(name, data)
    return output.getvalue()


class HostedSourceTests(unittest.TestCase):
    def test_exact_https_redirect_hosts_only(self):
        for hostname in ("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"):
            with self.subTest(hostname=hostname):
                self.assertTrue(hosted.redirect_allowed("https", hostname, None, None))
                self.assertFalse(hosted.redirect_allowed("http", hostname, None, None))
                self.assertFalse(hosted.redirect_allowed("https", hostname, "user", None))
                self.assertFalse(hosted.redirect_allowed("https", hostname, None, "password"))
                self.assertFalse(hosted.redirect_allowed("https", hostname, "", None))
        for hostname in (None, "evil.example", "sub.objects.githubusercontent.com",
                         "objects.githubusercontent.com.evil.example", "objects.githubusercontent.com.",
                         "objects.githubusercontent.com@evil.example"):
            with self.subTest(hostname=hostname):
                self.assertFalse(hosted.redirect_allowed("https", hostname, None, None))

    def test_default_skip_cannot_enter_target(self):
        with patch.object(hosted, "target", side_effect=AssertionError("target entered")):
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(hosted.main([]), 77)
            self.assertIn('"status": "SKIP"', output.getvalue())
        self.assertEqual(hosted.gate(args(admitted_hosted_run=False), "darwin", "arm64", 0, 0), "SKIP")

    def test_closed_first_push_target_gate(self):
        self.assertEqual(hosted.gate(args(), "linux", "aarch64", 1000, 1000), "TARGET")
        for change in (dict(attempt="2"), dict(before="1" * 40), dict(ref="refs/heads/main"),
                       dict(repository="other/repo"), dict(head="a" * 39), dict(run_id=""), dict(result="/tmp/other")):
            with self.subTest(change=change), self.assertRaises(hosted.Refusal):
                hosted.gate(args(**change), "linux", "aarch64", 1000, 1000)
        for platform, machine, uid, euid in (("darwin", "arm64", 1000, 1000),
                ("linux", "x86_64", 1000, 1000), ("linux", "aarch64", 0, 1000), ("linux", "aarch64", 1000, 0)):
            with self.subTest(platform=platform, machine=machine, uid=uid, euid=euid), self.assertRaises(hosted.Refusal):
                hosted.gate(args(), platform, machine, uid, euid)

    def test_official_metadata_and_checksum_text_data(self):
        metadata_bytes = (DIRECTORY / "official-release-DATA.json").read_bytes()
        self.assertEqual(hashlib.sha256(metadata_bytes).hexdigest(), hosted.METADATA_SHA)
        metadata = json.loads(metadata_bytes)
        checksum = (DIRECTORY / "SHASUMS256.txt").read_bytes()
        signed = (DIRECTORY / "SHASUMS256.txt.asc").read_bytes()
        hosted.check_metadata(metadata, checksum, signed)
        self.assertIn("not independently verified", metadata["signatureResidual"])
        for change in (dict(releaseId=0), dict(targetCommit="b" * 40)):
            with self.assertRaises(hosted.Refusal):
                hosted.check_metadata({**metadata, **change}, checksum, signed)
        with self.assertRaises(hosted.Refusal):
            hosted.check_metadata(metadata, checksum + b"\n", signed)

    def test_reviewed_source_pins_still_match(self):
        for name, expected in (("run.py", hosted.RUNNER_SHA), ("probe.ts", hosted.PROBE_SHA)):
            self.assertEqual(hashlib.sha256((DIRECTORY / name).read_bytes()).hexdigest(), expected)

    def test_closed_zip_inventory_data_only(self):
        self.assertEqual(hosted.unzip_binary(archive([("bun-linux-aarch64/bun", binary())])), binary())
        self.assertEqual(hosted.unzip_binary(archive([("bun-linux-aarch64/", b""), ("bun-linux-aarch64/bun", binary())])), binary())
        for entries in ([('../bun', binary())], [('bun-linux-aarch64/bun', binary()), ('extra', b'x')],
                        [('bun-linux-aarch64/bun', b'not-elf')], [('bun-linux-aarch64/', b'x'), ('bun-linux-aarch64/bun', binary())]):
            with self.subTest(entries=entries), self.assertRaises(hosted.Refusal):
                hosted.unzip_binary(archive(entries))

    def test_zip_symlink_and_bound_refused(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as value:
            entry = zipfile.ZipInfo("bun-linux-aarch64/bun")
            entry.external_attr = 0o120777 << 16
            value.writestr(entry, binary())
        with self.assertRaises(hosted.Refusal):
            hosted.unzip_binary(output.getvalue())
        with patch.object(hosted, "MAX_BINARY", 63), self.assertRaises(hosted.Refusal):
            hosted.unzip_binary(archive([("bun-linux-aarch64/bun", binary())]))

    def test_runner_output_scope_closed(self):
        value = dict(status="PASS", scope="unprivileged_inherited_fd_only", childReaped=True,
                     vmExecutionVerified=False, productionActivation=False, target=receipt(),
                     peerBytes=runner.PAYLOAD_BYTES, peerSha256=hashlib.sha256(bytes(i % 251 for i in range(runner.PAYLOAD_BYTES))).hexdigest(),
                     probeSha256=hosted.PROBE_SHA)
        self.assertEqual(hosted.parse_runner_output(0, (json.dumps(value) + "\n").encode(), b"", runner.validate_receipt)["status"], "PASS")
        for change in (dict(scope="VM"), dict(childReaped=False), dict(vmExecutionVerified=True), dict(productionActivation=True)):
            with self.assertRaises(hosted.Refusal):
                hosted.parse_runner_output(0, (json.dumps({**value, **change}) + "\n").encode(), b"", runner.validate_receipt)
        with self.assertRaises(runner.Refusal):
            hosted.parse_runner_output(0, (json.dumps({**value, "target": None}) + "\n").encode(), b"", runner.validate_receipt)
        self.assertEqual(hosted.parse_runner_output(1, b'{"status":"FAIL"}\n', b"", runner.validate_receipt)["status"], "FAIL")
        for stdout, stderr in ((b'{"status":"SKIP"}\n', b''), (b'{}\n{}\n', b''), (b'{}', b''), (b'{}\n', b'error')):
            with self.assertRaises(hosted.Refusal):
                hosted.parse_runner_output(0, stdout, stderr, runner.validate_receipt)

    def test_workflow_source_pins_and_one_shot_guards(self):
        repository = DIRECTORY.parent.parent
        workflow = (repository / '.github/workflows/cowork-bun-fd-proof-reviewed.yml').read_text()
        self.assertIn(hashlib.sha256((DIRECTORY / 'hosted.py').read_bytes()).hexdigest(), workflow)
        for required in ('actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
                         'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
                         'cancel-in-progress: false', 'github.run_attempt == 1', 'ubuntu-24.04-arm',
                         "github.event.before == '" + '0' * 40 + "'", 'persist-credentials: false',
                         'contents: read', 'env -i', 'resultBytes', 'resultSha256'):
            self.assertIn(required, workflow)
        for forbidden in ('workflow_dispatch', 'pull_request:', 'sudo', 'container:', 'secrets.',
                          'github.token', 'setup-bun', 'continue-on-error', 'curl', 'retry'):
            self.assertNotIn(forbidden, workflow)
        ci = (repository / '.github/workflows/ci.yml').read_text()
        self.assertIn("branches-ignore: ['cowork/bun-reader-fd-hosted-proof']", ci)
        self.assertIn('  pull_request:', ci)


if __name__ == "__main__":
    unittest.main()

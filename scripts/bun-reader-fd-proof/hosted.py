#!/usr/bin/env python3
"""SOURCE: one-shot admitted hosted CLI-Bun fixture, inert by default."""
import argparse
import hashlib
import io
import json
import re
import sys
import zipfile

ARCHIVE_SHA = "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b"
ARCHIVE_SIZE = 35700603
ARCHIVE_URL = "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-aarch64.zip"
PROBE_SHA = "1eeac2e001bcddda0a126211265c17bbb7233d670964a4ce9f043c0f53f11499"
RUNNER_SHA = "0d0b1066dc54c7665c21d54fe3fcf7df06f26c3572033526e35a9d6ab9fd5b6d"
CHECKSUM_SHA = "0fec8a7c8c72e903dba7ca24b533f9e924da296e65dec32418f68389ccd26165"
SIGNATURE_SHA = "f7dae34eb12b0752232f284a517457d9e7de44db90c8b8cfd6a494fcee410c9e"
METADATA_SHA = "ab6677c961b27a79e6473e8c3e2889c974684e93854675383bc31791c06ee02d"
BRANCH = "refs/heads/cowork/bun-reader-fd-hosted-proof"
REPOSITORY = "yanlingLabs/winter-agent-sdk"
MAX_BINARY = 134217728
MAX_RESULT = 65536


class Refusal(Exception):
    pass


def redirect_allowed(scheme, hostname, username, password):
    return scheme == "https" and hostname in (
        "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"
    ) and username is None and password is None


def gate(args, platform, machine, uid, euid):
    if not args.admitted_hosted_run:
        return "SKIP"
    if (platform, machine) != ("linux", "aarch64") or uid == 0 or euid == 0:
        raise Refusal("ordinary_linux_arm64_required")
    if args.repository != REPOSITORY or args.ref != BRANCH or args.attempt != "1" or args.before != "0" * 40:
        raise Refusal("first_branch_push_attempt1_required")
    if not re.fullmatch("[0-9a-f]{40}", args.head) or not args.run_id.isdecimal():
        raise Refusal("run_identity_required")
    if args.result != "out/bun-fd-proof/result.json":
        raise Refusal("closed_result_path")
    return "TARGET"


def check_metadata(metadata, checksum, signed):
    if hashlib.sha256(checksum).hexdigest() != CHECKSUM_SHA or hashlib.sha256(signed).hexdigest() != SIGNATURE_SHA:
        raise Refusal("checksum_text_pin")
    lines = checksum.decode("ascii").splitlines()
    selected = [line for line in lines if line.endswith("  bun-linux-aarch64.zip")]
    if selected != [ARCHIVE_SHA + "  bun-linux-aarch64.zip"]:
        raise Refusal("checksum_archive_crosscheck")
    # Text crosscheck is explicitly NOT independent PGP cryptographic verification.
    if not signed.startswith(b"-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\n") or b"-----BEGIN PGP SIGNATURE-----" not in signed:
        raise Refusal("clearsigned_text_shape")
    body = signed.split(b"\n\n", 1)[1].split(b"-----BEGIN PGP SIGNATURE-----", 1)[0].rstrip(b"\n")
    if body != checksum.rstrip(b"\n"):
        raise Refusal("signed_payload_crosscheck")
    if metadata.get("releaseId") != 320260981 or metadata.get("tag") != "bun-v1.3.14" or metadata.get("targetCommit") != "0d9b296af33f2b851fcbf4df3e9ec89751734ba4":
        raise Refusal("release_identity")
    archive = metadata.get("assets", {}).get("bun-linux-aarch64.zip", {})
    if archive != {"id": 418773677, "name": "bun-linux-aarch64.zip", "sha256": ARCHIVE_SHA,
                   "size": ARCHIVE_SIZE, "url": ARCHIVE_URL}:
        raise Refusal("release_asset_pin")


def unzip_binary(data):
    """Pure bounded ZIP interpretation; never extract paths or execute bytes."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(set(names)) != len(names) or set(names) not in ({"bun-linux-aarch64/bun"}, {"bun-linux-aarch64/", "bun-linux-aarch64/bun"}):
            raise Refusal("closed_zip_inventory")
        binary = archive.getinfo("bun-linux-aarch64/bun")
        kind = (binary.external_attr >> 16) & 0o170000
        if binary.flag_bits & 1 or kind not in (0, 0o100000) or not 1 <= binary.file_size <= MAX_BINARY:
            raise Refusal("zip_binary_identity")
        if "bun-linux-aarch64/" in names:
            directory = archive.getinfo("bun-linux-aarch64/")
            if directory.file_size != 0 or not directory.is_dir():
                raise Refusal("zip_directory_identity")
        with archive.open(binary) as stream:
            value = stream.read(MAX_BINARY + 1)
        if len(value) != binary.file_size or len(value) > MAX_BINARY:
            raise Refusal("zip_binary_bound")
        # ELF class64/little-endian/AArch64. This identifies ABI, not safe behavior.
        if len(value) < 20 or value[:6] != b"\x7fELF\x02\x01" or value[18:20] != b"\xb7\x00":
            raise Refusal("binary_elf_arm64")
        return value


def parse_runner_output(code, stdout, stderr, receipt_oracle):
    if len(stdout) > MAX_RESULT or stderr or not stdout.endswith(b"\n") or stdout.count(b"\n") != 1:
        raise Refusal("runner_output_bound_shape")
    value = json.loads(stdout)
    if not isinstance(value, dict) or value.get("status") not in ("PASS", "FAIL"):
        raise Refusal("runner_closed_result")
    if code != 0 or value["status"] != "PASS":
        return {"status": "FAIL", "reason": "actual_fd_probe_failed", "runnerExit": code, "runner": value}
    if value.get("scope") != "unprivileged_inherited_fd_only" or value.get("childReaped") is not True or value.get("vmExecutionVerified") is not False or value.get("productionActivation") is not False:
        raise Refusal("runner_scope")
    if value.get("runnerSha256") not in (None, RUNNER_SHA) or value.get("probeSha256") != PROBE_SHA:
        raise Refusal("runner_source_pin")
    receipt_oracle(value.get("target"), value.get("peerBytes"), value.get("peerSha256"))
    return {"status": "PASS", "scope": "unprivileged_cli_bun_fd_behavior_only", "runner": value}


def target(args):
    import os
    from pathlib import Path
    import subprocess
    import signal
    import tempfile
    import urllib.parse
    import urllib.request

    directory = Path(__file__).resolve().parent
    runner_source = None
    for name, digest in (("probe.ts", PROBE_SHA), ("run.py", RUNNER_SHA)):
        source = (directory / name).read_bytes()
        if hashlib.sha256(source).hexdigest() != digest:
            raise Refusal("reviewed_source_digest")
        if name == "run.py":
            runner_source = source
    # Execute only the already-hashed inert declarations to reuse the exact closed
    # receipt oracle independently. __main__ is absent; target remains uncalled.
    oracle_scope = {"__name__": "reviewed_fd_receipt_oracle", "__file__": str(directory / "run.py")}
    exec(compile(runner_source, "<reviewed-fd-receipt-oracle>", "exec"), oracle_scope)
    metadata_bytes = (directory / "official-release-DATA.json").read_bytes()
    if hashlib.sha256(metadata_bytes).hexdigest() != METADATA_SHA:
        raise Refusal("release_metadata_digest")
    metadata = json.loads(metadata_bytes)
    check_metadata(metadata, (directory / "SHASUMS256.txt").read_bytes(), (directory / "SHASUMS256.txt.asc").read_bytes())

    class ClosedRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            parsed = urllib.parse.urlparse(newurl)
            if not redirect_allowed(parsed.scheme, parsed.hostname, parsed.username, parsed.password):
                raise Refusal("official_asset_redirect")
            return super().redirect_request(request, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(ClosedRedirect, urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "winter-reviewed-fd-fixture"}), timeout=30) as response:
        data = response.read(ARCHIVE_SIZE + 1)
    if len(data) != ARCHIVE_SIZE or hashlib.sha256(data).hexdigest() != ARCHIVE_SHA:
        raise Refusal("official_archive_digest_size")
    binary_data = unzip_binary(data)
    binary_sha = hashlib.sha256(binary_data).hexdigest()
    with tempfile.TemporaryDirectory(prefix="winter-bun-hosted-") as temporary:
        root = Path(temporary)
        binary = root / "bun"
        binary.write_bytes(binary_data)
        binary.chmod(0o500)
        # No GitHub credentials, runner tokens, LD overrides, proxy or user config.
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": temporary, "TMPDIR": temporary}
        child = subprocess.Popen(["/usr/bin/python3", "-I", "-S", "-B", str(directory / "run.py"),
            "--admitted-run", "--admission", "Root45:run-" + args.run_id + ":" + args.head,
            "--bun", str(binary), "--bun-sha256", binary_sha, "--probe-sha256", PROBE_SHA],
            cwd=temporary, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
        try:
            stdout, stderr = child.communicate(timeout=40)
        finally:
            if child.poll() is None:
                # ONLY the fresh session created above; never an ambient/user group.
                try:
                    if os.getpgid(child.pid) != child.pid:
                        child.kill()
                    else:
                        os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                finally:
                    child.wait(timeout=5)
        result = parse_runner_output(child.returncode, stdout, stderr, oracle_scope["validate_receipt"])
        if result["status"] == "PASS" and result["runner"].get("bunSha256") != binary_sha:
            raise Refusal("runner_binary_pin")
        result.update(archiveSha256=ARCHIVE_SHA, archiveBytes=ARCHIVE_SIZE, binarySha256=binary_sha,
            runnerSha256=RUNNER_SHA, probeSha256=PROBE_SHA, signatureVerified=False,
            signatureResidual=metadata["signatureResidual"], vmExecutionVerified=False, productionActivation=False,
            runId=args.run_id, attempt=1, sourceHead=args.head)
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admitted-hosted-run", action="store_true")
    for option in ("repository", "ref", "before", "head", "attempt", "run-id", "result"):
        parser.add_argument("--" + option, default="")
    args = parser.parse_args(argv)
    if not args.admitted_hosted_run:
        print(json.dumps({"status": "SKIP", "reason": "fresh_exact_Root_45_hosted_admission_required"}))
        return 77
    import os
    import platform
    from pathlib import Path
    try:
        gate(args, sys.platform, platform.machine(), os.getuid(), os.geteuid())
        result = target(args)
    except Exception as error:
        # No raw URLs/paths/stderr are uploaded. Preserve only closed refusal codes.
        reason = str(error) if isinstance(error, Refusal) else "hosted_fixture_exception"
        result = {"status": "FAIL", "reason": reason, "vmExecutionVerified": False, "productionActivation": False}
    data = (json.dumps(result, sort_keys=True) + "\n").encode()
    if len(data) > MAX_RESULT:
        data = b'{"status":"FAIL","reason":"final_result_bound"}\n'
    destination = Path(args.result)
    destination.write_bytes(data)
    print(json.dumps({"status": result["status"], "resultBytes": len(data), "resultSha256": hashlib.sha256(data).hexdigest()}))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Explicit Linux fixture; private mounts/UIDs only, no daemon, VM or credentials."""
import base64
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def command(argv, payload=b"", timeout=10):
    child = subprocess.Popen([str(arg) for arg in argv], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = child.communicate(payload, timeout=timeout)
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.communicate(timeout=2)
        raise
    return child.returncode, stdout, stderr


def checked(argv):
    code, stdout, stderr = command(argv, timeout=60)
    if code != 0:
        raise RuntimeError(f"fixture command failed ({code}): {stderr.decode(errors='replace')[:2000]}")
    return stdout


def main():
    if os.uname().sysname != "Linux" or os.geteuid() != 0:
        raise SystemExit("Explicit Linux root fixture required; production code never invokes this launcher")
    compiler = shutil.which("cc")
    if not compiler:
        raise SystemExit("An existing Linux C compiler is required")
    with tempfile.TemporaryDirectory(prefix="winter-guest-files-") as temp:
        fixture = Path(temp)
        (fixture / ".fixture").write_text("winter-guest-file-fixture\n")
        os.chmod(fixture / ".fixture", 0o600)
        worker, launcher = fixture / "file-worker", fixture / "compartment"
        for source, target in ((ROOT / "packages/runtime/src/guest/file-worker.c", worker),
                               (HERE / "compartment.c", launcher)):
            checked([compiler, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static", source, "-o", target])
            os.chmod(target, 0o555)
        for name in ("source", "readonly"):
            path = fixture / name
            path.mkdir()
            os.chown(path, 10001, 10000)
            os.chmod(path, 0o2770)
            (path / "seed").write_bytes(b"unchanged-seed")
            os.chown(path / "seed", 10001, 10000)
            os.chmod(path / "seed", 0o660)
        (fixture / "readonly/secret").write_bytes(b"out-of-root-sentinel")
        os.chmod(fixture / "readonly/secret", 0o644)
        (fixture / "source/inside-link").symlink_to("seed")
        (fixture / "source/outside-link").symlink_to("../readonly/secret")
        (fixture / "source/absolute-link").symlink_to("/readonly/secret")
        (fixture / "source/directory").mkdir()
        os.chown(fixture / "source/directory", 10001, 10000)
        os.mkfifo(fixture / "source/fifo", 0o660)
        os.chown(fixture / "source/fifo", 10001, 10000)
        checks = []

        def execute(operation, relative, data=b"", root="/source", policy="auto", uid=10001, limit=4096):
            view = tempfile.mkdtemp(prefix="view-", dir=fixture)
            code, stdout, stderr = command([launcher, worker, fixture, view, uid, policy,
                operation, root, relative, limit], base64.b64encode(data) if operation == "write" else b"")
            if len(stdout) > 16384 or len(stderr) > 16384:
                raise AssertionError("fixture result exceeded its output bound")
            try:
                result = json.loads(stdout)
            except (ValueError, TypeError) as error:
                raise AssertionError(f"missing worker receipt; code={code}; stderr={stderr!r}") from error
            assert result.get("version") == 1 and isinstance(result.get("ok"), bool), result
            assert (code == 0) == result["ok"], (code, result)
            if result["ok"] and operation == "read":
                decoded = base64.b64decode(result["dataBase64"], validate=True)
                assert result["bytes"] == len(decoded)
                result["data"] = decoded
            return result

        def ok(name, result):
            assert result["ok"], (name, result)
            checks.append(name)
            return result

        def denied(name, result, code, errnos):
            assert not result["ok"] and result["code"] == code and result["errno"] in errnos, (name, result)
            checks.append(name)

        assert ok("ordinary read", execute("read", "seed"))["data"] == b"unchanged-seed"
        assert ok("in-root relative symlink", execute("read", "inside-link"))["data"] == b"unchanged-seed"
        denied("relative escape", execute("read", "outside-link"), "path_denied", [18])
        denied("absolute escape", execute("read", "absolute-link"), "path_denied", [18])
        denied("parent escape", execute("read", "../readonly/secret"), "path_denied", [18])
        assert ok("independent read-only root", execute("read", "secret", root="/readonly"))["data"] == b"out-of-root-sentinel"
        payload = b"written \x00binary\xff\n"
        ok("write byte identity", execute("write", "written", payload))
        assert (fixture / "source/written").read_bytes() == payload
        assert (fixture / "source/written").stat().st_mode & 0o777 == 0o664
        ok("other conversation shared group write", execute("write", "written", b"second-user", uid=10002))
        assert (fixture / "source/written").read_bytes() == b"second-user"
        ok("plan reads", execute("read", "written", policy="plan"))
        denied("plan existing write", execute("write", "written", b"forbidden", policy="plan"), "path_denied", [30])
        denied("plan creation", execute("write", "plan-created", b"forbidden", policy="plan"), "path_denied", [30])
        denied("read-only write", execute("write", "seed", b"forbidden", root="/readonly"), "path_denied", [30])
        assert not (fixture / "source/plan-created").exists()
        assert (fixture / "source/written").read_bytes() == b"second-user"
        assert (fixture / "readonly/seed").read_bytes() == b"unchanged-seed"
        denied("directory read", execute("read", "directory"), "regular_file_required", [22])
        denied("FIFO read cannot hang", execute("read", "fifo"), "regular_file_required", [22])
        denied("bounded read", execute("read", "seed", limit=4), "payload_limit", [27])
        denied("bounded write validates before effects", execute("write", "seed", b"0123456789", limit=4), "payload_limit", [27])
        assert (fixture / "source/seed").read_bytes() == b"unchanged-seed"
        code, stdout, _ = command([worker, "read", fixture / "source", "seed", "10001", "4096"])
        assert code != 0 and json.loads(stdout)["code"] == "compartment_required"
        checks.append("runtime/root identity refused before file access")

        # An external fixture attacker swaps an in-root entry with an out-of-root
        # symlink. Successful resolutions may read only the in-root sentinel.
        stop = threading.Event()
        failure = []
        race = fixture / "source/race"
        race.symlink_to("seed")
        def swapper():
            try:
                index = 0
                while not stop.is_set():
                    temporary = fixture / "source/swap-next"
                    temporary.symlink_to("seed" if index % 2 else "../readonly/secret")
                    os.replace(temporary, race)
                    index += 1
            except BaseException as error:
                failure.append(error)
        thread = threading.Thread(target=swapper)
        thread.start()
        try:
            for _ in range(40):
                result = execute("read", "race")
                if result["ok"]:
                    assert result["data"] == b"unchanged-seed", result
                else:
                    assert result["code"] == "path_denied" and result["errno"] in (2, 11, 18), result
        finally:
            stop.set(); thread.join(timeout=2)
        assert not thread.is_alive() and not failure, failure
        assert (fixture / "readonly/secret").read_bytes() == b"out-of-root-sentinel"
        checks.append("concurrent symlink replacement cannot escape root")
        print(json.dumps({"linuxCompartmentFiles": True, "realVM": False,
            "architecture": os.uname().machine, "checks": checks, "raceAttempts": 40}))


if __name__ == "__main__":
    main()

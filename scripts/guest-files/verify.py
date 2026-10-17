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
import time
import re

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
        worker, launcher, process_worker = fixture / "file-worker", fixture / "compartment", fixture / "process-worker"
        for source, target in ((ROOT / "packages/runtime/src/guest/file-worker.c", worker),
                               (ROOT / "packages/runtime/src/guest/process-worker.c", process_worker),
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

        def execute(operation, relative, data=b"", root="/source", policy="auto", uid=10001, limit=4096, expected_version=None):
            view = tempfile.mkdtemp(prefix="view-", dir=fixture)
            arguments = [launcher, worker, fixture, view, uid, policy, operation, root, relative, limit]
            if expected_version is not None:
                arguments.append(expected_version)
            code, stdout, stderr = command(arguments, base64.b64encode(data) if operation in ("write", "write-check") else b"")
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

        # Descriptor-derived identity rejects stale conditional writes before truncation.
        snapshot = ok("read returns descriptor identity", execute("read", "written"))
        assert isinstance(snapshot["fileVersion"], str) and isinstance(snapshot["mtimeMs"], (int, float))
        ok("conditional write", execute("write-check", "written", b"conditional", expected_version=snapshot["fileVersion"]))
        denied("stale conditional write leaves bytes unchanged", execute("write-check", "written", b"stale", expected_version=snapshot["fileVersion"]), "file_changed", [11])
        assert (fixture / "source/written").read_bytes() == b"conditional"
        ok("absence-conditioned create", execute("write-check", "new-conditional", b"created", expected_version="absent"))
        denied("absence collision preserves prior bytes", execute("write-check", "new-conditional", b"clobber", expected_version="absent"), "path_denied", [17])
        assert (fixture / "source/new-conditional").read_bytes() == b"created"
        denied("plan conditional write unchanged", execute("write-check", "written", b"denied", policy="plan", expected_version=snapshot["fileVersion"]), "path_denied", [30])
        assert (fixture / "source/written").read_bytes() == b"conditional"

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
        race_outcomes = {}
        try:
            for _ in range(40):
                result = execute("read", "race")
                outcome = "ok" if result["ok"] else f'{result["code"]}/{result["errno"]}'
                race_outcomes[outcome] = race_outcomes.get(outcome, 0) + 1
                if result["ok"]:
                    assert result["data"] == b"unchanged-seed", result
                elif result["code"] == "regular_file_required":
                    # Fail-closed refusal: the worker fstat()s the opened object and
                    # leaves before any read, truncate or write (file-worker.c).
                    # Both swap targets are regular files, so this arrives only when
                    # the kernel's lock-free path walk yields a different object
                    # while the entry is being replaced (seen once on ubuntu-24.04-arm).
                    # No bytes leave the root; the surviving checks below prove it.
                    assert result["errno"] == 22, result
                else:
                    assert result["code"] == "path_denied" and result["errno"] in (2, 11, 18), result
        finally:
            stop.set(); thread.join(timeout=2)
        assert not thread.is_alive() and not failure, failure
        assert (fixture / "readonly/secret").read_bytes() == b"out-of-root-sentinel"
        checks.append("concurrent symlink replacement cannot escape root")

        # Real Bash and immutable dependencies in exactly the same source/UID/mount view.
        # The protected runtime/store sentinel is never mounted into this compartment.
        runtime = fixture / "runtime"
        for name in ("bash", "cat", "sleep", "setsid"):
            executable = shutil.which(name)
            if not executable:
                raise AssertionError(f"existing fixture executable required: {name}")
            binary = runtime / "bin" / name
            binary.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(executable, binary)
            os.chmod(binary, 0o555)
            dependencies = checked(["ldd", executable]).decode()
            for dependency in set(re.findall(r"(/[^\s()]+)", dependencies)):
                library = runtime / dependency.lstrip("/")
                library.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dependency, library)
                os.chmod(library, 0o555)
        (fixture / "protected-runtime-secret").write_bytes(b"must-not-be-visible")

        def process_arguments(root="/source", cwd=".", policy="auto", timeout=2000, limit=4096):
            view = tempfile.mkdtemp(prefix="process-view-", dir=fixture)
            return [launcher, process_worker, fixture, view, 10001, policy, "process", root, cwd, timeout, limit]

        def process(script, **options):
            code, stdout, stderr = command(process_arguments(**options), script.encode())
            assert len(stdout) <= 25000 and len(stderr) <= 4096, "bounded process receipt"
            receipt = json.loads(stdout)
            assert receipt["version"] == 1 and (code == 0) == receipt["ok"], (code, receipt, stderr)
            if receipt["ok"]:
                receipt["stdout"] = base64.b64decode(receipt["stdoutBase64"], validate=True)
                receipt["stderr"] = base64.b64decode(receipt["stderrBase64"], validate=True)
            return receipt

        result = process("printf '%s' \"$PWD\"; printf 'err' >&2; printf data > from-shell")
        assert result["ok"] and result["exitCode"] == 0 and result["stdout"] == b"/source" and result["stderr"] == b"err", result
        assert (fixture / "source/from-shell").read_bytes() == b"data"
        assert ok("same-view file helper reads shell effects", execute("read", "from-shell"))["data"] == b"data"
        checks.append("actual Bash cwd, separate streams and shared file effects")
        result = process("test -c /dev/null && test -z \"$(cat)\" && printf discarded > /dev/null && printf stdin-eof")
        assert result["ok"] and result["exitCode"] == 0 and result["stdout"] == b"stdin-eof" and result["stderr"] == b"", result
        checks.append("fixed null device supplies EOF stdin and accepts discard writes")
        result = process("test ! -e /protected-runtime-secret && test ! -e /proc && test -z \"$WINTER_HOME\" && test -z \"$BASH_ENV\"")
        assert result["ok"] and result["exitCode"] == 0, result
        checks.append("protected runtime/store/proc/env absent from shell view")
        result = process("/file-worker /source . 10001 100 100")
        assert result["ok"] and result["exitCode"] == 1 and json.loads(result["stdout"])["code"] == "compartment_required", result
        result = process("printf poison > /bin/bash")
        assert result["ok"] and result["exitCode"] != 0, result
        checks.append("shell cannot replace immutable executable or impersonate compartment PID 1")
        for fault in (1, 2):
            fault_worker = fixture / f"process-worker-fault-{fault}"
            checked([compiler, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static",
                f"-DWINTER_GUEST_PROCESS_FIXTURE_FAULT={fault}", ROOT / "packages/runtime/src/guest/process-worker.c", "-o", fault_worker])
            os.chmod(fault_worker, 0o555)
            arguments = process_arguments()
            arguments[1] = fault_worker
            code, stdout, stderr = command(arguments, b"printf applied > io-error-effect; printf ready; sleep 30")
            receipt = json.loads(stdout)
            assert code != 0 and receipt["ok"] is False and receipt["code"] == "worker_io_failed" and receipt["errno"] == 5, (code, receipt, stderr)
            if fault == 1:
                assert (fixture / "source/io-error-effect").read_bytes() == b"applied", "read fault did not exercise post-effect failure"
        checks.append("native injected pipe read and poll errors never confirm success")
        result = process("printf forbidden > forbidden-shell", policy="plan")
        assert result["ok"] and result["exitCode"] != 0 and not (fixture / "source/forbidden-shell").exists(), result
        result = process("printf forbidden > /readonly/shell-write")
        assert result["ok"] and result["exitCode"] != 0 and not (fixture / "readonly/shell-write").exists(), result
        checks.append("actual Bash plan/read-only mount write denial")
        (fixture / "source/cwd-outside").symlink_to("../readonly")
        for cwd in ("cwd-outside", "../readonly", "absolute-link"):
            result = process("printf forbidden > /source/cwd-escaped", cwd=cwd)
            assert not result["ok"] and result["code"] == "cwd_denied", result
        assert not (fixture / "source/cwd-escaped").exists()
        checks.append("cwd escapes denied before shell effects")
        result = process("exit 7")
        assert result["ok"] and result["exitCode"] == 7 and result["termination"] == "exit", result
        result = process("while :; do printf '0123456789'; done", limit=31)
        assert result["ok"] and result["termination"] == "output_limit" and len(result["stdout"])+len(result["stderr"]) == 31, result
        checks.append("nonzero exit and combined stream kill limit")
        result = process("setsid /bin/bash -c 'printf ready > timeout-ready; sleep 0.5; printf escaped > timeout-orphan' & while [ ! -e timeout-ready ]; do sleep 0.01; done; sleep 30", timeout=150)
        assert result["ok"] and result["termination"] == "timeout", result
        assert (fixture / "source/timeout-ready").exists(), "detached timeout child never started"
        result = process("setsid /bin/bash -c 'printf ready > exit-ready; sleep 0.5; printf escaped > exit-orphan' >/tmp/orphan-output 2>&1 & while [ ! -e exit-ready ]; do sleep 0.01; done; exit 0")
        assert result["ok"] and result["termination"] == "exit", result
        assert (fixture / "source/exit-ready").exists(), "detached exit child never started"
        time.sleep(0.8)
        assert not (fixture / "source/timeout-orphan").exists() and not (fixture / "source/exit-orphan").exists()
        checks.append("timeout and normal exit destroy setsid descendants")
        child = subprocess.Popen([str(arg) for arg in process_arguments()], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            child.stdin.write(b"setsid /bin/bash -c 'printf ready > cancel-ready; sleep 0.7; printf escaped > cancelled-orphan' & sleep 30")
            child.stdin.close()
            deadline = time.monotonic()+2
            while not (fixture / "source/cancel-ready").exists() and time.monotonic()<deadline:
                time.sleep(0.01)
            assert (fixture / "source/cancel-ready").exists(), "shell never started"
        finally:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
            child.stdout.close(); child.stderr.close()
        time.sleep(0.9)
        assert not (fixture / "source/cancelled-orphan").exists()
        checks.append("cancellation destroys owned namespace including setsid descendants")
        code, stdout, _ = command([process_worker, fixture / "source", ".", "10001", "100", "100"], b"printf unsafe")
        assert code != 0 and json.loads(stdout)["code"] == "compartment_required"
        checks.append("process worker refuses runtime/root/outside namespace identity")
        print(json.dumps({"linuxCompartmentFiles": True, "realVM": False,
            "linuxCompartmentProcesses": True,
            "architecture": os.uname().machine, "checks": checks, "raceAttempts": 40, "raceOutcomes": race_outcomes}))


if __name__ == "__main__":
    main()

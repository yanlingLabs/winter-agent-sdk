"""Portable synthetic-byte capture/oracle tests; no utility or native fixture runs."""
import copy, hashlib, importlib.util, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
def load(name):
    spec = importlib.util.spec_from_file_location('utility_' + name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
closure, oracle = load('closure'), load('oracle')


def fixture(root):
    elf = bytearray(b'\x7fELF\x02\x01' + b'\0' * 14); elf[18:20] = (183).to_bytes(2, 'little')
    entries = [(guest, 'executable', sorted(closure.EXECUTABLE_SOURCES[guest])[0]) for guest in sorted(closure.EXECUTABLES)]
    entries += [('/lib/ld-linux-aarch64.so.1', 'library', 'usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1')]
    entries += [('/usr/lib/python3.12/' + name, 'stdlib', 'usr/lib/python3.12/' + name) for name in ('encodings/__init__.py', 'encodings/utf_8.py', 'multiprocessing/__init__.py', 'multiprocessing/shared_memory.py', 'multiprocessing/synchronize.py', 'multiprocessing/resource_tracker.py')]
    entries += [('/usr/lib/python3.12/lib-dynload/' + name + 'cpython-312-aarch64-linux-gnu.so', 'extension', 'usr/lib/python3.12/lib-dynload/' + name + 'cpython-312-aarch64-linux-gnu.so') for name in ('_multiprocessing.', '_posixshmem.')]
    files = {}
    for guest, role, source in entries:
        data = b'raise RuntimeError("synthetic source must never execute")\n' if role == 'stdlib' else bytes(elf)
        path = root / source; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        files[guest] = {'role': role, 'source': source, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    return {'formatVersion': 1, 'kind': 'winter-tool-utility-inputs', 'target': 'linux-arm64-gnu', 'files': files}


class UtilityFixtureTests(unittest.TestCase):
    def test_isolated_cli_captures_only_synthetic_bytes_and_requires_isolation(self):
        with tempfile.TemporaryDirectory(prefix='winter-utility-cli-source-') as temp:
            root = Path(temp).resolve(); source = root / 'source'; source.mkdir(); manifest = fixture(source)
            path = root / 'manifest.json'; path.write_text(json.dumps(manifest))
            arguments = [str(HERE / 'closure.py'), '--utility-root', str(source), '--manifest', str(path), '--out', str(root / 'capture')]
            refused = subprocess.run([sys.executable, *arguments], capture_output=True, text=True, timeout=5)
            self.assertNotEqual(refused.returncode, 0); self.assertFalse((root / 'capture').exists())
            result = subprocess.run([sys.executable, '-I', '-S', '-B', *arguments], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            observed = json.loads(result.stdout)
            self.assertEqual(set(observed), {'captured', 'receiptSha256', 'generalToolAvailabilityEnabled', 'linuxExecutionVerified'})
            self.assertTrue(observed['captured']); self.assertFalse(observed['generalToolAvailabilityEnabled']); self.assertFalse(observed['linuxExecutionVerified'])
            receipt = json.loads((root / 'capture/utility-receipt.json').read_text())
            closure.validate_capture(receipt, root / 'capture/environment')

    def test_synthetic_bytes_capture_all_measurements_and_never_claim_execution(self):
        with tempfile.TemporaryDirectory(prefix='winter-utility-capture-source-') as temp:
            root = Path(temp).resolve(); source = root / 'source'; source.mkdir(); manifest = fixture(source)
            receipt = closure.capture(source, manifest, root / 'capture')
            self.assertEqual(closure.validate_capture(receipt, root / 'capture/environment'), receipt)
            self.assertEqual(json.loads((root / 'capture/utility-receipt.json').read_text()), receipt)
            self.assertEqual(set(receipt['outputs']), set(manifest['files']))
            for key in ('dependencyCompletenessVerified', 'linuxExecutionVerified', 'vmExecutionVerified', 'generalToolAvailabilityEnabled'):
                self.assertIs(receipt[key], False)
            changed = copy.deepcopy(receipt); changed['linuxExecutionVerified'] = True
            with self.assertRaises(ValueError): closure.validate_capture(changed, root / 'capture/environment')
            changed = copy.deepcopy(receipt); changed['outputs']['/bin/bash']['sha256'] = '0' * 64
            with self.assertRaises(ValueError): closure.validate_capture(changed, root / 'capture/environment')
            changed = copy.deepcopy(receipt); changed['recipe']['utilityExecution'] = 0
            with self.assertRaises(ValueError): closure.validate_capture(changed, root / 'capture/environment')
            leaf = root / 'capture/environment/bin/bash'; leaf.chmod(0o644)
            with self.assertRaises(ValueError): closure.validate_capture(receipt, root / 'capture/environment')
            leaf.chmod(0o555)
            empty = root / 'capture/environment/extra-empty'; empty.mkdir()
            with self.assertRaises(ValueError): closure.validate_capture(receipt, root / 'capture/environment')
            empty.rmdir()
            (root / 'capture/environment/unmeasured').write_text('extra')
            with self.assertRaises(ValueError): closure.validate_capture(receipt, root / 'capture/environment')

    def test_missing_unmeasured_wrong_target_or_credential_shaped_sources_refuse(self):
        with tempfile.TemporaryDirectory(prefix='winter-utility-refusal-source-') as temp:
            root = Path(temp).resolve(); source = root / 'source'; source.mkdir(); manifest = fixture(source)
            for field, value in (('source', '../outside'), ('source', 'home/credential'), ('role', 'device'), ('bytes', True), ('sha256', '0' * 63)):
                with self.subTest(field=field, value=value):
                    changed = copy.deepcopy(manifest); changed['files']['/bin/bash'][field] = value
                    with self.assertRaises(ValueError): closure.validate_manifest(changed)
            changed = copy.deepcopy(manifest); changed['files']['/usr/bin/curl'] = changed['files'].pop('/bin/bash')
            with self.assertRaises(ValueError): closure.validate_manifest(changed)
            changed = copy.deepcopy(manifest); changed['files']['/usr/lib/python3.12/site-packages/extra.py'] = changed['files']['/usr/lib/python3.12/encodings/utf_8.py']
            with self.assertRaises(ValueError): closure.validate_manifest(changed)
            (source / manifest['files']['/bin/bash']['source']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'measurement changed'): closure.capture(source, manifest, root / 'changed')
            manifest = fixture(source); name = manifest['files']['/bin/bash']['source']; path = source / name
            data = bytearray(path.read_bytes()); data[18:20] = (62).to_bytes(2, 'little'); path.write_bytes(data)
            manifest['files']['/bin/bash']['sha256'] = hashlib.sha256(data).hexdigest()
            with self.assertRaisesRegex(ValueError, 'ARM64 ELF'): closure.capture(source, manifest, root / 'wrong-target')
            manifest = fixture(source)
            path.unlink(); path.symlink_to(source / manifest['files']['/bin/cat']['source'])
            with self.assertRaises(OSError): closure.capture(source, manifest, root / 'symlink')
            path.unlink(); os.mkfifo(path)
            with self.assertRaisesRegex(ValueError, 'regular leaf'): closure.capture(source, manifest, root / 'fifo')

    def test_external_hardlink_refused_despite_unchanged_inventory_and_bytes(self):
        with tempfile.TemporaryDirectory(prefix='winter-utility-hardlink-source-') as temp:
            root = Path(temp).resolve(); source = root / 'source'; source.mkdir(); manifest = fixture(source)
            receipt = closure.capture(source, manifest, root / 'capture')
            output = root / 'capture/environment'; leaf = output / 'bin/bash'; alias = root / 'outside-capture-hardlink'
            os.link(leaf, alias)
            self.assertEqual(leaf.stat().st_nlink, 2)
            with self.assertRaisesRegex(ValueError, 'multiply linked'):
                closure.validate_capture(receipt, output)
            alias.unlink()
            self.assertEqual(closure.validate_capture(receipt, output), receipt)

    def test_exact_oracle_rejects_failed_truncated_extra_or_unbound_markers(self):
        result = {'stdout': oracle.EXPECTED_STDOUT, 'stderr': '', 'exitCode': 0, 'termination': 'exit'}
        validated = oracle.validate_result(result)
        self.assertFalse(validated['generalToolAvailabilityEnabled'])
        for field, value in (('stdout', oracle.EXPECTED_STDOUT[:-1]), ('stdout', oracle.EXPECTED_STDOUT + 'extra\n'), ('stderr', 'warning'), ('exitCode', 1), ('exitCode', False), ('termination', 'timeout')):
            with self.subTest(field=field):
                changed = dict(result); changed[field] = value
                with self.assertRaises(ValueError): oracle.validate_result(changed)
        with self.assertRaises(ValueError): oracle.validate_result({**result, 'nativeCleanupConfirmed': True})

    def test_source_recipe_syntax_and_no_weakening_existing_runner(self):
        import ast, re
        result = subprocess.run(['/bin/bash', '--noprofile', '--norc', '-n', str(HERE / 'smoke.sh')], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        smoke = (HERE / 'smoke.sh').read_text()
        for code in re.findall(r"python3 - <<'PY'\n(.*?)\nPY", smoke, re.S): ast.parse(code)
        for code in re.findall(r"python3 -c '(.*?)'", smoke, re.S): ast.parse(code)
        for marker in oracle.EXPECTED_STDOUT.strip().splitlines(): self.assertIn(marker, smoke)
        for check in ('cat /dev/stdin', 'NoNewPrivs', 'CapAmb', 'os.urandom', 'shared_memory.SharedMemory', 'context.Semaphore', 'openssl rand', 'process-substitution-ok', 'mktemp -d', 'commit -m', "'/proc/1/status'", 'receipt/bootstrap socket leaked'):
            self.assertIn(check, smoke)
        self.assertIn('os.mkdir(sys.argv[1])', smoke)
        self.assertNotIn('\nmkdir ', smoke)
        existing = (closure.ROOT / 'scripts/guest-engine/verify.py').read_text()
        self.assertIn("{'passed':True,'turns':5,'peerValidated':True}", existing)
        self.assertIn("if len(calls)!=4 or len(results)!=4 or len(anchors)!=5", existing)


if __name__ == '__main__':
    unittest.main()

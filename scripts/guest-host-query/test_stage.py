"""Adversarial trusted-parent tests. Synthetic Linux bytes are never executed.

No root ownership is changed; positive ownership checks use injected stat metadata.
Only deadline-bounded refusal probes start isolated interpreters; no native effect runs.
"""
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace


MODULE = Path(__file__).with_name('stage.py')
spec = importlib.util.spec_from_file_location('host_query_trusted_stage_test', MODULE)
s = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = s
spec.loader.exec_module(s)

from test_environment import elf, environment_fixture

NATIVE = {
    'toolLauncher': 'linux-tool-compartment.c',
    'runtimeLauncher': 'linux-runtime-compartment.c',
    'fileWorker': 'file-worker.c',
    'processWorker': 'process-worker.c',
    'ownerLibrary': 'linux-session-owner.c',
}
ROOT_FILES = (
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tsconfig.base.json', 'tsconfig.typecheck.json', 'tsconfig.sdk-fence.json',
    'bunfig.toml',
)
REQUIRED_SOURCES = s.REQUIRED_SOURCES


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def measured(data):
    return {'kind': 'file', 'sha256': digest(data), 'bytes': len(data)}


class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.artifacts = self.root / 'artifacts'
        self.source.mkdir()
        self.artifacts.mkdir()
        self.pin = {'version': '1.3.14', 'target': 'bun-linux-arm64',
                    'executableSha256': '37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086'}
        for name in sorted(set(ROOT_FILES) | set(REQUIRED_SOURCES) | {s.PARENT}):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(('synthetic source ' + name + '\n').encode())
        (self.source / s.PARENT).write_bytes(MODULE.read_bytes())
        for name in ('utilities.sh','utilities-plan.sh'):(self.source/'scripts/guest-host-query'/name).write_bytes((MODULE.parent/name).read_bytes())
        (self.source / 'scripts/linux-runtime-base.json').write_text(canonical(self.pin))
        self.dependency = self.source / 'node_modules/pkg/dist/index.js'
        self.dependency.parent.mkdir(parents=True)
        self.dependency.write_bytes(b'synthetic installed dependency dist bytes\n')
        self.inputs = {
            path.relative_to(self.source).as_posix(): measured(path.read_bytes())
            for path in sorted(self.source.rglob('*')) if path.is_file()
        }
        self.outputs = {}
        for name in s.ARTIFACTS:
            header = bytearray(20)
            header[:6] = b'\x7fELF\x02\x01'
            header[18:20] = (183).to_bytes(2, 'little')
            (self.artifacts / name).write_bytes(elf())
        for name, entry in s.ENTRIES.items():
            relative = f'scripts/guest-host-query/{entry}'
            bundled = {key: self.inputs[key] for key in
                       (relative, 'node_modules/pkg/dist/index.js')}
            metadata = {'inputs': {key: {'bytes': value['bytes']}
                                   for key, value in bundled.items()}, 'outputs': {}}
            metafile = self.artifacts / f'{name}.metafile.json'
            metafile.write_text(canonical(metadata) + '\n')
            command = ['<compiler>', 'build', '--compile',
                       '--no-compile-autoload-bunfig', '--no-compile-autoload-dotenv',
                       '--target=bun-linux-arm64', '--compile-executable-path=linux-bun-base',
                       f'--metafile={name}.metafile.json', f'../source/{relative}',
                       '--outfile', f'<output>/{name}']
            data = (self.artifacts / name).read_bytes()
            self.outputs[name] = {
                'entry': relative, 'sha256': digest(data), 'bytes': len(data),
                'bundledInputs': bundled, 'metafileSha256': digest(metafile.read_bytes()),
                'command': command,
            }
        self.compile = {
            'formatVersion': 1, 'kind': 'winter-host-query-compile',
            'inputs': self.inputs, 'inputInventorySha256': digest(canonical(self.inputs).encode()),
            'compiler': {'version': '1.3.14', 'sha256': 'b' * 64, 'bytes': 123,
                         'platform': 'linux', 'architecture': 'arm64'},
            'base': {'version': '1.3.14', 'target': 'bun-linux-arm64',
                     'sha256': self.pin['executableSha256']},
            'recipe': {'flags': ['--compile', '--no-compile-autoload-bunfig',
                                '--no-compile-autoload-dotenv', '--target=bun-linux-arm64',
                                '--compile-executable-path=linux-bun-base',
                                '--metafile=<entry>.metafile.json'],
                       'cwd': 'stage', 'source': '../source',
                       'environment': {'PATH': '/usr/bin:/bin', 'LANG': 'C',
                                       'LC_ALL': 'C', 'TZ': 'UTC'}},
            'outputs': self.outputs, 'linuxExecutionVerified': False, 'vmExecutionVerified': False,
        }
        self.receipt = {
            'formatVersion': 3,
            'sources': {name: value['sha256'] for name, value in self.inputs.items()
                        if not name.startswith('node_modules/')},
            'artifacts': {name: digest((self.artifacts / name).read_bytes())
                          for name in s.ARTIFACTS},
            'nativeBuildCommands': [
                ['<native-compiler>', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                 *(['-shared', '-fPIC'] if name == 'ownerLibrary' else ['-static']),
                 f'packages/runtime/src/guest/{source}', '-o', f'<artifacts>/{name}']
                for name, source in NATIVE.items()
            ],
            'nativeCompiler': {'sha256': 'c' * 64, 'bytes': 456, 'version': 'cc fixture 1.0'},
            'nativeBuildEnvironment': {'PATH': '/usr/bin:/bin', 'LANG': 'C',
                                       'LC_ALL': 'C', 'TZ': 'UTC'},
            'linuxExecutionVerified': False, 'vmExecutionVerified': False,
        }
        self.receipt.update(environment_fixture(self.source,self.artifacts,self.inputs))
        self.receipt_path = self.artifacts / 'receipt.json'
        self.staged_roots = []
        self.reseal()

    def tearDown(self):
        for directory in self.staged_roots:
            for root, directories, _ in os.walk(directory):
                Path(root).chmod(0o700)
                for name in directories:
                    (Path(root) / name).chmod(0o700)
            shutil.rmtree(directory)
        self.temp.cleanup()

    def reseal(self):
        """Give malformed fixtures their own approved receipt digest, not authority."""
        wire = (canonical(self.compile) + '\n').encode()
        (self.artifacts / 'compile-receipt.json').write_bytes(wire)
        self.receipt['compileReceiptSha256'] = digest(wire)
        native = (canonical(self.receipt) + '\n').encode()
        self.receipt_path.write_bytes(native)
        self.approved = digest(native)

    def capture(self):
        return s.capture(self.source, self.artifacts, self.receipt_path, self.approved)

    def test_complete_three_entry_snapshot_accepts_without_execution(self):
        with self.capture() as snapshot:self.assertEqual(set(snapshot.compiled['outputs']),set(s.ENTRIES))
    def test_missing_extra_or_legacy_two_entry_output_refuses(self):
        for transform in ('missing','extra','legacy'):
            original=copy.deepcopy(self.compile)
            if transform=='missing':self.compile['outputs'].pop('hostClient')
            elif transform=='extra':self.compile['outputs']['extra']=self.compile['outputs']['hostClient']
            else:self.compile['kind']='winter-fresh-engine-compile';self.compile['outputs'].pop('hostClient')
            self.reseal()
            with self.assertRaises(ValueError):self.capture()
            self.compile=original;self.reseal()
    def test_wrong_entry_recipe_or_kind_refuses_even_rehashed(self):
        for field,value in [('entry','scripts/guest-engine/runtime.ts'),('command',['forged']),('kind','other')]:
            original=copy.deepcopy(self.compile)
            if field=='kind':self.compile[field]=value
            else:self.compile['outputs']['hostClient'][field]=value
            self.reseal()
            with self.assertRaises(ValueError):self.capture()
            self.compile=original;self.reseal()
    def test_changed_elf_dependency_or_host_metafile_refuses(self):
        for path in (self.artifacts/'hostClient',self.artifacts/'hostClient.metafile.json',self.dependency):
            old=path.read_bytes();path.write_bytes(old+b'changed')
            with self.assertRaises(ValueError):self.capture()
            path.write_bytes(old)
    def test_aggregate_limit_refuses_without_large_allocation(self):
        total=sum((self.artifacts/name).stat().st_size for name in s.ARTIFACTS)
        with patch.object(s,'MAX_ARTIFACT_BYTES',total-1):
            with self.assertRaisesRegex(ValueError,'aggregate'):self.capture()
    def test_missing_metafile_refuses_without_spawn(self):
        (self.artifacts/'hostClient.metafile.json').unlink()
        with patch.object(s.subprocess,'run') as run:
            with self.assertRaises(OSError):self.capture()
            run.assert_not_called()
if __name__=='__main__':unittest.main()

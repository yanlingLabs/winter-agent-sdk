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
spec = importlib.util.spec_from_file_location('fresh_trusted_stage_test', MODULE)
s = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = s
spec.loader.exec_module(s)

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
REQUIRED_SOURCES = (
    'packages/runtime/src/guest/linux-supervisor.py',
    'packages/runtime/src/guest/linux-compartment.h',
    *(f'packages/runtime/src/guest/{name}' for name in NATIVE.values()),
    'packages/runtime/src/guest/linux-session-admission.ts',
    'scripts/guest-engine/runtime.ts', 'scripts/guest-engine/provider.ts',
    'scripts/guest-engine/compile.ts', 'scripts/build-runtime.ts',
    'scripts/linux-runtime-base.json', 'scripts/guest-engine/verify.py',
    'scripts/guest-engine/build.py', 'scripts/guest-engine/provenance.py',
)


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
        (self.source / 'scripts/linux-runtime-base.json').write_text(canonical(self.pin))
        self.dependency = self.source / 'node_modules/pkg/dist/index.js'
        self.dependency.parent.mkdir(parents=True)
        self.dependency.write_bytes(b'synthetic installed dependency dist bytes\n')
        self.inputs = {
            path.relative_to(self.source).as_posix(): measured(path.read_bytes())
            for path in sorted(self.source.rglob('*')) if path.is_file()
        }
        self.outputs = {}
        for name in (*NATIVE, 'runtimeEntry', 'providerWorker'):
            header = bytearray(20)
            header[:6] = b'\x7fELF\x02\x01'
            header[18:20] = (183).to_bytes(2, 'little')
            (self.artifacts / name).write_bytes(header + b'SYNTHETIC-INERT-' + name.encode())
        for name, entry in [('runtimeEntry', 'runtime'), ('providerWorker', 'provider')]:
            relative = f'scripts/guest-engine/{entry}.ts'
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
            'formatVersion': 1, 'kind': 'winter-fresh-engine-compile',
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
            'formatVersion': 2,
            'sources': {name: value['sha256'] for name, value in self.inputs.items()
                        if not name.startswith('node_modules/')},
            'artifacts': {name: digest((self.artifacts / name).read_bytes())
                          for name in (*NATIVE, 'runtimeEntry', 'providerWorker')},
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

    @contextmanager
    def simulated_root_metadata(self):
        """Simulate Linux protected ancestry while every write remains our own UID."""
        original_stat, original_lstat, original_fstat = os.stat, os.lstat, os.fstat
        original_open_root = s.open_root
        real_tmp = Path('/tmp').resolve()

        def owned(info):
            values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
            values['st_uid'] = 0
            return SimpleNamespace(**values)

        def stat_root(*args, **kwargs):
            return owned(original_stat(*args, **kwargs))

        def lstat_root(path, *args, **kwargs):
            # macOS /tmp is a symlink; model the actual Linux directory only here.
            if str(path) == '/tmp':
                return owned(original_stat(real_tmp, *args, **kwargs))
            return owned(original_lstat(path, *args, **kwargs))

        def open_root(path):
            path = Path(path)
            if path == Path('/tmp') or Path('/tmp') in path.parents:
                path = real_tmp.joinpath(*path.parts[2:])
            return original_open_root(path)

        with patch.object(s.os, 'stat', side_effect=stat_root), \
                patch.object(s.os, 'lstat', side_effect=lstat_root), \
                patch.object(s.os, 'fstat', side_effect=lambda fd: owned(original_fstat(fd))), \
                patch.object(s, 'open_root', side_effect=open_root):
            yield

    def protected_fixture(self):
        """Materialize inert bytes, never call privileged staging or run a fixture."""
        real = Path(tempfile.mkdtemp(prefix=s.PREFIX, dir=Path('/tmp').resolve()))
        self.staged_roots.append(real)
        source, artifacts = real / 'source', real / 'artifacts'
        shutil.copytree(self.source, source)
        shutil.copytree(self.artifacts, artifacts)
        for tree in (source, artifacts):
            for root, _, names in os.walk(tree):
                for name in names:
                    path = Path(root) / name
                    path.chmod(0o500 if tree == artifacts and name in NATIVE or
                               tree == artifacts and name in ('runtimeEntry', 'providerWorker')
                               else 0o400)
            for root, _, _ in os.walk(tree, topdown=False):
                Path(root).chmod(0o500)
        real.chmod(0o500)
        return Path('/tmp') / real.name

    def assert_capture_refuses(self):
        with patch.object(s, 'stage') as stage, patch.object(s, 'run_staged') as runner, \
                patch.object(s.subprocess, 'run') as process:
            with self.assertRaises((ValueError, OSError)):
                self.capture()
            stage.assert_not_called()
            runner.assert_not_called()
            process.assert_not_called()

    def run_fifo_probe(self, operation, paths):
        """Real FIFO admission with a hard child deadline; no writer or native effect."""
        probe = r"""
import importlib.util,json,os,sys
from pathlib import Path
module=Path(sys.argv[1]);paths=json.loads(sys.argv[2]);operation=sys.argv[3]
spec=importlib.util.spec_from_file_location('fifo_admission_probe',module)
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
def forbidden(*args,**kwargs):raise AssertionError('staging/spawn must never occur')
s.stage=forbidden;s.run_staged=forbidden;s.subprocess.run=forbidden
if operation=='capture':
 sys.argv=['stage.py','--source',paths['source'],'--artifacts',paths['artifacts'],'--receipt',paths['receipt'],'--approved-receipt-sha256',paths['approved'],'--approved-parent-sha256',s.own_parent_hash()]
 try:s.main()
 except (ValueError,OSError) as error:
  if isinstance(error,ValueError) and str(error)!='closure leaf type':raise
  print(json.dumps({'refused':True,'staged':False,'spawned':False}))
 else:raise AssertionError('FIFO admitted')
elif operation=='copy-replacement':
 with s.capture(Path(paths['source']),Path(paths['artifacts']),Path(paths['receipt']),paths['approved']) as snapshot:
  name='scripts/guest-engine/runtime.ts';target=Path(paths['source'])/name
  target.unlink();os.mkfifo(target)
  destination=Path(paths['destination'])
  try:s.copy_leaf(snapshot.source,name,destination,snapshot.compiled['inputs'][name]['sha256'],s.MAX_FILE,0o400)
  except ValueError as error:
   if str(error)!='closure leaf type':raise
  else:raise AssertionError('FIFO copy admitted')
  if destination.exists():raise AssertionError('destination created before FIFO refusal')
  print(json.dumps({'refused':True,'destinationWritten':False,'spawned':False}))
else:raise AssertionError('unknown probe')
"""
        result=subprocess.run([sys.executable,'-I','-S','-B','-c',probe,str(MODULE),json.dumps(paths),operation],
                              capture_output=True,text=True,timeout=3,
                              env={'PATH':os.environ.get('PATH',''),'LANG':'C','LC_ALL':'C'})
        self.assertEqual(result.returncode,0,result.stderr)
        return json.loads(result.stdout)

    def test_real_fifo_receipt_compile_receipt_and_artifact_refuse_before_staging(self):
        paths={'source':str(self.source),'artifacts':str(self.artifacts),'receipt':str(self.receipt_path),'approved':self.approved}
        for path in (self.receipt_path,self.artifacts/'compile-receipt.json',self.artifacts/'runtimeEntry'):
            with self.subTest(input=path.name):
                original=path.read_bytes();path.unlink();os.mkfifo(path)
                try:
                    observed=self.run_fifo_probe('capture',paths)
                    self.assertEqual(observed,{'refused':True,'staged':False,'spawned':False})
                finally:path.unlink();path.write_bytes(original)

    def test_real_fifo_substituted_copy_input_refuses_without_destination_write(self):
        destination=self.root/'fifo-copy-destination'
        paths={'source':str(self.source),'artifacts':str(self.artifacts),'receipt':str(self.receipt_path),'approved':self.approved,'destination':str(destination)}
        observed=self.run_fifo_probe('copy-replacement',paths)
        self.assertEqual(observed,{'refused':True,'destinationWritten':False,'spawned':False})
        self.assertFalse(destination.exists())

    def test_documented_external_wrapper_fifo_parent_refuses_before_exec_with_deadline(self):
        # Exercise the actual documented initial wrapper, not a rewritten equivalent.
        document=MODULE.parents[2]/'guest/FRESH-ENGINE-STAGING.md'
        markdown=document.read_text()
        wrapper=markdown.split('```python\n',1)[1].split('\n```',1)[0]
        parent=self.root/'fifo-parent';os.mkfifo(parent)
        result=subprocess.run([sys.executable,'-I','-S','-B','-c',wrapper,str(parent),'0'*64],
                              capture_output=True,text=True,timeout=3,
                              env={'PATH':os.environ.get('PATH',''),'LANG':'C','LC_ALL':'C'})
        self.assertNotEqual(result.returncode,0)
        self.assertIn('parent input identity/limit',result.stderr)
        self.assertNotIn('external parent byte admission refused',result.stderr)

    def test_leaf_fstat_refusal_closes_opened_fifo_and_failed_stat_descriptors(self):
        folder=s.open_root(self.source);original_open=os.open;opened=[]
        fifo=self.source/'fifo';os.mkfifo(fifo)
        def capture_open(name,*args,**kwargs):
            fd=original_open(name,*args,**kwargs)
            if name in ('fifo','runtime.ts'):opened.append(fd)
            return fd
        try:
            with patch.object(s.os,'open',side_effect=capture_open):
                with self.assertRaisesRegex(ValueError,'closure leaf type'):s.leaf(folder,'fifo')
            self.assertEqual(len(opened),1)
            with self.assertRaises(OSError):os.fstat(opened[-1])
            opened.clear()
            with patch.object(s.os,'open',side_effect=capture_open),patch.object(s.os,'fstat',side_effect=OSError('injected stat refusal')):
                with self.assertRaisesRegex(OSError,'injected stat refusal'):s.leaf(folder,'scripts/guest-engine/runtime.ts')
            self.assertEqual(len(opened),1)
            with self.assertRaises(OSError):os.fstat(opened[-1])
        finally:os.close(folder)

    def test_complete_synthetic_closure_captures_without_execution(self):
        with patch.object(s.subprocess, 'run') as run:
            snapshot = self.capture()
            snapshot.close()
            run.assert_not_called()

    def test_capture_refusal_closes_every_held_root_descriptor(self):
        self.dependency.write_bytes(b'changed input')
        descriptors = []
        original = s.open_root

        def open_root(path):
            fd = original(path)
            descriptors.append(fd)
            return fd

        with patch.object(s, 'open_root', side_effect=open_root):
            self.assert_capture_refuses()
        self.assertGreaterEqual(len(descriptors), 3)
        for fd in descriptors:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_copy_destination_failure_closes_owned_source_descriptor(self):
        with self.capture() as snapshot:
            original=s.leaf;owned=[]
            def opened(*args,**kwargs):
                fd=original(*args,**kwargs);owned.append(fd);return fd
            destination=self.root/'already-present';destination.write_bytes(b'preserved')
            with patch.object(s,'leaf',side_effect=opened):
                with self.assertRaises(FileExistsError):
                    s.copy_leaf(snapshot.source,'node_modules/pkg/dist/index.js',destination,
                                snapshot.compiled['inputs']['node_modules/pkg/dist/index.js']['sha256'],s.MAX_FILE,0o400)
            self.assertEqual(destination.read_bytes(),b'preserved')
            for fd in owned:
                with self.assertRaises(OSError):os.fstat(fd)

    def test_changed_native_runtime_and_installed_dependency_refuse(self):
        for relative in ('packages/runtime/src/guest/linux-compartment.h',
                         'scripts/guest-engine/runtime.ts', 'node_modules/pkg/dist/index.js'):
            with self.subTest(relative=relative):
                path = self.source / relative
                original = path.read_bytes()
                path.write_bytes(original + b'changed after compilation')
                self.assert_capture_refuses()
                path.write_bytes(original)

    def test_each_of_seven_artifact_mutations_refuses(self):
        for name in self.receipt['artifacts']:
            with self.subTest(name=name):
                path = self.artifacts / name
                original = path.read_bytes()
                path.write_bytes(b'stale or substituted artifact')
                self.assert_capture_refuses()
                path.write_bytes(original)

    def test_omitted_artifact_or_required_source_receipt_refuses(self):
        for section, name in [('artifacts', 'ownerLibrary'),
                              ('sources', 'scripts/guest-engine/verify.py')]:
            with self.subTest(section=section):
                original = self.receipt[section].pop(name)
                self.reseal()
                self.assert_capture_refuses()
                self.receipt[section][name] = original
                self.reseal()

    def test_omitted_or_changed_compile_receipt_and_metafiles_refuse(self):
        for name in ('compile-receipt.json', 'runtimeEntry.metafile.json',
                     'providerWorker.metafile.json'):
            with self.subTest(name=name):
                path = self.artifacts / name
                original = path.read_bytes()
                path.write_bytes(b'{}')
                self.assert_capture_refuses()
                path.unlink()
                self.assert_capture_refuses()
                path.write_bytes(original)

    def test_receipt_digest_is_external_and_exact(self):
        self.approved = 'f' * 64
        self.assert_capture_refuses()

    def test_resealed_compile_recipe_and_execution_claims_refuse(self):
        original = copy.deepcopy(self.compile)
        for mutation in ('recipe', 'command', 'linuxExecutionVerified', 'vmExecutionVerified'):
            with self.subTest(mutation=mutation):
                self.compile = copy.deepcopy(original)
                if mutation == 'recipe':
                    self.compile['recipe']['flags'].append('--minify')
                elif mutation == 'command':
                    self.compile['outputs']['runtimeEntry']['command'].append('--minify')
                else:
                    self.compile[mutation] = True
                self.reseal()
                self.assert_capture_refuses()

    def test_resealed_native_recipe_and_execution_claims_refuse(self):
        original = copy.deepcopy(self.receipt)
        for mutation in ('command', 'linuxExecutionVerified', 'vmExecutionVerified'):
            with self.subTest(mutation=mutation):
                self.receipt = copy.deepcopy(original)
                if mutation == 'command':
                    self.receipt['nativeBuildCommands'][0].append('-DUNREVIEWED=1')
                else:
                    self.receipt[mutation] = True
                self.reseal()
                self.assert_capture_refuses()

    def test_resealed_foreign_machine_entry_refuses(self):
        path = self.artifacts / 'runtimeEntry'
        data = bytearray(path.read_bytes())
        data[18:20] = (62).to_bytes(2, 'little')
        path.write_bytes(data)
        self.compile['outputs']['runtimeEntry'].update(sha256=digest(data), bytes=len(data))
        self.receipt['artifacts']['runtimeEntry'] = digest(data)
        self.reseal()
        self.assert_capture_refuses()

    def test_duplicate_native_json_keys_refuse_even_when_digest_is_approved(self):
        wire = self.receipt_path.read_bytes()
        wire = b'{"formatVersion":2,' + wire[1:]
        self.receipt_path.write_bytes(wire)
        self.approved = digest(wire)
        self.assert_capture_refuses()

    def test_duplicate_compile_json_keys_refuse_even_when_native_digest_is_approved(self):
        wire = (self.artifacts / 'compile-receipt.json').read_bytes()
        wire = b'{"formatVersion":1,' + wire[1:]
        (self.artifacts / 'compile-receipt.json').write_bytes(wire)
        self.receipt['compileReceiptSha256'] = digest(wire)
        native = (canonical(self.receipt) + '\n').encode()
        self.receipt_path.write_bytes(native)
        self.approved = digest(native)
        self.assert_capture_refuses()

    def test_external_symlink_and_artifact_hardlink_refuse(self):
        outside = self.root / 'outside.js'
        outside.write_bytes(self.dependency.read_bytes())
        self.dependency.unlink()
        self.dependency.symlink_to(outside)
        self.assert_capture_refuses()
        self.dependency.unlink()
        self.dependency.write_bytes(outside.read_bytes())
        artifact = self.artifacts / 'runtimeEntry'
        os.link(artifact, self.root / 'artifact-alias')
        self.assert_capture_refuses()

    def test_input_root_symlink_refuses_before_any_staging(self):
        alias = self.root / 'source-alias'
        alias.symlink_to(self.source, target_is_directory=True)
        original = self.source
        self.source = alias
        self.assert_capture_refuses()
        self.source = original
        alias.unlink()
        alias.symlink_to(self.artifacts, target_is_directory=True)
        self.artifacts = alias
        self.assert_capture_refuses()

    def test_pnpm_source_hardlink_is_measured_but_cannot_mutate_unnoticed(self):
        alias = self.root / 'pnpm-store-alias'
        os.link(self.dependency, alias)
        snapshot = self.capture()
        try:
            destination = self.root / 'independent-dependency-copy'
            s.copy_leaf(snapshot.source, 'node_modules/pkg/dist/index.js', destination,
                        self.inputs['node_modules/pkg/dist/index.js']['sha256'], s.MAX_FILE, 0o400)
            self.assertEqual(destination.stat().st_nlink, 1)
            self.assertEqual(destination.read_bytes(), self.dependency.read_bytes())
            alias.write_bytes(b'dependency changed through installed-byte hardlink')
            with self.assertRaises(ValueError):
                s.check_snapshot(snapshot)
        finally:
            snapshot.close()

    def test_resealed_internal_link_cycle_refuses(self):
        for name, target in [('cycle-a', 'cycle-b'), ('cycle-b', 'cycle-a')]:
            (self.source / 'node_modules' / name).symlink_to(target)
            self.inputs['node_modules/' + name] = {'kind': 'symlink', 'target': target}
        self.compile['inputInventorySha256'] = digest(canonical(self.inputs).encode())
        self.reseal()
        self.assert_capture_refuses()

    def test_internal_resolution_link_is_measured_and_swap_refuses(self):
        alias = self.source / 'node_modules/alias'
        alias.symlink_to('pkg', target_is_directory=True)
        self.inputs['node_modules/alias'] = {'kind': 'symlink', 'target': 'pkg'}
        self.compile['inputInventorySha256'] = digest(canonical(self.inputs).encode())
        self.reseal()
        snapshot = self.capture()
        try:
            alias.unlink()
            alias.symlink_to('../packages', target_is_directory=True)
            with self.assertRaises(ValueError):
                s.check_snapshot(snapshot)
        finally:
            snapshot.close()

    def test_copy_rechecks_held_input_and_retains_partial_without_runner(self):
        snapshot = self.capture()
        relative = 'scripts/guest-engine/runtime.ts'
        path = self.source / relative
        identity = path.stat()
        original_read = os.read
        changed = False

        def read(fd, count):
            nonlocal changed
            data = original_read(fd, count)
            current = os.fstat(fd)
            if data and not changed and (current.st_dev, current.st_ino) == \
                    (identity.st_dev, identity.st_ino):
                changed = True
                path.write_bytes(b'changed while copied')
            return data

        destination = self.root / 'partial-copy'
        try:
            with patch.object(s.os, 'read', side_effect=read), \
                    patch.object(s.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'copy input changed'):
                    s.copy_leaf(snapshot.source, relative, destination,
                                self.inputs[relative]['sha256'], s.MAX_FILE, 0o400)
                self.assertTrue(changed)
                self.assertTrue(destination.exists())
                run.assert_not_called()
        finally:
            snapshot.close()

    def test_inventory_measurement_rechecks_leaf_after_read(self):
        path = self.artifacts / 'runtimeEntry'
        identity = path.stat()
        original_read = os.read
        changed = False

        def read(fd, count):
            nonlocal changed
            data = original_read(fd, count)
            current = os.fstat(fd)
            if data and not changed and (current.st_dev, current.st_ino) == \
                    (identity.st_dev, identity.st_ino):
                changed = True
                path.write_bytes(b'changed while measured')
            return data

        with patch.object(s.os, 'read', side_effect=read):
            self.assert_capture_refuses()
            self.assertTrue(changed)

    def test_missing_source_and_unmeasured_dependency_refuse(self):
        path = self.source / 'scripts/guest-engine/provider.ts'
        original = path.read_bytes()
        path.unlink()
        self.assert_capture_refuses()
        path.write_bytes(original)
        (self.dependency.parent / 'unmeasured.js').write_bytes(b'new resolution candidate')
        self.assert_capture_refuses()

    def test_receipt_file_inventory_aggregate_and_artifact_bounds_refuse(self):
        limits = {
            'MAX_JSON': len(self.receipt_path.read_bytes()) - 1,
            'MAX_FILE': 8,
            'MAX_ENTRIES': len(self.inputs) - 1,
            'MAX_INPUT_BYTES': sum(item['bytes'] for item in self.inputs.values()) - 1,
            'MAX_ARTIFACT': 19,
            'MAX_ARTIFACT_BYTES': 1,
        }
        for constant, value in limits.items():
            with self.subTest(constant=constant), patch.object(s, constant, value):
                self.assert_capture_refuses()

    def test_resealed_duplicate_metafile_json_refuses(self):
        path = self.artifacts / 'runtimeEntry.metafile.json'
        wire = b'{"inputs":{},' + path.read_bytes()[1:]
        path.write_bytes(wire)
        self.compile['outputs']['runtimeEntry']['metafileSha256'] = digest(wire)
        self.reseal()
        self.assert_capture_refuses()

    def test_resealed_receipt_source_escape_refuses(self):
        outside = self.root / 'external-source.py'
        outside.write_bytes(b'outside source closure')
        self.receipt['sources']['../external-source.py'] = digest(outside.read_bytes())
        self.reseal()
        self.assert_capture_refuses()

    def test_non_root_stage_refuses_without_creating_directory(self):
        snapshot = self.capture()
        try:
            with patch.object(s.os, 'geteuid', return_value=501), \
                    patch.object(s.tempfile, 'mkdtemp') as create, \
                    patch.object(s.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    s.stage(snapshot)
                create.assert_not_called()
                run.assert_not_called()
        finally:
            snapshot.close()

    def test_hostile_tmpdir_does_not_choose_stage_parent(self):
        snapshot = self.capture()
        try:
            with self.simulated_root_metadata(), \
                    patch.object(s.os, 'geteuid', return_value=0), \
                    patch.dict(os.environ, {'TMPDIR': str(self.root / 'hostile')}), \
                    patch.object(s.tempfile, 'mkdtemp', side_effect=RuntimeError('stop before write')) as create, \
                    patch.object(s.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'stop before write'):
                    s.stage(snapshot)
                create.assert_called_once_with(prefix=s.PREFIX, dir='/tmp')
                run.assert_not_called()
        finally:
            snapshot.close()

    def test_foreign_or_writable_ancestry_refuses_before_creation(self):
        snapshot = self.capture()
        real_lstat = os.lstat
        try:
            for name, uid, mode in [('/', 0, 0o777), ('/tmp', 501, 0o1777),
                                    ('/tmp', 0, 0o777)]:
                def metadata(path):
                    if str(path) == name:
                        return SimpleNamespace(st_uid=uid, st_mode=stat.S_IFDIR | mode)
                    return real_lstat(path)
                with self.subTest(name=name, uid=uid, mode=mode), \
                        patch.object(s.os, 'geteuid', return_value=0), \
                        patch.object(s.os, 'lstat', side_effect=metadata), \
                        patch.object(s.tempfile, 'mkdtemp') as create:
                    with self.assertRaisesRegex(ValueError, 'ancestry'):
                        s.stage(snapshot)
                    create.assert_not_called()
        finally:
            snapshot.close()

    def test_capture_pins_source_descriptor_despite_caller_directory_substitution(self):
        snapshot = self.capture()
        try:
            moved = self.root / 'held-source'
            self.source.rename(moved)
            self.source.mkdir()
            (self.source / 'attacker.py').write_text('raise RuntimeError("not admitted")')
            # A new caller spelling does not redirect reads off the captured directory.
            s.check_snapshot(snapshot)
            path = moved / 'scripts/guest-engine/runtime.ts'
            path.write_bytes(b'mutation of the actual held input')
            with patch.object(s.tempfile, 'mkdtemp') as create, \
                    patch.object(s.os, 'geteuid', return_value=0), \
                    self.simulated_root_metadata():
                with self.assertRaises(ValueError):
                    s.stage(snapshot)
                create.assert_not_called()
        finally:
            snapshot.close()

    def test_simulated_protected_closure_verifies_without_execution(self):
        directory = self.protected_fixture()
        with self.simulated_root_metadata(), patch.object(s.subprocess, 'run') as run:
            receipt = s.verify_staged(directory, self.approved, digest(MODULE.read_bytes()))
            self.assertEqual(receipt, self.receipt)
            run.assert_not_called()

    def test_renamed_and_substituted_staged_parent_refuses_without_spawn(self):
        directory = self.protected_fixture()
        real = directory.resolve()
        moved = self.root / 'caller-owned-parent'
        real.chmod(0o700)
        real.rename(moved)
        self.staged_roots.remove(real)
        self.staged_roots.append(moved)
        with self.simulated_root_metadata(), patch.object(s.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'ancestry'):
                s.verify_staged(moved, self.approved, digest(MODULE.read_bytes()))
            run.assert_not_called()
        real.mkdir(mode=0o500)
        self.staged_roots.append(real)
        with patch.object(s.subprocess, 'run') as run:
            with self.assertRaises((ValueError, OSError)):
                s.verify_staged(directory, self.approved, digest(MODULE.read_bytes()))
            run.assert_not_called()

    def test_staged_tamper_and_wrong_parent_digest_refuse_before_spawn(self):
        directory = self.protected_fixture()
        with self.simulated_root_metadata(), patch.object(s.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                s.verify_staged(directory, self.approved, 'f' * 64)
            artifact = directory / 'artifacts/ownerLibrary'
            artifact.chmod(0o600)
            artifact.write_bytes(b'changed after immutable capture')
            artifact.chmod(0o500)
            with self.assertRaises(ValueError):
                s.verify_staged(directory, self.approved, digest(MODULE.read_bytes()))
            run.assert_not_called()

    def test_staged_writable_leaf_and_unlisted_source_refuse_without_spawn(self):
        directory = self.protected_fixture()
        parent_sha = digest(MODULE.read_bytes())
        entry = directory / 'source/scripts/guest-engine/runtime.ts'
        with self.simulated_root_metadata(), patch.object(s.subprocess, 'run') as run:
            entry.chmod(0o600)
            with self.assertRaises(ValueError):
                s.verify_staged(directory, self.approved, parent_sha)
            entry.chmod(0o400)
            folder = entry.parent
            folder.chmod(0o700)
            extra = folder / 'unlisted-import.py'
            extra.write_text('raise RuntimeError("not reviewed")')
            extra.chmod(0o400)
            folder.chmod(0o500)
            with self.assertRaises(ValueError):
                s.verify_staged(directory, self.approved, parent_sha)
            run.assert_not_called()

    def test_runner_uses_stdlib_bootstrap_and_exact_isolated_environment(self):
        directory = self.protected_fixture()
        parent_sha = digest(MODULE.read_bytes())
        with self.simulated_root_metadata(), \
                patch.object(s.sys, 'platform', 'linux'), \
                patch.object(s.os, 'geteuid', return_value=0), \
                patch.object(s, 'system_python', return_value='/usr/bin/python3'), \
                patch.dict(os.environ, {'TMPDIR': str(self.root), 'PYTHONPATH': str(self.source),
                                        'HOME': str(self.root), 'WINTER_HOME': str(self.root)}), \
                patch.object(s, 'verify_staged', wraps=s.verify_staged) as verify, \
                patch.object(s.subprocess, 'run', return_value=SimpleNamespace(returncode=7)) as run:
            self.assertEqual(s.run_staged(directory, self.approved, parent_sha), 7)
            verify.assert_called_once_with(directory, self.approved, parent_sha)
            argv = run.call_args.args[0]
            self.assertEqual(argv[:5], ['/usr/bin/python3', '-I', '-S', '-B', '-c'])
            self.assertEqual(argv[5], s.BOOTSTRAP)
            self.assertEqual(argv[6:], [str(directory), self.approved, parent_sha])
            self.assertEqual(run.call_args.kwargs,
                             {'cwd': '/tmp', 'env': s.ENV, 'check': False})
            self.assertNotIn('PYTHONPATH', run.call_args.kwargs['env'])
            self.assertNotIn('TMPDIR', run.call_args.kwargs['env'])

    def test_main_capture_refusal_cannot_stage_or_run(self):
        self.dependency.write_bytes(b'changed after compilation')
        argv = ['stage.py', '--source', str(self.source), '--artifacts', str(self.artifacts),
                '--receipt', str(self.receipt_path), '--approved-receipt-sha256', self.approved,
                '--approved-parent-sha256', digest(MODULE.read_bytes())]
        with patch.object(s.sys, 'argv', argv), patch.object(s, 'stage') as stage, \
                patch.object(s, 'run_staged') as run:
            with self.assertRaises(ValueError):
                s.main()
            stage.assert_not_called()
            run.assert_not_called()

    def test_run_refuses_unprotected_caller_tree_without_spawn(self):
        with patch.object(s.subprocess, 'run') as run:
            with self.assertRaises((ValueError, OSError)):
                s.run_staged(self.root, self.approved, digest(MODULE.read_bytes()))
            run.assert_not_called()

    def test_direct_verifier_cli_refuses_before_project_import(self):
        project = self.root / 'hostile-project/scripts/guest-engine'
        project.mkdir(parents=True)
        verifier = project / 'verify.py'
        verifier.write_bytes(Path(__file__).with_name('verify.py').read_bytes())
        marker = self.root / 'project-imported'
        (project / 'build.py').write_text(
            f'from pathlib import Path\nPath({str(marker)!r}).write_text("imported")\n'
            'raise RuntimeError("project import reached before admission")\n'
        )
        result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(verifier), '--help'],
            capture_output=True, timeout=10,
            env={'PATH': '/usr/bin:/bin', 'HOME': str(self.root),
                 'WINTER_FRESH_ENGINE_STAGED_ROOT': str(project.parents[1]),
                 'WINTER_FRESH_ENGINE_APPROVED_RECEIPT_SHA': self.approved},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists(), result.stderr.decode(errors='replace'))
        self.assertIn(b'hash-admitted immutable staged runner required', result.stderr)

    def test_forged_interpreter_capability_on_caller_owned_root_cannot_import_project(self):
        directory = self.protected_fixture()
        verifier = directory / 'source/scripts/guest-engine/verify.py'
        verifier.chmod(0o600)
        verifier.write_bytes(Path(__file__).with_name('verify.py').read_bytes())
        verifier.chmod(0o400)
        marker = self.root / 'forged-capability-imported'
        build = verifier.with_name('build.py')
        build.chmod(0o600)
        build.write_text(f'from pathlib import Path\nPath({str(marker)!r}).write_text("imported")\n'
                         'raise RuntimeError("project import reached before admission")\n')
        build.chmod(0o400)
        # UID is a Python return-value substitution only: no process/user authority changes.
        code = '''
import hashlib,os,sys
from pathlib import Path
from types import SimpleNamespace
root=Path(sys.argv[1]);verifier=root/'source/scripts/guest-engine/verify.py'
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY);info=os.fstat(fd)
sys._winter_fresh_stage_admission=SimpleNamespace(directory=str(root),directory_fd=fd,
 identity=(info.st_dev,info.st_ino),receipt_sha=sys.argv[2],parent_sha=sys.argv[3],
 verify_sha=hashlib.sha256(verifier.read_bytes()).hexdigest(),pid=os.getpid())
os.geteuid=lambda:0;sys.platform='linux';sys.argv=[str(verifier),'--help']
try:exec(compile(verifier.read_bytes(),str(verifier),'exec'),{'__name__':'__main__','__file__':str(verifier)})
finally:os.close(fd)
'''
        result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', '-c', code, str(directory), self.approved,
             digest(MODULE.read_bytes())],
            capture_output=True, timeout=10, env={'PATH': '/usr/bin:/bin'},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists(), result.stderr.decode(errors='replace'))
        self.assertIn(b'hash-admitted immutable staged runner required', result.stderr)


if __name__ == '__main__':
    unittest.main()

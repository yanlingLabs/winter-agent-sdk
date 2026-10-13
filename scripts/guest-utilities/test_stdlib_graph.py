"""Synthetic static closure tests. Captured Python/ELF bytes never execute."""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('utility_graph_test', HERE / 'stdlib_graph.py')
graph = importlib.util.module_from_spec(spec);spec.loader.exec_module(graph)


class StaticStdlibGraphTests(unittest.TestCase):
    def setUp(self):
        inert = b'inert captured Python identity, never executed'
        self.builder = {'version':'3.12.3', 'sha256':graph.digest(inert), 'bytes':len(inert)}
        self.files = {'/usr/bin/python3':{'role':'executable', 'source':'usr/bin/python3.12', 'sha256':graph.digest(inert), 'bytes':len(inert)}}
        self.data = {};self.reads = []

    def source(self, relative, code, role='stdlib'):
        guest = graph.PREFIX + relative
        data = code.encode() if isinstance(code, str) else code
        self.data[guest] = data
        self.files[guest] = {'role':role, 'source':guest[1:], 'sha256':graph.digest(data), 'bytes':len(data)}
        return guest

    def run_graph(self, payload, builtins=('sys',), seeds=(), builder=None, platform='linux'):
        def read(guest):
            self.reads.append(guest);return self.data[guest]
        return graph.validate(self.files, read, [('test:1', payload.encode())], builtins, builder or self.builder, seeds, interpreter_platform=platform)

    def test_missing_transitive_required_module_fails_with_importer_and_no_discovery(self):
        self.source('alpha.py', 'import beta\nraise RuntimeError("source must not execute")\n')
        with self.assertRaisesRegex(ValueError, r'missing required captured module: beta \(from alpha\)'):
            self.run_graph('import alpha\n')
        self.source('beta.py', 'import sys\n')
        result = self.run_graph('import alpha\n')
        self.assertEqual(set(result['visited']), {'alpha', 'beta'})
        self.assertTrue(result['requiredStaticImportsCaptured']);self.assertFalse(result['dynamicCompletenessVerified'])
        self.assertFalse(result['nativeExecutionVerified'])

    def test_relative_submodules_and_exported_functions_are_resolved_without_inventing_modules(self):
        self.source('pkg/__init__.py', 'from .worker import exported\n')
        self.source('pkg/worker.py', 'from . import helper\ndef exported():\n    return helper.value\n')
        self.source('pkg/helper.py', 'value = 7\n')
        result = self.run_graph('from pkg import exported, worker\nfrom pkg.worker import exported\nfrom sys import maxsize\n')
        self.assertEqual(set(result['visited']), {'pkg', 'pkg.worker', 'pkg.helper'})
        self.assertFalse(any(edge['module'].endswith(('.exported', '.maxsize')) for edge in result['requiredEdges']))
        self.source('pkg/__init__.py', 'from . import missing\n')
        with self.assertRaisesRegex(ValueError, 'missing required captured module: pkg.missing'):
            self.run_graph('import pkg\n')

    def test_interpreter_identity_is_required_for_builtins_and_extensions_are_measured(self):
        extension = self.source('lib-dynload/_socket.cpython-312-aarch64-linux-gnu.so', b'\x7fELF-inert-not-executed', 'extension')
        result = self.run_graph('from sys import maxsize\nfrom _socket import socket\n')
        self.assertEqual(result['visited']['_socket']['guest'], extension)
        self.assertEqual(result['builtinInterpreter'], self.builder)
        for changes in ({'sha256':'0'*64}, {'bytes':1}, {'bytes':True}, {'version':'3.13.0'}, {'authority':'unmeasured'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.run_graph('import sys\n', builder={**self.builder, **changes})
        with self.assertRaisesRegex(ValueError, 'missing required captured module: sys'):
            self.run_graph('import sys\n', builtins=('time',))
        self.data[extension] += b'changed'
        with self.assertRaisesRegex(ValueError, 'static source measurement changed: _socket'):
            self.run_graph('import _socket\n')

    def test_optional_platform_and_importerror_paths_are_reported_and_other_try_imports_stay_required(self):
        self.source('alpha.py', 'try:\n    import missing_accelerator\nexcept ImportError:\n    pass\nif False:\n    from missing_platform import value\ndef later():\n    import missing_lazy\n')
        result = self.run_graph('import alpha\n')
        self.assertEqual([item['reason'] for item in result['optionalImports']], ['try-import-error', 'conditional-branch'])
        self.assertFalse(result['optionalImports'][0]['captured']['missing_accelerator'])
        self.assertFalse(result['optionalImports'][1]['captured']['missing_platform.value'])
        self.assertEqual(result['deferredImports'][0]['modules'], ['missing_lazy'])
        self.assertFalse(result['optionalBranchesVerified'])
        self.source('alpha.py', 'try:\n    import still_required\nexcept OSError:\n    pass\n')
        with self.assertRaisesRegex(ValueError, 'missing required captured module: still_required'):
            self.run_graph('import alpha\n')

    def test_cycles_terminate_and_explicit_exercised_seeds_cover_function_lazy_imports(self):
        self.source('alpha.py', 'import beta\ndef later():\n    import exercised\n')
        self.source('beta.py', 'import alpha\n')
        with self.assertRaisesRegex(ValueError, 'missing required captured module: exercised'):
            self.run_graph('import alpha\n', seeds=('exercised',))
        self.source('exercised.py', 'import sys\n')
        result = self.run_graph('import alpha\n', seeds=('exercised',))
        self.assertEqual(set(result['visited']), {'alpha', 'beta', 'exercised'})
        self.assertEqual(result['exercisedSeeds'], ['exercised'])
        self.assertEqual(self.reads.count(graph.PREFIX+'alpha.py'), 2)  # Once per graph invocation.

    def test_tampered_source_and_ambiguous_module_inventory_refuse(self):
        guest = self.source('alpha.py', 'import sys\n')
        self.data[guest] = b'import missing\n'
        with self.assertRaisesRegex(ValueError, 'static source measurement changed: alpha'):
            self.run_graph('import alpha\n')
        self.source('alpha.py', 'import sys\n');self.source('alpha/__init__.py', 'import sys\n')
        with self.assertRaisesRegex(ValueError, 'ambiguous captured module inventory'):
            self.run_graph('import alpha\n')

    def test_star_exports_and_relative_parent_imports_are_not_missing_submodules(self):
        self.source('pkg/__init__.py', 'from .api import *\n')
        self.source('pkg/api.py', 'def exported():\n    return 1\n')
        self.source('pkg/sub/__init__.py', 'from ..api import exported\n')
        result = self.run_graph('from pkg import exported\nfrom pkg.sub import exported\n')
        self.assertEqual(set(result['visited']), {'pkg', 'pkg.api', 'pkg.sub'})
        self.assertFalse(any(edge['module'].endswith('.exported') for edge in result['requiredEdges']))

    def os_source(self):
        return "import sys\n_names = sys.builtin_module_names\nif 'posix' in _names:\n    import posixpath as path\nelif 'nt' in _names:\n    import ntpath as path\nelse:\n    raise ImportError('no os specific module found')\nsys.modules['os.path'] = path\nfrom os.path import curdir\ndel _names\n"

    def test_linux_os_path_alias_uses_measured_source_and_follows_target_dependencies(self):
        os_guest = self.source('os.py', self.os_source())
        target = self.source('posixpath.py', "import genericpath\ncurdir = '.'\ndef join(*paths):\n    return paths\n")
        self.source('genericpath.py', 'import sys\n')
        result = self.run_graph('import os.path\nfrom os.path import join\n', builtins=('sys', 'posix'))
        self.assertEqual(set(result['visited']), {'os', 'posixpath', 'genericpath'})
        alias = result['aliases']['os.path']
        self.assertEqual(alias['target'], 'posixpath');self.assertEqual(alias['sourceGuest'], os_guest)
        self.assertEqual(alias['sourceSha256'], self.files[os_guest]['sha256'])
        self.assertEqual(alias['interpreterPlatform'], 'linux');self.assertEqual(alias['builtin'], 'posix')
        self.assertEqual(result['interpreterPlatform'], 'linux')
        with self.assertRaisesRegex(ValueError, 'missing required captured module: os.unknown'):
            self.run_graph('import os.unknown\n', builtins=('sys', 'posix'))
        del self.files[target]
        with self.assertRaisesRegex(ValueError, 'missing required captured module: posixpath'):
            self.run_graph('import os.path\n', builtins=('sys', 'posix'))
        self.source('posixpath.py', "import missing_transitive\ncurdir = '.'\n")
        with self.assertRaisesRegex(ValueError, 'missing required captured module: missing_transitive'):
            self.run_graph('import os.path\n', builtins=('sys', 'posix'))

    def test_os_path_alias_rejects_fake_bindings_platform_builtins_and_interpreter_identity(self):
        original = self.os_source();self.source('posixpath.py', "curdir = '.'\n")
        for code in (original.replace('posixpath as path', 'ntpath as path'), original.replace('sys.builtin_module_names', "('posix',)"), original.replace("sys.modules['os.path'] = path", "sys.modules['os.path'] = sys"), original + 'path = sys\n', original.replace("if 'posix' in _names:", 'if True:'), original + "sys.modules['os.path'] = sys\n", original.replace("if 'posix' in _names:", "del _names\nif 'posix' in _names:")):
            self.source('os.py', code)
            with self.subTest(code=code), self.assertRaises(ValueError):
                self.run_graph('import os.path\n', builtins=('sys', 'posix'))
        self.source('os.py', original)
        for builtins in (('sys',), ('sys', 'posix', 'nt')):
            with self.subTest(builtins=builtins), self.assertRaisesRegex(ValueError, 'posix builtin evidence'):
                self.run_graph('import os.path\n', builtins=builtins)
        with self.assertRaisesRegex(ValueError, 'Linux interpreter platform'):
            self.run_graph('import os.path\n', builtins=('sys', 'posix'), platform='darwin')
        with self.assertRaisesRegex(ValueError, 'exact captured interpreter identity'):
            self.run_graph('import os.path\n', builtins=('sys', 'posix'), builder={**self.builder, 'sha256':'0'*64})

    def test_all_fixed_payload_roots_are_extracted_as_syntax_not_executed(self):
        roots = graph.payload_roots((HERE/'smoke.sh').read_bytes(), (HERE/'descendant.py').read_bytes())
        self.assertEqual([name for name, _ in roots], ['smoke:1', 'smoke:2', 'smoke:3', 'smoke:4', 'smoke:5', 'descendant'])
        self.assertIn(b'import multiprocessing', roots[3][1])
        self.assertIn(b'import os,sys,time', roots[-1][1])
        for payload in (b'python3 -c "import sys"\n', b"python3 - <<'PY'\nimport sys\n"):
            with self.assertRaises(ValueError):graph.payload_roots(payload, b'import sys\n')
        recipe = (HERE/'utility_inputs.py').read_text()
        self.assertLess(recipe.index("static_graph=validate_stdlib_graph(origin,manifest['files'],builder)"), recipe.index("(output/'input-manifest.json').write_text"))
        self.assertIn("'staticStdlibGraph':static_graph", recipe)


if __name__ == '__main__':
    unittest.main()

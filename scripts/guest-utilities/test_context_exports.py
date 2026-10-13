"""Synthetic finite context-export tests. Captured Python bytes never execute."""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('utility_context_graph_test', HERE / 'test_stdlib_graph.py')
tests = importlib.util.module_from_spec(spec);spec.loader.exec_module(tests)

PACKAGE = "from . import context\n__all__ = [x for x in dir(context._default_context) if not x.startswith('_')]\nglobals().update((name, getattr(context._default_context, name)) for name in __all__)\n"
CONTEXT = "class BaseContext(object):\n    def get_start_method(self):\n        return 'fork'\n    def set_start_method(self, method):\n        pass\nclass DefaultContext(BaseContext):\n    def get_start_method(self):\n        return 'fork'\n    def set_start_method(self, method):\n        pass\n_default_context = DefaultContext(_concrete_contexts['fork'])\n"


class ContextExportTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tests.StaticStdlibGraphTests();self.fixture.setUp()
        self.package = self.fixture.source('multiprocessing/__init__.py', PACKAGE)
        self.context = self.fixture.source('multiprocessing/context.py', CONTEXT)
        self.fixture.source('multiprocessing/spawn.py', 'from . import get_start_method, set_start_method\n')

    def run_graph(self):
        return self.fixture.run_graph('import multiprocessing.spawn\n')

    def test_only_two_class_derived_exports_are_byte_bound_and_runtime_values_remain_unverified(self):
        result = self.run_graph();record = result['finiteClassDerivedExports']['multiprocessing']
        self.assertEqual(set(result['visited']), {'multiprocessing', 'multiprocessing.context', 'multiprocessing.spawn'})
        self.assertEqual(record['symbols'], ['get_start_method', 'set_start_method'])
        self.assertEqual(record['packageSha256'], self.fixture.files[self.package]['sha256'])
        self.assertEqual(record['contextSha256'], self.fixture.files[self.context]['sha256'])
        self.assertEqual(record['classLineage'], ['DefaultContext', 'BaseContext'])
        self.assertFalse(record['runtimeExportsVerified']);self.assertFalse(result['dynamicCompletenessVerified'])
        self.assertFalse(result['optionalBranchesVerified']);self.assertFalse(result['nativeExecutionVerified'])
        for payload in ('from multiprocessing import unknown\n', 'from multiprocessing import get_context\n'):
            with self.subTest(payload=payload),self.assertRaisesRegex(ValueError, 'missing required captured module'):
                self.fixture.run_graph(payload)
        self.fixture.source('multiprocessing/__init__.py', PACKAGE + 'from . import missing_real_module\n')
        with self.assertRaisesRegex(ValueError, 'missing required captured module: multiprocessing.missing_real_module'):
            self.run_graph()

    def test_missing_or_tampered_context_source_refuses_before_derived_exports(self):
        del self.fixture.files[self.context]
        with self.assertRaisesRegex(ValueError, 'captured multiprocessing context source required'):self.run_graph()
        self.fixture.source('multiprocessing/context.py', CONTEXT)
        self.fixture.data[self.context] += b'# changed bytes\n'
        with self.assertRaisesRegex(ValueError, 'context source measurement changed'):self.run_graph()

    def test_unknown_glue_and_all_module_scope_glue_rebindings_refuse(self):
        for code in (PACKAGE.replace("not x.startswith('_')", 'True'), PACKAGE.replace('getattr(context._default_context, name)', 'getattr(other, name)'), PACKAGE + 'context = None\n', PACKAGE + 'context: object = None\n', PACKAGE + 'context += other\n', PACKAGE + 'del context\n', PACKAGE + 'import fake as context\n', PACKAGE + 'from fake import context\n', PACKAGE + '__all__ = []\n', PACKAGE + "context._default_context = other\n", PACKAGE + 'def context():\n    pass\n'):
            self.fixture.source('multiprocessing/__init__.py', code)
            with self.subTest(code=code),self.assertRaises(ValueError):self.run_graph()

    def test_unknown_lineage_missing_methods_and_contradictory_class_or_default_bindings_refuse(self):
        variants = [CONTEXT.replace('DefaultContext(BaseContext)', 'DefaultContext(OtherContext)'), CONTEXT.replace('def get_start_method', 'def missing_method'), CONTEXT.replace('DefaultContext(_concrete_contexts', 'OtherContext(_concrete_contexts')]
        variants += [CONTEXT + mutation + '\n' for mutation in ('DefaultContext = other', 'import fake as DefaultContext', 'from fake import BaseContext', 'def DefaultContext():\n    pass', '_default_context: object = other', '_default_context += other', 'del _default_context', 'import fake as _default_context', 'DefaultContext.get_start_method = None', 'del BaseContext.set_start_method')]
        variants.append(CONTEXT.replace("_default_context =", "DefaultContext.set_start_method: object = None\n_default_context ="))
        variants.append(CONTEXT.replace("_default_context =", "DefaultContext.get_start_method += other\n_default_context ="))
        variants.append(CONTEXT.replace("    def set_start_method(self, method):\n        pass\n_default_context", "    def set_start_method(self, method):\n        pass\n    get_start_method = None\n_default_context"))
        for code in variants:
            self.fixture.source('multiprocessing/context.py', code)
            with self.subTest(code=code),self.assertRaises(ValueError):self.run_graph()

    def test_other_packages_do_not_get_computed_export_exemptions(self):
        self.fixture.source('pkg/__init__.py', PACKAGE.replace('from . import context', 'context = None'))
        with self.assertRaisesRegex(ValueError, 'missing required captured module: pkg.get_start_method'):
            self.fixture.run_graph('from pkg import get_start_method\n')


if __name__ == '__main__':
    unittest.main()

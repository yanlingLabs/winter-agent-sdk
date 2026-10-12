"""No process launch: uncertain fixture unwinding retains its exact disposable files."""
import importlib.util,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
MODULE=Path(__file__).with_name('verify.py');spec=importlib.util.spec_from_file_location('retention_verify',MODULE);verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)
class RetentionTests(unittest.TestCase):
    def test_uncertain_unwind_retains_files_and_reports_only_normalized_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'winter-fresh-engine-fixture';directory.mkdir();(directory/'store').write_text('must retain')
            errors=io.StringIO()
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(directory)),patch.object(verify.sys,'stderr',errors):
                with self.assertRaisesRegex(RuntimeError,'uncertain'):
                    with verify.retained_fixture_directory() as root:
                        self.assertEqual(root,directory);raise RuntimeError('uncertain')
            self.assertEqual((directory/'store').read_text(),'must retain')
            self.assertEqual(json.loads(errors.getvalue()),{'fixtureRetained':True,'retentionId':directory.name,'nativeCleanupConfirmed':False})
            self.assertNotIn(temporary,errors.getvalue())
    def test_context_does_not_delete_even_after_normal_return_without_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'winter-fresh-engine-fixture';directory.mkdir()
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(directory)),patch.object(verify.sys,'stderr',io.StringIO()):
                with verify.retained_fixture_directory():pass
            self.assertTrue(directory.is_dir())
if __name__=='__main__':unittest.main()

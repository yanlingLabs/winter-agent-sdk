"""No process launch: uncertain fixture unwinding retains its exact disposable files."""
import importlib.util,io,json,tempfile,unittest
from unittest.mock import MagicMock
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
            self.assertEqual(json.loads(errors.getvalue()),{'fixtureRetained':True,'retentionId':directory.name,'nativeCleanupConfirmed':False,'ownershipReleased':False})
            self.assertNotIn(temporary,errors.getvalue())
    def test_context_does_not_delete_even_after_normal_return_without_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'winter-fresh-engine-fixture';directory.mkdir()
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(directory)),patch.object(verify.sys,'stderr',io.StringIO()):
                with verify.retained_fixture_directory():pass
            self.assertTrue(directory.is_dir())
    def test_failure_before_store_creation_has_normalized_durable_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'winter-fresh-engine-fixture';directory.mkdir()
            observations={'phase':'service-startup','nativeCleanupConfirmed':False}
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(directory)),patch.object(verify.sys,'stderr',io.StringIO()):
                with self.assertRaises(OSError):
                    with verify.retained_fixture_directory(observations):raise OSError(13,'secret /private/path must not persist')
            record=json.loads((directory/'fixture-diagnostic.json').read_text())
            self.assertEqual(record['failure'],{'class':'PermissionError','errno':13})
            self.assertEqual(record['observations']['phase'],'service-startup');self.assertFalse(record['ownershipReleased'])
            self.assertFalse((directory/'store').exists());self.assertNotIn('secret',(directory/'fixture-diagnostic.json').read_text());self.assertEqual((directory/'fixture-diagnostic.json').stat().st_mode&0o777,0o600)
    def test_failure_after_cleanup_preserves_native_and_provider_observations(self):
        # Entire fixture flow is injected; no Popen implementation or privileged effect executes.
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'winter-fresh-engine-fixture';directory.mkdir();config=directory/'bootstrap.json';config.write_text('{}')
            fixture={'config':config,'binary':directory,'control':directory};observations={'phase':'fixture-staging','nativeCleanupConfirmed':False}
            server=MagicMock();server.stdin=io.BytesIO();server.stdout=io.BytesIO(b'service /private/path');server.stderr=io.BytesIO(b'');server.returncode=9;server.poll.return_value=9
            provider=MagicMock();provider.stdin=None;provider.stdout=io.BytesIO(b'{"passed":true,"turns":5,"peerValidated":true}');provider.stderr=io.BytesIO(b'');provider.returncode=0;provider.poll.return_value=0
            status={'active':0,'uncertain':False,'runtime':{'state':'stopped','exitCode':0,'cleanupConfirmed':True}}
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(directory)),patch.object(verify.sys,'stderr',io.StringIO()),patch.object(verify.subprocess,'Popen',return_value=server),patch.object(verify,'start_provider',return_value=(provider,MagicMock())),patch.object(verify,'admit_provider'),patch.object(verify,'exchange',return_value={'started':True}),patch.object(verify,'wait_for',side_effect=[True,status]),patch.object(verify,'persisted_evidence',return_value={}):
                with self.assertRaisesRegex(AssertionError,'retained cleanup obligation'):
                    with verify.retained_fixture_directory(observations):verify.execute_fixture(directory,fixture,{'artifacts':{}},observations)
            record=json.loads((directory/'fixture-diagnostic.json').read_text());observed=record['observations']
            self.assertEqual(observed['phase'],'service-reap');self.assertTrue(observed['nativeCleanupConfirmed']);self.assertTrue(observed['serviceReaped']);self.assertEqual(observed['serviceExitCode'],9)
            self.assertEqual(observed['providerReceipt'],{'passed':True,'turns':5,'peerValidated':True});self.assertTrue(observed['providerReaped']);self.assertFalse(record['ownershipReleased'])
            self.assertIn('sha256',observed['servicestdout']);self.assertNotIn('/private/path',(directory/'fixture-diagnostic.json').read_text());self.assertTrue(directory.exists())
    def test_capture_is_bounded_and_durable_summary_contains_no_output(self):
        capture=verify.BoundedCapture(io.BytesIO(b'private /path secret'*10000),100);capture.finish();metadata=capture.metadata()
        self.assertEqual(len(capture.data),100);self.assertTrue(metadata['truncated']);self.assertTrue(metadata['drainComplete']);self.assertNotIn('secret',json.dumps(metadata))
    def test_provider_failure_receipt_is_normalized_even_after_nonzero_exit(self):
        receipt=verify.provider_receipt_observation(b'{"passed":false,"turns":2,"peerValidated":true,"failure":{"phase":"provider_exchange","code":"native_continuation","message":"secret /private/path"}}')
        self.assertEqual(receipt,{'passed':False,'turns':2,'peerValidated':True,'failure':{'phase':'provider_exchange','code':'native_continuation'}});self.assertNotIn('secret',json.dumps(receipt))
        self.assertEqual(verify.provider_receipt_observation(b'invalid /private/path'),{'parsed':False})
    def test_normalized_stderr_retains_diagnostic_and_redacts_private_values(self):
        data=('Native owner initialization failed /private/fixture/runtime-view-abc bearer synthetic-token token=another-secret '+ 'f'*64+' DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET').encode()
        capture=verify.BoundedCapture(io.BytesIO(data),16384,('/private/fixture',));capture.finish();record=capture.metadata();text=record['normalizedText']
        self.assertIn('Native owner initialization failed',text)
        for private in ('/private','runtime-view-abc','synthetic-token','another-secret','f'*64,'DISPOSABLE-HOST-CREDENTIAL'):self.assertNotIn(private,text)
        self.assertLessEqual(len(verify.normalized_stderr(b'x'*16384).encode()),4096)
        self.assertNotIn('normalizedText',verify.BoundedCapture(io.BytesIO(data),16384).metadata())
if __name__=='__main__':unittest.main()

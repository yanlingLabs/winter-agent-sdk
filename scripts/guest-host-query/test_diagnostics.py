"""Injected failure records only; no Root/native/service/process launch."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('host_query_diagnostic_test',HERE/'verify.py')
verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.helper=verify.stable_helpers();self.helper['LOGICAL']='host-query-ask-allow'

    def test_closed_failure_reasons_codes_and_errno_do_not_echo_messages(self):
        self.assertEqual(verify.diagnostic_failure(AssertionError('runtime owner handoff deadline'),self.helper),{'class':'AssertionError','reason':'runtime_owner_handoff_deadline'})
        self.assertEqual(verify.diagnostic_failure(AssertionError('secret /foreign/path'),self.helper),{'class':'AssertionError'})
        self.assertEqual(verify.diagnostic_failure(AssertionError({'unhashable':'secret'}),self.helper),{'class':'AssertionError'})
        self.assertEqual(verify.diagnostic_failure(OSError(13,'bearer secret /foreign/path'),self.helper),{'class':'PermissionError','errno':13})
        Refusal=type('Refusal',(ValueError,),{})
        self.assertEqual(verify.diagnostic_failure(Refusal('runtime_duplex_descriptor'),self.helper),{'class':'Refusal','code':'runtime_duplex_descriptor'})
        self.assertEqual(verify.diagnostic_failure(Refusal('secret /foreign/path'),self.helper),{'class':'Refusal'})
        self.assertEqual(verify.diagnostic_failure(self.helper['MountIsolationError']('runtime_propagation'),self.helper),{'class':'MountIsolationError','code':'runtime_propagation'})

    def test_dac_failure_retains_injected_owned_child_exit_code_without_fork(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(verify.os,'fork',return_value=123),patch.object(verify.os,'waitpid',return_value=(123,61<<8)):
            with self.assertRaises(AssertionError) as failure:verify.dac_writable_control(Path(temp))
        self.assertEqual(verify.diagnostic_failure(failure.exception,self.helper),{'class':'AssertionError','reason':'same_source_dac_positive_control','dacExitCode':61})

    def test_capture_records_are_bounded_normalized_and_stdout_is_metadata_only(self):
        capture=self.helper['BoundedCapture'](io.BytesIO(b'{"passed":false,"failure":{"code":"callback_binding","class":"Error","errnoCode":"EPIPE"},"secret":"PRIVATE"}'),65536)
        error=self.helper['BoundedCapture'](io.BytesIO(b'bearer SECRET /foreign/path\n'*2000),16384,('/fixture/root',))
        capture.finish();error.finish()
        process=SimpleNamespace(poll=lambda:1)
        with tempfile.TemporaryDirectory() as temp:
            result=verify.failure_observation(None,'host-query-ask-allow',[capture],[error],(process,None),Path(temp),self.helper)
        wire=json.dumps(result)
        self.assertNotIn('PRIVATE',wire);self.assertNotIn('SECRET',wire);self.assertNotIn('/foreign/path',wire)
        self.assertEqual(result['processes']['host']['receipt']['failure'],{'code':'callback_binding','class':'Error','errnoCode':'EPIPE'})
        self.assertEqual(result['processes']['host']['exitCode'],1)
        self.assertFalse(result['nativeStatusAvailable']);self.assertTrue(result['processes']['host']['stderr']['truncated'])
        self.assertLessEqual(len(result['processes']['host']['stderr']['normalizedText'].encode()),4096)

    def test_host_sdk_receipt_enums_and_process_bounds_match_classifier(self):
        def observe(failure):
            capture=self.helper['BoundedCapture'](io.BytesIO(json.dumps({'passed':False,'failure':failure}).encode()),65536);capture.finish()
            with tempfile.TemporaryDirectory() as temp:
                value=verify.failure_observation(None,'host-query-ask-allow',[capture],[],(None,None),Path(temp),self.helper)
            return value['processes']['host']['receipt']['failure']
        for name in ('CLIConnectionError','ProtocolDecodeError','AbortError'):
            self.assertEqual(observe({'class':name,'code':'host_failure','processCode':255,'signal':'SIGKILL','resultSubtype':'success'}),{'class':name,'code':'host_failure'})
        self.assertEqual(observe({'class':'ProcessError','code':'host_failure','processCode':255,'signal':'SIGTRAP'}),{'class':'ProcessError','code':'host_failure','processCode':255,'signal':'SIGTRAP'})
        self.assertEqual(observe({'class':'ProcessError','code':'host_failure','processCode':None,'signal':None}),{'class':'ProcessError','code':'host_failure','processCode':None,'signal':None})
        for code in (-1,256,1.5,True):
            self.assertEqual(observe({'class':'ProcessError','code':'host_failure','processCode':code,'signal':'/private/signal'}),{'class':'ProcessError','code':'host_failure'})
        for subtype in ('success','error_max_turns','error_during_execution','error_max_budget_usd','error_max_structured_output_retries'):
            self.assertEqual(observe({'class':'ResultError','code':'host_failure','resultSubtype':subtype,'result':'secret /private'}),{'class':'ResultError','code':'host_failure','resultSubtype':subtype})
        self.assertEqual(observe({'class':'ResultError','code':'host_failure','resultSubtype':'/foreign/subtype'}),{'class':'ResultError','code':'host_failure'})
        self.assertEqual(observe({'class':'/private/class','code':'host_failure','processCode':77,'signal':'SIGTRAP'}),{'code':'host_failure'})
        source=(HERE/'host-client.ts').read_text()
        for signal in verify.HOST_SIGNALS:self.assertIn('"'+signal+'"',source)

    def test_before_after_native_status_does_not_imply_release(self):
        logical='host-query-ask-allow'
        service=SimpleNamespace(lock=threading.Lock(),runtimes={logical:{'state':'retained','exitCode':77,'cleanupConfirmed':False,'private':'secret'}},debt={logical},active={(logical,'request'):(logical,None,'file')})
        with tempfile.TemporaryDirectory() as temp:
            before=verify.failure_observation(service,logical,[],[],(None,None),Path(temp),self.helper)
            service.runtimes[logical].update(state='stopped',exitCode=0,cleanupConfirmed=True);service.debt.clear();service.active.clear()
            after=verify.failure_observation(service,logical,[],[],(None,None),Path(temp),self.helper)
        self.assertEqual(before['nativeStatus']['state'],'retained');self.assertTrue(before['logicalDebtObserved']);self.assertTrue(before['logicalActiveObserved'])
        self.assertEqual(after['nativeStatus']['state'],'stopped');self.assertTrue(after['nativeStatus']['cleanupConfirmed'])
        self.assertNotIn('ownershipReleased',after);self.assertNotIn('secret',json.dumps((before,after)))

    def test_fixed_runtime_diagnostic_missing_or_fifo_is_explicit_and_nonblocking(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);control=root/'control';control.mkdir(mode=0o700);private=control/'host-query-ask-allow';private.mkdir(mode=0o700)
            missing=verify.failure_observation(None,'host-query-ask-allow',[],[],(None,None),root,self.helper)
            self.assertFalse(missing['runtimeDiagnosticAvailable'])
            os.mkfifo(private/'runtime-diagnostic.json',0o600)
            refused=verify.failure_observation(None,'host-query-ask-allow',[],[],(None,None),root,self.helper)
            self.assertIn('runtimeDiagnosticReadFailure',refused)
            self.assertNotIn('runtimeDiagnostic',refused)

    def test_durable_failure_prints_bounded_metadata_and_retains_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'winter-host-query-run-fixture';root.mkdir(mode=0o711);(root/'sentinel').write_bytes(b'retain')
            output=io.StringIO()
            with contextlib.redirect_stdout(output):
                record=verify.print_failure_record(root,'ask-allow','owner-handoff',AssertionError('runtime owner unavailable'),{'nativeStatusAvailable':False},{'nativeStatusAvailable':False},{'serviceCloseObserved':False},self.helper)
            self.assertEqual(json.loads(output.getvalue()),record)
            self.assertEqual(record['phase'],'owner-handoff');self.assertEqual(record['retentionId'],root.name)
            self.assertFalse(record['ownershipReleased']);self.assertFalse(record['cleanup']['serviceCloseObserved']);self.assertTrue(record['retentionDirectoryObserved'])
            self.assertEqual(json.loads((root/'fixture-diagnostic.json').read_bytes()),record)
            self.assertEqual((root/'sentinel').read_bytes(),b'retain');self.assertEqual((root/'fixture-diagnostic.json').stat().st_mode&0o777,0o600)
            self.assertNotIn(temp,output.getvalue());self.assertLessEqual(len(output.getvalue().encode()),32768)

    def test_unknown_phase_overlarge_record_and_write_collision_do_not_claim_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'winter-host-query-run-fixture';root.mkdir();path=root/'fixture-diagnostic.json';path.write_bytes(b'original')
            with contextlib.redirect_stdout(io.StringIO()):
                record=verify.print_failure_record(root,'ask-allow','secret /foreign/path',RuntimeError('secret /path'),{'data':'x'*33000},{},{'serviceCloseObserved':None},self.helper)
            self.assertEqual(record['phase'],'unknown');self.assertTrue(record['diagnosticTruncated'])
            self.assertIn('diagnosticWriteFailure',record);self.assertFalse(record['ownershipReleased']);self.assertEqual(path.read_bytes(),b'original')
            self.assertNotIn('secret',json.dumps(record));self.assertLessEqual(len(json.dumps(record).encode()),32768)

    def test_unreadable_retention_directory_remains_unknown(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'winter-host-query-run-fixture';root.mkdir()
            with patch.object(Path,'lstat',side_effect=PermissionError(13,'secret')),contextlib.redirect_stdout(io.StringIO()):
                record=verify.print_failure_record(root,'ask-allow','owner-handoff',RuntimeError('secret'),{},{},{},self.helper)
            self.assertIsNone(record['retentionDirectoryObserved'])

    def test_outer_baseline_failure_is_reported_without_launching_or_cleaning_service(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'winter-host-query-run-fixture';root.mkdir()
            class Oracle:
                def __init__(self,path):pass
                def before(self,observed):raise self_error
            self_error=self.helper['MountIsolationError']('outer_mounts_changed')
            helper=dict(self.helper,MountIsolationOracle=Oracle)
            output=io.StringIO()
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(root)),patch.object(verify,'load',side_effect=AssertionError('must not load service')),contextlib.redirect_stdout(output):
                with self.assertRaises(helper['MountIsolationError']):verify.run_case('ask-allow',Path(temp),{},helper)
            record=json.loads(output.getvalue());self.assertEqual(record['phase'],'outer-baseline');self.assertEqual(record['failure']['code'],'outer_mounts_changed')
            self.assertFalse(record['beforeCleanup']['nativeStatusAvailable']);self.assertIsNone(record['cleanup']['serviceCloseObserved']);self.assertFalse(record['ownershipReleased'])


if __name__=='__main__':unittest.main()

"""Portable diagnostics tests. No native client, supervisor, mount or root executes."""
import copy,importlib.util,json,shutil,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('utility_diagnostics',HERE/'verify.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)


class UtilityDiagnosticsTests(unittest.TestCase):
    def test_client_exit_and_bounded_stderr_discard_paths_authority_credentials_and_source(self):
        private=b'/private/fixture authority={"workspaceId":"workspace-private","ownerToken":"owner-private"} token=credential-private'
        data=b'40 | throw new Error("exact utility smoke result required token=credential-private")\nError: exact utility smoke result required '+private+b'\n    at '+private+b'\nValueError: '+private+b'\n'+b'x'*20000
        record=v.client_observation('ordinary',126,b'',data)
        self.assertEqual(record['exitCode'],126);self.assertEqual(record['stdout']['classification'],'empty')
        self.assertEqual(record['stderr']['capturedBytes'],16384);self.assertTrue(record['stderr']['truncated'])
        self.assertIn('Error: exact utility smoke result required',record['stderr']['normalizedText'])
        encoded=json.dumps(record)
        for value in ('/private','workspace-private','owner-private','credential-private','throw new Error','authority='):
            self.assertNotIn(value,encoded)
        self.assertLessEqual(len(record['stderr']['normalizedText'].encode()),4096)

    def test_valid_stdout_failure_has_only_fixed_classification_and_code(self):
        wire=json.dumps({'ok':False,'code':'cwd_denied','authority':{'ownerToken':'private-token'},'contents':'private-body'}).encode()
        record=v.stdout_observation(wire)
        self.assertEqual(record['classification'],'json_failure');self.assertEqual(record['failureCode'],'cwd_denied')
        self.assertNotIn('private',json.dumps(record))
        record=v.stdout_observation(b'{"passed":false,"failure":{"code":"private-code"},"path":"/private/path"}')
        self.assertEqual(record['classification'],'json_failure');self.assertEqual(record['failureCode'],'unrecognized')
        for wire,classification in ((b'{"ok":false,"ok":true}','invalid_json'),(b'not json','invalid_json'),(b'[]','json_non_object'),(b'x'*65537,'over_limit')):
            self.assertEqual(v.stdout_observation(wire)['classification'],classification)
        self.assertEqual(v.stdout_observation(None)['classification'],'unavailable')

    def test_unknown_stderr_and_exception_text_are_never_retained(self):
        self.assertEqual(v.normalized_stderr(b'UNCLASSIFIED_PRIVATE_VALUE /private/path'), '[stderr details redacted]')
        observations={'phase':'client-ordinary','clients':[v.client_observation('ordinary',1,b'{"ok":false,"code":"authority_denied"}',b'Error: private-value')],'serviceReaped':True,'serviceExitCode':0,'serviceCleanupConfirmed':True,'nativeCleanupConfirmed':False}
        record=v.failure_record(ValueError('private exception /secret/path token=raw'),observations)
        self.assertTrue(record['fixtureRetained']);self.assertFalse(record['generalToolAvailabilityEnabled'])
        self.assertTrue(record['serviceCleanupConfirmed']);self.assertFalse(record['nativeCleanupConfirmed'])
        self.assertEqual(record['phase'],'client-ordinary');self.assertEqual(record['serviceExitCode'],0)
        self.assertNotIn('private-value',json.dumps(record));self.assertNotIn('/secret',json.dumps(record))
        self.assertLess(len(json.dumps(record).encode()),32768)

    def test_exact_client_failure_observation_is_safe_and_parent_whitelists_it(self):
        bun=shutil.which('bun')
        if not bun:self.skipTest('existing Bun unavailable')
        source=(HERE/'client.ts').read_text();start=source.index('function processFailureObservation(')
        helper=source[start:source.index('if (process.platform',start)]
        cases=[{'exitCode':1,'termination':'exit','stdout':'tool-device-stdin-fds-ok\nPRIVATE_BODY\n','stderr':'  File "<stdin>", line 47, in <module>\n  File "/secret/path", line 93, in <module>\n  File "<string>", line 7, in <module>\nModuleNotFoundError: No module named private_module /secret/path token=private-token'},{'exitCode':126,'termination':'exit','stdout':'','stderr':'error while loading shared libraries: private-library.so: /secret/path'},{'exitCode':1,'termination':'exit','stdout':'','stderr':'PRIVATE_VALUE'+('x'*20000)+'AssertionError: outside bounded prefix'},{'exitCode':1,'termination':'exit','stdout':'','stderr':'  File "<stdin>", line 10001, in <module>\n'+('  File "<string>", line 3, in <module>\n'*12)}]
        with tempfile.TemporaryDirectory(prefix='winter-utility-diagnostic-helper-') as temp:
            script=Path(temp)/'helper.ts';script.write_text(helper+'\nconsole.log(JSON.stringify('+json.dumps(cases)+'.map((result,index)=>processFailureObservation(result,index===0?0:1))));\n')
            result=subprocess.run([bun,'run',str(script)],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stderr,'');records=json.loads(result.stdout)
        first=v.stdout_observation(json.dumps(records[0]).encode())
        self.assertEqual(first['classification'],'utility_process_failure');self.assertEqual(first['process']['exitCode'],1)
        self.assertEqual(first['process']['stdoutMarkers'],['tool-device-stdin-fds-ok'])
        self.assertEqual(first['process']['stderrClass'],'ModuleNotFoundError');self.assertEqual(first['process']['stderrCategory'],'module_missing')
        self.assertEqual(first['process']['traceback'],[{'source':'stdin','line':47},{'source':'string','line':7}])
        self.assertEqual(records[1]['process']['stderrCategory'],'shared_library_load');self.assertEqual(records[2]['process']['stderrCategory'],'unknown')
        self.assertEqual(records[3]['process']['traceback'],[{'source':'string','line':3}]*8)
        for value in ('PRIVATE_BODY','private_module','private-token','private-library','/secret','PRIVATE_VALUE'):
            self.assertNotIn(value,result.stdout);self.assertNotIn(value,json.dumps(first))
        for update in ({'stderrClass':{}},{'stdoutMarkers':['PRIVATE_MARKER']},{'exitCode':False},{'termination':'PRIVATE_TERMINATION'},{'traceback':[{'source':'/private/path','line':4}]},{'traceback':[{'source':'stdin','line':True}]},{'traceback':[{'source':'stdin','line':10001}]},{'traceback':[{'source':'string','line':3}]*9}):
            malformed=copy.deepcopy(records[0]);malformed['process'].update(update)
            self.assertEqual(v.stdout_observation(json.dumps(malformed).encode())['classification'],'invalid_failure_observation')
        malformed={**records[0],'authority':'PRIVATE_AUTHORITY'}
        self.assertEqual(v.stdout_observation(json.dumps(malformed).encode())['classification'],'invalid_failure_observation')

    def test_failure_only_emit_keeps_success_predicate_and_cleanup_evidence_requirements(self):
        source=(HERE/'client.ts').read_text()
        predicate='const valid = result.exitCode === 0 && result.termination === "exit" && result.stdout === marker && result.stderr === "";'
        self.assertIn(predicate,source)
        emit=source.index('if (!valid) console.log(JSON.stringify(processFailureObservation(result, invocation)));')
        self.assertLess(source.index(predicate),emit);self.assertLess(emit,source.index('check(valid, "exact utility smoke result required")'))
        parent=(HERE/'verify.py').read_text();unwind=parent[parent.index('    finally:',parent.index('def execute(')):]
        self.assertIn('observations.update(serviceReaped=True,serviceExitCode=server.returncode)',unwind)
        self.assertNotIn('serviceCleanupConfirmed=server.returncode==0',parent)
        record=v.failure_record(ValueError(),{'phase':'client-ordinary','serviceReaped':True,'serviceExitCode':0})
        self.assertTrue(record['serviceReaped']);self.assertFalse(record['serviceCleanupConfirmed']);self.assertFalse(record['nativeCleanupConfirmed'])

    def test_failed_main_persists_observations_after_existing_unwind_and_never_succeeds(self):
        class ExpectedFailure(Exception):pass
        failure=ExpectedFailure('raw /private/path authority=private-body');written=[];printed=[]
        parent=SimpleNamespace(verify_staged=lambda *args:None,canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')),write_file=lambda path,data,mode:written.append((path,json.loads(data),mode)))
        capture=SimpleNamespace(validate_capture=lambda *args,**kwargs:None);modules={'stage':parent,'closure':capture,'oracle':object()}
        admission=SimpleNamespace(directory='/sealed-private-path',receipt_sha='private-authority',parent_sha='private-authority',receipt={'utilityCapture':{}})
        def fail(directory,parent,oracle,observations):
            observations.update(phase='client-ordinary',clients=[v.client_observation('ordinary',1,b'',b'Error: exact utility smoke result required /private/path')],serviceReaped=True,serviceExitCode=0,serviceCleanupConfirmed=True,nativeCleanupConfirmed=False)
            raise failure
        with patch.object(v,'ADMISSION',admission),patch.object(v,'checked_module',lambda name:modules[name]),patch.object(v.tempfile,'mkdtemp',lambda **kwargs:'/tmp/winter-utility-run-private'),patch.object(v,'execute',fail),patch('builtins.print',lambda value,**kwargs:printed.append(value)):
            with self.assertRaises(ExpectedFailure) as result:v.main()
        self.assertIs(result.exception,failure)
        self.assertEqual(len(written),1);self.assertEqual(written[0][0].name,'failure.json');self.assertEqual(written[0][2],0o600)
        record=written[0][1];self.assertEqual(record['clients'][0]['exitCode'],1);self.assertEqual(record['phase'],'client-ordinary')
        self.assertFalse(record['nativeCleanupConfirmed']);self.assertTrue(record['fixtureRetained'])
        self.assertFalse(any('"passed":true' in value for value in printed))
        for value in ('/private/path','private-authority','private-body','/sealed-private-path'):
            self.assertNotIn(value,json.dumps(record));self.assertFalse(any(value in text for text in printed))

    def test_client_failure_snapshot_precedes_unchanged_oracle_and_deadlines(self):
        source=(HERE/'verify.py').read_text()
        capture=source.index("observations['clients'].append(client_observation(scenario,child.returncode,out,err))")
        self.assertLess(capture,source.index("if child.returncode!=0 or err or len(out)>65536"))
        self.assertLess(capture,source.index('client_oracle(record,oracle',capture))
        self.assertIn('child.communicate(timeout=75)',source);self.assertIn('child.wait(timeout=2)',source)
        self.assertIn('server.communicate(timeout=5)',source);self.assertIn('server.wait(timeout=5)',source)
        self.assertIn("quiescent(control,'conversation-utility');quiescent(control,'conversation-plan')",source)
        self.assertIn("observations.update(serviceCleanupConfirmed=True,nativeCleanupConfirmed=True,phase='outer-mount-observation')",source)


if __name__=='__main__':unittest.main()

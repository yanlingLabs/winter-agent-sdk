"""Injected supervisor lifecycle; no privileged syscall or subprocess executes."""
import importlib.util,json,os,socket,struct,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import MagicMock,patch
MODULE=Path(__file__).resolve().parents[2]/'packages/runtime/src/guest/linux-supervisor.py'
spec=importlib.util.spec_from_file_location('diagnostic_service',MODULE);service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
class RuntimeDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);(self.root/'logical').mkdir()
        self.obj=service.ToolService.__new__(service.ToolService);self.obj.directory=self.root;self.obj.lock=threading.RLock();self.obj.debt=set();self.obj.active={};self.obj.retained_children=[];self.obj.stop_event=threading.Event()
        self.obj.runtime_artifacts={name:fd for name,fd in [('launcher',10),('executable',11),('ownerLibrary',12)]};self.obj.runtime_pins={name:'synthetic-pin' for name in self.obj.runtime_artifacts};self.obj.environment=-1
        self.item={'logicalSessionId':'logical','runtimeUid':20001,'workspaceGid':10000,'policy':'auto','roots':{},'revoked':False};self.runtime={'fds':{'storeDirectory':-1,'runhomeDirectory':-2},'cancel':threading.Event(),'timeout':5,'state':'starting','cleanupConfirmed':False}
        self.obj.conversations={'logical':self.item};self.obj.runtimes={'logical':self.runtime}
    def tearDown(self):self.temp.cleanup()
    def diagnostic(self):return json.loads((self.root/'logical'/'runtime-diagnostic.json').read_text())
    def test_failure_before_native_or_sdk_store_creation_is_durable(self):
        with patch.object(service,'verify_held_artifact',side_effect=service.Refusal('artifact_changed')),patch.object(service.subprocess,'Popen') as popen:
            self.obj._run_runtime(self.item,self.runtime);popen.assert_not_called()
        record=self.diagnostic();observed=record['observations']
        self.assertEqual(record['failure'],{'class':'Refusal','code':'artifact_changed'});self.assertEqual(observed['phase'],'artifact-admission');self.assertFalse(observed['nativeReceiptObserved']);self.assertFalse(observed['parentReaped']);self.assertFalse(observed['ownershipReleased'])
        self.assertEqual(self.runtime['state'],'retained');self.assertIn('logical',self.obj.debt);self.assertFalse(self.runtime['cleanupConfirmed'])
        self.assertEqual((self.root/'logical'/'runtime-diagnostic.json').stat().st_mode&0o777,0o600)
    def run_injected(self,terminal=0,parent_code=0):
        control,parent,bootstrap,guest=[MagicMock() for _ in range(4)]
        for fd,channel in enumerate((control,parent,bootstrap,guest),100):channel.fileno.return_value=fd
        control.recv.side_effect=[b'R'+struct.pack('=I',terminal),b''];bootstrap.sendmsg.side_effect=lambda buffers,*args:len(buffers[0])
        child=MagicMock();child.stdout.fileno.return_value=200;child.stderr.fileno.return_value=201;child.wait.return_value=parent_code
        selector=MagicMock();selector.get_map.side_effect=[True,True,False];selector.select.side_effect=[[(MagicMock(fileobj=control),1),(MagicMock(fileobj=child.stdout),1),(MagicMock(fileobj=child.stderr),1)],[(MagicMock(fileobj=control),1),(MagicMock(fileobj=child.stdout),1),(MagicMock(fileobj=child.stderr),1)]]
        chunks={200:iter([b'private /path runtime-output',b'']),201:iter([b'DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET',b''])}
        close=os.close
        with patch.object(service,'verify_held_artifact'),patch.object(service.os,'listdir',return_value=[]),patch.object(service.socket,'socketpair',side_effect=[(control,parent),(bootstrap,guest)]),patch.object(service.subprocess,'Popen',return_value=child),patch.object(service,'receive_init_pidfd',return_value=600),patch.object(service.os,'pidfd_open',return_value=700,create=True),patch.object(self.obj,'_runtime_record',return_value={'scope':{}}),patch.object(service.selectors,'DefaultSelector',return_value=selector),patch.object(service.os,'set_blocking'),patch.object(service.os,'read',side_effect=lambda fd,count:next(chunks[fd],b'')),patch.object(service.os,'close',side_effect=lambda fd:None if fd in (600,700) else close(fd)),patch.object(service.signal,'pidfd_send_signal',create=True):
            self.obj._run_runtime(self.item,self.runtime)
        return child
    def test_native_receipt_parent_reap_and_drain_observations_persist(self):
        self.run_injected();record=self.diagnostic();observed=record['observations']
        self.assertIsNone(record['failure']);self.assertTrue(observed['nativeReceiptObserved']);self.assertEqual(observed['nativeWaitStatus'],0);self.assertTrue(observed['parentReaped']);self.assertEqual(observed['parentExitCode'],0);self.assertTrue(observed['toolDrainConfirmed']);self.assertTrue(observed['nativeCleanupConfirmed']);self.assertFalse(observed['ownershipReleased']);self.assertEqual(self.runtime['state'],'stopped')
        self.assertEqual(record['stdout']['capturedBytes'],len(b'private /path runtime-output'));self.assertNotIn('/path',json.dumps(record));self.assertNotIn('DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET',json.dumps(record));self.assertEqual(list(self.root.glob('runtime-view-*')),[])
    def test_receipt_reap_mismatch_keeps_native_observation_and_debt(self):
        self.run_injected(parent_code=7);record=self.diagnostic();observed=record['observations']
        self.assertEqual(record['failure']['code'],'runtime_parent_reap_unconfirmed');self.assertTrue(observed['nativeReceiptObserved']);self.assertTrue(observed['parentReaped']);self.assertFalse(observed['nativeCleanupConfirmed']);self.assertFalse(observed['toolDrainConfirmed']);self.assertIn('logical',self.obj.debt);self.assertEqual(self.runtime['state'],'retained');self.assertEqual(len(list(self.root.glob('runtime-view-*'))),1)
    def test_tool_debt_retains_observed_drain_without_cleanup_claim(self):
        self.obj.debt.add('logical');self.run_injected();record=self.diagnostic();observed=record['observations']
        self.assertEqual(record['failure']['code'],'runtime_tool_debt');self.assertTrue(observed['toolDrainConfirmed']);self.assertTrue(observed['toolDebtObserved']);self.assertFalse(observed['nativeCleanupConfirmed']);self.assertFalse(observed['ownershipReleased'])
    def test_terminal_status_waits_for_diagnostic_and_diagnostic_failure_retains(self):
        original=service.write_diagnostic
        def check(path,record):
            self.assertEqual(self.runtime['state'],'cleaning');self.assertFalse(self.runtime['cleanupConfirmed']);original(path,record)
        with patch.object(service,'write_diagnostic',side_effect=check):self.run_injected()
        self.assertEqual(self.runtime['state'],'stopped');self.assertTrue(self.runtime['cleanupConfirmed'])
        self.runtime.update(state='starting',cleanupConfirmed=False)
        with patch.object(service,'write_diagnostic',side_effect=OSError(13,'private /path')):self.run_injected()
        self.assertEqual(self.runtime['state'],'retained');self.assertFalse(self.runtime['cleanupConfirmed']);self.assertTrue(self.runtime['diagnosticFailed']);self.assertIn('logical',self.obj.debt)
    def test_normalized_stderr_keeps_error_and_redacts_private_paths_identities(self):
        text=service.normalized_stderr(('SDK startup failed /private/fixture/path token=synthetic-sensitive-value '+ 'a'*64+' DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET').encode(),('/private/fixture',))
        self.assertIn('SDK startup failed',text);self.assertNotIn('/private',text);self.assertNotIn('synthetic-sensitive-value',text);self.assertNotIn('a'*64,text);self.assertNotIn('DISPOSABLE-HOST-CREDENTIAL',text)
        self.assertLessEqual(len(service.normalized_stderr(('error '*10000).encode()).encode()),4096)
if __name__=='__main__':unittest.main()

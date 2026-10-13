"""Fresh-runtime config and kernel file ownership checks. Unprivileged; no Linux launch."""
import array,importlib.util,json,os,socket,struct,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import patch
MODULE=Path(__file__).resolve().parents[2]/'packages/runtime/src/guest/linux-supervisor.py'
spec=importlib.util.spec_from_file_location('fresh_service',MODULE);service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
class FreshProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.store=self.root/'store';self.home=self.root/'home'
        for directory in (self.store,self.home):directory.mkdir(mode=0o700)
        self.obj=service.ToolService.__new__(service.ToolService);self.obj.runtime_artifacts={'fixture':-1};self.obj.owned=[];self.obj.runtimes={};self.obj.guest_boot='00000000-0000-0000-0000-000000000000';self.obj.debt=set();self.obj.stop_event=threading.Event();self.obj.lock=threading.RLock();self.obj.threads=[];self.obj.listeners=[];self.obj.active={}
        self.authority={'workspaceId':'workspace','sessionId':'backend','incarnationId':'incarnation','leaseEpoch':1,'configRevision':1,'grantRevision':1,'policyRevision':1}
        self.item={'logicalSessionId':'logical','runtimeUid':os.getuid(),'toolUid':10001,'workspaceGid':10000,'authority':self.authority,'revoked':False,'roots':{'source':{'root':{'id':'source','guestPath':'/workspace/folders/source','readOnly':False}}}}
        self.obj.conversations={'logical':self.item}
        self.provider={'scope':{'homeId':'home','workspaceId':'workspace','sessionId':'logical','backendSessionId':'backend','taskId':'task','incarnationId':'incarnation','bootId':self.obj.guest_boot,'leaseEpoch':1,'grantRevision':1,'accountRevision':1,'modelRevision':1},'selection':{'providerId':'openai','modelKey':'openai/fixture','providerModelId':'fixture','family':'openai','protocol':'openai-responses','capabilities':{'toolCalling':'native'}}}
        self.config={'storeDirectory':str(self.store),'runhomeDirectory':str(self.home),'provider':self.provider,'model':'openai/fixture'}
    def tearDown(self):
        for fd in self.obj.owned:os.close(fd)
        self.temp.cleanup()
    def test_configured_record_uses_backend_and_logical_paths_separately(self):
        self.obj._configure_runtime(self.item,self.config);runtime=self.obj.runtimes['logical'];record=self.obj._runtime_record(self.item,runtime)
        self.assertEqual(record['scope']['sessionId'],'backend');self.assertEqual(record['scope']['storeHome'],'/workspace/.winter/conversations/logical')
        self.assertEqual(record['toolSocketPath'],'/run/winter/conversations/logical/.control/tools.sock')
        self.assertEqual(record['runtimeConfig']['tools'],['Read','Write','Edit','Bash']);self.assertEqual(record['runtimeConfig']['settingSources'],[]);self.assertEqual(record['runtimeConfig']['mcpServers'],{})
        self.assertNotIn('resume',record['runtimeConfig']);self.assertEqual(record['runtimeConfig']['winterHome'],'/run/winter/conversations/logical')
        self.provider['scope']['grantRevision']=999;self.assertEqual(runtime['provider']['scope']['grantRevision'],1)
    def test_fresh_store_and_home_refuse_any_previous_file(self):
        for directory in (self.store,self.home):
            marker=directory/'old';marker.write_text('prior ownership is not recovery evidence')
            with self.assertRaisesRegex(service.Refusal,'runtime_fresh_store_required'):self.obj._configure_runtime(self.item,self.config)
            marker.unlink()
            for fd in self.obj.owned:os.close(fd)
            self.obj.owned=[]
    def test_real_directory_flock_excludes_separate_owner(self):
        self.obj._configure_runtime(self.item,self.config)
        with self.assertRaisesRegex(service.Refusal,'runtime_store_in_use'):self.obj._configure_runtime(self.item,self.config)
    def test_alias_and_directory_permission_refusal(self):
        alias=self.root/'alias';alias.symlink_to(self.store,target_is_directory=True)
        with self.assertRaisesRegex(service.Refusal,'source_alias'):self.obj._configure_runtime(self.item,{**self.config,'storeDirectory':str(alias)})
        self.store.chmod(0o750)
        with self.assertRaisesRegex(service.Refusal,'runtime_directory_identity'):self.obj._configure_runtime(self.item,self.config)
    def test_provider_private_material_and_scope_mismatch_refused_before_open(self):
        for key in ('authRef','url','headers','token','secret','credential'):
            self.provider['selection'][key]='synthetic-private-marker'
            with self.assertRaisesRegex(service.Refusal,'runtime_provider_private'):self.obj._configure_runtime(self.item,self.config)
            self.provider['selection'].pop(key)
        self.provider['scope']['backendSessionId']='other'
        with self.assertRaisesRegex(service.Refusal,'runtime_provider_scope'):self.obj._configure_runtime(self.item,self.config)
        self.assertEqual(self.obj.owned,[])
    def test_launch_is_single_use_and_revocation_cancels_owned_runtime(self):
        self.obj._configure_runtime(self.item,self.config)
        with patch.object(self.obj,'_run_runtime') as run:
            self.obj.launch_runtime('logical');self.obj.threads[0].join(1);run.assert_called_once()
            with self.assertRaisesRegex(service.Refusal,'runtime_fresh_only'):self.obj.launch_runtime('logical')
        self.obj.revoke('logical');self.assertTrue(self.obj.runtimes['logical']['cancel'].is_set())
    def test_debt_does_not_close_store_lock_or_report_cleanup(self):
        self.obj._configure_runtime(self.item,self.config);fd=self.obj.runtimes['logical']['fds']['storeDirectory'];self.obj.debt.add('logical')
        self.assertFalse(self.obj.close());self.assertTrue(os.fstat(fd));self.assertFalse(self.obj.runtimes['logical']['cleanupConfirmed'])
    def test_admin_handoff_preserves_actual_descriptor_and_fixed_owner_scope(self):
        # A pipe stands in for pidfd ONLY for portable SCM_RIGHTS framing; native
        # Linux receiver independently checks pidfd type/liveness before admission.
        self.obj._configure_runtime(self.item,self.config);runtime=self.obj.runtimes['logical'];record=self.obj._runtime_record(self.item,runtime);readfd,writefd=os.pipe();left,right=socket.socketpair();received=[]
        try:
            runtime.update(state='running',initPidfd=readfd,scope=record['scope']);service.frame_write(left,{'operation':'runtime-owner','sessionId':'logical'});self.obj._admin(right)
            data,ancillary,_,_=left.recvmsg(65536,socket.CMSG_SPACE(16));received=list(array.array('i',ancillary[0][2]));self.assertEqual(len(received),1);self.assertEqual(os.fstat(received[0]).st_ino,os.fstat(readfd).st_ino)
            length=struct.unpack('!I',data[:4])[0];response=json.loads(data[4:]);self.assertEqual(length,len(data)-4);self.assertEqual(response,{'logicalSessionId':'logical','runtimeUid':os.getuid(),'scope':record['scope'],'ownerToken':runtime['ownerToken']})
        finally:
            for fd in received:os.close(fd)
            os.close(readfd);os.close(writefd);left.close();right.close()
    def test_admin_handoff_refuses_nonrunning_uncertain_and_dead_owner(self):
        self.obj._configure_runtime(self.item,self.config);runtime=self.obj.runtimes['logical'];record=self.obj._runtime_record(self.item,runtime);readfd,writefd=os.pipe()
        def request():
            left,right=socket.socketpair()
            try:
                service.frame_write(left,{'operation':'runtime-owner','sessionId':'logical'})
                with self.assertRaisesRegex(service.Refusal,'runtime_owner_unavailable'):self.obj._admin(right)
            finally:left.close();right.close()
        try:
            runtime.update(initPidfd=readfd,scope=record['scope'])
            for state in ('configured','retained','stopped'):runtime['state']=state;request()
            runtime['state']='running';self.obj.debt.add('logical');request();self.obj.debt.clear()
            runtime['cancel'].set();request();runtime['cancel'].clear();os.close(writefd);writefd=None;request()
        finally:
            os.close(readfd)
            if writefd is not None:os.close(writefd)
    def test_missing_runtime_artifacts_cannot_admit_store(self):
        self.obj.runtime_artifacts={}
        with self.assertRaisesRegex(service.Refusal,'runtime_config'):self.obj._configure_runtime(self.item,self.config)
        self.assertEqual(self.obj.owned,[])
if __name__=='__main__':unittest.main()

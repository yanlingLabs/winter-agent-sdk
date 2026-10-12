"""No process launch: uncertain fixture unwinding retains its exact disposable files."""
import hashlib,importlib.util,io,json,os,socket,tempfile,unittest
from unittest.mock import MagicMock
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
MODULE=Path(__file__).with_name('verify.py');spec=importlib.util.spec_from_file_location('retention_verify',MODULE);verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)
class RetentionTests(unittest.TestCase):
    def setUp(self):
        # Existing fixture flow is injected; the kernel mount oracle has its own
        # portable reader/parser tests and must never read host /proc here.
        patched=patch.object(verify,'MountIsolationOracle');self.mount_oracle=patched.start()
        self.addCleanup(patched.stop)
    def test_mount_oracle_baseline_refusal_precedes_every_fixture_process_effect(self):
        self.mount_oracle.return_value.before.side_effect=verify.MountIsolationError('outer_mounts_changed')
        with patch.object(verify.subprocess,'Popen') as spawn,patch.object(verify,'snapshot_runtime_diagnostic'),patch.object(verify,'snapshot_bash_transcript'):
            with self.assertRaisesRegex(verify.MountIsolationError,'outer_mounts_changed'):verify.execute_fixture(Path('/unused'),{}, {'artifacts':{}},{})
        spawn.assert_not_called()
    def test_handoff_mount_refusal_closes_received_right_before_provider_admission(self):
        # Ordinary pipe is installed as a fake received right. No real pidfd or
        # kernel namespace is inspected; the injected oracle must reject it.
        read,write=os.pipe();channel=MagicMock();channel.__enter__.return_value=channel;admission=MagicMock()
        expected={'workspaceId':'workspace','incarnationId':'incarnation','leaseEpoch':1,'bootId':'fixture-boot'}
        scope={key:expected[key] for key in ('workspaceId','incarnationId','leaseEpoch')};scope.update(sessionId=verify.BACKEND,currentBootId=expected['bootId'],storeHome=f'/workspace/.winter/conversations/{verify.LOGICAL}')
        record={'logicalSessionId':verify.LOGICAL,'runtimeUid':verify.RUNTIME_UID,'scope':scope,'ownerToken':'a'*64}
        data=json.dumps(record).encode();wire=verify.struct.pack('!I',len(data))+data
        channel.recvmsg.return_value=(wire,[(socket.SOL_SOCKET,socket.SCM_RIGHTS,verify.array.array('i',[read]).tobytes())],0,None)
        oracle=MagicMock();oracle.during.side_effect=verify.MountIsolationError('runtime_propagation')
        try:
            with patch.object(verify.socket,'socket',return_value=channel),patch.object(verify.socket,'MSG_CMSG_CLOEXEC',0x40000000,create=True):
                with self.assertRaisesRegex(verify.MountIsolationError,'runtime_propagation'):verify.admit_provider({'control':Path('/unused'),'provider':{'scope':expected}},admission,[],{},oracle)
            admission.sendmsg.assert_not_called();oracle.during.assert_called_once()
            with self.assertRaises(OSError):os.fstat(read)
        finally:
            try:os.close(read)
            except OSError:pass
            os.close(write)
    def test_after_teardown_mount_change_preserves_fixture_instead_of_cleanup_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'winter-fresh-engine-fixture';directory.mkdir();config=directory/'bootstrap.json';config.write_text('{}')
            fixture={'config':config,'binary':directory,'control':directory};observations={}
            server=MagicMock();server.stdin=io.BytesIO();server.stdout=io.BytesIO();server.stderr=io.BytesIO();server.returncode=0;server.poll.return_value=0
            provider=MagicMock();provider.stdin=None;provider.stdout=io.BytesIO(b'{"passed":true,"turns":5,"peerValidated":true}');provider.stderr=io.BytesIO();provider.returncode=0;provider.poll.return_value=0
            status={'active':0,'uncertain':False,'runtime':{'state':'stopped','exitCode':0,'cleanupConfirmed':True}}
            oracle=self.mount_oracle.return_value
            def after(observed):
                provider.wait.assert_called_with(timeout=5);server.wait.assert_called_with(timeout=5)
                self.assertTrue(observed['nativeCleanupConfirmed']);self.assertTrue(observed['serviceReaped'])
                raise verify.MountIsolationError('outer_mounts_changed')
            oracle.after.side_effect=after
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(directory)),patch.object(verify.sys,'stderr',io.StringIO()),patch.object(verify.subprocess,'Popen',return_value=server),patch.object(verify,'start_provider',return_value=(provider,MagicMock())),patch.object(verify,'admit_provider'),patch.object(verify,'exchange',return_value={'started':True}),patch.object(verify,'wait_for',side_effect=[True,status]),patch.object(verify,'persisted_evidence',return_value={}),patch.object(verify,'snapshot_runtime_diagnostic'),patch.object(verify.shutil,'rmtree') as remove:
                with self.assertRaisesRegex(verify.MountIsolationError,'outer_mounts_changed'):
                    with verify.retained_fixture_directory(observations):verify.execute_fixture(directory,fixture,{'artifacts':{},'compileReceiptSha256':'a'*64},observations)
                remove.assert_not_called()
            oracle.before.assert_called_once();oracle.after.assert_called_once()
            record=json.loads((directory/'fixture-diagnostic.json').read_text())
            self.assertEqual(record['failure'],{'class':'MountIsolationError','code':'outer_mounts_changed'});self.assertFalse(record['ownershipReleased'])
            self.assertEqual(observations['providerReceipt'],{'passed':True,'turns':5,'peerValidated':True});self.assertTrue(directory.exists())
    def bash_records(self,content='Blocked by classifier',**flags):
        return [{'sessionId':verify.BACKEND,'type':'assistant','uuid':'known-assistant','message':{'content':[{'type':'tool_use','id':'call-3','name':'Bash','input':verify.EXPECTED_CALLS[3][1]}]}},
                {'sessionId':verify.BACKEND,'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'call-3','content':content,**flags}]}}]
    def transcript_fixture(self,directory,records):
        store=directory/'store';store.mkdir(mode=0o700);projects=store/'projects';projects.mkdir(mode=0o700);project=projects/'-workspace-folders-source';project.mkdir(mode=0o700)
        path=project/(verify.BACKEND+'.jsonl');path.write_text(''.join(json.dumps(record)+'\n' for record in records));path.chmod(0o600)
        return {'store':store},path
    def test_bash_classification_keeps_only_bound_call_and_allowlisted_outcomes(self):
        self.assertEqual(verify.bash_transcript_observation([]),{'class':'never-requested','requested':False,'resultObserved':False})
        self.assertEqual(verify.bash_transcript_observation(self.bash_records()[:1])['class'],'requested-no-result')
        observed=verify.bash_transcript_observation(self.bash_records(denied=True))
        self.assertEqual(observed['class'],'permission-denied');self.assertEqual(observed['errorCode'],'classifier-blocked')
        for code,expected in [(0,'exit-zero'),(1,'nonzero-exit')]:
            text=f'private /secret/path\n[stderr]\ncredential=hidden\n[Exit code: {code}; cwd changes apply to this command only]'
            observed=verify.bash_transcript_observation(self.bash_records(text,is_error=bool(code)))
            self.assertEqual(observed['class'],expected);self.assertEqual(observed['exitCode'],code);self.assertTrue(observed['stderrObserved'])
            for forbidden in ('/secret','credential','hidden','known-assistant'):self.assertNotIn(forbidden,json.dumps(observed))
        self.assertEqual(verify.bash_transcript_observation(self.bash_records('Error [cwd_denied]: guest process refused',is_error=True))['errorCode'],'cwd_denied')
        self.assertEqual(verify.bash_transcript_observation(self.bash_records('Error [secret_custom]: guest process refused',is_error=True))['errorCode'],'other')
    def test_bash_classification_refuses_wrong_call_or_result_binding(self):
        for mutate in ('input','id','session','duplicate','before'):
            records=json.loads(json.dumps(self.bash_records()))
            if mutate=='input':records[0]['message']['content'][0]['input']['command']='other command'
            elif mutate=='id':records[0]['message']['content'][0]['id']='other'
            elif mutate=='session':records[1]['sessionId']='other'
            elif mutate=='duplicate':records.append(records[1])
            else:records.reverse()
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):verify.bash_transcript_observation(records)
    def test_bash_snapshot_is_descriptor_safe_and_does_not_release_ownership(self):
        with tempfile.TemporaryDirectory() as temporary,patch.object(verify,'RUNTIME_UID',os.getuid()):
            fixture,path=self.transcript_fixture(Path(temporary),self.bash_records(denied=True));observed={'ownershipReleased':False}
            verify.snapshot_bash_transcript(fixture,observed)
            self.assertTrue(observed['bashTranscriptAvailable']);self.assertEqual(observed['bashTranscript']['errorCode'],'classifier-blocked');self.assertFalse(observed['ownershipReleased'])
            original=path.read_bytes()
            for kind in ('symlink','fifo','mode','hardlink','oversize','duplicate-json'):
                with self.subTest(kind=kind):
                    path.unlink()
                    if kind=='symlink':target=Path(temporary)/'outside';target.write_bytes(original);path.symlink_to(target)
                    elif kind=='fifo':os.mkfifo(path,0o600)
                    else:
                        path.write_bytes(b'{"sessionId":"one","sessionId":"two"}\n' if kind=='duplicate-json' else original);path.chmod(0o644 if kind=='mode' else 0o600)
                    if kind=='hardlink':os.link(path,Path(temporary)/'alias')
                    if kind=='oversize':
                        with path.open('wb') as stream:stream.truncate(8*1024*1024+1)
                    opened=[];real_open=os.open
                    def track(name,*args,**kwargs):
                        fd=real_open(name,*args,**kwargs);opened.append(fd);return fd
                    observed={}
                    with patch.object(verify.os,'open',side_effect=track):verify.snapshot_bash_transcript(fixture,observed)
                    self.assertFalse(observed['bashTranscriptAvailable']);self.assertNotIn('bashTranscript',observed);self.assertIn('bashTranscriptReadFailure',observed)
                    for fd in opened:
                        with self.assertRaises(OSError):os.fstat(fd)
    def test_bash_snapshot_missing_or_oversized_record_is_explicit(self):
        with tempfile.TemporaryDirectory() as temporary,patch.object(verify,'RUNTIME_UID',os.getuid()):
            fixture,path=self.transcript_fixture(Path(temporary),[]);path.unlink();observed={};verify.snapshot_bash_transcript(fixture,observed)
            self.assertEqual(observed,{'bashTranscriptAvailable':False})
            path.write_text('x'*(256*1024+1));path.chmod(0o600)
            with patch.object(verify.json,'loads',side_effect=AssertionError('parsing reached')):
                observed={};verify.snapshot_bash_transcript(fixture,observed)
            self.assertIn('bashTranscriptReadFailure',observed)
    def test_file_oracle_failure_retains_completed_provider_receipt_before_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary);config=directory/'config';config.write_text('{}');fixture={'config':config,'binary':directory,'control':directory}
            server=MagicMock();server.stdin=io.BytesIO();server.stdout=io.BytesIO();server.stderr=io.BytesIO();server.returncode=0;server.poll.return_value=0
            provider=MagicMock();provider.stdin=None;provider.stdout=io.BytesIO(b'{"passed":true,"turns":5,"peerValidated":true}');provider.stderr=io.BytesIO();provider.returncode=0;provider.poll.return_value=0
            status={'active':0,'uncertain':False,'runtime':{'state':'stopped','exitCode':0,'cleanupConfirmed':True}};observed={}
            def oracle(value):
                self.assertEqual(observed['providerReceipt'],{'passed':True,'turns':5,'peerValidated':True});provider.terminate.assert_called_once();provider.wait.assert_called_with(timeout=5)
                raise FileNotFoundError('no Bash file')
            with patch.object(verify.subprocess,'Popen',return_value=server),patch.object(verify,'start_provider',return_value=(provider,MagicMock())),patch.object(verify,'admit_provider'),patch.object(verify,'exchange',return_value={'started':True}),patch.object(verify,'wait_for',side_effect=[True,status]),patch.object(verify,'snapshot_bash_transcript'),patch.object(verify,'snapshot_runtime_diagnostic'),patch.object(verify,'persisted_evidence',side_effect=oracle):
                with self.assertRaises(FileNotFoundError):verify.execute_fixture(directory,fixture,{'artifacts':{}},observed)
            self.assertEqual(observed['phase'],'persisted-evidence');self.assertTrue(observed['providerReaped']);self.assertNotIn('ownershipReleased',observed)
    def test_uncertain_unwind_retains_files_and_reports_only_normalized_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'winter-fresh-engine-fixture';directory.mkdir();(directory/'store').write_text('must retain')
            errors=io.StringIO()
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(directory)),patch.object(verify.sys,'stderr',errors):
                with self.assertRaisesRegex(RuntimeError,'uncertain'):
                    with verify.retained_fixture_directory() as root:
                        self.assertEqual(root,directory);raise RuntimeError('uncertain')
            self.assertEqual((directory/'store').read_text(),'must retain')
            records=[json.loads(line) for line in errors.getvalue().splitlines()]
            self.assertEqual(records[0]['kind'],'fixture-failure-diagnostic');self.assertEqual(records[0]['failure'],{'class':'RuntimeError'});self.assertFalse(records[0]['ownershipReleased'])
            self.assertLessEqual(len(errors.getvalue().splitlines()[0].encode()),32768)
            self.assertEqual(records[1],{'fixtureRetained':True,'retentionId':directory.name,'nativeCleanupConfirmed':False,'ownershipReleased':False})
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
    def runtime_record(self,cleanup=False):
        stderr=b'Native initialization failed [fixture-path]'
        return {'version':1,'kind':'fixture-runtime-diagnostic','failure':{'class':'Uncertain','code':'runtime_native_owner_closed'},
                'observations':{'phase':'native-startup','nativeReceiptObserved':False,'nativeExitCode':None,'parentReaped':False,'parentExitCode':None,'toolDrainConfirmed':False,'nativeCleanupConfirmed':cleanup,'ownershipReleased':False},
                'stdout':{'capturedBytes':0,'captureLimit':1024*1024,'truncated':False,'sha256':hashlib.sha256(b'').hexdigest()},
                'stderr':{'capturedBytes':len(stderr),'captureLimit':16384,'truncated':False,'sha256':hashlib.sha256(stderr).hexdigest(),'normalizedText':stderr.decode(),'textLimit':4096}}
    def diagnostic_fixture(self,directory,record=None):
        control=directory/'control';control.mkdir(mode=0o700);private=control/verify.LOGICAL;private.mkdir(mode=0o700)
        path=private/'runtime-diagnostic.json'
        if record is not None:path.write_text(json.dumps(record));path.chmod(0o600)
        return {'control':control},path
    def test_failure_snapshot_is_printed_bounded_without_promoting_runtime_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp)/'winter-fresh-engine-fixture';directory.mkdir();fixture,path=self.diagnostic_fixture(directory,self.runtime_record(cleanup=True));observations={'phase':'native-admission','nativeCleanupConfirmed':False};errors=io.StringIO()
            with patch.object(verify.tempfile,'mkdtemp',return_value=str(directory)),patch.object(verify.sys,'stderr',errors):
                with self.assertRaisesRegex(AssertionError,'terminal before owner'):
                    with verify.retained_fixture_directory(observations):
                        verify.snapshot_runtime_diagnostic(fixture,observations);raise AssertionError('terminal before owner')
            lines=[json.loads(line) for line in errors.getvalue().splitlines()];self.assertEqual(lines[0]['observations']['runtimeDiagnostic'],self.runtime_record(cleanup=True));self.assertFalse(lines[0]['observations']['nativeCleanupConfirmed']);self.assertFalse(lines[0]['ownershipReleased']);self.assertFalse(lines[1]['nativeCleanupConfirmed'])
            self.assertLessEqual(len(errors.getvalue().splitlines()[0].encode()),32768);self.assertNotIn(temp,errors.getvalue());self.assertTrue(path.exists())
    def test_missing_runtime_diagnostic_is_explicit_without_claim_or_error(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture,path=self.diagnostic_fixture(Path(temp));observations={'nativeCleanupConfirmed':False};verify.snapshot_runtime_diagnostic(fixture,observations)
            self.assertFalse(observations['runtimeDiagnosticAvailable']);self.assertNotIn('runtimeDiagnostic',observations);self.assertFalse(observations['nativeCleanupConfirmed'])
    def test_runtime_snapshot_refuses_symlink_fifo_and_wrong_mode_with_owned_fd_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp);fixture,path=self.diagnostic_fixture(directory,self.runtime_record());original=path.read_bytes()
            for kind in ('symlink','fifo','mode','hardlink'):
                with self.subTest(kind=kind):
                    path.unlink()
                    if kind=='symlink':target=directory/'outside';target.write_bytes(original);path.symlink_to(target)
                    elif kind=='fifo':os.mkfifo(path,0o600)
                    else:path.write_bytes(original);path.chmod(0o644 if kind=='mode' else 0o600)
                    if kind=='hardlink':os.link(path,directory/'alias')
                    opened=[];real_open=os.open
                    def track(name,*args,**kwargs):
                        fd=real_open(name,*args,**kwargs);opened.append(fd);return fd
                    observed={}
                    with patch.object(verify.os,'open',side_effect=track):verify.snapshot_runtime_diagnostic(fixture,observed)
                    self.assertNotIn('runtimeDiagnostic',observed);self.assertIn('runtimeDiagnosticReadFailure',observed)
                    for fd in opened:
                        with self.assertRaises(OSError):os.fstat(fd)
    def test_runtime_snapshot_wrong_owner_or_oversize_refuses_before_json_parsing(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture,path=self.diagnostic_fixture(Path(temp),self.runtime_record());observed={}
            real_stat=os.fstat;inode=path.stat().st_ino
            def stat(fd):
                value=real_stat(fd)
                if value.st_ino==inode:return SimpleNamespace(st_mode=value.st_mode,st_uid=value.st_uid+1,st_nlink=value.st_nlink,st_size=value.st_size)
                return value
            with patch.object(verify.os,'fstat',side_effect=stat),patch.object(verify.json,'loads') as parse:verify.snapshot_runtime_diagnostic(fixture,observed);parse.assert_not_called()
            self.assertNotIn('runtimeDiagnostic',observed);self.assertIn('runtimeDiagnosticReadFailure',observed)
            path.write_bytes(b'x'*16385);observed={}
            with patch.object(verify.json,'loads') as parse:verify.snapshot_runtime_diagnostic(fixture,observed);parse.assert_not_called()
            self.assertNotIn('runtimeDiagnostic',observed)
    def test_runtime_snapshot_rejects_malformed_or_duplicate_records(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture,path=self.diagnostic_fixture(Path(temp),self.runtime_record())
            for wire in ('{}','{"version":1,"version":1}',json.dumps({**self.runtime_record(),'stderr':{'normalizedText':'secret /path'}})):
                path.write_text(wire);observed={};verify.snapshot_runtime_diagnostic(fixture,observed);self.assertNotIn('runtimeDiagnostic',observed);self.assertIn('runtimeDiagnosticReadFailure',observed)
    def test_terminal_owner_status_fails_promptly_without_handoff_or_cleanup_claim(self):
        fixture={'control':Path('/unused-fixture-control')};channel=MagicMock();channel.__enter__.return_value=channel;channel.recvmsg.return_value=(b'',[],0,None);admission=MagicMock();observations={'nativeCleanupConfirmed':False}
        status={'active':0,'uncertain':True,'runtime':{'state':'retained','exitCode':None,'cleanupConfirmed':False},'unsafe':'secret /private/path'}
        def wait(check,seconds,children):self.assertEqual(seconds,2);return check()
        with patch.object(verify.socket,'MSG_CMSG_CLOEXEC',0x40000000,create=True),patch.object(verify.socket,'socket',return_value=channel),patch.object(verify,'wait_for',side_effect=wait),patch.object(verify,'exchange',return_value=status) as exchange,patch.object(verify,'snapshot_runtime_diagnostic') as snapshot:
            with self.assertRaisesRegex(AssertionError,'terminal before owner'):verify.admit_provider(fixture,admission,[],observations,self.mount_oracle.return_value)
        self.assertEqual(observations['ownerAdmissionFailure'],'terminal-runtime-before-owner');self.assertEqual(observations['nativeStatus'],{'state':'retained','exitCode':None,'cleanupConfirmed':False,'active':0,'uncertain':True});self.assertFalse(observations['nativeCleanupConfirmed']);admission.sendmsg.assert_not_called();snapshot.assert_called_once_with(fixture,observations);self.assertLessEqual(exchange.call_args.kwargs['seconds'],.25);self.assertNotIn('secret',json.dumps(observations))
    def test_execute_failure_snapshots_runtime_diagnostic_before_and_after_existing_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp);fixture,path=self.diagnostic_fixture(directory,self.runtime_record());config=directory/'bootstrap.json';config.write_text('{}');fixture.update(config=config,binary=directory)
            server=MagicMock();server.stdin=io.BytesIO();server.stdout=io.BytesIO();server.stderr=io.BytesIO();server.returncode=1;server.poll.return_value=1
            provider=MagicMock();provider.stdin=None;provider.stdout=io.BytesIO(b'{"passed":false,"turns":0,"peerValidated":false}');provider.stderr=io.BytesIO();provider.returncode=1;provider.poll.return_value=1
            observations={'nativeCleanupConfirmed':False}
            with patch.object(verify.subprocess,'Popen',return_value=server),patch.object(verify,'start_provider',return_value=(provider,MagicMock())),patch.object(verify,'wait_for',return_value=True),patch.object(verify,'exchange',return_value={'started':True}),patch.object(verify,'admit_provider',side_effect=AssertionError('owner admission failed')),patch.object(verify,'snapshot_runtime_diagnostic',wraps=verify.snapshot_runtime_diagnostic) as snapshot:
                with self.assertRaisesRegex(AssertionError,'owner admission failed'):verify.execute_fixture(directory,fixture,{'artifacts':{}},observations)
            self.assertEqual(snapshot.call_count,2);self.assertEqual(observations['runtimeDiagnostic'],self.runtime_record());self.assertFalse(observations['nativeCleanupConfirmed']);self.assertTrue(path.exists());self.assertTrue(observations['serviceReaped']);self.assertTrue(observations['providerReaped'])

    def test_nonterminal_owner_status_keeps_original_wait_and_has_no_handoff_effect(self):
        fixture={'control':Path('/unused-fixture-control')};channel=MagicMock();channel.__enter__.return_value=channel;channel.recvmsg.return_value=(b'',[],0,None);admission=MagicMock();observations={}
        def wait(check,seconds,children):self.assertEqual(seconds,2);self.assertFalse(check());raise AssertionError('bounded fixture wait failed')
        with patch.object(verify.socket,'MSG_CMSG_CLOEXEC',0x40000000,create=True),patch.object(verify.socket,'socket',return_value=channel),patch.object(verify,'wait_for',side_effect=wait),patch.object(verify,'exchange',return_value={'runtime':{'state':'starting'}}):
            with self.assertRaisesRegex(AssertionError,'bounded fixture wait'):verify.admit_provider(fixture,admission,[],observations,self.mount_oracle.return_value)
        self.assertNotIn('nativeStatus',observations);admission.sendmsg.assert_not_called()
if __name__=='__main__':unittest.main()

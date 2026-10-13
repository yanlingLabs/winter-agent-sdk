"""Portable source schemas only. No Root/service/process/native/artifact execution."""
import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent

def load(name):
 spec=importlib.util.spec_from_file_location('host_fixture_'+name,HERE/(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
stage=load('stage');verify=load('verify')
class SourceTests(unittest.TestCase):
 def test_three_entries_and_actual_paths_are_closed(self):
  self.assertEqual(stage.ENTRIES,{'runtimeEntry':'runtime.ts','providerWorker':'provider.ts','hostClient':'host-client.ts'})
  self.assertEqual(stage.PARENT,'scripts/guest-host-query/stage.py')
  self.assertIn("('source','scripts','guest-host-query')",stage.BOOTSTRAP)
  self.assertEqual(stage.MAX_ARTIFACT_BYTES,384*1024*1024)
  self.assertGreater(stage.MAX_ARTIFACT_BYTES,91801560*3)
  self.assertIn('scripts/guest-engine/verify.py',stage.REQUIRED_SOURCES)
 def test_shared_helpers_are_exact_source_definitions_and_do_not_have_invented_close(self):
  helper=verify.stable_helpers();self.assertEqual(set(verify.HELPERS)-set(helper),set())
  self.assertFalse(hasattr(helper['MountIsolationOracle'],'close'))
  self.assertEqual(helper['parse_mountinfo'](b'1 2 0:1 / / rw - tmpfs tmpfs rw\n')[1]['point'],'/')
 def test_effects_require_exact_sentinel_and_allowed_bytes(self):
  with tempfile.TemporaryDirectory() as tmp:
   source=Path(tmp);(source/'dac-control').write_bytes(b'DAC-writable\n');(source/'store-probe').symlink_to('root-store');(source/'credential-probe').symlink_to('root-credential');(source/'seed').write_bytes(b'hello\n');verify.effect_oracle('plan',source)
   (source/'approved-write').write_bytes(b'approved\n');verify.effect_oracle('bypass',source)
   with self.assertRaises(AssertionError):verify.effect_oracle('ask-deny',source)
   (source/'seed').write_bytes(b'changed')
   with self.assertRaises(AssertionError):verify.effect_oracle('bypass',source)
 def test_dac_identity_requires_actual_tool_primary_and_supplementary_groups(self):
  verify.require_dac_identity(10001,10001,[10000])
  for identity in ((0,10001,[10000]),(10001,10000,[10000]),(10001,10001,[]),(10001,10001,[10000,0])):
   with self.assertRaises(AssertionError):verify.require_dac_identity(*identity)
 def test_dac_control_parent_observes_owned_child_and_exact_bytes_without_running_it(self):
  with tempfile.TemporaryDirectory() as tmp:
   source=Path(tmp);(source/'dac-control').write_bytes(b'DAC-writable\n')
   with patch.object(verify.os,'fork',return_value=123),patch.object(verify.os,'waitpid',return_value=(123,0)) as wait:
    verify.dac_writable_control(source);wait.assert_called_once_with(123,0)
   with patch.object(verify.os,'fork',return_value=123),patch.object(verify.os,'waitpid',return_value=(123,256)):
    with self.assertRaises(AssertionError):verify.dac_writable_control(source)
 def test_readable_canary_control_and_private_store_bounds_are_separate(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);root.chmod(0o711);canary=root/'protected-canary-store';canary.mkdir(mode=0o755)
   file=canary/'canary';file.write_bytes(b'readable store canary\n');file.chmod(0o444)
   secret=root/'host-only-credential';secret.write_bytes(b'fixture marker');secret.chmod(0o444)
   store=root/'store';store.mkdir(mode=0o700)
   self.assertEqual(file.stat().st_mode&0o777,0o444);self.assertEqual(secret.stat().st_mode&0o777,0o444)
   self.assertEqual(canary.stat().st_mode&0o777,0o755);self.assertEqual(root.stat().st_mode&0o777,0o711)
   self.assertEqual(store.stat().st_mode&0o777,0o700);self.assertEqual(list(store.iterdir()),[])
   source=(HERE/'verify.py').read_text();self.assertIn("str(root/'home'),str(canary_store)",source)
   self.assertIn("symlink_to(canary_store/'canary')",source)
 def test_fifo_and_symlink_inputs_refuse_without_waiting(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp).resolve();os.mkfifo(root/'fifo');(root/'file').write_bytes(b'x');(root/'alias').symlink_to('file')
   directory=stage.open_root(root)
   try:
    for name in ('fifo','alias'):
     with self.assertRaises((ValueError,OSError)):stage.measure(directory,name,1024)
   finally:os.close(directory)
 def test_last_duplicated_pipe_writer_closure_delivers_real_eof(self):
  read,write=os.pipe();duplicate=os.dup(write)
  try:
   os.close(write);write=None;os.set_blocking(read,False)
   with self.assertRaises(BlockingIOError):os.read(read,1)
   os.close(duplicate);duplicate=None
   self.assertEqual(os.read(read,1),b'')
  finally:
   for fd in (read,write,duplicate):
    if fd is not None:os.close(fd)
 def test_provider_metadata_and_runtime_scope_use_same_canonical_order(self):
  scope={'workspaceId':'workspace','sessionId':'logical','homeId':'home','leaseEpoch':1}
  metadata=json.dumps({'provider':{'scope':scope}},sort_keys=True,separators=(',',':'))
  observed=json.dumps(json.loads(metadata)['provider']['scope'],separators=(',',':'))
  self.assertEqual(observed,json.dumps(scope,sort_keys=True,separators=(',',':')))
  self.assertIn("'probePaths':probe_paths,'runtimeUid':RUNTIME_UID,'provider':route},sort_keys=True,separators=(',',':')",(HERE/'verify.py').read_text())
 def test_no_privileged_import_before_admission_and_phase_a_is_separate_from_utilities(self):
  text=(HERE/'verify.py').read_text();self.assertLess(text.index('require_staged_imports()\n'),text.index("build=load("))
  shell=(HERE/'cases.ts').read_text();self.assertIn('done < /proc/self/mountinfo',shell);self.assertIn('test -c \"$phase_device\"',shell);self.assertNotIn('python3',shell);self.assertNotIn('cgroup',shell)
  client=(HERE/'host-client.ts').read_text();self.assertIn('const lifecycle = await process.exited',client);self.assertIn('writePipe(cancelFd, "K")',client);self.assertNotIn('Promise.resolve({ code: 0',client)

class TranscriptTests(unittest.TestCase):
 def setUp(self):
  import hashlib
  self.temp=tempfile.TemporaryDirectory();self.store=Path(self.temp.name);self.kind='ask-allow';self.identity=verify.backend(self.kind)
  self.script=[{'name':'Read','input':{'file_path':'seed'}},{'name':'Write','input':{'file_path':'approved-write','content':'approved\n'}},{'name':'Bash','input':{'command':'fixed immutable command','timeout':5000}},{'name':'Bash','input':{'command':'fixed proc write command','timeout':5000}}]
  self.host={'scriptSha256':hashlib.sha256(json.dumps(self.script,separators=(',',':')).encode()).hexdigest()}
  self.records=[];self.states=[]
  for index,call in enumerate(self.script):
   anchor='assistant-'+str(index)
   self.records.extend([{'sessionId':self.identity,'type':'assistant','uuid':anchor,'message':{'content':[{'type':'tool_use','id':'call-'+str(index),**call}]}},{'sessionId':self.identity,'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'call-'+str(index),'is_error':False,'content':'hello\n' if index==0 else 'host-query-view-counts:2:5:3:10:1:1:1:5\nhost-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]' if index==2 else 'host-query-proc-device-ok\n[stderr]\n/bin/bash: line 5: printf: write error: No space left on device\n/bin/bash: line 8: /proc/self/comm: Read-only file system\n\n[Exit code: 0; cwd changes apply to this command only]' if index==3 else 'fixture'}]}}])
   self.states.append(self.native(index,anchor))
  self.records.append({'sessionId':self.identity,'type':'assistant','uuid':'assistant-4','message':{'content':[{'type':'text','text':'host-query-ask-allow-complete'}]}});self.states.append(self.native(4,'assistant-4'))
 def native(self,index,anchor):
  return {'type':'winter_provider_state','sessionId':self.identity,'anchorUuid':anchor,'provider':'openai','model':'openai/gpt-5.6','family':'openai','continuationDomain':'openai/gpt-5.6','itemIndex':1,'kind':'native-state','payload':{'items':[{'type':'reasoning','id':'reasoning-'+str(index),'encrypted_content':'fixture-native-state'}]},'uuid':'native-'+str(index),'timestamp':'fixture-time'}
 def tearDown(self):self.temp.cleanup()
 def validate(self):
  for name,rows in [(self.identity+'.jsonl',self.records),(self.identity+'.provider-state.jsonl',self.states)]:
   (self.store/name).write_text(''.join(json.dumps(row)+'\n' for row in rows))
  return verify.transcript_oracle(self.kind,self.store,self.host)
 def test_actual_schema_golden_accepts(self):self.assertEqual(self.validate()['nativeStateAnchors'],5)
 def test_wrong_anchor_items_schema_order_or_tool_input_refuse(self):
  import copy
  original_records=copy.deepcopy(self.records);original_states=copy.deepcopy(self.states)
  for change in ('anchor','items','schema','order','input','result'):
   self.records=copy.deepcopy(original_records);self.states=copy.deepcopy(original_states)
   if change=='anchor':self.states[0]['anchorUuid']='other'
   elif change=='items':self.states[0]['payload']['items']=[]
   elif change=='schema':self.states[0].pop('timestamp')
   elif change=='order':self.states.reverse()
   elif change=='input':self.records[0]['message']['content'][0]['input']={'file_path':'other'}
   else:self.records[1]['message']['content'][0]['content']='different bytes'
   with self.assertRaises(AssertionError):self.validate()

if __name__=='__main__':unittest.main()

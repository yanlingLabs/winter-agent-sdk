"""Evidence validator checks only: fixture files are synthetic, not a successful SDK execution."""
import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
MODULE=Path(__file__).with_name('verify.py');spec=importlib.util.spec_from_file_location('fresh_verify',MODULE);verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)
class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.source=self.root/'source';self.source.mkdir();self.store=self.root/'store';self.store.mkdir(mode=0o700);self.uid=patch.object(verify,'RUNTIME_UID',os.getuid());self.uid.start()
        for name,data in [('seed','edited\n'),('written','written\n'),('from-shell','shell')]:(self.source/name).write_text(data)
        self.fixture={'source':self.source,'store':self.store};self.records=[]
        for number,name in enumerate(['Read','Edit','Write','Bash']):
            self.records.extend([{'sessionId':verify.BACKEND,'type':'assistant','uuid':f'assistant-{number}','message':{'content':[{'type':'tool_use','id':f'call-{number}','name':name,'input':json.loads(json.dumps(verify.EXPECTED_CALLS[number][1]))}]}},{'sessionId':verify.BACKEND,'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':f'call-{number}','content':json.dumps(verify.EXPECTED_RESULTS[number]) if isinstance(verify.EXPECTED_RESULTS[number],dict) else verify.EXPECTED_RESULTS[number]}]}}])
        self.records.append({'sessionId':verify.BACKEND,'type':'assistant','uuid':'assistant-final','message':{'content':[{'type':'text','text':'fresh-engine-complete'}]}})
        self.states=[{'type':'winter_provider_state','uuid':f'state-{number}','timestamp':'2026-10-12T00:00:00.000Z','sessionId':verify.BACKEND,'kind':'native-state','anchorUuid':anchor,'provider':'openai','model':'openai/gpt-5.6','family':'openai','continuationDomain':'openai/gpt-5.6','itemIndex':1,'payload':{'items':[{'type':'reasoning','id':f'reasoning-{number}','encrypted_content':'fixture-native-state'}]}} for number,anchor in enumerate([*[f'assistant-{n}' for n in range(4)],'assistant-final'])];self.transcript=self.store/(verify.BACKEND+'.jsonl');self.state=self.store/(verify.BACKEND+'.provider-state.jsonl');self.write()
    def write(self):
        for path,records in [(self.transcript,self.records),(self.state,self.states)]:path.write_text(''.join(json.dumps(record)+'\n' for record in records));path.chmod(0o600)
    def tearDown(self):self.uid.stop();self.temp.cleanup()
    def test_complete_tool_results_and_bound_native_state_required(self):self.assertEqual(verify.persisted_evidence(self.fixture)['transcriptRecords'],9)
    def test_text_name_markers_do_not_replace_actual_successful_tool_history(self):
        self.records=[{'sessionId':verify.BACKEND,'type':'assistant','message':{'content':[{'type':'text','text':'fresh-engine-complete Read Edit Write Bash'}]}}];self.write()
        with self.assertRaisesRegex(AssertionError,'tool history'):verify.persisted_evidence(self.fixture)
    def test_tool_error_does_not_count_as_completed_success(self):
        self.records[1]['message']['content'][0]['is_error']=True;self.write()
        with self.assertRaisesRegex(AssertionError,'tool history'):verify.persisted_evidence(self.fixture)
    def test_native_state_cross_session_and_missing_anchor_refuse(self):
        for key,value in [('sessionId','other'),('anchorUuid','missing-assistant')]:
            original=self.states[0][key];self.states[0][key]=value;self.write()
            with self.assertRaisesRegex(AssertionError,'state binding'):verify.persisted_evidence(self.fixture)
            self.states[0][key]=original
    def test_host_fixture_credential_in_transcript_refuses(self):
        self.records[-1]['message']['content'].append({'type':'text','text':'DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET'});self.write()
        with self.assertRaisesRegex(AssertionError,'credential leaked'):verify.persisted_evidence(self.fixture)
    def test_group_readable_store_refuses_even_with_valid_transcript(self):
        self.state.chmod(0o640)
        with self.assertRaisesRegex(AssertionError,'owner/mode'):verify.persisted_evidence(self.fixture)
    def test_corrupted_read_result_refuses(self):
        self.records[1]['message']['content'][0]['content']='wrong read result; seed bytes were never returned';self.write()
        with self.assertRaisesRegex(AssertionError,'exact result bytes'):verify.persisted_evidence(self.fixture)
    def test_native_marker_false_positive_refuses(self):
        self.states[0]['payload']={'not_native_state':'fixture-native-state'};self.write()
        with self.assertRaisesRegex(AssertionError,'state binding'):verify.persisted_evidence(self.fixture)
    def test_exact_tool_inputs_results_and_order_required(self):
        self.records[0]['message']['content'][0]['input']['file_path']='wrong';self.write()
        with self.assertRaisesRegex(AssertionError,'call/input'):verify.persisted_evidence(self.fixture)
    def test_each_native_item_requires_exact_identity_and_producing_anchor(self):
        for key,value in [('provider','wrong'),('model','wrong'),('family','wrong'),('itemIndex',0),('anchorUuid','assistant-final')]:
            original=self.states[0][key];self.states[0][key]=value;self.write()
            with self.assertRaisesRegex(AssertionError,'state binding'):verify.persisted_evidence(self.fixture)
            self.states[0][key]=original
        self.states[0]['payload']['items'][0]['id']='reasoning-4';self.write()
        with self.assertRaisesRegex(AssertionError,'state binding'):verify.persisted_evidence(self.fixture)
    def test_every_exact_result_and_call_order_is_required(self):
        for number in range(4):
            block=self.records[number*2+1]['message']['content'][0];original=block['content'];block['content']='incorrect';self.write()
            with self.assertRaisesRegex(AssertionError,'exact result bytes'):verify.persisted_evidence(self.fixture)
            block['content']=original
        self.records[1],self.records[3]=self.records[3],self.records[1];self.write()
        with self.assertRaisesRegex(AssertionError,'result order/binding'):verify.persisted_evidence(self.fixture)
    def test_native_records_need_complete_typed_envelope(self):
        for key in ('type','provider','model','family','continuationDomain','itemIndex','uuid','timestamp'):
            original=self.states[0].pop(key);self.write()
            with self.assertRaisesRegex(AssertionError,'state binding'):verify.persisted_evidence(self.fixture)
            self.states[0][key]=original
    def test_oversized_evidence_refuses_before_json_parsing(self):
        with self.transcript.open('wb') as stream:stream.truncate(8*1024*1024+1)
        with patch.object(verify.json,'loads',side_effect=AssertionError('parsing reached')):
            with self.assertRaisesRegex(AssertionError,'evidence bound'):verify.persisted_evidence(self.fixture)
    def test_native_envelope_duplicate_identity_empty_identity_or_boolean_index_refuses(self):
        for key,value in [('uuid',''),('uuid',self.states[1]['uuid']),('itemIndex',True),('timestamp','')]:
            original=self.states[0][key];self.states[0][key]=value;self.write()
            with self.assertRaisesRegex(AssertionError,'state binding'):verify.persisted_evidence(self.fixture)
            self.states[0][key]=original
if __name__=='__main__':unittest.main()

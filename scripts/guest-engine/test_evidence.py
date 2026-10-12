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
            self.records.extend([{'sessionId':verify.BACKEND,'type':'assistant','uuid':f'assistant-{number}','message':{'content':[{'type':'tool_use','id':f'call-{number}','name':name}]}},{'sessionId':verify.BACKEND,'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':f'call-{number}','content':'fixture successful result'}]}}])
        self.records.append({'sessionId':verify.BACKEND,'type':'assistant','uuid':'assistant-final','message':{'content':[{'type':'text','text':'fresh-engine-complete'}]}})
        self.states=[{'type':'winter_provider_state','sessionId':verify.BACKEND,'kind':'native-state','anchorUuid':'assistant-final','payload':{'items':[{'encrypted_content':'fixture-native-state'}]}}];self.transcript=self.store/(verify.BACKEND+'.jsonl');self.state=self.store/(verify.BACKEND+'.provider-state.jsonl');self.write()
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
    def test_group_readable_store_refuses_even_with_valid_transcript(self):
        self.state.chmod(0o640)
        with self.assertRaisesRegex(AssertionError,'owner/mode'):verify.persisted_evidence(self.fixture)
if __name__=='__main__':unittest.main()

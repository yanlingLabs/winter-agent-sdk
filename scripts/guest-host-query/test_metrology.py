"""Injected clocks/base delegation only; no ToolService/native/process launch."""
import hashlib,importlib.util,unittest
from pathlib import Path
from unittest.mock import Mock
spec=importlib.util.spec_from_file_location('utility_metrology',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class TimingTests(unittest.TestCase):
 def test_delegate_result_identity_ceil_rounding_and_sha_without_changing_arguments(self):
  token=object();calls=[];measurements={'records':[],'overflow':False}
  class Base:
   def _run(self,*args):calls.append(args);return token
  args=(object(),'process','5000',object(),'.',65536,'-',b'fixed command',8,object(),object())
  service=v.timing_tool_service(Base,measurements,Mock(side_effect=[0,1000001]))()
  self.assertIs(service._run(*args),token);self.assertEqual(calls,[args]);self.assertEqual(measurements['records'],[{'commandSha256':hashlib.sha256(b'fixed command').hexdigest(),'elapsedTotalUpperBoundMs':2,'delegatedOutcome':'returned'}])
 def test_actual_delegated_exception_preserved_even_clock_fails_and_record_is_bounded(self):
  failure=RuntimeError('synthetic native uncertainty');measurements={'records':[],'overflow':False}
  class Base:
   def _run(self,*args):raise failure
  service=v.timing_tool_service(Base,measurements,Mock(side_effect=[0,OSError('clock unavailable')]))()
  with self.assertRaises(RuntimeError) as got:service._run(None,'process','5000',None,'.',1,'-',b'fixed',8,None,None)
  self.assertIs(got.exception,failure);self.assertEqual(measurements['records'][0]['delegatedOutcome'],'raised');self.assertIsNone(measurements['records'][0]['elapsedTotalUpperBoundMs'])
 def test_second_command_binding_unknown_margin_and_ask_deny_no_execution(self):
  digest=hashlib.sha256(b'fixed').hexdigest();other=hashlib.sha256(b'other').hexdigest()
  for elapsed,margin in ((1,True),(2499,True),(2500,None),(5000,None),(None,None)):
   records={'records':[{'commandSha256':other,'elapsedTotalUpperBoundMs':1,'delegatedOutcome':'returned'},{'commandSha256':digest,'elapsedTotalUpperBoundMs':elapsed,'delegatedOutcome':'returned'}],'overflow':False}
   self.assertIs(v.utility_timing_oracle('plan',digest,records)['conservativeTwofoldMargin'],margin)
   with self.assertRaises(AssertionError):v.utility_timing_oracle('ask-deny',digest,records)
   records['records'][1]['commandSha256']=other
   with self.assertRaises(AssertionError):v.utility_timing_oracle('bypass',digest,records)
  result=v.utility_timing_oracle('ask-deny',digest,{'records':[],'overflow':False});self.assertFalse(result['executed']);self.assertIsNone(result['elapsedTotalUpperBoundMs'])

 def test_unavailable_start_clock_does_not_prevent_delegation_or_invent_margin(self):
  token=object();measurements={'records':[],'overflow':False}
  class Base:
   def _run(self,*args):return token
  service=v.timing_tool_service(Base,measurements,Mock(side_effect=[OSError('clock unavailable'),1]))()
  self.assertIs(service._run(None,'process','5000',None,'.',1,'-',b'fixed',8,None,None),token)
  self.assertIsNone(measurements['records'][0]['elapsedTotalUpperBoundMs'])

 def test_failure_snapshot_preserves_before_after_distinction_and_bounds(self):
  measurements={'records':[],'overflow':False};before=v.timing_snapshot(measurements)
  measurements['records'].append({'commandSha256':'a'*64,'elapsedTotalUpperBoundMs':2,'delegatedOutcome':'raised'})
  after=v.timing_snapshot(measurements);measurements['records'][0]['elapsedTotalUpperBoundMs']=3
  self.assertEqual(before['records'],[]);self.assertEqual(after['records'][0]['elapsedTotalUpperBoundMs'],2)
  class Base:
   def _run(self,*args):return (0,b'')
  service=v.timing_tool_service(Base,measurements,lambda:1)()
  for _ in range(17):service._run(None,'process','5000',None,'.',1,'-',b'fixed',8,None,None)
  self.assertEqual(len(measurements['records']),16);self.assertTrue(measurements['overflow'])

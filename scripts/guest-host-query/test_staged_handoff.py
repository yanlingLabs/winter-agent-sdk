"""Actual sibling stage/validator chain with injected Root metadata, never native launch."""
import contextlib,copy,importlib.util,io,os,sys,tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from test_stage import StageTests,s
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('staged_handoff_verify',HERE/'verify.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class HandoffTests(StageTests):
 def stage_fixture(self):
  original=tempfile.mkdtemp
  def private_tree(**_ignored):
   directory=Path(original(prefix='inert-stage-',dir=self.root));self.staged_roots.append(directory);return str(directory)
  # Creation/copy is actual stage(); only its privileged ownership/ancestry final
  # check is deferred to the complete fd-bound handoff with injected metadata below.
  with self.capture() as captured,patch.object(s.os,'geteuid',return_value=0),patch.object(s,'trusted_staging_ancestry'),patch.object(s.tempfile,'mkdtemp',side_effect=private_tree),patch.object(s,'verify_staged'):
   return s.stage(captured)
 @contextlib.contextmanager
 def admitted(self,directory):
  root=s.open_root(directory);held=os.fstat(root)
  admission=SimpleNamespace(directory=str(directory),directory_fd=root,identity=(held.st_dev,held.st_ino),receipt_sha=self.approved,parent_sha=self.receipt['sources'][s.PARENT],pid=os.getpid())
  original_fstat=os.fstat;original_stat=os.stat;original_lstat=os.lstat
  def projected(info):
   fields={key:getattr(info,key) for key in dir(info) if key.startswith('st_')};fields['st_uid']=0;return SimpleNamespace(**fields)
  try:
   with patch.object(s.sys,'_winter_host_query_stage_admission',admission,create=True),patch.object(s.sys,'platform','linux'),patch.object(s.sys,'flags',SimpleNamespace(**{**{name:getattr(sys.flags,name) for name in dir(sys.flags) if not name.startswith('_')},'isolated':1,'no_site':1})),patch.object(s.sys,'dont_write_bytecode',True),patch.object(s.os,'geteuid',return_value=0),patch.object(s.os,'fstat',side_effect=lambda fd:projected(original_fstat(fd))),patch.object(s.os,'stat',side_effect=lambda *a,**kw:projected(original_stat(*a,**kw))),patch.object(s.os,'lstat',side_effect=lambda *a,**kw:projected(original_lstat(*a,**kw))),patch.object(s,'trusted_staging_ancestry'),patch.object(v.build,'ROOT',directory/'source'),patch.object(v.build,'load_parent',return_value=s):
    yield admission
  finally:os.close(root)
 def invoke_main(self,directory):
  with patch.object(v.sys,'argv',['verify.py','--artifacts',str(directory/'artifacts'),'--reviewed-receipt',str(directory/'artifacts/receipt.json')]),patch.object(v,'stable_helpers',side_effect=RuntimeError('stop before service/native')) as next_phase,patch.object(v,'run_case') as native,patch.object(s,'capture',side_effect=AssertionError('checkout recapture forbidden')):
   with self.assertRaisesRegex(RuntimeError,'stop before service/native'):v.main()
   next_phase.assert_called_once();native.assert_not_called()
 def test_actual_stage_siblings_and_verify_main_fd_bound_validation_pass_before_native(self):
  directory=self.stage_fixture();self.assertEqual({p.name for p in directory.iterdir()},{'source','artifacts','environment'})
  # The former artifact-relative recapture is deterministically wrong in this shape.
  with self.assertRaises(FileNotFoundError):s.capture(directory/'source',directory/'artifacts',directory/'artifacts/receipt.json',self.approved,environment=directory/'artifacts/environment')
  with self.admitted(directory):
   self.invoke_main(directory)
   native,fd=s.open_admitted_environment()
   try:self.assertEqual(native,self.receipt);self.assertEqual((os.fstat(fd).st_dev,os.fstat(fd).st_ino),((directory/'environment').stat().st_dev,(directory/'environment').stat().st_ino))
   finally:os.close(fd)
 def test_missing_sibling_wrong_identity_and_artifact_environment_decoy_refuse_before_native(self):
  for change in ('missing','identity','decoy'):
   directory=self.stage_fixture()
   with self.admitted(directory) as admission:
    if change=='identity':admission.identity=(admission.identity[0],admission.identity[1]+1)
    elif change=='missing':directory.chmod(0o700);(directory/'environment').rename(directory/'removed-environment');directory.chmod(0o500)
    else:
     (directory/'artifacts').chmod(0o700);(directory/'artifacts/environment').mkdir();(directory/'artifacts/environment/foreign').write_bytes(b'bad');(directory/'artifacts').chmod(0o500)
    with patch.object(v.sys,'argv',['verify.py','--artifacts',str(directory/'artifacts'),'--reviewed-receipt',str(directory/'artifacts/receipt.json')]),patch.object(v,'stable_helpers') as next_phase,patch.object(v,'run_case') as native:
     with self.assertRaises((ValueError,OSError)):v.main()
     next_phase.assert_not_called();native.assert_not_called()
 def test_closed_cli_paths_and_absent_admission_refuse_without_checkout_recapture(self):
  directory=self.stage_fixture()
  with patch.object(v.build,'ROOT',directory/'source'),patch.object(s,'capture') as capture:
   with self.assertRaises(ValueError):v.build.validate_staged_receipt(directory/'artifacts',directory/'artifacts/receipt.json')
   capture.assert_not_called()
  with self.admitted(directory),patch.object(s,'capture') as capture:
   for artifacts,receipt in ((self.artifacts,directory/'artifacts/receipt.json'),(directory/'artifacts',self.receipt_path)):
    with self.assertRaises(ValueError):v.build.validate_staged_receipt(artifacts,receipt)
   capture.assert_not_called()

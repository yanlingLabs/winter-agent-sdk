"""Disposable files and injected ownership only; no Root/fork/prctl/native/tool body."""
import importlib.util,os,stat,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('utility_data_fixture_verifier',HERE/'verify.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class DataTests(unittest.TestCase):
 def test_each_capability_must_be_observed_zero(self):
  fields={name:'0000000000000000' for name in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')};v.require_zero_capabilities(fields)
  for name in fields:
   for value in (None,'1','foreign',0,'0'*17):
    with self.subTest(name=name,value=value),self.assertRaises(AssertionError):v.require_zero_capabilities({**fields,name:value})
 def test_independent_git_data_and_closed_readonly_leaf_inventory(self):
  inventory=v.readonly_data_inventory()
  self.assertNotIn('utilities.sh',inventory);self.assertEqual(inventory['dac-canary'],b'DAC-positive\n')
  self.assertEqual(v.DATA.git_fixture()[0],'a0efbdcdb3273daa7d3659f3e230c4c75e4dedbb')
 def test_exact_held_data_bytes_modes_inode_and_directory_inventory(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);expected=v.readonly_data_inventory()
   for name,wire in expected.items():
    target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(wire);target.chmod(0o660 if name=='dac-canary' else 0o444)
   for folder in root.rglob('*'):
    if folder.is_dir():folder.chmod(0o555)
   root.chmod(0o555);directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
   actual_fstat=os.fstat;actual_stat=os.stat;canary=(root/'dac-canary').stat().st_ino
   def project(info):
    return SimpleNamespace(st_mode=info.st_mode,st_uid=10001 if info.st_ino==canary else 0,st_gid=10000 if info.st_ino==canary else 0,st_ino=info.st_ino,st_dev=info.st_dev,st_nlink=info.st_nlink)
   try:
    with patch.object(v.os,'fstat',side_effect=lambda fd:project(actual_fstat(fd))),patch.object(v.os,'stat',side_effect=lambda *a,**kw:project(actual_stat(*a,**kw))):
     identity=v.canary_identity(project(actual_stat(root/'dac-canary')))
     initial=v.verify_readonly_data(directory,identity,expected)
     root.chmod(0o755);(root/'extra').mkdir();root.chmod(0o555)
     with self.assertRaises(AssertionError):v.verify_readonly_data(directory,identity,expected,initial)
     root.chmod(0o755);(root/'extra').rmdir();root.chmod(0o555)
     (root/'marker').chmod(0o644)
     with self.assertRaises(AssertionError):v.verify_readonly_data(directory,identity,expected,initial)
     (root/'marker').chmod(0o444)
     root.chmod(0o755);(root/'marker').rename(root/'old');(root/'marker').write_bytes(v.DATA.MARKER);(root/'marker').chmod(0o444);(root/'old').unlink();root.chmod(0o555)
     with self.assertRaises(AssertionError):v.verify_readonly_data(directory,identity,expected,initial)
   finally:
    os.close(directory);root.chmod(0o755)
    for folder in root.rglob('*'):
     if folder.is_dir():folder.chmod(0o755)

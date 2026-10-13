"""Ordinary held-copy/package data only, never dpkg/readelf/utility/native invocation."""
import importlib.util,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from test_environment import elf,metadata
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('held_utility_environment_tests',HERE/'utility-environment.py');u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
class WrapperTests(unittest.TestCase):
 def test_consumed_pinned_fd_copy_rewinds_and_preserves_caller_descriptor(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);source=root/'input';source.write_bytes(elf(soname='libdl.so.2'));fd=os.open(source,os.O_RDONLY)
   try:
    expected,_=u.c.measure(fd);self.assertEqual(os.lseek(fd,0,os.SEEK_CUR),source.stat().st_size)
    u.copy_held(fd,root/'copy',expected)
    self.assertEqual((root/'copy').read_bytes(),source.read_bytes());self.assertEqual((root/'copy').stat().st_mode&0o777,0o444);os.fstat(fd)
    with self.assertRaises(FileExistsError):u.copy_held(fd,root/'copy',expected)
    with self.assertRaises(ValueError):u.copy_held(fd,root/'wrong',{'sha256':'0'*64,'bytes':1})
   finally:os.close(fd)
 def test_same_package_version_full_bytes_and_supplement_elf_contract(self):
  base={};extra={};records={}
  for guest in u.PACKAGE_LEAVES:
   wire=elf(('libc.so.6',),Path(guest).name);item={'bytes':len(wire),'sha256':u.c.digest(wire)}
   (extra if guest in u.SUPPLEMENTS else base)[guest]=item
   records[guest]={'package':'libc6:arm64','version':'2.39-0','elf':metadata(wire),**item}
  u.validate_package(records,base,extra)
  import copy
  for change in ('version','package','bytes','hash','type','soname','needed','rpath','runpath'):
   bad=copy.deepcopy(records);record=bad[u.SUPPLEMENTS[0]]
   if change in ('version','package'):record[change]='foreign'
   elif change=='bytes':record['bytes']+=1
   elif change=='hash':record['sha256']='0'*64
   elif change=='type':record['elf']['type']=2
   elif change=='soname':record['elf']['soname']='foreign.so.1'
   elif change=='needed':record['elf']['needed']=['foreign.so.1']
   else:record['elf'][change]='/foreign'
   with self.subTest(change=change),self.assertRaises(ValueError):u.validate_package(bad,base,extra)
 def test_prepare_private_parent_precedes_unchanged_collector(self):
  # Stop before any collector work; no subprocess or utility is invoked.
  with tempfile.TemporaryDirectory() as tmp,patch.object(u.os,'geteuid',return_value=501),patch.object(u.sys,'platform','linux'):
   output=Path(tmp)/'fresh'
   def collector(base):
    self.assertTrue(base.parent.is_dir());self.assertEqual(base.parent.stat().st_mode&0o777,0o700);raise RuntimeError('stop before collection')
   with patch.object(u.u,'prepare',side_effect=collector),patch.object(u,'source_snapshot',return_value={}):
    with self.assertRaisesRegex(RuntimeError,'stop before'):u.prepare(output)

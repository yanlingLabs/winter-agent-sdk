"""Root parent rejects malformed environment data before effects; inert bytes only."""
import copy,os
from unittest.mock import patch
from test_stage import StageTests,digest,canonical
class EnvironmentAdmissionTests(StageTests):
    def test_environment_package_source_loader_dependency_and_mode_mutations_refuse(self):
        baseline=copy.deepcopy(self.receipt)
        for change in ('version','package','soname','search','extra-needed','builder','builder-bytes','base-origin','capture-source','extra-leaf','missing','intent','graph','legacy'):
            with self.subTest(change=change):
                self.receipt=copy.deepcopy(baseline)
                origin=self.receipt['utilityOrigin'];capture=self.receipt['utilityCapture'];pair='/lib/aarch64-linux-gnu/libpthread.so.0'
                if change=='version':origin['libcPackage'][pair]['version']='foreign'
                elif change=='package':origin['libcPackage'][pair]['package']='foreign'
                elif change=='soname':origin['libcPackage'][pair]['elf']['soname']='foreign.so.0'
                elif change=='search':origin['libcPackage'][pair]['elf']['runpath']='/foreign'
                elif change=='extra-needed':origin['libcPackage'][pair]['elf']['needed']=['foreign.so.1']
                elif change=='builder':capture['builder']['architecture']='x64'
                elif change=='builder-bytes':capture['builder']['sha256']='e'*64
                elif change=='base-origin':origin['baseOrigin']['manifestSha256']='f'*64
                elif change=='capture-source':capture['sources']['scripts/guest-utilities/closure.py']['sha256']='f'*64
                elif change=='extra-leaf':self.receipt['environment']['/bin/foreign']={'role':'executable','executable':True,'bytes':1,'sha256':'f'*64}
                elif change=='missing':del self.receipt['environment']['/bin/bash']
                elif change=='intent':self.receipt['environment'][pair]['executable']=True
                elif change=='graph':origin['phaseBGraph']['dynamicCompletenessVerified']=True
                else:self.receipt['formatVersion']=2
                for name,key,value in (('utility-receipt.json','utilityCaptureSha256',capture),('utility-origin-receipt.json','utilityOriginSha256',origin)):
                    wire=(canonical(value)+'\n').encode();(self.artifacts/name).write_bytes(wire);self.receipt[key]=digest(wire)
                self.reseal()
                with self.assertRaises(ValueError):self.capture()
    def test_held_environment_changes_or_missing_sdk_library_refuse(self):
        with self.capture() as snapshot:
            path=self.artifacts/'environment/bin/bash';path.write_bytes(b'changed')
            with self.assertRaises(ValueError):snapshot_parent=__import__('test_stage').s.check_snapshot(snapshot)
    def test_capture_closes_all_pinned_fds_on_environment_failure(self):
        (self.artifacts/'environment/unexpected').write_bytes(b'bad');opened=[]
        parent=__import__('test_stage').s;original=parent.open_root
        def record(path):
            fd=original(path);opened.append(fd);return fd
        with patch.object(parent,'open_root',record):
            with self.assertRaises(ValueError):self.capture()
        for fd in opened:
            with self.assertRaises(OSError):os.fstat(fd)
    def test_combined_budget_refuses_without_large_allocations(self):
        parent=__import__('test_stage').s
        with patch.object(parent,'MAX_COMBINED_BYTES',1):
            with self.assertRaisesRegex(ValueError,'combined'):self.capture()

    def test_rehashed_actual_elf_metadata_mutations_refuse_before_any_spawn(self):
        from test_environment import elf,metadata
        parent=__import__('test_stage').s
        baseline=copy.deepcopy(self.receipt);guest='/lib/aarch64-linux-gnu/libpthread.so.0';path=self.artifacts/'environment'/guest[1:];original=path.read_bytes()
        for wire in (elf(kind=2,soname='libpthread.so.0'),elf(machine=62,soname='libpthread.so.0'),elf(soname='wrong.so.0'),elf(soname='libpthread.so.0',rpath='/foreign'),elf(('missing.so.1',),soname='libpthread.so.0')):
            self.receipt=copy.deepcopy(baseline);path.write_bytes(wire);item={'bytes':len(wire),'sha256':digest(wire)}
            for record in (self.receipt['environment'][guest],self.receipt['utilityCapture']['outputs'][guest],self.receipt['utilityCapture']['inputs'][guest],self.receipt['utilityOrigin']['supplementalPair'][guest],self.receipt['utilityOrigin']['libcPackage'][guest]):record.update(item)
            try:self.receipt['utilityOrigin']['libcPackage'][guest]['elf']=metadata(wire)
            except ValueError:pass
            capture=self.receipt['utilityCapture'];capture['inputManifestSha256']=digest(canonical({'formatVersion':1,'kind':'winter-tool-utility-inputs','target':'linux-arm64-gnu','files':capture['inputs']}).encode());capture['outputInventorySha256']=digest(canonical(capture['outputs']).encode());self.receipt['utilityOrigin']['combinedManifestSha256']=capture['inputManifestSha256']
            for name,key,value in (('utility-receipt.json','utilityCaptureSha256',capture),('utility-origin-receipt.json','utilityOriginSha256',self.receipt['utilityOrigin'])):
                data=(canonical(value)+'\n').encode();(self.artifacts/name).write_bytes(data);self.receipt[key]=digest(data)
            self.reseal()
            with patch.object(parent.subprocess,'run') as run:
                with self.assertRaises(ValueError):self.capture()
                run.assert_not_called()
        path.write_bytes(original)

    def test_environment_fifo_symlink_and_hardlink_refuse_without_spawn(self):
        parent=__import__('test_stage').s;path=self.artifacts/'environment/bin/bash';wire=path.read_bytes();alias=self.artifacts/'alias'
        for kind in ('fifo','symlink','hardlink'):
            path.unlink();alias.write_bytes(wire)
            if kind=='fifo':os.mkfifo(path)
            elif kind=='symlink':path.symlink_to(alias)
            else:os.link(alias,path)
            with patch.object(parent.subprocess,'run') as run:
                with self.assertRaises((ValueError,OSError)):self.capture()
                run.assert_not_called()
            path.unlink();alias.unlink();path.write_bytes(wire)

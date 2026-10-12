"""Synthetic sealed bundle/oracle tests. No root, helper, ELF or namespace executes."""
import copy,hashlib,importlib.util,io,json,os,stat,subprocess,sys,tarfile,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location('utility_test_'+name,HERE/(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
s=load('stage');v=load('verify');o=load('oracle');f=load('test_fixture')


class UtilityStageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='winter-utility-stage-source-');self.root=Path(self.temp.name).resolve();origin=self.root/'origin';origin.mkdir();manifest=f.fixture(origin);capture=f.closure.capture(origin,manifest,self.root/'capture')
        source_names=['scripts/guest-utilities/'+name for name in ('stage.py','verify.py','closure.py','oracle.py','client.ts','compile.ts','build.py','smoke.sh','utility_inputs.py')]
        source_names+=['scripts/guest-engine/provenance.py','scripts/build-runtime.ts','scripts/linux-runtime-base.json','packages/runtime/src/guest/linux-supervisor.py','packages/runtime/src/guest/linux-compartment.h','packages/runtime/src/guest/linux-tool-compartment.c','packages/runtime/src/guest/file-worker.c','packages/runtime/src/guest/process-worker.c','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','tsconfig.typecheck.json','tsconfig.sdk-fence.json','bunfig.toml']
        source_names+=['.github/workflows/cowork-tool-utilities-build.yml']
        self.data={'source/'+name:(ROOT/name).read_bytes() for name in source_names};inputs={name:{'kind':'file','sha256':s.sha(self.data['source/'+name]),'bytes':len(self.data['source/'+name])} for name in source_names}
        elf=b'\x7fELF\x02\x01'+b'\0'*12+(183).to_bytes(2,'little')+b'INERT-NOT-EXECUTED'
        for name in s.ARTIFACTS:self.data['artifacts/'+name]=elf+name.encode()
        bundled={name:inputs[name] for name in ('scripts/guest-utilities/client.ts','scripts/guest-utilities/smoke.sh')};meta={'inputs':{name:{'bytes':item['bytes']} for name,item in bundled.items()},'outputs':{}}
        self.data['artifacts/utilityClient.metafile.json']=(s.canonical(meta)+'\n').encode();self.data['artifacts/utility-receipt.json']=(s.canonical(capture)+'\n').encode();self.data['artifacts/utility-origin-receipt.json']=(s.canonical({'kind':'winter-utility-origin','manifestSha256':capture['inputManifestSha256'],'utilityExecution':False,'dependencyCompletenessVerified':False})+'\n').encode()
        for guest in capture['outputs']:self.data['environment'+guest]=(self.root/'capture/environment'/guest[1:]).read_bytes()
        files={name:{'kind':'file','sha256':s.sha(data),'bytes':len(data),'executable':name in {'artifacts/'+name for name in s.ARTIFACTS} or name.startswith('environment') and capture['outputs'][name.removeprefix('environment')]['role']=='executable'} for name,data in self.data.items()}
        compiled={'formatVersion':1,'kind':'winter-tool-utility-compile','inputs':inputs,'inputInventorySha256':s.sha(s.canonical(inputs).encode()),'compiler':{'version':'1.3.14','sha256':'b'*64,'bytes':123,'platform':'linux','architecture':'arm64'},'base':{'version':'1.3.14','target':'bun-linux-arm64','sha256':'37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086'},'recipe':{'flags':['--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--target=bun-linux-arm64','--compile-executable-path=linux-bun-base','--metafile=<entry>.metafile.json'],'cwd':'stage','source':'../source','environment':{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'}},'outputs':{'utilityClient':{'entry':'scripts/guest-utilities/client.ts','sha256':files['artifacts/utilityClient']['sha256'],'bytes':files['artifacts/utilityClient']['bytes'],'bundledInputs':bundled,'metafileSha256':files['artifacts/utilityClient.metafile.json']['sha256'],'command':['<compiler>','build','--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--target=bun-linux-arm64','--compile-executable-path=linux-bun-base','--metafile=utilityClient.metafile.json','../source/scripts/guest-utilities/client.ts','--outfile','<output>/utilityClient']}},'linuxExecutionVerified':False,'vmExecutionVerified':False}
        commands=[['<native-compiler>','-std=c11','-O2','-Wall','-Wextra','-Werror','-static','packages/runtime/src/guest/'+source,'-o','<artifacts>/'+name] for name,source in [('toolLauncher','linux-tool-compartment.c'),('fileWorker','file-worker.c'),('processWorker','process-worker.c')]]
        self.receipt={'formatVersion':1,'kind':'winter-tool-utility-bundle','files':files,'compile':compiled,'nativeCompiler':{'sha256':'c'*64,'bytes':456,'version':'fixture compiler'},'nativeCommands':commands,'utilityCapture':capture,'smokeSha256':files['source/scripts/guest-utilities/smoke.sh']['sha256'],'linuxExecutionVerified':False,'vmExecutionVerified':False,'generalToolAvailabilityEnabled':False};self.parent=files[s.PARENT]['sha256']
    def tearDown(self):self.temp.cleanup()
    def archive(self,receipt=None,data=None,extra=None):
        receipt=receipt or self.receipt;data=data or self.data;wire=(s.canonical(receipt)+'\n').encode();path=self.root/('bundle-'+str(len(list(self.root.glob('bundle-*'))))+'.tar.gz')
        with tarfile.open(path,'x:gz') as bundle:
            for name,content in {**data,'receipt.json':wire}.items():
                member=tarfile.TarInfo(name)
                if isinstance(content,dict):member.type=tarfile.SYMTYPE;member.linkname=content['target'];bundle.addfile(member)
                else:member.size=len(content);bundle.addfile(member,io.BytesIO(content))
            if extra:bundle.addfile(extra)
        return path,s.sha(path.read_bytes()),s.sha(wire)
    def test_exact_archive_roles_sources_metadata_and_utility_closure(self):
        path,archive_hash,receipt_hash=self.archive();receipt,wire,data=s.read_archive(path,archive_hash,receipt_hash,self.parent)
        self.assertEqual(receipt,self.receipt);self.assertEqual(data,self.data)
        for digest_name in ('archive','receipt','parent'):
            args=[path,archive_hash,receipt_hash,self.parent];args[{'archive':1,'receipt':2,'parent':3}[digest_name]]='0'*64
            with self.subTest(digest=digest_name),self.assertRaises(ValueError):s.read_archive(*args)
        changed=copy.deepcopy(self.receipt);changed['compile']['outputs']['runtimeEntry']=changed['compile']['outputs'].pop('utilityClient')
        with self.assertRaises(ValueError):s.validate_receipt(changed,self.parent)
        changed=copy.deepcopy(self.receipt);changed['linuxExecutionVerified']=True
        with self.assertRaises(ValueError):s.validate_receipt(changed,self.parent)
        changed=copy.deepcopy(self.receipt);changed['compile']['compiler']['platform']='darwin'
        with self.assertRaises(ValueError):s.validate_receipt(changed,self.parent)
    def test_archive_traversal_duplicate_hardlink_and_unmeasured_bytes_refuse(self):
        for name,type_ in [('../escape',tarfile.REGTYPE),('receipt.json',tarfile.REGTYPE),('source/hardlink',tarfile.LNKTYPE)]:
            with self.subTest(name=name):
                member=tarfile.TarInfo(name);member.type=type_;member.linkname=s.PARENT if type_==tarfile.LNKTYPE else ''
                path,a,r=self.archive(extra=member)
                with self.assertRaises(ValueError):s.read_archive(path,a,r,self.parent)
        changed=dict(self.data);changed['artifacts/utilityClient']=b'wrong';path,a,r=self.archive(data=changed)
        with self.assertRaises(ValueError):s.read_archive(path,a,r,self.parent)
        changed=dict(self.data);changed['environment/bin/unadmitted']=b'extra';path,a,r=self.archive(data=changed)
        with self.assertRaises(ValueError):s.read_archive(path,a,r,self.parent)
    def test_only_measured_internal_source_symlinks_survive_archive_admission(self):
        receipt=copy.deepcopy(self.receipt);data=dict(self.data);name='source/node_modules/fixture';item={'kind':'symlink','target':'../scripts/guest-utilities'}
        receipt['files'][name]=item;receipt['compile']['inputs']['node_modules/fixture']=item;receipt['compile']['inputInventorySha256']=s.sha(s.canonical(receipt['compile']['inputs']).encode());data[name]={'target':item['target']}
        path,a,r=self.archive(receipt,data);self.assertEqual(s.read_archive(path,a,r,self.parent)[0],receipt)
        for target in ('../../outside','/absolute','fixture'):
            changed=copy.deepcopy(receipt);changed['files'][name]['target']=target;changed['compile']['inputs']['node_modules/fixture']['target']=target;changed['compile']['inputInventorySha256']=s.sha(s.canonical(changed['compile']['inputs']).encode())
            with self.subTest(target=target),self.assertRaises(ValueError):s.validate_receipt(changed,self.parent)
    def test_sealed_bytes_owner_modes_single_link_and_extra_files_with_stat_doubles(self):
        sealed=self.root/'sealed';sealed.mkdir()
        for name,data in self.data.items():
            path=sealed/name;path.parent.mkdir(parents=True,exist_ok=True);s.write_file(path,data,0o500 if self.receipt['files'][name]['executable'] else 0o400)
        wire=(s.canonical(self.receipt)+'\n').encode();s.write_file(sealed/'receipt.json',wire,0o400)
        for path in sealed.rglob('*'):
            if path.is_dir():path.chmod(0o500)
        sealed.chmod(0o500);real_stat=os.stat;real_fstat=os.fstat
        def owner(info):return SimpleNamespace(**{name:getattr(info,name) for name in dir(info) if name.startswith('st_')},**{})
        def fake_stat(*args,**kwargs):value=owner(real_stat(*args,**kwargs));value.st_uid=0;return value
        def fake_fstat(*args,**kwargs):value=owner(real_fstat(*args,**kwargs));value.st_uid=0;return value
        with patch.object(s,'trusted_ancestry',lambda directory:None),patch.object(s.os,'stat',fake_stat),patch.object(s.os,'fstat',fake_fstat):
            self.assertEqual(s.verify_staged(sealed,s.sha(wire),self.parent),self.receipt)
            alias=self.root/'external-hardlink';os.link(sealed/'artifacts/utilityClient',alias)
            with self.assertRaises(ValueError):s.verify_staged(sealed,s.sha(wire),self.parent)
            alias.unlink()
            (sealed/'artifacts/utilityClient').chmod(0o555)
            with self.assertRaises(ValueError):s.verify_staged(sealed,s.sha(wire),self.parent)
            (sealed/'artifacts/utilityClient').chmod(0o500)
        # Restore only synthetic directories so TemporaryDirectory can clean them.
        for path in sealed.rglob('*'):
            if path.is_dir():path.chmod(0o700)
        sealed.chmod(0o700)
    def test_native_runner_refuses_unadmitted_entry_and_exact_client_oracle(self):
        result=subprocess.run([sys.executable,'-I','-S','-B',str(HERE/'verify.py')],capture_output=True,text=True,timeout=3)
        self.assertNotEqual(result.returncode,0);self.assertIn('before project imports',result.stderr)
        record={'kind':'winter-tool-utility-client','scenario':'ordinary','uid':20001,'smokeSha256':self.receipt['smokeSha256'],'results':[{'stdout':o.EXPECTED_STDOUT,'stderr':'','exitCode':0,'termination':'exit'}]*2,'fileRefusals':True,'sourceSymlinkRefused':True,'readonlyRefused':True,'descendantReceipt':True,'cancelledEffectsUncertain':True,'generalToolAvailabilityEnabled':False}
        v.client_oracle(record,o,self.receipt['smokeSha256'],'ordinary')
        changed=copy.deepcopy(record);changed['results'][1]['stdout']='partial'
        with self.assertRaises(ValueError):v.client_oracle(changed,o,self.receipt['smokeSha256'],'ordinary')
        changed=copy.deepcopy(record);changed['cancelledEffectsUncertain']=False
        with self.assertRaises(ValueError):v.client_oracle(changed,o,self.receipt['smokeSha256'],'ordinary')
    def test_outer_mount_guard_keeps_transient_change_and_reader_failure(self):
        guard=v.OuterMountGuard(lambda:b'stable');self.assertTrue(guard.finish()['unchanged'])
        guard=v.OuterMountGuard(lambda:b'stable');guard.read=lambda:b'new mount';guard.sample();guard.read=lambda:b'stable'
        with self.assertRaises(ValueError):guard.finish()
        guard=v.OuterMountGuard(lambda:b'stable')
        def fail():raise OSError('synthetic failure')
        guard.read=fail
        with self.assertRaises(ValueError):guard.finish()
    def test_build_scripts_refuse_unsupported_host_before_any_effect(self):
        builder=load('build');collector=load('utility_inputs')
        with patch.object(sys,'platform','unsupported'):
            with self.assertRaises(ValueError):collector.prepare(self.root/'uncreated-origin')
            with self.assertRaises(ValueError):builder.build('missing','missing','missing',self.root/'uncreated-build','missing')
        self.assertFalse((self.root/'uncreated-origin').exists());self.assertFalse((self.root/'uncreated-build').exists())


if __name__=='__main__':unittest.main()

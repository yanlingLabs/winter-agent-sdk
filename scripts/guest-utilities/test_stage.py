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
        source_names=['scripts/guest-utilities/'+name for name in ('stage.py','verify.py','closure.py','oracle.py','client.ts','compile.ts','build.py','smoke.sh','utility_inputs.py','descendant.py')]
        source_names+=['scripts/guest-engine/provenance.py','scripts/build-runtime.ts','scripts/linux-runtime-base.json','packages/runtime/src/guest/linux-supervisor.py','packages/runtime/src/guest/linux-compartment.h','packages/runtime/src/guest/linux-tool-compartment.c','packages/runtime/src/guest/file-worker.c','packages/runtime/src/guest/process-worker.c','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','tsconfig.typecheck.json','tsconfig.sdk-fence.json','bunfig.toml']
        source_names+=['.github/workflows/cowork-tool-utilities-build.yml']
        self.data={'source/'+name:(ROOT/name).read_bytes() for name in source_names};inputs={name:{'kind':'file','sha256':s.sha(self.data['source/'+name]),'bytes':len(self.data['source/'+name])} for name in source_names}
        elf=b'\x7fELF\x02\x01'+b'\0'*12+(183).to_bytes(2,'little')+b'INERT-NOT-EXECUTED'
        for name in s.ARTIFACTS:self.data['artifacts/'+name]=elf+name.encode()
        bundled={name:inputs[name] for name in ('scripts/guest-utilities/client.ts','scripts/guest-utilities/smoke.sh','scripts/guest-utilities/descendant.py')};meta={'inputs':{name:{'bytes':item['bytes']} for name,item in bundled.items()},'outputs':{}}
        self.data['artifacts/utilityClient.metafile.json']=(s.canonical(meta)+'\n').encode();self.data['artifacts/utility-receipt.json']=(s.canonical(capture)+'\n').encode();self.data['artifacts/utility-origin-receipt.json']=(s.canonical({'kind':'winter-utility-origin','manifestSha256':capture['inputManifestSha256'],'utilityExecution':False,'dependencyCompletenessVerified':False})+'\n').encode()
        for guest in capture['outputs']:self.data['environment'+guest]=(self.root/'capture/environment'/guest[1:]).read_bytes()
        files={name:{'kind':'file','sha256':s.sha(data),'bytes':len(data),'executable':name in {'artifacts/'+name for name in s.ARTIFACTS} or name.startswith('environment') and capture['outputs'][name.removeprefix('environment')]['executable']} for name,data in self.data.items()}
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
    def test_loader_intent_roundtrips_bundle_sealed_and_runtime_modes(self):
        path,a,r=self.archive();receipt,wire,data=s.read_archive(path,a,r,self.parent)
        loaders={'/lib/ld-linux-aarch64.so.1','/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1'}
        for guest in loaders:
            item=receipt['utilityCapture']['outputs'][guest]
            self.assertEqual(item['role'],'library');self.assertIs(item['executable'],True)
            self.assertIs(receipt['files']['environment'+guest]['executable'],True)
            self.assertEqual(v.environment_mode(guest,item),0o555)
            # Actual portable files model the immutable staging mode, then the
            # verified readable/executable copy mode used by the tool UID.
            sealed=self.root/('sealed-'+guest.rsplit('/',2)[1]);s.write_file(sealed,data['environment'+guest],0o500)
            self.assertEqual(stat.S_IMODE(sealed.stat().st_mode),0o500)
            copied=self.root/('copy-'+guest.rsplit('/',2)[1]);s.write_file(copied,sealed.read_bytes(),v.environment_mode(guest,item))
            self.assertEqual(stat.S_IMODE(copied.stat().st_mode),0o555)
        library='/lib/aarch64-linux-gnu/libc.so.6';item=receipt['utilityCapture']['outputs'][library]
        self.assertEqual(v.environment_mode(library,item),0o444)
        changed=copy.deepcopy(receipt);changed['files']['environment'+library]['executable']=True
        with self.assertRaises(ValueError):s.validate_receipt(changed,self.parent)
        # Even a coherently rehashed capture cannot grant X to another library.
        changed=copy.deepcopy(receipt);capture=changed['utilityCapture']
        capture['inputs'][library]['executable']=True;capture['outputs'][library]['executable']=True;changed['files']['environment'+library]['executable']=True
        manifest={'formatVersion':1,'kind':'winter-tool-utility-inputs','target':'linux-arm64-gnu','files':capture['inputs']}
        capture['inputManifestSha256']=s.sha(s.canonical(manifest).encode());capture['outputInventorySha256']=s.sha(s.canonical(capture['outputs']).encode())
        with self.assertRaisesRegex(ValueError,'execution intent'):s.validate_receipt(changed,self.parent)
        with self.assertRaises(ValueError):v.environment_mode(library,{**item,'executable':True})
        self.assertEqual({guest for guest,item in receipt['utilityCapture']['outputs'].items() if item['role']=='executable'},s.EXECUTABLES)
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
            f.closure.validate_capture(self.receipt['utilityCapture'],sealed/'environment',sealed=True)
            with self.assertRaisesRegex(ValueError,'execution-mode'):f.closure.validate_capture(self.receipt['utilityCapture'],sealed/'environment')
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
    def test_python312_zipfile_package_is_captured_and_missing_packages_refuse(self):
        collector=load('utility_inputs');base=self.root/'python3.12';base.mkdir()
        def source(relative):
            path=base/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('raise RuntimeError("synthetic source must not import")\n');return path
        for name in collector.MODULES:
            source('logging/__init__.py' if name=='logging' else name+'.py')
        for name in collector.PACKAGES:source(name+'/__init__.py')
        nested=source('zipfile/_path/__init__.py');glob=source('zipfile/_path/glob.py')
        excluded=source('zipfile/tests/should-not-copy.py')
        paths=collector.stdlib_paths(base)
        self.assertIn(base/'zipfile/__init__.py',paths);self.assertIn(nested,paths);self.assertIn(glob,paths)
        self.assertNotIn(excluded,paths);self.assertFalse((base/'zipfile.py').exists())
        (base/'zipfile/__init__.py').unlink()
        with self.assertRaisesRegex(ValueError,'fixed Python package missing: zipfile'):collector.stdlib_paths(base)
        source('zipfile/__init__.py');(base/'threading.py').unlink()
        with self.assertRaisesRegex(ValueError,'fixed Python module missing: threading'):collector.stdlib_paths(base)
    def test_exact_descendant_payload_child_readiness_after_setsid_and_parent_timeout(self):
        payload=(HERE/'descendant.py').read_text()
        class Halt(Exception):pass
        def run(child,scenario='foreground',ready_after=2,setsid_failure=False):
            events=[];clock=[0.0];reads=[0]
            def setsid():
                events.append(('setsid',))
                if setsid_failure:raise OSError('synthetic setsid failure')
            def exit_(code):raise Halt(code)
            def sleep(seconds):events.append(('sleep',seconds));clock[0]+=seconds
            class File:
                def __init__(self,name,mode):self.name=name;self.mode=mode
                def __enter__(self):return self
                def __exit__(self,*args):events.append(('close',self.name))
                def write(self,data):events.append(('write',self.name,data));return len(data)
                def read(self):return 'ready-after-setsid'
            def open_(name,mode='r'):
                events.append(('open',name,mode))
                if mode=='r':
                    reads[0]+=1
                    if ready_after is None or reads[0]<ready_after:raise FileNotFoundError(name)
                return File(name,mode)
            fake_os=SimpleNamespace(fork=lambda:0 if child else 123,setsid=setsid,_exit=exit_)
            fake_time=SimpleNamespace(monotonic=lambda:clock[0],sleep=sleep);fake_sys=SimpleNamespace(argv=['-c',scenario])
            with patch.dict(sys.modules,{'os':fake_os,'time':fake_time,'sys':fake_sys}),patch('builtins.open',open_):
                try:exec(compile(payload,'exact-descendant-payload','exec'),{})
                except BaseException as error:return events,error
            return events,None
        for scenario,ready in [('foreground','descendant-ready'),('cancel','cancel-ready')]:
            events,error=run(True,scenario);self.assertIsInstance(error,Halt)
            self.assertLess(events.index(('setsid',)),events.index(('write',ready,'ready-after-setsid')))
            self.assertLess(events.index(('close',ready)),events.index(('sleep',1)))
            events,error=run(True,scenario,setsid_failure=True);self.assertIsInstance(error,OSError)
            self.assertFalse(any(event[0]=='write' for event in events))
            events,error=run(False,scenario);self.assertIsNone(error)
            self.assertFalse(any(event[0] in ('write','setsid') for event in events))
            self.assertEqual(('sleep',5) in events,scenario=='cancel')
            events,error=run(False,scenario,ready_after=None);self.assertIsInstance(error,SystemExit)
            self.assertIn('readiness timeout',str(error));self.assertFalse(('sleep',5) in events)
    def test_readonly_grant_has_writable_dac_and_mount_flag_positive_controls(self):
        runner=(HERE/'verify.py').read_text();client=(HERE/'client.ts').read_text();smoke=(HERE/'smoke.sh').read_text()
        self.assertIn("readonly.mkdir(mode=0o2770);os.chown(readonly,10001,10000);readonly.chmod(0o2770)",runner)
        self.assertIn("'guestPath':'/workspace/folders/readonly','readOnly':True",runner)
        self.assertIn("{'rw','nosuid','nodev','noexec'} <= mounts['/workspace/folders/source'][0]",smoke)
        self.assertIn("{'ro','nosuid','nodev','noexec'} <= mounts['/workspace/folders/readonly'][0]",smoke)
        self.assertIn('assert stat.S_IMODE(info.st_mode) == 0o2770',smoke)
        self.assertIn("stream.write('writable-source-positive')",smoke)
        self.assertIn("(source/'writable-control').read_text()!='writable-source-positive'",runner)
        self.assertIn('TextDecoder().decode((await guest.read(source + "/cancel-ready")).bytes) === "ready-after-setsid"',client)
        self.assertIn("any((source/name).read_text()!='ready-after-setsid'",runner)
    def test_exact_workspace_group_check_distinguishes_primary_and_supplementary(self):
        smoke=(HERE/'smoke.sh').read_text();start=smoke.index('workspace_group = 10000')
        check=smoke[start:smoke.index("with open('/workspace/folders/source/writable-control'",start)]
        def run(primary=10001,supplementary=(10000,),directory_group=10000):
            visited=[]
            def metadata(name):
                self.assertIn(name,('/workspace/folders/source','/workspace/folders/readonly'));visited.append(name)
                return SimpleNamespace(st_uid=10001,st_gid=directory_group,st_mode=stat.S_IFDIR|0o2770)
            fake=SimpleNamespace(getuid=lambda:10001,getgid=lambda:primary,getgroups=lambda:list(supplementary),stat=metadata)
            exec(compile(check,'exact-workspace-group-check','exec'),{'os':fake,'stat':stat})
            return visited
        self.assertEqual(run(),['/workspace/folders/source','/workspace/folders/readonly'])
        for arguments in ({'primary':10000},{'supplementary':(10001,)},{'directory_group':10001}):
            with self.subTest(arguments=arguments),self.assertRaises(AssertionError):run(**arguments)


if __name__=='__main__':unittest.main()

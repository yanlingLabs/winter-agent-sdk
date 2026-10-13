"""Inert ELF/data tests only. No executable, utility, service, Root or native launch."""
import copy,hashlib,importlib.util,json,os,struct,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
s=load('environment_std_parent',HERE/'stage.py')
def digest(wire):return hashlib.sha256(wire).hexdigest()
def elf(needed=(),soname=None,rpath=None,runpath=None,machine=183,kind=3):
    strings=b'\0';positions={}
    for name in (*needed,*([soname] if soname is not None else []),*([rpath] if rpath is not None else []),*([runpath] if runpath is not None else [])):
        positions[name]=len(strings);strings+=name.encode()+b'\0'
    entries=[(5,0x10200),(10,len(strings)),*((1,positions[name]) for name in needed)]
    for tag,value in ((14,soname),(15,rpath),(29,runpath)):
        if value is not None:entries.append((tag,positions[value]))
    entries.append((0,0));dynamic=b''.join(struct.pack('<qQ',*item) for item in entries)
    wire=bytearray(0x200+len(strings));wire[:6]=b'\x7fELF\x02\x01';struct.pack_into('<HHI',wire,16,kind,machine,1);struct.pack_into('<Q',wire,32,64);struct.pack_into('<HHH',wire,52,64,56,2)
    struct.pack_into('<IIQQQQQQ',wire,64,1,5,0,0x10000,0,len(wire),len(wire),4096)
    struct.pack_into('<IIQQQQQQ',wire,120,2,4,0x100,0x10100,0,len(dynamic),len(dynamic),8)
    wire[0x100:0x100+len(dynamic)]=dynamic;wire[0x200:]=strings
    return bytes(wire)
def metadata(wire):
    with tempfile.TemporaryFile() as file:file.write(wire);file.flush();return s.elf_dependencies(file.fileno())
def environment_fixture(source,artifacts,inputs):
    environment=artifacts/'environment';environment.mkdir()
    records={};blobs={}
    names={*s.UTILITY_PROGRAMS,*s.UTILITY_LOADERS,'/lib/aarch64-linux-gnu/libc.so.6','/lib/aarch64-linux-gnu/libpthread.so.0','/lib/aarch64-linux-gnu/libdl.so.2'}
    for name in sorted(names):
        wire=elf(soname=Path(name).name);role='executable' if name in s.UTILITY_PROGRAMS else 'library';executable=role=='executable' or name in s.UTILITY_LOADERS
        path=environment/name[1:];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(wire);blobs[name]=wire
        records[name]={'role':role,'executable':executable,'bytes':len(wire),'sha256':digest(wire),'source':name[1:]}
    outputs={name:{key:item[key] for key in ('role','executable','bytes','sha256')} for name,item in records.items()}
    manifest={'formatVersion':1,'kind':'winter-tool-utility-inputs','target':'linux-arm64-gnu','files':records}
    source_names=('scripts/guest-utilities/closure.py','scripts/guest-utilities/oracle.py','scripts/guest-utilities/smoke.sh')
    captured={'formatVersion':1,'kind':'winter-tool-utility-capture','target':'linux-arm64-gnu','inputs':records,'inputManifestSha256':digest(s.canonical(manifest).encode()),'sources':{name:{key:inputs[name][key] for key in ('bytes','sha256')} for name in source_names},'builder':{'version':'3.12.0','platform':'linux','architecture':'aarch64','bytes':outputs['/usr/bin/python3']['bytes'],'sha256':outputs['/usr/bin/python3']['sha256']},'recipe':{'operation':'held-fd-byte-copy','implicitDiscovery':False,'utilityExecution':False},'outputs':outputs,'outputInventorySha256':digest(s.canonical(outputs).encode()),'dependencyCompletenessVerified':False,'linuxExecutionVerified':False,'vmExecutionVerified':False,'generalToolAvailabilityEnabled':False}
    supplements={name:records[name] for name in ('/lib/aarch64-linux-gnu/libpthread.so.0','/lib/aarch64-linux-gnu/libdl.so.2')};base={**manifest,'files':{name:item for name,item in records.items() if name not in supplements}}
    base_origin={'kind':'winter-utility-origin','builder':{key:captured['builder'][key] for key in ('version','sha256','bytes')},'readelf':{},'readelfCommands':[],'manifestSha256':digest(s.canonical(base).encode()),'staticStdlibGraph':{},'utilityExecution':False,'dependencyCompletenessVerified':False}
    package_names={'/lib/aarch64-linux-gnu/libc.so.6',*s.UTILITY_LOADERS,*supplements}
    packages={name:{'package':'libc6:arm64','version':'2.39-fixture',**{key:records[name][key] for key in ('source','bytes','sha256')},'elf':metadata(blobs[name])} for name in package_names}
    origin={'formatVersion':1,'kind':'winter-host-query-utility-origin','phaseBGraph':{'roots':s.phase_b_fragment_records([(source/'scripts/guest-host-query'/name).read_bytes() for name in ('utilities.sh','utilities-plan.sh')]),'kind':'winter-utility-static-stdlib-graph','requiredStaticImportsCaptured':True,'dynamicCompletenessVerified':False,'optionalBranchesVerified':False,'nativeExecutionVerified':False},'baseOrigin':base_origin,'baseManifest':base,'supplementalPair':supplements,'libcPackage':packages,'combinedManifestSha256':captured['inputManifestSha256'],'utilityExecution':False,'dependencyCompletenessVerified':False}
    extras={'kind':'winter-host-query-utilities','utilityCapture':captured,'utilityOrigin':origin,'environment':outputs,'elfDependencies':{name:metadata((artifacts/name).read_bytes()) for name in ('runtimeEntry','ownerLibrary')}}
    for name,key,value in (('utility-receipt.json','utilityCaptureSha256',captured),('utility-origin-receipt.json','utilityOriginSha256',origin)):
        wire=(s.canonical(value)+'\n').encode();(artifacts/name).write_bytes(wire);extras[key]=digest(wire)
    return extras
class ElfTests(unittest.TestCase):
    def test_actual_bounded_parser_reads_only_inert_needed_soname_type(self):
        result=metadata(elf(('libc.so.6',),'libpthread.so.0'));self.assertEqual(result['type'],3);self.assertEqual(result['needed'],['libc.so.6']);self.assertEqual(result['soname'],'libpthread.so.0')
    def test_malformed_machine_tables_offsets_and_truncation_refuse(self):
        wire=elf(('libc.so.6',))
        for invalid in (wire[:20],elf(machine=62),wire[:0x101]):
            with self.assertRaises(ValueError):metadata(invalid)
        bad=bytearray(wire);struct.pack_into('<Q',bad,32,len(wire)+1)
        with self.assertRaises(ValueError):metadata(bytes(bad))
if __name__=='__main__':unittest.main()

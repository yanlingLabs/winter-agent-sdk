"""Ordinary Linux compilation/archive only. No artifact or utility executes."""
import os,sys
if __name__=='__main__' and os.geteuid()==0:raise SystemExit('ordinary build required before project imports')
import argparse,importlib.util,io,json,platform,subprocess,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
s=load('utility_stage',Path(__file__).with_name('stage.py'));c=load('utility_capture',Path(__file__).with_name('closure.py'));p=load('utility_provenance',ROOT/'scripts/guest-engine/provenance.py')
NATIVE={'toolLauncher':'linux-tool-compartment.c','fileWorker':'file-worker.c','processWorker':'process-worker.c'}
def inputs():
    value=p.inventory(ROOT);workflow='.github/workflows/cowork-tool-utilities-build.yml';value[workflow]={'kind':'file',**p.sha(ROOT/workflow)};return value


def build(entries,capture,origin_receipt,output,compiler):
    if sys.platform!='linux' or platform.machine()!='aarch64' or os.geteuid()==0:raise ValueError('ordinary native Linux ARM64 build only')
    entries,capture,output=map(Path,(entries,capture,output));compiled=s.json_wire(s.read_path(entries/'compile-receipt.json',s.MAX_JSON));before=inputs()
    if compiled.get('kind')!='winter-tool-utility-compile' or compiled.get('inputs')!=before:raise ValueError('utility client source graph changed')
    utility=s.json_wire(s.read_path(capture/'utility-receipt.json',s.MAX_JSON));c.validate_capture(utility,capture/'environment')
    origin=s.json_wire(s.read_path(origin_receipt,s.MAX_JSON))
    if origin.get('kind')!='winter-utility-origin' or origin.get('utilityExecution') is not False or origin.get('manifestSha256')!=utility['inputManifestSha256']:raise ValueError('utility origin provenance')
    output.mkdir(mode=0o700);artifacts=output/'artifacts';artifacts.mkdir(mode=0o700);compiler=Path(compiler).resolve(strict=True);compiler_id=p.sha(compiler,s.MAX_ARTIFACT)
    version=subprocess.run([str(compiler),'--version'],capture_output=True,text=True,timeout=10)
    if version.returncode:raise ValueError('native compiler metadata')
    version=version.stdout.splitlines()[0]
    if '/' in version or len(version)>512:raise ValueError('native compiler version must be path neutral')
    native_commands=[]
    for name,source in NATIVE.items():
        command=[str(compiler),'-std=c11','-O2','-Wall','-Wextra','-Werror','-static',str(ROOT/'packages/runtime/src/guest'/source),'-o',str(artifacts/name)]
        result=subprocess.run(command,capture_output=True,timeout=60,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'})
        if result.returncode:raise ValueError('native compile failed: '+name)
        native_commands.append(['<native-compiler>',*command[1:-3],'packages/runtime/src/guest/'+source,'-o','<artifacts>/'+name])
    for name,path in [('utilityClient',entries/'utilityClient'),('utilityClient.metafile.json',entries/'utilityClient.metafile.json'),('utility-receipt.json',capture/'utility-receipt.json'),('utility-origin-receipt.json',Path(origin_receipt))]:
        s.write_file(artifacts/name,s.read_path(path,s.MAX_ARTIFACT),0o555 if name=='utilityClient' else 0o444)
    files={};data={}
    for relative,item in before.items():
        name='source/'+relative
        if item['kind']=='symlink':files[name]=dict(item);data[name]={'target':item['target']}
        else:
            wire=s.read_path(ROOT/relative,s.MAX_ARTIFACT,unique=False);files[name]={'kind':'file','sha256':s.sha(wire),'bytes':len(wire),'executable':False};data[name]=wire
            if {key:files[name][key] for key in ('kind','sha256','bytes')}!=item:raise ValueError('source byte capture changed')
    for path in sorted(artifacts.iterdir()):
        name='artifacts/'+path.name;wire=s.read_path(path,s.MAX_ARTIFACT);files[name]={'kind':'file','sha256':s.sha(wire),'bytes':len(wire),'executable':path.name in s.ARTIFACTS};data[name]=wire
    for guest,item in utility['outputs'].items():
        name='environment'+guest;wire=s.read_path(capture/'environment'/guest[1:]);files[name]={'kind':'file','sha256':s.sha(wire),'bytes':len(wire),'executable':item['role']=='executable'};data[name]=wire
    receipt={'formatVersion':1,'kind':'winter-tool-utility-bundle','files':files,'compile':compiled,'nativeCompiler':{**compiler_id,'version':version},'nativeCommands':native_commands,'utilityCapture':utility,'smokeSha256':files['source/scripts/guest-utilities/smoke.sh']['sha256'],'linuxExecutionVerified':False,'vmExecutionVerified':False,'generalToolAvailabilityEnabled':False}
    parent_hash=files[s.PARENT]['sha256'];s.validate_receipt(receipt,parent_hash)
    if inputs()!=before or p.sha(compiler,s.MAX_ARTIFACT)!=compiler_id:raise ValueError('build input/compiler changed')
    wire=(s.canonical(receipt)+'\n').encode();s.write_file(output/'receipt.json',wire,0o444)
    archive=output/'bundle.tar.gz'
    with tarfile.open(archive,'x:gz') as bundle:
        for name,value in sorted({**data,'receipt.json':wire}.items()):
            info=tarfile.TarInfo(name);info.uid=info.gid=0;info.mtime=0
            if isinstance(value,dict):info.type=tarfile.SYMTYPE;info.linkname=value['target'];bundle.addfile(info)
            else:info.size=len(value);info.mode=0o555 if files.get(name,{}).get('executable') else 0o444;bundle.addfile(info,io.BytesIO(value))
    archive_hash=s.sha(s.read_path(archive,s.MAX_ARCHIVE));receipt_hash=s.sha(wire);s.read_archive(archive,archive_hash,receipt_hash,parent_hash)
    print(s.canonical({'archiveSha256':archive_hash,'receiptSha256':receipt_hash,'parentSha256':parent_hash,'linuxExecutionVerified':False,'generalToolAvailabilityEnabled':False}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--entries',required=True);parser.add_argument('--capture',required=True);parser.add_argument('--origin-receipt',required=True);parser.add_argument('--out',required=True);parser.add_argument('--cc',default='/usr/bin/cc');args=parser.parse_args();build(args.entries,args.capture,args.origin_receipt,args.out,args.cc)

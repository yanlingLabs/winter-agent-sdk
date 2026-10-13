"""Ordinary capture wrapper. Never executes utility/helper/artifact or installs packages."""
import os,sys
if __name__=='__main__' and os.geteuid()==0:raise SystemExit('ordinary builder required before imports')
import argparse,hashlib,importlib.util,json,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
c=load('measured_utility_capture',ROOT/'scripts/guest-utilities/closure.py')
u=load('unchanged_utility_inputs',ROOT/'scripts/guest-utilities/utility_inputs.py')
s=load('host_query_stdlib_parent',HERE/'stage.py')
SUPPLEMENTS=('/lib/aarch64-linux-gnu/libpthread.so.0','/lib/aarch64-linux-gnu/libdl.so.2')
PACKAGE_LEAVES=('/lib/aarch64-linux-gnu/libc.so.6',*sorted(c.ELF_LOADERS),*SUPPLEMENTS)
def package_metadata(path):
    result=subprocess.run(['/usr/bin/dpkg-query','-S',str(path)],capture_output=True,text=True,timeout=10,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
    rows=result.stdout.strip().splitlines()
    if result.returncode or len(result.stdout)>4096 or len(result.stderr)>4096 or len(rows)!=1 or rows[0]!='libc6:arm64: '+str(path):raise ValueError('same libc6 ARM64 package required')
    result=subprocess.run(['/usr/bin/dpkg-query','-W','-f=${binary:Package}\t${Version}\n','libc6:arm64'],capture_output=True,text=True,timeout=10,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
    if result.returncode or len(result.stdout)>4096 or len(result.stderr)>4096:raise ValueError('libc6 version metadata')
    package,separator,version=result.stdout.strip().partition('\t')
    if package!='libc6:arm64' or not separator or not version or len(version)>128:raise ValueError('libc6 package/version')
    return {'package':package,'version':version}
def validate_package(records,base,extras):
    if set(records)!=set(PACKAGE_LEAVES) or set(extras)!=set(SUPPLEMENTS):raise ValueError('fixed supplement package leaves')
    versions={(record['package'],record['version']) for record in records.values()}
    if len(versions)!=1 or next(iter(versions))[0]!='libc6:arm64':raise ValueError('libc6 package/version mismatch')
    for guest in PACKAGE_LEAVES:
        record=records[guest];item=(extras if guest in extras else base)[guest]
        if {key:record[key] for key in ('bytes','sha256')}!={key:item[key] for key in ('bytes','sha256')}:raise ValueError('libc6 package byte binding')
        elf=record['elf']
        if elf['type']!=3 or elf['rpath'] is not None or elf['runpath'] is not None:raise ValueError('fixed glibc DSO properties')
        if guest in SUPPLEMENTS and (elf['soname']!=Path(guest).name or not set(elf['needed'])<= {'libc.so.6','ld-linux-aarch64.so.1'}):raise ValueError('supplement SONAME/dependencies')
def copy_held(fd,target,expected):
    destination=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        os.lseek(fd,0,os.SEEK_SET);copied,_=c.measure(fd,destination);os.fsync(destination);os.fchmod(destination,0o444)
        if copied!=expected:raise ValueError('supplement changed during copy')
    finally:os.close(destination)
def source_snapshot():
    fd=s.open_root(ROOT)
    try:return {name:s.measure(fd,name,s.MAX_FILE,unique=False) for name in s.UTILITY_SOURCES}
    finally:os.close(fd)
def prepare(output):
    if os.geteuid()==0 or sys.platform!='linux':raise ValueError('ordinary Linux collector only')
    before_sources=source_snapshot()
    output=Path(output);output.mkdir(mode=0o700);base=output/'base';manifest=u.prepare(base)
    base_fd=s.open_root(base)
    try:original=s.json_wire(s.measure(base_fd,'origin-receipt.json',s.MAX_JSON,retain=True))
    finally:os.close(base_fd)
    # The unchanged base origin is preserved; the wrapper separately attests the package pair.
    files=dict(manifest['files']);root=c.open_root('/');records={};extras={};readfds=[]
    try:
        for guest in PACKAGE_LEAVES:
            path=Path('/'+(files[guest]['source'] if guest in files else guest[1:])).resolve(strict=True)
            fd=c.leaf(root,path.as_posix()[1:]);readfds.append(fd);measured,header=c.measure(fd)
            if header[:6]!=b'\x7fELF\x02\x01' or int.from_bytes(header[18:20],'little')!=183:raise ValueError('same ARM64 libc6 ELF required')
            records[guest]={**package_metadata(path),**measured,'source':path.as_posix()[1:],'elf':s.elf_dependencies(fd)}
            if guest in SUPPLEMENTS:
                if guest in files:raise ValueError('supplement cannot relabel base leaf')
                target=base/'origin'/path.as_posix()[1:];target.parent.mkdir(parents=True,exist_ok=True)
                copy_held(fd,target,measured)
                extras[guest]={'role':'library','executable':False,'source':path.as_posix()[1:],**measured};files[guest]=extras[guest]
        validate_package(records,manifest['files'],extras)
        combined={**manifest,'files':files};c.validate_manifest(combined)
        captured=c.capture(base/'origin',combined,output/'capture');c.validate_capture(captured,output/'capture/environment')
        origin_fd=c.open_root(base/'origin')
        try:
            roots=[]
            descendant=(ROOT/'scripts/guest-utilities/descendant.py').read_bytes()
            for payload in ('utilities.sh','utilities-plan.sh'):
                for label,data in u.graph.payload_roots((HERE/payload).read_bytes(),descendant):
                    if label!='descendant':roots.append(('test:'+str(len(roots)+1),data))
            graph=u.graph.validate(files,lambda guest:u.held_source(origin_fd,files[guest],u.graph.MAX_SOURCE),roots,sys.builtin_module_names,original['builder'],interpreter_platform=sys.platform)
        finally:os.close(origin_fd)
        # Recheck held bytes and observed package version after all intake/copy/graph work.
        for guest,fd in zip(PACKAGE_LEAVES,readfds):
            os.lseek(fd,0,os.SEEK_SET);again,_=c.measure(fd)
            if again!={key:records[guest][key] for key in ('bytes','sha256')} or package_metadata(Path('/'+records[guest]['source']))!={key:records[guest][key] for key in ('package','version')}:raise ValueError('libc6 package input changed during capture')
        if source_snapshot()!=before_sources:raise ValueError('utility sources changed during capture')
        origin={'formatVersion':1,'kind':'winter-host-query-utility-origin','phaseBGraph':graph,'baseOrigin':original,'baseManifest':manifest,'supplementalPair':extras,'libcPackage':records,'combinedManifestSha256':captured['inputManifestSha256'],'utilityExecution':False,'dependencyCompletenessVerified':False}
        (output/'utility-origin-receipt.json').write_text(c.canonical(origin)+'\n')
        return captured,origin
    finally:
        for fd in readfds:os.close(fd)
        os.close(root)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',required=True);args=parser.parse_args();prepare(args.out)

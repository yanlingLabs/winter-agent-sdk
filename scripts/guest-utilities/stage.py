"""Stdlib-only utility bundle admission parent. Unsigned receipts grant no privilege.
An external byte-check bootstrap must approve this file, archive and receipt hashes.
No privileged project import precedes complete immutable closure validation.
"""
import argparse, hashlib, io, json, os, posixpath, re, stat, subprocess, sys, tarfile, tempfile
from pathlib import Path, PurePosixPath

PARENT = 'source/scripts/guest-utilities/stage.py'
RUNNER = 'source/scripts/guest-utilities/verify.py'
PREFIX = 'winter-utility-reviewed-'
MAX_FILE = 32 * 1024 * 1024
MAX_ARTIFACT = 128 * 1024 * 1024
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_ENTRIES = 24000
MAX_JSON = 16 * 1024 * 1024
ENV = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'}
EXECUTABLES = {'/bin/bash','/bin/cat','/usr/bin/git','/usr/bin/python3','/usr/bin/openssl','/usr/bin/mktemp'}
ARTIFACTS = {'utilityClient','toolLauncher','fileWorker','processWorker'}


def sha(data): return hashlib.sha256(data).hexdigest()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def valid_hash(value): return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def relative(name):
    if not isinstance(name,str) or not name or len(name)>4096 or '\0' in name or '\\' in name:
        raise ValueError('bundle path')
    path=PurePosixPath(name)
    if path.is_absolute() or str(path)!=name or any(part in ('.','..') for part in path.parts): raise ValueError('bundle path')
    return name


def json_wire(wire):
    if len(wire)>MAX_JSON: raise ValueError('bundle JSON limit')
    def unique(pairs):
        result={}
        for key,value in pairs:
            if key in result: raise ValueError('duplicate bundle field')
            result[key]=value
        return result
    return json.loads(wire,object_pairs_hook=unique)


def open_root(path):
    path=Path(os.path.abspath(path));fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for name in path.parts[1:]:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd);os.close(fd);fd=child
        return fd
    except BaseException: os.close(fd);raise


def leaf(root,name):
    parts=relative(name).split('/');folder=os.dup(root)
    try:
        for name in parts[:-1]:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);os.close(folder);folder=child
        return os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=folder)
    finally:os.close(folder)


def read_fd(fd,limit=MAX_FILE,immutable=False,unique=True):
    before=os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or unique and before.st_nlink!=1 or not 0<=before.st_size<=limit: raise ValueError('bundle leaf identity/limit')
    if immutable and (before.st_uid!=0 or stat.S_IMODE(before.st_mode) not in (0o400,0o500)): raise ValueError('immutable bundle leaf required')
    chunks=[];count=0
    while True:
        data=os.read(fd,min(65536,limit-count+1))
        if not data:break
        count+=len(data)
        if count>limit:raise ValueError('bundle leaf limit')
        chunks.append(data)
    after=os.fstat(fd)
    if count!=before.st_size or (before.st_dev,before.st_ino,before.st_mode,before.st_nlink,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_mode,after.st_nlink,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('bundle leaf changed')
    return b''.join(chunks)


def read_path(path,limit=MAX_FILE,unique=True):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:return read_fd(fd,limit,unique=unique)
    finally:os.close(fd)


def elf(data):return len(data)>=20 and data[:6]==b'\x7fELF\x02\x01' and int.from_bytes(data[18:20],'little')==183


def validate_receipt(value,parent_hash):
    keys={'formatVersion','kind','files','compile','nativeCompiler','nativeCommands','utilityCapture','smokeSha256','linuxExecutionVerified','vmExecutionVerified','generalToolAvailabilityEnabled'}
    if type(value) is not dict or set(value)!=keys or type(value['formatVersion']) is not int or value['formatVersion']!=1 or value['kind']!='winter-tool-utility-bundle':raise ValueError('utility bundle receipt')
    if any(value[key] is not False for key in ('linuxExecutionVerified','vmExecutionVerified','generalToolAvailabilityEnabled')):raise ValueError('bundle cannot grant execution')
    files=value['files']
    if type(files) is not dict or not 1<=len(files)<=MAX_ENTRIES:raise ValueError('bundle inventory limit')
    directories=set();total=0
    for name,item in files.items():
        relative(name)
        if name.split('/')[0] not in ('source','artifacts','environment') or type(item) is not dict:raise ValueError('bundle root/leaf')
        directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent)!='.')
        if item.get('kind')=='file':
            if set(item)!={'kind','sha256','bytes','executable'} or not valid_hash(item['sha256']) or type(item['bytes']) is not int or not 0<=item['bytes']<=MAX_ARTIFACT or type(item['executable']) is not bool:raise ValueError('bundle measured leaf')
            if name.startswith('source/') and item['executable']:raise ValueError('source must be data only')
            total+=item['bytes']
        elif item.get('kind')=='symlink':
            if set(item)!={'kind','target'} or not name.startswith('source/') or not isinstance(item['target'],str) or not item['target'] or len(item['target'])>4096 or '\0' in item['target'] or '\\' in item['target'] or PurePosixPath(item['target']).is_absolute():raise ValueError('bundle link')
        else:raise ValueError('bundle leaf kind')
    if total>MAX_TOTAL or directories&set(files):raise ValueError('bundle aggregate/prefix collision')
    for name,item in files.items():
        if item['kind']!='symlink':continue
        target=posixpath.normpath(str(PurePosixPath(name).parent/item['target']));seen={name}
        for _ in range(40):
            if not target.startswith('source/'):raise ValueError('bundle source link escape')
            parts=target.split('/');changed=False
            for count in range(1,len(parts)+1):
                prefix='/'.join(parts[:count]);node=files.get(prefix,{})
                if node.get('kind')!='symlink':continue
                if prefix in seen:raise ValueError('bundle link cycle')
                seen.add(prefix);target=posixpath.normpath(str(PurePosixPath(prefix).parent/node['target'])+('/'+'/'.join(parts[count:]) if count<len(parts) else ''));changed=True;break
            if not changed:
                if target not in files and target not in directories:raise ValueError('bundle link target absent')
                break
        else:raise ValueError('bundle link depth')
    required={PARENT,RUNNER,'source/scripts/guest-utilities/closure.py','source/scripts/guest-utilities/oracle.py','source/scripts/guest-utilities/client.ts','source/scripts/guest-utilities/compile.ts','source/scripts/guest-utilities/build.py','source/scripts/guest-utilities/smoke.sh','source/scripts/guest-utilities/utility_inputs.py','source/scripts/guest-engine/provenance.py','source/scripts/build-runtime.ts','source/scripts/linux-runtime-base.json','source/packages/runtime/src/guest/linux-supervisor.py','source/packages/runtime/src/guest/linux-compartment.h','source/packages/runtime/src/guest/linux-tool-compartment.c','source/packages/runtime/src/guest/file-worker.c','source/packages/runtime/src/guest/process-worker.c',*(f'artifacts/{name}' for name in ARTIFACTS),'artifacts/utilityClient.metafile.json','artifacts/utility-receipt.json'}
    if not required<=set(files) or files[PARENT].get('sha256')!=parent_hash or not valid_hash(value['smokeSha256']) or files['source/scripts/guest-utilities/smoke.sh'].get('sha256')!=value['smokeSha256']:raise ValueError('bundle required source/parent/payload')
    roots={'package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','tsconfig.typecheck.json','tsconfig.sdk-fence.json','bunfig.toml'}
    if not {'source/'+name for name in roots}<=set(files):raise ValueError('compiled workspace root inputs required')
    if 'source/.github/workflows/cowork-tool-utilities-build.yml' not in files:raise ValueError('utility build workflow input required')
    if 'source/scripts/guest-utilities/descendant.py' not in files:raise ValueError('fixed descendant payload input required')
    if {name.removeprefix('artifacts/') for name in files if name.startswith('artifacts/')}!=ARTIFACTS|{'utilityClient.metafile.json','utility-receipt.json','utility-origin-receipt.json'}:raise ValueError('explicit utility artifact inventory')
    compiled=value['compile']
    if type(compiled) is not dict or compiled.get('kind')!='winter-tool-utility-compile' or type(compiled.get('formatVersion')) is not int or compiled['formatVersion']!=1 or compiled.get('linuxExecutionVerified') is not False or compiled.get('vmExecutionVerified') is not False:raise ValueError('utility client compile receipt')
    if set(compiled)!={'formatVersion','kind','inputs','inputInventorySha256','compiler','base','recipe','outputs','linuxExecutionVerified','vmExecutionVerified'}:raise ValueError('closed utility compile receipt')
    pin={'version':'1.3.14','target':'bun-linux-arm64','sha256':'37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086'}
    if compiled.get('base')!=pin or compiled.get('compiler',{}).get('version')!='1.3.14' or compiled['compiler'].get('platform')!='linux' or compiled['compiler'].get('architecture')!='arm64':raise ValueError('fresh native Linux client builder/base required')
    compiler=compiled['compiler']
    if set(compiler)!={'version','sha256','bytes','platform','architecture'} or not valid_hash(compiler['sha256']) or type(compiler['bytes']) is not int or not 1<=compiler['bytes']<=MAX_ARTIFACT:raise ValueError('utility client compiler identity')
    recipe={'flags':['--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--target=bun-linux-arm64','--compile-executable-path=linux-bun-base','--metafile=<entry>.metafile.json'],'cwd':'stage','source':'../source','environment':{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'}}
    if compiled.get('recipe')!=recipe:raise ValueError('utility client compile recipe')
    inputs=compiled.get('inputs')
    if type(inputs) is not dict or compiled.get('inputInventorySha256')!=sha(canonical(inputs).encode()) or {name.removeprefix('source/') for name in files if name.startswith('source/')}!=set(inputs):raise ValueError('compiled input closure')
    for name,item in inputs.items():
        relative(name);node=files['source/'+name]
        expected={key:node[key] for key in ('kind','target')} if node['kind']=='symlink' else {key:node[key] for key in ('kind','sha256','bytes')}
        if item!=expected:raise ValueError('compiled source measurement mismatch')
    output=compiled.get('outputs',{})
    if type(output) is not dict or set(output)!={'utilityClient'}:raise ValueError('utilityClient role required')
    output=output['utilityClient'];entry='scripts/guest-utilities/client.ts'
    if type(output) is not dict or set(output)!={'entry','sha256','bytes','bundledInputs','metafileSha256','command'}:raise ValueError('closed utility client output')
    command=['<compiler>','build','--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--target=bun-linux-arm64','--compile-executable-path=linux-bun-base','--metafile=utilityClient.metafile.json','../source/'+entry,'--outfile','<output>/utilityClient']
    if output.get('entry')!=entry or output.get('command')!=command or output.get('sha256')!=files['artifacts/utilityClient']['sha256'] or output.get('bytes')!=files['artifacts/utilityClient']['bytes'] or output.get('metafileSha256')!=files['artifacts/utilityClient.metafile.json']['sha256']:raise ValueError('utilityClient compile binding')
    bundled=output.get('bundledInputs')
    if type(bundled) is not dict or entry not in bundled or 'scripts/guest-utilities/smoke.sh' not in bundled or 'scripts/guest-utilities/descendant.py' not in bundled or any(inputs.get(name)!=item or item.get('kind')!='file' for name,item in bundled.items()):raise ValueError('utilityClient bundled graph')
    capture=value['utilityCapture']
    if type(capture) is not dict or capture.get('kind')!='winter-tool-utility-capture' or capture.get('target')!='linux-arm64-gnu' or any(capture.get(key) is not False for key in ('dependencyCompletenessVerified','linuxExecutionVerified','vmExecutionVerified','generalToolAvailabilityEnabled')):raise ValueError('utility capture cannot grant execution')
    capture_keys={'formatVersion','kind','target','inputs','inputManifestSha256','sources','builder','recipe','outputs','outputInventorySha256','dependencyCompletenessVerified','linuxExecutionVerified','vmExecutionVerified','generalToolAvailabilityEnabled'}
    if set(capture)!=capture_keys or type(capture['formatVersion']) is not int or capture['formatVersion']!=1 or capture['recipe']!={'operation':'held-fd-byte-copy','implicitDiscovery':False,'utilityExecution':False} or capture['recipe']['implicitDiscovery'] is not False or capture['recipe']['utilityExecution'] is not False:raise ValueError('utility capture recipe')
    utilities=capture.get('outputs')
    if type(utilities) is not dict or {name for name,item in utilities.items() if item.get('role')=='executable'}!=EXECUTABLES:raise ValueError('fixed utility ceiling')
    if {name.removeprefix('environment') for name in files if name.startswith('environment/')}!=set(utilities):raise ValueError('utility environment inventory')
    if capture.get('outputInventorySha256')!=sha(canonical(utilities).encode()):raise ValueError('utility output inventory hash')
    source_keys={'scripts/guest-utilities/closure.py','scripts/guest-utilities/oracle.py','scripts/guest-utilities/smoke.sh'}
    if type(capture['sources']) is not dict or set(capture['sources'])!=source_keys or any(capture['sources'][name]!={key:files['source/'+name][key] for key in ('sha256','bytes')} for name in source_keys):raise ValueError('utility capture source binding')
    origin_manifest={'formatVersion':1,'kind':'winter-tool-utility-inputs','target':'linux-arm64-gnu','files':capture['inputs']}
    if type(capture['inputs']) is not dict or set(capture['inputs'])!=set(utilities) or capture['inputManifestSha256']!=sha(canonical(origin_manifest).encode()):raise ValueError('utility origin input manifest')
    for name,item in utilities.items():
        if not isinstance(name,str) or not name.startswith('/') or type(item) is not dict or set(item)!={'role','sha256','bytes'}:raise ValueError('utility leaf schema')
        relative(name[1:]);role=item['role'];source=capture['inputs'][name]
        if type(source) is not dict or set(source)!={'role','source','sha256','bytes'} or {key:source[key] for key in ('role','sha256','bytes')}!=item:raise ValueError('utility input/output binding')
        relative(source['source'])
        if role=='executable':
            if name not in EXECUTABLES:raise ValueError('utility executable ceiling')
        elif role=='library':
            if name!='/lib/ld-linux-aarch64.so.1' and not re.fullmatch(r'/(?:usr/)?lib/aarch64-linux-gnu/[A-Za-z0-9_.+-]+\.so(?:\.[0-9.]+)?',name):raise ValueError('utility library ceiling')
        elif role in ('stdlib','extension'):
            if not name.startswith('/usr/lib/python3.12/') or any(part in ('test','tests','site-packages','dist-packages','ensurepip','__pycache__') for part in PurePosixPath(name).parts) or role=='stdlib' and not name.endswith('.py') or role=='extension' and not re.fullmatch(r'/usr/lib/python3\.12/lib-dynload/[A-Za-z0-9_.+-]+\.so',name):raise ValueError('utility Python ceiling')
        else:raise ValueError('utility role')
        node=files['environment'+name]
        if node['kind']!='file' or node['sha256']!=item.get('sha256') or node['bytes']!=item.get('bytes') or node['executable'] is not (item.get('role')=='executable'):raise ValueError('utility measured binding')
    native=value['nativeCompiler']
    if type(native) is not dict or set(native)!={'sha256','bytes','version'} or not valid_hash(native['sha256']) or type(native['bytes']) is not int or not 1<=native['bytes']<=MAX_ARTIFACT or not isinstance(native['version'],str) or not 1<=len(native['version'])<=512 or '/' in native['version']:raise ValueError('native compiler identity')
    commands=[['<native-compiler>','-std=c11','-O2','-Wall','-Wextra','-Werror','-static','packages/runtime/src/guest/'+source,'-o','<artifacts>/'+name] for name,source in [('toolLauncher','linux-tool-compartment.c'),('fileWorker','file-worker.c'),('processWorker','process-worker.c')]]
    if value['nativeCommands']!=commands:raise ValueError('native recipe')
    return directories


def read_archive(path,approved_archive,approved_receipt,parent_hash):
    if not all(valid_hash(value) for value in (approved_archive,approved_receipt,parent_hash)):raise ValueError('external approval hashes required')
    wire=read_path(path,MAX_ARCHIVE)
    if sha(wire)!=approved_archive:raise ValueError('external archive hash mismatch')
    entries={};total=0
    with tarfile.open(fileobj=io.BytesIO(wire),mode='r:gz') as archive:
        for member in archive:
            relative(member.name)
            if member.name in entries or len(entries)>=MAX_ENTRIES+1:raise ValueError('archive duplicate/inventory limit')
            if member.isfile():
                if not 0<=member.size<=MAX_ARTIFACT:raise ValueError('archive file limit')
                stream=archive.extractfile(member);data=stream.read(MAX_ARTIFACT+1);stream.close();total+=len(data)
                if len(data)!=member.size or total>MAX_TOTAL:raise ValueError('archive aggregate limit')
                entries[member.name]=data
            elif member.issym():entries[member.name]={'target':member.linkname}
            else:raise ValueError('archive directories/hardlinks/devices refused')
    receipt_wire=entries.pop('receipt.json',None)
    if not isinstance(receipt_wire,bytes) or sha(receipt_wire)!=approved_receipt:raise ValueError('external receipt hash mismatch')
    receipt=json_wire(receipt_wire);validate_receipt(receipt,parent_hash)
    if set(entries)!=set(receipt['files']):raise ValueError('archive exact closure inventory')
    for name,item in receipt['files'].items():
        data=entries[name]
        if item['kind']=='symlink':
            if data!={'target':item['target']}:raise ValueError('archive link bytes')
        elif not isinstance(data,bytes) or len(data)!=item['bytes'] or sha(data)!=item['sha256']:raise ValueError('archive measured bytes')
        elif name in {f'artifacts/{key}' for key in ARTIFACTS} and not elf(data):raise ValueError('ARM64 artifact required')
    metadata=json_wire(entries['artifacts/utilityClient.metafile.json'])
    bundled=receipt['compile']['outputs']['utilityClient']['bundledInputs']
    if type(metadata) is not dict or type(metadata.get('inputs')) is not dict or set(metadata['inputs'])!=set(bundled) or any(type(item) is not dict or item.get('bytes')!=bundled[name]['bytes'] for name,item in metadata['inputs'].items()):raise ValueError('metafile exact graph mismatch')
    if json_wire(entries['artifacts/utility-receipt.json'])!=receipt['utilityCapture']:raise ValueError('utility capture receipt binding')
    origin=json_wire(entries['artifacts/utility-origin-receipt.json'])
    if type(origin) is not dict or origin.get('kind')!='winter-utility-origin' or origin.get('manifestSha256')!=receipt['utilityCapture'].get('inputManifestSha256') or origin.get('utilityExecution') is not False or origin.get('dependencyCompletenessVerified') is not False:raise ValueError('utility origin binding')
    return receipt,receipt_wire,entries


def write_file(path,data,mode):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        at=0
        while at<len(data):
            count=os.write(fd,data[at:])
            if count<=0:raise ValueError('sealed write')
            at+=count
        os.fsync(fd);os.fchmod(fd,mode)
    finally:os.close(fd)


def trusted_ancestry(directory):
    for name in ('/','/tmp'):
        info=os.lstat(name)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)&0o022 and (name=='/' or not info.st_mode&stat.S_ISVTX):raise ValueError('trusted staging ancestry required')
    directory=Path(directory)
    if directory.parent!=Path('/tmp') or not directory.name.startswith(PREFIX):raise ValueError('fixed sealed staging ancestry')


def stage(receipt,wire,entries,parent_hash):
    if sys.platform!='linux' or os.geteuid()!=0:raise ValueError('admitted Linux root staging required')
    directories=validate_receipt(receipt,parent_hash)
    # Temporary allocation itself happens only after external archive+receipt checks.
    trusted_ancestry(Path('/tmp')/(PREFIX+'ancestry'))
    directory=Path(tempfile.mkdtemp(prefix=PREFIX,dir='/tmp'));directory.chmod(0o700)
    for name in sorted(directories,key=lambda value:(len(PurePosixPath(value).parts),value)):(directory/name).mkdir(mode=0o700)
    for name,item in receipt['files'].items():
        if item['kind']=='file':write_file(directory/name,entries[name],0o500 if item['executable'] else 0o400)
        else:os.symlink(item['target'],directory/name)
    write_file(directory/'receipt.json',wire,0o400)
    for name in sorted(directories,key=lambda value:len(PurePosixPath(value).parts),reverse=True):(directory/name).chmod(0o500)
    directory.chmod(0o500);verify_staged(directory,sha(wire),parent_hash);return directory


def verify_staged(directory,receipt_hash,parent_hash):
    trusted_ancestry(directory);root=open_root(directory)
    try:
        info=os.fstat(root)
        if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500:raise ValueError('immutable staging root')
        fd=leaf(root,'receipt.json')
        try:wire=read_fd(fd,MAX_JSON,True)
        finally:os.close(fd)
        if sha(wire)!=receipt_hash:raise ValueError('sealed receipt hash')
        receipt=json_wire(wire);directories=validate_receipt(receipt,parent_hash);observed=set();count=0
        def walk(folder,prefix=''):
            nonlocal count
            info=os.fstat(folder)
            if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500:raise ValueError('immutable staged directory')
            with os.scandir(folder) as scan:
                for entry in scan:
                    name=prefix+entry.name;relative(name);count+=1
                    if count>MAX_ENTRIES*3:raise ValueError('sealed inventory limit')
                    item=os.stat(entry.name,dir_fd=folder,follow_symlinks=False)
                    if item.st_uid!=0:raise ValueError('sealed owner')
                    if stat.S_ISDIR(item.st_mode):
                        if name not in directories:raise ValueError('unmeasured staged directory')
                        child=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder)
                        try:walk(child,name+'/')
                        finally:os.close(child)
                    else:
                        observed.add(name)
                        if name=='receipt.json':continue
                        expected=receipt['files'].get(name)
                        if expected is None:raise ValueError('unmeasured staged leaf')
                        if expected['kind']=='symlink':
                            if not stat.S_ISLNK(item.st_mode) or os.readlink(entry.name,dir_fd=folder)!=expected['target']:raise ValueError('sealed source link')
                        else:
                            fd=leaf(root,name)
                            try:data=read_fd(fd,MAX_ARTIFACT,True)
                            finally:os.close(fd)
                            if len(data)!=expected['bytes'] or sha(data)!=expected['sha256'] or stat.S_IMODE(item.st_mode)!=(0o500 if expected['executable'] else 0o400):raise ValueError('sealed measured bytes/mode')
        walk(root)
        if observed!=set(receipt['files'])|{'receipt.json'}:raise ValueError('sealed exact closure')
        return receipt
    finally:os.close(root)


def run_staged(directory,receipt_hash,parent_hash):
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:raise ValueError('isolated admitted Linux root runner required')
    receipt=verify_staged(directory,receipt_hash,parent_hash);root=open_root(directory)
    try:
        fd=leaf(root,RUNNER)
        try:wire=read_fd(fd,MAX_FILE,True)
        finally:os.close(fd)
        if sha(wire)!=receipt['files'][RUNNER]['sha256']:raise ValueError('sealed runner identity')
        class Admission:pass
        admission=Admission();admission.directory=str(directory);admission.root_fd=root;admission.receipt=receipt;admission.receipt_sha=receipt_hash;admission.parent_sha=parent_hash;admission.pid=os.getpid()
        sys._winter_utility_stage_admission=admission
        exec(compile(wire,str(Path(directory)/RUNNER),'exec'),{'__name__':'__main__','__file__':str(Path(directory)/RUNNER)})
    finally:os.close(root)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--archive',required=True);parser.add_argument('--approved-archive-sha256',required=True);parser.add_argument('--approved-receipt-sha256',required=True);parser.add_argument('--approved-parent-sha256',required=True);parser.add_argument('--run',action='store_true');args=parser.parse_args()
    if sha(read_path(__file__))!=args.approved_parent_sha256:raise SystemExit('externally approved parent bytes required')
    receipt,wire,entries=read_archive(args.archive,args.approved_archive_sha256,args.approved_receipt_sha256,args.approved_parent_sha256)
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:raise SystemExit('isolated admitted Linux root parent required')
    directory=stage(receipt,wire,entries,args.approved_parent_sha256)
    if args.run:run_staged(directory,args.approved_receipt_sha256,args.approved_parent_sha256)
    else:print(canonical({'staged':True,'stageDirectory':str(directory),'linuxExecutionVerified':False,'generalToolAvailabilityEnabled':False}))


if __name__=='__main__':main()

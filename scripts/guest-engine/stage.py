"""Externally hash-admitted stdlib-only parent. No repository imports or native effects during capture.
Unsigned receipts do not authorize privilege. Invoke only with independently approved parent/receipt
hashes through the documented isolated system-Python byte-check bootstrap. Root execution is separate.
"""
import argparse,hashlib,json,os,stat,subprocess,sys,tempfile
from pathlib import Path,PurePosixPath
NATIVE={'toolLauncher':'linux-tool-compartment.c','runtimeLauncher':'linux-runtime-compartment.c','fileWorker':'file-worker.c','processWorker':'process-worker.c','ownerLibrary':'linux-session-owner.c'}
ARTIFACTS=tuple(NATIVE)+('runtimeEntry','providerWorker')
METADATA=('receipt.json','compile-receipt.json','runtimeEntry.metafile.json','providerWorker.metafile.json')
ROOT_FILES=('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','tsconfig.typecheck.json','tsconfig.sdk-fence.json','bunfig.toml')
PARENT='scripts/guest-engine/stage.py'
RUNNER='scripts/guest-engine/verify.py'
REQUIRED_SOURCES=('packages/runtime/src/guest/linux-supervisor.py','packages/runtime/src/guest/linux-compartment.h',*[f'packages/runtime/src/guest/{name}' for name in NATIVE.values()],'packages/runtime/src/guest/linux-session-admission.ts','scripts/guest-engine/runtime.ts','scripts/guest-engine/provider.ts','scripts/guest-engine/compile.ts','scripts/build-runtime.ts','scripts/linux-runtime-base.json',RUNNER,'scripts/guest-engine/build.py','scripts/guest-engine/provenance.py',PARENT)
MAX_FILE=16*1024*1024;MAX_INPUT_BYTES=256*1024*1024;MAX_ARTIFACT=128*1024*1024;MAX_ARTIFACT_BYTES=256*1024*1024;MAX_JSON=16*1024*1024;MAX_ENTRIES=20000
PREFIX='winter-fresh-reviewed-'
ENV={'LANG':'C','LC_ALL':'C','PATH':'/usr/sbin:/usr/bin:/sbin:/bin','TZ':'UTC'}

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def digest_text(value):return hashlib.sha256(value.encode()).hexdigest()
def valid_hash(value):return isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value)
def relative_name(value):
    if not isinstance(value,str) or not value or len(value)>4096 or '\0' in value or '\\' in value:raise ValueError('closure path')
    path=PurePosixPath(value)
    if path.is_absolute() or str(path)!=value or any(part in ('.','..') for part in path.parts):raise ValueError('closure path')
    return value

def open_root(path):
    # Every original path component is nofollow; subsequent input reads use held dirFDs.
    path=Path(os.path.abspath(path));fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for name in path.parts[1:]:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd);os.close(fd);fd=child
        return fd
    except BaseException:os.close(fd);raise

def leaf(root,name,flags=os.O_RDONLY):
    relative_name(name);parts=name.split('/');folder=os.dup(root)
    try:
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);os.close(folder);folder=child
        return os.open(parts[-1],flags|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder)
    finally:os.close(folder)

def measure(root,name,limit,expected=None,retain=False,immutable=False,unique=True):
    fd=leaf(root,name)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or (unique or immutable) and before.st_nlink!=1 or before.st_size>limit or (immutable and (before.st_uid!=0 or stat.S_IMODE(before.st_mode) not in (0o400,0o500))):raise ValueError('closure leaf identity/limit')
        hash=hashlib.sha256();count=0;chunks=[]
        while True:
            data=os.read(fd,min(65536,limit-count+1))
            if not data:break
            count+=len(data)
            if count>limit:raise ValueError('closure leaf limit')
            hash.update(data)
            if retain:chunks.append(data)
        after=os.fstat(fd)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or count!=before.st_size:raise ValueError('closure leaf changed')
        actual={'sha256':hash.hexdigest(),'bytes':count}
        if expected is not None and (not valid_hash(expected) or actual['sha256']!=expected):raise ValueError('closure bytes changed')
        return b''.join(chunks) if retain else actual
    finally:os.close(fd)

def json_wire(wire):
    def unique(pairs):
        output={}
        for key,value in pairs:
            if key in output:raise ValueError('duplicate receipt field')
            output[key]=value
        return output
    if len(wire)>MAX_JSON:raise ValueError('receipt limit')
    return json.loads(wire,object_pairs_hook=unique)

def link_target(root,name):
    relative_name(name);parts=name.split('/');folder=os.dup(root)
    try:
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);os.close(folder);folder=child
        value=os.readlink(parts[-1],dir_fd=folder)
        if not value or len(value)>4096 or PurePosixPath(value).is_absolute() or '\0' in value or '\\' in value:raise ValueError('closure symlink')
        target=os.path.normpath(str(PurePosixPath(name).parent/value))
        if target=='..' or target.startswith('../') or target.startswith('/'):raise ValueError('closure symlink escape')
        return value,target
    finally:os.close(folder)

def current_inputs(root):
    result={};total=0;visits=0
    def walk(fd,prefix):
        nonlocal total,visits
        with os.scandir(fd) as stream:
            for entry in stream:
                name=entry.name
                if name in ('.git','__pycache__','.DS_Store'):continue
                relative=prefix+name;relative_name(relative);visits+=1
                if visits>MAX_ENTRIES*3:raise ValueError('current inventory limit')
                info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                    try:walk(child,relative+'/')
                    finally:os.close(child)
                elif stat.S_ISLNK(info.st_mode):result[relative]={'kind':'symlink','target':link_target(root,relative)[0]}
                elif stat.S_ISREG(info.st_mode):
                    item=measure(root,relative,MAX_FILE,unique=False);total+=item['bytes'];result[relative]={'kind':'file',**item}
                else:raise ValueError('current inventory type')
                if len(result)>MAX_ENTRIES or total>MAX_INPUT_BYTES:raise ValueError('current inventory limit')
    for name in ROOT_FILES:
        item=measure(root,name,MAX_FILE,unique=False);total+=item['bytes'];result[name]={'kind':'file',**item}
    for name in ('packages','scripts','node_modules'):
        fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
        try:walk(fd,name+'/')
        finally:os.close(fd)
    return result

def resolve_link(name,inputs,directories):
    target=name;seen=set()
    for _ in range(40):
        parts=target.split('/');changed=False
        for count in range(1,len(parts)+1):
            prefix='/'.join(parts[:count]);item=inputs.get(prefix,{})
            if item.get('kind')!='symlink':continue
            if prefix in seen:raise ValueError('input link cycle')
            seen.add(prefix);target=os.path.normpath(str(PurePosixPath(prefix).parent/item['target'])+('/'+'/'.join(parts[count:]) if count<len(parts) else ''))
            if target=='..' or target.startswith('../') or target.startswith('/'):raise ValueError('input link escape')
            changed=True;break
        if not changed:
            if target not in inputs and target not in directories:raise ValueError('input link target outside closure')
            return target
    raise ValueError('input link depth')

def validate_manifests(native,compiled):
    native_keys={'formatVersion','sources','artifacts','compileReceiptSha256','nativeBuildCommands','nativeCompiler','nativeBuildEnvironment','linuxExecutionVerified','vmExecutionVerified'}
    compile_keys={'formatVersion','kind','inputs','inputInventorySha256','compiler','base','recipe','outputs','linuxExecutionVerified','vmExecutionVerified'}
    if type(native) is not dict or set(native)!=native_keys or type(native['formatVersion']) is not int or native['formatVersion']!=2 or type(compiled) is not dict or set(compiled)!=compile_keys or type(compiled['formatVersion']) is not int or compiled['formatVersion']!=1 or compiled['kind']!='winter-fresh-engine-compile':raise ValueError('closed receipt shape')
    for receipt in (native,compiled):
        if receipt['linuxExecutionVerified'] is not False or receipt['vmExecutionVerified'] is not False:raise ValueError('receipt cannot establish execution approval')
    inputs=compiled['inputs']
    if type(inputs) is not dict or not 1<=len(inputs)<=MAX_ENTRIES or digest_text(canonical(inputs))!=compiled['inputInventorySha256']:raise ValueError('input inventory')
    directories=set();total=0
    for name,item in inputs.items():
        relative_name(name)
        if name not in ROOT_FILES and name.split('/')[0] not in ('packages','scripts','node_modules'):raise ValueError('input root')
        directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent)!='.')
        if type(item) is not dict:raise ValueError('input shape')
        if item.get('kind')=='file':
            if set(item)!={'kind','sha256','bytes'} or not valid_hash(item['sha256']) or type(item['bytes']) is not int or not 0<=item['bytes']<=MAX_FILE:raise ValueError('input file shape/limit')
            total+=item['bytes']
        elif item.get('kind')=='symlink':
            if set(item)!={'kind','target'} or not isinstance(item['target'],str) or not item['target'] or len(item['target'])>4096 or '\0' in item['target'] or '\\' in item['target'] or PurePosixPath(item['target']).is_absolute():raise ValueError('input link shape')
        else:raise ValueError('input kind')
    if total>MAX_INPUT_BYTES or not set(ROOT_FILES)<=set(inputs) or not set(REQUIRED_SOURCES)<=set(inputs):raise ValueError('input closure required/limit')
    if directories&set(inputs):raise ValueError('input prefix collision')
    for name,item in inputs.items():
        if item['kind']=='symlink':
            target=os.path.normpath(str(PurePosixPath(name).parent/item['target']))
            if target=='..' or target.startswith('../') or target.startswith('/'):raise ValueError('input link target outside closure')
            resolve_link(name,inputs,directories)
    sources=native['sources']
    if type(sources) is not dict or not set(REQUIRED_SOURCES)<=set(sources) or not 1<=len(sources)<=MAX_ENTRIES:raise ValueError('native source closure')
    for name,expected in sources.items():
        relative_name(name)
        if inputs.get(name,{}).get('kind')!='file' or inputs[name]['sha256']!=expected:raise ValueError('native source outside compiled closure')
    if type(native['artifacts']) is not dict or set(native['artifacts'])!=set(ARTIFACTS) or not all(valid_hash(value) for value in native['artifacts'].values()):raise ValueError('native artifact closure')
    pin={'version':'1.3.14','target':'bun-linux-arm64','sha256':'37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086'}
    compiler=compiled['compiler']
    if type(compiler) is not dict or set(compiler)!={'version','sha256','bytes','platform','architecture'} or compiler['version']!=pin['version'] or compiler['platform']!='linux' or compiler['architecture']!='arm64' or not valid_hash(compiler['sha256']) or type(compiler['bytes']) is not int or not 1<=compiler['bytes']<=MAX_ARTIFACT:raise ValueError('fresh Linux ARM64 compilation required')
    expected_recipe={'flags':['--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--target=bun-linux-arm64','--compile-executable-path=linux-bun-base','--metafile=<entry>.metafile.json'],'cwd':'stage','source':'../source','environment':{'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'}}
    if compiled['base']!=pin or compiled['recipe']!=expected_recipe:raise ValueError('compile recipe/base')
    outputs=compiled['outputs']
    if type(outputs) is not dict or set(outputs)!={'runtimeEntry','providerWorker'}:raise ValueError('compile outputs')
    for name,output in outputs.items():
        entry=f"scripts/guest-engine/{'runtime' if name=='runtimeEntry' else 'provider'}.ts"
        if type(output) is not dict or set(output)!={'entry','sha256','bytes','bundledInputs','metafileSha256','command'} or output['entry']!=entry or output['sha256']!=native['artifacts'][name] or type(output['bytes']) is not int or not 20<=output['bytes']<=MAX_ARTIFACT or not valid_hash(output['metafileSha256']):raise ValueError('compiled artifact binding')
        command=['<compiler>','build','--compile','--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--target=bun-linux-arm64','--compile-executable-path=linux-bun-base',f'--metafile={name}.metafile.json',f'../source/{entry}','--outfile',f'<output>/{name}']
        bundled=output['bundledInputs']
        if output['command']!=command or type(bundled) is not dict or not 1<=len(bundled)<=MAX_ENTRIES or entry not in bundled or any(inputs.get(path)!=item or item.get('kind')!='file' for path,item in bundled.items()):raise ValueError('bundled compile closure')
    native_compiler=native['nativeCompiler']
    if type(native_compiler) is not dict or set(native_compiler)!={'sha256','bytes','version'} or not valid_hash(native_compiler['sha256']) or type(native_compiler['bytes']) is not int or not 1<=native_compiler['bytes']<=MAX_ARTIFACT or not isinstance(native_compiler['version'],str) or not 1<=len(native_compiler['version'])<=512 or '/' in native_compiler['version']:raise ValueError('native compiler identity')
    commands=[['<native-compiler>','-std=c11','-O2','-Wall','-Wextra','-Werror',*(['-shared','-fPIC'] if name=='ownerLibrary' else ['-static']),f'packages/runtime/src/guest/{source}','-o',f'<artifacts>/{name}'] for name,source in NATIVE.items()]
    if native['nativeBuildCommands']!=commands or native['nativeBuildEnvironment']!={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC'}:raise ValueError('native recipe')
    return directories

class Snapshot:
    def __init__(self,source,artifacts,native,compiled,wire,approved,parent_sha):
        self.source=source;self.artifacts=artifacts;self.native=native;self.compiled=compiled;self.wire=wire;self.approved=approved;self.parent_sha=parent_sha
    def close(self):
        for name in ('source','artifacts'):
            fd=getattr(self,name)
            if fd is not None:os.close(fd);setattr(self,name,None)
    def __enter__(self):return self
    def __exit__(self,*args):self.close()

def check_snapshot(snapshot,immutable=False):
    directories=validate_manifests(snapshot.native,snapshot.compiled);total=0
    if current_inputs(snapshot.source)!=snapshot.compiled['inputs']:raise ValueError('current source/dependency inventory changed')
    for name,item in snapshot.compiled['inputs'].items():
        if item['kind']=='file':
            actual=measure(snapshot.source,name,MAX_FILE,item['sha256'],immutable=immutable,unique=False)
            if actual['bytes']!=item['bytes']:raise ValueError('input size changed')
        else:
            target,_=link_target(snapshot.source,name)
            if target!=item['target']:raise ValueError('input link changed')
    for name in ARTIFACTS:
        actual=measure(snapshot.artifacts,name,MAX_ARTIFACT,snapshot.native['artifacts'][name],immutable=immutable);total+=actual['bytes']
        fd=leaf(snapshot.artifacts,name)
        try:header=os.read(fd,20)
        finally:os.close(fd)
        if len(header)!=20 or header[:6]!=b'\x7fELF\x02\x01' or int.from_bytes(header[18:20],'little')!=183:raise ValueError('ARM64 native artifact required')
        if name in snapshot.compiled['outputs'] and actual['bytes']!=snapshot.compiled['outputs'][name]['bytes']:raise ValueError('compiled artifact size')
    if total>MAX_ARTIFACT_BYTES:raise ValueError('artifact aggregate limit')
    for name in ('runtimeEntry','providerWorker'):
        output=snapshot.compiled['outputs'][name];meta=json_wire(measure(snapshot.artifacts,f'{name}.metafile.json',MAX_JSON,output['metafileSha256'],retain=True,immutable=immutable))
        if type(meta) is not dict or type(meta.get('inputs')) is not dict or set(meta['inputs'])!=set(output['bundledInputs']):raise ValueError('metafile bundled closure')
        for path,item in meta['inputs'].items():
            if type(item) is not dict or type(item.get('bytes')) is not int or item['bytes']!=output['bundledInputs'][path]['bytes']:raise ValueError('metafile input size')
    return directories

def own_parent_hash():
    path=Path(__file__).resolve();directory=open_root(path.parent)
    try:return measure(directory,path.name,MAX_FILE,unique=False)['sha256']
    finally:os.close(directory)

def capture(source,artifacts,receipt_path,approved_digest):
    if not valid_hash(approved_digest):raise ValueError('external approved receipt digest required')
    source_fd=artifact_fd=receipt_fd=None
    try:
        source_fd=open_root(source);artifact_fd=open_root(artifacts);receipt_fd=open_root(Path(receipt_path).parent)
        wire=measure(receipt_fd,Path(receipt_path).name,MAX_JSON,approved_digest,retain=True);native=json_wire(wire)
        if type(native) is not dict or not valid_hash(native.get('compileReceiptSha256')):raise ValueError('native receipt shape')
        compiled=json_wire(measure(artifact_fd,'compile-receipt.json',MAX_JSON,native['compileReceiptSha256'],retain=True))
        parent_sha=own_parent_hash()
        snapshot=Snapshot(source_fd,artifact_fd,native,compiled,wire,approved_digest,parent_sha);check_snapshot(snapshot)
        if native['sources'].get(PARENT)!=parent_sha:raise ValueError('externally admitted parent/source mismatch')
        source_fd=artifact_fd=None;return snapshot
    finally:
        for fd in (source_fd,artifact_fd,receipt_fd):
            if fd is not None:os.close(fd)

def trusted_staging_ancestry(directory=None):
    for name in ('/','/tmp'):
        info=os.lstat(name)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)&0o022 and (name=='/' or not info.st_mode&stat.S_ISVTX):raise ValueError('untrusted staging ancestry')
    if directory is not None:
        directory=Path(directory)
        if directory.parent!=Path('/tmp') or not directory.name.startswith(PREFIX):raise ValueError('untrusted staging ancestry')

def copy_leaf(source,name,destination,expected,limit,mode):
    src=leaf(source,name);dst=None
    try:
        dst=os.open(destination,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        before=os.fstat(src)
        if not stat.S_ISREG(before.st_mode) or mode==0o500 and before.st_nlink!=1 or before.st_size>limit:raise ValueError('copy input identity')
        hash=hashlib.sha256();count=0
        while True:
            data=os.read(src,min(65536,limit-count+1))
            if not data:break
            count+=len(data)
            if count>limit:raise ValueError('copy input limit')
            hash.update(data);at=0
            while at<len(data):
                written=os.write(dst,data[at:])
                if written<=0:raise ValueError('staging write')
                at+=written
        after=os.fstat(src)
        if hash.hexdigest()!=expected or count!=before.st_size or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('copy input changed')
        os.fsync(dst);os.fchmod(dst,mode)
    finally:
        os.close(src)
        if dst is not None:os.close(dst)

def stage(snapshot):
    if os.geteuid()!=0:raise ValueError('Root-owned staging required')
    trusted_staging_ancestry();check_snapshot(snapshot)
    directory=Path(tempfile.mkdtemp(prefix=PREFIX,dir='/tmp'));directory.chmod(0o700)
    source=directory/'source';artifacts=directory/'artifacts';source.mkdir(mode=0o700);artifacts.mkdir(mode=0o700)
    dirs=validate_manifests(snapshot.native,snapshot.compiled)
    for name in sorted(dirs,key=lambda item:(len(PurePosixPath(item).parts),item)):(source/name).mkdir(mode=0o700)
    # All capture/copy failures retain the partial Root-owned tree, never launch a runner.
    for name,item in snapshot.compiled['inputs'].items():
        if item['kind']=='file':copy_leaf(snapshot.source,name,source/name,item['sha256'],MAX_FILE,0o400)
        else:
            target,_=link_target(snapshot.source,name)
            if target!=item['target']:raise ValueError('copy link changed')
            os.symlink(target,source/name)
    for name in ARTIFACTS:copy_leaf(snapshot.artifacts,name,artifacts/name,snapshot.native['artifacts'][name],MAX_ARTIFACT,0o500)
    metadata={'compile-receipt.json':snapshot.native['compileReceiptSha256'],**{f'{name}.metafile.json':snapshot.compiled['outputs'][name]['metafileSha256'] for name in ('runtimeEntry','providerWorker')}}
    for name,expected in metadata.items():copy_leaf(snapshot.artifacts,name,artifacts/name,expected,MAX_JSON,0o400)
    receipt=artifacts/'receipt.json';fd=os.open(receipt,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,0o400)
    try:
        at=0
        while at<len(snapshot.wire):
            written=os.write(fd,snapshot.wire[at:])
            if written<=0:raise ValueError('staging receipt write')
            at+=written
        os.fsync(fd)
    finally:os.close(fd)
    for name in sorted(dirs,key=lambda item:len(PurePosixPath(item).parts),reverse=True):(source/name).chmod(0o500)
    source.chmod(0o500);artifacts.chmod(0o500);directory.chmod(0o500)
    verify_staged(directory,snapshot.approved,snapshot.parent_sha);return directory

def inventory_staged(root,immutable=True):
    result={};count=0
    def walk(fd,prefix=''):
        nonlocal count
        info=os.fstat(fd)
        if immutable and (info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500):raise ValueError('immutable staged directory required')
        with os.scandir(fd) as stream:
            for entry in stream:
                name=entry.name
                relative=prefix+name;relative_name(relative);count+=1
                if count>MAX_ENTRIES*3:raise ValueError('staged inventory limit')
                item=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if immutable and item.st_uid!=0:raise ValueError('immutable staged owner')
                if stat.S_ISDIR(item.st_mode):
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                    try:walk(child,relative+'/')
                    finally:os.close(child)
                elif stat.S_ISLNK(item.st_mode):result[relative]={'kind':'symlink','target':os.readlink(name,dir_fd=fd)}
                elif stat.S_ISREG(item.st_mode):result[relative]={'kind':'file',**measure(root,relative,MAX_ARTIFACT,immutable=immutable)}
                else:raise ValueError('staged entry type')
    walk(root);return result

def stage_root_names(fd):
    names=set()
    with os.scandir(fd) as stream:
        for entry in stream:
            names.add(entry.name)
            if len(names)>2:raise ValueError('staged root inventory')
    return names

def verify_staged(directory,approved_digest,parent_sha):
    trusted_staging_ancestry(directory)
    root=open_root(directory);source=artifacts=None
    try:
        info=os.fstat(root)
        if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500 or stage_root_names(root)!={'source','artifacts'}:raise ValueError('immutable staged root required')
        source=os.open('source',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root);artifacts=os.open('artifacts',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
        wire=measure(artifacts,'receipt.json',MAX_JSON,approved_digest,retain=True,immutable=True);native=json_wire(wire);compiled=json_wire(measure(artifacts,'compile-receipt.json',MAX_JSON,native['compileReceiptSha256'],retain=True,immutable=True))
        snapshot=Snapshot(source,artifacts,native,compiled,wire,approved_digest,parent_sha);check_snapshot(snapshot,immutable=True)
        if native['sources'].get(PARENT)!=parent_sha or inventory_staged(source)!=compiled['inputs'] or set(inventory_staged(artifacts))!=set((*ARTIFACTS,*METADATA)):raise ValueError('immutable staged closure inventory')
        return native
    finally:
        for fd in (source,artifacts,root):
            if fd is not None:os.close(fd)

BOOTSTRAP=r'''
import hashlib,os,stat,sys
from pathlib import Path
root=Path(sys.argv[1]);receipt_sha=sys.argv[2];parent_sha=sys.argv[3]
if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:raise SystemExit('isolated Root Linux bootstrap required')
for name in ('/','/tmp'):
 info=os.lstat(name)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)&0o022 and (name=='/' or not info.st_mode&stat.S_ISVTX):raise SystemExit('bootstrap ancestry')
if root.parent!=Path('/tmp') or not root.name.startswith('winter-fresh-reviewed-'):raise SystemExit('bootstrap ancestry')
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);info=os.fstat(fd)
if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500:raise SystemExit('bootstrap immutable root')
parent=root/'source/scripts/guest-engine/stage.py'
folder=os.dup(fd)
try:
 for name in ('source','scripts','guest-engine'):
  child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);os.close(folder);folder=child
  st=os.fstat(folder)
  if st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o500:raise SystemExit('bootstrap immutable source')
 leaf=os.open('stage.py',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder)
 try:
  st=os.fstat(leaf)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=0o400 or st.st_size>16*1024*1024:raise SystemExit('bootstrap parent identity')
  wire=os.pread(leaf,16*1024*1024+1,0)
 finally:os.close(leaf)
finally:os.close(folder)
if len(wire)!=st.st_size or hashlib.sha256(wire).hexdigest()!=parent_sha:raise SystemExit('bootstrap parent hash')
trusted={'__name__':'winter_fresh_trusted_parent','__file__':str(parent)}
exec(compile(wire,str(parent),'exec'),trusted)
native=trusted['verify_staged'](root,receipt_sha,parent_sha)
wire=trusted['measure'](fd,'source/scripts/guest-engine/verify.py',16*1024*1024,native['sources']['scripts/guest-engine/verify.py'],retain=True,immutable=True)
class Admission:pass
admission=Admission();admission.directory=str(root);admission.directory_fd=fd;admission.identity=(info.st_dev,info.st_ino);admission.receipt_sha=receipt_sha;admission.parent_sha=parent_sha;admission.verify_sha=native['sources']['scripts/guest-engine/verify.py'];admission.pid=os.getpid()
sys._winter_fresh_stage_admission=admission
runner=root/'source/scripts/guest-engine/verify.py'
sys.argv=[str(runner),'--artifacts',str(root/'artifacts'),'--reviewed-receipt',str(root/'artifacts/receipt.json')]
try:exec(compile(wire,str(runner),'exec'),{'__name__':'__main__','__file__':str(runner)})
finally:os.close(fd)
'''

def system_python():
    path=Path('/usr/bin/python3').resolve()
    for name in (*reversed(path.parents),path):
        info=os.lstat(name)
        if info.st_uid!=0 or stat.S_IMODE(info.st_mode)&0o022 or not (stat.S_ISDIR(info.st_mode) or name==path and stat.S_ISREG(info.st_mode)):raise ValueError('trusted system Python required')
    return str(path)

def run_staged(directory,approved_digest,parent_sha):
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:raise ValueError('isolated Root Linux runner required')
    verify_staged(directory,approved_digest,parent_sha)
    return subprocess.run([system_python(),'-I','-S','-B','-c',BOOTSTRAP,str(directory),approved_digest,parent_sha],cwd='/tmp',env=ENV,check=False).returncode

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,required=True);parser.add_argument('--artifacts',type=Path,required=True);parser.add_argument('--receipt',type=Path,required=True);parser.add_argument('--approved-receipt-sha256',required=True);parser.add_argument('--approved-parent-sha256',required=True);args=parser.parse_args()
    if not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:raise SystemExit('isolated stdlib-only parent required')
    if not valid_hash(args.approved_parent_sha256) or own_parent_hash()!=args.approved_parent_sha256:raise SystemExit('external parent admission mismatch')
    with capture(args.source,args.artifacts,args.receipt,args.approved_receipt_sha256) as snapshot:
        directory=stage(snapshot);print(json.dumps({'staged':True,'stagingId':directory.name,'approvedReceiptSha256':snapshot.approved}),flush=True)
        return run_staged(directory,snapshot.approved,snapshot.parent_sha)
if __name__=='__main__':raise SystemExit(main())

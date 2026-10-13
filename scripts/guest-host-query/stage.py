"""Externally hash-admitted stdlib-only parent. No repository imports or native effects during capture.
Unsigned receipts do not authorize privilege. Invoke only with independently approved parent/receipt
hashes through the documented isolated system-Python byte-check bootstrap. Root execution is separate.
"""
import argparse,hashlib,json,os,re,stat,struct,subprocess,sys,tempfile
from pathlib import Path,PurePosixPath
NATIVE={'toolLauncher':'linux-tool-compartment.c','runtimeLauncher':'linux-runtime-compartment.c','fileWorker':'file-worker.c','processWorker':'process-worker.c','ownerLibrary':'linux-session-owner.c'}
ENTRIES={'runtimeEntry':'runtime.ts','providerWorker':'provider.ts','hostClient':'host-client.ts'}
ARTIFACTS=tuple(NATIVE)+tuple(ENTRIES)
METADATA=('receipt.json','utility-receipt.json','utility-origin-receipt.json','compile-receipt.json',*(name+'.metafile.json' for name in ENTRIES))
ROOT_FILES=('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json','tsconfig.typecheck.json','tsconfig.sdk-fence.json','bunfig.toml')
PARENT='scripts/guest-host-query/stage.py'
RUNNER='scripts/guest-host-query/verify.py'
REQUIRED_SOURCES=('packages/runtime/src/guest/linux-supervisor.py','packages/runtime/src/guest/linux-compartment.h',*[f'packages/runtime/src/guest/{name}' for name in NATIVE.values()],'packages/runtime/src/guest/linux-session-admission.ts','scripts/guest-host-query/runtime.ts','scripts/guest-host-query/provider.ts','scripts/guest-host-query/host-client.ts','scripts/guest-host-query/cases.ts','scripts/guest-host-query/compile.ts','scripts/build-runtime.ts','scripts/linux-runtime-base.json',RUNNER,'scripts/guest-host-query/build.py','scripts/guest-host-query/provenance.py','scripts/guest-engine/verify.py',PARENT)
MAX_ENV_FILE=32*1024*1024;MAX_ENV_BYTES=128*1024*1024;MAX_ENV_ENTRIES=2048;MAX_COMBINED_BYTES=768*1024*1024
MAX_FILE=16*1024*1024;MAX_INPUT_BYTES=256*1024*1024;MAX_ARTIFACT=128*1024*1024;MAX_ARTIFACT_BYTES=384*1024*1024;MAX_JSON=16*1024*1024;MAX_ENTRIES=20000
UTILITY_SOURCES=('scripts/guest-utilities/utility_inputs.py','scripts/guest-utilities/closure.py','scripts/guest-utilities/stdlib_graph.py','scripts/guest-utilities/smoke.sh','scripts/guest-utilities/descendant.py','scripts/guest-utilities/oracle.py','scripts/guest-host-query/utility-environment.py','scripts/guest-host-query/utility-data.py','scripts/guest-host-query/utilities.sh','scripts/guest-host-query/utilities-plan.sh')
REQUIRED_SOURCES=(*REQUIRED_SOURCES,*UTILITY_SOURCES)
PREFIX='winter-host-query-reviewed-'
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
        # A FIFO must refuse before waiting for a writer, including if a checked
        # regular input is substituted between inventory and copy.
        fd=os.open(parts[-1],flags|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,dir_fd=folder)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('closure leaf type')
            return fd
        except BaseException:os.close(fd);raise
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

def elf_dependencies(fd):
    size=os.fstat(fd).st_size
    def read(offset,count):
        if type(offset)!=int or type(count)!=int or offset<0 or count<0 or offset+count>size or count>1024*1024:raise ValueError('ELF metadata bound')
        wire=os.pread(fd,count,offset)
        if len(wire)!=count:raise ValueError('ELF metadata truncated')
        return wire
    header=read(0,64)
    if header[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<H',header,18)[0]!=183:raise ValueError('ARM64 ELF metadata')
    offset=struct.unpack_from('<Q',header,32)[0];stride,count=struct.unpack_from('<HH',header,54)
    if stride!=56 or count>256:raise ValueError('ELF program table')
    loads=[];dynamic=None;interpreter=None
    for index in range(count):
        kind,flags,start,address,physical,length,memory,align=struct.unpack('<IIQQQQQQ',read(offset+index*stride,stride))
        if start+length>size:raise ValueError('ELF segment')
        if kind==1:loads.append((address,length,start))
        if kind==2:
            if dynamic is not None or length>65536 or length%16:raise ValueError('ELF dynamic table')
            dynamic=(start,length)
        if kind==3:
            if interpreter is not None or not 2<=length<=256:raise ValueError('ELF interpreter')
            value=read(start,length)
            if value[-1:]!=b'\0' or b'\0' in value[:-1]:raise ValueError('ELF interpreter string')
            interpreter=value[:-1].decode('ascii')
    needed=[];strings=None;string_size=None
    if dynamic:
        ended=False
        for pos in range(dynamic[0],dynamic[0]+dynamic[1],16):
            tag,value=struct.unpack('<qQ',read(pos,16))
            if tag==0:ended=True;break
            if tag==1:
                needed.append(value)
                if len(needed)>128:raise ValueError('ELF dependencies limit')
            if tag in (5,10):
                if tag==5:
                    if strings is not None:raise ValueError('ELF duplicate strtab')
                    strings=value
                else:
                    if string_size is not None:raise ValueError('ELF duplicate strsz')
                    string_size=value
        if not ended:raise ValueError('ELF dynamic end')
    names=[];soname=None;rpath=None;runpath=None
    if needed or dynamic:
        extra=[]
        if dynamic:
            for pos in range(dynamic[0],dynamic[0]+dynamic[1],16):
                tag,value=struct.unpack('<qQ',read(pos,16))
                if tag==0:break
                if tag in (14,15,29):extra.append((tag,value))
        if not needed and not extra:return {'type':struct.unpack_from('<H',header,16)[0],'interpreter':interpreter,'needed':[],'soname':None,'rpath':None,'runpath':None}

        if strings is None or string_size is None or not 1<=string_size<=1024*1024:raise ValueError('ELF string table')
        mappings=[start+strings-address for address,length,start in loads if address<=strings and strings+string_size<=address+length]
        if len(mappings)!=1:raise ValueError('ELF string mapping')
        wire=read(mappings[0],string_size)
        for offset in needed:
            if offset>=len(wire):raise ValueError('ELF dependency offset')
            end=wire.find(b'\0',offset)
            if end<0 or end-offset>256:raise ValueError('ELF dependency string')
            name=wire[offset:end].decode('ascii')
            if not re.fullmatch(r'[A-Za-z0-9_.+-]+\.so(?:\.[0-9.]+)?',name) or name in names:raise ValueError('ELF dependency name')
            names.append(name)
        for tag,offset in extra:
            if offset>=len(wire):raise ValueError('ELF string offset')
            end=wire.find(b'\0',offset)
            if end<0 or end-offset>256:raise ValueError('ELF string bounds')
            value=wire[offset:end].decode('ascii')
            if tag==14:
                if soname is not None:raise ValueError('ELF duplicate SONAME')
                soname=value
            if tag==15:
                if rpath is not None:raise ValueError('ELF duplicate RPATH')
                rpath=value
            if tag==29:
                if runpath is not None:raise ValueError('ELF duplicate RUNPATH')
                runpath=value
    return {'type':struct.unpack_from('<H',header,16)[0],'interpreter':interpreter,'needed':names,'soname':soname,'rpath':rpath,'runpath':runpath}

UTILITY_PROGRAMS=frozenset(('/bin/bash','/bin/cat','/usr/bin/git','/usr/bin/python3','/usr/bin/openssl','/usr/bin/mktemp'))
UTILITY_LOADERS=frozenset(('/lib/ld-linux-aarch64.so.1','/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1'))
def phase_b_fragment_records(wires):
    records=[]
    pattern=r"(?m)^python3[ \t]+(?:-c[ \t]+'([^']*)'|-[ \t]+<<'PY'\n(.*?)\nPY(?=\n|$))"
    for wire in wires:
        if type(wire)!=bytes or len(wire)>MAX_FILE:raise ValueError('bounded Phase B payload')
        text=wire.decode('utf-8');matches=list(re.finditer(pattern,text,re.S))
        if not matches or {match.start() for match in matches}!={match.start() for match in re.finditer(r'(?m)^python3\b',text)}:raise ValueError('fixed Phase B Python grammar')
        for match in matches:
            data=(match.group(1) if match.group(1) is not None else match.group(2)).encode()
            records.append({'id':'test:'+str(len(records)+1),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
    return records

def validate_environment(native,compiled):
    capture=native['utilityCapture'];origin=native['utilityOrigin'];outputs=native['environment']
    keys={'formatVersion','kind','target','inputs','inputManifestSha256','sources','builder','recipe','outputs','outputInventorySha256','dependencyCompletenessVerified','linuxExecutionVerified','vmExecutionVerified','generalToolAvailabilityEnabled'}
    if type(capture)!=dict or set(capture)!=keys or type(capture['formatVersion'])!=int or capture['formatVersion']!=1 or capture['kind']!='winter-tool-utility-capture' or capture['target']!='linux-arm64-gnu':raise ValueError('closed utility capture')
    if any(capture[key] is not False for key in ('dependencyCompletenessVerified','linuxExecutionVerified','vmExecutionVerified','generalToolAvailabilityEnabled')) or capture['recipe']!={'operation':'held-fd-byte-copy','implicitDiscovery':False,'utilityExecution':False}:raise ValueError('capture cannot grant execution')
    builder=capture['builder']
    if type(builder)!=dict or set(builder)!={'sha256','bytes','version','platform','architecture'} or not valid_hash(builder['sha256']) or type(builder['bytes'])!=int or not 1<=builder['bytes']<=MAX_ENV_BYTES or builder['platform']!='linux' or builder['architecture']!='aarch64' or type(builder['version'])!=str or not re.fullmatch(r'3\.12\.[0-9]+',builder['version']):raise ValueError('utility collector identity')
    if type(outputs)!=dict or not 8<=len(outputs)<=MAX_ENV_ENTRIES or outputs!=capture['outputs'] or digest_text(canonical(outputs))!=capture['outputInventorySha256']:raise ValueError('utility environment inventory')
    manifest={'formatVersion':1,'kind':'winter-tool-utility-inputs','target':'linux-arm64-gnu','files':capture['inputs']}
    if type(capture['inputs'])!=dict or set(capture['inputs'])!=set(outputs) or digest_text(canonical(manifest))!=capture['inputManifestSha256']:raise ValueError('utility input manifest')
    total=0;directories=set();programs=set()
    for guest,item in outputs.items():
        if type(guest)!=str or not guest.startswith('/') or type(item)!=dict or set(item)!={'role','executable','bytes','sha256'}:raise ValueError('utility leaf')
        relative_name(guest[1:]);total+=item['bytes'] if type(item.get('bytes')) is int else MAX_ENV_BYTES+1
        if type(item['bytes'])!=int or not 1<=item['bytes']<=MAX_ENV_FILE or not valid_hash(item['sha256']):raise ValueError('utility measurement')
        role=item['role'];executable=role=='executable' or role=='library' and guest in UTILITY_LOADERS
        if type(item['executable'])!=bool or item['executable'] is not executable:raise ValueError('utility execution intent')
        if role=='executable':
            if guest not in UTILITY_PROGRAMS:raise ValueError('utility program ceiling')
            programs.add(guest)
        elif role=='library':
            if guest!='/lib/ld-linux-aarch64.so.1' and not re.fullmatch(r'/(?:usr/)?lib/aarch64-linux-gnu/[A-Za-z0-9_.+-]+\.so(?:\.[0-9.]+)?',guest):raise ValueError('utility library')
        elif role in ('stdlib','extension'):
            if not guest.startswith('/usr/lib/python3.12/') or any(part in ('site-packages','dist-packages','__pycache__','test','tests','ensurepip') for part in PurePosixPath(guest).parts) or role=='stdlib' and not guest.endswith('.py') or role=='extension' and not re.fullmatch(r'/usr/lib/python3\.12/lib-dynload/[A-Za-z0-9_.+-]+\.so',guest):raise ValueError('utility Python leaf')
        else:raise ValueError('utility role')
        source=capture['inputs'][guest]
        if type(source)!=dict or set(source)!={'role','source','bytes','sha256','executable'} or {key:source[key] for key in item}!=item:raise ValueError('utility source/output binding')
        relative_name(source['source']);directories.update(str(p)[1:] for p in PurePosixPath(guest).parents if str(p)!='/')
    if programs!=UTILITY_PROGRAMS or not UTILITY_LOADERS<=set(outputs) or total>MAX_ENV_BYTES or directories&{name[1:] for name in outputs}:raise ValueError('utility closure budget/ancestors')
    source_names=('scripts/guest-utilities/closure.py','scripts/guest-utilities/oracle.py','scripts/guest-utilities/smoke.sh')
    if type(capture['sources'])!=dict or set(capture['sources'])!=set(source_names):raise ValueError('utility source inputs')
    for name in source_names:
        expected=compiled['inputs'].get(name,{})
        if capture['sources'][name]!={key:expected.get(key) for key in ('bytes','sha256')}:raise ValueError('utility capture source changed')
    if type(origin)!=dict or origin.get('kind')!='winter-host-query-utility-origin' or origin.get('combinedManifestSha256')!=capture['inputManifestSha256'] or origin.get('utilityExecution') is not False:raise ValueError('combined utility origin')
    origin_keys={'formatVersion','kind','phaseBGraph','baseOrigin','baseManifest','supplementalPair','libcPackage','combinedManifestSha256','utilityExecution','dependencyCompletenessVerified'}
    if set(origin)!=origin_keys or type(origin['formatVersion'])!=int or origin['formatVersion']!=1 or origin['dependencyCompletenessVerified'] is not False:raise ValueError('closed combined origin')
    base=origin['baseManifest'];base_origin=origin['baseOrigin'];pair=origin['supplementalPair'];packages=origin['libcPackage']
    supplement_names={'/lib/aarch64-linux-gnu/libpthread.so.0','/lib/aarch64-linux-gnu/libdl.so.2'}
    if type(base)!=dict or set(base)!={'formatVersion','kind','target','files'} or type(base['formatVersion'])!=int or base['formatVersion']!=1 or base['target']!='linux-arm64-gnu' or base['kind']!='winter-tool-utility-inputs' or type(base['files'])!=dict or type(pair)!=dict or set(pair)!=supplement_names or set(base['files'])&set(pair) or {**base['files'],**pair}!=capture['inputs']:raise ValueError('base/supplement manifest binding')
    if type(base_origin)!=dict or set(base_origin)!={'kind','builder','readelf','readelfCommands','manifestSha256','staticStdlibGraph','utilityExecution','dependencyCompletenessVerified'} or base_origin['kind']!='winter-utility-origin' or base_origin['manifestSha256']!=digest_text(canonical(base)) or base_origin['utilityExecution'] is not False or base_origin['dependencyCompletenessVerified'] is not False:raise ValueError('unchanged base origin binding')
    python=outputs.get('/usr/bin/python3',{})
    if base_origin['builder']!={key:builder[key] for key in ('version','sha256','bytes')} or any(python.get(key)!=builder[key] for key in ('sha256','bytes')):raise ValueError('collector/builtin/captured interpreter binding')
    graph=origin['phaseBGraph']
    if type(graph)!=dict or graph.get('kind')!='winter-utility-static-stdlib-graph' or graph.get('requiredStaticImportsCaptured') is not True or any(graph.get(key) is not False for key in ('dynamicCompletenessVerified','optionalBranchesVerified','nativeExecutionVerified')):raise ValueError('Phase B bounded static graph')
    package_names={'/lib/aarch64-linux-gnu/libc.so.6',*UTILITY_LOADERS,*supplement_names}
    if type(packages)!=dict or set(packages)!=package_names:raise ValueError('fixed libc6 package records')
    versions=set()
    for guest,record in packages.items():
        if type(record)!=dict or set(record)!={'package','version','source','sha256','bytes','elf'} or record['package']!='libc6:arm64' or type(record['version'])!=str or not re.fullmatch(r'[A-Za-z0-9.+:~_-]{1,128}',record['version']):raise ValueError('libc6 package/version shape')
        versions.add(record['version']);item=capture['inputs'].get(guest,{})
        if any(record[key]!=item.get(key) for key in ('source','sha256','bytes')):raise ValueError('libc6 package/capture bytes')
        metadata=record['elf']
        if type(metadata)!=dict or set(metadata)!={'type','interpreter','needed','soname','rpath','runpath'} or metadata['type']!=3 or metadata['rpath'] is not None or metadata['runpath'] is not None:raise ValueError('libc6 ELF package metadata')
        if guest in supplement_names and (metadata['soname']!=guest.split('/')[-1] or type(metadata['needed'])!=list or not set(metadata['needed'])<={'libc.so.6','ld-linux-aarch64.so.1'}):raise ValueError('supplement metadata')
    if len(versions)!=1:raise ValueError('mixed libc6 versions')
    if not valid_hash(native['utilityCaptureSha256']) or not valid_hash(native['utilityOriginSha256']):raise ValueError('utility receipt hashes')
    dependencies=native['elfDependencies']
    if type(dependencies)!=dict or set(dependencies)!={'runtimeEntry','ownerLibrary'}:raise ValueError('SDK ELF dependency records')
    for name,record in dependencies.items():
        if type(record)!=dict or set(record)!={'type','interpreter','needed','soname','rpath','runpath'} or type(record['needed'])!=list or len(record['needed'])>128 or any(type(value)!=str or not re.fullmatch(r'[A-Za-z0-9_.+-]+\.so(?:\.[0-9.]+)?',value) for value in record['needed']):raise ValueError('SDK ELF dependency schema')
        if type(record['type'])!=int or record['type'] not in (2,3) or record['rpath'] is not None or record['runpath'] is not None:raise ValueError('SDK ELF type/search path')
        if record['interpreter'] is not None and record['interpreter'] not in UTILITY_LOADERS:raise ValueError('SDK loader outside closure')
        if record['interpreter'] is not None and record['interpreter'] not in outputs:raise ValueError('SDK loader missing')
        for library in record['needed']:
            if not any(path in outputs for path in ('/lib/aarch64-linux-gnu/'+library,'/usr/lib/aarch64-linux-gnu/'+library)):raise ValueError('SDK library missing')
    return directories,total

def check_environment(snapshot,immutable=False):
    dirs,total=validate_environment(snapshot.native,snapshot.compiled)
    if snapshot.environment is None:raise ValueError('held utility environment required')
    root_info=os.fstat(snapshot.environment)
    if immutable and (root_info.st_uid!=0 or stat.S_IMODE(root_info.st_mode)!=0o500):raise ValueError('immutable environment root')
    actual={};seen_dirs=set();visits=0
    def walk(fd,prefix=''):
        nonlocal visits
        with os.scandir(fd) as entries:
            for entry in entries:
                name=prefix+entry.name;relative_name(name);visits+=1
                if visits>MAX_ENV_ENTRIES*3:raise ValueError('environment walk limit')
                info=os.stat(entry.name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    if name not in dirs or immutable and (info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500):raise ValueError('environment directory')
                    seen_dirs.add(name);child=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                    try:walk(child,name+'/')
                    finally:os.close(child)
                else:
                    expected=snapshot.native['environment'].get('/'+name)
                    if expected is None:raise ValueError('unmeasured environment leaf')
                    measured=measure(snapshot.environment,name,MAX_ENV_FILE,expected['sha256'],immutable=immutable)
                    if measured['bytes']!=expected['bytes'] or immutable and stat.S_IMODE(info.st_mode)!=(0o500 if expected['executable'] else 0o400):raise ValueError('environment bytes/mode')
                    if expected['role']!='stdlib':
                        leaf_fd=leaf(snapshot.environment,name)
                        try:header=os.read(leaf_fd,20)
                        finally:os.close(leaf_fd)
                        if header[:6]!=b'\x7fELF\x02\x01' or len(header)!=20 or int.from_bytes(header[18:20],'little')!=183:raise ValueError('environment ARM64 ELF')
                        elf_fd=leaf(snapshot.environment,name)
                        try:dependencies=elf_dependencies(elf_fd)
                        finally:os.close(elf_fd)
                        if dependencies['type'] not in (2,3) or dependencies['rpath'] is not None or dependencies['runpath'] is not None:raise ValueError('environment ELF type/search paths')
                        if dependencies['interpreter'] is not None and dependencies['interpreter'] not in snapshot.native['environment']:raise ValueError('environment ELF loader missing')
                        for needed in dependencies['needed']:
                            if not any(path in snapshot.native['environment'] for path in ('/lib/aarch64-linux-gnu/'+needed,'/usr/lib/aarch64-linux-gnu/'+needed)):raise ValueError('environment ELF dependency missing')
                        if '/'+name in snapshot.native['utilityOrigin']['libcPackage'] and dependencies!=snapshot.native['utilityOrigin']['libcPackage']['/'+name]['elf']:raise ValueError('libc6 actual ELF changed')
                        if '/'+name in ('/lib/aarch64-linux-gnu/libpthread.so.0','/lib/aarch64-linux-gnu/libdl.so.2') and (dependencies['type']!=3 or dependencies['soname']!=name.split('/')[-1] or not set(dependencies['needed'])<={'libc.so.6','ld-linux-aarch64.so.1'}):raise ValueError('supplement actual ELF properties')
                    actual['/'+name]=expected
    walk(snapshot.environment)
    if actual!=snapshot.native['environment'] or seen_dirs!=dirs:raise ValueError('environment exact closure')
    payloads=[measure(snapshot.source,'scripts/guest-host-query/'+name,MAX_FILE,retain=True,immutable=immutable,unique=False) for name in ('utilities.sh','utilities-plan.sh')]
    if snapshot.native['utilityOrigin']['phaseBGraph'].get('roots')!=phase_b_fragment_records(payloads):raise ValueError('Phase B static graph payload binding')
    for name in ('runtimeEntry','ownerLibrary'):
        fd=leaf(snapshot.artifacts,name)
        try:actual=elf_dependencies(fd)
        finally:os.close(fd)
        if actual!=snapshot.native['elfDependencies'][name]:raise ValueError('SDK ELF dependency changed')
    for name,key,inline in (('utility-receipt.json','utilityCaptureSha256','utilityCapture'),('utility-origin-receipt.json','utilityOriginSha256','utilityOrigin')):
        value=json_wire(measure(snapshot.artifacts,name,MAX_JSON,snapshot.native[key],retain=True,immutable=immutable))
        if value!=snapshot.native[inline]:raise ValueError('utility receipt inline binding')
    return dirs,total

def validate_manifests(native,compiled):
    native_keys={'formatVersion','kind','sources','artifacts','compileReceiptSha256','nativeBuildCommands','nativeCompiler','nativeBuildEnvironment','linuxExecutionVerified','vmExecutionVerified','utilityCapture','utilityOrigin','utilityCaptureSha256','utilityOriginSha256','environment','elfDependencies'}
    compile_keys={'formatVersion','kind','inputs','inputInventorySha256','compiler','base','recipe','outputs','linuxExecutionVerified','vmExecutionVerified'}
    if type(native) is not dict or set(native)!=native_keys or type(native['formatVersion']) is not int or native['formatVersion']!=3 or native.get('kind')!='winter-host-query-utilities' or type(compiled) is not dict or set(compiled)!=compile_keys or type(compiled['formatVersion']) is not int or compiled['formatVersion']!=1 or compiled['kind']!='winter-host-query-compile':raise ValueError('closed receipt shape')
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
    if type(outputs) is not dict or set(outputs)!=set(ENTRIES):raise ValueError('compile outputs')
    for name,output in outputs.items():
        entry=f"scripts/guest-host-query/{ENTRIES[name]}"
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
    def __init__(self,source,artifacts,native,compiled,wire,approved,parent_sha,environment=None):
        self.source=source;self.artifacts=artifacts;self.environment=environment;self.native=native;self.compiled=compiled;self.wire=wire;self.approved=approved;self.parent_sha=parent_sha
    def close(self):
        for name in ('source','artifacts','environment'):
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
    for name in ENTRIES:
        output=snapshot.compiled['outputs'][name];meta=json_wire(measure(snapshot.artifacts,f'{name}.metafile.json',MAX_JSON,output['metafileSha256'],retain=True,immutable=immutable))
        if type(meta) is not dict or type(meta.get('inputs')) is not dict or set(meta['inputs'])!=set(output['bundledInputs']):raise ValueError('metafile bundled closure')
        for path,item in meta['inputs'].items():
            if type(item) is not dict or type(item.get('bytes')) is not int or item['bytes']!=output['bundledInputs'][path]['bytes']:raise ValueError('metafile input size')
    env_dirs,env_bytes=check_environment(snapshot,immutable)
    source_bytes=sum(item.get('bytes',0) for item in snapshot.compiled['inputs'].values())
    metadata_bytes=len(snapshot.wire)
    for name in METADATA:
        if name!='receipt.json':metadata_bytes+=measure(snapshot.artifacts,name,MAX_JSON,immutable=immutable)['bytes']
    if source_bytes+total+env_bytes+metadata_bytes>MAX_COMBINED_BYTES:raise ValueError('combined closure budget')
    return directories

def own_parent_hash():
    path=Path(__file__).resolve();directory=open_root(path.parent)
    try:return measure(directory,path.name,MAX_FILE,unique=False)['sha256']
    finally:os.close(directory)

def capture(source,artifacts,receipt_path,approved_digest):
    if not valid_hash(approved_digest):raise ValueError('external approved receipt digest required')
    source_fd=artifact_fd=receipt_fd=environment_fd=None
    try:
        source_fd=open_root(source);artifact_fd=open_root(artifacts);receipt_fd=open_root(Path(receipt_path).parent)
        environment_fd=open_root(Path(artifacts)/'environment')
        wire=measure(receipt_fd,Path(receipt_path).name,MAX_JSON,approved_digest,retain=True);native=json_wire(wire)
        if type(native) is not dict or not valid_hash(native.get('compileReceiptSha256')):raise ValueError('native receipt shape')
        compiled=json_wire(measure(artifact_fd,'compile-receipt.json',MAX_JSON,native['compileReceiptSha256'],retain=True))
        parent_sha=own_parent_hash()
        snapshot=Snapshot(source_fd,artifact_fd,native,compiled,wire,approved_digest,parent_sha,environment_fd);check_snapshot(snapshot)
        if native['sources'].get(PARENT)!=parent_sha:raise ValueError('externally admitted parent/source mismatch')
        source_fd=artifact_fd=environment_fd=None;return snapshot
    finally:
        for fd in (source_fd,artifact_fd,receipt_fd,environment_fd):
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
    source=directory/'source';artifacts=directory/'artifacts';environment=directory/'environment';environment.mkdir(mode=0o700);source.mkdir(mode=0o700);artifacts.mkdir(mode=0o700)
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
    env_dirs,_=check_environment(snapshot)
    for name in sorted(env_dirs,key=lambda value:(len(PurePosixPath(value).parts),value)):(environment/name).mkdir(mode=0o700)
    for guest,item in snapshot.native['environment'].items():copy_leaf(snapshot.environment,guest[1:],environment/guest[1:],item['sha256'],MAX_ENV_FILE,0o500 if item['executable'] else 0o400)
    metadata={'utility-receipt.json':snapshot.native['utilityCaptureSha256'],'utility-origin-receipt.json':snapshot.native['utilityOriginSha256'],'compile-receipt.json':snapshot.native['compileReceiptSha256'],**{f'{name}.metafile.json':snapshot.compiled['outputs'][name]['metafileSha256'] for name in ENTRIES}}
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
    for name in sorted(env_dirs,key=lambda value:len(PurePosixPath(value).parts),reverse=True):(environment/name).chmod(0o500)
    environment.chmod(0o500);source.chmod(0o500);artifacts.chmod(0o500);directory.chmod(0o500)
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
            if len(names)>3:raise ValueError('staged root inventory')
    return names

def verify_staged(directory,approved_digest,parent_sha):
    trusted_staging_ancestry(directory)
    root=open_root(directory);source=artifacts=environment=None
    try:
        info=os.fstat(root)
        if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500 or stage_root_names(root)!={'source','artifacts','environment'}:raise ValueError('immutable staged root required')
        source=os.open('source',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root);artifacts=os.open('artifacts',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
        environment=os.open('environment',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
        wire=measure(artifacts,'receipt.json',MAX_JSON,approved_digest,retain=True,immutable=True);native=json_wire(wire);compiled=json_wire(measure(artifacts,'compile-receipt.json',MAX_JSON,native['compileReceiptSha256'],retain=True,immutable=True))
        snapshot=Snapshot(source,artifacts,native,compiled,wire,approved_digest,parent_sha,environment);check_snapshot(snapshot,immutable=True)
        if native['sources'].get(PARENT)!=parent_sha or inventory_staged(source)!=compiled['inputs'] or set(inventory_staged(artifacts))!=set((*ARTIFACTS,*METADATA)):raise ValueError('immutable staged closure inventory')
        return native
    finally:
        for fd in (source,artifacts,environment,root):
            if fd is not None:os.close(fd)

BOOTSTRAP=r'''
import hashlib,os,stat,sys
from pathlib import Path
root=Path(sys.argv[1]);receipt_sha=sys.argv[2];parent_sha=sys.argv[3]
if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:raise SystemExit('isolated Root Linux bootstrap required')
for name in ('/','/tmp'):
 info=os.lstat(name)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)&0o022 and (name=='/' or not info.st_mode&stat.S_ISVTX):raise SystemExit('bootstrap ancestry')
if root.parent!=Path('/tmp') or not root.name.startswith('winter-host-query-reviewed-'):raise SystemExit('bootstrap ancestry')
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);info=os.fstat(fd)
if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500:raise SystemExit('bootstrap immutable root')
parent=root/'source/scripts/guest-host-query/stage.py'
folder=os.dup(fd)
try:
 for name in ('source','scripts','guest-host-query'):
  child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);os.close(folder);folder=child
  st=os.fstat(folder)
  if st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o500:raise SystemExit('bootstrap immutable source')
 leaf=os.open('stage.py',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK,dir_fd=folder)
 try:
  st=os.fstat(leaf)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=0o400 or st.st_size>16*1024*1024:raise SystemExit('bootstrap parent identity')
  wire=os.pread(leaf,16*1024*1024+1,0)
 finally:os.close(leaf)
finally:os.close(folder)
if len(wire)!=st.st_size or hashlib.sha256(wire).hexdigest()!=parent_sha:raise SystemExit('bootstrap parent hash')
trusted={'__name__':'winter_host_query_trusted_parent','__file__':str(parent)}
exec(compile(wire,str(parent),'exec'),trusted)
native=trusted['verify_staged'](root,receipt_sha,parent_sha)
wire=trusted['measure'](fd,'source/scripts/guest-host-query/verify.py',16*1024*1024,native['sources']['scripts/guest-host-query/verify.py'],retain=True,immutable=True)
class Admission:pass
admission=Admission();admission.directory=str(root);admission.directory_fd=fd;admission.identity=(info.st_dev,info.st_ino);admission.receipt_sha=receipt_sha;admission.parent_sha=parent_sha;admission.verify_sha=native['sources']['scripts/guest-host-query/verify.py'];admission.pid=os.getpid()
sys._winter_host_query_stage_admission=admission
runner=root/'source/scripts/guest-host-query/verify.py'
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

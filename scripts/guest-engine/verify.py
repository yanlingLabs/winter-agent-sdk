#!/usr/bin/env python3
"""Reviewed disposable Linux fresh SDK-engine fixture; no VM, release or cold-resume claim.
Only a root-reviewed matching source/artifact receipt can reach privileged staging.
Guest provider packet parsing belongs to the separate fixture worker, not this root harness.
"""
from contextlib import contextmanager
import argparse,array,fcntl,hashlib,importlib.util,json,os,re,shutil,socket,stat,struct,subprocess,sys,tempfile,threading,time
from pathlib import Path
def require_staged_imports():
    # Ordinary portable tests may import definitions as an unprivileged process.
    # Direct CLI/elevated project imports require the isolated, hash-admitted parent.
    if __name__!='__main__' and os.geteuid()!=0:return
    admission=getattr(sys,'_winter_fresh_stage_admission',None)
    refusal='hash-admitted immutable staged runner required before imports'
    if admission is None or sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:raise SystemExit(refusal)
    directory=Path(admission.directory)
    if directory.parent!=Path('/tmp') or not directory.name.startswith('winter-fresh-reviewed-') or admission.pid!=os.getpid() or Path(__file__)!=directory/'source/scripts/guest-engine/verify.py':raise SystemExit(refusal)
    for name in ('/','/tmp'):
        info=os.lstat(name)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)&0o022 and (name=='/' or not info.st_mode&stat.S_ISVTX):raise SystemExit(refusal)
    held=os.fstat(admission.directory_fd);named=os.lstat(directory)
    if not stat.S_ISDIR(held.st_mode) or held.st_uid!=0 or stat.S_IMODE(held.st_mode)!=0o500 or (held.st_dev,held.st_ino)!=admission.identity or (named.st_dev,named.st_ino)!=(held.st_dev,held.st_ino):raise SystemExit(refusal)
    def checked(name,expected,limit):
        folder=os.dup(admission.directory_fd);fd=None
        try:
            parts=name.split('/')
            for part in parts[:-1]:
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);os.close(folder);folder=child
                info=os.fstat(folder)
                if info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o500:raise SystemExit(refusal)
            fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o400 or info.st_size>limit:raise SystemExit(refusal)
            hash=hashlib.sha256();count=0
            while True:
                data=os.read(fd,min(65536,limit-count+1))
                if not data:break
                count+=len(data)
                if count>limit:raise SystemExit(refusal)
                hash.update(data)
            if count!=info.st_size or hash.hexdigest()!=expected:raise SystemExit(refusal)
        finally:
            if fd is not None:os.close(fd)
            os.close(folder)
    checked('source/scripts/guest-engine/verify.py',admission.verify_sha,16*1024*1024)
    checked('source/scripts/guest-engine/stage.py',admission.parent_sha,16*1024*1024)
    checked('artifacts/receipt.json',admission.receipt_sha,16*1024*1024)
require_staged_imports()

ROOT=Path(__file__).resolve().parents[2]
BUILD_PATH=Path(__file__).with_name('build.py');spec=importlib.util.spec_from_file_location('fresh_build',BUILD_PATH);build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
RUNTIME_UID=20001;TOOL_UID=10001;WORKSPACE_GID=10000;PROVIDER_UID=30001
LOGICAL='conversation-fresh';BACKEND='01234567-89ab-4cde-8fab-0123456789ab'
EXPECTED_CALLS=[('Read',{'file_path':'seed'}),('Edit',{'file_path':'seed','old_string':'hello','new_string':'edited'}),('Write',{'file_path':'written','content':'written\n'}),('Bash',{'command':'test ! -e /workspace/.winter/conversations && printf shell > from-shell','timeout':5000})]
EXPECTED_RESULTS=['hello\n',{'filePath':'/workspace/folders/source/seed','diff':[{'type':'remove','oldLineNumber':1,'content':'hello'},{'type':'add','newLineNumber':1,'content':'edited'},{'type':'context','oldLineNumber':2,'newLineNumber':2,'content':''}],'originalContent':'hello\n','replaceAll':False,'userModified':False},{'type':'create','filePath':'/workspace/folders/source/written','content':'written\n','diff':[{'type':'add','newLineNumber':1,'content':'written'},{'type':'add','newLineNumber':2,'content':''}],'userEdited':False},'\n[Exit code: 0; cwd changes apply to this command only]']

def checked(args):
    result=subprocess.run(list(map(str,args)),capture_output=True,timeout=60)
    if result.returncode:raise AssertionError(('fixture command failed',result.returncode,result.stderr[-2000:]))
    return result.stdout

def exchange(path,value,seconds=3):
    wire=json.dumps(value,separators=(',',':')).encode()
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as channel:
        channel.settimeout(seconds);channel.connect(str(path));channel.sendall(struct.pack('!I',len(wire))+wire)
        def exact(count):
            output=bytearray()
            while len(output)<count:
                data=channel.recv(count-len(output))
                if not data:raise AssertionError('root admin channel closed')
                output.extend(data)
            return bytes(output)
        size=struct.unpack('!I',exact(4))[0]
        if not 1<=size<=65536:raise AssertionError('root admin response limit')
        return json.loads(exact(size))

def wait_for(check,seconds,children=()):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        for child in children:
            if child.poll() is not None:raise AssertionError(('fixture process exited early',child.returncode))
        result=check()
        if result:return result
        time.sleep(.02)
    raise AssertionError('bounded fixture wait failed')

def stage_environment(directory,executables):
    for executable in executables:
        executable=Path(executable)
        if not executable.is_file():raise AssertionError('existing fixture executable required')
        # Existing known shell utilities are mounted at their normal paths.
        if str(executable) in ('/bin/bash','/bin/sleep','/bin/cat','/usr/bin/setsid'):
            target=directory/str(executable).lstrip('/');target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(executable,target);target.chmod(0o555)
        libraries=set(re.findall(r'(/[^\s()]+)',checked(['ldd',executable]).decode()))
        for library in libraries:
            path=Path(library)
            if not path.is_file():raise AssertionError('fixture shared library missing')
            target=directory/library.lstrip('/');target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target);target.chmod(0o555)

def create_fixture(root,artifact_directory,receipt):
    root.chmod(0o711);binary=root/'bin';binary.mkdir(mode=0o755);control=root/'control';control.mkdir(mode=0o711);environment=root/'environment';environment.mkdir(mode=0o755)
    pins={}
    for name in [*build.NATIVE,'runtimeEntry','providerWorker']:
        target=binary/name;shutil.copyfile(artifact_directory/name,target);target.chmod(0o555);actual=build.digest(target)
        if actual!=receipt['artifacts'][name]:raise AssertionError('staged artifact changed after review')
        pins[name]={'path':str(target),'sha256':actual}
    service=binary/'linux-supervisor.py';shutil.copyfile(ROOT/'packages/runtime/src/guest/linux-supervisor.py',service);service.chmod(0o555)
    if build.digest(service)!=receipt['sources']['packages/runtime/src/guest/linux-supervisor.py']:raise AssertionError('staged supervisor changed after review')
    stage_environment(environment,['/bin/bash','/bin/sleep','/bin/cat','/usr/bin/setsid',binary/'runtimeEntry',binary/'ownerLibrary'])
    source=root/'source';source.mkdir(mode=0o2770);os.chown(source,TOOL_UID,WORKSPACE_GID);source.chmod(0o2770)
    (source/'seed').write_text('hello\n');os.chown(source/'seed',TOOL_UID,WORKSPACE_GID);(source/'seed').chmod(0o660)
    stores=root/'stores';stores.mkdir(mode=0o711);store=stores/LOGICAL;store.mkdir(mode=0o700);os.chown(store,RUNTIME_UID,RUNTIME_UID);store.chmod(0o700)
    homes=root/'homes';homes.mkdir(mode=0o711);home=homes/LOGICAL;home.mkdir(mode=0o700);os.chown(home,RUNTIME_UID,RUNTIME_UID);home.chmod(0o700)
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();authority={'workspaceId':'workspace','sessionId':BACKEND,'incarnationId':'incarnation','leaseEpoch':1,'configRevision':1,'grantRevision':1,'policyRevision':1}
    provider={'scope':{'homeId':'fixture-home','workspaceId':'workspace','sessionId':LOGICAL,'backendSessionId':BACKEND,'taskId':'fixture-task','incarnationId':'incarnation','bootId':boot,'leaseEpoch':1,'grantRevision':1,'accountRevision':1,'modelRevision':1},'selection':{'providerId':'openai','modelKey':'openai/gpt-5.6','providerModelId':'gpt-5.6','family':'openai','protocol':'openai-responses','continuationDomain':'openai/gpt-5.6','capabilities':{'toolCalling':'native','readableState':'summary'}}}
    conversation={'authority':authority,'logicalSessionId':LOGICAL,'runtimeUid':RUNTIME_UID,'toolUid':TOOL_UID,'workspaceGid':WORKSPACE_GID,'policy':'auto','roots':[{'id':'source','guestPath':'/workspace/folders/source','readOnly':False,'source':str(source)}],'freshRuntime':{'storeDirectory':str(store),'runhomeDirectory':str(home),'provider':provider,'model':provider['selection']['modelKey'],'timeoutMs':30000}}
    config={'guestBootId':boot,'protectedStoreDirectories':[str(store),str(home)],'artifacts':{'launcher':pins['toolLauncher'],'fileWorker':pins['fileWorker'],'processWorker':pins['processWorker']},'freshRuntime':{'artifacts':{'launcher':pins['runtimeLauncher'],'executable':pins['runtimeEntry'],'ownerLibrary':pins['ownerLibrary']}},'environment':str(environment),'controlDirectory':str(control),'conversations':[conversation]}
    config_path=root/'bootstrap.json';config_path.write_text(json.dumps(config));config_path.chmod(0o400)
    return {'binary':binary,'control':control,'source':source,'store':store,'home':home,'config':config_path,'provider':provider,'pins':pins}

def persisted_evidence(fixture):
    source=fixture['source'];store=fixture['store']
    if (source/'seed').read_text()!='edited\n' or (source/'written').read_text()!='written\n' or (source/'from-shell').read_text()!='shell':raise AssertionError('actual Edit/Write/Bash fixture bytes missing')
    transcripts=[path for path in store.rglob('*.jsonl') if path.name==BACKEND+'.jsonl']
    states=[path for path in store.rglob('*.jsonl') if path.name==BACKEND+'.provider-state.jsonl']
    if len(transcripts)!=1 or len(states)!=1:raise AssertionError('actual SDK root transcript/provider-state inventory')
    transcript_data=None;state_data=None
    for path in store.rglob('*.jsonl'):
        if path.stat().st_size>8*1024*1024:raise AssertionError('fixture credential leaked or store evidence bound')
        with path.open('rb') as stream:data=stream.read(8*1024*1024+1)
        if len(data)>8*1024*1024 or b'DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET' in data:raise AssertionError('fixture credential leaked or store evidence bound')
        if path==transcripts[0]:transcript_data=data
        if path==states[0]:state_data=data
    if transcript_data is None or state_data is None:raise AssertionError('actual SDK evidence changed during bounded read')
    records=[json.loads(line) for line in transcript_data.decode().splitlines()];state_records=[json.loads(line) for line in state_data.decode().splitlines()]
    calls={};results={};assistant_ids=set();anchors=[]
    for record in records:
        if record.get('sessionId')!=BACKEND:raise AssertionError('cross-session transcript record')
        if record.get('type')=='assistant':
            uuid=record.get('uuid')
            if not isinstance(uuid,str) or not uuid or uuid in assistant_ids:raise AssertionError('actual SDK tool history assistant identity')
            assistant_ids.add(uuid)
        content=record.get('message',{}).get('content',[])
        if not isinstance(content,list):continue
        for block in content:
            if not isinstance(block,dict):continue
            if record.get('type')=='assistant' and block.get('type')=='tool_use':
                number=len(calls);key=f'call-{number}'
                if number>=4 or block.get('id')!=key or (block.get('name'),block.get('input'))!=EXPECTED_CALLS[number] or record['uuid'] in anchors:raise AssertionError('actual SDK tool history exact call/input binding')
                calls[key]=block;anchors.append(record['uuid'])
            if record.get('type')=='user' and block.get('type')=='tool_result':
                key=block.get('tool_use_id')
                if key not in calls or key in results or len(results)!=len(calls)-1:raise AssertionError('actual SDK tool history result order/binding')
                results[key]=block
            if record.get('type')=='assistant' and block.get('type')=='text' and block.get('text')=='fresh-engine-complete':
                if len(calls)!=4 or len(results)!=4 or record['uuid'] in anchors or len(anchors)!=4:raise AssertionError('actual SDK tool history final binding')
                anchors.append(record['uuid'])
    if len(calls)!=4 or len(results)!=4 or len(anchors)!=5:raise AssertionError('actual SDK transcript missing completed successful tool history')
    for number,expected in enumerate(EXPECTED_RESULTS):
        result=results[f'call-{number}'];content=result.get('content')
        if result.get('is_error',False) is not False or result.get('denied',False) is not False:raise AssertionError('actual SDK tool history unsuccessful result')
        if isinstance(expected,dict):
            try:content=json.loads(content)
            except (TypeError,ValueError):raise AssertionError('actual SDK tool history exact result bytes')
        if content!=expected:raise AssertionError('actual SDK tool history exact result bytes')
    native=[record for record in state_records if record.get('kind')=='native-state']
    if len(native)!=5:raise AssertionError('actual SDK provider native state binding count')
    native_ids=set()
    for number,(record,anchor) in enumerate(zip(native,anchors)):
        expected={'type':'winter_provider_state','sessionId':BACKEND,'anchorUuid':anchor,'provider':'openai','model':'openai/gpt-5.6','family':'openai','continuationDomain':'openai/gpt-5.6','itemIndex':1,'kind':'native-state','payload':{'items':[{'type':'reasoning','id':f'reasoning-{number}','encrypted_content':'fixture-native-state'}]}}
        if any(record.get(key)!=value for key,value in expected.items()) or not isinstance(record.get('uuid'),str) or not record['uuid'] or record['uuid'] in assistant_ids or record['uuid'] in native_ids or type(record.get('itemIndex')) is not int or not isinstance(record.get('timestamp'),str) or not record['timestamp']:raise AssertionError('actual SDK provider native state binding schema/identity/item/anchor')
        native_ids.add(record['uuid'])
    for path in (store,transcripts[0],states[0]):
        st=path.stat()
        if st.st_uid!=RUNTIME_UID or st.st_mode&0o077:raise AssertionError('SDK durable state owner/mode')
    return {'transcriptSha256':build.digest(transcripts[0]),'providerStateSha256':build.digest(states[0]),'transcriptRecords':len(records),'providerStateRecords':len(state_records)}

# Provider process start/admission is wired only through its reviewed private
# socket contract. No permissive/mock provider fallback can satisfy this fixture.
def start_provider(fixture,server):
    listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);path=fixture['control']/LOGICAL/'provider.sock';listener.bind(str(path));os.chmod(path,0o660);os.chown(path,0,RUNTIME_UID);listener.listen(4)
    admission,worker=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
    metadata_path=fixture['config'].parent/'provider-metadata.json';metadata_path.write_text(json.dumps({'protocolVersion':1,'runtimeUid':RUNTIME_UID,'provider':fixture['provider']},sort_keys=True,separators=(',',':')));metadata_path.chmod(0o400)
    library=os.open(fixture['binary']/'ownerLibrary',os.O_RDONLY|os.O_CLOEXEC);metadata=os.open(metadata_path,os.O_RDONLY|os.O_CLOEXEC);copies=[];fillers=[]
    try:
        # Duplicate to high FDs before fixing 3..6 in the child so no source/dest
        # alias can lose the listener/admission/library/metadata binding.
        copies=[fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,64) for fd in (listener.fileno(),worker.fileno(),library,metadata)]
        for target in (3,4,5,6):
            try:os.fstat(target)
            except OSError:
                filler=os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC);fillers.append(filler)
                if filler!=target:raise AssertionError('fixed descriptor staging collision')
        def identity():
            for source,target in zip(copies,(3,4,5,6)):os.dup2(source,target,inheritable=True)
            for source in copies:os.close(source)
            os.setgroups([]);os.setgid(PROVIDER_UID);os.setuid(PROVIDER_UID)
        child=subprocess.Popen([str(fixture['binary']/'providerWorker'),'--listener-fd','3','--admission-fd','4','--owner-library-fd','5','--metadata-fd','6'],preexec_fn=identity,pass_fds=tuple([*copies,3,4,5,6]),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True,env={'LANG':'C','LC_ALL':'C','HOME':'/nonexistent'},start_new_session=True)
        return child,admission
    except BaseException:
        admission.close();raise
    finally:
        for fd in [library,metadata,*copies,*fillers]:os.close(fd)
        listener.close();worker.close()

def admit_provider(fixture,admission,children,observations=None):
    # Root-only admin sends the actual live namespace-init pidfd. Own all installed
    # rights before validating the bounded framed response; malformed packets leak
    # neither descriptors nor guessed PID authority.
    deadline=time.monotonic()+2
    def obtain():
        fds=[]
        try:
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as channel:
                channel.settimeout(max(.001,min(1,deadline-time.monotonic())));channel.connect(str(fixture['control']/'admin.sock'));request=json.dumps({'operation':'runtime-owner','sessionId':LOGICAL}).encode();channel.sendall(struct.pack('!I',len(request))+request)
                data,ancillary,flags,_=channel.recvmsg(65536,socket.CMSG_SPACE(16*array.array('i').itemsize),socket.MSG_CMSG_CLOEXEC)
                for level,kind,body in ancillary:
                    if (level,kind)==(socket.SOL_SOCKET,socket.SCM_RIGHTS):fds.extend(array.array('i',body[:len(body)-len(body)%array.array('i').itemsize]))
                if not data:
                    # Status is diagnostic only: no owner/effect is retried or manufactured.
                    remaining=deadline-time.monotonic()
                    if remaining>0:
                        try:status=exchange(fixture['control']/'admin.sock',{'operation':'status','sessionId':LOGICAL},seconds=min(.25,remaining))
                        except (OSError,ValueError,AssertionError) as error:
                            if observations is not None:observations['ownerStatusProbeFailure']=failure_metadata(error)
                        else:
                            observed=native_status_observation(status)
                            if observed['state'] in ('stopped','retained'):
                                if observations is not None:
                                    observations['nativeStatus']=observed;observations['ownerAdmissionFailure']='terminal-runtime-before-owner'
                                    snapshot_runtime_diagnostic(fixture,observations)
                                raise AssertionError('native runtime terminal before owner admission')
                    return False # owner not running yet; unchanged two-second budget
                if flags&~socket.MSG_CMSG_CLOEXEC or len(ancillary)!=1 or ancillary[0][:2]!=(socket.SOL_SOCKET,socket.SCM_RIGHTS) or len(fds)!=1:raise AssertionError('native owner rights inventory')
                while len(data)<4:
                    part=channel.recv(4-len(data))
                    if not part:raise AssertionError('native owner frame closed')
                    data+=part
                size=struct.unpack('!I',data[:4])[0]
                if not 1<=size<=65532:raise AssertionError('native owner frame limit')
                while len(data)<size+4:
                    part=channel.recv(size+4-len(data))
                    if not part:raise AssertionError('native owner frame closed')
                    data+=part
                if len(data)!=size+4:raise AssertionError('native owner frame trailing bytes')
                record=json.loads(data[4:]);scope=record.get('scope',{});expected=fixture['provider']['scope']
                owner_scope={'workspaceId':expected['workspaceId'],'sessionId':BACKEND,'incarnationId':expected['incarnationId'],'leaseEpoch':expected['leaseEpoch'],'currentBootId':expected['bootId'],'storeHome':f'/workspace/.winter/conversations/{LOGICAL}'}
                if set(record)!={'logicalSessionId','runtimeUid','scope','ownerToken'} or record.get('logicalSessionId')!=LOGICAL or record.get('runtimeUid')!=RUNTIME_UID or not isinstance(record.get('ownerToken'),str) or not re.fullmatch('[a-f0-9]{64}',record['ownerToken']) or scope!=owner_scope:raise AssertionError('native owner scope binding')
                if admission.sendmsg([b'I'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',fds))])!=1:raise AssertionError('provider owner handoff')
                return True
        finally:
            for fd in fds:os.close(fd)
    wait_for(obtain,2,children)
    admission.close()

def normalized_stderr(data,paths=()):
    text=bytes(data[:16384]).decode('utf-8',errors='replace')
    for path in sorted((str(path) for path in paths if path),key=len,reverse=True):text=text.replace(path,'[fixture-path]')
    text=text.replace('DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET','[fixture-credential]')
    text=re.sub(r'(?<![A-Za-z0-9])[a-fA-F0-9]{16,}(?![A-Za-z0-9])','[hex-identity]',text)
    text=re.sub(r'(?:https?://|/)[^\s\x00"\'<>;,)]+','[absolute-path]',text)
    text=re.sub(r'(?i)(?:bearer\s+|(?:token|secret|password|credential|authref)\s*[=:]\s*)[^\s,;"\']+','[private-value]',text)
    text=''.join(char if char in '\n\t' or ord(char)>=32 else '?' for char in text)
    return text.encode()[:4096].decode('utf-8',errors='ignore')

class BoundedCapture:
    """Drain a process pipe concurrently, retaining only bounded bytes for validation.
    Durable stdout is metadata only; stderr text is bounded and normalized.
    """
    def __init__(self,stream,limit,stderr_paths=None):
        self.stream=stream;self.limit=limit;self.data=bytearray();self.total=0;self.read_failed=False;self.stderr_paths=stderr_paths
        self.thread=threading.Thread(target=self._read,daemon=True);self.thread.start()
    def _read(self):
        try:
            while True:
                data=self.stream.read(4096)
                if not data:break
                self.total+=len(data)
                self.data.extend(data[:max(0,self.limit-len(self.data))])
        except (OSError,ValueError):self.read_failed=True
    def finish(self):self.thread.join(timeout=1)
    def metadata(self):
        record={'capturedBytes':len(self.data),'captureLimit':self.limit,'truncated':self.total>self.limit,'sha256':hashlib.sha256(self.data).hexdigest(),'drainComplete':not self.thread.is_alive() and not self.read_failed}
        if self.stderr_paths is not None:record.update(normalizedText=normalized_stderr(self.data,self.stderr_paths),textLimit=4096)
        return record

def failure_metadata(error):
    record={'class':type(error).__name__}
    if isinstance(error,OSError) and error.errno is not None:record['errno']=error.errno
    return record

def provider_receipt_observation(data):
    try:receipt=json.loads(data)
    except (ValueError,TypeError):return {'parsed':False}
    if not isinstance(receipt,dict):return {'parsed':False}
    observed={'passed':receipt.get('passed') is True,'turns':receipt.get('turns') if type(receipt.get('turns')) is int else None,'peerValidated':receipt.get('peerValidated') is True}
    failure=receipt.get('failure')
    if isinstance(failure,dict) and failure.get('phase')=='provider_exchange' and failure.get('code') in ('scope','turn','pull','end','native_continuation','framing','write','provider_failure'):observed['failure']={'phase':'provider_exchange','code':failure['code']}
    return observed

def native_status_observation(status):
    runtime=status.get('runtime',{}) if type(status) is dict else {}
    if type(runtime) is not dict:runtime={}
    def integer(value):return value if type(value) is int and -2147483648<=value<=2147483647 else None
    return {'state':runtime.get('state') if runtime.get('state') in ('configured','starting','running','cleaning','stopped','retained') else 'unknown',
            'exitCode':integer(runtime.get('exitCode')),'cleanupConfirmed':runtime.get('cleanupConfirmed') is True,
            'active':integer(status.get('active')) if type(status) is dict else None,
            'uncertain':type(status) is not dict or status.get('uncertain') is not False}

def runtime_diagnostic_observation(value):
    # Root's fixed control record is already normalized; keep only its documented schema.
    if type(value) is not dict or set(value)!={'version','kind','observations','failure','stdout','stderr'} or type(value['version']) is not int or value['version']!=1 or value['kind']!='fixture-runtime-diagnostic':raise ValueError('runtime diagnostic schema')
    source=value['observations']
    if type(source) is not dict or source.get('phase') not in ('artifact-admission','native-startup','sdk-runtime','native-cleanup','complete'):raise ValueError('runtime diagnostic phase')
    observed={'phase':source['phase']}
    booleans=('nativeReceiptObserved','parentReaped','toolDrainConfirmed','nativeCleanupConfirmed','ownershipReleased','toolDebtObserved')
    integers=('nativeWaitStatus','nativeExitCode','parentExitCode')
    for key in booleans:
        if key in source:
            if type(source[key]) is not bool:raise ValueError('runtime diagnostic observation')
            observed[key]=source[key]
    for key in integers:
        if key in source:
            if source[key] is not None and (type(source[key]) is not int or not -2147483648<=source[key]<=2147483647):raise ValueError('runtime diagnostic observation')
            observed[key]=source[key]
    def failure(record):
        if record is None:return None
        if type(record) is not dict or not isinstance(record.get('class'),str) or not re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,63}',record['class']):raise ValueError('runtime diagnostic failure')
        output={'class':record['class']}
        if 'code' in record:
            if not isinstance(record['code'],str) or not re.fullmatch('[a-z][a-z_]{0,63}',record['code']):raise ValueError('runtime diagnostic failure')
            output['code']=record['code']
        if type(record.get('errno')) is int:output['errno']=record['errno']
        return output
    if 'cleanupFailure' in source:observed['cleanupFailure']=failure(source['cleanupFailure'])
    def capture(record,limit,stderr=False):
        if type(record) is not dict or type(record.get('capturedBytes')) is not int or not 0<=record['capturedBytes']<=limit or record.get('captureLimit')!=limit or type(record.get('truncated')) is not bool or not isinstance(record.get('sha256'),str) or not re.fullmatch('[a-f0-9]{64}',record['sha256']):raise ValueError('runtime diagnostic capture')
        output={key:record[key] for key in ('capturedBytes','captureLimit','truncated','sha256')}
        if stderr:
            if type(record.get('normalizedText')) is not str or record.get('textLimit')!=4096 or len(record['normalizedText'].encode())>4096:raise ValueError('runtime diagnostic stderr')
            output.update(normalizedText=normalized_stderr(record['normalizedText'].encode()),textLimit=4096)
        return output
    return {'version':1,'kind':'fixture-runtime-diagnostic','observations':observed,'failure':failure(value['failure']),
            'stdout':capture(value['stdout'],1024*1024),'stderr':capture(value['stderr'],16384,True)}

def snapshot_runtime_diagnostic(fixture,observations):
    folder=private=fd=None
    try:
        folder=os.open(fixture['control'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        private=os.open(LOGICAL,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder)
        for directory in (folder,private):
            info=os.fstat(directory)
            if info.st_uid!=os.geteuid() or info.st_mode&0o022:raise ValueError('runtime diagnostic directory identity')
        fd=os.open('runtime-diagnostic.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=private);before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.geteuid() or before.st_nlink!=1 or stat.S_IMODE(before.st_mode)!=0o600 or before.st_size>16384:raise ValueError('runtime diagnostic identity/limit')
        wire=os.read(fd,16385);after=os.fstat(fd)
        if len(wire)!=before.st_size or len(wire)>16384 or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('runtime diagnostic changed')
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise ValueError('runtime diagnostic duplicate field')
                result[key]=value
            return result
        observations['runtimeDiagnostic']=runtime_diagnostic_observation(json.loads(wire,object_pairs_hook=unique))
        observations.pop('runtimeDiagnosticReadFailure',None)
    except FileNotFoundError:
        if 'runtimeDiagnostic' not in observations:observations['runtimeDiagnosticAvailable']=False
    except (OSError,ValueError,TypeError) as error:observations['runtimeDiagnosticReadFailure']=failure_metadata(error)
    finally:
        for descriptor in (fd,private,folder):
            if descriptor is not None:os.close(descriptor)
    if 'runtimeDiagnostic' in observations:observations['runtimeDiagnosticAvailable']=True

def bash_transcript_observation(records):
    """Diagnostic classification only. Never return transcript text or confer execution authority."""
    call=None;result=None
    for record in records:
        if type(record) is not dict or record.get('sessionId')!=BACKEND:raise ValueError('diagnostic transcript session')
        message=record.get('message',{})
        if type(message) is not dict:raise ValueError('diagnostic transcript message')
        blocks=message.get('content',[])
        if not isinstance(blocks,list):continue
        for block in blocks:
            if type(block) is not dict:continue
            if record.get('type')=='assistant' and block.get('type')=='tool_use' and (block.get('name')=='Bash' or block.get('id')=='call-3'):
                if call is not None or block.get('id')!='call-3' or (block.get('name'),block.get('input'))!=EXPECTED_CALLS[3] or not isinstance(record.get('uuid'),str) or not record['uuid']:raise ValueError('diagnostic Bash call binding')
                call=block
            if record.get('type')=='user' and block.get('type')=='tool_result' and block.get('tool_use_id')=='call-3':
                if call is None or result is not None:raise ValueError('diagnostic Bash result binding')
                result=block
    if call is None:return {'class':'never-requested','requested':False,'resultObserved':False}
    if result is None:return {'class':'requested-no-result','requested':True,'resultObserved':False}
    observed={'requested':True,'resultObserved':True,'isError':result.get('is_error') is True,'denied':result.get('denied') is True}
    content=result.get('content')
    if type(content) is not str:raise ValueError('diagnostic Bash result content')
    if observed['denied']:
        return {**observed,'class':'permission-denied','errorCode':'classifier-blocked' if content=='Blocked by classifier' else 'permission-denied'}
    guest=re.fullmatch(r'Error \[([a-z_]{1,64})\]: guest process (?:refused|may have changed files; do not replay automatically)',content)
    if guest:
        allowed={'invalid_request','background_unsupported','escape_denied','authority_denied','compartment_required','payload_limit','invalid_payload','fd_cleanup_unavailable','root_unavailable','cwd_denied','resource_unavailable','pipe_failed','fork_failed','process_unavailable','uncertain'}
        return {**observed,'class':'guest-process-error','errorCode':guest[1] if guest[1] in allowed else 'other'}
    status=re.search(r'\n\[Exit code: (-?[0-9]{1,10}); cwd changes apply to this command only\](?:\n\[Guest process stopped: (exit|timeout|cancelled|signal)\])?$',content)
    if status and -2147483648<=int(status[1])<=2147483647:
        code=int(status[1]);stopped=status[2]
        return {**observed,'class':'nonzero-exit' if code else 'process-stopped' if stopped and stopped!='exit' else 'tool-error' if observed['isError'] else 'exit-zero',
                'exitCode':code,'stderrObserved':'\n[stderr]\n' in content,'termination':stopped or 'exit'}
    return {**observed,'class':'tool-error' if observed['isError'] else 'unclassified-result'}

def snapshot_bash_transcript(fixture,observations):
    # The admitted cwd has a fixed SDK short project key. Never glob a runtime-controlled tree.
    folders=[];fd=None
    try:
        folder=os.open(fixture['store'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);folders.append(folder)
        for part in ('projects','-workspace-folders-source'):
            info=os.fstat(folder)
            if info.st_uid!=RUNTIME_UID or info.st_mode&0o022:raise ValueError('diagnostic transcript directory identity')
            folder=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);folders.append(folder)
        info=os.fstat(folder)
        if info.st_uid!=RUNTIME_UID or info.st_mode&0o022:raise ValueError('diagnostic transcript directory identity')
        fd=os.open(BACKEND+'.jsonl',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=folder);before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=RUNTIME_UID or before.st_nlink!=1 or stat.S_IMODE(before.st_mode)!=0o600 or before.st_size>8*1024*1024:raise ValueError('diagnostic transcript identity/limit')
        parts=[];size=0
        while True:
            data=os.read(fd,min(65536,8*1024*1024-size+1))
            if not data:break
            size+=len(data)
            if size>8*1024*1024:raise ValueError('diagnostic transcript limit')
            parts.append(data)
        after=os.fstat(fd)
        if size!=before.st_size or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_mode,before.st_uid,before.st_nlink)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_mode,after.st_uid,after.st_nlink):raise ValueError('diagnostic transcript changed')
        lines=b''.join(parts).splitlines()
        if len(lines)>2048 or any(len(line)>256*1024 for line in lines):raise ValueError('diagnostic transcript record bound')
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise ValueError('diagnostic transcript duplicate field')
                result[key]=value
            return result
        observations['bashTranscript']=bash_transcript_observation([json.loads(line,object_pairs_hook=unique) for line in lines])
        observations['bashTranscriptAvailable']=True
        observations.pop('bashTranscriptReadFailure',None)
    except FileNotFoundError:
        observations.pop('bashTranscript',None);observations['bashTranscriptAvailable']=False
    except (OSError,ValueError,TypeError,KeyError,RecursionError) as error:
        observations.pop('bashTranscript',None)
        observations['bashTranscriptAvailable']=False;observations['bashTranscriptReadFailure']=failure_metadata(error)
    finally:
        if fd is not None:os.close(fd)
        for folder in reversed(folders):os.close(folder)

def persist_fixture_diagnostic(directory,observations,failure):
    # Exceptions/packets stay metadata only; normalized stderr has a separate cap.
    record={'version':1,'kind':'fixture-failure-diagnostic','failure':failure,'observations':observations,'ownershipReleased':False}
    wire=json.dumps(record,sort_keys=True,separators=(',',':')).encode()
    if len(wire)>32768:raise AssertionError('bounded fixture diagnostic')
    fd=os.open(directory/'fixture-diagnostic.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'wb',closefd=False) as stream:stream.write(wire);stream.flush();os.fsync(fd)
    finally:os.close(fd)
    return record

@contextmanager
def retained_fixture_directory(observations=None):
    """Only the explicit native/service/provider success path may remove files."""
    directory=Path(tempfile.mkdtemp(prefix='winter-fresh-engine-'));failure=None
    if observations is None:observations={'phase':'fixture-startup','nativeCleanupConfirmed':False}
    try:yield directory
    except BaseException as error:
        failure=failure_metadata(error);raise
    finally:
        if directory.exists():
            record=persist_fixture_diagnostic(directory,observations,failure)
            if failure is not None:print(json.dumps(record,sort_keys=True,separators=(',',':')),file=sys.stderr)
            print(json.dumps({'fixtureRetained':True,'retentionId':directory.name,'nativeCleanupConfirmed':observations.get('nativeCleanupConfirmed') is True,'ownershipReleased':False}),file=sys.stderr)

def finish_child(child,captures,observations,label):
    if child is None:return
    try:
        if child.poll() is None:child.kill()
    except OSError as error:observations[label+'CleanupFailure']=failure_metadata(error)
    try:
        child.wait(timeout=2);observations[label+'Reaped']=True;observations[label+'ExitCode']=child.returncode
    except (subprocess.TimeoutExpired,OSError) as error:
        observations[label+'Reaped']=False;observations[label+'CleanupFailure']=failure_metadata(error)
    for name,capture in captures.items():
        capture.finish();observations[label+name]=capture.metadata()
    if label=='provider' and 'stdout' in captures and captures['stdout'].metadata()['drainComplete']:
        observations['providerReceipt']=provider_receipt_observation(captures['stdout'].data)
    # Never close a pipe while its collector still reads it.
    for capture in captures.values():
        if not capture.thread.is_alive():capture.stream.close()
    if child.stdin is not None and not child.stdin.closed:child.stdin.close()

def execute_fixture(directory,fixture,receipt,observations):
    server=None;provider=None;admission=None;server_captures={};provider_captures={};failed=False
    try:
        observations['phase']='service-startup'
        fd=os.open(fixture['config'],os.O_RDONLY|os.O_CLOEXEC)
        try:server=subprocess.Popen([sys.executable,'-I','-S',str(fixture['binary']/'linux-supervisor.py'),'--trusted-config-fd',str(fd)],pass_fds=(fd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'LANG':'C','LC_ALL':'C'},bufsize=0)
        finally:os.close(fd)
        server_captures={name:BoundedCapture(getattr(server,name),limit,(directory,) if name=='stderr' else None) for name,limit in (('stdout',65536),('stderr',16384))}
        wait_for(lambda:(fixture['control']/'admin.sock').exists(),3,[server]);observations['phase']='provider-startup';provider,admission=start_provider(fixture,server)
        provider_captures={name:BoundedCapture(getattr(provider,name),limit,(directory,) if name=='stderr' else None) for name,limit in (('stdout',65536),('stderr',16384))}
        observations['phase']='native-admission'
        if exchange(fixture['control']/'admin.sock',{'operation':'launch-runtime','sessionId':LOGICAL})!={'started':True}:raise AssertionError('root fresh runtime launch refused')
        admit_provider(fixture,admission,[server,provider],observations);admission=None;observations['phase']='sdk-runtime'
        status=wait_for(lambda:(lambda value:value if value.get('runtime',{}).get('state') in ('stopped','retained') else None)(exchange(fixture['control']/'admin.sock',{'operation':'status','sessionId':LOGICAL})),35,[server])
        runtime=status.get('runtime',{})
        observations['nativeCleanupConfirmed']=runtime.get('cleanupConfirmed') is True
        observations['nativeStatus']={'state':runtime.get('state') if runtime.get('state') in ('stopped','retained') else 'unknown','exitCode':runtime.get('exitCode') if type(runtime.get('exitCode')) is int else None,'active':status.get('active') if type(status.get('active')) is int else None,'uncertain':status.get('uncertain') is not False}
        if status!={'active':0,'uncertain':False,'runtime':{'state':'stopped','exitCode':0,'cleanupConfirmed':True}}:raise AssertionError('native service cleanup not confirmed')
        snapshot_bash_transcript(fixture,observations)
        observations['phase']='provider-receipt';provider.terminate();provider.wait(timeout=5)
        for capture in provider_captures.values():capture.finish()
        observations['providerReceipt']=provider_receipt_observation(provider_captures['stdout'].data)
        if provider.returncode!=0 or any(capture.total>capture.limit or capture.thread.is_alive() for capture in provider_captures.values()):raise AssertionError('provider fixture worker did not complete cleanly')
        if observations['providerReceipt']!={'passed':True,'turns':5,'peerValidated':True}:raise AssertionError('provider worker execution receipt')
        observations['phase']='persisted-evidence';evidence=persisted_evidence(fixture)
        observations['phase']='service-reap';server.stdin.close();server.wait(timeout=5);observations['serviceReaped']=True;observations['serviceExitCode']=server.returncode
        if server.returncode!=0:raise AssertionError('root service retained cleanup obligation')
        for capture in server_captures.values():capture.finish()
        if any(not capture.metadata()['drainComplete'] or capture.total>capture.limit for capture in server_captures.values()):raise AssertionError('service diagnostic drain unconfirmed')
        # Diagnostic or parser errors can never reach this explicit release path.
        observations['phase']='complete'
        return {'passed':True,'freshEngineExecutionVerified':True,'linuxExecutionVerified':True,'vmExecutionVerified':False,'coldContinuityVerified':False,'productionAvailabilityEnabled':False,'reviewedArtifactDigests':receipt['artifacts'],'compileReceiptSha256':receipt['compileReceiptSha256'],**evidence}
    except BaseException:
        failed=True;snapshot_runtime_diagnostic(fixture,observations)
        if 'store' in fixture:snapshot_bash_transcript(fixture,observations)
        raise
    finally:
        if admission is not None:admission.close()
        finish_child(provider,provider_captures,observations,'provider')
        finish_child(server,server_captures,observations,'service')
        if failed:snapshot_runtime_diagnostic(fixture,observations)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--artifacts',type=Path,required=True);parser.add_argument('--reviewed-receipt',type=Path,required=True);args=parser.parse_args()
    receipt=build.validate_receipt(build.provenance.json_read(args.reviewed_receipt),args.artifacts)
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site:raise SystemExit('Admitted staged Linux root fixture required; no fallback')
    observations={'reviewedReceiptSha256':build.digest(args.reviewed_receipt),'compileReceiptSha256':receipt['compileReceiptSha256'],'phase':'fixture-staging','nativeCleanupConfirmed':False,'serviceReaped':False,'providerReaped':False}
    with retained_fixture_directory(observations) as directory:
        fixture=create_fixture(directory,args.artifacts,receipt);result=execute_fixture(directory,fixture,receipt,observations)
        result['reviewedReceiptSha256']=observations['reviewedReceiptSha256'];shutil.rmtree(directory);print(json.dumps(result))
if __name__=='__main__':main()

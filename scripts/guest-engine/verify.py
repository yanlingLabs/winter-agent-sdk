#!/usr/bin/env python3
"""Reviewed disposable Linux fresh SDK-engine fixture; no VM, release or cold-resume claim.
Only a root-reviewed matching source/artifact receipt can reach privileged staging.
Guest provider packet parsing belongs to the separate fixture worker, not this root harness.
"""
import argparse,array,fcntl,importlib.util,json,os,re,shutil,socket,struct,subprocess,sys,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BUILD_PATH=Path(__file__).with_name('build.py');spec=importlib.util.spec_from_file_location('fresh_build',BUILD_PATH);build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
RUNTIME_UID=20001;TOOL_UID=10001;WORKSPACE_GID=10000;PROVIDER_UID=30001
LOGICAL='conversation-fresh';BACKEND='01234567-89ab-4cde-8fab-0123456789ab'

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
    records=[json.loads(line) for line in transcripts[0].read_text().splitlines()];state_records=[json.loads(line) for line in states[0].read_text().splitlines()]
    for path in store.rglob('*.jsonl'):
        if path.stat().st_size>8*1024*1024 or b'DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET' in path.read_bytes():raise AssertionError('fixture credential leaked or store evidence bound')
    calls={};results={};assistant_ids=set();final=False
    for record in records:
        if record.get('sessionId')!=BACKEND:raise AssertionError('cross-session transcript record')
        if record.get('type')=='assistant':assistant_ids.add(record.get('uuid'))
        content=record.get('message',{}).get('content',[])
        if not isinstance(content,list):continue
        for block in content:
            if not isinstance(block,dict):continue
            if record.get('type')=='assistant' and block.get('type')=='tool_use':calls[block.get('id')]=block.get('name')
            if record.get('type')=='user' and block.get('type')=='tool_result':results[block.get('tool_use_id')]=block
            if record.get('type')=='assistant' and block.get('type')=='text' and block.get('text')=='fresh-engine-complete':final=True
    if not final or not {'Read','Edit','Write','Bash'}<=set(calls.values()) or any(key not in results or results[key].get('is_error') is True for key in calls):raise AssertionError('actual SDK transcript missing completed successful tool history')
    native=[record for record in state_records if record.get('kind')=='native-state']
    if not native or any(record.get('sessionId')!=BACKEND or record.get('anchorUuid') not in assistant_ids for record in native) or 'fixture-native-state' not in json.dumps(native):raise AssertionError('actual SDK provider native state binding missing')
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

def admit_provider(fixture,admission,children):
    # Root-only admin sends the actual live namespace-init pidfd. Own all installed
    # rights before validating the bounded framed response; malformed packets leak
    # neither descriptors nor guessed PID authority.
    def obtain():
        fds=[]
        try:
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as channel:
                channel.settimeout(1);channel.connect(str(fixture['control']/'admin.sock'));request=json.dumps({'operation':'runtime-owner','sessionId':LOGICAL}).encode();channel.sendall(struct.pack('!I',len(request))+request)
                data,ancillary,flags,_=channel.recvmsg(65536,socket.CMSG_SPACE(16*array.array('i').itemsize),socket.MSG_CMSG_CLOEXEC)
                for level,kind,body in ancillary:
                    if (level,kind)==(socket.SOL_SOCKET,socket.SCM_RIGHTS):fds.extend(array.array('i',body[:len(body)-len(body)%array.array('i').itemsize]))
                if not data:return False # owner not running yet; no admission/effect retried
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

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--artifacts',type=Path,required=True);parser.add_argument('--reviewed-receipt',type=Path,required=True);args=parser.parse_args()
    receipt=build.validate_receipt(json.loads(args.reviewed_receipt.read_text()),args.artifacts)
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site:raise SystemExit('Explicit Linux root fixture via python -I -S required; no fallback')
    with tempfile.TemporaryDirectory(prefix='winter-fresh-engine-') as directory:
        fixture=create_fixture(Path(directory),args.artifacts,receipt);fd=os.open(fixture['config'],os.O_RDONLY|os.O_CLOEXEC)
        server=subprocess.Popen([sys.executable,'-I','-S',str(fixture['binary']/'linux-supervisor.py'),'--trusted-config-fd',str(fd)],pass_fds=(fd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'LANG':'C','LC_ALL':'C'},bufsize=0);os.close(fd);provider=None;admission=None
        try:
            wait_for(lambda:(fixture['control']/'admin.sock').exists(),3,[server]);provider,admission=start_provider(fixture,server)
            if exchange(fixture['control']/'admin.sock',{'operation':'launch-runtime','sessionId':LOGICAL})!={'started':True}:raise AssertionError('root fresh runtime launch refused')
            admit_provider(fixture,admission,[server,provider]);admission=None
            status=wait_for(lambda:(lambda value:value if value.get('runtime',{}).get('state') in ('stopped','retained') else None)(exchange(fixture['control']/'admin.sock',{'operation':'status','sessionId':LOGICAL})),35,[server])
            if status!={'active':0,'uncertain':False,'runtime':{'state':'stopped','exitCode':0,'cleanupConfirmed':True}}:raise AssertionError(('native service cleanup not confirmed',status))
            evidence=persisted_evidence(fixture)
            provider.terminate() # fixture-only parser stops after independently confirmed runtime teardown
            provider_out,provider_err=provider.communicate(timeout=5)
            if provider.returncode!=0 or len(provider_out)>65536 or len(provider_err)>16384:raise AssertionError('provider fixture worker did not complete cleanly')
            provider_receipt=json.loads(provider_out)
            if provider_receipt.get('passed') is not True or provider_receipt.get('turns')!=5 or provider_receipt.get('peerValidated') is not True:raise AssertionError('provider worker execution receipt')
            server.stdin.close();server.wait(timeout=5)
            if server.returncode!=0:raise AssertionError('root service retained cleanup obligation')
            print(json.dumps({'passed':True,'freshEngineExecutionVerified':True,'linuxExecutionVerified':True,'vmExecutionVerified':False,'coldContinuityVerified':False,'productionAvailabilityEnabled':False,'reviewedArtifactDigests':receipt['artifacts'],**evidence}))
        finally:
            if admission is not None:admission.close()
            if provider is not None:
                if provider.poll() is None:provider.kill()
                provider.wait(timeout=2)
                provider.stdout.close();provider.stderr.close()
            if server.poll() is None:server.kill();server.wait(timeout=2)
            server.stdout.close();server.stderr.close()
            if not server.stdin.closed:server.stdin.close()
if __name__=='__main__':main()

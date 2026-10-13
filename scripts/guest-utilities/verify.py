"""Sealed, externally admitted direct Linux tool-view fixture. No SDK/provider/VM claim."""
import os,sys
def admitted():
    value=getattr(sys,'_winter_utility_stage_admission',None)
    if __name__!='__main__' and os.geteuid()!=0:return value
    if value is None or sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode or value.pid!=os.getpid():raise SystemExit('sealed externally admitted utility parent required before project imports')
    if __file__!=value.directory+'/source/scripts/guest-utilities/verify.py':raise SystemExit('fixed sealed utility runner required')
    return value
ADMISSION=admitted()
import hashlib,json,re,socket,stat,struct,subprocess,tempfile,threading,time
from pathlib import Path
HERE=Path(__file__).resolve().parent

STDOUT_LIMIT=65536
STDERR_LIMIT=16384
TEXT_LIMIT=4096
ERROR_CLASSES={'Error','AssertionError','ValueError','TypeError','ModuleNotFoundError','ImportError','OSError','TimeoutExpired','SyntaxError','ReferenceError','RuntimeError','SystemExit'}
CLIENT_MESSAGES=('fixed Linux utility client required','fixed runtime UID required','fixed fixture endpoint required','exact utility smoke result required','file helper trusted path refusal required','file helper source symlink refusal required','readonly source must remain readonly','plan source must remain readonly','foreground descendant receipt required','cancel positive control required','cancellation must retain effect uncertainty','guest process denied','guest process response lost','malformed process receipt','invalid process receipt','invalid process outcome','invalid process stream','unbounded process response')
FAILURE_CODES={'authority_denied','invalid_request','compartment_required','root_unavailable','cwd_denied','invalid_payload','payload_limit','resource_unavailable','pipe_failed','fork_failed','fd_cleanup_unavailable','invalid_response','binding_mismatch','transport_lost','worker_failed'}
SMOKE_MARKERS=('tool-device-stdin-fds-ok','tool-device-inventory-ok','tool-device-boundaries-ok','tool-entropy-multiprocessing-ok','tool-device-smoke-ok')
PROCESS_CLASSES={'ModuleNotFoundError','ImportError','AssertionError','SyntaxError','PermissionError','unrecognized'}
PROCESS_CATEGORIES={'module_missing','import_error','assertion_failed','syntax_error','permission_denied','shared_library_load','empty','unknown'}
ERRNO_TOKENS=('EACCES','EPERM','ENOENT','ENOTDIR','ELOOP','ECONNREFUSED','ECONNRESET','EPIPE','EAGAIN','EMFILE','ENOSPC','EROFS','ENXIO')
OPERATIONS=('connect','open','spawn','exec','read','write','bind')
PHASES={'fixture-copy','service-startup','client-ordinary','client-plan','client-ordinary-receipt','client-plan-receipt','source-canaries','native-quiescence','service-close-wait','outer-mount-observation','complete'}


def normalized_stderr(data):
    # Retain only fixed source messages and known exception classes. Arbitrary
    # strings, stack/source frames, paths, credentials and authority never persist.
    text=data[:STDERR_LIMIT].decode('utf-8',errors='replace');lines=[]
    for line in text.splitlines():
        if re.match(r'^\s*\d+\s*\|',line):continue
        classes=[name for name in ERROR_CLASSES if re.search(r'\b'+name+r'\s*:',line) or name=='AssertionError' and re.fullmatch(r'\s*AssertionError\s*',line)]
        messages=[message for message in CLIENT_MESSAGES if message in line]
        if classes or messages:
            value=(sorted(classes)[0] if classes else 'diagnostic')+': '+(messages[0] if messages else '[message redacted]')
            if value not in lines:lines.append(value)
        for token in ERRNO_TOKENS:
            value='errno: '+token
            if re.search(r'\b'+token+r'\b',line) and value not in lines:lines.append(value)
        for operation in OPERATIONS:
            value='operation: '+operation
            if re.search(r'\b'+operation+r'\b',line) and value not in lines:lines.append(value)
        if re.search(r'\bwarn(?:ing)?\b',line,re.IGNORECASE) and 'warning: observed' not in lines:lines.append('warning: observed')
    if not lines and text:lines=['[stderr details redacted]']
    return '\n'.join(lines).encode()[:TEXT_LIMIT].decode('utf-8',errors='ignore')


def stdout_observation(data):
    if not isinstance(data,bytes):return {'classification':'unavailable','capturedBytes':0,'captureLimit':STDOUT_LIMIT,'truncated':False}
    record={'capturedBytes':min(len(data),STDOUT_LIMIT),'captureLimit':STDOUT_LIMIT,'truncated':len(data)>STDOUT_LIMIT}
    if record['truncated']:return {**record,'classification':'over_limit'}
    if not data:return {**record,'classification':'empty'}
    def unique(pairs):
        result={}
        for key,value in pairs:
            if key in result:raise ValueError('duplicate diagnostic JSON field')
            result[key]=value
        return result
    try:value=json.loads(data,object_pairs_hook=unique)
    except (ValueError,UnicodeError,RecursionError):return {**record,'classification':'invalid_json'}
    if type(value) is not dict:return {**record,'classification':'json_non_object'}
    if value.get('kind')=='winter-tool-utility-client-failure':
        process=value.get('process')
        keys={'kind','version','phase','scenario','invocation','process'}
        fields={'exitCode','termination','stdoutMarkers','stderrClass','stderrCategory','traceback','errnoTokens'}
        if set(value)!=keys or type(value.get('version')) is not int or value['version']!=1 or value.get('phase')!='smoke' or value.get('scenario')!='ordinary' or type(value.get('invocation')) is not int or value['invocation'] not in (0,1) or type(process) is not dict or set(process)!=fields:return {**record,'classification':'invalid_failure_observation'}
        markers=process['stdoutMarkers']
        if type(process['exitCode']) is not int or not 0<=process['exitCode']<=255 or type(process['termination']) is not str or process['termination'] not in ('exit','timeout','output_limit') or type(markers) is not list or len(markers)>len(SMOKE_MARKERS) or any(type(marker) is not str or marker not in SMOKE_MARKERS for marker in markers) or len(set(markers))!=len(markers) or type(process['stderrClass']) is not str or process['stderrClass'] not in PROCESS_CLASSES or type(process['stderrCategory']) is not str or process['stderrCategory'] not in PROCESS_CATEGORIES:return {**record,'classification':'invalid_failure_observation'}
        trace=process['traceback']
        if type(trace) is not list or len(trace)>8 or any(type(frame) is not dict or set(frame)!={'source','line'} or type(frame['source']) is not str or frame['source'] not in ('stdin','string') or type(frame['line']) is not int or not 1<=frame['line']<=10000 for frame in trace):return {**record,'classification':'invalid_failure_observation'}
        tokens=process['errnoTokens']
        if type(tokens) is not list or len(tokens)>len(ERRNO_TOKENS) or any(type(token) is not str or token not in ERRNO_TOKENS for token in tokens) or len(set(tokens))!=len(tokens):return {**record,'classification':'invalid_failure_observation'}
        return {**record,'classification':'utility_process_failure','phase':'smoke','invocation':value['invocation'],'process':{key:process[key] for key in fields}}
    if value.get('passed') is False or value.get('ok') is False:
        failure=value.get('failure');code=failure.get('code') if type(failure) is dict else value.get('code')
        return {**record,'classification':'json_failure','failureCode':code if isinstance(code,str) and code in FAILURE_CODES else 'unrecognized'}
    return {**record,'classification':'utility_client_receipt' if value.get('kind')=='winter-tool-utility-client' else 'json_object'}


def client_observation(scenario,exit_code,out,err):
    stderr=err if isinstance(err,bytes) else b''
    return {'scenario':scenario,'exitCode':exit_code if type(exit_code) is int and -2147483648<=exit_code<=2147483647 else None,'stdout':stdout_observation(out),'stderr':{'capturedBytes':min(len(stderr),STDERR_LIMIT),'captureLimit':STDERR_LIMIT,'truncated':len(stderr)>STDERR_LIMIT,'normalizedText':normalized_stderr(stderr),'textLimit':TEXT_LIMIT}}


def failure_record(error,observations):
    phase=observations.get('phase','fixture-copy');code=observations.get('serviceExitCode')
    return {'kind':'winter-utility-failure','class':type(error).__name__ if type(error).__name__ in ERROR_CLASSES else 'Exception','phase':phase if type(phase) is str and phase in PHASES else 'unknown','clients':observations.get('clients',[]),'serviceReaped':observations.get('serviceReaped') is True,'serviceExitCode':code if type(code) is int and -2147483648<=code<=2147483647 else None,'serviceCleanupConfirmed':observations.get('serviceCleanupConfirmed') is True,'nativeCleanupConfirmed':observations.get('nativeCleanupConfirmed') is True,'fixtureRetained':True,'generalToolAvailabilityEnabled':False}


def diagnostic_wire(error,observations,canonical):
    record=failure_record(error,observations);wire=canonical(record).encode()
    if len(wire)>32768:
        record={key:record[key] for key in ('kind','class','phase','serviceReaped','serviceExitCode','serviceCleanupConfirmed','nativeCleanupConfirmed','fixtureRetained','generalToolAvailabilityEnabled')}
        record['diagnosticTruncated']=True;wire=canonical(record).encode()
    return record,wire


def outer_mountinfo():
    fd=os.open('/proc/self/mountinfo',os.O_RDONLY|os.O_CLOEXEC)
    try:
        chunks=[];count=0
        while True:
            wire=os.read(fd,min(65536,1024*1024-count+1))
            if not wire:break
            count+=len(wire)
            if count>1024*1024:raise ValueError('outer mountinfo bound')
            chunks.append(wire)
        return b''.join(chunks)
    finally:os.close(fd)


class OuterMountGuard:
    def __init__(self,read=outer_mountinfo):
        self.read=read;self.before=read();self.changed=False;self.failed=False;self.samples=0;self.stop=threading.Event()
        self.thread=threading.Thread(target=self.watch,daemon=True);self.thread.start()
    def sample(self):
        try:
            wire=self.read();self.samples+=1
            if wire!=self.before:self.changed=True
        except BaseException:self.failed=True
    def watch(self):
        while not self.stop.wait(.01):self.sample()
    def finish(self):
        self.sample();self.stop.set();self.thread.join(timeout=1);self.sample()
        if self.changed or self.failed or self.thread.is_alive():raise ValueError('original outer mount namespace changed or observation failed')
        return {'unchanged':True,'beforeSha256':hashlib.sha256(self.before).hexdigest(),'afterSha256':hashlib.sha256(self.before).hexdigest(),'duringAndAfterSamples':self.samples}


def checked_module(name):
    relative='source/scripts/guest-utilities/'+name+'.py';folder=os.dup(ADMISSION.root_fd)
    try:
        parts=relative.split('/')
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder);os.close(folder);folder=child
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=folder)
        try:
            info=os.fstat(fd);wire=os.read(fd,32*1024*1024+1)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o400 or len(wire)!=info.st_size or hashlib.sha256(wire).hexdigest()!=ADMISSION.receipt['files'][relative]['sha256']:raise ValueError('sealed utility module bytes required')
        finally:os.close(fd)
    finally:os.close(folder)
    from types import ModuleType
    module=ModuleType('admitted_utility_'+name);module.__file__=ADMISSION.directory+'/'+relative
    exec(compile(wire,module.__file__,'exec'),module.__dict__);return module


def exchange(path,value):
    wire=json.dumps(value,separators=(',',':')).encode()
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as channel:
        channel.settimeout(2);channel.connect(str(path));channel.sendall(struct.pack('!I',len(wire))+wire)
        def exact(size):
            result=bytearray()
            while len(result)<size:
                part=channel.recv(size-len(result))
                if not part:raise ValueError('utility control channel closed')
                result.extend(part)
            return bytes(result)
        size=struct.unpack('!I',exact(4))[0]
        if not 1<=size<=65536:raise ValueError('utility admin reply bound')
        return json.loads(exact(size))


def quiescent(control,sid,seconds=3):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        value=exchange(control/'admin.sock',{'operation':'status','sessionId':sid})
        if value=={'active':0,'uncertain':False}:return
        time.sleep(.02)
    raise ValueError('native wait/cleanup/debt unconfirmed')


def client_oracle(record,oracle,smoke_hash,scenario):
    if scenario=='plan':
        if record!={'kind':'winter-tool-utility-client','scenario':'plan','uid':20002,'planReadonly':True,'generalToolAvailabilityEnabled':False} or record['planReadonly'] is not True or record['generalToolAvailabilityEnabled'] is not False:raise ValueError('exact plan utility receipt')
        return
    keys={'kind','scenario','uid','smokeSha256','results','fileRefusals','sourceSymlinkRefused','readonlyRefused','descendantReceipt','cancelledEffectsUncertain','generalToolAvailabilityEnabled'}
    if type(record) is not dict or set(record)!=keys or record['kind']!='winter-tool-utility-client' or record['scenario']!='ordinary' or type(record['uid']) is not int or record['uid']!=20001 or record['smokeSha256']!=smoke_hash or record['generalToolAvailabilityEnabled'] is not False or any(record[key] is not True for key in ('fileRefusals','sourceSymlinkRefused','readonlyRefused','descendantReceipt','cancelledEffectsUncertain')) or type(record['results']) is not list or len(record['results'])!=2:raise ValueError('exact ordinary utility receipt')
    for result in record['results']:oracle.validate_result(result)


def environment_mode(guest,item):
    programs={'/bin/bash','/bin/cat','/usr/bin/git','/usr/bin/python3','/usr/bin/openssl','/usr/bin/mktemp'}
    loaders={'/lib/ld-linux-aarch64.so.1','/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1'}
    allowed=item['role']=='executable' and guest in programs or item['role']=='library' and guest in loaders
    if type(item['executable']) is not bool or item['executable'] is not allowed:raise ValueError('fixed copied execution-mode intent required')
    return 0o555 if item['executable'] else 0o444


def execute(directory,parent,oracle,observations=None):
    if observations is None:observations={}
    observations.update(phase='fixture-copy',clients=[],serviceReaped=False,serviceExitCode=None,serviceCleanupConfirmed=False,nativeCleanupConfirmed=False)
    receipt=ADMISSION.receipt;directory=Path(directory);directory.chmod(0o711);binary=directory/'bin';binary.mkdir(mode=0o755);environment=directory/'environment';environment.mkdir(mode=0o755);control=directory/'control';control.mkdir(mode=0o711)
    def copy(relative,target,mode):
        fd=parent.leaf(ADMISSION.root_fd,relative)
        try:wire=parent.read_fd(fd,parent.MAX_ARTIFACT,True)
        finally:os.close(fd)
        if parent.sha(wire)!=receipt['files'][relative]['sha256']:raise ValueError('sealed fixture copy changed')
        parent.write_file(target,wire,mode)
    for name in parent.ARTIFACTS:copy('artifacts/'+name,binary/name,0o555)
    copy('source/packages/runtime/src/guest/linux-supervisor.py',binary/'linux-supervisor.py',0o555)
    for guest,item in receipt['utilityCapture']['outputs'].items():
        target=environment/guest[1:];target.parent.mkdir(parents=True,exist_ok=True,mode=0o755);copy('environment'+guest,target,environment_mode(guest,item))
    source=directory/'source';source.mkdir(mode=0o2770);os.chown(source,10001,10000);source.chmod(0o2770)
    readonly=directory/'readonly';readonly.mkdir(mode=0o2770);os.chown(readonly,10001,10000);readonly.chmod(0o2770);(readonly/'sentinel').write_text('readonly-fixture');(readonly/'sentinel').chmod(0o444)
    stores=directory/'stores';stores.mkdir(mode=0o711);store=stores/'private';store.mkdir(mode=0o700);os.chown(store,20001,20001)
    (source/'runtime-escape').symlink_to(str(store/'private-canary'))
    (store/'private-canary').write_text('private-fixture-marker');(store/'private-canary').chmod(0o600)
    conversations=[]
    for sid,uid,tool,backend,policy in [('conversation-utility',20001,10001,'backend-utility','auto'),('conversation-plan',20002,10002,'backend-plan','plan')]:
        conversations.append({'authority':{'workspaceId':'utility-workspace','sessionId':backend,'incarnationId':'utility-incarnation','leaseEpoch':1,'configRevision':1,'grantRevision':1,'policyRevision':1},'logicalSessionId':sid,'runtimeUid':uid,'toolUid':tool,'workspaceGid':10000,'policy':policy,'roots':[{'id':'source','guestPath':'/workspace/folders/source','readOnly':False,'source':str(source)},{'id':'readonly','guestPath':'/workspace/folders/readonly','readOnly':True,'source':str(readonly)}]})
    config={'protectedStoreDirectories':[str(store)],'guestBootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'artifacts':{key:{'path':str(binary/name),'sha256':receipt['files']['artifacts/'+name]['sha256']} for key,name in [('launcher','toolLauncher'),('fileWorker','fileWorker'),('processWorker','processWorker')]},'environment':str(environment),'controlDirectory':str(control),'conversations':conversations}
    parent.write_file(directory/'bootstrap.json',parent.canonical(config).encode(),0o400);fd=os.open(directory/'bootstrap.json',os.O_RDONLY|os.O_CLOEXEC);server=None;clients=[];complete=False;outer=OuterMountGuard();outer_result=None
    try:
        observations['phase']='service-startup'
        server=subprocess.Popen(['/usr/bin/python3','-I','-S','-B',str(binary/'linux-supervisor.py'),'--trusted-config-fd',str(fd)],pass_fds=(fd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=parent.ENV,bufsize=0);os.close(fd);fd=None
        outer.sample()
        deadline=time.monotonic()+3
        while not (control/'admin.sock').exists():
            if server.poll() is not None or time.monotonic()>deadline:raise ValueError('utility supervisor startup failed')
            time.sleep(.02)
        records=[]
        for scenario,uid,sid in [('ordinary',20001,'conversation-utility'),('plan',20002,'conversation-plan')]:
            observations['phase']='client-'+scenario
            def identity():os.setgroups([]);os.setgid(uid);os.setuid(uid)
            child=subprocess.Popen([str(binary/'utilityClient'),str(control/sid/'tools.sock'),scenario],preexec_fn=identity,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','HOME':'/nonexistent'},start_new_session=True);clients.append(child)
            try:out,err=child.communicate(timeout=75)
            except subprocess.TimeoutExpired as error:
                observations['clients'].append(client_observation(scenario,child.returncode,error.output,error.stderr));raise
            observations['clients'].append(client_observation(scenario,child.returncode,out,err))
            if child.returncode!=0 or err or len(out)>65536:raise ValueError('utility runtime-UID client failed/bounded output')
            observations['phase']='client-'+scenario+'-receipt'
            record=parent.json_wire(out);client_oracle(record,oracle,receipt['smokeSha256'],scenario);records.append(record);quiescent(control,sid)
        observations['phase']='source-canaries'
        # Quiescence is backed by the existing supervisor's immutable wait receipt;
        # source canaries are an additional descendant check, never its substitute.
        time.sleep(1.1)
        if any((source/name).read_text()!='ready-after-setsid' for name in ('descendant-ready','cancel-ready')) or (source/'writable-control').read_text()!='writable-source-positive' or any((source/name).exists() for name in ('descendant-orphan','cancel-orphan','plan-write')) or (readonly/'write').exists():raise ValueError('descendant/source positive-control fence')
        observations['phase']='native-quiescence'
        quiescent(control,'conversation-utility');quiescent(control,'conversation-plan')
        parent.write_file(directory/'client-records.json',parent.canonical(records).encode(),0o600)
        outer.sample()
        observations['phase']='service-close-wait'
        server.stdin.close();server.stdin=None;out,err=server.communicate(timeout=5)
        observations.update(serviceReaped=True,serviceExitCode=server.returncode)
        if server.returncode!=0 or err or out!=b'{"fullGuestExecutionEnabled":false,"ready":true}\n':raise ValueError('root service wait/close confirmation required')
        observations.update(serviceCleanupConfirmed=True,nativeCleanupConfirmed=True,phase='outer-mount-observation')
        outer_result=outer.finish()
        observations['phase']='complete'
        complete=True
        return {'kind':'winter-tool-utility-native-fixture','passed':True,'directToolViewExecutionVerified':True,'firstSDKEngineExecutionVerified':False,'linuxExecutionVerified':True,'vmExecutionVerified':False,'generalToolAvailabilityEnabled':False,'nativeCleanupConfirmed':True,'clientRecordsSha256':parent.sha(parent.canonical(records).encode()),'approvedReceiptSha256':ADMISSION.receipt_sha,'smokeSha256':receipt['smokeSha256'],'freshInvocations':2,'outerMountObservation':outer_result}
    finally:
        if fd is not None:os.close(fd)
        if not complete:
            # Retain every failure directory. Killing/reaping alone never makes it success.
            for child in clients:
                if child.poll() is None:child.kill()
                try:child.wait(timeout=2)
                except subprocess.TimeoutExpired:pass
            if server is not None:
                if server.stdin is not None and not server.stdin.closed:server.stdin.close()
                try:
                    server.wait(timeout=5)
                    observations.update(serviceReaped=True,serviceExitCode=server.returncode)
                except subprocess.TimeoutExpired:
                    server.kill();server.wait(timeout=2)
                    observations.update(serviceReaped=True,serviceExitCode=server.returncode,serviceCleanupConfirmed=False)
            outer.finish()


def main():
    parent=checked_module('stage');parent.verify_staged(ADMISSION.directory,ADMISSION.receipt_sha,ADMISSION.parent_sha)
    capture=checked_module('closure');capture.validate_capture(ADMISSION.receipt['utilityCapture'],Path(ADMISSION.directory)/'environment',sealed=True)
    oracle=checked_module('oracle');directory=Path(tempfile.mkdtemp(prefix='winter-utility-run-',dir='/tmp'))
    observations={'phase':'fixture-copy'}
    try:
        result=execute(directory,parent,oracle,observations)
    except BaseException as error:
        diagnostic,wire=diagnostic_wire(error,observations,parent.canonical)
        parent.write_file(directory/'failure.json',wire,0o600)
        print(parent.canonical(diagnostic),file=sys.stderr)
        print(parent.canonical({'fixtureRetained':True,'retentionId':directory.name,'nativeCleanupConfirmed':diagnostic['nativeCleanupConfirmed']}),file=sys.stderr);raise
    else:
        parent.write_file(directory/'result.json',parent.canonical(result).encode(),0o600)
        print(parent.canonical(result))


if __name__=='__main__':main()

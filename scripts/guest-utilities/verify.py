"""Sealed, externally admitted direct Linux tool-view fixture. No SDK/provider/VM claim."""
import os,sys
def admitted():
    value=getattr(sys,'_winter_utility_stage_admission',None)
    if __name__!='__main__' and os.geteuid()!=0:return value
    if value is None or sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode or value.pid!=os.getpid():raise SystemExit('sealed externally admitted utility parent required before project imports')
    if __file__!=value.directory+'/source/scripts/guest-utilities/verify.py':raise SystemExit('fixed sealed utility runner required')
    return value
ADMISSION=admitted()
import hashlib,json,socket,stat,struct,subprocess,tempfile,threading,time
from pathlib import Path
HERE=Path(__file__).resolve().parent


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


def execute(directory,parent,oracle):
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
        server=subprocess.Popen(['/usr/bin/python3','-I','-S','-B',str(binary/'linux-supervisor.py'),'--trusted-config-fd',str(fd)],pass_fds=(fd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=parent.ENV,bufsize=0);os.close(fd);fd=None
        outer.sample()
        deadline=time.monotonic()+3
        while not (control/'admin.sock').exists():
            if server.poll() is not None or time.monotonic()>deadline:raise ValueError('utility supervisor startup failed')
            time.sleep(.02)
        records=[]
        for scenario,uid,sid in [('ordinary',20001,'conversation-utility'),('plan',20002,'conversation-plan')]:
            def identity():os.setgroups([]);os.setgid(uid);os.setuid(uid)
            child=subprocess.Popen([str(binary/'utilityClient'),str(control/sid/'tools.sock'),scenario],preexec_fn=identity,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','HOME':'/nonexistent'},start_new_session=True);clients.append(child)
            out,err=child.communicate(timeout=75)
            if child.returncode!=0 or err or len(out)>65536:raise ValueError('utility runtime-UID client failed/bounded output')
            record=parent.json_wire(out);client_oracle(record,oracle,receipt['smokeSha256'],scenario);records.append(record);quiescent(control,sid)
        # Quiescence is backed by the existing supervisor's immutable wait receipt;
        # source canaries are an additional descendant check, never its substitute.
        time.sleep(1.1)
        if any((source/name).read_text()!='ready-after-setsid' for name in ('descendant-ready','cancel-ready')) or (source/'writable-control').read_text()!='writable-source-positive' or any((source/name).exists() for name in ('descendant-orphan','cancel-orphan','plan-write')) or (readonly/'write').exists():raise ValueError('descendant/source positive-control fence')
        quiescent(control,'conversation-utility');quiescent(control,'conversation-plan')
        parent.write_file(directory/'client-records.json',parent.canonical(records).encode(),0o600)
        outer.sample()
        server.stdin.close();server.stdin=None;out,err=server.communicate(timeout=5)
        if server.returncode!=0 or err or out!=b'{"fullGuestExecutionEnabled":false,"ready":true}\n':raise ValueError('root service wait/close confirmation required')
        outer_result=outer.finish()
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
                try:server.wait(timeout=5)
                except subprocess.TimeoutExpired:server.kill();server.wait(timeout=2)
            outer.finish()


def main():
    parent=checked_module('stage');parent.verify_staged(ADMISSION.directory,ADMISSION.receipt_sha,ADMISSION.parent_sha)
    capture=checked_module('closure');capture.validate_capture(ADMISSION.receipt['utilityCapture'],Path(ADMISSION.directory)/'environment',sealed=True)
    oracle=checked_module('oracle');directory=Path(tempfile.mkdtemp(prefix='winter-utility-run-',dir='/tmp'))
    try:
        result=execute(directory,parent,oracle)
    except BaseException as error:
        parent.write_file(directory/'failure.json',parent.canonical({'kind':'winter-utility-failure','class':type(error).__name__,'nativeCleanupConfirmed':False,'generalToolAvailabilityEnabled':False}).encode(),0o600)
        print(parent.canonical({'fixtureRetained':True,'retentionId':directory.name,'nativeCleanupConfirmed':False}),file=sys.stderr);raise
    else:
        parent.write_file(directory/'result.json',parent.canonical(result).encode(),0o600)
        print(parent.canonical(result))


if __name__=='__main__':main()

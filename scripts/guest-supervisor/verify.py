#!/usr/bin/env python3
"""Disposable Linux CI: actual UID-authenticated service + native helpers + compiled SDK client.
No VM, containers, daemon, providers, credentials, global installs or production availability.
"""
import argparse,base64,hashlib,json,os,re,shutil,socket,struct,subprocess,sys,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def checked(args):
    result=subprocess.run(list(map(str,args)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    if result.returncode:raise AssertionError((args,result.returncode,result.stderr[-2000:]))
    return result.stdout

def exchange(path,value):
    data=json.dumps(value,separators=(',',':')).encode();channel=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);channel.settimeout(10)
    try:
        channel.connect(str(path));channel.sendall(struct.pack('!I',len(data))+data)
        def exact(count):
            result=b''
            while len(result)<count:
                part=channel.recv(count-len(result))
                if not part:raise AssertionError('private channel closed')
                result+=part
            return result
        size=struct.unpack('!I',exact(4))[0];assert size<=2*1024*1024;return json.loads(exact(size))
    finally:channel.close()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--runtime-client',type=Path,required=True);args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0:raise SystemExit('Explicit isolated Linux root fixture required; no fallback')
    compiler=shutil.which('cc');assert compiler,'existing Linux compiler required'
    with tempfile.TemporaryDirectory(prefix='winter-tool-supervisor-') as directory:
        root=Path(directory);root.chmod(0o711);binary=root/'bin';binary.mkdir(mode=0o755);control=root/'control';control.mkdir(mode=0o711);environment=root/'environment';environment.mkdir()
        compiled={}
        for name,source in [('launcher','linux-tool-compartment.c'),('fileWorker','file-worker.c'),('processWorker','process-worker.c')]:
            target=binary/name;checked([compiler,'-std=c11','-O2','-Wall','-Wextra','-Werror','-static',ROOT/'packages/runtime/src/guest'/source,'-o',target]);target.chmod(0o555)
            compiled[name]={'path':str(target),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
        client=binary/'runtime-client';shutil.copyfile(args.runtime_client,client);client.chmod(0o555)
        service=binary/'linux-supervisor.py';shutil.copyfile(ROOT/'packages/runtime/src/guest/linux-supervisor.py',service);service.chmod(0o555)
        for executable in ['/bin/bash','/bin/sleep','/bin/cat','/usr/bin/setsid']:
            target=environment/executable.lstrip('/');target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(executable,target);target.chmod(0o555)
            libraries=set(re.findall(r'(/[^\s()]+)',checked(['ldd',executable]).decode()))
            for library in libraries:
                path=environment/library.lstrip('/');path.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(library,path);path.chmod(0o555)
        checked([compiler,'-O2','-Wall','-Wextra','-Werror','-pthread',ROOT/'scripts/guest-supervisor/glibc-tools.c','-o',environment/'bin/glibc-tools']);(environment/'bin/glibc-tools').chmod(0o555)
        source=root/'source';source.mkdir(mode=0o2770);os.chown(source,10001,10000);source.chmod(0o2770)
        readonly=root/'readonly';readonly.mkdir();readonly.chmod(0o777);(readonly/'sentinel').write_bytes(b'private-other-root');(readonly/'sentinel').chmod(0o644)
        (source/'seed').write_bytes(b'hello\n');os.chown(source/'seed',10001,10000);(source/'seed').chmod(0o660);(source/'escape').symlink_to('../readonly/sentinel')
        scopes=[]
        for number,policy in enumerate(('auto','plan','ask','accept-edits','dont-ask','bypass'),1):
            scopes.append({'authority':{'workspaceId':'workspace','sessionId':f'backend-{number}','incarnationId':'boot','leaseEpoch':1,'configRevision':1,'grantRevision':1,'policyRevision':1},'logicalSessionId':f'conversation-{number}','runtimeUid':20000+number,'toolUid':10000+number,'workspaceGid':10000,'policy':policy,'roots':[{'id':'source','guestPath':'/workspace/folders/source','readOnly':False,'source':str(source)},{'id':'readonly','guestPath':'/workspace/folders/readonly','readOnly':True,'source':str(readonly)}]})
        stores=root/'stores';stores.mkdir();protected=[]
        for number in range(1,7):
            store=stores/f'conversation-{number}';store.mkdir();os.chown(store,20000+number,20000+number);store.chmod(0o700);protected.append(str(store))
        config={'protectedStoreDirectories':protected,'guestBootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'artifacts':compiled,'environment':str(environment),'controlDirectory':str(control),'conversations':scopes}
        config_path=root/'bootstrap.json';config_path.write_text(json.dumps(config));config_path.chmod(0o400);fd=os.open(config_path,os.O_RDONLY|os.O_CLOEXEC)
        server=subprocess.Popen([sys.executable,'-I','-S',str(service),'--trusted-config-fd',str(fd)],pass_fds=(fd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'LANG':'C','LC_ALL':'C','PYTHONPATH':'/must-not-load'},bufsize=0);os.close(fd)
        clients=[]
        try:
            deadline=time.monotonic()+3
            while not (control/'admin.sock').exists() and time.monotonic()<deadline:
                if server.poll() is not None:raise AssertionError(server.stderr.read())
                time.sleep(.02)
            assert (control/'admin.sock').exists(),'service did not admit protected sockets'
            # The service already holds the admitted directory FD. Replace its original
            # spelling before tool namespace construction; it must still use that inode.
            admitted_source=root/'source-admitted';source.rename(admitted_source)
            source.mkdir(mode=0o2770);os.chown(source,10001,10000)
            (source/'seed').write_bytes(b'replacement-must-not-be-read-or-written\n')
            replacement_source=source;source=admitted_source
            def start(number,scenario):
                uid=20000+number
                def identity():os.setgroups([]);os.setgid(uid);os.setuid(uid)
                child=subprocess.Popen([str(client),str(control/f'conversation-{number}/tools.sock'),f'backend-{number}',str(10000+number),scenario],preexec_fn=identity,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True,env={'HOME':str(root),'WINTER_HOME':str(root/'unused-home'),'WINTER_KEYCHAIN_SERVICE':'com.winter.core.test-isolated','SECRET_SHOULD_NOT_TRAVEL':'synthetic-environment-marker'},start_new_session=True);clients.append(child);return child
            def finish(child):
                out,err=child.communicate(timeout=15);assert child.returncode==0,(child.returncode,out,err);assert not err,err;return json.loads(out)
            assert finish(start(1,'forged'))['uid']==20001;assert not (source/'forged-write').exists()
            # Observe the actual protocol bytes under the same runtime UID before the SDK fold.
            # Fixture-only read: no retry of writes/effects, no production diagnostic disclosure.
            read_end,write_end=os.pipe();probe_pid=os.fork()
            if probe_pid==0:
                os.close(read_end)
                try:
                    os.setgroups([]);os.setgid(20001);os.setuid(20001)
                    request={'protocolVersion':1,'requestId':str(uuid.uuid4()),'authority':scopes[0]['authority'],'operation':'read','root':{'id':'source','guestPath':'/workspace/folders/source','readOnly':False},'relativePath':'seed','expectedUid':10001,'maxBytes':1024}
                    ticket=exchange(control/'conversation-1/tools.sock',{'kind':'reserve','toolKind':'file','request':request})['ticket']
                    response=exchange(control/'conversation-1/tools.sock',{'kind':'file','request':request,'ticket':ticket})
                    os.write(write_end,json.dumps(response).encode()[:4096]);os._exit(0)
                except BaseException:os._exit(1)
            os.close(write_end);raw_probe=os.read(read_end,4096);os.close(read_end);_,probe_status=os.waitpid(probe_pid,0)
            assert probe_status==0,('raw protocol probe failed',probe_status,raw_probe)
            response=json.loads(raw_probe)
            assert response.get('exitCode')==0 and response.get('stdout'),('raw Read response',response)
            assert finish(start(1,'ordinary'))['uid']==20001
            assert (source/'seed').read_bytes()==b'written\n';assert (source/'from-shell').read_bytes()==b'shell';assert not (readonly/'new').exists();assert not (readonly/'shell-write').exists()
            assert (replacement_source/'seed').read_bytes()==b'replacement-must-not-be-read-or-written\n' and not (replacement_source/'from-shell').exists()
            assert finish(start(2,'plan'))['uid']==20002;assert (source/'seed').read_bytes()==b'written\n';assert not (source/'plan-shell').exists()
            for number in range(3,7):
                finish(start(number,'writable-policy'))
                assert (source/f'policy-{10000+number}').read_bytes()==b'approved-runtime-write'
            finish(start(1,'cancel'))
            def quiescent():
                deadline=time.monotonic()+3
                while time.monotonic()<deadline:
                    value=exchange(control/'admin.sock',{'operation':'status','sessionId':'conversation-1'})
                    if value['active']==0:return value
                    time.sleep(.02)
                raise AssertionError('native cleanup remained active')
            status=quiescent();assert status=={'active':0,'uncertain':False},status
            (source/'cancellation-ready').unlink(missing_ok=True)
            active=start(1,'revoke');deadline=time.monotonic()+3
            while not (source/'cancellation-ready').exists() and time.monotonic()<deadline:time.sleep(.02)
            assert (source/'cancellation-ready').exists(),'descendant never started'
            assert exchange(control/'admin.sock',{'operation':'revoke','sessionId':'conversation-1'})['revoked'];finish(active)
            time.sleep(1.1);assert not (source/'cancellation-orphan').exists(),'setsid descendant survived namespace cancellation/revocation'
            status=quiescent();assert status=={'active':0,'uncertain':False},status
            # Root itself cannot impersonate an admitted runtime peer UID, even with valid JSON.
            try:exchange(control/'conversation-2/tools.sock',{'kind':'file','request':{}});raise AssertionError('root peer was admitted as runtime')
            except (ConnectionResetError,BrokenPipeError,AssertionError) as failure:
                if str(failure)=='root peer was admitted as runtime':raise
            server.stdin.close();server.wait(timeout=5);assert server.returncode==0,server.stderr.read()
            print(json.dumps({'passed':True,'fullGuestExecutionEnabled':False,'checks':['actual-registry-read-edit-write-bash','two-distinct-runtime-uids','plan-and-readonly-kernel-mounts','no-runtime-proc-env-view','private-peer-credential-admission','bounded-cancel-and-revoke','setsid-descendants-reaped']}))
        finally:
            for child in clients:
                if child.poll() is None:child.kill();child.wait(timeout=2)
                child.stdout.close();child.stderr.close()
            if server.poll() is None:server.kill();server.wait(timeout=2)
            server.stdout.close();server.stderr.close()
            if not server.stdin.closed:server.stdin.close()
if __name__=='__main__':main()

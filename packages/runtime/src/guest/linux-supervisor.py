#!/usr/bin/env python3
"""Protected Linux tool service. Start only via immutable python -I -S and a trusted config FD.
Not the guest engine/bootstrap. No host credentials, file paths, UIDs or policy from tool requests.
"""
import array, base64, fcntl, hashlib, json, os, re, selectors, select, signal, socket, stat, struct, subprocess, sys, tempfile, threading, time
from pathlib import Path

FRAME_LIMIT=2*1024*1024
FRAME_READ_SECONDS=3
TOOL_CONNECTION_LIMIT=8
ADMIN_CONNECTION_LIMIT=2
AUTH_KEYS=('workspaceId','sessionId','incarnationId','leaseEpoch','configRevision','grantRevision','policyRevision')
ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
class Refusal(Exception):pass
class Uncertain(Exception):pass

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'))
def authority(value):
    if not isinstance(value,dict) or set(value)!=set(AUTH_KEYS):raise Refusal('invalid_authority')
    for name in AUTH_KEYS[:3]:
        if not isinstance(value[name],str) or not ID.fullmatch(value[name]):raise Refusal('invalid_authority')
    for name in AUTH_KEYS[3:]:
        if type(value[name])!=int or value[name]<0:raise Refusal('invalid_authority')
    return dict(value)
def pinned_artifact(value):
    if set(value)!={'path','sha256'} or not re.fullmatch('[a-f0-9]{64}',value['sha256']):raise Refusal('artifact_pin')
    fd=os.open(value['path'],os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or st.st_mode&0o222 or st.st_size>128*1024*1024:raise Refusal('artifact_identity')
        digest=hashlib.sha256()
        while True:
            data=os.read(fd,65536)
            if not data:break
            digest.update(data)
        os.lseek(fd,0,os.SEEK_SET)
        if digest.hexdigest()!=value['sha256']:raise Refusal('artifact_digest')
        return fd
    except BaseException:os.close(fd);raise

def verify_held_artifact(fd,pin):
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_nlink!=1 or st.st_mode&0o222:raise Refusal('artifact_identity')
    digest=hashlib.sha256();offset=0
    while offset<st.st_size:
        data=os.pread(fd,min(65536,st.st_size-offset),offset)
        if not data:raise Refusal('artifact_changed')
        digest.update(data);offset+=len(data)
    if digest.hexdigest()!=pin:raise Refusal('artifact_changed')

def frame_read(channel,timeout=FRAME_READ_SECONDS):
    deadline=time.monotonic()+timeout;original_timeout=channel.gettimeout()
    def exact(count):
        result=bytearray()
        while len(result)<count:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise Refusal('frame_deadline')
            channel.settimeout(remaining)
            try:data=channel.recv(count-len(result))
            except socket.timeout:raise Refusal('frame_deadline')
            if time.monotonic()>=deadline:raise Refusal('frame_deadline')
            if not data:raise Refusal('channel_closed')
            result.extend(data)
        return bytes(result)
    try:
        size=struct.unpack('!I',exact(4))[0]
        if size<1 or size>FRAME_LIMIT:raise Refusal('frame_limit')
        return json.loads(exact(size))
    finally:channel.settimeout(original_timeout)
def frame_write(channel,value):
    data=canonical(value).encode()
    if len(data)>FRAME_LIMIT:raise Uncertain('response_limit')
    channel.sendall(struct.pack('!I',len(data))+data)

def peer_uid(channel):return struct.unpack('3i',channel.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]

def source_directory(source,protected):
    # Bootstrap roots must be canonical, with no symlink at ANY path component.
    # Compare the admitted identity to the held descriptor after the walk, so a
    # rename/replacement between policy check and open cannot redirect the root.
    spelling=Path(source)
    if not spelling.is_absolute() or any(part in ('.','..') for part in spelling.parts):raise Refusal('source_path')
    resolved=spelling.resolve(strict=True);expected=resolved.stat()
    if spelling!=resolved:raise Refusal('source_alias')
    if any(resolved==path or resolved in path.parents or path in resolved.parents for path in protected):raise Refusal('protected_source_overlap')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
    try:
        for component in spelling.parts[1:]:
            next_fd=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            os.close(fd);fd=next_fd
        actual=os.fstat(fd)
        if (actual.st_dev,actual.st_ino)!=(expected.st_dev,expected.st_ino):raise Refusal('source_changed')
        result=fd;fd=None;return result
    finally:
        if fd is not None:os.close(fd)

def receive_init_pidfd(control):
    owned=[]
    try:
        marker,ancillary,flags,_=control.recvmsg(16,socket.CMSG_SPACE(16*array.array('i').itemsize),getattr(socket,'MSG_CMSG_CLOEXEC',0))
        # recvmsg installs descriptors even if the envelope is malformed. Own
        # every delivered descriptor BEFORE validating marker/count/truncation.
        for level,kind,data in ancillary:
            if (level,kind)==(socket.SOL_SOCKET,socket.SCM_RIGHTS):
                usable=len(data)-len(data)%array.array('i').itemsize
                owned.extend(array.array('i',data[:usable]))
        for fd in owned:os.set_inheritable(fd,False)
        if marker!=b'I' or flags&~getattr(socket,'MSG_CMSG_CLOEXEC',0) or len(ancillary)!=1 or ancillary[0][:2]!=(socket.SOL_SOCKET,socket.SCM_RIGHTS) or len(ancillary[0][2])!=array.array('i').itemsize or len(owned)!=1:raise Uncertain('init_admission_lost')
        return owned.pop()
    finally:
        for fd in owned:os.close(fd)

class ToolService:
    def __init__(self,config):
        if sys.platform!='linux' or os.geteuid()!=0:raise Refusal('protected_linux_root_required')
        if not sys.flags.isolated or not sys.flags.no_site:raise Refusal('isolated_interpreter_required')
        if config.get('guestBootId')!=Path('/proc/sys/kernel/random/boot_id').read_text().strip():raise Refusal('stale_guest_boot')
        self.lock=threading.RLock();self.stop_event=threading.Event();self.conversations={};self.active={};self.debt=set();self.seen={};self.retained_children=[];self.tool_connections=threading.BoundedSemaphore(TOOL_CONNECTION_LIMIT);self.admin_connections=threading.BoundedSemaphore(ADMIN_CONNECTION_LIMIT)
        self.artifacts={};self.artifact_pins={};self.owned=[];self.listeners=[];self.threads=[];self.runtimes={};self.runtime_artifacts={};self.runtime_pins={};self.guest_boot=config['guestBootId']
        try:
            for name in ('launcher','fileWorker','processWorker'):self.artifacts[name]=pinned_artifact(config['artifacts'][name]);self.artifact_pins[name]=config['artifacts'][name]['sha256'];self.owned.append(self.artifacts[name])
            if 'freshRuntime' in config:
                if set(config['freshRuntime'])!={'artifacts'} or set(config['freshRuntime']['artifacts'])!={'launcher','executable','ownerLibrary'}:raise Refusal('runtime_artifacts')
                for name,value in config['freshRuntime']['artifacts'].items():
                    self.runtime_artifacts[name]=pinned_artifact(value);self.runtime_pins[name]=value['sha256'];self.owned.append(self.runtime_artifacts[name])
            self.environment=os.open(config['environment'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);self.owned.append(self.environment)
            self.directory=Path(config['controlDirectory']).resolve(strict=True)
            protected=[self.directory,Path(config['environment']).resolve(strict=True)]+[Path(v['path']).resolve(strict=True).parent for v in config['artifacts'].values()]
            protected.extend(Path(path).resolve(strict=True) for path in config['protectedStoreDirectories'])
            if self.runtime_artifacts:
                protected.extend(Path(v['path']).resolve(strict=True).parent for v in config['freshRuntime']['artifacts'].values())
                protected.extend(Path(v['freshRuntime'][key]).resolve(strict=True) for v in config['conversations'] if 'freshRuntime' in v for key in ('storeDirectory','runhomeDirectory'))
            st=self.directory.lstat()
            if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or (st.st_mode&0o777) not in (0o700,0o711):raise Refusal('control_directory')
            uids=set();backends=set();workspace=None
            runtime_uids={item['runtimeUid'] for item in config['conversations']}
            if runtime_uids.intersection(item['workspaceGid'] for item in config['conversations']):raise Refusal('private_group_collision')
            if not 1<=len(config['conversations'])<=16:raise Refusal('conversation_limit')
            for item in config['conversations']:
                scope=authority(item['authority'])
                if workspace is None:workspace=scope['workspaceId']
                if scope['workspaceId']!=workspace:raise Refusal('workspace_scope')
                sid=item['logicalSessionId']
                if not isinstance(sid,str) or not ID.fullmatch(sid) or scope['sessionId'] in backends:raise Refusal('conversation_mapping')
                backends.add(scope['sessionId']);runtime=item['runtimeUid'];tool=item['toolUid'];group=item['workspaceGid']
                if sid in self.conversations or any(type(n)!=int or n<1000 or n>65535 for n in (runtime,tool,group)) or runtime==tool or runtime in uids or tool in uids:raise Refusal('identity_collision')
                uids.update((runtime,tool))
                if item['policy'] not in ('auto','plan','ask','accept-edits','dont-ask','bypass') or not 1<=len(item['roots'])<=16:raise Refusal('admitted_policy')
                roots={}
                for root in item['roots']:
                    guest=root['guestPath']
                    if not ID.fullmatch(root['id']) or root['id'] in roots or not isinstance(guest,str) or not guest.startswith('/') or len(guest)>1024 or any(p in ('.','..','') for p in guest[1:].split('/')) or type(root['readOnly'])!=bool:raise Refusal('admitted_root')
                    parts=guest[1:].split('/')
                    allowed=(len(parts)>=3 and parts[:2] in (['workspace','folders'],['workspace','repos'])) or parts==['workspace','.winter','memory'] or parts==['workspace','.winter','scratch',sid] or parts==['workspace','outputs',sid]
                    if not allowed:raise Refusal('protected_root')
                    fd=source_directory(root['source'],protected);self.owned.append(fd)
                    roots[root['id']]={'root':{'id':root['id'],'guestPath':guest,'readOnly':root['readOnly']},'fd':fd}
                views=[v['root']['guestPath'] for v in roots.values()]
                if len(set(views))!=len(views) or any(a!=b and b.startswith(a+'/') for a in views for b in views):raise Refusal('overlapping_roots')
                private=self.directory/sid;private.mkdir(mode=0o750);os.chown(private,0,runtime)
                self.conversations[sid]={'logicalSessionId':sid,'authority':scope,'runtimeUid':runtime,'toolUid':tool,'workspaceGid':group,'policy':item['policy'],'roots':roots,'socket':private/'tools.sock','revoked':False}
                self.seen[sid]=set()
                if 'freshRuntime' in item:self._configure_runtime(self.conversations[sid],item['freshRuntime'])
        except BaseException:
            self.close();raise
    def _listener(self,path,uid,handler,*,admin=False):
        capacity=self.admin_connections if admin else self.tool_connections
        server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(str(path));os.chmod(path,0o660 if uid else 0o600);os.chown(path,0,uid);server.listen(ADMIN_CONNECTION_LIMIT if admin else TOOL_CONNECTION_LIMIT);server.settimeout(.1);self.listeners.append(server)
        def accept():
            while not self.stop_event.is_set():
                try:connection,_=server.accept()
                except socket.timeout:continue
                except OSError:break
                if not capacity.acquire(False):connection.close();continue
                def serve(connection=connection):
                    try:
                        connection.settimeout(3)
                        if peer_uid(connection)!=uid:raise Refusal('peer_identity')
                        handler(connection)
                    except (OSError,ValueError,Refusal,Uncertain):pass
                    finally:connection.close();capacity.release()
                thread=threading.Thread(target=serve,daemon=True);thread.start()
                with self.lock:self.threads=[t for t in self.threads if t.is_alive()]+[thread]
        thread=threading.Thread(target=accept,daemon=True);thread.start();self.threads.append(thread)
    def start(self):
        for sid,item in self.conversations.items():self._listener(item['socket'],item['runtimeUid'],lambda channel,sid=sid:self._request(sid,channel))
        self._listener(self.directory/'admin.sock',0,self._admin,admin=True)
    def _admin(self,channel):
        request=frame_read(channel)
        if set(request)!={'operation','sessionId'} or request['operation'] not in ('revoke','status','launch-runtime','runtime-owner'):raise Refusal('admin_request')
        if request['operation']=='revoke':
            self.revoke(request['sessionId']);frame_write(channel,{'revoked':True})
        elif request['operation']=='runtime-owner':
            with self.lock:
                sid=request['sessionId'];runtime=self.runtimes.get(sid);item=self.conversations.get(sid)
                if not runtime or not item or runtime['state']!='running' or runtime['cancel'].is_set() or item['revoked'] or sid in self.debt or self.stop_event.is_set():raise Refusal('runtime_owner_unavailable')
                fd=runtime.get('initPidfd')
                if fd is None or select.select([fd],[],[],0)[0]:raise Refusal('runtime_owner_unavailable')
                record={'logicalSessionId':sid,'runtimeUid':item['runtimeUid'],'scope':runtime['scope'],'ownerToken':runtime['ownerToken']}
                payload=canonical(record).encode();wire=struct.pack('!I',len(payload))+payload
                if channel.sendmsg([wire],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[fd]))])!=len(wire):raise Uncertain('runtime_owner_handoff')
        elif request['operation']=='launch-runtime':
            self.launch_runtime(request['sessionId']);frame_write(channel,{'started':True})
        else:
            with self.lock:
                result={'active':sum(sid==request['sessionId'] for sid,_ in self.active.values()),'uncertain':request['sessionId'] in self.debt}
                if request['sessionId'] in getattr(self,'runtimes',{}):result['runtime']={key:self.runtimes[request['sessionId']].get(key) for key in ('state','exitCode','cleanupConfirmed')}
                frame_write(channel,result)
    def revoke(self,sid):
        with self.lock:
            self.conversations[sid]['revoked']=True
            if sid in getattr(self,'runtimes',{}):self.runtimes[sid]['cancel'].set()
            for active_sid,cancel in self.active.values():
                if active_sid==sid:cancel.set()
    def _deny(self,request,item,code):
        return {'protocolVersion':1,'requestId':request.get('requestId'),'authority':dict(item['authority']),'exitCode':1,'stdout':canonical({'version':1,'ok':False,'code':code,'errno':1})}
    def _request(self,sid,channel):
        envelope=frame_read(channel)
        if not isinstance(envelope,dict) or set(envelope)!={'kind','request'}:raise Refusal('request_shape')
        request=envelope['request']
        if not isinstance(request,dict):raise Refusal('request_shape')
        item=self.conversations[sid];kind=envelope['kind'];cancel=threading.Event();key=None;admitted=False
        try:
            with self.lock:
                allowed={'protocolVersion','requestId','authority','root','expectedUid'} | ({'operation','relativePath','maxBytes','dataBase64','expectedFileVersion'} if kind=='file' else {'relativeCwd','command','timeoutMs','maxOutputBytes'})
                if set(request)-allowed:raise Refusal('invalid_request')
                if self.stop_event.is_set() or item['revoked'] or sid in self.debt or kind not in ('file','process') or request.get('protocolVersion')!=1 or request.get('authority')!=item['authority'] or request.get('expectedUid')!=item['toolUid']:raise Refusal('authority_denied')
                key=request.get('requestId')
                if not isinstance(key,str) or not re.fullmatch('[a-f0-9-]{36}',key):raise Refusal('invalid_request')
                if key in self.seen[sid]:raise Uncertain('request_already_admitted')
                if len(self.seen[sid])>=4096 or len(self.active)>=8:raise Refusal('authority_denied')
                requested_root=request.get('root')
                if not isinstance(requested_root,dict) or not isinstance(requested_root.get('id'),str):raise Refusal('invalid_request')
                root=item['roots'].get(requested_root['id'])
                if not root or request['root']!=root['root']:raise Refusal('authority_denied')
                relative=request.get('relativePath' if kind=='file' else 'relativeCwd')
                if not isinstance(relative,str) or len(relative)>4096 or '\0' in relative or relative.startswith('/') or (relative!='.' or kind=='file') and any(p in ('','..','.') for p in relative.split('/')):raise Refusal('invalid_request')
                limit=request.get('maxBytes' if kind=='file' else 'maxOutputBytes')
                if type(limit)!=int or not 1<=limit<=1024*1024:raise Refusal('payload_limit')
                if kind=='file':
                    operation=request.get('operation')
                    if operation not in ('read','write','write-check'):raise Refusal('invalid_request')
                    if operation!='read' and (root['root']['readOnly'] or item['policy']=='plan'):raise Refusal('authority_denied')
                    data=request.get('dataBase64','')
                    if not isinstance(data,str) or len(data)>((limit+2)//3)*4:raise Refusal('payload_limit')
                    try:decoded=base64.b64decode(data,validate=True)
                    except ValueError:raise Refusal('invalid_payload')
                    if len(decoded)>limit or base64.b64encode(decoded).decode()!=data:raise Refusal('invalid_payload')
                    payload=data.encode();extra=request.get('expectedFileVersion','-')
                    if not isinstance(extra,str) or (operation=='write-check' and (not isinstance(extra,str) or len(extra)>256 or extra!='absent' and not re.fullmatch(r'\d+:\d+:\d+:-?\d+:\d{9}:-?\d+:\d{9}',extra))):raise Refusal('invalid_request')
                    deadline=3
                else:
                    command=request.get('command');timeout=request.get('timeoutMs')
                    if not isinstance(command,str) or '\0' in command or not 1<=len(command.encode())<=65536 or type(timeout)!=int or not 1<=timeout<=600000:raise Refusal('invalid_request')
                    operation=str(timeout);payload=command.encode();extra='-';deadline=timeout/1000+3
                self.seen[sid].add(key);self.active[(sid,key)]=(sid,cancel);admitted=True
            code,out=self._run(item,kind,operation,root,relative,limit,extra,payload,deadline,cancel,channel)
            with self.lock:
                if item['revoked']:raise Uncertain('authority_revoked')
            frame_write(channel,{'protocolVersion':1,'requestId':key,'authority':dict(item['authority']),'exitCode':code,'stdout':out.decode('utf8')})
        except Refusal as failure:frame_write(channel,self._deny(request,item,str(failure)))
        except (Uncertain,OSError,ValueError):
            try:frame_write(channel,{'error':'effects_uncertain','requestId':key})
            except OSError:pass
        finally:
            if admitted:
                with self.lock:
                    if self.active.get((sid,key))==(sid,cancel):self.active.pop((sid,key),None)
    def _run(self,item,kind,operation,root,relative,limit,extra,payload,seconds,cancel,channel):
        sid=item['logicalSessionId']
        for name in ('launcher','processWorker' if kind=='process' else 'fileWorker'):verify_held_artifact(self.artifacts[name],self.artifact_pins[name])
        view=tempfile.mkdtemp(prefix='view-',dir=self.directory);control,parent=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);child=None;pidfd=None;cleanup=False
        try:
            worker=self.artifacts['processWorker' if kind=='process' else 'fileWorker']
            arguments=[str(self.artifacts['launcher']),str(worker),view,str(parent.fileno()),str(self.environment),str(item['toolUid']),str(item['workspaceGid']),'plan' if item['policy']=='plan' else 'auto',kind,operation,root['root']['guestPath'],relative,str(limit),extra,str(len(item['roots']))]
            descriptors=[self.artifacts['launcher'],worker,parent.fileno(),self.environment]
            for binding in item['roots'].values():arguments.extend((str(binding['fd']),binding['root']['guestPath'],'1' if binding['root']['readOnly'] else '0'));descriptors.append(binding['fd'])
            child=subprocess.Popen(arguments,executable=f"/proc/self/fd/{self.artifacts['launcher']}",stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=descriptors,close_fds=True,env={'LANG':'C','LC_ALL':'C'},start_new_session=True,bufsize=0)
            parent.close();control.settimeout(2)
            pidfd=receive_init_pidfd(control)
            selector=selectors.DefaultSelector();remaining=memoryview(payload);out=bytearray();err=bytearray();terminal=None;start=time.monotonic();terminated=False;kill_deadline=None
            for stream,event in ((child.stdin,selectors.EVENT_WRITE),(child.stdout,selectors.EVENT_READ),(child.stderr,selectors.EVENT_READ)):
                os.set_blocking(stream.fileno(),False);selector.register(stream,event)
            control.setblocking(False);selector.register(control,selectors.EVENT_READ)
            while selector.get_map():
                if not terminated and (cancel.is_set() or self.stop_event.is_set() or time.monotonic()-start>seconds):
                    try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                    except ProcessLookupError:pass
                    terminated=True;kill_deadline=time.monotonic()+2
                if terminated and time.monotonic()>kill_deadline:raise Uncertain('namespace_cleanup_unconfirmed')
                # Runtime disconnect is cancellation, never a success receipt or replay trigger.
                readable,_,_=select.select([channel],[],[],0)
                if readable and channel.recv(1,socket.MSG_PEEK)==b'':cancel.set()
                for event,_ in selector.select(.05):
                    stream=event.fileobj
                    if stream is child.stdin:
                        if time.monotonic()-start>2:cancel.set();continue
                        try:count=os.write(stream.fileno(),remaining[:65536])
                        except BlockingIOError:continue
                        except BrokenPipeError:count=0;remaining=memoryview(b'')
                        remaining=remaining[count:]
                        if not remaining:selector.unregister(stream);stream.close()
                    elif stream is control:
                        receipt=control.recv(16)
                        if receipt:
                            if len(receipt)!=5 or receipt[:1]!=b'R':raise Uncertain('native_receipt_invalid')
                            terminal=struct.unpack('=I',receipt[1:])[0]
                        else:selector.unregister(stream)
                    else:
                        try:data=os.read(stream.fileno(),16384)
                        except BlockingIOError:continue
                        if not data:selector.unregister(stream);continue
                        target=out if stream is child.stdout else err;target.extend(data)
                        if len(out)>((limit+2)//3)*4+2048 or len(err)>16384:raise Uncertain('capture_limit')
            selector.close();returncode=child.wait(timeout=1)
            if terminal is None:raise Uncertain('native_exit_unconfirmed')
            native_code=os.waitstatus_to_exitcode(terminal);native_code=native_code if native_code>=0 else 128-native_code
            if native_code!=returncode:raise Uncertain('native_exit_unconfirmed')
            cleanup=True
            if terminated:raise Uncertain('cancelled_effects')
            return returncode,bytes(out)
        finally:
            if child is not None and not cleanup:
                if pidfd is None:
                    try:child.kill()
                    except OSError:pass
                if pidfd is not None:
                    try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                    except OSError:pass
                try:child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    # Retain exact Popen reference; no timer/PID check can clear native debt.
                    with self.lock:self.debt.add(sid)
                    self.retained_children.append(child)
                # Missing native terminal receipt remains uncertain even if parent exited.
                if not cleanup:
                    with self.lock:self.debt.add(sid)
            if child is not None:
                for stream in (child.stdin,child.stdout,child.stderr):
                    if not stream.closed:stream.close()
            if pidfd is not None:os.close(pidfd)
            control.close();parent.close()
            # Namespace private mounts vanish with confirmed init teardown. Unknown owner retains its view.
            if cleanup:os.rmdir(view)
    def _configure_runtime(self,item,value):
        # Only immutable root bootstrap can select artifacts, directories, model or
        # public provider metadata. The tool/admin launch request carries only sid.
        if not self.runtime_artifacts or not isinstance(value,dict) or set(value)-{'storeDirectory','runhomeDirectory','provider','model','timeoutMs'} or not {'storeDirectory','runhomeDirectory','provider','model'}<=set(value):raise Refusal('runtime_config')
        if not isinstance(value['model'],str) or not 1<=len(value['model'])<=256 or '\0' in value['model']:raise Refusal('runtime_model')
        provider=value['provider']
        if not isinstance(provider,dict) or set(provider)!={'scope','selection'}:raise Refusal('runtime_provider')
        def public_metadata(node):
            if isinstance(node,dict):
                for key,child in node.items():
                    if not isinstance(key,str) or any(word in key.lower() for word in ('authref','url','header','secret','token','credential')):raise Refusal('runtime_provider_private')
                    public_metadata(child)
            elif isinstance(node,list):
                for child in node:public_metadata(child)
            elif node is not None and type(node) not in (str,int,bool):raise Refusal('runtime_provider')
        public_metadata(provider)
        provider_scope=provider['scope'];selection=provider['selection']
        scope_keys={'homeId','workspaceId','sessionId','backendSessionId','taskId','incarnationId','bootId','leaseEpoch','grantRevision','accountRevision','modelRevision'}
        selection_keys={'providerId','modelKey','providerModelId','family','protocol','capabilities','continuationDomain'}
        if not isinstance(provider_scope,dict) or set(provider_scope)!=scope_keys or not isinstance(selection,dict) or set(selection)-selection_keys or not selection_keys-{'continuationDomain'}<=set(selection):raise Refusal('runtime_provider')
        expected={'workspaceId':item['authority']['workspaceId'],'sessionId':item['logicalSessionId'],'backendSessionId':item['authority']['sessionId'],'incarnationId':item['authority']['incarnationId'],'bootId':self.guest_boot,'leaseEpoch':item['authority']['leaseEpoch'],'grantRevision':item['authority']['grantRevision']}
        if any(provider_scope[key]!=expected[key] for key in expected) or selection['modelKey']!=value['model']:raise Refusal('runtime_provider_scope')
        if len(canonical(provider).encode())>32768:raise Refusal('runtime_provider_limit')
        timeout=value.get('timeoutMs',600000)
        if type(timeout)!=int or not 1<=timeout<=600000:raise Refusal('runtime_deadline')
        descriptors={}
        for key in ('storeDirectory','runhomeDirectory'):
            fd=source_directory(value[key],[]);self.owned.append(fd);st=os.fstat(fd)
            if st.st_uid!=item['runtimeUid'] or st.st_mode&0o777!=0o700:raise Refusal('runtime_directory_identity')
            descriptors[key]=fd
        # Cross-process directory ownership: same inode cannot be launched by two
        # root services. Fresh admission refuses every prior file/lease/history.
        try:fcntl.flock(descriptors['storeDirectory'],fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise Refusal('runtime_store_in_use')
        if os.listdir(descriptors['storeDirectory']) or os.listdir(descriptors['runhomeDirectory']):raise Refusal('runtime_fresh_store_required')
        self.runtimes[item['logicalSessionId']]={'state':'configured','cancel':threading.Event(),'fds':descriptors,'provider':json.loads(canonical(provider)),'model':value['model'],'timeout':timeout/1000,'cleanupConfirmed':False,'exitCode':None,'ownerToken':os.urandom(32).hex()}
    def _runtime_record(self,item,runtime):
        sid=item['logicalSessionId'];home=f'/run/winter/conversations/{sid}';store=f'/workspace/.winter/conversations/{sid}'
        tools=['Read','Write','Edit','Bash'];scope={key:item['authority'][key] for key in ('workspaceId','sessionId','incarnationId','leaseEpoch')};scope.update(storeHome=store,currentBootId=self.guest_boot)
        return {'protocolVersion':1,'freshOnly':True,'runtimeUid':item['runtimeUid'],'toolUid':item['toolUid'],'workspaceGid':item['workspaceGid'],'logicalSessionId':sid,'scope':scope,'ownerToken':runtime['ownerToken'],'toolSocketPath':home+'/.control/tools.sock','authority':dict(item['authority']),'roots':[binding['root'] for binding in item['roots'].values()],'provider':runtime['provider'],'runtimeConfig':{'executionPosture':'confined-guest','sessionId':item['authority']['sessionId'],'model':runtime['model'],'cwd':next(iter(item['roots'].values()))['root']['guestPath'],'winterHome':home,'storeHome':store,'persistSession':True,'settingSources':[],'tools':tools,'allowedTools':tools,'skills':[],'plugins':[],'strictMcpConfig':True,'mcpServers':{},'permissionMode':'auto'}}
    def launch_runtime(self,sid):
        with self.lock:
            if sid not in self.runtimes or self.stop_event.is_set() or self.conversations[sid]['revoked'] or sid in self.debt:raise Refusal('runtime_admission')
            runtime=self.runtimes[sid]
            if runtime['state']!='configured':raise Refusal('runtime_fresh_only')
            # Reserve the single fresh launch before starting any external effect.
            runtime['state']='starting';thread=threading.Thread(target=self._run_runtime,args=(self.conversations[sid],runtime),daemon=True);self.threads.append(thread);thread.start()
    def _run_runtime(self,item,runtime):
        sid=item['logicalSessionId'];child=None;pidfd=None;control=None;parent=None;bootstrap=None;guest=None;view=None;selector=None;confirmed=False;service_pidfd=None
        try:
            for name,fd in self.runtime_artifacts.items():verify_held_artifact(fd,self.runtime_pins[name])
            if os.listdir(runtime['fds']['storeDirectory']) or os.listdir(runtime['fds']['runhomeDirectory']):raise Refusal('runtime_fresh_store_required')
            view=tempfile.mkdtemp(prefix='runtime-view-',dir=self.directory);control,parent=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);bootstrap,guest=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
            control_directory=os.open(self.directory/sid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                args=[str(self.runtime_artifacts['launcher']),str(self.runtime_artifacts['executable']),view,str(parent.fileno()),str(self.environment),str(item['runtimeUid']),str(item['workspaceGid']),str(guest.fileno()),str(self.runtime_artifacts['ownerLibrary']),str(runtime['fds']['storeDirectory']),str(runtime['fds']['runhomeDirectory']),str(control_directory),sid,item['policy'],str(len(item['roots']))]
                fds=[*self.runtime_artifacts.values(),parent.fileno(),self.environment,guest.fileno(),*runtime['fds'].values(),control_directory]
                for binding in item['roots'].values():args.extend((str(binding['fd']),binding['root']['guestPath'],'1' if binding['root']['readOnly'] else '0'));fds.append(binding['fd'])
                child=subprocess.Popen(args,executable=f"/proc/self/fd/{self.runtime_artifacts['launcher']}",stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=fds,close_fds=True,env={'LANG':'C','LC_ALL':'C'},start_new_session=True,bufsize=0)
            finally:os.close(control_directory)
            parent.close();guest.close();control.settimeout(2);pidfd=receive_init_pidfd(control);service_pidfd=os.pidfd_open(os.getpid(),0)
            bootstrap_record=self._runtime_record(item,runtime)
            with self.lock:runtime['scope']=bootstrap_record['scope']
            record=canonical(bootstrap_record).encode()
            if len(record)>65536:raise Refusal('runtime_bootstrap_limit')
            rights=array.array('i',[pidfd,service_pidfd,runtime['fds']['storeDirectory'],self.runtime_artifacts['executable']]);bootstrap.settimeout(2)
            if bootstrap.sendmsg([record],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,rights)])!=len(record):raise Uncertain('runtime_bootstrap_send')
            with self.lock:runtime.update(state='running',initPidfd=pidfd)
            selector=selectors.DefaultSelector();control.setblocking(False);selector.register(control,selectors.EVENT_READ)
            for stream in (child.stdout,child.stderr):os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ)
            terminal=None;out=bytearray();err=bytearray();start=time.monotonic();killed=False;kill_deadline=None
            while selector.get_map():
                if not killed and (runtime['cancel'].is_set() or self.stop_event.is_set() or time.monotonic()-start>runtime['timeout']):
                    try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                    except ProcessLookupError:pass
                    killed=True;kill_deadline=time.monotonic()+2
                if killed and time.monotonic()>kill_deadline:raise Uncertain('runtime_cleanup_unconfirmed')
                for event,_ in selector.select(.05):
                    stream=event.fileobj
                    if stream is control:
                        receipt=control.recv(16)
                        if receipt:
                            if terminal is not None or len(receipt)!=5 or receipt[:1]!=b'R':raise Uncertain('runtime_native_receipt')
                            terminal=struct.unpack('=I',receipt[1:])[0]
                        else:selector.unregister(stream)
                    else:
                        try:data=os.read(stream.fileno(),16384)
                        except BlockingIOError:continue
                        if not data:selector.unregister(stream);continue
                        (out if stream is child.stdout else err).extend(data)
                        if len(out)>1024*1024 or len(err)>16384:raise Uncertain('runtime_capture_limit')
            code=child.wait(timeout=1)
            if terminal is None:raise Uncertain('runtime_native_exit_unconfirmed')
            native=os.waitstatus_to_exitcode(terminal);native=native if native>=0 else 128-native
            if code!=native:raise Uncertain('runtime_parent_reap_unconfirmed')
            # Namespace-init wait + launcher reaping precede tool revocation/drain.
            # Runtime JSON/EOF/success and kill delivery cannot acknowledge tenancy.
            self.revoke(sid);deadline=time.monotonic()+3
            while True:
                with self.lock:active=any(active_sid==sid for active_sid,_ in self.active.values())
                if not active:break
                if time.monotonic()>deadline:raise Uncertain('runtime_tool_drain_unconfirmed')
                time.sleep(.02)
            with self.lock:
                if sid in self.debt:raise Uncertain('runtime_tool_debt')
                runtime.update(state='stopped',exitCode=code,cleanupConfirmed=True)
            confirmed=True
        except (Refusal,Uncertain,OSError,ValueError,subprocess.TimeoutExpired):
            with self.lock:runtime['state']='retained';self.debt.add(sid)
            self.revoke(sid)
        finally:
            if selector is not None:selector.close()
            if child is not None and not confirmed:
                try:
                    if pidfd is not None:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                    else:child.kill()
                except OSError:pass
                try:child.wait(timeout=2)
                except subprocess.TimeoutExpired:self.retained_children.append(child)
            if child is not None:
                for stream in (child.stdout,child.stderr):stream.close()
            with self.lock:runtime.pop('initPidfd',None)
            for fd in (pidfd,service_pidfd):
                if fd is not None:os.close(fd)
            for channel in (control,parent,bootstrap,guest):
                if channel is not None:channel.close()
            if confirmed and view is not None:os.rmdir(view)
    def close(self):
        self.stop_event.set()
        with self.lock:
            for _,cancel in self.active.values():cancel.set()
            for runtime in getattr(self,'runtimes',{}).values():runtime['cancel'].set()
        for listener in self.listeners:listener.close()
        deadline=time.monotonic()+3
        for thread in self.threads:
            if isinstance(thread,threading.Thread):thread.join(timeout=max(0,deadline-time.monotonic()))
        if any(thread.is_alive() for thread in self.threads):return False
        if self.debt:return False
        for fd in self.owned:
            try:os.close(fd)
            except OSError:pass
        self.owned=[]
        return not self.debt

def main():
    if len(sys.argv)!=3 or sys.argv[1]!='--trusted-config-fd' or not sys.argv[2].isdigit():raise SystemExit(64)
    fd=int(sys.argv[2]);st=os.fstat(fd)
    if fd<3 or not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_size>65536:raise SystemExit(64)
    with os.fdopen(fd,'rb') as stream:config=json.load(stream)
    service=ToolService(config)
    try:
        service.start();print(canonical({'ready':True,'fullGuestExecutionEnabled':False}),flush=True)
        while sys.stdin.buffer.read(1):pass
    finally:
        if not service.close():raise SystemExit(78)
if __name__=='__main__':main()

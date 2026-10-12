#!/usr/bin/env python3
"""Protected Linux tool service. Start only via immutable python -I -S and a trusted config FD.
Not the guest engine/bootstrap. No host credentials, file paths, UIDs or policy from tool requests.
"""
import array, base64, hashlib, json, os, re, selectors, select, signal, socket, stat, struct, subprocess, sys, tempfile, threading, time, uuid
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
        self.lock=threading.RLock();self.stop_event=threading.Event();self.conversations={};self.active={};self.debt=set();self.tickets={};self.retained_children=[];self.tool_connections=threading.BoundedSemaphore(TOOL_CONNECTION_LIMIT);self.admin_connections=threading.BoundedSemaphore(ADMIN_CONNECTION_LIMIT)
        self.artifacts={};self.artifact_pins={};self.owned=[];self.listeners=[];self.threads=[]
        try:
            for name in ('launcher','fileWorker','processWorker'):self.artifacts[name]=pinned_artifact(config['artifacts'][name]);self.artifact_pins[name]=config['artifacts'][name]['sha256'];self.owned.append(self.artifacts[name])
            self.environment=os.open(config['environment'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);self.owned.append(self.environment)
            self.directory=Path(config['controlDirectory']).resolve(strict=True)
            protected=[self.directory,Path(config['environment']).resolve(strict=True)]+[Path(v['path']).resolve(strict=True).parent for v in config['artifacts'].values()]
            protected.extend(Path(path).resolve(strict=True) for path in config['protectedStoreDirectories'])
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
                self.tickets[sid]={}
        except BaseException:
            self.close();raise
    def _listener(self,path,uid,handler,*,admin=False):
        capacity=self.admin_connections if admin else self.tool_connections
        local_capacity=None if admin else threading.BoundedSemaphore(2)
        server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(str(path));os.chmod(path,0o660 if uid else 0o600);os.chown(path,0,uid);server.listen(ADMIN_CONNECTION_LIMIT if admin else TOOL_CONNECTION_LIMIT);server.settimeout(.1);self.listeners.append(server)
        def accept():
            while not self.stop_event.is_set():
                try:connection,_=server.accept()
                except socket.timeout:continue
                except OSError:break
                local_acquired=local_capacity is None or local_capacity.acquire(False)
                global_acquired=local_acquired and capacity.acquire(False)
                if not global_acquired:
                    if local_capacity is not None and local_acquired:local_capacity.release()
                    try:
                        connection.settimeout(.1);frame_write(connection,{'error':'capacity_busy'})
                    except OSError:pass
                    connection.close();continue
                def serve(connection=connection):
                    try:
                        connection.settimeout(3)
                        if peer_uid(connection)!=uid:raise Refusal('peer_identity')
                        handler(connection)
                    except (OSError,ValueError,Refusal,Uncertain):pass
                    finally:
                        connection.close();capacity.release()
                        if local_capacity is not None:local_capacity.release()
                thread=threading.Thread(target=serve,daemon=True);thread.start()
                with self.lock:self.threads=[t for t in self.threads if t.is_alive()]+[thread]
        thread=threading.Thread(target=accept,daemon=True);thread.start();self.threads.append(thread)
    def start(self):
        for sid,item in self.conversations.items():self._listener(item['socket'],item['runtimeUid'],lambda channel,sid=sid:self._request(sid,channel))
        self._listener(self.directory/'admin.sock',0,self._admin,admin=True)
    def _admin(self,channel):
        request=frame_read(channel)
        if set(request)!={'operation','sessionId'} or request['operation'] not in ('revoke','status'):raise Refusal('admin_request')
        if request['operation']=='revoke':
            self.revoke(request['sessionId']);frame_write(channel,{'revoked':True})
        else:
            with self.lock:frame_write(channel,{'active':sum(sid==request['sessionId'] for sid,_ in self.active.values()),'uncertain':request['sessionId'] in self.debt})
    def revoke(self,sid):
        with self.lock:
            self.conversations[sid]['revoked']=True
            for active_sid,cancel in self.active.values():
                if active_sid==sid:cancel.set()
    def _deny(self,request,item,code):
        return {'protocolVersion':1,'requestId':request.get('requestId'),'authority':dict(item['authority']),'exitCode':1,'stdout':canonical({'version':1,'ok':False,'code':code,'errno':1})}
    def _reserve(self,sid,channel,envelope):
        request=envelope.get('request');item=self.conversations[sid]
        try:
            if set(envelope)!={'kind','toolKind','request'} or envelope['toolKind'] not in ('file','process') or not isinstance(request,dict):raise Refusal('invalid_request')
            with self.lock:
                if self.stop_event.is_set() or item['revoked'] or sid in self.debt or request.get('authority')!=item['authority'] or request.get('expectedUid')!=item['toolUid']:raise Refusal('authority_denied')
                key=request.get('requestId')
                if not isinstance(key,str) or not re.fullmatch('[a-f0-9-]{36}',key):raise Refusal('invalid_request')
                now=time.monotonic()
                for pending in self.tickets.values():
                    for token,entry in list(pending.items()):
                        if entry[1]<=now:del pending[token]
                if len(self.tickets[sid])>=16 or sum(map(len,self.tickets.values()))>=128:raise Refusal('capacity_busy')
                token=str(uuid.uuid4());digest=hashlib.sha256(canonical({'kind':envelope['toolKind'],'request':request}).encode()).digest()
                self.tickets[sid][token]=(digest,now+15)
            frame_write(channel,{'protocolVersion':1,'requestId':key,'authority':dict(item['authority']),'ticket':token})
        except Refusal as failure:frame_write(channel,self._deny(request if isinstance(request,dict) else {},item,str(failure)))
    def _consume_ticket(self,sid,token,kind,request):
        # Only server-issued live tickets exist. Removing a consumed/expired ticket
        # cannot make an old frame executable: absence is always uncertain/refused.
        entry=self.tickets[sid].pop(token,None) if isinstance(token,str) else None
        digest=hashlib.sha256(canonical({'kind':kind,'request':request}).encode()).digest()
        if entry is None or entry[1]<=time.monotonic() or entry[0]!=digest:raise Uncertain('admission_ticket_unavailable')
    def _request(self,sid,channel):
        envelope=frame_read(channel)
        if isinstance(envelope,dict) and envelope.get('kind')=='reserve':return self._reserve(sid,channel,envelope)
        if not isinstance(envelope,dict) or set(envelope)!={'kind','request','ticket'}:raise Refusal('request_shape')
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
                if (sid,key) in self.active:raise Uncertain('request_already_admitted')
                if len(self.active)>=8 or sum(active_sid==sid for active_sid,_ in self.active.values())>=2:raise Refusal('capacity_busy')
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
                self._consume_ticket(sid,envelope.get('ticket'),kind,request)
                self.active[(sid,key)]=(sid,cancel);admitted=True
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
    def close(self):
        self.stop_event.set()
        with self.lock:
            for _,cancel in self.active.values():cancel.set()
        for listener in self.listeners:listener.close()
        deadline=time.monotonic()+3
        for thread in self.threads:
            if isinstance(thread,threading.Thread):thread.join(timeout=max(0,deadline-time.monotonic()))
        if any(thread.is_alive() for thread in self.threads):return False
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

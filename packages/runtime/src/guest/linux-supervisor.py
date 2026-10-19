#!/usr/bin/env python3
"""Protected Linux tool service. Start only via immutable python -I -S and a trusted config FD.
Not the guest engine/bootstrap. No host credentials, file paths, UIDs or policy from tool requests.
"""
import array, base64, errno, fcntl, hashlib, json, os, re, selectors, select, signal, socket, stat, struct, subprocess, sys, tempfile, threading, time, uuid
from pathlib import Path

FRAME_LIMIT=2*1024*1024
FRAME_READ_SECONDS=3
TOOL_CONNECTION_LIMIT=24
ADMIN_CONNECTION_LIMIT=2
AUTH_KEYS=('workspaceId','sessionId','incarnationId','leaseEpoch','configRevision','grantRevision','policyRevision')
ID=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
# Guided host-query profile: closed constants. Root's own trusted config is the only selector.
GUIDED_PROFILE='host-query-guided-v1'
GUIDED_READER_LIMITS={'maxFileBytes':128*1024,'maxReadBytes':256*1024,'maxReadOccurrences':256,'maxExpandedBytes':128*1024}
GUIDED_SHARED_ROOT='/run/winter/shared-instructions'
GUIDED_SHARED_PATH=GUIDED_SHARED_ROOT+'/WINTER.md'
GUIDED_SOURCE_ROOT=re.compile(r'^/workspace/(folders|repos)/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
GUIDED_UUID4=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
GUIDED_BOOT_ID=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
JS_SAFE_INTEGER=2**53-1
RUNTIME_KEYS=(('fresh','freshRuntime'),('host-query-v1','hostQueryRuntime'),(GUIDED_PROFILE,'hostQueryGuidedRuntime'))
class Refusal(Exception):pass
class Uncertain(Exception):pass

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'))
def normalized_stderr(data,paths=()):
    text=bytes(data[:16384]).decode('utf-8',errors='replace')
    for path in sorted((str(path) for path in paths if path),key=len,reverse=True):text=text.replace(path,'[fixture-path]')
    text=text.replace('DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET','[fixture-credential]')
    text=re.sub(r'(?<![A-Za-z0-9])[a-fA-F0-9]{16,}(?![A-Za-z0-9])','[hex-identity]',text)
    text=re.sub(r'(?:https?://|/)[^\s\x00"\'<>;,)]+','[absolute-path]',text)
    text=re.sub(r'(?i)(?:bearer\s+|(?:token|secret|password|credential|authref)\s*[=:]\s*)[^\s,;"\']+','[private-value]',text)
    text=''.join(char if char in '\n\t' or ord(char)>=32 else '?' for char in text)
    # Cap encoded durable bytes, including invalid UTF-8 replacement expansion.
    return text.encode()[:4096].decode('utf-8',errors='ignore')
def capture_metadata(data,limit,stderr_paths=None):
    # Arbitrary stdout/provider packets stay metadata only. Stderr is normalized.
    bounded=bytes(data[:limit])
    record={'capturedBytes':len(bounded),'captureLimit':limit,'truncated':len(data)>limit,'sha256':hashlib.sha256(bounded).hexdigest()}
    if stderr_paths is not None:record.update(normalizedText=normalized_stderr(bounded,stderr_paths),textLimit=4096)
    return record
def failure_metadata(error):
    record={'class':type(error).__name__}
    # Only the service's fixed refusal codes are safe diagnostic text.
    code=str(error)
    if isinstance(error,(Refusal,Uncertain)) and re.fullmatch('[a-z][a-z_]{0,63}',code):record['code']=code
    if isinstance(error,OSError) and error.errno is not None:record['errno']=error.errno
    return record
def write_diagnostic(path,record):
    wire=canonical(record).encode()
    if len(wire)>16384:raise ValueError('diagnostic_limit')
    # Fixture-owned control state, separate from canonical SDK records/authority.
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'wb',closefd=False) as stream:stream.write(wire);stream.flush();os.fsync(fd)
    finally:os.close(fd)
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

def discard_busy_frame(channel,timeout=.1,*,deadline=None):
    """Consume one bounded frame without decoding, handling or admitting it.

    Closing a Unix stream with an unread request can reset the peer and hide
    the explicit no-effect busy reply. Rejection keeps its original short
    budget; idle/trickling/oversized requests never enter the handler.
    """
    if deadline is None:deadline=time.monotonic()+timeout
    original_timeout=channel.gettimeout()
    def exact(count,header=False):
        retained=bytearray()
        while count:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise Refusal('frame_deadline')
            channel.settimeout(remaining)
            try:data=channel.recv(min(count,65536))
            except socket.timeout:raise Refusal('frame_deadline')
            if time.monotonic()>=deadline:raise Refusal('frame_deadline')
            if not data:raise Refusal('channel_closed')
            count-=len(data)
            # Only the four-byte header is retained, never a request body.
            if header:retained.extend(data)
        return bytes(retained)
    try:
        size=struct.unpack('!I',exact(4,header=True))[0]
        if size<1 or size>FRAME_LIMIT:raise Refusal('frame_limit')
        exact(size)
    finally:channel.settimeout(original_timeout)
def frame_write(channel,value):
    data=canonical(value).encode()
    if len(data)>FRAME_LIMIT:raise Uncertain('response_limit')
    channel.sendall(struct.pack('!I',len(data))+data)

def peer_uid(channel):return struct.unpack('3i',channel.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]

def reply_busy(channel,uid):
    # Authentication, drain and response share the original rejection budget.
    deadline=time.monotonic()+.1
    if peer_uid(channel)!=uid:raise Refusal('peer_identity')
    remaining=deadline-time.monotonic()
    if remaining<=0:raise Refusal('frame_deadline')
    discard_busy_frame(channel,deadline=deadline)
    remaining=deadline-time.monotonic()
    if remaining<=0:raise Refusal('frame_deadline')
    channel.settimeout(remaining)
    frame_write(channel,{'error':'capacity_busy'})
    if time.monotonic()>=deadline:raise Refusal('frame_deadline')

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

# Transport only. None of these objects admit an owner, store, executable or guest.
DUPLEX_CHUNK=256*1024
DUPLEX_FRAME=1024*1024
DUPLEX_QUEUE=2*1024*1024
DUPLEX_STDERR_QUEUE=64*1024
DUPLEX_PREFLIGHT_SECONDS=2
class RuntimeDuplexPorts:
    def __init__(self,logical_session_id,scope,input_fd,stdout_fd,stderr_fd):
        if not isinstance(logical_session_id,str) or not ID.fullmatch(logical_session_id):raise Refusal('runtime_duplex_scope')
        self.logical_session_id=logical_session_id;self.scope=authority(scope);self.fds={};self.identities={};self.phase='new';self.initial=b''
        try:
            for name,fd,access in (('input',input_fd,os.O_RDONLY),('stdout',stdout_fd,os.O_WRONLY),('stderr',stderr_fd,os.O_WRONLY)):
                if type(fd)!=int or fd<0:raise Refusal('runtime_duplex_descriptor')
                held=fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,64);self.fds[name]=held
                st=os.fstat(held);flags=fcntl.fcntl(held,fcntl.F_GETFL)
                if not stat.S_ISFIFO(st.st_mode) or st.st_uid!=os.geteuid() or st.st_nlink!=1 or flags&os.O_ACCMODE!=access or not flags&os.O_NONBLOCK:raise Refusal('runtime_duplex_descriptor')
                identity=(st.st_dev,st.st_ino,st.st_uid,st.st_mode,access)
                if any(identity[:2]==old[:2] for old in self.identities.values()):raise Refusal('runtime_duplex_alias')
                self.identities[name]=identity
        except BaseException:self.close();raise
    def verify(self):
        if self.phase=='closed':raise Refusal('runtime_duplex_closed')
        for name,fd in self.fds.items():
            st=os.fstat(fd);flags=fcntl.fcntl(fd,fcntl.F_GETFL)
            if (st.st_dev,st.st_ino,st.st_uid,st.st_mode,flags&os.O_ACCMODE)!=self.identities[name] or st.st_nlink!=1 or not flags&os.O_NONBLOCK or not fcntl.fcntl(fd,fcntl.F_GETFD)&fcntl.FD_CLOEXEC:raise Refusal('runtime_duplex_changed')
    def bind(self,item):
        self.verify()
        if self.phase!='new' or self.logical_session_id!=item['logicalSessionId'] or self.scope!=item['authority']:raise Refusal('runtime_duplex_scope')
        self.phase='configured'
    def claim(self,item):
        self.verify()
        if self.phase!='configured' or self.logical_session_id!=item['logicalSessionId'] or self.scope!=item['authority']:raise Refusal('runtime_duplex_scope')
        deadline=time.monotonic()+DUPLEX_PREFLIGHT_SECONDS
        while True:
            try:self.initial=os.read(self.fds['input'],DUPLEX_CHUNK)
            except InterruptedError:
                if time.monotonic()>=deadline:raise Refusal('runtime_duplex_input_unavailable')
                continue
            except BlockingIOError:self.initial=b'';break
            if not self.initial:raise Refusal('runtime_duplex_input_closed')
            break
        self.phase='running'
    def close(self):
        if self.phase=='closed':return
        self.phase='closed'
        for fd in self.fds.values():
            try:os.close(fd)
            except OSError:pass
        self.fds={};self.initial=b''

class RuntimeDuplexRelay:
    def __init__(self,ports,child,cancel):
        if ports.phase!='running':raise Refusal('runtime_duplex_scope')
        ports.verify();self.ports=ports;self.child=child;self.cancel=cancel
        self.buffers={'input':bytearray(ports.initial),'stdout':bytearray(),'stderr':bytearray()};ports.initial=b''
        self.eof={'input':False,'stdout':False,'stderr':False};self.terminal=False;self.line_bytes={'input':0,'stdout':0}
        self.registered=set()
        self._lines('input',self.buffers['input'])
        for stream in (child.stdin,child.stdout,child.stderr):os.set_blocking(stream.fileno(),False)
    def _lines(self,name,data):
        parts=data.split(b'\n')
        if len(parts)==1:self.line_bytes[name]+=len(data)
        else:
            if self.line_bytes[name]+len(parts[0])>DUPLEX_FRAME or any(len(line)>DUPLEX_FRAME for line in parts[1:-1]):raise Uncertain('runtime_duplex_frame_limit')
            self.line_bytes[name]=len(parts[-1])
        if self.line_bytes[name]>DUPLEX_FRAME:raise Uncertain('runtime_duplex_frame_limit')
    def native_terminal(self):
        self.terminal=True;self.eof['input']=True;self.buffers['input'].clear()
        self.child.stdin.close()
    def sync(self,selector):
        self.ports.verify()
        if self.eof['input'] and not self.buffers['input'] and not self.child.stdin.closed:self.child.stdin.close()
        desired={}
        if not self.eof['input'] and not self.terminal and len(self.buffers['input'])<DUPLEX_QUEUE:desired[self.ports.fds['input']]=(selectors.EVENT_READ,'host-input')
        if self.buffers['input'] and not self.terminal:desired[self.child.stdin.fileno()]=(selectors.EVENT_WRITE,'child-input')
        for name,limit in (('stdout',DUPLEX_QUEUE),('stderr',DUPLEX_STDERR_QUEUE)):
            if not self.eof[name] and len(self.buffers[name])<limit:desired[getattr(self.child,name).fileno()]=(selectors.EVENT_READ,'child-'+name)
            if self.buffers[name]:desired[self.ports.fds[name]]=(selectors.EVENT_WRITE,'host-'+name)
        for fd in self.registered-set(desired):selector.unregister(fd)
        for fd,(mask,route) in desired.items():
            if fd not in self.registered:selector.register(fd,mask,('duplex',route))
            else:selector.modify(fd,mask,('duplex',route))
        self.registered=set(desired)
    def handle(self,event):
        self.ports.verify();route=event.data[1];fd=event.fd
        name='input' if route.endswith('input') else route.split('-')[1]
        if name=='input' and (self.terminal or self.eof['input'] and (route=='host-input' or not self.buffers['input'])):return None
        writing=route=='child-input' or route.startswith('host-') and name!='input'
        if writing:
            try:count=os.write(fd,bytes(self.buffers[name][:65536]))
            except (BlockingIOError,InterruptedError):return None
            except OSError as error:
                if route!='child-input' or error.errno!=errno.EPIPE:raise
                # The returned runtime may close stdin before its native receipt arrives.
                # Unsent late input is discarded, never acknowledged or replayed. This is
                # only input-reader closure, not native terminal/cleanup/release evidence.
                self.buffers['input'].clear();self.eof['input']=True;self.child.stdin.close()
                return None
            if count<=0:raise Uncertain('runtime_duplex_write_failed')
            del self.buffers[name][:count]
            if name=='input' and self.eof['input'] and not self.buffers['input']:self.child.stdin.close()
            return None
        limit=DUPLEX_STDERR_QUEUE if name=='stderr' else DUPLEX_QUEUE
        try:data=os.read(fd,min(65536,limit-len(self.buffers[name])))
        except (BlockingIOError,InterruptedError):return None
        if not data:
            self.eof[name]=True
            if name=='input':
                if self.line_bytes['input']:raise Uncertain('runtime_duplex_input_truncated')
                if not self.buffers['input']:self.child.stdin.close()
            elif name=='stdout' and self.line_bytes[name]:raise Uncertain('runtime_duplex_output_truncated')
            return None
        if name in self.line_bytes:self._lines(name,data)
        self.buffers[name].extend(data)
        return (name,data) if name!='input' else None

def host_query_source_is_view(source,guest):
    # A host-query root is served from exactly the path it is shown at (the host sends source == guestPath), so the source is inside the
    # admitted views by construction. Tests that need a real directory behind a virtual guest path replace this one predicate.
    return type(source) is str and source==guest

def native_mount_policy(policy):
    # Native launchers select the mount view, not the SDK approval mode.
    # The Root-admitted full policy remains unchanged in item/bootstrap/config.
    return 'plan' if policy=='plan' else 'auto'

def runtime_root_metadata(root,policy,host_query=False):
    # Effective descriptor metadata MUST match the plan mount override and tool request comparison.
    return {'id':root['id'],'guestPath':root['guestPath'],'readOnly':root['readOnly'] or (host_query and policy=='plan')}

def host_query_config(item,tool_classes,model):
    if not isinstance(tool_classes,list) or len(tool_classes)>3 or any(type(value)!=str or value not in ('read','write','execute') for value in tool_classes) or len(set(tool_classes))!=len(tool_classes):raise Refusal('host_query_tools')
    # Only the SDK runtime mode collapses: the host matrix behind canUseTool is the Cowork policy authority, and any guest mode other than
    # default/plan lets the SDK resolve calls without canUseTool. The received policy stays recorded as-is (item['policy']); plan roots, the
    # plan write refusal and native_mount_policy still read it directly. Bypass is never produced here.
    modes={'auto':'default','ask':'default','plan':'plan','accept-edits':'default','dont-ask':'default','bypass':'default'}
    if item['policy'] not in modes:raise Refusal('host_query_policy')
    roots=[binding['root'] for binding in item['roots'].values()]
    if not 1<=len(roots)<=16 or any(not root['guestPath'].startswith('/workspace/') or root['guestPath']=='/workspace/.winter' or root['guestPath'].startswith('/workspace/.winter/') or item['policy']=='plan' and not root['readOnly'] for root in roots):raise Refusal('host_query_roots')
    tools=[]
    if 'read' in tool_classes:tools.append('Read')
    if 'write' in tool_classes:
        if 'read' in tool_classes:tools.append('Edit')
        tools.append('Write')
    if 'execute' in tool_classes:tools.append('Bash')
    sid=item['logicalSessionId']
    return {'executionPosture':'confined-guest','sessionId':item['authority']['sessionId'],'model':model,'cwd':roots[0]['guestPath'],'winterHome':f'/run/winter/conversations/{sid}','storeHome':f'/workspace/.winter/conversations/{sid}','persistSession':True,'settingSources':[],'tools':tools,'allowedTools':[],'skills':[],'plugins':[],'strictMcpConfig':True,'mcpServers':{},'permissionMode':modes[item['policy']],'permissions':{'disableBypassPermissionsMode':True},'allowDangerouslySkipPermissions':False}

def select_runtime_profile(config):
    # Only the key Root's own trusted config FD carries selects a profile. Tool and
    # admin requests never reach this function; a second profile key is a conflict.
    present=[profile for profile,key in RUNTIME_KEYS if key in config]
    if len(present)>1:raise Refusal('runtime_profile_conflict')
    return present[0] if present else 'fresh'

def item_profile_conflict(item,runtime_key):
    return any(key in item and key!=runtime_key for _,key in RUNTIME_KEYS)

def guided_requirement(value):
    # Plain Root-config correlation: the SDK's closed {version:1,bindingId}. Delivery
    # from a prepared query to Root is a separate, undecided transport.
    if type(value) is not dict or set(value)!={'version','bindingId'} or type(value['version']) is not int or value['version']!=1 or type(value['bindingId']) is not str or not GUIDED_UUID4.fullmatch(value['bindingId']):raise Refusal('guided_context')
    return {'version':1,'bindingId':value['bindingId']}

def guided_generation(value):
    # Explicit Root input. The production expiry/replay policy is still undecided.
    if type(value) is not int or not 1<=value<=JS_SAFE_INTEGER:raise Refusal('guided_generation')
    return value

def guided_host_query_config(item,tool_classes,model,requirement):
    config=host_query_config(item,tool_classes,model)
    config['requiredRuntimeContext']=guided_requirement(requirement)
    return config

def guided_reader_registration(item,config,boot_id,registration_id,generation):
    # Closed DATA only: the guest validators bind it, the native owner does not authenticate it.
    requirement=guided_requirement(config.get('requiredRuntimeContext'));source=config['cwd'];authority=item['authority']
    if not GUIDED_SOURCE_ROOT.fullmatch(source):raise Refusal('guided_roots')
    if type(authority['leaseEpoch']) is not int or not 1<=authority['leaseEpoch']<=JS_SAFE_INTEGER or type(boot_id) is not str or not GUIDED_BOOT_ID.fullmatch(boot_id):raise Refusal('guided_scope')
    if type(registration_id) is not str or not GUIDED_UUID4.fullmatch(registration_id):raise Refusal('guided_registration')
    owner={'workspaceId':authority['workspaceId'],'logicalSessionId':item['logicalSessionId'],'backendSessionId':authority['sessionId'],'incarnationId':authority['incarnationId'],'leaseEpoch':authority['leaseEpoch'],'bootId':boot_id,'generation':guided_generation(generation)}
    return {'version':1,'registrationId':registration_id,'owner':owner,'views':{'sourceRoot':source,'sourceCwd':source,'sharedRoot':GUIDED_SHARED_ROOT,'sharedPath':GUIDED_SHARED_PATH},'limits':dict(GUIDED_READER_LIMITS),'requiredRuntimeContext':requirement}

def guidance_directory(source,protected,root_sources):
    # Guided only. Root's dedicated canonical guidance directory: the same no-symlink, identity-checked
    # walk as every source root, refused when it equals, contains or sits inside ANY protected store/run
    # home/config path (so it can never widen to the enclosing .winter) or ANY admitted tool root (a
    # writable root would let a tool edit guidance), by path in either direction and by inode.
    if type(source) is not str or not 1<=len(source)<=4096 or '\0' in source:raise Refusal('guided_guidance')
    fd=source_directory(source,protected)
    try:
        spelling=Path(source);held=os.fstat(fd)
        for root in root_sources:
            if spelling==root or spelling in root.parents or root in spelling.parents:raise Refusal('guided_guidance_overlap')
            other=root.stat()
            if (other.st_dev,other.st_ino)==(held.st_dev,held.st_ino):raise Refusal('guided_guidance_overlap')
        result=fd;fd=None;return result
    finally:
        if fd is not None:os.close(fd)

def bootstrap_rights(profile,pidfd,service_pidfd,store_fd,executable_fd,reader_fd=None):
    # The native owner accepts exactly four descriptors, or five for guided with its reader channel.
    rights=array.array('i',[pidfd,service_pidfd,store_fd,executable_fd])
    if profile==GUIDED_PROFILE:
        if type(reader_fd) is not int or reader_fd<0:raise Refusal('guided_reader_channel')
        rights.append(reader_fd)
    elif reader_fd is not None:raise Refusal('runtime_profile_conflict')
    return rights

# ---- Guided reader service: Root's end of the fifth descriptor --------------------------------------------------------
# The TS side (linux-guided-reader-protocol.ts, linux-guided-reader-channel.ts) is the source of truth for every frame.
# Frames are a 4-byte big-endian length and a compact literal-UTF-8 JSON body that JSON.stringify(JSON.parse(body)) reproduces
# byte for byte. A frame is DATA: nothing here admits an owner, a source path or a provider.
GUIDED_READER_REQUEST_BYTES=4096
GUIDED_READER_BODY_BYTES=1024*1024+4096
GUIDED_READER_OUTSTANDING=16
GUIDED_READER_CONSUMED=4096
GUIDED_READER_FRAME_BYTES=320*1024
GUIDED_READER_INPUT_BYTES=16*1024
GUIDED_READER_STDERR_BYTES=16*1024
GUIDED_READER_SUPERVISE_SECONDS=4.5
GUIDED_READER_REAP_SECONDS=2
GUIDED_READER_SEND_SECONDS=5
GUIDED_OWNER_KEYS=('workspaceId','logicalSessionId','backendSessionId','incarnationId','leaseEpoch','bootId','generation')
GUIDED_TERMINAL_FLAGS=('namespaceInitReaped','monitorReaped','stdoutEof','stderrEof','captureDrained')
READER_VIEWS_ROOT='/run/winter/instruction-reader-views'
READER_DEPENDENCY_LIMIT=32

def wire_json(value):return json.dumps(value,separators=(',',':'),ensure_ascii=False,allow_nan=False)
def _wire_int(text):
    value=int(text)
    # A number JavaScript cannot round-trip exactly is refused; so is anything whose JSON.stringify spelling could differ from ours.
    if abs(value)>JS_SAFE_INTEGER+1:raise ValueError(text)
    return value
def _wire_float(text):
    value=float(text)
    # Non-integral decimals in the range where Python repr and JavaScript's shortest form are both plain notation; everything else is refused.
    if text!=repr(value) or 'e' in text.lower() or value==int(value) or not 1e-4<=abs(value)<1e16:raise ValueError(text)
    return value
def _wire_parse(body):
    try:
        text=bytes(body).decode('utf-8');return text,json.loads(text,parse_int=_wire_int,parse_float=_wire_float)  # NaN and Infinity parse but cannot be written back (allow_nan=False), so they never round-trip
    except (ValueError,RecursionError):raise Refusal('guided_reader_frame')
def _wire_text(value):
    try:return wire_json(value)
    except (ValueError,RecursionError):raise Refusal('guided_reader_frame')
def reader_wire_frame(value):
    try:body=wire_json(value).encode()
    except (ValueError,RecursionError):raise Refusal('guided_reader_frame')
    if not 1<=len(body)<=GUIDED_READER_BODY_BYTES:raise Refusal('guided_reader_frame')
    return struct.pack('!I',len(body))+body
def _reader_uuid(value):return type(value) is str and GUIDED_UUID4.fullmatch(value) is not None
def _same(left,right):return type(left) is type(right) and left==right
def _closed(value,names):
    if type(value) is not dict or set(value)!=set(names):raise Refusal('guided_reader_frame')
    return value
def reader_request(body,registration):
    """One guest frame body -> ('start', readId, contextRequestId) or ('cancel', readId, None). Anything else refuses.

    Acceptance means the bytes are EXACTLY what linuxGuidedReaderStart/linuxGuidedReaderCancel plus the channel's encoder
    produce for this registration, so key order, whitespace, escapes, duplicate keys and number spellings cannot differ."""
    text,value=_wire_parse(body)
    if type(value) is not dict:raise Refusal('guided_reader_frame')
    kind=value.get('kind');read=value.get('readId');registration_id=registration['registrationId'];owner=value.get('owner')
    # The owner object keeps whatever key order the guest's parsed registration had (Root's record is key-sorted); its VALUES must be Root's own.
    if type(owner) is not dict or set(owner)!=set(GUIDED_OWNER_KEYS) or any(not _same(owner[key],registration['owner'][key]) for key in GUIDED_OWNER_KEYS):raise Refusal('guided_reader_frame')
    if kind=='reader_start':
        context=value.get('contextRequestId');binding=registration['requiredRuntimeContext']['bindingId']
        # registrationId and bindingId are pinned by the canonical-bytes rule below: the expected text carries Root's own values.
        if not _reader_uuid(read) or not _reader_uuid(context) or read==context:raise Refusal('guided_reader_frame')
        expected={'version':1,'kind':'reader_start','registrationId':registration_id,'owner':owner,'readId':read,'contextRequestId':context,'bindingId':binding}
    elif kind=='reader_cancel':
        context=None
        if not _reader_uuid(read):raise Refusal('guided_reader_frame')
        expected={'version':1,'kind':'reader_cancel','registrationId':registration_id,'readId':read,'owner':owner}
    else:raise Refusal('guided_reader_frame')
    if _wire_text(expected)!=text:raise Refusal('guided_reader_frame')
    return ('start' if kind=='reader_start' else 'cancel'),read,context
class ReaderFrameDecoder:
    """Incremental 4-byte-length framing for the guest's requests. A size outside 1..4096 refuses; nothing is buffered beyond one frame."""
    def __init__(self):self.buffer=bytearray()
    def feed(self,data):
        self.buffer.extend(data);frames=[]
        while True:
            if len(self.buffer)>=4:
                size=struct.unpack('!I',bytes(self.buffer[:4]))[0]
                if not 1<=size<=GUIDED_READER_REQUEST_BYTES:raise Refusal('guided_reader_frame')
                if len(self.buffer)>=4+size:frames.append(bytes(self.buffer[4:4+size]));del self.buffer[:4+size];continue
            return frames
def _reader_owner(value):
    # The guest also checks each owner id's grammar and the epoch/generation range; for a registration Root built (and the guest's own parser
    # accepted) equality with it implies all of that, so only the closed shape is checked here.
    return _closed(value,GUIDED_OWNER_KEYS)
def check_reader_value(data,registration,read_id):
    """Python mirror of parseLinuxGuidedReaderMessage: what Root sends must be what the guest's validator accepts."""
    if not _reader_uuid(read_id) or type(data) is not dict:raise Refusal('guided_reader_frame')
    common=('version','kind','registrationId','readId','owner')
    kind=data.get('kind')
    _closed(data,common+('frame',) if kind=='reader_result' else common+('outcome','namespaceInitReaped','monitorReaped','namespaceWaitStatus','monitorWaitStatus','stdoutEof','stderrEof','captureDrained'))
    owner=_reader_owner(data['owner'])
    if not _same(data['version'],1) or not _same(data['registrationId'],registration['registrationId']) or not _same(data['readId'],read_id) or any(not _same(owner[key],registration['owner'][key]) for key in GUIDED_OWNER_KEYS):raise Refusal('guided_reader_frame')
    if kind=='reader_result':
        frame=data['frame']
        try:size=len(frame.encode()) if type(frame) is str else None
        except UnicodeEncodeError:size=None
        if size is None or size>GUIDED_READER_FRAME_BYTES or not frame.endswith('\n') :raise Refusal('guided_reader_frame')
        _,inner=_wire_parse(frame.encode())
        echo=_closed(inner,('version','readId','owner','views','limits','snapshot'))
        inner_keys=tuple(key for key in GUIDED_OWNER_KEYS if key!='workspaceId');inner_owner=_closed(echo['owner'],inner_keys)
        views=_closed(echo['views'],tuple(registration['views']));limits=_closed(echo['limits'],tuple(GUIDED_READER_LIMITS))
        if not _same(echo['version'],1) or not _same(echo['readId'],read_id) or any(not _same(inner_owner[key],registration['owner'][key]) for key in inner_keys) \
                or any(not _same(views[key],expected) for key,expected in registration['views'].items()) or any(not _same(limits[key],expected) for key,expected in GUIDED_READER_LIMITS.items()) \
                or _wire_text(inner)+'\n'!=frame:raise Refusal('guided_reader_frame')
        _closed(echo['snapshot'],('blocks','digest','droppedImports','files','provenance','skippedLinks','text','tiers'))
    elif kind=='reader_terminal':
        if type(data['outcome']) is not str or data['outcome'] not in ('ok','unavailable','cancelled') or any(data[key] is not True for key in GUIDED_TERMINAL_FLAGS) \
                or any(type(data[key]) is not int or not 0<=data[key]<=65535 for key in ('namespaceWaitStatus','monitorWaitStatus')):raise Refusal('guided_reader_frame')
    else:raise Refusal('guided_reader_frame')
    return data
def check_reader_message(frame,registration,read_id):
    """Python mirror of decodeLinuxGuidedReaderFrame over a whole length-prefixed frame."""
    if type(frame) not in (bytes,bytearray) or not 5<=len(frame)<=GUIDED_READER_BODY_BYTES+4 or struct.unpack('!I',bytes(frame[:4]))[0]!=len(frame)-4:raise Refusal('guided_reader_frame')
    text,data=_wire_parse(frame[4:])
    if _wire_text(data)!=text:raise Refusal('guided_reader_frame')
    return check_reader_value(data,registration,read_id)
def reader_result_message(registration,read_id,frame):
    return {'version':1,'kind':'reader_result','registrationId':registration['registrationId'],'readId':read_id,'owner':registration['owner'],'frame':frame}
def reader_terminal_message(registration,read_id,outcome,namespace_status,monitor_status):
    return {'version':1,'kind':'reader_terminal','registrationId':registration['registrationId'],'readId':read_id,'owner':registration['owner'],'outcome':outcome,
            'namespaceInitReaped':True,'monitorReaped':True,'namespaceWaitStatus':namespace_status,'monitorWaitStatus':monitor_status,'stdoutEof':True,'stderrEof':True,'captureDrained':True}
def reader_invocation(registration,read_id):
    """The one stdin request of the isolated reader (RuntimeSDK's InstructionReaderInvocation): the registration minus workspaceId, canonical compact JSON."""
    owner=registration['owner']
    body=wire_json({'version':1,'readId':read_id,'owner':{key:owner[key] for key in ('logicalSessionId','backendSessionId','generation','bootId','incarnationId','leaseEpoch')},
                    'views':dict(registration['views']),'limits':dict(registration['limits'])}).encode()
    if len(body)>GUIDED_READER_INPUT_BYTES:raise Refusal('guided_reader_input')
    return body
def reader_argv(launcher,executable,view,receipt,uid,gid,source,source_path,source_cwd,guidance,dependencies):
    """The exact Root-only launch envelope of linux-instruction-reader-compartment.c (argc == 12 + 2 * dependencies)."""
    return [str(launcher),'instruction-reader-v1',str(executable),view,str(receipt),str(uid),str(gid),str(source),source_path,source_cwd,str(guidance),str(len(dependencies)),*[value for fd,path in dependencies for value in (str(fd),path)]]
def reader_dependency_path(value):
    if type(value) is not str or not 2<=len(value)<=1024 or not value.startswith(('/lib/','/lib64/','/usr/lib/')) or any(not 33<=ord(char)<=126 for char in value):return False
    return not any(part in ('','.','..') for part in value[1:].split('/'))
def reader_control_message(control,expect_init):
    """One packet from the launcher's SEQPACKET receipt socket: ('init', pidfd), ('receipt', waitStatus) or ('eof', None).

    Every delivered descriptor is owned before the packet is judged, as receive_init_pidfd does."""
    owned=[]
    try:
        data,ancillary,_,_=control.recvmsg(16,socket.CMSG_SPACE(16*array.array('i').itemsize),getattr(socket,'MSG_CMSG_CLOEXEC',0))
        for level,kind,payload in ancillary:
            if (level,kind)==(socket.SOL_SOCKET,socket.SCM_RIGHTS):
                owned.extend(array.array('i',payload[:len(payload)-len(payload)%array.array('i').itemsize]))
        for fd in owned:os.set_inheritable(fd,False)
        if not data:
            if owned or ancillary:raise Uncertain('guided_reader_receipt')
            return 'eof',None
        if expect_init:
            if data!=b'I' or len(ancillary)!=1 or ancillary[0][:2]!=(socket.SOL_SOCKET,socket.SCM_RIGHTS) or len(ancillary[0][2])!=array.array('i').itemsize or len(owned)!=1:raise Uncertain('guided_reader_receipt')
            return 'init',owned.pop()
        if owned or ancillary or len(data)!=5 or data[:1]!=b'R':raise Uncertain('guided_reader_receipt')
        return 'receipt',struct.unpack('=I',data[1:])[0]
    finally:
        for fd in owned:os.close(fd)
def reader_pidfd_check(fd):
    if os.readlink(f'/proc/self/fd/{fd}')!='anon_inode:[pidfd]':raise Uncertain('guided_reader_receipt')
def reader_kill_init(fd):
    try:signal.pidfd_send_signal(fd,signal.SIGKILL)
    except ProcessLookupError:pass
def poll_readable(fds,timeout):
    """Descriptors that are readable, hung up or in error. select.poll, not select.select: the latter raises ValueError for any descriptor numbered 1024 or more."""
    poller=select.poll()
    for fd in fds:poller.register(fd,select.POLLIN)
    ready=[]
    for fd,event in poller.poll(int(timeout*1000)):
        if event&select.POLLNVAL:raise OSError(errno.EBADF,'invalid descriptor')
        ready.append(fd)
    return ready
def reader_raw_status(code):return code<<8 if code>=0 else -code

class ReaderLauncher:
    """Runs ONE isolated instruction reader through its existing launcher and returns the evidence, never raising for a launch that
    started. Root's creating thread must stay alive until the reader is reaped (PDEATHSIG tracks the thread), so the caller is the
    service's one worker thread. Nothing here chooses a path: every descriptor and mount field comes from Root's trusted config."""
    def __init__(self,*,artifacts,pins,dependencies,uid,gid,source,source_path,source_cwd,guidance,views_root=None,retained=None,spawn=None,clock=time.monotonic,kill_init=None,pidfd_check=None,root_uid=0):
        self.root_uid=root_uid;self.artifacts=dict(artifacts);self.pins=dict(pins);self.dependencies=list(dependencies);self.uid=uid;self.gid=gid;self.source=source;self.source_path=source_path;self.source_cwd=source_cwd
        self.guidance=guidance;self.views_root=views_root or READER_VIEWS_ROOT;self.retained=retained if retained is not None else [];self.spawn=spawn or subprocess.Popen;self.clock=clock
        self.kill_init=kill_init or reader_kill_init;self.pidfd_check=pidfd_check or reader_pidfd_check
    def _vacuous(self):
        # Nothing was launched: there is no namespace init, monitor or pipe to reap, and the receipt says so with zero statuses.
        return {'launched':False,'outcome':'unavailable','frame':None,'namespaceInitReaped':True,'monitorReaped':True,'namespaceWaitStatus':0,'monitorWaitStatus':0,'stdoutEof':True,'stderrEof':True,'captureDrained':True}
    def _view(self,read_id):
        path=f'{self.views_root}/{read_id}';os.mkdir(path,0o700);os.chmod(path,0o700);st=os.lstat(path)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid!=self.root_uid or st.st_mode&0o777!=0o700 or os.listdir(path):os.rmdir(path);raise Refusal('guided_reader_view')
        return path
    def run(self,read_id,request,cancel):
        result=self._vacuous()
        if type(request) is not bytes or not 1<=len(request)<=GUIDED_READER_INPUT_BYTES:return result
        view=None;control=remote=child=selector=pidfd=None
        try:
            for name in ('launcher','executable'):verify_held_artifact(self.artifacts[name],self.pins[name])
            for fd,_,pin in self.dependencies:verify_held_artifact(fd,pin)
            view=self._view(read_id);control,remote=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
            argv=reader_argv(self.artifacts['launcher'],self.artifacts['executable'],view,remote.fileno(),self.uid,self.gid,self.source,self.source_path,self.source_cwd,self.guidance,[(fd,path) for fd,path,_ in self.dependencies])
            fds=[self.artifacts['launcher'],self.artifacts['executable'],remote.fileno(),self.source,self.guidance,*[fd for fd,_,_ in self.dependencies]]
        except (Refusal,OSError):
            if control is not None:control.close()
            if remote is not None:remote.close()
            if view is not None:
                try:os.rmdir(view)
                except OSError:pass
            return result
        out=bytearray();err=bytearray();status=None;overrun=False;timed_out=False;killed=False;fallback=False;code=None
        try:
            executable=f"/proc/self/fd/{self.artifacts['launcher']}"
            try:
                child=self.spawn(argv,executable=executable,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=fds,close_fds=True,env={'LANG':'C','LC_ALL':'C'},start_new_session=True,bufsize=0)
            except OSError as error:
                # Only a failed exec of the launcher itself (CPython names the executable in it) proves no process exists. Any other OSError may come after
                # the exec succeeded, with a live monitor and no handle: that is unaccounted for, never the vacuous receipt.
                if error.filename!=executable:result.update(launched=True,namespaceInitReaped=False,monitorReaped=False,namespaceWaitStatus=None,monitorWaitStatus=None,stdoutEof=False,stderrEof=False,captureDrained=False)
                raise
            finally:remote.close()
            # From here a process may exist: every flag below is False until it is actually observed.
            result.update(launched=True,namespaceInitReaped=False,monitorReaped=False,namespaceWaitStatus=None,monitorWaitStatus=None,stdoutEof=False,stderrEof=False,captureDrained=False)
            try:
                child.stdin.write(request)
            except OSError:pass
            finally:
                try:child.stdin.close()
                except OSError:pass
            selector=selectors.DefaultSelector();control.setblocking(False);selector.register(control,selectors.EVENT_READ)
            for stream in (child.stdout,child.stderr):os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ)
            start=self.clock();hard=start+GUIDED_READER_SUPERVISE_SECONDS+GUIDED_READER_REAP_SECONDS
            while selector.get_map():
                now=self.clock()
                if now>hard:raise Uncertain('guided_reader_cleanup_unconfirmed')
                if now-start>GUIDED_READER_SUPERVISE_SECONDS:timed_out=True
                want=cancel.is_set() or timed_out or overrun
                if want and not killed and pidfd is not None:
                    # The pidfd kill is the cancellation. Root sends the launcher NO packet: the monitor never reads one, and closing a unix socket that
                    # holds an unread packet resets the peer, which can hide the monitor's own 'R' receipt behind ECONNRESET.
                    self.kill_init(pidfd);killed=True
                elif want and pidfd is None and not fallback and timed_out:
                    # Before the launcher's 'I' receipt nothing can name the namespace init: the monitor itself is the last resort.
                    try:child.kill()
                    except OSError:pass
                    fallback=True
                for event,_ in selector.select(.05):
                    stream=event.fileobj
                    if stream is control:
                        try:kind,value=reader_control_message(control,pidfd is None and status is None)
                        except BlockingIOError:continue
                        if kind=='eof':selector.unregister(control)
                        elif kind=='init':
                            pidfd=value;self.pidfd_check(pidfd)
                        elif pidfd is None or status is not None:raise Uncertain('guided_reader_receipt')
                        else:status=value
                    else:
                        try:data=os.read(stream.fileno(),16384)
                        except BlockingIOError:continue
                        target,limit=(out,GUIDED_READER_FRAME_BYTES) if stream is child.stdout else (err,GUIDED_READER_STDERR_BYTES)
                        if not data:selector.unregister(stream);continue
                        room=limit+1-len(target)
                        if room>0:target.extend(data[:room])
                        if len(target)>limit:overrun=True
            try:code=child.wait(timeout=max(.1,hard-self.clock()))
            except subprocess.TimeoutExpired:raise Uncertain('guided_reader_cleanup_unconfirmed')
            result.update(namespaceInitReaped=status is not None,namespaceWaitStatus=status,monitorReaped=True,monitorWaitStatus=reader_raw_status(code),stdoutEof=True,stderrEof=True,captureDrained=True)  # the loop only ends once the receipt socket and both pipes reached EOF
            if pidfd is None and status is None and code==64:
                # Exit 64 is the launcher's refusal of its own envelope, which happens strictly before the namespace fork: no init ever existed.
                result.update(namespaceInitReaped=True,namespaceWaitStatus=0)
            if cancel.is_set():result['outcome']='cancelled'
            elif overrun or timed_out or status != 0 or code != 0:result['outcome']='unavailable'
            else:
                try:result.update(outcome='ok',frame=bytes(out).decode('utf-8'))
                except UnicodeDecodeError:result['outcome']='unavailable'
        except (Refusal,Uncertain,OSError,ValueError):
            # Whatever was not observed stays False: the service turns that into retained debt and sends no receipt.
            result['outcome']='unavailable'
        finally:
            if selector is not None:selector.close()
            if child is not None and not result['monitorReaped']:
                try:child.kill()
                except OSError:pass
                self.retained.append(child)
            if child is not None:
                for stream in (child.stdin,child.stdout,child.stderr):
                    try:
                        if stream is not None:stream.close()
                    except OSError:pass
            for end in (control,remote):
                if end is not None:end.close()
            if pidfd is not None:os.close(pidfd)
            if view is not None and (not result['launched'] or result['monitorReaped']):
                try:os.rmdir(view)
                except OSError:pass
        return result

class GuidedReaderService:
    """Root's service on its end of the guided runtime's fifth descriptor, for ONE incarnation.

    Handoff: Root made the stream for this run alone, sent the other end exactly once in the bootstrap envelope and then handed THIS end
    to the one service instance built for the run. `start` claims it exactly once; a second claim, or any claim after the service
    stopped, refuses. The service is also bound to the run's registration (owner, views, limits, binding) and to the runtime's
    namespace-init pidfd: the runtime exiting, a revocation or a shutdown ends service. Root never half-closes or shuts the stream down
    while serving, because the native owner reads that as the owner being lost.

    Serving: a bounded, serial reader queue. At most 16 reads are outstanding, replays and unknown requests are protocol violations that
    stop the service (the guest's own channel fails closed on the same events), and a receipt is sent only from real evidence: the
    namespace init reaped, the monitor reaped, both pipes at EOF and the capture drained. Missing evidence is retained debt, never a receipt."""
    def __init__(self,*,registration,stream,owner_pidfd,halt,launch,clock=time.monotonic):
        self.registration=registration;self.stream=stream;self.owner_pidfd=owner_pidfd;self.halt=halt;self.launch=launch;self.clock=clock
        self.cv=threading.Condition();self.send_lock=threading.Lock();self.state='new';self.failure=None;self.threads=[];self.queue=[];self.reads={};self.consumed=set();self.uncertain=[]
        self.counts={'started':0,'ok':0,'unavailable':0,'cancelled':0,'ignoredCancels':0}
    @property
    def debt(self):return bool(self.uncertain)
    def start(self):
        with self.cv:
            if self.state!='new':raise Refusal('guided_reader_claimed')
            self.state='serving'
        self.stream.settimeout(GUIDED_READER_SEND_SECONDS)
        self.threads=[threading.Thread(target=self._serve,daemon=True),threading.Thread(target=self._work,daemon=True)]
        for thread in self.threads:thread.start()
    def observations(self):
        with self.cv:return {'state':self.state,'failure':self.failure,'consumed':len(self.consumed),'outstanding':len(self.reads),'uncertainReads':len(self.uncertain),**self.counts}
    def _owner_gone(self):
        if self.owner_pidfd is None:return False
        try:return bool(poll_readable([self.owner_pidfd],0))
        except (OSError,ValueError):return True
    def _fail(self,code):
        with self.cv:
            if self.state in ('failed','closed'):return
            self.state='failed';self.failure=code
            for read in self.reads.values():read['cancel'].set()
            for read in self.queue:self.reads.pop(read['readId'],None)
            del self.queue[:];self.cv.notify_all()
    def _serve(self):
        decoder=ReaderFrameDecoder()
        try:
            while True:
                with self.cv:
                    if self.state!='serving':return
                if self.halt.is_set() or self._owner_gone():self._fail('owner_ended');return
                try:ready=poll_readable([self.stream.fileno()],.05)
                except (OSError,ValueError):self._fail('stream_lost');return
                if not ready:continue
                try:data=self.stream.recv(65536)
                except (BlockingIOError,socket.timeout):continue
                except OSError:self._fail('stream_lost');return
                if not data:self._fail('stream_closed');return
                for body in decoder.feed(data):self._handle(body)
        except Refusal as error:self._fail(str(error))
    def _handle(self,body):
        kind,read_id,context=reader_request(body,self.registration)
        terminal=None
        with self.cv:
            if self.state!='serving':return
            if kind=='start':
                if read_id in self.consumed or len(self.consumed)>=GUIDED_READER_CONSUMED or len(self.reads)>=GUIDED_READER_OUTSTANDING:raise Refusal('guided_reader_bound')
                read={'readId':read_id,'contextRequestId':context,'state':'queued','cancel':threading.Event()}
                self.consumed.add(read_id);self.reads[read_id]=read;self.queue.append(read);self.counts['started']+=1;self.cv.notify_all()
            else:
                read=self.reads.get(read_id)
                if read is None:
                    # A cancel that crossed its own terminal receipt is benign; one for a read never started is not.
                    if read_id not in self.consumed:raise Refusal('guided_reader_unknown')
                    self.counts['ignoredCancels']+=1
                elif read['state']=='queued':
                    self.queue.remove(read);read['state']='done';terminal=read
                else:read['cancel'].set()
        if terminal is not None:self._terminal(terminal,'cancelled',0,0)
    def _send(self,message):
        frame=reader_wire_frame(message);check_reader_message(frame,self.registration,message['readId'])
        try:
            with self.send_lock:self.stream.sendall(frame)
        except (OSError,socket.timeout):self._fail('stream_lost');raise Refusal('guided_reader_send')
    def _terminal(self,read,outcome,namespace_status,monitor_status):
        try:self._send(reader_terminal_message(self.registration,read['readId'],outcome,namespace_status,monitor_status))
        except Refusal:return
        with self.cv:
            self.reads.pop(read['readId'],None);read['state']='done'
            if outcome in self.counts:self.counts[outcome]+=1
    def _work(self):
        while True:
            with self.cv:
                while not self.queue and self.state=='serving':self.cv.wait(.1)
                if self.state!='serving':return
                read=self.queue.pop(0);read['state']='running'
            self._run_one(read)
    def _run_one(self,read):
        if self.halt.is_set() or self._owner_gone():
            # Revoked or ended before launch: nothing was started, so no process evidence exists or is owed.
            self._fail('owner_ended');return
        try:result=self.launch(read['readId'],reader_invocation(self.registration,read['readId']),read['cancel'])
        except BaseException:
            self._debt(read);self._fail('launch_failed');return
        complete=type(result) is dict and all(result.get(key) is True for key in GUIDED_TERMINAL_FLAGS) and all(type(result.get(key)) is int and 0<=result[key]<=65535 for key in ('namespaceWaitStatus','monitorWaitStatus'))
        if not complete:
            self._debt(read);self._fail('reader_evidence_missing');return
        outcome=result.get('outcome');frame=result.get('frame')
        if read['cancel'].is_set():outcome='cancelled'
        if outcome=='ok':
            message=reader_result_message(self.registration,read['readId'],frame)
            try:check_reader_message(reader_wire_frame(message),self.registration,read['readId'])
            except Refusal:outcome='unavailable'
            else:
                try:self._send(message)
                except Refusal:return
        elif outcome not in ('unavailable','cancelled'):outcome='unavailable'
        self._terminal(read,outcome,result['namespaceWaitStatus'],result['monitorWaitStatus'])
    def _debt(self,read):
        with self.cv:
            read['state']='uncertain'
            if read['readId'] not in self.uncertain:self.uncertain.append(read['readId'])
    def stop(self):
        """End service and wait for the worker. True only when no read is left unaccounted for. Idempotent; never closes the stream."""
        with self.cv:
            fresh=self.state=='new'
            if fresh:self.state='closed'
        if fresh:return True
        self._fail('stopped')
        deadline=self.clock()+GUIDED_READER_SUPERVISE_SECONDS+GUIDED_READER_REAP_SECONDS+1
        for thread in self.threads:thread.join(max(0,deadline-self.clock()))
        with self.cv:
            if any(thread.is_alive() for thread in self.threads) and 'worker' not in self.uncertain:self.uncertain.append('worker')
            self.state='closed'
        return not self.debt

class ToolService:
    def __init__(self,config,*,host_query_ports=None):
        if sys.platform!='linux' or os.geteuid()!=0:raise Refusal('protected_linux_root_required')
        if not sys.flags.isolated or not sys.flags.no_site:raise Refusal('isolated_interpreter_required')
        if config.get('guestBootId')!=Path('/proc/sys/kernel/random/boot_id').read_text().strip():raise Refusal('stale_guest_boot')
        self.lock=threading.RLock();self.stop_event=threading.Event();self.conversations={};self.active={};self.debt=set();self.tickets={};self.retained_children=[];self.tool_connections=threading.BoundedSemaphore(TOOL_CONNECTION_LIMIT);self.admin_connections=threading.BoundedSemaphore(ADMIN_CONNECTION_LIMIT)
        self.host_query_ports=dict(host_query_ports or {})
        self.reader=None;self.artifacts={};self.artifact_pins={};self.owned=[];self.listeners=[];self.threads=[];self.runtimes={};self.runtime_artifacts={};self.runtime_pins={};self.guest_boot=config['guestBootId']
        try:
            # First inside the try: a conflict still refuses before any artifact opens, and close() releases injected ports.
            self.runtime_profile=select_runtime_profile(config)
            for name in ('launcher','fileWorker','processWorker'):self.artifacts[name]=pinned_artifact(config['artifacts'][name]);self.artifact_pins[name]=config['artifacts'][name]['sha256'];self.owned.append(self.artifacts[name])
            runtime_key=dict(RUNTIME_KEYS)[self.runtime_profile]
            expected_ports={item['logicalSessionId'] for item in config['conversations'] if 'hostQueryRuntime' in item or 'hostQueryGuidedRuntime' in item}
            if set(self.host_query_ports)!=expected_ports or any(type(port) is not RuntimeDuplexPorts for port in self.host_query_ports.values()):raise Refusal('host_query_transport')
            if any(item_profile_conflict(item,runtime_key) for item in config['conversations']):raise Refusal('runtime_profile_conflict')
            if runtime_key in config:
                if set(config[runtime_key])!=({'artifacts','reader'} if self.runtime_profile==GUIDED_PROFILE else {'artifacts'}) or set(config[runtime_key]['artifacts'])!={'launcher','executable','ownerLibrary'}:raise Refusal('runtime_artifacts')
                for name,value in config[runtime_key]['artifacts'].items():
                    self.runtime_artifacts[name]=pinned_artifact(value);self.runtime_pins[name]=value['sha256'];self.owned.append(self.runtime_artifacts[name])
            self.environment=os.open(config['environment'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);self.owned.append(self.environment)
            self.directory=Path(config['controlDirectory']).resolve(strict=True)
            protected=[self.directory,Path(config['environment']).resolve(strict=True)]+[Path(v['path']).resolve(strict=True).parent for v in config['artifacts'].values()]
            protected.extend(Path(path).resolve(strict=True) for path in config['protectedStoreDirectories'])
            if self.runtime_artifacts:
                protected.extend(Path(v['path']).resolve(strict=True).parent for v in config[runtime_key]['artifacts'].values())
                protected.extend(Path(v[runtime_key][key]).resolve(strict=True) for v in config['conversations'] if runtime_key in v for key in ('storeDirectory','runhomeDirectory'))
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
                    # Host-query roots are served at the path they are admitted from: the source is exactly the guest view, so it is inside the admitted
                    # views by construction and can never name a different (protected or foreign) directory.
                    if ('hostQueryRuntime' in item or 'hostQueryGuidedRuntime' in item) and not host_query_source_is_view(root['source'],guest):raise Refusal('admitted_root')
                    fd=source_directory(root['source'],protected);self.owned.append(fd)
                    roots[root['id']]={'root':runtime_root_metadata(root,item['policy'],'hostQueryRuntime' in item or 'hostQueryGuidedRuntime' in item),'fd':fd}
                views=[v['root']['guestPath'] for v in roots.values()]
                if len(set(views))!=len(views) or any(a!=b and b.startswith(a+'/') for a in views for b in views):raise Refusal('overlapping_roots')
                private=self.directory/sid;private.mkdir(mode=0o750);os.chown(private,0,runtime)
                self.conversations[sid]={'logicalSessionId':sid,'authority':scope,'runtimeUid':runtime,'toolUid':tool,'workspaceGid':group,'policy':item['policy'],'roots':roots,'socket':private/'tools.sock','revoked':False}
                self.tickets[sid]={}
                if runtime_key in item:self._configure_runtime(self.conversations[sid],item[runtime_key],profile=self.runtime_profile)
            if self.runtime_profile==GUIDED_PROFILE:
                root_sources=[Path(root['source']).resolve(strict=True) for entry in config['conversations'] for root in entry['roots']]
                for entry in config['conversations']:
                    if runtime_key in entry:
                        # The reader service must refuse to serve a view that is not mounted: a guided conversation without its guidance directory is not admitted.
                        if 'guidanceDirectory' not in entry[runtime_key]:raise Refusal('guided_guidance_required')
                        fd=guidance_directory(entry[runtime_key]['guidanceDirectory'],protected,root_sources);self.owned.append(fd);self.conversations[entry['logicalSessionId']]['guidance']=fd
                if any(runtime_key in entry for entry in config['conversations']):self.reader=self._open_reader(config[runtime_key]['reader'],config['conversations'])
        except BaseException:
            self.close();raise
    def _listener(self,path,uid,handler,*,admin=False):
        capacity=self.admin_connections if admin else self.tool_connections
        local_capacity=None if admin else threading.BoundedSemaphore(6)
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
                        reply_busy(connection,uid)
                    except (OSError,Refusal):pass
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
                result={'active':sum(sid==request['sessionId'] for sid,_,_ in self.active.values()),'uncertain':request['sessionId'] in self.debt}
                if request['sessionId'] in getattr(self,'runtimes',{}):result['runtime']={key:self.runtimes[request['sessionId']].get(key) for key in ('state','exitCode','cleanupConfirmed')}
                frame_write(channel,result)
    def revoke(self,sid):
        with self.lock:
            self.conversations[sid]['revoked']=True
            if sid in getattr(self,'runtimes',{}):self.runtimes[sid]['cancel'].set()
            for active_sid,cancel,_ in self.active.values():
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
                if sum(active_kind==kind for _,_,active_kind in self.active.values()) >= (16 if kind=='file' else 8) or sum(active_sid==sid and active_kind==kind for active_sid,_,active_kind in self.active.values()) >= (4 if kind=='file' else 2):raise Refusal('capacity_busy')
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
                self.active[(sid,key)]=(sid,cancel,kind);admitted=True
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
                    if self.active.get((sid,key))==(sid,cancel,kind):self.active.pop((sid,key),None)
    def _run(self,item,kind,operation,root,relative,limit,extra,payload,seconds,cancel,channel):
        sid=item['logicalSessionId']
        for name in ('launcher','processWorker' if kind=='process' else 'fileWorker'):verify_held_artifact(self.artifacts[name],self.artifact_pins[name])
        view=tempfile.mkdtemp(prefix='view-',dir=self.directory);control,parent=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);child=None;pidfd=None;cleanup=False
        try:
            worker=self.artifacts['processWorker' if kind=='process' else 'fileWorker']
            arguments=[str(self.artifacts['launcher']),str(worker),view,str(parent.fileno()),str(self.environment),str(item['toolUid']),str(item['workspaceGid']),native_mount_policy(item['policy']),kind,operation,root['root']['guestPath'],relative,str(limit),extra,str(len(item['roots']))]
            descriptors=[self.artifacts['launcher'],worker,parent.fileno(),self.environment]
            for binding in item['roots'].values():arguments.extend((str(binding['fd']),binding['root']['guestPath'],'1' if binding['root']['readOnly'] else '0'));descriptors.append(binding['fd'])
            if item.get('guidance') is not None:arguments.extend(('--guidance',str(item['guidance'])));descriptors.append(item['guidance'])
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
    def _configure_runtime(self,item,value,*,profile='fresh'):
        # Only immutable root bootstrap can select artifacts, directories, model or
        # public provider metadata. The tool/admin launch request carries only sid.
        allowed={'storeDirectory','runhomeDirectory','provider','model','timeoutMs'}
        if profile in ('host-query-v1',GUIDED_PROFILE):allowed.add('toolClasses')
        if profile==GUIDED_PROFILE:allowed.update(('requiredRuntimeContext','generation','guidanceDirectory'))
        elif profile not in ('fresh','host-query-v1'):raise Refusal('runtime_profile_conflict')
        if not self.runtime_artifacts or not isinstance(value,dict) or set(value)-allowed or not {'storeDirectory','runhomeDirectory','provider','model'}<=set(value):raise Refusal('runtime_config')
        if profile==GUIDED_PROFILE and 'guidanceDirectory' not in value:raise Refusal('guided_guidance_required')
        port=None;host_config=None;reader_registration=None
        if profile in ('host-query-v1',GUIDED_PROFILE):
            if profile==GUIDED_PROFILE:
                host_config=guided_host_query_config(item,value.get('toolClasses'),value['model'],value.get('requiredRuntimeContext'))
                reader_registration=guided_reader_registration(item,host_config,self.guest_boot,str(uuid.uuid4()),value.get('generation'))
            else:host_config=host_query_config(item,value.get('toolClasses'),value['model'])
            port=getattr(self,'host_query_ports',{}).get(item['logicalSessionId'])
            if type(port) is not RuntimeDuplexPorts:raise Refusal('host_query_transport')
            port.bind(item)
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
        if port is not None:self.runtimes[item['logicalSessionId']].update(profile=profile,duplex=port,hostConfig=host_config)
        if reader_registration is not None:self.runtimes[item['logicalSessionId']].update(readerRegistration=reader_registration)
    def _runtime_record(self,item,runtime):
        sid=item['logicalSessionId'];home=f'/run/winter/conversations/{sid}';store=f'/workspace/.winter/conversations/{sid}'
        # Root-owned fixture preauthorization only. Winter's production Auto uses
        # SDK default plus the host approval bridge; that bridge is not this fixture.
        tools=['Read','Write','Edit','Bash'];scope={key:item['authority'][key] for key in ('workspaceId','sessionId','incarnationId','leaseEpoch')};scope.update(storeHome=store,currentBootId=self.guest_boot)
        record={'protocolVersion':1,'freshOnly':True,'runtimeUid':item['runtimeUid'],'toolUid':item['toolUid'],'workspaceGid':item['workspaceGid'],'logicalSessionId':sid,'scope':scope,'ownerToken':runtime['ownerToken'],'toolSocketPath':home+'/.control/tools.sock','authority':dict(item['authority']),'roots':[binding['root'] for binding in item['roots'].values()],'provider':runtime['provider'],'runtimeConfig':{'executionPosture':'confined-guest','sessionId':item['authority']['sessionId'],'model':runtime['model'],'cwd':next(iter(item['roots'].values()))['root']['guestPath'],'winterHome':home,'storeHome':store,'persistSession':True,'settingSources':[],'tools':tools,'allowedTools':tools,'skills':[],'plugins':[],'strictMcpConfig':True,'mcpServers':{},'permissionMode':'default'}}
        if runtime.get('profile')=='host-query-v1':record.update(profile='host-query-v1',runtimeConfig=json.loads(canonical(runtime['hostConfig'])))
        if runtime.get('profile')==GUIDED_PROFILE:
            record.update(profile=GUIDED_PROFILE,runtimeConfig=json.loads(canonical(runtime['hostConfig'])),readerRegistration=json.loads(canonical(runtime['readerRegistration'])))
            if record['runtimeConfig'].get('requiredRuntimeContext')!=record['readerRegistration']['requiredRuntimeContext']:raise Refusal('guided_context')
        return record
    def _open_reader(self,value,conversations):
        # Guided only. Root's trusted config alone names the isolated reader's launcher, loader, dependency closure and identity.
        if type(value) is not dict or set(value)!={'artifacts','dependencies','uid'} or type(value['artifacts']) is not dict or set(value['artifacts'])!={'launcher','executable'}:raise Refusal('guided_reader_config')
        uid=value['uid'];dependencies=value['dependencies'];reserved={0}
        for entry in conversations:reserved.update((entry['runtimeUid'],entry['toolUid'],entry['workspaceGid']))
        if type(uid) is not int or not 1000<=uid<=65535 or uid in reserved:raise Refusal('guided_reader_identity')
        if type(dependencies) is not list or len(dependencies)>READER_DEPENDENCY_LIMIT or any(type(value['artifacts'][name]) is not dict for name in ('launcher','executable')):raise Refusal('guided_reader_config')
        paths=[]
        for dependency in dependencies:
            if type(dependency) is not dict or set(dependency)!={'path','sha256','guestPath'} or not reader_dependency_path(dependency['guestPath']):raise Refusal('guided_reader_config')
            guest=dependency['guestPath']
            if any(guest==other or guest.startswith(other+'/') or other.startswith(guest+'/') for other in paths):raise Refusal('guided_reader_config')
            paths.append(guest)
        self._reader_views_root()
        reader={'artifacts':{},'pins':{},'dependencies':[],'uid':uid}
        for name in ('launcher','executable'):
            fd=pinned_artifact(value['artifacts'][name]);self.owned.append(fd);reader['artifacts'][name]=fd;reader['pins'][name]=value['artifacts'][name]['sha256']
        for dependency in dependencies:
            fd=pinned_artifact({'path':dependency['path'],'sha256':dependency['sha256']});self.owned.append(fd);reader['dependencies'].append((fd,dependency['guestPath'],dependency['sha256']))
        return reader
    def _reader_views_root(self):
        # Each read's final view directory is made under this parent. The launcher re-checks every ancestor (Root-owned, not group/other writable).
        os.makedirs(READER_VIEWS_ROOT,mode=0o755,exist_ok=True);current=Path(READER_VIEWS_ROOT)
        for each in (current,*current.parents):
            if each==Path('/'):continue
            st=each.lstat()
            if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise Refusal('guided_reader_views')
    def _guided_reader_service(self,item,runtime,stream,pidfd):
        # One service per run; v1 and fresh runs never reach this. The source descriptor is the root the registration names, and the guidance
        # descriptor is the one the constructor already opened and checked for the tool view, so both views name the same directories.
        reader=getattr(self,'reader',None);registration=runtime['readerRegistration'];views=registration['views']
        source=next((binding['fd'] for binding in item['roots'].values() if binding['root']['guestPath']==views['sourceRoot']),None);guidance=item.get('guidance')
        if reader is None or source is None or guidance is None:raise Refusal('guided_reader_service')
        # One service per incarnation: the registration (and the stream made for this run) is bound to exactly one instance, ever.
        if runtime.get('readerService') is not None:raise Refusal('guided_reader_claimed')
        launcher=ReaderLauncher(artifacts=reader['artifacts'],pins=reader['pins'],dependencies=reader['dependencies'],uid=reader['uid'],gid=item['workspaceGid'],source=source,
                                source_path=views['sourceRoot'],source_cwd=views['sourceCwd'],guidance=guidance,retained=self.retained_children)
        built=GuidedReaderService(registration=registration,stream=stream,owner_pidfd=pidfd,halt=runtime['cancel'],launch=launcher.run)
        runtime['readerService']=built
        return built
    def launch_runtime(self,sid):
        with self.lock:
            if sid not in self.runtimes or self.stop_event.is_set() or self.conversations[sid]['revoked'] or sid in self.debt:raise Refusal('runtime_admission')
            runtime=self.runtimes[sid]
            if runtime['state']!='configured':raise Refusal('runtime_fresh_only')
            # Reserve the single fresh launch before starting any external effect.
            runtime['state']='starting';thread=threading.Thread(target=self._run_runtime,args=(self.conversations[sid],runtime),daemon=True);self.threads.append(thread);thread.start()
    def _run_runtime(self,item,runtime):
        sid=item['logicalSessionId'];child=None;pidfd=None;control=None;parent=None;bootstrap=None;guest=None;view=None;selector=None;confirmed=False;service_pidfd=None
        out=bytearray();err=bytearray();failure=None;relay=None;port=runtime.get('duplex');reader_root=None;reader_guest=None;reader_service=None
        observations={'phase':'artifact-admission','nativeReceiptObserved':False,'nativeExitCode':None,'parentReaped':False,'parentExitCode':None,'toolDrainConfirmed':False,'nativeCleanupConfirmed':False,'ownershipReleased':False}
        try:
            if port is not None:port.claim(item)
            for name,fd in self.runtime_artifacts.items():verify_held_artifact(fd,self.runtime_pins[name])
            if os.listdir(runtime['fds']['storeDirectory']) or os.listdir(runtime['fds']['runhomeDirectory']):raise Refusal('runtime_fresh_store_required')
            observations['phase']='native-startup'
            view=tempfile.mkdtemp(prefix='runtime-view-',dir=self.directory);control,parent=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);bootstrap,guest=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
            control_directory=os.open(self.directory/sid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                args=[str(self.runtime_artifacts['launcher']),str(self.runtime_artifacts['executable']),view,str(parent.fileno()),str(self.environment),str(item['runtimeUid']),str(item['workspaceGid']),str(guest.fileno()),str(self.runtime_artifacts['ownerLibrary']),str(runtime['fds']['storeDirectory']),str(runtime['fds']['runhomeDirectory']),str(control_directory),sid,native_mount_policy(item['policy']),str(len(item['roots']))]
                fds=[*self.runtime_artifacts.values(),parent.fileno(),self.environment,guest.fileno(),*runtime['fds'].values(),control_directory]
                for binding in item['roots'].values():args.extend((str(binding['fd']),binding['root']['guestPath'],'1' if binding['root']['readOnly'] else '0'));fds.append(binding['fd'])
                if port is not None:port.verify()
                child=subprocess.Popen(args,executable=f"/proc/self/fd/{self.runtime_artifacts['launcher']}",stdin=subprocess.PIPE if port is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=fds,close_fds=True,env={'LANG':'C','LC_ALL':'C'},start_new_session=True,bufsize=0)
            finally:os.close(control_directory)
            parent.close();guest.close();control.settimeout(2);pidfd=receive_init_pidfd(control);service_pidfd=os.pidfd_open(os.getpid(),0)
            bootstrap_record=self._runtime_record(item,runtime)
            with self.lock:runtime['scope']=bootstrap_record['scope']
            record=canonical(bootstrap_record).encode()
            if len(record)>65536:raise Refusal('runtime_bootstrap_limit')
            guided=runtime.get('profile')==GUIDED_PROFILE
            # Guided only: Root keeps reader_root open until the finally below, and the one reader service built for this run
            # serves it. Closing or shutting it down early would make the native owner check fail.
            if guided:reader_root,reader_guest=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
            rights=bootstrap_rights(runtime.get('profile'),pidfd,service_pidfd,runtime['fds']['storeDirectory'],self.runtime_artifacts['executable'],reader_guest.fileno() if guided else None);bootstrap.settimeout(2)
            if guided:reader_service=self._guided_reader_service(item,runtime,reader_root,pidfd)
            try:sent=bootstrap.sendmsg([record],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,rights)])
            finally:
                if reader_guest is not None:reader_guest.close()
            if sent!=len(record):raise Uncertain('runtime_bootstrap_send')
            with self.lock:runtime.update(state='running',initPidfd=pidfd)
            if reader_service is not None:reader_service.start()
            selector=selectors.DefaultSelector();control.setblocking(False);selector.register(control,selectors.EVENT_READ)
            if port is not None:relay=RuntimeDuplexRelay(port,child,runtime['cancel'])
            else:
                for stream in (child.stdout,child.stderr):os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ)
            terminal=None;start=time.monotonic();killed=False;kill_deadline=None;observations['phase']='sdk-runtime'
            while True:
                if relay is not None:relay.sync(selector)
                if not selector.get_map():break
                if not killed and (runtime['cancel'].is_set() or self.stop_event.is_set() or time.monotonic()-start>runtime['timeout']):
                    try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                    except ProcessLookupError:pass
                    killed=True;kill_deadline=time.monotonic()+2
                if killed and time.monotonic()>kill_deadline:raise Uncertain('runtime_cleanup_unconfirmed')
                for event,_ in selector.select(.05):
                    stream=event.fileobj
                    if relay is not None and event.data and event.data[0]=='duplex':
                        captured=relay.handle(event)
                        if captured:
                            name,data=captured;target,limit=(out,1024*1024) if name=='stdout' else (err,16384)
                            target.extend(data[:max(0,limit+1-len(target))])
                        continue
                    if stream is control:
                        receipt=control.recv(16)
                        if receipt:
                            if terminal is not None or len(receipt)!=5 or receipt[:1]!=b'R':raise Uncertain('runtime_native_receipt')
                            terminal=struct.unpack('=I',receipt[1:])[0]
                            observations.update(nativeReceiptObserved=True,nativeWaitStatus=terminal)
                            if relay is not None:relay.native_terminal()
                        else:selector.unregister(stream)
                    else:
                        try:data=os.read(stream.fileno(),16384)
                        except BlockingIOError:continue
                        if not data:selector.unregister(stream);continue
                        (out if stream is child.stdout else err).extend(data)
                        if len(out)>1024*1024 or len(err)>16384:raise Uncertain('runtime_capture_limit')
            code=child.wait(timeout=1)
            observations.update(parentReaped=True,parentExitCode=code,phase='native-cleanup')
            if terminal is None:raise Uncertain('runtime_native_exit_unconfirmed')
            native=os.waitstatus_to_exitcode(terminal);native=native if native>=0 else 128-native
            observations['nativeExitCode']=native
            if code!=native:raise Uncertain('runtime_parent_reap_unconfirmed')
            # The reader service ends with the runtime. Any reader whose reap, EOF or drain is unproven is retained debt, so tenancy is not released.
            if reader_service is not None:
                reader_service.stop();observations['reader']=reader_service.observations()
                if reader_service.debt:raise Uncertain('guided_reader_debt')
            # Namespace-init wait + launcher reaping precede tool revocation/drain.
            # Runtime JSON/EOF/success and kill delivery cannot acknowledge tenancy.
            self.revoke(sid);deadline=time.monotonic()+3
            while True:
                with self.lock:active=any(active_sid==sid for active_sid,_,_ in self.active.values())
                if not active:break
                if time.monotonic()>deadline:raise Uncertain('runtime_tool_drain_unconfirmed')
                time.sleep(.02)
            with self.lock:
                observations['toolDrainConfirmed']=True
                observations['toolDebtObserved']=sid in self.debt
                if sid in self.debt:raise Uncertain('runtime_tool_debt')
                observations.update(toolDrainConfirmed=True,nativeCleanupConfirmed=True,phase='complete')
                # Publish terminal status only after its diagnostic is durable.
                runtime.update(state='cleaning',exitCode=code,cleanupConfirmed=False)
            confirmed=True
            if code!=0:failure={'class':'RuntimeExit','code':'runtime_nonzero_exit'}
        except (Refusal,Uncertain,OSError,ValueError,subprocess.TimeoutExpired) as error:
            failure=failure_metadata(error)
            with self.lock:runtime['state']='retained';self.debt.add(sid)
            self.revoke(sid)
        finally:
            if selector is not None:selector.close()
            if reader_service is not None:
                # Before any descriptor below is closed: the service polls the runtime pidfd and writes the reader stream.
                reader_service.stop();observations['reader']=reader_service.observations()
            if child is not None and not confirmed:
                try:
                    if pidfd is not None:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                    else:child.kill()
                except OSError:pass
                try:
                    observations.update(parentExitCode=child.wait(timeout=2),parentReaped=True)
                except (subprocess.TimeoutExpired,OSError) as error:
                    self.retained_children.append(child);observations['cleanupFailure']=failure_metadata(error)
                # Drain only already available bytes; EOF is never a death receipt.
                for stream,target,limit in ((child.stdout,out,1024*1024),(child.stderr,err,16384)):
                    try:
                        os.set_blocking(stream.fileno(),False)
                        while len(target)<=limit:
                            data=os.read(stream.fileno(),min(16384,limit+1-len(target)))
                            if not data:break
                            target.extend(data)
                    except (OSError,ValueError):pass
            diagnostic={'version':1,'kind':'fixture-runtime-diagnostic','observations':observations,'failure':failure,'stdout':capture_metadata(out,1024*1024),'stderr':capture_metadata(err,16384,(self.directory.parent,self.directory,view))}
            try:
                write_diagnostic(self.directory/sid/'runtime-diagnostic.json',diagnostic)
                if confirmed:
                    with self.lock:runtime.update(state='stopped',cleanupConfirmed=True)
            except (OSError,ValueError):
                # Losing diagnostics cannot permit release or erase native debt.
                with self.lock:runtime['diagnosticFailed']=True;self.debt.add(sid);runtime['state']='retained'
            if child is not None:
                for stream in (child.stdin,child.stdout,child.stderr):
                    if stream is not None:stream.close()
            if port is not None:port.close()
            with self.lock:runtime.pop('initPidfd',None)
            for fd in (pidfd,service_pidfd):
                if fd is not None:os.close(fd)
            for channel in (control,parent,bootstrap,guest,reader_root,reader_guest):
                if channel is not None:channel.close()
            if confirmed and view is not None:os.rmdir(view)
    def close(self):
        self.stop_event.set()
        with self.lock:
            for _,cancel,_ in self.active.values():cancel.set()
            for runtime in getattr(self,'runtimes',{}).values():runtime['cancel'].set()
        for listener in self.listeners:listener.close()
        deadline=time.monotonic()+3
        for thread in self.threads:
            if isinstance(thread,threading.Thread):thread.join(timeout=max(0,deadline-time.monotonic()))
        if any(thread.is_alive() for thread in self.threads):return False
        for port in getattr(self,'host_query_ports',{}).values():
            if type(port) is RuntimeDuplexPorts:port.close()
        if self.debt:return False
        for fd in self.owned:
            try:os.close(fd)
            except OSError:pass
        self.owned=[]
        return not self.debt

# Root's init (Winter N2 slice S5) starts this process with the trusted config on one descriptor and, when a host-query conversation
# exists, the runtime transport as three FIFOs on three more: the input it reads, then the stdout and stderr it writes. The relay that
# owns the virtio port is the other end of those FIFOs; this process never sees the port, and a tool never inherits these descriptors
# (the supervisor keeps its own CLOEXEC duplicates above fd 64 and the originals are closed before the service starts).
def descriptor_number(text):
    if not re.fullmatch(r'[0-9]{1,9}',text) or str(int(text))!=text:raise SystemExit(64)
    return int(text)

def parse_arguments(argv):
    """argv -> (trusted config fd, None) or (trusted config fd, (input, stdout, stderr)). Anything else is a usage error (64)."""
    arguments=list(argv[1:])
    if len(arguments)==2 and arguments[0]=='--trusted-config-fd':return descriptor_number(arguments[1]),None
    if len(arguments)==4 and arguments[0]=='--trusted-config-fd' and arguments[2]=='--runtime-ports-fds':
        config_fd=descriptor_number(arguments[1]);parts=arguments[3].split(',')
        if len(parts)!=3:raise SystemExit(64)
        ports=tuple(descriptor_number(part) for part in parts)
        # Distinct from each other and from the config, and never a standard stream.
        if len({config_fd,*ports})!=4 or min(ports)<3:raise SystemExit(64)
        return config_fd,ports
    raise SystemExit(64)

def host_query_conversations(config):
    conversations=config.get('conversations') if isinstance(config,dict) else None
    if not isinstance(conversations,list):return []
    return [item for item in conversations if isinstance(item,dict) and ('hostQueryRuntime' in item or 'hostQueryGuidedRuntime' in item)]

def runtime_ports_from_descriptors(config,descriptors):
    """The injected transport for the one host-query conversation, or {} when there is no transport or no conversation that wants one.

    The runtime class of the mux carries a single stream, so more than one host-query conversation cannot be served and is refused.
    The caller still owns (and closes) the three originals: RuntimeDuplexPorts takes its own duplicates and re-checks every FIFO
    fact (type, owner, link count, access mode, non-blocking, distinct inodes) itself."""
    if descriptors is None:return {}
    wanted=host_query_conversations(config)
    if not wanted:return {}
    if len(wanted)>1:raise SystemExit(64)
    (item,)=wanted;sid=item.get('logicalSessionId')
    return {sid:RuntimeDuplexPorts(sid,item.get('authority'),*descriptors)}

def close_descriptors(descriptors):
    for fd in descriptors or ():
        try:os.close(fd)
        except OSError:pass

def read_trusted_config(fd):
    st=os.fstat(fd)
    if fd<3 or not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_size>65536:raise SystemExit(64)
    with os.fdopen(fd,'rb') as stream:return json.load(stream)

def main(argv=None):
    config_fd,descriptors=parse_arguments(sys.argv if argv is None else argv)
    try:
        config=read_trusted_config(config_fd)
        ports=runtime_ports_from_descriptors(config,descriptors)
    finally:close_descriptors(descriptors)  # exactly once, success or failure
    try:service=ToolService(config,host_query_ports=ports)
    except BaseException:
        for port in ports.values():port.close()
        raise
    try:
        service.start();print(canonical({'ready':True,'fullGuestExecutionEnabled':False}),flush=True)
        while sys.stdin.buffer.read(1):pass
    finally:
        if not service.close():raise SystemExit(78)
if __name__=='__main__':main()

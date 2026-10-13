#!/usr/bin/env python3
"""Reviewed disposable Linux fresh SDK-engine fixture; no VM, release or cold-resume claim.
Only a root-reviewed matching source/artifact receipt can reach privileged staging.
Guest provider packet parsing belongs to the separate fixture worker, not this root harness.
"""
from contextlib import contextmanager
import argparse,array,fcntl,hashlib,importlib.util,json,os,re,shutil,socket,select,stat,struct,subprocess,sys,tempfile,threading,time
from pathlib import Path
def require_staged_imports():
    # Ordinary portable tests may import definitions as an unprivileged process.
    # Direct CLI/elevated project imports require the isolated, hash-admitted parent.
    if __name__!='__main__' and os.geteuid()!=0:return
    admission=getattr(sys,'_winter_host_query_stage_admission',None)
    refusal='hash-admitted immutable staged runner required before imports'
    if admission is None or sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:raise SystemExit(refusal)
    directory=Path(admission.directory)
    if directory.parent!=Path('/tmp') or not directory.name.startswith('winter-host-query-reviewed-') or admission.pid!=os.getpid() or Path(__file__)!=directory/'source/scripts/guest-host-query/verify.py':raise SystemExit(refusal)
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
            fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=folder);info=os.fstat(fd)
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
    checked('source/scripts/guest-host-query/verify.py',admission.verify_sha,16*1024*1024)
    checked('source/scripts/guest-host-query/stage.py',admission.parent_sha,16*1024*1024)
    checked('artifacts/receipt.json',admission.receipt_sha,16*1024*1024)
require_staged_imports()

import ast
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
build=load('host_query_build',Path(__file__).with_name('build.py'))
HELPERS=('checked','stage_environment','MountIsolationError','parse_mountinfo','mount_private','relevant_mounts','runtime_mount_proof','KernelMountReader','MountIsolationOracle','BoundedCapture','normalized_stderr','failure_metadata','native_status_observation','runtime_diagnostic_observation','snapshot_runtime_diagnostic','provider_receipt_observation')
def stable_helpers():
    # Exact accepted source definitions after COMPLETE staged source/dependency/artifact admission.
    # No old privileged entry/import guard is weakened; its top-level imports/entry never execute.
    source=ROOT/'scripts/guest-engine/verify.py';tree=ast.parse(source.read_text())
    definitions=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in HELPERS]
    if {node.name for node in definitions}!=set(HELPERS):raise ValueError('accepted helper definition closure')
    namespace=dict(globals());namespace.update(MOUNTINFO_BYTES=1024*1024,MOUNTINFO_RECORDS=8192,MOUNT_ERROR_CODES=frozenset(('mountinfo_limit','mountinfo_invalid','outer_namespace_changed','outer_mounts_changed','runtime_dead','runtime_pid_changed','runtime_namespace_changed','runtime_mounts_missing','runtime_mount_flags','runtime_propagation','proc_read_failed','oracle_phase','oracle_deadline')))
    exec(compile(ast.Module(body=definitions,type_ignores=[]),str(source),'exec'),namespace)
    return namespace
CASES=('ask-allow','ask-deny','plan','bypass');RUNTIME_UID=20001;TOOL_UID=10001;GROUP=10000;PROVIDER_UID=30001;HOST_UID=40001
BACKENDS={kind:f'01234567-89ab-4cde-8fab-0123456789a{index}' for index,kind in enumerate(CASES)}
def backend(kind):return BACKENDS[kind]
def snapshot(path,limit=8*1024*1024):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>limit:raise ValueError('fixture evidence identity')
        wire=os.pread(fd,limit+1,0);after=os.fstat(fd)
        if len(wire)!=before.st_size or len(wire)>limit or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('fixture evidence changed')
        return wire
    finally:os.close(fd)
def require_dac_identity(uid,gid,groups):
    if uid!=TOOL_UID or gid!=TOOL_UID or list(groups)!=[GROUP]:raise AssertionError('DAC tool identity mismatch')
def dac_writable_control(source):
    # Fixed fixture child BEFORE service threads, not a guest/native-owner substitute.
    # It proves the same backing source accepts a write under the actual tool UID/GID.
    pid=os.fork()
    if pid==0:
        try:
            os.setgroups([GROUP]);os.setgid(TOOL_UID);os.setuid(TOOL_UID)
            require_dac_identity(os.getuid(),os.getgid(),os.getgroups())
            fd=os.open(source/'dac-control',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
            try:
                if os.write(fd,b'DAC-writable\n')!=13:os._exit(61)
            finally:os.close(fd)
            os._exit(0)
        except BaseException:os._exit(62)
    waited,status=os.waitpid(pid,0)
    code=os.waitstatus_to_exitcode(status)
    if waited!=pid or code!=0 or snapshot(source/'dac-control')!=b'DAC-writable\n':
        failure=AssertionError('same source DAC positive control');failure.dacExitCode=code;raise failure
def effect_oracle(kind,source):
    if snapshot(source/'dac-control')!=b'DAC-writable\n':raise AssertionError('DAC control changed')
    if snapshot(source/'seed')!=b'hello\n':raise AssertionError('source sentinel changed')
    expected=kind in ('ask-allow','bypass')
    for name,value in (('approved-write',b'approved\n'),):
        if expected:
            if snapshot(source/name)!=value:raise AssertionError('allowed source bytes missing')
        elif (source/name).exists():raise AssertionError('denied source effect')
    if set(path.name for path in source.iterdir())!={'seed','dac-control','store-probe','credential-probe',*(['approved-write'] if expected else [])}:raise AssertionError('unexpected source effect')
    return {'sourceSentinelUnchanged':True,'allowedSourceBytes':expected,'noDeniedSourceEffects':not expected}
def transcript_oracle(kind,store,host_record):
    records=[];states=[];identity=backend(kind)
    for path in store.rglob('*.jsonl'):
        wire=snapshot(path)
        if b'DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET' in wire:raise AssertionError('fixture credential leak')
        parsed=[json.loads(line) for line in wire.decode().splitlines()]
        if path.name==identity+'.jsonl':records=parsed
        if path.name==identity+'.provider-state.jsonl':states=parsed
    expected=6 if kind=='bypass' else 3;calls={};results={};anchors=[]
    for record in records:
        if record.get('sessionId')!=identity:raise AssertionError('transcript scope')
        content=record.get('message',{}).get('content',[])
        for block in content if isinstance(content,list) else []:
            if record.get('type')=='assistant' and block.get('type')=='tool_use':
                key=f'call-{len(calls)}'
                if block.get('id')!=key or key in calls or not isinstance(record.get('uuid'),str):raise AssertionError('tool call binding')
                calls[key]=block;anchors.append(record['uuid'])
            if record.get('type')=='user' and block.get('type')=='tool_result':
                key=block.get('tool_use_id')
                if key not in calls or key in results or key!=f'call-{len(results)}':raise AssertionError('tool result binding')
                results[key]=block
            if record.get('type')=='assistant' and block.get('type')=='text' and block.get('text')==f'host-query-{kind}-complete':anchors.append(record['uuid'])
    if len(calls)!=expected or len(results)!=expected or len(set(anchors))!=expected+1:raise AssertionError('tool/native-state history count')
    for index in range(expected):
        result=results[f'call-{index}'];denied=kind=='ask-deny' and index in (1,2);outside=kind=='bypass' and index>=3 or kind=='plan' and index==1
        if bool(result.get('is_error'))!=outside or bool(result.get('denied'))!=denied:raise AssertionError('tool result error class')
        content=result.get('content')
        if index==0:
            if content!='hello\n':raise AssertionError('Read exact seed bytes')
        if kind=='plan' and index==1 and str(content)!='Error [read_only]: guest file operation refused':raise AssertionError('native plan file authority')
        if kind=='plan' and index==2 and ('Read-only file system' not in str(content) or 'host-query-boundary-ok' not in str(content) or not str(content).endswith('[Exit code: 0; cwd changes apply to this command only]')):raise AssertionError('native plan readonly mount')
        if index==2 and kind in ('ask-allow','bypass') and 'host-query-boundary-ok' not in str(content):raise AssertionError('Bash boundary did not run')
    state_ids=set()
    for row in states:
        if row.get('type')!='winter_provider_state' or row.get('sessionId')!=identity or row.get('anchorUuid') not in anchors or row.get('kind') not in ('origin','native-state','effort','tool-epoch','tool-changes') or row.get('provider')!='openai' or row.get('model')!='openai/gpt-5.6' or not isinstance(row.get('uuid'),str) or row['uuid'] in state_ids or row['uuid'] in anchors:raise AssertionError('sidecar ancillary scope/identity')
        state_ids.add(row['uuid'])
    native=[row for row in states if row.get('kind')=='native-state']
    if len(native)!=expected+1:raise AssertionError('provider continuation count')
    for index,(row,anchor) in enumerate(zip(native,anchors)):
        expected_row={'type':'winter_provider_state','sessionId':identity,'anchorUuid':anchor,'provider':'openai','model':'openai/gpt-5.6','family':'openai','continuationDomain':'openai/gpt-5.6','itemIndex':1,'kind':'native-state','payload':{'items':[{'type':'reasoning','id':f'reasoning-{index}','encrypted_content':'fixture-native-state'}]}}
        if any(row.get(key)!=value for key,value in expected_row.items()) or not isinstance(row.get('uuid'),str) or not row['uuid'] or not isinstance(row.get('timestamp'),str) or not row['timestamp']:raise AssertionError('native state anchor/content')
    actual_script=[{'name':calls[f'call-{index}']['name'],'input':calls[f'call-{index}']['input']} for index in range(expected)]
    if hashlib.sha256(json.dumps(actual_script,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()!=host_record['scriptSha256']:raise AssertionError('persisted tool inputs differ from actual host oracle')
    return {'exactReadBytes':True,'toolCalls':expected,'toolResults':expected,'nativeStateAnchors':len(native)}
def spawn_fixed(binary,args,descriptors,uid):
    # Before all service/listener/runtime threads start. No Popen preexec from a threaded Root.
    copies=[fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,64) for fd in descriptors];fillers=[]
    try:
        for target in range(3,3+len(copies)):
            try:os.fstat(target)
            except OSError:
                fd=os.open('/dev/null',os.O_RDONLY|os.O_CLOEXEC);fillers.append(fd)
                if fd!=target:raise AssertionError('fixed FD collision')
        def identity():
            for source,target in zip(copies,range(3,3+len(copies))):os.dup2(source,target,inheritable=True)
            if uid==HOST_UID:
                for fd in (3,4,5,7,8):os.set_blocking(fd,True)
            for fd in copies:os.close(fd)
            os.setgroups([]);os.setgid(uid);os.setuid(uid)
        return subprocess.Popen([str(binary),*args],preexec_fn=identity,pass_fds=tuple([*copies,*range(3,3+len(copies))]),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True,env={'LANG':'C','LC_ALL':'C','HOME':'/nonexistent'},start_new_session=True)
    finally:
        for fd in (*copies,*fillers):os.close(fd)

FAILURE_REASONS = {'Bash boundary did not run': 'bash_boundary_did_not_run', 'DAC control changed': 'dac_control_changed', 'DAC tool identity mismatch': 'dac_tool_identity_mismatch', 'Read exact seed bytes': 'read_exact_seed_bytes', 'actual SDK/provider receipt': 'actual_sdk_provider_receipt', 'allowed source bytes missing': 'allowed_source_bytes_missing', 'artifact changed': 'artifact_changed', 'backing canary changed': 'backing_canary_changed', 'backing canary controls': 'backing_canary_controls', 'bounded process drain': 'bounded_process_drain', 'denied source effect': 'denied_source_effect', 'fixed FD collision': 'fixed_fd_collision', 'fixed cancellation protocol': 'fixed_cancellation_protocol', 'fixture credential leak': 'fixture_credential_leak', 'host/provider reap': 'host_provider_reap', 'native ownership retained': 'native_ownership_retained', 'native plan file authority': 'native_plan_file_authority', 'native plan readonly mount': 'native_plan_readonly_mount', 'native state anchor/content': 'native_state_anchor_content', 'native/reap/drain conjunction': 'native_reap_drain_conjunction', 'persisted tool inputs differ from actual host oracle': 'persisted_tool_inputs_differ_from_actual_host_oracle', 'protected SDK state owner/mode': 'protected_sdk_state_owner_mode', 'provider continuation count': 'provider_continuation_count', 'provider owner handoff': 'provider_owner_handoff', 'runtime completion deadline': 'runtime_completion_deadline', 'runtime owner handoff deadline': 'runtime_owner_handoff_deadline', 'runtime owner unavailable': 'runtime_owner_unavailable', 'same source DAC positive control': 'same_source_dac_positive_control', 'service/store ownership retained': 'service_store_ownership_retained', 'sidecar ancillary scope/identity': 'sidecar_ancillary_scope_identity', 'source sentinel changed': 'source_sentinel_changed', 'tool call binding': 'tool_call_binding', 'tool result binding': 'tool_result_binding', 'tool result error class': 'tool_result_error_class', 'tool/native-state history count': 'tool_native_state_history_count', 'transcript scope': 'transcript_scope', 'unexpected source effect': 'unexpected_source_effect'}
SERVICE_FAILURE_CODES = frozenset(('admin_request', 'admission_ticket_unavailable', 'admitted_policy', 'admitted_root', 'artifact_changed', 'artifact_digest', 'artifact_identity', 'artifact_pin', 'authority_denied', 'authority_revoked', 'cancelled_effects', 'capacity_busy', 'capture_limit', 'channel_closed', 'control_directory', 'conversation_limit', 'conversation_mapping', 'frame_deadline', 'frame_limit', 'host_query_policy', 'host_query_roots', 'host_query_tools', 'host_query_transport', 'identity_collision', 'init_admission_lost', 'invalid_authority', 'invalid_payload', 'invalid_request', 'isolated_interpreter_required', 'namespace_cleanup_unconfirmed', 'native_exit_unconfirmed', 'native_receipt_invalid', 'overlapping_roots', 'payload_limit', 'peer_identity', 'private_group_collision', 'protected_linux_root_required', 'protected_root', 'protected_source_overlap', 'request_already_admitted', 'request_shape', 'response_limit', 'runtime_admission', 'runtime_artifacts', 'runtime_bootstrap_limit', 'runtime_bootstrap_send', 'runtime_capture_limit', 'runtime_cleanup_unconfirmed', 'runtime_config', 'runtime_deadline', 'runtime_directory_identity', 'runtime_duplex_alias', 'runtime_duplex_changed', 'runtime_duplex_closed', 'runtime_duplex_descriptor', 'runtime_duplex_frame_limit', 'runtime_duplex_input_closed', 'runtime_duplex_input_truncated', 'runtime_duplex_input_unavailable', 'runtime_duplex_output_truncated', 'runtime_duplex_scope', 'runtime_duplex_write_failed', 'runtime_fresh_only', 'runtime_fresh_store_required', 'runtime_model', 'runtime_native_exit_unconfirmed', 'runtime_native_receipt', 'runtime_owner_handoff', 'runtime_owner_unavailable', 'runtime_parent_reap_unconfirmed', 'runtime_profile_conflict', 'runtime_provider', 'runtime_provider_limit', 'runtime_provider_private', 'runtime_provider_scope', 'runtime_store_in_use', 'runtime_tool_debt', 'runtime_tool_drain_unconfirmed', 'source_alias', 'source_changed', 'source_path', 'stale_guest_boot', 'workspace_scope'))
def diagnostic_failure(error,helper):
    raw=helper['failure_metadata'](error)
    name=raw.get('class')
    record={'class':name if name in ('AssertionError','ValueError','TypeError','KeyError','RuntimeError','OSError','PermissionError','FileNotFoundError','FileExistsError','BrokenPipeError','TimeoutExpired','JSONDecodeError','Refusal','Uncertain','MountIsolationError') else 'Exception'}
    if type(raw.get('errno')) is int and 0<=raw['errno']<=4095:record['errno']=raw['errno']
    if type(error) is AssertionError and len(error.args)==1 and type(error.args[0]) is str and error.args[0] in FAILURE_REASONS:record['reason']=FAILURE_REASONS[error.args[0]]
    if record.get('reason')=='same_source_dac_positive_control' and type(getattr(error,'dacExitCode',None)) is int and -255<=error.dacExitCode<=255:record['dacExitCode']=error.dacExitCode
    code=raw.get('code')
    if name in ('Refusal','Uncertain') and len(error.args)==1 and type(error.args[0]) is str and error.args[0] in SERVICE_FAILURE_CODES:code=error.args[0]
    if type(code) is str and (code in SERVICE_FAILURE_CODES or code in helper['MOUNT_ERROR_CODES']):record['code']=code
    return record
def failure_observation(service,logical,captures,errors,processes,root,helper):
    result={'nativeStatusAvailable':False,'processes':{}}
    if service is not None:
        try:
            with service.lock:
                runtime=service.runtimes.get(logical,{})
                result['nativeStatus']=helper['native_status_observation']({'runtime':runtime,'active':len(service.active),'uncertain':bool(service.debt)})
                result['nativeStatusAvailable']=True;result['logicalDebtObserved']=logical in service.debt
                result['logicalActiveObserved']=any(item[0]==logical for item in service.active.values())
        except Exception as error:result['nativeStatusReadFailure']=diagnostic_failure(error,helper)
    for index,(label,process) in enumerate(zip(('host','provider'),processes)):
        item={'started':process is not None,'exitCode':None}
        if process is not None:
            try:
                code=process.poll();item['exitCode']=code if type(code) is int and -255<=code<=255 else None
                item['exitObserved']=code is not None
            except Exception as error:item['exitReadFailure']=diagnostic_failure(error,helper)
        if index<len(captures):
            item['stdout']=captures[index].metadata()
            wire=bytes(captures[index].data[:65536])
            if label=='provider':
                try:item['receipt']=helper['provider_receipt_observation'](wire)
                except Exception as error:item['receiptReadFailure']=diagnostic_failure(error,helper)
            else:
                try:
                    value=json.loads(wire);item['receipt']={'parsed':type(value) is dict}
                    if type(value) is dict:
                        item['receipt'].update(passed=value.get('passed') is True)
                        for key in ('callbacks','requests','responses','messages','toolCalls','toolResults'):
                            if type(value.get(key)) is int and 0<=value[key]<=256:item['receipt'][key]=value[key]
                        failure=value.get('failure')
                        if type(failure) is dict and type(failure.get('code')) is str and failure['code'] in HOST_FAILURE_CODES:
                            item['receipt']['failure']={'code':failure['code']}
                            if failure.get('class') in ('Error','TypeError','RangeError','SyntaxError','NonError','CLIConnectionError','ProcessError','ProtocolDecodeError','ResultError','AbortError'):item['receipt']['failure']['class']=failure['class']
                            if failure.get('errnoCode') in ('EBADF','EPIPE','EIO','EINVAL','ENOENT','ETIMEDOUT','EINTR'):item['receipt']['failure']['errnoCode']=failure['errnoCode']
                            if failure.get('class') in ('ProcessError','ResultError'):
                                if 'processCode' in failure and (failure['processCode'] is None or type(failure['processCode']) is int and 0<=failure['processCode']<=255):item['receipt']['failure']['processCode']=failure['processCode']
                                if 'signal' in failure and (failure['signal'] is None or failure['signal'] in HOST_SIGNALS):item['receipt']['failure']['signal']=failure['signal']
                            if failure.get('class')=='ResultError' and failure.get('resultSubtype') in ('success','error_max_turns','error_during_execution','error_max_budget_usd','error_max_structured_output_retries'):item['receipt']['failure']['resultSubtype']=failure['resultSubtype']
                except (ValueError,TypeError,RecursionError):item['receipt']={'parsed':False}
        if index<len(errors):item['stderr']=errors[index].metadata()
        result['processes'][label]=item
    try:helper['snapshot_runtime_diagnostic']({'control':root/'control'},result)
    except Exception as error:result['runtimeDiagnosticReadFailure']=diagnostic_failure(error,helper)
    return result
HOST_SIGNALS=('SIGABRT','SIGALRM','SIGBUS','SIGCHLD','SIGCONT','SIGFPE','SIGHUP','SIGILL','SIGINT','SIGIO','SIGIOT','SIGKILL','SIGPIPE','SIGPOLL','SIGPROF','SIGPWR','SIGQUIT','SIGSEGV','SIGSTKFLT','SIGSTOP','SIGSYS','SIGTERM','SIGTRAP','SIGTSTP','SIGTTIN','SIGTTOU','SIGURG','SIGUSR1','SIGUSR2','SIGVTALRM','SIGWINCH','SIGXCPU','SIGXFSZ')
HOST_FAILURE_CODES=frozenset(('fixture_case','bypass_callback','approval_binding','tool_call','tool_result','tool_status','read_bytes','plan_write','plan_bash','bash_output','missing_results','pipe_bound','input_closed','input_frame','control_correlation','output_frame','observation_bound','control_route','permission_binding','output_truncated','lifecycle_bound','lifecycle_unavailable','lifecycle_code','callback_binding','input_truncated','teardown_failed','approval_result','host_failure'))
def print_failure_record(root,kind,phase,error,before,after,cleanup,helper):
    phases=('outer-baseline','artifacts','environment','dac-control','canaries','service-construct','metadata','listener','provider-spawn','host-spawn','service-start','launch','owner-handoff','oracle-during','provider-handoff','completion-loop','native-conjunction','close','flock','observer','reap','capture-drain','receipts','oracles','source-effects','persisted-history','mount-teardown','rmtree')
    phase=phase if phase in phases else 'unknown'
    retention=root.name if re.fullmatch(r'winter-host-query-run-[a-zA-Z0-9_]{1,64}',root.name) else 'unknown'
    record={'version':1,'kind':'host-query-failure-diagnostic','passed':False,'case':kind,'phase':phase,'failure':diagnostic_failure(error,helper),'retentionId':retention,'retained':True,'ownershipReleased':False,'beforeCleanup':before,'afterCleanup':after,'cleanup':cleanup}
    try:record['retentionDirectoryObserved']=stat.S_ISDIR(root.lstat().st_mode)
    except FileNotFoundError:record['retentionDirectoryObserved']=False
    except OSError:record['retentionDirectoryObserved']=None
    wire=json.dumps(record,sort_keys=True,separators=(',',':')).encode()
    if len(wire)>32000:
        record.update(beforeCleanup={'omitted':True},afterCleanup={'omitted':True},diagnosticTruncated=True)
        wire=json.dumps(record,sort_keys=True,separators=(',',':')).encode()
    fd=folder=None
    try:
        folder=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);info=os.fstat(folder)
        if info.st_uid!=os.geteuid() or info.st_mode&0o022:raise ValueError('diagnostic directory identity')
        fd=os.open('fixture-diagnostic.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=folder)
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.geteuid():raise ValueError('diagnostic file identity')
        offset=0
        while offset<len(wire):
            count=os.write(fd,wire[offset:])
            if count<=0:raise OSError('diagnostic write')
            offset+=count
        os.fsync(fd)
    except (OSError,ValueError) as failure:record['diagnosticWriteFailure']=diagnostic_failure(failure,helper)
    finally:
        for descriptor in (fd,folder):
            if descriptor is not None:os.close(descriptor)
    print(json.dumps(record,sort_keys=True,separators=(',',':')),flush=True)
    return record

def run_case(kind,artifacts,receipt,helper):
    logical='host-query-'+kind;helper['LOGICAL']=logical
    root=Path(tempfile.mkdtemp(prefix='winter-host-query-run-',dir='/tmp'));root.chmod(0o711)
    service=host=provider=owner=None;all_fds=[];channels=[];observed={};captures=[];errors=[];phase='outer-baseline'
    oracle=helper['MountIsolationOracle'](str(root))
    try:
        oracle.before(observed);phase='artifacts'
        binary=root/'bin';binary.mkdir(mode=0o755);control=root/'control';control.mkdir(mode=0o711);environment=root/'environment';environment.mkdir(mode=0o755);pins={}
        for name in (*build.NATIVE,*build.ENTRIES):
            target=binary/name;shutil.copyfile(artifacts/name,target);target.chmod(0o555)
            if build.digest(target)!=receipt['artifacts'][name]:raise AssertionError('artifact changed')
            pins[name]={'path':str(target),'sha256':receipt['artifacts'][name]}
        phase='environment'
        helper['stage_environment'](environment,['/bin/bash','/bin/sleep','/bin/cat','/usr/bin/setsid',binary/'runtimeEntry',binary/'ownerLibrary'])
        source=root/'source';source.mkdir(mode=0o2770);os.chown(source,TOOL_UID,GROUP);source.chmod(0o2770)
        (source/'seed').write_bytes(b'hello\n');os.chown(source/'seed',TOOL_UID,GROUP);(source/'seed').chmod(0o660)
        phase='dac-control';dac_writable_control(source)
        phase='canaries'
        (root/'host-only-credential').write_text('DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET');(root/'host-only-credential').chmod(0o444)
        canary_store=root/'protected-canary-store';canary_store.mkdir(mode=0o755)
        (canary_store/'canary').write_bytes(b'readable store canary\n');(canary_store/'canary').chmod(0o444)
        for folder in ('store','home'):
            (root/folder).mkdir(mode=0o700);os.chown(root/folder,RUNTIME_UID,RUNTIME_UID)
        (source/'store-probe').symlink_to(canary_store/'canary')
        (source/'credential-probe').symlink_to(root/'host-only-credential')
        if (source/'store-probe').resolve()!=canary_store/'canary' or snapshot(canary_store/'canary')!=b'readable store canary\n' or (source/'credential-probe').resolve()!=root/'host-only-credential':raise AssertionError('backing canary controls')
        boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        scope={'workspaceId':'workspace','sessionId':backend(kind),'incarnationId':'incarnation','leaseEpoch':1,'configRevision':1,'grantRevision':1,'policyRevision':1}
        selection={'providerId':'openai','modelKey':'openai/gpt-5.6','providerModelId':'gpt-5.6','family':'openai','protocol':'openai-responses','continuationDomain':'openai/gpt-5.6','capabilities':{'toolCalling':'native','readableState':'summary'}}
        route={'scope':{'homeId':'fixture-home','workspaceId':'workspace','sessionId':logical,'backendSessionId':backend(kind),'taskId':'task','incarnationId':'incarnation','bootId':boot,'leaseEpoch':1,'grantRevision':1,'accountRevision':1,'modelRevision':1},'selection':selection}
        conversation={'authority':scope,'logicalSessionId':logical,'runtimeUid':RUNTIME_UID,'toolUid':TOOL_UID,'workspaceGid':GROUP,'policy':'bypass' if kind=='bypass' else 'plan' if kind=='plan' else 'ask','roots':[{'id':'source','guestPath':'/workspace/folders/source','readOnly':False,'source':str(source)}],'hostQueryRuntime':{'storeDirectory':str(root/'store'),'runhomeDirectory':str(root/'home'),'provider':route,'model':selection['modelKey'],'toolClasses':['read','write','execute'],'timeoutMs':30000}}
        config={'guestBootId':boot,'protectedStoreDirectories':[str(root/'store'),str(root/'home'),str(canary_store)],'artifacts':{'launcher':pins['toolLauncher'],'fileWorker':pins['fileWorker'],'processWorker':pins['processWorker']},'hostQueryRuntime':{'artifacts':{'launcher':pins['runtimeLauncher'],'executable':pins['runtimeEntry'],'ownerLibrary':pins['ownerLibrary']}},'environment':str(environment),'controlDirectory':str(control),'conversations':[conversation]}
        pipes=[os.pipe2(os.O_CLOEXEC|os.O_NONBLOCK) for _ in range(5)];all_fds=[fd for pair in pipes for fd in pair]
        module=load('protected_fixture_service',ROOT/'packages/runtime/src/guest/linux-supervisor.py')
        phase='service-construct'
        ports=module.RuntimeDuplexPorts(logical,scope,pipes[0][0],pipes[1][1],pipes[2][1]);service=module.ToolService(config,host_query_ports={logical:ports})
        # Only the accepted relay duplicates retain these service ends. No hidden writer
        # may keep host stderr/stdout alive after actual service closure.
        for fd in (pipes[0][0],pipes[1][1],pipes[2][1]):os.close(fd);all_fds.remove(fd)
        phase='metadata'
        metadata=root/'host-metadata.json';metadata.write_text(json.dumps({'case':kind,'runtimeConfig':service._runtime_record(service.conversations[logical],service.runtimes[logical])['runtimeConfig']},sort_keys=True,separators=(',',':')));metadata.chmod(0o444)
        meta=os.open(metadata,os.O_RDONLY|os.O_CLOEXEC);all_fds.append(meta)
        phase='listener'
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);channels.append(listener);listener.bind(str(control/logical/'provider.sock'));os.chmod(control/logical/'provider.sock',0o660);os.chown(control/logical/'provider.sock',0,RUNTIME_UID);listener.listen(4)
        admission,worker=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);channels.extend((admission,worker))
        pmeta=root/'provider-metadata.json';pmeta.write_text(json.dumps({'case':kind,'runtimeUid':RUNTIME_UID,'provider':route},sort_keys=True,separators=(',',':')));pmeta.chmod(0o444)
        pm=os.open(pmeta,os.O_RDONLY|os.O_CLOEXEC);lib=os.open(binary/'ownerLibrary',os.O_RDONLY|os.O_CLOEXEC);all_fds.extend((pm,lib))
        phase='provider-spawn'
        provider=spawn_fixed(binary/'providerWorker',['--listener-fd','3','--admission-fd','4','--owner-library-fd','5','--metadata-fd','6'],[listener.fileno(),worker.fileno(),lib,pm],PROVIDER_UID)
        phase='host-spawn'
        host=spawn_fixed(binary/'hostClient',['--input-fd','3','--output-fd','4','--error-fd','5','--metadata-fd','6','--lifecycle-fd','7','--cancel-fd','8'],[pipes[0][1],pipes[1][0],pipes[2][0],meta,pipes[3][0],pipes[4][1]],HOST_UID)
        for fd in (pipes[0][1],pipes[1][0],pipes[2][0],pipes[3][0],pipes[4][1]):os.close(fd);all_fds.remove(fd)
        captures=[helper['BoundedCapture'](process.stdout,65536) for process in (host,provider)]
        errors=[helper['BoundedCapture'](process.stderr,16384,(root,)) for process in (host,provider)]
        phase='service-start';service.start()
        phase='launch';service.launch_runtime(logical)
        phase='owner-handoff'
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            with service.lock:
                runtime=service.runtimes[logical]
                if runtime['state']=='running':owner=os.dup(runtime['initPidfd']);break
                if runtime['state'] in ('stopped','retained'):raise AssertionError('runtime owner unavailable')
            time.sleep(.01)
        if owner is None:raise AssertionError('runtime owner handoff deadline')
        phase='oracle-during';oracle.during(owner,observed,time.monotonic()+2)
        phase='provider-handoff'
        if admission.sendmsg([b'I'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[owner]))])!=1:raise AssertionError('provider owner handoff')
        phase='completion-loop';deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            try:cancel=os.read(pipes[4][0],2)
            except BlockingIOError:cancel=None
            if cancel:
                if cancel!=b'K':raise AssertionError('fixed cancellation protocol')
                service.revoke(logical)
            with service.lock:
                state=service.runtimes[logical]['state']
                if state=='retained' or logical in service.debt:raise AssertionError('native ownership retained')
                if state=='stopped':break
            time.sleep(.01)
        else:raise AssertionError('runtime completion deadline')
        phase='native-conjunction'
        with service.lock:
            runtime=service.runtimes[logical]
            if runtime['exitCode']!=0 or not runtime['cleanupConfirmed'] or service.active or service.debt:raise AssertionError('native/reap/drain conjunction')
        phase='close'
        if not service.close():raise AssertionError('service/store ownership retained')
        # Independent real native/reap/drain + actual FD/store-lock release precede observer.
        phase='flock'
        flock_fd=os.open(root/'store',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
        try:fcntl.flock(flock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(flock_fd)
        phase='observer'
        os.write(pipes[3][1],b'HQX1:0\n');os.close(pipes[3][1]);all_fds.remove(pipes[3][1])
        phase='reap'
        if host.wait(timeout=3)!=0 or provider.wait(timeout=3)!=0:raise AssertionError('host/provider reap')
        phase='capture-drain'
        for capture in (*captures,*errors):capture.finish()
        if any(not capture.metadata()['drainComplete'] or capture.metadata()['truncated'] for capture in (*captures,*errors)):raise AssertionError('bounded process drain')
        phase='receipts'
        host_record=json.loads(captures[0].data);provider_record=json.loads(captures[1].data)
        if host_record.get('passed') is not True or host_record.get('rootTeardownObserved') is not True or provider_record.get('passed') is not True:raise AssertionError('actual SDK/provider receipt')
        phase='oracles'
        if snapshot(canary_store/'canary')!=b'readable store canary\n' or snapshot(root/'host-only-credential')!=b'DISPOSABLE-HOST-CREDENTIAL-NOT-A-REAL-SECRET' or not (source/'store-probe').is_symlink() or not (source/'credential-probe').is_symlink():raise AssertionError('backing canary changed')
        for path in [root/'store',*list((root/'store').rglob('*.jsonl'))]:
            info=path.lstat()
            if info.st_uid!=RUNTIME_UID or info.st_mode&0o077:raise AssertionError('protected SDK state owner/mode')
        phase='source-effects';effects=effect_oracle(kind,source)
        phase='persisted-history';history=transcript_oracle(kind,root/'store',host_record)
        evidence={**effects,**history,'callbacks':host_record['callbacks'],'backingCanariesUnchanged':True,'sameBackingDacWriteControl':True,'nativeServiceClosed':True,'storeLockReleased':True,'hostProviderReaped':True}
        phase='mount-teardown';oracle.after(observed);evidence['mountIsolation']=observed
        for capture in (*captures,*errors):capture.stream.close()
        for channel in channels:channel.close()
        channels=[];os.close(owner);owner=None
        for fd in all_fds:os.close(fd)
        all_fds=[]
        phase='rmtree';shutil.rmtree(root) # Normal removal is an oracle; never unmount/ignore errors.
        return {'case':kind,'passed':True,'evidence':evidence}
    except BaseException as error:
        before=failure_observation(service,logical,captures,errors,(host,provider),root,helper)
        cleanup={'serviceCloseObserved':None,'hostWaitCompleted':False,'providerWaitCompleted':False}
        if service is not None:
            try:service.revoke(logical)
            except Exception as failure:cleanup['revokeFailure']=diagnostic_failure(failure,helper)
        for label,process in (('host',host),('provider',provider)):
            if process is not None:
                try:
                    if process.poll() is None:process.kill()
                    process.wait(timeout=2);cleanup[label+'WaitCompleted']=True
                except (OSError,subprocess.TimeoutExpired) as failure:cleanup[label+'CleanupFailure']=diagnostic_failure(failure,helper)
        if service is not None:
            try:cleanup['serviceCloseObserved']=service.close() is True
            except Exception as failure:cleanup['serviceCloseFailure']=diagnostic_failure(failure,helper)
        for capture in (*captures,*errors):capture.finish()
        after=failure_observation(service,logical,captures,errors,(host,provider),root,helper)
        print_failure_record(root,kind,phase,error,before,after,cleanup,helper)
        raise
    finally:
        if owner is not None:os.close(owner)
        for fd in all_fds:
            try:os.close(fd)
            except OSError:pass
        for channel in channels:channel.close()
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--artifacts',type=Path,required=True);parser.add_argument('--reviewed-receipt',type=Path,required=True);args=parser.parse_args()
    receipt=build.validate_receipt(build.provenance.json_read(args.reviewed_receipt),args.artifacts)
    if sys.platform!='linux' or os.geteuid()!=0:raise SystemExit('admitted disposable Root Linux fixture only')
    helper=stable_helpers()
    try:results=[run_case(kind,args.artifacts,receipt,helper) for kind in CASES]
    except BaseException:raise SystemExit(78) from None
    print(json.dumps({'passed':True,'cases':results,'productionGuestExecutionEnabled':False,'vmExecutionVerified':False},sort_keys=True))
if __name__=='__main__':main()

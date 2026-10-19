"""Source-only root-record and real-pipe adapter tests. Never start a service/native process."""
import fcntl,json,os,selectors,socket,struct,tempfile,threading,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock,patch
import test_fresh_protocol as fresh
service=fresh.service
AUTH={'workspaceId':'workspace','sessionId':'backend','incarnationId':'incarnation','leaseEpoch':1,'configRevision':2,'grantRevision':3,'policyRevision':4}
def item(policy='ask'):
    root=service.runtime_root_metadata({'id':'source','guestPath':'/workspace/folders/source','readOnly':False},policy,True)
    return {'logicalSessionId':'logical','runtimeUid':os.getuid(),'toolUid':10001,'workspaceGid':10000,'authority':dict(AUTH),'policy':policy,'revoked':False,'roots':{'source':{'root':root}}}
class Pipes:
    def __init__(self):
        self.temp=tempfile.TemporaryDirectory();self.ends=[]
        # Named disposable FIFOs give actual UID/nlink/inode metadata on both macOS and Linux;
        # anonymous macOS pipes have no persistent inode identity. Never a native owner stand-in.
        for index in range(6):
            path=Path(self.temp.name)/str(index);os.mkfifo(path,0o600)
            self.ends.extend((os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_CLOEXEC),os.open(path,os.O_WRONLY|os.O_NONBLOCK|os.O_CLOEXEC)))
        self.input,self.input_writer,self.output_reader,self.output,self.error_reader,self.error,self.child_input_reader,stdin,stdout,self.child_output,stderr,self.child_error=self.ends
        self.child=SimpleNamespace(stdin=os.fdopen(stdin,'wb',buffering=0),stdout=os.fdopen(stdout,'rb',buffering=0),stderr=os.fdopen(stderr,'rb',buffering=0))
        self.ports=service.RuntimeDuplexPorts('logical',AUTH,self.input,self.output,self.error)
    def relay(self):
        self.ports.bind(item());self.ports.claim(item());self.cancel=threading.Event();return service.RuntimeDuplexRelay(self.ports,self.child,self.cancel)
    def close(self):
        self.ports.close()
        for stream in (self.child.stdin,self.child.stdout,self.child.stderr):stream.close()
        for fd in self.ends:
            try:os.close(fd)
            except OSError:pass
        self.temp.cleanup()

def route(relay,selector,name):
    relay.sync(selector)
    key=next(key for key in selector.get_map().values() if key.data==('duplex',name))
    return relay.handle(key)

class HostQueryProducerTests(unittest.TestCase):
    def test_policy_and_source_tool_facts_derive_all_closed_sdk_modes(self):
        for policy,mode in [('auto','default'),('ask','default'),('plan','plan'),('accept-edits','default'),('dont-ask','default'),('bypass','default')]:
            current=item(policy);config=service.host_query_config(current,['read','write','execute'],'openai/fixture')
            self.assertEqual(config['permissionMode'],mode);self.assertEqual(config['tools'],['Read','Edit','Write','Bash']);self.assertEqual(config['allowedTools'],[])
            self.assertEqual(config['permissions'],{'disableBypassPermissionsMode':True});self.assertIs(config['allowDangerouslySkipPermissions'],False)
            self.assertEqual(config['cwd'],'/workspace/folders/source');self.assertEqual(config['storeHome'],'/workspace/.winter/conversations/logical')
            self.assertNotIn('resume',config);self.assertNotIn('env',config);self.assertNotIn('hooks',config)
        self.assertEqual(service.host_query_config(item(),['write'],'model')['tools'],['Write'])
        self.assertEqual(service.host_query_config(item(),[],'model')['tools'],[])
    def test_plan_metadata_matches_tool_service_descriptor_and_source_flags(self):
        root={'id':'source','guestPath':'/workspace/folders/source','readOnly':False}
        self.assertFalse(service.runtime_root_metadata(root,'plan',False)['readOnly']) # old fresh route unchanged
        self.assertTrue(service.runtime_root_metadata(root,'plan',True)['readOnly'])
        self.assertTrue(service.runtime_root_metadata({**root,'readOnly':True},'ask',True)['readOnly'])
        self.assertEqual(root['readOnly'],False)
        invalid=item('plan');invalid['roots']['source']['root']['readOnly']=False
        with self.assertRaisesRegex(service.Refusal,'host_query_roots'):service.host_query_config(invalid,['write'],'model')
    def test_closed_tools_and_bounded_first_slice_roots_refuse_before_transport(self):
        for classes in [['read','read'],['credentials'],['read',{}],None,'read']:
            with self.assertRaisesRegex(service.Refusal,'host_query_tools'):service.host_query_config(item(),classes,'model')
        invalid=item();invalid['roots']['source']['root']['guestPath']='/workspace/.winter/memory'
        with self.assertRaisesRegex(service.Refusal,'host_query_roots'):service.host_query_config(invalid,['read'],'model')
    def test_transport_binding_cannot_be_json_or_change_authority_or_reuse(self):
        pipes=Pipes()
        try:
            wrong=item();wrong['authority']['grantRevision']+=1
            with self.assertRaisesRegex(service.Refusal,'runtime_duplex_scope'):pipes.ports.bind(wrong)
            pipes.ports.bind(item())
            with self.assertRaisesRegex(service.Refusal,'runtime_duplex_scope'):pipes.ports.bind(item())
            self.assertNotEqual(pipes.ports.fds['input'],pipes.input)
        finally:pipes.close()
    def test_descriptor_access_alias_type_and_failure_cleanup_preserve_originals(self):
        pipes=Pipes();original_flags={fd:fcntl.fcntl(fd,fcntl.F_GETFL) for fd in pipes.ends};held=list(pipes.ports.fds.values())
        try:
            with self.assertRaisesRegex(service.Refusal,'runtime_duplex_alias'):service.RuntimeDuplexPorts('logical',AUTH,pipes.input,pipes.output,pipes.output)
            with self.assertRaisesRegex(service.Refusal,'runtime_duplex_descriptor'):service.RuntimeDuplexPorts('logical',AUTH,pipes.input_writer,pipes.output,pipes.error)
            with tempfile.TemporaryFile() as regular:
                with self.assertRaisesRegex(service.Refusal,'runtime_duplex_descriptor'):service.RuntimeDuplexPorts('logical',AUTH,regular.fileno(),pipes.output,pipes.error)
            allocated=[];original=service.fcntl.fcntl
            def capture(fd,operation,*args):
                result=original(fd,operation,*args)
                if operation==fcntl.F_DUPFD_CLOEXEC:allocated.append(result)
                return result
            with patch.object(service.fcntl,'fcntl',side_effect=capture):
                with self.assertRaisesRegex(service.Refusal,'runtime_duplex_descriptor'):service.RuntimeDuplexPorts('logical',AUTH,pipes.input,pipes.input,pipes.error)
            for fd in allocated:
                with self.assertRaises(OSError):os.fstat(fd)
            pipes.ports.close()
            for fd in held:
                with self.assertRaises(OSError):os.fstat(fd)
            for fd,flags in original_flags.items():self.assertEqual(fcntl.fcntl(fd,fcntl.F_GETFL),flags)
        finally:pipes.close()
    def test_held_flags_and_link_identity_revalidate_without_touching_originals(self):
        pipes=Pipes()
        try:
            held=pipes.ports.fds['input'];os.set_inheritable(held,True)
            with self.assertRaisesRegex(service.Refusal,'runtime_duplex_changed'):pipes.ports.verify()
            os.set_inheritable(held,False);pipes.ports.verify()
            self.assertFalse(os.get_inheritable(pipes.input))
            os.unlink(Path(pipes.temp.name)/'0')
            with self.assertRaisesRegex(service.Refusal,'runtime_duplex_changed'):pipes.ports.verify()
        finally:pipes.close()
    def test_stale_closed_input_refuses_before_claim_and_originals_remain(self):
        pipes=Pipes()
        try:
            pipes.ports.bind(item());os.close(pipes.input_writer)
            with self.assertRaisesRegex(service.Refusal,'runtime_duplex_input_closed'):pipes.ports.claim(item())
            pipes.ports.close();self.assertTrue(os.fstat(pipes.input))
            with self.assertRaisesRegex(service.Refusal,'runtime_duplex_closed'):pipes.ports.claim(item())
        finally:pipes.close()

class DuplexRelayTests(unittest.TestCase):
    def setUp(self):self.pipes=Pipes();self.relay=self.pipes.relay();self.selector=selectors.DefaultSelector()
    def tearDown(self):self.selector.close();self.pipes.close()
    def test_fragmented_frames_partial_writes_and_permission_response_after_end_input(self):
        chunks=[b'{"type":"user","text":"go',b'"}\n{"type":"control_request","requestId":"end","subtype":"end_input"}\n',b'{"type":"control_response","requestId":"p","ok":true,"payload":{"behavior":"allow"}}\n']
        original=service.os.write
        for data in chunks:
            os.write(self.pipes.input_writer,data);route(self.relay,self.selector,'host-input')
            with patch.object(service.os,'write',side_effect=lambda fd,value:original(fd,value[:3])):
                while self.relay.buffers['input']:route(self.relay,self.selector,'child-input')
        captured=os.read(self.pipes.child_input_reader,65536)
        self.assertEqual(captured,b''.join(chunks));self.assertFalse(self.pipes.cancel.is_set());self.assertFalse(self.pipes.child.stdin.closed)
    def test_stdout_stderr_backpressure_bound_and_partial_output_writes(self):
        output=b'{"type":"data"}\n';error=b'bounded error\n'
        os.write(self.pipes.child_output,output);os.write(self.pipes.child_error,error)
        self.assertEqual(route(self.relay,self.selector,'child-stdout'),('stdout',output));route(self.relay,self.selector,'child-stderr')
        original=service.os.write
        with patch.object(service.os,'write',side_effect=lambda fd,value:original(fd,value[:2])):
            while self.relay.buffers['stdout']:route(self.relay,self.selector,'host-stdout')
            while self.relay.buffers['stderr']:route(self.relay,self.selector,'host-stderr')
        self.assertEqual(os.read(self.pipes.output_reader,65536),output);self.assertEqual(os.read(self.pipes.error_reader,65536),error)
        self.relay.buffers['input']=bytearray(service.DUPLEX_QUEUE);self.relay.buffers['stdout']=bytearray(service.DUPLEX_QUEUE);self.relay.buffers['stderr']=bytearray(service.DUPLEX_STDERR_QUEUE)
        with patch.object(service.time,'monotonic',return_value=time.monotonic()+3):self.relay.sync(self.selector)
        routes={key.data[1] for key in self.selector.get_map().values()}
        self.assertNotIn('host-input',routes);self.assertNotIn('child-stdout',routes);self.assertNotIn('child-stderr',routes)
        self.assertEqual(len(self.relay.buffers['stdout']),service.DUPLEX_QUEUE);self.assertEqual(len(self.relay.buffers['stderr']),service.DUPLEX_STDERR_QUEUE)
    def test_paused_consumer_over_two_seconds_preserves_bounds_then_resumes(self):
        receipt_read,receipt_write=os.pipe()
        try:
            self.selector.register(receipt_read,selectors.EVENT_READ,'native-control')
            self.relay.buffers['stdout'].extend(b'{"type":"init"}\n')
            with patch.object(service.time,'monotonic',return_value=time.monotonic()+3):self.relay.sync(self.selector)
            self.assertIn(receipt_read,self.selector.get_map());self.assertFalse(self.pipes.cancel.is_set())
            route(self.relay,self.selector,'host-stdout')
            self.assertEqual(os.read(self.pipes.output_reader,65536),b'{"type":"init"}\n');self.assertFalse(self.relay.buffers['stdout'])
        finally:self.selector.unregister(receipt_read);os.close(receipt_read);os.close(receipt_write)
    def test_clean_physical_eof_drains_queued_partial_writes_before_closing_stdin(self):
        data=b'{"type":"user","text":"go"}\n';os.write(self.pipes.input_writer,data);route(self.relay,self.selector,'host-input')
        original=service.os.write
        with patch.object(service.os,'write',side_effect=lambda fd,value:original(fd,value[:3])):route(self.relay,self.selector,'child-input')
        os.close(self.pipes.input_writer);route(self.relay,self.selector,'host-input')
        self.assertFalse(self.pipes.cancel.is_set());self.assertFalse(self.relay.terminal);self.assertFalse(self.pipes.child.stdin.closed)
        self.assertTrue(self.relay.buffers['input'])
        with patch.object(service.os,'write',side_effect=lambda fd,value:original(fd,value[:3])):
            while self.relay.buffers['input']:route(self.relay,self.selector,'child-input')
        self.assertEqual(os.read(self.pipes.child_input_reader,65536),data);self.assertEqual(os.read(self.pipes.child_input_reader,65536),b'')
        self.assertTrue(self.pipes.child.stdin.closed);self.assertFalse(self.pipes.cancel.is_set());self.assertFalse(self.relay.terminal)
    def test_truncated_input_eof_remains_an_error(self):
        os.write(self.pipes.input_writer,b'{"type":');route(self.relay,self.selector,'host-input');os.close(self.pipes.input_writer)
        with self.assertRaisesRegex(service.Uncertain,'runtime_duplex_input_truncated'):route(self.relay,self.selector,'host-input')
        self.assertFalse(self.relay.terminal)
    def test_frame_bound_truncation_and_replaced_held_fd_refuse(self):
        self.relay._lines('input',b'x'*service.DUPLEX_FRAME)
        with self.assertRaisesRegex(service.Uncertain,'runtime_duplex_frame_limit'):self.relay._lines('input',b'x')
        os.write(self.pipes.child_output,b'partial');route(self.relay,self.selector,'child-stdout');os.close(self.pipes.child_output)
        with self.assertRaisesRegex(service.Uncertain,'runtime_duplex_output_truncated'):route(self.relay,self.selector,'child-stdout')
        original=self.pipes.ports.fds['input'];os.dup2(self.pipes.child_input_reader,original)
        with self.assertRaisesRegex(service.Refusal,'runtime_duplex_changed'):self.relay.sync(self.selector)
    def test_eintr_and_would_block_leave_queued_bytes_unchanged_for_next_poll(self):
        os.write(self.pipes.input_writer,b'{"type":"user","text":"go"}\n');route(self.relay,self.selector,'host-input')
        before=bytes(self.relay.buffers['input'])
        for error in (InterruptedError(),BlockingIOError()):
            with patch.object(service.os,'write',side_effect=error):self.assertIsNone(route(self.relay,self.selector,'child-input'))
            self.assertEqual(bytes(self.relay.buffers['input']),before)
        route(self.relay,self.selector,'child-input');self.assertEqual(os.read(self.pipes.child_input_reader,65536),before)
    def test_closed_output_consumer_fails_without_dropping_or_retrying_bytes(self):
        os.write(self.pipes.child_output,b'{"type":"init"}\n');route(self.relay,self.selector,'child-stdout');before=bytes(self.relay.buffers['stdout']);os.close(self.pipes.output_reader)
        with self.assertRaises(BrokenPipeError):route(self.relay,self.selector,'host-stdout')
        self.assertEqual(bytes(self.relay.buffers['stdout']),before);self.assertFalse(self.relay.terminal)
    def test_child_input_epipe_stops_intake_without_inventing_native_terminal_or_effects(self):
        os.write(self.pipes.input_writer,b'{"type":"user","text":"late"}\n');route(self.relay,self.selector,'host-input');self.relay.sync(self.selector)
        stale=next(key for key in self.selector.get_map().values() if key.data==('duplex','child-input'))
        os.close(self.pipes.child_input_reader);self.relay.handle(stale)
        self.assertFalse(self.relay.buffers['input']);self.assertTrue(self.relay.eof['input']);self.assertTrue(self.pipes.child.stdin.closed)
        self.assertFalse(self.relay.terminal);self.assertFalse(self.pipes.cancel.is_set());self.assertIsNone(self.relay.handle(stale))
        self.relay.sync(self.selector);self.assertNotIn('host-input',{key.data[1] for key in self.selector.get_map().values()})
    def test_other_child_input_write_errors_remain_uncertain(self):
        os.write(self.pipes.input_writer,b'{"type":"user","text":"go"}\n');route(self.relay,self.selector,'host-input')
        with patch.object(service.os,'write',side_effect=OSError(service.errno.EIO,'fixture write error')):
            with self.assertRaises(OSError):route(self.relay,self.selector,'child-input')
        self.assertTrue(self.relay.buffers['input']);self.assertFalse(self.relay.eof['input']);self.assertFalse(self.relay.terminal)
    def test_native_terminal_stops_input_and_drains_outputs_with_stale_events_harmless(self):
        os.write(self.pipes.input_writer,b'{"type":"user","text":"go"}\n');route(self.relay,self.selector,'host-input');self.relay.sync(self.selector)
        stale=next(key for key in self.selector.get_map().values() if key.data==('duplex','child-input'))
        self.relay.native_terminal();self.assertIsNone(self.relay.handle(stale));self.assertTrue(self.relay.terminal)
        for name,fd in [('stdout',self.pipes.child_output),('stderr',self.pipes.child_error)]:os.close(fd);route(self.relay,self.selector,'child-'+name)
        self.relay.sync(self.selector);self.assertEqual(len(self.selector.get_map()),0)


class ConfiguredHostRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fresh.FreshProtocolTests();self.fixture.setUp();self.pipes=Pipes()
        self.obj=self.fixture.obj;self.obj.directory=self.fixture.root;(self.obj.directory/'logical').mkdir()
        self.obj.host_query_ports={'logical':self.pipes.ports};self.obj.runtime_pins={'fixture':'test-pin'};self.fixture.item['roots']['source']['fd']=-9;self.fixture.item.update(policy='ask',authority=dict(AUTH))
        self.fixture.provider['scope']['grantRevision']=AUTH['grantRevision']
        self.config={**self.fixture.config,'toolClasses':['read','write','execute']}
    def tearDown(self):self.pipes.close();self.fixture.tearDown()
    def configure(self):
        self.obj._configure_runtime(self.fixture.item,self.config,profile='host-query-v1')
        return self.obj.runtimes['logical']
    def test_root_config_supplies_only_profile_source_facts_and_uses_unchanged_native_record_abi(self):
        runtime=self.configure();record=self.obj._runtime_record(self.fixture.item,runtime)
        self.assertEqual(record['profile'],'host-query-v1');self.assertEqual(record['protocolVersion'],1);self.assertTrue(record['freshOnly'])
        self.assertEqual(record['runtimeConfig']['allowedTools'],[]);self.assertEqual(record['runtimeConfig']['tools'],['Read','Edit','Write','Bash'])
        self.assertEqual(record['authority'],AUTH);self.assertEqual(record['roots'],[self.fixture.item['roots']['source']['root']])
        self.config['toolClasses'].clear();self.assertEqual(runtime['hostConfig']['tools'],['Read','Edit','Write','Bash'])
    def test_existing_fresh_record_and_transport_choice_are_unchanged(self):
        self.obj._configure_runtime(self.fixture.item,self.fixture.config)
        record=self.obj._runtime_record(self.fixture.item,self.obj.runtimes['logical'])
        self.assertNotIn('profile',record);self.assertEqual(record['runtimeConfig']['permissionMode'],'default');self.assertEqual(record['runtimeConfig']['allowedTools'],['Read','Write','Edit','Bash'])
        self.assertNotIn('duplex',self.obj.runtimes['logical']);self.assertEqual(self.pipes.ports.phase,'new')
    def test_json_or_missing_transport_and_arbitrary_config_surfaces_refuse_before_store_open(self):
        self.obj.host_query_ports={'logical':{'inputFd':self.pipes.input,'profile':'host-query-v1'}}
        with self.assertRaisesRegex(service.Refusal,'host_query_transport'):self.configure()
        self.assertEqual(self.obj.owned,[])
        self.obj.host_query_ports={'logical':self.pipes.ports}
        for key in ('argv','env','settings','profile','runtimeConfig','resume'):
            with self.assertRaisesRegex(service.Refusal,'runtime_config'):self.obj._configure_runtime(self.fixture.item,{**self.config,key:{}},profile='host-query-v1')
        self.assertEqual(self.obj.owned,[]);self.assertEqual(self.pipes.ports.phase,'new')
    def test_startup_failure_closes_transport_duplicates_without_store_release_or_native_claim(self):
        runtime=self.configure();duplicates=list(self.pipes.ports.fds.values())
        with patch.object(service,'verify_held_artifact',side_effect=service.Refusal('artifact_changed')),patch.object(service.subprocess,'Popen') as spawn:
            self.obj._run_runtime(self.fixture.item,runtime);spawn.assert_not_called()
        for fd in duplicates:
            with self.assertRaises(OSError):os.fstat(fd)
        self.assertTrue(os.fstat(self.pipes.input));self.assertTrue(os.fstat(runtime['fds']['storeDirectory']))
        self.assertEqual(runtime['state'],'retained');self.assertFalse(runtime['cleanupConfirmed']);self.assertIn('logical',self.obj.debt)
        diagnostic=json.loads((self.obj.directory/'logical'/'runtime-diagnostic.json').read_text())
        self.assertFalse(diagnostic['observations']['nativeReceiptObserved']);self.assertFalse(diagnostic['observations']['ownershipReleased'])
    def run_injected(self,parent_code=0,clean_eof=False,cancel_requested=False,backpressure_cancel=False,late_input=False):
        runtime=self.configure();self.obj.runtime_artifacts={'launcher':10,'executable':11,'ownerLibrary':12};self.obj.runtime_pins={name:'test-pin' for name in self.obj.runtime_artifacts};self.obj.environment=-1
        if clean_eof or late_input:
            os.write(self.pipes.input_writer,b'{"type":"user","text":"go"}\n')
            if clean_eof:os.close(self.pipes.input_writer)
        control,parent,bootstrap,guest=[MagicMock() for _ in range(4)]
        for fd,channel in enumerate((control,parent,bootstrap,guest),100):channel.fileno.return_value=fd
        control.recv.side_effect=[b'R'+struct.pack('=I',0),b''];bootstrap.sendmsg.side_effect=lambda buffers,*args:len(buffers[0])
        child=self.pipes.child;child.wait=MagicMock(return_value=parent_code);child.kill=MagicMock()
        stdout_fd,stderr_fd=child.stdout.fileno(),child.stderr.fileno()
        stdout_payload=b'{"type":"init"}\n'+(b'{"type":"data","message":{"type":"result","subtype":"success"}}\n' if late_input else b'')
        chunks={stdout_fd:iter([stdout_payload,b'']),stderr_fd:iter([b'bounded stderr\n',b''])};original_read=service.os.read;original_close=service.os.close
        def read(fd,count):return next(chunks[fd],b'') if fd in chunks else original_read(fd,count)
        def event(fd,route):return SimpleNamespace(fd=fd,fileobj=fd,data=('duplex',route))
        selector=MagicMock();selector.get_map.side_effect=[True,True,True,False]
        selector.select.side_effect=[[(event(stdout_fd,'child-stdout'),1),(event(stderr_fd,'child-stderr'),1)],[(SimpleNamespace(fileobj=control,data=None),1),(event(self.pipes.ports.fds['stdout'],'host-stdout'),2),(event(self.pipes.ports.fds['stderr'],'host-stderr'),2),(event(stdout_fd,'child-stdout'),1),(event(stderr_fd,'child-stderr'),1)],[(SimpleNamespace(fileobj=control,data=None),1)]]
        if clean_eof or late_input:
            selector.get_map.side_effect=[True,True,True,True,False]
            rows=list(selector.select.side_effect)
            rows.insert(0,[(event(child.stdin.fileno(),'child-input'),2)] if late_input else [(event(self.pipes.ports.fds['input'],'host-input'),1),(event(child.stdin.fileno(),'child-input'),2)])
            selector.select.side_effect=rows
        original_write=service.os.write
        child_input_fd=child.stdin.fileno()
        def write(fd,data):
            if late_input and fd==child_input_fd:raise BrokenPipeError(service.errno.EPIPE,'fixture runtime input reader closed')
            return original_write(fd,data)
        original_sync=service.RuntimeDuplexRelay.sync
        def sync(relay,selected):
            if backpressure_cancel:
                relay.buffers['stdout']=bytearray(service.DUPLEX_QUEUE);runtime['cancel'].set()
            original_sync(relay,selected)
        if backpressure_cancel:selector.select.side_effect=BrokenPipeError(32,'fixture consumer closed')
        def admitted(_):
            if cancel_requested:runtime['cancel'].set()
            return 600
        with patch.object(service,'verify_held_artifact'),patch.object(service.socket,'socketpair',side_effect=[(control,parent),(bootstrap,guest)]),patch.object(service.subprocess,'Popen',return_value=child) as spawn,patch.object(service,'receive_init_pidfd',side_effect=admitted),patch.object(service.os,'pidfd_open',return_value=700,create=True),patch.object(service.selectors,'DefaultSelector',return_value=selector),patch.object(service.RuntimeDuplexRelay,'sync',new=sync),patch.object(service.os,'read',side_effect=read),patch.object(service.os,'write',side_effect=write),patch.object(service.os,'close',side_effect=lambda fd:None if fd in (600,700) else original_close(fd)),patch.object(service.signal,'pidfd_send_signal',create=True) as kill:
            self.obj._run_runtime(self.fixture.item,runtime)
        if backpressure_cancel:
            kill.assert_any_call(600,service.signal.SIGKILL)
            observed=json.loads((self.obj.directory/'logical'/'runtime-diagnostic.json').read_text())['observations']
            return runtime,observed
        if cancel_requested:kill.assert_any_call(600,service.signal.SIGKILL)
        elif parent_code==0:kill.assert_not_called()
        self.assertEqual(spawn.call_args.kwargs['stdin'],service.subprocess.PIPE)
        root=self.fixture.item['roots']['source']['root']
        self.assertEqual(spawn.call_args.args[0][-3:],['-9',root['guestPath'],'1' if root['readOnly'] else '0'])
        self.assertEqual(os.read(self.pipes.output_reader,65536),stdout_payload);self.assertEqual(os.read(self.pipes.error_reader,65536),b'bounded stderr\n')
        observed=json.loads((self.obj.directory/'logical'/'runtime-diagnostic.json').read_text())['observations']
        self.assertFalse(observed['ownershipReleased']);self.assertTrue(os.fstat(runtime['fds']['storeDirectory']))
        return runtime,observed
    def test_actual_run_loop_injected_process_relays_and_keeps_receipt_reap_drain_conjunction(self):
        runtime,observed=self.run_injected()
        self.assertEqual(runtime['state'],'stopped');self.assertTrue(runtime['cleanupConfirmed']);self.assertNotIn('logical',self.obj.debt)
        for key in ('nativeReceiptObserved','parentReaped','toolDrainConfirmed','nativeCleanupConfirmed'):self.assertTrue(observed[key])
    def test_normal_eof_after_queued_input_reaches_injected_receipt_reap_cleanup_without_sigkill(self):
        runtime,observed=self.run_injected(clean_eof=True)
        self.assertEqual(runtime['state'],'stopped');self.assertEqual(runtime['exitCode'],0);self.assertTrue(observed['nativeCleanupConfirmed'])
        self.assertEqual(os.read(self.pipes.child_input_reader,65536),b'{"type":"user","text":"go"}\n')
    def test_late_input_epipe_preserves_output_and_native_receipt_reap_without_sigkill(self):
        runtime,observed=self.run_injected(late_input=True)
        self.assertEqual(runtime['state'],'stopped');self.assertEqual(runtime['exitCode'],0);self.assertTrue(observed['nativeReceiptObserved']);self.assertTrue(observed['nativeCleanupConfirmed']);self.assertFalse(observed['ownershipReleased'])
        self.assertFalse(runtime['duplex'].fds) # only transport handles closed, not store hold
    def test_explicit_cancellation_still_targets_injected_native_descriptor_promptly(self):
        runtime,observed=self.run_injected(cancel_requested=True)
        # Signal call only is asserted above; injected status is not native stop/effect authority.
        self.assertTrue(observed['parentReaped'])
    def test_explicit_cancel_with_full_output_queue_still_signals_and_retains_unconfirmed_cleanup(self):
        runtime,observed=self.run_injected(backpressure_cancel=True)
        self.assertEqual(runtime['state'],'retained');self.assertIn('logical',self.obj.debt);self.assertFalse(observed['nativeCleanupConfirmed']);self.assertFalse(observed['ownershipReleased'])
    def test_effective_plan_record_tool_descriptor_and_native_argv_agree(self):
        self.fixture.item['policy']='plan'
        self.fixture.item['roots']['source']['root']=service.runtime_root_metadata(self.fixture.item['roots']['source']['root'],'plan',True)
        runtime,observed=self.run_injected()
        record=self.obj._runtime_record(self.fixture.item,runtime)
        self.assertTrue(record['roots'][0]['readOnly']);self.assertEqual(record['runtimeConfig']['permissionMode'],'plan');self.assertTrue(record['runtimeConfig']['permissions']['disableBypassPermissionsMode'])
    def test_reap_mismatch_after_duplex_output_does_not_release_native_ownership(self):
        runtime,observed=self.run_injected(parent_code=7)
        self.assertEqual(runtime['state'],'retained');self.assertFalse(runtime['cleanupConfirmed']);self.assertIn('logical',self.obj.debt)
        self.assertTrue(observed['nativeReceiptObserved']);self.assertTrue(observed['parentReaped']);self.assertFalse(observed['nativeCleanupConfirmed'])

if __name__=='__main__':unittest.main()

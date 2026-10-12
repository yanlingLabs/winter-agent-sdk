"""Real socket/descriptor checks; no privileged service or Linux confinement claim."""
import array,importlib.util,json,os,socket,struct,sys,tempfile,threading,time,unittest,warnings
from pathlib import Path
from unittest.mock import patch
MODULE=Path(__file__).resolve().parents[2]/'packages/runtime/src/guest/linux-supervisor.py'
spec=importlib.util.spec_from_file_location('protected_tool_service',MODULE);service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
class ProtocolTests(unittest.TestCase):
    def test_fixed_authority_copies_all_revisions_and_rejects_extra_identity(self):
        original={'workspaceId':'workspace','sessionId':'session','incarnationId':'boot','leaseEpoch':1,'configRevision':2,'grantRevision':3,'policyRevision':4}
        snapshot=service.authority(original);original['grantRevision']=999;self.assertEqual(snapshot['grantRevision'],3)
        for invalid in [{**snapshot,'modelRoot':'/'},{**snapshot,'sessionId':'../other'},{**snapshot,'leaseEpoch':True}]:
            with self.assertRaises(service.Refusal):service.authority(invalid)
    def test_bounded_framing_roundtrip_and_oversize_reject_before_body_read(self):
        left,right=socket.socketpair()
        try:
            service.frame_write(left,{'key':'雪'});self.assertEqual(service.frame_read(right),{'key':'雪'})
            left.sendall(struct.pack('!I',service.FRAME_LIMIT+1))
            with self.assertRaises(service.Refusal):service.frame_read(right)
        finally:left.close();right.close()
    def test_trickle_has_one_header_and_body_deadline_and_restores_timeout(self):
        left,right=socket.socketpair();right.settimeout(7);stop=threading.Event()
        wire=struct.pack('!I',11)+b'{"ok":true}'
        def trickle():
            try:
                for byte in wire:
                    left.sendall(bytes([byte]))
                    if stop.wait(.03):break
            except OSError:pass
        producer=threading.Thread(target=trickle);producer.start();start=time.monotonic()
        try:
            with self.assertRaisesRegex(service.Refusal,'frame_deadline'):service.frame_read(right,timeout=.2)
            self.assertLess(time.monotonic()-start,.6);self.assertEqual(right.gettimeout(),7)
        finally:stop.set();producer.join(1);left.close();right.close()
    def test_fragmented_frame_inside_deadline_succeeds(self):
        left,right=socket.socketpair();wire=struct.pack('!I',11)+b'{"ok":true}'
        def fragments():
            for chunk in (wire[:2],wire[2:6],wire[6:]):left.sendall(chunk);time.sleep(.01)
        producer=threading.Thread(target=fragments);producer.start()
        try:self.assertEqual(service.frame_read(right,timeout=.5),{'ok':True})
        finally:producer.join(1);left.close();right.close()
    def test_admin_status_and_revoke_survive_eight_busy_tool_connections(self):
        obj=service.ToolService.__new__(service.ToolService);obj.lock=threading.RLock();obj.stop_event=threading.Event();obj.listeners=[];obj.threads=[];obj.owned=[];obj.debt=set()
        obj.tool_connections=threading.BoundedSemaphore(8);obj.admin_connections=threading.BoundedSemaphore(2)
        cancels=[threading.Event() for _ in range(8)];obj.active={('logical',str(i)):('logical',cancel) for i,cancel in enumerate(cancels)};obj.conversations={'logical':{'revoked':False}}
        release=threading.Event();busy=threading.Condition();entered=[];clients=[]
        def hold(channel):
            with busy:entered.append(channel);busy.notify_all()
            release.wait(2)
        with tempfile.TemporaryDirectory(prefix='tool-sockets-') as tmp,patch.object(service,'peer_uid',return_value=0),patch.object(service.os,'chown'):
            root=Path(tmp);obj._listener(root/'tools',0,hold);obj._listener(root/'admin',0,obj._admin,admin=True)
            try:
                for _ in range(8):
                    client=socket.socket(socket.AF_UNIX);client.connect(str(root/'tools'));clients.append(client)
                with busy:self.assertTrue(busy.wait_for(lambda:len(entered)==8,timeout=1))
                ninth=socket.socket(socket.AF_UNIX);ninth.settimeout(1);ninth.connect(str(root/'tools'));clients.append(ninth);self.assertEqual(ninth.recv(1),b'')
                def admin(operation):
                    with socket.socket(socket.AF_UNIX) as channel:
                        channel.connect(str(root/'admin'));service.frame_write(channel,{'operation':operation,'sessionId':'logical'});return service.frame_read(channel,timeout=1)
                self.assertEqual(admin('status'),{'active':8,'uncertain':False});self.assertEqual(admin('revoke'),{'revoked':True});self.assertTrue(all(event.is_set() for event in cancels))
                self.assertEqual(len(entered),8)
                # Reserved capacity is itself bounded, never an unlimited thread pool.
                self.assertTrue(obj.admin_connections.acquire(timeout=1));self.assertTrue(obj.admin_connections.acquire(timeout=1));self.assertFalse(obj.admin_connections.acquire(False));obj.admin_connections.release();obj.admin_connections.release()
            finally:
                release.set()
                for client in clients:client.close()
                self.assertTrue(obj.close())
    def test_source_ancestor_swap_and_leaf_alias_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();allowed=root/'allowed';allowed.mkdir();(allowed/'nested').mkdir();protected=root/'protected';protected.mkdir();(protected/'nested').mkdir();source=allowed/'nested';original_open=service.os.open;swapped=False
            def swapping_open(path,*args,**kwargs):
                nonlocal swapped
                if path=='/' and not swapped:
                    swapped=True;allowed.rename(root/'original');allowed.symlink_to(protected,target_is_directory=True)
                return original_open(path,*args,**kwargs)
            with patch.object(service.os,'open',side_effect=swapping_open):
                with self.assertRaises(OSError):service.source_directory(source,[protected])
            with self.assertRaisesRegex(service.Refusal,'source_alias'):service.source_directory(source,[protected])
            with self.assertRaisesRegex(service.Refusal,'protected_source_overlap'):service.source_directory(protected/'nested',[protected])
            fd=service.source_directory(root/'original'/'nested',[protected])
            try:self.assertEqual(os.fstat(fd).st_ino,(root/'original'/'nested').stat().st_ino)
            finally:os.close(fd)
    def test_source_replacement_after_check_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();source=root/'source';source.mkdir();original_open=service.os.open;swapped=False
            def replacing_open(path,*args,**kwargs):
                nonlocal swapped
                if path=='/' and not swapped:swapped=True;source.rename(root/'old');source.mkdir()
                return original_open(path,*args,**kwargs)
            with patch.object(service.os,'open',side_effect=replacing_open):
                with self.assertRaisesRegex(service.Refusal,'source_changed'):service.source_directory(source,[])
    def test_received_descriptors_owned_before_malformed_envelope_refusal(self):
        for marker,count in ((b'X',1),(b'I',2)):
            with self.subTest(marker=marker,count=count):
                left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);read_fd,write_fd=os.pipe();received=[]
                class Captured:
                    def recvmsg(self,*args):
                        result=right.recvmsg(*args)
                        for level,kind,data in result[1]:
                            if (level,kind)==(socket.SOL_SOCKET,socket.SCM_RIGHTS):received.extend(array.array('i',data))
                        return result
                try:
                    left.sendmsg([marker],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[read_fd]*count))])
                    with self.assertRaisesRegex(service.Uncertain,'init_admission_lost'):service.receive_init_pidfd(Captured())
                    self.assertTrue(received)
                    for fd in received:
                        with self.assertRaises(OSError):os.fstat(fd)
                finally:left.close();right.close();os.close(read_fd);os.close(write_fd)
    @unittest.skipUnless(sys.platform=='linux','Linux truncation semantics; never install undisclosed macOS FDs')
    def test_truncated_linux_ancillary_preserves_complete_fd_set(self):
        def snapshot():
            result={}
            for name in os.listdir('/proc/self/fd'):
                try:fd=int(name);st=os.fstat(fd)
                except OSError:continue # The transient directory enumeration FD is closed.
                result[fd]=(st.st_dev,st.st_ino,st.st_mode)
            return result
        left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);read_fd,write_fd=os.pipe();flags_seen=[];received=[]
        class Captured:
            def recvmsg(self,*args):
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore',RuntimeWarning) # Intentional target-Linux truncation.
                    result=right.recvmsg(*args)
                flags_seen.append(result[2])
                for level,kind,data in result[1]:
                    if (level,kind)==(socket.SOL_SOCKET,socket.SCM_RIGHTS):received.extend(array.array('i',data))
                return result
        try:
            before=snapshot()
            left.sendmsg([b'I'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[read_fd]*20))])
            with self.assertRaisesRegex(service.Uncertain,'init_admission_lost'):service.receive_init_pidfd(Captured())
            self.assertTrue(flags_seen[0]&socket.MSG_CTRUNC);self.assertTrue(received);self.assertLess(len(received),20)
            # Compare all installed FDs while original endpoints remain open, so
            # neither undisclosed descriptors nor FD-number reuse can hide leaks.
            self.assertEqual(snapshot(),before)
        finally:left.close();right.close();os.close(read_fd);os.close(write_fd)
    def test_valid_descriptor_transfers_single_noninheritable_owner(self):
        left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);read_fd,write_fd=os.pipe()
        try:
            left.sendmsg([b'I'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[read_fd]))]);owned=service.receive_init_pidfd(right)
            try:self.assertEqual(os.fstat(owned).st_ino,os.fstat(read_fd).st_ino);self.assertFalse(os.get_inheritable(owned))
            finally:os.close(owned)
        finally:left.close();right.close();os.close(read_fd);os.close(write_fd)
    def test_no_privileged_service_fallback_off_linux(self):
        if __import__('sys').platform!='linux':
            with self.assertRaisesRegex(service.Refusal,'protected_linux_root_required'):service.ToolService({})
if __name__=='__main__':unittest.main()

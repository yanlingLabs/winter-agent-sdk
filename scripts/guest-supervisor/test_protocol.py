"""Platform-neutral protocol checks. They do not prove Linux OS enforcement."""
import importlib.util,json,socket,struct,unittest
from pathlib import Path
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
    def test_no_privileged_service_fallback_off_linux(self):
        if __import__('sys').platform!='linux':
            with self.assertRaisesRegex(service.Refusal,'protected_linux_root_required'):service.ToolService({})
if __name__=='__main__':unittest.main()

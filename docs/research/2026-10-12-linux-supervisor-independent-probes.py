import argparse,subprocess,tempfile,importlib.util,os,socket,struct,threading,time,json,fcntl,io,array
from pathlib import Path
from unittest.mock import patch
parser=argparse.ArgumentParser();parser.add_argument('--sdk-checkout',type=Path,required=True);args=parser.parse_args();repo=args.sdk_checkout;source=subprocess.check_output(['git','-C',str(repo),'show','30bb3f18:packages/runtime/src/guest/linux-supervisor.py'],text=True)
receipt={'sourceCommit':'30bb3f18','linuxServiceStarted':False,'privilegedCodeExecuted':False,'vmStarted':False}
with tempfile.TemporaryDirectory(prefix='winter-supervisor-review-') as temp:
 root=Path(temp);path=root/'supervisor.py';path.write_text(source);spec=importlib.util.spec_from_file_location('review_supervisor',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 a,b=socket.socketpair();b.settimeout(3);wire=struct.pack('!I',len(b'{"ok":true}'))+b'{"ok":true}'
 def trickle():
  for byte in wire:a.send(bytes([byte]));time.sleep(.25)
 t=threading.Thread(target=trickle);t.start();start=time.monotonic();value=m.frame_read(b);elapsed=time.monotonic()-start;t.join();a.close();b.close();assert value=={'ok':True} and elapsed>3
 receipt['trickle']={'socketTimeoutSeconds':3,'wholeFrameSeconds':round(elapsed,3),'acceptedAfterTimeoutBudget':True}
 class Conn:
  closed=False
  def close(self):self.closed=True
 c=Conn()
 class Server:
  def bind(self,*a):pass
  def listen(self,*a):pass
  def settimeout(self,*a):pass
  def accept(self):
   if hasattr(self,'used'):raise OSError('done')
   self.used=True;return c,None
 srv=Server();service=m.ToolService.__new__(m.ToolService);service.stop_event=threading.Event();service.connections=threading.BoundedSemaphore(8);service.lock=threading.RLock();service.listeners=[];service.threads=[]
 for _ in range(8):assert service.connections.acquire(False)
 calls=[]
 with patch.object(m.socket,'socket',return_value=srv),patch.object(m.os,'chmod'),patch.object(m.os,'chown'):
  service._listener('/unused-review-admin.sock',0,lambda ch:calls.append('admin'))
  for th in service.threads:th.join(1)
 assert c.closed and not calls;receipt['adminSaturation']={'ordinarySlotsHeld':8,'adminConnectionClosed':True,'adminHandlerInvoked':False,'actualListenerMethodWithMockSocket':True}
 allowed=root/'allowed';allowed.mkdir();(allowed/'nested').mkdir();protected=root/'protected';protected.mkdir();(protected/'nested').mkdir();spelling=allowed/'nested';checked=spelling.resolve(strict=True)
 assert not (checked==protected or checked in protected.parents or protected in checked.parents)
 allowed.rename(root/'old-allowed');allowed.symlink_to(protected,target_is_directory=True)
 fd=os.open(spelling,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  st=os.fstat(fd);target=(protected/'nested').stat();assert(st.st_dev,st.st_ino)==(target.st_dev,target.st_ino)
 finally:os.close(fd)
 receipt['sourceAncestorSwap']={'originalResolvedPathPassedProtectionCheck':True,'openedPinnedFdIsProtectedDirectory':True,'actualTempDirectorySyscalls':True}
 service=m.ToolService.__new__(m.ToolService);service.artifacts={'launcher':99,'fileWorker':98};service.artifact_pins={'launcher':'a','fileWorker':'b'};service.environment=97;service.directory=root;service.lock=threading.RLock();service.debt=set();service.retained_children=[]
 item={'logicalSessionId':'logical','toolUid':10001,'workspaceGid':10000,'policy':'auto','roots':{}};viewroot={'root':{'guestPath':'/workspace/repos/source'}}
 control,parent=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);rfd,wfd=os.pipe();received=[]
 class Control:
  def settimeout(self,t):control.settimeout(t)
  def recvmsg(self,*a):
   result=control.recvmsg(*a)
   for level,kind,data in result[1]:
    if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:received.extend(array.array('i',data))
   return result
  def close(self):control.close()
 class Child:
  def __init__(self):self.stdin=io.BytesIO();self.stdout=io.BytesIO();self.stderr=io.BytesIO()
  def kill(self):pass
  def wait(self,timeout):return 0
 def fake_launch(*args,**kwargs):parent.sendmsg([b'X'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[rfd]))]);return Child()
 with patch.object(m,'verify_held_artifact'),patch.object(m.socket,'socketpair',return_value=(Control(),parent)),patch.object(m.subprocess,'Popen',side_effect=fake_launch):
  try:service._run(item,'file','read',viewroot,'name',128,'-',b'',1,threading.Event(),None)
  except m.Uncertain as e:assert str(e)=='init_admission_lost'
 assert len(received)==1
 os.fstat(received[0]);assert 'logical' in service.debt
 receipt['malformedAncillary']={'actualReceivedFdLeaked':True,'newLeakedDescriptors':1,'exactRunMethodWithMockLauncher':True,'conversationDebtRetained':True}
 for fd in received+[rfd,wfd]:os.close(fd)
Path(__file__).with_suffix('.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))

// Compiled CI runtime-UID client: actual registry routes over the real Linux service.
import { createConnection } from "node:net";
import { createLinuxSupervisorSession } from "../../packages/runtime/src/guest/supervisor-client.ts";
import { buildRegistryToolExecutor, type RegistryToolExecutorDeps } from "../../packages/runtime/src/tools/registry.ts";
import "../../packages/runtime/src/tools/impl/index.ts";
if (process.argv.length !== 6) throw new Error("fixed fixture arguments required");
const endpoint=process.argv[2]!,sessionId=process.argv[3]!,uid=process.argv[4]!,scenario=process.argv[5]!;
const authority = { workspaceId:"workspace",sessionId,incarnationId:"boot",leaseEpoch:1,configRevision:1,grantRevision:1,policyRevision:1 };
const cwd="/workspace/folders/source", roots=[{id:"source",guestPath:cwd,readOnly:false},{id:"readonly",guestPath:"/workspace/folders/readonly",readOnly:true}];
const guest=createLinuxSupervisorSession({socketPath:endpoint,authority,roots,toolUid:Number(uid),maxBytes:1024*1024,maxOutputBytes:1024*1024});
const forbidden=()=>{throw new Error("runtime-side filesystem path must never be used");};
const deps:RegistryToolExecutorDeps={executionPosture:"confined-guest",guestFiles:guest,home:"/protected/runtime",sessionId,getCwd:()=>cwd,getTempDir:forbidden,readState:{recordRead:forbidden,lookup:forbidden},probeReadAccess:forbidden,emitFrame(){},sandboxSettings:{},session:{setCwd:forbidden,addBoundedRoot:forbidden,removeBoundedRoot:forbidden,setPermissionMode:forbidden,getBoundedRoots:()=>[],getPermissionMode:()=>"default",getSessionRoot:()=>cwd,setSessionRoot:forbidden}};
const executor=buildRegistryToolExecutor(deps);
const run=async(name:string,input:unknown)=>{const result=await executor.execute({id:crypto.randomUUID(),name,input});return result;};
const require=(condition:unknown,label:string)=>{if(!condition)throw new Error(label);};
const results:unknown[]=[];
if(scenario==="ordinary"){
 const read=await run("Read",{file_path:"seed"});
 require(read.output==="hello\n","actual Read: "+JSON.stringify(read));
 const parallel=await Promise.all(Array.from({length:10},()=>run("Read",{file_path:"seed"})));require(parallel.every(value=>!value.isError&&value.output==="hello\n"),"ten concurrent actual Reads: "+JSON.stringify(parallel));
 let buildsFinished=0; const buildAbort=new AbortController();
 const builds=[1,2].map(i=>guest.executeProcess!(`printf ready > parallel-build-${i}; while [ ! -e parallel-build-release ]; do sleep 0.02; done`,cwd,8000,buildAbort.signal).finally(()=>{buildsFinished++;}));
 try {
  for(let i=1;i<=2;i++){let started=false;for(let attempt=0;attempt<100;attempt++){try{await guest.read(`${cwd}/parallel-build-${i}`);started=true;break;}catch{await Bun.sleep(10);}}require(started,"parallel build started");}
  const during=await Promise.all(Array.from({length:10},()=>run("Read",{file_path:"seed"})));
  require(buildsFinished===0&&during.every(value=>!value.isError&&value.output==="hello\n"),"file reads remain available while two Bash processes run");
 } finally {
  try {await guest.write(`${cwd}/parallel-build-release`,new TextEncoder().encode("release"),"absent");const finished=await Promise.all(builds);require(finished.every(result=>result.exitCode===0&&result.termination==="exit"),"parallel builds exit after barrier release");} finally {buildAbort.abort();await Promise.allSettled(builds);}
 }
 require(!(await run("Edit",{file_path:"seed",old_string:"hello",new_string:"edited"})).isError,"actual Edit");
 require(!(await run("Write",{file_path:"seed",content:"written\n"})).isError,"actual Write");
 const shell=await run("Bash",{command:"printf shell > from-shell; printf '%s' \"$PWD\"; printf err >&2"});require(!shell.isError&&shell.output.includes(cwd)&&shell.output.includes("err"),"actual foreground Bash");
 const glibc=await run("Bash",{command:"/bin/glibc-tools"});require(!glibc.isError&&glibc.output.includes("glibc-thread-spawn-local-ipc-ok"),"glibc threads/spawn/local IPC: "+JSON.stringify(glibc));
 const bounded=await run("Bash",{command:"exit 7"});require(bounded.isError&&bounded.output.includes("Exit code: 7"),"shell nonzero receipt");
 require((await run("Read",{file_path:"escape"})).isError,"out-of-root symlink");
 // Process tools now have their own private procfs. It must describe only the
 // tool identity; the runtime, service, protected paths and host env stay hidden.
 const privateProc=await guest.executeProcess!(`set -e
test -r /proc/1/status && test -r /proc/self/status || exit 1
test ! -e /run && test ! -e /protected/runtime && test -z "$SECRET_SHOULD_NOT_TRAVEL" || exit 1
for status in /proc/[0-9]*/status; do
 uid_seen=0; nnp_seen=0; seccomp_seen=0; caps_seen=0
 while read -r key a b c d unused; do
  case "$key" in
   Uid:) test "$a" = "${Number(uid)}" && test "$b" = "$a" && test "$c" = "$a" && test "$d" = "$a" || exit 1; uid_seen=1;;
   CapInh:|CapPrm:|CapEff:|CapBnd:|CapAmb:) test "$a" = 0000000000000000; caps_seen=$((caps_seen+1));;
   NoNewPrivs:) test "$a" = 1; nnp_seen=1;;
   Seccomp:) test "$a" = 2; seccomp_seen=1;;
  esac
 done < "$status"
 test "$uid_seen:$nnp_seen:$seccomp_seen:$caps_seen" = 1:1:1:5
done
printf private-proc-only`,cwd,5000);
 require(privateProc.exitCode===0&&privateProc.termination==="exit"&&privateProc.stdout==="private-proc-only"&&privateProc.stderr==="","private tool proc and no runtime/env surface");
 require((await run("Write",{file_path:"/workspace/folders/readonly/new",content:"blocked"})).isError,"readonly file mount");
 const ro=await run("Bash",{command:"printf blocked > /workspace/folders/readonly/shell-write"});require(ro.isError&&ro.output.includes("Read-only file system"),"actual readonly mount errno");
 for(const name of ["Glob","Grep","NotebookEdit","Workflow","Monitor"])require((await run(name,{})).output.includes("guest_tool_unsupported"),"unsupported route");
 results.push("actual-read-edit-write-bash");
}else if(scenario==="forged"){
 const response=await new Promise<any>((resolve,reject)=>{const socket=createConnection({path:endpoint});let received=Buffer.alloc(0);socket.on("error",reject);socket.on("connect",()=>{
  const body=Buffer.from(JSON.stringify({kind:"file",ticket:"unissued",request:{protocolVersion:1,requestId:crypto.randomUUID(),authority:{...authority,sessionId:"backend-2"},operation:"write",root:roots[0],relativePath:"forged-write",expectedUid:Number(uid),maxBytes:1024,dataBase64:Buffer.from("forbidden").toString("base64")}}));const frame=Buffer.alloc(body.length+4);frame.writeUInt32BE(body.length,0);body.copy(frame,4);socket.write(frame);
 });socket.on("data",incoming=>{const chunk=typeof incoming==="string"?Buffer.from(incoming):incoming;received=Buffer.concat([received,chunk]);if(received.length>=4&&received.length>=received.readUInt32BE(0)+4){socket.destroy();resolve(JSON.parse(received.subarray(4).toString()));}});});
 require(response.exitCode!==0&&JSON.parse(response.stdout).code==="authority_denied","runtime UID cannot select another scope");results.push("forged-scope-denied");
}else if(scenario==="plan"){
 await run("Read",{file_path:"seed"});require((await run("Write",{file_path:"seed",content:"forbidden"})).isError,"plan Write denied");
 const value=await run("Bash",{command:"printf forbidden > plan-shell"});require(!value.output.includes("Exit code: 0"),"plan Bash readonly");results.push("plan-kernel-readonly");
}else if(scenario==="writable-policy"){
 require(!(await run("Write",{file_path:`policy-${uid}`,content:"approved-runtime-write"})).isError,"approved non-plan policy native write");results.push("non-plan-native-write");
}else if(scenario==="cancel"||scenario==="revoke"){
 const abort=new AbortController();
 const command=guest.executeProcess!("setsid /bin/bash -c 'printf ready > cancellation-ready; sleep 1; printf escaped > cancellation-orphan' >/tmp/orphan 2>&1 & while [ ! -e cancellation-ready ]; do sleep 0.01; done; sleep 5",cwd,6000,abort.signal);void command.catch(()=>{});
 if(scenario==="cancel"){
  let observed=false;for(let i=0;i<100;i++){try{await guest.read(cwd+"/cancellation-ready");observed=true;break;}catch{await Bun.sleep(10);}}
  require(observed,"cancellation positive control never started");abort.abort();
 }
 try{await command;throw new Error("cancelled command returned success");}
 catch(error){require((error as {effectsUncertain?:boolean}).effectsUncertain,"cancel effect uncertainty");}
 results.push("cancelled-no-replay");
}else throw new Error("unknown fixed fixture scenario");
console.log(JSON.stringify({uid:process.getuid?.(),sessionId,scenario,checks:results}));

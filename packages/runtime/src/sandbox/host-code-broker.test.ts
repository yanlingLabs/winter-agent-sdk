import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_CODE_PROCESS_SUBTYPES as operations, type HostCodeProcessStart, type HostCodeProcessStartReply, type HostCodeProcessPollReply } from "@yanlinglabs/winter-agent-sdk";
import { createHostCodeProcessRegistration, type HostCodeCanonicalContext } from "./host-code-broker.ts";
import { installHostCodeProcessClient, type HostCodeProcessClient } from "./host-code-process.ts";
import { brokeredWorkflowWorker } from "../workflows/host-code-worker.ts";

const cleanup: Array<()=>void> = [];
afterEach(()=>{for(const dispose of cleanup.splice(0).reverse())dispose();});
function fixture(resolver?: (request:HostCodeProcessStart)=>Promise<HostCodeCanonicalContext>) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),"winter-code-broker-")));
  const control=join(dir,"control");mkdirSync(control);writeFileSync(join(control,"secret"),"protected");
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const context={signal:new AbortController().signal,callerSessionId:"parent",generationId:"generation"};
  const canonical=(request:HostCodeProcessStart):HostCodeCanonicalContext=>({scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},floor:{denyReadPaths:[control],denyWritePaths:[control]},commandOptions:{cwd:dir,env:{PATH:"/bin:/usr/bin",HOME:dir},settings:{enabled:false},timeoutMs:3000}});
  const registration=createHostCodeProcessRegistration({generationId:"generation",resolveCurrentContext:async(request)=>resolver?resolver(request):canonical(request)});
  cleanup.push(()=>registration.stopAll());
  const start=(extra:Partial<HostCodeProcessStart>={})=>({version:1 as const,generationId:"generation",sessionId:"child-session",toolUseId:"active-call",cwd:dir,kind:"command" as const,command:"printf output",timeoutMs:1000,maxStreamedBytes:65536,...extra});
  const poll=(handle:HostCodeProcessStartReply["handle"],afterSequence=0)=>registration.handle(operations.poll,{handle,afterSequence,maxBytes:65536,maxWaitMs:30000},context) as Promise<HostCodeProcessPollReply>;
  async function terminal(handle:HostCodeProcessStartReply["handle"]){let sequence=0;let output="";for(;;){const reply=await poll(handle,sequence);for(const event of reply.events){sequence=event.sequence;output+=Buffer.from(event.dataBase64,"base64").toString();}if(reply.exit)return{reply,sequence,output};}}
  return{dir,control,context,canonical,registration,start,poll,terminal};
}
describe.skipIf(process.platform!=="darwin")("trusted host Code broker, disposable native processes",()=>{
  test("final bytes replay until acknowledged, release is idempotent and stale handles cannot signal",async()=>{
    const f=fixture();const started=await f.registration.handle(operations.start,f.start(),f.context) as HostCodeProcessStartReply;
    const initial=await f.poll(started.handle,0);expect(initial.events).toHaveLength(1);
    expect((await f.poll(started.handle,0)).events).toEqual(initial.events);
    const final=await f.terminal(started.handle);expect(final.output).toBe("output");
    await expect(f.registration.handle(operations.release,{handle:started.handle,afterSequence:0},f.context)).rejects.toThrow("not acknowledged");
    const kill=spyOn(process,"kill");
    await f.registration.handle(operations.signal,{handle:started.handle,signal:"SIGKILL"},f.context);expect(kill).not.toHaveBeenCalled();kill.mockRestore();
    const release={handle:started.handle,afterSequence:final.sequence};
    await f.registration.handle(operations.release,release,f.context);await f.registration.handle(operations.release,release,f.context);
    await expect(f.registration.handle(operations.signal,{handle:started.handle,signal:"SIGKILL"},f.context)).rejects.toThrow("foreign");
    const second=await f.registration.handle(operations.start,f.start({toolUseId:"next-call"}),f.context) as HostCodeProcessStartReply;
    expect((await f.terminal(second.handle)).output).toBe("output");
  });
  test("serialized policy/env/approval, foreign caller and fabricated cursor are refused",async()=>{
    const f=fixture();
    for(const field of ["profile","env","approval","mandatoryFloor"]){await expect(f.registration.handle(operations.start,{...f.start(),[field]:{}},f.context)).rejects.toThrow("invalid");}
    const started=await f.registration.handle(operations.start,f.start(),f.context) as HostCodeProcessStartReply;
    await expect(f.poll(started.handle,999)).rejects.toThrow("invalid");
    await expect(f.registration.handle(operations.signal,{handle:started.handle,signal:"SIGTERM"},{...f.context,callerSessionId:"foreign"})).rejects.toThrow("foreign");
    await f.terminal(started.handle);
  });
  test("dispose during admission cannot start a command and closes later admission",async()=>{
    let admit!:(value:HostCodeCanonicalContext)=>void;
    const f=fixture(()=>new Promise(resolve=>{admit=resolve}));
    const request=f.start({command:`touch '${join(f.dir,"must-not-run")}'`});
    const pending=f.registration.handle(operations.start,request,f.context);f.registration.dispose!();admit(f.canonical(request));
    await expect(pending).rejects.toThrow("admission changed");
    await expect(f.registration.handle(operations.start,f.start(),f.context)).rejects.toThrow("closing");
  });
  test("Workflow stdio proxy uses immutable host worker and composed profile",async()=>{
    const f=fixture();
    const base=f.canonical(f.start());
    const workerScript=`import {readFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk.toString();process.stdout.write(input.trim());try{readFileSync(${JSON.stringify(join(f.control,"secret"))});process.exitCode=0}catch(error){console.error(error.message);process.exitCode=1}`;
    const registration=createHostCodeProcessRegistration({generationId:"generation",resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},workflow:{command:{file:process.execPath,args:["-e",workerScript]}}})});
    cleanup.push(()=>registration.stopAll());
    const client:HostCodeProcessClient={
      start:(request,signal)=>registration.handle(operations.start,request,{...f.context,...(signal?{signal}:{})}) as Promise<HostCodeProcessStartReply>,
      poll:(handle,afterSequence)=>registration.handle(operations.poll,{handle,afterSequence,maxBytes:65536,maxWaitMs:30000},f.context) as Promise<HostCodeProcessPollReply>,
      write:async payload=>{await registration.handle(operations.write,payload,f.context)},
      signal:async(handle,signal)=>{await registration.handle(operations.signal,{handle,signal},f.context)},
      release:async(handle,afterSequence)=>{await registration.handle(operations.release,{handle,afterSequence},f.context)},
    };
    cleanup.push(installHostCodeProcessClient({generationId:"generation",client}));
    const worker=brokeredWorkflowWorker({cwd:f.dir,runId:"run",scope:{sessionId:"child-session",toolUseId:"workflow-call"}});
    const exited=new Promise<number|null>((resolve,reject)=>{worker.onExit(resolve);worker.onError(reject)});let output="";worker.stdout.on("data",chunk=>{output+=chunk.toString()});
    worker.stdin.end("stdio-roundtrip\n");expect(await exited).not.toBe(0);expect(output,worker.lastStderrLine?.()).toBe("stdio-roundtrip");expect(worker.lastStderrLine?.()).toMatch(/operation not permitted|permission denied/i);
  });
  test("a nonreading Workflow admits one bounded write and refuses overlapping data/EOF",async()=>{
    const f=fixture();
    const base=f.canonical(f.start());
    const registration=createHostCodeProcessRegistration({generationId:"generation",resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},workflow:{command:{file:process.execPath,args:["-e","setInterval(()=>{},1000)"]}}})});
    cleanup.push(()=>registration.stopAll());
    const {command:_command,...request}=f.start({kind:"workflow",workflowRunId:"nonreader"});
    const {handle}=await registration.handle(operations.start,request,f.context) as HostCodeProcessStartReply;
    const dataBase64=Buffer.alloc(65536,65).toString("base64");
    let pending:Promise<unknown>|undefined;
    // Fill the OS pipe serially until one callback is blocked. There is no broker queue.
    for(let index=0;index<32;index++){
      const write=registration.handle(operations.write,{handle,dataBase64},f.context);
      const settled=await Promise.race([write.then(()=>true),new Promise<false>(resolve=>setTimeout(()=>resolve(false),10))]);
      if(!settled){pending=write;break;}
    }
    expect(pending).toBeDefined();
    const blocked=await Promise.allSettled(Array.from({length:64},(_,index)=>registration.handle(operations.write,index%2?{handle,dataBase64}:{handle,end:true},f.context)));
    expect(blocked.filter(result=>result.status==="fulfilled")).toHaveLength(0);
    for(const result of blocked)if(result.status==="rejected")expect(result.reason.message).toContain("overlapping");
    // Attach rejection observation before stopping the child; pending write must not ACK later.
    const final=pending!.then(()=>"ack",()=>"refused");registration.stopAll();expect(await final).toBe("refused");
    await expect(registration.handle(operations.write,{handle,dataBase64},f.context)).rejects.toThrow("unavailable");
  },10000);
  test("EOF is serial and every later write is refused without an ACK",async()=>{
    const f=fixture();const base=f.canonical(f.start());
    const registration=createHostCodeProcessRegistration({generationId:"generation",resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},workflow:{command:{file:process.execPath,args:["-e","let count=0;for await(const chunk of process.stdin)count+=chunk.length;console.log(count)"]}}})});cleanup.push(()=>registration.stopAll());
    const {command:_command,...request}=f.start({kind:"workflow",workflowRunId:"reader"});
    const {handle}=await registration.handle(operations.start,request,f.context) as HostCodeProcessStartReply;
    await registration.handle(operations.write,{handle,dataBase64:Buffer.from("payload").toString("base64")},f.context);
    await registration.handle(operations.write,{handle,end:true},f.context);
    const attempts=await Promise.allSettled([{handle,dataBase64:""},{handle,dataBase64:"YWJj"},{handle,end:true}].map(payload=>registration.handle(operations.write,payload,f.context)));
    expect(attempts.filter(result=>result.status==="fulfilled")).toHaveLength(0);
    let sequence=0,output="";for(;;){const reply=await registration.handle(operations.poll,{handle,afterSequence:sequence,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply;for(const event of reply.events){sequence=event.sequence;output+=Buffer.from(event.dataBase64,"base64").toString();}if(reply.exit){expect(reply.exit.code).toBe(0);break;}}
    expect(output).toBe("7\n");
  });
  test("aggregate output quota spans producers and acknowledgment/release free it",async()=>{
    const f=fixture();
    const registration=createHostCodeProcessRegistration({generationId:"generation",maxBufferedBytes:65536,resolveCurrentContext:async request=>f.canonical(request)});cleanup.push(()=>registration.stopAll());
    async function produce(id:string,bytes:number){
      const command=`'${process.execPath}' -e 'process.stdout.write("x".repeat(${bytes}))'`;
      const {handle}=await registration.handle(operations.start,f.start({command,toolUseId:id}),f.context) as HostCodeProcessStartReply;
      const deadline=Date.now()+2000;
      for(;;){
        const reply=await registration.handle(operations.poll,{handle,afterSequence:0,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply;
        if(reply.exit)return{handle,reply,sequence:reply.events.at(-1)?.sequence??0,bytes:reply.events.reduce((count,event)=>count+Buffer.from(event.dataBase64,"base64").length,0)};
        if(Date.now()>deadline)throw new Error("fixture producer did not exit");await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    const first=await produce("first",49152);expect(first.bytes).toBe(49152);expect(first.reply.exit?.streamKilled).toBe(false);
    const second=await produce("second",49152);expect(second.reply.exit?.streamKilled).toBe(true);expect(first.bytes+second.bytes).toBeLessThanOrEqual(65536);
    // Acknowledging the first producer's bytes frees global quota even before its release.
    await registration.handle(operations.poll,{handle:first.handle,afterSequence:first.sequence,maxBytes:65536,maxWaitMs:30000},f.context);
    const third=await produce("third",49152);expect(third.bytes).toBe(49152);expect(third.reply.exit?.streamKilled).toBe(false);
    // Release acknowledges and frees each terminal producer's retained bytes.
    for(const row of [first,second,third])await registration.handle(operations.release,{handle:row.handle,afterSequence:row.sequence},f.context);
    const fourth=await produce("fourth",65536);expect(fourth.bytes).toBe(65536);expect(fourth.reply.exit?.streamKilled).toBe(false);
  });
  test("drain confirms managed close events after stop, not a kill receipt",async()=>{
    const f=fixture();await f.registration.handle(operations.start,f.start({command:"sleep 30"}),f.context);
    let settled=false;void f.registration.drained.then(()=>{settled=true});await Promise.resolve();expect(settled).toBe(false);
    f.registration.stopAll();expect(await f.registration.drained).toEqual({status:"confirmed",generationId:"generation",coverage:"registered-process-close-only",confirmedProcessCount:1});
  });
  test("unconfirmed kill remains uncertain with its exact owned handle",async()=>{
    const f=fixture();const registration=createHostCodeProcessRegistration({generationId:"generation",drainTimeoutMs:10,resolveCurrentContext:async request=>f.canonical(request)});cleanup.push(()=>registration.stopAll());
    const {handle}=await registration.handle(operations.start,f.start({command:"sleep 30"}),f.context) as HostCodeProcessStartReply;
    const original=process.kill;const kill=spyOn(process,"kill").mockImplementation((pid,signal)=>pid===-handle.pid?true:original(pid,signal));
    try{registration.stopAll();expect(await registration.drained).toEqual({status:"uncertain",generationId:"generation",coverage:"registered-process-close-only",confirmedProcessCount:0,pendingHandles:[handle]});}finally{kill.mockRestore();await registration.handle(operations.signal,{handle,signal:"SIGKILL"},f.context);}
  });
});

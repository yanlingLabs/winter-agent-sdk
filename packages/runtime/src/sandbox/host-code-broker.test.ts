import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_CODE_PROCESS_SUBTYPES as operations, type HostCodeProcessStart, type HostCodeProcessStartReply, type HostCodeProcessPollReply } from "@yanlinglabs/winter-agent-sdk";
import { createHostCodeProcessRegistration, type HostCodeCanonicalContext } from "./host-code-broker.ts";
import { installHostCodeProcessClient, type HostCodeProcessClient } from "./host-code-process.ts";
import { brokeredWorkflowWorker } from "../workflows/host-code-worker.ts";
import { runCommand, runCommandLocally } from "./spawn.ts";
import { createFixtureHostOutput } from "./fixtures/host-output.ts";
import { startTracking, resetBackgroundTaskRuntimeForTest } from "../tools/impl/background-task-runtime.ts";
import { taskStopExecutor } from "../tools/impl/task-stop.ts";
import type { ToolExecutionContext } from "../tools/registry.ts";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";

const cleanup: Array<()=>void> = [];
afterEach(()=>{for(const dispose of cleanup.splice(0).reverse())dispose();});
function fixture(resolver?: (request:HostCodeProcessStart)=>Promise<HostCodeCanonicalContext>) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),"winter-code-broker-")));
  const control=join(dir,"control");mkdirSync(control);writeFileSync(join(control,"secret"),"protected");
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const context={signal:new AbortController().signal,callerSessionId:"parent",generationId:"generation"};
  const canonical=(request:HostCodeProcessStart):HostCodeCanonicalContext=>({scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},floor:{denyReadPaths:[control],denyWritePaths:[control]},commandOptions:{cwd:dir,env:{PATH:"/bin:/usr/bin",HOME:dir},settings:{enabled:false},timeoutMs:3000}});
  const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",resolveCurrentContext:async(request)=>resolver?resolver(request):canonical(request)});
  cleanup.push(()=>registration.stopAll());
  const start=(extra:Partial<HostCodeProcessStart>={})=>({version:1 as const,generationId:"generation",sessionId:"child-session",toolUseId:"active-call",cwd:dir,kind:"command" as const,command:"printf output",timeoutMs:1000,maxStreamedBytes:65536,...extra});
  const poll=(handle:HostCodeProcessStartReply["handle"],afterSequence=0)=>registration.handle(operations.poll,{handle,afterSequence,maxBytes:65536,maxWaitMs:30000},context) as Promise<HostCodeProcessPollReply>;
  async function terminal(handle:HostCodeProcessStartReply["handle"]){let sequence=0;let output="";for(;;){const reply=await poll(handle,sequence);for(const event of reply.events){sequence=event.sequence;output+=Buffer.from(event.dataBase64,"base64").toString();}if(reply.exit)return{reply,sequence,output};}}
  return{dir,control,context,canonical,registration,start,poll,terminal};
}
describe.skipIf(process.platform!=="darwin")("trusted host Code broker, disposable native processes",()=>{
  test("missing protected output capability refuses execution before side effects",async()=>{
    const f=fixture();const registration=createHostCodeProcessRegistration({generationId:"generation",resolveCurrentContext:async request=>f.canonical(request)});cleanup.push(()=>registration.stopAll());
    const marker=join(f.dir,"unbounded-must-not-run");
    await expect(registration.handle(operations.start,f.start({command:`touch '${marker}'`}),f.context)).rejects.toThrow("bounded host output transport unavailable");expect(existsSync(marker)).toBe(false);
  });
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
    const pending=f.registration.handle(operations.start,request,f.context);while(!admit)await new Promise(resolve=>setTimeout(resolve,0));f.registration.dispose!();admit(f.canonical(request));
    await expect(pending).rejects.toThrow("admission changed");
    await expect(f.registration.handle(operations.start,f.start(),f.context)).rejects.toThrow("closing");
  });
  test("Workflow stdio proxy uses immutable host worker and composed profile",async()=>{
    const f=fixture();
    const base=f.canonical(f.start());
    const workerScript=`import {readFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk.toString();process.stdout.write(input.trim());try{readFileSync(${JSON.stringify(join(f.control,"secret"))});process.exitCode=0}catch(error){console.error(error.message);process.exitCode=1}`;
    const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},workflow:{command:{file:process.execPath,args:["-e",workerScript]}}})});
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
  test("a positive host Workflow deadline wins over a runtime no-deadline request",async()=>{
    const f=fixture(),base=f.canonical(f.start());
    const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},commandOptions:{...base.commandOptions,timeoutMs:40},workflow:{command:{file:process.execPath,args:["-e","setInterval(()=>{},1000)"]}}})});cleanup.push(()=>registration.stopAll());
    const {command:_command,...request}=f.start({kind:"workflow",workflowRunId:"deadline",timeoutMs:0});
    const {handle}=await registration.handle(operations.start,request,f.context) as HostCodeProcessStartReply;
    const reply=await registration.handle(operations.poll,{handle,afterSequence:0,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply;
    expect(reply.exit).toMatchObject({code:null,signal:"SIGKILL",timedOut:true});
    await registration.handle(operations.release,{handle,afterSequence:0},f.context);
  });
  test("Workflow deadline ends at OS close while output EOF delivery may remain pending",async()=>{
    const f=fixture(),base=f.canonical(f.start());let eof!:()=>void,finish!:()=>void;const readEOF=new Promise<void>(resolve=>{eof=resolve}),gate=new Promise<void>(resolve=>{finish=resolve});
    const registration=createHostCodeProcessRegistration({generationId:"generation",createOutputTransport:async()=>{const transport=await createFixtureHostOutput();return{...transport,async start(stdout,stderr){await transport.start(stdout,stderr);eof();await gate;}}},resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},commandOptions:{...base.commandOptions,timeoutMs:500},workflow:{command:{file:process.execPath,args:["-e","console.log('done')"]}}})});cleanup.push(()=>registration.stopAll());
    const {command:_command,...request}=f.start({kind:"workflow",workflowRunId:"pending-output"});const {handle}=await registration.handle(operations.start,request,f.context) as HostCodeProcessStartReply;
    await readEOF;await new Promise(resolve=>setTimeout(resolve,550));finish();
    let sequence=0;for(;;){const reply=await registration.handle(operations.poll,{handle,afterSequence:sequence,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply;sequence=reply.events.at(-1)?.sequence??sequence;if(reply.exit){expect(reply.exit).toMatchObject({code:0,timedOut:false});break;}}
    await registration.handle(operations.release,{handle,afterSequence:sequence},f.context);
  });
  test("a nonreading Workflow admits one bounded write and refuses overlapping data/EOF",async()=>{
    const f=fixture();
    const base=f.canonical(f.start());
    const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},workflow:{command:{file:process.execPath,args:["-e","setInterval(()=>{},1000)"]}}})});
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
    const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},workflow:{command:{file:process.execPath,args:["-e","let count=0;for await(const chunk of process.stdin)count+=chunk.length;console.log(count)"]}}})});cleanup.push(()=>registration.stopAll());
    const {command:_command,...request}=f.start({kind:"workflow",workflowRunId:"reader"});
    const {handle}=await registration.handle(operations.start,request,f.context) as HostCodeProcessStartReply;
    await registration.handle(operations.write,{handle,dataBase64:Buffer.from("payload").toString("base64")},f.context);
    await registration.handle(operations.write,{handle,end:true},f.context);
    const attempts=await Promise.allSettled([{handle,dataBase64:""},{handle,dataBase64:"YWJj"},{handle,end:true}].map(payload=>registration.handle(operations.write,payload,f.context)));
    expect(attempts.filter(result=>result.status==="fulfilled")).toHaveLength(0);
    let sequence=0,output="";for(;;){const reply=await registration.handle(operations.poll,{handle,afterSequence:sequence,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply;for(const event of reply.events){sequence=event.sequence;output+=Buffer.from(event.dataBase64,"base64").toString();}if(reply.exit){expect(reply.exit.code).toBe(0);break;}}
    expect(output).toBe("7\n");
  });
  test("per-process backpressure preserves large output while another producer is unacknowledged",async()=>{
    const f=fixture();
    const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",maxBufferedBytes:65536,resolveCurrentContext:async request=>f.canonical(request)});cleanup.push(()=>registration.stopAll());
    const retained=await registration.handle(operations.start,f.start({command:"head -c 49152 /dev/zero",toolUseId:"retained"}),f.context) as HostCodeProcessStartReply;
    let first:HostCodeProcessPollReply;
    do { first=await registration.handle(operations.poll,{handle:retained.handle,afterSequence:0,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply; if(!first.exit)await new Promise(resolve=>setTimeout(resolve,0)); } while(!first.exit);
    expect(first.events.reduce((sum,event)=>sum+Buffer.from(event.dataBase64,"base64").length,0)).toBe(49152);
    const size=10*1024*1024;
    const {handle}=await registration.handle(operations.start,f.start({command:`head -c ${size} /dev/zero`,toolUseId:"large",maxStreamedBytes:size+1,timeoutMs:10000}),f.context) as HostCodeProcessStartReply;
    // Let this row reach its high watermark while the other row's bytes remain retained.
    await new Promise(resolve=>setTimeout(resolve,50));
    let sequence=0,bytes=0;
    for(;;){const reply=await registration.handle(operations.poll,{handle,afterSequence:sequence,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply;
      for(const event of reply.events){sequence=event.sequence;const chunk=Buffer.from(event.dataBase64,"base64");bytes+=chunk.length;expect(chunk.every(value=>value===0)).toBe(true);}
      if(reply.exit){expect(reply.exit.code).toBe(0);expect(reply.exit.streamKilled).toBe(false);break;}
    }
    expect(bytes).toBe(size);
    await registration.handle(operations.release,{handle,afterSequence:sequence},f.context);
    await registration.handle(operations.release,{handle:retained.handle,afterSequence:first.events.at(-1)!.sequence},f.context);
  },15000);
  test("abandonment frees an unread output row, closes it and never signals a released handle",async()=>{
    const f=fixture();
    const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",maxBufferedBytes:65536,resolveCurrentContext:async request=>f.canonical(request)});cleanup.push(()=>registration.stopAll());
    const {handle}=await registration.handle(operations.start,f.start({command:"head -c 10485760 /dev/zero",maxStreamedBytes:10485761,timeoutMs:10000}),f.context) as HostCodeProcessStartReply;
    await new Promise(resolve=>setTimeout(resolve,30));
    const payload={handle,afterSequence:0,abandon:true};
    await registration.handle(operations.release,payload,f.context);
    await registration.handle(operations.release,payload,f.context);
    await expect(registration.handle(operations.signal,{handle,signal:"SIGKILL"},f.context)).rejects.toThrow("foreign");
    registration.stopAll();expect((await registration.drained).status).toBe("confirmed");
  });
  test("a throwing output consumer abandons its broker row in command finally",async()=>{
    const f=fixture();let abandoned=false;
    const client:HostCodeProcessClient={
      start:(request)=>f.registration.handle(operations.start,request,f.context) as Promise<HostCodeProcessStartReply>,
      poll:(handle,afterSequence)=>f.poll(handle,afterSequence),
      write:async payload=>{await f.registration.handle(operations.write,payload,f.context)},
      signal:async(handle,signal)=>{await f.registration.handle(operations.signal,{handle,signal},f.context)},
      release:async(handle,afterSequence,options)=>{abandoned=options?.abandon===true;await f.registration.handle(operations.release,{handle,afterSequence,...options},f.context)},
    };
    cleanup.push(installHostCodeProcessClient({generationId:"generation",client}));
    const canonical=f.canonical(f.start());
    await expect(runCommand({...canonical.commandOptions,command:"printf bytes",hostCodeScope:{sessionId:"child-session",toolUseId:"active-call"},onStdout(){throw new Error("consumer stopped")}})).rejects.toThrow("no local execution fallback");
    expect(abandoned).toBe(true);f.registration.stopAll();expect((await f.registration.drained).status).toBe("confirmed");
  });
  test("TaskStop signals an exact broker handle and a released stop closure cannot re-signal",async()=>{
    const f=fixture();resetBackgroundTaskRuntimeForTest();cleanup.push(resetBackgroundTaskRuntimeForTest);
    let inBroker=false,runtimeSignals=0;const signals:HostCodeProcessStartReply["handle"][]=[];
    const client:HostCodeProcessClient={
      start:request=>f.registration.handle(operations.start,request,f.context) as Promise<HostCodeProcessStartReply>,poll:(handle,sequence)=>f.poll(handle,sequence),
      write:async request=>{await f.registration.handle(operations.write,request,f.context)},
      release:async(handle,afterSequence,options)=>{await f.registration.handle(operations.release,{handle,afterSequence,...options},f.context)},
      signal:async(handle,signal)=>{signals.push(handle);inBroker=true;try{await f.registration.handle(operations.signal,{handle,signal},f.context);}finally{inBroker=false;}},
    };
    cleanup.push(installHostCodeProcessClient({generationId:"generation",client}));
    const originalKill=process.kill;const kill=spyOn(process,"kill").mockImplementation(((pid:number,signal?:number|NodeJS.Signals)=>{if(!inBroker)runtimeSignals++;return originalKill(pid,signal)}) as typeof process.kill);
    let spawned!:()=>void;const started=new Promise<void>(resolve=>{spawned=resolve});let stopped!:(()=>void);let displayPid=0;
    try {
      const completion=runCommand({...f.canonical(f.start()).commandOptions,command:"sleep 30",hostCodeScope:{sessionId:"child-session",toolUseId:"active-call"},onSpawned(info){displayPid=info.pid;stopped=info.stopOwnedProcess!;startTracking({taskId:"owned-native",kind:"bash",outputPath:"/fixture",description:"native",pid:info.pid,stopOwnedProcess:stopped});spawned();}});
      await started;expect(typeof stopped).toBe("function");
      const context={sessionId:"child-session",emitFrame(){}} as unknown as ToolExecutionContext;
      expect((await taskStopExecutor.execute({task_id:"owned-native"},context)).isError).toBeFalsy();await completion;
      expect(signals).toHaveLength(1);expect(signals[0]).toMatchObject({generationId:"generation",sessionId:"child-session",toolUseId:"active-call",pid:displayPid});
      expect(runtimeSignals).toBe(0);stopped();await Promise.resolve();expect(signals).toHaveLength(1);
    } finally {kill.mockRestore();}
  });
  test("pending admissions reserve capacity before authorization completes",async()=>{
    const f=fixture();let admit!:(value:HostCodeCanonicalContext)=>void;
    const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",maxProcesses:1,resolveCurrentContext:()=>new Promise(resolve=>{admit=resolve})});cleanup.push(()=>registration.stopAll());
    const request=f.start();const pending=registration.handle(operations.start,request,f.context);
    await expect(registration.handle(operations.start,f.start({toolUseId:"next"}),f.context)).rejects.toThrow("inventory");
    while(!admit)await new Promise(resolve=>setTimeout(resolve,0));admit(f.canonical(request));const {handle}=await pending as HostCodeProcessStartReply;
    await registration.handle(operations.release,{handle,afterSequence:0,abandon:true},f.context);
    registration.stopAll();expect((await registration.drained).status).toBe("confirmed");
  });
  test("abandoned rows reserve capacity and can be re-signalled until actual close",async()=>{
    const f=fixture();const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",maxProcesses:1,drainTimeoutMs:10,resolveCurrentContext:async request=>f.canonical(request)});cleanup.push(()=>registration.stopAll());
    const {handle}=await registration.handle(operations.start,f.start({command:"sleep 30"}),f.context) as HostCodeProcessStartReply;
    const originalKill=process.kill;let attempts=0;
    const kill=spyOn(process,"kill").mockImplementation(((pid:number,signal?:number|NodeJS.Signals)=>{
      if(pid===-handle.pid){attempts++;return true;}return originalKill(pid,signal);
    }) as typeof process.kill);
    try {
      await registration.handle(operations.release,{handle,afterSequence:0,abandon:true},f.context);
      await expect(registration.handle(operations.start,f.start({toolUseId:"next"}),f.context)).rejects.toThrow("inventory");
      registration.stopAll();expect(attempts).toBe(2);expect((await registration.drained).status).toBe("uncertain");
    } finally {kill.mockRestore();try{process.kill(-handle.pid,"SIGKILL");}catch{}}
  });
  test("bound release remains admitted after abort while new execution is refused",async()=>{
    const f=fixture();const abort=new AbortController();const context={...f.context,signal:abort.signal};
    const {handle}=await f.registration.handle(operations.start,f.start({command:"sleep 30"}),context) as HostCodeProcessStartReply;
    abort.abort();
    await expect(f.registration.handle(operations.start,f.start({toolUseId:"next"}),context)).rejects.toThrow("cancelled");
    await expect(f.registration.handle(operations.write,{handle,end:true},context)).rejects.toThrow("cancelled");
    await f.registration.handle(operations.release,{handle,afterSequence:0,abandon:true},context);
    f.registration.stopAll();expect((await f.registration.drained).status).toBe("confirmed");
  });
  test("aggregate watermarks pause peers and abandonment frees budget for a surviving stream",async()=>{
    const f=fixture();const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",maxBufferedBytes:65536,maxTotalBufferedBytes:262144,resolveCurrentContext:async request=>f.canonical(request)});cleanup.push(()=>registration.stopAll());
    const handles:HostCodeProcessStartReply["handle"][]=[];
    for(let index=0;index<5;index++){
      const marker=join(f.dir,`finished-${index}`);
      const {handle}=await registration.handle(operations.start,f.start({command:`head -c 10485760 /dev/zero; touch '${marker}'`,toolUseId:`stream-${index}`}),f.context) as HostCodeProcessStartReply;handles.push(handle);
    }
    await new Promise(resolve=>setTimeout(resolve,50));expect(existsSync(join(f.dir,"finished-0"))).toBe(false);
    for(const handle of handles.slice(1))await registration.handle(operations.release,{handle,afterSequence:0,abandon:true},f.context);
    const handle=handles[0]!;let sequence=0,bytes=0;
    for(;;){const reply=await registration.handle(operations.poll,{handle,afterSequence:sequence,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply;for(const event of reply.events){sequence=event.sequence;bytes+=Buffer.from(event.dataBase64,"base64").length;}if(reply.exit){expect(reply.exit.code).toBe(0);expect(reply.exit.streamKilled).toBe(false);break;}}
    expect(bytes).toBe(10485760);expect(existsSync(join(f.dir,"finished-0"))).toBe(true);
    await registration.handle(operations.release,{handle,afterSequence:sequence},f.context);
  });
  test("idle native pipes leave host file I/O responsive and wake promptly",async()=>{
    const f=fixture();const handles:HostCodeProcessStartReply["handle"][]=[];
    for(let index=0;index<12;index++){
      const {handle}=await f.registration.handle(operations.start,f.start({command:"sleep 30",toolUseId:`idle-${index}`}),f.context) as HostCodeProcessStartReply;handles.push(handle);
    }
    await new Promise(resolve=>setTimeout(resolve,30));
    const began=performance.now();expect(await readFile(join(f.control,"secret"),"utf8")).toBe("protected");expect(performance.now()-began).toBeLessThan(250);
    const output=await createFixtureHostOutput();const child=spawn("/bin/sh",["-c","sleep 0.03; printf awake"],{stdio:["ignore",output.stdoutFd,output.stderrFd]});output.closeWriters();
    let awake!:()=>void;const received=new Promise<void>(resolve=>{awake=resolve});const start=performance.now();
    const done=output.start(chunk=>{expect(chunk.toString()).toBe("awake");awake();},()=>{});await received;expect(performance.now()-start).toBeLessThan(250);await done;
    for(const handle of handles)await f.registration.handle(operations.release,{handle,afterSequence:0,abandon:true},f.context);
  });
  test("host authority fd and native pipe endpoints are CLOEXEC; child inherits only 0-2",async()=>{
    const f=fixture();const authority:number[]=[];
    try {
      for(let index=0;index<140;index++)authority.push(openSync(join(f.control,"secret"),"r"));
      expect(Math.max(...authority)).toBeGreaterThan(128);
      const request=f.start({command:'for path in /dev/fd/*; do if test -e "$path"; then printf "%s\\n" "${path##*/}"; fi; done' });const {handle}=await f.registration.handle(operations.start,request,f.context) as HostCodeProcessStartReply;
      const terminal=await f.terminal(handle);expect(terminal.reply.exit?.code).toBe(0);expect(terminal.output.trim().split("\n").sort()).toEqual(["0","1","2"]);
      await f.registration.handle(operations.release,{handle,afterSequence:terminal.sequence},f.context);
    } finally {for(const fd of authority)closeSync(fd);}
  });
  test("drain confirms managed close events after stop, not a kill receipt",async()=>{
    const f=fixture();await f.registration.handle(operations.start,f.start({command:"sleep 30"}),f.context);
    let settled=false;void f.registration.drained.then(()=>{settled=true});await Promise.resolve();expect(settled).toBe(false);
    f.registration.stopAll();expect(await f.registration.drained).toEqual({status:"confirmed",generationId:"generation",coverage:"registered-process-close-only",confirmedProcessCount:1});
  });
  test("closed process cannot be signalled during a delayed or failed output drain",async()=>{
    const f=fixture(), inner=await createFixtureHostOutput(), abort=new AbortController();
    let failOutput!:(error:Error)=>void, observedClose!:()=>void;
    const outputFence=new Promise<void>((_resolve,reject)=>{failOutput=reject});
    // Observe rejection immediately even if the OS close arrives before pipe EOF.
    void outputFence.catch(()=>{});
    const closed=new Promise<void>(resolve=>{observedClose=resolve});
    const output={...inner,start:(stdout:(chunk:Buffer)=>void,stderr:(chunk:Buffer)=>void)=>inner.start(stdout,stderr).then(()=>outputFence)};
    cleanup.push(()=>{inner.dispose();failOutput(new Error("fixture cleanup"))});
    const pending=runCommandLocally({...f.canonical(f.start()).commandOptions,command:"true",timeoutMs:200,signal:abort.signal,hostOwnedOutput:output,onProcessClosed:observedClose});
    await closed;
    const kill=spyOn(process,"kill").mockImplementation(()=>{throw new Error("stale signal attempted")});
    try {
      abort.abort();await new Promise(resolve=>setTimeout(resolve,250));
      failOutput(new Error("output failed after process exit"));
      const result=await pending;
      expect(kill).not.toHaveBeenCalled();expect(result.timedOut).toBe(false);expect(result.aborted).toBe(false);
      expect(result.exitCode).toBeNull();expect(result.streamKilled).toBe(true);
    } finally {kill.mockRestore();}
  });
  test("Workflow OS exit zero cannot hide failed native output completion",async()=>{
    const f=fixture();const base=f.canonical(f.start());
    let late!:(chunk:Buffer)=>void, allocations=0, disposed=0;
    const registration=createHostCodeProcessRegistration({generationId:"generation",maxTotalBufferedBytes:65536,createOutputTransport:async()=>{
      const inner=await createFixtureHostOutput();if(allocations++>0)return inner;
      return{...inner,dispose(){disposed++;inner.dispose()},start:(stdout:(chunk:Buffer)=>void,stderr:(chunk:Buffer)=>void)=>{
        late=stderr;return inner.start(stdout,stderr).then(()=>{throw new Error("fixture output completion failed")});
      }};
    },resolveCurrentContext:async request=>({...base,scope:{generationId:"generation",sessionId:request.sessionId,toolUseId:request.toolUseId},workflow:{command:{file:process.execPath,args:["-e","process.exit(0)"]}}})});
    cleanup.push(()=>registration.stopAll());
    const {command:_command,...request}=f.start({kind:"workflow",workflowRunId:"failed-output"});
    const {handle}=await registration.handle(operations.start,request,f.context) as HostCodeProcessStartReply;
    let sequence=0;
    for(;;){const reply=await registration.handle(operations.poll,{handle,afterSequence:sequence,maxBytes:65536,maxWaitMs:30000},f.context) as HostCodeProcessPollReply;
      sequence=reply.events.at(-1)?.sequence??sequence;
      if(reply.exit){expect(reply.exit.code).toBeNull();expect(reply.exit.streamKilled).toBe(true);break;}
    }
    expect(disposed).toBeGreaterThan(0);
    await registration.handle(operations.release,{handle,afterSequence:sequence},f.context);
    // A broken adapter's second stream callback cannot refill released rows or
    // consume the aggregate watermark and pause an unrelated later command.
    late(Buffer.alloc(262144,65));
    const next=await registration.handle(operations.start,f.start({command:"printf alive",toolUseId:"after-failed-output"}),f.context) as HostCodeProcessStartReply;
    const reply=await Promise.race([
      registration.handle(operations.poll,{handle:next.handle,afterSequence:0,maxBytes:65536,maxWaitMs:30000},f.context) as Promise<HostCodeProcessPollReply>,
      new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error("late output consumed another row's budget")),1000)),
    ]);
    expect(reply.events.map(event=>Buffer.from(event.dataBase64,"base64").toString()).join("")).toBe("alive");
    await registration.handle(operations.release,{handle:next.handle,afterSequence:0,abandon:true},f.context);
  });
  test("unconfirmed kill remains uncertain with its exact owned handle",async()=>{
    const f=fixture();const registration=createHostCodeProcessRegistration({createOutputTransport:createFixtureHostOutput,generationId:"generation",drainTimeoutMs:10,resolveCurrentContext:async request=>f.canonical(request)});cleanup.push(()=>registration.stopAll());
    const {handle}=await registration.handle(operations.start,f.start({command:"sleep 30"}),f.context) as HostCodeProcessStartReply;
    const original=process.kill;const kill=spyOn(process,"kill").mockImplementation((pid,signal)=>pid===-handle.pid?true:original(pid,signal));
    try{registration.stopAll();expect(await registration.drained).toEqual({status:"uncertain",generationId:"generation",coverage:"registered-process-close-only",confirmedProcessCount:0,pendingHandles:[handle]});}finally{kill.mockRestore();await registration.handle(operations.signal,{handle,signal:"SIGKILL"},f.context);}
  });
});

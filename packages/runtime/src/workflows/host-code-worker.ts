import { PassThrough, Writable } from "node:stream";
import type { HostCodeProcessHandle, HostCodeProcessScope } from "@yanlinglabs/winter-agent-sdk";
import { currentHostCodeProcessClient, requireBoundHandle } from "../sandbox/host-code-process.ts";
import { stderrTail, type WorkerProcess } from "./runtime.ts";

/** Virtual stdio worker backed by the trusted host process owner, not a nested sandbox-exec. */
export function brokeredWorkflowWorker(input: { cwd: string; runId: string; scope: Omit<HostCodeProcessScope,"generationId"> }): WorkerProcess {
  const bound = currentHostCodeProcessClient();
  if (!bound) throw new Error("trusted parent Workflow broker unavailable");
  const scope = { ...input.scope, generationId: bound.generationId };
  const stdout = new PassThrough(); const stderr = new PassThrough();
  let handle: HostCodeProcessHandle | undefined;
  let done=false; let stopping=false;
  const lastStderrLine=stderrTail(stderr);
  const exits: Array<(code:number|null)=>void> = []; const errors:Array<(error:Error)=>void>=[];
  const abort=new AbortController();
  const fail=(error:unknown)=>{
    if(done)return;done=true;
    if(handle)void bound.client.signal(handle,"SIGKILL").catch(()=>{});
    const failure=error instanceof Error?error:new Error("host Workflow broker failed");
    for(const callback of errors)callback(failure);
    stdout.end();stderr.end();for(const callback of exits)callback(1);
  };
  const ready=bound.client.start({version:1,...scope,kind:"workflow",workflowRunId:input.runId,cwd:input.cwd,timeoutMs:0,maxStreamedBytes:5*1024**3},abort.signal).then(async(started)=>{
    requireBoundHandle(started.handle,scope);handle=started.handle;
    if(started.posture!=="sandboxed")throw new Error("host Workflow worker lacks canonical sandbox");
    if(stopping)void bound.client.signal(handle,"SIGKILL").catch(fail);
    void(async()=>{
      let sequence=0;
      try{
        while(!done){
          const reply=await bound.client.poll(handle!,sequence);
          requireBoundHandle(reply.handle,scope);
          if(reply.handle.id!==handle!.id||reply.handle.pid!==handle!.pid)throw new Error("foreign Workflow process handle");
          let bytes=0;
          for(const event of reply.events){
            if(event.sequence!==sequence+1||(event.stream!=="stdout"&&event.stream!=="stderr"))throw new Error("Workflow output sequence mismatch");
            const chunk=Buffer.from(event.dataBase64,"base64");if(chunk.toString("base64")!==event.dataBase64||(bytes+=chunk.length)>65536)throw new Error("Workflow output bound/encoding mismatch");
            sequence=event.sequence;(event.stream==="stdout"?stdout:stderr).write(chunk);
          }
          if(reply.exit){await bound.client.release(handle!,sequence);done=true;stdout.end();stderr.end();for(const callback of exits)callback(reply.exit.code);return;}
        }
      }catch(error){fail(error);}
    })();
    return handle;
  });
  void ready.catch(fail);
  const stdin=new Writable({write(chunk:Buffer,_encoding,callback){
    void ready.then(async(owner)=>{if(stopping||done)throw new Error("Workflow stdin cancelled");for(let offset=0;offset<chunk.length;offset+=65536)await bound.client.write({handle:owner,dataBase64:chunk.subarray(offset,offset+65536).toString("base64")});}).then(()=>callback(),(error)=>{fail(error);callback(error instanceof Error?error:new Error("Workflow stdin failed"));});
  },final(callback){void ready.then((owner)=>{if(stopping||done)throw new Error("Workflow stdin cancelled");return bound.client.write({handle:owner,end:true});}).then(()=>callback(),(error)=>{fail(error);callback(error);});}});
  stdin.on("error",()=>{});
  // A virtual worker has no synchronously available local PID. Its handle remains broker-owned.
  return {stdin,stdout,onExit(callback){exits.push(callback)},onError(callback){errors.push(callback)},lastStderrLine,kill(){if(done)return;stopping=true;abort.abort();if(handle)void bound.client.signal(handle,"SIGKILL").catch(fail);}};
}

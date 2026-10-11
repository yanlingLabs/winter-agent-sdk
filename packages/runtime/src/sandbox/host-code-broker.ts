import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { HOST_CODE_PROCESS_SUBTYPES, buildMandatoryFloorProfile, hasMandatoryFloor, type HostCodeDrainEvidence, type HostCodeProcessRegistration, type HostCodeProcessStart, type HostCodeProcessScope, type HostCodeProcessHandle, type HostCodeProcessEvent, type HostCodeProcessPollReply, type HostExecutionFloor } from "@yanlinglabs/winter-agent-sdk";
import { runCommandLocally, resolveExecutionPath, type RunCommandOptions } from "./spawn.ts";
import { buildWorkerSpawn, type WorkerCommand } from "../workflows/sandbox.ts";

export interface HostCodeCanonicalContext {
  /** Host authenticates query/generation/active tool/descendant, validates cwd and current policy. */
  scope: HostCodeProcessScope;
  commandOptions: Omit<RunCommandOptions, "command" | "onStdout" | "onStderr" | "onSpawned" | "onProcessClosed" | "mandatoryFloor" | "hostCodeScope">;
  floor: HostExecutionFloor;
  /** Host-generated command (e.g. validated pwd capture); never a runtime-supplied profile/script wrapper. */
  executionCommand?: string;
  /** Resolved by host from runId/immutable runtime image; no executable from runtime JSON. */
  workflow?: { command: WorkerCommand; home?: string; winterHome?: string };
}
interface Row {
  handle: HostCodeProcessHandle; events: HostCodeProcessEvent[]; nextSequence: number; buffered: number;
  callerSessionId: string; acknowledgedSequence: number; deliveredSequence: number; polling: boolean;
  wake: (() => void) | undefined; exit: HostCodeProcessPollReply["exit"]; backlogKilled?: boolean;
  signal(value: "SIGTERM" | "SIGKILL"): void;
  stdin?: NodeJS.WritableStream;
  stdinState?: { writing: boolean; ended: boolean; failure: Error | undefined };
}

/** Trusted parent only. Resolver is admission authority; runtime JSON supplies neither policy nor profile. */
export function createHostCodeProcessRegistration(input: {
  generationId: string;
  resolveCurrentContext(request: HostCodeProcessStart, context: { signal: AbortSignal; callerSessionId: string; generationId: string }): Promise<HostCodeCanonicalContext>;
  /** Aggregate decoded output retained by this registration, across every process. */
  maxBufferedBytes?: number;
  drainTimeoutMs?:number;
}): HostCodeProcessRegistration & { stopAll(): void; readonly drained:Promise<HostCodeDrainEvidence> } {
  const rows = new Map<string, Row>();
  // Final output stays replayable until explicit acknowledgment; only bounded released handles remain.
  const released = new Map<string, { handle: HostCodeProcessHandle; callerSessionId: string; sequence: number }>();
  const maxBuffered = input.maxBufferedBytes ?? 4 * 1024 * 1024;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.generationId) || !Number.isSafeInteger(maxBuffered) || maxBuffered < 65536) throw new Error("invalid host Code broker bounds/identity");
  let closed = false;
  const pendingClose=new Map<string,HostCodeProcessHandle>();
  let confirmedProcessCount=0;
  let settleDrain!:(result:HostCodeDrainEvidence)=>void;
  const drained=new Promise<HostCodeDrainEvidence>(resolve=>{settleDrain=resolve});
  let drainTimer:ReturnType<typeof setTimeout>|undefined;
  const drainTimeout=input.drainTimeoutMs??5000;
  if(!Number.isSafeInteger(drainTimeout)||drainTimeout<1)throw new Error("invalid host Code drain deadline");
  function confirmClose(handle:HostCodeProcessHandle|undefined){
    if(handle&&pendingClose.delete(handle.id))confirmedProcessCount++;
    if(closed&&pendingClose.size===0){clearTimeout(drainTimer);settleDrain({status:"confirmed",generationId:input.generationId,coverage:"registered-process-close-only",confirmedProcessCount});}
  }
  let totalBuffered = 0;
  let totalEvents = 0;
  const maxRetainedEvents = 4096; // Bound per-event metadata independently of byte-sized writes.
  function discard(row: Row, throughSequence: number) {
    while(row.events[0] && row.events[0].sequence<=throughSequence) {
      const bytes=Buffer.from(row.events.shift()!.dataBase64,"base64").length;
      row.buffered-=bytes;totalBuffered-=bytes;totalEvents--;
    }
  }
  function record(row: Row, stream: "stdout" | "stderr", chunk: Buffer) {
    if(row.backlogKilled)return;
    // Keep every poll at <=64KiB; byte boundaries are preserved with base64.
    for (let offset=0; offset<chunk.length; offset+=16384) {
      const part = chunk.subarray(offset, offset+16384);
      if (totalBuffered + part.length > maxBuffered || totalEvents>=maxRetainedEvents) { row.backlogKilled = true; row.signal("SIGKILL"); return; }
      row.events.push({ sequence: row.nextSequence++, stream, dataBase64: part.toString("base64") }); row.buffered += part.length;totalBuffered+=part.length;totalEvents++;
    }
    row.wake?.(); row.wake = undefined;
  }
  function owned(payload: unknown, callerSessionId: string): Row {
    const handle = (payload as { handle?: HostCodeProcessHandle })?.handle;
    const row = handle && rows.get(handle.id);
    if (!row || row.callerSessionId !== callerSessionId || ["id","generationId","sessionId","toolUseId","pid"].some((key) => row.handle[key as keyof HostCodeProcessHandle] !== handle[key as keyof HostCodeProcessHandle])) throw new Error("foreign host Code process handle");
    return row;
  }
  const registration: HostCodeProcessRegistration & { stopAll(): void; readonly drained:Promise<HostCodeDrainEvidence> } = {
    generationId: input.generationId,
    drained,
    dispose() { registration.stopAll(); },
    stopAll() {
      if(closed)return;closed=true;
      for (const row of rows.values()) if (!row.exit) row.signal("SIGKILL");
      confirmClose(undefined);
      if(pendingClose.size)drainTimer=setTimeout(()=>settleDrain({status:"uncertain",generationId:input.generationId,coverage:"registered-process-close-only",confirmedProcessCount,pendingHandles:[...pendingClose.values()]}),drainTimeout);
    },
    async handle(subtype, payload, context) {
      if (context.generationId !== input.generationId || context.signal.aborted) throw new Error("stale/cancelled host Code generation");
      if (subtype === HOST_CODE_PROCESS_SUBTYPES.start) {
        if (closed) throw new Error("host Code generation is closing");
        const request = payload as HostCodeProcessStart;
        const allowed = new Set(["version","generationId","sessionId","toolUseId","agentId","parentToolUseId","kind","cwd","command","workflowRunId","sandboxIntent","timeoutMs","maxStreamedBytes","pwdCapturePath"]);
        if (!request || typeof request !== "object" || Object.keys(request).some((key) => !allowed.has(key)) || request.version !== 1 || request.generationId !== input.generationId || typeof request.sessionId !== "string" || typeof request.toolUseId !== "string" || !request.toolUseId || typeof request.cwd !== "string" || !request.cwd.startsWith("/") || request.cwd.includes("\0") || (request.agentId !== undefined && typeof request.agentId !== "string") || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0 || !Number.isSafeInteger(request.maxStreamedBytes) || request.maxStreamedBytes < 1 || (request.sandboxIntent !== undefined && request.sandboxIntent !== "ordinary" && request.sandboxIntent !== "override-requested") || (request.kind !== "command" && request.kind !== "workflow") || (request.kind === "command" && (typeof request.command !== "string" || request.command.includes("\0") || request.workflowRunId !== undefined)) || (request.kind === "workflow" && (typeof request.workflowRunId !== "string" || !request.workflowRunId || request.command !== undefined))) throw new Error("invalid host Code start request");
        const canonical = await input.resolveCurrentContext(request, context);
        if(request.parentToolUseId!==undefined && typeof request.parentToolUseId!=="string")throw new Error("invalid descendant correlation");
        if (request.pwdCapturePath !== undefined && (typeof request.pwdCapturePath !== "string" || request.kind !== "command" || typeof canonical.executionCommand !== "string")) throw new Error("host pwd capture not admitted");
        if (closed || context.signal.aborted || canonical.scope.generationId !== request.generationId || canonical.scope.sessionId !== request.sessionId || canonical.scope.toolUseId !== request.toolUseId || canonical.scope.agentId !== request.agentId || canonical.scope.parentToolUseId !== request.parentToolUseId || canonical.commandOptions.cwd !== request.cwd || !hasMandatoryFloor(canonical.floor)) throw new Error("host Code admission changed or floor unavailable");
        if (rows.size >= 1024) throw new Error("host Code process inventory exceeded its bound");
        let resolveStarted!: (reply: { handle: HostCodeProcessHandle; posture: string }) => void;
        let rejectStarted!: (error: unknown) => void;
        const started = new Promise<{ handle: HostCodeProcessHandle; posture: string }>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
        let row: Row | undefined;
        const onAbort = () => row?.signal("SIGKILL");
        context.signal.addEventListener("abort", onAbort, { once: true });
        try {
        if (request.kind === "command") {
          const posture = resolveExecutionPath({ settings: canonical.commandOptions.settings, command: request.command!, ...(canonical.commandOptions.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: canonical.commandOptions.dangerouslyDisableSandbox } : {}) }).posture;
          const completion = runCommandLocally({ ...canonical.commandOptions, command: canonical.executionCommand ?? request.command!, matchCommand: request.command!, mandatoryFloor: canonical.floor, signal: context.signal,
            onProcessClosed(){confirmClose(row?.handle);},
            onSpawned({pid}) {
              const handle = { id: randomUUID(), generationId: request.generationId, sessionId: request.sessionId, toolUseId: request.toolUseId, pid };
              row = { handle, callerSessionId: context.callerSessionId, acknowledgedSequence: 0, deliveredSequence: 0, polling: false, events: [], nextSequence: 1, buffered: 0, wake: undefined, exit: undefined, signal(value) { if(row?.exit)return;try { process.kill(-pid,value); } catch {} } };
              rows.set(handle.id,row);
              pendingClose.set(handle.id,handle);
              // Returned posture comes from canonical host selection, not runtime intent.
              resolveStarted({handle,posture});
            }, onStdout(chunk) { if(row) record(row,"stdout",chunk); }, onStderr(chunk) { if(row) record(row,"stderr",chunk); },
          });
          completion.then((result) => {
            context.signal.removeEventListener("abort",onAbort);
            if(!row) { rejectStarted(new Error("host Code command did not spawn")); return; }
            row.exit = { code:result.exitCode,signal:null,timedOut:result.timedOut,aborted:result.aborted,streamKilled:result.streamKilled || row.backlogKilled === true }; row.wake?.(); row.wake=undefined;
          },(error)=>{ context.signal.removeEventListener("abort",onAbort); if(row){row.signal("SIGKILL");row.exit={code:null,signal:null,timedOut:false,aborted:context.signal.aborted,streamKilled:true};row.wake?.();row.wake=undefined;}rejectStarted(error); });
        } else {
          if (!canonical.workflow) throw new Error("workflow immutable worker unavailable");
          const worker = buildWorkerSpawn(canonical.workflow);
          const floor = buildMandatoryFloorProfile(canonical.floor).split("\n").slice(2).join("\n");
          const profile = `${worker.args[1]}\n${floor}`;
          const child = spawn(worker.file,["-p",profile,...worker.args.slice(2)],{cwd:canonical.commandOptions.cwd,env:canonical.commandOptions.env,stdio:["pipe","pipe","pipe"],detached:true});
          if (!child.pid) throw new Error("workflow worker failed to spawn");
          const pid=child.pid; const handle={id:randomUUID(),generationId:request.generationId,sessionId:request.sessionId,toolUseId:request.toolUseId,pid};
          row={handle,callerSessionId:context.callerSessionId,acknowledgedSequence:0,deliveredSequence:0,polling:false,events:[],nextSequence:1,buffered:0,wake:undefined,exit:undefined,stdin:child.stdin,stdinState:{writing:false,ended:false,failure:undefined},signal(value){if(row?.exit)return;try{process.kill(-pid,value)}catch{}}}; rows.set(handle.id,row);
          pendingClose.set(handle.id,handle);
          // Stream errors can arrive after a write callback or during stop. Consume them at
          // the process owner; never allow ERR_STREAM_WRITE_AFTER_END to crash the SDK host.
          child.stdin.on("error",(error:Error)=>{row!.stdinState!.failure=error;row!.stdinState!.ended=true;row!.signal("SIGKILL");});
          child.stdout.on("data",(chunk:Buffer)=>record(row!,"stdout",chunk)); child.stderr.on("data",(chunk:Buffer)=>record(row!,"stderr",chunk));
          child.once("close",(code,signal)=>{confirmClose(handle);context.signal.removeEventListener("abort",onAbort); row!.exit={code,signal,timedOut:false,aborted:context.signal.aborted,streamKilled:row!.backlogKilled === true};row!.wake?.();row!.wake=undefined});
          child.once("error",(error)=>{context.signal.removeEventListener("abort",onAbort);rejectStarted(error)}); resolveStarted({handle,posture:"sandboxed"});
        }
        } catch(error) { context.signal.removeEventListener("abort",onAbort); row?.signal("SIGKILL");throw error; }
        return started;
      }
      if(subtype===HOST_CODE_PROCESS_SUBTYPES.release){
        const request=payload as {handle:HostCodeProcessHandle;afterSequence:number};
        const prior=request?.handle && released.get(request.handle.id);
        if(prior && prior.callerSessionId===context.callerSessionId && JSON.stringify(prior.handle)===JSON.stringify(request.handle) && prior.sequence===request.afterSequence)return{};
        const row=owned(payload,context.callerSessionId);
        if(!row.exit || request.afterSequence!==row.nextSequence-1 || request.afterSequence!==row.deliveredSequence)throw new Error("final host Code output not acknowledged");
        discard(row,request.afterSequence);
        rows.delete(row.handle.id);released.set(row.handle.id,{handle:row.handle,callerSessionId:row.callerSessionId,sequence:request.afterSequence});
        if(released.size>256)released.delete(released.keys().next().value!);
        return{};
      }
      const row = owned(payload, context.callerSessionId);
      if (subtype === HOST_CODE_PROCESS_SUBTYPES.signal) {
        const signal=(payload as {signal?:unknown}).signal; if(signal!=="SIGTERM" && signal!=="SIGKILL")throw new Error("invalid signal"); row.signal(signal); return {};
      }
      if (subtype === HOST_CODE_PROCESS_SUBTYPES.write) {
        const request=payload as {dataBase64?:unknown;end?:unknown};
        const state=row.stdinState;
        if(closed || !row.stdin || row.exit || !state || state.ended || state.failure)throw new Error("host Code stdin unavailable");
        // Admission is synchronous and BEFORE base64 decoding/allocation. No pending write
        // queue exists in the broker; ordinary Workflow clients already send serially.
        if(state.writing)throw new Error("overlapping host Code stdin write");
        if(Object.keys(request).some(key=>!["handle","dataBase64","end"].includes(key)) || (request.end!==undefined && request.end!==true) || (request.dataBase64===undefined && request.end!==true) || (request.dataBase64!==undefined && (typeof request.dataBase64!=="string" || request.dataBase64.length>87384)))throw new Error("invalid stdin request");
        state.writing=true;
        try {
          if(request.dataBase64!==undefined) {
            const bytes=Buffer.from(request.dataBase64 as string,"base64");
            if(bytes.toString("base64")!==request.dataBase64 || bytes.length>65536)throw new Error("invalid stdin encoding");
            await new Promise<void>((resolve,reject)=>row.stdin!.write(bytes,(error?:Error|null)=>error?reject(error):resolve()));
          }
          if(closed || row.exit || state.failure)throw new Error("host Code stdin stopped before acknowledgment");
          if(request.end===true) {
            state.ended=true;
            await new Promise<void>((resolve,reject)=>row.stdin!.end((error?:Error|null)=>error?reject(error):resolve()));
          }
          if(state.failure || closed)throw new Error("host Code stdin stopped before acknowledgment");
          return{};
        } finally { state.writing=false; }
      }
      if(subtype!==HOST_CODE_PROCESS_SUBTYPES.poll)throw new Error("unknown host Code process operation");
      const request=payload as {afterSequence?:unknown;maxBytes?:unknown;maxWaitMs?:unknown};
      if(!Number.isSafeInteger(request.afterSequence) || (request.afterSequence as number)<row.acknowledgedSequence || (request.afterSequence as number)>row.deliveredSequence || request.maxBytes!==65536 || request.maxWaitMs!==30000 || row.polling)throw new Error("invalid host Code poll");
      row.acknowledgedSequence=request.afterSequence as number;
      discard(row,request.afterSequence as number);
      if(!row.events.length && !row.exit) {
        row.polling=true;
        try { await new Promise<void>((resolve)=>{
          const finish=()=>{clearTimeout(timer);context.signal.removeEventListener("abort",finish);row.wake=undefined;resolve();};
          const timer=setTimeout(finish,30000);row.wake=finish;context.signal.addEventListener("abort",finish,{once:true});
          if(context.signal.aborted)finish();
        }); } finally { row.polling=false; }
        if(context.signal.aborted)throw new Error("host Code poll cancelled");
      }
      const events:HostCodeProcessEvent[]=[];let bytes=0;
      for(const event of row.events){const length=Buffer.from(event.dataBase64,"base64").length;if(bytes+length>65536)break;bytes+=length;events.push(event);}
      row.deliveredSequence=events.at(-1)?.sequence ?? row.deliveredSequence;
      const final = row.exit && events.length===row.events.length;
      return {handle:row.handle,events,...(final?{exit:row.exit}:{})};
    },
  };
  return registration;
}

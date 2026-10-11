import type { HostOutputTransportFactory, HostOutputTransport } from "./host-output.ts";
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
  disposeOutput?: () => void;
  pauseOutput?: () => void; resumeOutput?: () => void; outputPaused?: boolean; abandoned?: boolean; outputFailed?: boolean;
  stdin?: NodeJS.WritableStream;
  stdinState?: { writing: boolean; ended: boolean; failure: Error | undefined };
}

/** Trusted parent only. Resolver is admission authority; runtime JSON supplies neither policy nor profile. */
export function createHostCodeProcessRegistration(input: {
  generationId: string;
  resolveCurrentContext(request: HostCodeProcessStart, context: { signal: AbortSignal; callerSessionId: string; generationId: string }): Promise<HostCodeCanonicalContext>;
  /** Per-process decoded output high watermark. Reading pauses until acknowledged below half. */
  maxBufferedBytes?: number;
  /** Aggregate byte watermark; all readers pause until output is acknowledged below half. */
  maxTotalBufferedBytes?: number;
  /** Includes retained rows, unconfirmed closes and unresolved admissions. */
  maxProcesses?: number;
  /** Protected native adapter. Missing refuses execution; Bun-owned stdio is not bounded. */
  createOutputTransport?: HostOutputTransportFactory;
  drainTimeoutMs?:number;
}): HostCodeProcessRegistration & { stopAll(): void; readonly drained:Promise<HostCodeDrainEvidence> } {
  const rows = new Map<string, Row>();
  // Final output stays replayable until explicit acknowledgment; only bounded released handles remain.
  const released = new Map<string, { handle: HostCodeProcessHandle; callerSessionId: string; sequence: number; abandoned?: boolean }>();
  const maxBuffered = input.maxBufferedBytes ?? 1024 * 1024;
  const maxTotalBuffered = input.maxTotalBufferedBytes ?? 4 * 1024 * 1024;
  const maxProcesses = input.maxProcesses ?? 64;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.generationId) || !Number.isSafeInteger(maxBuffered) || maxBuffered < 65536 || !Number.isSafeInteger(maxTotalBuffered) || maxTotalBuffered < 65536 || !Number.isSafeInteger(maxProcesses) || maxProcesses < 1 || maxProcesses > 1024) throw new Error("invalid host Code broker bounds/identity");
  let closed = false;
  const pendingClose=new Map<string,HostCodeProcessHandle>();
  const closingRows = new Map<string, Row>();
  let pendingAdmissions = 0;
  function inventorySize() {
    return pendingAdmissions + rows.size + [...pendingClose.keys()].filter(id => !rows.has(id)).length;
  }
  let confirmedProcessCount=0;
  let settleDrain!:(result:HostCodeDrainEvidence)=>void;
  const drained=new Promise<HostCodeDrainEvidence>(resolve=>{settleDrain=resolve});
  let drainTimer:ReturnType<typeof setTimeout>|undefined;
  const drainTimeout=input.drainTimeoutMs??5000;
  if(!Number.isSafeInteger(drainTimeout)||drainTimeout<1)throw new Error("invalid host Code drain deadline");
  function confirmClose(handle:HostCodeProcessHandle|undefined){
    if(handle&&pendingClose.delete(handle.id)){confirmedProcessCount++;closingRows.delete(handle.id);}
    if(closed&&pendingClose.size===0){clearTimeout(drainTimer);settleDrain({status:"confirmed",generationId:input.generationId,coverage:"registered-process-close-only",confirmedProcessCount});}
  }
  const maxRetainedEvents = 4096;
  let totalBuffered = 0;
  let totalEvents = 0;
  let aggregatePaused = false;
  function pause(row: Row) {
    if (row.outputPaused) return;
    row.outputPaused = true; row.pauseOutput?.();
  }
  function refreshFlow() {
    if (totalBuffered >= maxTotalBuffered || totalEvents >= maxRetainedEvents) aggregatePaused = true;
    else if (totalBuffered < maxTotalBuffered / 2 && totalEvents < maxRetainedEvents / 2) aggregatePaused = false;
    for (const row of rows.values()) {
      if (row.abandoned) continue;
      if (aggregatePaused || row.buffered >= maxBuffered || row.events.length >= maxRetainedEvents) pause(row);
      else if (row.outputPaused && row.buffered < maxBuffered / 2 && row.events.length < maxRetainedEvents / 2) {
        row.outputPaused = false; row.resumeOutput?.();
      }
    }
  }
  function discard(row: Row, throughSequence: number) {
    while(row.events[0] && row.events[0].sequence<=throughSequence) {
      const bytes=Buffer.from(row.events.shift()!.dataBase64,"base64").length;
      row.buffered-=bytes;totalBuffered-=bytes;totalEvents--;
    }
    if (row.abandoned && row.outputPaused) { row.outputPaused = false; row.resumeOutput?.(); }
    refreshFlow();
  }
  function record(row: Row, stream: "stdout" | "stderr", chunk: Buffer) {
    if(row.abandoned || row.outputFailed)return;
    // Keep every poll at <=64KiB; byte boundaries are preserved with base64. Streams pause
    // synchronously after this already-delivered chunk; the watermark can overshoot by it.
    for (let offset=0; offset<chunk.length; offset+=16384) {
      const part = chunk.subarray(offset, offset+16384);
      row.events.push({ sequence: row.nextSequence++, stream, dataBase64: part.toString("base64") });
      row.buffered += part.length;totalBuffered+=part.length;totalEvents++;
    }
    refreshFlow();
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
      for (const row of new Set([...rows.values(), ...closingRows.values()])) {
        if (!row.exit) row.signal("SIGKILL");
        row.abandoned=true;discard(row,row.nextSequence-1);row.disposeOutput?.();
      }
      confirmClose(undefined);
      if(pendingClose.size)drainTimer=setTimeout(()=>settleDrain({status:"uncertain",generationId:input.generationId,coverage:"registered-process-close-only",confirmedProcessCount,pendingHandles:[...pendingClose.values()]}),drainTimeout);
    },
    async handle(subtype, payload, context) {
      if (context.generationId !== input.generationId || (context.signal.aborted && subtype !== HOST_CODE_PROCESS_SUBTYPES.release && subtype !== HOST_CODE_PROCESS_SUBTYPES.signal)) throw new Error("stale/cancelled host Code generation");
      if (subtype === HOST_CODE_PROCESS_SUBTYPES.start) {
        if (closed) throw new Error("host Code generation is closing");
        const request = payload as HostCodeProcessStart;
        const allowed = new Set(["version","generationId","sessionId","toolUseId","agentId","parentToolUseId","kind","cwd","command","workflowRunId","sandboxIntent","timeoutMs","maxStreamedBytes","pwdCapturePath"]);
        if (!request || typeof request !== "object" || Object.keys(request).some((key) => !allowed.has(key)) || request.version !== 1 || request.generationId !== input.generationId || typeof request.sessionId !== "string" || typeof request.toolUseId !== "string" || !request.toolUseId || typeof request.cwd !== "string" || !request.cwd.startsWith("/") || request.cwd.includes("\0") || (request.agentId !== undefined && typeof request.agentId !== "string") || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0 || !Number.isSafeInteger(request.maxStreamedBytes) || request.maxStreamedBytes < 1 || (request.sandboxIntent !== undefined && request.sandboxIntent !== "ordinary" && request.sandboxIntent !== "override-requested") || (request.kind !== "command" && request.kind !== "workflow") || (request.kind === "command" && (typeof request.command !== "string" || request.command.includes("\0") || request.workflowRunId !== undefined)) || (request.kind === "workflow" && (typeof request.workflowRunId !== "string" || !request.workflowRunId || request.command !== undefined))) throw new Error("invalid host Code start request");
        if (inventorySize() >= maxProcesses) throw new Error("host Code process inventory exceeded its bound");
        pendingAdmissions++;
        let allocatedOutput: HostOutputTransport | undefined;
        try {
        if (!input.createOutputTransport) throw new Error("bounded host output transport unavailable");
        // Allocate before the authority check: no transport initialization await may separate
        // fresh host admission from its synchronous OS spawn below.
        allocatedOutput=await input.createOutputTransport();
        const canonical = await input.resolveCurrentContext(request, context);
        if(request.parentToolUseId!==undefined && typeof request.parentToolUseId!=="string")throw new Error("invalid descendant correlation");
        if (request.pwdCapturePath !== undefined && (typeof request.pwdCapturePath !== "string" || request.kind !== "command" || typeof canonical.executionCommand !== "string")) throw new Error("host pwd capture not admitted");
        if (closed || context.signal.aborted || canonical.scope.generationId !== request.generationId || canonical.scope.sessionId !== request.sessionId || canonical.scope.toolUseId !== request.toolUseId || canonical.scope.agentId !== request.agentId || canonical.scope.parentToolUseId !== request.parentToolUseId || canonical.commandOptions.cwd !== request.cwd || !hasMandatoryFloor(canonical.floor)) throw new Error("host Code admission changed or floor unavailable");
        let resolveStarted!: (reply: { handle: HostCodeProcessHandle; posture: string }) => void;
        let rejectStarted!: (error: unknown) => void;
        const started = new Promise<{ handle: HostCodeProcessHandle; posture: string }>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
        let row: Row | undefined;
        const onAbort = () => row?.signal("SIGKILL");
        context.signal.addEventListener("abort", onAbort, { once: true });
        try {
        if (request.kind === "command") {
          const posture = resolveExecutionPath({ settings: canonical.commandOptions.settings, command: request.command!, ...(canonical.commandOptions.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: canonical.commandOptions.dangerouslyDisableSandbox } : {}) }).posture;
          const hostOutput=allocatedOutput;
          const completion = runCommandLocally({ ...canonical.commandOptions, hostOwnedOutput:hostOutput, command: canonical.executionCommand ?? request.command!, matchCommand: request.command!, mandatoryFloor: canonical.floor, signal: context.signal,
            onProcessClosed(){confirmClose(row?.handle);},
            onSpawned({pid,pauseOutput,resumeOutput}) {
              const handle = { id: randomUUID(), generationId: request.generationId, sessionId: request.sessionId, toolUseId: request.toolUseId, pid };
              row = { handle, disposeOutput(){hostOutput.dispose();}, ...(pauseOutput ? { pauseOutput } : {}), ...(resumeOutput ? { resumeOutput } : {}), callerSessionId: context.callerSessionId, acknowledgedSequence: 0, deliveredSequence: 0, polling: false, events: [], nextSequence: 1, buffered: 0, wake: undefined, exit: undefined, signal(value) { if(row?.exit || !pendingClose.has(handle.id))return;try { process.kill(-pid,value); } catch {} } };
              rows.set(handle.id,row);
              pendingClose.set(handle.id,handle);closingRows.set(handle.id,row);refreshFlow();
              // Returned posture comes from canonical host selection, not runtime intent.
              resolveStarted({handle,posture});
            }, onStdout(chunk) { if(row) record(row,"stdout",chunk); }, onStderr(chunk) { if(row) record(row,"stderr",chunk); },
          });
          completion.then((result) => {
            context.signal.removeEventListener("abort",onAbort);
            if(!row) { rejectStarted(new Error("host Code command did not spawn")); return; }
            row.exit = { code:result.exitCode,signal:null,timedOut:result.timedOut,aborted:result.aborted,streamKilled:result.streamKilled || row.backlogKilled === true }; row.wake?.(); row.wake=undefined;
          },(error)=>{ hostOutput.dispose();context.signal.removeEventListener("abort",onAbort); if(row){row.signal("SIGKILL");row.exit={code:null,signal:null,timedOut:false,aborted:context.signal.aborted,streamKilled:true};row.wake?.();row.wake=undefined;}rejectStarted(error); });
        } else {
          if (!canonical.workflow) throw new Error("workflow immutable worker unavailable");
          const workflowTimeoutMs=canonical.commandOptions.timeoutMs;
          if(!Number.isSafeInteger(workflowTimeoutMs) || workflowTimeoutMs<0 || workflowTimeoutMs>2147483647)throw new Error("invalid host Workflow deadline");
          const worker = buildWorkerSpawn(canonical.workflow);
          const floor = buildMandatoryFloorProfile(canonical.floor).split("\n").slice(2).join("\n");
          const profile = `${worker.args[1]}\n${floor}`;
          const hostOutput=allocatedOutput;
          const child = spawn(worker.file,["-p",profile,...worker.args.slice(2)],{cwd:canonical.commandOptions.cwd,env:canonical.commandOptions.env,stdio:["pipe",hostOutput.stdoutFd,hostOutput.stderrFd],detached:true});
          hostOutput.closeWriters();
          child.once("error",()=>{}); // a launch refusal must not become an unhandled host error
          if (!child.pid || !child.stdin) {hostOutput.dispose();throw new Error("workflow worker failed to spawn");}
          const stdin=child.stdin;
          const pid=child.pid; const handle={id:randomUUID(),generationId:request.generationId,sessionId:request.sessionId,toolUseId:request.toolUseId,pid};
          row={handle,disposeOutput(){hostOutput.dispose();},pauseOutput(){hostOutput.pause();},resumeOutput(){hostOutput.resume();},callerSessionId:context.callerSessionId,acknowledgedSequence:0,deliveredSequence:0,polling:false,events:[],nextSequence:1,buffered:0,wake:undefined,exit:undefined,stdin,stdinState:{writing:false,ended:false,failure:undefined},signal(value){if(row?.exit || !pendingClose.has(handle.id))return;try{process.kill(-pid,value)}catch{}}}; rows.set(handle.id,row);
          pendingClose.set(handle.id,handle);closingRows.set(handle.id,row);refreshFlow();
          let workflowTimedOut=false;
          // Zero is the host's explicit no-deadline policy. Runtime request fields do not choose it.
          const workflowTimer=workflowTimeoutMs>0 ? setTimeout(()=>{workflowTimedOut=true;row!.signal("SIGKILL");},workflowTimeoutMs) : undefined;
          // Stream errors can arrive after a write callback or during stop. Consume them at
          // the process owner; never allow ERR_STREAM_WRITE_AFTER_END to crash the SDK host.
          stdin.on("error",(error:Error)=>{row!.stdinState!.failure=error;row!.stdinState!.ended=true;row!.signal("SIGKILL");});
          let outputDone:Promise<unknown>;
          try { outputDone=hostOutput.start(chunk=>record(row!,"stdout",chunk),chunk=>record(row!,"stderr",chunk)); }
          catch(error) { outputDone=Promise.reject(error); }
          void outputDone.catch(()=>{row!.outputFailed=true;hostOutput.dispose();row!.signal("SIGKILL")});
          child.once("close",(code,signal)=>{
            clearTimeout(workflowTimer);
            confirmClose(handle);context.signal.removeEventListener("abort",onAbort);
            const finished=(outputFailed:boolean)=>{row!.exit={code:outputFailed?null:code,signal,timedOut:workflowTimedOut,aborted:context.signal.aborted,streamKilled:outputFailed || row!.backlogKilled === true};row!.wake?.();row!.wake=undefined};
            void outputDone.then(()=>finished(false),()=>finished(true));
          });
          child.once("error",(error)=>{clearTimeout(workflowTimer);hostOutput.dispose();context.signal.removeEventListener("abort",onAbort);rejectStarted(error)}); resolveStarted({handle,posture:"sandboxed"});
        }
        } catch(error) { context.signal.removeEventListener("abort",onAbort); row?.signal("SIGKILL");throw error; }
        return await started;
        } catch(error) { allocatedOutput?.dispose();throw error; } finally { pendingAdmissions--; }
      }
      if(subtype===HOST_CODE_PROCESS_SUBTYPES.release){
        const request=payload as {handle:HostCodeProcessHandle;afterSequence:number;abandon?:true};
        if(Object.keys(request).some(key=>!["handle","afterSequence","abandon"].includes(key)) || (request.abandon!==undefined && request.abandon!==true))throw new Error("invalid release request");
        const prior=request?.handle && released.get(request.handle.id);
        if(prior && prior.callerSessionId===context.callerSessionId && JSON.stringify(prior.handle)===JSON.stringify(request.handle) && prior.sequence===request.afterSequence && prior.abandoned===(request.abandon===true))return{};
        const row=owned(payload,context.callerSessionId);
        if(request.abandon===true) {
          if(request.afterSequence!==0)throw new Error("invalid abandonment cursor");
          row.abandoned=true;row.signal("SIGKILL");row.disposeOutput?.();
        } else if(!row.exit || request.afterSequence!==row.nextSequence-1 || request.afterSequence!==row.deliveredSequence)throw new Error("final host Code output not acknowledged");
        row.abandoned=true;row.disposeOutput?.();discard(row,row.nextSequence-1);
        rows.delete(row.handle.id);released.set(row.handle.id,{handle:row.handle,callerSessionId:row.callerSessionId,sequence:request.afterSequence,abandoned:request.abandon===true});
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

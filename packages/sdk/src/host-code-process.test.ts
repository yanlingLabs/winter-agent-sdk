import { expect, test } from "bun:test";
import { query } from "./query.ts";
import { HOST_CODE_PROCESS_SUBTYPES, type HostCodeProcessRegistration } from "./host-code-process.ts";
import type { SpawnedRuntimeProcess } from "./transport.ts";
import { encodeFrame } from "./protocol/codec.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";

function peer() {
  let answer!:(frame:unknown)=>void;const response=new Promise<unknown>(resolve=>{answer=resolve});
  const proc:SpawnedRuntimeProcess={pid:null,kill(){},exited:Promise.resolve({code:0,signal:null}),stdin:{end(){},write(chunk){for(const line of chunk.split("\n").filter(Boolean)){const frame=JSON.parse(line);if(frame.type==="control_response")answer(frame)}}},stdout:(async function*(){
    yield encodeFrame({type:"init",protocolVersion:PROTOCOL_VERSION,sessionId:"actual-session",cwd:"/tmp",model:"winter-test/echo",permissionMode:"default",tools:[]});
    yield encodeFrame({type:"control_request",requestId:"broker",subtype:HOST_CODE_PROCESS_SUBTYPES.start,payload:{sessionId:"spoofed-session",generationId:"spoofed-generation"}});
    await response;yield encodeFrame({type:"data",message:{type:"result",subtype:"success",is_error:false,result:"done"}});
  })()};return{proc,response};
}
test("host registration captures query/channel identity and disposes on teardown",async()=>{
  const fixture=peer();let disposed=0;const calls:unknown[]=[];
  const registration:HostCodeProcessRegistration={generationId:"trusted-generation",dispose(){disposed++},async handle(subtype,payload,context){calls.push({subtype,payload,callerSessionId:context.callerSessionId,generationId:context.generationId});return{admitted:false}}};
  let wire:unknown;
  for await(const _ of query({prompt:"hello",options:{sessionId:"actual-session",hostCodeProcessBroker:registration,spawnClaudeCodeProcess:opts=>{wire=JSON.parse(opts.args[2]!);return fixture.proc}}})){}
  expect(wire).toMatchObject({hostCodeProcessBroker:{generationId:"trusted-generation"}});expect(calls).toEqual([{subtype:HOST_CODE_PROCESS_SUBTYPES.start,payload:{sessionId:"spoofed-session",generationId:"spoofed-generation"},callerSessionId:"actual-session",generationId:"trusted-generation"}]);expect(disposed).toBe(1);
});
test("wire marker alone cannot install a host callback",async()=>{
  const fixture=peer();
  for await(const _ of query({prompt:"hello",options:{spawnClaudeCodeProcess:()=>fixture.proc}})){}
  expect(await fixture.response).toMatchObject({ok:false});
});
test("guest posture refuses host broker before spawn",()=>{
  let spawns=0;
  expect(()=>query({prompt:"hello",options:{executionPosture:"confined-guest",hostCodeProcessBroker:{generationId:"generation",async handle(){throw new Error("unsafe")}},spawnClaudeCodeProcess:()=>{spawns++;throw new Error("unsafe")}}})).toThrow("guest-incompatible");expect(spawns).toBe(0);
});
test("query abort disposes host ownership even when the generator was never consumed",async()=>{
  const abortController=new AbortController();let disposed=0,finished!:()=>void;
  const exited=new Promise<{code:number;signal:null}>(resolve=>{finished=()=>resolve({code:0,signal:null})});
  const proc:SpawnedRuntimeProcess={pid:null,stdin:{write(){},end(){}},stdout:(async function*(){})(),exited,kill(){finished()}};
  const registration:HostCodeProcessRegistration={generationId:"abandoned",dispose(){disposed++},async handle(){return{}}};
  query({prompt:"fixture",options:{abortController,hostCodeProcessBroker:registration,spawnClaudeCodeProcess:()=>proc}});
  expect(disposed).toBe(0);abortController.abort();expect(disposed).toBe(1);await exited;await Promise.resolve();expect(disposed).toBe(1);
});
test("a runtime exit closes host ownership independently of consumer iteration",async()=>{
  let disposed=0,finished!:(value:{code:number;signal:null})=>void;
  const exited=new Promise<{code:number;signal:null}>(resolve=>{finished=resolve});
  const proc:SpawnedRuntimeProcess={pid:null,stdin:{write(){},end(){}},stdout:(async function*(){})(),exited,kill(){}};
  const registration:HostCodeProcessRegistration={generationId:"exited",dispose(){disposed++},async handle(){return{}}};
  const handle=query({prompt:"fixture",options:{hostCodeProcessBroker:registration,spawnClaudeCodeProcess:()=>proc}});
  finished({code:0,signal:null});await exited;await Promise.resolve();expect(disposed).toBe(1);await handle.return(undefined);expect(disposed).toBe(1);
});
test("pending host admission observes the query abort signal",async()=>{
  const fixture=peer(),abortController=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});let received:AbortSignal|undefined;let disposed=0;
  const registration:HostCodeProcessRegistration={generationId:"pending",dispose(){disposed++},async handle(_subtype,_payload,context){received=context.signal;entered();return new Promise(resolve=>context.signal.addEventListener("abort",()=>resolve({cancelled:true}),{once:true}));}};
  // Keep this fixture process live until abort: the basic peer otherwise reports a synthetic
  // already-resolved exit while still producing its request frames.
  let finish!:(value:{code:number;signal:null})=>void;const proc:SpawnedRuntimeProcess={...fixture.proc,exited:new Promise(resolve=>{finish=resolve}),kill(){finish({code:0,signal:null});}};
  const handle=query({prompt:"fixture",options:{abortController,hostCodeProcessBroker:registration,spawnClaudeCodeProcess:()=>proc}});
  const consumed=(async()=>{try{for await(const _ of handle){} }catch{}})();await started;abortController.abort();expect(received?.aborted).toBe(true);expect(disposed).toBe(1);await consumed;expect(disposed).toBe(1);
});

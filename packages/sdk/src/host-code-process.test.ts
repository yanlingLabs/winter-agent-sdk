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

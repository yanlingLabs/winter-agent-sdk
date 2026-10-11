import { expect, test } from "bun:test";
import { createGuestFileSession, bindGuestFileSession } from "./file-session.ts";
import { buildRegistryToolExecutor, type RegistryToolExecutorDeps, type ToolExecutionContext } from "../tools/registry.ts";
import type { GuestProcessPort, GuestProcessRequest, GuestProcessReply } from "./process-helper.ts";
import "../tools/impl/index.ts";
import { bashExecutor } from "../tools/impl/bash.ts";

const authority = { workspaceId: "workspace", sessionId: "guest", incarnationId: "boot", leaseEpoch: 1, configRevision: 2, grantRevision: 3, policyRevision: 4 };
function fixture(maxOutputBytes = 1024) {
  const calls: GuestProcessRequest[] = [], signals: (AbortSignal | undefined)[] = [];
  let response: ((request: GuestProcessRequest) => GuestProcessReply) | undefined;
  const port: GuestProcessPort = { async execute(request, signal) {
    calls.push(request); signals.push(signal);
    return response ? response(request) : { protocolVersion: 1, requestId: request.requestId, authority: request.authority, exitCode: 0, stdout: JSON.stringify({version:1,ok:true,exitCode:0,termination:"exit",stdoutBase64:Buffer.from("stdout 雪").toString("base64"),stderrBase64:Buffer.from("stderr").toString("base64")}) };
  }};
  const guest = createGuestFileSession({ authority, roots: [{id:"source",guestPath:"/workspace/source",readOnly:false}], expectedUid:10001, port:{ execute:async()=>{throw new Error("file port must not execute");}}, processPort:port, maxOutputBytes });
  const forbidden = () => { throw new Error("trusted runtime consumer reached"); };
  const deps: RegistryToolExecutorDeps = { executionPosture:"confined-guest",guestFiles:guest,sessionId:"guest",home:"/protected/runtime",getCwd:()=>"/workspace/source/nested",getTempDir:forbidden,probeReadAccess:forbidden,readState:{lookup:forbidden,recordRead:forbidden},emitFrame:forbidden,sandboxSettings:{},env:{BASH_ENV:"/protected/env",SECRET:"never-copy"},session:{setCwd:forbidden,getSessionRoot:forbidden,getBoundedRoots:forbidden,setSessionRoot:forbidden,addBoundedRoot:forbidden,removeBoundedRoot:forbidden,getPermissionMode:forbidden,setPermissionMode:forbidden} };
  const executor = buildRegistryToolExecutor(deps);
  const run=(input:unknown,signal?:AbortSignal)=>executor.execute({id:"shell-call",name:"Bash",input},signal?{signal}:undefined);
  const ctx=(): ToolExecutionContext=>{ const ctx={...deps,cwd:deps.getCwd(),permissions:{probeReadAccess:forbidden},get tempDir(){return forbidden();}} as unknown as ToolExecutionContext;bindGuestFileSession(ctx,guest);return ctx; };
  const receipt=(request:GuestProcessRequest,patch:Record<string,unknown>={})=>({protocolVersion:1,requestId:request.requestId,authority:request.authority,exitCode:0,stdout:JSON.stringify({version:1,ok:true,exitCode:0,termination:"exit",stdoutBase64:"",stderrBase64:"",...patch})});
  return {calls,signals,run,ctx,deps,port,receipt,respond:(value:(request:GuestProcessRequest)=>GuestProcessReply)=>response=value};
}
test("actual registry and direct Bash route same file-session authority without trusted filesystem/settings/env",async()=>{
  const f=fixture();const controller=new AbortController();
  const result=await f.run({command:"printf text",timeout:900000},controller.signal);
  expect(result.isError).not.toBe(true);expect(result.output).toContain("stdout 雪");expect(result.output).toContain("stderr");
  expect(f.calls[0]).toMatchObject({authority,expectedUid:10001,relativeCwd:"nested",timeoutMs:600000,maxOutputBytes:1024,root:{id:"source",guestPath:"/workspace/source"}});
  expect(f.signals[0]).toBe(controller.signal);expect(f.calls[0]).not.toHaveProperty("env");expect(Object.isFrozen(f.calls[0]!.authority)).toBe(true);
  expect((await bashExecutor.execute({command:"cd .."},f.ctx())).isError).not.toBe(true);expect(f.calls).toHaveLength(2);
  expect((await f.run({command:"true",timeout:0.1})).isError).not.toBe(true);expect(f.calls[2]!.timeoutMs).toBe(1);
});
test("missing/forged object capabilities and local posture never enter guest or local fallback",async()=>{
  const f=fixture();
  const unbound = { ...f.deps, cwd:f.deps.getCwd(), tempDir:"/forbidden" } as unknown as ToolExecutionContext;
  expect((await bashExecutor.execute({command:"danger"},unbound)).output).toContain("binding_missing");
  expect((await buildRegistryToolExecutor({...f.deps,guestFiles:{...f.deps.guestFiles!}}).execute({id:"x",name:"Bash",input:{command:"danger"}})).output).toContain("binding_invalid");
  expect((await buildRegistryToolExecutor({...f.deps,executionPosture:"local"}).execute({id:"x",name:"Bash",input:{command:"danger"}})).output).toContain("posture_mismatch");
  expect(f.calls).toHaveLength(0);
});
test("unsupported lifecycle/escape, invalid input, inadmissible cwd and pre-admission abort cause no port effects",async()=>{
  const f=fixture();
  for(const [input,code] of [[{command:"x",run_in_background:true},"background_unsupported"],[{command:"x",dangerouslyDisableSandbox:true},"escape_denied"],[{command:"x",timeout:-1},"invalid_request"],[{command:"x\0"},"invalid_command"],[{command:"x".repeat(65537)},"invalid_command"]] as const)expect((await f.run(input)).output).toContain(code);
  const ctx=f.ctx();ctx.cwd="/protected/runtime";expect((await bashExecutor.execute({command:"danger"},ctx)).output).toContain("cwd_denied");
  const abort=new AbortController();abort.abort();expect((await f.run({command:"danger"},abort.signal)).output).toContain("aborted");expect(f.calls).toHaveLength(0);
});
test("lost/stale/invalid acknowledgments are uncertain and never replay commands or leak errors",async()=>{
  const f=fixture();f.port.execute=async()=>{throw new Error("secret transport failure");};
  let result=await f.run({command:"effect"});expect(result.output).toContain("do not replay automatically");expect(result.output).not.toContain("secret");
  const stale=fixture();stale.respond(request=>({...stale.receipt(request),authority:{...request.authority,grantRevision:99}}));
  result=await stale.run({command:"effect"});expect(result.output).toContain("binding_mismatch");expect(result.output).toContain("do not replay automatically");expect(stale.calls).toHaveLength(1);
  for(const patch of [{stdoutBase64:"A==="},{stdoutBase64:"Zg==",stderrBase64:Buffer.alloc(1024).toString("base64")},{exitCode:999},{termination:"cancelled"}]){
    const malformed=fixture();malformed.respond(request=>malformed.receipt(request,patch));
    expect((await malformed.run({command:"effect"})).output).toContain("do not replay automatically");expect(malformed.calls).toHaveLength(1);
  }
});
test("typed prelaunch authority denial is certain; unknown denial remains uncertain",async()=>{
  for(const [code,uncertain] of [["authority_denied",false],["postlaunch_crash",true]] as const){
    const f=fixture();f.respond(request=>({...f.receipt(request),exitCode:1,stdout:JSON.stringify({version:1,ok:false,code,errno:1})}));
    const result=await f.run({command:"effect"});expect(result.isError).toBe(true);expect(result.output.includes("do not replay automatically")).toBe(uncertain);
  }
});
test("timeout, output limit and real nonzero shell exits report confirmed outcomes",async()=>{
  for(const patch of [{exitCode:137,termination:"timeout"},{exitCode:137,termination:"output_limit"},{exitCode:7,termination:"exit"}]){
    const f=fixture();f.respond(request=>f.receipt(request,patch));const result=await f.run({command:"effect"});
    expect(result.isError).toBe(true);expect(result.output).not.toContain("do not replay automatically");
    if(patch.termination!=="exit")expect(result.output).toContain(patch.termination);
  }
});
test("every authority field and invocation UUID bind the receipt before confirming shell effects",async()=>{
  for(const key of ["workspaceId","sessionId","incarnationId","leaseEpoch","configRevision","grantRevision","policyRevision"] as const){
    const f=fixture();f.respond(request=>({...f.receipt(request),authority:{...request.authority,[key]:typeof request.authority[key]==="number"?99:"foreign"}}));
    expect((await f.run({command:"effect"})).output).toContain("binding_mismatch");expect(f.calls).toHaveLength(1);
  }
  const f=fixture();f.respond(request=>({...f.receipt(request),requestId:"wrong"}));
  expect((await f.run({command:"effect"})).output).toContain("binding_mismatch");expect(f.calls).toHaveLength(1);
});
test("large confirmed output truncates inline without trusted overflow storage and documents initial-cwd semantics",async()=>{
  const f=fixture(32768);f.respond(request=>f.receipt(request,{stdoutBase64:Buffer.from("x".repeat(30001)).toString("base64")}));
  const result=await f.run({command:"effect"});expect(result.isError).not.toBe(true);expect(result.output).toContain("inline output truncated");
  expect(result.output).toContain("cwd changes apply to this command only");expect(result.output.length).toBeLessThan(30200);
});

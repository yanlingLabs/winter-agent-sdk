import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistryToolExecutor, type RegistryToolExecutorDeps } from "../tools/registry.ts";
import "../tools/impl/index.ts";
import { createLinuxSupervisorSession } from "./supervisor-client.ts";

const authority = { workspaceId: "workspace", sessionId: "session", incarnationId: "boot", leaseEpoch: 1, configRevision: 1, grantRevision: 1, policyRevision: 1 };
const roots = [{ id: "source", guestPath: "/workspace/folders/source", readOnly: false }];
const directories: string[] = [], servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); for (const dir of directories.splice(0)) rmSync(dir,{recursive:true,force:true}); });
async function wire(respond: (envelope: any) => unknown | undefined, scope=authority, endpoint="s.sock", reserve?: (envelope: any) => unknown) {
  const directory=mkdtempSync(join(tmpdir(),"w-svc-"));directories.push(directory);
  const path=join(directory,endpoint),calls:any[]=[];
  const server=createServer(socket=>{let data=Buffer.alloc(0);socket.on("error",()=>{});socket.on("data",incoming=>{const chunk=typeof incoming==="string"?Buffer.from(incoming):incoming;
    data=Buffer.concat([data,chunk]);if(data.length<4 || data.length<data.readUInt32BE(0)+4)return;
    const envelope=JSON.parse(data.subarray(4).toString());if(envelope.kind!=="reserve")calls.push(envelope);const value=envelope.kind==="reserve"?(reserve ? reserve(envelope) : {protocolVersion:1,requestId:envelope.request.requestId,authority:envelope.request.authority,ticket:"00000000-0000-4000-8000-000000000001"}):respond(envelope);if(value===undefined)return;
    const body=Buffer.from(JSON.stringify(value)),frame=Buffer.alloc(4+body.length);frame.writeUInt32BE(body.length,0);body.copy(frame,4);
    socket.write(frame.subarray(0,2));socket.end(frame.subarray(2));
  });});servers.push(server);await new Promise<void>(resolve=>server.listen(path,resolve));
  const guest=createLinuxSupervisorSession({socketPath:path,authority:scope,roots,toolUid:10001,maxBytes:1024,maxOutputBytes:1024});return {guest,calls};
}
test("private framed client feeds existing guest file/process receipt validators",async()=>{
  const f=await wire(({kind,request})=>({protocolVersion:1,requestId:request.requestId,authority:request.authority,exitCode:0,stdout:JSON.stringify(kind==="file"?{version:1,ok:true,bytes:5,dataBase64:Buffer.from("hello").toString("base64"),fileVersion:"1:2:5:1:000000000:1:000000000",mtimeMs:1}:{version:1,ok:true,exitCode:7,termination:"exit",stdoutBase64:Buffer.from("out").toString("base64"),stderrBase64:""})}));
  expect(new TextDecoder().decode((await f.guest.read("/workspace/folders/source/file")).bytes)).toBe("hello");
  expect(await f.guest.executeProcess!("exit 7","/workspace/folders/source",1000)).toEqual({stdout:"out",stderr:"",exitCode:7,termination:"exit"});
  expect(f.calls.map(call=>call.kind)).toEqual(["file","process"]);expect(f.calls[0].request).toMatchObject({authority,expectedUid:10001,relativePath:"file"});
  expect(f.calls[1].request).not.toHaveProperty("env");expect(f.calls[1].request).not.toHaveProperty("argv");
});
test("supervisor uncertain/error replies cannot become a successful file mutation",async()=>{
  const f=await wire(()=>({error:"effects_uncertain",privateDetail:"must not leak"}));
  await expect(f.guest.write("/workspace/folders/source/file",new TextEncoder().encode("change"),"absent")).rejects.toMatchObject({effectsUncertain:true});expect(f.calls).toHaveLength(1);
});
test("private client cancels without retrying or accepting a later response",async()=>{
  const f=await wire(()=>undefined),abort=new AbortController();const operation=f.guest.executeProcess!("sleep 1","/workspace/folders/source",2000,abort.signal);await Bun.sleep(10);abort.abort();
  await expect(operation).rejects.toMatchObject({effectsUncertain:true});expect(f.calls).toHaveLength(1);
});

test("actual registry binds backend authority independently of the logical conversation endpoint",async()=>{
 const backend={...authority,sessionId:"backend-1"};
 const f=await wire(({request})=>({protocolVersion:1,requestId:request.requestId,authority:request.authority,exitCode:0,stdout:JSON.stringify({version:1,ok:true,bytes:5,dataBase64:Buffer.from("hello").toString("base64"),fileVersion:"1:2:5:1:000000000:1:000000000",mtimeMs:1})}),backend,"logical-1.sock");
 const forbidden=()=>{throw new Error("runtime filesystem consumer reached");};
 const deps:RegistryToolExecutorDeps={executionPosture:"confined-guest",guestFiles:f.guest,sessionId:"backend-1",home:"/protected/runtime",getCwd:()=>roots[0]!.guestPath,getTempDir:forbidden,readState:{recordRead:forbidden,lookup:forbidden},probeReadAccess:forbidden,emitFrame(){},sandboxSettings:{},session:{setCwd:forbidden,addBoundedRoot:forbidden,removeBoundedRoot:forbidden,setPermissionMode:forbidden,getBoundedRoots:()=>[],getPermissionMode:()=>"default",getSessionRoot:()=>roots[0]!.guestPath,setSessionRoot:forbidden}};
 expect((await buildRegistryToolExecutor(deps).execute({id:"read",name:"Read",input:{file_path:"file"}})).output).toBe("hello");
 expect(f.calls[0].request.authority.sessionId).toBe("backend-1");
 const wrong=await buildRegistryToolExecutor({...deps,sessionId:"logical-conversation-1"}).execute({id:"wrong",name:"Read",input:{file_path:"file"}});
 expect(wrong.output).toContain("binding_invalid");expect(f.calls).toHaveLength(1);
});

for (const phase of ["reserve", "effect"] as const) test(`capacity saturation at ${phase} is a no-effect refusal without retry`, async () => {
  let reservations = 0;
  const f = await wire(() => ({ error: "capacity_busy" }), authority, "s.sock", envelope => {
    reservations++;
    return phase === "reserve" ? { error: "capacity_busy" } : { protocolVersion: 1, requestId: envelope.request.requestId, authority: envelope.request.authority, ticket: "00000000-0000-4000-8000-000000000001" };
  });
  await expect(f.guest.write("/workspace/folders/source/file", new TextEncoder().encode("change"), "absent")).rejects.toMatchObject({ code: "capacity_busy", effectsUncertain: false });
  expect(reservations).toBe(1);
  expect(f.calls).toHaveLength(phase === "reserve" ? 0 : 1);
});
test("a reservation with changed authority never submits an effect", async () => {
  const f = await wire(() => { throw new Error("effect must not run"); }, authority, "s.sock", envelope => ({ protocolVersion: 1, requestId: envelope.request.requestId, authority: { ...authority, leaseEpoch: 2 }, ticket: "00000000-0000-4000-8000-000000000001" }));
  await expect(f.guest.write("/workspace/folders/source/file", new TextEncoder().encode("change"), "absent")).rejects.toMatchObject({ effectsUncertain: true });
  expect(f.calls).toHaveLength(0);
});

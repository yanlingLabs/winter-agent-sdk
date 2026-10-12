import { expect, test } from "bun:test";
import { createGuestFileSession, bindGuestFileSession } from "./file-session.ts";
import { imagePrepWorkRoot } from "../tools/image-prep.ts";
import { mcpResultWithImages } from "../mcp/lifecycle.ts";
import { buildRegistryToolExecutor, buildRegistryToolExecutorWithFallback, getRegisteredTool, type RegistryToolExecutorDeps, type ToolExecutionContext } from "../tools/registry.ts";
import type { GuestFileRequest, GuestFileHelperPort } from "./file-helper.ts";
import "../tools/impl/index.ts";

const authority = {workspaceId:"workspace",sessionId:"guest-session",incarnationId:"boot",leaseEpoch:1,configRevision:1,grantRevision:1,policyRevision:1};
function fixture({ readOnly = false, probe = "silent" as "silent" | "deny" } = {}) {
  const calls: GuestFileRequest[] = [], files = new Map<string,{content:string,version:number,inode:number}>(), aliases = new Map<string,string>();
  let nextInode = 10;
  let beforeWrite: (() => void) | undefined, disconnect = false;
  function put(path: string, content: string) { files.set(path,{content,version:(files.get(path)?.version ?? 0)+1,inode:files.get(path)?.inode ?? nextInode++}); }
  function version(value: {version:number;content:string;inode:number}) { return `1:${value.inode}:${Buffer.byteLength(value.content)}:1:000000000:1:${String(value.version).padStart(9,"0")}`; }
  const port: GuestFileHelperPort = { async execute(request) {
    calls.push(request); const requestedPath = `${request.root.guestPath}/${request.relativePath}`, path = aliases.get(requestedPath) ?? requestedPath;
    const reply = (body: unknown, exitCode = 0) => ({protocolVersion:1,requestId:request.requestId,authority:request.authority,exitCode,stdout:JSON.stringify(body)});
    if (request.operation !== "read") {
      beforeWrite?.();
      const previous = files.get(path);
      if ((request.expectedFileVersion === "absent" && previous) || (request.expectedFileVersion !== "absent" && (!previous || request.expectedFileVersion !== version(previous)))) return reply({version:1,ok:false,code:"file_changed",errno:11},1);
      put(path,Buffer.from(request.dataBase64!,"base64").toString());
      if (disconnect) throw new Error("private transport secret must not enter output");
    }
    const value = files.get(path);
    if (!value) return reply({version:1,ok:false,code:"path_denied",errno:2},1);
    const bytes = Buffer.from(value.content);
    return reply({version:1,ok:true,bytes:bytes.length,fileVersion:version(value),mtimeMs:1,...(request.operation==="read"?{dataBase64:bytes.toString("base64")}:{})});
  }};
  const guest = createGuestFileSession({authority,roots:[{id:"source",guestPath:"/workspace/source",readOnly}],expectedUid:10001,port,maxBytes:1024*1024,probeReadAccess:()=>probe});
  const forbidden = () => { throw new Error("runtime-side filesystem/context consumer reached"); };
  const deps: RegistryToolExecutorDeps = {executionPosture:"confined-guest",guestFiles:guest,home:"/protected/runtime",sessionId:authority.sessionId,getCwd:()=>"/workspace/source",readState:{recordRead:forbidden,lookup:forbidden},getTempDir:forbidden,probeReadAccess:forbidden,emitFrame:()=>{},sandboxSettings:{},session:{setCwd:forbidden,addBoundedRoot:forbidden,removeBoundedRoot:forbidden,setPermissionMode:forbidden,getBoundedRoots:()=>[],getPermissionMode:()=>"default",getSessionRoot:()=>"/workspace/source",setSessionRoot:forbidden}};
  const executor=buildRegistryToolExecutor(deps);
  const run=(name:string,input:unknown)=>executor.execute({id:`call-${calls.length}`,name,input});
  const ctx=():ToolExecutionContext=>{const value={...deps,cwd:"/workspace/source",permissions:{probeReadAccess:forbidden},tempDir:"/forbidden"} as unknown as ToolExecutionContext;bindGuestFileSession(value,guest);return value;};
  return {calls,files,put,run,guest,deps,ctx,port,alias:(path:string,target:string)=>aliases.set(path,target),beforeWrite:(value:()=>void)=>beforeWrite=value,disconnect:()=>disconnect=true};
}
test("actual registry Read then Edit/Write use protected helper, preserve literal bytes and read history", async()=>{
  const f=fixture();f.put("/workspace/source/file.txt","hello 雪\n");
  expect((await f.run("Read",{file_path:" file.txt "})).output).toBe("hello 雪\n");
  const edit=await f.run("Edit",{file_path:"file.txt",old_string:"hello",new_string:"$HOME $$"});expect(edit.isError).not.toBe(true);
  expect(f.files.get("/workspace/source/file.txt")?.content).toBe("$HOME $$ 雪\n");
  const write=await f.run("Write",{file_path:"file.txt",content:"complete\n"});expect(write.isError).not.toBe(true);
  expect(f.calls.map(call=>call.operation)).toEqual(["read","read","write-check","read","write-check"]);
  expect(f.guest.readState.lookup("/workspace/source/file.txt")).toMatchObject({complete:true,fileVersion:expect.any(String)});
});
test("strict unread/partial overwrite refusals preserve source; bounded text continuation preserves completeness",async()=>{
  const f=fixture();f.put("/workspace/source/file.txt","one\ntwo\nthree");
  expect((await f.run("Edit",{file_path:"file.txt",old_string:"one",new_string:"new"})).isError).toBe(true);
  expect((await f.run("Read",{file_path:"file.txt",limit:1})).output).toBe("one");
  expect((await f.run("Write",{file_path:"file.txt",content:"clobber"})).isError).toBe(true);
  expect(f.calls.every(call=>call.operation==="read")).toBe(true);
  expect(f.guest.readState.lookup("/workspace/source/file.txt")?.complete).toBe(false);
});
test("same mtime replacement is drift; unique permitted Edit rescues while Write requires fresh Read",async()=>{
  const f=fixture();f.put("/workspace/source/file","hello");await f.run("Read",{file_path:"file"});f.put("/workspace/source/file","hello changed");
  expect((await f.run("Write",{file_path:"file",content:"wrong"})).isError).toBe(true);
  expect((await f.run("Edit",{file_path:"file",old_string:"hello",new_string:"updated"})).isError).not.toBe(true);
  expect(f.files.get("/workspace/source/file")?.content).toBe("updated changed");
  const denied=fixture({probe:"deny"});denied.put("/workspace/source/file","hello");await denied.run("Read",{file_path:"file"});denied.put("/workspace/source/file","hello changed");
  expect((await denied.run("Edit",{file_path:"file",old_string:"hello",new_string:"updated"})).isError).toBe(true);
});
test("new Write uses absence condition; change between snapshot and write leaves concurrent source untouched",async()=>{
  const f=fixture();expect((await f.run("Write",{file_path:"new",content:"new source"})).isError).not.toBe(true);
  expect(f.calls.at(-1)?.expectedFileVersion).toBe("absent");
  await f.run("Read",{file_path:"new"});f.beforeWrite(()=>f.put("/workspace/source/new","concurrent"));
  expect((await f.run("Edit",{file_path:"new",old_string:"new",new_string:"edit"})).output).toContain("file_changed");
  expect(f.files.get("/workspace/source/new")?.content).toBe("concurrent");
});
test("readonly, outside roots, missing object capability and unknown posture never fall back to runtime fs",async()=>{
  const f=fixture({readOnly:true});expect((await f.run("Write",{file_path:"new",content:"denied"})).output).toContain("read_only");
  const attempts=f.calls.length;expect((await f.run("Read",{file_path:"../../protected/store"})).output).toContain("path_denied");expect(f.calls.length).toBe(attempts);
  const plain={...f.ctx(),executionPosture:"confined-guest"} as ToolExecutionContext;
  expect((await getRegisteredTool("Read")!.executor!.execute({file_path:"file"},plain)).output).toContain("binding_missing");
  const forged={...f.deps,guestFiles:{...f.guest}};expect((await buildRegistryToolExecutor(forged).execute({id:"x",name:"Read",input:{file_path:"file"}})).output).toContain("binding_invalid");
  const unknown={...f.deps,executionPosture:"unrecognized" as "local"};expect((await buildRegistryToolExecutor(unknown).execute({id:"x",name:"Read",input:{file_path:"file"}})).output).toContain("posture_invalid");
});
test("unsupported tools, images, notebooks and diagnostic routes fail before helper/runtime filesystem access",async()=>{
  const f=fixture();for(const name of ["Glob","Grep","NotebookEdit","Bash","Workflow","TaskOutput","LSP","CronCreate","custom-file-consumer"]) expect((await f.run(name,{})).output).toContain("guest_tool_unsupported");
  for(const path of ["image.png","document.pdf","cells.ipynb"]) expect((await f.run("Read",{file_path:path})).output).toContain("guest_file_type_unsupported");
  expect(f.calls).toHaveLength(0);
  expect(() => imagePrepWorkRoot(f.ctx())).toThrow("guest image conversion");
  expect((await mcpResultWithImages([{type:"image",data:"invalid",mimeType:"image/png"}],false,f.ctx(),"fixture","image")).output).toContain("guest_tool_unsupported");
  for(const name of ["Glob","Grep","NotebookEdit","Bash","Workflow","TaskOutput"]) expect((await getRegisteredTool(name)!.executor!.execute({},f.ctx())).output).toContain("guest_tool_unsupported");
  const fallback=buildRegistryToolExecutorWithFallback(f.deps,{execute:async()=>{throw new Error("fallback must not run");}});
  expect((await fallback.execute({id:"x",name:"custom-file-consumer",input:{}})).output).toContain("guest_tool_unsupported");
});
test("lost write response is uncertain, never replayed, and does not claim successful read state",async()=>{
  const f=fixture();f.disconnect();const result=await f.run("Write",{file_path:"new",content:"applied but ack lost"});
  expect(result.isError).toBe(true);expect(result.output).toContain("do not replay automatically");expect(result.output).not.toContain("secret");
  expect(f.calls.filter(call=>call.operation!=="read")).toHaveLength(1);expect(f.guest.readState.lookup("/workspace/source/new")).toBeUndefined();
});

test("in-root descriptor alias shares a prior complete Read without runtime realpath", async () => {
  const f = fixture(); f.put("/workspace/source/real", "before"); f.alias("/workspace/source/link", "/workspace/source/real");
  await f.run("Read", { file_path: "real" });
  expect((await f.run("Edit", { file_path: "link", old_string: "before", new_string: "after" })).isError).not.toBe(true);
  expect(f.files.get("/workspace/source/real")?.content).toBe("after");
  expect((await f.run("Write", { file_path: "real", content: "authored next" })).isError).not.toBe(true);
});
test("missing parent creation returns unsupported without a runtime mkdir fallback", async () => {
  const f = fixture(); f.port.execute = async request => ({ protocolVersion:1,requestId:request.requestId,authority:request.authority,exitCode:1,stdout:'{"version":1,"ok":false,"code":"path_denied","errno":2}' });
  expect((await f.run("Write", { file_path: "missing/child", content: "new" })).output).toContain("guest_parent_creation_unsupported");
});

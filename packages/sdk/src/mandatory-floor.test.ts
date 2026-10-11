import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostCodeProcessRegistration } from "../../runtime/src/sandbox/host-code-broker.ts";
import { buildPwdCaptureScript } from "../../runtime/src/tools/bash-pwd-capture.ts";
import { query } from "./query.ts";
import type { HostCodeProcessStart } from "./host-code-process.ts";
import { defaultSpawn, type SpawnRuntimeOptions } from "./transport.ts";
import { applyMandatoryFloorToSpawnOptions, buildMandatoryFloorProfile, createMandatoryFloorSpawn, type HostExecutionFloor } from "./mandatory-floor.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const darwin = process.platform === "darwin";
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-mandatory-floor-"))); dirs.push(dir);
  const cowork = join(dir, "home", "cowork"); const coord = join(dir, "coord"); const source = join(dir, "source");
  const control = join(cowork, "workspaces", "w", "control"); const shared = join(cowork, "workspaces", "w", "shared");
  const ownRuntime = join(dir, "home", "cache", "runs", "own");
  for (const path of [control, shared, coord, source, ownRuntime]) mkdirSync(path, { recursive: true });
  const manifest = join(cowork, "workspaces", "w", "manifest.json");
  writeFileSync(manifest, "control-data"); writeFileSync(join(shared, "note.txt"), "shared-data"); writeFileSync(join(source, "ordinary.txt"), "ordinary-data");
  writeFileSync(join(cowork, "workspaces", "w", "data.ext4"), "synthetic-volume-bytes");
  writeFileSync(join(cowork, "workspaces", "w", "env.ext4"), "synthetic-environment-bytes");
  writeFileSync(join(source, "data.ext4"), "ordinary-volume-name");
  writeFileSync(join(control, "secret.txt"), "planted-floor-needle");
  symlinkSync(join(control, "secret.txt"), join(shared, "control-alias.txt"));
  symlinkSync(join(dir,"home"),join(dir,".winter"));
  const floor: HostExecutionFloor = { denyWritePaths: [cowork, coord], denyReadPaths: [control, coord], denyReadGlobs: [join(cowork, "workspaces", "*", "manifest.json"), join(cowork, "workspaces", "*", "*.ext4")], denyLinkPaths: [cowork], protectAncestorsOf: [cowork, coord] };
  const spawn = createMandatoryFloorSpawn({ spawn: defaultSpawn, floor });
  async function command(body: string, args: string[] = []) {
    const proc = spawn({ command: "/bin/sh", args: ["-c", body, "sh", ...args], cwd: source, env: { PATH: "/usr/bin:/bin", HOME: dir, WINTER_TEST_KEYCHAIN: "memory" } });
    let out = "", err = "";
    await Promise.all([ (async () => { for await (const chunk of proc.stdout) out += chunk; })(), (async () => { for await (const chunk of proc.stderr!) err += chunk; })() ]);
    return { ...(await proc.exited), out, err };
  }
  return { dir, source, cowork, coord, control, shared, manifest, ownRuntime, floor, command, spawn };
}

test("no registration is an identity-preserving no-op; floor is separate from editable settings", () => {
  const input: SpawnRuntimeOptions = { command: "inert", args: [], cwd: "/tmp", env: {} };
  expect(applyMandatoryFloorToSpawnOptions(input)).toBe(input);
  expect(applyMandatoryFloorToSpawnOptions(input, { denyReadPaths: [], denyWritePaths: [] })).toBe(input);
});
test("floor renders narrow wildcard reads, full writes/link floor and literal ancestor protection", () => {
  const profile = buildMandatoryFloorProfile({ denyReadPaths: [], denyWritePaths: ["/fixture/cowork"], denyReadGlobs: ["/fixture/cowork/workspaces/*/manifest.json", "/fixture/cowork/**/volume.ext4"] });
  expect(profile).toContain('(allow default)');
  expect(profile).toContain('workspaces/[^/]*/manifest\\.json$');
  expect(profile).toContain('cowork/(?:.*/)?volume\\.ext4$');
  expect(profile).toContain('deny file-link'); expect(profile).toContain('(literal "/fixture")');
  expect(() => buildMandatoryFloorProfile({ denyReadPaths: ["relative"], denyWritePaths: [] })).toThrow("absolute");
  expect(() => buildMandatoryFloorProfile({ denyReadPaths: [], denyWritePaths: [], denyReadGlobs: ["/fixture/{unsafe}"] })).toThrow("unsupported");
});
describe.skipIf(!darwin)("real macOS persistent floor, disposable files only", () => {
  test("control reads denied, shared reads allowed, own runtime/outside writes remain available", async () => {
    const f = fixture();
    for (const controlPath of [f.manifest, join(f.cowork, "workspaces", "w", "data.ext4"), join(f.cowork, "workspaces", "w", "env.ext4")]) {
      const denied = await f.command('/bin/cat "$1"', [controlPath]);
      expect(denied.code).not.toBe(0); expect(denied.err).toMatch(/Operation not permitted|Permission denied/);
    }
    const ordinaryVolume = await f.command('/bin/cat "$1"', [join(f.source, "data.ext4")]);
    expect(ordinaryVolume.code).toBe(0); expect(ordinaryVolume.out).toBe("ordinary-volume-name");
    const shared = await f.command('/bin/cat "$1"', [join(f.shared, "note.txt")]);
    expect(shared.code).toBe(0); expect(shared.out).toBe("shared-data");
    const outside = await f.command('printf allowed > "$1"; printf own > "$2"; /bin/cat "$1" "$2"', [join(f.source, "outside.txt"), join(f.ownRuntime, "transcript.jsonl")]);
    expect(outside.code).toBe(0); expect(outside.out).toBe("allowedown");
  });
  test("new hardlink aliases to readable fenced shared data fail; ordinary hardlinks still work", async () => {
    const f = fixture();
    expect((await f.command('/bin/ln "$1" "$2"', [join(f.shared, "note.txt"), join(f.source, "bypass.txt")])).code).not.toBe(0);
    expect((await f.command('/bin/ln "$1" "$2"', [join(f.source, "ordinary.txt"), join(f.source, "ordinary-link.txt")])).code).toBe(0);
    expect((await f.command('/bin/ln "$1" "$2"', [join(f.source,"ordinary.txt"),join(f.control,"outside-link.txt")])).code).not.toBe(0);
    expect((await f.command('/bin/cat "$1"',[join(f.shared,"control-alias.txt")])).code).not.toBe(0);
  });
  test("descendant computed-path reads and ancestor rename/chmod cannot remove the floor", async () => {
    const f = fixture();
    expect((await f.command(`/bin/sh -c 'p=$1; /bin/cat "$p"' sh "$1"`, [f.manifest])).code).not.toBe(0);
    expect((await f.command('/bin/mv "$1" "$2"', [join(f.dir, "home"), join(f.dir, "moved-home")])).code).not.toBe(0);
    expect((await f.command('/bin/chmod 0777 "$1"', [join(f.dir, "home")])).code).not.toBe(0);
    const nested = await f.command(`/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/cat "$1"`, [f.manifest]);
    expect(nested.code).not.toBe(0);
    expect(nested.err).toContain("sandbox_apply");
    expect((await f.command('/bin/rm -rf "$1"',[join(f.dir,"home")])).code).not.toBe(0);
    expect(existsSync(f.manifest)).toBe(true);
    const upperVolume=join(f.cowork,"workspaces","w","DATA.EXT4");
    if(existsSync(upperVolume))expect((await f.command('/bin/cat "$1"',[upperVolume])).code).not.toBe(0);
    const upperAlias=join(f.dir,".WINTER","cowork","workspaces","w","manifest.json");
    if(existsSync(upperAlias))expect((await f.command('/bin/cat "$1"',[upperAlias])).code).not.toBe(0);
  });
  test("actual SDK Grep/Glob rooted above storage hide protected files and retain shared hits", async()=>{
    const f=fixture();
    const secretPaths=[f.manifest,join(f.cowork,"workspaces","w","data.ext4"),join(f.cowork,"workspaces","w","env.ext4"),join(f.control,"secret.txt")];
    for(const path of secretPaths)writeFileSync(path,"planted-floor-needle");
    writeFileSync(join(f.shared,"note.txt"),"planted-floor-needle");
    const impl=fileURLToPath(new URL("../../runtime/src/tools/impl/",import.meta.url));
    const registry=fileURLToPath(new URL("../../runtime/src/tools/registry.ts",import.meta.url));
    const script=`import ${JSON.stringify(join(impl,"grep.ts"))};import ${JSON.stringify(join(impl,"glob.ts"))};import {getRegisteredTool} from ${JSON.stringify(registry)};
const ctx={cwd:${JSON.stringify(join(f.dir,"home"))},home:${JSON.stringify(f.dir)},permissions:{probeReadAccess:()=>"silent"}};
const grep=await getRegisteredTool('Grep').executor.execute({pattern:'planted-floor-needle',output_mode:'files_with_matches'},ctx);
const glob=await getRegisteredTool('Glob').executor.execute({pattern:'**/*'},ctx);
const volumes=await getRegisteredTool('Glob').executor.execute({pattern:'**/data.ext4'},ctx);
console.log(JSON.stringify({grep,glob,volumes}));`;
    const child=f.spawn({command:process.execPath,args:["-e",script],cwd:f.source,env:{PATH:"/usr/bin:/bin",HOME:f.dir,WINTER_TEST_KEYCHAIN:"memory"}});
    let out="",err="";await Promise.all([(async()=>{for await(const chunk of child.stdout)out+=chunk})(),(async()=>{for await(const chunk of child.stderr!)err+=chunk})()]);
    expect((await child.exited).code,err).toBe(0);
    const results=JSON.parse(out);
    expect(results.grep.isError,JSON.stringify(results)).toBeUndefined();expect(results.glob.isError,JSON.stringify(results)).toBeUndefined();
    expect(results.grep.output).toContain(join(f.shared,"note.txt"));expect(results.glob.output).toContain(join(f.shared,"note.txt"));
    for(const path of secretPaths){expect(results.grep.output).not.toContain(path);expect(results.glob.output).not.toContain(path);}
    expect(results.volumes.output).toBe("");
  });
  test("real SDK sandboxed, disabled, excluded and override Bash descendants retain the persistent floor", async () => {
    const f = fixture();
    const module = fileURLToPath(new URL("../../runtime/src/sandbox/spawn.ts", import.meta.url));
    const brokerModule = fileURLToPath(new URL("../../runtime/src/sandbox/host-code-process.ts", import.meta.url));
    const rpcModule = fileURLToPath(new URL("../../runtime/src/rpc/bridge.ts", import.meta.url));
    const commands = {
      deny: `/bin/cat '${f.manifest}'`,
      allow: `/bin/cat '${join(f.source, "ordinary.txt")}'`,
      write: `printf harmless > '${join(f.source, "ordinary-write.txt")}'`,
    };
    const registration = createHostCodeProcessRegistration({ generationId: "fixture-generation", async resolveCurrentContext(request, context) {
      if (context.callerSessionId !== "fixture-session" || request.cwd !== f.source) throw new Error("foreign fixture caller");
      const [mode, operation] = request.toolUseId.split(":");
      if (request.command !== commands[operation as keyof typeof commands]) throw new Error("not an active fixture command");
      const settings = mode === "disabled" ? { enabled: false } : mode === "excluded" ? { excludedCommands: [request.command], allowUnsandboxedCommands: true } : { enabled: true };
      return { scope: { generationId: "fixture-generation", sessionId: "fixture-session", toolUseId: request.toolUseId }, floor: f.floor,
        commandOptions: { cwd: f.source, env: { PATH: "/usr/bin:/bin", HOME: f.dir }, timeoutMs: 2000, settings, ...(mode === "override" ? { dangerouslyDisableSandbox: true } : {}) } };
    } });
    const script = `import {runCommand} from ${JSON.stringify(module)};
import {createHostCodeProcessClient,installHostCodeProcessClient} from ${JSON.stringify(brokerModule)};
import {createRpcBridge} from ${JSON.stringify(rpcModule)};
const bridge=createRpcBridge({write(frame){process.stdout.write(JSON.stringify(frame)+'\\n')},end(){}});
let carry='';
(async()=>{for await(const chunk of process.stdin){carry+=chunk.toString();for(;;){const i=carry.indexOf('\\n');if(i<0)break;const line=carry.slice(0,i);carry=carry.slice(i+1);if(line)bridge.handleResponse(JSON.parse(line));}}})();
installHostCodeProcessClient({client:createHostCodeProcessClient(bridge),generationId:'fixture-generation'});
const commands=${JSON.stringify(commands)};const rows=[];
for(const mode of ['sandboxed','disabled','excluded','override']) {
  const run=async(operation)=>runCommand({command:commands[operation],cwd:${JSON.stringify(f.source)},env:{},timeoutMs:2000,settings:{enabled:false},
    hostCodeScope:{sessionId:'fixture-session',toolUseId:mode+':'+operation}});
  const deny=await run('deny');const permit=await run('allow');const write=await run('write');
  rows.push({mode,denied:deny.exitCode!==0,allowed:permit.exitCode===0,writable:write.exitCode===0,posture:permit.posture});
}
process.stdout.write(JSON.stringify({fixtureResult:rows})+'\\n');process.exit(0);`;
    const child = f.spawn({ command: process.execPath, args: ["-e", script], cwd: f.source, env: { PATH: "/usr/bin:/bin", HOME: f.dir, WINTER_TEST_KEYCHAIN: "memory" } });
    let stdout = "", stderr = "", carry = "";
    await Promise.all([(async () => {
      for await (const chunk of child.stdout) {
        carry += chunk;
        for (;;) {
          const index = carry.indexOf("\n"); if (index < 0) break;
          const frame = JSON.parse(carry.slice(0, index)); carry = carry.slice(index + 1);
          if (frame.fixtureResult) { stdout = JSON.stringify(frame.fixtureResult); continue; }
          if (frame.type === "control_request") {
            void registration.handle(frame.subtype, frame.payload, { signal: new AbortController().signal, callerSessionId: "fixture-session", generationId: "fixture-generation" }).then(
              (payload) => child.stdin.write(JSON.stringify({ type: "control_response", requestId: frame.requestId, ok: true, payload }) + "\n"),
              () => child.stdin.write(JSON.stringify({ type: "control_response", requestId: frame.requestId, ok: false, error: { code: "refused", message: "fixture refused" } }) + "\n"),
            );
          }
        }
      }
    })(), (async () => { for await (const chunk of child.stderr!) stderr += chunk; })()]);
    registration.stopAll();
    expect((await child.exited).code, stderr).toBe(0);
    expect(JSON.parse(stdout), stderr).toEqual([
      { mode: "sandboxed", denied: true, allowed: true, writable: true, posture: "sandboxed" },
      { mode: "disabled", denied: true, allowed: true, writable: true, posture: "config-disabled" },
      { mode: "excluded", denied: true, allowed: true, writable: true, posture: "excluded" },
      { mode: "override", denied: true, allowed: true, writable: true, posture: "override-requested" },
    ]);
  });
  test("enrolled SDK grandchildren retain observed call correlation and execute Bash through the host broker",async()=>{
    const f=fixture();const commands=[`/bin/cat '${f.manifest}'`,`/bin/cat '${join(f.source,"ordinary.txt")}'`];
    const observed=new Map<string,{command:string;parentToolUseId:string}>();const admitted:HostCodeProcessStart[]=[];const attempts:HostCodeProcessStart[]=[];
    const registration=createHostCodeProcessRegistration({generationId:"nested-generation",async resolveCurrentContext(request,context){
      attempts.push(request);
      const call=observed.get(request.toolUseId);
      if(context.callerSessionId!=="nested-session" || !call || call.parentToolUseId!==request.parentToolUseId || call.command!==request.command || request.cwd!==f.source || !request.pwdCapturePath?.startsWith(f.dir+"/"))throw new Error("unobserved/foreign nested fixture call");
      admitted.push(request);
      return{scope:{generationId:"nested-generation",sessionId:"nested-session",toolUseId:request.toolUseId,...(request.agentId?{agentId:request.agentId}:{}),parentToolUseId:call.parentToolUseId},floor:f.floor,
        executionCommand:buildPwdCaptureScript(call.command,request.pwdCapturePath),commandOptions:{cwd:f.source,env:{PATH:"/bin:/usr/bin",HOME:f.dir},settings:{enabled:true},writableRoots:[f.source,f.dir],home:f.dir,timeoutMs:3000}};
    }});
    const testing=fileURLToPath(new URL("../../runtime/src/testing.ts",import.meta.url));
    const script=`import {inMemoryProcess} from ${JSON.stringify(testing)};
const commands=${JSON.stringify(commands)};
const provider={async generate(request){
 const users=request.messages.filter(message=>message.role==='user');const last=users.at(-1);const text=typeof last?.content==='string'?last.content:JSON.stringify(last?.content??[]);
 const ran=request.messages.some(message=>message.role==='tool');
 if(ran)return {kind:'text',text:'finished'};
 if(text.includes('GRANDCHILD-TASK'))return {kind:'tool_use',calls:commands.map((command,index)=>({id:'grandchild-bash-'+index,name:'Bash',input:{command}}))};
 if(text.includes('CHILD-TASK'))return {kind:'tool_use',calls:[{id:'inner-agent-call',name:'Agent',input:{description:'nested child',prompt:'GRANDCHILD-TASK',run_in_background:false}}]};
 return {kind:'tool_use',calls:[{id:'root-agent-call',name:'Agent',input:{description:'child',prompt:'CHILD-TASK',run_in_background:false}}]};
}};
const proc=inMemoryProcess(process.argv.slice(1),provider,undefined,{...process.env,WINTER_HOME:${JSON.stringify(f.ownRuntime)}});
void(async()=>{for await(const chunk of process.stdin)proc.stdin.write(chunk.toString());proc.stdin.end()})();
void(async()=>{for await(const chunk of proc.stderr)process.stderr.write(chunk)})();
for await(const chunk of proc.stdout)process.stdout.write(chunk);const exit=await proc.exited;process.exit(exit.code??1);`;
    const results:string[]=[];
    try{
      for await(const message of query({prompt:"root fixture",options:{sessionId:"nested-session",model:"winter-test/echo",cwd:f.source,permissionMode:"bypassPermissions",allowDangerouslySkipPermissions:true,persistSession:false,hostCodeProcessBroker:registration,
        spawnClaudeCodeProcess:options=>f.spawn({...options,command:process.execPath,args:["-e",script,"--",...options.args],env:{PATH:"/bin:/usr/bin",HOME:f.dir,WINTER_HOME:f.ownRuntime,WINTER_TMPDIR:f.dir,TMPDIR:f.dir,WINTER_TEST_KEYCHAIN:"memory",WINTER_DISABLE_GIT_INSTRUCTIONS:"1"}})}})){
        if(message.type==="assistant"){
          const parent=(message as {parent_tool_use_id?:string}).parent_tool_use_id;
          for(const block of message.message.content)if(block.type==="tool_use" && block.name==="Bash" && typeof block.id==="string")observed.set(block.id,{command:(block.input as {command:string}).command,parentToolUseId:parent??""});
        }
        // The runtime yields tool-result carrier frames; public SdkMessage's older union
        // omits that wire variant, so inspect it as a wire record for this regression.
        const carrier=message as unknown as {type:string;message?:{content?:Array<{type?:string}>}};
        if(carrier.type==="user")for(const block of carrier.message?.content??[])if(block.type==="tool_result")results.push(JSON.stringify(block));
      }
    }finally{registration.stopAll();}
    expect(observed.size).toBe(2);expect([...observed.values()].map(call=>call.parentToolUseId)).toEqual(["inner-agent-call","inner-agent-call"]);
    expect(admitted,JSON.stringify({attempts,results})).toHaveLength(2);expect(admitted.map(request=>request.parentToolUseId)).toEqual(["inner-agent-call","inner-agent-call"]);
    expect(results.join("\n")).toContain("ordinary-data");expect(results.join("\n")).toMatch(/Operation not permitted|Permission denied/);
  },15000);
});

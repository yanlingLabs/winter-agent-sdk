import { test, expect } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnEmbeddedWorker } from "../../../packages/runtime/src/embedded-host.ts";
const runtime=join(import.meta.dir,"../../../packages/runtime/src");
for(const topology of ["native","embedded"] as const) test(topology+" actual startup fences instruction imports",async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-startup-review-"))),cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork");
 for(const p of [cwd,home,denied])mkdirSync(p,{recursive:true});
 let worker:ReturnType<typeof spawnEmbeddedWorker>|undefined;
 let native:ReturnType<typeof Bun.spawn>|undefined;
 try{
  writeFileSync(join(denied,"private.ext4"),"PROTECTED-STARTUP-SYNTHETIC");
  symlinkSync(join(denied,"private.ext4"),join(home,"alias.md"));
  writeFileSync(join(home,"WINTER.md"),"ALLOWED-STARTUP-GUIDANCE\n@./alias.md");
  const config={sessionId:"source-startup-"+topology,cwd,winterHome:home,model:"winter-test/echo",persistSession:false,settingSources:["user"],...(topology==="native"?{sandbox:{filesystem:{denyRead:[denied]}}}:{})};
  const args=["--run","--config-json",JSON.stringify(config)];
  const env={PATH:"/usr/bin:/bin",HOME:home,WINTER_HOME:home,WINTER_DISABLE_GIT_INSTRUCTIONS:"1"};
  const input=JSON.stringify({type:"user",text:"fixture"})+"\n"+JSON.stringify({type:"control_request",requestId:"end",subtype:"end_input"})+"\n";
  let out="",err="",code;
  if(topology==="native"){
   native=Bun.spawn([process.execPath,join(runtime,"main.ts"),...args],{cwd,env,stdin:"pipe",stdout:"pipe",stderr:"pipe"});
   native.stdin.write(input);native.stdin.end();
   [out,err,code]=await Promise.all([new Response(native.stdout).text(),new Response(native.stderr).text(),native.exited]);
  }else{
   worker=spawnEmbeddedWorker({workerEntry:join(runtime,"embedded-worker.ts"),spawn:{command:"winter",args,cwd,env},hostCodeProtection:{revision:1,denyReadPaths:[denied],denyWritePaths:[]}});
   worker.stdin.write(input);
   await Promise.all([(async()=>{for await(const s of worker!.stdout)out+=s;})(),(async()=>{for await(const s of worker!.stderr!)err+=s;})()]);
   code=(await worker.exited).code;
  }
  expect(code,err).toBe(0);expect(out).toContain("ALLOWED-STARTUP-GUIDANCE");expect(out).not.toContain("PROTECTED-STARTUP-SYNTHETIC");
 }finally {if(native&&native.exitCode===null){native.kill();await native.exited;}if(worker){worker.kill();worker.terminate();await worker.exited;}rmSync(root,{recursive:true,force:true});}
},10000);

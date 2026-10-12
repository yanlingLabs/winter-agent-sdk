import { expect, test } from "bun:test";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { createHostCodePermissionEvaluator, type HostCodePermissionSnapshot, type HostCodePermissionRequest } from "./host-code.ts";
import { sourceRule } from "./ruleset.ts";
import { createAutoEngine } from "./auto/engine.ts";
const scope={generationId:"generation",sessionId:"session",toolUseId:"call"};
const request=(command="custom-build"):HostCodePermissionRequest=>({scope,toolName:"Bash",input:{command}});
function fixture(){let snapshot:HostCodePermissionSnapshot={scope,policyRevision:1,config:{permissionMode:"default",sandbox:{enabled:false}},cwd:"/synthetic/work",sessionRoot:"/synthetic/work",home:"/synthetic/home",winterHome:"/synthetic/runtime",trustedWorkspace:false,brand:WINTER_BRAND};const evaluator=createHostCodePermissionEvaluator({getCurrentSnapshot:()=>snapshot});return{evaluator,get snapshot(){return snapshot},set snapshot(value){snapshot=value}};}
test("host evaluator reuses standing allow and deny precedence without a prompt card",async()=>{
  const f=fixture();f.snapshot.config.permissions={allow:["Bash(custom-build)"]};expect((await f.evaluator.evaluate(request())).status).toBe("allow");
  f.snapshot.config.permissions.deny=["Bash(custom-build)"];f.snapshot.policyRevision++;expect((await f.evaluator.evaluate(request())).status).toBe("deny");
});
test("prepared project settings retain the existing trust gate",async()=>{
  const f=fixture();f.snapshot.settingsRules={entries:[sourceRule({toolName:"Bash",ruleContent:"custom-build"},"allow","project")],directories:[]};
  expect((await f.evaluator.evaluate(request())).status).toBe("needs_prompt");f.snapshot.trustedWorkspace=true;f.snapshot.policyRevision++;expect((await f.evaluator.evaluate(request())).status).toBe("allow");
});
test("exact host receipt clears an ask without duplicate cards; other input/epoch/cwd cannot reuse it",async()=>{
  const f=fixture();f.snapshot.config.permissions={ask:["Bash"]};const call=request();
  expect((await f.evaluator.evaluate(call)).status).toBe("needs_prompt");
  f.evaluator.recordPromptResult({...call,cwd:f.snapshot.cwd,policyRevision:1,result:{behavior:"allow"}});
  expect((await f.evaluator.evaluate(call)).status).toBe("allow");expect((await f.evaluator.evaluate(request("another-build"))).status).toBe("needs_prompt");
  f.snapshot.policyRevision++;expect((await f.evaluator.evaluate(call)).status).toBe("needs_prompt");
  expect(()=>f.evaluator.recordPromptResult({...call,cwd:f.snapshot.cwd,policyRevision:1,result:{behavior:"allow"}})).toThrow("stale");
  f.evaluator.recordPromptResult({...call,cwd:f.snapshot.cwd,policyRevision:2,result:{behavior:"allow"}});f.snapshot.cwd="/synthetic/elsewhere";expect((await f.evaluator.evaluate(call)).status).toBe("needs_prompt");
});
test("receipt cannot override a new deny or managed bypass prohibition",async()=>{
  const f=fixture();const call=request();f.evaluator.recordPromptResult({...call,cwd:f.snapshot.cwd,policyRevision:1,result:{behavior:"allow"}});
  f.snapshot.config.permissions={deny:["Bash"]};expect((await f.evaluator.evaluate(call)).status).toBe("deny");
  f.snapshot.config={permissionMode:"bypassPermissions",allowDangerouslySkipPermissions:true,permissions:{disableBypassPermissionsMode:true}};await expect(f.evaluator.evaluate(call)).rejects.toThrow();
});
test("real host auto engine/classifier is used; absent reviewer stays unresolved",async()=>{
  const f=fixture();f.snapshot.config.permissionMode="auto";f.snapshot.autoConfig={classifyAllShell:true};expect((await f.evaluator.evaluate(request())).status).toBe("deny");
  let reviewed=0;f.snapshot.autoEngine=createAutoEngine({sessionId:"session",classifier:{async classify(){reviewed++;return{verdict:"allow"}}}});
  expect((await f.evaluator.evaluate(request())).status).toBe("allow");expect(reviewed).toBe(1);
});
test("policy changes during host classification fence the delayed allow",async()=>{
  const f=fixture();f.snapshot.config.permissionMode="auto";f.snapshot.autoConfig={classifyAllShell:true};let finish!:(verdict:{verdict:"allow"})=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});
  f.snapshot.autoEngine=createAutoEngine({sessionId:"session",classifier:{classify:()=>new Promise(resolve=>{finish=resolve;entered()})}});
  const pending=f.evaluator.evaluate(request());await started;f.snapshot.policyRevision++;finish({verdict:"allow"});expect((await pending).status).toBe("stale");
});

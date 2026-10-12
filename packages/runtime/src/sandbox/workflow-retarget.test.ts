import {test,expect} from "bun:test";
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,symlinkSync,unlinkSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";import {join,dirname} from "node:path";
import {SkillIndex} from "../skills/store.ts";
import {installHostCodeProtection} from "../sandbox/host-code-protection.ts";
import {inheritSourceObject} from "../sandbox/source-read.ts";
import {listWorkflowsForListing,buildWorkflowSkillPrompt,resolveWorkflowByName} from "../workflows/store.ts";
test("synthetic refresh uses current declared name and removes stale identity",()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-workflow-name-review-"))),cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork"),alias=join(cwd,".winter/workflows/slot.js");for(const p of [home,denied,dirname(alias)])mkdirSync(p,{recursive:true});
 const a=join(denied,"A"),b=join(root,"B");writeFileSync(a,'export const meta={name:"source-secret-name",description:"original"};\nreturn 1;');writeFileSync(b,'export const meta={name:"safe-name",description:"safe"};\nreturn 2;');symlinkSync(a,alias);
 const workflows=listWorkflowsForListing({cwd,trustedWorkspace:true});
 const synthetic=workflows.map(w=>inheritSourceObject({name:w.name,description:w.description,source:w.source,path:w.path,body:buildWorkflowSkillPrompt(w)},w));
 const index=SkillIndex.build({cwd,winterHome:home,syntheticSkills:synthetic});const lease=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
 try{unlinkSync(alias);symlinkSync(b,alias);const current=index.list(),body=index.load("safe-name")?.body;const findings={cachedName:current[0]?.name,bodyContainsProtectedName:body?.includes("source-secret-name"),oldNameResolves:resolveWorkflowByName("source-secret-name",{cwd,trustedWorkspace:true}).ok,newNameResolves:resolveWorkflowByName("safe-name",{cwd,trustedWorkspace:true}).ok};expect(findings).toEqual({cachedName:"safe-name",bodyContainsProtectedName:false,oldNameResolves:false,newNameResolves:true});expect(index.get("source-secret-name")).toBeUndefined();expect(index.get(".winter:source-secret-name")).toBeUndefined();expect(index.get(".winter:safe-name")?.name).toBe("safe-name");expect(body).toContain('Workflow({ name: "safe-name" })');}finally{lease.close();rmSync(root,{recursive:true,force:true});}
});

test("synthetic refresh refuses replacement above normal workflow size cap",()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-workflow-name-review-"))),cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork"),alias=join(cwd,".winter/workflows/slot.js");for(const p of [home,denied,dirname(alias)])mkdirSync(p,{recursive:true});
 const a=join(denied,"A"),b=join(root,"B");writeFileSync(a,'export const meta={name:"source-secret-name",description:"original"};\nreturn 1;');writeFileSync(b,'export const meta={name:"source-secret-name",description:"safe"};\n//'+"x".repeat(524288));symlinkSync(a,alias);
 const workflows=listWorkflowsForListing({cwd,trustedWorkspace:true});
 const synthetic=workflows.map(w=>inheritSourceObject({name:w.name,description:w.description,source:w.source,path:w.path,body:buildWorkflowSkillPrompt(w)},w));
 const index=SkillIndex.build({cwd,winterHome:home,syntheticSkills:synthetic});const lease=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
 try{unlinkSync(alias);symlinkSync(b,alias);const current=index.list(),body=index.load("source-secret-name")?.body;const findings={freshListingCount:listWorkflowsForListing({cwd,trustedWorkspace:true}).length,cachedBodyExists:typeof body==="string",oldNameResolves:resolveWorkflowByName("source-secret-name",{cwd,trustedWorkspace:true}).ok};expect(findings).toEqual({freshListingCount:0,cachedBodyExists:false,oldNameResolves:false});writeFileSync(b,'export const meta={name:"safe-name",description:"allowed"};\nreturn 2;');expect(index.load("safe-name")?.body).toContain('Workflow({ name: "safe-name" })');}finally{lease.close();rmSync(root,{recursive:true,force:true});}
});

import { workflowSyntheticSkill } from "../workflows/store.ts";
import { FilesystemCommandResolver } from "../commands/resolver.ts";

test("refresh keeps normal workflow collisions and ordinary skill precedence", async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-workflow-collision-"))),cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork"),dir=join(cwd,".winter/workflows"),alias=join(dir,"a.js");
 for(const p of [home,denied,dir])mkdirSync(p,{recursive:true});
 const original=join(denied,"A"),replacement=join(root,"B");
 writeFileSync(original,'export const meta={name:"old-name",description:"old"};\nreturn 1;');
 writeFileSync(replacement,'export const meta={name:"winner",description:"replacement loser"};\nreturn 2;');
 writeFileSync(join(dir,"z.js"),'export const meta={name:"winner",description:"normal later-file winner"};\nreturn 3;');symlinkSync(original,alias);
 const opts={cwd,trustedWorkspace:true};
 const index=SkillIndex.build({cwd,winterHome:home,syntheticSkills:listWorkflowsForListing(opts).map(workflowSyntheticSkill)});
 const commands=FilesystemCommandResolver.build({cwd,winterHome:home,skills:index});
 const lease=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
 try{
  // Populate command enumeration before the retarget, under the same protection revision.
  expect(commands.list().map(entry=>entry.name)).toEqual(["winner"]);
  unlinkSync(alias);symlinkSync(replacement,alias);
  expect(index.list().map(entry=>entry.name)).toEqual(["winner"]);
  expect(index.load("winner")?.body).toContain("normal later-file winner");
  expect(index.load("winner")?.body).not.toContain("replacement loser");
  const resolved=resolveWorkflowByName("winner",opts);expect(resolved.ok).toBe(true);
  if(resolved.ok)expect(resolved.path).toBe(join(dir,"z.js"));
  writeFileSync(replacement,'export const meta={name:"fresh-name",description:"fresh"};\nreturn 2;');
  expect(commands.list().map(entry=>entry.name)).toContain("fresh-name");
  expect((await commands.resolve("/fresh-name",cwd) as {text:string}).text).toContain('Workflow({ name: "fresh-name" })');
  mkdirSync(join(cwd,".winter/skills/fresh-name"),{recursive:true});
  writeFileSync(join(cwd,".winter/skills/fresh-name/SKILL.md"),'---\ndescription: ordinary\n---\nORDINARY-SKILL-BODY');
  const ordinary=SkillIndex.build({cwd,winterHome:home,syntheticSkills:listWorkflowsForListing(opts).map(workflowSyntheticSkill)});
  expect(ordinary.load("fresh-name")?.isSynthetic).toBe(false);expect(ordinary.load("fresh-name")?.body).toBe("ORDINARY-SKILL-BODY");
 }finally{lease.close();rmSync(root,{recursive:true,force:true});}
});

test("plugin namespace and user/project source gates survive refresh",()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-workflow-gates-"))),cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork"),plugin=join(root,"plugin"),alias=join(plugin,"slot.js");
 for(const p of [cwd,home,denied,plugin])mkdirSync(p,{recursive:true});
 const original=join(denied,"A"),replacement=join(root,"B");writeFileSync(original,'export const meta={name:"old-name",description:"old"};\nreturn 1;');writeFileSync(replacement,'export const meta={name:"safe-name",description:"safe"};\nreturn 2;');symlinkSync(original,alias);
 const opts={cwd,winterHome:home,trustedWorkspace:false,settingSources:[] as [],pluginWorkflows:[{name:"p",workflowsPath:plugin}]};
 const index=SkillIndex.build({cwd,winterHome:home,settingSources:[],syntheticSkills:listWorkflowsForListing(opts).map(workflowSyntheticSkill)});
 const lease=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
 try{
  unlinkSync(alias);symlinkSync(replacement,alias);
  mkdirSync(join(cwd,".winter/workflows"),{recursive:true});mkdirSync(join(home,"workflows"),{recursive:true});
  writeFileSync(join(cwd,".winter/workflows/project.js"),'export const meta={name:"project",description:"blocked"};\nreturn 1;');
  writeFileSync(join(home,"workflows/user.js"),'export const meta={name:"user",description:"blocked"};\nreturn 1;');
  expect(index.names()).toEqual(["p:safe-name"]);expect(index.load("p:old-name")).toBeNull();expect(index.load("p:safe-name")?.body).toContain('Workflow({ name: "p:safe-name" })');
  expect(resolveWorkflowByName("p:safe-name",opts).ok).toBe(true);
 }finally{lease.close();rmSync(root,{recursive:true,force:true});}
});

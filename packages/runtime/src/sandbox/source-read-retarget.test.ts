import { test, expect } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { installHostCodeProtection } from "../sandbox/host-code-protection.ts";
import { loadRules, conditionalRuleAttachmentProducer } from "../context/rules.ts";
import { loadPlugins } from "../plugins/loader.ts";
import { pluginAgentDefinitions } from "../plugins/bundle.ts";
import { loadAgentDefinitions } from "../subagents/definitions.ts";
import { SkillIndex } from "../skills/store.ts";
test("cached source origins refuse old bytes after deny and symlink retarget", async () => {
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-source-cache-review-")));
 let lease: ReturnType<typeof installHostCodeProtection>|undefined;
 try {
  const cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork"),plugin=join(root,"plugin");
  for (const dir of [cwd,home,denied,plugin]) mkdirSync(dir,{recursive:true});
  const write=(p:string,s:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,s);return p;};
  const aliases=[join(cwd,".winter/rules/cache.md"),join(plugin,"agents/cache.md"),join(cwd,".winter/skills/cache/SKILL.md")];
  const contents=['---\npaths: ["**"]\n---\nRULE-SYNTHETIC-PROTECTED-BYTES','---\nname: cache\ndescription: test\n---\nAGENT-SYNTHETIC-PROTECTED-BYTES','---\ndescription: SKILL-SYNTHETIC-PROTECTED-BYTES\n---\nbody'];
  for(let i=0;i<aliases.length;i++){mkdirSync(dirname(aliases[i]!),{recursive:true});symlinkSync(write(join(denied,String(i)+".md"),contents[i]!),aliases[i]!);}
  const rules=loadRules({home,cwd,projectRoot:cwd,sources:["project"],brand:WINTER_BRAND});
  const producer=conditionalRuleAttachmentProducer(rules.conditional,{originalCwd:cwd});
  const pluginAgents=pluginAgentDefinitions(loadPlugins([{type:"local",path:plugin}]).bundles);
  const skills=SkillIndex.build({cwd,winterHome:home});
  lease=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
  expect(skills.names()).not.toContain("cache");
  const cleanContents=['---\npaths: ["**"]\n---\nALLOWED-RULE','---\nname: cache\ndescription: allowed\n---\nALLOWED-AGENT','---\ndescription: ALLOWED-SKILL\n---\nallowed body'];
  const cleanPaths=cleanContents.map((content,i)=>write(join(root,"allowed-"+i+".md"),content));
  for(let i=0;i<aliases.length;i++){unlinkSync(aliases[i]!);symlinkSync(cleanPaths[i]!,aliases[i]!);}
  const attachments=await producer({messages:[{role:"assistant",content:[{type:"tool_use",id:"x",name:"Read",input:{file_path:join(cwd,"a.ts")}}]}]} as any);
  const agents=loadAgentDefinitions({cwd,home,winterHome:home,trustedWorkspace:true,pluginAgents});
  const findings={rule:JSON.stringify(attachments).includes("RULE-SYNTHETIC-PROTECTED-BYTES"),agent:JSON.stringify([...agents]).includes("AGENT-SYNTHETIC-PROTECTED-BYTES"),skill:JSON.stringify(skills.list()).includes("SKILL-SYNTHETIC-PROTECTED-BYTES")};
  expect(findings).toEqual({rule:false,agent:false,skill:false});
  expect(JSON.stringify(attachments)).toContain("ALLOWED-RULE");
  expect(JSON.stringify([...agents])).toContain("ALLOWED-AGENT");
  expect(JSON.stringify(skills.list())).toContain("ALLOWED-SKILL");
  const other=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
  try {
    lease.update({revision:2,denyReadPaths:[],denyWritePaths:[]});
    for(let i=0;i<aliases.length;i++){unlinkSync(aliases[i]!);symlinkSync(join(denied,String(i)+".md"),aliases[i]!);}
    expect(skills.list()).toEqual([]);
    expect(loadAgentDefinitions({cwd,home,winterHome:home,trustedWorkspace:true,pluginAgents}).has("cache")).toBe(false);
  } finally {other.close();}
  expect(skills.load("cache")?.body).toBe("body");
  expect(loadAgentDefinitions({cwd,home,winterHome:home,trustedWorkspace:true,pluginAgents}).get("cache")?.prompt).toContain("AGENT-SYNTHETIC-PROTECTED-BYTES");
 } finally {lease?.close();rmSync(root,{recursive:true,force:true});}
});

import { pluginCommandContributions, pluginSkillContributions } from "../plugins/bundle.ts";
import { FilesystemCommandResolver } from "../commands/resolver.ts";
import { listWorkflowsForListing, buildWorkflowSkillPrompt } from "../workflows/store.ts";
import { inheritSourceObject } from "./source-read.ts";

test("plugin command/skill and synthetic workflow transformations retain original provenance", () => {
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-metadata-origin-")));
 let lease: ReturnType<typeof installHostCodeProtection>|undefined;
 try {
  const cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork"),plugin=join(root,"plugin");
  for(const dir of [cwd,home,denied,plugin])mkdirSync(dir,{recursive:true});
  const write=(p:string,s:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,s);return p;};
  const paths=[join(plugin,"commands/deploy.md"),join(plugin,"skills/cache/SKILL.md"),join(cwd,".winter/workflows/wf.js")];
  const bodies=['---\ndescription: COMMAND-ORIGINAL\nargument-hint: HINT-ORIGINAL\n---\noriginal command','---\ndescription: SKILL-ORIGINAL\n---\noriginal skill','export const meta = { name:"wf",description:"WORKFLOW-ORIGINAL",whenToUse:"WHEN-ORIGINAL" };\nreturn 1;'];
  const originals=paths.map((path,i)=>{mkdirSync(dirname(path),{recursive:true});const target=write(join(denied,i+".source"),bodies[i]!);symlinkSync(target,path);return target;});
  const bundles=loadPlugins([{type:"local",path:plugin}]).bundles;
  const workflows=listWorkflowsForListing({cwd,trustedWorkspace:true});
  const synthetic=workflows.map(w=>inheritSourceObject({name:w.name,description:w.description,source:w.source,path:w.path,body:buildWorkflowSkillPrompt(w)},w));
  const skills=SkillIndex.build({cwd,winterHome:home,plugins:pluginSkillContributions(bundles),syntheticSkills:synthetic});
  const resolver=FilesystemCommandResolver.build({cwd,winterHome:home,skills,plugins:pluginCommandContributions(bundles)});
  expect(JSON.stringify(resolver.list())).toContain("COMMAND-ORIGINAL");
  expect(skills.load("wf")?.body).toContain("WHEN-ORIGINAL");
  lease=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
  const replacements=['---\ndescription: COMMAND-ALLOWED\nargument-hint: HINT-ALLOWED\n---\nallowed command','---\ndescription: SKILL-ALLOWED\n---\nallowed skill','export const meta = { name:"wf",description:"WORKFLOW-ALLOWED",whenToUse:"WHEN-ALLOWED" };\nreturn 2;'];
  for(let i=0;i<paths.length;i++){unlinkSync(paths[i]!);symlinkSync(write(join(root,i+".replacement"),replacements[i]!),paths[i]!);}
  const listing=JSON.stringify(resolver.list());
  expect(listing).not.toContain("ORIGINAL");expect(listing).toContain("COMMAND-ALLOWED");expect(listing).toContain("SKILL-ALLOWED");
  expect(skills.load("wf")?.body).not.toContain("ORIGINAL");expect(skills.load("wf")?.body).toContain("WHEN-ALLOWED");
  expect(skills.load("plugin:cache")?.body).toBe("allowed skill");
  lease.update({revision:2,denyReadPaths:[],denyWritePaths:[]});
  for(let i=0;i<paths.length;i++){unlinkSync(paths[i]!);symlinkSync(originals[i]!,paths[i]!);}
  expect(skills.load("plugin:cache")?.body).toBe("original skill");
 } finally {lease?.close();rmSync(root,{recursive:true,force:true});}
});

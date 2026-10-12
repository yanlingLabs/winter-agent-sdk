import { test, expect } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { WINTER_BRAND } from "../../../packages/sdk/src/index.ts";
import { installHostCodeProtection } from "../../../packages/runtime/src/sandbox/host-code-protection.ts";
import { loadRules, conditionalRuleAttachmentProducer } from "../../../packages/runtime/src/context/rules.ts";
import { loadPlugins } from "../../../packages/runtime/src/plugins/loader.ts";
import { pluginAgentDefinitions } from "../../../packages/runtime/src/plugins/bundle.ts";
import { loadAgentDefinitions } from "../../../packages/runtime/src/subagents/definitions.ts";
import { SkillIndex } from "../../../packages/runtime/src/skills/store.ts";
test("reproduce cached source bytes surviving policy deny through symlink retarget", async () => {
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-source-cache-review-")));
 let lease: ReturnType<typeof installHostCodeProtection>|undefined;
 try {
  const cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork"),plugin=join(root,"plugin");
  for (const dir of [cwd,home,denied,plugin]) mkdirSync(dir,{recursive:true});
  const write=(p:string,s:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,s);return p;};
  const aliases=[join(cwd,".winter/rules/cache.md"),join(plugin,"agents/cache.md"),join(cwd,".winter/skills/cache/SKILL.md")];
  const contents=['---\npaths: ["**"]\n---\nRULE-SYNTHETIC-PROTECTED-BYTES','---\nname: cache\ndescription: test\n---\nAGENT-SYNTHETIC-PROTECTED-BYTES','---\ndescription: SKILL-SYNTHETIC-PROTECTED-BYTES\n---\nbody'];
  for(let i=0;i<aliases.length;i++){mkdirSync(dirname(aliases[i]),{recursive:true});symlinkSync(write(join(denied,String(i)+".md"),contents[i]),aliases[i]);}
  const rules=loadRules({home,cwd,projectRoot:cwd,sources:["project"],brand:WINTER_BRAND});
  const producer=conditionalRuleAttachmentProducer(rules.conditional,{originalCwd:cwd});
  const pluginAgents=pluginAgentDefinitions(loadPlugins([{type:"local",path:plugin}]).bundles);
  const skills=SkillIndex.build({cwd,winterHome:home});
  lease=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
  expect(skills.names()).not.toContain("cache");
  const clean=write(join(root,"allowed.md"),"---\ndescription: clean\n---\nclean");
  for(const alias of aliases){unlinkSync(alias);symlinkSync(clean,alias);}
  const attachments=await producer({messages:[{role:"assistant",content:[{type:"tool_use",id:"x",name:"Read",input:{file_path:join(cwd,"a.ts")}}]}]} as any);
  const agents=loadAgentDefinitions({cwd,home,winterHome:home,trustedWorkspace:true,pluginAgents});
  const findings={rule:JSON.stringify(attachments).includes("RULE-SYNTHETIC-PROTECTED-BYTES"),agent:JSON.stringify([...agents]).includes("AGENT-SYNTHETIC-PROTECTED-BYTES"),skill:JSON.stringify(skills.list()).includes("SKILL-SYNTHETIC-PROTECTED-BYTES")};
  console.log(JSON.stringify(findings));
  expect(findings).toEqual({rule:true,agent:true,skill:true});
 } finally {lease?.close();rmSync(root,{recursive:true,force:true});}
});

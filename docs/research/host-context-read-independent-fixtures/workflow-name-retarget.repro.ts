import {test,expect} from "bun:test";
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,symlinkSync,unlinkSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";import {join,dirname} from "node:path";
import {SkillIndex} from "../../../packages/runtime/src/skills/store.ts";
import {installHostCodeProtection} from "../../../packages/runtime/src/sandbox/host-code-protection.ts";
import {inheritSourceObject} from "../../../packages/runtime/src/sandbox/source-read.ts";
import {listWorkflowsForListing,buildWorkflowSkillPrompt,resolveWorkflowByName} from "../../../packages/runtime/src/workflows/store.ts";
test("reproduce stale protected workflow-declared name in freshly rebuilt synthetic body",()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-workflow-name-review-"))),cwd=join(root,"repo"),home=join(root,"home"),denied=join(root,"cowork"),alias=join(cwd,".winter/workflows/slot.js");for(const p of [home,denied,dirname(alias)])mkdirSync(p,{recursive:true});
 const a=join(denied,"A"),b=join(root,"B");writeFileSync(a,'export const meta={name:"source-secret-name",description:"original"};\nreturn 1;');writeFileSync(b,'export const meta={name:"safe-name",description:"safe"};\nreturn 2;');symlinkSync(a,alias);
 const workflows=listWorkflowsForListing({cwd,trustedWorkspace:true});
 const synthetic=workflows.map(w=>inheritSourceObject({name:w.name,description:w.description,source:w.source,path:w.path,body:buildWorkflowSkillPrompt(w)},w));
 const index=SkillIndex.build({cwd,winterHome:home,syntheticSkills:synthetic});const lease=installHostCodeProtection({revision:1,denyReadPaths:[denied],denyWritePaths:[]});
 try{unlinkSync(alias);symlinkSync(b,alias);const current=index.list(),body=index.load("source-secret-name")?.body;const findings={cachedName:current[0]?.name,bodyContainsProtectedName:body?.includes("source-secret-name"),oldNameResolves:resolveWorkflowByName("source-secret-name",{cwd,trustedWorkspace:true}).ok,newNameResolves:resolveWorkflowByName("safe-name",{cwd,trustedWorkspace:true}).ok};console.log(JSON.stringify(findings));expect(findings).toEqual({cachedName:"source-secret-name",bodyContainsProtectedName:true,oldNameResolves:false,newNameResolves:true});}finally{lease.close();rmSync(root,{recursive:true,force:true});}
});

import {test,expect} from "bun:test";
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WINTER_BRAND} from "../../../packages/sdk/src/index.ts";
import {loadGlobalConfigMcp} from "../../../packages/runtime/src/settings/loaders/mcp-config.ts";
import {installSourceReadRestrictions} from "../../../packages/runtime/src/sandbox/source-read.ts";
import {installHostCodeProtection} from "../../../packages/runtime/src/sandbox/host-code-protection.ts";
test("own MCP exception retains live exact/root/glob and canonical ancestor denials",()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-control-review-"))),home=join(root,"own"),alias=join(root,"alias");mkdirSync(home);symlinkSync(home,alias);
 const control=join(home,".winter.json");writeFileSync(control,JSON.stringify({mcpServers:{ok:{command:"fixture"}}}));
 const release=installSourceReadRestrictions([control],root);let lease:ReturnType<typeof installHostCodeProtection>|undefined;
 const load=(h=home)=>loadGlobalConfigMcp({home:h,cwd:root,gitRoot:null,brand:WINTER_BRAND,sources:["user"]}).user;
 try{
  expect(load().ok).toBeDefined();expect(load(alias).ok).toBeDefined();
  for(const deny of [control,home,join(home,"*.json")]){lease=installHostCodeProtection({revision:1,denyReadPaths:[deny],denyWritePaths:[]});expect(load()).toEqual({});expect(load(alias)).toEqual({});lease.close();lease=undefined;}
  const broad=installSourceReadRestrictions([home],root);try{expect(load()).toEqual({});expect(load(alias)).toEqual({});}finally{broad();}
 }finally{lease?.close();release();rmSync(root,{recursive:true,force:true});}
});

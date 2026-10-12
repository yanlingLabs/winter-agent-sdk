import {test,expect,mock} from "bun:test";
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,symlinkSync,unlinkSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {installHostCodeProtection} from "../sandbox/host-code-protection.ts";
const actualRead=(await import("node:fs/promises")).readFile;
let didRead!:()=>void,release!:()=>void;
const bytesRead=new Promise<void>(resolve=>{didRead=resolve;});
const held=new Promise<void>(resolve=>{release=resolve;});
mock.module("node:fs/promises",()=>({readFile:async(...args:Parameters<typeof actualRead>)=>{const bytes=await actualRead(...args);didRead();await held;return bytes;}}));
const {readSourceText}=await import("../sandbox/source-read.ts");
test("pending async bytes retain original canonical authority after retarget",async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),"winter-async-review-"))),denied=join(root,"cowork"),alias=join(root,"alias.md"),benign=join(root,"benign.md");mkdirSync(denied);
 writeFileSync(join(denied,"data.ext4"),"ASYNC-SYNTHETIC-PROTECTED-BYTES");writeFileSync(benign,"benign");symlinkSync(join(denied,"data.ext4"),alias);
 const lease=installHostCodeProtection({revision:0,denyReadPaths:[],denyWritePaths:[]});
 try{
  const pending=readSourceText(alias);await bytesRead;
  lease.update({revision:1,denyReadPaths:[denied],denyWritePaths:[]});unlinkSync(alias);symlinkSync(benign,alias);release();
  await expect(pending).rejects.toThrow("protected host path");
  expect(await readSourceText(alias)).toBe("benign");
 }finally{release();lease.close();rmSync(root,{recursive:true,force:true});}
});

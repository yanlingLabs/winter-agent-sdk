import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSpawn, createMandatoryFloorSpawn } from "@yanlinglabs/winter-agent-sdk";

describe.skipIf(process.platform!=="darwin")("native permission-error glob fallback",()=>{
  test("absolute and parent-relative patterns retain allowed hits beyond cwd",async()=>{
    const dir=realpathSync(mkdtempSync(join(tmpdir(),"winter-glob-floor-")));
    try {
      const cwd=join(dir,"source"),target=join(dir,"target"),control=join(target,"control");
      for(const path of [cwd,join(target,"allowed"),control])mkdirSync(path,{recursive:true});
      const allowed=join(target,"allowed","hit.txt"),secret=join(control,"secret.txt");
      writeFileSync(allowed,"allowed");writeFileSync(secret,"secret");writeFileSync(join(cwd,"wrong.txt"),"outside requested target");
      const patterns=[`${target}/**/*`,"../target/**/*"];
      const module=fileURLToPath(new URL("./safe-glob-scan.ts",import.meta.url));
      const script=`import {scanReadableFiles} from ${JSON.stringify(module)};
const patterns=${JSON.stringify(patterns)},root=${JSON.stringify(cwd)},rows=[];
for(const pattern of patterns){let nativeError;try{for await(const path of new Bun.Glob(pattern).scan({cwd:root,onlyFiles:true,dot:true,followSymlinks:false})){} }catch(error){nativeError=error.code}
rows.push({pattern,nativeError,files:await scanReadableFiles(pattern,root,true)});}console.log(JSON.stringify(rows));`;
      const spawn=createMandatoryFloorSpawn({spawn:defaultSpawn,floor:{denyReadPaths:[control],denyWritePaths:[control]}});
      const child=spawn({command:process.execPath,args:["-e",script],cwd,env:{PATH:"/bin:/usr/bin",HOME:dir,WINTER_TEST_KEYCHAIN:"memory"}});
      let stdout="",stderr="";await Promise.all([(async()=>{for await(const chunk of child.stdout)stdout+=chunk})(),(async()=>{for await(const chunk of child.stderr!)stderr+=chunk})()]);
      expect((await child.exited).code,stderr).toBe(0);
      const rows=JSON.parse(stdout) as Array<{pattern:string;nativeError:string;files:string[]}>;
      expect(rows).toHaveLength(2);
      for(const row of rows){expect(row.nativeError).toBe("EPERM");expect(row.files).toEqual([allowed]);expect(row.files).not.toContain(secret);}
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});

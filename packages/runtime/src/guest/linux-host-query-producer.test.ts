/** Cross-language pure producer/validator contract. No Root service/native admission is invoked. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { assertLinuxHostQueryConfig, assertLinuxHostQueryRoots } from "./linux-host-query-profile.ts";

test("actual Python root producer emits configurations accepted by the closed SDK profile in all host modes", () => {
  const script = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('producer',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
records=[]
for policy in ('auto','ask','plan','accept-edits','dont-ask','bypass'):
 root=module.runtime_root_metadata({'id':'source','guestPath':'/workspace/folders/source','readOnly':False},policy,True)
 item={'policy':policy,'logicalSessionId':'logical','authority':{'sessionId':'backend'},'roots':{'source':{'root':root}}}
 records.append({'config':module.host_query_config(item,['read','write','execute'],'openai/fixture'),'roots':[root]})
 records.append({'config':module.host_query_config(item,['read','write','execute','coordinate'],'openai/fixture'),'roots':[root],'coordinate':True})
 records.append({'config':module.host_query_config(item,['coordinate'],'openai/fixture'),'roots':[root],'coordinate':True})
print(json.dumps(records))
`;
  const result = spawnSync("python3", ["-I", "-S", "-c", script, join(import.meta.dir, "linux-supervisor.py")], { timeout: 3000, maxBuffer: 65536, encoding: "utf8" });
  expect(result.status).toBe(0); expect(result.error).toBeUndefined(); expect(result.stderr).toBe("");
  const records = JSON.parse(result.stdout);
  expect(records).toHaveLength(18);
  for (const record of records) {
    expect(() => assertLinuxHostQueryConfig(record.config)).not.toThrow();
    expect(() => assertLinuxHostQueryRoots(record.config, record.roots)).not.toThrow();
    expect(record.config.hostMessaging === true).toBe(record.coordinate === true);
    if (record.coordinate) for (const tool of ["SendMessage", "ListAgents", "AskUserQuestion", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]) expect(record.config.tools).toContain(tool);
    for (const tool of ["TaskStop", "TaskOutput"]) expect(record.config.tools).not.toContain(tool);
  }
});

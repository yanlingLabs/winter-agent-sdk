/** Why the first hosted guided run failed at dispatch1 (run 39310740026), as a deterministic test with no root and no native owner.
 *
 * The SDK's `query()` generates the guided `requiredRuntimeContext.bindingId` itself (`randomUUID()`, query.ts) and the host client's
 * spawn hook asserts that config against the reader registration Root produced. A registration made BEFORE the query therefore carries an id
 * the query can never pick: every query is refused with `required_context_unavailable`. The id only agrees when the registration is
 * made FROM the query's id (Root learns it from the host's `host-spawn` line and builds the service then). */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { consumeGuidedQueryCorrelation, prepareGuidedQuery, query, type Options, type RuntimeConfig, type SpawnRuntimeOptions } from "@yanlinglabs/winter-agent-sdk";
import { assertLinuxGuidedHostQueryConfig } from "./linux-guided-host-query-profile.ts";

const supervisor = join(import.meta.dir, "linux-supervisor.py");
const BOOT = "3a8f1c2e-5b7d-4e19-9c6a-0d2b4f6e8a10";
const ROOT_BINDING = "5f6e7d8c-0000-4000-a000-00000000000b";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PRODUCE = `
import importlib.util,json,os,sys,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('producer',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
args=json.loads(sys.argv[2])
class Port:
 def bind(self,item):pass
module.RuntimeDuplexPorts=Port
temp=Path(tempfile.mkdtemp()).resolve();store=temp/'store';home=temp/'home'
for directory in (store,home):directory.mkdir(mode=0o700);os.chmod(directory,0o700)
obj=module.ToolService.__new__(module.ToolService)
obj.runtime_artifacts={'fixture':-1};obj.owned=[];obj.runtimes={};obj.guest_boot=args['boot'];obj.host_query_ports={'logical':Port()}
auth={'workspaceId':'workspace-a','sessionId':'backend-1','incarnationId':'incarnation-1','leaseEpoch':3,'configRevision':1,'grantRevision':2,'policyRevision':1}
root=module.runtime_root_metadata({'id':'source','guestPath':'/workspace/folders/source','readOnly':False},'ask',True)
item={'logicalSessionId':'logical','runtimeUid':os.getuid(),'toolUid':10001,'workspaceGid':10000,'authority':auth,'policy':'ask','revoked':False,'roots':{'source':{'root':root,'fd':-9}}}
provider={'scope':{'homeId':'home','workspaceId':'workspace-a','sessionId':'logical','backendSessionId':'backend-1','taskId':'task','incarnationId':'incarnation-1','bootId':args['boot'],'leaseEpoch':3,'grantRevision':2,'accountRevision':1,'modelRevision':1},'selection':{'providerId':'openai','modelKey':'openai/fixture','providerModelId':'fixture','family':'openai','protocol':'openai-responses','capabilities':{'toolCalling':'native','readableState':'summary'}}}
value={'storeDirectory':str(store),'runhomeDirectory':str(home),'provider':provider,'model':'openai/fixture','toolClasses':['read','write','execute'],'requiredRuntimeContext':args['requirement'],'generation':4,'guidanceDirectory':'/guidance'}
obj._configure_runtime(item,value,profile='host-query-guided-v1')
print(json.dumps(obj._runtime_record(item,obj.runtimes['logical'])))
`;
function produce(bindingId: string): { runtimeConfig: RuntimeConfig; readerRegistration: unknown } {
  const result = spawnSync("python3", ["-I", "-S", "-B", "-c", PRODUCE, supervisor, JSON.stringify({ boot: BOOT, requirement: { version: 1, bindingId } })], { timeout: 10000, maxBuffer: 1 << 20, encoding: "utf8" });
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

/** What the host client's spawn hook sees from one real `query()`: the config the SDK built, with its own generated binding id. The hook returns a process that
 * ends at once, so nothing runs; only the SDK's own config and correlation are observed. */
async function observe(sessionId: string): Promise<{ config: RuntimeConfig; correlation: { version: 1; bindingId: string } }> {
  let seen: { config: RuntimeConfig; correlation: { version: 1; bindingId: string } } | undefined;
  const spawnClaudeCodeProcess = (spawn: SpawnRuntimeOptions) => {
    const correlation = consumeGuidedQueryCorrelation(spawn.guidedQueryClaim!, spawn.args);
    seen = { config: JSON.parse(spawn.args[2]!), correlation: { ...correlation } as never };
    throw new Error("observed");
  };
  const onRuntimeContext = async () => ({ revision: "r", facts: "f", instructions: "i" });
  const preparation = prepareGuidedQuery({ onRuntimeContext, spawnClaudeCodeProcess });
  const options: Options = { onRuntimeContext, spawnClaudeCodeProcess, guidedQueryPreparation: preparation, requireRuntimeContext: true, sessionId };
  try { for await (const _ of query({ prompt: "x", options })) { /* never yields */ } } catch { /* the hook stopped the query on purpose */ }
  expect(seen).toBeDefined();
  return seen!;
}

test("two guided queries get two different SDK-generated binding ids, and neither can be a Root-chosen one", async () => {
  const first = await observe("backend-1"), second = await observe("backend-1");
  for (const item of [first, second]) {
    expect(item.config.requiredRuntimeContext).toEqual({ version: 1, bindingId: item.correlation.bindingId });
    expect(item.correlation.bindingId).toMatch(UUID_V4);
  }
  expect(first.correlation.bindingId).not.toBe(second.correlation.bindingId);
  expect(first.correlation.bindingId).not.toBe(ROOT_BINDING);
});

test("a registration made before the query is refused for every query; one made from the query's own id is accepted", async () => {
  const early = produce(ROOT_BINDING);
  const queries = [await observe("backend-1"), await observe("backend-1")];
  for (const { config, correlation } of queries) {
    // The host client asserts the config the SDK emitted against the registration it was given. Root's early registration cannot match.
    const emitted = { ...early.runtimeConfig, requiredRuntimeContext: config.requiredRuntimeContext } as RuntimeConfig;
    expect(() => assertLinuxGuidedHostQueryConfig(emitted, early.readerRegistration)).toThrow("required_context_unavailable");
    // The same assertion succeeds against a registration produced FROM the query's id: Root has to learn the id first.
    const late = produce(correlation.bindingId);
    expect(() => assertLinuxGuidedHostQueryConfig(late.runtimeConfig, late.readerRegistration)).not.toThrow();
    expect(() => assertLinuxGuidedHostQueryConfig({ ...late.runtimeConfig, requiredRuntimeContext: config.requiredRuntimeContext } as RuntimeConfig, late.readerRegistration)).not.toThrow();
  }
});

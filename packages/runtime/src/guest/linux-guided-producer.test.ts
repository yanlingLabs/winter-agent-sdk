/** Cross-language guided producer contract. The actual Python Root producer emits the guided bootstrap
 * and the SDK's closed validators judge it. No native owner is admitted, no reader is served and no
 * provider is dispatched: a record these validators accept is DATA, never authority. */
import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { runEmbeddedSession } from "../embedded.ts";
import { assertLinuxGuidedHostQueryConfig, assertLinuxGuidedHostQueryRoots } from "./linux-guided-host-query-profile.ts";
import { LINUX_GUIDED_READER_LIMITS, parseLinuxGuidedReaderRegistration } from "./linux-guided-reader-protocol.ts";
import { assertLinuxHostQueryConfig } from "./linux-host-query-profile.ts";
import type { LinuxSessionAdmission } from "./linux-session-admission.ts";
import { createProtectedStoreBootstrap } from "./store-bootstrap.ts";

const supervisor = join(import.meta.dir, "linux-supervisor.py");
const BOOT = "3a8f1c2e-5b7d-4e19-9c6a-0d2b4f6e8a10";
const BINDING = "5f6e7d8c-0000-4000-a000-00000000000b";
const GENERATION = 4;
const GUIDED = "host-query-guided-v1";
const POLICIES = ["auto", "ask", "plan", "accept-edits", "dont-ask", "bypass"] as const;
// Canonical-record SHA-256 of the UNCHANGED v1 and fresh profiles, computed on origin/main (6a6425a1)
// from the same fixed inputs. A change here is a v1/fresh bootstrap contract change.
const GOLDEN = { v1: "d35cbd99749c6e50830680b761d81517e999f834814fc05f817793ecab2cc310", fresh: "517b3c3c940f02ef0bad33dbc05ca88290cad9afa6f606dab87fd29ffa0292b6" } as const;

const PRELUDE = `
import importlib.util,json,os,sys,tempfile,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('producer',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
args=json.loads(sys.argv[2])
class Port:
 def bind(self,item):pass
module.RuntimeDuplexPorts=Port
BOOT=args['boot']
def make(policy,profile,extra):
 temp=Path(tempfile.mkdtemp()).resolve();store=temp/'store';home=temp/'home'
 for directory in (store,home):directory.mkdir(mode=0o700);os.chmod(directory,0o700)
 obj=module.ToolService.__new__(module.ToolService)
 obj.runtime_artifacts={'fixture':-1};obj.owned=[];obj.runtimes={};obj.guest_boot=BOOT;obj.host_query_ports={'logical':Port()}
 auth={'workspaceId':'workspace-a','sessionId':'backend-1','incarnationId':'incarnation-1','leaseEpoch':3,'configRevision':1,'grantRevision':2,'policyRevision':1}
 root=module.runtime_root_metadata({'id':'source','guestPath':'/workspace/folders/source','readOnly':False},policy,True)
 item={'logicalSessionId':'logical','runtimeUid':os.getuid(),'toolUid':10001,'workspaceGid':10000,'authority':auth,'policy':policy,'revoked':False,'roots':{'source':{'root':root,'fd':-9}}}
 provider={'scope':{'homeId':'home','workspaceId':'workspace-a','sessionId':'logical','backendSessionId':'backend-1','taskId':'task','incarnationId':'incarnation-1','bootId':BOOT,'leaseEpoch':3,'grantRevision':2,'accountRevision':1,'modelRevision':1},'selection':{'providerId':'openai','modelKey':'openai/fixture','providerModelId':'fixture','family':'openai','protocol':'openai-responses','capabilities':{'toolCalling':'native'}}}
 value={'storeDirectory':str(store),'runhomeDirectory':str(home),'provider':provider,'model':'openai/fixture'}
 if profile!='fresh':value['toolClasses']=['read','write','execute']
 value.update(extra)
 obj._configure_runtime(item,value,profile=profile)
 return obj,item
def stable(obj,item):
 runtime=obj.runtimes['logical'];runtime['ownerToken']='ab'*32;item['runtimeUid']=20001
 return module.canonical(obj._runtime_record(item,runtime))
`;
const PRODUCE = `
records=[]
for policy in ('auto','ask','plan','accept-edits','dont-ask','bypass'):
 obj,item=make(policy,'host-query-guided-v1',{'requiredRuntimeContext':args['requirement'],'generation':args['generation']})
 records.append({'policy':policy,'record':obj._runtime_record(item,obj.runtimes['logical'])})
rights={'guided':len(module.bootstrap_rights('host-query-guided-v1',10,11,12,13,14)),'v1':len(module.bootstrap_rights('host-query-v1',10,11,12,13)),'fresh':len(module.bootstrap_rights('fresh',10,11,12,13))}
print(json.dumps({'records':records,'rights':rights}))
`;
const GOLDEN_SCRIPT = `
out={}
for name,profile in (('fresh','fresh'),('v1','host-query-v1')):
 obj,item=make('ask',profile,{});out[name]=hashlib.sha256(stable(obj,item).encode()).hexdigest()
print(json.dumps(out))
`;
const REFUSE = `
import socket
out={}
def attempt(label,call):
 try:call();out[label]='accepted'
 except module.Refusal as error:out[label]=str(error)
def bare():
 obj=module.ToolService.__new__(module.ToolService);obj.runtime_artifacts={'fixture':-1};obj.owned=[];obj.runtimes={};obj.guest_boot=BOOT;obj.host_query_ports={'logical':Port()}
 return obj
for profile in ('fresh','host-query-v1','host-query-guided-v1'):
 for key in ('profile','runtimeProfile','readerRegistration','runtimeConfig','registrationId','owner','views','limits'):
  def call(profile=profile,key=key):
   bare()._configure_runtime({'logicalSessionId':'logical','authority':{},'roots':{}},{'storeDirectory':'/x','runhomeDirectory':'/y','provider':{},'model':'m',key:{}},profile=profile)
  attempt(profile+':'+key,call)
for profile in ('fresh','host-query-v1'):
 for key in ('requiredRuntimeContext','generation'):
  def call(profile=profile,key=key):
   bare()._configure_runtime({'logicalSessionId':'logical','authority':{},'roots':{}},{'storeDirectory':'/x','runhomeDirectory':'/y','provider':{},'model':'m',key:{}},profile=profile)
  attempt('guided-key:'+profile+':'+key,call)
for config in ({'hostQueryRuntime':{},'hostQueryGuidedRuntime':{}},{'freshRuntime':{},'hostQueryGuidedRuntime':{}},{'freshRuntime':{},'hostQueryRuntime':{}}):
 attempt('conflict:'+','.join(sorted(config)),lambda config=config:module.select_runtime_profile(config))
out['json-profile-selects']=module.select_runtime_profile({'profile':'host-query-guided-v1','runtimeProfile':'host-query-guided-v1'})
for extra in ({'profile':'host-query-guided-v1'},{'readerRegistration':{}},{'requiredRuntimeContext':{}}):
 near,far=socket.socketpair()
 try:
  module.frame_write(near,dict({'operation':'launch-runtime','sessionId':'logical'},**extra));attempt('admin:'+','.join(extra),lambda:bare()._admin(far))
 finally:near.close();far.close()
print(json.dumps(out))
`;

function python(body: string, input: Record<string, unknown>, file = supervisor): any {
  const result = spawnSync("python3", ["-I", "-S", "-B", "-c", PRELUDE + body, file, JSON.stringify({ boot: BOOT, ...input })], { timeout: 10000, maxBuffer: 1 << 20, encoding: "utf8" });
  expect(result.error).toBeUndefined(); expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
interface Produced { policy: string; record: any }
let produced!: { records: Produced[]; rights: Record<string, number> };
beforeAll(() => { produced = python(PRODUCE, { requirement: { version: 1, bindingId: BINDING }, generation: GENERATION }); });

test("actual Python Root emits a guided bootstrap the closed SDK validators accept in every host mode", () => {
  expect(produced.records.map(row => row.policy)).toEqual([...POLICIES]);
  for (const { policy, record } of produced.records) {
    expect(record.profile).toBe(GUIDED);
    expect(record.protocolVersion).toBe(1); expect(record.freshOnly).toBe(true);
    expect(() => parseLinuxGuidedReaderRegistration(record.readerRegistration), policy).not.toThrow();
    expect(() => assertLinuxGuidedHostQueryConfig(record.runtimeConfig, record.readerRegistration), policy).not.toThrow();
    expect(() => assertLinuxGuidedHostQueryRoots(record.runtimeConfig, record.roots, record.readerRegistration), policy).not.toThrow();
    // The v1 validator must keep refusing the same config: the correlation key is guided-only.
    expect(() => assertLinuxHostQueryConfig(record.runtimeConfig as RuntimeConfig)).toThrow();
    expect(record.runtimeConfig.allowedTools).toEqual([]);
    expect(record.runtimeConfig.requiredRuntimeContext).toEqual({ version: 1, bindingId: BINDING });
    expect(record.roots[0].readOnly).toBe(policy === "plan");
  }
});

test("registration owner matches the record scope, generation, boot, lease and correlation", () => {
  for (const { record } of produced.records) {
    const registration = parseLinuxGuidedReaderRegistration(record.readerRegistration), owner = registration.owner;
    expect(owner.workspaceId).toBe(record.scope.workspaceId); expect(owner.workspaceId).toBe(record.authority.workspaceId);
    expect(owner.logicalSessionId).toBe(record.logicalSessionId);
    expect(owner.backendSessionId).toBe(record.scope.sessionId); expect(owner.backendSessionId).toBe(record.runtimeConfig.sessionId);
    expect(owner.incarnationId).toBe(record.scope.incarnationId);
    expect(owner.leaseEpoch).toBe(record.scope.leaseEpoch); expect(owner.leaseEpoch).toBe(3);
    expect(owner.bootId).toBe(record.scope.currentBootId); expect(owner.bootId).toBe(BOOT);
    expect(owner.bootId).toBe(record.provider.scope.bootId);
    expect(owner.generation).toBe(GENERATION);
    expect(registration.requiredRuntimeContext.bindingId).toBe(BINDING);
    expect(registration.requiredRuntimeContext).toEqual(record.runtimeConfig.requiredRuntimeContext);
    expect(registration.views.sourceRoot).toBe(record.roots[0].guestPath); expect(registration.views.sourceCwd).toBe(record.runtimeConfig.cwd);
    expect(registration.views.sharedPath).toBe("/run/winter/shared-instructions/WINTER.md");
    expect(record.runtimeConfig.winterHome).toBe(`/run/winter/conversations/${owner.logicalSessionId}`);
    expect(record.runtimeConfig.storeHome).toBe(`/workspace/.winter/conversations/${owner.logicalSessionId}`);
  }
});

test("the four reader limits are the exact constants, not merely accepted values", () => {
  const exact: Record<string, number> = { maxFileBytes: 131072, maxReadBytes: 262144, maxReadOccurrences: 256, maxExpandedBytes: 131072 };
  expect({ ...LINUX_GUIDED_READER_LIMITS } as Record<string, number>).toEqual(exact);
  for (const { record } of produced.records) expect(record.readerRegistration.limits).toEqual(exact);
});

test("guided sends five native descriptors and v1 and fresh stay at four", () => {
  expect(produced.rights).toEqual({ guided: 5, v1: 4, fresh: 4 });
});

test("the v1 and fresh bootstrap records are byte-identical to origin/main", () => {
  expect(python(GOLDEN_SCRIPT, {})).toEqual(GOLDEN);
});

test("validators fail closed when Root's registration or correlation is missing, mismatched or zeroed", () => {
  const { record } = produced.records.find(row => row.policy === "ask")!;
  const registration = record.readerRegistration, config = record.runtimeConfig as RuntimeConfig;
  const clone = <T>(value: T): T => structuredClone(value);
  // Missing registration: the guided config check has nothing to bind.
  expect(() => assertLinuxGuidedHostQueryConfig(config, undefined)).toThrow("required_context_unavailable");
  // Correlation mismatch between config and registration, in each direction.
  const otherBinding = "5f6e7d8c-0000-4000-a000-0000000000ff";
  const mismatchedConfig = { ...config, requiredRuntimeContext: { version: 1 as const, bindingId: otherBinding } };
  expect(() => assertLinuxGuidedHostQueryConfig(mismatchedConfig, registration)).toThrow("required_context_unavailable");
  const mismatchedRegistration = clone(registration); mismatchedRegistration.requiredRuntimeContext.bindingId = otherBinding;
  expect(() => assertLinuxGuidedHostQueryConfig(config, mismatchedRegistration)).toThrow("required_context_unavailable");
  // Zeroed or invalid generation, lease, boot and limits.
  for (const change of [(r: any) => { r.owner.generation = 0; }, (r: any) => { r.owner.leaseEpoch = 0; }, (r: any) => { r.owner.bootId = "boot"; },
    (r: any) => { r.limits.maxReadBytes += 1; }, (r: any) => { delete r.limits; }, (r: any) => { r.registrationId = "not-a-uuid"; }]) {
    const mutated = clone(registration); change(mutated);
    expect(() => parseLinuxGuidedReaderRegistration(mutated)).toThrow("required_context_unavailable");
    expect(() => assertLinuxGuidedHostQueryConfig(config, mutated)).toThrow("required_context_unavailable");
  }
  // The config alone cannot carry the guided key through the v1 closed profile.
  expect(() => assertLinuxHostQueryConfig(config)).toThrow();
});

test("JSON, tool and admin request input cannot select a profile or carry registration data", () => {
  const refusals = python(REFUSE, {}) as Record<string, string>;
  const labels = Object.keys(refusals);
  expect(labels.length).toBeGreaterThan(20);
  for (const label of labels) {
    if (label.startsWith("conflict:")) expect(refusals[label], label).toBe("runtime_profile_conflict");
    else if (label.startsWith("admin:")) expect(refusals[label], label).toBe("admin_request");
    else if (label === "json-profile-selects") expect(refusals[label]).toBe("fresh");
    else expect(refusals[label], label).toBe("runtime_config");
  }
  expect(Object.keys(refusals).filter(label => label.startsWith("conflict:"))).toHaveLength(3);
  expect(Object.keys(refusals).filter(label => label.startsWith("admin:"))).toHaveLength(3);
});

test("the guided engine path fails closed without a native admission: no store, no output, no provider", async () => {
  const { record } = produced.records.find(row => row.policy === "ask")!;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-guided-producer-")));
  try {
    for (const admission of [undefined, Object.freeze({ ...record, ownerToken: "not-native-evidence" }) as unknown as LinuxSessionAdmission, structuredClone(record) as unknown as LinuxSessionAdmission]) {
      let acquired = 0; const output: string[] = [];
      const store = createProtectedStoreBootstrap({ ...record.scope, storeHome: home }, { acquire: async () => { acquired++; throw new Error("should never acquire"); } });
      const code = await runEmbeddedSession({ argv: ["--run", "--config-json", JSON.stringify(record.runtimeConfig)], env: {}, ...(admission ? { linuxSessionAdmission: admission } : {}),
        protectedStoreBootstrap: store, onProtectedStoreOwnershipOutcome() {}, input: (async function* () {})(), write: value => output.push(value), writeErr() {} });
      // An engine init frame would only follow a provider selection; none is written and nothing is acquired.
      expect(code).toBe(1); expect(acquired).toBe(0); expect(output).toEqual([]);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- static pins: the entry exists only as source and calls only the guided factory ----
const repo = join(import.meta.dir, "../../../..");
const source = (path: string): string => readFileSync(join(repo, path), "utf8");
const sourceFiles = (patterns: string[]): string[] => patterns.flatMap(pattern => [...new Bun.Glob(pattern).scanSync({ cwd: repo, dot: true })]).filter(path => !path.includes("node_modules/") && !path.includes("/dist/"));

test("static pin: the guided entry calls the guided factory and never the v1 or fresh one", () => {
  const entry = source("packages/runtime/src/guest/linux-guided-host-query-main.ts");
  expect(entry.match(/admitGuidedHostQueryLinuxSession\(3, 4\)/g)).toHaveLength(1);
  expect(entry).not.toContain("admitHostQueryLinuxSession");
  expect(entry).not.toContain("admitFreshLinuxSession");
  expect(entry).not.toMatch(/\badmit(?!GuidedHostQueryLinuxSession\b)\w*LinuxSession/);
  expect(entry.match(/import \{[^}]*\} from "\.\/linux-session-admission\.ts"/g)).toEqual(['import { admitGuidedHostQueryLinuxSession } from "./linux-session-admission.ts"']);
  // Same fixed native ABI as the v1 entry, byte for byte.
  const argv = 'JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--native-bootstrap-fd", "3", "--native-owner-fd", "4"])';
  expect(entry).toContain(argv);
  // The v1 entry is untouched: it still calls only its own factory.
  const v1 = source("packages/runtime/src/guest/linux-host-query-main.ts");
  expect(v1).toContain("admitHostQueryLinuxSession(3, 4)"); expect(v1).not.toContain("Guided");
});

test("static pin: the guided entry is unwired and absent from every compile packet", () => {
  const importers = sourceFiles(["packages/*/src/**/*.ts", "packages/*/*.ts", "scripts/**/*.{ts,py,sh,json}", ".github/**/*.yml"])
    .filter(path => path !== relative(repo, import.meta.path) && readFileSync(join(repo, path), "utf8").includes("linux-guided-host-query-main"));
  expect(importers).toEqual([]);
  for (const path of ["scripts/guest-host-query/compile.ts", "scripts/guest-host-query/provenance.py"]) expect(source(path)).not.toMatch(/guided/i);
});

test("static pin: the host guard still refuses a confined required-context query unless a spent guest ticket lifts it", () => {
  const query = source("packages/sdk/src/query.ts");
  // The only exception is a guided query whose guest ticket query() spent (guided-guest-attestation.md); nothing else lifts it.
  expect(query).toContain('(preparation !== undefined || options.requireRuntimeContext === true) && options.executionPosture === "confined-guest" && preparation?.guest !== true) throw new Error("required_context_unavailable")');
  expect(query).toContain("The unconditional native guest refusal lifts ONLY for a valid, unspent, current-generation guest ticket bound to");
  expect(query).toContain("guest: ticket !== undefined,");
  expect(query).toContain("spendGuidedGuestTicket(ticket, preparation,");
});

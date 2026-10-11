import { createHash } from "node:crypto";
import type { BrandProfile, HostCodeProcessScope, PermissionResult, RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { buildBaselineDenyRules, type EngineSettingsRuleSeed } from "../engine.ts";
import { DEFAULT_SANDBOX_SETTINGS } from "../sandbox/profile.ts";
import { isSandboxAvailable, resolveExecutionPath } from "../sandbox/spawn.ts";
import { getRegisteredTool } from "../tools/registry.ts";
import { evaluate, NO_OPINION_AUTO_ENGINE, NO_OPINION_HOOK_STAGE, REAL_SPECIAL_CHECKS, type EvaluationContext, type PermissionCall, type PermissionDecisionRecord, type AutoEngine, type HookStage } from "./evaluator.ts";
import { PolicyStateStore, assertKnownPermissionMode, type AutoModeConfig } from "./policy-state.ts";
import { buildSdkSourcedEntries, emptyRuleSet } from "./ruleset.ts";
import { isValidPermissionResult, toPromptDecision } from "./prompt-stage.ts";

/** All fields are prepared/captured by the host before launch, never accepted from runtime RPC.
 * The revision covers mode, rules, grants, settings and hooks; every change invalidates receipts. */
export interface HostCodePermissionSnapshot {
  scope:Omit<HostCodeProcessScope,"toolUseId">;
  policyRevision:number;
  config:Pick<RuntimeConfig,"permissionMode"|"permissions"|"allowedTools"|"disallowedTools"|"allowDangerouslySkipPermissions"|"additionalDirectories"|"sandbox">;
  settingsRules?:EngineSettingsRuleSeed;
  cwd:string;sessionRoot:string;home:string;winterHome?:string;storeHome?:string;
  trustedWorkspace:boolean;brand:BrandProfile;outputsDir?:string;
  additionalDirectories?:readonly string[];
  autoConfig?:AutoModeConfig;
  /** An actual host-owned reviewer/classifier. Missing produces no verdict and never an allow. */
  autoEngine?:AutoEngine;
  hookStage?:HookStage;
}
export interface HostCodePermissionRequest {scope:HostCodeProcessScope;toolName:string;input:Record<string,unknown>}
export interface HostCodePermissionReceipt extends HostCodePermissionRequest {cwd:string;policyRevision:number;result:PermissionResult}
const scopeKeys=["generationId","sessionId","agentId","parentToolUseId"] as const;
function sameOwner(scope:HostCodeProcessScope,snapshot:HostCodePermissionSnapshot):boolean{return scopeKeys.every(key=>scope[key]===snapshot.scope[key]);}
function canonical(value:unknown):string {
  if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
  if(typeof value==="number"&&Number.isFinite(value))return JSON.stringify(value);
  if(typeof value!=="object")throw new Error("host permission binding requires JSON values");
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new Error("host permission binding requires plain JSON objects");
  return `{${Object.entries(value).filter(([,entry])=>entry!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>`${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}
function key(request:HostCodePermissionRequest,cwd:string,revision:number):string {
  return createHash("sha256").update(canonical({scope:request.scope,toolName:request.toolName,input:request.input,cwd,revision})).digest("hex");
}
/** Reuses the runtime's policy store, source/trust matcher and special checks. No I/O settings reload. */
export function buildHostCodePermissionContext(snapshot:HostCodePermissionSnapshot):EvaluationContext {
  if(!Number.isSafeInteger(snapshot.policyRevision)||snapshot.policyRevision<0)throw new Error("invalid host policy revision");
  const config=snapshot.config;
  const policy=new PolicyStateStore({mode:assertKnownPermissionMode(config.permissionMode??snapshot.settingsRules?.defaultMode),rules:{...emptyRuleSet(),entries:[...buildBaselineDenyRules(snapshot.winterHome,snapshot.brand,snapshot.storeHome),...(snapshot.settingsRules?.entries??[]),...buildSdkSourcedEntries(config)],directories:[...(snapshot.settingsRules?.directories??[])]},...(snapshot.autoConfig?{autoConfig:snapshot.autoConfig}:{})},
    {allowDangerouslySkipPermissions:config.allowDangerouslySkipPermissions===true,disableBypassPermissionsMode:config.permissions?.disableBypassPermissionsMode===true||snapshot.settingsRules?.disableBypassPermissionsMode===true}).getState();
  const stampedPolicy={...policy,version:snapshot.policyRevision};
  const settings=config.sandbox??DEFAULT_SANDBOX_SETTINGS;
  const posture=(call:PermissionCall,override:boolean)=>resolveExecutionPath({settings,command:typeof call.input.command==="string"?call.input.command:"",dangerouslyDisableSandbox:override}).posture;
  return {policy:stampedPolicy,cwd:snapshot.cwd,sessionRoot:snapshot.sessionRoot,home:snapshot.home,trustedWorkspace:snapshot.trustedWorkspace,brand:snapshot.brand,
    sessionBypassEnabled:config.allowDangerouslySkipPermissions===true,
    additionalDirectories:[...(config.additionalDirectories??[]),...(snapshot.additionalDirectories??[])],
    ...(snapshot.winterHome?{winterHome:snapshot.winterHome}:{}),...(snapshot.storeHome?{storeHome:snapshot.storeHome}:{}),...(snapshot.outputsDir?{outputsDir:snapshot.outputsDir}:{}),
    hookStage:snapshot.hookStage??NO_OPINION_HOOK_STAGE,autoEngine:snapshot.autoEngine??NO_OPINION_AUTO_ENGINE,specialChecks:REAL_SPECIAL_CHECKS,
    promptStage:{async prompt(){return null;}},
    requiresInteraction:name=>getRegisteredTool(name)?.descriptor.interaction==="required",
    bashRunsSandboxed:call=>call.toolName==="Bash"&&settings.autoAllowBashIfSandboxed===true&&posture(call,call.input.dangerouslyDisableSandbox===true)==="sandboxed"&&isSandboxAvailable(),
    bashSandboxEscape:call=>call.toolName==="Bash"&&call.input.dangerouslyDisableSandbox===true&&posture(call,true)!=="sandboxed"&&posture(call,false)==="sandboxed",
  };
}
/** Host-only capability. Receipts come from the real host canUseTool callback, never serialized bits.
 * Evaluations do not create permission cards; they return needs_prompt when no bound receipt exists. */
export function createHostCodePermissionEvaluator(input:{getCurrentSnapshot(request:HostCodePermissionRequest):HostCodePermissionSnapshot}) {
  const receipts=new Map<string,PermissionResult>();
  return {
    recordPromptResult(receipt:HostCodePermissionReceipt){
      const current=input.getCurrentSnapshot(receipt);
      if(!sameOwner(receipt.scope,current)||receipt.cwd!==current.cwd||receipt.policyRevision!==current.policyRevision||!isValidPermissionResult(receipt.result))throw new Error("stale or invalid host permission receipt");
      receipts.set(key(receipt,receipt.cwd,receipt.policyRevision),structuredClone(receipt.result));
      if(receipts.size>1024)receipts.delete(receipts.keys().next().value!);
    },
    clearReceipts(){receipts.clear();},
    async evaluate(request:HostCodePermissionRequest,signal?:AbortSignal):Promise<{status:"allow"|"deny"|"needs_prompt"|"stale"|"cancelled";policyRevision:number;record?:PermissionDecisionRecord}> {
      const captured:HostCodePermissionRequest=structuredClone(request);
      const live=input.getCurrentSnapshot(captured);
      const snapshot:HostCodePermissionSnapshot={...live,scope:{...live.scope},config:structuredClone(live.config),brand:structuredClone(live.brand),...(live.settingsRules?{settingsRules:structuredClone(live.settingsRules)}:{}),...(live.autoConfig?{autoConfig:structuredClone(live.autoConfig)}:{}),...(live.additionalDirectories?{additionalDirectories:[...live.additionalDirectories]}:{})};
      if(!sameOwner(captured.scope,snapshot))throw new Error("foreign host permission scope");
      if(signal?.aborted)return{status:"cancelled",policyRevision:snapshot.policyRevision};
      const context=buildHostCodePermissionContext(snapshot);let needsPrompt=false;
      context.promptStage={async prompt(call){
        const receipt=receipts.get(key({...captured,toolName:call.toolName,input:call.input},context.cwd,snapshot.policyRevision));
        if(!receipt){needsPrompt=true;return null;}return toPromptDecision(receipt);
      }};
      if(signal)context.signal=signal;
      const record=await evaluate({toolName:captured.toolName,input:captured.input,toolUseId:captured.scope.toolUseId,...(captured.scope.agentId?{agentId:captured.scope.agentId}:{})},context);
      const current=input.getCurrentSnapshot(captured);
      if(signal?.aborted)return{status:"cancelled",policyRevision:current.policyRevision};
      if(!sameOwner(captured.scope,current)||current.policyRevision!==snapshot.policyRevision||current.cwd!==snapshot.cwd)return{status:"stale",policyRevision:current.policyRevision};
      return{status:needsPrompt?"needs_prompt":record.decision==="allow"?"allow":"deny",policyRevision:snapshot.policyRevision,record};
    },
  };
}

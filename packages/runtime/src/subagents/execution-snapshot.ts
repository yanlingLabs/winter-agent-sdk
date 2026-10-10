import type { ChildInheritance, ChildSessionRecord, SpawnChildRequest } from "./child-handle.ts";
import type { ParentRuleMirror } from "./child-handle.ts";
import { isPermissionMode } from "../permissions/policy-state.ts";
import type { Workspace } from "./workspace.ts";

/** Credential-bearing adapters, callbacks, MCP transports and parent history stay host-owned. */
export interface ChildExecutionSnapshot {
  version: 1;
  projectKey: string;
  parentAgentId?: string;
  workspace: Workspace;
  request: Omit<SpawnChildRequest, "onProgress" | "onSpawned" | "definition"> & {
    definition?: Omit<NonNullable<SpawnChildRequest["definition"]>, "mcpServers">;
  };
  inheritance: Omit<ChildInheritance, "messages">;
  restrictions: Pick<ParentRuleMirror, "ask" | "deny">;
  /** A definition-scoped transport requires host reconfiguration; its config is never persisted. */
  scopedMcpServerNames: string[];
  inheritedMcpServerNames: string[];
}

const definitionFields = ["description", "prompt", "tools", "disallowedTools", "model", "criticalSystemReminder_EXPERIMENTAL", "skills", "initialPrompt", "maxTurns", "background", "memory", "effort", "permissionMode", "observer", "observerMessage", "isolation", "color", "appendSystemPrompt", "omitProjectContext", "whenToUseLean"] as const;

export function snapshotChildExecution(opts: {
  request: SpawnChildRequest;
  inheritance: ChildInheritance;
  workspace: Workspace;
  projectKey: string;
  parentAgentId?: string;
  rules?: { ask?: string[]; deny?: string[] };
}): ChildExecutionSnapshot {
  const req = opts.request;
  const definition = req.definition === undefined ? undefined : Object.fromEntries(definitionFields.flatMap((key) => req.definition![key as keyof NonNullable<SpawnChildRequest["definition"]>] === undefined ? [] : [[key, req.definition![key as keyof NonNullable<SpawnChildRequest["definition"]>]]]));
  const i = opts.inheritance;
  const snapshot: ChildExecutionSnapshot = {
    version: 1, projectKey: opts.projectKey, workspace: opts.workspace,
    ...(opts.parentAgentId !== undefined ? { parentAgentId: opts.parentAgentId } : {}),
    request: {
      parentToolUseId: req.parentToolUseId, prompt: req.prompt, runInBackground: req.runInBackground,
      ...(definition !== undefined ? { definition: definition as NonNullable<ChildExecutionSnapshot["request"]["definition"]> } : {}),
      ...(req.fork !== undefined ? { fork: req.fork } : {}),
      ...(req.isolation !== undefined ? { isolation: req.isolation } : {}),
      ...(req.name !== undefined ? { name: req.name } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.agentType !== undefined ? { agentType: req.agentType } : {}),
      ...(req.builtinAgentType !== undefined ? { builtinAgentType: req.builtinAgentType } : {}),
      ...(req.outputFormat !== undefined ? { outputFormat: req.outputFormat } : {}),
    },
    inheritance: {
      policy: i.policy, tools: i.tools, model: i.model, effort: i.effort, thinking: i.thinking,
      systemPrompt: i.systemPrompt, sessionRoot: i.sessionRoot,
      ...(i.outputStyle !== undefined ? { outputStyle: i.outputStyle } : {}),
      ...(i.provider !== undefined ? { provider: { providerId: i.provider.providerId, modelKey: i.provider.modelKey, family: i.provider.family, ...(i.provider.continuationDomain !== undefined ? { continuationDomain: i.provider.continuationDomain } : {}) } } : {}),
      ...(i.effectiveEffort !== undefined ? { effectiveEffort: i.effectiveEffort } : {}),
      ...(i.effectiveThinking !== undefined ? { effectiveThinking: i.effectiveThinking } : {}),
      ...(i.slot !== undefined ? { slot: i.slot } : {}),
      ...(i.requestLayout !== undefined ? { requestLayout: i.requestLayout } : {}),
    },
    restrictions: { ask: opts.rules?.ask ?? [], deny: opts.rules?.deny ?? [] },
    scopedMcpServerNames: (req.definition?.mcpServers ?? []).flatMap((spec) => typeof spec === "string" ? [] : Object.keys(spec)),
    inheritedMcpServerNames: (req.definition?.mcpServers ?? []).filter((spec): spec is string => typeof spec === "string"),
  };
  // A plain data copy avoids later mutations through caller-held definitions/layouts. Reject unsupported
  // payloads rather than silently dropping executable values into a less faithful snapshot.
  return JSON.parse(JSON.stringify(snapshot, (_key, value: unknown) => {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("child execution snapshot must contain JSON data only");
    return value;
  })) as ChildExecutionSnapshot;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((item) => typeof item === "string");
const optional = (obj: Record<string, unknown>, key: string, check: (v: unknown) => boolean): boolean => obj[key] === undefined || check(obj[key]);
const text = (v: unknown): boolean => typeof v === "string";
const finiteNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): boolean => finiteNumber(v) && (v as number) > 0;
const thinking = (v: unknown): boolean => object(v) && ["disabled", "enabled", "adaptive"].includes(String(v.type)) && optional(v, "budgetTokens", positive) && optional(v, "display", (d) => d === "summarized" || d === "omitted");
const layout = (v: unknown): boolean => object(v) && optional(v, "system", text) && Array.isArray(v.systemBlocks) && v.systemBlocks.every((b) => object(b) && text(b.text) && ["org", "global"].includes(String(b.cacheScope))) && Array.isArray(v.userContext) && v.userContext.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every(text)) && Array.isArray(v.tools) && v.tools.every((tool) => object(tool) && text(tool.name) && text(tool.description) && object(tool.inputSchema));
const definition = (v: unknown): boolean => object(v) && text(v.prompt) && text(v.description) && Object.keys(v).every((key) => (definitionFields as readonly string[]).includes(key)) &&
  ["tools", "disallowedTools", "skills"].every((key) => optional(v, key, strings)) && ["model", "criticalSystemReminder_EXPERIMENTAL", "initialPrompt", "permissionMode", "observer", "observerMessage", "isolation", "color", "whenToUseLean"].every((key) => optional(v, key, text)) &&
  ["background", "appendSystemPrompt", "omitProjectContext"].every((key) => optional(v, key, (item) => typeof item === "boolean")) && optional(v, "maxTurns", finiteNumber) && optional(v, "memory", (m) => ["user", "project", "local"].includes(String(m))) && optional(v, "effort", (e) => finiteNumber(e) || ["low", "medium", "high", "xhigh", "max"].includes(String(e)));

export function readChildExecutionSnapshot(record: ChildSessionRecord): ChildExecutionSnapshot {
  const s: unknown = record.execution;
  if (!object(s) || s.version !== 1) throw new Error("legacy or unsupported child execution snapshot; its identity and transcript are available, but safe resume requires a version 1 snapshot");
  const i = s.inheritance;
  const r = s.request;
  const w = s.workspace;
  const restrictions = s.restrictions;
  if (!object(i) || !strings(i.tools) || typeof i.model !== "string" || typeof i.effort !== "string" || typeof i.systemPrompt !== "string" || typeof i.sessionRoot !== "string" ||
      !object(r) || typeof r.prompt !== "string" || r.parentToolUseId !== record.parentToolUseId || typeof r.runInBackground !== "boolean" ||
      !object(w) || typeof w.root !== "string" || !["normal", "worktree"].includes(String(w.isolationType)) || !["keep", "auto-remove-if-unchanged"].includes(String(w.cleanupPolicy)) ||
      typeof s.projectKey !== "string" || !strings(s.scopedMcpServerNames) || !strings(s.inheritedMcpServerNames) ||
      !object(restrictions) || !strings(restrictions.ask) || !strings(restrictions.deny) ||
      (s.parentAgentId !== undefined && typeof s.parentAgentId !== "string") ||
      !object(record.permission) || !isPermissionMode(String(record.permission.effectiveMode)) || typeof record.permission.parentPolicyHash !== "string" || !Number.isInteger(record.permission.parentPolicyVersion) ||
      !object(record.model) || typeof record.model.effectiveModel !== "string" || !optional(record.model, "effectiveProvider", text) ||
      !["running", "completed", "stopped", "failed"].includes(record.status) ||
      !["outputStyle"].every((key) => optional(i, key, text)) || !optional(i, "requestLayout", layout) || !optional(i, "effectiveThinking", thinking) ||
      !optional(i, "effectiveEffort", (effort) => finiteNumber(effort) || ["low", "medium", "high", "xhigh", "max"].includes(String(effort))) ||
      !optional(i, "provider", (provider) => object(provider) && text(provider.providerId) && text(provider.modelKey) && text(provider.family) && optional(provider, "continuationDomain", text)) ||
      !["name", "model", "agentType", "builtinAgentType"].every((key) => optional(r, key, text)) || !optional(r, "fork", (fork) => fork === true) ||
      !optional(r, "isolation", (isolation) => isolation === "worktree") || (r.isolation === "worktree") !== (w.isolationType === "worktree") ||
      !optional(r, "outputFormat", (format) => object(format) && format.type === "json_schema" && object(format.schema)) ||
      !Number.isInteger(record.spawnDepth) || (record.spawnDepth ?? 0) < 1 ||
      (r.definition !== undefined && !definition(r.definition))) {
    throw new Error("corrupt child execution snapshot; safe resume is unavailable");
  }
  return s as unknown as ChildExecutionSnapshot;
}

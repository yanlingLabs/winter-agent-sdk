/** Pure closed-profile checks. Passing these checks never creates a native admission. */
import type { GuestFileRoot } from "./file-helper.ts";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { HOST_INPUT_COMMIT_SUBTYPE, HOST_INPUT_DISCARD_SUBTYPE, HOST_INPUT_FORGET_SUBTYPE, HOST_INPUT_HOLD_SUBTYPE } from "@yanlinglabs/winter-agent-sdk";
import { isHostMessageSendAnswer, normaliseHostMessageListAnswer } from "@yanlinglabs/winter-agent-sdk/messaging";

export const LINUX_HOST_QUERY_PROFILE = "host-query-v1" as const;
export const LINUX_SESSION_FRAME_BYTES = 1024 * 1024;
export const LINUX_SESSION_CHUNK_BYTES = 256 * 1024;
/** The closed guest tool set: the four file/shell tools plus the coordination tools. TaskStop and TaskOutput are withheld (O10): the guest has no background tasks or subagents to stop. */
export const LINUX_HOST_QUERY_FILE_TOOLS = ["Read", "Write", "Edit", "Bash"] as const;
export const LINUX_HOST_QUERY_COORDINATION_TOOLS = ["SendMessage", "ListAgents", "AskUserQuestion", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate"] as const;
export const LINUX_HOST_QUERY_TOOLS: readonly string[] = [...LINUX_HOST_QUERY_FILE_TOOLS, ...LINUX_HOST_QUERY_COORDINATION_TOOLS];
const tools = new Set<string>(LINUX_HOST_QUERY_TOOLS);
const configKeys = new Set(["executionPosture", "sessionId", "resume", "model", "cwd", "winterHome", "storeHome", "persistSession", "settingSources", "tools", "allowedTools", "skills", "plugins", "strictMcpConfig", "mcpServers", "permissionMode", "permissions", "allowDangerouslySkipPermissions", "contextWindowTokens", "hostMessaging"]);
function refuse(): never { throw new Error("Linux host-query profile unavailable"); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function closed(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
const emptyList = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
/** A trusted native record must still satisfy this narrow policy; no settings, grants or callbacks here. */
export function assertLinuxHostQueryConfig(config: RuntimeConfig): void {
  if (Object.keys(config).some(key => !configKeys.has(key)) || config.executionPosture !== "confined-guest" || config.persistSession !== true || !Array.isArray(config.tools) || config.tools.length > LINUX_HOST_QUERY_TOOLS.length || new Set(config.tools).size !== config.tools.length || config.tools.some(tool => typeof tool !== "string" || !tools.has(tool)) || (config.tools.includes("Edit") && (!config.tools.includes("Read") || !config.tools.includes("Write")))) refuse();
  if (![config.sessionId, config.model, config.cwd, config.winterHome, config.storeHome].every(value => typeof value === "string" && value.length > 0 && value.length <= 4096)) refuse();
  if (!emptyList(config.allowedTools) || !emptyList(config.settingSources) || !emptyList(config.skills) || !emptyList(config.plugins) || config.strictMcpConfig !== true || !object(config.mcpServers) || Object.keys(config.mcpServers).length !== 0) refuse();
  // Cowork's host matrix behind canUseTool is the policy authority, so the guest runs only default or plan: any other mode lets the SDK
  // resolve calls without canUseTool. The bypass clamp pair is fixed (never allowed to skip, bypass mode disabled).
  if (!["default", "plan"].includes(config.permissionMode ?? "")) refuse();
  if (config.allowDangerouslySkipPermissions !== false || !object(config.permissions) || !closed(config.permissions, ["disableBypassPermissionsMode"]) || config.permissions.disableBypassPermissionsMode !== true) refuse();
  // Host messaging is a flag, never a grant: only `true`, and only when a tool that uses it is offered.
  if (config.hostMessaging !== undefined && (config.hostMessaging !== true || !(config.tools.includes("SendMessage") || config.tools.includes("ListAgents")))) refuse();
  // A cold resume names its own conversation and nothing else; continue, fork and resume-at stay outside configKeys.
  if (config.resume !== undefined && config.resume !== config.sessionId) refuse();
  if (config.contextWindowTokens !== undefined && (!Number.isSafeInteger(config.contextWindowTokens) || config.contextWindowTokens < 1 || config.contextWindowTokens > 16 * 1024 * 1024)) refuse();
}
/** Root metadata is corroboration, not mount proof; native supervisor must enforce these roots. */
/** The plan view (contract revision 3, 12.5): the conversation's own epoch-scoped planning scratch, `/workspace/plan/<logicalSessionId>/<epoch>`, OUTSIDE the store tree,
 * epoch a canonical decimal of at most nine digits. Read-write only under plan, at most once, and only for this conversation (its own id). That an EARLIER epoch is never
 * mounted once a later one exists is the supervisor's check (it alone sees the data disk); this profile check is corroboration of the record's shape. */
/** The memory share: the one exact path under the guest store a host-query or guided conversation may be shown as a root. Never the working directory. */
export const LINUX_MEMORY_ROOT = "/workspace/.winter/memory";
export const LINUX_PLAN_VIEW = /^\/workspace\/plan\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/(0|[1-9][0-9]{0,8})$/;
export function assertLinuxHostQueryRoots(config: RuntimeConfig, roots: readonly GuestFileRoot[]): void {
  assertLinuxHostQueryConfig(config);
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 16 || new Set(roots.map(root => root.id)).size !== roots.length || new Set(roots.map(root => root.guestPath)).size !== roots.length) refuse();
  let planViews = 0;
  for (const root of roots) {
    if (!object(root) || !closed(root as unknown as Record<string, unknown>, ["id", "guestPath", "readOnly"]) || typeof root.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(root.id) || typeof root.guestPath !== "string" || !root.guestPath.startsWith("/workspace/") || root.guestPath.length > 4096 || root.guestPath.includes("\0") || root.guestPath.split("/").slice(1).some(part => part === "" || part === "." || part === "..") || (root.guestPath === "/workspace/.winter" || (root.guestPath.startsWith("/workspace/.winter/") && root.guestPath !== LINUX_MEMORY_ROOT)) || typeof root.readOnly !== "boolean" ) refuse();
    const view = LINUX_PLAN_VIEW.exec(root.guestPath);
    if (view !== null || root.guestPath === "/workspace/plan" || root.guestPath.startsWith("/workspace/plan/")) {
      if (view === null || config.permissionMode !== "plan" || root.readOnly !== false || view[1] !== (config.winterHome ?? "").split("/").pop() || ++planViews > 1) refuse();
    } else if (config.permissionMode === "plan" && !root.readOnly) refuse();
  }
  if (config.cwd === LINUX_MEMORY_ROOT || !roots.some(root => root.guestPath === config.cwd)) refuse();
}
/** end_input carries nothing; interrupt carries nothing or exactly the host SDK's `{ scope: "turn" }`. The engine ignores the payload, so both forms act alike. */
function interruptPayload(subtype: unknown, payload: unknown): boolean {
  if (payload === undefined) return true;
  if (!object(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.length === 0) return true;
  return subtype === "interrupt" && keys.length === 1 && keys[0] === "scope" && payload.scope === "turn";
}
const HELD_INPUT_CONTROL_SUBTYPES: ReadonlySet<string> = new Set([HOST_INPUT_HOLD_SUBTYPE, HOST_INPUT_COMMIT_SUBTYPE, HOST_INPUT_DISCARD_SUBTYPE, HOST_INPUT_FORGET_SUBTYPE]);
const HELD_INPUT_TEXT_BYTES = 64 * 1024;
const exactly = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const heldId = (value: unknown): boolean => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const heldToken = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function heldInputPayload(subtype: string, payload: unknown): boolean {
  if (subtype !== HOST_INPUT_HOLD_SUBTYPE) return exactly(payload, ["inputId", "holdToken"]) && heldId(payload.inputId) && heldToken(payload.holdToken);
  if (!exactly(payload, ["inputId", "holdToken", "epoch", "text", "clientName"]) || !heldId(payload.inputId) || !heldToken(payload.holdToken)) return false;
  if (!exactly(payload.epoch, ["incarnationId", "leaseEpoch"]) || typeof payload.epoch.incarnationId !== "string" || payload.epoch.incarnationId.length === 0 || payload.epoch.incarnationId.length > 256 || !Number.isSafeInteger(payload.epoch.leaseEpoch) || (payload.epoch.leaseEpoch as number) < 0) return false;
  // A committed input becomes a user turn, so it keeps the user-frame vocabulary closed: no leading slash command (built-in compaction ran from one).
  return typeof payload.text === "string" && payload.text.length > 0 && !payload.text.trimStart().startsWith("/") && Buffer.byteLength(payload.text) <= HELD_INPUT_TEXT_BYTES && typeof payload.clientName === "string" && payload.clientName.length <= 256;
}
const requestId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
/** Only pending permission answers can settle runtime RPCs. Stale/foreign answers are harmless drops. */
/** The control subtypes a host-query guest may issue to its host beside `permission` (SendMessage, ListAgents). Never `host_session_stop`: TaskStop is withheld. */
export const LINUX_HOST_MESSAGE_SUBTYPES = ["host_message_send", "host_message_list"] as const;
/** What the engine knows about an id it issued as a runtime -> host messaging request: which answer shape closes it. `true` accepts either shape. */
export type HostMessageRequestKind = "host_message_send" | "host_message_list";
export type OwnsHostRequest = (requestId: string) => HostMessageRequestKind | boolean | undefined;
/** The engine's predicate: which messaging request (if any) this run's own bridge has outstanding under `requestId`. */
export function hostMessageRequestKind(bridge: { ownsRequest(requestId: string, subtype?: string): boolean }): OwnsHostRequest {
  return id => bridge.ownsRequest(id, "host_message_send") ? "host_message_send" : bridge.ownsRequest(id, "host_message_list") ? "host_message_list" : undefined;
}
export function checkLinuxHostQueryFrame(frame: unknown, ownsPermission: (requestId: string) => boolean, ownsHostRequest?: OwnsHostRequest): "accept" | "drop" {
  if (!object(frame) || Buffer.byteLength(JSON.stringify(frame)) > LINUX_SESSION_FRAME_BYTES) refuse();
  if (frame.type === "user") {
    if (!closed(frame, ["type", "text"]) || typeof frame.text !== "string" || frame.text.trimStart().startsWith("/")) refuse();
    return "accept";
  }
  if (!requestId(frame.requestId)) refuse();
  if (frame.type === "control_request") {
    if (typeof frame.subtype === "string" && HELD_INPUT_CONTROL_SUBTYPES.has(frame.subtype)) {
      // The four host -> runtime held-input verbs (N2 extensions 4.5): closed payloads only, bounded to the 64 KiB message plus its envelope.
      if (!closed(frame, ["type", "requestId", "subtype", "payload"]) || !heldInputPayload(frame.subtype, frame.payload)) refuse();
      return "accept";
    }
    if (!closed(frame, ["type", "requestId", "subtype", "payload"]) || !["end_input", "interrupt"].includes(String(frame.subtype)) || !interruptPayload(frame.subtype, frame.payload)) refuse();
    return "accept";
  }
  if (frame.type !== "control_response" || !closed(frame, ["type", "requestId", "ok", "payload", "error"]) || typeof frame.ok !== "boolean") refuse();
  const hostRequest = ownsHostRequest?.(frame.requestId);
  if (hostRequest !== undefined && hostRequest !== false) {
    // The answer to a host_message_send / host_message_list the runtime issued: closed shapes only, never a permission answer.
    if (!frame.ok) {
      if (frame.payload !== undefined || !object(frame.error) || !closed(frame.error, ["code", "message"]) || typeof frame.error.code !== "string" || frame.error.code.length > 128 || typeof frame.error.message !== "string") refuse();
      return "accept";
    }
    if (frame.error !== undefined) refuse();
    const send = isHostMessageSendAnswer(frame.payload), list = normaliseHostMessageListAnswer(frame.payload) !== undefined;
    if (!(hostRequest === "host_message_send" ? send : hostRequest === "host_message_list" ? list : send || list)) refuse();
    return "accept";
  }
  if (!ownsPermission(frame.requestId)) return "drop";
  if (!frame.ok) {
    if (frame.payload !== undefined || !object(frame.error) || !closed(frame.error, ["code", "message"]) || typeof frame.error.code !== "string" || frame.error.code.length > 128 || typeof frame.error.message !== "string") refuse();
  } else {
    const answer = frame.payload;
    if (frame.error !== undefined || !object(answer)) refuse();
    // No updatedPermissions: configuration/settings mutation is outside this entry's authority.
    if (answer.behavior === "allow") {
      if (!closed(answer, ["behavior", "updatedInput"]) || (answer.updatedInput !== undefined && !object(answer.updatedInput))) refuse();
    } else if (answer.behavior === "deny") {
      if (!closed(answer, ["behavior", "message", "interrupt"]) || typeof answer.message !== "string" || (answer.interrupt !== undefined && typeof answer.interrupt !== "boolean")) refuse();
    } else refuse();
  }
  return "accept";
}

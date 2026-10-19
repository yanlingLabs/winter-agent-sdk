/** Pure closed-profile checks. Passing these checks never creates a native admission. */
import type { GuestFileRoot } from "./file-helper.ts";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";

export const LINUX_HOST_QUERY_PROFILE = "host-query-v1" as const;
export const LINUX_SESSION_FRAME_BYTES = 1024 * 1024;
export const LINUX_SESSION_CHUNK_BYTES = 256 * 1024;
const tools = new Set(["Read", "Write", "Edit", "Bash"]);
const configKeys = new Set(["executionPosture", "sessionId", "model", "cwd", "winterHome", "storeHome", "persistSession", "settingSources", "tools", "allowedTools", "skills", "plugins", "strictMcpConfig", "mcpServers", "permissionMode", "permissions", "allowDangerouslySkipPermissions", "contextWindowTokens"]);
function refuse(): never { throw new Error("Linux host-query profile unavailable"); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function closed(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
const emptyList = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
/** A trusted native record must still satisfy this narrow policy; no settings, grants or callbacks here. */
export function assertLinuxHostQueryConfig(config: RuntimeConfig): void {
  if (Object.keys(config).some(key => !configKeys.has(key)) || config.executionPosture !== "confined-guest" || config.persistSession !== true || !Array.isArray(config.tools) || config.tools.length > 4 || new Set(config.tools).size !== config.tools.length || config.tools.some(tool => typeof tool !== "string" || !tools.has(tool)) || (config.tools.includes("Edit") && (!config.tools.includes("Read") || !config.tools.includes("Write")))) refuse();
  if (![config.sessionId, config.model, config.cwd, config.winterHome, config.storeHome].every(value => typeof value === "string" && value.length > 0 && value.length <= 4096)) refuse();
  if (!emptyList(config.allowedTools) || !emptyList(config.settingSources) || !emptyList(config.skills) || !emptyList(config.plugins) || config.strictMcpConfig !== true || !object(config.mcpServers) || Object.keys(config.mcpServers).length !== 0) refuse();
  // Cowork's host matrix behind canUseTool is the policy authority, so the guest runs only default or plan: any other mode lets the SDK
  // resolve calls without canUseTool. The bypass clamp pair is fixed (never allowed to skip, bypass mode disabled).
  if (!["default", "plan"].includes(config.permissionMode ?? "")) refuse();
  if (config.allowDangerouslySkipPermissions !== false || !object(config.permissions) || !closed(config.permissions, ["disableBypassPermissionsMode"]) || config.permissions.disableBypassPermissionsMode !== true) refuse();
  if (config.contextWindowTokens !== undefined && (!Number.isSafeInteger(config.contextWindowTokens) || config.contextWindowTokens < 1 || config.contextWindowTokens > 16 * 1024 * 1024)) refuse();
}
/** Root metadata is corroboration, not mount proof; native supervisor must enforce these roots. */
export function assertLinuxHostQueryRoots(config: RuntimeConfig, roots: readonly GuestFileRoot[]): void {
  assertLinuxHostQueryConfig(config);
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 16 || new Set(roots.map(root => root.id)).size !== roots.length || new Set(roots.map(root => root.guestPath)).size !== roots.length) refuse();
  for (const root of roots) {
    if (!object(root) || !closed(root as unknown as Record<string, unknown>, ["id", "guestPath", "readOnly"]) || typeof root.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(root.id) || typeof root.guestPath !== "string" || !root.guestPath.startsWith("/workspace/") || root.guestPath.length > 4096 || root.guestPath.includes("\0") || root.guestPath.split("/").slice(1).some(part => part === "" || part === "." || part === "..") || root.guestPath === "/workspace/.winter" || root.guestPath.startsWith("/workspace/.winter/") || typeof root.readOnly !== "boolean" || (config.permissionMode === "plan" && !root.readOnly)) refuse();
  }
  if (!roots.some(root => root.guestPath === config.cwd)) refuse();
}
const requestId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
/** Only pending permission answers can settle runtime RPCs. Stale/foreign answers are harmless drops. */
export function checkLinuxHostQueryFrame(frame: unknown, ownsPermission: (requestId: string) => boolean): "accept" | "drop" {
  if (!object(frame) || Buffer.byteLength(JSON.stringify(frame)) > LINUX_SESSION_FRAME_BYTES) refuse();
  if (frame.type === "user") {
    if (!closed(frame, ["type", "text"]) || typeof frame.text !== "string" || frame.text.trimStart().startsWith("/")) refuse();
    return "accept";
  }
  if (!requestId(frame.requestId)) refuse();
  if (frame.type === "control_request") {
    if (!closed(frame, ["type", "requestId", "subtype", "payload"]) || !["end_input", "interrupt"].includes(String(frame.subtype)) || (frame.payload !== undefined && (!object(frame.payload) || Object.keys(frame.payload).length !== 0))) refuse();
    return "accept";
  }
  if (frame.type !== "control_response" || !closed(frame, ["type", "requestId", "ok", "payload", "error"]) || typeof frame.ok !== "boolean") refuse();
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

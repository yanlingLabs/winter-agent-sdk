/** Closed DATA validators for the future inherited reader channel. These never admit
 * an owner, open a descriptor or discharge native reader debt. */
import { parseRuntimeContextConfig, type RuntimeContextConfig } from "@yanlinglabs/winter-agent-sdk";
import { GUIDED_READER_FRAME_BYTES, type GuidedReaderRequest } from "./guided-parent-bridge.ts";

export const LINUX_GUIDED_READER_LIMITS = Object.freeze({ maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024 });
export const LINUX_GUIDED_READER_BODY_BYTES = GUIDED_READER_FRAME_BYTES + 4096;
export interface LinuxGuidedReaderOwner {
  readonly workspaceId: string; readonly logicalSessionId: string; readonly backendSessionId: string;
  readonly incarnationId: string; readonly leaseEpoch: number; readonly bootId: string; readonly generation: number;
}
export interface LinuxGuidedReaderRegistration {
  readonly version: 1; readonly registrationId: string; readonly owner: Readonly<LinuxGuidedReaderOwner>;
  readonly views: Readonly<{ sourceRoot: string; sourceCwd: string; sharedRoot: "/run/winter/shared-instructions"; sharedPath: "/run/winter/shared-instructions/WINTER.md" }>;
  readonly limits: Readonly<typeof LINUX_GUIDED_READER_LIMITS>; readonly requiredRuntimeContext: Readonly<RuntimeContextConfig>;
}
interface Correlation { readonly version: 1; readonly registrationId: string; readonly readId: string; readonly owner: Readonly<LinuxGuidedReaderOwner>; }
export interface LinuxGuidedReaderResult extends Correlation { readonly kind: "reader_result"; readonly frame: string; }
/** A valid DTO is still only a claimed receipt. The admission-owned adapter must
 * associate it with its actual held channel, registered operation and Root evidence. */
export interface LinuxGuidedReaderTerminal extends Correlation {
  readonly kind: "reader_terminal"; readonly outcome: "ok" | "unavailable" | "cancelled";
  readonly namespaceInitReaped: true; readonly monitorReaped: true;
  readonly namespaceWaitStatus: number; readonly monitorWaitStatus: number;
  readonly stdoutEof: true; readonly stderrEof: true; readonly captureDrained: true;
}
export type LinuxGuidedReaderMessage = LinuxGuidedReaderResult | LinuxGuidedReaderTerminal;
const unavailable = (): never => { throw new Error("required_context_unavailable"); };
function json(text: string): unknown { try { return JSON.parse(text); } catch { return unavailable(); } }
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const ownerKeys = ["workspaceId", "logicalSessionId", "backendSessionId", "incarnationId", "leaseEpoch", "bootId", "generation"] as const;
export function closedLinuxGuidedData(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unavailable();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== names.length || names.some(name => !Object.hasOwn(fields, name))
    || Reflect.ownKeys(fields).some(key => typeof key !== "string" || !names.includes(key))
    || Object.values(fields).some(field => !("value" in field))) return unavailable();
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value]));
}
function ownerOf(value: unknown): Readonly<LinuxGuidedReaderOwner> {
  const owner = closedLinuxGuidedData(value, ownerKeys);
  for (const key of ["workspaceId", "logicalSessionId", "backendSessionId", "incarnationId"]) {
    if (typeof owner[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(owner[key])) return unavailable();
  }
  if (typeof owner.bootId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.bootId)
    || ![owner.leaseEpoch, owner.generation].every(value => Number.isSafeInteger(value) && (value as number) > 0)) return unavailable();
  return Object.freeze(owner) as unknown as Readonly<LinuxGuidedReaderOwner>;
}
function path(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096 || !value.startsWith("/") || value.endsWith("/")
    || /[\\\x00-\x1f\x7f]/.test(value) || Buffer.from(value, "utf8").toString("utf8") !== value
    || value.split("/").slice(1).some(part => ["", ".", ".."].includes(part))) return unavailable();
  return value;
}
export function parseLinuxGuidedReaderRegistration(value: unknown): Readonly<LinuxGuidedReaderRegistration> {
  const data = closedLinuxGuidedData(value, ["version", "registrationId", "owner", "views", "limits", "requiredRuntimeContext"]);
  if (data.version !== 1 || !uuid(data.registrationId)) return unavailable();
  const owner = ownerOf(data.owner), views = closedLinuxGuidedData(data.views, ["sourceRoot", "sourceCwd", "sharedRoot", "sharedPath"]);
  for (const key of Object.keys(views)) views[key] = path(views[key]);
  if (typeof views.sourceRoot !== "string" || !/^\/workspace\/(folders|repos)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(views.sourceRoot)
    || typeof views.sourceCwd !== "string" || (views.sourceCwd !== views.sourceRoot && !views.sourceCwd.startsWith(`${views.sourceRoot}/`))
    || views.sharedRoot !== "/run/winter/shared-instructions" || views.sharedPath !== "/run/winter/shared-instructions/WINTER.md") return unavailable();
  const limits = closedLinuxGuidedData(data.limits, Object.keys(LINUX_GUIDED_READER_LIMITS));
  for (const [key, expected] of Object.entries(LINUX_GUIDED_READER_LIMITS)) if (limits[key] !== expected) return unavailable();
  const binding = parseRuntimeContextConfig(data.requiredRuntimeContext);
  if (!uuid(binding.bindingId)) return unavailable();
  return Object.freeze({ version: 1, registrationId: data.registrationId, owner, views: Object.freeze(views), limits: LINUX_GUIDED_READER_LIMITS, requiredRuntimeContext: binding }) as unknown as Readonly<LinuxGuidedReaderRegistration>;
}
/** Build only lookup/correlation data. Native registration and the live pending
 * context are additional prerequisites at the future admission-owned adapter. */
export function linuxGuidedReaderStart(registration: LinuxGuidedReaderRegistration, request: GuidedReaderRequest) {
  const fixed = parseLinuxGuidedReaderRegistration(registration);
  const data = closedLinuxGuidedData(request, ["version", "bindingId", "contextRequestId", "readId"]);
  if (data.version !== 1 || data.bindingId !== fixed.requiredRuntimeContext.bindingId || !uuid(data.contextRequestId) || !uuid(data.readId) || data.contextRequestId === data.readId) return unavailable();
  return Object.freeze({ version: 1 as const, kind: "reader_start" as const, registrationId: fixed.registrationId, owner: fixed.owner,
    readId: data.readId, contextRequestId: data.contextRequestId, bindingId: data.bindingId });
}
export function linuxGuidedReaderCancel(registration: LinuxGuidedReaderRegistration, readId: string) {
  const fixed = parseLinuxGuidedReaderRegistration(registration);
  if (!uuid(readId)) return unavailable();
  return Object.freeze({ version: 1 as const, kind: "reader_cancel" as const, registrationId: fixed.registrationId, readId, owner: fixed.owner });
}
export function parseLinuxGuidedReaderMessage(value: unknown, registration: LinuxGuidedReaderRegistration, readId: string): Readonly<LinuxGuidedReaderMessage> {
  const fixed = parseLinuxGuidedReaderRegistration(registration);
  if (!uuid(readId) || !value || typeof value !== "object") return unavailable();
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (!kind || !("value" in kind)) return unavailable();
  const common = ["version", "kind", "registrationId", "readId", "owner"];
  const data = closedLinuxGuidedData(value, kind.value === "reader_result" ? [...common, "frame"] : [...common, "outcome", "namespaceInitReaped", "monitorReaped", "namespaceWaitStatus", "monitorWaitStatus", "stdoutEof", "stderrEof", "captureDrained"]);
  const owner = ownerOf(data.owner);
  if (data.version !== 1 || data.registrationId !== fixed.registrationId || data.readId !== readId || ownerKeys.some(key => owner[key] !== fixed.owner[key])) return unavailable();
  if (data.kind === "reader_result") {
    if (typeof data.frame !== "string" || Buffer.byteLength(data.frame, "utf8") > 320 * 1024 || !data.frame.endsWith("\n")
      || data.frame.slice(0, -1).includes("\n") || Buffer.from(data.frame, "utf8").toString("utf8") !== data.frame) return unavailable();
    const inner = json(data.frame);
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return unavailable();
  } else if (data.kind === "reader_terminal") {
    if (typeof data.outcome !== "string" || !["ok", "unavailable", "cancelled"].includes(data.outcome)
      || ["namespaceInitReaped", "monitorReaped", "stdoutEof", "stderrEof", "captureDrained"].some(key => data[key] !== true)
      || ![data.namespaceWaitStatus, data.monitorWaitStatus].every(status => Number.isSafeInteger(status) && (status as number) >= 0 && (status as number) <= 65535)) return unavailable();
  } else return unavailable();
  return Object.freeze({ ...data, owner }) as unknown as Readonly<LinuxGuidedReaderMessage>;
}
/** Pure framing only. No stream/socket lifecycle or cleanup authority. */
export function decodeLinuxGuidedReaderFrame(bytes: Uint8Array, registration: LinuxGuidedReaderRegistration, readId: string): Readonly<LinuxGuidedReaderMessage> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5 || bytes.byteLength > LINUX_GUIDED_READER_BODY_BYTES + 4) return unavailable();
  const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (frame.readUInt32BE(0) !== frame.byteLength - 4) return unavailable();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(frame.subarray(4)); } catch { return unavailable(); }
  const data = json(text);
  if (JSON.stringify(data) !== text) return unavailable();
  return parseLinuxGuidedReaderMessage(data, registration, readId);
}

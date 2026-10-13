/** Dedicated current guidance transport. These fields are lookup data, never authority. */
export const RUNTIME_CONTEXT_SUBTYPE = "runtime_context";
export const RUNTIME_CONTEXT_VERSION = 1;
export const RUNTIME_CONTEXT_MAX_BYTES = 128 * 1024;
export interface RuntimeContextConfig { version: 1; bindingId: string; }
export interface RuntimeContextRequest {
  readonly bindingId: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly cwd: string;
  readonly purpose: "generation" | "compaction";
  readonly attempt: number;
}
export interface RuntimeContextSnapshot { readonly revision: string; readonly facts: string; readonly instructions: string; }
/** The owning query identity comes from this SDK instance, not the guest request.
 * The host MUST authorize canonical backend/session/child ownership and current roots
 * before reading guidance. Neither bindingId nor revision is an authorization token. */
export type RuntimeContextHandler = (request: Readonly<RuntimeContextRequest>, options: {
  signal: AbortSignal; trustedQuerySessionId: string;
}) => Promise<RuntimeContextSnapshot>;

function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("required_context_unavailable");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(property => !("value" in property))) throw new Error("required_context_unavailable");
  return Object.fromEntries(Object.entries(descriptors).map(([key, property]) => [key, property.value]));
}
const identity = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
export function parseRuntimeContextConfig(value: unknown): Readonly<RuntimeContextConfig> {
  const v = fields(value, ["version", "bindingId"]);
  if (v.version !== RUNTIME_CONTEXT_VERSION || !identity(v.bindingId)) throw new Error("required_context_unavailable");
  return Object.freeze({ version: RUNTIME_CONTEXT_VERSION, bindingId: v.bindingId });
}
export function parseRuntimeContextRequest(value: unknown): Readonly<RuntimeContextRequest> {
  const v = fields(value, ["bindingId", "sessionId", "cwd", "purpose", "attempt"], ["agentId"]);
  if (!identity(v.bindingId) || !identity(v.sessionId) || (Object.hasOwn(v, "agentId") && !identity(v.agentId))
    || typeof v.cwd !== "string" || v.cwd.length === 0 || v.cwd.includes("\0") || Buffer.byteLength(v.cwd, "utf8") > 4096
    || (v.purpose !== "generation" && v.purpose !== "compaction")
    || !Number.isSafeInteger(v.attempt) || (v.attempt as number) < 1 || (v.attempt as number) > 1_000_000) throw new Error("required_context_unavailable");
  return Object.freeze({ bindingId: v.bindingId, sessionId: v.sessionId, cwd: v.cwd, purpose: v.purpose,
    attempt: v.attempt as number, ...(v.agentId !== undefined ? { agentId: v.agentId as string } : {}) });
}
export function parseRuntimeContextSnapshot(value: unknown): Readonly<RuntimeContextSnapshot> {
  const v = fields(value, ["revision", "facts", "instructions"]);
  if (!identity(v.revision) || typeof v.facts !== "string" || typeof v.instructions !== "string"
    || Buffer.byteLength(v.facts, "utf8") + Buffer.byteLength(v.instructions, "utf8") > RUNTIME_CONTEXT_MAX_BYTES) throw new Error("required_context_unavailable");
  return Object.freeze({ revision: v.revision, facts: v.facts, instructions: v.instructions });
}
